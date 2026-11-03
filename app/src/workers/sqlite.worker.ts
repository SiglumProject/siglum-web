/**
 * SQLite WASM Worker - Full-text search using FTS5
 *
 * Provides persistent, high-performance search indexing using SQLite WASM with:
 * - FTS5 full-text search with BM25 ranking
 * - Persistent storage via opfs-sahpool VFS
 * - Support for 10,000+ documents
 *
 * The worker communicates via postMessage and handles:
 * - init: Initialize SQLite and create tables
 * - search: Full-text search with snippets
 * - upsert: Add or update a document
 * - delete: Remove a document
 * - bulk: Batch operations for initial indexing
 */

// Message types
export interface SQLiteInitMessage {
  type: 'init'
  id: number
}

export interface SQLiteSearchMessage {
  type: 'search'
  id: number
  query: string
  limit?: number
}

export interface SQLiteUpsertMessage {
  type: 'upsert'
  id: number
  docId: string
  title: string
  content: string
}

export interface SQLiteDeleteMessage {
  type: 'delete'
  id: number
  docId: string
}

export interface SQLiteBulkMessage {
  type: 'bulk'
  id: number
  documents: Array<{ id: string; title: string; content: string }>
}

export interface SQLiteResultMessage {
  id: number
  success: boolean
  error?: string
  results?: SQLiteSearchResult[]
}

export interface SQLiteSearchResult {
  docId: string
  title: string
  snippet: string
  rank: number
}

type SQLiteMessage =
  | SQLiteInitMessage
  | SQLiteSearchMessage
  | SQLiteUpsertMessage
  | SQLiteDeleteMessage
  | SQLiteBulkMessage

// SQLite WASM types (minimal interface)
interface SQLite3 {
  oo1: {
    DB: new (filename: string, mode?: string) => SQLiteDB
    OpfsDb?: new (filename: string) => SQLiteDB
  }
  opfs?: {
    OpfsDb: new (filename: string) => SQLiteDB
  }
  installOpfsSAHPoolVfs?: (options: { name: string; initialCapacity?: number }) => Promise<any>
}

interface SQLiteDB {
  exec(sql: string, options?: { bind?: any[]; returnValue?: string; rowMode?: string }): any[]
  close(): void
}

// Global state
let db: SQLiteDB | null = null
let sqlite3: SQLite3 | null = null
let initialized = false

/**
 * Load SQLite WASM
 *
 * Tries multiple sources in order:
 * 1. Local bundled copy (if available via npm install @aspect-build/aspect-sqlite3-wasm or similar)
 * 2. Official SQLite CDN (requires network access)
 *
 * Note: For production, consider bundling sqlite3.wasm locally to avoid CDN dependency.
 * Install: npm install @aspect-build/aspect-sqlite3-wasm
 */
async function loadSQLite(): Promise<SQLite3> {
  // Load from CDN using dynamic import with type assertion
  const cdnUrl = 'https://sqlite.org/wasm/jswasm/sqlite3.mjs'

  try {
    // Use Function constructor to avoid TypeScript module resolution
    const importFn = new Function('url', 'return import(url)') as (url: string) => Promise<{ default: () => Promise<SQLite3> }>
    const sqlite3Module = await importFn(cdnUrl)
    console.log('[SQLite] Using CDN WASM')
    return sqlite3Module.default()
  } catch (e) {
    throw new Error(
      `Failed to load SQLite WASM from CDN. ` +
      `Ensure network access to sqlite.org. Error: ${e}`
    )
  }
}

/**
 * Initialize SQLite with OPFS persistence
 */
