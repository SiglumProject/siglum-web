import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHostedRuntime } from '../hosted-runtime'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, {recursive:true,force:true}))) })
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'siglum-hosted-setup-'))
  temporary.push(directory)
  const version='1.2.3',year=2026
  const files=Object.fromEntries(['wasm/busytex.js','wasm/busytex.wasm','bundles.json','file-manifest.json','xzwasm.js'].map(name=>[name,{size:2,sha256:sha('{}')}]))
  const identity={texLiveYear:year,engineVersion:version,files}
  const releaseId=`tl${year}-${sha(JSON.stringify(identity)).slice(0,16)}`
  const manifestText=JSON.stringify({releaseId,...identity})
  const baseUrl=`https://packages.siglum.org/releases/${releaseId}`
  const descriptor={schemaVersion:1,engineVersion:version,releaseId,baseUrl,manifestUrl:`${baseUrl}/runtime.json`,manifestSha256:sha(manifestText)}
  const responses=new Map<string,Response>([
    [`https://packages.siglum.org/engines/${version}/latest.json`,Response.json(descriptor)],
    [descriptor.manifestUrl,new Response(manifestText)],
  ])
  const fetchResource=(async (url: string | URL | Request) => {
    const response=responses.get(String(url))
    if (!response) throw new Error('Unexpected request: '+url)
    return response.clone()
  }) as typeof fetch
  return {options:{version,year,cacheFile:join(directory,'selection.json'),fetchResource},responses,descriptor,manifestText}
}

test('selects compatible hosted assets without sibling checkouts and caches verified metadata',async()=>{
  const f=await fixture()
  expect(await resolveHostedRuntime(f.options)).toEqual({apiBase:'https://packages.siglum.org',releaseId:f.descriptor.releaseId})
  expect(JSON.parse(await readFile(f.options.cacheFile,'utf8')).version).toBe(f.options.version)
})
test('supports published releases made before the discovery endpoint existed',async()=>{
  const f=await fixture()
  f.responses.set(`https://packages.siglum.org/engines/${f.options.version}/latest.json`,new Response('',{status:404}))
  f.responses.set(`https://api.github.com/repos/SiglumProject/siglum/releases/tags/v${f.options.version}`,Response.json({tag_name:`v${f.options.version}`,draft:false,body:`Runtime: ${f.descriptor.manifestUrl}`}))
  expect((await resolveHostedRuntime(f.options)).releaseId).toBe(f.descriptor.releaseId)
})
test('reuses compatible verified metadata when restarting the dev server offline',async()=>{
  const f=await fixture()
  await resolveHostedRuntime(f.options)
  expect((await resolveHostedRuntime({...f.options,fetchResource:(async()=>{throw new TypeError('offline')}) as typeof fetch})).releaseId).toBe(f.descriptor.releaseId)
})
test('does not silently use cached metadata after a bad manifest digest',async()=>{
  const f=await fixture()
  await resolveHostedRuntime(f.options)
  f.responses.set(f.descriptor.manifestUrl,new Response(f.manifestText+' '))
  await expect(resolveHostedRuntime(f.options)).rejects.toThrow('does not match')
})
test('rejects another SDK or runtime service',async()=>{
  for(const change of [{engineVersion:'2.0.0'},{baseUrl:'https://other.example'}]) {
    const f=await fixture()
    f.responses.set(`https://packages.siglum.org/engines/${f.options.version}/latest.json`,Response.json({...f.descriptor,...change}))
    await expect(resolveHostedRuntime(f.options)).rejects.toThrow('Invalid hosted runtime descriptor')
  }
})
test('rejects corrupted cached metadata on offline restart',async()=>{
  const f=await fixture()
  await resolveHostedRuntime(f.options)
  const cached=JSON.parse(await readFile(f.options.cacheFile,'utf8'))
  cached.manifestText+=' '
  await writeFile(f.options.cacheFile,JSON.stringify(cached))
  await expect(resolveHostedRuntime({...f.options,fetchResource:(async()=>{throw new TypeError('offline')}) as typeof fetch})).rejects.toThrow('unavailable')
})

test('reopens verified cached metadata when a response body disconnects',async()=>{
  const f=await fixture()
  await resolveHostedRuntime(f.options)
  const interrupted=(async(url:string|URL|Request)=>{
    if(String(url)!==f.descriptor.manifestUrl)return f.options.fetchResource(url)
    const response=new Response('')
    response.text=async()=>{throw new TypeError('body connection closed')}
    return response
  }) as typeof fetch
  expect((await resolveHostedRuntime({...f.options,fetchResource:interrupted})).releaseId).toBe(f.descriptor.releaseId)
})

test('verified online selection does not require a writable optional metadata cache',async()=>{
  const f=await fixture()
  const directory=f.options.cacheFile.slice(0,f.options.cacheFile.lastIndexOf('/'))
  expect((await resolveHostedRuntime({...f.options,cacheFile:directory})).releaseId).toBe(f.descriptor.releaseId)
})
