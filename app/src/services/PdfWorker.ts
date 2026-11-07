import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

export const pdfWorkerUrl = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// PDF.js multiplexes document transports on one worker. Explicit ownership
// lets a loading task be cancelled or destroyed without killing the worker
// used by another document, a cached tab, or the next compilation.
let sharedWorker: pdfjs.PDFWorker | null = null
export function getPdfWorker(): pdfjs.PDFWorker {
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new pdfjs.PDFWorker()
  return sharedWorker
}
