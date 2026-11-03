import { useLayoutEffect, useRef, useState } from 'react'
import './PdfPageControl.css'

export default function PdfPageControl({ page, count, onChange, className = '' }: {
  page: number; count: number; onChange: (page: number) => void; className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const finished = useRef(false)
  const restoreFocus = useRef(false)
  useLayoutEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select() }
    else if (restoreFocus.current) { restoreFocus.current = false; button.current?.focus({ preventScroll: true }) }
  }, [editing])
  const finish = (commit: boolean, focusButton: boolean) => {
    if (finished.current) return
    finished.current = true
    if (commit && /^\d+$/.test(draft.trim())) {
      const value = Number(draft)
      if (Number.isFinite(value)) onChange(Math.max(1, Math.min(count, value)))
    }
    restoreFocus.current = focusButton
    setEditing(false)
  }
  return <span className={`pdf-page-control ${className}`}>
    {editing ? <input ref={input} className="pdf-page-input" aria-label="Page number" title={`Page 1 to ${count}`} inputMode="numeric" pattern="[0-9]*" value={draft}
      onChange={event => setDraft(event.target.value)} onBlur={() => finish(true, false)}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finish(event.key === 'Enter', true) }
      }} /> : <button ref={button} type="button" className="pdf-page-counter-button" disabled={!count} aria-label={`Go to page, current page ${page} of ${count}`} title="Go to page" onClick={() => {
        finished.current = false; setDraft(String(page)); setEditing(true)
      }}>{count ? `${page} / ${count}` : 'PDF'}</button>}
  </span>
}
