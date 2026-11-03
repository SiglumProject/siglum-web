/** Build the candidate against an already staged immutable runtime; no uploads. */
import {resolve} from 'node:path';
const root=resolve(import.meta.dir,'..');
const engine=resolve(root,'../../siglum-engine');
const current=await Bun.file(resolve(engine,'.local-release/current.json')).json();
for(const [cwd,command] of [[engine,['node','scripts/verify-runtime.mjs',current.directory]],
 [resolve(root,'app'),['bun','run','build','--outDir',resolve(root,'.local-release/site')]]] as const){
 const child=Bun.spawn([...command],{cwd,env:{...process.env,VITE_API_BASE:'https://packages.siglum.org',VITE_ENGINE_RELEASE:current.releaseId},stdout:'inherit',stderr:'inherit'});
 if(await child.exited!==0)throw new Error('Release preparation failed');
}
console.log(`Built ${current.releaseId} in .local-release/site. Run preview:release then test:release. Nothing published.`);
