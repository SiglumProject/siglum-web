/**
 * ProjectSearcher - Search across project files
 *
 * Searches file names and content in the current project.
 * Uses ProjectStore for file tree and GitService for reading content.
 * Content search is offloaded to a Web Worker to prevent UI blocking.
 */

import ProjectStore from './ProjectStore'
import type { FileItem } from './ProjectStore'
import GitService from './GitService'
import type { SearchMessage, SearchResultMessage, ContentSearchResult, FileData } from '../workers/search.worker'

export interface FileSearchResult {
  file: FileItem
  /** Type of match: 'name' for filename, 'content' for content match */
  matchType: 'name' | 'content'
  /** For content matches: the line number (1-indexed) */
  lineNumber?: number
  /** Snippet of matching content with context */
  snippet?: string
  /** Relevance score for sorting */
  score: number
}

export interface SearchOptions {
  /** Maximum results to return */
  maxResults?: number
  /** Search file contents (slower for large projects) */
  searchContent?: boolean
  /** File extensions to search (e.g., ['tex', 'bib', 'sty']) */
  extensions?: string[]
  /** Case-sensitive search */
  caseSensitive?: boolean
}

const TEXT_EXTENSIONS = new Set([
  'tex', 'bib', 'sty', 'cls', 'dtx', 'ins',
  'txt', 'md', 'json', 'yaml', 'yml',
  'bst', 'bbx', 'cbx', 'lbx'
])

class ProjectSearcher {
  private contentCache: Map<string, string> = new Map()
  private cacheTimestamp: number = 0
  private readonly CACHE_TTL = 300000 // 5 minutes (was 30s - too short for real usage)

  // File list cache - avoid flattening tree on every search
  private fileListCache: FileItem[] | null = null
  private fileListTimestamp: number = 0

  // Extension cache - avoid repeated string splitting
  private extensionCache: Map<string, string> = new Map()

  // Search worker for offloading content search from main thread
  private searchWorker: Worker | null = null
  private workerRequestId = 0
  private pendingRequests: Map<number, {
    resolve: (results: ContentSearchResult[]) => void
    reject: (error: Error) => void
  }> = new Map()

