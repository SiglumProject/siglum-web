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

test('deployment isolates the 2026 runtime from existing package and proxy clients',async()=>{
 const config=Bun.TOML.parse(await Bun.file(new URL('../wrangler.toml',import.meta.url)).text()) as {name:string;routes:{pattern:string}[]}
 expect(config.name).toBe('siglum-api-2026')
 const patterns=config.routes.map(route=>route.pattern)
 expect(patterns.sort()).toEqual([
  'ctan-proxy.siglum.org/releases/tl2026-*',
  'packages.siglum.org/api/zotero/*',
  'packages.siglum.org/engines/*',
  'packages.siglum.org/latest',
  'packages.siglum.org/latest.json*',
  'packages.siglum.org/latest/*',
  'packages.siglum.org/releases/tl2026-*',
 ])
 const legacy=['packages.siglum.org/bundles/core.data.gz','packages.siglum.org/wasm/busytex.wasm','packages.siglum.org/latest-fonts.js','ctan-proxy.siglum.org/api/fetch/csquotes','ctan-proxy.siglum.org/api/texlive/csquotes']
 const matches=(url:string,pattern:string)=>pattern.endsWith('*')?url.startsWith(pattern.slice(0,-1)):url===pattern
 for(const url of legacy)expect(patterns.some(pattern=>matches(url,pattern))).toBe(false)
 for(const url of ['packages.siglum.org/latest','packages.siglum.org/latest.json?check=1','packages.siglum.org/engines/0.2.1/latest.json']){
  expect(patterns.some(pattern=>matches(url,pattern))).toBe(true)
 }
 for(const host of ['packages.siglum.org','ctan-proxy.siglum.org']){
  upstream=[]
  const response=await worker.fetch(new Request(`https://${host}/releases/tl2026-1234567890abcdef/api/texlive/releasecheck`),environment(),context)
  expect(response.status).toBe(200)
  if(host==='packages.siglum.org')expect(upstream.some(url=>url.endsWith('/TEXLIVE_2026'))).toBe(true)
  expect(response.headers.get('X-TL-Year')).toBe('2026')
 }
})

function descriptor(engineVersion='0.2.1', releaseId='tl2026-1234567890abcdef') {
 const baseUrl=`https://packages.siglum.org/releases/${releaseId}`
 return {schemaVersion:1,engineVersion,releaseId,baseUrl,manifestUrl:`${baseUrl}/runtime.json`,manifestSha256:'a'.repeat(64)}
}
function storeDescriptor(key:string, value:unknown) {
 stored.set(key,new TextEncoder().encode(JSON.stringify(value)))
}

test('latest and exact engine discovery read separate R2 descriptors without edge caching',async()=>{
 let cacheReads=0,cacheWrites=0
 Object.defineProperty(globalThis,'caches',{configurable:true,value:{default:{
  match:async()=>{cacheReads++;return new Response('stale edge entry')},
  put:async()=>{cacheWrites++},
 }}})
 const current=descriptor(), older=descriptor('0.2.0','tl2026-aaaaaaaaaaaaaaaa')
 storeDescriptor('channels/latest.json',current)
 storeDescriptor('engines/0.2.0/latest.json',older)
 for(const [path,expected] of [['/latest.json',current],['/engines/0.2.0/latest.json',older]] as const){
  const response=await request(path)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  expect(response.headers.get('Content-Type')).toBe('application/json')
  expect(await response.json()).toEqual(expected)
 }
 const updated=descriptor('0.2.2','tl2026-bbbbbbbbbbbbbbbb')
 storeDescriptor('channels/latest.json',updated)
 expect(await(await request('/latest.json')).json()).toEqual(updated)
 expect(cacheReads).toBe(0)
 expect(cacheWrites).toBe(0)
 expect(upstream).toEqual([])
})

