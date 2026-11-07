import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { EditorView, keymap, placeholder as cmPlaceholder, ViewUpdate, lineNumbers, Decoration, highlightActiveLine, highlightActiveLineGutter, ViewPlugin, WidgetType, drawSelection } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder, Transaction } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, isolateHistory, indentWithTab, insertNewline } from '@codemirror/commands'
import { bracketMatching, foldGutter, syntaxHighlighting, HighlightStyle, foldEffect, unfoldEffect, LanguageSupport } from '@codemirror/language'
import { styleTags, tags } from '@lezer/highlight'
import { closeBrackets, closeBracketsKeymap, completionKeymap, autocompletion } from '@codemirror/autocomplete'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { linter } from '@codemirror/lint'
import { latexLinter, latexBracketMatching, latexCompletionSource, latexLanguage, latexHoverTooltip, autoCloseTags } from 'codemirror-lang-latex'
import { Settings, Play, Menu, X, ChevronUp, ChevronDown, Filter, FileText } from 'lucide-react'
import { fileManager } from '../../services/FileManager'
import CompilerService from '../../services/CompilerService'
import { createBatchedLogger } from '@siglum/engine'
import EventBus from '../../services/EventBus'
import GitService from '../../services/GitService'
import syncTexService from '../../services/SyncTexService'
import { compilationContext } from '../../services/CompilationFiles'
import CitationPopover from '../CitationPopover'
import SelectionContextMenu from '../SelectionContextMenu'
import stateStore from '../../services/FileStateStore'
import ProjectStore from '../../services/ProjectStore'
import FileReaderService from '../../services/FileReaderService'
import { fileSystem } from '@siglum/filesystem'
import { useWordCount } from '../../hooks/useWordCount'
import type { TexDiagnostic } from '../../utils/texLogParser'
import type { MobileEditorApi, CursorContext } from '../MobileStudio/model'
import './LaTeXEditor.css'

// File completion configuration - extensible for different LaTeX commands
interface FileCompletionConfig {
  pattern: RegExp  // Pattern to match (captures the partial path typed so far)
  extensions: Set<string>  // File extensions to show (empty = all files)
  stripExtension?: boolean  // Whether to strip .tex extension from completions
}

// Pre-compiled configs with Set for O(1) extension lookup
const FILE_COMPLETION_CONFIGS: FileCompletionConfig[] = [
  {
    pattern: /\\(?:input|include)\{([^}]*)$/,
    extensions: new Set(['tex']),
    stripExtension: true,
  },
  {
    pattern: /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/,
    extensions: new Set(['png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg']),
    stripExtension: false,
  },
  {
    pattern: /\\bibliography\{([^}]*)$/,
    extensions: new Set(['bib']),
    stripExtension: true,
  },
]

// Cache for filtered files by extension set (cleared when files change)
let fileCache: { files: ReturnType<typeof ProjectStore.getAllFiles>, byExt: Map<Set<string>, ReturnType<typeof ProjectStore.getAllFiles>> } | null = null
let lastFileCount = -1

// LaTeX escape sequences for display (module-level for efficiency)
const LATEX_ESCAPES: Record<string, string> = {
  "\\&": "&", "\\%": "%", "\\$": "$", "\\#": "#",
  "\\_": "_", "\\{": "{", "\\}": "}", "\\~": "~",
  "\\textasciitilde": "~", "\\textbackslash": "\\",
  "\\textemdash": "\u2014", "\\textendash": "\u2013",
  "\\textquotedblleft": "\u201C", "\\textquotedblright": "\u201D",
  "\\textquoteleft": "\u2018", "\\textquoteright": "\u2019",
  "~~": " ",
}
const LATEX_ESCAPE_REGEX = /\\(?:text\w+|[&%$#_{}~])|~~/g

function getFilteredFiles(extensions: Set<string>) {
  const allFiles = ProjectStore.getAllFiles()

  // Invalidate cache if file count changed
  if (allFiles.length !== lastFileCount) {
    fileCache = { files: allFiles, byExt: new Map() }
    lastFileCount = allFiles.length
  }

  if (!fileCache) {
    fileCache = { files: allFiles, byExt: new Map() }
  }

  // Check cache first
  const cached = fileCache.byExt.get(extensions)
  if (cached) return cached

  // Filter and cache
  const filtered = extensions.size === 0 ? allFiles : allFiles.filter(f => {
    const ext = f.path.split('.').pop()?.toLowerCase()
    return ext && extensions.has(ext)
  })

  fileCache.byExt.set(extensions, filtered)
  return filtered
}

// Create file completion source for LaTeX commands
function fileCompletionSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  const textBefore = line.text.slice(0, context.pos - line.from)

  // Quick check: must contain backslash to be relevant
  if (!textBefore.includes('\\')) return null

  // Check each config to see if we should trigger completions
  for (const config of FILE_COMPLETION_CONFIGS) {
    const match = textBefore.match(config.pattern)
    if (!match) continue

    const partialPath = match[1] || ''
    const startPos = context.pos - partialPath.length

    // Get cached filtered files
    let files = getFilteredFiles(config.extensions)

    // Filter by partial path (case-insensitive) - only if user typed something
    if (partialPath) {
      const lowerPartial = partialPath.toLowerCase()
      files = files.filter(f =>
        f.path.toLowerCase().includes(lowerPartial) ||
        f.name.toLowerCase().includes(lowerPartial)
      )
    }

    if (files.length === 0) return null

    // Convert to completions
    const options = files.map(f => {
      let label = f.path.startsWith('/') ? f.path.slice(1) : f.path
      if (config.stripExtension) {
        label = label.replace(/\.tex$/, '')
      }
      return {
        label,
        type: 'file' as const,
        boost: partialPath && f.name.toLowerCase().startsWith(partialPath.toLowerCase()) ? 1 : 0,
      }
    })

    return {
      from: startPos,
      options,
      validFor: /^[^}]*$/,
    }
  }

  return null
}


export interface LaTeXEditorProps {
  mobileApiRef?: React.MutableRefObject<MobileEditorApi | null>
  onCursorContext?: (context: CursorContext) => void
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
  onCitationInsert?: (citeKey: string, bibtex: string) => void
  showWordCount?: boolean
  onShowWordCountChange?: (show: boolean) => void
  showCompileStatus?: boolean
  onShowCompileStatusChange?: (show: boolean) => void
  diagnostics?: TexDiagnostic[]
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

// Section can be from main document or an included file
interface Section {
  level: number
  title: string
  line: number
  sourceFile?: string  // If from \input{file}, the path to the included file
}

// Dark theme matching your design
const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: '#CDC9C1',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: "'Commit Mono', 'SF Mono', 'Cascadia Code', monospace",
    fontSize: '17px',
    lineHeight: '1.5',
    padding: '8px 0 36px 0',
    caretColor: '#D97757',
  },
  '.cm-cursor': {
    borderLeftColor: '#D97757',
    borderLeftWidth: '1.5px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-base)',
    color: 'rgba(205, 201, 193, 0.2)',
    borderRight: '1px solid rgba(232, 227, 211, 0.08)',
    fontFamily: "'Commit Mono', 'SF Mono', 'Cascadia Code', monospace",
    fontSize: '14px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 8px',
    minWidth: '28px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-secondary)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(232, 227, 211, 0.03)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(217, 119, 87, 0.25) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(217, 119, 87, 0.25) !important',
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
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    padding: '4px',
    '& > ul': {
      fontFamily: "'Commit Mono', 'SF Mono', 'Cascadia Code', monospace",
      fontSize: '12.5px',
    },
    '& > ul > li': {
      borderRadius: '6px',
      padding: '7px 10px',
      color: 'var(--color-text-tertiary)',
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(232, 227, 211, 0.08)',
      color: 'var(--color-text-secondary)',
    },
  },
  '.cm-tooltip-hover': {
    padding: '8px 12px',
  },
  '.cm-placeholder': {
    color: 'var(--color-text-tertiary)',
    fontStyle: 'italic',
  },
  '.cm-foldGutter .cm-gutterElement': {
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
}, { dark: true })

// Desert theme syntax highlighting using Lezer tags
const desertHighlightStyle = HighlightStyle.define([
  // Body text
  { tag: tags.content, color: '#CDC9C1' },
  { tag: tags.strong, fontWeight: 'bold', color: '#CDC9C1' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#CDC9C1' },
  // Headings — warm sand, slightly muted
  { tag: tags.heading, color: '#b8a878', fontWeight: 'bold' },
  // Strings/literal — muted sage
  { tag: tags.string, color: '#7a8a6e' },
  { tag: tags.literal, color: '#7a8a6e' },
  // Monospace
  { tag: tags.monospace, color: '#a8a49c', fontFamily: "'Commit Mono', 'SF Mono', monospace" },
  // Math — muted copper
  { tag: tags.variableName, color: '#a07a5c' },
  { tag: tags.number, color: '#a88a4c' },
  // $ delimiters — muted dusty rose
  { tag: tags.processingInstruction, color: '#8a7070' },
  // Keywords (commands) — muted terracotta
  { tag: tags.keyword, color: '#8a6050' },
  { tag: tags.definitionKeyword, color: '#967058' },
  // Brackets — muted sand
  { tag: tags.bracket, color: '#8a7a68' },
  { tag: tags.paren, color: '#8a7a68' },
  { tag: tags.brace, color: '#8a7a68' },
  { tag: tags.squareBracket, color: '#8a7a68' },
  // Environment names — muted teal
  { tag: tags.className, color: '#5e8878' },
  // Operators — muted sand
  { tag: tags.operator, color: '#787570' },
  // Meta (verbatim) — muted lavender
  { tag: tags.meta, color: '#7a7088' },
  // Comments — muted warm gray
  { tag: tags.comment, color: '#585550', fontStyle: 'italic' },
  // Labels — muted blue-gray
  { tag: tags.labelName, color: '#6a8088' },
  // Citations — muted mauve
  { tag: tags.quote, color: '#887080' },
  // Invalid
  { tag: tags.invalid, color: '#705050' },
])

// Hanging indent for \item lines — wrapped text aligns with content, not the tag
const itemIndentPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.build(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      const newDeco = this.build(update.view)
      // Only swap if decorations actually changed (avoids layout thrash on click)
      if (newDeco.size !== this.decorations.size) {
        this.decorations = newDeco
      } else {
        // Check content equality — map existing through changes if doc changed
        this.decorations = update.docChanged ? newDeco : this.decorations
      }
    }
  }

  build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()
    const { from, to } = view.viewport
    const charWidth = view.defaultCharacterWidth
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos)
      const match = line.text.match(/^(\s*\\item(?:\[[^\]]*\])?\s)/)
      if (match) {
        const indent = match[1].length * charWidth
        builder.add(line.from, line.from, Decoration.line({
          class: 'cm-item-indent',
          attributes: { style: `--item-indent: ${indent}px` }
        }))
      }
      pos = line.to + 1
    }
    return builder.finish()
  }
}, {
  decorations: v => v.decorations,
})

