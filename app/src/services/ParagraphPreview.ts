export interface ParagraphEdit {
  chapter?: number
  localPage: number
  pageCount: number
  page: number
  paragraph: number
  occurrence: number
  anchorCount: number
  before: string
  after: string
}

export interface ParagraphPatch extends ParagraphEdit {
  basePdf: Uint8Array
  pdf: Uint8Array
}

export const paragraphPreviewEnabled = import.meta.env.MODE === 'local-preview'
  && new URLSearchParams(location.search).has('paragraphPreview')

let worker: Worker | undefined
let nextRequest = 0
const pending = new Map<number, { resolve: (pdf: Uint8Array) => void; reject: (error: Error) => void; timeout: number }>()

function reset(error: Error) {
  worker?.terminate()
  worker = undefined
  for (const request of pending.values()) {
    clearTimeout(request.timeout)
    request.reject(error)
  }
  pending.clear()
}

function getWorker() {
  if (worker) return worker
  worker = new Worker('/paragraph-runtime/worker.js')
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    clearTimeout(request.timeout)
    if (data.error) request.reject(new Error(data.error))
    else request.resolve(data.pdf)
  }
  worker.onerror = () => reset(new Error('Paragraph worker failed'))
  return worker
}

function requestParagraph(text?: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const currentWorker = getWorker()
    const id = ++nextRequest
    const timeout = window.setTimeout(() => reset(new Error('Paragraph worker timed out')), 2500)
    pending.set(id, { resolve, reject, timeout })
    currentWorker.postMessage({ id, text })
  })
}

export function warmParagraphPreview() {
  return requestParagraph().then(() => undefined)
}

export function typesetParagraph(text: string) {
  return requestParagraph(text)
}
