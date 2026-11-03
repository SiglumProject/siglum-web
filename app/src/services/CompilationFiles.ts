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
  return parts.length ? parts.join('/') : null
}

/** Resolve literal TeX dependencies relative to the main document's directory. */
export async function loadCompilationFiles(
  source: string,
  documentPath: string | undefined,
  read: (path: string) => Promise<Uint8Array | null>,
): Promise<Record<string, FileData>> {
  const files: Record<string, FileData> = {}
  const visited = new Set<string>()
  const { root, directory } = compilationContext(documentPath)
  const decoder = new TextDecoder()
  async function scan(text: string) {
    const pattern = /\\(input|include|bibliography|addbibresource|includegraphics|usepackage|documentclass)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g
    // Ignore comments; commands constructed dynamically are left for TeX to diagnose.
    const uncommented = text.replace(/(^|[^\\])%[^\n]*/g, '$1')
    for (const match of uncommented.matchAll(pattern)) {
      const [, command, argument] = match
      const names = /^(bibliography|usepackage)$/.test(command) ? argument.split(',') : [argument]
      for (const rawName of names) {
        const name = rawName.trim().replace(/^\.\//, '')
        if (!name || /[\\{}]/.test(name)) continue
        const extensions = command === 'includegraphics' ? ['.pdf', '.png', '.jpg', '.jpeg', '.eps']
          : command === 'bibliography' || command === 'addbibresource' ? ['.bib']
          : command === 'usepackage' ? ['.sty'] : command === 'documentclass' ? ['.cls'] : ['.tex']
        const candidates = /\.[^/]+$/.test(name) ? [name] : extensions.map(ext => name + ext)
        for (const candidate of candidates) {
          const projectPath = resolvePath(directory, candidate)
          if (!projectPath) continue
          if (visited.has(projectPath)) break
          const data = await read(`${root}/${projectPath}`)
          if (!data) continue
          visited.add(projectPath)
          const isText = /\.(tex|sty|cls|bib)$/i.test(candidate)
          const content = isText ? decoder.decode(data) : data
          files[projectPath] = content
          if (typeof content === 'string' && !candidate.endsWith('.bib')) await scan(content)
          break
        }
      }
    }
  }
  await scan(source)
  return files
}
