/**
 * TeXcount - LaTeX Word Counter (Optimized)
 *
 * TypeScript port of TeXcount (https://app.uio.no/ifi/texcount/)
 * Original Perl script by Einar Andreas Rødland
 *
 * Optimized for CPU and memory efficiency:
 * - Single-pass streaming parser (no tokenization array)
 * - Numeric enums for fast comparisons
 * - Char code comparisons instead of regex in hot paths
 * - Minimal string allocations
 * - Inline word counting (no recursive sub-counters)
 */

// ============================================================================
// Types - Use numeric enums for performance
// ============================================================================

/** Parser states (numeric for fast comparison) */
const enum State {
  PREAMBLE = 0,
  TEXT = 1,
  HEADER = 2,
  CAPTION = 3,
  SKIP = 4,  // Skip content (math, verbatim, etc.)
}

/** Macro rules (numeric) */
const enum Rule {
  IGNORE = 0,
  COUNT = 1,
  COUNT_HEADER = 2,
  COUNT_CAPTION = 3,
  SKIP_ENV = 4,
}

/** Counter indices for different word categories */
export interface WordCounts {
  textWords: number
  headerWords: number
  captionWords: number
  inlineMath: number
  displayMath: number
  headers: number
  floats: number
  mathInlines: number
  mathDisplays: number
  files: number
}

/** Options for the counter */
export interface TeXCountOptions {
  countHeaders?: boolean
  countCaptions?: boolean
  countInlineMath?: boolean
  countDisplayMath?: boolean
}

// ============================================================================
// Character classification (avoid regex in hot paths)
// ============================================================================

// Character codes for fast comparison
const CHAR_BACKSLASH = 92   // \
const CHAR_PERCENT = 37     // %
const CHAR_DOLLAR = 36      // $
const CHAR_OPEN_BRACE = 123 // {
const CHAR_CLOSE_BRACE = 125 // }
const CHAR_OPEN_BRACKET = 91  // [
const CHAR_CLOSE_BRACKET = 93 // ]
const CHAR_NEWLINE = 10     // \n
const CHAR_CR = 13          // \r
const CHAR_SPACE = 32       // space
const CHAR_TAB = 9          // \t
const CHAR_STAR = 42        // *
const CHAR_AT = 64          // @
const CHAR_UNDERSCORE = 95  // _
const CHAR_CARET = 94       // ^
const CHAR_AMPERSAND = 38   // &
const CHAR_HASH = 35        // #
const CHAR_TILDE = 126      // ~

/** Check if char is a letter (a-z, A-Z) */
function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

/** Check if char is alphanumeric or @ (for command names) */
function isCommandChar(c: number): boolean {
  return isLetter(c) || c === CHAR_AT
}

/** Check if char is a word character (letter, digit, apostrophe, hyphen, or unicode letter) */
function isWordChar(c: number): boolean {
  // ASCII letters
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true
  // Digits
  if (c >= 48 && c <= 57) return true
  // Apostrophe, hyphen
  if (c === 39 || c === 45) return true
  // Extended Latin and other Unicode letters (common accented chars)
  if (c >= 192 && c <= 687) return true  // Latin Extended
  if (c >= 880 && c <= 1023) return true // Greek
  return false
}

/** Check if char starts a word (letter or unicode letter, not digit/punctuation) */
function isWordStart(c: number): boolean {
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true
  if (c >= 192 && c <= 687) return true
  if (c >= 880 && c <= 1023) return true
  return false
}

/** Check if char is whitespace */
function isWhitespace(c: number): boolean {
  return c === CHAR_SPACE || c === CHAR_TAB || c === CHAR_NEWLINE || c === CHAR_CR
}

// ============================================================================
// Macro and Environment Rules (compact representation)
// ============================================================================

// Macro rules: [rule, argPattern]
// argPattern: string where '[' = optional, '{' = required, '*' = optional star
type MacroEntry = [Rule, string]

