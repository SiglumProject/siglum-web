import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { EditorView, keymap, placeholder as cmPlaceholder, ViewUpdate, lineNumbers } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { lintGutter, linter } from '@codemirror/lint'
import { latex, latexLinter } from 'codemirror-lang-latex'
import { Settings, Play, Menu } from 'lucide-react'
import DocumentManager from '../../services/DocumentManager'
import CompilerService from '../../services/CompilerService'
import EventBus from '../../services/EventBus'
import CitationPopover from '../CitationPopover'
import stateStore from '../../services/StateStore'
import './LaTeXEditor.css'

interface LaTeXEditorProps {
  value: string
  onChange: (value: string) => void
  onSelectionChange?: (start: number, end: number, selectedText: string) => void
  onMenuClick?: () => void
  documentId?: string
  compilerSettings?: CompilerSettings
  onCompilerSettingsChange?: (settings: CompilerSettings) => void
  compileStatus?: CompileStatusType
  compileTimeMs?: number | null
  onCompile?: () => void
}

export type CompilerType = 'auto' | 'pdflatex' | 'xelatex'

export interface CompilerSettings {
  autoCompile: boolean
  compiler: CompilerType
  ctanFetch: boolean
  cachePreamble: boolean
  autoUnload: boolean
}

export type CompileStatusType = 'idle' | 'initializing' | 'compiling' | 'success' | 'error'

// Dark theme matching your design
const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-base)',
    color: 'var(--color-text-primary)',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: "'SF Mono', Monaco, 'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: '17px',
    lineHeight: '1.7',
    padding: '24px 0 36px 0',
    caretColor: 'var(--color-text-primary)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-text-primary)',
    borderLeftWidth: '1px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-base)',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    fontFamily: "'SF Mono', Monaco, 'JetBrains Mono', monospace",
    fontSize: '14px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 12px',
    minWidth: '32px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-secondary)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(184, 149, 110, 0.25) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(184, 149, 110, 0.25) !important',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    outline: '1px solid rgba(255, 255, 255, 0.12)',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-base-lighter)',
    border: '1px solid var(--color-border)',
    borderRadius: '12px',
    boxShadow: '0 10px 38px rgba(0, 0, 0, 0.5), 0 4px 16px rgba(0, 0, 0, 0.3)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    '& > ul': {
      fontFamily: "'SF Mono', Monaco, 'JetBrains Mono', monospace",
      fontSize: '14px',
    },
    '& > ul > li': {
      padding: '6px 12px',
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'var(--color-accent)',
      color: 'var(--color-base)',
    },
  },
  '.cm-tooltip-hover': {
    padding: '8px 12px',
  },
  '.cm-placeholder': {
    color: 'var(--color-text-tertiary)',
    fontStyle: 'italic',
  },
  '.cm-foldGutter': {
    width: '16px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 4px',
    fontSize: '14px',
    cursor: 'pointer',
    color: 'var(--color-text-tertiary)',
    transition: 'color 0.15s ease',
  },
  '.cm-foldGutter .cm-gutterElement:hover': {
    color: 'var(--color-text-secondary)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    border: 'none',
    color: 'var(--color-text-tertiary)',
    padding: '2px 6px',
    borderRadius: '3px',
    margin: '0 4px',
    fontSize: '12px',
  },
  // Scrollbar styling
  '&::-webkit-scrollbar': {
    width: '6px',
    height: '6px',
  },
  '&::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '&::-webkit-scrollbar-thumb': {
    background: 'var(--color-border)',
    borderRadius: '3px',
  },
  '&::-webkit-scrollbar-thumb:hover': {
    background: 'rgba(255, 255, 255, 0.2)',
  },
}, { dark: true })

