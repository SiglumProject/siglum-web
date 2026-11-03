import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const contents = new Map<string, string>()
mock.module('../src/services/FileReaderService', () => ({
  default: { readFile: async (path: string) => contents.get(path) ?? null }
}))
mock.module('../src/services/GitService', () => ({
  default: { getStatus: () => ({ isConnected: false }), readFile: async () => { throw new Error('No Git repository connected') } }
}))
const { default: store } = await import('../src/services/ProjectStore')
const { default: searcher } = await import('../src/services/ProjectSearcher')
const file = (path: string) => ({ id: path, path, name: path.split('/').pop()!, type: 'file' as const })
beforeEach(() => { contents.clear(); store.setFiles([]); searcher.clearCache() })
afterAll(() => (searcher as any).searchWorker?.terminate())

describe('local project search', () => {
  test('finds Chris in document contents without Git', async () => {
    const path = '/project/src/notes.tex'
    contents.set(path, 'Introduction\nChris reviewed the draft.\nConclusion')
    store.setFiles([file(path)])
    const results = await searcher.search('chris')
    expect(results).toHaveLength(1)
    expect(results[0].file.path).toBe(path)
    expect(results[0].lineNumber).toBe(2)
    expect(results[0].snippet).toContain('Chris')
  })
  test('finds newly created files without waiting for cache expiry', async () => {
    store.setFiles([file('/project/src/old.tex')])
    await searcher.search('new', {searchContent: false})
    store.setFiles([file('/project/src/old.tex'), file('/project/src/new.tex')])
    expect(await searcher.search('new', {searchContent: false})).toHaveLength(1)
  })
  test('shows project files for an empty query', async () => {
    store.setFiles([file('/project/src/notes.tex')])
    expect(await searcher.search('', {maxResults: 8})).toHaveLength(1)
  })
  test('reflects saved content edits and removals', async () => {
    const path = '/project/src/notes.tex'
    contents.set(path, 'Chris')
    store.setFiles([file(path)])
    expect(await searcher.search('chris')).toHaveLength(1)
    contents.set(path, 'Alice')
    store.setFiles([file(path)])
    expect(await searcher.search('chris')).toHaveLength(0)
    expect(await searcher.search('alice')).toHaveLength(1)
    store.setFiles([])
    expect(await searcher.search('alice')).toHaveLength(0)
  })
  test('trims whitespace and respects case sensitivity', async () => {
    const path = '/project/src/notes.tex'
    contents.set(path, 'Chris')
    store.setFiles([file(path)])
    expect(await searcher.search(' chris ')).toHaveLength(1)
    expect(await searcher.search('chris', {caseSensitive: true})).toHaveLength(0)
    expect(await searcher.search('Chris', {caseSensitive: true})).toHaveLength(1)
  })
})
