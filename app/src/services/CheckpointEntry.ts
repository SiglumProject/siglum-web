import { loadCompilationFiles, compilationContext } from './CompilationFiles'
/** Find a nearby main file for a literal input/include, without fixture names. */
export async function checkpointEntry(source: string, path: string | undefined,
  read: (path: string) => Promise<Uint8Array | null>) {
  if (!path || /\\documentclass\b/.test(source)) return { source, path }
  const root = path.startsWith('/project/src/') ? '/project/src' : '/' + path.split('/').filter(Boolean)[0]
  let parent = path.slice(0, path.lastIndexOf('/'))
  while (parent.length >= root.length) {
    const relative = path.slice(parent.length + 1).replace(/\.tex$/, '')
    for (const filename of ['main.tex', 'document.tex', 'index.tex']) {
      const candidate = parent + '/' + filename
      if (candidate === path) continue
      const data = await read(candidate)
      if (!data) continue
      const main = new TextDecoder().decode(data)
      const inputs = [...main.replace(/(^|[^\\])%[^\n]*/g, '$1')
        .matchAll(/\\(?:include|input)\s*\{([^{}]+)\}/g)].map(match => match[1].replace(/^\.\//, '').replace(/\.tex$/, ''))
      if (!/\\documentclass\b/.test(main)) continue
      if (inputs.includes(relative)) return { source: main, path: candidate }
      const files = await loadCompilationFiles(main, candidate, read)
      if (Object.hasOwn(files, compilationContext(path).mainFile)) return { source: main, path: candidate, files }
    }
    if (parent === root) break
    parent = parent.slice(0, parent.lastIndexOf('/'))
  }
  return { source, path }
}
