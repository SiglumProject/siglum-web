// Run against a local dev server; all documents live in isolated browser contexts.
// Chromium uses native touch input. WebKit exercises the touch handlers synthetically.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { chromium, webkit } = createRequire(require.resolve('@siglum/engine'))('playwright');
const base = process.env.SIGLUM_TEST_URL || 'http://127.0.0.1:5174/';
const artifacts = process.env.SIGLUM_TEST_ARTIFACTS || join(tmpdir(), 'siglum-pdf-tests');
mkdirSync(artifacts, { recursive: true });
import assert from 'node:assert/strict';
const source=String.raw`\documentclass{article}
\begin{document}
First page. Chris tests scrolling and zoom.
\[ E = mc^2 \]
\newpage
Second page. Readable content on a small phone.
\newpage
Third page. End of the scrolling test.
\end{document}`;
for(const kind of (process.env.SIGLUM_TEST_BROWSER ? [process.env.SIGLUM_TEST_BROWSER] : ['chromium','webkit'])) {
const browser=await (kind==='chromium'?chromium.launch({headless:true}):webkit.launch({headless:true,executablePath:process.env.SIGLUM_WEBKIT_EXECUTABLE}));
try {
const context=await browser.newContext({viewport:{width:320,height:568},isMobile:true,hasTouch:true,deviceScaleFactor:2});
await context.addInitScript(()=>{delete ReadableStream.prototype[Symbol.asyncIterator]});
const page=await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(base);await page.getByRole('button',{name:'Open the editor',exact:true}).click();await page.locator('.cm-content').waitFor();
await page.waitForFunction(async()=>{const {default:s}=await import('/src/services/CompilerService.ts');return s.getStatus()==='success'},{},{timeout:60000});await page.waitForTimeout(500);
await page.evaluate(async text=>{const {EditorView}=await import('/node_modules/.vite/deps/@codemirror_view.js');const view=EditorView.findFromDOM(document.querySelector('.cm-content'));view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text}});},source);
await page.getByRole('button',{name:'Compile document',exact:true}).click();await page.waitForTimeout(1500);await page.waitForFunction(async()=>{const {default:s}=await import('/src/services/CompilerService.ts');return s.getStatus()==='success'},{},{timeout:60000});
await page.getByRole('button',{name:'Preview PDF; hold to peek',exact:true}).tap();
await page.locator('.pdf-text-layer').getByText('First page. Chris tests scrolling and zoom.',{exact:true}).waitFor();assert.equal(await page.locator('.mobile-pdf-page').count(),3);
const scroll=page.locator('.mobile-pdf-scroll');
const metrics=()=>scroll.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft,width:el.scrollWidth,height:el.scrollHeight,clientWidth:el.clientWidth,clientHeight:el.clientHeight,pageWidth:document.querySelector('.mobile-pdf-page').getBoundingClientRect().width}));
const initial=await metrics();assert.ok(initial.height>initial.clientHeight*2);
let cdp;if(kind==='chromium')cdp=await context.newCDPSession(page);
async function touch(type,points) {if(cdp)await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y],id)=>({x,y,id}))});else await scroll.evaluate((el,{type,points})=>{const touches=points.map(([clientX,clientY],identifier)=>({identifier,target:el,clientX,clientY}));const event=new Event(({touchStart:'touchstart',touchMove:'touchmove',touchEnd:'touchend'})[type],{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:touches});el.dispatchEvent(event);},{type,points});}
if(cdp){await touch('touchStart',[[160,430]]);for(let y=420;y>=150;y-=15){await touch('touchMove',[[160,y]]);await page.waitForTimeout(20)}await touch('touchEnd',[]);await page.waitForTimeout(700);assert.ok((await metrics()).top>150,'native single-finger scroll');}else{await scroll.evaluate(el=>el.scrollTop=250)}
console.log(kind,'scroll',await metrics());
await scroll.evaluate(el=>el.scrollTop=80);await page.waitForTimeout(300);
await touch('touchStart',[[110,240],[210,340]]);for(let i=1;i<=6;i++){await touch('touchMove',[[110-i*8,240-i*8],[210+i*8,340+i*8]]);await page.waitForTimeout(30)}await touch('touchEnd',[]);await page.waitForTimeout(700);
const pinched=await metrics();assert.ok(pinched.pageWidth>initial.pageWidth*1.7,'pinch increases PDF size');assert.ok(pinched.width>pinched.clientWidth,'zoom permits horizontal scrolling');
assert.ok(await page.getByRole('button',{name:'Fit PDF to width'}).innerText()!=='100%Fit');
await scroll.evaluate(el => el.scrollTop = 0);
await page.screenshot({path:`${artifacts}/pdf-mobile-${kind}-zoom.png`});
console.log(kind,'pinch zoom',pinched);
if(cdp){const before=(await metrics()).left;await touch('touchStart',[[260,310]]);for(let x=245;x>=65;x-=15){await touch('touchMove',[[x,310]]);await page.waitForTimeout(20)}await touch('touchEnd',[]);await page.waitForTimeout(500);assert.ok((await metrics()).left>before+40,'native horizontal pan after pinch');}
await page.getByRole('button',{name:'Fit PDF to width'}).tap();await page.waitForTimeout(300);assert.equal(Math.round((await metrics()).pageWidth),304);assert.equal((await metrics()).left,0);
await page.getByRole('button',{name:'Zoom in PDF'}).tap();await page.waitForTimeout(300);assert.equal(Math.round((await metrics()).pageWidth),456);
await page.getByRole('button',{name:'Zoom out PDF'}).tap();await page.waitForTimeout(300);assert.equal(Math.round((await metrics()).pageWidth),304);
await scroll.evaluate(el=>el.scrollTop=el.scrollHeight);await page.locator('[data-page="3"] .pdf-text-layer').getByText('Third page. End of the scrolling test.',{exact:true}).waitFor();
assert.equal(await page.locator('.mobile-pdf-count').innerText(),'3 / 3');
const toolbar = await page.locator('.mobile-pdf-toolbar').evaluate(el => ({width: el.clientWidth, content: el.scrollWidth}));
assert.ok(toolbar.content <= toolbar.width, 'PDF controls fit the 320px viewport');
const filter=await page.locator('[data-page="3"] canvas').evaluate(el=>getComputedStyle(el).filter);assert.ok(filter.includes('invert(0.85)'));
await page.screenshot({path:`${artifacts}/pdf-mobile-${kind}-scroll.png`});
await page.setViewportSize({width:320,height:240});await page.waitForTimeout(300);const box=await scroll.boundingBox();assert.ok(box.height>90);await page.getByRole('button',{name:'Zoom in PDF'}).tap();assert.equal(Math.round((await metrics()).pageWidth),456);await page.screenshot({path:`${artifacts}/pdf-mobile-${kind}-tiny.png`});
assert.deepEqual(errors,[]);console.log('PASS',kind,'three pages, zoom buttons, pinch, fit, night mode, 320×568 and 320×240',errors);
}finally{await browser.close()}
}
