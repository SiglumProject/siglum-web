const MAX_BYTES = 16 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

/** Each invocation owns its worker and heap; cancellation always releases both. */
export async function runGnuplot(request, context) {
  if (context.signal.aborted) throw Error('Gnuplot cancelled')
  const transport = new SharedArrayBuffer(CHUNK_BYTES + 32)
  const header = new Int32Array(transport, 0, 8)
  const area = new Uint8Array(transport, 32)
  const worker = new Worker(new URL('./gnuplot-worker.mjs', import.meta.url), { type: 'module' })
  let input = null
  let offset = 0
  return await new Promise((resolve, reject) => {
    let finished = false
    const stop = (error, result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      context.signal.removeEventListener('abort', abort)
      worker.terminate()
      input = null
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => stop(Error('Gnuplot cancelled'))
    const timer = setTimeout(() => stop(Error('Gnuplot timed out')), 40000)
    const send = () => {
      if (finished) return
      if (!input || Atomics.load(header, 0) !== 0) return stop(Error('Invalid Gnuplot input state'))
      const length = Math.min(area.length, input.byteLength - offset)
      area.set(input.subarray(offset, offset + length))
      Atomics.store(header, 1, length)
      Atomics.store(header, 2, input.byteLength)
      offset += length
      Atomics.store(header, 0, offset === input.byteLength ? 2 : 1)
      Atomics.notify(header, 0)
      if (offset === input.byteLength) input = null
    }
    context.signal.addEventListener('abort', abort, { once: true })
    worker.onerror = event => stop(Error(event.message || 'Gnuplot worker failed'))
    worker.onmessage = async ({ data }) => {
      if (finished) return
      if (data.type === 'read') {
        try {
          if (input) throw Error('Overlapping Gnuplot reads')
          input = await context.readFile(data.path)
          if (!(input instanceof Uint8Array) || input.byteLength > MAX_BYTES) throw Error('Gnuplot input too large')
          offset = 0
          send()
        } catch {
          input = null
          if (!finished) { Atomics.store(header, 0, -1); Atomics.notify(header, 0) }
        }
      } else if (data.type === 'next') send()
      else if (data.type === 'result') stop(null, data.result)
      else if (data.type === 'error') stop(Error(data.error))
    }
    worker.postMessage({ args: request.args, transport })
  })
}
