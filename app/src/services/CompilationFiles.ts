type FileData = string | Uint8Array

export function compilationContext(documentPath?: string) {
  const path = documentPath || '/project/src/document.tex'
  const root = path.startsWith('/project/src/') ? '/project/src'
    : '/' + path.split('/').filter(Boolean)[0]
  const mainFile = path.slice(root.length + 1)
  const directory = mainFile.includes('/') ? mainFile.slice(0, mainFile.lastIndexOf('/')) : ''
  return { root, mainFile, directory }
}

function resolvePath(directory: string, name: string): string | null {
  const parts: string[] = []
  const path = name.startsWith('/') ? name : directory + '/' + name
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

type FileRule = {
  extensions?: string[]
  argument?: 1 | 2
  list?: boolean
  prefix?: string
}

const tex = { extensions: ['.tex'] }
const bibliography = { extensions: ['.bib'] }
const style = { extensions: ['.sty'], list: true }
const classFile = { extensions: ['.cls'] }
const maxMintedCacheFiles = 256
const maxMintedCacheBytes = 8 * 1024 * 1024
const mintedCacheFile = /^(?:[A-Za-z0-9_-]+\.style|[A-F0-9]{32}\.highlight)\.minted$/
const packageDeclarations = new Set(['usepackage', 'RequirePackage', 'RequirePackageWithOptions'])
const flashcardsFlags = new Set(['dvips', 'grid', 'frame', 'fronts', 'backs'])
const rules: Record<string, FileRule> = {
  input: tex,
  include: tex,
  loadglsentries: tex,
  usepackage: style,
  RequirePackage: style,
  RequirePackageWithOptions: style,
  documentclass: classFile,
  LoadClass: classFile,
  LoadClassWithOptions: classFile,
  bibliography: { ...bibliography, list: true },
  addbibresource: bibliography,
  bibliographystyle: { extensions: ['.bst'] },
  includegraphics: { extensions: ['.pdf', '.png', '.jpg', '.jpeg', '.eps'] },
  includepdf: { extensions: ['.pdf'] },
  usetheme: { ...style, prefix: 'beamertheme' },
  usecolortheme: { ...style, prefix: 'beamercolortheme' },
  usefonttheme: { ...style, prefix: 'beamerfonttheme' },
  useinnertheme: { ...style, prefix: 'beamerinnertheme' },
  useoutertheme: { ...style, prefix: 'beameroutertheme' },
  lstinputlisting: {},
  verbatiminput: {},
  inputminted: { argument: 2 },
  attachfile: {},
  textattachfile: {},
  csvreader: {},
  csvautotabular: {},
  csvautolongtable: {},
  DTLloaddb: { argument: 2 },
  DTLloadrawdb: { argument: 2 },
  pgfplotstableread: {},
  pgfplotstabletypeset: {},
  addplot: {},
}

const imports = ['import', 'inputfrom', 'includefrom', 'subimport', 'subinputfrom', 'subincludefrom']
const fontCommands = new Set(['fontspec', 'setmainfont', 'setsansfont', 'setmonofont', 'setmathfont',
  'newfontfamily', 'renewfontfamily', 'providefontfamily', 'setfontfamily',
  'newfontface', 'renewfontface', 'providefontface', 'setfontface', 'setmathfontface'])
const fontFileExtensions = ['.otf', '.ttf', '.ttc', '.otc', '.pfb']
const standalone = 'includestandalone'
const fileCommands = [...Object.keys(rules), ...imports, ...fontCommands, 'graphicspath', standalone]
function compileCommands(names: string[]) {
  return new RegExp('\\\\\\\\|\\\\(' + names.join('|') + ')(?![A-Za-z@])\\*?', 'g')
}
const commands = compileCommands(fileCommands)
const forwardedCommands = { includestandalone: compileCommands([standalone]), includegraphics: compileCommands(['includegraphics']) }

function skipSpace(text: string, offset: number) {
  while (offset < text.length && /\s/.test(text[offset])) offset++
  return offset
}

function readGroup(text: string, offset: number, open: '{' | '[' = '{') {
  const start = skipSpace(text, offset)
  if (text[start] !== open) return null
  const close = open === '{' ? '}' : ']'
  let depth = 1
  let braces = 0
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') {
      i++
    } else if (open === '[' && char === '{') {
      braces++
    } else if (open === '[' && char === '}' && braces) {
      braces--
    } else if (!braces) {
      if (char === open) depth++
      if (char === close && --depth === 0) return { value: text.slice(start + 1, i), end: i + 1 }
    }
  }
  return null
}

