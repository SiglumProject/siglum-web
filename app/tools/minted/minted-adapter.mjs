const sessions=new WeakMap();let nextId=0;
function binary(data){let s='';for(let i=0;i<data.length;i+=32768)s+=String.fromCharCode(...data.subarray(i,i+32768));return btoa(s)}
export async function runMinted(request,context){
 const key=context.sessionSignal||context.signal;
 if(key.aborted)throw Error('Tool session cancelled');
 let session=sessions.get(key);
 if(!session){const worker=new Worker(new URL('./minted-worker.js',import.meta.url));session={worker,pending:new Map()};sessions.set(key,session);const stop=()=>{worker.terminate();for(const item of session.pending.values())item.reject(Error('Tool session ended'));session.pending.clear();sessions.delete(key)};key.addEventListener('abort',stop,{once:true});worker.addEventListener('error',event=>{for(const item of session.pending.values())item.reject(Error(event.message||'Python tool failed'));stop()});worker.onmessage=async({data})=>{const item=session.pending.get(data.id);if(!item)return;if(data.type==='read-inputs'){try{const files=[];for(const path of data.paths)files.push({path,data:binary(await item.context.readFile(path))});worker.postMessage({type:'inputs',files})}catch(error){item.reject(error);stop()}}else if(data.type==='result'){session.pending.delete(data.id);if(!data.ok)item.reject(Error(data.error));else item.resolve({files:data.files.map(x=>({path:x.path,bytes:Uint8Array.from(atob(x.data),ch=>ch.charCodeAt(0))})),removed:data.removed,log:data.log})}};
 }
 const args=request.args;
 if(!Array.isArray(args)||args.length>8)throw Error('Invalid minted arguments');
 const digest=args.at(-1);
 if(typeof digest!=='string'||!(/^[A-Fa-f0-9]{32}$/).test(digest))throw Error('Invalid minted job identity');
 const path='_'+digest+'.data.minted';
 const controls=[];
 if(!['cleanconfig','cleantemp'].includes(args[0]))controls.push({path,text:new TextDecoder('utf-8',{fatal:true}).decode(await context.readFile(path))});
 const id=String(++nextId),message={argv:args,controls};
 return await new Promise((resolve,reject)=>{session.pending.set(id,{resolve,reject,context});context.signal.addEventListener('abort',()=>{if(session.pending.has(id)){session.pending.delete(id);session.worker.terminate();sessions.delete(key);reject(Error('Tool request cancelled'))}},{once:true});session.worker.postMessage({type:'run',id,request:message})});
}
