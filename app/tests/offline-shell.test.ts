import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

test('a first document URL reload can use the installed app shell offline', async () => {
  const listeners = new Map<string, (event: any) => void>()
  const shell = { name: 'precached app shell' }
  const matches: string[] = []
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    URL, Request, console,
    self: { location: { origin: 'https://test.local' }, addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener) },
    caches: { open: async () => ({ match: async (request: string | { url: string }) => {
      const path = typeof request === 'string' ? request : request.url
      matches.push(path)
      return path === '/index.html' ? shell : undefined
    } }) },
    fetch: async () => { throw new Error('Network disconnected') },
  })
  let response!: Promise<unknown>
  listeners.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://test.local/?fastPreview&file=%2Fproject%2Fsrc%2Fcustom.tex' }, respondWith: (value: Promise<unknown>) => { response = value } })
  expect(await response).toBe(shell)
  expect(matches).toContain('/index.html')
})
