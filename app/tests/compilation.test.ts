import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
const jobs: { source: string; options: any; resolve: (result: any) => void }[] = []
let status = 'idle'
const statusListeners = new Set<(status: string) => void>()
const emitStatus = (next: string) => { status = next; for (const listener of statusListeners) listener(next) }
mock.module('../src/services/CompilerService', () => ({ default: {
  initialize: async () => {}, getStatus: () => status, isReady: () => status !== 'initializing',
  onStatus: (listener: (status: string) => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener) } }, onLog: () => () => {},
  generateFormat: async () => {}, clearCache: () => {}, setAutoUnload: () => {},
  compile: (source: string, options: any) => new Promise(resolve => jobs.push({ source, options, resolve })),
} }))
mock.module('../src/services/SyncTexService', () => ({ default: { update: () => {}, clear: () => {} } }))
mock.module('../src/services/FileReaderService', () => ({ default: { readFile: async () => null, readBinary: async () => null } }))
const { renderHook, act, cleanup } = await import('@testing-library/react')
mock.module('../src/services/CheckpointCompiler', () => ({ checkpointPreviewEnabled: false, checkpointRuntime: undefined }))
const { useCompilation } = await import('../src/hooks/useCompilation')
afterEach(() => { cleanup(); jobs.length = 0; status = 'idle'; statusListeners.clear() })
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

test('coalesces Cmd+S queued behind an identical active auto compilation', async () => {
  const hook = renderHook(() => useCompilation('unchanged draft', true, '/project/manual.tex'))
  await act(tick)
  expect(jobs).toHaveLength(1)
  await act(async () => { await hook.result.current.compile(); await hook.result.current.compile() })
  await act(async () => { jobs[0].resolve(result(7)); await tick(); await tick() })
  expect(jobs).toHaveLength(1)
  expect(hook.result.current.pdfData).toEqual(new Uint8Array([7]))
})

test('a queued save still compiles newer source after the active job finishes', async () => {
  const hook = renderHook(({ source }) => useCompilation(source, true, '/project/newer.tex'), {
    initialProps: { source: 'before edit' },
  })
  await act(tick)
  hook.rerender({ source: 'after edit' })
  await act(async () => { await hook.result.current.compile() })
  await act(async () => { jobs[0].resolve(result(8)); await tick() })
  expect(jobs).toHaveLength(2)
  expect(jobs[1].source).toBe('after edit')
  await act(async () => { jobs[1].resolve(result(9)); await tick() })
  expect(hook.result.current.pdfData).toEqual(new Uint8Array([9]))
})


test('worker replacement readiness does not recompile an already published document', async () => {
  renderHook(() => useCompilation('unchanged after success', true, '/project/swap.tex'))
  await act(tick)
  await act(async () => { jobs[0].resolve(result(10)); await tick() })
  expect(jobs).toHaveLength(1)
  await act(async () => { emitStatus('initializing'); await tick(); emitStatus('idle'); await tick() })
  expect(jobs).toHaveLength(1)
})

test('a queued first load runs once when the compiler becomes ready', async () => {
  status = 'initializing'
  renderHook(() => useCompilation('first load', true, '/project/first.tex'))
  await act(tick)
  expect(jobs).toHaveLength(0)
  await act(async () => { emitStatus('initializing'); await tick(); emitStatus('idle'); await tick() })
  expect(jobs).toHaveLength(1)
  await act(async () => { jobs[0].resolve(result(11)); await tick() })
  expect(jobs).toHaveLength(1)
})

test('manual compilation queued during initialization works with auto compile disabled', async () => {
  const hook = renderHook(() => useCompilation('manual request', true, '/project/manual-init.tex'))
  await act(tick)
  await act(async () => { jobs[0].resolve(result(12)); await tick() })
  await act(async () => { hook.result.current.setCompilerSettings({ ...hook.result.current.compilerSettings, autoCompile: false }); await tick(); emitStatus('initializing'); await tick() })
  await act(async () => { await hook.result.current.compile(); await tick(); emitStatus('idle'); await tick() })
  expect(jobs).toHaveLength(2)
  await act(async () => { jobs[1].resolve(result(13)); await tick() })
})