// Image preview for \includegraphics — shows thumbnail below the line
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024 // 50 MB
const INCLUDEGRAPHICS_RE = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g
const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
}

/** Resolve an image path from \includegraphics to a filesystem path, or null */
function resolveImagePath(imagePath: string): string | null {
  const allFiles = ProjectStore.getAllFiles()
  const ext = imagePath.split('.').pop()?.toLowerCase() || ''

  // Only preview browser-displayable image formats
  if (ext && !IMAGE_EXTENSIONS.has(ext)) {
    // Has a non-image extension (e.g. .pdf, .eps) — skip
    if (ext.length <= 5) return null
  }

  // Helper: return the file's path if it's a displayable image, else null
  // FileSystemWatcher paths are already absolute filesystem paths (e.g. /project/src/photo.png)
  const asImagePath = (f: { path: string }) => {
    const fExt = f.path.split('.').pop()?.toLowerCase() || ''
    return IMAGE_EXTENSIONS.has(fExt) ? f.path : null
  }

  // Try exact match against full path or with leading slash
  let match = allFiles.find(f => f.path === imagePath || f.path === '/' + imagePath)
  if (match) return asImagePath(match)

  // Try matching just the filename
  const filename = imagePath.split('/').pop() || imagePath
  match = allFiles.find(f => f.path.endsWith('/' + filename) || f.name === filename)
  if (match) return asImagePath(match)

  // LaTeX often omits extension — try common image extensions
  for (const tryExt of IMAGE_EXTENSIONS) {
    const withExt = imagePath + '.' + tryExt
    match = allFiles.find(f => f.path === withExt || f.path === '/' + withExt)
    if (match) return match.path
    const fnWithExt = filename + '.' + tryExt
    match = allFiles.find(f => f.path.endsWith('/' + fnWithExt) || f.name === fnWithExt)
    if (match) return match.path
  }

  return null
}

class ImagePreviewWidget extends WidgetType {
  private pendingUrl: string | null = null

  constructor(readonly filepath: string, readonly cache: Map<string, string>) {
    super()
  }

  eq(other: ImagePreviewWidget) {
    return this.filepath === other.filepath
  }

  toDOM(view: EditorView) {
    const container = document.createElement('div')
    container.className = 'cm-image-preview'

    const cached = this.cache.get(this.filepath)
    if (cached) {
      const img = document.createElement('img')
      img.src = cached
      container.appendChild(img)
      return container
    }

    // Placeholder while loading
    const placeholder = document.createElement('div')
    placeholder.className = 'cm-image-preview-error'
    placeholder.textContent = 'Loading image...'
    container.appendChild(placeholder)

    const widget = this
    const filepath = this.filepath
    const cache = this.cache
    fileSystem.stat(filepath).then(stats => {
      if (stats.size > MAX_PREVIEW_BYTES) {
        placeholder.textContent = `Too large to preview (${(stats.size / 1024 / 1024).toFixed(0)} MB)`
        return
      }
      return fileSystem.readBinary(filepath, { autoDecompress: false }).then(data => {
        const ext = filepath.split('.').pop()?.toLowerCase() || 'png'
        const mime = MIME_MAP[ext] || 'image/png'
        const blob = new Blob([data], { type: mime })
        const url = URL.createObjectURL(blob)
        widget.pendingUrl = url

        const img = document.createElement('img')
        img.onload = () => {
          widget.pendingUrl = null // Now in cache — plugin.destroy() handles revoke
          cache.set(filepath, url)
          container.replaceChildren(img)
          requestAnimationFrame(() => {
            try { view.requestMeasure() } catch {}
          })
        }
        img.onerror = () => {
          widget.pendingUrl = null
          URL.revokeObjectURL(url)
          placeholder.textContent = 'Image not found'
        }
        img.src = url
      })
    }).catch(() => {
      placeholder.textContent = 'Image not found'
    })

    return container
  }

  destroy() {
    // Revoke blob URL if widget is removed before image finished loading
    if (this.pendingUrl) {
      URL.revokeObjectURL(this.pendingUrl)
      this.pendingUrl = null
    }
  }

  ignoreEvent() { return true }
}

const imageRefreshEffect = StateEffect.define()

const imagePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  cache: Map<string, string> = new Map()
  unsubscribe: (() => void) | null = null
  view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.decorations = this.build(view)
    // When project files change (re-upload), dispatch an effect to trigger a proper update cycle
    this.unsubscribe = ProjectStore.subscribe(() => {
      // Revoke old blob URLs and clear cache so images are re-read from filesystem
      for (const url of this.cache.values()) URL.revokeObjectURL(url)
      this.cache.clear()
      this.view.dispatch({ effects: imageRefreshEffect.of(null) })
    })
  }

  update(update: ViewUpdate) {
    const needsRefresh = update.transactions.some(
      tr => tr.effects.some(e => e.is(imageRefreshEffect))
    )
    if (update.docChanged || update.viewportChanged || needsRefresh) {
      this.decorations = this.build(update.view)
    }
    this.view = update.view
  }

  build(view: EditorView): DecorationSet {
    try {
      const builder = new RangeSetBuilder<Decoration>()
      const { from, to } = view.viewport
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos)
        INCLUDEGRAPHICS_RE.lastIndex = 0
        let match
        while ((match = INCLUDEGRAPHICS_RE.exec(line.text)) !== null) {
          const imagePath = match[1]
          const fsPath = resolveImagePath(imagePath)
          if (fsPath) {
            builder.add(line.to, line.to, Decoration.widget({
              widget: new ImagePreviewWidget(fsPath, this.cache),
              side: 1,
            }))
            break // One preview per line is enough
          }
        }
        pos = line.to + 1
      }
      return builder.finish()
    } catch {
      return Decoration.none
    }
  }

  destroy() {
    this.unsubscribe?.()
    for (const url of this.cache.values()) {
      URL.revokeObjectURL(url)
    }
    this.cache.clear()
  }
}, {
  decorations: v => v.decorations,
})

// Smart quotes: auto-replace " and ' with LaTeX-style quotes
const smartQuotesHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (text === '"') {
    const before = from > 0 ? view.state.doc.sliceString(from - 1, from) : ''
    const isOpening = before === '' || /[\s({[\n]/.test(before)
    const replacement = isOpening ? '``' : "''"
    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: { anchor: from + replacement.length },
    })
    return true
  }
  if (text === "'") {
    const before = from > 0 ? view.state.doc.sliceString(from - 1, from) : ''
    const isOpening = before === '' || /[\s({[\n]/.test(before)
    const replacement = isOpening ? '`' : "'"
    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: { anchor: from + replacement.length },
    })
    return true
  }
  return false
})

// Patch missing styleTags in codemirror-lang-latex plugin.
// These node types exist in the parser but were never assigned highlight tags.
const patchedLatexLanguage = latexLanguage.configure({
  props: [
    styleTags({
      // Commands already partially covered — fill in the gaps
      ItemCtrlSeq: tags.keyword,
      HrefCtrlSeq: tags.keyword,
      UrlCtrlSeq: tags.keyword,
      IncludeGraphicsCtrlSeq: tags.keyword,
      CaptionCtrlSeq: tags.keyword,
      InputCtrlSeq: tags.keyword,
      IncludeCtrlSeq: tags.keyword,
      MaketitleCtrlSeq: tags.keyword,
      // Definition commands
      NewCommandCtrlSeq: tags.definitionKeyword,
      RenewCommandCtrlSeq: tags.definitionKeyword,
      NewEnvironmentCtrlSeq: tags.definitionKeyword,
      RenewEnvironmentCtrlSeq: tags.definitionKeyword,
      DefCtrlSeq: tags.definitionKeyword,
      LetCtrlSeq: tags.definitionKeyword,
      NewTheoremCtrlSeq: tags.definitionKeyword,
      SetLengthCtrlSeq: tags.definitionKeyword,
      // Formatting commands
      CenteringCtrlSeq: tags.keyword,
      TextColorCtrlSeq: tags.keyword,
      ColorBoxCtrlSeq: tags.keyword,
      ParBoxCtrlSeq: tags.keyword,
      // Table commands
      HLineCtrlSeq: tags.keyword,
      TopRuleCtrlSeq: tags.keyword,
      MidRuleCtrlSeq: tags.keyword,
      BottomRuleCtrlSeq: tags.keyword,
      MultiColumnCtrlSeq: tags.keyword,
      // Bibliography
      BibliographyCtrlSeq: tags.keyword,
      BibliographyStyleCtrlSeq: tags.keyword,
      TheoremStyleCtrlSeq: tags.keyword,
      // Catch-all for any unrecognized command (\fancyfoot, \pagestyle, etc.)
      UnknownCommand: tags.keyword,
    }),
  ],
})

