import { chromium, webkit } from 'playwright';
const target=process.env.SIGLUM_TEST_URL || 'http://127.0.0.1:5176/';
import assert from 'node:assert/strict';
const source=String.raw`\documentclass{article}
\begin{document}
SESSION-RESTORE-KEEPS-MY-DRAFT
\end{document}`;
const welcomePath = '/project/src/welcome.tex';
const draftPath = '/project/src/untitled.tex';

const savedRecents = page => page.evaluate(() =>
 JSON.parse(localStorage.getItem('siglum_recent_files') ?? '[]')
);

const rememberWelcome = (page, select = false) => page.evaluate(({ path, select }) => {
 const recent = JSON.parse(localStorage.getItem('siglum_recent_files') ?? '[]');
 localStorage.setItem('siglum_recent_files', JSON.stringify([path, ...recent.filter(file => file !== path)]));
 if (select) localStorage.setItem('siglum_current_file', path);
}, { path: welcomePath, select });

// Remove only the sample in this test profile to model a stale saved selection.
const accessWelcome = (page, backend, remove = false) => page.evaluate(async ({ backend, remove }) => {
 if (backend === 'opfs') {
  const root = await navigator.storage.getDirectory();
  const project = await (await root.getDirectoryHandle('siglum-files')).getDirectoryHandle('src');
  if (remove) await project.removeEntry('welcome.tex');
  try {
   await project.getFileHandle('welcome.tex');
   return true;
  } catch (error) {
   if (error.name !== 'NotFoundError') throw error;
   return false;
  }
 }
 const db = await new Promise((resolve, reject) => {
  const request = indexedDB.open('siglum_filesystem');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
 });
 try {
  return await new Promise((resolve, reject) => {
   const transaction = db.transaction('files', remove ? 'readwrite' : 'readonly');
   const files = transaction.objectStore('files');
   if (remove) files.delete('/src/welcome.tex');
   const count = files.count('/src/welcome.tex');
   transaction.oncomplete = () => resolve(count.result > 0);
   transaction.onabort = () => reject(transaction.error);
  });
 } finally {
  db.close();
 }
}, { backend, remove });

