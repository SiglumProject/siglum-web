import {createRequire} from 'node:module';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {chromium,webkit}=createRequire(require.resolve('@siglum/engine'))('playwright');
const target=process.env.SIGLUM_TEST_URL || 'http://127.0.0.1:5176/';
import assert from 'node:assert/strict';
const source=String.raw`\documentclass{article}
\begin{document}
SESSION-RESTORE-KEEPS-MY-DRAFT
\end{document}`;
for(const [kind, forceFallback] of [['chromium',false],['chromium',true],['webkit',false]]) {
 const browser=await(kind==='chromium'?chromium.launch():webkit.launch({executablePath:process.env.SIGLUM_WEBKIT_EXECUTABLE}));
 try{
 const page=await browser.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(forceFallback=>{
  window.storageProbeCount=0;
  const getDirectory = navigator.storage.getDirectory?.bind(navigator.storage);
  if (getDirectory) navigator.storage.getDirectory = (...args) => sessionStorage.getItem('test-root-failure') === '1'
    ? Promise.reject(new DOMException('Temporary test storage failure','UnknownError')) : getDirectory(...args);
  if(forceFallback && !localStorage.getItem('siglum-filesystem-backend'))sessionStorage.setItem('test-storage-failure','1');
  if(typeof FileSystemFileHandle!=='undefined' && FileSystemFileHandle.prototype.createWritable){
   const original=FileSystemFileHandle.prototype.createWritable;
   FileSystemFileHandle.prototype.createWritable=function(...args){
    if(this.name.startsWith('.opfs-write-test-'))window.storageProbeCount++;
    if(sessionStorage.getItem('test-storage-failure')==='1' && this.name.startsWith('.opfs-write-test-'))return Promise.reject(new DOMException('Temporary test storage failure','UnknownError'));
    if(sessionStorage.getItem('test-no-opfs-probe')==='1' && this.name.startsWith('.opfs-write-test-'))throw Error('Pinned IndexedDB must not probe OPFS');
    return original.apply(this,args)
   }
  }
 },forceFallback);
 await page.goto(target);await page.getByRole('button',{name:'Open the editor',exact:true}).click();await page.locator('.cm-content').waitFor();
 await page.keyboard.press('Control+KeyN');await page.waitForFunction(()=>localStorage.getItem('siglum_current_file')==='/project/src/untitled.tex');await page.locator('.cm-content').fill(source);await page.waitForTimeout(1200);
 await page.evaluate(()=>sessionStorage.removeItem('test-storage-failure'));
 await page.reload();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));
 const backend=await page.evaluate(()=>localStorage.getItem('siglum-filesystem-backend'));assert.ok(backend==='opfs'||backend==='indexeddb');
 if(backend==='opfs'){
  for(const legacy of [false,true]){
   await page.evaluate(legacy=>{sessionStorage.setItem('test-storage-failure','1');if(legacy)localStorage.removeItem('siglum-filesystem-backend')},legacy);
   await page.reload();await page.getByText('Your document storage is temporarily unavailable.',{exact:false}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Open the editor',exact:true}).count(),0);
   assert.equal(await page.evaluate(()=>localStorage.getItem('siglum_current_file')),'/project/src/untitled.tex');
   const stored=await page.evaluate(async()=>{const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('siglum-files');const src=await root.getDirectoryHandle('src');return(await(await src.getFileHandle('untitled.tex')).getFile()).text()});assert.equal(stored,source);
   await page.evaluate(()=>sessionStorage.removeItem('test-storage-failure'));
   await page.getByRole('button',{name:'Reload',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));
   console.log('PASS',kind,legacy?'legacy storage recovery':'pinned storage recovery');
  }
 } else {
  await page.evaluate(()=>sessionStorage.setItem('test-no-opfs-probe','1'));await page.reload();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));assert.equal(await page.evaluate(()=>window.storageProbeCount),0);console.log('PASS',kind,'IndexedDB session stays on its saved backend');
 }
 if(backend==='opfs'){
  await page.evaluate(()=>{localStorage.removeItem('siglum-filesystem-backend');sessionStorage.setItem('test-root-failure','1')});
  await page.reload();await page.getByText('Could not reopen "untitled.tex".',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('siglum-filesystem-backend')),null,'do not pin an empty fallback');
  await page.evaluate(()=>sessionStorage.removeItem('test-root-failure'));
  await page.getByRole('button',{name:'Reload',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));
  console.log('PASS',kind,'legacy inaccessible storage recovers without pinning an empty fallback');
 }
 // A missing selected document must not silently open welcome and overwrite the pointer.
 await page.evaluate(()=>localStorage.setItem('siglum_current_file','/project/src/missing-session.tex'));await page.reload();await page.getByText('Could not reopen "missing-session.tex".',{exact:false}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('siglum_current_file')),'/project/src/missing-session.tex');assert.equal(await page.getByRole('button',{name:'Open the editor',exact:true}).count(),0);
 await page.evaluate(()=>localStorage.setItem('siglum_current_file','/project/src/untitled.tex'));await page.getByRole('button',{name:'Reload',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));
 assert.deepEqual(errors,[]);console.log('PASS',kind,'saved selection retained on read failure and restored on retry');
 }finally{await browser.close()}
}
