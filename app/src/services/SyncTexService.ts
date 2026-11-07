/**
 * SyncTexService - Centralized SyncTeX data management with indexed lookups
 *
 * Wraps the synctex.ts parser and builds indexed data structures for O(1)
 * page lookups and bounded source-line lookups. Also manages scroll sync coordination
 * via a leader-follower lock to prevent feedback loops.
 *
 * Usage:
 * ```typescript
 * import syncTexService from './SyncTexService'
 *
 * // After compilation succeeds
 * syncTexService.queueUpdate(rawSyncTexString)
 *
 * // Forward sync: editor line → PDF position
 * const loc = syncTexService.forwardSync(42)
 *
 * // Inverse sync: PDF click → source line
 * const src = syncTexService.inverseSync(1, 200, 300)
 * ```
 */

import {
  parseSyncTeX,
  sourceInputNumber,
  syncRecordToPdfLocation,
  inverseSync as rawInverseSync,
  type SyncTexData,
  type PdfLocation,
  type SourceLocation,
  type SyncRecord,
} from '../utils/synctex'

type UpdateListener = () => void

class SyncTexServiceImpl {
  private data: Omit<SyncTexData, 'records'> | null = null
  private pendingData: string | null = null
  private mappingSource: string | null = null
  private scheduledData: string | null = null
  private listeners: Set<UpdateListener> = new Set()

  // Indexes for O(1) lookups
  private pageIndex: Map<number, SyncRecord[]> = new Map()
  private lineIndex: Map<number, Map<number, SyncRecord>> = new Map() // inputNumber → line → records

  // Sorted waypoints for scroll sync interpolation (built from input 1 records)
  private scrollWaypoints: { line: number; page: number }[] = []
  private pageSummaries = new Map<number, { center: number; first: number; last: number }>()

  // Page heights from PDF.js (in PDF points at 72 DPI)
  private pageHeights: Map<number, number> = new Map()

  // Scroll sync lock
  private scrollLock: {
    leader: 'editor' | 'pdf' | null
    timeout: ReturnType<typeof setTimeout> | null
  } = { leader: null, timeout: null }

  /** Associate the mapping with the new PDF without delaying its first draw. */
  queueUpdate(rawData: string): void {
    this.resetData()
    this.pendingData = rawData
    this.mappingSource = rawData
  }

