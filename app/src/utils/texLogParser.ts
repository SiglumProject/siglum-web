/**
 * TeX Log Parser
 *
 * Parses TeX/LaTeX compiler output to extract meaningful error messages,
 * warnings, and diagnostics. Inspired by LaTeX-Workshop's log parser.
 *
 * Optimized for incremental parsing - O(n) instead of O(n²).
 */

export type DiagnosticType = 'error' | 'warning' | 'info' | 'typesetting'

export interface TexDiagnostic {
  type: DiagnosticType
  message: string
  line?: number
  file?: string
  context?: string
}

export interface ParsedLog {
  diagnostics: TexDiagnostic[]
}

// Pre-compiled regex patterns (created once, reused)
const PATTERNS = {
  error: /^(?:(.+?):(\d+):?\s*)?!\s*(?:(.+?)\s+[Ee]rror:\s*)?(.+)$/,
  errorLine: /^l\.(\d+)\s+(.*)$/,
  errorContext: /^\s{15,}(.*)$/,
  latexWarning: /^((?:Class|Package|Module)\s+\S+|LaTeX(?:\s+\S+)?)\s+Warning:\s*(.+?)(?:\s+on(?:\s+input)?\s+line\s+(\d+))?\.?$/,
  overfullBox: /^(Overfull\s+\\[hv]box\s+\([^)]+\))\s+(?:in\s+paragraph\s+at\s+lines?\s+(\d+)(?:--(\d+))?|detected\s+at\s+line\s+(\d+)|has\s+occurred\s+while\s+\\output\s+is\s+active)/,
  underfullBox: /^(Underfull\s+\\[hv]box\s+\([^)]+\))\s+(?:in\s+paragraph\s+at\s+lines?\s+(\d+)(?:--(\d+))?|detected\s+at\s+line\s+(\d+)|has\s+occurred\s+while\s+\\output\s+is\s+active)/,
  missingChar: /^\s*(Missing\s+character:\s*.+?!)/,
  undefinedRef: /^LaTeX\s+Warning:\s+(Reference|Citation)\s+`([^']+)'\s+on\s+page\s+\d+\s+undefined\s+on\s+input\s+line\s+(\d+)/,
  fileOpen: /^\(([^()]+\.[a-z]{2,4})/i,
  emergencyStop: /^!\s+Emergency\s+stop/,
  fatalError: /^!\s+==>?\s+Fatal\s+error/i,
} as const

// Fast prefix checks - avoid regex for common cases
const IGNORE_PREFIXES = [
  'This is ',
  'Output written',
  'Transcript written',
  '***',
  'entering extended',
  'restricted \\write18',
  '%&-line',
  'Document Class:',
  'File:',
  'Package:',
  'Tab ',
  'Idle timer',
  'Compiler ',
  'Auto-unload',
  'Format ',
  'Fetching ',
  'CTAN:',
  'Bundle',
  'Loading',
  'Cache',
  'Deferred resolve',
  'Range coalescing',
  'Fetched coalesced',
  'Stored file',
  'Loaded file',
  'Retry #',
  'Initializing WASM',
  'WASM ready',
  'VFS:',
  'Mounted ',
  'Registered ',
  'Rewrote pdftex',
  'Using custom',
  'Total time:',
  'Generating format',
  'Compilation successful',
  'pdfTeX',
] as const

// Patterns that need regex (less common)
const IGNORE_PATTERNS_REGEX = [
  /^\s*\[\d+\]/,  // Page numbers [1] [2]
  /^\s*$/,        // Empty lines
  /^[()]+$/,      // Just parens
  /program exited.*keepRuntimeAlive/i,
] as const

/**
 * Fast ignore check - prefix matching first, then regex fallback
 */
function shouldIgnore(line: string): boolean {
  // Check single-char cases first
  if (line.length === 0 || line === '(' || line === ')') return true

  // Prefix matching is O(1) per prefix vs O(n) for regex
  const lineLower = line.slice(0, 30).toLowerCase() // Only check first 30 chars
  for (let i = 0; i < IGNORE_PREFIXES.length; i++) {
    const prefix = IGNORE_PREFIXES[i]
    if (line.length >= prefix.length) {
      // Case-insensitive prefix check
      if (lineLower.startsWith(prefix.toLowerCase())) return true
    }
  }

  // Fallback to regex for complex patterns
  for (let i = 0; i < IGNORE_PATTERNS_REGEX.length; i++) {
    if (IGNORE_PATTERNS_REGEX[i].test(line)) return true
  }

  return false
}

/**
 * Count occurrences of char in string (no array allocation)
 */
function countChar(str: string, char: string): number {
  let count = 0
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) count++
  }
  return count
}

interface ParserState {
  currentError: Partial<TexDiagnostic> | null
  expectingErrorLine: boolean
  expectingContext: boolean
  fileStack: string[]
  contextParts: string[] // Collect context parts, join once at end
}

function createParserState(): ParserState {
  return {
    currentError: null,
    expectingErrorLine: false,
    expectingContext: false,
    fileStack: [],
    contextParts: [],
  }
}

/**
 * Finalize current error and add to diagnostics
 */
function finalizeError(state: ParserState, diagnostics: TexDiagnostic[]): void {
  if (state.currentError?.message) {
    if (state.contextParts.length > 0) {
      state.currentError.context = state.contextParts.join('')
      state.contextParts = []
    }
    diagnostics.push(state.currentError as TexDiagnostic)
  }
  state.currentError = null
  state.expectingErrorLine = false
  state.expectingContext = false
}

/**
 * Parse a single line incrementally
 */
function parseLine(
  line: string,
  state: ParserState,
  diagnostics: TexDiagnostic[]
): void {
  // Track file stack
  const fileOpenMatch = line.match(PATTERNS.fileOpen)
  if (fileOpenMatch) {
    state.fileStack.push(fileOpenMatch[1])
  }

  // Count closing parens without creating array
  if (line.includes(')') && state.fileStack.length > 0) {
    const closes = countChar(line, ')')
    for (let i = 0; i < closes && state.fileStack.length > 0; i++) {
      state.fileStack.pop()
    }
  }

  // Fast ignore check
  if (shouldIgnore(line)) return

  const currentFile = state.fileStack[state.fileStack.length - 1]

  // Handle error line context
  if (state.expectingErrorLine) {
    const errorLineMatch = line.match(PATTERNS.errorLine)
    if (errorLineMatch) {
      if (state.currentError) {
        state.currentError.line = parseInt(errorLineMatch[1], 10)
        state.contextParts.push(errorLineMatch[2])
      }
      state.expectingErrorLine = false
      state.expectingContext = true
      return
    }
  }

  // Handle context continuation
  if (state.expectingContext) {
    const contextMatch = line.match(PATTERNS.errorContext)
    if (contextMatch && state.currentError) {
      state.contextParts.push(contextMatch[1])
      return
    }
    // Context ended
    finalizeError(state, diagnostics)
  }

  // --file-line-error reports the actual source file, including nested inputs.
  const locatedError = line.match(/^(.+?):(\d+):\s*(.+)$/)
  if (locatedError) {
    finalizeError(state, diagnostics)
    state.currentError = {
      type: 'error', file: locatedError[1], line: Number(locatedError[2]),
      message: locatedError[3].replace(/^!\s*/, ''),
    }
    state.expectingErrorLine = true
    return
  }

  // Check for errors (must start with !)
  if (line[0] === '!') {
    finalizeError(state, diagnostics)

    const errorMatch = line.match(PATTERNS.error)
    if (errorMatch) {
      const errorType = errorMatch[3]
      const errorMsg = errorMatch[4]

      state.currentError = {
        type: 'error',
        message: errorType ? `${errorType}: ${errorMsg}` : errorMsg,
        file: errorMatch[1] || currentFile,
        line: errorMatch[2] ? parseInt(errorMatch[2], 10) : undefined,
      }
      state.expectingErrorLine = true
      return
    }

    // Check emergency stop / fatal
    if (PATTERNS.emergencyStop.test(line)) {
      diagnostics.push({
        type: 'error',
        message: 'Emergency stop - compilation aborted',
        file: currentFile,
      })
      return
    }
    if (PATTERNS.fatalError.test(line)) {
      diagnostics.push({
        type: 'error',
        message: 'Fatal error occurred',
        file: currentFile,
      })
      return
    }
    return
  }

  // Only check warning patterns if line starts with expected prefixes
  const firstWord = line.slice(0, 10)

  // Undefined reference/citation (starts with "LaTeX")
  if (firstWord.startsWith('LaTeX')) {
    const undefRefMatch = line.match(PATTERNS.undefinedRef)
    if (undefRefMatch) {
      diagnostics.push({
        type: 'warning',
        message: `Undefined ${undefRefMatch[1].toLowerCase()}: '${undefRefMatch[2]}'`,
        line: parseInt(undefRefMatch[3], 10),
        file: currentFile,
      })
      return
    }
  }

  // LaTeX/Package warnings
  if (firstWord.startsWith('LaTeX') || firstWord.startsWith('Class') ||
      firstWord.startsWith('Package') || firstWord.startsWith('Module')) {
    const warningMatch = line.match(PATTERNS.latexWarning)
    if (warningMatch) {
      diagnostics.push({
        type: 'warning',
        message: `${warningMatch[1]}: ${warningMatch[2]}`,
        line: warningMatch[3] ? parseInt(warningMatch[3], 10) : undefined,
        file: currentFile,
      })
      return
    }
  }

  // Box warnings (start with "Overfull" or "Underfull")
  if (firstWord.startsWith('Overful')) {
    const overfullMatch = line.match(PATTERNS.overfullBox)
    if (overfullMatch) {
      const lineNum = overfullMatch[2] || overfullMatch[4]
      diagnostics.push({
        type: 'typesetting',
        message: overfullMatch[1],
        line: lineNum ? parseInt(lineNum, 10) : undefined,
        file: currentFile,
      })
      return
    }
  }

  if (firstWord.startsWith('Underfu')) {
    const underfullMatch = line.match(PATTERNS.underfullBox)
    if (underfullMatch) {
      const lineNum = underfullMatch[2] || underfullMatch[4]
      diagnostics.push({
        type: 'typesetting',
        message: underfullMatch[1],
        line: lineNum ? parseInt(lineNum, 10) : undefined,
        file: currentFile,
      })
      return
    }
  }

  // Missing character (starts with whitespace then "Missing")
  if (line.length > 2 && line.trimStart().startsWith('Missing')) {
    const missingCharMatch = line.match(PATTERNS.missingChar)
    if (missingCharMatch) {
      diagnostics.push({
        type: 'warning',
        message: missingCharMatch[1],
        file: currentFile,
      })
    }
  }
}

/**
 * Parse TeX log output into structured diagnostics
 */
export function parseTexLog(log: string): ParsedLog {
  const lines = log.split('\n')
  const diagnostics: TexDiagnostic[] = []
  const state = createParserState()

  for (let i = 0; i < lines.length; i++) {
    parseLine(lines[i], state, diagnostics)
  }

  // Finalize any pending error
  finalizeError(state, diagnostics)

  // Deduplicate using object keys (faster than Set for small n)
  const seen: Record<string, boolean> = {}
  const deduped: TexDiagnostic[] = []
  for (let i = 0; i < diagnostics.length; i++) {
    const d = diagnostics[i]
    const key = `${d.type}:${d.message}:${d.line ?? ''}`
    if (!seen[key]) {
      seen[key] = true
      deduped.push(d)
    }
  }

  return { diagnostics: deduped }
}

/**
 * Format diagnostics for display
 */
export function formatDiagnostics(diagnostics: TexDiagnostic[]): string {
  if (diagnostics.length === 0) return ''

  const parts: string[] = []
  let errors = 0, warnings = 0, typesetting = 0

  // Single pass categorization and formatting
  for (let i = 0; i < diagnostics.length; i++) {
    const d = diagnostics[i]
    if (d.type === 'error') {
      errors++
      parts.push(formatSingleDiagnostic(d))
    }
  }

  for (let i = 0; i < diagnostics.length; i++) {
    const d = diagnostics[i]
    if (d.type === 'warning') {
      warnings++
      parts.push(formatSingleDiagnostic(d))
    }
  }

  // Limit typesetting warnings
  for (let i = 0; i < diagnostics.length && typesetting < 3; i++) {
    const d = diagnostics[i]
    if (d.type === 'typesetting') {
      typesetting++
      parts.push(formatSingleDiagnostic(d))
    }
  }

  const totalTypesetting = diagnostics.filter(d => d.type === 'typesetting').length
  if (totalTypesetting > 3) {
    parts.push(`  ... and ${totalTypesetting - 3} more typesetting warnings`)
  }

  return parts.join('\n')
}

function formatSingleDiagnostic(d: TexDiagnostic): string {
  const prefix = d.type === 'error' ? 'Error' : d.type === 'warning' ? 'Warning' : 'Info'
  const lineInfo = d.line ? ` (line ${d.line})` : ''
  return d.context
    ? `${prefix}: ${d.message}${lineInfo}\n  ${d.context.trim()}`
    : `${prefix}: ${d.message}${lineInfo}`
}

/**
 * Streaming log parser - truly incremental O(n)
 * Parses each line once as it arrives
 */
export class StreamingLogParser {
  private state: ParserState = createParserState()
  private diagnostics: TexDiagnostic[] = []
  private seenKeys: Record<string, boolean> = {}
  private callbacks: Set<(diagnostics: TexDiagnostic[]) => void> = new Set()
  private lineCount = 0

  // Memory limit: max lines to keep in state
  private static readonly MAX_FILE_STACK = 50

  addLine(line: string): void {
    this.lineCount++

    // Strip [TeX] prefix if present
    const cleanLine = line.startsWith('[TeX]')
      ? line.slice(5).trimStart()
      : line

    const prevCount = this.diagnostics.length
    parseLine(cleanLine, this.state, this.diagnostics)

    // Deduplicate new diagnostics
    if (this.diagnostics.length > prevCount) {
      const newDiags: TexDiagnostic[] = []
      for (let i = prevCount; i < this.diagnostics.length; i++) {
        const d = this.diagnostics[i]
        const key = `${d.type}:${d.message}:${d.line ?? ''}`
        if (!this.seenKeys[key]) {
          this.seenKeys[key] = true
          newDiags.push(d)
        }
      }
      // Replace with deduped
      this.diagnostics.length = prevCount
      this.diagnostics.push(...newDiags)

      if (newDiags.length > 0) {
        this.notifyCallbacks()
      }
    }

    // Prevent file stack from growing unbounded
    if (this.state.fileStack.length > StreamingLogParser.MAX_FILE_STACK) {
      this.state.fileStack = this.state.fileStack.slice(-StreamingLogParser.MAX_FILE_STACK)
    }
  }

  onDiagnostics(callback: (diagnostics: TexDiagnostic[]) => void): () => void {
    this.callbacks.add(callback)
    callback(this.diagnostics)
    return () => this.callbacks.delete(callback)
  }

  getDiagnostics(): TexDiagnostic[] {
    return this.diagnostics
  }

  getFormatted(): string {
    return formatDiagnostics(this.diagnostics)
  }

  /** Finalize any pending error (call after feeding all lines from a batch) */
  finalize(): void {
    const prevCount = this.diagnostics.length
    finalizeError(this.state, this.diagnostics)
    if (this.diagnostics.length > prevCount) {
      this.notifyCallbacks()
    }
  }

  clear(): void {
    this.state = createParserState()
    this.diagnostics = []
    this.seenKeys = {}
    this.lineCount = 0
    this.notifyCallbacks()
  }

  private notifyCallbacks(): void {
    const diags = [...this.diagnostics]
    this.callbacks.forEach(cb => cb(diags))
  }
}