async function initDatabase(): Promise<void> {
  if (initialized && db) return

  try {
    // Load SQLite WASM
    sqlite3 = await loadSQLite()

    // Try to use OPFS with opfs-sahpool VFS for best performance
    let dbPath = '/siglum-search.db'
    let useOpfs = false

    if (sqlite3.installOpfsSAHPoolVfs) {
      try {
        const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
          name: 'siglum-search-pool',
          initialCapacity: 6
        })
        // Use pool-based OPFS database
        db = new poolUtil.OpfsSAHPoolDb(dbPath)
        useOpfs = true
        console.log('[SQLite] Using OPFS SAH Pool VFS')
      } catch (e) {
        console.warn('[SQLite] OPFS SAH Pool unavailable, trying standard OPFS')
      }
    }

    if (!useOpfs && sqlite3.opfs?.OpfsDb) {
      try {
        db = new sqlite3.opfs.OpfsDb(dbPath)
        useOpfs = true
        console.log('[SQLite] Using standard OPFS VFS')
      } catch (e) {
        console.warn('[SQLite] OPFS unavailable, using in-memory database')
      }
    }

    if (!useOpfs) {
      // Fall back to in-memory database
      db = new sqlite3.oo1.DB(':memory:')
      console.log('[SQLite] Using in-memory database (data will not persist)')
    }

    // TypeScript assertion - one of the above paths must have set db
    if (!db) throw new Error('Failed to create database')

    // Create tables
    db.exec(`
      -- Main documents table
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- FTS5 virtual table for full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        title,
        content,
        content='documents',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS index in sync
      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, title, content)
        VALUES (new.rowid, new.title, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, content)
        VALUES('delete', old.rowid, old.title, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, content)
        VALUES('delete', old.rowid, old.title, old.content);
        INSERT INTO documents_fts(rowid, title, content)
        VALUES (new.rowid, new.title, new.content);
      END;
    `)

    initialized = true
    console.log('[SQLite] Database initialized successfully')
  } catch (e) {
    console.error('[SQLite] Initialization failed:', e)
    throw e
  }
}

/**
 * Search documents using FTS5
 */
function search(query: string, limit: number = 50): SQLiteSearchResult[] {
  if (!db) throw new Error('Database not initialized')

  // Escape special FTS5 characters and prepare query
  const sanitizedQuery = query
    .replace(/[^\w\s]/g, ' ')  // Remove special chars
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)
    .map(w => `"${w}"*`)  // Prefix matching
    .join(' OR ')

  if (!sanitizedQuery) {
    // Return recent documents if no valid query
    const results = db.exec(`
      SELECT id, title, substr(content, 1, 200) as snippet, 0 as rank
      FROM documents
      ORDER BY updated_at DESC
      LIMIT ?
    `, { bind: [limit], returnValue: 'resultRows', rowMode: 'object' })

    return results.map((row: any) => ({
      docId: row.id,
      title: row.title,
      snippet: row.snippet,
      rank: row.rank
    }))
  }

  // Full-text search with BM25 ranking
  const results = db.exec(`
    SELECT
      d.id,
      d.title,
      snippet(documents_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
      bm25(documents_fts, 2.0, 1.0) as rank
    FROM documents_fts
    JOIN documents d ON documents_fts.rowid = d.rowid
    WHERE documents_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `, { bind: [sanitizedQuery, limit], returnValue: 'resultRows', rowMode: 'object' })

  return results.map((row: any) => ({
    docId: row.id,
    title: row.title,
    snippet: row.snippet || '',
    rank: row.rank
  }))
}

/**
 * Insert or update a document
 */
function upsertDocument(docId: string, title: string, content: string): void {
  if (!db) throw new Error('Database not initialized')

  db.exec(`
    INSERT OR REPLACE INTO documents (id, title, content, updated_at)
    VALUES (?, ?, ?, ?)
  `, { bind: [docId, title, content, Date.now()] })
}

/**
 * Delete a document
 */
function deleteDocument(docId: string): void {
  if (!db) throw new Error('Database not initialized')

  db.exec(`DELETE FROM documents WHERE id = ?`, { bind: [docId] })
}

/**
 * Bulk insert documents (for initial indexing)
 */
function bulkUpsert(documents: Array<{ id: string; title: string; content: string }>): void {
  if (!db) throw new Error('Database not initialized')

  const now = Date.now()

  // Use transaction for better performance
  db.exec('BEGIN TRANSACTION')
  try {
    for (const doc of documents) {
      db.exec(`
        INSERT OR REPLACE INTO documents (id, title, content, updated_at)
        VALUES (?, ?, ?, ?)
      `, { bind: [doc.id, doc.title, doc.content, now] })
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// Message handler
self.onmessage = async (event: MessageEvent<SQLiteMessage>) => {
  const message = event.data
  const response: SQLiteResultMessage = { id: message.id, success: false }

  try {
    switch (message.type) {
      case 'init':
        await initDatabase()
        response.success = true
        break

      case 'search':
        response.results = search(message.query, message.limit)
        response.success = true
        break

      case 'upsert':
        upsertDocument(message.docId, message.title, message.content)
        response.success = true
        break

      case 'delete':
        deleteDocument(message.docId)
        response.success = true
        break

      case 'bulk':
        bulkUpsert(message.documents)
        response.success = true
        break
    }
  } catch (e) {
    response.error = e instanceof Error ? e.message : String(e)
  }

  self.postMessage(response)
}
