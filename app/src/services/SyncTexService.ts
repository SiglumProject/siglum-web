/**
 * SyncTexService - Centralized SyncTeX data management with indexed lookups
 *
 * Wraps the synctex.ts parser and builds indexed data structures for O(1)
 * forward/inverse sync lookups. Also manages scroll sync coordination
 * via a leader-follower lock to prevent feedback loops.
 *
 * Usage:
 * ```typescript
 * import syncTexService from './SyncTexService'
 *
 * // After compilation succeeds
 * syncTexService.update(rawSyncTexString)
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
  forwardSync as rawForwardSync,
  inverseSync as rawInverseSync,
  getPageCenterLine as rawGetPageCenterLine,
  getPageLineRange as rawGetPageLineRange,
  type SyncTexData,
  type PdfLocation,
  type SourceLocation,
  type SyncRecord,
} from '../utils/synctex'

type UpdateListener = () => void

class SyncTexServiceImpl {
  private data: SyncTexData | null = null
  private listeners: Set<UpdateListener> = new Set()

  // Indexes for O(1) lookups
  private pageIndex: Map<number, SyncRecord[]> = new Map()
  private lineIndex: Map<number, Map<number, SyncRecord[]>> = new Map() // inputNumber → line → records

  // Sorted waypoints for scroll sync interpolation (built from input 1 records)
  private scrollWaypoints: { line: number; page: number }[] = []

  // Page heights from PDF.js (in PDF points at 72 DPI)
  private pageHeights: Map<number, number> = new Map()

  // Scroll sync lock
  private scrollLock: {
    leader: 'editor' | 'pdf' | null
    timeout: ReturnType<typeof setTimeout> | null
  } = { leader: null, timeout: null }

  /**
   * Update with new SyncTeX data from a compilation
   */
  update(rawData: string): void {
    const parsed = parseSyncTeX(rawData)
    if (!parsed) return

    this.data = parsed
    this.buildIndexes()

    // Debug: log what we parsed and what boundaries were computed
    const boundaries = this.getPageBoundaries()
    const input1Count = parsed.records.filter(r => r.inputNumber === 1).length
    const pagesWithInput1 = new Set(parsed.records.filter(r => r.inputNumber === 1).map(r => r.page)).size
    console.log('[SyncTeX] Parsed:', {
      records: parsed.records.length,
      recordsInput1: input1Count,
      pages: this.pageIndex.size,
      pagesWithInput1,
      boundaries: boundaries.length,
      boundaryPages: boundaries.map(b => `p${b.page}@L${b.line}`),
      inputs: Object.fromEntries(parsed.inputs),
    })

    this.notifyListeners()
  }

  /**
   * Clear SyncTeX data (e.g. when document changes)
   * Note: During recompilation, prefer keeping old data until new data arrives.
   */
  clear(): void {
    this.data = null
    this.pageIndex.clear()
    this.lineIndex.clear()
    this.notifyListeners()
  }

  /**
   * Check if SyncTeX data is available
   */
  isAvailable(): boolean {
    return this.data !== null
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
    if (!this.data) return null
    // First pass with default height to find the page
    const preliminary = rawForwardSync(this.data, line, filename, 792)
    if (!preliminary) return null
    // Pass the page geometry through the compatibility API
    const pageHeight = this.getPageHeight(preliminary.page)
    const result = rawForwardSync(this.data, line, filename, pageHeight)
    console.log('[SyncTeX] forwardSync line', line, '→', result)
    return result
  }

  /**
   * Inverse sync: PDF click → source location
   * x, y are in PDF points (72 DPI, origin top-left)
   */
  inverseSync(page: number, x: number, y: number): SourceLocation | null {
    if (!this.data) return null
    const result = rawInverseSync(this.data, page, x, y, this.getPageHeight(page))
    console.log('[SyncTeX] inverseSync page', page, 'at', { x, y }, '→', result)
    return result
  }

  /**
   * Get the page that contains a given source line
   */
  getPageForLine(line: number, inputNumber: number = 1): number | null {
    const inputMap = this.lineIndex.get(inputNumber)
    if (!inputMap) return null

    // Try exact match first
    const records = inputMap.get(line)
    if (records && records.length > 0) return records[0].page

    // Find nearest line
    let bestLine = -1
    let bestDist = Infinity
    for (const l of inputMap.keys()) {
      const dist = Math.abs(l - line)
      if (dist < bestDist) {
        bestDist = dist
        bestLine = l
      }
    }

    if (bestLine >= 0) {
      const nearRecords = inputMap.get(bestLine)
      if (nearRecords && nearRecords.length > 0) return nearRecords[0].page
    }

    return null
  }

  /**
   * Get center line for a page (for scroll sync: PDF page → editor line)
   */
  getCenterLineForPage(page: number): number | null {
    if (!this.data) return null
    return rawGetPageCenterLine(this.data, page)
  }

  /**
   * Get line range for a page
   */
  getLineRangeForPage(page: number): { first: number; last: number } | null {
    if (!this.data) return null
    return rawGetPageLineRange(this.data, page)
  }

  /**
   * Get the unique source lines for a page, sorted by Y position (top to bottom).
   * Only returns lines from the main input (user's document, not system files).
   * Used for inverse sync: gives the exact candidate lines to score.
   */
  getLinesForPage(page: number): number[] {
    const records = this.pageIndex.get(page)
    if (!records) return []

    // Collect unique lines from main input (input 1), tracking Y per line
    const lineY = new Map<number, number>()
    for (const r of records) {
      if (r.inputNumber !== 1) continue
      // Keep the largest Y (topmost on page — SyncTeX Y is from bottom)
      if (!lineY.has(r.line) || r.y > lineY.get(r.line)!) {
        lineY.set(r.line, r.y)
      }
    }

    // Sort by Y descending (SyncTeX Y is from bottom, so larger Y = higher on page)
    return Array.from(lineY.entries())
      .sort((a, b) => b[1] - a[1])
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
    return this.pageIndex.size
  }

  /**
   * Scroll-sync line→page lookup using interpolated waypoints.
   * Unlike forwardSync (which returns precise PDF coordinates for click sync),
   * this returns a smoothly-progressing page number suitable for scroll sync.
   * Accounts for non-uniform content density (figures, tables, etc).
   */
  lineToPage(line: number): number | null {
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
    return this.data?.inputs ?? new Map()
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

  private extendLockTimeout(): void {
    if (this.scrollLock.timeout) clearTimeout(this.scrollLock.timeout)
    this.scrollLock.timeout = setTimeout(() => {
      this.scrollLock.leader = null
      this.scrollLock.timeout = null
    }, 150)
  }

  private buildIndexes(): void {
    this.pageIndex.clear()
    this.lineIndex.clear()
    this.scrollWaypoints = []

    if (!this.data) return

    // Collect unique (line → page) pairs for waypoint table.
    // Only use records from the main input (input 1 = user's document).
    // System files (book.cls, hyperref.sty, etc.) have their own line numbers
    // that would pollute the mapping if included.
    const mainInput = 1
    const linePageMap = new Map<number, number>()

    for (const record of this.data.records) {
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
      let lineRecords = inputMap.get(record.line)
      if (!lineRecords) {
        lineRecords = []
        inputMap.set(record.line, lineRecords)
      }
      lineRecords.push(record)

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
