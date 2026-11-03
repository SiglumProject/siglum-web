import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parseSyncTeX, forwardSync } from '../../utils/synctex'
import { compilationContext } from '../../services/CompilationFiles'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()
export default function PdfRegion({ data, syncTex, line, documentPath, lens = false, height: lensHeight = 150 }: {
  data: Uint8Array | null; syncTex: string | null; line: number; documentPath?: string; lens?: boolean; height?: number
}) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [width, setWidth] = useState(300)
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [message, setMessage] = useState('Loading preview…')
  const [pageNumber, setPageNumber] = useState(1)
  const map = useMemo(() => syncTex ? parseSyncTeX(syncTex) : null, [syncTex])
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(1, entries[0].contentRect.width)))
    if (container.current) observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setDocument(null)
    if (!data) { setMessage('Compile your document to see its PDF.'); return }
    setMessage('Loading preview…')
    let cancelled = false
    const task = pdfjs.getDocument({ data: Uint8Array.from(data) })
    task.promise.then(pdf => { if (!cancelled) setDocument(pdf) }).catch(error => { if (!cancelled) setMessage(error.message || 'Preview unavailable') })
    return () => { cancelled = true; void task.destroy() }
  }, [data])
  const renderWidth = lens ? 0 : width
  useEffect(() => {
    if (!document || !canvas.current) return
    let cancelled = false
    let task: pdfjs.RenderTask | undefined
    const target = canvas.current
    ;(async () => {
      const filename = compilationContext(documentPath).mainFile
      const preliminary = map ? forwardSync(map, line, filename) : null
      const number = Math.max(1, Math.min(preliminary?.page || 1, document.numPages))
      const page = await document.getPage(number)
      if (cancelled) return
      const size = page.getViewport({ scale: 1 })
      const location = map ? forwardSync(map, line, filename, size.height) : null
      const scale = lens ? 1.25 : Math.max(1.1, width / Math.max(1, size.width - 144))
      const height = 230
      const left = Math.max(0, Math.min((location?.x || 72) - (lens ? 28 : 40), size.width - width / scale))
      const top = Math.max(0, Math.min((location?.y || 90) - 48, size.height - height / scale))
      const pageWidth = lens ? size.width * scale : width
      const pageHeight = lens ? size.height * scale : height
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3_000_000 / (pageWidth * pageHeight)))
      target.width = Math.round(pageWidth * ratio)
      target.height = Math.round(pageHeight * ratio)
      target.style.width = `${pageWidth}px`
      target.style.height = `${pageHeight}px`
      const context = target.getContext('2d')
      if (!context) return
      task = page.render({ canvas: target, canvasContext: context, viewport: page.getViewport({ scale }), transform: [ratio, 0, 0, ratio, lens ? 0 : -left * scale * ratio, lens ? 0 : -top * scale * ratio] })
      await task.promise
      if (!cancelled) {
        setPageNumber(number); setMessage('')
        // Reveal before scrolling: a display:none canvas has no scrollable extent.
        target.hidden = false
        if (lens && scroll.current) {
          scroll.current.scrollLeft = Math.max(0, ((location?.x ?? 72) - 28) * scale)
          scroll.current.scrollTop = Math.max(0, ((location?.y ?? 90) - 48) * scale)
        }
      }
      page.cleanup()
    })().catch(error => { if (!cancelled && error.name !== 'RenderingCancelledException') setMessage('Could not render this preview.') })
    return () => { cancelled = true; task?.cancel() }
  }, [document, map, line, documentPath, renderWidth, lens])
  return <div className={`mobile-pdf-region ${lens ? 'mobile-pdf-region-interactive' : ''}`} ref={container}>
    {message && <div className="mobile-preview-message" role="status">{message}</div>}
    <div ref={scroll} className={lens ? 'mobile-lens-scroll' : undefined} style={lens ? { height: lensHeight } : undefined} role={lens ? 'region' : undefined} aria-label={lens ? 'PDF lens content; scroll or drag to pan' : undefined} tabIndex={lens ? 0 : undefined}
      onPointerDown={event => {
        if (!lens || event.pointerType !== 'mouse' || event.button !== 0) return
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }
        event.currentTarget.classList.add('is-panning')
      }} onPointerMove={event => {
        const start = drag.current
        if (!start) return
        event.currentTarget.scrollLeft = start.left + start.x - event.clientX
        event.currentTarget.scrollTop = start.top + start.y - event.clientY
      }} onPointerUp={event => { drag.current = null; event.currentTarget.classList.remove('is-panning') }} onPointerCancel={event => { drag.current = null; event.currentTarget.classList.remove('is-panning') }} onLostPointerCapture={event => { drag.current = null; event.currentTarget.classList.remove('is-panning') }}>
      <canvas ref={canvas} aria-label={`PDF preview near source line ${line}, page ${pageNumber}`} hidden={!!message} />
    </div>
    {!message && <span className="mobile-preview-page">Page {pageNumber} · {map ? `near line ${line}` : 'last compiled PDF'}</span>}
  </div>
}
