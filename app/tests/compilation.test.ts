import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
const jobs: { source: string; options: any; resolve: (result: any) => void }[] = []
mock.module('../src/services/CompilerService', () => ({ default: {
  initialize: async () => {}, getStatus: () => 'idle', onStatus: () => () => {}, onLog: () => () => {},
  generateFormat: async () => {}, clearCache: () => {}, setAutoUnload: () => {},
  compile: (source: string, options: any) => new Promise(resolve => jobs.push({ source, options, resolve })),
} }))
mock.module('../src/services/SyncTexService', () => ({ default: { update: () => {}, clear: () => {} } }))
mock.module('../src/services/FileReaderService', () => ({ default: { readFile: async () => null, readBinary: async () => null } }))
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useCompilation } = await import('../src/hooks/useCompilation')
afterEach(() => { cleanup(); jobs.length = 0 })
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const result = (value: number) => ({ success: true, pdf: new Uint8Array([value]), timeMs: 12 })

describe('compilation document isolation', () => {
  test('a late result cannot populate another document preview or cache', async () => {
    const hook = renderHook(({ source, path }) => useCompilation(source, true, path), {
      initialProps: { source: 'document A', path: '/project/a.tex' },
    })
    await act(tick)
    expect(jobs).toHaveLength(1)
    hook.rerender({ source: 'document B', path: '/project/b.tex' })
    await act(async () => { jobs[0].resolve(result(1)); await tick() })
    expect(hook.result.current.pdfData).toBeNull()
    expect(jobs).toHaveLength(2)
    expect(jobs[0].options.mainFile).toBe('a.tex')
    expect(jobs[1].source).toBe('document B')
    await act(async () => { jobs[1].resolve(result(2)); await tick() })
    expect(hook.result.current.pdfData).toEqual(new Uint8Array([2]))
    hook.rerender({ source: 'document A', path: '/project/a.tex' })
    expect(hook.result.current.pdfData).toEqual(new Uint8Array([1]))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
    expect(jobs).toHaveLength(3)
    await act(async () => { jobs[2].resolve(result(1)); await tick() })
  })
  test('typing during an active compilation queues the newest source', async () => {
    const hook = renderHook(({ source }) => useCompilation(source, true, '/project/typing.tex'), {
      initialProps: { source: 'first draft' },
    })
    await act(tick)
    hook.rerender({ source: 'second draft' })
    hook.rerender({ source: 'latest draft' })
    await act(async () => { jobs[0].resolve(result(3)); await tick() })
    expect(jobs).toHaveLength(2)
    expect(jobs[1].source).toBe('latest draft')
    await act(async () => { jobs[1].resolve(result(4)); await tick() })
    expect(hook.result.current.pdfData).toEqual(new Uint8Array([4]))
  })
})


test('a runtime failure without a TeX log produces an actionable diagnostic', async () => {
  const hook = renderHook(() => useCompilation('source', true, '/project/failure.tex'))
  await act(tick)
  await act(async () => { jobs[0].resolve({ success: false, error: 'Worker could not initialize' }); await tick() })
  expect(hook.result.current.diagnostics).toEqual([{ type: 'error', message: 'Worker could not initialize' }])
})
