import { useState, useCallback, useEffect, useRef } from 'react'
import CompilerService from '../services/CompilerService'
import EventBus from '../services/EventBus'
import type { CompileStatus } from '../services/CompilerService'

export interface CompilerSettings {
  autoCompile: boolean
  compiler: 'auto' | 'pdflatex' | 'xelatex'
  ctanFetch: boolean
  cachePreamble: boolean
  autoUnload: boolean
}

interface UseCompilationReturn {
  pdfData: Uint8Array | null
  compileStatus: CompileStatus
  compileTimeMs: number | null
  compilerSettings: CompilerSettings
  setCompilerSettings: (settings: CompilerSettings) => void
  compile: () => Promise<void>
  compileRef: React.MutableRefObject<() => Promise<void>>
  autoCompileRef: React.MutableRefObject<boolean>
  clearPendingAutoCompile: () => void
}

export function useCompilation(latexCode: string, isLoaded: boolean): UseCompilationReturn {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [compileStatus, setCompileStatus] = useState<CompileStatus>('idle')
  const [compileTimeMs, setCompileTimeMs] = useState<number | null>(null)
  const compileTimeoutRef = useRef<number | null>(null)
  const formatGeneratedRef = useRef(false)
  const lastCompiledCodeRef = useRef<string | null>(null)

  const [compilerSettings, setCompilerSettingsState] = useState<CompilerSettings>({
    autoCompile: true,
    compiler: 'auto',
    ctanFetch: true,
    cachePreamble: true,
    autoUnload: true,
  })

  // Keep refs to avoid stale closures
  const latexCodeRef = useRef(latexCode)
  const autoCompileRef = useRef(compilerSettings.autoCompile)
  const compilerSettingsRef = useRef(compilerSettings)

  useEffect(() => {
    latexCodeRef.current = latexCode
  }, [latexCode])

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

  // Compile function - uses refs to avoid recreating on settings change
  const compile = useCallback(async () => {
    const currentStatus = CompilerService.getStatus()
    if (!latexCodeRef.current || currentStatus === 'compiling' || currentStatus === 'initializing') {
      return
    }

    const settings = compilerSettingsRef.current
    const codeToCompile = latexCodeRef.current

    try {
      const result = await CompilerService.compile(codeToCompile, {
        engine: settings.compiler,
      })
      if (result.success && result.pdf) {
        const pdfCopy = new Uint8Array(result.pdf.length)
        pdfCopy.set(result.pdf)
        setPdfData(pdfCopy)
        setCompileTimeMs(result.timeMs ?? null)
        lastCompiledCodeRef.current = codeToCompile

        // Only generate format once per session (not on every compile)
        if (settings.cachePreamble && !formatGeneratedRef.current) {
          formatGeneratedRef.current = true
          CompilerService.generateFormat(codeToCompile, {
            engine: settings.compiler,
          }).catch(() => {
            // Reset so we retry on next compile if it fails
            formatGeneratedRef.current = false
          })
        }
      }
    } catch {
      // Compilation errors shown in UI
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

  // Auto-compile on content change (debounced)
  useEffect(() => {
    if (!compilerSettings.autoCompile || !latexCode || !isLoaded) return

    if (compileTimeoutRef.current) {
      clearTimeout(compileTimeoutRef.current)
    }

    compileTimeoutRef.current = window.setTimeout(() => {
      // Check at callback time, not effect time - code may have been compiled by init trigger
      if (lastCompiledCodeRef.current === latexCodeRef.current) return
      compileRef.current()
    }, 1000)

    return () => {
      if (compileTimeoutRef.current) {
        clearTimeout(compileTimeoutRef.current)
      }
    }
  }, [latexCode, isLoaded, compilerSettings.autoCompile])

  return {
    pdfData,
    compileStatus,
    compileTimeMs,
    compilerSettings,
    setCompilerSettings,
    compile,
    compileRef,
    autoCompileRef,
    clearPendingAutoCompile,
  }
}
