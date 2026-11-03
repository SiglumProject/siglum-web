/**
 * FileMetadataStore - Document metadata persistence using @siglum/filesystem
 *
 * Stores document metadata as JSON files alongside document content:
 * - /documents/{id}.tex       - document content
 * - /documents/{id}.meta.json - document metadata
 *
 * Replaces the old IndexedDB-based MetadataStore for unified storage.
 */

import type { DocumentMetadata } from '../types/Document'
import { fileSystem } from '@siglum/filesystem'

const DOCUMENTS_PATH = '/documents'
const MIGRATION_KEY = 'siglum_metadata_migrated_v1'

/**
 * JSON-serializable metadata format (dates as ISO strings)
 */
interface SerializedMetadata {
  id: string
  filePath: string
  title: string
  createdAt: string
  updatedAt: string
  lastViewedAt: string
  wordCount: number
}

class FileMetadataStore {
  private cache = new Map<string, DocumentMetadata>()
  private filePathIndex = new Map<string, string>() // filePath -> id for O(1) lookup
  private initialized = false
  private initPromise: Promise<void> | null = null

  /**
   * Initialize the store - load all metadata into cache
   */
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
    // Ensure documents directory is mounted
    if (!fileSystem.isMounted(DOCUMENTS_PATH)) {
      await fileSystem.mountAuto(DOCUMENTS_PATH)
    }

    // Check for legacy IndexedDB and migrate if needed
    if (!localStorage.getItem(MIGRATION_KEY)) {
      await this.migrateFromIndexedDB()
      localStorage.setItem(MIGRATION_KEY, 'complete')
    }

