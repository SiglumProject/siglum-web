import { getPlainArticleEdit, isPlainArticle } from '../services/plainArticleParagraph'
import { paragraphPreviewEnabled, typesetParagraph, warmParagraphPreview, type ParagraphPatch } from '../services/ParagraphPreview'
import { createBookParagraphProfile, getBookParagraphEdit } from '../services/paragraphEligibility.mjs'
import { useState, useCallback, useEffect, useRef } from 'react'
import { checkpointEntry } from '../services/CheckpointEntry'
import CompilerService from '../services/CompilerService'
import { checkpointPreviewEnabled } from '../services/CheckpointCompiler'
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
  paragraphPatch: ParagraphPatch | null
  onParagraphFailure: (patch: ParagraphPatch) => void
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

export function useCompilation(latexCode: string, isLoaded: boolean, documentId?: string, allowParagraphOverlay = false): UseCompilationReturn {
  const [paragraphPatch, setParagraphPatch] = useState<ParagraphPatch | null>(null)
  const paragraphPatchRef = useRef<ParagraphPatch | null>(null)
  const fullBuild = useRef<{
    source: string
    mainPath?: string
    files: Record<string, string | Uint8Array>
    dependencies: Map<string, Uint8Array | null>
    profile: ReturnType<typeof createBookParagraphProfile>
    pdf: Uint8Array
  } | null>(null)
  const activePdf = useRef<Uint8Array | null>(null)
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [syncTexData, setSyncTexData] = useState<string | null>(null)
  const [compileStatus, setCompileStatus] = useState<CompileStatus>('idle')
  const [compileTimeMs, setCompileTimeMs] = useState<number | null>(null)
  const [diagnostics, setDiagnostics] = useState<TexDiagnostic[]>([])
  const editorFocus = useRef<{ path: string; offsetUTF16: number } | undefined>(undefined)
  useEffect(() => EventBus.on('editorFocus', focus => { editorFocus.current = focus }), [])
  const compileTimeoutRef = useRef<number | null>(null)
  const compileInFlightRef = useRef(false)
  const pendingCompileRef = useRef<'auto' | 'manual' | null>(null)
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
    setParagraphPatch(null)
    paragraphPatchRef.current = null

    const cached = pdfCache.get(documentId)
    activePdf.current = cached?.pdf ?? null
    if (cached) {
      setPdfData(cached.pdf)
      setSyncTexData(cached.syncTex)
      if (cached.syncTex) syncTexService.queueUpdate(cached.syncTex)
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

  // Compilation initializes the runtime after the document's engine is known.
  // Welcome/recovery screens must not allocate a pdfTeX heap speculatively.

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
  const runCompile = useCallback(async (auto: boolean): Promise<void> => {
    const currentStatus = CompilerService.getStatus()
    if (!latexCodeRef.current) return
    if (compileInFlightRef.current || currentStatus === 'compiling' || currentStatus === 'initializing') {
      if (!auto || pendingCompileRef.current === null) pendingCompileRef.current = auto ? 'auto' : 'manual'
      return
    }
    compileInFlightRef.current = true
    pendingCompileRef.current = null
    const compilingDocumentId = documentIdRef.current
    setParagraphPatch(null)
    paragraphPatchRef.current = null

    // Clear previous diagnostics when starting new compile
    // Note: We intentionally keep old SyncTeX data alive during compilation
    // so sync operations still work while recompiling
    logParserRef.current.clear()

    const settings = compilerSettingsRef.current
    const codeToCompile = latexCodeRef.current
    let published = false

    // Load any files referenced via \input{} or \include{}
    try {
      const baseline = fullBuild.current
      const chapter = paragraphPreviewEnabled && compilingDocumentId?.match(/^(.*)\/(chapters\/chapter-\d\d\.tex)$/)
      const candidateMainPath = chapter ? chapter[1] + '/main.tex' : compilingDocumentId
      const chapterPath = chapter ? chapter[2] : undefined
      if (auto && allowParagraphOverlay && settings.compiler !== 'xelatex' && baseline
        && baseline.mainPath === candidateMainPath && activePdf.current === baseline.pdf) {
        let edit: { chapter?: number; page: number; paragraph: number; before: string; after: string } | undefined
        let pageOffset = 0
        let pageCount = 1
        let pageParagraphs: string[] = []
        if (chapterPath && baseline.profile) {
          const previous = baseline.files[chapterPath]
          if (typeof previous === 'string') edit = getBookParagraphEdit(baseline.profile, chapterPath, previous, codeToCompile) ?? undefined
          if (edit) {
            for (const [path, chapter] of baseline.profile.chapters) {
              if (path === chapterPath) break
              pageOffset += chapter.pages.length
            }
            pageParagraphs = baseline.profile.chapters.get(chapterPath)?.pages[edit.page - 1].paragraphs
              .map(paragraph => paragraph.text) ?? []
            pageCount = [...baseline.profile.chapters.values()].reduce((count, chapter) => count + chapter.pages.length, 0)
          }
        } else if (!chapterPath && !Object.keys(baseline.files).length) {
          const plainEdit = getPlainArticleEdit(baseline.source, codeToCompile)
          if (plainEdit) {
            edit = plainEdit
            pageParagraphs = plainEdit.pageParagraphs
          }
        }
        if (edit && edit.before.split('\n').length === edit.after.split('\n').length) {
          try {
            // Typeset speculatively. Publish only after rechecking the full build's inputs.
            const [pdf, dependenciesMatch] = await Promise.all([
              typesetParagraph(edit.after),
              dependenciesUnchanged(baseline.dependencies, compilingDocumentId),
            ])
            if (!dependenciesMatch) throw new Error('Project dependencies changed')
            if (documentIdRef.current !== compilingDocumentId || latexCodeRef.current !== codeToCompile) return
            const firstWords = (text: string) => text.trim().split(/\s+/).slice(0, 3).join(' ')
            const matchesAnchor = (paragraph: string) => firstWords(paragraph) === firstWords(edit.before)
            const occurrence = pageParagraphs.slice(0, edit.paragraph - 1).filter(matchesAnchor).length
            const anchorCount = pageParagraphs.filter(matchesAnchor).length
            const patch = { ...edit, localPage: edit.page, page: pageOffset + edit.page, pageCount, occurrence, anchorCount, basePdf: baseline.pdf, pdf }
            paragraphPatchRef.current = patch
            setParagraphPatch(patch)
            return
          } catch {
            // Rejected or unavailable fragments use the regular compiler.
          }
        }
      }
      let mainPath = compilingDocumentId
      let source = codeToCompile
      const dependencies = new Map<string, Uint8Array | null>()
      const read = async (path: string) => {
        const data = checkpointPreviewEnabled && path === compilingDocumentId
          ? new TextEncoder().encode(codeToCompile) : await FileReaderService.readBinary(path)
        // Keep misses too, so a newly added local class or package invalidates the preview.
        if (paragraphPreviewEnabled) dependencies.set(path, data)
        return data
      }
      if (chapter) {
        const bytes = await read(candidateMainPath!)
        const main = bytes && new TextDecoder().decode(bytes)
        if (main?.includes('\\include{' + chapter[2].slice(0, -4) + '}')) {
          mainPath = candidateMainPath
          source = main
        }
      }
      let resolvedFiles: Record<string, string | Uint8Array> | undefined
      if (checkpointPreviewEnabled) {
        const entry = await checkpointEntry(source, compilingDocumentId, read)
        mainPath = entry.path
        source = entry.source
        resolvedFiles = entry.files
      }
      const additionalFiles = resolvedFiles ?? await loadCompilationFiles(source, mainPath, read, FileReaderService)
      if (checkpointPreviewEnabled && mainPath !== compilingDocumentId && compilingDocumentId) {
        additionalFiles[compilationContext(compilingDocumentId).mainFile] = codeToCompile
      }
      if (chapterPath && mainPath !== compilingDocumentId) additionalFiles[chapterPath] = codeToCompile
      const result = await CompilerService.compile(source, {
        engine: settings.compiler,
        cachePreamble: settings.cachePreamble,
        additionalFiles,
        mainFile: compilationContext(mainPath).mainFile,
        projectId: mainPath,
        focus: editorFocus.current && editorFocus.current.path === compilingDocumentId ? {
          path: compilationContext(compilingDocumentId).mainFile, offsetUTF16: editorFocus.current.offsetUTF16,
        } : undefined,
      })
      if (result.success && result.pdf) {
        const compiledPdf = result.pdf
        const newSyncTex = result.syncTexData ?? null
        const newTimeMs = result.timeMs ?? 0
        if (compilingDocumentId) {
          cachePdf(compilingDocumentId, { pdf: compiledPdf, syncTex: newSyncTex, timeMs: newTimeMs })

        }
        // A completed job belongs to the document that started it.
        if (documentIdRef.current !== compilingDocumentId || latexCodeRef.current !== codeToCompile) return
        activePdf.current = compiledPdf
        fullBuild.current = paragraphPreviewEnabled && settings.compiler !== 'xelatex'
          ? { source, mainPath, files: additionalFiles, dependencies, profile: createBookParagraphProfile(source, additionalFiles), pdf: compiledPdf }
          : null
        if (fullBuild.current && allowParagraphOverlay && (fullBuild.current.profile || isPlainArticle(source))) void warmParagraphPreview().catch(() => {})
        setPdfData(compiledPdf)
        setSyncTexData(newSyncTex)
        if (newSyncTex) {
          syncTexService.queueUpdate(newSyncTex)
        } else {
          syncTexService.clear()
        }
        setCompileTimeMs(result.timeMs ?? null)
        published = true
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
        if (!checkpointPreviewEnabled && settings.cachePreamble && !formatGeneratedRef.current && Object.keys(additionalFiles).length === 0 && !compilationContext(compilingDocumentId).directory) {
          formatGeneratedRef.current = true
          CompilerService.generateFormat(codeToCompile, {
            engine: settings.compiler,
            mainFile: compilationContext(compilingDocumentId).mainFile,
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
      const pending = pendingCompileRef.current
      pendingCompileRef.current = null
      const alreadyCompleted = published && documentIdRef.current === compilingDocumentId
        && latexCodeRef.current === codeToCompile && compilerSettingsRef.current.compiler === settings.compiler
      if (pending && !alreadyCompleted) setTimeout(() => void runCompile(pending === 'auto'), 0)
    }
  }, [allowParagraphOverlay])

  const compile = useCallback(() => runCompile(false), [runCompile])
  const onParagraphFailure = useCallback((patch: ParagraphPatch) => {
    if (paragraphPatchRef.current === patch) void runCompile(false)
  }, [runCompile])
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

      // Initialization may be a worker replacement after a successful compile.
      // Consume an actual queued request; readiness alone must not compile again.
      if (prevStatus === 'initializing' && status === 'idle' && CompilerService.isReady()
        && !compileInFlightRef.current && latexCodeRef.current) {
        const pending = pendingCompileRef.current
        pendingCompileRef.current = null
        if (pending && (pending === 'manual' || autoCompileRef.current)) {
          if (compileTimeoutRef.current) {
            clearTimeout(compileTimeoutRef.current)
            compileTimeoutRef.current = null
          }
          setTimeout(() => void runCompile(pending === 'auto'), 0)
        }
      }
    })
  }, [runCompile])

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
    const throttleInterval = checkpointPreviewEnabled ? 0 : 1000 // 1 second between compiles during continuous typing
    const debounceDelay = 150 // 150ms after typing stops

    // Throttle: if it's been more than 1 second since last compile, compile now
    if (timeSinceLastCompile >= throttleInterval) {
      void runCompile(true)
      return
    }

    // Debounce: schedule compile for when typing stops (or throttle kicks in)
    const delay = Math.min(debounceDelay, throttleInterval - timeSinceLastCompile)
    compileTimeoutRef.current = window.setTimeout(() => {
      if (lastCompiledCodeRef.current === latexCodeRef.current) return
      void runCompile(true)
    }, delay)

    return () => {
      if (compileTimeoutRef.current) {
        clearTimeout(compileTimeoutRef.current)
      }
    }
  }, [latexCode, documentId, isLoaded, compilerSettings.autoCompile, runCompile])

  return {
    paragraphPatch,
    onParagraphFailure,
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

function sameBytes(before: Uint8Array | null, after: Uint8Array | null) {
  if (!before || !after) return before === after
  if (before.length !== after.length) return false
  if (before.byteOffset % 4 || after.byteOffset % 4) return before.every((byte, i) => byte === after[i])
  const words = Math.floor(before.length / 4)
  const left = new Uint32Array(before.buffer, before.byteOffset, words)
  const right = new Uint32Array(after.buffer, after.byteOffset, words)
  for (let i = 0; i < words; i++) {
    if (left[i] !== right[i]) return false
  }
  for (let i = words * 4; i < before.length; i++) {
    if (before[i] !== after[i]) return false
  }
  return true
}

async function dependenciesUnchanged(dependencies: Map<string, Uint8Array | null>, editedPath?: string) {
  const paths = [...dependencies.keys()].filter(path => path !== editedPath)
  const current = await FileReaderService.readBinaryBatch(paths)
  return paths.every(path => sameBytes(dependencies.get(path) ?? null, current.get(path) ?? null))
}
