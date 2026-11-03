import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Code2, Download, Minus, Plus } from 'lucide-react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfText } from '../../utils/pdfText'
import './MobilePDFViewer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()
const clampZoom = (zoom: number) => Math.max(1, Math.min(4, zoom))
type PageSize = { width: number; height: number }

function Page({ pdf, number, size, width, scrollRoot }: {
  pdf: pdfjs.PDFDocumentProxy; number: number; size: PageSize; width: number;
  scrollRoot: React.RefObject<HTMLDivElement>
}) {
  const element = useRef<HTMLElement>(null)
  const artwork = useRef<HTMLDivElement>(null)
  const [nearby, setNearby] = useState(false)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), { root: scrollRoot.current, rootMargin: '400px 0px' })
    if (element.current) observer.observe(element.current)
    return () => observer.disconnect()
  }, [scrollRoot])
  useEffect(() => {
    const host = artwork.current
    if (!host) return
    if (!nearby) { host.replaceChildren(); return }
    let cancelled = false
    let task: pdfjs.RenderTask | undefined
    const canvas = document.createElement('canvas')
    canvas.className = 'pdf-page-canvas'
    canvas.setAttribute('aria-label', `PDF page ${number}`)
    setError(false)
    void (async () => {
      const page = await pdf.getPage(number)
      if (cancelled) return
      const viewport = page.getViewport({ scale: width / size.width })
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3_000_000 / (viewport.width * viewport.height)))
      canvas.width = Math.ceil(viewport.width * ratio)
      canvas.height = Math.ceil(viewport.height * ratio)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      task = page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
      await task.promise
      if (cancelled) return
      // Keep the previous bitmap visible while a sharper zoomed page renders.
      host.replaceChildren(canvas)
      try {
        const content = await readPdfText(page)
        if (cancelled) return
        const layer = document.createElement('div')
        layer.className = 'pdf-text-layer'
        // Use page coordinates so text stretches with the bitmap during a pinch.
        const unit = page.getViewport({ scale: 1 })
        for (const item of content.items) {
          if (!('str' in item) || !item.str) continue
          const span = document.createElement('span')
          span.textContent = item.str
          const tx = pdfjs.Util.transform(unit.transform, item.transform)
          const height = Math.hypot(tx[2], tx[3])
          const style = content.styles[item.fontName]
          const angle = Math.atan2(tx[1], tx[0])
          const ascent = height * (style?.ascent ?? 0.8)
          span.style.cssText = `left:${(tx[4] + ascent * Math.sin(angle)) / unit.width * 100}%;top:${(tx[5] - ascent * Math.cos(angle)) / unit.height * 100}%;font-size:${height / unit.width * 100}cqw;font-family:${style?.fontFamily || 'sans-serif'};transform:rotate(${angle}rad)`
          context.font = `${height}px ${style?.fontFamily || 'sans-serif'}`
          const measured = context.measureText(item.str).width
          if (measured) span.style.transform += ` scaleX(${item.width / measured})`
          layer.appendChild(span)
        }
        host.appendChild(layer)
      } catch (cause) { if (!cancelled) console.warn('PDF text selection unavailable', cause) }
      page.cleanup()
    })().catch(cause => { if (!cancelled && cause.name !== 'RenderingCancelledException') setError(true) })
    return () => { cancelled = true; task?.cancel() }
  }, [pdf, number, width, size.width, nearby, retry])
  return <section ref={element} className="mobile-pdf-page" data-page={number} aria-label={`Page ${number}`} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
    <div ref={artwork} className="mobile-pdf-artwork" />
    {error && <div className="mobile-pdf-page-error" role="alert">This page could not be rendered.<button onClick={() => setRetry(value => value + 1)}>Retry page {number}</button></div>}
  </section>
}

