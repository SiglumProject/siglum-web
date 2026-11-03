import { describe, expect, test } from 'bun:test'
import { DocumentSaveQueue } from '../src/services/DocumentSaveQueue'

describe('document save safety', () => {
  test('keeps edits attached to their paths across tab switches', async () => {
    const disk = new Map<string, string>()
    const queue = new DocumentSaveQueue(async (path, text) => { disk.set(path, text) })
    queue.schedule('/project/a.tex', 'Chris')
    queue.schedule('/project/b.tex', 'Different document')
    queue.schedule('/project/a.tex', 'Chris revised')
    await queue.flushOrThrow()
    expect(disk.get('/project/a.tex')).toBe('Chris revised')
    expect(disk.get('/project/b.tex')).toBe('Different document')
  })
  test('serializes writes and retains edits made during an in-flight save', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const writes: string[] = []
    const queue = new DocumentSaveQueue(async (_, text) => {
      if (text === 'first') await gate
      writes.push(text)
    })
    queue.schedule('a.tex', 'first')
    const flush = queue.flush()
    queue.schedule('a.tex', 'latest')
    release()
    await flush
    expect(writes).toEqual(['first', 'latest'])
  })
  test('preserves failed drafts, blocks destructive mutations, and supports retry', async () => {
    let failing = true
    let saved = ''
    const queue = new DocumentSaveQueue(async (_, text) => {
      if (failing) throw new Error('Disk full')
      saved = text
    })
    let status: any
    queue.subscribe(value => { status = value })
    queue.schedule('a.tex', 'unsaved text')
    await expect(queue.flushOrThrow()).rejects.toThrow('Disk full')
    expect(status.hasUnsavedChanges).toBe(true)
    failing = false
    await queue.flushOrThrow()
    expect(saved).toBe('unsaved text')
    expect(status.hasUnsavedChanges).toBe(false)
  })
})
