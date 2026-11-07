import { validateParagraphText } from './paragraph.mjs'

const header = String.raw`\documentclass{article}
\setlength{\parindent}{0pt}
\begin{document}
`
const footer = '\n\\end{document}\n'

function paragraphs(source: string) {
  if (!source.startsWith(header) || !source.endsWith(footer)) return
  const parts = source.slice(header.length, -footer.length).split(/\n[ \t]*\n/)
  if (!parts.length || parts.length > 4) return
  try {
    for (const part of parts) {
      if (part.includes('$') || part !== part.trim()) return
      validateParagraphText(part)
    }
    return parts
  } catch {
    return
  }
}

export function isPlainArticle(source: string) {
  return paragraphs(source) !== undefined
}

export function getPlainArticleEdit(previous: string, current: string) {
  const before = paragraphs(previous)
  const after = paragraphs(current)
  if (!before || !after || before.length !== after.length) return
  const changed = before.flatMap((text, index) => text === after[index] ? [] : [index])
  if (changed.length !== 1) return
  const index = changed[0]
  return { page: 1, paragraph: index + 1, before: before[index], after: after[index], pageParagraphs: before }
}
