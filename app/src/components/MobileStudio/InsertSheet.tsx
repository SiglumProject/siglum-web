import { useEffect, useMemo, useState } from 'react'
import { Sigma, Table2, Image, Quote, Heading, X, Check, Link2 } from 'lucide-react'
import { Drawer } from 'vaul'
import MathExample from './MathExample'
import TableEditor from './TableEditor'
import { useCitationSearch } from './useCitationSearch'
import type { CitationItem } from '../../services/CitationService'
import EventBus from '../../services/EventBus'
import FileReaderService from '../../services/FileReaderService'
import { buildInsertion, initialForm, type InsertKind, type InsertForm } from './model'

export interface ProjectOption { path: string; label: string; relative: string }
export const insertChoices = [
  { kind: 'equation', label: 'Equation', icon: Sigma },
  { kind: 'table', label: 'Table', icon: Table2 },
  { kind: 'figure', label: 'Image', icon: Image },
  { kind: 'citation', label: 'Citation', icon: Quote },
  { kind: 'section', label: 'Section', icon: Heading },
] as const
export default function InsertSheet({ initialKind, files, citations, availableHeight, onClose, onInsert }: {
  availableHeight: number; initialKind: InsertKind; files: ProjectOption[]; citations: string[]; onClose: () => void;
  onInsert: (text: string, packageName?: string, citation?: CitationItem) => void | Promise<void>
}) {
  const [kind, setKind] = useState(initialKind)
  const compact = availableHeight < 480
  const [citationQuery, setCitationQuery] = useState('')
  const [selectedCitation, setSelectedCitation] = useState<CitationItem | undefined>()
  const [inserting, setInserting] = useState(false)
  const [insertError, setInsertError] = useState('')
  const library = useCitationSearch(citationQuery, kind === 'citation')
  const [open, setOpen] = useState(true)
  const [manualCitation, setManualCitation] = useState(false)
  const images = files.filter(file => /\.(png|jpe?g|pdf)$/i.test(file.path))
  const [form, setForm] = useState<InsertForm>({ ...initialForm, file: images[0]?.relative || '', citeKey: '' })
  const [editedSource, setEditedSource] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const insertion = useMemo(() => buildInsertion(kind, form), [kind, form])
  const update = (field: keyof InsertForm, value: string) => { setForm(previous => ({ ...previous, [field]: value })); setEditedSource(null) }
  useEffect(() => {
    const selected = files.find(file => file.relative === form.file)
    setImageUrl(null)
    if (!selected || !/\.(png|jpe?g)$/i.test(selected.path)) return
    let cancelled = false
    let url: string | undefined
    void FileReaderService.readBinary(selected.path).then(bytes => {
      if (cancelled || !bytes) return
      url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: /\.png$/i.test(selected.path) ? 'image/png' : 'image/jpeg' }))
      setImageUrl(url)
    }).catch(() => {})
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [form.file, files])
  const localKeys = citations.filter(key => key.toLowerCase().includes(citationQuery.toLowerCase()) && !library.items.some(item => item.citeKey === key)).slice(0, 20)
  const hasResults = library.items.length + localKeys.length > 0
  const connectLibrary = () => { onClose(); EventBus.emit('openIntegrations') }
  const insertButton = <button className="mobile-primary sheet-insert-action" aria-label={`Insert ${kind === 'figure' ? 'image' : kind}`} disabled={inserting || !!insertion.error || !(editedSource ?? insertion.source).trim()} onClick={async () => { setInserting(true); setInsertError(''); try { await onInsert(editedSource ?? insertion.source, insertion.package, kind === 'citation' ? selectedCitation : undefined) } catch { setInsertError(kind === 'citation' ? 'Could not save this reference. Try again.' : 'Could not insert. Try again.'); setInserting(false) } }}>{inserting ? '…' : 'Insert'}</button>
  return <Drawer.Root dismissible={!inserting} open={open} onOpenChange={setOpen} onAnimationEnd={visible => { if (!visible) onClose() }} repositionInputs={false} fixed autoFocus={false} handleOnly>
    <Drawer.Portal>
      <Drawer.Overlay className="insert-sheet-overlay" />
      <Drawer.Content className={`ios-insert-sheet insert-sheet-stable ${compact ? 'insert-sheet-compact' : ''} insert-sheet-${kind}`} style={{ top: (window.visualViewport?.offsetTop || 0) + 8, bottom: 'auto', height: Math.max(120, availableHeight - 8) }} onCloseAutoFocus={event => event.preventDefault()}>
        <Drawer.Handle className="insert-sheet-handle" aria-label="Dismiss insert sheet" />
        <div className="insert-sheet-heading">
          <Drawer.Title className="visually-hidden">Insert {kind === 'figure' ? 'image' : kind}</Drawer.Title>
          <select className="insert-kind-select" aria-label="Insert type" value={kind} onChange={event => { setKind(event.target.value as InsertKind); setEditedSource(null) }}>{insertChoices.map(choice => <option key={choice.kind} value={choice.kind}>Insert {choice.label.toLowerCase()}</option>)}</select>
          {insertButton}
          <Drawer.Close disabled={inserting} aria-label="Close insert sheet"><X size={19} /></Drawer.Close>
        </div>
        <Drawer.Description className="visually-hidden">Choose what to insert. Swipe the handle down to close.</Drawer.Description>
    <div className="mobile-insert-body" data-vaul-no-drag>
      {kind === 'equation' && <div className="mobile-form-pair">
        <label>Numerator<input value={form.numerator} onChange={event => update('numerator', event.target.value)} spellCheck={false} /></label>
        <label>Denominator<input value={form.denominator} onChange={event => update('denominator', event.target.value)} spellCheck={false} /></label>
      </div>}
      {kind === 'table' && <TableEditor value={form.table} onChange={value => update('table', value)} caption={form.caption} onCaptionChange={value => update('caption', value)} />}
      {kind === 'figure' && <label>Project image<select aria-label="Project image" value={form.file} onChange={event => update('file', event.target.value)}><option value="">Choose an image</option>{images.map(file => <option key={file.path} value={file.relative}>{file.label}</option>)}</select></label>}
      {kind === 'figure' && <label>Caption <span>(optional)</span><input value={form.caption} onChange={event => update('caption', event.target.value)} /></label>}
      {kind === 'citation' && <div className="mobile-citation-picker">
        <label className="citation-search"><span className="visually-hidden">Search references</span><input aria-label="Search references" type="search" placeholder="Search title or author" value={citationQuery} onChange={event => { setCitationQuery(event.target.value); setSelectedCitation(undefined); update('citeKey', ''); setManualCitation(false) }} autoCapitalize="none" spellCheck={false} /></label>
        {library.loading && <p className="citation-empty" role="status">Searching…</p>}
        {library.error && <p className="citation-empty" role="alert">{library.error}</p>}
        <div className="mobile-citation-results" role="group" aria-label="Reference results">
          {library.items.map(item => <button key={item.citeKey} aria-pressed={form.citeKey === item.citeKey} onClick={() => { setSelectedCitation(item); update('citeKey', item.citeKey); (document.activeElement as HTMLElement)?.blur() }}><span className="citation-result-copy"><strong>{item.title || item.citeKey}</strong>{(item.creatorsText || item.year) && <span>{[item.creatorsText, item.year].filter(Boolean).join(' · ')}</span>}</span>{form.citeKey === item.citeKey && <Check size={18} />}</button>)}
          {localKeys.map(key => <button key={key} aria-pressed={form.citeKey === key} onClick={() => { setSelectedCitation(undefined); update('citeKey', key); (document.activeElement as HTMLElement)?.blur() }}><strong>{key}</strong>{form.citeKey === key && <Check size={18} />}</button>)}
        </div>
        {!hasResults && !library.loading && !library.error && <p className="citation-empty">{citationQuery ? 'No references found.' : library.status.connectedCount ? 'Search your library above.' : 'Add references from your Zotero library.'}</p>}
        {!library.status.connectedCount && <button className="citation-connect" onClick={connectLibrary}><Link2 size={17} />Connect Zotero</button>}
        <details className="citation-manual" open={manualCitation} onToggle={event => setManualCitation(event.currentTarget.open)}><summary>Use a citation key</summary><label>Key from your .bib file<input aria-label="Citation key" value={form.citeKey} onChange={event => { setSelectedCitation(undefined); update('citeKey', event.target.value) }} placeholder="e.g. smith2026" autoCapitalize="none" spellCheck={false} /></label></details>
      </div>}
      {kind === 'section' && <><label>Heading<input value={form.heading} onChange={event => update('heading', event.target.value)} /></label><label>Level<select value={form.level} onChange={event => update('level', event.target.value)}><option value="section">Section</option><option value="subsection">Subsection</option><option value="subsubsection">Subsubsection</option></select></label></>}
      {kind !== 'table' && kind !== 'citation' && <>
      <div className="mobile-example-label">{editedSource !== null && kind !== 'equation' ? 'Custom LaTeX' : 'Live example'}</div>
      <div className="mobile-insert-example" aria-label="Live layout preview">
        {kind === 'equation' && <MathExample source={(editedSource ?? insertion.source).trim()} />}
        {editedSource === null && kind === 'figure' && <figure>{imageUrl ? <img src={imageUrl} alt={form.caption || 'Selected project image'} /> : <div className="mobile-image-placeholder"><Image size={32} /><span>{form.file ? 'PDF figure · available in the compiled document' : 'Select a project image'}</span></div>}{form.caption && <figcaption>Figure: {form.caption}</figcaption>}</figure>}
        {editedSource === null && kind === 'section' && <h3>{form.level === 'section' ? '1' : form.level === 'subsection' ? '1.1' : '1.1.1'} {form.heading}</h3>}
        {editedSource !== null && kind !== 'equation' && <pre className="mobile-custom-example">{editedSource}</pre>}
      </div>
      <p className="mobile-field-help mobile-preview-note">Your document’s fonts, numbering, and citation style apply when compiled.</p>
      <details className="mobile-insert-source"><summary>Edit LaTeX</summary><textarea aria-label="LaTeX to insert" rows={6} value={editedSource ?? insertion.source} onChange={event => setEditedSource(event.target.value)} spellCheck={false} /></details>
      </>}
      {insertion.error && kind !== 'citation' && <p className="mobile-field-help" role="status">{insertion.error}</p>}
      {kind === 'figure' && <p className="mobile-field-help">Adds graphicx to the preamble if needed.</p>}
    </div>
    {insertError && <p className="mobile-insert-error" role="alert">{insertError}</p>}

      </Drawer.Content>
    </Drawer.Portal>
  </Drawer.Root>
}
