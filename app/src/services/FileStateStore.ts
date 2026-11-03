/**
 * FileStateStore - UI state persistence
 *
 * Storage strategy:
 * - localStorage (synchronous write-through) — primary for reads, survives refresh/unload
 * - @siglum/filesystem (async backup) — debounced 100ms
 *
 * Every state change writes to localStorage synchronously, then queues
 * an async filesystem write. On load, localStorage is read first (instant),
 * falling back to filesystem if localStorage is empty.
 *
 * Paths:
 * - /state/app.json              - App settings (filesystem backup)
 * - /state/docs/{documentId}.json - Per-document state (filesystem backup)
 */

import { fileSystem } from '@siglum/filesystem'
import type { FileItem } from './ProjectStore'

const STATE_PATH = '/state'
const DOCS_STATE_PATH = '/state/docs'
const APP_STATE_FILE = '/state/app.json'
const MIGRATION_KEY = 'siglum_state_migrated_v1'
const LS_APP_STATE_KEY = 'siglum_app_state' // localStorage write-through (synchronous, survives unload)
const LS_DOC_PREFIX = 'siglum_doc_' // localStorage prefix for recent doc states

export interface DocumentState {
  cursorStart: number
  cursorEnd: number
  scrollTop: number
  scrollLeft: number
  pdfRenderScale?: number
  pdfTransformX?: number
  pdfTransformY?: number
  pdfTransformScale?: number
  pdfCurrentPage?: number
  updatedAt: number
}

export interface CompilerSettings {
  autoCompile: boolean
  compiler: 'auto' | 'pdflatex' | 'xelatex'
  ctanFetch: boolean
  cachePreamble: boolean
  autoUnload: boolean
}

interface AppState {
  sidebarExpanded: boolean
  currentDocumentId: string | null
  recentDocumentIds: string[]
  projectFiles: FileItem[]
  compilerSettings: CompilerSettings | null
  showWordCount: boolean
  showCompileStatus: boolean
  showDebugInfo: boolean
  sessionToken: string | null
  reviewerName: string | null
}

const DEFAULT_APP_STATE: AppState = {
  sidebarExpanded: false,
  currentDocumentId: null,
  recentDocumentIds: [],
  projectFiles: [],
  compilerSettings: null,
  showWordCount: false,
  showCompileStatus: true,
  showDebugInfo: false,
  sessionToken: null,
  reviewerName: null
}

interface PendingWrite {
  type: 'app' | 'doc'
  key: string
  value: unknown
}

class FileStateStore {
  private appState: AppState = { ...DEFAULT_APP_STATE }
  private docStateCache = new Map<string, DocumentState>()
  private readonly MAX_DOC_CACHE_SIZE = 20

  private pendingWrites = new Map<string, PendingWrite>()
  private flushTimeout: number | null = null
  private readonly FLUSH_DELAY = 100

