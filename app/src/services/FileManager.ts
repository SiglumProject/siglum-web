/**
 * FileManager - Path-based file operations for the unified filesystem
 *
 * This service replaces DocumentManager with a simpler, path-based approach.
 * Files are stored at their actual paths (e.g., /project/main.tex) instead
 * of using random IDs.
 *
 * Key differences from DocumentManager:
 * - Uses paths instead of IDs
 * - Works directly with siglum-filesystem
 * - No separate metadata store
 * - Integrates with FileSystemWatcher for tree updates
 *
 * Usage:
 * ```typescript
 * import { fileManager } from './FileManager'
 *
 * // Open a file
 * const file = await fileManager.openFile('/project/main.tex')
 *
 * // Save changes
 * await fileManager.saveFile('/project/main.tex', newContent)
 *
 * // Create a new file
 * const newFile = await fileManager.createFile('/project/chapter1.tex', '')
 * ```
 */

import { fileSystem } from '@siglum/filesystem'
import { fileSystemWatcher } from './FileSystemWatcher'
import UndoManager from './UndoManager'
import EventBus from './EventBus'
import { DocumentSaveQueue } from './DocumentSaveQueue'

export interface OpenFile {
  path: string
  content: string
  isDirty: boolean
  cursorPosition?: { line: number; column: number }
}

const MAX_CACHE_SIZE = 20
const MAX_RECENT = 10
const RECENT_FILES_KEY = 'siglum_recent_files'
const CURRENT_FILE_KEY = 'siglum_current_file'

type FileChangeListener = (file: OpenFile | null) => void

class FileManagerService {
  readonly saveQueue = new DocumentSaveQueue((path, content) => this.saveDraft(path, content))
  private openFiles: Map<string, OpenFile> = new Map()
  private currentPath: string | null = null
  private recentPaths: string[] = []
  private initialized = false
  private initPromise: Promise<void> | null = null
  private listeners: Set<FileChangeListener> = new Set()

  /**
   * Initialize the FileManager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._initialize()
    await this.initPromise
    this.initialized = true
  }

  private async _initialize(): Promise<void> {
    // Ensure filesystem watcher is initialized (mounts filesystem)
    await fileSystemWatcher.initialize()

    // Load recent files from localStorage
    this.loadRecent()

    // Preload top 3 recent files
    await Promise.allSettled(
      this.recentPaths.slice(0, 3).map(path => this.preload(path))
    )
  }

  /**
   * Subscribe to current file changes
   */
  subscribe(listener: FileChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    const currentFile = this.getCurrentFile()
    this.listeners.forEach(fn => fn(currentFile))
  }

  /**
   * Get the currently open file
   */
  getCurrentFile(): OpenFile | null {
    return this.currentPath ? this.openFiles.get(this.currentPath) ?? null : null
  }

  /**
   * Get the current file path
   */
  getCurrentPath(): string | null {
    return this.currentPath
  }

  /**
   * Get cursor position for current file
   */
  getCursorPosition(): { line: number; column: number } | undefined {
    if (!this.currentPath) return undefined
    return this.openFiles.get(this.currentPath)?.cursorPosition
  }

  /**
   * Set cursor position for current file
   */
  setCursorPosition(position: { line: number; column: number }): void {
    if (!this.currentPath) return
    const file = this.openFiles.get(this.currentPath)
    if (file) file.cursorPosition = position
  }

  /**
   * Open a file by path
   */
  async openFile(path: string): Promise<OpenFile> {
    await this.initialize()

    // Normalize path
    const normalizedPath = this.normalizePath(path)

    // Check if already open
    if (this.openFiles.has(normalizedPath)) {
      this.currentPath = normalizedPath
      this.updateRecent(normalizedPath)
      this.saveCurrentFile()
      this.notify()
      EventBus.emit('documentSwitched', { id: normalizedPath })
      return this.openFiles.get(normalizedPath)!
    }

    // Read file from filesystem
    const content = await fileSystem.readFile(normalizedPath)

    const file: OpenFile = {
      path: normalizedPath,
      content,
      isDirty: false
    }

    this.addToCache(normalizedPath, file)
    this.currentPath = normalizedPath
    this.updateRecent(normalizedPath)

    // Initialize undo manager for this file
    UndoManager.init(normalizedPath, content)

    this.saveCurrentFile()
    this.notify()
    EventBus.emit('documentSwitched', { id: normalizedPath })

    return file
  }

  /**
   * Save file content
   */
  async saveFile(path: string, content: string): Promise<void> {
    await this.initialize()

    const normalizedPath = this.normalizePath(path)
    await fileSystem.writeFile(normalizedPath, content)

    const file = this.openFiles.get(normalizedPath)
    if (file) {
      file.content = content
      file.isDirty = false
    }

    // Refresh the file tree
    await fileSystemWatcher.refresh()
    this.notify()
  }