function afterOptions(text: string, offset: number) {
  return readGroup(text, offset, '[')?.end ?? offset
}

type FileWrapper = { command: 'includestandalone' | 'includegraphics'; end: number }

function fileWrappers(text: string) {
  const wrappers = new Map<string, FileWrapper | null>()
  const definitions = /\\\\|\\(def|gdef|edef|xdef|let|newcommand|renewcommand|providecommand|(?:New|Renew|Provide|Declare)DocumentCommand)\*?(?![A-Za-z@])\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))/g
  for (const match of text.matchAll(definitions)) {
    const [, kind, bracedName, unbracedName] = match
    const name = bracedName ?? unbracedName
    if (!name || fileCommands.includes(name)) continue
    const duplicate = wrappers.has(name)
    wrappers.set(name, null)
    if (duplicate) continue

    let offset = skipSpace(text, match.index + match[0].length)
    let arity = 1
    if (kind === 'def' && unbracedName && text.startsWith('#1', offset)) {
      offset += 2
    } else if (kind === 'newcommand') {
      const args = readGroup(text, offset, '[')
      const count = args?.value.trim()
      if (!args || (count !== '1' && count !== '2')) continue
      offset = args.end
      arity = Number(count)
    } else continue

    // An optional default, extra parameter, or delimiter cannot be followed
    // by the body here. Leave those signatures to TeX.
    const body = readGroup(text, offset)
    if (!body) continue
    const command = arity === 1 ? standalone : 'includegraphics'
    for (const use of body.value.matchAll(forwardedCommands[command])) {
      if (!use[1] || (command === standalone && use[0].endsWith('*'))) continue
      if (readGroup(body.value, afterOptions(body.value, use.index + use[0].length))?.value.trim() === '#' + arity) {
        wrappers.set(name, { command, end: body.end })
        break
      }
    }
  }
  return wrappers
}

