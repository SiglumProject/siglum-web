// Real local compiler and native source selection/right-click in Chromium and WebKit.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const { chromium, webkit } = createRequire(require.resolve('@siglum/engine'))('playwright')
const artifacts = process.env.SIGLUM_TEST_ARTIFACTS || '/tmp/siglum-selection-menu'
mkdirSync(artifacts, { recursive: true })
const source = String.raw`\documentclass{article}
\begin{document}
First page introduction.
\newpage
\vspace*{12cm}
Second page unique marker destination.
\end{document}`
for (const kind of ['chromium', 'webkit']) {
  const browser = await (kind === 'chromium' ? chromium.launch({ headless: true }) : webkit.launch({ headless: true, executablePath: process.env.SIGLUM_WEBKIT_EXECUTABLE }))
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(30000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto('http://127.0.0.1:5174/')
    assert.equal(await page.getByRole('link', { name: 'Suggest an integration', exact: true }).getAttribute('href'), 'https://github.com/SiglumProject/siglum/issues/new?title=Integration%20request%3A%20')
    await page.getByRole('button', { name: 'Open the editor', exact: true }).click()
    await page.locator('.cm-content').waitFor()
    await page.waitForFunction(async () => (await import('/src/services/CompilerService.ts')).default.getStatus() === 'success', {}, { timeout: 90000 })
    await page.locator('.cm-content').fill(source)
    await page.waitForFunction(() => document.querySelector('.pdf-text-layer')?.textContent?.includes('First page introduction'), {}, { timeout: 90000 })
    // Zoom so the second-page target starts outside the visible area.
    await page.getByTitle('Zoom presets', { exact: true }).click()
    await page.getByRole('button', { name: '150%', exact: true }).click()
    await page.waitForTimeout(500)
    const coords = await page.evaluate(async () => {
      const { EditorView } = await import('/node_modules/.vite/deps/@codemirror_view.js')
      const view = EditorView.findFromDOM(document.querySelector('.cm-content'))
      window.menuTestView = view
      const start = view.state.doc.toString().indexOf('unique marker')
      return { start: view.coordsAtPos(start), end: view.coordsAtPos(start + 'unique marker'.length) }
    })
    const y = (coords.start.top + coords.start.bottom) / 2
    await page.mouse.move(coords.start.left, y)
    await page.mouse.down()
    await page.mouse.move(coords.end.left, y, { steps: 10 })
    await page.mouse.up()
    const selection = () => page.evaluate(() => { const v = window.menuTestView; const s = v.state.selection.main; return v.state.sliceDoc(s.from, s.to) })
    assert.equal(await selection(), 'unique marker')
    await page.mouse.click(coords.start.left + 12, y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Jump to PDF', exact: true }).waitFor()
    assert.equal(await selection(), 'unique marker', 'right-click preserves source selection')
    assert.equal(await page.locator('.page-info').innerText(), '1 / 2', 'opening menu does not navigate')
    await page.screenshot({ path: `${artifacts}/${kind}-menu.png` })
    await page.getByRole('menuitem', { name: 'Jump to PDF', exact: true }).click()
    await page.waitForFunction(() => {
      const span = [...document.querySelectorAll('.pdf-text-layer span')].find(el => el.textContent.includes('Second page unique'))
      if (!span) return false
      const text = span.getBoundingClientRect(), viewport = document.querySelector('.pdf-document').getBoundingClientRect()
      return text.top >= viewport.top && text.bottom <= viewport.bottom && text.left < viewport.right && text.right > viewport.left
    })
    assert.equal(await page.locator('.page-info').innerText(), '2 / 2')
    assert.equal(await selection(), 'unique marker', 'jump preserves selected text')
    await page.locator('.pdf-sync-indicator').waitFor({ state: 'visible' })
    await page.screenshot({ path: `${artifacts}/${kind}-jump.png` })
    // Same page, keyboard invocation and cancellation preserve source and selection.
    await page.locator('.cm-content').press('Shift+F10')
    await page.getByRole('menu', { name: 'Selection actions' }).waitFor()
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Copy')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('menu').count(), 0)
    assert.equal(await selection(), 'unique marker')
    await page.locator('.cm-content').press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Jump to PDF', exact: true }).click()
    assert.equal(await page.locator('.page-info').innerText(), '2 / 2')
    // Copy uses the original selection; menu remains within viewport edges.
    if (kind === 'chromium') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.locator('.cm-content').press('Shift+F10')
      await page.getByRole('menuitem', { name: 'Copy', exact: true }).click()
      await page.getByRole('menu').waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'unique marker')
      assert.equal(await selection(), 'unique marker')
    }
    await page.locator('.cm-content').evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1438, clientY: 898, button: 2 })))
    await page.getByRole('menu').waitFor({ state: 'visible' })
    const menuBox = await page.getByRole('menu').boundingBox()
    assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 1440 && menuBox.y + menuBox.height <= 900)
    await page.locator('.page-info').click()
    await page.getByRole('menu').waitFor({ state: 'detached' })
    // No rendered mapping: copy remains available, jump is disabled.
    await page.evaluate(async () => (await import('/src/services/SyncTexService.ts')).default.clear())
    await page.locator('.cm-content').press('Shift+F10')
    assert.equal(await page.getByRole('menuitem', { name: 'Jump to PDF', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    await page.locator('.cm-content').press('ArrowLeft')
    await page.mouse.click(coords.start.left + 12, y, { button: 'right' })
    assert.equal(await page.getByRole('menu').count(), 0, 'unselected text keeps native context menu')
    assert.deepEqual(errors, [])
    console.log('PASS', kind, 'native selection/right-click, cross-page zoomed jump, keyboard, dismissal, selection preservation, missing compilation, homepage link')
  } catch (error) {
    await page.screenshot({ path: `${artifacts}/${kind}-failure.png` })
    throw error
  } finally { await browser.close() }
}
