import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

/** Explicit globals for the classic worker, independent of bundler export naming. */
export async function bundleParagraphWorker(modulePath: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'siglum-paragraph-bundle-'))
  try {
    const entry = resolve(directory, 'entry.js')
    await writeFile(entry, 'import { FONT_NAMES, createParagraphRuntime } from ' + JSON.stringify(resolve(modulePath)) + ';\nObject.assign(globalThis, { FONT_NAMES, createParagraphRuntime });\n')
    const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife', write: false })
    if (!result.success) throw new AggregateError(result.logs, 'Could not bundle the paragraph laboratory')
    return await result.outputs[0].text()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
