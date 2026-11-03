// Test a staged local preview, or set SIGLUM_TEST_URL to verify a real deployment without intercepting its network.
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {chromium,webkit}=createRequire(require.resolve('@siglum/engine'))('playwright');
const {releaseId}=JSON.parse(readFileSync(resolve(root,'../../siglum-engine/.local-release/current.json'),'utf8'));
const target=process.env.SIGLUM_TEST_URL || 'http://127.0.0.1:5175/';
const remote=Boolean(process.env.SIGLUM_TEST_URL);
const artifacts=process.env.SIGLUM_TEST_ARTIFACTS||resolve(root,'.local-release/test-artifacts');mkdirSync(artifacts,{recursive:true});
import assert from 'node:assert/strict';
for(const [kind,viewport] of [['chromium',{width:1440,height:900}],['chromium',{width:320,height:568}],['webkit',{width:320,height:568}]]){
 const browser=await(kind==='chromium'?chromium.launch({headless:true}):webkit.launch({headless:true,executablePath:process.env.SIGLUM_WEBKIT_EXECUTABLE}));
 try{
 const mobile=viewport.width<600;const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,serviceWorkers:remote?'allow':'block'});const p=await context.newPage();p.setDefaultTimeout(60000);const errors=[],requests=[];
 p.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});p.on('console',m=>{if(m.type()==='error'||m.type()==='warning'){console.log('CONSOLE',m.text());if(m.text().includes('Math.sumPrecise'))errors.push(m.text())}});
 if(remote)p.on('request',request=>{if(request.url().startsWith('https://packages.siglum.org/'))requests.push(request.url())});
 else await context.route('https://packages.siglum.org/**',async route=>{requests.push(route.request().url());await route.fulfill({response:await route.fetch({url:route.request().url().replace('https://packages.siglum.org','http://127.0.0.1:5175/engine')})})});
 await p.goto(target);await p.getByRole('button',{name:'Open the editor',exact:true}).click();await p.locator('.cm-content').waitFor();await p.waitForTimeout(3000);
 const source='\\documentclass{article}\n\\usepackage{csquotes}\n\\begin{document}\nPinned release verification.\\newpage\nSecond page works.\n\\end{document}';
 await p.locator('.cm-content').fill(source);
 if(mobile){await p.getByRole('button',{name:'Compile document',exact:true}).click();await p.getByRole('button',{name:'Preview PDF; hold to peek',exact:true}).click()}
 await p.waitForTimeout(10000);await p.waitForFunction(()=>document.querySelector('.pdf-text-layer')?.textContent?.includes('Pinned release verification'),{},{timeout:90000});
 assert.ok(requests.some(url=>url.includes(`/releases/${releaseId}/wasm/busytex.wasm`)),'uses pinned WASM');
 assert.ok(requests.some(url=>url.includes('/api/texlive/csquotes')),'downloads an unbundled package');
 assert.ok(requests.some(url=>url.endsWith('/xzwasm.js')),'loads the staged decompressor');
 assert.ok(requests.every(url=>url.includes(`/releases/${releaseId}/`)),'all engine requests pinned');
 const canvas=await p.locator('.pdf-page-canvas').first().evaluate(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let ink=0;for(let i=0;i<d.length;i+=4)if(d[i]<180&&d[i+1]<180&&d[i+2]<180&&d[i+3]>0)ink++;return{width:c.width,height:c.height,ink}});assert.ok(canvas.ink>10,'PDF contains rendered ink');
 await p.screenshot({path:resolve(artifacts,`production-${kind}-${viewport.width}.png`)});if(!mobile){const download=p.waitForEvent('download');await p.getByTitle('Download PDF',{exact:true}).click();await(await download).saveAs(resolve(artifacts,'production-output.pdf'))}if(remote){await p.waitForFunction(()=>Boolean(navigator.serviceWorker?.controller),{},{timeout:30000});await p.waitForTimeout(1000);await p.reload();await p.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('Pinned release verification'),{},{timeout:30000});if(mobile)await p.getByRole('button',{name:'Preview PDF; hold to peek',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.pdf-text-layer')?.textContent?.includes('Pinned release verification'),{},{timeout:90000});console.log('PASS service-worker reload',kind,viewport.width)}assert.deepEqual(errors,[]);console.log('PASS production',kind,viewport.width,canvas,requests.length,'pinned requests');
 }finally{await browser.close()}
}
