import { flushSync } from 'react-dom'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Eye, Code2, Plus, ChevronUp, ChevronDown, X, ScanSearch, Maximize2, GripHorizontal, Keyboard, TriangleAlert, ArrowRight, FileText } from 'lucide-react'
import LaTeXEditor, { type LaTeXEditorProps } from '../LaTeXEditor/LaTeXEditor'
import type { FileItem } from '../ProjectSidebar'
import citationService, { type CitationItem } from '../../services/CitationService'
import FileReaderService from '../../services/FileReaderService'
import EventBus from '../../services/EventBus'
import InsertSheet, { insertChoices, type ProjectOption } from './InsertSheet'
import PdfRegion from './PdfRegion'
import { actionableErrors, citationKeys, diagnosticPath, inputContext, relativeFilePath, type CursorContext, type EditorBookmark, type InsertKind, type MobileEditorApi } from './model'
import './MobileStudio.css'

const PDFViewer = lazy(() => import('./MobilePDFViewer'))
const emptyCursor: CursorContext = { from: 0, to: 0, line: 1, text: '' }
export default function MobileStudio({ editorProps, files, pdfData, syncTexData, showPreview, onPreviewChange }: {
  editorProps: LaTeXEditorProps; files: FileItem[]; pdfData: Uint8Array | null; syncTexData: string | null;
  showPreview: boolean; onPreviewChange: (open: boolean) => void
}) {
  const api = useRef<MobileEditorApi | null>(null)
  const [cursor, setCursor] = useState(emptyCursor)
  const [expanded, setExpanded] = useState(false)
  const [peek, setPeek] = useState(false)
  const [lens, setLens] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ width: window.innerWidth, height: window.innerHeight - 56 })
  const [lensPosition, setLensPosition] = useState({ x: 16, y: 70 })
  const [sheet, setSheet] = useState<InsertKind | null>(null)
  const [references, setReferences] = useState<string[]>([])
  const [issueIndex, setIssueIndex] = useState(0)
  const [issuesHidden, setIssuesHidden] = useState(false)
  const [excerpt, setExcerpt] = useState('')
  const [viewport, setViewport] = useState({ height: window.visualViewport?.height || window.innerHeight, top: window.visualViewport?.offsetTop || 0 })
  const bookmark = useRef<EditorBookmark | null>(null)
  const sheetArgument = useRef<{from: number; to: number; closing: boolean} | null>(null)
  const sheetBookmark = useRef<EditorBookmark | null>(null)
  const hold = useRef<{ timer?: number; active: boolean; x: number; y: number; cancelled: boolean }>({ active: false, x: 0, y: 0, cancelled: false })
  const previewPointerTime = useRef(-Infinity)
  const sourceTapReady = useRef(false)
  const dockDrag = useRef<number | null>(null)
  const movedDock = useRef(false)
  const draggingLens = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null)
  const compact = viewport.height < 500 || window.innerHeight - viewport.height > 120
  const busy = editorProps.compileStatus === 'compiling' || editorProps.compileStatus === 'initializing'
  const errors = useMemo(() => actionableErrors(editorProps.diagnostics || []), [editorProps.diagnostics])
  const issue = errors[Math.min(issueIndex, errors.length - 1)]
  const currentPath = editorProps.documentId || '/project/src/document.tex'
  const currentPathRef = useRef(currentPath)
  currentPathRef.current = currentPath
  const context = inputContext(editorProps.value, cursor.to)
  const options = useMemo(() => {
    const result: ProjectOption[] = []
    const visit = (items: FileItem[]) => items.forEach(file => {
      if (file.type === 'folder') visit(file.children || [])
      else result.push({ path: file.path, label: file.name, relative: relativeFilePath(currentPath, file.path) })
    })
    visit(files)
    return result
  }, [files, currentPath])
  const onCursor = useCallback((next: CursorContext) => setCursor(previous => previous.from === next.from && previous.to === next.to && previous.text === next.text && previous.line === next.line ? previous : next), [])
  useEffect(() => {
    const update = () => setViewport({ height: window.visualViewport?.height || window.innerHeight, top: window.visualViewport?.offsetTop || 0 })
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => { window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update) }
  }, [])
  const lensContentHeight = Math.max(32, Math.min(150, stageSize.height - 58))
  const lensWidth = Math.min(compact ? 228 : 280, stageSize.width - 16)
  const clampLens = useCallback((x: number, y: number) => ({
    x: Math.max(8, Math.min(x, stageSize.width - lensWidth - 8)),
    y: Math.max(8, Math.min(y, stageSize.height - lensContentHeight - 50))
  }), [stageSize, lensWidth, lensContentHeight])
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (stage.current) observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { setLensPosition(position => clampLens(position.x, position.y)) }, [clampLens])
  useEffect(() => {
    let cancelled = false
    void Promise.all(options.filter(file => file.path.endsWith('.bib')).map(async file => {
      try { return citationKeys(await FileReaderService.readFile(file.path) || '') } catch { return [] }
    })).then(keys => { if (!cancelled) setReferences([...new Set(keys.flat())]) })
    return () => { cancelled = true }
  }, [options, sheet, context.kind])
  useEffect(() => { setIssueIndex(0); setIssuesHidden(false) }, [errors])
  useEffect(() => {
    let cancelled = false
    setExcerpt('')
    if (!issue?.line) return
    const path = diagnosticPath(issue.file, currentPath)
    const source = path === currentPath ? Promise.resolve(editorProps.value) : FileReaderService.readFile(path)
    void source.then(text => { if (!cancelled && text) setExcerpt(text.split('\n').slice(Math.max(0, issue.line! - 2), issue.line! + 1).map((line, i) => `${Math.max(1, issue.line! - 1) + i}  ${line}`).join('\n')) }).catch(() => {})
    return () => { cancelled = true }
  }, [issue, currentPath, editorProps.value])
  useEffect(() => {
    setPeek(false); setSheet(null); setExpanded(false); setLens(false); bookmark.current = null; sheetBookmark.current = null
    window.clearTimeout(hold.current.timer)
    onPreviewChange(false)
  }, [currentPath, onPreviewChange])
  useEffect(() => () => window.clearTimeout(hold.current.timer), [])
  const restoreEditor = () => requestAnimationFrame(() => { if (bookmark.current) api.current?.restore(bookmark.current); else api.current?.focus() })
  const openPreview = () => {
    sourceTapReady.current = false
    bookmark.current = api.current?.bookmark() || null
    ;(document.activeElement as HTMLElement | null)?.blur()
    setExpanded(false); onPreviewChange(true)
  }
  const closePreview = () => { onPreviewChange(false); restoreEditor() }
  const openSheet = (kind: InsertKind) => {
    sheetArgument.current = kind === 'citation' && context.kind === 'citation' ? { from: context.from, to: cursor.to, closing: editorProps.value[cursor.to] === '}' } : null
    sheetBookmark.current = api.current?.bookmark() || null
    setExpanded(false); setSheet(kind)
  }
  const closeSheet = () => {
    setSheet(null)
    requestAnimationFrame(() => { if (sheetBookmark.current) api.current?.restore(sheetBookmark.current) })
  }
  const insert = async (text: string, packageName?: string, citation?: CitationItem) => {
    const insertionDocument = currentPath
    if (citation) {
      await citationService.trackCitation(citation)
      await editorProps.onCitationInsert?.(citation.citeKey, citationService.getBibtex(citation))
    }
    if (currentPathRef.current !== insertionDocument) return
    const saved = sheetBookmark.current
    const argument = sheetArgument.current
    const key = text.match(/^\\cite\{([^}]+)\}$/)?.[1]
    if (argument && key) {
      flushSync(() => setSheet(null))
      requestAnimationFrame(() => api.current?.focus())
      api.current?.insert(key + (argument.closing ? '' : '}'), { from: argument.from, to: argument.to, cursor: key.length + 1 })
      return
    }
    flushSync(() => { setSheet(null); onPreviewChange(false) })
    requestAnimationFrame(() => api.current?.focus())
    api.current?.insert(text, { from: saved ? Math.min(saved.anchor, saved.head) : undefined, to: saved ? Math.max(saved.anchor, saved.head) : undefined, package: packageName })
  }
  const snippet = (template: string) => {
    const selected = editorProps.value.slice(cursor.from, cursor.to)
    const marker = template.indexOf('|')
    api.current?.insert(template.replace('|', selected), { cursor: marker >= 0 ? marker + selected.length : template.length })
  }
  const completeArgument = (text: string) => {
    const closing = editorProps.value[cursor.to] === '}'
    api.current?.insert(text + (closing ? '' : '}'), { from: context.from, to: cursor.to, cursor: text.length + 1 })
  }
  const cancelPeek = () => { window.clearTimeout(hold.current.timer); setPeek(false); hold.current.active = false }
  const filteredFiles = options.filter(file => {
    if (context.command === 'input' || context.command === 'include') return file.path.endsWith('.tex')
    if (context.command === 'bibliography' || context.command === 'addbibresource') return file.path.endsWith('.bib')
    return /\.(png|jpe?g|pdf)$/i.test(file.path)
  }).filter(file => file.relative.toLowerCase().includes(context.query.toLowerCase())).slice(0, 12)
  const mathKeys = [['Fraction', '\\frac{|}{}'], ['Power', '^{|}'], ['Subscript', '_{|}'], ['α', '\\alpha '], ['β', '\\beta '], ['π', '\\pi '], ['Square root', '\\sqrt{|}'], ['Brackets', '\\left(|\\right)']]
  const textKeys = [['Bold', '\\textbf{|}'], ['Italic', '\\textit{|}'], ['Math', '$|$'], ['Citation', '\\cite{|}'], ['Input', '\\input{|}'], ['Braces', '{|}']]
  return <div className={`mobile-studio ${compact ? 'mobile-keyboard-open' : ''} ${showPreview ? 'mobile-viewing-pdf' : ''}`} style={{ height: viewport.height, top: viewport.top, '--mobile-height': `${viewport.height}px`, '--mobile-top': `${viewport.top}px` } as React.CSSProperties}>
    <div className="mobile-studio-stage" ref={stage}>
      <div className={`mobile-persistent-editor ${showPreview ? 'mobile-editor-concealed' : ''}`} aria-hidden={showPreview}>
        <LaTeXEditor {...editorProps} showCompileStatus={false} showWordCount={false} mobileApiRef={api} onCursorContext={onCursor} />
      </div>
      {showPreview && <div className="mobile-full-preview"><Suspense fallback={<p className="mobile-preview-message">Loading PDF…</p>}><PDFViewer onClose={closePreview} pdfData={pdfData || undefined} documentId={currentPath} onCompile={editorProps.onCompile} isCompiling={busy} /></Suspense></div>}
      {(peek || (lens && !showPreview)) && <div className={peek ? 'mobile-peek' : 'mobile-lens'} style={peek ? undefined : { left: lensPosition.x, top: lensPosition.y, width: lensWidth }} role="region" aria-label={peek ? 'PDF peek' : 'Movable PDF lens'}>
        <div className="mobile-lens-heading">
          {peek ? <span><Eye size={16} />Line {cursor.line} · release to return</span> : <button className="mobile-lens-grip" aria-label="Move PDF lens" title="Drag to move; use arrow keys when focused" onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); draggingLens.current = { x: event.clientX, y: event.clientY, originX: lensPosition.x, originY: lensPosition.y } }} onPointerMove={event => { const start = draggingLens.current; if (start) setLensPosition(clampLens(start.originX + event.clientX - start.x, start.originY + event.clientY - start.y)) }} onPointerUp={() => { draggingLens.current = null }} onPointerCancel={() => { draggingLens.current = null }} onKeyDown={event => { const moves: Record<string, number[]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }; const move = moves[event.key]; if (move) { event.preventDefault(); setLensPosition(position => clampLens(position.x + move[0], position.y + move[1])) } }}><GripHorizontal size={16} />Line {cursor.line}</button>}
          {!peek && <><button aria-label="Expand PDF lens" onClick={openPreview}><Maximize2 size={16} /></button><button aria-label="Close PDF lens" onClick={() => setLens(false)}><X size={16} /></button></>}
        </div>
        <PdfRegion data={pdfData} syncTex={syncTexData} line={cursor.line} documentPath={currentPath} lens={!peek} height={lensContentHeight} />
        {busy && <span className="mobile-preview-updating">Updating PDF…</span>}
      </div>}
    </div>
    {!showPreview && !peek && issue && !issuesHidden && editorProps.compileStatus === 'error' && <section className="mobile-error-card" aria-label="Compile error" aria-live="polite">
      <div className="mobile-error-top"><span><TriangleAlert size={16} />{issue.line ? `Line ${issue.line}` : 'Compilation error'}{issue.file ? ` · ${issue.file.split('/').pop()}` : ''}</span><button aria-label="Dismiss error card" onClick={() => setIssuesHidden(true)}><X size={16} /></button></div>
      <p>{issue.message}</p>{excerpt && <pre>{excerpt}</pre>}
      <div className="mobile-error-actions"><button disabled={!issue.line} onClick={() => { const path = diagnosticPath(issue.file, currentPath); if (path === currentPath) api.current?.goTo(issue.line!); else EventBus.emit('openDocument', { path, line: issue.line }) }}>Go there<ArrowRight size={14} /></button><button disabled={errors.length < 2} onClick={() => setIssueIndex(index => (index + 1) % errors.length)}>Next error ({Math.min(issueIndex + 1, errors.length)}/{errors.length})</button><button onClick={() => api.current?.showLog()}>Full log</button></div>
    </section>}
    {!showPreview && compact && <div className="mobile-context-strip" role="toolbar" aria-label={context.kind === 'math' ? 'Math shortcuts' : context.kind === 'citation' ? 'Citation suggestions' : context.kind === 'file' ? 'Project file suggestions' : 'LaTeX shortcuts'} onPointerDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }}>
      <button aria-label="Dismiss keyboard" className="mobile-keyboard-dismiss" onClick={() => (document.activeElement as HTMLElement | null)?.blur()}><Keyboard size={18} /><ChevronDown size={12} /></button><span className="mobile-context-label">{context.kind === 'text' ? 'LaTeX' : context.kind === 'math' ? 'Math' : context.kind === 'file' ? 'Files' : 'Cite'}</span>
      {context.kind === 'citation' ? <>{references.filter(key => key.toLowerCase().includes(context.query.toLowerCase())).slice(0, 12).map(key => <button key={key} onClick={() => completeArgument(key)}>{key}</button>)}<button onClick={() => openSheet('citation')}>Search libraries…</button></> : context.kind === 'file' ? <>{filteredFiles.map(file => <button key={file.path} onClick={() => completeArgument(/^(input|include)$/.test(context.command || '') ? file.relative.replace(/\.tex$/, '') : file.relative)}>{file.relative}</button>)}{filteredFiles.length === 0 && <span>No matching project files</span>}</> : (context.kind === 'math' ? mathKeys : textKeys).map(([label, template]) => <button key={label} onClick={() => snippet(template)}>{label}</button>)}
    </div>}
    {expanded && <div className="mobile-dock-drawer" aria-label="More tools">{insertChoices.map(choice => <button key={choice.kind} onClick={() => openSheet(choice.kind)}><choice.icon size={20} />{choice.label}</button>)}<button aria-pressed={lens} onClick={() => { setLens(previous => !previous); setExpanded(false); onPreviewChange(false) }}><ScanSearch size={20} />PDF lens</button>{errors.length > 0 && <button onClick={() => { setIssuesHidden(false); setExpanded(false); onPreviewChange(false) }}><TriangleAlert size={20} />Errors ({errors.length})</button>}<button onClick={() => { onPreviewChange(false); setExpanded(false); api.current?.showLog() }}><FileText size={20} />Compiler log</button></div>}
    <div className="mobile-dock" role="toolbar" aria-label="Document tools" onPointerDown={event => { dockDrag.current = event.clientY; movedDock.current = false }} onPointerMove={event => { if (dockDrag.current !== null && dockDrag.current - event.clientY > 35) { setExpanded(true); movedDock.current = true } }} onPointerUp={() => { dockDrag.current = null }} onPointerCancel={() => { dockDrag.current = null }}>
      <button className="mobile-dock-compile" onPointerDown={event => event.preventDefault()} aria-label={busy ? 'Compiling document' : 'Compile document'} disabled={busy} onClick={() => { if (!movedDock.current) editorProps.onCompile?.() }}><Play size={20} /><span>{busy ? 'Compiling…' : 'Compile'}</span></button>
      {showPreview ? <button key="source" aria-label="Source" onPointerDown={() => { sourceTapReady.current = true }} onKeyDown={() => { sourceTapReady.current = true }} onClick={() => { if (sourceTapReady.current || performance.now() - previewPointerTime.current > 800) closePreview() }}><Code2 size={20} /><span>Source</span></button> : <button key="preview" className="mobile-dock-preview" aria-label="Preview PDF; hold to peek" onContextMenu={event => event.preventDefault()} onPointerDown={event => {
        previewPointerTime.current = performance.now(); event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        bookmark.current = api.current?.bookmark() || null
        hold.current = { active: false, x: event.clientX, y: event.clientY, cancelled: false }
        hold.current.timer = window.setTimeout(() => { hold.current.active = true; setPeek(true); setExpanded(false) }, 300)
      }} onPointerMove={event => { if (!hold.current.active && Math.hypot(event.clientX - hold.current.x, event.clientY - hold.current.y) > 18) { window.clearTimeout(hold.current.timer); hold.current.cancelled = true } }} onPointerUp={event => {
        previewPointerTime.current = performance.now(); event.stopPropagation(); window.clearTimeout(hold.current.timer)
        const wasPeek = hold.current.active
        cancelPeek()
        if (!wasPeek && !hold.current.cancelled) openPreview()
        else if (bookmark.current) api.current?.restore(bookmark.current, false)
      }} onPointerCancel={cancelPeek} onLostPointerCapture={cancelPeek} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') previewPointerTime.current = -Infinity }} onClick={() => { if (performance.now() - previewPointerTime.current > 800) openPreview() }}><Eye size={20} /><span>Preview</span></button>}
      <button onClick={() => { if (!movedDock.current) openSheet('equation') }} aria-label="Insert" aria-haspopup="dialog"><Plus size={21} /><span>Insert</span></button>
      <button className="mobile-dock-more" aria-label={expanded ? 'Close more tools' : 'More tools; drag up to expand'} aria-expanded={expanded} onClick={() => { if (!movedDock.current) setExpanded(previous => !previous) }}>{expanded ? <ChevronDown size={20} /> : <ChevronUp size={20} />}<span>More</span></button>
    </div>
    {sheet && <InsertSheet availableHeight={viewport.height} key={currentPath} initialKind={sheet} files={options} citations={references} onClose={closeSheet} onInsert={insert} />}
  </div>
}
