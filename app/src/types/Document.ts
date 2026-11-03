export interface UndoState {
  content: string
  cursorPosition: { start: number; end: number }
  timestamp: number
}

/**
 * Document metadata
 * Content is stored separately in the filesystem
 */
export interface DocumentMetadata {
  id: string
  filePath: string        // Path in filesystem (e.g., /documents/abc123.tex)
  title: string           // Auto-generated from first meaningful line
  createdAt: Date
  updatedAt: Date
  lastViewedAt: Date
  wordCount: number
}

/**
 * Full document with content loaded from filesystem
 * Used at runtime when editing
 */
export interface SiglumDocument {
  id: string
  title: string           // Auto-generated from first meaningful line
  content: string         // LaTeX source (loaded from filesystem)
  createdAt: Date
  updatedAt: Date
  lastViewedAt: Date
  wordCount: number
  searchableText: string  // Processed content for search (derived, not stored)
  filePath?: string       // Path in filesystem
  undoHistory?: UndoState[]  // Stack of previous states (in-memory only)
  redoHistory?: UndoState[]  // Stack of future states for redo (in-memory only)
  undoIndex?: number      // Current position in undo history
}

/**
 * Convert metadata + content to full document
 */
export function toSiglumDocument(metadata: DocumentMetadata, content: string, searchableText: string): SiglumDocument {
  return {
    id: metadata.id,
    title: metadata.title,
    content,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    lastViewedAt: metadata.lastViewedAt,
    wordCount: metadata.wordCount,
    searchableText,
    filePath: metadata.filePath
  }
}

/**
 * Extract metadata from a full document
 */
export function toDocumentMetadata(doc: SiglumDocument, filePath: string): DocumentMetadata {
  return {
    id: doc.id,
    filePath,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastViewedAt: doc.lastViewedAt,
    wordCount: doc.wordCount
  }
}

export interface MatchPosition {
  line: number        // 1-indexed line number
  column: number      // 0-indexed column in line
  context: string     // Line content with <mark> tags around match
}

export interface SearchResult {
  document: SiglumDocument
  relevanceScore: number
  matchedTerms: string[]
  snippet: string         // Context around the match
  highlights: string[]    // HTML highlighted matches
  matches: MatchPosition[] // All match positions in content
}

export interface DocumentMetrics {
  editFrequency: number   // Times edited per day
  viewRecency: Date      // Last viewed
  wordCount: number      // Document length
  searchScore: number    // How often found in search
}

export type DocumentSortBy = 'recent' | 'alphabetical' | 'created' | 'updated'