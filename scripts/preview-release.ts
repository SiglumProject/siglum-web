import {resolve} from 'node:path';
const root=resolve(import.meta.dir,'..');
const ui=resolve(root,'.local-release/site');
const stage=await Bun.file(resolve(root,'../../siglum-engine/.local-release/current.json')).json();
Bun.serve({hostname:'127.0.0.1',port:5175,async fetch(request){
 const url=new URL(request.url);let path=url.pathname;
 const headers:Record<string,string>={'Access-Control-Allow-Origin':'*','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'};
 if(path.startsWith('/engine/')){
  path=path.slice(7);
  const prefix='/releases/'+stage.releaseId+'/';
  if(!path.startsWith(prefix))return new Response('Wrong runtime',{status:404,headers});
  path=path.slice(prefix.length);
  if(path.startsWith('api/')){const upstream=await fetch('http://127.0.0.1:8787/'+path+url.search,{headers:request.headers});const responseHeaders=new Headers(upstream.headers);for(const [key,value] of Object.entries(headers))responseHeaders.set(key,value);return new Response(upstream.body,{status:upstream.status,headers:responseHeaders})}
  path=path.replace(/^bundles\//,'');if(path.includes('..'))return new Response('Invalid path',{status:400});
  const file=Bun.file(resolve(stage.directory,path));if(!await file.exists())return new Response('Missing',{status:404,headers});
  headers['Content-Type']=path.endsWith('.wasm')?'application/wasm':path.endsWith('.js')?'application/javascript':path.endsWith('.json')?'application/json':'application/octet-stream';
  const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range')||'');
  if(range){const start=+range[1],end=Math.min(file.size-1,range[2]?+range[2]:file.size-1);headers['Content-Range']=`bytes ${start}-${end}/${file.size}`;return new Response(file.slice(start,end+1),{status:206,headers})}
  return new Response(file,{headers});
 }
 if(path.includes('..'))return new Response('Invalid path',{status:400});
 const file=Bun.file(resolve(ui,'.'+path));return new Response(await file.exists()?file:Bun.file(resolve(ui,'index.html')),{headers});
}});console.log('Staged production preview http://127.0.0.1:5175/');
