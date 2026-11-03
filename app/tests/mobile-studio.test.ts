import { describe, expect, test } from 'bun:test'
import { actionableErrors, inputContext, relativeFilePath, diagnosticPath, buildInsertion, initialForm, citationKeys } from '../src/components/MobileStudio/model'
import { parseSyncTeX, forwardSync, inverseSync } from '../src/utils/synctex'
const context = (source: string) => inputContext(source, source.length)

describe('mobile writing context', () => {
  test('distinguishes math, escaped dollars, comments, and closed environments', () => {
    for (const text of ['$x', '$$x', '\\[x', '\\(x', '\\begin{align*}\nx']) expect(context(text).kind).toBe('math')
    for (const text of ['price \\$3', '% $x\ntext', '$x$ text', '$$x$$ text', '\\[x\\] text', '\\begin{align*}x\\end{align*}']) expect(context(text).kind).toBe('text')
  })
  test('completes only the current key, retaining earlier citations', () => {
    const text = '\\cite[see]{first,ch'
    const result = context(text)
    expect(result.kind).toBe('citation')
    expect(result.query).toBe('ch')
    expect(text.slice(0, result.from)).toBe('\\cite[see]{first,')
  })
  test('recognizes image, input and bibliography arguments', () => {
    for (const command of ['includegraphics[width=0.8\\linewidth]', 'input', 'include', 'addbibresource', 'bibliography']) {
      expect(context(`\\${command}{chap`).kind).toBe('file')
    }
  })
  test('resolves nested project files and diagnostic paths', () => {
    expect(relativeFilePath('/project/src/chapters/main.tex', '/project/src/images/plot.png')).toBe('../images/plot.png')
    expect(diagnosticPath('chapters/main.tex', '/project/src/chapters/main.tex')).toBe('/project/src/chapters/main.tex')
    expect(diagnosticPath('../appendix.tex', '/project/src/chapters/main.tex')).toBe('/project/src/appendix.tex')
    expect(diagnosticPath('../../../outside.tex', '/project/src/chapters/main.tex')).toBe('/project/src/chapters/main.tex')
  })
  test('collects bibliography entry keys without string and preamble directives', () => {
    expect(citationKeys('@string{journal="J"}\n@article{chris2026, title={Research}}\n@book{notes, title={Notes}}')).toEqual(['chris2026', 'notes'])
  })
})
describe('mobile insertion source', () => {
  test('escapes prose, preserves blank table cells and math commands', () => {
    const table = buildInsertion('table', { ...initialForm, table: 'A & B\t30%\n\t', caption: 'Costs_2026' })
    expect(table.source).toContain('A \\& B & 30\\%')
    expect(table.source).toContain('\n &  \\\\\n')
    expect(table.source).toContain('\\caption{Costs\\_2026}')
    expect(buildInsertion('equation', { ...initialForm, numerator: '\\alpha^2' }).source).toContain('\\frac{\\alpha^2}{y}')
    expect(buildInsertion('section', { ...initialForm, heading: 'A & B' }).source).toBe('\\section{A \\& B}')
  })
  test('rejects missing files and malformed citation arguments', () => {
    expect(buildInsertion('figure', initialForm).error).toBeTruthy()
    expect(buildInsertion('citation', { ...initialForm, citeKey: 'bad}key' }).error).toBeTruthy()
    const image = buildInsertion('figure', { ...initialForm, file: '../images/plot.png' })
    expect(image.error).toBeUndefined()
    expect(image.package).toBe('graphicx')
    expect(image.source).toContain('{../images/plot.png}')
  })
})
test('SyncTeX positions use top-left coordinates on both Letter and A4 pages', () => {
  const parsed = parseSyncTeX('SyncTeX Version:1\nInput:1:main.tex\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\nx1,3:4736287,9472573\nx1,8:4736287,28417720\n}1\nPostamble:\nCount:2')!
  for (const height of [792, 841.89]) {
    const location = forwardSync(parsed, 3, 'main.tex', height)!
    expect(location.x).toBeCloseTo(72, 2)
    expect(location.y).toBeCloseTo(144, 2)
    expect(inverseSync(parsed, 1, 72, 144, height)?.line).toBe(3)
    expect(inverseSync(parsed, 1, 72, 432, height)?.line).toBe(8)
  }
})

test('error cards omit duplicate shutdown summaries but retain a lone fatal failure', () => {
  const specific = { type: 'error' as const, message: 'Undefined control sequence.', line: 3 }
  const fatal = { type: 'error' as const, message: '==> Fatal error occurred, no output PDF file produced!', line: 3 }
  expect(actionableErrors([specific, fatal, specific])).toEqual([specific])
  expect(actionableErrors([fatal])).toEqual([fatal])
})
