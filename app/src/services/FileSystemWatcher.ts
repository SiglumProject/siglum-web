/**
 * FileSystemWatcher - Watches siglum-filesystem and emits events when files change
 *
 * This service provides a unified view of the filesystem and notifies subscribers
 * when the file tree changes. It acts as the bridge between siglum-filesystem
 * and the React UI components.
 *
 * Usage:
 * ```typescript
 * import { fileSystemWatcher } from './FileSystemWatcher'
 *
 * // Get the current file tree
 * const tree = await fileSystemWatcher.getTree()
 *
 * // Subscribe to changes
 * const unsub = fileSystemWatcher.subscribe((tree) => {
 *   console.log('Files changed:', tree)
 * })
 *
 * // After any file operation, refresh the tree
 * await fileSystemWatcher.refresh()
 * ```
 */

import { fileSystem } from '@siglum/filesystem'
import { migrationService } from './MigrationService'
import EventBus from './EventBus'

export interface FileNode {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

type FileTreeListener = (tree: FileNode | null) => void

const MOUNT_POINT = '/project'
const DEFAULT_ROOT = '/project/src'

class FileSystemWatcherService {
  private currentTree: FileNode | null = null
  private listeners: Set<FileTreeListener> = new Set()
  private initialized = false
  private initPromise: Promise<void> | null = null
  private scanRoot: string = DEFAULT_ROOT

  /**
   * Initialize the filesystem watcher
   * Mounts the filesystem and scans the initial tree
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._initialize().then(
      () => { this.initialized = true },
      error => { this.initPromise = null; throw error }
    )
    await this.initPromise
  }

  private async _initialize(): Promise<void> {
    // Mount the filesystem at /project — project files live under /project/src
    await fileSystem.mountAuto(MOUNT_POINT)

    // Run migration from old /documents/ format if needed
    await migrationService.migrateIfNeeded()

    // Ensure the project directory exists
    const exists = await fileSystem.exists(DEFAULT_ROOT)
    if (!exists) {
      await fileSystem.mkdir(DEFAULT_ROOT, { silent: true })
    }

    // Subscribe to filesystem events for automatic refresh
    fileSystem.subscribe(async (event) => {
      if (event.path.startsWith(this.scanRoot)) {
        await this.refresh()
      }
    })

    // Scan the initial tree (use _doRefresh to avoid deadlock)
    await this._doRefresh()
  }

  /**
   * Get the current file tree
   */
  async getTree(): Promise<FileNode | null> {
    await this.initialize()
    return this.currentTree
  }

  /**
   * Scan a directory and build a FileNode tree
   */
  private async scanDirectory(path: string): Promise<FileNode> {
    const entries = await fileSystem.readdir(path)
    const children: FileNode[] = []

    // Sort: directories first, then alphabetically
    const sortedEntries = entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const entry of sortedEntries) {
      // Hide git internals
      if (entry.name === '.git') continue

      const itemPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`

      if (entry.isDirectory) {
        children.push(await this.scanDirectory(itemPath))
      } else {
        children.push({
          id: this.generateId(itemPath),
          name: entry.name,
          path: itemPath,
          type: 'file'
        })
      }
    }

    const name = path.split('/').pop() || 'project'
    return {
      id: this.generateId(path),
      name,
      path,
      type: 'directory',
      children
    }
  }

  /**
   * Generate a stable ID for a path
   */
  private generateId(path: string): string {
    // Use path as ID for stability (allows reconnecting to existing files)
    return `fs:${path}`
  }

  /**
   * Refresh the file tree from the filesystem
   */
  async refresh(): Promise<void> {
    // Ensure initialized before refreshing (but don't call from _initialize to avoid deadlock)
    await this.initialize()
    await this._doRefresh()
  }

  private async _doRefresh(): Promise<void> {
    const root = this.scanRoot
    try {
      const exists = await fileSystem.exists(root)
      if (exists) {
        this.currentTree = await this.scanDirectory(root)
      } else {
        this.currentTree = {
          id: this.generateId(root),
          name: root.split('/').pop() || 'project',
          path: root,
          type: 'directory',
          children: []
        }
      }
    } catch (err) {
      console.warn('[FileSystemWatcher] Error scanning directory:', err)
      this.currentTree = {
        id: this.generateId(root),
        name: root.split('/').pop() || 'project',
        path: root,
        type: 'directory',
        children: []
      }
    }

    this.notifyListeners()
    EventBus.emit('filesChanged')
  }

  /**
   * Subscribe to file tree changes
   */
  subscribe(listener: FileTreeListener): () => void {
    this.listeners.add(listener)
    // Immediately call with current tree
    if (this.currentTree) {
      listener(this.currentTree)
    }
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.currentTree))
  }

  /**
   * Get a flat list of all files in the tree
   */
  getAllFiles(): FileNode[] {
    if (!this.currentTree) return []

    const files: FileNode[] = []
    const collect = (node: FileNode) => {
      if (node.type === 'file') {
        files.push(node)
      }
      if (node.children) {
        node.children.forEach(collect)
      }
    }
    collect(this.currentTree)
    return files
  }

  /**
   * Get files by extension
   */
  getFilesByExtension(...extensions: string[]): FileNode[] {
    const extSet = new Set(extensions.map(e => e.toLowerCase().replace(/^\./, '')))
    return this.getAllFiles().filter(file => {
      const ext = file.path.split('.').pop()?.toLowerCase()
      return ext && extSet.has(ext)
    })
  }

  /**
   * Convert FileNode tree to FileItem array for compatibility with existing code
   */
  toFileItems(): import('./ProjectStore').FileItem[] {
    if (!this.currentTree?.children) return []

    const convert = (node: FileNode): import('./ProjectStore').FileItem => ({
      id: node.id,
      name: node.name,
      path: node.path,
      type: node.type === 'directory' ? 'folder' : 'file',
      children: node.children?.map(convert)
    })

    return this.currentTree.children.map(convert)
  }

  /**
   * Switch the scan root (e.g., when git connects)
   */
  async setScanRoot(path: string): Promise<void> {
    this.scanRoot = path
    await this.initialize()
    await this._doRefresh()
  }

  /**
   * Reset scan root to the default project directory
   */
  async resetScanRoot(): Promise<void> {
    await this.setScanRoot(DEFAULT_ROOT)
  }

  /**
   * Get the current scan root path
   */
  getProjectRoot(): string {
    return this.scanRoot
  }
}

// Export singleton instance
export const fileSystemWatcher = new FileSystemWatcherService()
export default fileSystemWatcher
