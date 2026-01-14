/**
 * StateStore - UI state persistence in IndexedDB
 *
 * Stores all UI state in IndexedDB instead of localStorage for:
 * - Better performance with large data
 * - No storage limits (localStorage is 5-10MB)
 * - Works in Web Workers (future-proofing)
 * - Batched writes with debouncing for reduced I/O
 *
 * State includes:
 * - App settings (sidebar, onboarding, etc.)
 * - Document state (cursor, scroll, current doc)
 * - Project files
 * - Recent documents
 */

import type { FileItem } from '../components/ProjectSidebar'

const DB_NAME = 'siglum_state'
const DB_VERSION = 1

// Store names
const APP_STORE = 'app'
const DOC_STATE_STORE = 'document_state'

// App state keys
const APP_KEYS = {
  SIDEBAR_EXPANDED: 'sidebar_expanded',
  ONBOARDING_COMPLETE: 'onboarding_complete',
  CURRENT_DOCUMENT_ID: 'current_document_id',
  RECENT_DOCUMENT_IDS: 'recent_document_ids',
  PROJECT_FILES: 'project_files',
  COMPILER_SETTINGS: 'compiler_settings',
} as const

export interface DocumentState {
  documentId: string
  cursorStart: number
  cursorEnd: number
  scrollTop: number
  scrollLeft: number
  updatedAt: number
}

export interface CompilerSettings {
  autoCompile: boolean
  compiler: 'auto' | 'pdflatex' | 'xelatex'
  ctanFetch: boolean
  cachePreamble: boolean
  autoUnload: boolean
}

// Pending writes for batching
interface PendingWrite {
  store: string
  key: string
  value: unknown
}

class StateStore {
  private dbPromise: Promise<IDBDatabase>
  private pendingWrites = new Map<string, PendingWrite>()
  private flushTimeout: number | null = null
  private readonly FLUSH_DELAY = 100 // ms
  // In-memory cache for document states to avoid async lookups
  // Limited to 20 entries with LRU eviction to prevent unbounded memory growth
  private docStateCache = new Map<string, DocumentState>()
  private readonly MAX_DOC_CACHE_SIZE = 20

  // LRU cache helper: move key to end (most recent) and evict oldest if needed
  private touchDocCache(documentId: string, state: DocumentState): void {
    // Delete and re-add to move to end (Map maintains insertion order)
    this.docStateCache.delete(documentId)
    this.docStateCache.set(documentId, state)

    // Evict oldest entries if over limit
    while (this.docStateCache.size > this.MAX_DOC_CACHE_SIZE) {
      const oldestKey = this.docStateCache.keys().next().value
      if (oldestKey) this.docStateCache.delete(oldestKey)
    }
  }

