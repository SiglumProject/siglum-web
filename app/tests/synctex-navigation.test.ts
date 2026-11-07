import { afterEach, expect, test } from 'bun:test'
import service from '../src/services/SyncTexService'
import { parseSyncTeX, forwardSync, inverseSync, getPageCenterLine, getPageLineRange, getPageCount, sourceInputNumber, type SyncTexData } from '../src/utils/synctex'

afterEach(() => { service.clear(); service.releaseScrollLock() })

const wrap = (content: string, unit = 2) => `SyncTeX Version:1
Input:1:/project/main.tex
Input:2:/project/chapters/α.tex
Input:3:C:\\project\\appendix.tex
Magnification:1200
Unit:${unit}
X Offset:-32768
Y Offset:65536
Content:
${content}
Postamble:
Count:1`

test('indexed navigation matches full scans for inputs, coordinates and missing locations', () => {
  const lines: string[] = []
  for (let i = 0; i < 800; i++) {
    lines.push(`{${(i * 7) % 17 + 1}`, `[${i % 3 + 1},${(i * 13) % 200 + 1}:${i * 177 - 10000},${i * 419}:32768,65536,0`)
  }
  const raw = wrap(lines.join('\n')), parsed = parseSyncTeX(raw)!
  service.queueUpdate(raw)
  const names = [undefined, 'main.tex', 'α.tex', 'chapters/α.tex', 'appendix.tex', 'missing.tex', '/project/chapters/α.tex']
  for (let i = 0; i < 240; i++) {
    const line = i * 11 % 250, filename = names[i % names.length], page = i % 19
    expect(service.forwardSync(line, filename)).toEqual(forwardSync(parsed, line, filename))
    expect(service.inverseSync(page, i * 7 % 612, i * 19 % 792)).toEqual(inverseSync(parsed, page, i * 7 % 612, i * 19 % 792))
    expect(service.getCenterLineForPage(page)).toEqual(getPageCenterLine(parsed, page))
    expect(service.getLineRangeForPage(page)).toEqual(getPageLineRange(parsed, page))
  }
  expect(service.forwardSync(NaN)).toBeNull()
  expect(service.forwardSync(Infinity)).toBeNull()
  expect(service.inverseSync(1, NaN, 12)).toBeNull()
})

test('equal nearest-line ties retain first native occurrence, including repeated records', () => {
  const raw = wrap('{3\nx1,12:10,20\n{1\nx1,8:30,40\n{2\nx1,12:50,60')
  service.queueUpdate(raw)
  expect(service.forwardSync(10)?.page).toBe(3)
  expect(service.forwardSync(12)?.page).toBe(3)
  expect(service.getPageForLine(10)).toBe(3)
  expect(service.getPageForLine(12)).toBe(3)
})

test('filename matching preserves first suffix match and missing-name fallback', () => {
  const parsed = parseSyncTeX(wrap('{1\nx1,1:0,0'))!
  parsed.inputs = new Map([[2, '/nested/main.tex'], [1, 'main.tex'], [3, 'C:\\file\\α.tex']])
  expect(sourceInputNumber(parsed, 'main.tex')).toBe(2)
  expect(sourceInputNumber(parsed, 'α.tex')).toBe(3)
  expect(sourceInputNumber(parsed, 'missing')).toBe(1)
  expect(sourceInputNumber(parsed)).toBe(1)
})

test('cached page summaries preserve duplicates and do not expose mutable cached ranges', () => {
  service.queueUpdate(wrap('{2\nx1,5:0,0\nx2,11:1,1\nx1,11:2,2\nx1,9:3,3'))
  expect(service.getCenterLineForPage(2)).toBe(11)
  const range = service.getLineRangeForPage(2)!
  expect(range).toEqual({ first: 5, last: 11 })
  range.first = -100
  expect(service.getLineRangeForPage(2)).toEqual({ first: 5, last: 11 })
  service.queueUpdate(wrap('{2\nx1,77:0,0', 3))
  expect(service.getCenterLineForPage(2)).toBe(77)
  expect(service.getLineRangeForPage(2)).toEqual({ first: 77, last: 77 })
  service.clear()
  expect(service.getCenterLineForPage(2)).toBeNull()
  expect(service.getLineRangeForPage(2)).toBeNull()
})

test('empty replacement removes old input and page indexes', () => {
  service.queueUpdate(wrap('{2\nx1,8:1,1'))
  expect(service.getPageForLine(8)).toBe(2)
  service.queueUpdate('')
  expect(service.forwardSync(8)).toBeNull()
  expect(service.inverseSync(2, 1, 1)).toBeNull()
  expect(service.getPageCount()).toBe(0)
  expect(service.getInputFiles().size).toBe(0)
})

test('large record arrays and dense pages avoid function argument limits', () => {
  const data: SyncTexData = { inputs: new Map([[1, 'main.tex']]), magnification: 1000, xOffset: 0, yOffset: 0, unitLength: 1,
    records: Array.from({ length: 200000 }, (_, i) => ({ inputNumber: 1, line: i + 1, page: 7, x: i, y: i })) }
  expect(getPageCount(data)).toBe(7)
  expect(getPageLineRange(data, 7)).toEqual({ first: 1, last: 200000 })
})


test('mapping identity guards shared preview consumers across replacement and clear', () => {
  const first = wrap('{1\nx1,3:1,2'), second = wrap('{1\nx1,7:3,4')
  service.queueUpdate(first)
  expect(service.matchesMapping(first)).toBe(true)
  expect(service.matchesMapping(second)).toBe(false)
  service.getPageCount()
  expect(service.matchesMapping(first)).toBe(true)
  service.queueUpdate(second)
  expect(service.matchesMapping(first)).toBe(false)
  expect(service.matchesMapping(second)).toBe(true)
  service.clear()
  expect(service.matchesMapping(second)).toBe(false)
})

test('inverse source candidates use the selected input and top-to-bottom coordinates', () => {
  service.queueUpdate(wrap('{1\nx1,9:0,800\nx1,3:0,100\nx1,9:0,500\nx2,7:0,300\nx2,2:0,50'))
  expect(service.getLinesForPage(1)).toEqual([3, 9])
  expect(service.getLinesForPage(1, 'chapters/α.tex')).toEqual([2, 7])
  expect(service.getLinesForPage(2, 'chapters/α.tex')).toEqual([])
})


test('canonical native paths resolve chapter edits rather than falling back to main', () => {
  const raw = wrap('{250\nx1,18:1,2\n{477\nx2,18:3,4').replace('Input:2:/project/chapters/α.tex', 'Input:2:/book/./chapters/chapter-20.tex')
  service.queueUpdate(raw)
  for (const filename of ['book/chapters/chapter-20.tex', '/book/chapters/chapter-20.tex', '/book/./chapters/chapter-20.tex', 'book/other/../chapters/chapter-20.tex']) {
    expect(service.forwardSync(18, filename)?.page).toBe(477)
    expect(service.getLinesForPage(477, filename)).toEqual([18])
  }
  const parsed = parseSyncTeX(raw)!
  expect(sourceInputNumber(parsed, 'book/chapters/chapter-20.tex')).toBe(2)
  expect(forwardSync(parsed, 18, 'book/chapters/chapter-20.tex')?.page).toBe(477)
  const exposed = service.getInputFiles(); exposed.set(2, 'changed.tex')
  expect(service.forwardSync(18, 'book/chapters/chapter-20.tex')?.page).toBe(477)
})
