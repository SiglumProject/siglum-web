import type { TexDiagnostic } from '../../utils/texLogParser'
import { compilationContext } from '../../services/CompilationFiles'

export interface CursorContext { from: number; to: number; line: number; text: string }
export interface EditorBookmark { anchor: number; head: number; top: number; left: number }
export interface MobileEditorApi {
  bookmark(): EditorBookmark
  restore(bookmark: EditorBookmark, focus?: boolean): void
  insert(text: string, options?: { from?: number; to?: number; cursor?: number; package?: string }): void
  goTo(line: number): void
  showLog(): void
  focus(): void
}
export type InsertKind = 'equation' | 'table' | 'figure' | 'citation' | 'section'
export type InputContext = { kind: 'text' | 'math' | 'citation' | 'file'; query: string; from: number; command?: string }
export function inputContext(source: string, cursor: number): InputContext {
  const before = source.slice(0, cursor)
  const argument = before.match(/\\(cite[a-zA-Z]*|input|include|includegraphics|addbibresource|bibliography)(?:\[[^\]]*\])?\{([^{}]*)$/)
  if (argument) {
    const query = argument[2].split(',').pop() || ''
    return { kind: argument[1].startsWith('cite') ? 'citation' : 'file', query, from: cursor - query.length, command: argument[1] }
  }
  const clean = before.replace(/(^|[^\\])%[^\n]*/g, '$1')
  const dollars = (clean.match(/(?<!\\)\$/g) || []).length
  const display = clean.lastIndexOf('\\[') > clean.lastIndexOf('\\]')
  const inline = clean.lastIndexOf('\\(') > clean.lastIndexOf('\\)')
  const env = /\\begin\{(equation\*?|align\*?|gather\*?|math|displaymath)\}/g
  const opened = [...clean.matchAll(env)].pop()
  const inEnvironment = !!opened && clean.lastIndexOf(`\\end{${opened[1]}}`) < opened.index!
  const doubleDollars = (clean.match(/(?<!\\)\$\$/g) || []).length
  return { kind: dollars % 2 || doubleDollars % 2 || display || inline || inEnvironment ? 'math' : 'text', query: '', from: cursor }
}
export function relativeFilePath(current: string, target: string): string {
  const from = current.split('/').filter(Boolean).slice(0, -1)
  const to = target.split('/').filter(Boolean)
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift() }
  return [...from.map(() => '..'), ...to].join('/')
}
export function diagnosticPath(file: string | undefined, current: string): string {
  if (!file) return current
  const { root, mainFile, directory } = compilationContext(current)
  if (file.startsWith(root + '/')) return file
  const name = file.replace(/^\.\//, '').replace(/^\//, '')
  const path = file.startsWith('/') || name === mainFile ? name : [directory, name].filter(Boolean).join('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.length) return current; parts.pop() }
    else if (part && part !== '.') parts.push(part)
  }
  return root + '/' + parts.join('/')
}
export function escapeTex(text: string): string {
  return text.replace(/[\\{}$&#%_^~]/g, character => ({'\\':'\\textbackslash{}','~':'\\textasciitilde{}','^':'\\textasciicircum{}'}[character] || '\\' + character))
}
export interface InsertForm { numerator: string; denominator: string; table: string; caption: string; file: string; citeKey: string; heading: string; level: string }
export const initialForm: InsertForm = { numerator: 'x + 1', denominator: 'y', table: 'Item\tValue\nAlpha\t10\nBeta\t20', caption: '', file: '', citeKey: '', heading: 'A new section', level: 'section' }
export function buildInsertion(kind: InsertKind, form: InsertForm): { source: string; package?: string; error?: string } {
  switch (kind) {
    case 'equation': return { source: `\\[\n  \\frac{${form.numerator}}{${form.denominator}}\n\\]` }
    case 'table': {
      const rows = form.table.split('\n').slice(0, 8).map(row => row.split('\t').slice(0, 5))
      const columns = Math.max(1, ...rows.map(row => row.length))
      const body = rows.map(row => Array.from({ length: columns }, (_, i) => escapeTex(row[i] || '')).join(' & ') + ' \\\\').join('\n')
      return { source: `\\begin{table}[ht]\n\\centering\n\\begin{tabular}{${'l'.repeat(columns)}}\n${body}\n\\end{tabular}${form.caption ? '\n\\caption{' + escapeTex(form.caption) + '}' : ''}\n\\end{table}` }
    }
    case 'figure': return { source: `\\begin{figure}[ht]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{${form.file}}${form.caption ? '\n\\caption{' + escapeTex(form.caption) + '}' : ''}\n\\end{figure}`, package: 'graphicx', error: !form.file || /[{}%\n\\]/.test(form.file) ? 'Choose a project image to insert.' : undefined }
    case 'citation': return { source: `\\cite{${form.citeKey}}`, error: !form.citeKey || /[{}\\\s]/.test(form.citeKey) ? 'Choose or enter a citation key.' : undefined }
    case 'section': return { source: `\\${['section', 'subsection', 'subsubsection'].includes(form.level) ? form.level : 'section'}{${escapeTex(form.heading)}}`, error: form.heading.trim() ? undefined : 'Enter a section heading.' }
  }
}
export function citationKeys(bib: string): string[] {
  return [...bib.matchAll(/@(?!comment\b|string\b|preamble\b)[a-z]+\s*\{\s*([^,\s]+)\s*,/gi)].map(match => match[1])
}

/** Keep shutdown summaries in the full log, rather than presenting them as another fix. */
export function actionableErrors(diagnostics: TexDiagnostic[]): TexDiagnostic[] {
  const errors = diagnostics.filter(item => item.type === 'error')
  const specific = errors.filter(item => !/^(?:==>\s*)?(?:Fatal error|Emergency stop)/i.test(item.message))
  const seen = new Set<string>()
  return (specific.length ? specific : errors).filter(item => {
    const key = `${item.file}:${item.line}:${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