// Build LanguageSupport with patched language + hover tooltips
const patchedLatex = new LanguageSupport(patchedLatexLanguage, [latexHoverTooltip])

// Search highlight effect and state field
const setSearchHighlights = StateEffect.define<{
  others: { from: number; to: number }[]
  current: { from: number; to: number } | null
}>()

const searchHighlightMark = Decoration.mark({ class: 'cm-search-match' })
const currentMatchMark = Decoration.mark({ class: 'cm-search-match-current' })

const searchHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlights)) {
        const builder = new RangeSetBuilder<Decoration>()
        // Collect all ranges and sort by position (RangeSetBuilder requires sorted order)
        const allRanges: { from: number; to: number; isCurrent: boolean }[] = []
        for (const { from, to } of effect.value.others) {
          allRanges.push({ from, to, isCurrent: false })
        }
        if (effect.value.current) {
          allRanges.push({ ...effect.value.current, isCurrent: true })
        }
        allRanges.sort((a, b) => a.from - b.from)
        for (const range of allRanges) {
          builder.add(range.from, range.to, range.isCurrent ? currentMatchMark : searchHighlightMark)
        }
        decorations = builder.finish()
      }
    }
    return decorations
  },
  provide: f => EditorView.decorations.from(f),
})

// Fix for fold/unfold causing scroll jumps with lineWrapping enabled
// See: https://github.com/codemirror/codemirror5/issues/6181
const foldScrollFix = ViewPlugin.fromClass(class {
  update(update: ViewUpdate) {
    // Check if this update contains a fold or unfold effect
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(foldEffect) || effect.is(unfoldEffect)) {
          // Schedule scroll position restoration after the fold renders
          // Using requestAnimationFrame to let the DOM update first
          const scrollTop = update.view.scrollDOM.scrollTop
          requestAnimationFrame(() => {
            update.view.scrollDOM.scrollTop = scrollTop
          })
          return
        }
      }
    }
  }
})

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
  onCitationInsert,
  showWordCount = false,
  onShowWordCountChange,
  showCompileStatus = true,
  onShowCompileStatusChange,
  diagnostics = [],
  mobileApiRef,
  onCursorContext,
}) => {
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const syncModeRef = useRef(false) // Track sync mode from PDFViewer toggle
  const editorViewRef = useRef<EditorView | null>(null)
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number; line: number; text: string; canJump: boolean } | null>(null)
  const closeSelectionMenu = useCallback((restoreFocus: boolean) => {
    setSelectionMenu(null)
    if (restoreFocus) editorViewRef.current?.focus()
  }, [])
  useEffect(() => { setSelectionMenu(null) }, [documentId, value])
  const openSelectionMenu = (x: number, y: number) => {
    const view = editorViewRef.current
    if (!view || view.state.selection.main.empty || mobileApiRef) return false
    const selection = view.state.selection.main
    const line = view.state.doc.lineAt(selection.from).number
    setSelectionMenu({ x, y, line, text: view.state.sliceDoc(selection.from, selection.to), canJump: Boolean(syncTexService.forwardSync(line, compilationContext(documentId).mainFile)) })
    return true
  }
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [logs, setLogs] = useState<{time: string, type: string, message: string}[]>([])
  const [consoleHeight, setConsoleHeight] = useState(() => {
    const saved = sessionStorage.getItem('consoleHeight')
    return saved ? parseInt(saved, 10) : 180
  })
  const consoleLogsRef = useRef<HTMLDivElement>(null)
  const isResizingRef = useRef(false)
  const [showOutline, setShowOutline] = useState(false)
  const [outlineFilter, setOutlineFilter] = useState('')
  const [outlinePinned, setOutlinePinned] = useState(false) // True if user clicked a section (keeps panel open)
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0) // Track current section based on scroll
  const [sections, setSections] = useState<Section[]>([])
  const lockedSectionRef = useRef<{ index: number; scrollTop: number } | null>(null) // Lock section until user scrolls away
  const sectionsRef = useRef<Section[]>([])
  const [showCompilerSettings, setShowCompilerSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'compiler' | 'editor'>('compiler')

  // Editor search state (dropdown search bar)
  const [showEditorSearch, setShowEditorSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchCount, setSearchMatchCount] = useState(0)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const savedMatchIndexRef = useRef<number | null>(null) // Preserve position when closing/reopening
  const currentMatchIndexRef = useRef(0) // Track for stable callbacks
  useEffect(() => { currentMatchIndexRef.current = currentMatchIndex }, [currentMatchIndex])
  const searchMatchesRef = useRef<{from: number, to: number}[]>([]) // Cached search matches

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

  // Git branch indicator state
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [gitHasChanges, setGitHasChanges] = useState(false)
  const [gitConnected, setGitConnected] = useState(false)

  const compilerSettingsRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLDivElement>(null)
  const outlineFilterInputRef = useRef<HTMLInputElement>(null)

  // Word count hook
  const { count: wordCount } = useWordCount(value, showWordCount)

  // Subscribe to git status for branch indicator
  useEffect(() => {
    const config = GitService.getConfig()
    const status = GitService.getStatus()
    setGitConnected(status.isConnected)
    setGitHasChanges(status.hasChanges)
    setGitBranch(config?.branch ?? null)

    return GitService.subscribeStatus((status) => {
      setGitConnected(status.isConnected)
      setGitHasChanges(status.hasChanges)
      const cfg = GitService.getConfig()
      setGitBranch(cfg?.branch ?? null)
    })
  }, [])

  // Track if we're updating value from external source
  const isExternalUpdate = useRef(false)
  // Track whether the editor itself produced the last change (to skip redundant value-sync)
  const editorChangedSinceLastSync = useRef(false)

  // Ref for documentId to avoid stale closure in updateListener
  const documentIdRef = useRef(documentId)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onCursorContextRef = useRef(onCursorContext)
  onCursorContextRef.current = onCursorContext

  // Track which document we've restored cursor for (to avoid duplicate restores)
  const restoredCursorForDoc = useRef<string | null>(null)

  // Compartments for dynamic configuration
  const readOnlyCompartment = useMemo(() => new Compartment(), [])
  const highlightCompartment = useMemo(() => new Compartment(), [])
  const historyCompartment = useMemo(() => new Compartment(), [])
  const lineWrappingCompartment = useMemo(() => new Compartment(), [])
  const errorLineCompartment = useMemo(() => new Compartment(), [])

  const [wordWrap, setWordWrap] = useState(true)

  // Subscribe to compiler logs with batching and truncation
  // Batching prevents React re-renders on every log line (~4000 per compile)
  // Keep max 500 logs to bound memory usage
  const MAX_LOGS = 500
  useEffect(() => {
    const batchedLog = createBatchedLogger((messages) => {
      const now = new Date()
      const time = now.toLocaleTimeString('en-US', { hour12: false })
      const newEntries = messages.map(message => ({
        time,
        type: message.toLowerCase().includes('error') ? 'error'
          : message.toLowerCase().includes('warning') ? 'warning'
          : message.toLowerCase().includes('success') ? 'success'
          : 'info' as const,
        message
      }))
      setLogs(prev => {
        const newLogs = [...prev, ...newEntries]
        // Truncate if exceeding max - keep newest logs
        if (newLogs.length > MAX_LOGS) {
          return newLogs.slice(-MAX_LOGS)
        }
        return newLogs
      })
    })
    const unsubscribe = CompilerService.onLog(batchedLog)
    return unsubscribe
  }, [])

  // Clear logs when compilation starts
  useEffect(() => {
    if (compileStatus === 'compiling') setLogs([])
  }, [compileStatus])

  // Listen for goToLine events (line-level navigation)
  useEffect(() => {
    const handleGoToLine = ({ line }: { line: number }) => {
      const view = editorViewRef.current
      if (!view) return
      const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines))
      view.dispatch({
        selection: { anchor: lineInfo.from },
        scrollIntoView: true,
      })
      view.focus()
    }
    return EventBus.on('goToLine', handleGoToLine)
  }, [])

  // Strip LaTeX commands to get visible text content for matching against PDF
  const stripLatex = useCallback((source: string): string => {
    return source
      .replace(/%.*$/gm, '')              // comments
      .replace(/\\begin\{.*?\}/g, '')     // \begin{env}
      .replace(/\\end\{.*?\}/g, '')       // \end{env}
      .replace(/\\[a-zA-Z@]+\*?/g, '')   // commands
      .replace(/[{}[\]$\\~^_&]/g, '')     // special chars
      .replace(/\s+/g, ' ')              // normalize whitespace
      .trim()
  }, [])

  // Listen for inverseSync events (word-level: PDF click → editor)
  // Hybrid approach: SyncTeX gives exact candidate lines, text matching disambiguates
  useEffect(() => {
    const handleInverseSync = ({ context, word, page, yFraction }: { context: string; word: string; page: number; yFraction: number }) => {
      const view = editorViewRef.current
      if (!view) return

      const doc = view.state.doc
      const contextWords = context.toLowerCase().split(/\s+/).filter(w => w.length >= 2)
      const wordLower = word.toLowerCase()

      // Stage 1: Get exact source lines for this page from SyncTeX (sorted top→bottom)
      const pageLines = syncTexService.getLinesForPage(page, compilationContext(documentIdRef.current).mainFile)

      // Score candidate lines by context word overlap against raw source
      // SyncTeX candidates only include lines that produce output (no comments/preamble)
      // so matching context words from PDF text against raw source works directly
      const scoreLine = (lineNum: number): number => {
        if (lineNum < 1 || lineNum > doc.lines) return 0
        return contextWords.filter(w => doc.line(lineNum).text.toLowerCase().includes(w)).length
      }

      let bestLine = -1
      let bestScore = 0
      let bestTiebreak = 0

      if (pageLines.length > 0) {
        // Score SyncTeX candidate lines; use yFraction as tiebreaker
        for (let idx = 0; idx < pageLines.length; idx++) {
          const lineNum = pageLines[idx]
          const score = scoreLine(lineNum)
          // Position tiebreak: how close this line is to the click position (0-1)
          const posFraction = pageLines.length > 1 ? idx / (pageLines.length - 1) : 0.5
          const tiebreak = 1 - Math.abs(posFraction - yFraction)
          if (score > bestScore || (score === bestScore && tiebreak > bestTiebreak)) {
            bestScore = score
            bestTiebreak = tiebreak
            bestLine = lineNum
          }
        }
      }

      // Fallback: if SyncTeX didn't help (no data or low confidence), scan full doc
      if (bestScore < 2) {
        for (let i = 1; i <= doc.lines; i++) {
          const score = scoreLine(i)
          if (score > bestScore) {
            bestScore = score
            bestLine = i
          }
        }
      }

      if (bestLine < 1) return

      // Stage 2: Navigate to the exact word position and select it
      const lineInfo = doc.line(bestLine)
      const rawLower = lineInfo.text.toLowerCase()
      const wordIdx = rawLower.indexOf(wordLower)

      if (wordIdx >= 0) {
        const anchor = lineInfo.from + wordIdx
        const head = anchor + word.length
        view.dispatch({
          selection: { anchor, head },
          scrollIntoView: true,
        })
      } else {
        view.dispatch({
          selection: { anchor: lineInfo.from },
          scrollIntoView: true,
        })
      }
      view.focus()
    }

    return EventBus.on('inverseSync', handleInverseSync)
  }, [])

  // Listen for syncModeChanged event from PDFViewer toggle
  useEffect(() => {
    return EventBus.on('syncModeChanged', ({ enabled }: { enabled: boolean }) => {
      syncModeRef.current = enabled
    })
  }, [])

  // Scroll sync: Listen for PDF text → find matching editor position
  const editorScrollSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return EventBus.on('scrollSync', ({ text, source }) => {
      if (source !== 'pdf') return
      const view = editorViewRef.current
      if (!view) return

      // Use service-level lock to prevent feedback loops
      if (!syncTexService.acquireScrollLock('pdf')) return

      // Extract search words from PDF page text
      const words = text.toLowerCase().split(/\s+/).filter(w => w.length >= 4 && /[a-z]/.test(w))
      if (words.length < 2) return

      // Search editor lines for best matching region
      const doc = view.state.doc
      let bestLine = -1
      let bestScore = 0

      for (let i = 1; i <= doc.lines; i++) {
        const lineText = doc.line(i).text.toLowerCase()
        if (lineText.length < 5) continue
        const score = words.filter(w => lineText.includes(w)).length
        if (score > bestScore) {
          bestScore = score
          bestLine = i
        }
      }

      if (bestLine > 0 && bestScore >= 2) {
        const lineInfo = doc.line(bestLine)
        view.dispatch({
          effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
        })
      }
    })
  }, [])

  // Scroll sync: Editor → PDF setup function (called after editor is created)
  const setupEditorScrollSync = useCallback((view: EditorView) => {
    let lastText = ''

    const handleScroll = () => {
      if (!syncModeRef.current) return

      // Check service-level lock — if PDF is leading, don't emit
      if (syncTexService.isScrollLocked() && syncTexService.getScrollLeader() !== 'editor') return

      // Small debounce to batch rapid scroll events — expensive work runs inside
      if (editorScrollSyncTimeoutRef.current) clearTimeout(editorScrollSyncTimeoutRef.current)
      editorScrollSyncTimeoutRef.current = setTimeout(() => {
        // Get all visible lines in the viewport
        const rect = view.dom.getBoundingClientRect()
        const topPos = view.posAtCoords({ x: rect.left, y: rect.top })
        const bottomPos = view.posAtCoords({ x: rect.left, y: rect.bottom })
        if (topPos === null || bottomPos === null) return

        const topLine = view.state.doc.lineAt(topPos).number
        const bottomLine = view.state.doc.lineAt(bottomPos).number

        // Collect visible text and strip LaTeX
        let visibleText = ''
        for (let i = topLine; i <= bottomLine; i++) {
          visibleText += view.state.doc.line(i).text + '\n'
        }
        const stripped = stripLatex(visibleText)

        // Dedupe — don't emit if text hasn't meaningfully changed
        if (stripped === lastText) return
        lastText = stripped

        if (stripped.length < 10) return

        if (!syncTexService.acquireScrollLock('editor')) return
        EventBus.emit('scrollSync', { text: stripped, source: 'editor' })
      }, 100)
    }

    const scrollDOM = view.scrollDOM
    scrollDOM.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      scrollDOM.removeEventListener('scroll', handleScroll)
      if (editorScrollSyncTimeoutRef.current) {
        clearTimeout(editorScrollSyncTimeoutRef.current)
      }
    }
  }, [stripLatex])

  // Handle click in editor to trigger forward sync (editor → PDF)
  // When syncMode is enabled, any click triggers sync; otherwise requires Ctrl/Cmd+Click
  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return

    const handleClick = (e: MouseEvent) => {
      // Trigger when syncMode is enabled OR on Ctrl/Cmd+Click
      if (!syncModeRef.current && !(e.ctrlKey || e.metaKey)) return

      const view = editorViewRef.current
      if (!view) return

      // Get the position from the click
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos === null) return

      // Get the line number
      const lineObj = view.state.doc.lineAt(pos)
      const line = lineObj.number

      // Get selected text if any, otherwise use text around click position
      const selection = view.state.selection.main
      let searchText: string
      if (selection.from !== selection.to) {
        // Use selected text
        searchText = view.state.sliceDoc(selection.from, selection.to)
      } else {
        // Get word at click position (find word boundaries)
        const lineStart = lineObj.from
        const lineText = lineObj.text
        const posInLine = pos - lineStart

        // Find word boundaries
        let wordStart = posInLine
        let wordEnd = posInLine
        while (wordStart > 0 && /\w/.test(lineText[wordStart - 1])) wordStart--
        while (wordEnd < lineText.length && /\w/.test(lineText[wordEnd])) wordEnd++

        searchText = lineText.substring(wordStart, wordEnd)
      }

      // Emit forward sync event to PDF viewer with search text
      EventBus.emit('forwardSync', { line, lineText: searchText, filename: compilationContext(documentIdRef.current).mainFile })
    }

    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [])

  // Sync documentId ref and reset state tracking when document changes
  useEffect(() => {
    documentIdRef.current = documentId
    editorChangedSinceLastSync.current = false
    if (documentId && restoredCursorForDoc.current !== documentId) {
      restoredCursorForDoc.current = null
    }
    // Clear undo history so Cmd+Z doesn't cross document boundaries
    const view = editorViewRef.current
    if (view) {
      view.dispatch({ effects: historyCompartment.reconfigure(history()) })
    }
  }, [documentId, historyCompartment])

  // Allow external code (git sync, conflict resolution) to force the next value prop through
  useEffect(() => {
    return EventBus.on('forceEditorSync', () => {
      editorChangedSinceLastSync.current = false
    })
  }, [])

  // Clear search state when switching documents
  useEffect(() => {
    setSearchQuery('')
    setSearchMatchCount(0)
    setCurrentMatchIndex(0)
    savedMatchIndexRef.current = null
    if (showEditorSearchRef.current) {
      setShowEditorSearch(false)
    }
    const view = editorViewRef.current
    if (view) {
      view.dispatch({ effects: setSearchHighlights.of({ others: [], current: null }) })
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
        editorChangedSinceLastSync.current = true
        const newValue = update.state.doc.toString()
        onChangeRef.current(newValue)
      }

      if (update.selectionSet || update.docChanged) {
        const selection = update.state.selection.main
        const line = update.state.doc.lineAt(selection.head)
        if (documentIdRef.current) EventBus.emit('editorFocus', { path: documentIdRef.current, offsetUTF16: selection.head })
        onCursorContextRef.current?.({ from: selection.from, to: selection.to, line: line.number, text: line.text })
      }
      if (update.selectionSet) {
        const selection = update.state.selection.main
        const selectedText = update.state.sliceDoc(selection.from, selection.to)
        if (onSelectionChange) {
          onSelectionChange(selection.from, selection.to, selectedText)
        }

        // Save cursor position to FileManager
        const pos = update.state.doc.lineAt(selection.from)
        fileManager.setCursorPosition({ line: pos.number, column: selection.from - pos.from })

        // Save cursor position to StateStore (uses ref to avoid stale closure)
        if (documentIdRef.current) {
          stateStore.setCursorPosition(documentIdRef.current, selection.from, selection.to)
        }

        // Emit forwardSync when sync mode is enabled (sync cursor position to PDF)
        if (syncModeRef.current) {
          const lineObj = update.state.doc.lineAt(selection.head)
          const line = lineObj.number

          // Get selected text if any, otherwise get word at cursor
          let searchText: string
          if (selection.from !== selection.to) {
            searchText = update.state.sliceDoc(selection.from, selection.to)
          } else {
            // Get word at cursor position
            const lineText = lineObj.text
            const posInLine = selection.head - lineObj.from
            let wordStart = posInLine
            let wordEnd = posInLine
            while (wordStart > 0 && /\w/.test(lineText[wordStart - 1])) wordStart--
            while (wordEnd < lineText.length && /\w/.test(lineText[wordEnd])) wordEnd++
            searchText = lineText.substring(wordStart, wordEnd)
          }

          EventBus.emit('forwardSync', { line, lineText: searchText, filename: compilationContext(documentIdRef.current).mainFile })
        }
      }

      // Detect \cite{ pattern for citation popover (only on doc changes, not cursor movement)
      if (update.docChanged && !mobileApiRef) {
        const pos = update.state.selection.main.head
        // Look back up to 20 chars to find \cite{ or \citep{ or \citet{ etc
        const lookback = update.state.doc.sliceString(Math.max(0, pos - 20), pos)
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
      // Cmd+F - toggle editor search dropdown
      {
        key: 'Mod-f',
        run: () => {
          toggleEditorSearch()
          return true
        },
      },
      // Formatting stays scoped to the source editor.
      {
        key: 'Mod-b',
        run: view => { wrapSelectionInView(view, '\\textbf{', '}'); return true },
      },
      {
        key: 'Mod-i',
        run: view => { wrapSelectionInView(view, '\\textit{', '}'); return true },
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
      // Cmd+Shift+Enter - jump to next section (wraps around)
      {
        key: 'Mod-Shift-Enter',
        run: (view) => {
          const currentSections = sectionsRef.current
          if (currentSections.length === 0) return true

          // Get current cursor line
          const cursorPos = view.state.selection.main.head
          const cursorLine = view.state.doc.lineAt(cursorPos).number

          // Find next section after cursor
          let nextSection = currentSections.find(s => s.line > cursorLine)

          // Wrap around to first section if none found
          if (!nextSection) {
            nextSection = currentSections[0]
          }

          // Jump to the section
          const lineInfo = view.state.doc.line(nextSection.line)
          view.dispatch({
            selection: { anchor: lineInfo.from },
            scrollIntoView: true,
            effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
          })
          return true
        },
      },
    ])

    const state = EditorState.create({
      doc: value,
      extensions: [
        // Core extensions
        drawSelection(),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        historyCompartment.of(history()),
        bracketMatching(),
        latexBracketMatching,  // LaTeX-specific bracket matching (handles \left \right etc)
        closeBrackets(),

        // LaTeX language support (must come before foldGutter to provide fold points)
        // LaTeX language with patched highlight tags for missing node types
        patchedLatex,
        ...autoCloseTags,

        // Fold gutter - shows fold markers for environments, sections, groups
        foldGutter(),
        foldScrollFix,  // Prevent scroll jumps when folding/unfolding with lineWrapping

        // Combined autocomplete: file paths + latex commands
        autocompletion({
          activateOnTyping: true,
          override: [
            // File completions first (for \input{}, \include{}, etc.)
            fileCompletionSource,
            // LaTeX completions (commands, environments, snippets)
            latexCompletionSource(true),
          ],
        }),

        // Linting - environment matching and reference checks only
        linter(latexLinter({
          checkMissingDocumentEnv: false,   // Don't require \begin{document} (for snippets)
          checkUnmatchedEnvironments: true, // Check \begin/\end matching
          checkMissingReferences: true,     // Check undefined \ref labels
        })),
        // Note: lintGutter() removed - markers weren't appearing and took up space

        // Keymaps
        customKeymap,
        keymap.of([
          indentWithTab,
          ...closeBracketsKeymap,
          // Completion keymap: strip Tab→accept so typing filters naturally, keep Enter to accept
          ...completionKeymap.filter(b => b.key !== 'Tab'),
          ...historyKeymap,
          { key: 'Enter', run: insertNewline },
          ...defaultKeymap,
        ]),

        // Theme
        darkTheme,
        highlightCompartment.of(syntaxHighlighting(desertHighlightStyle)),

        // Search highlighting
        searchHighlightField,

        // Placeholder for empty docs
        cmPlaceholder('Start writing LaTeX... try ⌘K to search, or just begin typing'),

        // Line wrapping (dynamic via compartment)
        lineWrappingCompartment.of(wordWrap ? EditorView.lineWrapping : []),

        // Hanging indent for \item lines
        itemIndentPlugin,

        // Inline image previews for \includegraphics
        imagePreviewPlugin,

        // NOTE: scrollMargins removed - was causing scroll centering on first keystroke
        // If performance issues occur with very large documents, investigate alternative solutions

        // Update listener
        updateListener,

        // Smart quotes (auto-convert " to `` and '')
        smartQuotesHandler,

        // Error line highlights (reconfigured when diagnostics change)
        errorLineCompartment.of([]),

        // Read-only compartment (for future use)
        readOnlyCompartment.of([]),
      ],
    })

    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    })

    editorViewRef.current = view

    // Set up scroll sync for Editor → PDF
    const cleanupScrollSync = setupEditorScrollSync(view)

    // Focus editor (cursor/scroll restoration happens in the [value] effect)
    view.focus()

    return () => {
      cleanupScrollSync()
      view.destroy()
      editorViewRef.current = null
    }
  }, [setupEditorScrollSync]) // Include setupEditorScrollSync in deps

  // Reconfigure line wrapping when word wrap toggles
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return
    view.dispatch({
      effects: lineWrappingCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    })
  }, [wordWrap, lineWrappingCompartment])

  // Highlight error lines from compile diagnostics
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return

    const errorLines = diagnostics
      .filter(d => d.type === 'error' && d.line !== undefined)
      .map(d => d.line!)

    if (errorLines.length === 0) {
      view.dispatch({ effects: errorLineCompartment.reconfigure([]) })
      return
    }

    const errorLineDeco = Decoration.line({ class: 'cm-error-line' })
    const ext = StateField.define<DecorationSet>({
      create(state) {
        const builder = new RangeSetBuilder<Decoration>()
        const sortedLines = [...new Set(errorLines)].sort((a, b) => a - b)
        for (const lineNum of sortedLines) {
          if (lineNum >= 1 && lineNum <= state.doc.lines) {
            const line = state.doc.line(lineNum)
            builder.add(line.from, line.from, errorLineDeco)
          }
        }
        return builder.finish()
      },
      update(decos, tr) {
        if (tr.docChanged) return decos.map(tr.changes)
        return decos
      },
      provide: f => EditorView.decorations.from(f),
    })

    view.dispatch({ effects: errorLineCompartment.reconfigure(ext) })
  }, [diagnostics, errorLineCompartment])

  // Update editor when value changes externally (e.g. document switch)
  // Skip when the editor itself produced the change — its internal state is already correct
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return

    if (editorChangedSinceLastSync.current) {
      editorChangedSinceLastSync.current = false
      // Fall through to cursor restoration below
    } else {
      const currentLength = view.state.doc.length
      const needsReplace = currentLength !== value.length
        || (currentLength > 0 && view.state.doc.toString() !== value)
      if (needsReplace) {
        isExternalUpdate.current = true
        try {
          view.dispatch({
            changes: { from: 0, to: currentLength, insert: value },
            annotations: Transaction.addToHistory.of(false),
          })
        } finally {
          isExternalUpdate.current = false
        }
      }
    }

    // Restore cursor/scroll position AFTER content is loaded (once per document)
    const docId = documentIdRef.current
    if (docId && value.length > 0 && restoredCursorForDoc.current !== docId) {
      restoredCursorForDoc.current = docId

      stateStore.getDocumentState(docId).then(state => {
        // Guard: doc may have switched while awaiting state
        if (!editorViewRef.current || documentIdRef.current !== docId) return

        if (state) {
          const currentView = editorViewRef.current
          const docLength = currentView.state.doc.length

          // Restore cursor position (clamp to document length)
          const cursorStart = Math.min(state.cursorStart, docLength)
          const cursorEnd = Math.min(state.cursorEnd, docLength)

          if (cursorStart > 0 || cursorEnd > 0) {
            currentView.dispatch({
              selection: { anchor: cursorStart, head: cursorEnd }
            })
          }

          // Restore scroll position after CodeMirror has finished rendering, then focus
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!editorViewRef.current || documentIdRef.current !== docId) return
              if (state.scrollTop > 0 || state.scrollLeft > 0) {
                editorViewRef.current.scrollDOM.scrollTop = state.scrollTop
                editorViewRef.current.scrollDOM.scrollLeft = state.scrollLeft
              }
              editorViewRef.current.focus()
            })
          })
        } else {
          // New document with no saved state — just focus
          editorViewRef.current.focus()
        }
      })
    }
  }, [value, documentId])

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

  // A local editor API keeps touch controls independent of focus and global events.
  useEffect(() => {
    const view = editorViewRef.current
    if (!view || !mobileApiRef) return
    mobileApiRef.current = {
      bookmark: () => ({ anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }),
      restore: (saved, focus = true) => {
        const limit = view.state.doc.length
        view.dispatch({ selection: { anchor: Math.min(saved.anchor, limit), head: Math.min(saved.head, limit) } })
        if (focus) view.focus()
        view.scrollDOM.scrollTop = saved.top
        view.scrollDOM.scrollLeft = saved.left
      },
      insert: (text, options = {}) => {
        const selection = view.state.selection.main
        let from = Math.min(options.from ?? selection.from, view.state.doc.length)
        let to = Math.min(options.to ?? selection.to, view.state.doc.length)
        const source = view.state.doc.toString()
        const packageName = options.package
        const hasPackage = packageName && [...source.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)].some(match => match[1].split(',').map(s => s.trim()).includes(packageName))
        const preambleAt = source.indexOf('\\begin{document}')
        const preamble = packageName && !hasPackage && preambleAt >= 0 && (preambleAt <= from || preambleAt >= to) ? `\\usepackage{${packageName}}\n` : ''
        const changes = [{ from, to, insert: text }]
        if (preamble) changes.push({ from: preambleAt, to: preambleAt, insert: preamble })
        const shift = preamble && preambleAt <= from ? preamble.length : 0
        view.dispatch({ changes, selection: { anchor: from + shift + (options.cursor ?? text.length) }, scrollIntoView: true, userEvent: 'input', annotations: isolateHistory.of('full') })
        view.focus()
      },
      goTo: line => {
        const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
        view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true })
        view.focus()
      },
      showLog: () => setConsoleOpen(true),
      focus: () => view.focus(),
    }
    const selection = view.state.selection.main
    const line = view.state.doc.lineAt(selection.head)
    onCursorContextRef.current?.({ from: selection.from, to: selection.to, line: line.number, text: line.text })
    return () => { mobileApiRef.current = null }
  }, [mobileApiRef])

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


  // Fade scrollbar: cover div overlays the 4px scrollbar, fades out on scroll
  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return

    let timeout: ReturnType<typeof setTimeout> | null = null
    let visible = false

    const cover = document.createElement('div')
    cover.className = 'scrollbar-cover'
    container.appendChild(cover)

    const handleScroll = () => {
      if (!visible) {
        cover.style.opacity = '0'
        visible = true
      }
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        cover.style.opacity = '1'
        visible = false
      }, 1000)
    }

    const scroller = container.querySelector('.cm-scroller')
    scroller?.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      scroller?.removeEventListener('scroll', handleScroll)
      if (timeout) clearTimeout(timeout)
      cover.remove()
    }
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

  const logsRef = useRef(logs)
  logsRef.current = logs

  const handleCopyLogs = useCallback(() => {
    const logText = logsRef.current.map(log => `[${log.time}] ${log.type.toUpperCase()}: ${log.message}`).join('\n')
    navigator.clipboard.writeText(logText)
  }, [])

  // Track showEditorSearch in a ref for use in CodeMirror keymap
  const showEditorSearchRef = useRef(showEditorSearch)
  useEffect(() => {
    showEditorSearchRef.current = showEditorSearch
  }, [showEditorSearch])

  // Editor search handlers
  const toggleEditorSearch = useCallback(() => {
    if (showEditorSearchRef.current) {
      // Save position before closing (use ref to avoid stale closure)
      savedMatchIndexRef.current = currentMatchIndexRef.current
      setShowEditorSearch(false)
      // Clear highlights but keep query/position for next open
      setSearchMatchCount(0)
      const view = editorViewRef.current
      if (view) {
        view.dispatch({ effects: setSearchHighlights.of({ others: [], current: null }) })
      }
    } else {
      setShowEditorSearch(true)
      setTimeout(() => {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }, 0)
    }
  }, [])

  const closeEditorSearch = useCallback(() => {
    // Save position before closing (use ref to avoid stale closure)
    savedMatchIndexRef.current = currentMatchIndexRef.current
    setShowEditorSearch(false)
    // Clear highlights but keep query/position for next open
    setSearchMatchCount(0)
    const view = editorViewRef.current
    if (view) {
      view.dispatch({ effects: setSearchHighlights.of({ others: [], current: null }) })
    }
  }, [])

  const performSearch = useCallback((query: string) => {
    const view = editorViewRef.current
    if (!view || !query) {
      searchMatchesRef.current = []
      setSearchMatchCount(0)
      setCurrentMatchIndex(0)
      // Clear highlights when query is empty
      if (view) {
        view.dispatch({ effects: setSearchHighlights.of({ others: [], current: null }) })
      }
      return
    }

    const doc = view.state.doc.toString()
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'gi')
    const matches: { from: number; to: number }[] = []
    let match
    while ((match = regex.exec(doc)) !== null) {
      matches.push({ from: match.index, to: match.index + query.length })
    }

    searchMatchesRef.current = matches
    setSearchMatchCount(matches.length)

    if (matches.length > 0) {
      let currentIdx: number

      // Use saved position if resuming, otherwise find match near cursor
      if (savedMatchIndexRef.current !== null) {
        currentIdx = Math.min(savedMatchIndexRef.current, matches.length - 1)
        savedMatchIndexRef.current = null // Clear after using
      } else {
        // Find current match based on cursor position
        const cursorPos = view.state.selection.main.head
        currentIdx = 0
        for (let i = 0; i < matches.length; i++) {
          if (matches[i].from >= cursorPos) {
            currentIdx = i
            break
          }
          currentIdx = i
        }
      }
      setCurrentMatchIndex(currentIdx)

      // Highlight all matches - current gets special styling, others get regular
      const otherMatches = matches.filter((_, i) => i !== currentIdx)
      const currentMatch = matches[currentIdx]
      view.dispatch({ effects: setSearchHighlights.of({ others: otherMatches, current: currentMatch }) })

      // Select and scroll to current match
      view.dispatch({
        selection: { anchor: currentMatch.from, head: currentMatch.to },
        scrollIntoView: true
      })
    } else {
      view.dispatch({ effects: setSearchHighlights.of({ others: [], current: null }) })
    }
  }, [])

  const goToNextMatch = useCallback(() => {
    const view = editorViewRef.current
    const matches = searchMatchesRef.current
    if (!view || matches.length === 0) return

    const newIdx = (currentMatchIndex + 1) % matches.length
    setCurrentMatchIndex(newIdx)

    // Update highlights - current gets special styling
    const otherMatches = matches.filter((_, i) => i !== newIdx)
    const currentMatch = matches[newIdx]
    view.dispatch({ effects: setSearchHighlights.of({ others: otherMatches, current: currentMatch }) })

    view.dispatch({
      selection: { anchor: currentMatch.from, head: currentMatch.to },
      scrollIntoView: true
    })
  }, [currentMatchIndex])

  const goToPrevMatch = useCallback(() => {
    const view = editorViewRef.current
    const matches = searchMatchesRef.current
    if (!view || matches.length === 0) return

    const newIdx = (currentMatchIndex - 1 + matches.length) % matches.length
    setCurrentMatchIndex(newIdx)

    // Update highlights - current gets special styling
    const otherMatches = matches.filter((_, i) => i !== newIdx)
    const currentMatch = matches[newIdx]
    view.dispatch({ effects: setSearchHighlights.of({ others: otherMatches, current: currentMatch }) })

    view.dispatch({
      selection: { anchor: currentMatch.from, head: currentMatch.to },
      scrollIntoView: true
    })
  }, [currentMatchIndex])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Cmd/Ctrl+F while search input is focused - close search and return focus to editor
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault()
      closeEditorSearch()
      editorViewRef.current?.focus()
    } else if (e.key === 'Escape') {
      closeEditorSearch()
      editorViewRef.current?.focus()
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        goToPrevMatch()
      } else {
        goToNextMatch()
      }
    }
  }, [closeEditorSearch, goToNextMatch, goToPrevMatch])

  // Search when query changes (debounced to avoid scanning on every keystroke)
  useEffect(() => {
    if (!showEditorSearch) return
    const id = setTimeout(() => performSearch(searchQuery), 150)
    return () => clearTimeout(id)
  }, [searchQuery, showEditorSearch, performSearch])

  // Handle citation insertion from popover
  const handleCitationInsert = useCallback((citeKey: string, bibtex: string) => {
    const view = editorViewRef.current
    if (!view) return

    const pos = citationInsertPosRef.current
    // Insert the cite key and close the brace
    view.dispatch({
      changes: { from: pos, to: pos, insert: `${citeKey}}` },
      selection: { anchor: pos + citeKey.length + 1 }
    })
    setCitationPopoverOpen(false)

    // Notify parent to add bibtex to references.bib
    onCitationInsert?.(citeKey, bibtex)

    // Reset dismissed flag after the call stack completes (after onClose runs)
    // This ensures future citations will trigger the popover
    setTimeout(() => {
      citationDismissedRef.current = false
    }, 0)
    view.focus()
  }, [onCitationInsert])

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

  // Close outline panel when clicking outside (only if pinned)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (outlineRef.current && !outlineRef.current.contains(e.target as Node)) {
        setShowOutline(false)
        setOutlineFilter('')
        setOutlinePinned(false)
      }
    }
    if (showOutline && outlinePinned) {
      // Only add click-outside listener when pinned
      document.addEventListener('mousedown', handleClickOutside, true)
      return () => document.removeEventListener('mousedown', handleClickOutside, true)
    }
  }, [showOutline, outlinePinned])

  // Unescape common LaTeX special characters for display
  const unescapeLatex = useCallback((text: string): string => {
    return text.replace(LATEX_ESCAPE_REGEX, m => LATEX_ESCAPES[m] ?? m)
  }, [])

  // Parse LaTeX for sections (synchronous, from main document only)
  const parseSectionsFromText = useCallback((text: string, sourceFile?: string): Section[] => {
    const sectionRegex = /\\(part|chapter|section|subsection|subsubsection|paragraph)\{([^}]+)\}/g
    const levelMap: Record<string, number> = {
      'part': 0,
      'chapter': 1,
      'section': 2,
      'subsection': 3,
      'subsubsection': 4,
      'paragraph': 5
    }

    const results: Section[] = []
    const lines = text.split('\n')

    lines.forEach((line, index) => {
      let match
      sectionRegex.lastIndex = 0
      while ((match = sectionRegex.exec(line)) !== null) {
        results.push({
          level: levelMap[match[1]] || 2,
          title: unescapeLatex(match[2]),
          line: index + 1,
          sourceFile
        })
      }
    })

    return results
  }, [unescapeLatex])

  // Find \input{} and \include{} commands in text
  const findIncludedFiles = useCallback((text: string): { path: string; line: number }[] => {
    const includeRegex = /\\(input|include)\{([^}]+)\}/g
    const results: { path: string; line: number }[] = []
    const lines = text.split('\n')

    lines.forEach((line, index) => {
      let match
      includeRegex.lastIndex = 0
      while ((match = includeRegex.exec(line)) !== null) {
        let path = match[2].trim()
        // Add .tex extension if not present
        if (!path.endsWith('.tex')) {
          path = path + '.tex'
        }
        results.push({ path, line: index + 1 })
      }
    })

    return results
  }, [])

  // Resolve included file path to ProjectStore file
  const resolveIncludePath = useCallback((includePath: string): string | null => {
    const allFiles = ProjectStore.getAllFiles()

    // Try exact match first
    let match = allFiles.find(f => f.path === includePath || f.path === '/' + includePath)
    if (match) return match.path

    // Try matching just the filename
    const filename = includePath.split('/').pop() || includePath
    match = allFiles.find(f => f.path.endsWith('/' + filename) || f.name === filename)
    if (match) return match.path

    return null
  }, [])

  // Parse sections including from \input files (async)
  const parseSectionsWithIncludes = useCallback(async (text: string): Promise<Section[]> => {
    // Parse main document sections
    const mainSections = parseSectionsFromText(text)

    // Find included files
    const includes = findIncludedFiles(text)
    if (includes.length === 0) {
      return mainSections
    }

    // Resolve and load included files
    const includedSections: { insertAfterLine: number; sections: Section[] }[] = []

    for (const include of includes) {
      const resolvedPath = resolveIncludePath(include.path)
      if (!resolvedPath) continue

      try {
        const content = await FileReaderService.readFile(resolvedPath)
        if (content === null) continue
        const sections = parseSectionsFromText(content, resolvedPath)
        if (sections.length > 0) {
          includedSections.push({
            insertAfterLine: include.line,
            sections
          })
        }
      } catch {
        // File couldn't be read, skip it
      }
    }

    // Merge sections: insert included sections after their \input line
    // Sort includes by line number descending to insert from bottom up
    includedSections.sort((a, b) => b.insertAfterLine - a.insertAfterLine)

    const allSections = [...mainSections]
    for (const { insertAfterLine, sections: incSections } of includedSections) {
      // Find the index to insert after
      let insertIdx = allSections.findIndex(s => !s.sourceFile && s.line > insertAfterLine)
      if (insertIdx === -1) {
        insertIdx = allSections.length
      }
      allSections.splice(insertIdx, 0, ...incSections)
    }

    return allSections
  }, [parseSectionsFromText, findIncludedFiles, resolveIncludePath])

  // Update sections when content changes (debounced to avoid parsing on every keystroke)
  useEffect(() => {
    let cancelled = false
    const timeoutId = setTimeout(async () => {
      const newSections = await parseSectionsWithIncludes(value)
      if (!cancelled) {
        setSections(newSections)
        sectionsRef.current = newSections
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [value, parseSectionsWithIncludes])

  // Jump to section (and pin the outline open)
  const jumpToSection = useCallback((line: number) => {
    const view = editorViewRef.current

    // Set current section to the clicked one immediately
    const clickedIndex = sections.findIndex(s => s.line === line && !s.sourceFile)
    if (clickedIndex !== -1) {
      setCurrentSectionIndex(clickedIndex)
      // Mark as locked (scroll position captured after scroll completes)
      lockedSectionRef.current = { index: clickedIndex, scrollTop: -1 }
    }

    if (view) {
      const lineInfo = view.state.doc.line(line)
      view.dispatch({
        selection: { anchor: lineInfo.from },
        scrollIntoView: true,
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
      })
      view.focus()

      // Capture scroll position after the programmatic scroll
      requestAnimationFrame(() => {
        if (lockedSectionRef.current && lockedSectionRef.current.scrollTop === -1) {
          lockedSectionRef.current.scrollTop = view.scrollDOM.scrollTop
        }
      })
    }
    setOutlinePinned(true) // Keep outline open after clicking a section
  }, [sections])

  // Handle clicking an external section (from \input file)
  const handleOpenExternalSection = useCallback((section: Section) => {
    if (!section.sourceFile) return

    // Find the file in ProjectStore to get the document
    const allFiles = ProjectStore.getAllFiles()
    const file = allFiles.find(f => f.path === section.sourceFile)

    if (file) {
      // Emit event to open the document and go to line
      EventBus.emit('openDocument', {
        path: file.path,
        line: section.line
      })
    }

    setOutlinePinned(true)
  }, [])

  // Track current section based on scroll position (throttled to once per frame)
  useEffect(() => {
    const view = editorViewRef.current
    if (!view || sections.length === 0) return

    let rafPending = false

    const updateCurrentSection = () => {
      const scrollTop = view.scrollDOM.scrollTop

      // If a section is locked, keep it until user scrolls significantly
      if (lockedSectionRef.current) {
        // If scroll position not yet captured, skip update
        if (lockedSectionRef.current.scrollTop === -1) return

        const scrollDelta = Math.abs(scrollTop - lockedSectionRef.current.scrollTop)
        if (scrollDelta < 100) {
          // Keep the locked section
          return
        }
        // User has scrolled enough, unlock
        lockedSectionRef.current = null
      }

      // Get the line at the center of the viewport for better accuracy
      const viewportHeight = view.scrollDOM.clientHeight
      const centerY = scrollTop + viewportHeight / 3 // Use upper third for "current" section
      const blockInfo = view.lineBlockAtHeight(centerY)
      const centerLine = view.state.doc.lineAt(blockInfo.from).number

      // Find the last section that's at or before the center line
      let currentIdx = 0
      for (let i = sections.length - 1; i >= 0; i--) {
        if (sections[i].line <= centerLine) {
          currentIdx = i
          break
        }
      }
      setCurrentSectionIndex(currentIdx)
    }

    // Initial update
    updateCurrentSection()

    // Throttle scroll handler to once per animation frame
    const handleScroll = () => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        updateCurrentSection()
      })
    }

    // Listen for scroll
    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
    return () => view.scrollDOM.removeEventListener('scroll', handleScroll)
  }, [sections])

  // Handle outline panel mouse leave (auto-close if not pinned)
  const handleOutlineMouseLeave = useCallback(() => {
    if (!outlinePinned) {
      setShowOutline(false)
      setOutlineFilter('')
    }
  }, [outlinePinned])

  // Focus filter input when outline opens, restore editor focus when it closes
  useEffect(() => {
    if (showOutline && outlineFilterInputRef.current) {
      // Small delay to ensure the panel has transitioned open
      setTimeout(() => {
        outlineFilterInputRef.current?.focus()
      }, 50)
    } else if (!showOutline && editorViewRef.current) {
      // Return focus to editor when outline closes
      editorViewRef.current.focus()
    }
  }, [showOutline])

  // Handle outline trigger click (toggle)
  const handleOutlineTriggerClick = useCallback(() => {
    setShowOutline(prev => !prev)
    setOutlinePinned(prev => !prev)
  }, [])

  const containerElRef = useRef<HTMLDivElement>(null)

  const hasStatusBar = showCompileStatus || showWordCount || gitConnected

  return (
    <>
    {selectionMenu && <SelectionContextMenu {...selectionMenu}
      onClose={closeSelectionMenu}
      onJump={() => {
        EventBus.emit('forwardSync', { line: selectionMenu.line, lineText: selectionMenu.text, filename: compilationContext(documentId).mainFile, reveal: true })
        closeSelectionMenu(true)
      }}
      onCopy={async () => {
        try { await navigator.clipboard.writeText(selectionMenu.text) }
        catch { EventBus.emit('showToast', { message: 'Could not copy. Use Command+C or Ctrl+C.', type: 'error' }) }
        closeSelectionMenu(true)
      }}
    />}
    <div className="editor-toolbar">
      <div className="toolbar-left">
        {onMenuClick && (
          <button className="toolbar-item mobile-menu-btn" aria-label="Open project sidebar" onClick={onMenuClick}>
            <Menu size={16} />
          </button>
        )}
        <button className="toolbar-item" onClick={handleCommandPalette}>
          <span>Search</span>
        </button>
        <button className="toolbar-item" onClick={handleHelp}>
          <span>Help</span>
        </button>
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
        <div className="compiler-settings-wrapper" ref={compilerSettingsRef}>
          <button
            className={`toolbar-item compiler-settings-button ${showCompilerSettings ? 'active' : ''}`}
            onClick={() => setShowCompilerSettings(!showCompilerSettings)}
            title="Settings"
          >
            <Settings size={14} />
          </button>
          {showCompilerSettings && (
            <div className="compiler-settings-dropdown">
                <div className="settings-tabs">
                  <button
                    className={`settings-tab ${settingsTab === 'compiler' ? 'active' : ''}`}
                    onClick={() => setSettingsTab('compiler')}
                  >
                    Compiler
                  </button>
                  <button
                    className={`settings-tab ${settingsTab === 'editor' ? 'active' : ''}`}
                    onClick={() => setSettingsTab('editor')}
                  >
                    Editor
                  </button>
                </div>

                {settingsTab === 'compiler' && (
                  <>
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
                      <span className="setting-label">Engine</span>
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
                  </>
                )}

                {settingsTab === 'editor' && (
                  <>
                    <div className="compiler-setting-row">
                      <span className="setting-label">Word wrap</span>
                      <button
                        className={`setting-toggle ${wordWrap ? 'active' : ''}`}
                        onClick={() => setWordWrap(!wordWrap)}
                      >
                        <span className="toggle-track">
                          <span className="toggle-thumb" />
                        </span>
                      </button>
                    </div>
                    <div className="compiler-setting-row">
                      <span className="setting-label">Word count</span>
                      <button
                        className={`setting-toggle ${showWordCount ? 'active' : ''}`}
                        onClick={() => onShowWordCountChange?.(!showWordCount)}
                      >
                        <span className="toggle-track">
                          <span className="toggle-thumb" />
                        </span>
                      </button>
                    </div>
                    <div className="compiler-setting-row">
                      <span className="setting-label">Compile status</span>
                      <button
                        className={`setting-toggle ${showCompileStatus ? 'active' : ''}`}
                        onClick={() => onShowCompileStatusChange?.(!showCompileStatus)}
                      >
                        <span className="toggle-track">
                          <span className="toggle-thumb" />
                        </span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    {showEditorSearch && (
      <div className="editor-search-dropdown">
        <input
          ref={searchInputRef}
          type="text"
          className="editor-search-input"
          placeholder="Find..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          autoFocus
        />
        <span className="editor-search-count">
          {searchMatchCount > 0 ? `${currentMatchIndex + 1} of ${searchMatchCount}` : 'No results'}
        </span>
        <button className="editor-search-btn" onClick={goToPrevMatch} title="Previous (Shift+Enter)">
          <ChevronUp size={14} />
        </button>
        <button className="editor-search-btn" onClick={goToNextMatch} title="Next (Enter)">
          <ChevronDown size={14} />
        </button>
        <button className="editor-search-btn" onClick={closeEditorSearch} title="Close (Escape)">
          <X size={14} />
        </button>
      </div>
    )}
    <div ref={containerElRef} className={`latex-editor-container${hasStatusBar ? ' has-status-bar' : ''}`}>
      <div
        className="editor-wrapper"
        style={{
          height: consoleOpen
            ? `calc(100% - ${consoleHeight}px${(showCompileStatus || showWordCount) ? ' - 24px' : ''})`
            : (showCompileStatus || showWordCount) ? 'calc(100% - 24px)' : undefined
        }}
      >
        <div ref={editorContainerRef} className="codemirror-container"
          onContextMenu={event => {
            if (event.shiftKey || !(event.target as Element).closest('.cm-content')) return
            if (openSelectionMenu(event.clientX, event.clientY)) event.preventDefault()
          }}
          onKeyDownCapture={event => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
            const view = editorViewRef.current
            const rect = view?.coordsAtPos(view.state.selection.main.from)
            if (rect && openSelectionMenu(rect.left, rect.bottom)) { event.preventDefault(); event.stopPropagation() }
          }}
        />
        {diagnostics.length > 0 && editorViewRef.current && (() => {
          const view = editorViewRef.current!
          const totalLines = view.state.doc.lines
          const marks = diagnostics
            .filter(d => d.line !== undefined && d.line >= 1 && d.line <= totalLines)
            .map(d => ({
              pct: ((d.line! - 1) / Math.max(totalLines - 1, 1)) * 100,
              type: d.type,
              line: d.line!,
              message: d.message,
            }))
          if (marks.length === 0) return null
          return (
            <div className="overview-ruler" aria-hidden="true">
              {marks.map((m, i) => (
                <div
                  key={i}
                  className={`overview-ruler-mark overview-ruler-${m.type}`}
                  style={{ top: `${m.pct}%` }}
                  title={`Line ${m.line}: ${m.message}`}
                  onClick={() => {
                    const line = view.state.doc.line(m.line)
                    view.dispatch({
                      selection: { anchor: line.from },
                      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
                    })
                    view.focus()
                  }}
                />
              ))}
            </div>
          )
        })()}

        {/* Quip-style section outline panel */}
        {sections.length > 0 && (
          <div
            ref={outlineRef}
            className={`outline-panel ${showOutline ? 'expanded' : ''}`}
            onMouseLeave={handleOutlineMouseLeave}
          >
            {/* Trigger line - click to toggle */}
            <div
              className="outline-trigger"
              onClick={handleOutlineTriggerClick}
            />

            {/* Expandable panel - always rendered for smooth transition */}
            <div className="outline-content">
              <div className="outline-filter">
                <Filter size={14} />
                <input
                  ref={outlineFilterInputRef}
                  type="text"
                  className="outline-filter-input"
                  placeholder="Filter..."
                  value={outlineFilter}
                  onChange={(e) => setOutlineFilter(e.target.value)}
                  tabIndex={showOutline ? 0 : -1}
                />
              </div>
              <div className="outline-list">
                {sections
                  .filter(s => outlineFilter === '' || s.title.toLowerCase().includes(outlineFilter.toLowerCase()))
                  .map((section, index) => {
                    const originalIndex = sections.indexOf(section)
                    const isCurrentSection = originalIndex === currentSectionIndex
                    const isExternal = !!section.sourceFile

                    return (
                      <button
                        key={index}
                        className={`outline-item outline-level-${section.level} ${isCurrentSection ? 'current' : ''} ${isExternal ? 'external' : ''}`}
                        onClick={() => isExternal ? handleOpenExternalSection(section) : jumpToSection(section.line)}
                        tabIndex={showOutline ? 0 : -1}
                        title={isExternal ? `From: ${section.sourceFile}` : undefined}
                      >
                        {isCurrentSection && !isExternal && <span className="outline-dot" />}
                        {isExternal && <FileText size={12} className="outline-file-icon" />}
                        <span className="outline-title">{section.title}</span>
                      </button>
                    )
                  })}
                {outlineFilter && sections.filter(s => s.title.toLowerCase().includes(outlineFilter.toLowerCase())).length === 0 && (
                  <div className="outline-empty">No matches</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      {consoleOpen && (
        <div className="compile-console" style={{ height: consoleHeight }}>
          <div className="console-resize-handle" onMouseDown={handleConsoleResizeStart} />
          <div className="console-header">
            <span className="console-title">
              {(() => {
                const errorCount = diagnostics.filter(d => d.type === 'error').length
                const warningCount = diagnostics.filter(d => d.type === 'warning').length
                if (diagnostics.length === 0) return 'Compile Output'
                return (
                  <>
                    {errorCount > 0 && (
                      <span className="console-count error">{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
                    )}
                    {warningCount > 0 && (
                      <span className="console-count warning">{warningCount} warning{warningCount !== 1 ? 's' : ''}</span>
                    )}
                    {errorCount === 0 && warningCount === 0 && (
                      <span>Compile Output</span>
                    )}
                  </>
                )
              })()}
            </span>
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
            {diagnostics.length > 0 ? (
              <div className="diagnostics-list">
                {compileStatus === 'success' && !diagnostics.some(d => d.type === 'error') && (
                  <div className="diagnostic-success">
                    Compilation successful
                    {(() => {
                      const wc = diagnostics.filter(d => d.type === 'warning').length
                      return wc > 0 ? ` with ${wc} warning${wc !== 1 ? 's' : ''}` : ''
                    })()}
                  </div>
                )}
                {diagnostics.map((d, i) => (
                  <div
                    key={i}
                    className={`diagnostic-item diagnostic-${d.type}`}
                    onClick={() => d.line && jumpToSection(d.line)}
                    style={{ cursor: d.line ? 'pointer' : 'default' }}
                  >
                    <span className={`diagnostic-indicator ${d.type}`} />
                    <div className="diagnostic-content">
                      <span className="diagnostic-message">{d.message}</span>
                      {d.line && <span className="diagnostic-line">line {d.line}</span>}
                      {d.context && (
                        <span className="diagnostic-context">{d.context}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : compileStatus === 'success' ? (
              <div className="console-empty console-success">Compilation successful</div>
            ) : logs.length === 0 ? (
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

      {/* Status bar - shows word count (left), git branch, and compile status (right) */}
      {hasStatusBar && (
        <div className="editor-status-bar">
          <div className="status-bar-left">
            {showWordCount && (
              <span className="status-word-count">
                {wordCount !== null ? `${wordCount.toLocaleString()} words` : 'Counting...'}
                {wordCount !== null && wordCount > 0 && (
                  <span className="status-reading-time"> · ~{Math.max(1, Math.round(wordCount / 230))} min read</span>
                )}
              </span>
            )}
            {gitConnected && gitBranch && (
              <button className="status-git-branch" onClick={() => EventBus.emit('openIntegrations')} title="Git settings">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="5" cy="4" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="7" r="2"/>
                  <path d="M5 6v4M10 7H7.5A2.5 2.5 0 015 4.5"/>
                </svg>
                <span className="status-branch-name">{gitBranch}</span>
                {gitHasChanges && <span className="status-dirty-dot" />}
              </button>
            )}
          </div>
          <div className="status-bar-right">
            {showCompileStatus && (
              <button
                className={`status-compile ${consoleOpen ? 'active' : ''} ${compileStatus}`}
                onClick={() => setConsoleOpen(!consoleOpen)}
                title="Toggle compile output"
              >
                <span className={`status-dot ${compileStatus}`} />
                <span className="status-text">
                  {compileStatus === 'compiling' ? 'Compiling...' :
                   compileStatus === 'initializing' ? 'Initializing...' :
                   compileStatus === 'error' ? 'Error' :
                   compileStatus === 'success' ? (compileTimeMs != null ? `${Math.round(compileTimeMs)}ms` : 'Ready') :
                   'Idle'}
                </span>
              </button>
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
    </>
  )
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render when significant props change
  return (
    prevProps.value === nextProps.value &&
    prevProps.documentId === nextProps.documentId &&
    prevProps.mobileApiRef === nextProps.mobileApiRef &&
    prevProps.onCursorContext === nextProps.onCursorContext &&
    prevProps.compileStatus === nextProps.compileStatus &&
    prevProps.compileTimeMs === nextProps.compileTimeMs &&
    prevProps.compilerSettings?.autoCompile === nextProps.compilerSettings?.autoCompile &&
    prevProps.compilerSettings?.compiler === nextProps.compilerSettings?.compiler &&
    prevProps.compilerSettings?.ctanFetch === nextProps.compilerSettings?.ctanFetch &&
    prevProps.compilerSettings?.cachePreamble === nextProps.compilerSettings?.cachePreamble &&
    prevProps.compilerSettings?.autoUnload === nextProps.compilerSettings?.autoUnload &&
    prevProps.showWordCount === nextProps.showWordCount &&
    prevProps.showCompileStatus === nextProps.showCompileStatus &&
    prevProps.diagnostics === nextProps.diagnostics
  )
})

export default LaTeXEditor
