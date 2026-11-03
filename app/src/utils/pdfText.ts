import type { PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api'

/** PDF.js uses ReadableStream async iteration, which is missing in some iOS browsers. */
export async function readPdfText(page: Pick<PDFPageProxy, 'streamTextContent'>): Promise<TextContent> {
  const reader = page.streamTextContent().getReader()
  const result: TextContent = { items: [], styles: Object.create(null), lang: null }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return result
      result.lang ??= value.lang
      Object.assign(result.styles, value.styles)
      result.items.push(...value.items)
    }
  } finally {
    reader.releaseLock()
  }
}