  /** The viewer schedules indexing after it draws the matching PDF. */
  prepareAfterPaint(rawData: string | undefined): void {
    if (!rawData || this.pendingData !== rawData || this.scheduledData === rawData) return
    this.scheduledData = rawData
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.pendingData === rawData) this.indexPendingData()
    }))
  }

  private indexPendingData(): void {
    if (this.pendingData === null) return
    const rawData = this.pendingData
    this.pendingData = null
    this.scheduledData = null
    const parsed = parseSyncTeX(rawData)
    if (parsed) {
      const { records, ...metadata } = parsed
      this.data = metadata
      this.buildIndexes(records)
    } else {
      this.data = null
      this.buildIndexes([])
    }
    this.notifyListeners()
  }

  private resetData(): void {
    this.data = null
    this.mappingSource = null
    this.pendingData = null
    this.scheduledData = null
    this.pageIndex.clear()
    this.lineIndex.clear()
    this.scrollWaypoints = []
    this.pageSummaries.clear()
  }

  clear(): void {
    this.resetData()
    this.notifyListeners()
  }

  /** Shares an index only with the exact SyncTeX content for the displayed PDF. */
  matchesMapping(rawData: string | null | undefined): boolean {
    return !!rawData && this.mappingSource === rawData
  }

  isAvailable(): boolean {
    return this.pendingData !== null || this.data !== null
  }

  /**
   * Set page height in PDF points (from pdf.js viewport at scale 1)
   * Call this after rendering a page to retain page geometry for callers.
   */
  setPageHeight(page: number, heightPts: number): void {
    this.pageHeights.set(page, heightPts)
  }

  private getPageHeight(page: number): number {
    return this.pageHeights.get(page) ?? 792 // US Letter fallback
  }

  /**
   * Forward sync: source line → PDF location (PDF points, origin top-left)
   */
  forwardSync(line: number, filename?: string): PdfLocation | null {
    this.indexPendingData()
    if (!this.data) return null
    const record = this.nearestRecord(line, this.inputNumber(filename))
    if (!record) return null
    const result = syncRecordToPdfLocation(this.data, record)
    return result
  }

  /**
   * Inverse sync: PDF click → source location
   * x, y are in PDF points (72 DPI, origin top-left)
   */
  inverseSync(page: number, x: number, y: number): SourceLocation | null {
    this.indexPendingData()
    if (!this.data) return null
    const records = this.pageIndex.get(page)
    if (!records) return null
    const result = rawInverseSync({ ...this.data, records }, page, x, y, this.getPageHeight(page))
    return result
  }

  /**
   * Get the page that contains a given source line
   */
  getPageForLine(line: number, inputNumber: number = 1): number | null {
    this.indexPendingData()
    return this.nearestRecord(line, inputNumber)?.page ?? null
  }

  /**
   * Get center line for a page (for scroll sync: PDF page → editor line)
   */
  getCenterLineForPage(page: number): number | null {
    this.indexPendingData()
    if (!this.data) return null
    return this.pageSummary(page)?.center ?? null
  }

  /**
   * Get line range for a page
   */
  getLineRangeForPage(page: number): { first: number; last: number } | null {
    this.indexPendingData()
    if (!this.data) return null
    const summary = this.pageSummary(page)
    return summary ? { first: summary.first, last: summary.last } : null
  }

  /**
   * Get the unique source lines for a page, sorted by Y position (top to bottom).
   * Only returns lines from the main input (user's document, not system files).
   * Used for inverse sync: gives the exact candidate lines to score.
   */
  getLinesForPage(page: number, filename?: string): number[] {
    this.indexPendingData()
    const records = this.pageIndex.get(page)
    if (!records) return []

    // Collect unique lines from main input (input 1), tracking Y per line
    const lineY = new Map<number, number>()
    const input = this.data ? this.inputNumber(filename) : 1
    for (const r of records) {
      if (r.inputNumber !== input) continue
      // SyncTeX Y increases down the page. Keep the first/topmost occurrence.
      if (!lineY.has(r.line) || r.y < lineY.get(r.line)!) {
        lineY.set(r.line, r.y)
      }
    }

    // Sort top to bottom in the same coordinates as forward/inverse sync.
    return Array.from(lineY.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([line]) => line)
  }

  /**
   * Get page boundaries for editor indicators.
   *
   * Uses the pre-built scrollWaypoints (source lines sorted ascending, deduplicated
   * to page transitions). Filters out preamble lines (< beginDocLine) and prepends
   * a page-1 marker at \begin{document} if front matter pages got filtered out.
   */
  getPageBoundaries(beginDocLine: number = 0): { line: number; page: number }[] {
    this.indexPendingData()
    if (this.scrollWaypoints.length === 0) return []

    // Filter out preamble noise
    const boundaries = beginDocLine > 0
      ? this.scrollWaypoints.filter(wp => wp.line >= beginDocLine)
      : [...this.scrollWaypoints]

    // If front matter pages were lost (first boundary is past page 1),
    // anchor page 1 at \begin{document}
    if (boundaries.length > 0 && boundaries[0].page > 1 && beginDocLine > 0) {
      boundaries.unshift({ line: beginDocLine, page: 1 })
    } else if (boundaries.length === 0 && beginDocLine > 0 && this.pageIndex.size > 0) {
      // All waypoints were preamble — still show page 1 at \begin{document}
      boundaries.push({ line: beginDocLine, page: 1 })
    }

    return boundaries
  }

  /**
   * Get the number of pages in the document
   */
  getPageCount(): number {
    this.indexPendingData()
    return this.pageIndex.size
  }

  /**
   * Scroll-sync line→page lookup using interpolated waypoints.
   * Unlike forwardSync (which returns precise PDF coordinates for click sync),
   * this returns a smoothly-progressing page number suitable for scroll sync.
   * Accounts for non-uniform content density (figures, tables, etc).
   */
  lineToPage(line: number): number | null {
    this.indexPendingData()
    const wp = this.scrollWaypoints
    if (wp.length === 0) return null

    // Before first waypoint
    if (line <= wp[0].line) return wp[0].page

    // After last waypoint
    if (line >= wp[wp.length - 1].line) return wp[wp.length - 1].page

    // Binary search for bracketing waypoints
    let lo = 0
    let hi = wp.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (wp[mid].line <= line) lo = mid
      else hi = mid
    }

    // Interpolate between lo and hi
    const lower = wp[lo]
    const upper = wp[hi]
    const lineDelta = upper.line - lower.line
    if (lineDelta === 0) return lower.page

    const t = (line - lower.line) / lineDelta
    return Math.round(lower.page + t * (upper.page - lower.page))
  }

  /**
   * Get input files map
   */
  getInputFiles(): Map<number, string> {
    this.indexPendingData()
    return new Map(this.data?.inputs)
  }

  /**
   * Subscribe to data updates
   */
  onUpdate(callback: UpdateListener): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  // --- Scroll sync lock ---

  /**
   * Attempt to acquire scroll sync leadership.
   * Returns true if acquired (or already held by this leader).
   */
  acquireScrollLock(leader: 'editor' | 'pdf'): boolean {
    // Already held by this leader — extend timeout
    if (this.scrollLock.leader === leader) {
      this.extendLockTimeout()
      return true
    }

    // Held by other leader — deny
    if (this.scrollLock.leader !== null) {
      return false
    }

    // Acquire
    this.scrollLock.leader = leader
    this.extendLockTimeout()
    return true
  }

  /**
   * Release the scroll sync lock
   */
  releaseScrollLock(): void {
    if (this.scrollLock.timeout) clearTimeout(this.scrollLock.timeout)
    this.scrollLock.leader = null
    this.scrollLock.timeout = null
  }

  /**
   * Check if scroll sync is locked
   */
  isScrollLocked(): boolean {
    return this.scrollLock.leader !== null
  }

  /**
   * Get current scroll sync leader
   */
  getScrollLeader(): 'editor' | 'pdf' | null {
    return this.scrollLock.leader
  }

  // --- Private ---

  private inputNumber(filename?: string): number {
    return this.data ? sourceInputNumber(this.data, filename) : 1
  }

  private nearestRecord(line: number, inputNumber: number): SyncRecord | null {
    const lines = this.lineIndex.get(inputNumber)
    if (!lines) return null
    const exact = lines.get(line)
    if (exact) return exact
    let best: SyncRecord | null = null
    let distance = Infinity
    // Insertion order is the first native occurrence of a line. Strictly less
    // preserves the whole-document scan's first-record behavior on equal ties.
    for (const [sourceLine, record] of lines) {
      const next = Math.abs(sourceLine - line)
      if (next < distance) { distance = next; best = record }
    }
    return best
  }

  private pageSummary(page: number): { center: number; first: number; last: number } | null {
    const cached = this.pageSummaries.get(page)
    if (cached) return cached
    const records = this.pageIndex.get(page)
    if (!records?.length) return null
    const lines = records.map(record => record.line).sort((a, b) => a - b)
    const summary = { center: lines[Math.floor(lines.length / 2)], first: lines[0], last: lines[lines.length - 1] }
    this.pageSummaries.set(page, summary)
    return summary
  }

  private extendLockTimeout(): void {
    if (this.scrollLock.timeout) clearTimeout(this.scrollLock.timeout)
    this.scrollLock.timeout = setTimeout(() => {
      this.scrollLock.leader = null
      this.scrollLock.timeout = null
    }, 150)
  }

  private buildIndexes(records: readonly SyncRecord[]): void {
    this.pageIndex.clear()
    this.lineIndex.clear()
    this.scrollWaypoints = []
    this.pageSummaries.clear()

    if (!records.length) return

    // Collect unique (line → page) pairs for waypoint table.
    // Only use records from the main input (input 1 = user's document).
    // System files (book.cls, hyperref.sty, etc.) have their own line numbers
    // that would pollute the mapping if included.
    const mainInput = 1
    const linePageMap = new Map<number, number>()

    for (const record of records) {
      // Page index
      let pageRecords = this.pageIndex.get(record.page)
      if (!pageRecords) {
        pageRecords = []
        this.pageIndex.set(record.page, pageRecords)
      }
      pageRecords.push(record)

      // Line index: inputNumber → line → records
      let inputMap = this.lineIndex.get(record.inputNumber)
      if (!inputMap) {
        inputMap = new Map()
        this.lineIndex.set(record.inputNumber, inputMap)
      }
      // Source navigation needs the first native record for each line only.
      // Every record remains owned by its page index; avoid a second set of
      // per-line arrays and the redundant whole-document reference array.
      if (!inputMap.has(record.line)) inputMap.set(record.line, record)

      // Waypoint: only main input records (skip package/class file records)
      if (record.inputNumber === mainInput && !linePageMap.has(record.line)) {
        linePageMap.set(record.line, record.page)
      }
    }

    // Build sorted waypoint array, deduplicating adjacent same-page entries
    const sorted = Array.from(linePageMap.entries())
      .sort((a, b) => a[0] - b[0])

    let lastPage = -1
    for (const [line, page] of sorted) {
      if (page !== lastPage) {
        this.scrollWaypoints.push({ line, page })
        lastPage = page
      }
    }
  }

  private notifyListeners(): void {
    this.listeners.forEach(fn => fn())
  }
}

const syncTexService = new SyncTexServiceImpl()
export default syncTexService