function literalPath(value: string) {
  const path = value.trim().replace(/^"(.*)"$/, '$1')
  return path && !/[\\{}#\0\r\n]/.test(path) ? path : null
}

// Only literal font filenames are project dependencies. Family names still go
// through the engine's font resolver, and TeX remains responsible for expansion.
function fontFileArguments(text: string, offset: number, command: string): string[][] {
  if (/(?:fontfamily|fontface)$/.test(command)) {
    const name = readGroup(text, offset)
    if (name) offset = name.end
    else {
      const control = /^\\[A-Za-z@]+/.exec(text.slice(skipSpace(text, offset)))
      if (!control) return []
      offset = skipSpace(text, offset) + control[0].length
    }
  }
  const before = readGroup(text, offset, '[')
  const name = readGroup(text, before?.end ?? offset)
  if (!name) return []
  const after = readGroup(text, name.end, '[')
  const options = new Map<string, string>()
  for (const group of [before, after]) {
    if (!group) continue
    let start = 0, depth = 0
    for (let i = 0; i <= group.value.length; i++) {
      const char = group.value[i]
      if (char === '\\') { i++; continue }
      if (char === '{') depth++
      else if (char === '}') depth--
      if (i !== group.value.length && (char !== ',' || depth)) continue
      const item = group.value.slice(start, i), equals = item.indexOf('=')
      start = i + 1
      if (equals < 0) continue
      let value = item.slice(equals + 1).trim()
      const braced = readGroup(value, 0)
      if (braced?.end === value.length) value = braced.value
      options.set(item.slice(0, equals).trim(), value)
    }
  }
  const path = literalPath(options.get('Path') ?? '') ?? ''
  // A dynamic path must not accidentally resolve against the project root.
  if (options.has('Path') && options.get('Path')?.trim() && !path) return []
  const extension = options.get('Extension')?.trim()
  if (extension && !fontFileExtensions.includes(extension.toLowerCase())) return []
  const base = literalPath(name.value)
  if (!base) return []
  const values = [base]
  for (const key of ['UprightFont', 'BoldFont', 'ItalicFont', 'BoldItalicFont',
    'SlantedFont', 'BoldSlantedFont', 'SmallCapsFont']) {
    const value = options.get(key)
    if (value?.trim()) values.push(value.replace(/\*/g, () => base))
  }
  const files: string[][] = []
  for (const value of values) {
    const literal = literalPath(value)
    if (!literal) continue
    const explicit = fontFileExtensions.some(ext => literal.toLowerCase().endsWith(ext))
    if (!explicit && !extension && !path) continue
    const candidates = candidateNames(literal, explicit ? [] : extension ? [extension] : fontFileExtensions)
    files.push(candidates.map(file => path ? path.replace(/\/?$/, '/') + file : file))
  }
  return files
}

function literalMintedCacheDir(options = '') {
  if (options.length > 1024) return null
  const literal = options.replace(/=\s*\{\s*([A-Za-z0-9_./-]+)\s*\}/g, '=$1')
  if (/[\\{}]/.test(literal)) return null
  const values = new Map(literal.split(',').map(option => {
    const equals = option.indexOf('=')
    return equals < 0 ? [option.trim(), 'true'] : [option.slice(0, equals).trim(), option.slice(equals + 1).trim()]
  }))
  for (const key of ['cache', 'verbatim', 'placeholder', 'frozencache']) {
    const value = values.get(key)
    if (value !== undefined && value !== 'true' && value !== 'false') return null
  }
  if (values.get('cache') === 'false' || values.get('verbatim') === 'true' || values.get('placeholder') === 'true') {
    return null
  }
  const path = (values.get('cachedir') ?? '_minted').replace(/^\.\//, '')
  return /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\/?$/.test(path) ? path : null
}

type MintedCacheReader = {
  listFiles(directory: string): Promise<readonly string[]>
  fileSize(path: string): Promise<number | null>
  readRawBinary(path: string): Promise<Uint8Array | null>
}

async function readMintedCache(reader: MintedCacheReader, root: string, directory: string) {
  const names = new Set<string>()
  for (const name of await reader.listFiles(root + '/' + directory)) {
    if (!mintedCacheFile.test(name)) continue
    names.add(name)
    if (names.size > maxMintedCacheFiles) return null
  }

  const sizes = new Map<string, number>()
  let bytes = 0
  for (const name of names) {
    const path = directory + '/' + name
    const size = await reader.fileSize(root + '/' + path)
    if (size === null || !Number.isSafeInteger(size) || size < 0 || size > maxMintedCacheBytes - bytes) return null
    sizes.set(path, size)
    bytes += size
  }

  // Commit the optional cache only after all files pass the size checks.
  const files: Record<string, Uint8Array> = Object.create(null)
  for (const [path, size] of sizes) {
    const data = await reader.readRawBinary(root + '/' + path)
    if (!data || data.byteLength !== size) return null
    files[path] = data
  }
  return files
}

function candidateNames(name: string, extensions: string[] = [], tryBare = false) {
  const lower = name.toLowerCase()
  if (!extensions.length || extensions.some(ext => lower.endsWith(ext))) return [name]
  const suffixed = extensions.map(ext => name + ext)
  if (/\.[^/]+$/.test(name)) return [name, ...suffixed]
  return tryBare ? [...suffixed, name] : suffixed
}

type SearchScope = {
  imports: string[]
  graphics: string[]
}

/** Resolve literal TeX dependencies without enumerating or copying unrelated project files. */
export async function loadCompilationFiles(
  source: string,
  documentPath: string | undefined,
  read: (path: string) => Promise<Uint8Array | null>,
  cacheReader?: MintedCacheReader,
): Promise<Record<string, FileData>> {
  const { root, mainFile, directory } = compilationContext(documentPath)
  const files: Record<string, FileData> = Object.create(null)
  const missing = new Set<string>()
  const scanning = new Set([mainFile])
  const scanned = new Map<string, string[]>()
  const decoder = new TextDecoder()
  let mintedCacheDir: string | null | undefined
  const styleWrappers = new Map<string, FileWrapper>()
  const styleDefinitions = new Set<string>()
  let wrapperRevision = 0

  async function load(names: string[], directories: string[], scope: SearchScope, graphicsWrappers: string[] = []) {
    for (const name of names) {
      for (const parent of directories) {
        const path = resolvePath(parent, name)
        if (!path || missing.has(path)) continue
        if (path === mainFile) return
        if (!Object.hasOwn(files, path)) {
          const data = await read(root + '/' + path)
          if (!data) {
            missing.add(path)
            continue
          }
          files[path] = /\.(tex|sty|cls|clo|def|cfg|ltx|bib)$/i.test(path) ? decoder.decode(data) : data
        }
        const content = files[path]
        if (typeof content === 'string' && !/\.bib$/i.test(path) && !scanning.has(path)) {
          const inherited = /\.tex$/i.test(path) ? graphicsWrappers : []
          const key = JSON.stringify([path, scope.imports, scope.graphics, inherited])
          const resultingGraphics = scanned.get(key)
          if (resultingGraphics) {
            scope.graphics = resultingGraphics
          } else {
            scanning.add(path)
            await scan(content, scope, /\.sty$/i.test(path), inherited)
            scanning.delete(path)
            scanned.set(key, scope.graphics)
          }
        }
        return
      }
    }
  }

  async function scan(text: string, scope: SearchScope, isStyle = false, inheritedGraphics: string[] = []) {
    // Preserve escaped percent signs and newlines while removing TeX comments.
    const uncommented = text.includes('%') ? text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, '$1$2') : text
    const wrappers = fileWrappers(uncommented)
    const inherited = new Set(inheritedGraphics)
    const localNames = [...wrappers].filter(([, rule]) => rule).map(([name]) => name)
    const localGraphics = [...wrappers].filter(([, rule]) => rule?.command === 'includegraphics')
    function currentCommands() {
      const names = new Set([...localNames, ...inheritedGraphics, ...[...styleWrappers.keys()].filter(name => !wrappers.has(name))])
      return names.size ? compileCommands([...fileCommands, ...names]) : new RegExp(commands)
    }
    function wrappersForChild(position: number) {
      const names = inheritedGraphics.filter(name => !wrappers.has(name) && !styleDefinitions.has(name))
      for (const [name, wrapper] of localGraphics) {
        if (wrapper && wrapper.end <= position
          && !inherited.has(name) && !styleDefinitions.has(name)) names.push(name)
      }
      return names.sort()
    }
    let revision = wrapperRevision
    let scanCommands = currentCommands()
    while (true) {
      if (revision !== wrapperRevision) {
        const resume = scanCommands.lastIndex
        scanCommands = currentCommands()
        scanCommands.lastIndex = resume
        revision = wrapperRevision
      }
      const match = scanCommands.exec(uncommented)
      if (!match) break
      const command = match[1]
      if (!command) continue
      let offset = scanCommands.lastIndex
      if (fontCommands.has(command)) {
        for (const candidates of fontFileArguments(uncommented, offset, command)) {
          await load(candidates, [...scope.imports, directory], scope)
        }
        continue
      }
      const localWrapper = wrappers.get(command)
      let wrapperCommand = localWrapper?.command
      if (!wrappers.has(command)) {
        wrapperCommand = inherited.has(command)
          ? (styleDefinitions.has(command) ? undefined : 'includegraphics')
          : styleWrappers.get(command)?.command
      }
      if (wrapperCommand && (match.index < (localWrapper?.end ?? 0) || match[0].endsWith('*'))) continue
      if (wrapperCommand === 'includegraphics') {
        const title = readGroup(uncommented, offset)
        const image = title && readGroup(uncommented, title.end)
        const name = image && literalPath(image.value)
        if (name) await load(candidateNames(name, rules.includegraphics.extensions),
          [...scope.imports, directory, ...scope.graphics], scope)
        continue
      }
      if (command === standalone || wrapperCommand === standalone) {
        const argument = readGroup(uncommented, command === standalone ? afterOptions(uncommented, offset) : offset)
        const name = argument && literalPath(argument.value)
        if (!name) continue
        const directories = [...scope.imports, directory, ...scope.graphics]
        // The package can choose a prebuilt PDF or the source based on its
        // mode. Mount each available form and let TeX make that choice.
        for (const candidate of candidateNames(name, ['.pdf', '.tex'])) {
          await load([candidate], directories, scope)
        }
        continue
      }
      if (command === 'addplot') {
        if (uncommented[offset] === '3') offset++
        if (uncommented[offset] === '+') offset++
        offset = skipSpace(uncommented, afterOptions(uncommented, offset))
        if (!/^table\b/.test(uncommented.slice(offset, offset + 6))) continue
        offset += 'table'.length
      }
      const options = readGroup(uncommented, offset, '[')
      offset = options?.end ?? offset
      const first = readGroup(uncommented, offset)
      if (command === 'graphicspath') {
        const graphics = []
        if (first) {
          for (let child = readGroup(first.value, 0); child; child = readGroup(first.value, child.end)) {
            const name = literalPath(child.value)
            const path = name && resolvePath(directory, name)
            if (path !== null) graphics.push(path)
          }
        }
        scope.graphics = graphics
        continue
      }
      if (imports.includes(command)) {
        if (!first) continue
        const parent = literalPath(first.value)
        const second = readGroup(uncommented, first.end)
        const name = second && literalPath(second.value)
        if (!parent || !name) continue
        const from = command.startsWith('sub') ? scope.imports[0] ?? directory : directory
        const target = resolvePath(from, parent)
        if (target === null) continue
        const nested = { imports: [target, ...scope.imports], graphics: scope.graphics }
        await load(candidateNames(name, tex.extensions, true), [target], nested)
        continue
      }

      const rule = rules[command]
      if (!rule) continue
      const second = first && rule.argument === 2 ? readGroup(uncommented, first.end) : null
      const bareInput = command === 'input' && !first
        ? /^(?:"[^"\r\n]+"|[^\s\\{}]+)/.exec(uncommented.slice(skipSpace(uncommented, offset)))?.[0]
        : undefined
      const value = (rule.argument === 2 ? second?.value : first?.value) ?? bareInput
      if (!value) continue
      const directories = [...scope.imports, directory]
      if (command === 'includegraphics' || command === 'includepdf') directories.push(...scope.graphics)
      for (const rawName of rule.list ? value.split(',') : [value]) {
        const name = literalPath(rawName)
        if (!name) continue
        if (name === 'minted' && cacheReader && mintedCacheDir === undefined && packageDeclarations.has(command)) {
          mintedCacheDir = literalMintedCacheDir(options?.value)
        }
        const childWrappers = command === 'input' || command === 'include' ? wrappersForChild(match.index) : undefined
        await load(candidateNames((rule.prefix ?? '') + name, rule.extensions, command === 'input'), directories, scope, childWrappers)
      }
      if ((command === 'documentclass' || command === 'LoadClass') && value.trim() === 'flashcards'
        && options && /^[A-Za-z0-9_,\s-]+$/.test(options.value)) {
        // The flashcards class loads an option-named .cfg for its card dimensions.
        for (const option of options.value.split(',').map(option => option.trim())) {
          if (option && !flashcardsFlags.has(option)) {
            await load([option + '.cfg'], directories, scope)
          }
        }
      }
    }
    if (isStyle) {
      // A project-owned package can introduce a graphics wrapper for later files.
      for (const [name, wrapper] of wrappers) {
        if (!styleDefinitions.has(name) && wrapper?.command === 'includegraphics') {
          styleWrappers.set(name, wrapper)
          wrapperRevision++
        } else if (styleWrappers.delete(name)) {
          wrapperRevision++
        }
        styleDefinitions.add(name)
      }
    }
  }

  await scan(source, { imports: [], graphics: [] })
  if (cacheReader && mintedCacheDir) {
    // Minted resolves cachedir relative to TeX's working directory, which is the main file's folder.
    const path = resolvePath(directory, mintedCacheDir)
    if (path) {
      const cache = await readMintedCache(cacheReader, root, path).catch(() => null)
      if (cache) Object.assign(files, cache)
    }
  }
  return files
}
