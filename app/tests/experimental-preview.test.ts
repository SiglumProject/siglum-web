import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { startPreview } from '../scripts/preview-experimental.mjs'

test('matched runtime preview serves bounded ranges, tool policies and the explicit package proxy', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'siglum-preview-'))
  const upstream = createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ path: request.url })) })
  await new Promise<void>(yes => upstream.listen(0, '127.0.0.1', yes))
  const upstreamPort = (upstream.address() as { port: number }).port
  let preview: Awaited<ReturnType<typeof startPreview>> | undefined
  try {
    await mkdir(resolve(directory, 'app'), { recursive: true })
    await mkdir(resolve(directory, 'runtime/wasm'), { recursive: true })
    await writeFile(resolve(directory, 'app/index.html'), '<h1>Synthetic editor</h1>')
    await writeFile(resolve(directory, 'runtime/wasm/busytex.wasm'), 'native')
    const releaseId = 'tl2026-1234567890abcdef'
    await writeFile(resolve(directory, 'runtime/manifest.json'), JSON.stringify({ releaseId, engineVersion: '1.2.3', files: { 'wasm/busytex.wasm': { size: 6 } } }))
    const config = resolve(directory, 'runtime/server-config.json')
    await writeFile(config, JSON.stringify({ runtimeRoot: '.', manifest: 'manifest.json', files: {} }))
    const revision = 'a'.repeat(64), prefix = '/tools/providers/' + revision + '/'
    await mkdir(resolve(directory, 'app', '.' + prefix), { recursive: true })
    await writeFile(resolve(directory, 'app', '.' + prefix, 'worker.js'), '// tool')
    await writeFile(resolve(directory, 'app', '.' + prefix, 'provider-policy.json'), JSON.stringify({ worker: prefix + 'worker.js', scripts: [prefix + 'worker.js'], connect: [prefix + 'runtime.wasm'], wasm: true }))
    preview = await startPreview(0, { directory: resolve(directory, 'app'), config, packageProxy: 'http://127.0.0.1:' + upstreamPort })
    const base = preview.url + '/engine/releases/' + releaseId + '/'
    const partial = await fetch(base + 'wasm/busytex.wasm', { headers: { Range: 'bytes=1-2' } })
    expect(partial.status).toBe(206); expect(await partial.text()).toBe('at')
    expect(partial.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp')
    const suffix = await fetch(base + 'wasm/busytex.wasm', { headers: { Range: 'bytes=-2' } })
    expect(await suffix.text()).toBe('ve')
    const invalid = await fetch(base + 'wasm/busytex.wasm', { headers: { Range: 'bytes=900-' } })
    expect(invalid.status).toBe(416)
    expect((await fetch(base + 'manifest.json').then(r => r.json())).releaseId).toBe(releaseId)
    const runtimeText = await fetch(base + 'runtime.json').then(r => r.text())
    const pointer = await fetch(preview.url + '/engine/engines/1.2.3/latest.json')
    expect(pointer.headers.get('Cache-Control')).toBe('no-store')
    const descriptor = await pointer.json()
    expect(descriptor.manifestUrl).toBe(base + 'runtime.json')
    expect(descriptor.manifestSha256).toBe(createHash('sha256').update(runtimeText).digest('hex'))
    expect((await fetch(base + 'not-in-manifest')).status).toBe(404)
    expect((await fetch(preview.url + '/%2e%2e%2fruntime%2fmanifest.json')).status).toBe(404)
    const head = await fetch(base + 'wasm/busytex.wasm', { method: 'HEAD' })
    expect(head.headers.get('Content-Length')).toBe('6'); expect(await head.text()).toBe('')
    const tool = await fetch(preview.url + prefix + 'worker.js')
    expect(tool.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(tool.headers.get('Content-Security-Policy')).toContain("'wasm-unsafe-eval'")
    expect((await fetch(base + 'api/check?q=one').then(r => r.json())).path).toBe('/api/check?q=one')
    expect((await fetch(base + 'wasm/busytex.wasm', { method: 'POST' })).status).toBe(405)
  } finally {
    await preview?.stop()
    await new Promise<void>(yes => upstream.close(() => yes()))
    await rm(directory, { recursive: true, force: true })
  }
})
