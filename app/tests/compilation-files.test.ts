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

test('mounts local listing, attachment, bibliography style, and table data files', async () => {
  const entries = new Map<string, Uint8Array>([
    ['IataCode.java', new Uint8Array([67, 108, 97, 115, 115])],
    ['Jungle.java', new Uint8Array([0x80, 0xff])],
    ['kapitalertraege.csv', new Uint8Array([0xff, 59, 42])],
    ['messergebnisse.csv', new Uint8Array([120, 44, 121])],
    ['data.csv', new Uint8Array([120, 32, 121])],
    ['itmalpha.bst', new Uint8Array([66, 73, 66])],
  ])
  const source = [
    '\\lstinputlisting[style=demostyle]{IataCode.java}',
    '\\attachfile{Jungle.java}',
    '\\csvreader[before reading={\\def\\value[units]{0}},separator=semicolon]{kapitalertraege.csv}{}{}',
    '\\DTLloaddb[noheader,keys={x,y}]{measurements}{messergebnisse.csv}',
    '\\addplot3+[surf] table[col sep=comma,point meta=\\thisrow{steps}] {data.csv};',
    '\\bibliographystyle{itmalpha}',
  ].join('\n')
  const files = await loadCompilationFiles(source, '/project/src/work/main.tex',
    async path => entries.get(path.replace('/project/src/work/', '')) ?? null)
  expect(Object.entries(files)).toEqual([...entries].map(([path, bytes]) => ['work/' + path, bytes]))
})

test('loads starred graphics from literal graphicspath directories', async () => {
  const image = new Uint8Array([0xff, 0xd8, 0xff])
  const reads: string[] = []
  const source = [
    '\\graphicspath{{missing/}{../figures/}}',
    '\\includegraphics*[width=5cm,alt={Plot [A]}]{"office screenshot"}',
    '\\includegraphics*{"office screenshot"}',
    '\\% \\includegraphics*{direct.jpg}',
    '% \\includegraphics{commented}',
    '\\\\includegraphics{ordinary-text}',
    '\\includegraphics{\\generatedname}',
    '\\includegraphics{../../../outside}',
  ].join('\n')
  const files = await loadCompilationFiles(source, '/project/src/chapter/main.tex', async path => {
    reads.push(path)
    return ['/project/src/figures/office screenshot.jpg', '/project/src/chapter/direct.jpg'].includes(path) ? image : null
  })
  expect(Object.keys(files)).toEqual(['figures/office screenshot.jpg', 'chapter/direct.jpg'])
  expect(reads.length).toBe(new Set(reads).size)
  expect(reads.some(path => /commented|ordinary-text|generatedname|outside/.test(path))).toBe(false)
})

test('resolves import scopes, nested imports, and later main-directory inputs', async () => {
  const encode = (source: string) => new TextEncoder().encode(source)
  const entries = new Map<string, Uint8Array>([
    ['sections/chapter.tex', encode('\\subimport{part/}{intro} \\input{notes} \\includegraphics{cover}')],
    ['sections/part/intro.tex', encode('\\input "extra details"')],
    ['sections/part/extra details.tex', encode('More detail.')],
    ['sections/notes.tex', encode('\\input{chapter}')],
    ['sections/cover.png', new Uint8Array([0xff])],
    ['notes.tex', encode('Main document notes.')],
  ])
  const files = await loadCompilationFiles('\\import{sections/}{chapter} \\input{notes}',
    '/project/src/book/main.tex', async path => entries.get(path.replace('/project/src/book/', '')) ?? null)
  expect(Object.keys(files).sort()).toEqual([...entries.keys()].map(path => 'book/' + path).sort())
})