  /**
   * Get or create the search worker
   */
  private getWorker(): Worker {
    if (!this.searchWorker) {
      this.searchWorker = new Worker(
        new URL('../workers/search.worker.ts', import.meta.url),
        { type: 'module' }
      )
      this.searchWorker.onmessage = (event: MessageEvent<SearchResultMessage>) => {
        const { id, results } = event.data
        const pending = this.pendingRequests.get(id)
        if (pending) {
          this.pendingRequests.delete(id)
          pending.resolve(results)
        }
      }
      this.searchWorker.onerror = (error) => {
        // Reject all pending requests on worker error
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error(`Worker error: ${error.message}`))
          this.pendingRequests.delete(id)
        }
      }
    }
    return this.searchWorker
  }

  /**
   * Search content using the worker (off main thread)
   */
  private searchContentInWorker(
    query: string,
    files: FileData[],
    caseSensitive: boolean,
    maxResults: number
  ): Promise<ContentSearchResult[]> {
    return new Promise((resolve, reject) => {
      const id = ++this.workerRequestId
      this.pendingRequests.set(id, { resolve, reject })

      const message: SearchMessage = {
        type: 'search',
        id,
        query,
        files,
        caseSensitive,
        maxResults
      }

      this.getWorker().postMessage(message)
    })
  }

  /**
   * Get file extension with caching
   */
  private getExtension(path: string): string {
    if (this.extensionCache.has(path)) {
      return this.extensionCache.get(path)!
    }
    const lastDot = path.lastIndexOf('.')
    const ext = lastDot > 0 ? path.slice(lastDot + 1).toLowerCase() : ''
    this.extensionCache.set(path, ext)
    return ext
  }

  /**
   * Search project files by name and optionally content
   */
  async search(query: string, options: SearchOptions = {}): Promise<FileSearchResult[]> {
    const {
      maxResults = 20,
      searchContent = true,
      extensions,
      caseSensitive = false
    } = options

    if (!query.trim()) {
      return []
    }

    const allFiles = this.getCachedFileList()
    const results: FileSearchResult[] = []
    const searchQuery = caseSensitive ? query : query.toLowerCase()

    // Filter files by extension if specified (use Set for O(1) lookup)
    const extensionSet = extensions ? new Set(extensions) : null
    const filesToSearch = extensionSet
      ? allFiles.filter(f => {
          const ext = this.getExtension(f.path)
          return ext && extensionSet.has(ext)
        })
      : allFiles

    // Search file names first (fast)
    for (const file of filesToSearch) {
      const fileName = caseSensitive ? file.name : file.name.toLowerCase()
      const filePath = caseSensitive ? file.path : file.path.toLowerCase()

      if (fileName.includes(searchQuery) || filePath.includes(searchQuery)) {
        // Score based on match quality
        let score = 10
        if (fileName === searchQuery) score = 100 // Exact match
        else if (fileName.startsWith(searchQuery)) score = 50 // Prefix match
        else if (fileName.includes(searchQuery)) score = 30 // Contains in name
        else score = 10 // Contains in path

        results.push({
          file,
          matchType: 'name',
          score
        })
      }
    }

    // Early exit if we have enough high-quality matches
    const highScoreMatches = results.filter(r => r.score >= 50).length
    if (highScoreMatches >= maxResults) {
      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
    }

    // Search file contents if enabled - offloaded to worker
    if (searchContent && GitService.getStatus().isConnected) {
      const textFiles = filesToSearch.filter(f => {
        const ext = this.getExtension(f.path)
        return ext && TEXT_EXTENSIONS.has(ext)
      })

      // Build set of already-matched high-score files for quick lookup
      const highScorePaths = new Set(
        results.filter(r => r.score >= 50).map(r => r.file.path)
      )

      // Filter to only files that need content search
      const filesToSearchContent = textFiles.filter(f => !highScorePaths.has(f.path))

      // Load file contents (main thread) then search in worker
      const fileDataPromises = filesToSearchContent.map(async (file): Promise<FileData | null> => {
        try {
          const content = await this.getFileContent(file.path)
          if (!content) return null
          return {
            path: file.path,
            name: file.name,
            id: file.id,
            content
          }
        } catch {
          return null
        }
      })

      const fileDataResults = await Promise.all(fileDataPromises)
      const fileData = fileDataResults.filter((f): f is FileData => f !== null)

      // Offload the actual search to the worker (off main thread)
      if (fileData.length > 0) {
        try {
          const workerResults = await this.searchContentInWorker(
            query,
            fileData,
            caseSensitive,
            maxResults * 2 - results.length
          )

          // Create a map to look up files by path
          const fileMap = new Map(filesToSearchContent.map(f => [f.path, f]))
          const resultsByPath = new Map(results.map(r => [r.file.path, r]))

          // Merge worker results into main results
          for (const workerResult of workerResults) {
            const file = fileMap.get(workerResult.filePath)
            if (!file) continue

            const existing = resultsByPath.get(workerResult.filePath)
            if (existing) {
              existing.matchType = 'content'
              existing.lineNumber = workerResult.lineNumber
              existing.snippet = workerResult.snippet
              existing.score += workerResult.score
            } else {
              const result: FileSearchResult = {
                file,
                matchType: 'content',
                lineNumber: workerResult.lineNumber,
                snippet: workerResult.snippet,
                score: workerResult.score
              }
              results.push(result)
              resultsByPath.set(workerResult.filePath, result)
            }
          }
        } catch (error) {
          // Worker failed, fall through without content search results
          console.warn('Search worker failed:', error)
        }
      }
    }

    // Sort by score (descending) and return top results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
  }

  /**
   * Get file list with caching
   */
  private getCachedFileList(): FileItem[] {
    const now = Date.now()
    if (this.fileListCache && now - this.fileListTimestamp < this.CACHE_TTL) {
      return this.fileListCache
    }
    this.fileListCache = ProjectStore.getAllFiles()
    this.fileListTimestamp = now
    return this.fileListCache
  }

  /**
   * Search only file names (fast, no content reading)
   */
  searchFileNames(query: string, maxResults = 20): FileSearchResult[] {
    if (!query.trim()) {
      return []
    }

    const allFiles = this.getCachedFileList()
    const searchQuery = query.toLowerCase()
    const results: FileSearchResult[] = []

    for (const file of allFiles) {
      const fileName = file.name.toLowerCase()
      const filePath = file.path.toLowerCase()

      if (fileName.includes(searchQuery) || filePath.includes(searchQuery)) {
        let score = 10
        if (fileName === searchQuery) score = 100
        else if (fileName.startsWith(searchQuery)) score = 50
        else if (fileName.includes(searchQuery)) score = 30
        else score = 10

        results.push({
          file,
          matchType: 'name',
          score
        })
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
  }

  /**
   * Get file content with caching
   */
  private async getFileContent(path: string): Promise<string | null> {
    // Invalidate cache if stale
    if (Date.now() - this.cacheTimestamp > this.CACHE_TTL) {
      this.contentCache.clear()
      this.cacheTimestamp = Date.now()
    }

    // Return cached content if available
    if (this.contentCache.has(path)) {
      return this.contentCache.get(path)!
    }

    // Read and cache content
    const content = await GitService.readFile(path)
    if (content !== null) {
      this.contentCache.set(path, content)
    }
    return content
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.contentCache.clear()
    this.cacheTimestamp = 0
    this.fileListCache = null
    this.fileListTimestamp = 0
    this.extensionCache.clear()
  }
}

export default new ProjectSearcher()