const MACROS: Record<string, MacroEntry> = {
  // Sectioning - count as headers
  'part': [Rule.COUNT_HEADER, '*[]{}'],
  'chapter': [Rule.COUNT_HEADER, '*[]{}'],
  'section': [Rule.COUNT_HEADER, '*[]{}'],
  'subsection': [Rule.COUNT_HEADER, '*[]{}'],
  'subsubsection': [Rule.COUNT_HEADER, '*[]{}'],
  'paragraph': [Rule.COUNT_HEADER, '*[]{}'],
  'subparagraph': [Rule.COUNT_HEADER, '*[]{}'],

  // Caption
  'caption': [Rule.COUNT_CAPTION, '[]{}'],
  'captionof': [Rule.COUNT_CAPTION, '{}[]{}'],

  // Text formatting - count content
  'textbf': [Rule.COUNT, '{}'],
  'textit': [Rule.COUNT, '{}'],
  'textsl': [Rule.COUNT, '{}'],
  'textsc': [Rule.COUNT, '{}'],
  'textsf': [Rule.COUNT, '{}'],
  'texttt': [Rule.COUNT, '{}'],
  'textrm': [Rule.COUNT, '{}'],
  'emph': [Rule.COUNT, '{}'],
  'underline': [Rule.COUNT, '{}'],
  'mbox': [Rule.COUNT, '{}'],
  'fbox': [Rule.COUNT, '{}'],
  'text': [Rule.COUNT, '{}'],
  'intertext': [Rule.COUNT, '{}'],
  'footnote': [Rule.COUNT, '[]{}'],
  'footnotetext': [Rule.COUNT, '[]{}'],
  'title': [Rule.COUNT, '[]{}'],
  'author': [Rule.COUNT, '[]{}'],
  'href': [Rule.COUNT, '{}{}'],
  'hyperref': [Rule.COUNT, '[]{}'],

  // Ignore
  'documentclass': [Rule.IGNORE, '[]{}'],
  'usepackage': [Rule.IGNORE, '[]{}'],
  'RequirePackage': [Rule.IGNORE, '[]{}'],
  'newcommand': [Rule.IGNORE, '{}[][]{}'],
  'renewcommand': [Rule.IGNORE, '{}[][]{}'],
  'providecommand': [Rule.IGNORE, '{}[][]{}'],
  'DeclareRobustCommand': [Rule.IGNORE, '{}[][]{}'],
  'newenvironment': [Rule.IGNORE, '{}[][]{}{}'],
  'renewenvironment': [Rule.IGNORE, '{}[][]{}{}'],
  'setcounter': [Rule.IGNORE, '{}{}'],
  'addtocounter': [Rule.IGNORE, '{}{}'],
  'setlength': [Rule.IGNORE, '{}{}'],
  'addtolength': [Rule.IGNORE, '{}{}'],
  'ref': [Rule.IGNORE, '{}'],
  'eqref': [Rule.IGNORE, '{}'],
  'pageref': [Rule.IGNORE, '{}'],
  'cite': [Rule.IGNORE, '[][]{}'],
  'citep': [Rule.IGNORE, '[][]{}'],
  'citet': [Rule.IGNORE, '[][]{}'],
  'citeauthor': [Rule.IGNORE, '[]{}'],
  'citeyear': [Rule.IGNORE, '[]{}'],
  'nocite': [Rule.IGNORE, '{}'],
  'label': [Rule.IGNORE, '{}'],
  'bibliography': [Rule.IGNORE, '{}'],
  'bibliographystyle': [Rule.IGNORE, '{}'],
  'input': [Rule.IGNORE, '{}'],
  'include': [Rule.IGNORE, '{}'],
  'includegraphics': [Rule.IGNORE, '[]{}'],
  'graphicspath': [Rule.IGNORE, '{}'],
  'vspace': [Rule.IGNORE, '*{}'],
  'hspace': [Rule.IGNORE, '*{}'],
  'footnotemark': [Rule.IGNORE, '[]'],
  'date': [Rule.IGNORE, '{}'],
  'thanks': [Rule.IGNORE, '{}'],
  'url': [Rule.IGNORE, '{}'],
  'pagebreak': [Rule.IGNORE, '[]'],
  'linebreak': [Rule.IGNORE, '[]'],
  'printbibliography': [Rule.IGNORE, '[]'],
}