  /** Keep drafts in memory immediately, including when switching tabs before persistence. */
  stageContent(path: string, content: string): void {
    const file = this.openFiles.get(this.normalizePath(path))
    if (!file) return
    const cursor = this.getCursorPosition() || { line: 0, column: 0 }
    UndoManager.onContentChange(file.path, file.content, content, { start: cursor.line, end: cursor.line })
    file.content = content
    file.isDirty = true
    this.saveQueue.schedule(file.path, content)
  }

  async saveDraft(path: string, content: string): Promise<void> {
    const normalizedPath = this.normalizePath(path)
    await fileSystem.writeFile(normalizedPath, content)
    const file = this.openFiles.get(normalizedPath)
    // An earlier write must never replace text typed while it was in flight.
    if (file?.content === content) file.isDirty = false
    fileSystemWatcher.refresh().catch(() => {})
  }

  /**
   * Update content in memory (for auto-save debouncing)
   */
  async updateContent(content: string): Promise<void> {
    if (!this.currentPath) return

    const file = this.openFiles.get(this.currentPath)
    if (!file) return

    const cursor = this.getCursorPosition() || { line: 0, column: 0 }

    // Track for undo
    UndoManager.onContentChange(
      this.currentPath,
      file.content,
      content,
      { start: cursor.line, end: cursor.line }
    )

    // Save to filesystem
    await fileSystem.writeFile(this.currentPath, content)

    file.content = content
    file.isDirty = false

    // Fire and forget - don't block on tree refresh
    fileSystemWatcher.refresh().catch(() => {})
    this.notify()
  }

  /**
   * Create a new file
   */
  async createFile(path: string, content: string = ''): Promise<OpenFile> {
    await this.initialize()

    const normalizedPath = this.normalizePath(path)
    await fileSystem.writeFile(normalizedPath, content, { createParents: true })

    await fileSystemWatcher.refresh()
    return this.openFile(normalizedPath)
  }

  /**
   * Close a file (remove from recents and evict from cache, but don't delete from disk)
   */
  closeFile(path: string): void {
    const normalizedPath = this.normalizePath(path)
    if (!this.openFiles.get(normalizedPath)?.isDirty) this.openFiles.delete(normalizedPath)
    this.recentPaths = this.recentPaths.filter(p => p !== normalizedPath)
    this.saveRecent()
  }

  /**
   * Delete a file
   */
  async deleteFile(path: string): Promise<void> {
    await this.saveQueue.flushOrThrow()
    await this.initialize()

    const normalizedPath = this.normalizePath(path)
    await fileSystem.deleteFile(normalizedPath)

    this.openFiles.delete(normalizedPath)
    this.recentPaths = this.recentPaths.filter(p => p !== normalizedPath)
    this.saveRecent()

    if (this.currentPath === normalizedPath) {
      // Switch to most recent file
      const nextPath = this.recentPaths[0]
      if (nextPath) {
        await this.openFile(nextPath)
      } else {
        this.currentPath = null
        this.notify()
      }
    }

    await fileSystemWatcher.refresh()
  }

  /**
   * Rename a file
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.saveQueue.flushOrThrow()
    await this.initialize()

    const normalizedOld = this.normalizePath(oldPath)
    const normalizedNew = this.normalizePath(newPath)

    await fileSystem.rename(normalizedOld, normalizedNew)

    const remap = (path: string) => path === normalizedOld || path.startsWith(normalizedOld + '/')
      ? normalizedNew + path.slice(normalizedOld.length) : path
    for (const [path, file] of [...this.openFiles]) {
      const updated = remap(path)
      if (updated !== path) {
        this.openFiles.delete(path)
        this.openFiles.set(updated, { ...file, path: updated })
      }
    }
    this.recentPaths = this.recentPaths.map(remap)
    this.saveRecent()
    if (this.currentPath) this.currentPath = remap(this.currentPath)
    this.saveCurrentFile()

    await fileSystemWatcher.refresh()
    this.notify()
  }

  /**
   * Create a new directory
   */
  async createDirectory(path: string): Promise<void> {
    await this.initialize()
    const normalizedPath = this.normalizePath(path)
    await fileSystem.mkdir(normalizedPath)
    await fileSystemWatcher.refresh()
  }

  /**
   * Delete a directory
   */
  async deleteDirectory(path: string): Promise<void> {
    await this.saveQueue.flushOrThrow()
    await this.initialize()
    const normalizedPath = this.normalizePath(path)
    await fileSystem.rmdir(normalizedPath, { recursive: true })
    await fileSystemWatcher.refresh()
  }

  /**
   * Undo the last change
   */
  async undo(): Promise<{ content: string; cursorPosition: { start: number; end: number } } | null> {
    if (!this.currentPath) return null

    const file = this.openFiles.get(this.currentPath)
    if (!file) return null

    const cursor = this.getCursorPosition() || { line: 0, column: 0 }
    const prev = UndoManager.undo(this.currentPath, file.content, { start: cursor.line, end: cursor.line })

    if (!prev) return null

    await fileSystem.writeFile(this.currentPath, prev.content)
    file.content = prev.content

    this.notify()
    return prev
  }