  constructor() {
    this.dbPromise = this.initDB()

    // Force flush on page unload to save cursor position
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.flushSync()
      })
      // Also flush on visibility change (tab switch, minimize)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.flushSync()
        }
      })
    }
  }

  // Synchronous flush for unload events (uses sendBeacon pattern)
  private flushSync(): void {
    if (this.flushTimeout !== null) {
      clearTimeout(this.flushTimeout)
      this.flushTimeout = null
    }

    if (this.pendingWrites.size === 0) return

    // For unload, we need to do this synchronously
    // IndexedDB transactions might not complete, so we try anyway
    const writes = Array.from(this.pendingWrites.values())
    this.pendingWrites.clear()

    // Try to write synchronously (may not always complete on unload)
    this.dbPromise.then(db => {
      const stores = [...new Set(writes.map(w => w.store))]
      const tx = db.transaction(stores, 'readwrite')

      for (const write of writes) {
        const store = tx.objectStore(write.store)
        if (write.store === DOC_STATE_STORE) {
          store.put(write.value)
        } else {
          store.put(write.value, write.key)
        }
      }
    }).catch(() => {
      // Ignore errors during unload
    })
  }

  private async initDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // App settings store (key-value)
        if (!db.objectStoreNames.contains(APP_STORE)) {
          db.createObjectStore(APP_STORE)
        }

        // Per-document state store
        if (!db.objectStoreNames.contains(DOC_STATE_STORE)) {
          const docStore = db.createObjectStore(DOC_STATE_STORE, { keyPath: 'documentId' })
          docStore.createIndex('updatedAt', 'updatedAt', { unique: false })
        }
      }
    })
  }

  // ========================================
  // Batched write system
  // ========================================

  private queueWrite(store: string, key: string, value: unknown): void {
    const writeKey = `${store}:${key}`
    this.pendingWrites.set(writeKey, { store, key, value })

    if (this.flushTimeout === null) {
      this.flushTimeout = window.setTimeout(() => this.flush(), this.FLUSH_DELAY)
    }
  }

  private async flush(): Promise<void> {
    this.flushTimeout = null

    if (this.pendingWrites.size === 0) return

    const writes = Array.from(this.pendingWrites.values())
    this.pendingWrites.clear()

    try {
      const db = await this.dbPromise
      const stores = [...new Set(writes.map(w => w.store))]
      const tx = db.transaction(stores, 'readwrite')

      for (const write of writes) {
        const store = tx.objectStore(write.store)
        if (write.store === DOC_STATE_STORE) {
          store.put(write.value)
        } else {
          store.put(write.value, write.key)
        }
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch (error) {
      console.error('[StateStore] Flush failed:', error)
    }
  }

  // Force flush (for critical writes)
  async forceFlush(): Promise<void> {
    if (this.flushTimeout !== null) {
      clearTimeout(this.flushTimeout)
      this.flushTimeout = null
    }
    await this.flush()
  }

  // ========================================
  // App Settings
  // ========================================

  async getSidebarExpanded(): Promise<boolean> {
    return (await this.getAppValue(APP_KEYS.SIDEBAR_EXPANDED)) ?? false
  }

  setSidebarExpanded(expanded: boolean): void {
    this.queueWrite(APP_STORE, APP_KEYS.SIDEBAR_EXPANDED, expanded)
  }

  async getOnboardingComplete(): Promise<boolean> {
    return (await this.getAppValue(APP_KEYS.ONBOARDING_COMPLETE)) ?? false
  }

  setOnboardingComplete(complete: boolean): void {
    this.queueWrite(APP_STORE, APP_KEYS.ONBOARDING_COMPLETE, complete)
  }

  async getCurrentDocumentId(): Promise<string | null> {
    return (await this.getAppValue(APP_KEYS.CURRENT_DOCUMENT_ID)) ?? null
  }

  setCurrentDocumentId(id: string | null): void {
    this.queueWrite(APP_STORE, APP_KEYS.CURRENT_DOCUMENT_ID, id)
  }

  async getRecentDocumentIds(): Promise<string[]> {
    return (await this.getAppValue(APP_KEYS.RECENT_DOCUMENT_IDS)) ?? []
  }

  setRecentDocumentIds(ids: string[]): void {
    this.queueWrite(APP_STORE, APP_KEYS.RECENT_DOCUMENT_IDS, ids)
  }

  async getProjectFiles(): Promise<FileItem[]> {
    return (await this.getAppValue(APP_KEYS.PROJECT_FILES)) ?? []
  }

  setProjectFiles(files: FileItem[]): void {
    this.queueWrite(APP_STORE, APP_KEYS.PROJECT_FILES, files)
  }

  async getCompilerSettings(): Promise<CompilerSettings | null> {
    return (await this.getAppValue(APP_KEYS.COMPILER_SETTINGS)) ?? null
  }

  setCompilerSettings(settings: CompilerSettings): void {
    this.queueWrite(APP_STORE, APP_KEYS.COMPILER_SETTINGS, settings)
  }

  private async getAppValue<T>(key: string): Promise<T | undefined> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const tx = db.transaction([APP_STORE], 'readonly')
      const store = tx.objectStore(APP_STORE)
      const request = store.get(key)

      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error)
    })
  }

  // ========================================
  // Document State (cursor, scroll)
  // ========================================

  async getDocumentState(documentId: string): Promise<DocumentState | null> {
    // Check cache first
    const cached = this.docStateCache.get(documentId)
    if (cached) return cached

    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const tx = db.transaction([DOC_STATE_STORE], 'readonly')
      const store = tx.objectStore(DOC_STATE_STORE)
      const request = store.get(documentId)

      request.onsuccess = () => {
        const result = request.result ?? null
        // Populate cache with LRU eviction
        if (result) {
          this.touchDocCache(documentId, result)
        }
        resolve(result)
      }
      request.onerror = () => reject(request.error)
    })
  }

  setCursorPosition(documentId: string, start: number, end: number): void {
    // Use in-memory cache for synchronous access (critical for beforeunload)
    const existing = this.docStateCache.get(documentId)
    const state: DocumentState = {
      documentId,
      cursorStart: start,
      cursorEnd: end,
      scrollTop: existing?.scrollTop ?? 0,
      scrollLeft: existing?.scrollLeft ?? 0,
      updatedAt: Date.now()
    }
    // Update cache immediately with LRU eviction
    this.touchDocCache(documentId, state)
    this.queueWrite(DOC_STATE_STORE, documentId, state)
  }

  setScrollPosition(documentId: string, scrollTop: number, scrollLeft: number): void {
    // Use in-memory cache for synchronous access (critical for beforeunload)
    const existing = this.docStateCache.get(documentId)
    const state: DocumentState = {
      documentId,
      cursorStart: existing?.cursorStart ?? 0,
      cursorEnd: existing?.cursorEnd ?? 0,
      scrollTop,
      scrollLeft,
      updatedAt: Date.now()
    }
    // Update cache immediately with LRU eviction
    this.touchDocCache(documentId, state)
    this.queueWrite(DOC_STATE_STORE, documentId, state)
  }

  async deleteDocumentState(documentId: string): Promise<void> {
    // Clear from cache
    this.docStateCache.delete(documentId)

    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const tx = db.transaction([DOC_STATE_STORE], 'readwrite')
      const store = tx.objectStore(DOC_STATE_STORE)
      const request = store.delete(documentId)

      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  // Clean up old document states (keep last 50)
  async pruneDocumentStates(keepCount: number = 50): Promise<void> {
    const db = await this.dbPromise

    return new Promise((resolve, reject) => {
      const tx = db.transaction([DOC_STATE_STORE], 'readwrite')
      const store = tx.objectStore(DOC_STATE_STORE)
      const index = store.index('updatedAt')

      // Get all sorted by updatedAt (oldest first)
      const request = index.openCursor()
      const toDelete: string[] = []
      let count = 0

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result
        if (cursor) {
          count++
          const state = cursor.value as DocumentState
          toDelete.push(state.documentId)
          cursor.continue()
        } else {
          // Delete oldest entries if we have more than keepCount
          const deleteCount = Math.max(0, count - keepCount)
          for (let i = 0; i < deleteCount; i++) {
            store.delete(toDelete[i])
          }
          resolve()
        }
      }

      request.onerror = () => reject(request.error)
    })
  }

  // ========================================
  // Migration from localStorage
  // ========================================

  async migrateFromLocalStorage(): Promise<void> {
    // Check if already migrated
    const migrated = await this.getAppValue<boolean>('_migrated_from_localstorage')
    if (migrated) return

    console.log('[StateStore] Migrating from localStorage...')

    // Migrate sidebar state
    const sidebarSaved = localStorage.getItem('siglum-sidebar-expanded')
    if (sidebarSaved !== null) {
      this.queueWrite(APP_STORE, APP_KEYS.SIDEBAR_EXPANDED, sidebarSaved === 'true')
    }

    // Migrate onboarding state
    const onboardingSaved = localStorage.getItem('siglum-onboarding-complete')
    if (onboardingSaved !== null) {
      this.queueWrite(APP_STORE, APP_KEYS.ONBOARDING_COMPLETE, onboardingSaved === 'true')
    }

    // Migrate current document
    const currentDocSaved = localStorage.getItem('siglum_current_document')
    if (currentDocSaved !== null) {
      this.queueWrite(APP_STORE, APP_KEYS.CURRENT_DOCUMENT_ID, currentDocSaved)
    }

    // Migrate recent documents
    const recentSaved = localStorage.getItem('siglum_recent_documents')
    if (recentSaved !== null) {
      try {
        const recent = JSON.parse(recentSaved)
        this.queueWrite(APP_STORE, APP_KEYS.RECENT_DOCUMENT_IDS, recent)
      } catch { /* ignore */ }
    }

    // Migrate project files
    const projectFilesSaved = localStorage.getItem('siglum-project-files')
    if (projectFilesSaved !== null) {
      try {
        const files = JSON.parse(projectFilesSaved)
        this.queueWrite(APP_STORE, APP_KEYS.PROJECT_FILES, files)
      } catch { /* ignore */ }
    }

    // Mark as migrated
    this.queueWrite(APP_STORE, '_migrated_from_localstorage', true)

    // Force flush to complete migration
    await this.forceFlush()

    console.log('[StateStore] Migration complete')
  }
}

export default new StateStore()
