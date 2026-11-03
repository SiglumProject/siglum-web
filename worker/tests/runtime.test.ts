import { beforeEach, afterEach, expect, test } from 'bun:test'
import worker from '../src/index'
const realFetch = globalThis.fetch
let upstream: string[] = []
let stored: Map<string, Uint8Array>
const context = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext
beforeEach(() => {
 stored = new Map(); upstream = []
 Object.defineProperty(globalThis,'caches',{configurable:true,value:{default:{match:async()=>undefined,put:async()=>{}}}})
 globalThis.fetch = (async (url: string) => { upstream.push(String(url)); return new Response(new Uint8Array([1,2,3])) }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })
const environment = () => ({ BUNDLES: {
 head: async (key: string) => stored.has(key) ? {size:stored.get(key)!.length} : null,
 get: async (key: string, options?: {range?:{offset:number;length:number}}) => {
  const value = stored.get(key); if (!value) return null
  const range = options?.range
  const body = range ? value.slice(range.offset,range.offset+range.length) : value
  return {body:new Blob([body]).stream(),size:value.length,httpEtag:'"fixture"',json:async()=>JSON.parse(new TextDecoder().decode(value)),text:async()=>new TextDecoder().decode(value)}
 },
 put: async (key: string, data: ArrayBuffer) => { stored.set(key,new Uint8Array(data)); return {} },
} }) as unknown as Parameters<typeof worker.fetch>[1]
const request = (path: string, init?: RequestInit) => worker.fetch(new Request('https://siglum-api.example'+path,init),environment(),context)
test('immutable release files never fall back to unversioned objects or stale Brotli',async()=>{
 const release='tl2026-1234567890abcdef'
 stored.set('wasm/busytex.wasm',new Uint8Array([99]))
 stored.set(`releases/${release}/wasm/busytex.wasm.br`,new Uint8Array([88]))
 expect((await request(`/releases/${release}/wasm/busytex.wasm`)).status).toBe(404)
 stored.set(`releases/${release}/wasm/busytex.wasm`,new Uint8Array([1,2,3]))
 const response=await request(`/releases/${release}/wasm/busytex.wasm`)
 expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1,2,3])
 expect(response.headers.get('Cache-Control')).toContain('immutable')
 expect(response.headers.get('Content-Type')).toBe('application/wasm')
})
test('raw bundle ranges return exact bytes, lengths, and 416 for invalid bounds',async()=>{
 stored.set('releases/tl2026-1234567890abcdef/core.raw',new Uint8Array([0,1,2,3,4,5]))
 const path='/releases/tl2026-1234567890abcdef/bundles/core.raw'
 const response=await request(path,{headers:{Range:'bytes=2-4'}})
 expect(response.status).toBe(206)
 expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2,3,4])
 expect(response.headers.get('Content-Range')).toBe('bytes 2-4/6')
 expect(response.headers.get('Content-Length')).toBe('3')
 expect((await request(path,{headers:{Range:'bytes=9-10'}})).status).toBe(416)
 expect((await request(path,{method:'HEAD'})).headers.get('Content-Length')).toBe('6')
})
test('TeX Live default and explicit older years use separate URLs and caches',async()=>{
 await request('/api/texlive/example')
 expect(upstream.some(url=>url.endsWith('/TEXLIVE_2026'))).toBe(true)
 expect(upstream.some(url=>url.includes('/tlnet/archive/example.tar.xz'))).toBe(true)
 expect(stored.has('texlive-cache/tl2026/example.tar.xz')).toBe(true)
 upstream=[]
 await request('/api/texlive/example?tlYear=2025')
 expect(upstream.some(url=>url.includes('/2025/tlnet-final/archive/example.tar.xz'))).toBe(true)
 expect(stored.has('texlive-cache/tl2025/example.tar.xz')).toBe(true)
 expect((await request('/api/texlive/example?tlYear=1900')).status).toBe(400)
})

test('normalized package artifacts are isolated by release and API routes work on packages host',async()=>{
 const a='tl2026-aaaaaaaaaaaaaaaa', b='tl2026-bbbbbbbbbbbbbbbb'
 for (const id of [a,b]) {
  stored.set(`releases/${id}/normalized/_index.json`,new TextEncoder().encode('["example"]'))
  stored.set(`releases/${id}/normalized/example.json`,new TextEncoder().encode(JSON.stringify({name:'example',release:id,files:{}})))
 }
 for (const id of [a,b,a]) {
  const response=await worker.fetch(new Request(`https://packages.siglum.org/releases/${id}/api/fetch/example`),environment(),context)
  expect((await response.json() as {release:string}).release).toBe(id)
 }
 expect(upstream).toEqual([])
})
test('Zotero proxy forwards credentials only to Zotero, never caches private data',async()=>{
 let forwarded: RequestInit|undefined
 globalThis.fetch=(async(url:string,init:RequestInit)=>{upstream.push(String(url));forwarded=init;return new Response('[]')}) as typeof fetch
 const response=await request('/api/zotero/users/123/items?q=Chris',{headers:{'Zotero-API-Key':'test-key'}})
 expect(upstream).toEqual(['https://api.zotero.org/users/123/items?q=Chris'])
 expect(new Headers(forwarded?.headers).get('Zotero-API-Key')).toBe('test-key')
 expect(response.headers.get('Cache-Control')).toBe('private, no-store')
 expect(stored.size).toBe(0)
 expect((await request('/api/zotero/anything')).status).toBe(400)
 expect((await request('/api/zotero/users/123/items',{method:'POST'})).status).toBe(405)
})
