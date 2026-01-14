import type { SiglumDocument, SearchResult } from '../types/Document'
import DocumentService from './DocumentService'
import type { FuzzyMatchMessage, FuzzyMatchResultMessage, FuzzyMatchResult, FuzzyMatchRequest } from '../workers/search.worker'

export interface SearchOptions {
  maxResults?: number
  includeContent?: boolean
  fuzzyMatch?: boolean
}

class DocumentSearcher {
  private searchIndex: Map<string, Set<string>> = new Map() // word -> document IDs
  private documentWords: Map<string, Set<string>> = new Map() // docId -> words (inverse index for O(1) removal)
  private prefixToWords: Map<string, Set<string>> = new Map() // prefix -> full words (for fast fuzzy)
  private documentCache: Map<string, SiglumDocument> = new Map()
  private isIndexed = false

  // Optimization: pre-cached lowercase text for O(1) phrase search
  private lowercaseCache: Map<string, { title: string; text: string }> = new Map()

  // Optimization: LRU cache for Levenshtein distance calculations (max 1000 entries)
  private similarityCache: Map<string, number> = new Map()
  private readonly SIMILARITY_CACHE_MAX = 1000

  // Search worker for offloading fuzzy matching from main thread
  private searchWorker: Worker | null = null
  private workerRequestId = 0
  private pendingRequests: Map<number, {
    resolve: (results: FuzzyMatchResult[]) => void
    reject: (error: Error) => void
  }> = new Map()

  async initialize(): Promise<void> {
    if (this.isIndexed) return

    await DocumentService.initialize()
    const documents = await DocumentService.getAll()
    for (const doc of documents) {
      this.indexDocument(doc)
    }
    this.isIndexed = true
  }