    // Load all metadata files into cache
    await this.loadCache()
  }

  /**
   * Load all .meta.json files into the in-memory cache
   * Uses parallel reads for better performance
   */
  private async loadCache(): Promise<void> {
    this.cache.clear()
    this.filePathIndex.clear()

    try {
      const entries = await fileSystem.readdir(DOCUMENTS_PATH)
      const metaFiles = entries.filter(e => e.name.endsWith('.meta.json'))

      // Parallel read all metadata files
      // NOTE: Construct path manually (DOCUMENTS_PATH + '/' + name) because
      // FileSystemService.readdir has a path-join bug where mount-relative
      // paths lose a separator (e.g. '/documentsabc.json' instead of '/documents/abc.json')
      const results = await Promise.all(
        metaFiles.map(async (entry) => {
          try {
            const fullPath = `${DOCUMENTS_PATH}/${entry.name}`
            const content = await fileSystem.readFile(fullPath)
            return JSON.parse(content) as SerializedMetadata
          } catch {
            return null
          }
        })
      )

      // Populate caches
      for (const serialized of results) {
        if (serialized) {
          const metadata = this.deserialize(serialized)
          this.cache.set(metadata.id, metadata)
          this.filePathIndex.set(metadata.filePath, metadata.id)
        }
      }

      console.log(`[FileMetadataStore] Loaded ${this.cache.size} documents into cache`)
    } catch {
      // Directory might not exist yet
      console.log('[FileMetadataStore] Documents directory empty or not found')
    }
  }

  /**
   * Migrate metadata from old IndexedDB store
   */
  private async migrateFromIndexedDB(): Promise<void> {
    const dbExists = await this.checkDatabaseExists('siglum_metadata', 'metadata')
    if (!dbExists) return

    console.log('[FileMetadataStore] Migrating from IndexedDB...')

    try {
      const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('siglum_metadata', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

      const oldMetadata = await new Promise<SerializedMetadata[]>((resolve, reject) => {
        const transaction = oldDb.transaction(['metadata'], 'readonly')
        const store = transaction.objectStore('metadata')
        const request = store.getAll()

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

      oldDb.close()

      // Write each metadata entry as a .meta.json file (parallel for speed)
      await Promise.all(
        oldMetadata.map(item => {
          const metaPath = `${DOCUMENTS_PATH}/${item.id}.meta.json`
          return fileSystem.writeFile(metaPath, JSON.stringify(item))
        })
      )

      console.log(`[FileMetadataStore] Migrated ${oldMetadata.length} entries from IndexedDB`)
    } catch (e) {
      console.warn('[FileMetadataStore] Migration failed:', e)
    }
  }

  private async checkDatabaseExists(dbName: string, storeName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const request = indexedDB.open(dbName, 1)
      request.onsuccess = () => {
        const db = request.result
        const hasStore = db.objectStoreNames.contains(storeName)
        db.close()
        resolve(hasStore)
      }
      request.onerror = () => resolve(false)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        resolve(false)
      }
    })
  }

  /**
   * Serialize metadata for JSON storage
   */
  private serialize(metadata: DocumentMetadata): SerializedMetadata {
    return {
      id: metadata.id,
      filePath: metadata.filePath,
      title: metadata.title,
      createdAt: metadata.createdAt.toISOString(),
      updatedAt: metadata.updatedAt.toISOString(),
      lastViewedAt: metadata.lastViewedAt.toISOString(),
      wordCount: metadata.wordCount
    }
  }

  /**
   * Deserialize metadata from JSON storage
   */
  private deserialize(serialized: SerializedMetadata): DocumentMetadata {
    return {
      id: serialized.id,
      filePath: serialized.filePath,
      title: serialized.title,
      createdAt: new Date(serialized.createdAt),
      updatedAt: new Date(serialized.updatedAt),
      lastViewedAt: new Date(serialized.lastViewedAt),
      wordCount: serialized.wordCount
    }
  }

  /**
   * Get the metadata file path for a document
   */
  private getMetaPath(id: string): string {
    return `${DOCUMENTS_PATH}/${id}.meta.json`
  }

  /**
   * Write metadata to filesystem and cache
   */
  private async writeMetadata(metadata: DocumentMetadata): Promise<void> {
    const metaPath = this.getMetaPath(metadata.id)
    const serialized = this.serialize(metadata)
    // Compact JSON for smaller file size
    await fileSystem.writeFile(metaPath, JSON.stringify(serialized))
    this.cache.set(metadata.id, metadata)
    this.filePathIndex.set(metadata.filePath, metadata.id)
  }

  // ========================================
  // Public API (same as old MetadataStore)
  // ========================================

  async create(metadata: DocumentMetadata): Promise<DocumentMetadata> {
    await this.initialize()
    await this.writeMetadata(metadata)
    return metadata
  }

  async update(id: string, updates: Partial<Omit<DocumentMetadata, 'id'>>): Promise<DocumentMetadata> {
    await this.initialize()

    const existing = this.cache.get(id)
    if (!existing) {
      throw new Error(`Document metadata with id ${id} not found`)
    }

    const updated: DocumentMetadata = {
      ...existing,
      ...updates,
      updatedAt: new Date()
    }

    await this.writeMetadata(updated)
    return updated
  }

  async getById(id: string): Promise<DocumentMetadata | null> {
    await this.initialize()
    return this.cache.get(id) || null
  }

  async getByFilePath(filePath: string): Promise<DocumentMetadata | null> {
    await this.initialize()

    // O(1) lookup using index
    const id = this.filePathIndex.get(filePath)
    return id ? this.cache.get(id) || null : null
  }

  async getAll(): Promise<DocumentMetadata[]> {
    await this.initialize()
    return Array.from(this.cache.values())
  }

  async getRecent(limit: number = 10): Promise<DocumentMetadata[]> {
    await this.initialize()

    return Array.from(this.cache.values())
      .sort((a, b) => b.lastViewedAt.getTime() - a.lastViewedAt.getTime())
      .slice(0, limit)
  }

  async delete(id: string): Promise<void> {
    await this.initialize()

    // Remove from index first
    const metadata = this.cache.get(id)
    if (metadata) {
      this.filePathIndex.delete(metadata.filePath)
    }

    const metaPath = this.getMetaPath(id)

    try {
      await fileSystem.deleteFile(metaPath)
    } catch {
      // File might not exist
    }

    this.cache.delete(id)
  }

  async updateLastViewed(id: string): Promise<void> {
    await this.update(id, { lastViewedAt: new Date() })
  }

  async count(): Promise<number> {
    await this.initialize()
    return this.cache.size
  }
}

export default new FileMetadataStore()
