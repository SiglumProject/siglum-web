import { useEffect, useRef, useState } from 'react'
import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ParagraphPatch } from '../services/ParagraphPreview'

let worker: PDFWorker | undefined
const baseTextCache = new WeakMap<PDFDocumentProxy, { page: number; text: ReturnType<PDFPageProxy['getTextContent']> }>()

function getBaseText(document: PDFDocumentProxy, page: PDFPageProxy) {
  const cached = baseTextCache.get(document)
  if (cached?.page === page.pageNumber) return cached.text
  const text = page.getTextContent()
  baseTextCache.set(document, { page: page.pageNumber, text })
  void text.catch(() => {
    if (baseTextCache.get(document)?.text === text) baseTextCache.delete(document)
  })
  return text
}

function firstWords(text: string) {
  return text.trim().split(/\s+/).slice(0, 3).join(' ')
}

export default function ParagraphOverlay({ patch, document, scale, onFailure }: {
  patch: ParagraphPatch
  document: PDFDocumentProxy
  scale: number
  onFailure?: (patch: ParagraphPatch) => void
}) {
  const target = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState<{ patch: ParagraphPatch; scale: number; top: number; width: number; height: number }>()
  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof getDocument> | undefined
    void (async () => {
      try {
        task = getDocument({ data: patch.pdf.slice(), worker: worker ??= new PDFWorker(), useSystemFonts: false })
        const [base, fragment] = await Promise.all([document.getPage(patch.page), task.promise])
        if (fragment.numPages !== 1 || document.numPages !== patch.pageCount) throw new Error('Unexpected paragraph PDF')
        const strip = await fragment.getPage(1)
        const [baseText, stripText] = await Promise.all([getBaseText(document, base), strip.getTextContent()])
        const baseItems = baseText.items.flatMap(item => 'str' in item && item.str.trim() ? [item] : [])
        const stripItems = stripText.items.flatMap(item => 'str' in item && item.str.trim() ? [item] : [])
        if (patch.chapter && !baseItems.some(item => item.str.trim() === `Chapter ${patch.chapter} Local Page ${patch.localPage}`)) {
          throw new Error('Page does not match the project layout')
        }
        const original = baseItems.filter(item => item.str.startsWith(firstWords(patch.before)))
        const anchor = original[patch.occurrence]
        const first = stripItems[0]
        const last = stripItems.at(-1)
        if (original.length !== patch.anchorCount || !anchor || !first || !last || !first.str.startsWith(firstWords(patch.after))) throw new Error('Paragraph position unavailable')

        const lastWords = patch.before.trim().split(/\s+/).at(-1)
        const end = baseItems.slice(baseItems.indexOf(anchor)).find(item => lastWords && item.str.trim().endsWith(lastWords))
        if (!end) throw new Error('Paragraph end unavailable')
        const originalDepth = anchor.transform[5] - end.transform[5]
        const newDepth = first.transform[5] - last.transform[5]
        if (Math.abs(originalDepth - newDepth) > 0.05) throw new Error('Paragraph height changed')

        const ratio = window.devicePixelRatio || 1
        const viewport = base.getViewport({ scale: scale * ratio })
        const stripViewport = strip.getViewport({ scale: scale * ratio })
        const [x, y] = viewport.convertToViewportPoint(anchor.transform[4], anchor.transform[5])
        const [stripX, stripY] = stripViewport.convertToViewportPoint(first.transform[4], first.transform[5])
        const top = Math.floor(y - 9 * scale * ratio)
        const bottom = Math.floor(y + (originalDepth + 3) * scale * ratio)
        const canvas = window.document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = bottom - top
        await strip.render({ canvas, viewport: stripViewport, intent: 'print', transform: [1, 0, 0, 1, x - stripX, y - stripY - top] }).promise
        if (cancelled || !target.current) return
        target.current.width = canvas.width
        target.current.height = canvas.height
        target.current.getContext('2d')?.drawImage(canvas, 0, 0)
        setDrawn({ patch, scale, top: top / ratio, width: canvas.width / ratio, height: canvas.height / ratio })
      } catch {
        if (!cancelled) onFailure?.(patch)
      } finally {
        if (!cancelled) await task?.destroy().catch(() => {})
      }
    })()
    return () => {
      cancelled = true
      void task?.destroy().catch(() => {})
    }
  }, [patch, document, scale, onFailure])

  const visible = drawn?.patch === patch && drawn.scale === scale
  return <canvas ref={target} data-paragraph-preview={visible ? '' : undefined} aria-hidden="true"
    style={{ position: 'absolute', pointerEvents: 'none', display: visible ? 'block' : 'none',
      left: 0, top: drawn?.top, width: drawn?.width, height: drawn?.height }} />
}
