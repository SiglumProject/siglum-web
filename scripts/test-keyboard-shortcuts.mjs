// Exercises all ten application shortcuts documented in Help using actual key input.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const { chromium, webkit } = createRequire(require.resolve('@siglum/engine'))('playwright')
const artifacts = process.env.SIGLUM_TEST_ARTIFACTS || '/tmp/siglum-keyboard-tests'
mkdirSync(artifacts, { recursive: true })
const source = String.raw`\documentclass{article}
\begin{document}
\section{Alpha}
Boldword italicword mathword. KEYBOARD-FIRST.
\newpage
\section{Beta}
Second page for navigation.
\end{document}`
for (const kind of ['chromium', 'webkit']) for (const [platform, mod] of [['MacIntel', 'Meta'], ['Win32', 'Control']]) {
 if (process.env.SIGLUM_TEST_BROWSER && kind !== process.env.SIGLUM_TEST_BROWSER) continue
 if (process.env.SIGLUM_TEST_PLATFORM && platform !== process.env.SIGLUM_TEST_PLATFORM) continue
 const browser = await (kind === 'chromium' ? chromium.launch({headless:true}) : webkit.launch({headless:true, executablePath:process.env.SIGLUM_WEBKIT_EXECUTABLE}))
 const page = await browser.newPage({viewport:{width:1440,height:900}})
 page.setDefaultTimeout(30000)
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.addInitScript(platform=>{Object.defineProperty(navigator,'platform',{get:()=>platform});window.keyAudit=[];window.addEventListener('keydown',event=>{const record={key:event.key,code:event.code,keyCode:event.keyCode,meta:event.metaKey,ctrl:event.ctrlKey,shift:event.shiftKey};queueMicrotask(()=>window.keyAudit.push({...record,prevented:event.defaultPrevented}))},true)},platform)
 const press = keys => page.keyboard.press(`${mod}+${keys.replace(/(^|\+)([a-z])$/, (_, prefix, letter) => `${prefix}Key${letter.toUpperCase()}`)}`)
 const pdfText = marker => page.waitForFunction(marker=>document.querySelector('.pdf-text-layer')?.textContent?.includes(marker), marker, {timeout:90000})
 const select = async word => page.evaluate(async word=>{
   const {EditorView}=await import('/node_modules/.vite/deps/@codemirror_view.js')
   const view=EditorView.findFromDOM(document.querySelector('.cm-content'))
   const from=word ? view.state.doc.toString().indexOf(word) : 0
   view.dispatch({selection:{anchor:from,head:from+(word?.length||0)}});view.focus()
 },word)
 const state = () => page.evaluate(async()=>{
   const {EditorView}=await import('/node_modules/.vite/deps/@codemirror_view.js')
   const view=EditorView.findFromDOM(document.querySelector('.cm-content'))
   return {text:view.state.doc.toString(),line:view.state.doc.lineAt(view.state.selection.main.head).number}
 })
 try {
  await page.goto('http://127.0.0.1:5174/')
  await page.getByRole('button',{name:'Open the editor',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.pdf-text-layer')?.textContent?.includes('Welcome to Siglum'),{},{timeout:90000})
  // Disable auto-compile, so it cannot hide a broken shortcut.
  await page.getByTitle('Settings',{exact:true}).click()
  const auto=page.locator('.compiler-setting-row').filter({hasText:'Auto-compile'}).locator('button')
  assert.ok((await auto.getAttribute('class')).includes('active'))
  await auto.click();await page.getByTitle('Settings',{exact:true}).click()
  await page.evaluate(async()=>{
    // Vite app imports can carry HMR timestamps; use the already-loaded module.
    const urls=performance.getEntriesByType('resource').map(entry=>entry.name).filter(url=>new URL(url).pathname==='/src/services/CompilerService.ts')
    const compiler=(await import(urls.find(url=>url.includes('?t=')) || urls[0])).default
    const original=compiler.compile.bind(compiler)
    window.keyboardCompiles=[]
    compiler.compile=(source,options)=>{window.keyboardCompiles.push(source);return original(source,options)}
  })
  // Help contains the same ten shortcuts we exercise here.
  await page.getByRole('button',{name:'Help',exact:true}).click()
  await page.locator('.shortcut-keys').first().waitFor()
  const listed=await page.locator('.shortcut-keys').evaluateAll(rows=>rows.map(row=>row.textContent))
  assert.deepEqual(listed,['⌘K','⌘S','⌘⇧↵','⌘N','⌘1','⌘2','⌘\\','⌘B','⌘I','⌘⇧M'])
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'})
  await page.locator('.cm-content').fill(source)
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(()=>window.keyboardCompiles.length),0,'editing must not auto-compile')
  await press('s');await pdfText('KEYBOARD-FIRST')
  assert.equal(await page.evaluate(()=>window.keyboardCompiles.length),1,'editor compile runs once')
  for(const [focus,marker] of [['pdf','KEYBOARD-PDF'],['toolbar','KEYBOARD-TOOLBAR']]){
    const current=(await state()).text.replace(/KEYBOARD-[A-Z]+/g,marker)
    await page.locator('.cm-content').fill(current)
    if(focus==='pdf')await page.locator('.pdf-viewer').focus();else await page.getByTitle('Settings',{exact:true}).focus()
    const before=await page.evaluate(()=>window.keyboardCompiles.length)
    await press('s');await pdfText(marker)
    assert.equal(await page.evaluate(()=>window.keyboardCompiles.length),before+1,`${focus} compile runs once`)
  }
  console.log('PASS',kind,platform,'compile from source, PDF and toolbar with auto-compile off')
  // Palette opens and closes, including the previously duplicated alias.
  await select('Boldword');await press('k');await page.locator('.command-palette-input').waitFor()
  await press('k');await page.locator('.command-palette-input').waitFor({state:'detached'})
  await select('Boldword');await press('Shift+f');await page.locator('.command-palette-input').waitFor()
  await press('k');await page.locator('.command-palette-input').waitFor({state:'detached'})
  // Both layout commands are idempotent and never switch source documents.
  const originalPath=await page.evaluate(()=>window.fileManager.getCurrentPath())
  await press('1');await page.locator('.pdf-viewer').waitFor({state:'detached'})
  await press('1');assert.equal(await page.locator('.pdf-viewer').count(),0)
  await press('2');await page.locator('.pdf-viewer').waitFor()
  await press('2');assert.equal(await page.locator('.pdf-viewer').count(),1)
  await press('Backslash');await page.locator('.pdf-viewer').waitFor({state:'detached'})
  await press('Backslash');await page.locator('.pdf-viewer').waitFor()
  assert.equal(await page.evaluate(()=>window.fileManager.getCurrentPath()),originalPath)
  for(const [key,word,wrapped] of [['b','Boldword',String.raw`\textbf{Boldword}`],['i','italicword',String.raw`\textit{italicword}`],['Shift+m','mathword','$mathword$']]){
    await select(word);await press(key);assert.ok((await state()).text.includes(wrapped),`${key} wraps source`)
  }
  await page.waitForTimeout(400)
  await select(null);await press('Shift+Enter');assert.equal((await state()).line,3)
  await press('Shift+Enter');assert.equal((await state()).line,6)
  await press('Shift+Enter');assert.equal((await state()).line,3,'next section wraps')
  // Arrow keys must not page the PDF while editing source or a page-number field.
  await page.getByTitle('Go to page',{exact:true}).click();await page.getByRole('textbox',{name:'Page number',exact:true}).fill('1');await page.getByRole('textbox',{name:'Page number',exact:true}).press('Enter')
  await select('Boldword');await page.keyboard.press('ArrowRight');assert.equal(await page.locator('.page-info').innerText(),'1 / 2')
  await page.getByTitle('Go to page',{exact:true}).click();await page.getByRole('textbox',{name:'Page number',exact:true}).press('ArrowRight');await page.keyboard.press('Escape')
  assert.equal(await page.locator('.page-info').innerText(),'1 / 2')
  await page.locator('.pdf-viewer').focus();await page.keyboard.press('ArrowRight');await page.getByRole('button',{name:'Go to page, current page 2 of 2',exact:true}).waitFor()
  await page.keyboard.press('ArrowLeft');await page.getByRole('button',{name:'Go to page, current page 1 of 2',exact:true}).waitFor()
  await page.screenshot({path:`${artifacts}/${kind}-${platform}.png`})
  // New document is last so earlier checks retain their fixture.
  await select('Boldword');await press('n')
  await page.waitForFunction(previous=>window.fileManager.getCurrentPath()!==previous,originalPath)
  await page.waitForFunction(async()=>{const {EditorView}=await import('/node_modules/.vite/deps/@codemirror_view.js');return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.length===0})
  assert.match(await page.evaluate(()=>window.fileManager.getCurrentPath()),/untitled(?:-\d+)?\.tex$/)
  assert.deepEqual(errors,[])
  console.log('PASS',kind,platform,'all 10 Help shortcuts; section wrap; layout idempotence; formatting; PDF arrow focus isolation; new document')
 }catch(error){console.log('KEY EVENTS',await page.evaluate(()=>window.keyAudit.slice(-14)));await page.screenshot({path:`${artifacts}/${kind}-${platform}-failure.png`});throw error}
 finally{await browser.close()}
}
