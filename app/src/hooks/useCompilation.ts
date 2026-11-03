import { useState, useCallback, useEffect, useRef } from 'react'
import CompilerService from '../services/CompilerService'
import EventBus from '../services/EventBus'
import FileReaderService from '../services/FileReaderService'
import { loadCompilationFiles, compilationContext } from '../services/CompilationFiles'
import syncTexService from '../services/SyncTexService'
import type { CompileStatus } from '../services/CompilerService'
import { StreamingLogParser, type TexDiagnostic } from '../utils/texLogParser'

export interface CompilerSettings {
  autoCompile: boolean
  compiler: 'auto' | 'pdflatex' | 'xelatex'
  ctanFetch: boolean
  cachePreamble: boolean
  autoUnload: boolean
}

// Per-document PDF cache — avoids blank preview on tab switch
const MAX_PDF_CACHE = 5
interface CachedPdf {
  pdf: Uint8Array
  syncTex: string | null
  timeMs: number
}
const pdfCache = new Map<string, CachedPdf>()

function cachePdf(docId: string, entry: CachedPdf) {
  pdfCache.delete(docId) // move to end (most recent)
  pdfCache.set(docId, entry)
  while (pdfCache.size > MAX_PDF_CACHE) {
    const oldest = pdfCache.keys().next().value
    if (oldest) pdfCache.delete(oldest)
  }
}

interface UseCompilationReturn {
  pdfData: Uint8Array | null
  syncTexData: string | null
  compileStatus: CompileStatus
  compileTimeMs: number | null
  compilerSettings: CompilerSettings
  setCompilerSettings: (settings: CompilerSettings) => void
  compile: () => Promise<void>
  compileRef: React.MutableRefObject<() => Promise<void>>
  autoCompileRef: React.MutableRefObject<boolean>
  clearPendingAutoCompile: () => void
  diagnostics: TexDiagnostic[]
}

