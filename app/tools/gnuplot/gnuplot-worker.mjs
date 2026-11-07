import createGnuplot from './assets/gnuplot.js'
const MAX_BYTES = 16 * 1024 * 1024
const MAX_FILES = 128
const decoder = new TextDecoder()

self.onmessage = async ({ data: { args, transport } }) => {
  try {
    if (!Array.isArray(args) || args.length > 128 || args.some(x => typeof x !== 'string' || /[\0\r\n]/.test(x))) throw Error('Invalid Gnuplot arguments')
    const header = new Int32Array(transport, 0, 8), area = new Uint8Array(transport, 32)
    let readBytes = 0
    const read = path => {
      Atomics.store(header, 0, 0)
      self.postMessage({ type: 'read', path })
      let result, offset = 0
      for (;;) {
        if (Atomics.wait(header, 0, 0, 40000) === 'timed-out') throw Error('Gnuplot input timed out')
        const state = Atomics.load(header, 0), length = Atomics.load(header, 1), total = Atomics.load(header, 2)
        if (state === -1) throw Error('Input unavailable')
        if (![1, 2].includes(state) || total < 0 || total > MAX_BYTES || length < 0 || length > area.length || offset + length > total) throw Error('Invalid Gnuplot input packet')
        if (!result) { readBytes += total; if (readBytes > MAX_BYTES) throw Error('Gnuplot input limit'); result = new Uint8Array(total) }
        if (result.byteLength !== total) throw Error('Gnuplot input size changed')
        result.set(area.subarray(0, length), offset); offset += length
        Atomics.store(header, 0, 0)
        if (state === 2) { if (offset !== total) throw Error('Truncated Gnuplot input'); return result }
        self.postMessage({ type: 'next' })
      }
    }
    const log = []; let deniedSystemCalls = 0
    const compiled = await WebAssembly.compile(await (await fetch(new URL('./assets/gnuplot.wasm', import.meta.url))).arrayBuffer())
    const module = await createGnuplot({ noInitialRun: true, noFSInit: true,
      print: value => { if (log.length < 128) log.push(String(value).slice(0, 1000)) },
      printErr: value => { if (log.length < 128) log.push(String(value).slice(0, 1000)) },
      instantiateWasm(imports, receive) {
        // A plot script can request system(), but receives no nested process capability.
        for (const values of Object.values(imports)) for (const name of ['system', '_emscripten_system', 'emscripten_system']) if (Object.hasOwn(values, name)) values[name] = () => { deniedSystemCalls++; return -1 }
        const instance = new WebAssembly.Instance(compiled, imports)
        receive(instance, compiled)
        return instance.exports
      },
    })
    const FS = module.FS
    FS.init(() => null, null, null)
    FS.mkdir('/work'); FS.chdir('/work')
    const originalOpen = FS.open.bind(FS), originalStat = FS.stat.bind(FS)
    const inputs = new Set(), misses = new Set(), outputs = new Set()
    const relative = path => {
      if (typeof path !== 'string') return null
      const parts = []
      for (const part of (path.startsWith('/') ? path : FS.cwd() + '/' + path).split('/')) {
        if (!part || part === '.') continue
        if (part === '..') parts.pop()
        else parts.push(part)
      }
      return parts[0] === 'work' && parts.length > 1 ? parts.slice(1).join('/') : null
    }
    const materialize = path => {
      const name = relative(path)
      if (!name || misses.has(name)) return false
      try {
        const bytes = read(name), parent = name.split('/').slice(0, -1).join('/')
        if (parent) FS.mkdirTree('/work/' + parent)
        // Bypass the observer while installing read-only supplied project bytes.
        const open = FS.open; FS.open = originalOpen
        try { FS.writeFile('/work/' + name, bytes) } finally { FS.open = open }
        inputs.add(name)
        return true
      } catch { misses.add(name); return false }
    }
    FS.open = (path, flags, ...rest) => {
      const writing = typeof flags === 'string' ? /[wa+]/.test(flags) : !!(flags & (3 | 64 | 512))
      const name = relative(path)
      if (writing && (inputs.has(name) || (!name && !String(path).startsWith('/tmp/')))) throw new FS.ErrnoError(2)
      let stream
      try { stream = originalOpen(path, flags, ...rest) }
      catch (error) { if (writing || error.errno !== 44 || !materialize(path)) throw error; stream = originalOpen(path, flags, ...rest) }
      if (writing && name) { outputs.add(name); if (outputs.size > MAX_FILES) throw Error('Too many Gnuplot outputs') }
      return stream
    }
    FS.stat = (path, ...rest) => {
      try { return originalStat(path, ...rest) }
      catch (error) { if (error.errno !== 44 || !materialize(path)) throw error; return originalStat(path, ...rest) }
    }
    const originalWrite = FS.write.bind(FS); let outputBytes = 0
    FS.write = (stream, buffer, offset, length, ...rest) => {
      if (outputs.has(relative(FS.getPath(stream.node)))) {
        if (length > MAX_BYTES - outputBytes) throw Error('Gnuplot output limit')
        outputBytes += length
      }
      return originalWrite(stream, buffer, offset, length, ...rest)
    }
    let exitCode
    try { exitCode = module.callMain(args) ?? 0 }
    catch (error) { if (Number.isInteger(error.status)) exitCode = error.status; else throw error }
    const files = []; let bytes = 0
    for (const path of outputs) {
      let value
      try { value = FS.readFile('/work/' + path) } catch { continue }
      bytes += value.byteLength; if (bytes > MAX_BYTES) throw Error('Gnuplot output limit')
      files.push({ path, bytes: value })
    }
    self.postMessage({ type: 'result', result: { exitCode, files, log, heapBytes: module.HEAPU8.byteLength, deniedSystemCalls: deniedSystemCalls + (module._siglum_gnuplot_denied_system_calls?.() || 0) } }, files.map(x => x.bytes.buffer))
  } catch (error) { self.postMessage({ type: 'error', error: String(error.message || error) }) }
}
