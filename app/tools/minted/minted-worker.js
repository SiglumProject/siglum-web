const base=new URL('./python/',self.location.href),originalFetch=self.fetch.bind(self);
const assets=['pyodide.js','pyodide.asm.js','pyodide.asm.wasm','python_stdlib.zip','pyodide-lock.json','latex2pydata-0.5.0-py3-none-any.whl','latexminted-0.6.0-py3-none-any.whl','latexrestricted-0.6.2-py3-none-any.whl','pygments-2.19.1-py3-none-any.whl'];
const urls=new Set(assets.map(x=>new URL(x,base).href));urls.add(new URL('minted-bridge.py',base).href);
self.fetch=async(input,options)=>{const url=new URL(input instanceof Request?input.url:input,self.location.href).href;if(!urls.has(url))throw Error('Unexpected tool asset request');let cache;try{cache=await caches.open('siglum-tool-assets:'+new URL('.',self.location.href).pathname)}catch{}const saved=await cache?.match(url);if(saved)return saved;const response=await originalFetch(url,{...options,redirect:'error'});if(!response.ok)throw Error('Missing tool asset '+url);try{await cache?.put(url,response.clone())}catch{}return response};
for(const key of ['XMLHttpRequest','WebSocket','EventSource','WebTransport'])Object.defineProperty(self,key,{value:undefined});
let runtimePromise,waiting;
async function initialize(){importScripts(new URL('pyodide.js',base).href);const runtime=await loadPyodide({indexURL:base.href,stdout:()=>{},stderr:()=>{}});runtime.FS.mkdirTree('/wheels');for(const name of assets.filter(x=>x.endsWith('.whl'))){runtime.FS.writeFile('/wheels/'+name,new Uint8Array(await(await fetch(new URL(name,base))).arrayBuffer()))}const code=await(await fetch(new URL('minted-bridge.py',base))).text();runtime.runPython(code);urls.clear();return runtime}
self.onmessage=async({data})=>{
 if(data.type==='inputs'){waiting?.(data.files);waiting=null;return}
 if(data.type!=='run')return;
 try{
  const runtime=await(runtimePromise??=initialize());runtime.globals.set('request_json',JSON.stringify(data.request));const paths=JSON.parse(runtime.runPython('prepare(request_json)'));const inputs=await new Promise(resolve=>{waiting=resolve;self.postMessage({type:'read-inputs',id:data.id,paths})});runtime.globals.set('input_json',JSON.stringify(inputs));const output=JSON.parse(runtime.runPython('execute(input_json)'));self.postMessage({type:'result',id:data.id,ok:true,...output});
 }catch(error){self.postMessage({type:'result',id:data.id,ok:false,error:String(error.stack||error)})}
};