  /**
   * Redo the last undone change
   */
  async redo(): Promise<{ content: string; cursorPosition: { start: number; end: number } } | null> {
    if (!this.currentPath) return null

    const file = this.openFiles.get(this.currentPath)
    if (!file) return null

    const cursor = this.getCursorPosition() || { line: 0, column: 0 }
    const next = UndoManager.redo(this.currentPath, file.content, { start: cursor.line, end: cursor.line })

    if (!next) return null

    await fileSystem.writeFile(this.currentPath, next.content)
    file.content = next.content

    this.notify()
    return next
  }

  /**
   * Get recent files
   */
  getRecentFiles(): OpenFile[] {
    return this.recentPaths
      .map(path => this.openFiles.get(path))
      .filter((f): f is OpenFile => !!f)
  }

  /**
   * Get recent file paths
   */
  getRecentPaths(): string[] {
    return [...this.recentPaths]
  }

  /**
   * Check if a path exists in the filesystem
   */
  async exists(path: string): Promise<boolean> {
    await this.initialize()
    return fileSystem.exists(this.normalizePath(path))
  }

  /**
   * Read a file without opening it
   */
  async readFile(path: string): Promise<string> {
    await this.initialize()
    return fileSystem.readFile(this.normalizePath(path))
  }

  /**
   * Write to a file without opening it
   */
  async writeFile(path: string, content: string): Promise<void> {
    await this.initialize()
    await fileSystem.writeFile(this.normalizePath(path), content, { createParents: true })
    await fileSystemWatcher.refresh()
  }

  /**
   * Export the current file as a download
   */
  exportFile(path?: string): void {
    const file = path ? this.openFiles.get(this.normalizePath(path)) : this.getCurrentFile()
    if (!file) return

    const blob = new Blob([file.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)

    const fileName = file.path.split('/').pop() || 'untitled.tex'
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()

    URL.revokeObjectURL(url)
  }

  /**
   * Get file path from URL parameter
   */
  getFilePathFromURL(): string | null {
    const params = new URL(window.location.href).searchParams
    return params.get('file') || params.get('doc')
  }

  /**
   * Set URL parameter for current file
   */
  setURLParam(path: string): void {
    const url = new URL(window.location.href)
    url.searchParams.set('file', path)
    window.history.replaceState(null, '', url.toString())
  }

  /**
   * Clear URL file parameter
   */
  clearURLFile(): void {
    const url = new URL(window.location.href)
    url.searchParams.delete('file')
    url.searchParams.delete('doc')
    window.history.replaceState(null, '', url.toString())
  }

  // Private helpers

  private normalizePath(path: string): string {
    const root = fileSystemWatcher.getProjectRoot()
    if (!path.startsWith('/')) {
      path = '/' + path
    }
    // Don't re-root paths already under a filesystem mount point
    if (!path.startsWith(root) && !path.startsWith('/git') && !path.startsWith('/project')) {
      path = root + path
    }
    return path.replace(/\/+/g, '/')
  }

  private addToCache(path: string, file: OpenFile): void {
    // Evict oldest if full
    if (this.openFiles.size >= MAX_CACHE_SIZE) {
      let oldestPath: string | null = null
      const entries = Array.from(this.openFiles.keys())

      for (const entryPath of entries) {
        if (entryPath === this.currentPath || this.openFiles.get(entryPath)?.isDirty) continue
        oldestPath = entryPath
        break
      }

      if (oldestPath) this.openFiles.delete(oldestPath)
    }
    this.openFiles.set(path, file)
  }

  private async preload(path: string): Promise<void> {
    if (this.openFiles.has(path)) return
    try {
      const content = await fileSystem.readFile(path)
      this.addToCache(path, { path, content, isDirty: false })
    } catch { /* ignore */ }
  }

  private updateRecent(path: string): void {
    this.recentPaths = [path, ...this.recentPaths.filter(p => p !== path)].slice(0, MAX_RECENT)
    this.saveRecent()
  }

  private loadRecent(): void {
    try {
      const saved = localStorage.getItem(RECENT_FILES_KEY)
      if (saved) {
        this.recentPaths = JSON.parse(saved)
      }
    } catch { /* ignore */ }
  }

  private saveRecent(): void {
    try {
      localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(this.recentPaths))
    } catch { /* ignore */ }
  }

  private saveCurrentFile(): void {
    if (this.currentPath) {
      try {
        localStorage.setItem(CURRENT_FILE_KEY, this.currentPath)
      } catch { /* ignore */ }
    }
  }

  /**
   * Get the project root path
   */
  getProjectRoot(): string {
    return fileSystemWatcher.getProjectRoot()
  }
}

// Export singleton instance
export const fileManager = new FileManagerService()
export default fileManager
