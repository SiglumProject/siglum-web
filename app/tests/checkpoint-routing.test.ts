import { test, expect, mock, afterEach } from 'bun:test'
const instances: Compiler[] = []
const calls: { source: string; options: any }[] = []
const formats: { source: string; options: any }[] = []
const nativeRuntime = { apiUrl: '/native-api.mjs', jsUrl: '/pdftex.js', wasmUrl: '/pdftex.wasm', identity: 'test' }
class Compiler {
  unloaded = false
  constructor(readonly options: any) { instances.push(this) }
  async init() {}
  async compile(source: string, options: any) {
    calls.push({ source, options })
    const stats = { compileTimeMs: 3, preamblePreparationMs: source.includes('preparation') ? 7 : 0, checkpoint: { mode: 'reuse', reason: 'safe', snapshotBytes: 1024 },
      memory: { instanceId: source.includes('new instance') ? 2 : 1, wasmHeapBytes: 400 * 1024 * 1024 } }
    return source.includes('invalid') ? { success: false, error: 'Undefined control sequence', log: 'source error', stats }
      : { success: true, pdf: new TextEncoder().encode('%PDF-test'), stats }
  }
  async generateFormat(source: string, options: any) { formats.push({ source, options }); return new Uint8Array([1]) }
  clearBundleMemoryCache() {}
  unload() { this.unloaded = true }
  terminate() { this.unload() }
}
mock.module('../src/services/CheckpointCompiler', () => ({ checkpointPreviewEnabled: true, checkpointRuntime: nativeRuntime }))
mock.module('@siglum/engine', () => ({ SiglumCompiler: Compiler, detectEngine: () => 'pdflatex' }))
mock.module('@siglum/engine/worker?url', () => ({ default: '/worker.js' }))
Object.assign(globalThis, { window: { location: { origin: 'http://127.0.0.1' } }, document: { hidden: false, addEventListener() {} } })
const { default: singleton } = await import('../src/services/CompilerService.ts?single-native-worker')
const Service = singleton.constructor as new () => typeof singleton
let service: typeof singleton
function fresh() { service = new Service(); service.setAutoUnload(false); return service }
afterEach(() => { service?.unload(); instances.length = 0; calls.length = 0; formats.length = 0 })
test('manual compilation uses the existing SDK with native configuration and no forced full build', async () => {
  fresh(); await service.initialize()
  const result = await service.compile('document', { projectId: 'project', focus: { path: 'main.tex', line: 20 } })
  expect(instances).toHaveLength(1)
  expect(instances[0].options.checkpointRuntime).toEqual(nativeRuntime)
  expect(calls[0].options).toMatchObject({ projectId: 'project', checkpointProject: 'project', checkpointFocus: { path: 'main.tex', line: 20 } })
  expect(calls[0].options.forceFull).not.toBe(true)
  expect(result.checkpoint?.mode).toBe('reuse')
  expect(await service.generateFormat('document')).toBe(true)
  expect(formats).toEqual([{ source: 'document', options: { engine: 'pdflatex' } }])
  expect(instances).toHaveLength(1)
})
test('reusing one native instance does not trigger periodic worker rotation', async () => {
  fresh()
  for (let i = 0; i < 12; i++) await service.compile('edit ' + i)
  expect(instances).toHaveLength(1)
  expect(instances[0].unloaded).toBe(false)
})
test('new instances still count toward the memory guard', async () => {
  fresh(); await service.compile('first'); await service.compile('new instance'); await service.initialize()
  expect(instances).toHaveLength(2)
  expect(instances[0].unloaded).toBe(true)
  expect(instances[1].options.checkpointRuntime).toEqual(nativeRuntime)
})
test('engine selection and source errors remain in the same SDK pipeline', async () => {
  fresh(); await service.compile('native fonts', { engine: 'xelatex' })
  expect(calls[0].options.engine).toBe('xelatex')
  const result = await service.compile('invalid document')
  expect(result.success).toBe(false)
  expect(result.log).toBe('source error')
  expect(instances).toHaveLength(1)
})

test('the reported compile time includes upfront preamble preparation', async () => {
  fresh()
  const result = await service.compile('preparation')
  expect(result.timeMs).toBe(10)
})

test('disabling the preamble cache reaches the SDK', async () => {
  fresh()
  await service.compile('document', { cachePreamble: false })
  expect(calls[0].options.usePreambleCache).toBe(false)
})