// Environments that skip content entirely
const SKIP_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*',
  'displaymath', 'math', 'verbatim', 'verbatim*', 'lstlisting', 'minted',
  'alltt', 'thebibliography', 'tikzpicture', 'pgfpicture', 'array',
])

// Environments that are floats
const FLOAT_ENVS = new Set(['figure', 'figure*', 'table', 'table*'])

// Math environments (for counting)
const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*',
  'displaymath', 'math',
])

// ============================================================================
// Streaming Parser
// ============================================================================

/**
 * Optimized single-pass LaTeX word counter
 */
class TeXCounterOptimized {
  private src: string = ''
  private len: number = 0
  private pos: number = 0
  private state: State = State.PREAMBLE
  private stateStack: State[] = []

  // Counts
  private textWords: number = 0
  private headerWords: number = 0
  private captionWords: number = 0
  private mathInlines: number = 0
  private mathDisplays: number = 0
  private headers: number = 0
  private floats: number = 0

  // Options
  private countHeaders: boolean
  private countCaptions: boolean
  private countInlineMath: boolean
  private countDisplayMath: boolean

  constructor(options: TeXCountOptions = {}) {
    this.countHeaders = options.countHeaders !== false
    this.countCaptions = options.countCaptions !== false
    this.countInlineMath = options.countInlineMath === true
    this.countDisplayMath = options.countDisplayMath === true
  }

  count(content: string): WordCounts {
    // Reset
    this.src = content
    this.len = content.length
    this.pos = 0
    this.state = State.PREAMBLE
    this.stateStack.length = 0
    this.textWords = 0
    this.headerWords = 0
    this.captionWords = 0
    this.mathInlines = 0
    this.mathDisplays = 0
    this.headers = 0
    this.floats = 0

    this.parse()

    return {
      textWords: this.textWords,
      headerWords: this.headerWords,
      captionWords: this.captionWords,
      inlineMath: this.countInlineMath ? this.mathInlines : 0,
      displayMath: this.countDisplayMath ? this.mathDisplays : 0,
      headers: this.headers,
      floats: this.floats,
      mathInlines: this.mathInlines,
      mathDisplays: this.mathDisplays,
      files: 0,
    }
  }

  getTotalWords(): number {
    let total = this.textWords
    if (this.countHeaders) total += this.headerWords
    if (this.countCaptions) total += this.captionWords
    if (this.countInlineMath) total += this.mathInlines
    if (this.countDisplayMath) total += this.mathDisplays
    return total
  }

  private parse(): void {
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos)

      // Comment - skip to end of line
      if (c === CHAR_PERCENT) {
        this.skipComment()
        continue
      }

      // Command
      if (c === CHAR_BACKSLASH) {
        this.handleCommand()
        continue
      }

      // Inline math $
      if (c === CHAR_DOLLAR) {
        this.handleDollarMath()
        continue
      }

      // Word
      if (isWordStart(c)) {
        this.handleWord()
        continue
      }

