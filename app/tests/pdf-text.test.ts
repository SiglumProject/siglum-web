import { expect, test } from 'bun:test'
import { readPdfText } from '../src/utils/pdfText'

test('extracts PDF text without ReadableStream async iteration (iOS)', async () => {
  let released = false
  const chunks = [
    { items: [{ str: 'Chris' }], styles: { a: { fontFamily: 'serif' } }, lang: null },
    { items: [{ str: 'mobile PDF' }], styles: { b: { fontFamily: 'sans-serif' } }, lang: 'en' },
  ]
  const page = { streamTextContent: () => ({ getReader: () => ({
    read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true },
    releaseLock: () => { released = true },
  }) }) }
  const content = await readPdfText(page as any)
  expect(content.items).toEqual([{ str: 'Chris' }, { str: 'mobile PDF' }])
  expect(Object.keys(content.styles)).toEqual(['a', 'b'])
  expect(content.lang).toBe('en')
  expect(released).toBe(true)
})

test('releases the stream reader when text extraction fails', async () => {
  let released = false
  const page = { streamTextContent: () => ({ getReader: () => ({
    read: async () => { throw new Error('Interrupted') }, releaseLock: () => { released = true },
  }) }) }
  await expect(readPdfText(page as any)).rejects.toThrow('Interrupted')
  expect(released).toBe(true)
})
