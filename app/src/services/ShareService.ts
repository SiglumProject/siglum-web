/**
 * ShareService - Manages PDF snapshots and comments
 *
 * Each share is a snapshot of the compiled PDF at a moment in time.
 * Comments are tied to that snapshot and don't migrate between versions.
 *
 * Storage:
 * - /shares/{shareId}/metadata.json - Share metadata + comments
 * - /shares/{shareId}/snapshot.pdf - PDF binary
 */

import { fileSystem } from '@siglum/filesystem'

export interface Comment {
  id: string
  /** Page number (1-indexed) */
  page: number
  /** Position on page (0-1 normalized) */
  x: number
  y: number
  /** Selected text if any */
  selectedText?: string
  /** Comment content */
  text: string
  /** Author name (optional, anonymous by default) */
  author?: string
  /** Timestamp */
  createdAt: Date
  /** Session token for ownership (allows editing/deleting own comments) */
  sessionToken?: string
}

export interface Share {
  /** Unique share ID (used in URL) */
  id: string
  /** Document/project name */
  name: string
  /** When the share was created */
  createdAt: Date
  /** Comments on this share */
  comments: Comment[]
  /** Number of comments last time author viewed */
  lastSeenCommentCount: number
}

// Internal type for storage (excludes pdfData which is stored separately)
interface ShareMetadata {
  id: string
  name: string
  createdAt: string // ISO string for JSON serialization
  comments: Array<Omit<Comment, 'createdAt'> & { createdAt: string }>
  lastSeenCommentCount: number
}

export interface ShareStatus {
  /** Total shares */
  totalShares: number
  /** Total unread comments across all shares */
  unreadComments: number
}

type ShareStatusListener = (status: ShareStatus) => void

const SHARES_PATH = '/shares'
const LEGACY_STORAGE_KEY = 'siglum-shares'

class ShareServiceClass {
  private shares: Share[] = []
  private listeners: Set<ShareStatusListener> = new Set()
  private initialized = false
  private initPromise: Promise<void> | null = null

  /**
   * Initialize the service (must be called before other operations)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._initialize()
    try {
      await this.initPromise
      this.initialized = true
    } catch (e) {
      // Clear promise so retry is possible
      this.initPromise = null
      throw e
    }
  }

  private async _initialize(): Promise<void> {
    // Mount filesystem
    await fileSystem.mountAuto(SHARES_PATH)

    // Migrate from localStorage if needed
    await this.migrateFromLocalStorage()

    // Load shares from filesystem
    await this.loadFromFilesystem()
  }

  /**
   * Migrate shares from localStorage to filesystem (one-time migration)
   */
  private async migrateFromLocalStorage(): Promise<void> {
    if (typeof localStorage === 'undefined') return

    const saved = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!saved) return

    try {
      const parsed = JSON.parse(saved)
      console.log(`[ShareService] Migrating ${parsed.length} shares from localStorage to filesystem`)

      for (const share of parsed) {
        const shareId = share.id
        const dirPath = `${SHARES_PATH}/${shareId}`

        // Write metadata (without pdfData)
        const metadata: ShareMetadata = {
          id: share.id,
          name: share.name,
          createdAt: share.createdAt,
          comments: share.comments || [],
          lastSeenCommentCount: share.lastSeenCommentCount || 0
        }
        await fileSystem.writeFile(`${dirPath}/metadata.json`, JSON.stringify(metadata), { createParents: true })

        // Write PDF binary
        if (share.pdfData) {
          const pdfBinary = this.base64ToUint8Array(share.pdfData)
          await fileSystem.writeBinary(`${dirPath}/snapshot.pdf`, pdfBinary, { createParents: true })
        }
      }

      // Remove from localStorage after successful migration
      localStorage.removeItem(LEGACY_STORAGE_KEY)
      console.log('[ShareService] Migration complete')
    } catch (e) {
      console.error('[ShareService] Migration failed:', e)
    }
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  /**
   * Load all shares from filesystem
   */
  private async loadFromFilesystem(): Promise<void> {
    try {
      // Check if shares directory exists
      const exists = await fileSystem.exists(SHARES_PATH)
      if (!exists) {
        this.shares = []
        return
      }

      // List all share directories
      const entries = await fileSystem.readdir(SHARES_PATH)
      const sharePromises = entries
        .filter(e => e.isDirectory)
        .map(async (entry) => {
          try {
            const metadataPath = `${SHARES_PATH}/${entry.name}/metadata.json`
            const content = await fileSystem.readFile(metadataPath)
            const metadata: ShareMetadata = JSON.parse(content)

            return {
              id: metadata.id,
              name: metadata.name,
              createdAt: new Date(metadata.createdAt),
              comments: metadata.comments.map(c => ({
                ...c,
                createdAt: new Date(c.createdAt)
              })),
              lastSeenCommentCount: metadata.lastSeenCommentCount
            } as Share
          } catch (e) {
            console.warn(`[ShareService] Failed to load share ${entry.name}:`, e)
            return null
          }
        })

      const results = await Promise.all(sharePromises)
      this.shares = results.filter((s): s is Share => s !== null)
    } catch (e) {
      console.error('[ShareService] Failed to load shares:', e)
      this.shares = []
    }
  }