// Desert theme syntax highlighting using Lezer tags
const desertHighlightStyle = HighlightStyle.define([
  // Keywords (commands like \begin, \end) - muted terracotta
  { tag: tags.keyword, color: '#c08868' },
  // Comments - muted warm gray, italic
  { tag: tags.comment, color: '#706d68', fontStyle: 'italic' },
  // Strings/literal content - soft sage green
  { tag: tags.string, color: '#a3b38c' },
  { tag: tags.literal, color: '#a3b38c' },
  // Numbers - warm gold
  { tag: tags.number, color: '#d4a656' },
  // Operators - muted sand
  { tag: tags.operator, color: '#a8a5a0' },
  // Processing instructions ($ delimiters) - dusty rose
  { tag: tags.processingInstruction, color: '#c9a0a0' },
  // Brackets - warm sand
  { tag: tags.bracket, color: '#d4b896' },
  { tag: tags.paren, color: '#d4b896' },
  { tag: tags.brace, color: '#d4b896' },
  { tag: tags.squareBracket, color: '#d4b896' },
  // Class names (environment names like itemize, document) - warm teal/turquoise
  { tag: tags.className, color: '#7eb8a8' },
  // Headings (section commands) - bright warm sand
  { tag: tags.heading, color: '#e8c896' },
  // Strong/bold text
  { tag: tags.strong, fontWeight: 'bold' },
  // Emphasis/italic text
  { tag: tags.emphasis, fontStyle: 'italic' },
  // Meta (verbatim content) - dusty lavender
  { tag: tags.meta, color: '#a89bb8' },
  // Variable names (math chars) - warm copper
  { tag: tags.variableName, color: '#c9956e' },
])

