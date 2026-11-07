/** Prepare the separate, opt-in plain-paragraph laboratory. No downloads. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { FONT_NAMES } from '../src/services/paragraph.mjs'
import { bundleParagraphWorker } from './bundleParagraphWorker'

const runtime = process.argv[2]
if (!runtime) throw new Error('Usage: bun scripts/prepareParagraphRuntime.ts MATCHED_RUNTIME_DIRECTORY')
const source = resolve(runtime), app = resolve(import.meta.dir, '..')
const target = resolve(app, 'public/paragraph-runtime')
const manifest = JSON.parse(await readFile(resolve(source, 'file-manifest.json'), 'utf8')) as Record<string, { bundle: string; start: number; end: number }>
const bundles = new Map<string, Buffer>()
const names = [...FONT_NAMES.flatMap(name => [name + '.tfm', name + '.pfb']), 'hyphen.tex']
const prepared: Record<string, Buffer> = {}
for (const name of names) {
  const candidates = Object.entries(manifest).filter(([path]) => basename(path) === name)
  if (!candidates.length) throw new Error('Missing paragraph resource: ' + name)
  for (const [, info] of candidates) {
    let data = bundles.get(info.bundle)
    if (!data) { data = await readFile(resolve(source, info.bundle + '.raw')); bundles.set(info.bundle, data) }
    if (!Number.isSafeInteger(info.start) || !Number.isSafeInteger(info.end) || info.start < 0 || info.end <= info.start || info.end > data.length) throw new Error('Invalid paragraph resource range')
    const bytes = data.subarray(info.start, info.end)
    if (prepared[name] && !prepared[name].equals(bytes)) throw new Error('Ambiguous paragraph resource: ' + name)
    prepared[name] = bytes
  }
}
await mkdir(target, { recursive: true })
prepared['paragraph.js'] = Buffer.from(await bundleParagraphWorker(resolve(app, 'src/services/paragraph.mjs')))
for (const extension of ['js', 'wasm']) prepared['pdftex.' + extension] = await readFile(resolve(source, 'checkpoint/pdftex.' + extension))
const entries: Record<string, { size: number; sha256: string }> = {}
for (const [name, bytes] of Object.entries(prepared)) {
  await writeFile(resolve(target, name), bytes)
  entries[name] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
await writeFile(resolve(target, 'prepared.json'), JSON.stringify({ sourceRelease: JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8')).releaseId, files: entries }, null, 2) + '\n')
console.log('Prepared ' + Object.keys(entries).length + ' paragraph laboratory assets. Full-compile fallback remains active.')