export default function MobilePDFViewer({ pdfData, documentId, onCompile, isCompiling, onClose }: {
  pdfData?: Uint8Array; documentId: string; onCompile?: () => void; isCompiling?: boolean; onClose: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [message, setMessage] = useState('Loading PDF…')
  const [loadRetry, setLoadRetry] = useState(0)
  const [fitWidth, setFitWidth] = useState(304)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const liveZoom = useRef(1)
  const fit = useRef(fitWidth)
  fit.current = fitWidth
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setFitWidth(Math.max(1, entry.contentRect.width - 16)))
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setPdf(null); setSizes([]); setCurrentPage(1)
    liveZoom.current = 1; setZoom(1)
    if (pages.current) pages.current.style.setProperty('--pdf-page-width', `${fit.current}px`)
    if (root.current) root.current.scrollTo(0, 0)
    if (!pdfData) { setMessage('Compile your document to see its PDF.'); return }
    setMessage('Loading PDF…')
    let cancelled = false
    const task = pdfjs.getDocument({ data: Uint8Array.from(pdfData) })
    void (async () => {
      const document = await task.promise
      const dimensions: PageSize[] = []
      // Read page dimensions without allocating canvases for the whole document.
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index)
        if (cancelled) return
        const viewport = page.getViewport({ scale: 1 })
        dimensions.push({ width: viewport.width, height: viewport.height })
      }
      if (!cancelled) { setSizes(dimensions); setPdf(document); setMessage('') }
    })().catch(() => { if (!cancelled) setMessage('Could not open this PDF. Try again or compile your document.') })
    return () => { cancelled = true; void task.destroy() }
  }, [pdfData, documentId, loadRetry])

  type Anchor = { page: HTMLElement; x: number; y: number }
  const anchorAt = (x: number, y: number): Anchor | null => {
    const children = pages.current?.querySelectorAll<HTMLElement>('[data-page]')
    if (!children?.length) return null
    const page = Array.from(children).find(child => child.getBoundingClientRect().bottom >= y) || children[children.length - 1]
    const box = page.getBoundingClientRect()
    return { page, x: (x - box.left) / box.width, y: (y - box.top) / box.height }
  }
  const resize = (next: number, x: number, y: number, anchor = anchorAt(x, y)) => {
    const scroll = root.current
    if (!scroll || !pages.current) return
    liveZoom.current = clampZoom(next)
    pages.current.style.setProperty('--pdf-page-width', `${fit.current * liveZoom.current}px`)
    // Anchor the exact point between the fingers, including while the midpoint moves.
    if (anchor) {
      const box = anchor.page.getBoundingClientRect()
      scroll.scrollLeft += box.left + anchor.x * box.width - x
      scroll.scrollTop += box.top + anchor.y * box.height - y
    }
  }
  const changeZoom = (next: number) => {
    const box = root.current?.getBoundingClientRect()
    if (!box) return
    resize(next, box.left + box.width / 2, box.top + box.height / 2)
    setZoom(liveZoom.current)
  }
  useLayoutEffect(() => {
    pages.current?.style.setProperty('--pdf-page-width', `${fitWidth * liveZoom.current}px`)
  }, [fitWidth])
  useEffect(() => {
    const scroll = root.current
    if (!scroll) return
    let pinch: { distance: number; zoom: number; anchor: Anchor | null } | null = null
    const geometry = (touches: TouchList) => ({
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
      distance: Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    })
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return
      event.preventDefault()
      const point = geometry(event.touches)
      pinch = { distance: Math.max(1, point.distance), zoom: liveZoom.current, anchor: anchorAt(point.x, point.y) }
    }
    const move = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return
      event.preventDefault()
      const point = geometry(event.touches)
      resize(pinch.zoom * point.distance / pinch.distance, point.x, point.y, pinch.anchor)
    }
    const end = () => { if (pinch) { pinch = null; setZoom(liveZoom.current) } }
    scroll.addEventListener('touchstart', start, { passive: false })
    scroll.addEventListener('touchmove', move, { passive: false })
    scroll.addEventListener('touchend', end)
    scroll.addEventListener('touchcancel', end)
    return () => { scroll.removeEventListener('touchstart', start); scroll.removeEventListener('touchmove', move); scroll.removeEventListener('touchend', end); scroll.removeEventListener('touchcancel', end) }
  }, [])
  const download = () => {
    if (!pdfData) return
    const url = URL.createObjectURL(new Blob([Uint8Array.from(pdfData)], { type: 'application/pdf' }))
    const link = document.createElement('a')
    link.href = url; link.download = (documentId.split('/').pop() || 'document.tex').replace(/\.tex$/i, '') + '.pdf'
    link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return <div className="mobile-pdf-viewer">
    <div className="mobile-pdf-toolbar" role="toolbar" aria-label="PDF controls">
      <button aria-label="Back to source" onClick={onClose}><Code2 size={18} /></button>
      <span className="mobile-pdf-count" aria-label={`Page ${currentPage} of ${pdf?.numPages || 0}`}>{pdf ? `${currentPage} / ${pdf.numPages}` : 'PDF'}</span>
      <button aria-label="Zoom out PDF" disabled={!pdf || zoom <= 1} onClick={() => changeZoom(zoom - 0.5)}><Minus size={18} /></button>
      <button className="mobile-pdf-fit" aria-label="Fit PDF to width" disabled={!pdf} onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%<small>Fit</small></button>
      <button aria-label="Zoom in PDF" disabled={!pdf || zoom >= 4} onClick={() => changeZoom(zoom + 0.5)}><Plus size={18} /></button>
      <button aria-label="Download PDF" disabled={!pdfData} onClick={download}><Download size={18} /></button>
    </div>
    <div ref={root} className="mobile-pdf-scroll" role="region" aria-label="Scrollable PDF" tabIndex={0} onScroll={() => {
      const box = root.current?.getBoundingClientRect()
      const midpoint = box ? box.top + box.height / 2 : 0
      const children = pages.current?.querySelectorAll<HTMLElement>('[data-page]')
      const visible = children && Array.from(children).find(child => child.getBoundingClientRect().bottom > midpoint)
      if (visible) setCurrentPage(Number(visible.dataset.page))
    }}>
      {message && <div className="mobile-pdf-message" role="status"><p>{message}</p>{pdfData ? <button onClick={() => setLoadRetry(value => value + 1)}>Retry preview</button> : <button disabled={isCompiling} onClick={onCompile}>{isCompiling ? 'Compiling…' : 'Compile document'}</button>}</div>}
      <div ref={pages} className="mobile-pdf-pages">
        {pdf && sizes.map((size, index) => <Page key={index} pdf={pdf} number={index + 1} size={size} width={fitWidth * zoom} scrollRoot={root} />)}
      </div>
    </div>
  </div>
}