  // Debounced localStorage writes for document state (batched per animation frame)
  private docLsDirty = new Set<string>()
  private docLsRaf: number | null = null

  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor() {
    // Hydrate in-memory state from localStorage immediately (synchronous).
    // This ensures that any subsequent setter (e.g. setSidebarExpanded) that
    // calls saveToLocalStorage() won't overwrite OTHER fields with defaults.
    try {
      const raw = localStorage.getItem(LS_APP_STATE_KEY)
      if (raw) {
        this.appState = { ...DEFAULT_APP_STATE, ...JSON.parse(raw) }
      }
    } catch { /* corrupted or unavailable — keep defaults */ }

    // Force flush on page unload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.flushSync()
      })
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.flushSync()
        }
      })
    }
  }

  // ========================================
  // Initialization
  // ========================================

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._initialize().then(
      () => { this.initialized = true },
      (e) => { this.initPromise = null; throw e }
    )
    return this.initPromise
  }

  private async _initialize(): Promise<void> {
    // Mount state directory
    if (!fileSystem.isMounted(STATE_PATH)) {
      await fileSystem.mountAuto(STATE_PATH)
    }

    // Ensure directories exist
    try {
      await fileSystem.mkdir(STATE_PATH, { silent: true })
      await fileSystem.mkdir(DOCS_STATE_PATH, { silent: true })
    } catch {
      // Directories may already exist
    }

    // Migrate from IndexedDB if needed
    if (!localStorage.getItem(MIGRATION_KEY)) {
      await this.migrateFromIndexedDB()
      localStorage.setItem(MIGRATION_KEY, 'complete')
    }

    // Load app state
    await this.loadAppState()
  }

  private async loadAppState(): Promise<void> {
    // Primary source: localStorage (synchronous, always survives refresh)
    try {
      const lsContent = localStorage.getItem(LS_APP_STATE_KEY)
      if (lsContent) {
        this.appState = { ...DEFAULT_APP_STATE, ...JSON.parse(lsContent) }
        console.log('[StateStore] Loaded from localStorage:', this.appState.currentDocumentId)
        return
      }
    } catch { /* corrupted, fall through */ }

    // Fallback: filesystem (may not have been flushed before last unload)
    try {
      const content = await fileSystem.readFile(APP_STATE_FILE)
      this.appState = { ...DEFAULT_APP_STATE, ...JSON.parse(content) }
      console.log('[StateStore] Loaded from filesystem:', this.appState.currentDocumentId)
      // Backfill localStorage so future loads are instant
      this.saveToLocalStorage()
    } catch {
      // File doesn't exist yet, use defaults
      console.log('[StateStore] No saved state found, using defaults')
      this.appState = { ...DEFAULT_APP_STATE }
    }
  }

  private saveToLocalStorage(): void {
    try {
      localStorage.setItem(LS_APP_STATE_KEY, JSON.stringify(this.appState))
    } catch { /* quota exceeded — non-fatal */ }
  }

  private saveDocToLocalStorage(documentId: string, state: DocumentState): void {
    try {
      localStorage.setItem(LS_DOC_PREFIX + documentId, JSON.stringify(state))
    } catch { /* quota exceeded — non-fatal */ }
  }

  private queueDocLsWrite(documentId: string): void {
    this.docLsDirty.add(documentId)
    if (this.docLsRaf === null) {
      this.docLsRaf = requestAnimationFrame(() => {
        this.docLsRaf = null
        for (const id of this.docLsDirty) {
          const state = this.docStateCache.get(id)
          if (state) this.saveDocToLocalStorage(id, state)
        }
        this.docLsDirty.clear()
      })
    }
  }

  private flushDocLs(): void {
    if (this.docLsRaf !== null) {
      cancelAnimationFrame(this.docLsRaf)
      this.docLsRaf = null
    }
    for (const id of this.docLsDirty) {
      const state = this.docStateCache.get(id)
      if (state) this.saveDocToLocalStorage(id, state)
    }
    this.docLsDirty.clear()
  }

  // ========================================
  // Migration from IndexedDB
  // ========================================

  private async migrateFromIndexedDB(): Promise<void> {
    const dbExists = await this.checkDatabaseExists('siglum_state')
    if (!dbExists) {
      // Also check for localStorage migration
      await this.migrateFromLocalStorage()
      return
    }

    console.log('[FileStateStore] Migrating from IndexedDB...')

    try {
      const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('siglum_state', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

      // Migrate app settings
      if (oldDb.objectStoreNames.contains('app')) {
        const appSettings = await this.readAllFromStore(oldDb, 'app')
        const migratedApp: Partial<AppState> = {}

        for (const [key, value] of Object.entries(appSettings)) {
          switch (key) {
            case 'sidebar_expanded': migratedApp.sidebarExpanded = value as boolean; break
            case 'current_document_id': migratedApp.currentDocumentId = value as string | null; break
            case 'recent_document_ids': migratedApp.recentDocumentIds = value as string[]; break
            case 'project_files': migratedApp.projectFiles = value as FileItem[]; break
            case 'compiler_settings': migratedApp.compilerSettings = value as CompilerSettings | null; break
            case 'show_word_count': migratedApp.showWordCount = value as boolean; break
            case 'show_compile_status': migratedApp.showCompileStatus = value as boolean; break
            case 'show_debug_info': migratedApp.showDebugInfo = value as boolean; break
            case 'session_token': migratedApp.sessionToken = value as string | null; break
            case 'reviewer_name': migratedApp.reviewerName = value as string | null; break
          }
        }

        this.appState = { ...DEFAULT_APP_STATE, ...migratedApp }
        this.saveToLocalStorage()
        await fileSystem.writeFile(APP_STATE_FILE, JSON.stringify(this.appState))
      }

      // Migrate document states (parallel writes)
      if (oldDb.objectStoreNames.contains('document_state')) {
        const docStates = await this.readAllFromStore(oldDb, 'document_state')
        const states = Object.values(docStates) as Array<DocumentState & { documentId: string }>

        await Promise.all(
          states
            .filter(state => state.documentId)
            .map(state => {
              const docPath = `${DOCS_STATE_PATH}/${state.documentId}.json`
              const { documentId, ...stateWithoutId } = state
              return fileSystem.writeFile(docPath, JSON.stringify(stateWithoutId))
            })
        )
      }

      oldDb.close()
      console.log('[FileStateStore] Migration from IndexedDB complete')
    } catch (e) {
      console.warn('[FileStateStore] IndexedDB migration failed:', e)
    }
  }

  private async migrateFromLocalStorage(): Promise<void> {
    console.log('[FileStateStore] Checking localStorage for legacy data...')

    const migratedApp: Partial<AppState> = {}

    // Migrate sidebar state
    const sidebarSaved = localStorage.getItem('siglum-sidebar-expanded')
    if (sidebarSaved !== null) {
      migratedApp.sidebarExpanded = sidebarSaved === 'true'
    }

    // Migrate current document
    const currentDocSaved = localStorage.getItem('siglum_current_document')
    if (currentDocSaved !== null) {
      migratedApp.currentDocumentId = currentDocSaved
    }

    // Migrate recent documents
    const recentSaved = localStorage.getItem('siglum_recent_documents')
    if (recentSaved !== null) {
      try {
        migratedApp.recentDocumentIds = JSON.parse(recentSaved)
      } catch { /* ignore */ }
    }

    // Migrate project files
    const projectFilesSaved = localStorage.getItem('siglum-project-files')
    if (projectFilesSaved !== null) {
      try {
        migratedApp.projectFiles = JSON.parse(projectFilesSaved)
      } catch { /* ignore */ }
    }

    // Migrate session token
    const sessionTokenSaved = localStorage.getItem('siglum-session-token')
    if (sessionTokenSaved !== null) {
      migratedApp.sessionToken = sessionTokenSaved
    }

    // Migrate reviewer name
    const reviewerNameSaved = localStorage.getItem('siglum-reviewer-name')
    if (reviewerNameSaved !== null) {
      migratedApp.reviewerName = reviewerNameSaved
    }

    if (Object.keys(migratedApp).length > 0) {
      this.appState = { ...DEFAULT_APP_STATE, ...migratedApp }
      this.saveToLocalStorage()
      await fileSystem.writeFile(APP_STATE_FILE, JSON.stringify(this.appState))
      console.log('[FileStateStore] Migrated settings from localStorage')
    }
  }

  private async checkDatabaseExists(dbName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const request = indexedDB.open(dbName, 1)
      request.onsuccess = () => {
        const db = request.result
        const hasStores = db.objectStoreNames.length > 0
        db.close()
        resolve(hasStores)
      }
      request.onerror = () => resolve(false)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        resolve(false)
      }
    })
  }

  private async readAllFromStore(db: IDBDatabase, storeName: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const result: Record<string, unknown> = {}
      const transaction = db.transaction([storeName], 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.openCursor()

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result
        if (cursor) {
          result[cursor.key as string] = cursor.value
          cursor.continue()
        } else {
          resolve(result)
        }
      }

      request.onerror = () => reject(request.error)
    })
  }

  // ========================================
  // Batched Write System
  // ========================================

  private queueWrite(type: 'app' | 'doc', key: string, value: unknown): void {
    const writeKey = `${type}:${key}`
    this.pendingWrites.set(writeKey, { type, key, value })

    // Write-through to localStorage (survives unload/refresh)
    if (type === 'app') {
      this.saveToLocalStorage() // Sync — app writes are infrequent
    } else {
      this.queueDocLsWrite(key) // Debounced — doc writes are frequent (cursor/scroll)
    }

    if (this.flushTimeout === null) {
      this.flushTimeout = window.setTimeout(() => this.flush(), this.FLUSH_DELAY)
    }
  }

  private async flush(): Promise<void> {
    this.flushTimeout = null

    if (this.pendingWrites.size === 0) return

    // Skip filesystem writes if not initialized yet - localStorage has the data
    if (!this.initialized) {
      this.pendingWrites.clear()
      return
    }

    const writes = Array.from(this.pendingWrites.values())
    this.pendingWrites.clear()

    try {
      // Collect all write promises
      const writePromises: Promise<void>[] = []
      let hasAppWrite = false

      for (const write of writes) {
        if (write.type === 'app') {
          hasAppWrite = true
        } else {
          const docPath = `${DOCS_STATE_PATH}/${write.key}.json`
          writePromises.push(fileSystem.writeFile(docPath, JSON.stringify(write.value)))
        }
      }

      // Write app state once if any app writes queued
      if (hasAppWrite) {
        writePromises.push(fileSystem.writeFile(APP_STATE_FILE, JSON.stringify(this.appState)))
      }

      // Execute all writes in parallel
      await Promise.all(writePromises)
    } catch (error) {
      console.error('[FileStateStore] Flush failed:', error)
    }
  }

  private flushSync(): void {
    // Flush any debounced localStorage doc writes first
    this.flushDocLs()

    if (this.flushTimeout !== null) {
      clearTimeout(this.flushTimeout)
      this.flushTimeout = null
    }

    if (this.pendingWrites.size === 0) return

    // Skip filesystem writes if not initialized - localStorage has the data
    if (!this.initialized) {
      this.pendingWrites.clear()
      return
    }

    // localStorage is already up-to-date (written synchronously in queueWrite).
    // Fire async filesystem writes as best-effort backup (may not complete on unload).
    let hasAppWrite = false

    for (const write of this.pendingWrites.values()) {
      if (write.type === 'app') {
        hasAppWrite = true
      } else {
        const docPath = `${DOCS_STATE_PATH}/${write.key}.json`
        fileSystem.writeFile(docPath, JSON.stringify(write.value)).catch(() => {})
      }
    }

    if (hasAppWrite) {
      fileSystem.writeFile(APP_STATE_FILE, JSON.stringify(this.appState)).catch(() => {})
    }

    this.pendingWrites.clear()
  }

  async forceFlush(): Promise<void> {
    if (this.flushTimeout !== null) {
      clearTimeout(this.flushTimeout)
      this.flushTimeout = null
    }
    await this.flush()
  }

  // ========================================
  // LRU Cache for Document States
  // ========================================

  private touchDocCache(documentId: string, state: DocumentState): void {
    this.docStateCache.delete(documentId)
    this.docStateCache.set(documentId, state)

    while (this.docStateCache.size > this.MAX_DOC_CACHE_SIZE) {
      const oldestKey = this.docStateCache.keys().next().value
      if (oldestKey) this.docStateCache.delete(oldestKey)
    }
  }

  // ========================================
  // Synchronous State Access (localStorage only, no initialization required)
  // ========================================

  /**
   * Read all app state synchronously from localStorage.
   * Does NOT require initialize() — safe to call immediately on mount.
   * Returns defaults for any missing values.
   */
  getAppStateSync(): AppState {
    try {
      const raw = localStorage.getItem(LS_APP_STATE_KEY)
      if (raw) {
        return { ...DEFAULT_APP_STATE, ...JSON.parse(raw) }
      }
    } catch { /* corrupted or unavailable */ }
    return { ...DEFAULT_APP_STATE }
  }

  // ========================================
  // App Settings
  // ========================================

  async getSidebarExpanded(): Promise<boolean> {
    await this.initialize()
    return this.appState.sidebarExpanded
  }

  setSidebarExpanded(expanded: boolean): void {
    this.appState.sidebarExpanded = expanded
    this.queueWrite('app', 'sidebarExpanded', expanded)
  }


  async getCurrentDocumentId(): Promise<string | null> {
    // Check direct localStorage key first
    try {
      const direct = localStorage.getItem('siglum_current_doc')
      if (direct !== null) return direct || null
    } catch {}
    await this.initialize()
    return this.appState.currentDocumentId
  }

  setCurrentDocumentId(id: string | null): void {
    this.appState.currentDocumentId = id
    try { localStorage.setItem('siglum_current_doc', id ?? '') } catch {}
    this.queueWrite('app', 'currentDocumentId', id)
  }

  async getRecentDocumentIds(): Promise<string[]> {
    await this.initialize()
    return this.appState.recentDocumentIds
  }

  setRecentDocumentIds(ids: string[]): void {
    this.appState.recentDocumentIds = ids
    this.queueWrite('app', 'recentDocumentIds', ids)
  }

  async getProjectFiles(): Promise<FileItem[]> {
    await this.initialize()
    return this.appState.projectFiles
  }

  setProjectFiles(files: FileItem[]): void {
    this.appState.projectFiles = files
    this.queueWrite('app', 'projectFiles', files)
  }

  async getCompilerSettings(): Promise<CompilerSettings | null> {
    await this.initialize()
    return this.appState.compilerSettings
  }

  setCompilerSettings(settings: CompilerSettings): void {
    this.appState.compilerSettings = settings
    this.queueWrite('app', 'compilerSettings', settings)
  }

  async getShowWordCount(): Promise<boolean> {
    await this.initialize()
    return this.appState.showWordCount
  }

  setShowWordCount(show: boolean): void {
    this.appState.showWordCount = show
    this.queueWrite('app', 'showWordCount', show)
  }

  async getShowCompileStatus(): Promise<boolean> {
    await this.initialize()
    return this.appState.showCompileStatus
  }

  setShowCompileStatus(show: boolean): void {
    this.appState.showCompileStatus = show
    this.queueWrite('app', 'showCompileStatus', show)
  }

  async getShowDebugInfo(): Promise<boolean> {
    await this.initialize()
    return this.appState.showDebugInfo
  }

  setShowDebugInfo(show: boolean): void {
    this.appState.showDebugInfo = show
    this.queueWrite('app', 'showDebugInfo', show)
  }

  async getSessionToken(): Promise<string | null> {
    await this.initialize()
    return this.appState.sessionToken
  }

  setSessionToken(token: string): void {
    this.appState.sessionToken = token
    this.queueWrite('app', 'sessionToken', token)
  }

  async getReviewerName(): Promise<string | null> {
    await this.initialize()
    return this.appState.reviewerName
  }

  setReviewerName(name: string): void {
    this.appState.reviewerName = name
    this.queueWrite('app', 'reviewerName', name)
  }

  // ========================================
  // Document State
  // ========================================

  /**
   * Synchronous state lookup — checks in-memory cache and localStorage only.
   * No initialization required. Use this for instant restore on tab switch.
   */
  getDocumentStateSync(documentId: string): DocumentState | null {
    // Check in-memory cache first
    if (this.docStateCache.has(documentId)) {
      const cached = this.docStateCache.get(documentId)!
      this.docStateCache.delete(documentId)
      this.docStateCache.set(documentId, cached)
      return cached
    }

    // Check localStorage (synchronous, always up to date)
    try {
      const lsContent = localStorage.getItem(LS_DOC_PREFIX + documentId)
      if (lsContent) {
        const state: DocumentState = JSON.parse(lsContent)
        this.touchDocCache(documentId, state)
        return state
      }
    } catch { /* corrupted */ }

    return null
  }

  async getDocumentState(documentId: string): Promise<DocumentState | null> {
    await this.initialize()

    // Check cache first - move to end for LRU on hit
    if (this.docStateCache.has(documentId)) {
      const cached = this.docStateCache.get(documentId)!
      this.docStateCache.delete(documentId)
      this.docStateCache.set(documentId, cached)
      return cached
    }

    // Check localStorage (synchronous, always up to date)
    try {
      const lsContent = localStorage.getItem(LS_DOC_PREFIX + documentId)
      if (lsContent) {
        const state: DocumentState = JSON.parse(lsContent)
        this.touchDocCache(documentId, state)
        return state
      }
    } catch { /* corrupted, fall through */ }

    // Fallback: filesystem
    try {
      const docPath = `${DOCS_STATE_PATH}/${documentId}.json`
      const content = await fileSystem.readFile(docPath)
      const state: DocumentState = JSON.parse(content)
      this.touchDocCache(documentId, state)
      return state
    } catch {
      return null
    }
  }

  setCursorPosition(documentId: string, start: number, end: number): void {
    const existing = this.docStateCache.get(documentId)
    const state: DocumentState = {
      cursorStart: start,
      cursorEnd: end,
      scrollTop: existing?.scrollTop ?? 0,
      scrollLeft: existing?.scrollLeft ?? 0,
      pdfRenderScale: existing?.pdfRenderScale,
      pdfTransformX: existing?.pdfTransformX,
      pdfTransformY: existing?.pdfTransformY,
      pdfTransformScale: existing?.pdfTransformScale,
      pdfCurrentPage: existing?.pdfCurrentPage,
      updatedAt: Date.now()
    }
    this.touchDocCache(documentId, state)
    this.queueWrite('doc', documentId, state)
  }

  setScrollPosition(documentId: string, scrollTop: number, scrollLeft: number): void {
    const existing = this.docStateCache.get(documentId)
    const state: DocumentState = {
      cursorStart: existing?.cursorStart ?? 0,
      cursorEnd: existing?.cursorEnd ?? 0,
      scrollTop,
      scrollLeft,
      pdfRenderScale: existing?.pdfRenderScale,
      pdfTransformX: existing?.pdfTransformX,
      pdfTransformY: existing?.pdfTransformY,
      pdfTransformScale: existing?.pdfTransformScale,
      pdfCurrentPage: existing?.pdfCurrentPage,
      updatedAt: Date.now()
    }
    this.touchDocCache(documentId, state)
    this.queueWrite('doc', documentId, state)
  }

  setPdfViewerState(
    documentId: string,
    renderScale: number,
    transformX: number,
    transformY: number,
    transformScale: number,
    currentPage: number
  ): void {
    const existing = this.docStateCache.get(documentId)
    const state: DocumentState = {
      cursorStart: existing?.cursorStart ?? 0,
      cursorEnd: existing?.cursorEnd ?? 0,
      scrollTop: existing?.scrollTop ?? 0,
      scrollLeft: existing?.scrollLeft ?? 0,
      pdfRenderScale: renderScale,
      pdfTransformX: transformX,
      pdfTransformY: transformY,
      pdfTransformScale: transformScale,
      pdfCurrentPage: currentPage,
      updatedAt: Date.now()
    }
    this.touchDocCache(documentId, state)
    this.queueWrite('doc', documentId, state)
  }

  async deleteDocumentState(documentId: string): Promise<void> {
    await this.initialize()

    this.docStateCache.delete(documentId)

    try {
      const docPath = `${DOCS_STATE_PATH}/${documentId}.json`
      await fileSystem.deleteFile(docPath)
    } catch {
      // File might not exist
    }
  }

  async pruneDocumentStates(keepCount: number = 50): Promise<void> {
    await this.initialize()

    try {
      const entries = await fileSystem.readdir(DOCS_STATE_PATH)
      const stateFiles = entries.filter(e => e.name.endsWith('.json'))

      if (stateFiles.length <= keepCount) return

      // Load all states in parallel to sort by updatedAt
      // NOTE: Construct path manually to work around FileSystemService.readdir path-join bug
      const results = await Promise.all(
        stateFiles.map(async (entry) => {
          const fullPath = `${DOCS_STATE_PATH}/${entry.name}`
          try {
            const content = await fileSystem.readFile(fullPath)
            const state: DocumentState = JSON.parse(content)
            return { path: fullPath, updatedAt: state.updatedAt || 0, valid: true }
          } catch {
            // Mark corrupted files for deletion
            return { path: fullPath, updatedAt: 0, valid: false }
          }
        })
      )

      // Delete corrupted files
      const corrupted = results.filter(r => !r.valid)
      if (corrupted.length > 0) {
        await Promise.all(corrupted.map(r => fileSystem.deleteFile(r.path).catch(() => {})))
      }

      // Sort valid states by updatedAt (oldest first)
      const validStates = results.filter(r => r.valid)
      validStates.sort((a, b) => a.updatedAt - b.updatedAt)

      // Delete oldest entries in parallel
      const deleteCount = Math.max(0, validStates.length - keepCount)
      if (deleteCount > 0) {
        const toDelete = validStates.slice(0, deleteCount)
        await Promise.all(toDelete.map(s => fileSystem.deleteFile(s.path).catch(() => {})))
        console.log(`[FileStateStore] Pruned ${deleteCount} old document states`)
      }
    } catch (e) {
      console.warn('[FileStateStore] Prune failed:', e)
    }
  }
}

export default new FileStateStore()