  /**
   * Get or create the search worker
   */
  private getWorker(): Worker {
    if (!this.searchWorker) {
      this.searchWorker = new Worker(
        new URL('../workers/search.worker.ts', import.meta.url),
        { type: 'module' }
      )
      this.searchWorker.onmessage = (event: MessageEvent<FuzzyMatchResultMessage>) => {
        const { id, results } = event.data
        const pending = this.pendingRequests.get(id)
        if (pending) {
          this.pendingRequests.delete(id)
          pending.resolve(results)
        }
      }
      this.searchWorker.onerror = (error) => {
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error(`Worker error: ${error.message}`))
          this.pendingRequests.delete(id)
        }
      }
    }
    return this.searchWorker
  }

  /**
   * Batch fuzzy matching using the worker (off main thread)
   */
  private fuzzyMatchInWorker(requests: FuzzyMatchRequest[]): Promise<FuzzyMatchResult[]> {
    return new Promise((resolve, reject) => {
      const id = ++this.workerRequestId
      this.pendingRequests.set(id, { resolve, reject })

      const message: FuzzyMatchMessage = {
        type: 'fuzzyMatch',
        id,
        requests
      }

      this.getWorker().postMessage(message)
    })
  }

  indexDocument(doc: SiglumDocument): void {
    this.documentCache.set(doc.id, doc)

    // Cache lowercase versions for O(1) phrase search
    this.lowercaseCache.set(doc.id, {
      title: doc.title.toLowerCase(),
      text: doc.searchableText.toLowerCase()
    })

    // Remove old index entries for this document (now O(k) where k = words in doc)
    this.removeFromIndex(doc.id)

    // Index title and content separately
    const titleWords = this.extractWords(doc.title, 2.0) // Title gets higher weight
    const contentWords = this.extractWords(doc.searchableText, 1.0)

    const allWords = new Map<string, number>()

    // Combine words with weights
    titleWords.forEach((weight, word) => {
      allWords.set(word, (allWords.get(word) || 0) + weight)
    })
    contentWords.forEach((weight, word) => {
      allWords.set(word, (allWords.get(word) || 0) + weight)
    })

    // Track words for this document (inverse index)
    const docWordSet = new Set<string>()

    // Add to search index
    allWords.forEach((_weight, word) => {
      if (!this.searchIndex.has(word)) {
        this.searchIndex.set(word, new Set())
      }
      this.searchIndex.get(word)!.add(doc.id)
      docWordSet.add(word)
    })

    // Store inverse mapping for O(1) removal
    this.documentWords.set(doc.id, docWordSet)
  }

  private extractWords(text: string, weight: number = 1.0): Map<string, number> {
    const words = new Map<string, number>()
    const cleanText = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()

    if (!cleanText) return words

    const wordList = cleanText.split(' ').filter(word => word.length > 2)

    for (const word of wordList) {
      words.set(word, weight)

      // Also index word prefixes for partial matching
      if (word.length > 4) {
        for (let i = 3; i <= Math.min(word.length - 1, 6); i++) {
          const prefix = word.substring(0, i)
          words.set(prefix, weight * 0.5) // Lower weight for prefixes

          // Build reverse lookup: prefix -> full words (for fast fuzzy search)
          if (!this.prefixToWords.has(prefix)) {
            this.prefixToWords.set(prefix, new Set())
          }
          this.prefixToWords.get(prefix)!.add(word)
        }
      }
    }

    return words
  }

  private removeFromIndex(documentId: string): void {
    // Use inverse index for O(k) removal instead of O(n)
    const words = this.documentWords.get(documentId)
    if (!words) return

    for (const word of words) {
      const docIds = this.searchIndex.get(word)
      if (docIds) {
        docIds.delete(documentId)
        if (docIds.size === 0) {
          this.searchIndex.delete(word)
        }
      }
    }

    this.documentWords.delete(documentId)
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    await this.initialize()
    
    if (!query.trim()) {
      return this.getRecentDocuments(options.maxResults || 10)
    }

    const {
      maxResults = 10,
      includeContent = false,
      fuzzyMatch = true
    } = options

    const queryWords = this.extractWords(query.toLowerCase())
    const documentScores = new Map<string, number>()
    
    // Score documents based on word matches
    // First pass: exact matches (synchronous)
    for (const [word] of queryWords) {
      const exactMatches = this.searchIndex.get(word) || new Set()
      for (const docId of exactMatches) {
        const currentScore = documentScores.get(docId) || 0
        documentScores.set(docId, currentScore + 2.0) // Exact match gets high score
      }
    }

    // Second pass: fuzzy matches (offloaded to worker)
    if (fuzzyMatch) {
      // Build batch of fuzzy match requests
      const fuzzyRequests: FuzzyMatchRequest[] = []
      for (const [word] of queryWords) {
        if (word.length > 3) {
          const prefix = word.substring(0, 3)
          const candidateWords = this.prefixToWords.get(prefix)
          if (candidateWords) {
            const candidates = Array.from(candidateWords).filter(c => c !== word)
            if (candidates.length > 0) {
              fuzzyRequests.push({
                word,
                candidates,
                threshold: 0.6
              })
            }
          }
        }
      }

      // Process fuzzy matches in worker (off main thread)
      if (fuzzyRequests.length > 0) {
        try {
          const fuzzyResults = await this.fuzzyMatchInWorker(fuzzyRequests)

          // Apply fuzzy match scores
          for (const result of fuzzyResults) {
            const docIds = this.searchIndex.get(result.candidate)
            if (docIds) {
              for (const docId of docIds) {
                const currentScore = documentScores.get(docId) || 0
                documentScores.set(docId, currentScore + result.similarity)
              }
            }
          }
        } catch (error) {
          // Worker failed, fall back to synchronous calculation
          console.warn('Fuzzy match worker failed, using fallback:', error)
          for (const request of fuzzyRequests) {
            for (const candidate of request.candidates) {
              const similarity = this.calculateSimilarity(request.word, candidate)
              if (similarity >= request.threshold) {
                const docIds = this.searchIndex.get(candidate)
                if (docIds) {
                  for (const docId of docIds) {
                    const currentScore = documentScores.get(docId) || 0
                    documentScores.set(docId, currentScore + similarity)
                  }
                }
              }
            }
          }
        }
      }
    }
    
    // Check for phrase matches (higher score) - uses pre-cached lowercase
    // Only check docs that already have word matches to reduce iterations
    if (query.includes(' ')) {
      const phrase = query.toLowerCase().trim()
      const docsToCheck = documentScores.size > 0
        ? documentScores.keys()
        : this.documentCache.keys()

      for (const docId of docsToCheck) {
        const cached = this.lowercaseCache.get(docId)
        if (!cached) continue

        if (cached.title.includes(phrase)) {
          const currentScore = documentScores.get(docId) || 0
          documentScores.set(docId, currentScore + 5.0) // Phrase in title = highest score
        } else if (cached.text.includes(phrase)) {
          const currentScore = documentScores.get(docId) || 0
          documentScores.set(docId, currentScore + 3.0) // Phrase in content = high score
        }
      }
    }
    
    // Apply recency boost
    const now = Date.now()
    for (const [docId, score] of documentScores.entries()) {
      const doc = this.documentCache.get(docId)
      if (doc) {
        const daysSinceViewed = (now - doc.lastViewedAt.getTime()) / (1000 * 60 * 60 * 24)
        const recencyMultiplier = Math.max(0.1, 1 - (daysSinceViewed / 30)) // Recent docs get boost
        documentScores.set(docId, score * (1 + recencyMultiplier * 0.5))
      }
    }
    
    // Sort by score and convert to SearchResult
    const sortedResults = Array.from(documentScores.entries())
      .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
      .slice(0, maxResults)
      .map(([docId, score]): SearchResult => {
        const doc = this.documentCache.get(docId)!
        const highlights = this.getHighlights(doc, queryWords, includeContent)
        return {
          document: doc,
          relevanceScore: score,
          matchedTerms: Array.from(queryWords.keys()),
          snippet: highlights[0] || '',
          highlights
        }
      })

    return sortedResults
  }

  private async getRecentDocuments(maxResults: number): Promise<SearchResult[]> {
    const recentDocs = await DocumentService.getRecent(maxResults)
    return recentDocs.map(doc => ({
      document: doc,
      relevanceScore: 1.0,
      matchedTerms: [],
      snippet: '',
      highlights: []
    }))
  }

  private calculateSimilarity(word1: string, word2: string): number {
    // Memoization: use canonical key (sorted order) to avoid duplicate entries
    const cacheKey = word1 < word2 ? `${word1}|${word2}` : `${word2}|${word1}`

    const cached = this.similarityCache.get(cacheKey)
    if (cached !== undefined) return cached

    const longer = word1.length > word2.length ? word1 : word2
    const shorter = word1.length <= word2.length ? word1 : word2

    if (longer.length === 0) return 1.0

    const editDistance = this.levenshteinDistance(longer, shorter)
    const similarity = (longer.length - editDistance) / longer.length

    // LRU eviction: remove oldest entries if cache is full
    if (this.similarityCache.size >= this.SIMILARITY_CACHE_MAX) {
      const firstKey = this.similarityCache.keys().next().value
      if (firstKey) this.similarityCache.delete(firstKey)
    }
    this.similarityCache.set(cacheKey, similarity)

    return similarity
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null))
    
    for (let i = 0; i <= str1.length; i++) {
      matrix[0][i] = i
    }
    
    for (let j = 0; j <= str2.length; j++) {
      matrix[j][0] = j
    }
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        if (str1[i - 1] === str2[j - 1]) {
          matrix[j][i] = matrix[j - 1][i - 1]
        } else {
          matrix[j][i] = Math.min(
            matrix[j - 1][i - 1] + 1, // substitution
            matrix[j][i - 1] + 1,     // insertion
            matrix[j - 1][i] + 1      // deletion
          )
        }
      }
    }
    
    return matrix[str2.length][str1.length]
  }

  private getHighlights(doc: SiglumDocument, queryWords: Map<string, number>, includeContent: boolean): string[] {
    const highlights: string[] = []
    
    // Always highlight in title
    let titleHighlight = this.highlightText(doc.title, queryWords)
    if (titleHighlight !== doc.title) {
      highlights.push(titleHighlight)
    }
    
    // Optionally highlight in content
    if (includeContent) {
      const contentPreview = doc.searchableText.substring(0, 200)
      const contentHighlight = this.highlightText(contentPreview, queryWords)
      if (contentHighlight !== contentPreview) {
        highlights.push(contentHighlight + '...')
      }
    }
    
    return highlights
  }

  private highlightText(text: string, queryWords: Map<string, number>): string {
    let result = text
    for (const [word] of queryWords) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi')
      result = result.replace(regex, `<mark>$&</mark>`)
    }
    return result
  }

  // Update methods for real-time indexing
  async updateDocument(doc: SiglumDocument): Promise<void> {
    this.indexDocument(doc)
  }

  async removeDocument(docId: string): Promise<void> {
    this.removeFromIndex(docId)
    this.documentCache.delete(docId)
    this.lowercaseCache.delete(docId)
  }
}

export default new DocumentSearcher()