      // Skip other characters
      this.pos++
    }
  }

  private skipComment(): void {
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos)
      this.pos++
      if (c === CHAR_NEWLINE || c === CHAR_CR) break
    }
  }

  private skipWhitespace(): void {
    while (this.pos < this.len && isWhitespace(this.src.charCodeAt(this.pos))) {
      this.pos++
    }
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos)
      if (isWhitespace(c)) {
        this.pos++
      } else if (c === CHAR_PERCENT) {
        this.skipComment()
      } else {
        break
      }
    }
  }

  private readCommandName(): string {
    const start = this.pos
    while (this.pos < this.len && isCommandChar(this.src.charCodeAt(this.pos))) {
      this.pos++
    }
    // Check for trailing *
    if (this.pos < this.len && this.src.charCodeAt(this.pos) === CHAR_STAR) {
      this.pos++
    }
    return this.src.slice(start, this.pos)
  }

  private readBraceArg(): string {
    this.skipWhitespaceAndComments()
    if (this.pos >= this.len || this.src.charCodeAt(this.pos) !== CHAR_OPEN_BRACE) {
      return ''
    }
    this.pos++ // skip {
    const start = this.pos
    let depth = 1
    while (this.pos < this.len && depth > 0) {
      const c = this.src.charCodeAt(this.pos)
      if (c === CHAR_OPEN_BRACE) depth++
      else if (c === CHAR_CLOSE_BRACE) depth--
      if (depth > 0) this.pos++
    }
    const content = this.src.slice(start, this.pos)
    if (this.pos < this.len) this.pos++ // skip }
    return content
  }

  private skipBraceArg(): void {
    this.skipWhitespaceAndComments()
    if (this.pos >= this.len || this.src.charCodeAt(this.pos) !== CHAR_OPEN_BRACE) {
      return
    }
    this.pos++ // skip {
    let depth = 1
    while (this.pos < this.len && depth > 0) {
      const c = this.src.charCodeAt(this.pos)
      if (c === CHAR_OPEN_BRACE) depth++
      else if (c === CHAR_CLOSE_BRACE) depth--
      this.pos++
    }
  }

  private skipBracketArg(): void {
    this.skipWhitespaceAndComments()
    if (this.pos >= this.len || this.src.charCodeAt(this.pos) !== CHAR_OPEN_BRACKET) {
      return
    }
    this.pos++ // skip [
    let depth = 1
    while (this.pos < this.len && depth > 0) {
      const c = this.src.charCodeAt(this.pos)
      if (c === CHAR_OPEN_BRACKET) depth++
      else if (c === CHAR_CLOSE_BRACKET) depth--
      this.pos++
    }
  }

  private parseArgs(pattern: string): void {
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i]
      if (ch === '*') {
        this.skipWhitespaceAndComments()
        if (this.pos < this.len && this.src.charCodeAt(this.pos) === CHAR_STAR) {
          this.pos++
        }
      } else if (ch === '[') {
        this.skipBracketArg()
        if (pattern[i + 1] === ']') i++
      } else if (ch === '{') {
        this.skipBraceArg()
        if (pattern[i + 1] === '}') i++
      }
    }
  }

  private countWordsInString(content: string, target: State): void {
    let i = 0
    const len = content.length
    while (i < len) {
      const c = content.charCodeAt(i)

      // Skip comments
      if (c === CHAR_PERCENT) {
        while (i < len && content.charCodeAt(i) !== CHAR_NEWLINE) i++
        continue
      }

      // Skip math
      if (c === CHAR_DOLLAR) {
        i++
        if (i < len && content.charCodeAt(i) === CHAR_DOLLAR) {
          i++
          while (i < len - 1 && !(content.charCodeAt(i) === CHAR_DOLLAR && content.charCodeAt(i + 1) === CHAR_DOLLAR)) i++
          i += 2
        } else {
          while (i < len && content.charCodeAt(i) !== CHAR_DOLLAR) i++
          i++
        }
        continue
      }

      // Skip commands (don't count nested formatting)
      if (c === CHAR_BACKSLASH) {
        i++
        while (i < len && isCommandChar(content.charCodeAt(i))) i++
        if (i < len && content.charCodeAt(i) === CHAR_STAR) i++
        continue
      }

      // Count word
      if (isWordStart(c)) {
        while (i < len && isWordChar(content.charCodeAt(i))) i++
        if (target === State.HEADER) this.headerWords++
        else if (target === State.CAPTION) this.captionWords++
        else this.textWords++
        continue
      }

      i++
    }
  }

  private handleWord(): void {
    // Consume word
    while (this.pos < this.len && isWordChar(this.src.charCodeAt(this.pos))) {
      this.pos++
    }

    // Count based on state
    if (this.state === State.TEXT) {
      this.textWords++
    } else if (this.state === State.HEADER) {
      this.headerWords++
    } else if (this.state === State.CAPTION) {
      this.captionWords++
    }
    // PREAMBLE and SKIP: don't count
  }

  private handleDollarMath(): void {
    this.pos++ // skip $
    if (this.pos < this.len && this.src.charCodeAt(this.pos) === CHAR_DOLLAR) {
      // Display math $$...$$
      this.pos++
      while (this.pos < this.len - 1) {
        if (this.src.charCodeAt(this.pos) === CHAR_DOLLAR &&
            this.src.charCodeAt(this.pos + 1) === CHAR_DOLLAR) {
          this.pos += 2
          break
        }
        this.pos++
      }
      if (this.state !== State.PREAMBLE) this.mathDisplays++
    } else {
      // Inline math $...$
      while (this.pos < this.len && this.src.charCodeAt(this.pos) !== CHAR_DOLLAR) {
        this.pos++
      }
      if (this.pos < this.len) this.pos++ // skip closing $
      if (this.state !== State.PREAMBLE) this.mathInlines++
    }
  }

  private handleCommand(): void {
    this.pos++ // skip \
    if (this.pos >= this.len) return

    const c = this.src.charCodeAt(this.pos)

    // \[ display math
    if (c === CHAR_OPEN_BRACKET) {
      this.pos++
      this.skipToCommand('\\]')
      if (this.state !== State.PREAMBLE) this.mathDisplays++
      return
    }

    // \] end display math (shouldn't happen outside \[)
    if (c === CHAR_CLOSE_BRACKET) {
      this.pos++
      return
    }

    // \( inline math
    if (c === 40) { // (
      this.pos++
      this.skipToCommand('\\)')
      if (this.state !== State.PREAMBLE) this.mathInlines++
      return
    }

    // \) end inline math
    if (c === 41) { // )
      this.pos++
      return
    }

    // Special escaped char
    if (!isLetter(c)) {
      this.pos++
      return
    }

    // Read command name
    const cmdName = this.readCommandName()

    // \begin
    if (cmdName === 'begin') {
      this.handleBegin()
      return
    }

    // \end
    if (cmdName === 'end') {
      this.handleEnd()
      return
    }

    // Look up macro
    const macro = MACROS[cmdName]
    if (macro) {
      const [rule, pattern] = macro

      // In preamble, just skip args
      if (this.state === State.PREAMBLE) {
        this.parseArgs(pattern)
        return
      }

      if (rule === Rule.IGNORE) {
        this.parseArgs(pattern)
      } else if (rule === Rule.COUNT) {
        // Count words in brace args
        this.countArgsAsText(pattern)
      } else if (rule === Rule.COUNT_HEADER) {
        this.headers++
        this.countArgsAs(pattern, State.HEADER)
      } else if (rule === Rule.COUNT_CAPTION) {
        this.countArgsAs(pattern, State.CAPTION)
      }
    }
    // Unknown command - just skip it
  }

  private countArgsAsText(pattern: string): void {
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i]
      if (ch === '*') {
        this.skipWhitespaceAndComments()
        if (this.pos < this.len && this.src.charCodeAt(this.pos) === CHAR_STAR) {
          this.pos++
        }
      } else if (ch === '[') {
        this.skipBracketArg() // Skip optional args
        if (pattern[i + 1] === ']') i++
      } else if (ch === '{') {
        const content = this.readBraceArg()
        if (content) this.countWordsInString(content, State.TEXT)
        if (pattern[i + 1] === '}') i++
      }
    }
  }

  private countArgsAs(pattern: string, target: State): void {
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i]
      if (ch === '*') {
        this.skipWhitespaceAndComments()
        if (this.pos < this.len && this.src.charCodeAt(this.pos) === CHAR_STAR) {
          this.pos++
        }
      } else if (ch === '[') {
        this.skipBracketArg() // Skip optional args
        if (pattern[i + 1] === ']') i++
      } else if (ch === '{') {
        const content = this.readBraceArg()
        if (content) this.countWordsInString(content, target)
        if (pattern[i + 1] === '}') i++
      }
    }
  }

  private handleBegin(): void {
    const envName = this.readBraceArg()

    // \begin{document}
    if (envName === 'document') {
      this.state = State.TEXT
      return
    }

    // Float environments
    if (FLOAT_ENVS.has(envName)) {
      this.floats++
      this.stateStack.push(this.state)
      return
    }

    // Skip environments
    if (SKIP_ENVS.has(envName)) {
      this.skipToEndEnv(envName)
      if (MATH_ENVS.has(envName) && this.state !== State.PREAMBLE) {
        this.mathDisplays++
      }
      return
    }

    // Other environments - continue parsing
    this.stateStack.push(this.state)
  }

  private handleEnd(): void {
    const envName = this.readBraceArg()

    if (envName === 'document') {
      // Stop parsing
      this.pos = this.len
      return
    }

    // Pop state
    if (this.stateStack.length > 0) {
      this.state = this.stateStack.pop()!
    }
  }

  private skipToEndEnv(envName: string): void {
    let depth = 1
    const beginStr = '\\begin{' + envName + '}'
    const endStr = '\\end{' + envName + '}'

    while (this.pos < this.len && depth > 0) {
      // Quick scan for backslash
      const idx = this.src.indexOf('\\', this.pos)
      if (idx === -1) {
        this.pos = this.len
        break
      }
      this.pos = idx

      // Check for \begin{envName} or \end{envName}
      if (this.src.startsWith(beginStr, this.pos)) {
        depth++
        this.pos += beginStr.length
      } else if (this.src.startsWith(endStr, this.pos)) {
        depth--
        this.pos += endStr.length
      } else {
        this.pos++
      }
    }
  }

  private skipToCommand(cmd: string): void {
    while (this.pos < this.len) {
      const idx = this.src.indexOf(cmd, this.pos)
      if (idx === -1) {
        this.pos = this.len
        return
      }
      this.pos = idx + cmd.length
      return
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

// Reusable counter instance for simple calls
let sharedCounter: TeXCounterOptimized | null = null

/**
 * Count words in a LaTeX document (optimized)
 */
export function countWords(content: string, options?: TeXCountOptions): number {
  // Reuse counter instance if no custom options
  if (!options) {
    if (!sharedCounter) sharedCounter = new TeXCounterOptimized()
    sharedCounter.count(content)
    return sharedCounter.getTotalWords()
  }
  const counter = new TeXCounterOptimized(options)
  counter.count(content)
  return counter.getTotalWords()
}

/**
 * Get detailed word counts for a LaTeX document
 */
export function getDetailedCounts(content: string, options?: TeXCountOptions): WordCounts {
  const counter = new TeXCounterOptimized(options)
  return counter.count(content)
}

/**
 * Create a reusable counter instance
 */
export function createCounter(options?: TeXCountOptions): { count: (content: string) => WordCounts; getTotalWords: () => number } {
  const counter = new TeXCounterOptimized(options)
  return {
    count: (content: string) => counter.count(content),
    getTotalWords: () => counter.getTotalWords(),
  }
}

// Export class for advanced usage
export { TeXCounterOptimized as TeXCounter }

export default {
  countWords,
  getDetailedCounts,
  createCounter,
}
