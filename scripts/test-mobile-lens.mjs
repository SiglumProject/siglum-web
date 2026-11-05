import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const artifacts = process.env.SIGLUM_TEST_ARTIFACTS || join(tmpdir(), 'siglum-lens-tests');
mkdirSync(artifacts, { recursive: true });
for (const kind of (process.env.SIGLUM_TEST_BROWSER ? [process.env.SIGLUM_TEST_BROWSER] : ['chromium', 'webkit'])) {
  const browser = await (kind === 'chromium' ? chromium.launch({ headless: true }) : webkit.launch({ headless: true, executablePath: process.env.SIGLUM_WEBKIT_EXECUTABLE }));
  try {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const button = name => page.getByRole('button', { name, exact: true });
    await page.goto(process.env.SIGLUM_TEST_URL || 'http://127.0.0.1:5174/');
    await button('Open the editor').tap();
    await page.waitForFunction(async () => { const { default: service } = await import('/src/services/CompilerService.ts'); return service.getStatus() === 'success'; }, {}, { timeout: 60000 });
    await button('More tools; drag up to expand').tap(); await button('PDF lens').tap();
    const lens = page.getByRole('region', { name: 'Movable PDF lens', exact: true });
    const content = page.getByRole('region', { name: 'PDF lens content; scroll or drag to pan', exact: true });
    await lens.locator('canvas:visible').waitFor();
    await page.evaluate(async () => {
      const { EditorView } = await import('/node_modules/.vite/deps/@codemirror_view.js');
      window.lensTestEditor = EditorView.findFromDOM(document.querySelector('.cm-content'));
      window.lensTestEditor.focus();
    });
    const selection = await page.evaluate(() => lensTestEditor.state.selection.toJSON());
    const metrics = () => content.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop, width: el.clientWidth, height: el.clientHeight, fullWidth: el.scrollWidth, fullHeight: el.scrollHeight }));
    await content.evaluate(el => { el.scrollLeft = 100; el.scrollTop = 100; });
    const initial = await metrics();
    assert.ok(initial.fullWidth > initial.width * 2 && initial.fullHeight > initial.height * 3);
    const position = await lens.boundingBox();
    if (kind === 'chromium') {
      const cdp = await context.newCDPSession(page);
      const box = await content.boundingBox();
      const x = box.x + box.width - 35, y = box.y + box.height - 25;
      // Native phone scrolling locks diagonal gestures to the dominant axis.
      for (const [dx, dy] of [[16, 0], [0, 10]]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; step <= 8; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * dx, y: y - step * dy }] });
          await page.waitForTimeout(25);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(500);
      }
      const panned = await metrics();
      assert.ok(panned.x > initial.x + 50 && panned.y > initial.y + 25, 'native touch scrolls both axes');
      assert.deepEqual(await lens.boundingBox(), position, 'panning content does not move the lens');
    }
    // Mouse drag uses the same scroll surface, without hijacking native touch scroll.
    await content.evaluate(el => { el.scrollLeft = 100; el.scrollTop = 100; });
    const box = await content.boundingBox();
    await page.mouse.move(box.x + 160, box.y + 110); await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 60, { steps: 6 }); await page.mouse.up();
    let panned = await metrics();
    assert.ok(panned.x >= 160 && panned.y >= 145, 'mouse drag pans the PDF');
    if (kind === 'chromium') {
      await page.mouse.wheel(40, 80); await page.waitForTimeout(300);
      const wheeled = await metrics();
      assert.ok(wheeled.y > panned.y + 30, 'wheel scrolls the PDF');
    }
    assert.deepEqual(await lens.boundingBox(), position);
    assert.deepEqual(await page.evaluate(() => lensTestEditor.state.selection.toJSON()), selection);
    assert.ok(await page.evaluate(() => lensTestEditor.hasFocus), 'panning preserves editor focus');
    const beforeMove = await metrics();
    const header = await button('Move PDF lens').boundingBox();
    await page.mouse.move(header.x + 25, header.y + 20); await page.mouse.down();
    await page.mouse.move(header.x + 40, header.y + 90, { steps: 6 }); await page.mouse.up();
    assert.ok((await lens.boundingBox()).y > position.y + 40, 'header still moves the floating lens');
    assert.deepEqual(await metrics(), beforeMove, 'moving lens does not pan its PDF');
    await page.screenshot({ path: join(artifacts, `lens-${kind}-panned.png`) });
    for (const height of [240, 200]) {
      await page.setViewportSize({ width: 320, height }); await page.waitForTimeout(250);
      const bounds = await lens.boundingBox(), stage = await page.locator('.mobile-studio-stage').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= stage.y && bounds.y + bounds.height <= stage.y + stage.height, 'lens fits above keyboard controls');
      assert.ok((await metrics()).height >= 32);
      await content.evaluate(el => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; });
      const end = await metrics();
      assert.ok(end.x > 300 && end.y > 500, 'page edges remain reachable in a tiny lens');
      await page.screenshot({ path: join(artifacts, `lens-${kind}-${height}.png`) });
    }
    await button('Expand PDF lens').tap(); await page.locator('.mobile-pdf-page canvas').first().waitFor();
    await button('Back to source').tap(); await button('Close PDF lens').tap();
    assert.equal(await lens.count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS', kind, 'lens scroll, pan, header drag, source focus, tiny viewports, expand and close');
  } finally { await browser.close(); }
}