test('finds local Beamer themes and TeX files with dotted names', async () => {
  const encode = (source: string) => new TextEncoder().encode(source)
  const entries = new Map([
    ['beamerthemeFeather.sty', encode('\\RequirePackage{local-colors}')],
    ['local-colors.sty', encode('Local colors')],
    ['quadratic-case-2.1.tex', encode('A quadratic example')],
  ])
  const files = await loadCompilationFiles('\\usetheme{Feather} \\input{quadratic-case-2.1}',
    '/project/src/main.tex', async path => entries.get(path.replace('/project/src/', '')) ?? null)
  expect(Object.keys(files)).toEqual([...entries.keys()])
})

test('loads glossary entries through the optional glossary selector', async () => {
  const entries = new TextEncoder().encode('\\newglossaryentry{item}{name=Item,description={Local glossary entry}}')
  const files = await loadCompilationFiles('\\loadglsentries[main]{glossary}',
    '/project/src/book/main.tex', async path => path === '/project/src/book/glossary.tex' ? entries : null)
  expect(files['book/glossary.tex']).toContain('Local glossary entry')
})

test('mounts literal standalone source and prebuilt PDF through one-argument wrappers', async () => {
  const source = [
    '\\def\\galleryimage#1{\\adjustbox{width=4cm}{\\includestandalone{#1}}}',
    '\\newcommand*{\\example}[1]{\\includestandalone[mode=tex,width={2cm}]{#1}}',
    '\\galleryimage{figures/one} \\example{figures/two}',
    '\\includestandalone[mode=image]{figures/three}',
  ].join('\n')
  const encode = (value: string) => new TextEncoder().encode(value)
  const entries = new Map([
    ['figures/one.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46])],
    ['figures/one.tex', encode('\\input{shared}')],
    ['figures/two.tex', encode('Another figure')],
    ['figures/three.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46])],
    ['shared.tex', encode('Shared definitions')],
  ])
  const files = await loadCompilationFiles(source, '/project/src/book/main.tex',
    async path => entries.get(path.replace('/project/src/book/', '')) ?? null)
  expect(Object.keys(files).sort()).toEqual([...entries.keys()].map(path => 'book/' + path).sort())
  expect(files['book/figures/one.pdf']).toEqual(entries.get('figures/one.pdf')!)
})

test('leaves dynamic standalone arguments, optional wrappers, and comments to TeX', async () => {
  const source = [
    '\\figure{before-definition}',
    '\\def\\figure#1{\\includestandalone{#1}}',
    '\\def\\modified#1{\\includestandalone{prefix-#1}}',
    '\\def\\delimited#1;{\\includestandalone{#1}}',
    '\\def\\outer#1{\\figure{#1}}',
    '\\newcommand{\\optional}[1][default]{\\includestandalone{#1}}',
    '\\def\\redefined#1{\\includestandalone{#1}} \\let\\redefined\\relax',
    '% \\def\\commented#1{\\includestandalone{#1}}',
    '% \\figure{commented-use} \\includestandalone{commented-direct}',
    '\\% \\figure{escaped-percent}',
    '\\\\figure{escaped-command}',
    '\\figure[width=2cm]{not-a-wrapper-option}',
    '\\figure{\\generatedname} \\includestandalone{\\generatedname}',
    '\\commented{not-defined} \\modified{dynamic} \\delimited{delimited}',
    '\\outer{nested-wrapper} \\optional{optional} \\redefined{redefined}',
  ].join('\n')
  const reads: string[] = []
  await loadCompilationFiles(source, '/project/src/main.tex', async path => {
    reads.push(path)
    return null
  })
  expect(reads).toEqual(['/project/src/escaped-percent.pdf', '/project/src/escaped-percent.tex'])
})

test('a regular article keeps its existing dependency reads', async () => {
  const source = '\\documentclass{article}\\begin{document}A regular article.\\end{document}'
  const reads: string[] = []
  const files = await loadCompilationFiles(source, '/project/src/main.tex', async path => {
    reads.push(path)
    return null
  })
  expect(reads).toEqual(['/project/src/article.cls'])
  expect(Object.keys(files)).toEqual([])
})

test('loads literal Flashcards paper configurations next to the main source', async () => {
  const encoder = new TextEncoder()
  const config = '\\newcommand{\\cardpaper}{a4paper}\\input{card-dimensions}'
  const entries = new Map([
    ['/project/src/revision/mycards.cfg', encoder.encode(config)],
    ['/project/src/revision/card-dimensions.tex', encoder.encode('dimensions')],
  ])
  const reads: string[] = []
  const files = await loadCompilationFiles('\\documentclass[mycards, frame, fronts]{flashcards}', '/project/src/revision/main.tex',
    async path => { reads.push(path); return entries.get(path) ?? null })
  expect(files['revision/mycards.cfg']).toBe(config)
  expect(files['revision/card-dimensions.tex']).toBe('dimensions')
  expect(reads).toEqual([
    '/project/src/revision/flashcards.cls',
    '/project/src/revision/mycards.cfg',
    '/project/src/revision/card-dimensions.tex',
  ])
})

test('recognizes a literal Flashcards config in a local wrapper and skips dynamic or other-class options', async () => {
  const reads: string[] = []
  const wrapper = new TextEncoder().encode('\\LoadClass[a7cards,grid]{flashcards}')
  await loadCompilationFiles([
    '\\documentclass[mycards]{wrapper}',
    '\\documentclass[names={one,unrelated,two}]{flashcards}',
  ].join('\n'), '/project/src/main.tex', async path => {
    reads.push(path)
    return path === '/project/src/wrapper.cls' ? wrapper : null
  })
  expect(reads).toEqual(['/project/src/wrapper.cls', '/project/src/flashcards.cls', '/project/src/a7cards.cfg'])
})

test('mounts only minted 3 highlight and style files beside an unchanged nested source', async () => {
  const cachePath = '/project/src/slides/_minted'
  const highlight = '6D1AB2CA9389B192F1CA97F430E212CB.highlight.minted'
  const entries = new Map([
    ['/project/src/slides/IataCode.java', new Uint8Array([0x49, 0x61, 0x74, 0x61])],
    [cachePath + '/default.style.minted', new Uint8Array([0xff, 0x2f])],
    [cachePath + '/' + highlight, new Uint8Array([0x34, 0x42])],
  ])
  const source = '\\usepackage{minted}\\inputminted{java}{IataCode.java}'
  const reads: string[] = []
  const cacheOps: string[] = []
  const files = await loadCompilationFiles(source, '/project/src/slides/main.tex', async path => {
    reads.push(path)
    return entries.get(path) ?? null
  }, {
    async listFiles(path) {
      cacheOps.push('list ' + path)
      return ['default.style.minted', highlight, highlight, '../unsafe.style.minted', 'other/unsafe.style.minted',
        'default.pygstyle', 'x.highlight.minted', '_job.config.minted', '_job.index.minted']
    },
    async fileSize(path) {
      cacheOps.push('stat ' + path)
      return entries.get(path)?.byteLength ?? null
    },
    async readRawBinary(path) {
      cacheOps.push('read ' + path)
      return entries.get(path) ?? null
    },
  })
  expect(reads).toEqual(['/project/src/slides/minted.sty', '/project/src/slides/IataCode.java'])
  expect(cacheOps).toEqual(['list ' + cachePath, 'stat ' + cachePath + '/default.style.minted',
    'stat ' + cachePath + '/' + highlight, 'read ' + cachePath + '/default.style.minted', 'read ' + cachePath + '/' + highlight])
  expect(Object.entries(files)).toEqual([...entries].map(([path, data]) => [path.slice('/project/src/'.length), data]))
})

test('loads a literal minted cache directory relative to the main file even from a local style', async () => {
  const entries = new Map([
    ['/git/review/local.sty', new TextEncoder().encode('\\RequirePackage[frozencache,cachedir={./build/cache}]{minted}')],
    ['/git/review/build/cache/default.style.minted', new Uint8Array([0x41])],
  ])
  const lists: string[] = []
  const files = await loadCompilationFiles('\\usepackage{local}', '/git/review/main.tex',
    async path => entries.get(path) ?? null, {
      async listFiles(path) {
        lists.push(path)
        return ['default.style.minted']
      },
      async fileSize(path) { return entries.get(path)?.byteLength ?? null },
      async readRawBinary(path) { return entries.get(path) ?? null },
    })
  expect(lists).toEqual(['/git/review/build/cache'])
  expect(files['review/build/cache/default.style.minted']).toEqual(new Uint8Array([0x41]))
})

test('does not list caches for ordinary, disabled, or unsupported minted sources', async () => {
  const lists: string[] = []
  for (const source of [
    '\\documentclass{article}\n% \\usepackage[frozencache]{minted}\n',
    '\\usepackage[cache=false]{minted}',
    '\\usepackage[placeholder]{minted}',
    '\\usepackage[verbatim=true]{minted}',
    '\\usepackage[cachedir={../outside}]{minted}',
    '\\usepackage[cachedir=/outside]{minted}',
    '\\usepackage[cachedir=\\cacheDirectory]{minted}',
    '\\usepackage[cache=unknown]{minted}',
    '\\usepackage[cachedir=' + 'a'.repeat(1024) + ']{minted}',
  ]) {
    await loadCompilationFiles(source, '/project/src/main.tex', async () => null, {
      async listFiles(path) { lists.push(path); return [] },
      async fileSize() { throw new Error('Unexpected cache stat') },
      async readRawBinary() { throw new Error('Unexpected cache read') },
    })
  }
  expect(lists).toEqual([])
})

test('oversized or changed minted caches fall back without mounting a partial cache', async () => {
  const source = '\\usepackage[frozencache]{minted}\\input{chapter}'
  const mainFile = '/project/src/main.tex'
  const read = async (path: string) => path.endsWith('/chapter.tex') ? new TextEncoder().encode('Chapter') : null
  const normalFiles = { 'chapter.tex': 'Chapter' }
  const names = ['default.style.minted', 'friendly.style.minted']
  const stats: string[] = []
  const reads: string[] = []

  const byCount = await loadCompilationFiles(source, mainFile, read, {
    async listFiles() { return Array.from({ length: 257 }, (_, i) => i + '.style.minted') },
    async fileSize(path) { stats.push(path); return 1 },
    async readRawBinary(path) { reads.push(path); return new Uint8Array([1]) },
  })
  expect(byCount).toEqual(normalFiles)
  expect(stats).toEqual([])
  expect(reads).toEqual([])

  const bySize = await loadCompilationFiles(source, mainFile, read, {
    async listFiles() { return names },
    async fileSize(path) { return path.endsWith(names[0]) ? 1 : 8 * 1024 * 1024 },
    async readRawBinary(path) { reads.push(path); return new Uint8Array([1]) },
  })
  expect(bySize).toEqual(normalFiles)
  expect(reads).toEqual([])

  const changed = await loadCompilationFiles(source, mainFile, read, {
    async listFiles() { return names },
    async fileSize() { return 1 },
    async readRawBinary(path) { return new Uint8Array(path.endsWith(names[0]) ? [1] : [1, 2]) },
  })
  expect(changed).toEqual(normalFiles)

  const unavailable = await loadCompilationFiles(source, mainFile, read, {
    async listFiles() { return names },
    async fileSize() { throw new Error('File disappeared') },
    async readRawBinary(path) { reads.push(path); return new Uint8Array([1]) },
  })
  expect(unavailable).toEqual(normalFiles)
  expect(reads).toEqual([])
})

test('loads a literal image passed to a local two-argument graphics wrapper', async () => {
  const encoder = new TextEncoder()
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const style = encoder.encode(String.raw`\newcommand {\framedgraphic}[2] {
    \begin{frame}{#1}\includegraphics[alt={File [A]}]{#2}\end{frame}
  }`)
  const source = String.raw`\framedgraphic{too early}{../images/early.png}
\usepackage{../templates/myStyle}
\input{closing}
\framedgraphic{Dynamic}{\generated}
\framedgraphic{Outside}{../../outside.png}
% \framedgraphic{Commented}{../images/comment.png}`
  const reads: string[] = []
  const files = await loadCompilationFiles(source, '/project/src/talk/main.tex', async path => {
    reads.push(path)
    if (path === '/project/src/templates/myStyle.sty') return style
    if (path === '/project/src/talk/closing.tex') {
      return encoder.encode(String.raw`\framedgraphic{Title {A}}{../images/Teach-yourself-C++-in-21-days.png}`)
    }
    return path === '/project/src/images/Teach-yourself-C++-in-21-days.png' ? image : null
  })
  expect(reads).toEqual([
    '/project/src/templates/myStyle.sty', '/project/src/talk/closing.tex',
    '/project/src/images/Teach-yourself-C++-in-21-days.png',
  ])
  expect(files['images/Teach-yourself-C++-in-21-days.png']).toEqual(image)
})

test('does not infer graphics after a conflicting style declaration or from a dynamic wrapper', async () => {
  const encoder = new TextEncoder()
  const reads: string[] = []
  const source = String.raw`\usepackage{local,conflicting}
\framedgraphic{title}{ignored.png}
\dynamicgraphic{title}{dynamic.png}
\optionalgraphic{title}{optional.png}`
  await loadCompilationFiles(source, '/project/src/main.tex', async path => {
    reads.push(path)
    if (path === '/project/src/local.sty') return encoder.encode(String.raw`
\newcommand{\framedgraphic}[2]{\includegraphics{#2}}
\newcommand{\dynamicgraphic}[2]{\includegraphics{prefix-#2}}
\newcommand{\optionalgraphic}[2][caption]{\includegraphics{#2}}`)
    if (path === '/project/src/conflicting.sty') return encoder.encode(String.raw`\let\framedgraphic\relax`)
    return null
  })
  expect(reads).toEqual(['/project/src/local.sty', '/project/src/conflicting.sty'])
})

test('inherits only active literal graphics wrappers into later input children', async () => {
  const encoder = new TextEncoder()
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const definitions = String.raw`\newcommand{\showgraphic}[2]{\includegraphics[alt={Title [A]}]{#2}}`
  const source = [String.raw`\input{early}`, String.raw`\input{reused}`, definitions,
    String.raw`\input{reused}`, String.raw`\include{nested}`, String.raw`\input{conflict}`].join('\n')
  const entries = new Map<string, Uint8Array>([
    ['early.tex', encoder.encode(String.raw`\showgraphic{Early}{images/early.png}`)],
    ['reused.tex', encoder.encode(String.raw`\showgraphic{Late}{images/reused.png}`)],
    ['nested.tex', encoder.encode(String.raw`\input{grandchild}`)],
    ['grandchild.tex', encoder.encode(String.raw`\showgraphic{Nested}{images/grandchild.png}`)],
    ['conflict.tex', encoder.encode(String.raw`\let\showgraphic\relax\showgraphic{Conflict}{images/conflict.png}`)],
    ['images/reused.png', image],
    ['images/grandchild.png', image],
  ])
  const reads: string[] = []
  const files = await loadCompilationFiles(source, '/project/src/talk/main.tex', async path => {
    reads.push(path)
    return entries.get(path.replace('/project/src/talk/', '')) ?? null
  })
  expect(Object.keys(files)).toEqual([
    'talk/early.tex', 'talk/reused.tex', 'talk/images/reused.png', 'talk/nested.tex',
    'talk/grandchild.tex', 'talk/images/grandchild.png', 'talk/conflict.tex',
  ])
  expect(reads.filter(path => path.endsWith('reused.tex'))).toHaveLength(1)
  expect(reads.some(path => /early\.png|conflict\.png/.test(path))).toBe(false)
})

test('keeps conflicted inherited wrappers out of later grandchildren', async () => {
  const encoder = new TextEncoder()
  const source = String.raw`\newcommand{\image}[2]{\includegraphics{#2}}\input{child}`
  const entries = new Map([
    ['child.tex', String.raw`\RenewDocumentCommand{\image}{m m}{#1}\input{grandchild}`],
    ['grandchild.tex', String.raw`\image{caption}{do-not-read.png}`],
  ])
  const reads: string[] = []
  await loadCompilationFiles(source, '/project/src/main.tex', async path => {
    reads.push(path)
    const value = entries.get(path.replace('/project/src/', ''))
    return value ? encoder.encode(value) : null
  })
  expect(reads).toEqual(['/project/src/child.tex', '/project/src/grandchild.tex'])
})

test('keeps a recognized child-local wrapper ahead of an inherited graphics wrapper', async () => {
  const encoder = new TextEncoder()
  const source = String.raw`\newcommand{\custom}[2]{\includegraphics{#2}}\input{child}`
  const entries = new Map([
    ['/project/src/child.tex', String.raw`\def\custom#1{\includestandalone{#1}}\custom{nested}`],
    ['/project/src/nested.tex', 'Standalone figure'],
  ])
  const files = await loadCompilationFiles(source, '/project/src/main.tex', async path => {
    const entry = entries.get(path)
    return entry === undefined ? null : encoder.encode(entry)
  })
  expect(Object.keys(files)).toEqual(['child.tex', 'nested.tex'])
})


test('loads explicit font files as binary dependencies, including font-face commands', async () => {
  const bytes = new Uint8Array([0, 255, 128, 7])
  const source = String.raw`
\setmainfont{User Font.otf}
\setsansfont{Sans.ttf}
\setmonofont{Mono.ttc}
\setmathfont{Math.otf}
\newfontfamily\custom{Other.otf}
\newfontface{\other}[Color=blue]{Other.otf}
% \fontspec{commented.otf}
\\fontspec{ordinary-text.otf}
`
  const reads: string[] = []
  const files = await loadCompilationFiles(source, '/project/src/book/main.tex', async path => {
    reads.push(path)
    return bytes
  })
  expect(Object.keys(files)).toEqual(['book/User Font.otf', 'book/Sans.ttf', 'book/Mono.ttc', 'book/Math.otf', 'book/Other.otf'])
  expect(Object.values(files).every(value => value === bytes)).toBe(true)
  expect(reads).toHaveLength(5)
})

test('resolves literal font paths, extensions and wildcard style filenames', async () => {
  const bytes = new Uint8Array([0, 128, 1])
  const source = String.raw`
\setmainfont[Path={../fonts/},Extension=.otf,BoldFont=*-Bold,ItalicFont={*-Italic},RawFeature={+ss01,+ss02}]{Text}
\setsansfont{Sans.ttf}[Path=../fonts/]
\newfontfamily\local[Path={../fonts/}]{Bare}
`
  const entries = new Set(['fonts/Text.otf', 'fonts/Text-Bold.otf', 'fonts/Text-Italic.otf', 'fonts/Sans.ttf', 'fonts/Bare.otf'])
  const files = await loadCompilationFiles(source, '/project/src/book/main.tex', async path => entries.has(path.slice('/project/src/'.length)) ? bytes : null)
  expect(Object.keys(files)).toEqual([...entries])
})

test('does not treat font families, dynamic filenames or escaping paths as project font files', async () => {
  const source = String.raw`
\setmainfont{Latin Modern Roman}
\setmathfont{Latin Modern Math}
\fontspec{\generated.otf}
\setmainfont[Path=\fontdir]{User.otf}
\setmainfont[Path=../../../escape/]{User.otf}
\setsansfont{../../escape.ttf}
\newfontfamily\custom{Family Name}
\setmonofont[Extension=\fontext]{User}
`
  const reads: string[] = []
  const files = await loadCompilationFiles(source, '/project/src/book/main.tex', async path => { reads.push(path); return null })
  expect(reads).toEqual([])
  expect(Object.keys(files)).toEqual([])
})