test('discovery supports HEAD, preflight and method rejection with consistent CORS and metadata',async()=>{
 storeDescriptor('channels/latest.json',descriptor())
 const get=await request('/latest.json'), head=await request('/latest.json',{method:'HEAD'})
 expect(head.status).toBe(get.status)
 expect([...head.headers]).toEqual([...get.headers])
 expect(await head.text()).toBe('')
 expect(Number(head.headers.get('Content-Length'))).toBe(new TextEncoder().encode(await get.text()).length)
 const options=await request('/engines/0.2.1/latest.json',{method:'OPTIONS'})
 expect(options.status).toBe(200)
 expect(options.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS')
 expect(options.headers.get('Cache-Control')).toBe('no-store')
 const post=await request('/latest.json',{method:'POST'})
 expect(post.status).toBe(405)
 expect(post.headers.get('Allow')).toBe('GET, HEAD, OPTIONS')
 expect(post.headers.get('Cache-Control')).toBe('no-store')
})

test('missing discovery never falls back to a legacy descriptor, asset or package request',async()=>{
 storeDescriptor('latest.json',descriptor())
 storeDescriptor('engines/0.2.1/runtime.json',descriptor())
 stored.set('wasm/busytex.wasm',new Uint8Array([99]))
 for(const path of ['/latest.json','/latest','/engines/0.2.1/latest.json']){
  const response=await request(path)
  expect(response.status).toBe(404)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  expect((await request(path,{method:'HEAD'})).body).toBeNull()
 }
 for(const path of ['/latest/wasm/busytex.wasm','/latest.json/extra','/engines/0.2.1/busytex.wasm']){
  expect((await request(path)).status).toBe(404)
 }
 expect(upstream).toEqual([])
})

test('discovery leaves similarly named legacy assets intact',async()=>{
 stored.set('latest-fonts.js',new Uint8Array([44]))
 const response=await worker.fetch(new Request('https://packages.siglum.org/latest-fonts.js'),environment(),context)
 expect(response.status).toBe(200)
 expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([44])
 expect(response.headers.get('Content-Type')).toBe('application/javascript')
})

test('malformed descriptors and incompatible engine versions fail closed',async()=>{
 const good=descriptor()
 const invalid=[null,[],{},
  {...good,schemaVersion:'1'},
  {...good,engineVersion:'01.2.1'},
  {...good,releaseId:'tl2026-invalid'},
  {...good,manifestSha256:'A'.repeat(64)},
  {...good,manifestSha256:'a'.repeat(63)},
  {...good,manifestUrl:good.baseUrl+'/other.json'},
 ]
 const invalidBases=[good.baseUrl+'/',
  'http://packages.siglum.org/releases/'+good.releaseId,
  'https://user:password@packages.siglum.org/releases/'+good.releaseId,
  good.baseUrl+'?mutable=1',good.baseUrl+'#mutable',
  'https://packages.siglum.org/latest',
  'https://packages.siglum.org/other/../releases/'+good.releaseId,
 ]
 invalid.push(...invalidBases.map(baseUrl=>({...good,baseUrl,manifestUrl:baseUrl+'/runtime.json'})))
 for(const value of invalid){
  storeDescriptor('channels/latest.json',value)
  const response=await request('/latest.json')
  expect(response.status).toBe(502)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
 }
 stored.set('channels/latest.json',new TextEncoder().encode('{incomplete'))
 expect((await request('/latest.json')).status).toBe(502)
 storeDescriptor('engines/0.2.0/latest.json',good)
 expect((await request('/engines/0.2.0/latest.json')).status).toBe(502)
 expect(upstream).toEqual([])
})

test('exact engine paths accept semver prerelease/build metadata and reject invalid identifiers',async()=>{
 const version='0.3.0-rc.1+build.01'
 const candidate=descriptor(version)
 storeDescriptor(`engines/${version}/latest.json`,candidate)
 expect(await(await request(`/engines/${encodeURIComponent(version)}/latest.json`)).json()).toEqual(candidate)
 for(const version of ['latest','0.2','v0.2.1','01.2.1','0.2.1-01','0.2.1%2Fother','%FF']){
  const response=await request(`/engines/${version}/latest.json`)
  expect(response.status).toBe(400)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
 }
 expect(upstream).toEqual([])
})

test('latest and bare release links redirect to immutable manifests without caching aliases',async()=>{
 const current=descriptor()
 storeDescriptor('channels/latest.json',current)
 for(const path of ['/latest','/latest/']){
  const response=await request(path)
  expect(response.status).toBe(302)
  expect(response.headers.get('Location')).toBe(current.manifestUrl)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  const head=await request(path,{method:'HEAD'})
  expect(head.status).toBe(302)
  expect(head.headers.get('Location')).toBe(current.manifestUrl)
  expect(await head.text()).toBe('')
 }
 for(const path of [`/releases/${current.releaseId}`,`/releases/${current.releaseId}/`]){
  const response=await request(path)
  expect(response.status).toBe(302)
  expect(response.headers.get('Location')).toBe(`https://siglum-api.example/releases/${current.releaseId}/runtime.json`)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
 }
})

test('discovery storage errors are controlled no-store responses',async()=>{
 const env={BUNDLES:{get:async()=>{throw new Error('temporary storage failure')}}} as unknown as ReturnType<typeof environment>
 const response=await worker.fetch(new Request('https://packages.siglum.org/latest.json'),env,context)
 expect(response.status).toBe(502)
 expect(response.headers.get('Cache-Control')).toBe('no-store')
 expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
 expect(upstream).toEqual([])
})