  /**
   * Save a share's metadata to filesystem
   */
  private async saveMetadata(share: Share): Promise<void> {
    const metadata: ShareMetadata = {
      id: share.id,
      name: share.name,
      createdAt: share.createdAt.toISOString(),
      comments: share.comments.map(c => ({
        ...c,
        createdAt: c.createdAt.toISOString()
      })),
      lastSeenCommentCount: share.lastSeenCommentCount
    }

    const dirPath = `${SHARES_PATH}/${share.id}`
    await fileSystem.writeFile(`${dirPath}/metadata.json`, JSON.stringify(metadata), { createParents: true })
  }

  private notifyListeners(): void {
    const status = this.getStatus()
    this.listeners.forEach(l => l(status))
  }

  private generateId(): string {
    // Short, URL-safe ID
    return Math.random().toString(36).substring(2, 10)
  }

  /**
   * Subscribe to status changes
   */
  subscribe(listener: ShareStatusListener): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => this.listeners.delete(listener)
  }

  /**
   * Get current status
   */
  getStatus(): ShareStatus {
    let unreadComments = 0
    for (const share of this.shares) {
      const newComments = share.comments.length - share.lastSeenCommentCount
      if (newComments > 0) {
        unreadComments += newComments
      }
    }
    return {
      totalShares: this.shares.length,
      unreadComments
    }
  }

  /**
   * Get all shares (most recent first)
   */
  getShares(): Share[] {
    return [...this.shares].sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime()
    )
  }

  /**
   * Get a specific share by ID
   */
  getShare(id: string): Share | undefined {
    return this.shares.find(s => s.id === id)
  }

  /**
   * Create a new share from current PDF
   */
  async createShare(name: string, pdfData: ArrayBuffer): Promise<Share> {
    await this.initialize()

    const shareId = this.generateId()
    const dirPath = `${SHARES_PATH}/${shareId}`

    const share: Share = {
      id: shareId,
      name,
      createdAt: new Date(),
      comments: [],
      lastSeenCommentCount: 0
    }

    // Save PDF binary
    await fileSystem.writeBinary(`${dirPath}/snapshot.pdf`, new Uint8Array(pdfData), { createParents: true })

    // Save metadata
    await this.saveMetadata(share)

    this.shares.push(share)
    this.notifyListeners()

    return share
  }

  /**
   * Add a comment to a share
   */
  async addComment(shareId: string, comment: Omit<Comment, 'id' | 'createdAt'>): Promise<Comment | null> {
    await this.initialize()

    const share = this.shares.find(s => s.id === shareId)
    if (!share) return null

    const newComment: Comment = {
      ...comment,
      id: this.generateId(),
      createdAt: new Date()
    }

    share.comments.push(newComment)
    await this.saveMetadata(share)
    this.notifyListeners()

    return newComment
  }

  /**
   * Update a comment (requires matching session token)
   */
  async updateComment(shareId: string, commentId: string, text: string, sessionToken: string): Promise<boolean> {
    await this.initialize()

    const share = this.shares.find(s => s.id === shareId)
    if (!share) return false

    const comment = share.comments.find(c => c.id === commentId)
    if (!comment || comment.sessionToken !== sessionToken) return false

    comment.text = text
    await this.saveMetadata(share)
    this.notifyListeners()

    return true
  }

  /**
   * Delete a comment (requires matching session token)
   */
  async deleteComment(shareId: string, commentId: string, sessionToken: string): Promise<boolean> {
    await this.initialize()

    const share = this.shares.find(s => s.id === shareId)
    if (!share) return false

    const commentIndex = share.comments.findIndex(c => c.id === commentId)
    if (commentIndex === -1) return false

    const comment = share.comments[commentIndex]
    if (comment.sessionToken !== sessionToken) return false

    share.comments.splice(commentIndex, 1)
    await this.saveMetadata(share)
    this.notifyListeners()

    return true
  }

  /**
   * Mark a share as viewed (updates lastSeenCommentCount)
   */
  async markAsViewed(shareId: string): Promise<void> {
    await this.initialize()

    const share = this.shares.find(s => s.id === shareId)
    if (!share) return

    share.lastSeenCommentCount = share.comments.length
    await this.saveMetadata(share)
    this.notifyListeners()
  }

  /**
   * Delete a share
   */
  async deleteShare(shareId: string): Promise<void> {
    await this.initialize()

    const dirPath = `${SHARES_PATH}/${shareId}`

    // Delete files
    try {
      await fileSystem.deleteFile(`${dirPath}/metadata.json`)
      await fileSystem.deleteFile(`${dirPath}/snapshot.pdf`)
      await fileSystem.rmdir(dirPath)
    } catch (e) {
      console.warn('[ShareService] Error deleting share files:', e)
    }

    this.shares = this.shares.filter(s => s.id !== shareId)
    this.notifyListeners()
  }

  /**
   * Get PDF data as ArrayBuffer for a share
   */
  async getPdfData(shareId: string): Promise<ArrayBuffer | null> {
    await this.initialize()

    const share = this.shares.find(s => s.id === shareId)
    if (!share) return null

    try {
      const pdfPath = `${SHARES_PATH}/${shareId}/snapshot.pdf`
      const data = await fileSystem.readBinary(pdfPath)
      return data.buffer
    } catch (e) {
      console.error('[ShareService] Failed to read PDF:', e)
      return null
    }
  }

  /**
   * Get share URL
   */
  getShareUrl(shareId: string): string {
    // For now, use current origin. Later this could be a dedicated share domain.
    return `${window.location.origin}/share/${shareId}`
  }
}

// Singleton instance
const ShareService = new ShareServiceClass()
export default ShareService
