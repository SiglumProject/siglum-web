/**
 * SQLiteSearchService - Wrapper for SQLite WASM worker
 *
 * Provides a Promise-based API for full-text search using SQLite FTS5.
 * All operations run in a web worker to keep the main thread responsive.
 */

import type {
  SQLiteInitMessage,
  SQLiteSearchMessage,
  SQLiteUpsertMessage,
  SQLiteDeleteMessage,
  SQLiteBulkMessage,
  SQLiteResultMessage,
  SQLiteSearchResult
} from '../workers/sqlite.worker'
import type { SiglumDocument, SearchResult, MatchPosition } from '../types/Document'

type SQLiteMessage =
  | SQLiteInitMessage
  | SQLiteSearchMessage
  | SQLiteUpsertMessage
  | SQLiteDeleteMessage
  | SQLiteBulkMessage

// Distributive Omit for union types
type OmitId<T> = T extends { id: number } ? Omit<T, 'id'> : never
type SQLiteMessageWithoutId = OmitId<SQLiteMessage>

class SQLiteSearchServiceClass {
  private worker: Worker | null = null
  private messageId = 0
  private pending = new Map<number, {
    resolve: (result: any) => void
    reject: (error: Error) => void
  }>()
  private initialized = false
  private initPromise: Promise<void> | null = null

  /**
   * Initialize the SQLite worker
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._initialize()
    try {
      await this.initPromise
      this.initialized = true
    } catch (e) {
      this.initPromise = null
      throw e
    }
  }

  private async _initialize(): Promise<void> {
    // Create the worker
    this.worker = new Worker(
      new URL('../workers/sqlite.worker.ts', import.meta.url),
      { type: 'module' }
    )

    // Set up message handler
    this.worker.onmessage = (event: MessageEvent<SQLiteResultMessage>) => {
      const { id, success, error, results } = event.data
      const handler = this.pending.get(id)

      if (handler) {
        this.pending.delete(id)
        if (success) {
          handler.resolve(results)
        } else {
          handler.reject(new Error(error || 'Unknown SQLite error'))
        }
      }
    }

    this.worker.onerror = (event) => {
      console.error('[SQLiteSearch] Worker error:', event.message)
      // Reject all pending requests
      for (const [id, handler] of this.pending) {
        handler.reject(new Error(`Worker error: ${event.message}`))
        this.pending.delete(id)
      }
    }

    // Initialize the database
    await this.send({ type: 'init' })
  }

  /**
   * Send a message to the worker and wait for response
   */
  private send<T>(message: SQLiteMessageWithoutId): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('SQLite worker not initialized'))
    }

    return new Promise((resolve, reject) => {
      const id = ++this.messageId
      this.pending.set(id, { resolve, reject })

      const fullMessage = { ...message, id } as SQLiteMessage
      this.worker!.postMessage(fullMessage)
    })
  }

  /**
   * Search documents using full-text search
   */
  async search(query: string, limit: number = 50): Promise<SearchResult[]> {
    await this.initialize()

    const results = await this.send<SQLiteSearchResult[]>({
      type: 'search',
      query,
      limit
    })

    // Transform SQLite results to SearchResult format
    return (results || []).map(r => this.toSearchResult(r, query))
  }

  /**
   * Update or insert a document in the index
   */
  async updateDocument(doc: SiglumDocument): Promise<void> {
    await this.initialize()

    await this.send({
      type: 'upsert',
      docId: doc.id,
      title: doc.title,
      content: doc.searchableText || doc.content
    })
  }

  /**
   * Remove a document from the index
   */
  async removeDocument(docId: string): Promise<void> {
    await this.initialize()

    await this.send({
      type: 'delete',
      docId
    })
  }

  /**
   * Bulk index multiple documents (for initial load)
   */
  async bulkIndex(documents: SiglumDocument[]): Promise<void> {
    await this.initialize()

    await this.send({
      type: 'bulk',
      documents: documents.map(doc => ({
        id: doc.id,
        title: doc.title,
        content: doc.searchableText || doc.content
      }))
    })
  }

  /**
   * Transform SQLite result to SearchResult format
   */
  private toSearchResult(result: SQLiteSearchResult, query: string): SearchResult {
    // Extract match positions from content
    const matches = this.findMatchPositions(result.snippet, query)

    return {
      document: {
        id: result.docId,
        title: result.title,
        content: '', // Not returned from search for efficiency
        searchableText: '',
        createdAt: new Date(),
        updatedAt: new Date(),
        lastViewedAt: new Date()
      } as SiglumDocument,
      relevanceScore: -result.rank, // BM25 returns negative scores (higher = better match)
      matchedTerms: query.trim().split(/\s+/).filter(w => w.length > 1),
      snippet: result.snippet,
      highlights: [result.snippet],
      matches
    }
  }

  /**
   * Find match positions in snippet for jump-to functionality
   */
  private findMatchPositions(snippet: string, query: string): MatchPosition[] {
    const positions: MatchPosition[] = []
    const hasQueryWords = query.trim().split(/\s+/).some(w => w.length > 1)

    // Look for <mark> tags in the snippet (added by SQLite snippet function)
    const markRegex = /<mark>([^<]+)<\/mark>/gi
    let match

    while ((match = markRegex.exec(snippet)) !== null) {
      // We don't have full content here, so line numbers will be approximate
      // The actual line will be determined when the document is loaded
      positions.push({
        line: 1, // Will be updated when document is loaded
        column: match.index,
        context: snippet
      })
    }

    // If no marks found but query has words, return first position
    if (positions.length === 0 && hasQueryWords) {
      positions.push({
        line: 1,
        column: 0,
        context: snippet
      })
    }

    return positions
  }

  /**
   * Terminate the worker (call on cleanup)
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
      this.initialized = false
      this.initPromise = null
      this.pending.clear()
    }
  }
}

// Export singleton instance
const SQLiteSearchService = new SQLiteSearchServiceClass()
export default SQLiteSearchService
