/**
 * Search Worker - Offloads content search from main thread
 *
 * Handles searching through file contents in a background thread
 * to prevent UI blocking on large projects.
 */

export interface FileData {
  path: string
  name: string
  id: string
  content: string
}

export interface ContentSearchResult {
  filePath: string
  fileId: string
  fileName: string
  lineNumber: number
  snippet: string
  score: number
}

export interface SearchMessage {
  type: 'search'
  id: number
  query: string
  files: FileData[]
  caseSensitive: boolean
  maxResults: number
}

export interface SearchResultMessage {
  type: 'result'
  id: number
  results: ContentSearchResult[]
}

// Fuzzy matching types for DocumentSearcher
export interface FuzzyMatchRequest {
  word: string
  candidates: string[]
  threshold: number
}

export interface FuzzyMatchResult {
  word: string
  candidate: string
  similarity: number
}

export interface FuzzyMatchMessage {
  type: 'fuzzyMatch'
  id: number
  requests: FuzzyMatchRequest[]
}

export interface FuzzyMatchResultMessage {
  type: 'fuzzyMatchResult'
  id: number
  results: FuzzyMatchResult[]
}

/**
 * Find line number at a given character index without splitting entire string
 * More memory efficient than content.split('\n')
 */
function findLineNumber(content: string, charIndex: number): number {
  let lineNumber = 1
  for (let i = 0; i < charIndex && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) { // newline
      lineNumber++
    }
  }
  return lineNumber
}

/**
 * Extract snippet around match without creating intermediate arrays
 */
function extractSnippet(content: string, matchIndex: number, query: string): string {
  const maxLength = 150
  const contextBefore = 40
  const contextAfter = 60

  // Find line boundaries around match
  let lineStart = matchIndex
  let linesBack = 1
  while (lineStart > 0 && linesBack >= 0) {
    lineStart--
    if (content.charCodeAt(lineStart) === 10) {
      linesBack--
    }
  }
  if (lineStart > 0) lineStart++ // Move past the newline

  let lineEnd = matchIndex + query.length
  let linesForward = 1
  while (lineEnd < content.length && linesForward >= 0) {
    if (content.charCodeAt(lineEnd) === 10) {
      linesForward--
    }
    lineEnd++
  }

  let snippet = content.substring(lineStart, lineEnd).trim()

  // Truncate if too long, centering on query
  if (snippet.length > maxLength) {
    const queryInSnippet = snippet.toLowerCase().indexOf(query.toLowerCase())
    if (queryInSnippet !== -1) {
      const start = Math.max(0, queryInSnippet - contextBefore)
      const end = Math.min(snippet.length, queryInSnippet + query.length + contextAfter)
      snippet = (start > 0 ? '...' : '') +
                snippet.substring(start, end) +
                (end < snippet.length ? '...' : '')
    } else {
      snippet = snippet.substring(0, maxLength) + '...'
    }
  }

  return snippet
}

/**
 * Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null))

  for (let i = 0; i <= str1.length; i++) {
    matrix[0][i] = i
  }

  for (let j = 0; j <= str2.length; j++) {
    matrix[j][0] = j
  }

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[j][i] = matrix[j - 1][i - 1]
      } else {
        matrix[j][i] = Math.min(
          matrix[j - 1][i - 1] + 1, // substitution
          matrix[j][i - 1] + 1,     // insertion
          matrix[j - 1][i] + 1      // deletion
        )
      }
    }
  }

  return matrix[str2.length][str1.length]
}

/**
 * Calculate similarity between two words (0-1)
 */
function calculateSimilarity(word1: string, word2: string): number {
  const longer = word1.length > word2.length ? word1 : word2
  const shorter = word1.length <= word2.length ? word1 : word2

  if (longer.length === 0) return 1.0

  const editDistance = levenshteinDistance(longer, shorter)
  return (longer.length - editDistance) / longer.length
}

/**
 * Batch fuzzy matching - process multiple word comparisons
 */
function processFuzzyMatches(requests: FuzzyMatchRequest[]): FuzzyMatchResult[] {
  const results: FuzzyMatchResult[] = []

  for (const request of requests) {
    for (const candidate of request.candidates) {
      const similarity = calculateSimilarity(request.word, candidate)
      if (similarity >= request.threshold) {
        results.push({
          word: request.word,
          candidate,
          similarity
        })
      }
    }
  }

  return results
}

/**
 * Search file content for query
 */
function searchContent(
  query: string,
  files: FileData[],
  caseSensitive: boolean,
  maxResults: number
): ContentSearchResult[] {
  const results: ContentSearchResult[] = []
  const searchQuery = caseSensitive ? query : query.toLowerCase()

  for (const file of files) {
    if (results.length >= maxResults) break

    const content = file.content
    const searchableContent = caseSensitive ? content : content.toLowerCase()

    const matchIndex = searchableContent.indexOf(searchQuery)
    if (matchIndex === -1) continue

    results.push({
      filePath: file.path,
      fileId: file.id,
      fileName: file.name,
      lineNumber: findLineNumber(content, matchIndex),
      snippet: extractSnippet(content, matchIndex, query),
      score: 5
    })
  }

  return results
}

// Handle messages from main thread
type WorkerMessage = SearchMessage | FuzzyMatchMessage

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data

  if (message.type === 'search') {
    const results = searchContent(
      message.query,
      message.files,
      message.caseSensitive,
      message.maxResults
    )

    self.postMessage({
      type: 'result',
      id: message.id,
      results
    } satisfies SearchResultMessage)
  } else if (message.type === 'fuzzyMatch') {
    const results = processFuzzyMatches(message.requests)

    self.postMessage({
      type: 'fuzzyMatchResult',
      id: message.id,
      results
    } satisfies FuzzyMatchResultMessage)
  }
}