export function useCompilation(latexCode: string, isLoaded: boolean, documentId?: string): UseCompilationReturn {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [syncTexData, setSyncTexData] = useState<string | null>(null)
  const [compileStatus, setCompileStatus] = useState<CompileStatus>('idle')
  const [compileTimeMs, setCompileTimeMs] = useState<number | null>(null)
  const [diagnostics, setDiagnostics] = useState<TexDiagnostic[]>([])
  const compileTimeoutRef = useRef<number | null>(null)
  const compileInFlightRef = useRef(false)
  const pendingCompileRef = useRef(false)
  const formatGeneratedRef = useRef(false)
  const lastCompiledCodeRef = useRef<string | null>(null)
  const lastCompileTimeRef = useRef<number>(0) // For throttle
  const prevCompileTimeMsRef = useRef<number | null>(null)
  const logParserRef = useRef<StreamingLogParser>(new StreamingLogParser())

  const [compilerSettings, setCompilerSettingsState] = useState<CompilerSettings>({
    autoCompile: true,
    compiler: 'auto',
    ctanFetch: true,
    cachePreamble: true,
    autoUnload: true,
  })

  // Keep refs to avoid stale closures
  const latexCodeRef = useRef(latexCode)
  const documentIdRef = useRef(documentId)
  const autoCompileRef = useRef(compilerSettings.autoCompile)
  const compilerSettingsRef = useRef(compilerSettings)

  useEffect(() => {
    latexCodeRef.current = latexCode
  }, [latexCode])

  // Restore cached PDF when switching documents
  useEffect(() => {
    const prevDocId = documentIdRef.current
    documentIdRef.current = documentId
    if (!documentId || documentId === prevDocId) return

    // Show the cached preview immediately, then validate dependencies again on each switch.
    lastCompiledCodeRef.current = null
    logParserRef.current.clear()
    setDiagnostics([])

    const cached = pdfCache.get(documentId)
    if (cached) {
      setPdfData(cached.pdf)
      setSyncTexData(cached.syncTex)
      if (cached.syncTex) syncTexService.update(cached.syncTex)
      else syncTexService.clear()
      setCompileTimeMs(cached.timeMs)
    } else {
      // No cache — clear stale PDF from previous document
      setPdfData(null)
      setSyncTexData(null)
      syncTexService.clear()
      setCompileTimeMs(null)
    }
  }, [documentId])

  useEffect(() => {
    autoCompileRef.current = compilerSettings.autoCompile
    compilerSettingsRef.current = compilerSettings
  }, [compilerSettings])

  // Eagerly initialize compiler
  useEffect(() => {
    CompilerService.initialize().catch(() => {
      // Initialization errors handled when compile is called
    })
  }, [])

  // Subscribe to log messages and parse them
  useEffect(() => {
    const parser = logParserRef.current

    // Subscribe to diagnostics updates
    const unsubDiagnostics = parser.onDiagnostics(setDiagnostics)

    // Subscribe to compiler logs
    const unsubLogs = CompilerService.onLog((message) => {
      parser.addLine(message)

      // CTAN package fetch toasts
      const reqMatch = message.match(/\[CTAN-REQ\] Worker requested package: (.+)/)
      if (reqMatch) {
        EventBus.emit('showToast', {
          message: `Fetching ${reqMatch[1]}...`,
          type: 'loading',
          key: `ctan-${reqMatch[1]}`,
          duration: 0,
        })
        return
      }
      const gotMatch = message.match(/\[CTAN-REQ\] (.+?): got (\d+) files/)
      if (gotMatch) {
        EventBus.emit('showToast', {
          message: `${gotMatch[1]} cached (${gotMatch[2]} files)`,
          type: 'success',
          key: `ctan-${gotMatch[1]}`,
          duration: 2000,
        })
      }
    })

    return () => {
      unsubDiagnostics()
      unsubLogs()
    }
  }, [])

  // Compile function - uses refs to avoid recreating on settings change
  const compile = useCallback(async () => {
    const currentStatus = CompilerService.getStatus()
    if (!latexCodeRef.current) return
    if (compileInFlightRef.current || currentStatus === 'compiling' || currentStatus === 'initializing') {
      pendingCompileRef.current = true
      return
    }
    compileInFlightRef.current = true
    pendingCompileRef.current = false
    const compilingDocumentId = documentIdRef.current

    // Clear previous diagnostics when starting new compile
    // Note: We intentionally keep old SyncTeX data alive during compilation
    // so sync operations still work while recompiling
    logParserRef.current.clear()

    const settings = compilerSettingsRef.current
    const codeToCompile = latexCodeRef.current

    // Load any files referenced via \input{} or \include{}
    try {
      const additionalFiles = await loadCompilationFiles(codeToCompile, compilingDocumentId, path => FileReaderService.readBinary(path))
      const result = await CompilerService.compile(codeToCompile, {
        engine: settings.compiler,
        additionalFiles,
        mainFile: compilationContext(compilingDocumentId).mainFile,
      })
      if (result.success && result.pdf) {
        const pdfCopy = new Uint8Array(result.pdf.length)
        pdfCopy.set(result.pdf)
        const newSyncTex = result.syncTexData ?? null
        const newTimeMs = result.timeMs ?? 0
        if (compilingDocumentId) {
          cachePdf(compilingDocumentId, { pdf: pdfCopy, syncTex: newSyncTex, timeMs: newTimeMs })

        }
        // A completed job belongs to the document that started it.
        if (documentIdRef.current !== compilingDocumentId) return
        setPdfData(pdfCopy)
        setSyncTexData(newSyncTex)
        if (newSyncTex) {
          syncTexService.update(newSyncTex)
        } else {
          syncTexService.clear()
        }
        setCompileTimeMs(result.timeMs ?? null)
        lastCompiledCodeRef.current = codeToCompile
        lastCompileTimeRef.current = Date.now()

        const isFaster = prevCompileTimeMsRef.current !== null && newTimeMs < prevCompileTimeMsRef.current
        prevCompileTimeMsRef.current = newTimeMs

        EventBus.emit('showToast', {
          message: `Compiled · ${Math.round(newTimeMs)}ms`,
          type: 'success',
          key: 'compile',
          className: isFaster ? 'toast-compile toast-bounce' : 'toast-compile',
        })

        // Only generate format once per session (not on every compile)
        if (settings.cachePreamble && !formatGeneratedRef.current && Object.keys(additionalFiles).length === 0 && !compilationContext(compilingDocumentId).directory) {
          formatGeneratedRef.current = true
          CompilerService.generateFormat(codeToCompile, {
            engine: settings.compiler,
          }).catch(() => {
            // Reset so we retry on next compile if it fails
            formatGeneratedRef.current = false
          })
        }
      } else if (!result.success && documentIdRef.current === compilingDocumentId) {
        EventBus.emit('showToast', {
          message: 'Compile error',
          type: 'error',
          key: 'compile',
        })
      }

      // Feed TeX log output to the parser for diagnostics extraction
      if (result.log && documentIdRef.current === compilingDocumentId) {
        for (const line of result.log.split('\n')) {
          logParserRef.current.addLine(line)
        }
        logParserRef.current.finalize()
      }
      if (!result.success && documentIdRef.current === compilingDocumentId && !logParserRef.current.getDiagnostics().some(d => d.type === 'error')) {
        setDiagnostics([{ type: 'error', message: result.error || 'Compilation failed. Open the log for details.' }])
      }
    } catch (error) {
      if (documentIdRef.current !== compilingDocumentId) return
      setDiagnostics([{ type: 'error', message: error instanceof Error ? error.message : 'Compilation failed' }])
      EventBus.emit('showToast', {
        message: 'Compile failed',
        type: 'error',
        key: 'compile',
      })
    } finally {
      compileInFlightRef.current = false
      if (pendingCompileRef.current) {
        pendingCompileRef.current = false
        setTimeout(() => compileRef.current(), 0)
      }
    }
  }, [])

  const compileRef = useRef(compile)
  useEffect(() => {
    compileRef.current = compile
  }, [compile])

  // Settings change handler with side effects
  const setCompilerSettings = useCallback((newSettings: CompilerSettings) => {
    if (compilerSettings.cachePreamble && !newSettings.cachePreamble) {
      CompilerService.clearCache()
    }
    if (compilerSettings.autoUnload !== newSettings.autoUnload) {
      CompilerService.setAutoUnload(newSettings.autoUnload)
    }
    setCompilerSettingsState(newSettings)
  }, [compilerSettings.cachePreamble, compilerSettings.autoUnload])

  // Subscribe to compiler status
  const prevStatusRef = useRef<CompileStatus>('idle')
  useEffect(() => {
    return CompilerService.onStatus((status) => {
      const prevStatus = prevStatusRef.current
      prevStatusRef.current = status
      setCompileStatus(status)

      // Trigger compile when initialization completes
      if (prevStatus === 'initializing' && status === 'idle' && latexCodeRef.current && autoCompileRef.current) {
        // Clear any pending auto-compile debounce to prevent double compilation
        if (compileTimeoutRef.current) {
          clearTimeout(compileTimeoutRef.current)
          compileTimeoutRef.current = null
        }
        setTimeout(() => compileRef.current(), 0)
      }
    })
  }, [])

  // Helper to clear pending auto-compile (exposed for external use like file select)
  const clearPendingAutoCompile = useCallback(() => {
    if (compileTimeoutRef.current) {
      clearTimeout(compileTimeoutRef.current)
      compileTimeoutRef.current = null
    }
  }, [])

  // Listen for triggerCompile event from editor (Cmd+S)
  useEffect(() => {
    return EventBus.on('triggerCompile', () => {
      // Clear any pending auto-compile to prevent double compilation
      clearPendingAutoCompile()
      compileRef.current()
    })
  }, [clearPendingAutoCompile])

  // Auto-compile on content change (throttle + debounce)
  // - Throttle: compile at most every 1 second during continuous typing
  // - Debounce: compile 150ms after typing stops
  useEffect(() => {
    if (!compilerSettings.autoCompile || !latexCode || !isLoaded) return

    // Clear any pending debounce timer
    if (compileTimeoutRef.current) {
      clearTimeout(compileTimeoutRef.current)
    }

    // Skip if code hasn't changed
    if (lastCompiledCodeRef.current === latexCode) return

    const now = Date.now()
    const timeSinceLastCompile = now - lastCompileTimeRef.current
    const throttleInterval = 1000 // 1 second between compiles during continuous typing
    const debounceDelay = 150 // 150ms after typing stops

    // Throttle: if it's been more than 1 second since last compile, compile now
    if (timeSinceLastCompile >= throttleInterval) {
      compileRef.current()
      return
    }

    // Debounce: schedule compile for when typing stops (or throttle kicks in)
    const delay = Math.min(debounceDelay, throttleInterval - timeSinceLastCompile)
    compileTimeoutRef.current = window.setTimeout(() => {
      if (lastCompiledCodeRef.current === latexCodeRef.current) return
      compileRef.current()
    }, delay)

    return () => {
      if (compileTimeoutRef.current) {
        clearTimeout(compileTimeoutRef.current)
      }
    }
  }, [latexCode, documentId, isLoaded, compilerSettings.autoCompile])

  return {
    pdfData,
    syncTexData,
    compileStatus,
    compileTimeMs,
    compilerSettings,
    setCompilerSettings,
    compile,
    compileRef,
    autoCompileRef,
    clearPendingAutoCompile,
    diagnostics,
  }
}
