import { expect, test } from 'bun:test'
import { loadCompilationFiles, compilationContext } from '../src/services/CompilationFiles'

test('resolves local nested TeX, bibliography, style and binary image dependencies', async () => {
  const encoder = new TextEncoder()
  const entries = new Map<string, Uint8Array>([
    ['/project/src/chapters/one.tex', encoder.encode('Chris \\input{chapters/two} \\includegraphics{figure}')],
    ['/project/src/chapters/two.tex', encoder.encode('\\input{chapters/one} nested text')],
    ['/project/src/refs.bib', encoder.encode('@book{test,title={Example}}')],
    ['/project/src/local.sty', encoder.encode('custom style')],
    ['/project/src/figure.png', new Uint8Array([0,255,128,42])],
  ])
  const files = await loadCompilationFiles('\\input{chapters/one} \\bibliography{refs} \\usepackage{local}',
    '/project/src/main.tex', async path => entries.get(path) ?? null)
  expect(Object.keys(files).sort()).toEqual(['chapters/one.tex','chapters/two.tex','figure.png','local.sty','refs.bib'])
  expect(files['chapters/one.tex']).toContain('Chris')
  expect(files['figure.png']).toEqual(new Uint8Array([0,255,128,42]))
})


test('nested main documents resolve parent references inside the project root', async () => {
 const encoder = new TextEncoder()
 const entries = new Map([
  ['/project/src/shared.tex', encoder.encode('Shared')],
  ['/project/src/revision/sections/intro.tex', encoder.encode('Intro')],
  ['/project/src/revision/figures/plot.pdf', new Uint8Array([1,2,3])],
 ])
 const reads: string[] = []
 const files = await loadCompilationFiles('\\input{../shared} \\input{sections/intro} \\includegraphics{figures/plot} \\input{../../outside}',
  '/project/src/revision/main.tex', async path => { reads.push(path); return entries.get(path) ?? null })
 expect(compilationContext('/project/src/revision/main.tex').mainFile).toBe('revision/main.tex')
 expect(compilationContext('/git/revision/main.tex').mainFile).toBe('revision/main.tex')
 expect(Object.keys(files).sort()).toEqual(['revision/figures/plot.pdf','revision/sections/intro.tex','shared.tex'])
 expect(reads.every(path=>path.startsWith('/project/src/'))).toBe(true)
})