for(const [kind, forceFallback] of [['chromium',false],['chromium',true],['webkit',false]]) {
 const browser=await(kind==='chromium'?chromium.launch():webkit.launch({executablePath:process.env.SIGLUM_WEBKIT_EXECUTABLE}));
 try{
 const page=await browser.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(forceFallback=>{
  window.storageProbeCount=0;
  const getDirectory = navigator.storage.getDirectory?.bind(navigator.storage);
  if (getDirectory) navigator.storage.getDirectory = (...args) => sessionStorage.getItem('test-root-failure') === '1'
    ? Promise.reject(new DOMException('Temporary test storage failure','UnknownError')) : getDirectory(...args);
  // Recovery checks later restore writable OPFS after the initial fallback.
  if(forceFallback && !localStorage.getItem('siglum-filesystem-backend') && !sessionStorage.getItem('test-initial-fallback')){
   sessionStorage.setItem('test-initial-fallback','1');
   sessionStorage.setItem('test-storage-failure','1');
  }
  if(typeof FileSystemFileHandle!=='undefined' && FileSystemFileHandle.prototype.getFile){
   const original=FileSystemFileHandle.prototype.getFile;
   FileSystemFileHandle.prototype.getFile=function(...args){
    if(this.name==='welcome.tex' && sessionStorage.getItem('test-welcome-read-failure')==='1'){
     return Promise.reject(new DOMException('Temporary welcome read failure','UnknownError'));
    }
    return original.apply(this,args);
   };
  }
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
 let backend=await page.evaluate(()=>localStorage.getItem('siglum-filesystem-backend'));assert.ok(backend==='opfs'||backend==='indexeddb');
 if(backend==='opfs'){
  for(const legacy of [false,true]){
   await page.evaluate(legacy=>{sessionStorage.setItem('test-storage-failure','1');if(legacy)localStorage.removeItem('siglum-filesystem-backend')},legacy);
   await page.reload();await page.getByText('Your document storage is temporarily unavailable.',{exact:false}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Open the editor',exact:true}).count(),0);
   assert.equal(await page.locator('summary').filter({ hasText: 'Choose another file' }).count(), 0);
   assert.equal(await page.getByRole('button', { name: 'New document', exact: true }).count(), 0);
   assert.equal(await page.evaluate(()=>localStorage.getItem('siglum_current_file')),'/project/src/untitled.tex');
   const stored=await page.evaluate(async()=>{const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('siglum-files');const src=await root.getDirectoryHandle('src');return(await(await src.getFileHandle('untitled.tex')).getFile()).text()});assert.equal(stored,source);
   await page.evaluate(()=>sessionStorage.removeItem('test-storage-failure'));
   await page.getByRole('button',{name:'Reload',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));
   console.log('PASS',kind,legacy?'legacy storage recovery':'pinned storage recovery');
  }
 } else {
  await page.evaluate(()=>sessionStorage.setItem('test-no-opfs-probe','1'));await page.reload();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));assert.equal(await page.evaluate(()=>window.storageProbeCount),0);console.log('PASS',kind,'IndexedDB session stays on its saved backend');
  if(forceFallback){
   const readIndexedDBDocuments=()=>page.evaluate(async()=>{
    const database=await new Promise((resolve,reject)=>{
     const request=indexedDB.open('siglum_filesystem');
     request.onsuccess=()=>resolve(request.result);
     request.onerror=()=>reject(request.error);
    });
    try{
     return await new Promise((resolve,reject)=>{
      const transaction=database.transaction('files','readonly');
      const request=transaction.objectStore('files').getAll();
      transaction.oncomplete=()=>resolve(Object.fromEntries(request.result.filter(file=>file.path.endsWith('.tex')).map(file=>[file.path,file.content])));
      transaction.onabort=()=>reject(transaction.error);
     });
    }finally{database.close()}
   });
   const originals=await readIndexedDBDocuments();
   assert.equal(originals['/src/untitled.tex'],source);
   assert.equal(await accessWelcome(page,'indexeddb'),true);
   const opfsDocuments=await page.evaluate(async()=>{
    sessionStorage.removeItem('test-no-opfs-probe');
    sessionStorage.removeItem('test-storage-failure');
    const root=await navigator.storage.getDirectory();
    const proofName='.session-recovery-write-proof';
    try{
     const proof=await root.getFileHandle(proofName,{create:true});
     const writer=await proof.createWritable();
     await writer.write('Writable OPFS recovery check');
     await writer.close();
    }finally{await root.removeEntry(proofName)}
    const files=await root.getDirectoryHandle('siglum-files',{create:true});
    const src=await files.getDirectoryHandle('src',{create:true});
    const names=[];
    for await(const entry of src.values())names.push(entry.name);
    return names;
   });
   assert.deepEqual(opfsDocuments,[],'recovery starts with an empty OPFS source directory');
   for(const savedPreference of [null,'opfs']){
    await page.evaluate(preference=>{
     sessionStorage.removeItem('test-no-opfs-probe');
     sessionStorage.removeItem('test-storage-failure');
     if(preference===null)localStorage.removeItem('siglum-filesystem-backend');
     else localStorage.setItem('siglum-filesystem-backend',preference);
    },savedPreference);
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));
    backend=await page.evaluate(()=>localStorage.getItem('siglum-filesystem-backend'));
    assert.equal(backend,'indexeddb');
    assert.equal(await page.evaluate(()=>localStorage.getItem('siglum_current_file')),draftPath);
    assert.ok(await page.evaluate(()=>window.storageProbeCount)>0,'OPFS is writable and was probed');
    assert.deepEqual(await readIndexedDBDocuments(),originals,'retain every original IndexedDB document');
    assert.equal(await accessWelcome(page,backend),true);
    console.log('PASS',kind,savedPreference===null?'legacy IndexedDB documents recover without a backend preference':'IndexedDB documents recover from an incorrect OPFS preference');
   }
  }
 }
 if(backend==='opfs'){
  await page.evaluate(()=>{localStorage.removeItem('siglum-filesystem-backend');sessionStorage.setItem('test-root-failure','1')});
  await page.reload();await page.getByText('Could not reopen "untitled.tex".',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('siglum-filesystem-backend')),null,'do not pin an empty fallback');
  await page.evaluate(()=>sessionStorage.removeItem('test-root-failure'));
  await page.getByRole('button',{name:'Reload',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));
  console.log('PASS',kind,'legacy inaccessible storage recovers without pinning an empty fallback');
 }
 const welcomeTab = page.locator('.tab-bar-tab[title="' + welcomePath + '"]');
 const draftTab = page.locator('.tab-bar-tab[title="' + draftPath + '"]');
 const openFailure = page.locator('.toast-message').filter({ hasText: 'Could not open "welcome.tex".' });
 const original = new URL(target);
 original.searchParams.set('file', draftPath);
 const waitForDraft = async () => {
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('SESSION-RESTORE-KEEPS-MY-DRAFT'));
  assert.equal(await page.evaluate(() => localStorage.getItem('siglum_current_file')), draftPath);
 };

 if (backend === 'opfs') {
  // The storage entry still exists. A failed read must leave the tab and the
  // active draft intact so that retrying can open it once storage recovers.
  await page.evaluate(() => sessionStorage.setItem('test-welcome-read-failure', '1'));
  await page.reload();
  await waitForDraft();
  await welcomeTab.click();
  await openFailure.waitFor();
  await waitForDraft();
  assert.ok((await savedRecents(page)).includes(welcomePath));
  assert.equal(await accessWelcome(page, backend), true);
  await page.evaluate(() => sessionStorage.removeItem('test-welcome-read-failure'));
  await welcomeTab.click();
  await page.waitForFunction(path => localStorage.getItem('siglum_current_file') === path, welcomePath);
  await draftTab.click();
  await waitForDraft();
  console.log('PASS', kind, 'temporarily unreadable welcome keeps its tab and can be reopened');
 }

 // The saved welcome selection is stale. Startup must preserve it and offer
 // recovery without writing a replacement welcome or touching the saved draft.
 assert.equal(await accessWelcome(page, backend, true), false);
 const openStaleWelcome = async () => {
  await rememberWelcome(page, true);
  await page.reload();
  await page.getByText('Could not reopen "welcome.tex".', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('siglum_current_file')), welcomePath);
  assert.equal(await page.getByRole('button', { name: 'Open the editor', exact: true }).count(), 0);
  assert.equal(await accessWelcome(page, backend), false);
 };
 await openStaleWelcome();
 await page.locator('summary').filter({ hasText: 'Choose another file' }).click();
 await page.getByRole('button', { name: 'untitled.tex', exact: true }).click();
 await waitForDraft();
 assert.equal(await accessWelcome(page, backend), false);
 console.log('PASS', kind, 'stale welcome can recover to an existing saved draft');

 await openStaleWelcome();
 await page.getByRole('button', { name: 'New document', exact: true }).click();
 await page.locator('.cm-content').waitFor();
 const newPath = await page.evaluate(() => localStorage.getItem('siglum_current_file'));
 assert.match(newPath, /^\/project\/src\/.+\.tex$/);
 assert.notEqual(newPath, welcomePath);
 assert.notEqual(newPath, draftPath);
 assert.equal(await accessWelcome(page, backend), false);
 await draftTab.waitFor();
 await welcomeTab.waitFor({ state: 'detached' });
 assert.ok(!(await savedRecents(page)).includes(welcomePath));
 console.log('PASS', kind, 'new document recovery removes the stale welcome tab and preserves the saved draft');

 // Simulate an older session with an invalid recent tab and a valid selection.
 await rememberWelcome(page);
 await page.goto(original.href);
 await waitForDraft();
 await welcomeTab.click();
 await openFailure.waitFor();
 await waitForDraft();
 await welcomeTab.waitFor({ state: 'detached' });
 assert.ok(!(await savedRecents(page)).includes(welcomePath));
 assert.equal(await accessWelcome(page, backend), false);
 assert.deepEqual(errors, []);
 console.log('PASS', kind, 'clicking a stale tab preserves the editor and removes only the invalid tab');
 }finally{await browser.close()}
}
