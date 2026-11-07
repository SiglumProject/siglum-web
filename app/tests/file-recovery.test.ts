import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'

const browser = new Window({ url: 'http://localhost/?fastPreview' })
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, HTMLElement: browser.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const disk = new Map<string, string>()
let readFailure: Error | null = null
mock.module('@siglum/filesystem', () => ({ fileSystem: {
  isMounted: () => true,
  readFile: async (path: string) => {
    if (readFailure) throw readFailure
    if (!disk.has(path)) throw new Error(`ENOENT: no such file: ${path}`)
    return disk.get(path)!
  },
  writeFile: async (path: string, content: string) => { disk.set(path, content) },
  exists: async (path: string) => disk.has(path),
  getBackendType: () => 'opfs',
} }))
mock.module('../src/services/FileSystemWatcher', () => ({ fileSystemWatcher: {
  initialize: async () => {}, refresh: async () => {},
  subscribe: (fn: (tree: unknown) => void) => { fn({ path: '/project/src', children: [] }); return () => {} },
  getProjectRoot: () => '/project/src', getFilesByExtension: () => [],
} }))
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { fileManager } = await import('../src/services/FileManager')
const { useFileManager } = await import('../src/hooks/useFileManager')
const missing = '/project/src/missing-test.tex'
const kept = '/project/src/kept.tex'
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
beforeEach(() => {
  browser.localStorage.clear()
  browser.history.replaceState(null, '', '/?fastPreview')
  disk.clear()
  readFailure = null
  const state = fileManager as any
  state.openFiles.clear()
  state.currentPath = null
  state.recentPaths = []
  state.initialized = false
  state.initPromise = null
  state.listeners.clear()
})
afterEach(cleanup)

describe('failed document restore', () => {
  test('retains a failed selection until explicitly dismissed, then stays dismissed on reload', async () => {
    disk.set(kept, 'SAVED CONTENT')
    browser.localStorage.setItem('siglum_current_file', missing)
    browser.localStorage.setItem('siglum_entered_editor', '1')
    browser.localStorage.setItem('siglum_recent_files', JSON.stringify([missing, kept]))
    browser.history.replaceState(null, '', `/?fastPreview&file=${encodeURIComponent(missing)}`)
    const hook = renderHook(useFileManager)
    await act(tick)
    expect(hook.result.current.failedRestorePath).toBe(missing)
    expect(browser.localStorage.getItem('siglum_current_file')).toBe(missing)
    await act(async () => hook.result.current.dismissFailedRestore())
    expect(hook.result.current.error).toBeNull()
    expect(browser.localStorage.getItem('siglum_current_file')).toBeNull()
    expect(browser.localStorage.getItem('siglum_entered_editor')).toBeNull()
    expect(new URL(browser.location.href).searchParams.get('file')).toBeNull()
    expect(fileManager.getRecentPaths()).toEqual([kept])
    expect(disk.get(kept)).toBe('SAVED CONTENT')
    hook.unmount()
    const reloaded = renderHook(useFileManager)
    await act(tick)
    expect(reloaded.result.current.error).toBeNull()
  })

  test('opening a saved document replaces the stale URL and restores it on the next mount', async () => {
    disk.set(kept, 'KEPT EXACTLY')
    browser.history.replaceState(null, '', `/?fastPreview&doc=${encodeURIComponent(missing)}`)
    const hook = renderHook(useFileManager)
    await act(tick)
    await act(async () => hook.result.current.openFile(kept))
    expect(hook.result.current.currentFile?.content).toBe('KEPT EXACTLY')
    expect(hook.result.current.failedRestorePath).toBeNull()
    expect(new URL(browser.location.href).searchParams.get('file')).toBe(kept)
    hook.unmount()
    const reloaded = renderHook(useFileManager)
    await act(tick)
    expect(reloaded.result.current.currentFile?.path).toBe(kept)
    expect(reloaded.result.current.error).toBeNull()
  })

  test('a temporary read failure preserves the real file and selection for retry', async () => {
    disk.set(kept, 'NOT LOST')
    browser.localStorage.setItem('siglum_current_file', kept)
    readFailure = new Error('Storage temporarily unavailable')
    const hook = renderHook(useFileManager)
    await act(tick)
    expect(hook.result.current.error).toContain('Could not reopen')
    expect(browser.localStorage.getItem('siglum_current_file')).toBe(kept)
    expect(disk.get(kept)).toBe('NOT LOST')
    hook.unmount()
    readFailure = null
    const retried = renderHook(useFileManager)
    await act(tick)
    expect(retried.result.current.currentFile?.content).toBe('NOT LOST')
  })

  test('dismissing an old restore does not clear a newer selection', () => {
    browser.localStorage.setItem('siglum_current_file', kept)
    browser.history.replaceState(null, '', `/?file=${encodeURIComponent(kept)}`)
    fileManager.forgetSavedSelection(missing)
    expect(browser.localStorage.getItem('siglum_current_file')).toBe(kept)
    expect(new URL(browser.location.href).searchParams.get('file')).toBe(kept)
  })
})
