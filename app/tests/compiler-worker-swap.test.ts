import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

type StubConfig = { wasmUrl: string }
type InitGate = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
const instances: StubCompiler[] = []
const events: string[] = []
let nextInit: InitGate | undefined
let nextCompile: { started: InitGate; release: InitGate } | undefined
let formatWritten = false
let sidecarWritten = false
type MemoryStats = { instanceId?: number; wasmHeapBytes?: number; workerId?: number; wasmAllocatedBytes?: number; wasmAllocationComplete?: boolean }
let nextMemoryStats: MemoryStats | undefined

function deferred(): InitGate {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function holdReplacement() { return nextInit = deferred() }

class StubCompiler {
  id = instances.length + 1
  formatGenerationPromise: Promise<void> | null = null
  cancelFormat?: () => void
  constructor(readonly config: StubConfig) { instances.push(this) }
  init() {
    events.push(`init:${this.id}`)
    const gate = nextInit
    nextInit = undefined
    return gate?.promise ?? Promise.resolve()
  }
  async compile(source: string) {
    events.push(`compile:${this.id}`)
    const held = nextCompile
    nextCompile = undefined
    if (held) {
      held.started.resolve()
      await held.release.promise
    }
    if (source.includes('read sidecar') && formatWritten) {
      events.push(`read:${this.id}:${sidecarWritten ? 'complete' : 'incomplete'}`)
      if (!sidecarWritten) return { success: false, error: 'Incomplete cached format' }
    }
    const memory = nextMemoryStats ?? (source.includes('large') ? { wasmHeapBytes: 400 * 1024 * 1024 } : undefined)
    nextMemoryStats = undefined
    const stats = { compileTimeMs: 12, memory }
    return source.includes('broken')
      ? { success: false, error: 'Invalid LaTeX', log: 'Source error', stats }
      : { success: true, pdf: new Uint8Array([this.id]), syncTexData: 'sync', stats }
  }
  publishFormat(sidecar: InitGate) {
    formatWritten = true
    this.formatGenerationPromise = sidecar.promise.then(() => {
      sidecarWritten = true
      events.push(`sidecar:${this.id}`)
    })
  }
  startFormatOnWorker() {
    const pending = deferred()
    this.formatGenerationPromise = pending.promise
    void pending.promise.catch(() => {})
    this.cancelFormat = () => {
      events.push(`cancel-format:${this.id}`)
      pending.reject(new Error('Worker terminated'))
    }
  }
  clearBundleMemoryCache() { events.push(`clear:${this.id}`) }
  unload() {
    events.push(`unload:${this.id}`)
    this.cancelFormat?.()
  }
  terminate() { this.unload() }
}

mock.module('@siglum/engine', () => ({ SiglumCompiler: StubCompiler, detectEngine: () => 'pdflatex' }))
mock.module('@siglum/engine/worker?url', () => ({ default: '/worker.js' }))
if (typeof document === 'undefined') Object.assign(globalThis, {
  document: { hidden: false, addEventListener: () => {} },
  window: { location: { origin: 'http://127.0.0.1', search: '' } },
})

mock.module('../src/services/CheckpointCompiler', () => ({ checkpointPreviewEnabled: false, checkpointRuntime: undefined }))

const { default: singleton } = await import('../src/services/CompilerService.ts?worker-swap-regression')
const CompilerService = singleton.constructor as new () => typeof singleton
let compiler: typeof singleton
const source = (text: string) => `\\documentclass{article}\n\\begin{document}\n${text}\n\\end{document}`
const tick = () => new Promise<void>(done => queueMicrotask(done))
const drain = () => new Promise<void>(done => setTimeout(done, 0))

beforeEach(() => {
  compiler = new CompilerService()
  compiler.setAutoUnload(false)
})

afterEach(() => {
  nextInit = undefined
  nextCompile = undefined
  nextMemoryStats = undefined
  formatWritten = false
  sidecarWritten = false
  compiler.unload()
  instances.length = 0
  events.length = 0
})

test('swaps after publishing the threshold PDF and queues a later revision on the replacement', async () => {
  await compiler.compile(source('large first revision'))
  expect(instances).toHaveLength(1)
  expect(events).not.toContain('unload:1')

  const gate = holdReplacement()
  let sawCompile = false
  let later: ReturnType<typeof compiler.compile> | undefined
  const unsubscribe = compiler.onStatus(status => {
    if (status === 'compiling') sawCompile = true
    if (status === 'success' && sawCompile && !later) later = compiler.compile(source('next edit'))
  })

  try {
    const threshold = await compiler.compile(source('large threshold revision'))
    expect(threshold).toMatchObject({ success: true, pdf: new Uint8Array([1]), syncTexData: 'sync', timeMs: 12 })
    expect(compiler.getStatus()).toBe('success')
    const initialized = compiler.initialize()
    await tick()
    expect(events).toEqual(['init:1', 'compile:1', 'clear:1', 'compile:1', 'clear:1', 'init:2', 'unload:1'])
    expect(instances[1].config.wasmUrl).toBe(instances[0].config.wasmUrl)
    expect(instances[0].config.wasmUrl).toEndWith(`/${process.env.EXPECTED_RUNTIME ?? 'busytex'}.wasm`)
    gate.resolve()
    await initialized
    expect(await later).toMatchObject({ success: true, pdf: new Uint8Array([2]) })
    expect(events.slice(-2)).toEqual(['compile:2', 'clear:2'])
  } finally {
    unsubscribe()
    gate.resolve()
    await later
  }
})

test('rotates after the fifth compile without memory stats, even when that result is a source error', async () => {
  for (let attempt = 1; attempt <= 4; attempt++) await compiler.compile(source('small compile'))
  expect(instances).toHaveLength(1)
  const failed = await compiler.compile(source('broken compile'))
  expect(failed).toMatchObject({ success: false, error: 'Invalid LaTeX', log: 'Source error', timeMs: 12 })
  expect(compiler.getStatus()).toBe('error')
  await tick()
  expect(events.filter(event => event === 'unload:1')).toHaveLength(1)
  expect(await compiler.compile(source('fixed edit'))).toMatchObject({ success: true, pdf: new Uint8Array([2]) })
  expect(instances).toHaveLength(2)
})

test('discards a replacement that is still initializing when the service unloads', async () => {
  await compiler.compile(source('large first revision'))
  const gate = holdReplacement()
  try {
    expect(await compiler.compile(source('large threshold revision'))).toMatchObject({ success: true })
    expect(events).toContain('init:2')
    const prewarm = compiler.initialize()
    compiler.unload()
    gate.resolve()
    await prewarm
    await drain()
    expect(compiler.isReady()).toBe(false)
    expect(events.filter(event => event === 'unload:2')).toHaveLength(1)
    expect(await compiler.compile(source('next revision'))).toMatchObject({ success: true, pdf: new Uint8Array([3]) })
  } finally {
    gate.resolve()
  }
})

test('preserves the threshold PDF and recovers the next compile if replacement init fails', async () => {
  await compiler.compile(source('large first revision'))
  const gate = holdReplacement()
  try {
    const threshold = await compiler.compile(source('large threshold revision'))
    expect(threshold).toMatchObject({ success: true, pdf: new Uint8Array([1]), syncTexData: 'sync' })
    expect(events).toContain('init:2')
    gate.reject(new Error('Worker could not initialize'))
    expect(await compiler.compile(source('next revision'))).toMatchObject({ success: true, pdf: new Uint8Array([3]) })
    expect(events.filter(event => event === 'unload:2')).toHaveLength(1)
  } finally {
    gate.resolve()
  }
})

for (const replacementFails of [false, true]) {
  test(`waits for a retiring format sidecar when replacement ${replacementFails ? 'fails' : 'succeeds'}`, async () => {
    await compiler.compile(source('large first revision'))
    const held = nextCompile = { started: deferred(), release: deferred() }
    const sidecar = deferred()
    const replacement = replacementFails ? holdReplacement() : undefined
    const threshold = compiler.compile(source('large threshold revision'))
    let next: ReturnType<typeof compiler.compile> | undefined
    try {
      // The engine passed its initial format wait before the competing job
      // replied and wrote .fmt. Its .side.json write is still pending.
      await held.started.promise
      instances[0].publishFormat(sidecar)
      held.release.resolve()
      expect(await threshold).toMatchObject({ success: true, pdf: new Uint8Array([1]) })
      expect(events).toContain('unload:1')
      expect(events).toContain('init:2')
      next = compiler.compile(source('read sidecar'))
      if (replacementFails && events.includes('init:2')) replacement?.reject(new Error('Replacement failed'))
      await drain()
      expect(events.filter(event => event.startsWith('read:'))).toEqual([])
      sidecar.resolve()
      const id = replacementFails ? 3 : 2
      expect(await next).toMatchObject({ success: true, pdf: new Uint8Array([id]) })
      expect(events.filter(event => event.startsWith('read:'))).toEqual([`read:${id}:complete`])
    } finally {
      held.release.resolve()
      sidecar.resolve()
      replacement?.resolve()
      await threshold
      await next
    }
  })
}

test('unloads a still-running worker format before waiting for its cancellation', async () => {
  await compiler.compile(source('large first revision'))
  const held = nextCompile = { started: deferred(), release: deferred() }
  const threshold = compiler.compile(source('large threshold revision'))
  await held.started.promise
  instances[0].startFormatOnWorker()
  held.release.resolve()
  expect(await threshold).toMatchObject({ success: true, pdf: new Uint8Array([1]) })
  expect(await compiler.compile(source('next revision'))).toMatchObject({ success: true, pdf: new Uint8Array([2]) })
  expect(events).toContain('cancel-format:1')
})

function reportAllocation(totalMiB: number, workerId: number, instanceId: number) {
  nextMemoryStats = { workerId, instanceId, wasmHeapBytes: 64 * 1024 * 1024,
    wasmAllocatedBytes: totalMiB * 1024 * 1024, wasmAllocationComplete: true }
}

test('includes intermediate native passes in the retirement budget while preserving the PDF', async () => {
  reportAllocation(700, 7, 2)
  await compiler.compile(source('first multi-pass build'))
  expect(instances).toHaveLength(1)
  const gate = holdReplacement()
  try {
    reportAllocation(850, 7, 3)
    expect(await compiler.compile(source('later build'))).toMatchObject({ success: true, pdf: new Uint8Array([1]) })
    expect(events).toContain('unload:1')
    gate.resolve()
    await compiler.initialize()
  } finally { gate.resolve() }
})

test('starts a new allocation epoch when the SDK replaces its worker', async () => {
  reportAllocation(700, 7, 2)
  await compiler.compile(source('old worker build'))
  reportAllocation(200, 8, 1)
  await compiler.compile(source('new worker build'))
  expect(events).not.toContain('unload:1')
  const gate = holdReplacement()
  try {
    reportAllocation(850, 8, 3)
    await compiler.compile(source('new worker threshold'))
    expect(events).toContain('unload:1')
    gate.resolve()
    await compiler.initialize()
  } finally { gate.resolve() }
})

test('a decreasing report cannot lower the budget and falls back conservatively', async () => {
  reportAllocation(700, 7, 2)
  await compiler.compile(source('first build'))
  reportAllocation(695, 7, 3)
  await compiler.compile(source('invalid decreasing report'))
  expect(events).not.toContain('unload:1')
  const gate = holdReplacement()
  try {
    reportAllocation(690, 7, 4)
    await compiler.compile(source('another decreasing report'))
    expect(events).toContain('unload:1')
    gate.resolve()
    await compiler.initialize()
  } finally { gate.resolve() }
})