const LaTeXEditor: React.FC<LaTeXEditorProps> = React.memo(({
  value,
  onChange,
  onSelectionChange,
  onMenuClick,
  documentId,
  compilerSettings: externalSettings,
  onCompilerSettingsChange,
  compileStatus = 'idle',
  compileTimeMs,
  onCompile,
}) => {
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [logs, setLogs] = useState<{time: string, type: string, message: string}[]>([])
  const [consoleHeight, setConsoleHeight] = useState(() => {
    const saved = sessionStorage.getItem('consoleHeight')
    return saved ? parseInt(saved, 10) : 180
  })
  const consoleLogsRef = useRef<HTMLDivElement>(null)
  const isResizingRef = useRef(false)
  const [showOutline, setShowOutline] = useState(false)
  const [sections, setSections] = useState<{ level: number; title: string; line: number }[]>([])
  const [showCompilerSettings, setShowCompilerSettings] = useState(false)

  // Citation popover state
  const [citationPopoverOpen, setCitationPopoverOpen] = useState(false)
  const [citationPopoverPos, setCitationPopoverPos] = useState({ top: 0, left: 0 })
  const citationInsertPosRef = useRef<number>(0)
  // Track if user dismissed the popover (via Escape) to prevent re-opening
  const citationDismissedRef = useRef(false)

  // Use external settings if provided, otherwise use local state
  const [localSettings, setLocalSettings] = useState<CompilerSettings>({
    autoCompile: true,
    compiler: 'auto',
    ctanFetch: true,
    cachePreamble: true,
    autoUnload: true,
  })
  const compilerSettings = externalSettings ?? localSettings
  const setCompilerSettings = onCompilerSettingsChange ?? setLocalSettings

  const compilerSettingsRef = useRef<HTMLDivElement>(null)

  // Track if we're updating value from external source
  const isExternalUpdate = useRef(false)

  // Ref for documentId to avoid stale closure in updateListener
  const documentIdRef = useRef(documentId)
  useEffect(() => {
    documentIdRef.current = documentId
  }, [documentId])

  // Track which document we've restored cursor for (to avoid duplicate restores)
  const restoredCursorForDoc = useRef<string | null>(null)

  // Compartment for dynamic configuration
  const readOnlyCompartment = useMemo(() => new Compartment(), [])

  // Subscribe to compiler logs with truncation to prevent memory leak
  // Keep max 500 logs to bound memory usage
  const MAX_LOGS = 500
  useEffect(() => {
    const unsubscribe = CompilerService.onLog((message) => {
      const now = new Date()
      const time = now.toLocaleTimeString('en-US', { hour12: false })
      const type = message.toLowerCase().includes('error') ? 'error'
        : message.toLowerCase().includes('warning') ? 'warning'
        : message.toLowerCase().includes('success') ? 'success'
        : 'info'
      setLogs(prev => {
        const newLogs = [...prev, { time, type, message }]
        // Truncate if exceeding max - keep newest logs
        if (newLogs.length > MAX_LOGS) {
          return newLogs.slice(-MAX_LOGS)
        }
        return newLogs
      })
    })
    return unsubscribe
  }, [])

  // Clear logs when compilation starts
  useEffect(() => {
    if (compileStatus === 'compiling') setLogs([])
  }, [compileStatus])

  // Reset cursor restoration tracking when document changes
  useEffect(() => {
    // When switching documents, allow cursor restoration for the new document
    if (documentId && restoredCursorForDoc.current !== documentId) {
      restoredCursorForDoc.current = null
    }
  }, [documentId])

  // Save cursor position when selection changes
  const saveCursorPosition = useCallback((start: number, end: number) => {
    if (documentId) {
      stateStore.setCursorPosition(documentId, start, end)
    }
  }, [documentId])

  // Save scroll position when scrolling
  const saveScrollPosition = useCallback((scrollTop: number, scrollLeft: number) => {
    if (documentId) {
      stateStore.setScrollPosition(documentId, scrollTop, scrollLeft)
    }
  }, [documentId])

  // Create editor on mount
  useEffect(() => {
    if (!editorContainerRef.current || editorViewRef.current) return

    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged && !isExternalUpdate.current) {
        const newValue = update.state.doc.toString()
        onChange(newValue)
      }

      if (update.selectionSet) {
        const selection = update.state.selection.main
        const selectedText = update.state.sliceDoc(selection.from, selection.to)
        if (onSelectionChange) {
          onSelectionChange(selection.from, selection.to, selectedText)
        }

        // Save cursor position to DocumentManager (legacy)
        DocumentManager.setCursorPosition({ start: selection.from, end: selection.to })

        // Save cursor position to StateStore (uses ref to avoid stale closure)
        if (documentIdRef.current) {
          stateStore.setCursorPosition(documentIdRef.current, selection.from, selection.to)
        }
      }

      // Detect \cite{ pattern for citation popover (only on doc changes, not cursor movement)
      if (update.docChanged) {
        const pos = update.state.selection.main.head
        const doc = update.state.doc.toString()
        // Look back up to 20 chars to find \cite{ or \citep{ or \citet{ etc
        const lookback = doc.slice(Math.max(0, pos - 20), pos)
        const citeMatch = lookback.match(/\\cite[pt]?\{([^}]*)$/)

        if (citeMatch) {
          // We're inside a cite command - show popover (unless dismissed)
          if (!citationDismissedRef.current) {
            const coords = update.view.coordsAtPos(pos)
            if (coords) {
              setCitationPopoverPos({
                top: coords.bottom + 4,
                left: coords.left
              })
              citationInsertPosRef.current = pos
              setCitationPopoverOpen(true)
            }
          }
        } else {
          // Close popover and reset dismissed state when leaving cite context
          setCitationPopoverOpen(false)
          citationDismissedRef.current = false
        }

      }
    })

    // Custom keymap for our shortcuts
    const customKeymap = keymap.of([
      // Cmd+K - toggle command palette
      {
        key: 'Mod-k',
        run: () => {
          EventBus.emit('toggleCommandPalette')
          return true
        },
      },
      // Cmd+Shift+K - also toggle command palette
      {
        key: 'Mod-Shift-k',
        run: () => {
          EventBus.emit('toggleCommandPalette')
          return true
        },
      },
      // Cmd+Shift+F - toggle command palette
      {
        key: 'Mod-Shift-f',
        run: () => {
          EventBus.emit('toggleCommandPalette')
          return true
        },
      },
      // Cmd+S - trigger compile
      {
        key: 'Mod-s',
        run: () => {
          EventBus.emit('triggerCompile')
          return true
        },
      },
      // Cmd+B - bold
      {
        key: 'Mod-b',
        run: (view) => {
          wrapSelectionInView(view, '\\textbf{', '}')
          return true
        },
      },
      // Cmd+I - italic
      {
        key: 'Mod-i',
        run: (view) => {
          wrapSelectionInView(view, '\\textit{', '}')
          return true
        },
      },
      // Cmd+Shift+M - inline math
      {
        key: 'Mod-Shift-m',
        run: (view) => {
          wrapSelectionInView(view, '$', '$')
          return true
        },
      },
      // Cmd+Shift+D - display math
      {
        key: 'Mod-Shift-d',
        run: (view) => {
          wrapSelectionInView(view, '\\[\n  ', '\n\\]')
          return true
        },
      },
      // Prevent default undo/redo to let App.tsx handle it
      {
        key: 'Mod-z',
        run: () => {
          // Let App.tsx handle undo
          return false
        },
      },
      {
        key: 'Mod-Shift-z',
        run: () => {
          // Let App.tsx handle redo
          return false
        },
      },
      {
        key: 'Mod-y',
        run: () => {
          // Let App.tsx handle redo
          return false
        },
      },
    ])

    const state = EditorState.create({
      doc: value,
      extensions: [
        // Core extensions
        lineNumbers(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        foldGutter(),

        // LaTeX language support (includes syntax, tooltips, auto-closing)
        latex({
          autoCloseTags: true,
          enableLinting: false, // We'll add linter separately for custom config
          enableTooltips: true,
          enableAutocomplete: true, // Use built-in LaTeX autocompletion
        }),

        // Linting
        linter(latexLinter()),
        lintGutter(),

        // Keymaps
        customKeymap,
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),

        // Theme
        darkTheme,
        syntaxHighlighting(desertHighlightStyle),

        // Placeholder for empty docs
        cmPlaceholder('Start writing LaTeX... try ⌘K to search, or just begin typing'),

        // Line wrapping
        EditorView.lineWrapping,

        // Update listener
        updateListener,

        // Read-only compartment (for future use)
        readOnlyCompartment.of([]),
      ],
    })

    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    })

    editorViewRef.current = view

    // Restore cursor position
    const cursorPos = DocumentManager.getCursorPosition()
    if (cursorPos) {
      view.dispatch({
        selection: { anchor: cursorPos.start, head: cursorPos.end },
        scrollIntoView: true,
      })
    }

    // Focus editor
    view.focus()

    return () => {
      view.destroy()
      editorViewRef.current = null
    }
  }, []) // Empty deps - only run on mount

  // Update editor when value changes externally
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return

    // Optimization: Check length first to avoid O(n) string comparison on every keystroke
    // For large documents (thousands of lines), this skips creating a full string copy
    // when the length already differs (common case: adding/deleting text)
    const currentLength = view.state.doc.length
    if (currentLength !== value.length) {
      // Length differs, definitely need to update
      isExternalUpdate.current = true
      view.dispatch({
        changes: { from: 0, to: currentLength, insert: value },
      })
      isExternalUpdate.current = false
    } else if (currentLength > 0) {
      // Same length - need full comparison (rare case: character replacement)
      // Only create string copy when absolutely necessary
      const currentValue = view.state.doc.toString()
      if (currentValue !== value) {
        isExternalUpdate.current = true
        view.dispatch({
          changes: { from: 0, to: currentLength, insert: value },
        })
        isExternalUpdate.current = false
      }
    }

    // Restore cursor/scroll position AFTER content is loaded (once per document)
    const docId = documentIdRef.current
    if (docId && value.length > 0 && restoredCursorForDoc.current !== docId) {
      restoredCursorForDoc.current = docId

      stateStore.getDocumentState(docId).then(state => {
        if (!state || !editorViewRef.current) return

        const currentView = editorViewRef.current
        const docLength = currentView.state.doc.length

        // Restore cursor position (clamp to document length)
        const cursorStart = Math.min(state.cursorStart, docLength)
        const cursorEnd = Math.min(state.cursorEnd, docLength)

        // Only restore if there's a meaningful saved position
        if (cursorStart > 0 || cursorEnd > 0) {
          currentView.dispatch({
            selection: { anchor: cursorStart, head: cursorEnd }
          })
        }

        // Restore scroll position
        if (state.scrollTop > 0 || state.scrollLeft > 0) {
          currentView.scrollDOM.scrollTop = state.scrollTop
          currentView.scrollDOM.scrollLeft = state.scrollLeft
        }
      })
    }
  }, [value])

  // Set up scroll event listener for state persistence
  useEffect(() => {
    const view = editorViewRef.current
    if (!view || !documentId) return

    let scrollTimeout: number | null = null
    const handleScroll = () => {
      // Debounce scroll saves to avoid excessive writes
      if (scrollTimeout) clearTimeout(scrollTimeout)
      scrollTimeout = window.setTimeout(() => {
        const { scrollTop, scrollLeft } = view.scrollDOM
        saveScrollPosition(scrollTop, scrollLeft)
      }, 200)
    }

    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      if (scrollTimeout) clearTimeout(scrollTimeout)
    }
  }, [documentId, saveScrollPosition])

  // Listen for goToLine events from search results
  useEffect(() => {
    const handleGoToLine = (e: CustomEvent<{ line: number }>) => {
      const view = editorViewRef.current
      if (view && e.detail.line) {
        const lineCount = view.state.doc.lines
        const targetLine = Math.min(e.detail.line, lineCount)
        const lineInfo = view.state.doc.line(targetLine)
        view.dispatch({
          selection: { anchor: lineInfo.from },
          scrollIntoView: true,
          effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
        })
        view.focus()
      }
    }

    window.addEventListener('goToLine', handleGoToLine as EventListener)
    return () => window.removeEventListener('goToLine', handleGoToLine as EventListener)
  }, [])

  // Listen for insertText events from CommandPalette citation selection
  useEffect(() => {
    return EventBus.on('insertText', ({ text }) => {
      const view = editorViewRef.current
      if (!view) return

      const pos = view.state.selection.main.head
      view.dispatch({
        changes: { from: pos, to: pos, insert: text },
        selection: { anchor: pos + text.length }
      })
      view.focus()
    })
  }, [])

  // Helper to wrap selection
  const wrapSelectionInView = useCallback((view: EditorView, prefix: string, suffix: string) => {
    const selection = view.state.selection.main
    const selectedText = view.state.sliceDoc(selection.from, selection.to)
    const wrappedText = prefix + selectedText + suffix

    view.dispatch({
      changes: {
        from: selection.from,
        to: selection.to,
        insert: wrappedText,
      },
      selection: selectedText === ''
        ? { anchor: selection.from + prefix.length }
        : { anchor: selection.from, head: selection.from + wrappedText.length },
    })

    view.focus()
  }, [])

  const handleCommandPalette = useCallback(() => {
    EventBus.emit('toggleCommandPalette')
  }, [])

  const handleHelp = useCallback(() => {
    EventBus.emit('toggleHelp')
  }, [])

  const handleClearLogs = useCallback(() => {
    setLogs([])
  }, [])

  const handleCopyLogs = useCallback(() => {
    const logText = logs.map(log => `[${log.time}] ${log.type.toUpperCase()}: ${log.message}`).join('\n')
    navigator.clipboard.writeText(logText)
  }, [logs])

  // Handle citation insertion from popover
  const handleCitationInsert = useCallback((citeKey: string, _bibtex: string) => {
    const view = editorViewRef.current
    if (!view) return

    const pos = citationInsertPosRef.current
    // Insert the cite key and close the brace
    view.dispatch({
      changes: { from: pos, to: pos, insert: `${citeKey}}` },
      selection: { anchor: pos + citeKey.length + 1 }
    })
    setCitationPopoverOpen(false)
    // Reset dismissed flag after the call stack completes (after onClose runs)
    // This ensures future citations will trigger the popover
    setTimeout(() => {
      citationDismissedRef.current = false
    }, 0)
    view.focus()
  }, [])

  // Use RAF to debounce resize updates - prevents layout thrashing
  const pendingHeightRef = useRef<number | null>(null)
  const rafIdRef = useRef<number | null>(null)

  const handleConsoleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRef.current = true
    const startY = e.clientY
    const startHeight = consoleHeight

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return
      const delta = startY - e.clientY
      const newHeight = Math.max(100, Math.min(600, startHeight + delta))

      // Store pending height and schedule RAF update
      pendingHeightRef.current = newHeight
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          if (pendingHeightRef.current !== null) {
            setConsoleHeight(pendingHeightRef.current)
          }
          rafIdRef.current = null
        })
      }
    }

    const handleMouseUp = () => {
      isResizingRef.current = false
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      // Apply final height
      if (pendingHeightRef.current !== null) {
        setConsoleHeight(pendingHeightRef.current)
        pendingHeightRef.current = null
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [consoleHeight])

  // Save console height when it changes
  useEffect(() => {
    sessionStorage.setItem('consoleHeight', String(consoleHeight))
  }, [consoleHeight])

  // Scroll console to bottom when opened
  useEffect(() => {
    if (consoleOpen && consoleLogsRef.current) {
      consoleLogsRef.current.scrollTop = consoleLogsRef.current.scrollHeight
    }
  }, [consoleOpen])

  // Close compiler settings dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (compilerSettingsRef.current && !compilerSettingsRef.current.contains(e.target as Node)) {
        setShowCompilerSettings(false)
      }
    }
    if (showCompilerSettings) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showCompilerSettings])

  // Parse LaTeX for sections
  const parseSections = useCallback((text: string) => {
    const sectionRegex = /\\(part|chapter|section|subsection|subsubsection|paragraph)\{([^}]+)\}/g
    const levelMap: Record<string, number> = {
      'part': 0,
      'chapter': 1,
      'section': 2,
      'subsection': 3,
      'subsubsection': 4,
      'paragraph': 5
    }

    const results: { level: number; title: string; line: number }[] = []
    const lines = text.split('\n')

    lines.forEach((line, index) => {
      let match
      sectionRegex.lastIndex = 0
      while ((match = sectionRegex.exec(line)) !== null) {
        results.push({
          level: levelMap[match[1]] || 2,
          title: match[2],
          line: index + 1
        })
      }
    })

    return results
  }, [])

  // Update sections when content changes (debounced to avoid parsing on every keystroke)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const newSections = parseSections(value)
      setSections(newSections)
    }, 300)
    return () => clearTimeout(timeoutId)
  }, [value, parseSections])

  // Jump to section
  const jumpToSection = useCallback((line: number) => {
    const view = editorViewRef.current
    if (view) {
      const lineInfo = view.state.doc.line(line)
      view.dispatch({
        selection: { anchor: lineInfo.from },
        scrollIntoView: true,
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
      })
      view.focus()
    }
  }, [])

  return (
    <div className="latex-editor-container">
      <div className="editor-toolbar">
        <div className="toolbar-left">
          {onMenuClick && (
            <button className="toolbar-item mobile-menu-btn" onClick={onMenuClick}>
              <Menu size={16} />
            </button>
          )}
          <button className="toolbar-item" onClick={handleCommandPalette}>
            <span>Search</span>
          </button>
          <button className="toolbar-item" onClick={handleHelp}>
            <span>Help</span>
          </button>
          <div className="toolbar-separator" />
          <div className="compiler-settings-wrapper" ref={compilerSettingsRef}>
            <button
              className={`toolbar-item compiler-settings-button ${showCompilerSettings ? 'active' : ''}`}
              onClick={() => setShowCompilerSettings(!showCompilerSettings)}
              title="Compiler settings"
            >
              <Settings size={14} />
            </button>
            {showCompilerSettings && (
              <div className="compiler-settings-dropdown">
                <div className="compiler-setting-row">
                  <span className="setting-label">Auto-compile</span>
                  <button
                    className={`setting-toggle ${compilerSettings.autoCompile ? 'active' : ''}`}
                    onClick={() => setCompilerSettings({ ...compilerSettings, autoCompile: !compilerSettings.autoCompile })}
                  >
                    <span className="toggle-track">
                      <span className="toggle-thumb" />
                    </span>
                  </button>
                </div>
                <div className="compiler-setting-row">
                  <span className="setting-label">Compiler</span>
                  <select
                    className="setting-select"
                    value={compilerSettings.compiler}
                    onChange={(e) => setCompilerSettings({ ...compilerSettings, compiler: e.target.value as CompilerType })}
                  >
                    <option value="auto">Auto</option>
                    <option value="pdflatex">pdfLaTeX</option>
                    <option value="xelatex">XeLaTeX</option>
                  </select>
                </div>
                <div className="compiler-setting-row">
                  <span className="setting-label">CTAN fetch</span>
                  <button
                    className={`setting-toggle ${compilerSettings.ctanFetch ? 'active' : ''}`}
                    onClick={() => setCompilerSettings({ ...compilerSettings, ctanFetch: !compilerSettings.ctanFetch })}
                  >
                    <span className="toggle-track">
                      <span className="toggle-thumb" />
                    </span>
                  </button>
                </div>
                <div className="compiler-setting-row">
                  <span className="setting-label">Cache preamble</span>
                  <button
                    className={`setting-toggle ${compilerSettings.cachePreamble ? 'active' : ''}`}
                    onClick={() => setCompilerSettings({ ...compilerSettings, cachePreamble: !compilerSettings.cachePreamble })}
                  >
                    <span className="toggle-track">
                      <span className="toggle-thumb" />
                    </span>
                  </button>
                </div>
                <div className="compiler-setting-row">
                  <span className="setting-label" title="Unload compiler after 5 min idle to save ~500MB RAM">Low memory mode</span>
                  <button
                    className={`setting-toggle ${compilerSettings.autoUnload ? 'active' : ''}`}
                    onClick={() => setCompilerSettings({ ...compilerSettings, autoUnload: !compilerSettings.autoUnload })}
                  >
                    <span className="toggle-track">
                      <span className="toggle-thumb" />
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
          {!compilerSettings.autoCompile && (
            <>
              <div className="toolbar-separator" />
              <button
                className="toolbar-item compile-button"
                onClick={() => onCompile?.()}
                disabled={compileStatus === 'compiling' || compileStatus === 'initializing'}
                title="Compile (⌘S)"
              >
                <Play size={14} />
                <span>{compileStatus === 'compiling' ? 'Compiling...' : compileStatus === 'initializing' ? 'Loading...' : 'Compile'}</span>
              </button>
            </>
          )}
        </div>
        <div className="toolbar-right">
          {sections.length > 0 && (
            <>
              <button
                className={`toolbar-item ${showOutline ? 'active' : ''}`}
                onClick={() => setShowOutline(!showOutline)}
                title="Document outline"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </button>
              <div className="toolbar-separator" />
            </>
          )}
          <button
            className={`compile-status ${consoleOpen ? 'active' : ''} ${compileStatus}`}
            onClick={() => setConsoleOpen(!consoleOpen)}
          >
            {compileStatus === 'compiling' ? '...' :
             compileStatus === 'initializing' ? 'init' :
             compileTimeMs != null ? `${Math.round(compileTimeMs)}ms` : '—'}
          </button>
        </div>
      </div>
      <div
        className="editor-wrapper"
        style={consoleOpen ? { height: `calc(100% - 32px - ${consoleHeight}px)` } : undefined}
      >
        <div ref={editorContainerRef} className="codemirror-container" />
      </div>
      {showOutline && sections.length > 0 && (
        <div className="editor-outline">
          {sections.map((section, index) => (
            <button
              key={index}
              className={`outline-item outline-level-${section.level}`}
              onClick={() => jumpToSection(section.line)}
            >
              <span className="outline-title">{section.title}</span>
              <span className="outline-line">{section.line}</span>
            </button>
          ))}
        </div>
      )}
      {consoleOpen && (
        <div className="compile-console" style={{ height: consoleHeight }}>
          <div className="console-resize-handle" onMouseDown={handleConsoleResizeStart} />
          <div className="console-header">
            <span className="console-title">Compile Output</span>
            <div className="console-actions">
              <button className="console-action" onClick={handleCopyLogs} title="Copy logs">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              </button>
              <div className="console-separator" />
              <button className="console-action" onClick={handleClearLogs} title="Clear">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </button>
              <button className="console-action" onClick={() => setConsoleOpen(false)} title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="console-logs" ref={consoleLogsRef}>
            {logs.length === 0 ? (
              <div className="console-empty">No output</div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className={`console-log log-${log.type}`}>
                  <span className="log-time">{log.time}</span>
                  <span className="log-message">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <CitationPopover
        isOpen={citationPopoverOpen}
        position={citationPopoverPos}
        onClose={() => {
          setCitationPopoverOpen(false)
          citationDismissedRef.current = true
        }}
        onInsert={handleCitationInsert}
      />
    </div>
  )
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render when significant props change
  return (
    prevProps.value === nextProps.value &&
    prevProps.compileStatus === nextProps.compileStatus &&
    prevProps.compileTimeMs === nextProps.compileTimeMs &&
    prevProps.compilerSettings?.autoCompile === nextProps.compilerSettings?.autoCompile &&
    prevProps.compilerSettings?.compiler === nextProps.compilerSettings?.compiler &&
    prevProps.compilerSettings?.ctanFetch === nextProps.compilerSettings?.ctanFetch &&
    prevProps.compilerSettings?.cachePreamble === nextProps.compilerSettings?.cachePreamble &&
    prevProps.compilerSettings?.autoUnload === nextProps.compilerSettings?.autoUnload
  )
})

export default LaTeXEditor
