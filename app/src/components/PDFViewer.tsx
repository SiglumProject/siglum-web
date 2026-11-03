/**
 * PDFViewer - Full-featured PDF viewer using pdf.js
 *
 * Features:
 * - Search with highlight
 * - Light/dark mode
 * - Zoom presets dropdown
 * - Fit-width mode
 * - Text selection
 * - Memory-optimized for 100+ page documents:
 *   - Explicit page.cleanup() after rendering
 *   - Streaming search (doesn't load all pages at once)
 *   - Page cache with cleanup for off-screen pages
 */

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, X, Download } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem, TextContent } from 'pdfjs-dist/types/src/display/api'
import syncTexService from '../services/SyncTexService'
import EventBus from '../services/EventBus'
import StateStore from '../services/FileStateStore'
import './PDFViewer.css'
import { usePdfTheme } from '../hooks/usePdfTheme'
import PdfThemeToggle from './PdfThemeToggle'
import PdfPageControl from './PdfPageControl'
import { readPdfText } from '../utils/pdfText'

// Set worker path
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// How many pages to keep in cache around current page
const PAGE_CACHE_SIZE = 3

// In-memory per-document viewer state — instant restore on tab switch
interface ViewerState {
  renderScale: number
  transformX: number
  transformY: number
  transformScale: number
  page: number
}
const viewerStateCache = new Map<string, ViewerState>()

// PDF proxy cache — avoids re-parsing on tab switch (parsing takes 50-200ms)
const MAX_PROXY_CACHE = 5
interface CachedProxy {
  proxy: pdfjsLib.PDFDocumentProxy
  dataRef: Uint8Array | string  // track which data produced this proxy
}
const pdfProxyCache = new Map<string, CachedProxy>()

function evictOldestProxy() {
  if (pdfProxyCache.size <= MAX_PROXY_CACHE) return
  const oldest = pdfProxyCache.keys().next().value
  if (oldest) {
    pdfProxyCache.get(oldest)?.proxy.destroy()
    pdfProxyCache.delete(oldest)
  }
}

interface PDFViewerProps {
  compact?: boolean
  pdfUrl?: string
  pdfData?: Uint8Array
  syncTexData?: string // Raw SyncTeX data for bidirectional sync
  onCompile?: () => void
  isCompiling?: boolean
  documentId?: string // For persisting viewer state (zoom, position, page)
}

interface SearchMatch {
  pageNum: number
  itemIndex: number
  text: string
  startIndex: number
  endIndex: number
}

interface TextItemWithTransform extends TextItem {
  transform: number[]
}

const ZOOM_PRESETS = [
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100%', value: 1.0 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2.0 },
]

const PDFViewer: React.FC<PDFViewerProps> = React.memo(({ pdfUrl, pdfData, onCompile, isCompiling, documentId, compact = false }) => {
  const { dark } = usePdfTheme()
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  // renderScale: the scale at which we render the canvas (for sharpness)
  const [renderScale, setRenderScale] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [renderRetry, setRenderRetry] = useState(0)
  const [fitWidth, setFitWidth] = useState(true)
  const [showZoomPresets, setShowZoomPresets] = useState(false)

  // Apple-style transform state (the source of truth for viewport)
  // visualScale: total visual zoom (renderScale * transformScale)
  // translateX/Y: position of content in viewport
  const transformRef = useRef({
    x: 0,
    y: 0,
    scale: 1, // multiplier on top of renderScale
  })
  // Skip auto-centering after gesture-triggered re-renders or recompiles
  const skipCenterRef = useRef(false)
  const lastDocumentIdRef = useRef<string | undefined>(undefined)
  const hadPdfRef = useRef(false) // Track if we had a PDF before (for recompile detection)
  const lastPdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null) // Track pdf reference for recompile detection

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const [showSearch, setShowSearch] = useState(false)
  const savedMatchIndexRef = useRef(0) // Preserve position when closing/reopening search
  const currentMatchIndexRef = useRef(0) // Track current index for stable event handlers

  // Sync highlight state - Y position and key to force animation restart
  const [syncHighlight, setSyncHighlight] = useState<{ y: number; key: number } | null>(null)
  const revealLocationRef = useRef<(x: number, y: number) => void>(() => {})
  const pendingJumpRef = useRef<{ page: number; show: () => void } | null>(null)
  const renderedPageRef = useRef<{ page: number; scale: number; pdf: pdfjsLib.PDFDocumentProxy } | null>(null)
  useEffect(() => { pendingJumpRef.current = null }, [documentId])
  const syncHighlightTimeoutRef = useRef<number | null>(null)
  const syncHighlightKeyRef = useRef(0)
  const syncIndicatorRef = useRef<HTMLDivElement>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)
  const renderIdRef = useRef(0)  // Incremented each render to detect stale renders
  // Refs to track state for stable event handlers (avoids listener churn)
  const showSearchRef = useRef(showSearch)
  useEffect(() => { showSearchRef.current = showSearch }, [showSearch])
  useEffect(() => { currentMatchIndexRef.current = currentMatchIndex }, [currentMatchIndex])
  const searchInputRef = useRef<HTMLInputElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const highlightLayerRef = useRef<HTMLDivElement>(null)
  const zoomButtonRef = useRef<HTMLButtonElement>(null)
  const pdfDataCopyRef = useRef<Uint8Array | null>(null) // Keep a copy for download (pdf.js may detach the buffer)
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null) // Track current PDF for cleanup
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null) // Track loading task for cancellation
  const pageCacheRef = useRef<Map<number, pdfjsLib.PDFPageProxy>>(new Map()) // LRU page cache
  const searchAbortRef = useRef<AbortController | null>(null) // For cancelling ongoing search
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null) // Reusable canvas for text measurement
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null) // Reusable offscreen canvas for double-buffering
  const pixelRatioRef = useRef(window.devicePixelRatio || 1) // Cache pixel ratio (rarely changes)
  const stateRestoredRef = useRef(false) // Track if state has been restored for this document
  const saveStateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null) // Debounce state saves
  const pageTextsRef = useRef<Map<number, string>>(new Map()) // Cached extracted text per PDF page
  const pageTextContentRef = useRef<Map<number, TextContent>>(new Map()) // Cached TextContent per page (for inverse sync)
  const documentIdRef = useRef(documentId) // Ref for stable callback
  documentIdRef.current = documentId

  // SyncTeX data is parsed by SyncTexService (updated by useCompilation hook)
  // The syncTexData prop is still passed to signal when data changes

  // Inverse sync: PDF text → editor
  // Uses document-level mouseup to avoid ref timing issues with conditional rendering.
  // Checks if the mouseup target is within the text layer.
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      const textLayer = textLayerRef.current
      if (!textLayer) return

      // Use elementFromPoint instead of e.target because setPointerCapture
      // on the pdf-document container redirects all pointer events to it,
      // making e.target always the container div instead of the text layer span
      const elementUnderCursor = document.elementFromPoint(e.clientX, e.clientY)
      if (!elementUnderCursor || !textLayer.contains(elementUnderCursor)) return

      const textContent = pageTextContentRef.current.get(currentPageRef.current)
      if (!textContent) return

      // Check if user selected text or just clicked
      const selection = window.getSelection()
      let selectedWord = ''

      if (selection && selection.toString().trim().length >= 2) {
        // User selected/highlighted text — use the first word of selection
        selectedWord = selection.toString().trim().split(/\s+/)[0]
      } else {
        // Single click — find the word under cursor
        const span = (elementUnderCursor as HTMLElement).closest('span') as HTMLSpanElement | null
        if (!span) return

        const spanText = span.textContent || ''
        const spanRect = span.getBoundingClientRect()
        const charIndex = Math.min(
          spanText.length - 1,
          Math.max(0, Math.floor((e.clientX - spanRect.left) / (spanRect.width / Math.max(1, spanText.length))))
        )

        let ws = charIndex, we = charIndex
        while (ws > 0 && /\w/.test(spanText[ws - 1])) ws--
        while (we < spanText.length && /\w/.test(spanText[we])) we++
        selectedWord = spanText.substring(ws, we)
      }

      if (!selectedWord || selectedWord.length < 2) return

      // Build all words on this page from TextContent items
      const allWords: string[] = []
      for (const item of textContent.items) {
        if (!('str' in item) || !(item as any).str) continue
        const str = (item as any).str as string
        for (const w of str.split(/\s+/)) {
          if (w.length > 0) allWords.push(w)
        }
      }

      // Find the selected word's position in the word sequence
      const wordLower = selectedWord.toLowerCase()
      let wordIndex = -1

      // Try to locate via selection anchor node → span index → word count
      if (selection && selection.anchorNode) {
        const anchorSpan = selection.anchorNode.parentElement
        if (anchorSpan && textLayer.contains(anchorSpan)) {
          const spans = textLayer.querySelectorAll('span')
          let spanIdx = -1
          for (let i = 0; i < spans.length; i++) {
            if (spans[i] === anchorSpan) { spanIdx = i; break }
          }

          if (spanIdx >= 0) {
            let wordCount = 0
            for (let i = 0; i < textContent.items.length && i < spanIdx; i++) {
              if (!('str' in textContent.items[i])) continue
              const str = (textContent.items[i] as any).str as string
              wordCount += str.split(/\s+/).filter((w: string) => w.length > 0).length
            }
            for (let i = wordCount; i < allWords.length; i++) {
              if (allWords[i].toLowerCase().includes(wordLower) ||
                  wordLower.includes(allWords[i].toLowerCase())) {
                wordIndex = i
                break
              }
            }
          }
        }
      }

      // Fallback: find first occurrence
      if (wordIndex === -1) {
        for (let i = 0; i < allWords.length; i++) {
          if (allWords[i].toLowerCase().includes(wordLower)) {
            wordIndex = i
            break
          }
        }
      }
      if (wordIndex === -1) return

      // Extract context window: 4 words before + word + 4 words after
      const WINDOW = 4
      const before = allWords.slice(Math.max(0, wordIndex - WINDOW), wordIndex)
      const after = allWords.slice(wordIndex + 1, wordIndex + 1 + WINDOW)
      const context = [...before, selectedWord, ...after].join(' ')

      // Compute vertical position as fraction (0=top, 1=bottom) for SyncTeX narrowing
      const canvas = canvasRef.current
      let yFraction = 0.5
      if (canvas) {
        const canvasRect = canvas.getBoundingClientRect()
        yFraction = Math.max(0, Math.min(1, (e.clientY - canvasRect.top) / canvasRect.height))
      }

      EventBus.emit('inverseSync', { context, word: selectedWord, page: currentPageRef.current, yFraction })
    }

    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [])

  // Ref for renderScale so stable callbacks can access current value
  const renderScaleRef = useRef(renderScale)
  const currentPageRef = useRef(currentPage)
  const pageCountRef = useRef(pageCount)

  // Sync refs for stable callbacks (combined into single effect to reduce effect count)
  useEffect(() => { renderScaleRef.current = renderScale }, [renderScale])

  // Apply transform to the page wrapper element
  const applyTransform = useCallback(() => {
    const wrapper = documentRef.current?.querySelector('.pdf-page-wrapper') as HTMLElement
    if (!wrapper) return

    const { x, y, scale } = transformRef.current
    wrapper.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }, [])

  // Save PDF viewer state to StateStore (debounced)
  // Uses refs to avoid recreating callback on every state change
  const saveViewerState = useCallback(() => {
    const docId = documentIdRef.current
    if (!docId) return

    // Clear any pending save
    if (saveStateTimeoutRef.current) {
      clearTimeout(saveStateTimeoutRef.current)
    }

    // Debounce saves to avoid excessive writes during gestures
    saveStateTimeoutRef.current = setTimeout(() => {
      const t = transformRef.current
      StateStore.setPdfViewerState(
        docId,
        renderScaleRef.current,
        t.x,
        t.y,
        t.scale,
        currentPageRef.current
      )
    }, 300)
  }, []) // Stable callback - uses refs for changing values

  // Restore PDF viewer state synchronously when document changes
  // Uses in-memory cache (instant) with localStorage fallback (also sync)
  useEffect(() => {
    if (!documentId) return

    // Save current viewer state for the document we're leaving
    const prevId = lastDocumentIdRef.current
    if (prevId && prevId !== documentId) {
      const t = transformRef.current
      viewerStateCache.set(prevId, {
        renderScale: renderScaleRef.current,
        transformX: t.x,
        transformY: t.y,
        transformScale: t.scale,
        page: currentPageRef.current,
      })
    }

    // Reset tracking for new document
    stateRestoredRef.current = false
    hadPdfRef.current = false

    // Clear search state
    setSearchQuery('')
    setSearchMatches([])
    setCurrentMatchIndex(0)
    savedMatchIndexRef.current = 0
    if (showSearchRef.current) {
      setShowSearch(false)
    }

    // A phone opens at a usable fit instead of restoring a pan from a larger viewport.
    if (compact) {
      transformRef.current = { x: 0, y: 0, scale: 1 }
      setCurrentPage(1)
      setFitWidth(true)
      setRenderScale(1)
      return
    }

    // Try in-memory cache first (instant — covers tab switching within session)
    const cached = viewerStateCache.get(documentId)
    if (cached) {
      transformRef.current = {
        x: cached.transformX,
        y: cached.transformY,
        scale: cached.transformScale,
      }
      skipCenterRef.current = true
      stateRestoredRef.current = true
      setRenderScale(cached.renderScale)
      setCurrentPage(cached.page)
      setFitWidth(false)
      return
    }

    // Fallback: synchronous localStorage/StateStore cache read
    // Covers page reload (state persisted to localStorage on save)
    const stored = StateStore.getDocumentStateSync(documentId)
    if (stored && stored.pdfRenderScale !== undefined) {
      transformRef.current = {
        x: stored.pdfTransformX ?? 0,
        y: stored.pdfTransformY ?? 0,
        scale: stored.pdfTransformScale ?? 1,
      }
      skipCenterRef.current = true
      stateRestoredRef.current = true
      setRenderScale(stored.pdfRenderScale)
      setCurrentPage(stored.pdfCurrentPage ?? 1)
      setFitWidth(false)
    }
  }, [documentId, compact])

  // Save state when relevant values change
  useEffect(() => {
    // Don't save during initial restore
    if (!stateRestoredRef.current && !pdf) return
    saveViewerState()
  }, [renderScale, currentPage, saveViewerState, pdf])

  // Center the content in the viewport (called after render or reset)
  // IMPORTANT: This must produce the same result as clampTransform for small content
  const centerContent = useCallback(() => {
    const container = documentRef.current
    const wrapper = container?.querySelector('.pdf-page-wrapper') as HTMLElement
    const canvas = canvasRef.current
    if (!container || !wrapper || !canvas) return

    // Use clientWidth/clientHeight for consistency with clampTransform
    // These reflect the actual rendered CSS size
    const containerRect = container.getBoundingClientRect()
    const canvasWidth = canvas.clientWidth
    const canvasHeight = canvas.clientHeight

    // If canvas hasn't been sized yet, skip centering (will be called again after render)
    if (canvasWidth === 0 || canvasHeight === 0) return

    const scale = transformRef.current.scale

    // Content size at current transform scale
    const contentWidth = canvasWidth * scale
    const contentHeight = canvasHeight * scale

    // Use same logic as clampTransform to avoid jump on first gesture
    let x: number, y: number
    if (contentWidth <= containerRect.width) {
      x = (containerRect.width - contentWidth) / 2
    } else {
      x = 0
    }
    if (contentHeight <= containerRect.height) {
      const padding = Math.min(24, (containerRect.height - contentHeight) / 4)
      y = padding
    } else {
      // Content taller than viewport - start with top padding
      y = 24
    }

    transformRef.current.x = x
    transformRef.current.y = y
    applyTransform()
  }, [applyTransform])

  useEffect(() => {
    currentPageRef.current = currentPage
  }, [currentPage])

  useEffect(() => {
    pageCountRef.current = pageCount
  }, [pageCount])

  // Directly update indicator position via DOM (bypass React reconciliation issues)
  useEffect(() => {
    if (syncIndicatorRef.current) {
      if (syncHighlight) {
        syncIndicatorRef.current.style.top = `${syncHighlight.y}px`
        syncIndicatorRef.current.style.display = 'block'
      } else {
        syncIndicatorRef.current.style.display = 'none'
      }
    }
  }, [syncHighlight])

  // Forward sync: editor click → PDF (SyncTeX-based precise positioning)
  useEffect(() => {
    const handleForwardSync = ({ line, filename, reveal }: { line: number; filename?: string; reveal?: boolean }) => {
      if (!syncTexService.isAvailable()) return

      // Look up PDF location in PDF-point coordinates
      const result = syncTexService.forwardSync(line, filename)
      if (!result) return

      // Navigate and show highlight

      // Clear any existing highlight timeout
      if (syncHighlightTimeoutRef.current) {
        clearTimeout(syncHighlightTimeoutRef.current)
      }

      const showHighlight = () => {
        // Convert PDF points to canvas pixels (at current renderScale)
        // The highlight is a child of pdf-page-wrapper which has the CSS transform,
        // so we position in canvas-pixel space (pre-transform)
        const currentRenderScale = renderScaleRef.current
        const canvasY = result.y * currentRenderScale

        // Clamp to canvas bounds
        const canvas = canvasRef.current
        const maxY = canvas ? canvas.clientHeight - 4 : canvasY
        const clampedY = Math.max(0, Math.min(canvasY, maxY))

        if (reveal) revealLocationRef.current(result.x * currentRenderScale, clampedY)

        // Show highlight with new key to restart CSS animation
        syncHighlightKeyRef.current += 1
        setSyncHighlight({ y: clampedY, key: syncHighlightKeyRef.current })

        // Auto-hide after 2 seconds
        syncHighlightTimeoutRef.current = window.setTimeout(() => {
          setSyncHighlight(null)
        }, 2000)
      }

      if (reveal) {
        // A page change must finish rendering before we position the viewport.
        if (renderedPageRef.current?.pdf === pdfRef.current && renderedPageRef.current?.page === result.page && renderedPageRef.current?.scale === renderScaleRef.current && currentPageRef.current === result.page) {
          pendingJumpRef.current = null
          showHighlight()
        } else {
          pendingJumpRef.current = { page: result.page, show: showHighlight }
          setCurrentPage(result.page)
        }
        return
      }

      // Navigate to the correct page if needed
      if (result.page !== currentPageRef.current) {
        setCurrentPage(result.page)
        // Wait for page render before positioning highlight
        setTimeout(() => requestAnimationFrame(showHighlight), 100)
      } else {
        showHighlight()
      }
    }

    return EventBus.on('forwardSync', handleForwardSync)
  }, []) // Stable — uses refs and service singleton for changing values

  // Scroll sync: Listen for editor text → find matching PDF page
  useEffect(() => {
    return EventBus.on('scrollSync', ({ text, source }) => {
      if (source !== 'editor') return
      if (pageTextsRef.current.size === 0) return

      // Extract distinctive words from the editor text
      const words = text.toLowerCase().split(/\s+/).filter(w => w.length >= 4 && /[a-z]/.test(w))
      if (words.length < 2) return

      // Search all pages, pick the one with the most matching words
      let bestPage = -1
      let bestScore = 0
      const currentP = currentPageRef.current

      for (const [page, pageText] of pageTextsRef.current) {
        const lower = pageText.toLowerCase()
        const score = words.filter(w => lower.includes(w)).length
        // Tiebreak: prefer page closer to current (avoids jumps on ambiguous matches)
        if (score > bestScore || (score === bestScore && bestPage !== -1 && Math.abs(page - currentP) < Math.abs(bestPage - currentP))) {
          bestScore = score
          bestPage = page
        }
      }

      if (bestScore >= 2 && bestPage !== currentP) {
        if (!syncTexService.acquireScrollLock('editor')) return
        setCurrentPage(bestPage)
      }
    })
  }, [])

  // Cleanup PDF on unmount
  useEffect(() => {
    return () => {
      // Cancel any ongoing search
      if (searchAbortRef.current) {
        searchAbortRef.current.abort()
      }
      // Cancel any ongoing loading task
      if (loadingTaskRef.current) {
        loadingTaskRef.current.destroy()
        loadingTaskRef.current = null
      }
      // Cancel any ongoing render task
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        renderTaskRef.current = null
      }
      // Cleanup all cached pages
      for (const page of pageCacheRef.current.values()) {
        page.cleanup()
      }
      pageCacheRef.current.clear()
      // Clear sync highlight timeout
      if (syncHighlightTimeoutRef.current) {
        clearTimeout(syncHighlightTimeoutRef.current)
        syncHighlightTimeoutRef.current = null
      }
      // Clear save state timeout
      if (saveStateTimeoutRef.current) {
        clearTimeout(saveStateTimeoutRef.current)
        saveStateTimeoutRef.current = null
      }
      // Cached proxies survive layout remounts; eviction owns their destruction.
      if (pdfRef.current) {
        const current = pdfRef.current
        const cached = [...pdfProxyCache.values()].some(entry => entry.proxy === current)
        if (!cached) void current.destroy()
        pdfRef.current = null
      }
    }
  }, [])

  // Load PDF document — uses proxy cache for instant tab switching
  useEffect(() => {
    // No source provided - show empty state
    if (!pdfData && !pdfUrl) {
      // Cancel any ongoing loading task first
      if (loadingTaskRef.current) {
        loadingTaskRef.current.destroy()
        loadingTaskRef.current = null
      }
      // Clear current proxy ref (don't destroy — it's in the cache)
      pageCacheRef.current.clear()
      pdfRef.current = null
      setPdf(null)
      setIsLoading(false)
      return
    }

    const dataRef = pdfData || pdfUrl!

    // Check proxy cache — instant restore if same data reference
    if (documentId) {
      const cached = pdfProxyCache.get(documentId)
      if (cached && cached.dataRef === dataRef) {
        // Cancel any in-flight load
        if (loadingTaskRef.current) {
          loadingTaskRef.current.destroy()
          loadingTaskRef.current = null
        }
        if (pdfData) pdfDataCopyRef.current = pdfData
        pageCacheRef.current.clear()
        pdfRef.current = cached.proxy
        // Move to end of map (most recently used)
        pdfProxyCache.delete(documentId)
        pdfProxyCache.set(documentId, cached)
        setPdf(cached.proxy)
        setPageCount(cached.proxy.numPages)
        setCurrentPage(page => Math.max(1, Math.min(page, cached.proxy.numPages)))
        setError(null)
        setIsLoading(false)
        return
      }
    }

    // Track if this effect has been superseded (prevents stale state updates)
    let cancelled = false

    const loadPdf = async () => {
      // Cancel any ongoing loading task before starting a new one
      // This prevents "Transport destroyed" errors from in-flight operations
      if (loadingTaskRef.current) {
        loadingTaskRef.current.destroy()
        loadingTaskRef.current = null
      }

      let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null

      try {
        // Only show loading on initial load, not on updates (to prevent flash)
        if (!pdf) {
          setIsLoading(true)
        }
        setError(null)

        if (pdfData) {
          // Keep the original pdfData reference for download
          pdfDataCopyRef.current = pdfData

          // pdf.js may detach the buffer it's given, so hand it a private copy
          const dataForPdfJs = new Uint8Array(pdfData.length)
          dataForPdfJs.set(pdfData)
          loadingTask = pdfjsLib.getDocument({ data: dataForPdfJs })
        } else if (pdfUrl) {
          loadingTask = pdfjsLib.getDocument(pdfUrl)
        } else {
          return
        }

        // Track the loading task for cancellation
        loadingTaskRef.current = loadingTask

        const pdfDoc = await loadingTask.promise

        // An older completion must not clear a newer loading task.
        if (loadingTaskRef.current === loadingTask) loadingTaskRef.current = null

        // Check if cancelled before updating state (prevents race condition)
        if (cancelled) {
          pdfDoc.destroy()
          return
        }

        // Clear page cache (don't destroy old proxy — it may be in pdfProxyCache)
        pageCacheRef.current.clear()

        // Cache the new proxy for instant restore later
        if (documentId) {
          // If a different proxy was cached for this doc (e.g. recompile), destroy it
          const prev = pdfProxyCache.get(documentId)
          if (prev && prev.proxy !== pdfDoc) {
            prev.proxy.destroy()
          }
          pdfProxyCache.set(documentId, { proxy: pdfDoc, dataRef })
          evictOldestProxy()
        } else if (pdfRef.current) {
          // No documentId — destroy the old proxy outright
          pdfRef.current.destroy()
        }

        pdfRef.current = pdfDoc
        setPdf(pdfDoc)
        setPageCount(pdfDoc.numPages)
        setCurrentPage(page => Math.max(1, Math.min(page, pdfDoc.numPages)))
        setIsLoading(false)
      } catch (err: unknown) {
        // Only clear ref if this is still the current task (avoid clobbering newer task)
        if (loadingTaskRef.current === loadingTask) {
          loadingTaskRef.current = null
        }

        // Ignore cancellation errors (expected when superseded)
        if (err instanceof Error && err.message?.includes('destroyed')) {
          return
        }

        // Don't update state if cancelled
        if (cancelled) return

        console.error('Failed to load PDF:', err)
        setError('Failed to load PDF')
        setIsLoading(false)
      }
    }

    loadPdf()

    return () => {
      // Mark as cancelled to prevent stale state updates
      cancelled = true

      // Cancel render task
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
      }

      // Cancel loading task if still in progress
      if (loadingTaskRef.current) {
        loadingTaskRef.current.destroy()
        loadingTaskRef.current = null
      }
    }
  }, [pdfUrl, pdfData, documentId])

  // Extract text from all PDF pages for scroll sync and inverse sync
  // Updates progressively (per-page) so clicks work before full extraction completes
  useEffect(() => {
    if (!pdf) {
      pageTextsRef.current = new Map()
      pageTextContentRef.current = new Map()
      return
    }

    let cancelled = false
    pageTextsRef.current = new Map()
    pageTextContentRef.current = new Map()

    const yieldToMain = () => new Promise<void>(resolve => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => resolve(), { timeout: 500 })
      } else {
        setTimeout(resolve, 0)
      }
    })

    const extract = async () => {
      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) return
        // Yield between pages to avoid blocking the main thread
        await yieldToMain()
        if (cancelled || pdfRef.current !== pdf) return
        const page = await pdf.getPage(i)
        const content = await readPdfText(page)
        if (cancelled) return
        pageTextContentRef.current.set(i, content)
        const text = content.items
          .filter((item: any) => typeof item.str === 'string')
          .map((item: any) => item.str)
          .join(' ')
        pageTextsRef.current.set(i, text)
      }
    }

    extract().catch(error => {
      if (!cancelled && pdfRef.current === pdf) console.error('PDF text extraction failed:', error)
    })
    return () => { cancelled = true }
  }, [pdf])

  // Get page from cache or load and cache it
  const getPageCached = useCallback(async (pdf: pdfjsLib.PDFDocumentProxy, pageNum: number): Promise<pdfjsLib.PDFPageProxy> => {
    const cache = pageCacheRef.current

    // Return cached page if available
    if (cache.has(pageNum)) {
      return cache.get(pageNum)!
    }

    // Load and cache the page
    const page = await pdf.getPage(pageNum)
    if (pdfRef.current !== pdf) return page
    cache.set(pageNum, page)

    // Evict pages outside the cache window (LRU-style based on distance from current page)
    // Keep pages within PAGE_CACHE_SIZE of the current page
    const pagesToKeep = new Set<number>()
    for (let i = Math.max(1, pageNum - PAGE_CACHE_SIZE); i <= Math.min(pdf.numPages, pageNum + PAGE_CACHE_SIZE); i++) {
      pagesToKeep.add(i)
    }

    // Cleanup pages outside the window
    for (const [cachedPageNum, cachedPage] of cache) {
      if (!pagesToKeep.has(cachedPageNum)) {
        cachedPage.cleanup()
        cache.delete(cachedPageNum)
      }
    }

    return page
  }, [])

  // Render current page using double-buffering to prevent blink
  const renderPage = useCallback(async () => {
    if (!pdf || pdfRef.current !== pdf || !canvasRef.current) return

    // Increment render ID to track this render
    const thisRenderId = ++renderIdRef.current

    // Cancel any ongoing render
    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel()
      } catch {
        // Ignore cancellation errors
      }
      renderTaskRef.current = null
    }

    try {
      const page = await getPageCached(pdf, currentPage)

      // Check if a newer render was started while we were waiting
      if (thisRenderId !== renderIdRef.current || pdfRef.current !== pdf) return

      const viewport = page.getViewport({ scale: renderScale })

      // Tell SyncTexService the actual page height (in PDF points at 72 DPI)
      syncTexService.setPageHeight(currentPage, viewport.height / renderScale)

      const pixelRatio = pixelRatioRef.current
      const requiredWidth = Math.ceil(viewport.width * pixelRatio)
      const requiredHeight = Math.ceil(viewport.height * pixelRatio)

      const canvas = canvasRef.current
      if (!canvas) return

      // Immediately update CSS dimensions so existing content scales visually
      // This prevents blurriness while the high-res render happens
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      // Create a fresh offscreen canvas for this render to avoid PDF.js conflicts
      // when cancelling renders (PDF.js doesn't allow canvas reuse during active renders)
      const offscreen = document.createElement('canvas')
      offscreen.width = requiredWidth
      offscreen.height = requiredHeight

      const offscreenCtx = offscreen.getContext('2d')
      if (!offscreenCtx) return

      // Set up transform for high-DPI rendering
      offscreenCtx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

      // Check again before starting expensive render
      if (thisRenderId !== renderIdRef.current || pdfRef.current !== pdf) return

      // Render to offscreen canvas
      renderTaskRef.current = page.render({
        canvasContext: offscreenCtx,
        viewport: viewport,
        canvas: offscreen,
      })
      await renderTaskRef.current.promise

      // Check if this render is still current before blitting
      if (thisRenderId !== renderIdRef.current || pdfRef.current !== pdf) return

      // Update canvas buffer dimensions and blit the new content
      if (canvas.width !== requiredWidth || canvas.height !== requiredHeight) {
        canvas.width = requiredWidth
        canvas.height = requiredHeight
      }

      const context = canvas.getContext('2d')
      if (context) {
        // Draw offscreen content to visible canvas (single blit, no clear needed)
        context.drawImage(offscreen, 0, 0)
      }

      renderedPageRef.current = { page: currentPage, scale: renderScale, pdf }
      // Store for reuse by subsequent same-scale renders
      offscreenCanvasRef.current = offscreen

      // Text selection/search is optional. Its failure must never hide a rendered page.
      try {
        const textContent = await readPdfText(page)
        if (thisRenderId !== renderIdRef.current || pdfRef.current !== pdf) return
        await renderTextLayer(page, viewport, textContent)
        if (searchMatches.length > 0) renderSearchHighlights(textContent, viewport)
      } catch (textError) {
        if (thisRenderId === renderIdRef.current && pdfRef.current === pdf) console.warn('PDF text layer unavailable:', textError)
      }
      const jump = pendingJumpRef.current
      if (jump?.page === currentPage) {
        // Run after the viewer's normal page-centering frames.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (pendingJumpRef.current !== jump || renderIdRef.current !== thisRenderId) return
          pendingJumpRef.current = null
          jump.show()
        }))
      }
    } catch (err: unknown) {
      // Ignore cancelled renders and results belonging to a superseded PDF.
      if (pdfRef.current !== pdf || thisRenderId !== renderIdRef.current) return
      if (err instanceof Error && err.name !== 'RenderingCancelledException') {
        console.error('Render error:', err)
        setError('This page could not be rendered. Try compiling again or downloading the PDF.')
      }
    }
  }, [pdf, currentPage, renderScale, searchMatches, getPageCached, renderRetry])

  // Preserve transform on recompile or restored state — runs BEFORE browser paint to prevent flash.
  // The wrapper has position:absolute top:0 left:0, so without a transform it sits at the origin.
  // useEffect would let one frame paint without the transform; useLayoutEffect prevents that.
  useLayoutEffect(() => {
    if (!pdf) return
    const wrapper = documentRef.current?.querySelector('.pdf-page-wrapper') as HTMLElement
    if (!wrapper) return
    // Apply on recompile (same document, had PDF before) OR when state was restored
    if ((hadPdfRef.current && documentId === lastDocumentIdRef.current) || stateRestoredRef.current) {
      const { x, y, scale } = transformRef.current
      wrapper.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    }
  }, [pdf, documentId])

  // Center content after render completes (but not after gesture-triggered re-renders or recompiles)
  useEffect(() => {
    if (pdf && canvasRef.current) {
      // Detect recompile: pdf object actually changed, same document, already had a PDF
      const pdfChanged = pdf !== lastPdfRef.current
      const isRecompile = pdfChanged && documentId === lastDocumentIdRef.current && hadPdfRef.current

      // Update tracking refs
      lastPdfRef.current = pdf
      lastDocumentIdRef.current = documentId
      hadPdfRef.current = true

      // Skip centering if state was restored, gesture-triggered, or recompile
      if (skipCenterRef.current || isRecompile || stateRestoredRef.current) {
        skipCenterRef.current = false
        // Still need to apply transform after canvas resizes
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            applyTransform()
          })
        })
        return
      }
      // Wait for canvas to be sized
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          centerContent()
        })
      })
    }
  }, [pdf, renderScale, currentPage, centerContent, applyTransform, documentId])

  // Get or create the measurement canvas (reused to avoid GC pressure)
  const getMeasureContext = useCallback((): CanvasRenderingContext2D | null => {
    if (!measureCanvasRef.current) {
      measureCanvasRef.current = document.createElement('canvas')
    }
    return measureCanvasRef.current.getContext('2d')
  }, [])

  // Render text layer for selection
  // Uses scaleX transform to match text width to PDF bounding box (same approach as pdf.js)
  // Optimized: DocumentFragment for batch DOM insertion, cssText for single style assignment
  const renderTextLayer = async (_page: pdfjsLib.PDFPageProxy, viewport: pdfjsLib.PageViewport, textContent: TextContent) => {
    if (!textLayerRef.current) return

    const textLayerDiv = textLayerRef.current
    textLayerDiv.innerHTML = ''
    textLayerDiv.style.cssText = `width:${viewport.width}px;height:${viewport.height}px`

    // Reuse canvas for text measurement (avoids creating new element each render)
    const ctx = getMeasureContext()
    if (!ctx) return

    // Use DocumentFragment for batch DOM insertion (avoids layout thrash per span)
    const fragment = document.createDocumentFragment()

    textContent.items.forEach((item) => {
      if (!('str' in item) || !item.str) return
      const textItem = item as TextItemWithTransform

      const span = document.createElement('span')
      span.textContent = textItem.str

      const tx = textItem.transform[4] * renderScale
      const ty = textItem.transform[5] * renderScale
      const fontSize = Math.sqrt(textItem.transform[0] ** 2 + textItem.transform[1] ** 2) * renderScale
      const style = textContent.styles[textItem.fontName]
      const fontFamily = style?.fontFamily || 'sans-serif'

      // Get the width from PDF (if available) or estimate from transform
      const pdfWidth = (textItem.width || 0) * renderScale

      // Measure the text as it will render in the browser
      ctx.font = `${fontSize}px ${fontFamily}`
      const measuredWidth = ctx.measureText(textItem.str).width

      // Calculate scaleX to fit the PDF bounding box
      const scaleX = pdfWidth > 0 && measuredWidth > 0 ? pdfWidth / measuredWidth : 1

      // ty is baseline from bottom of page in PDF coords
      // Convert to top-left CSS coords, accounting for ascender (text above baseline)
      const top = viewport.height - ty - fontSize * (style?.ascent ?? 0.8)

      // Single cssText assignment instead of 10 individual style properties
      // Reduces DOM operations from 10 to 1 per span
      span.style.cssText = `left:${tx}px;top:${top}px;font-size:${fontSize}px;font-family:${fontFamily};line-height:1;position:absolute;white-space:pre;pointer-events:auto;cursor:text;transform-origin:0% 0%;transform:scaleX(${scaleX})`

      fragment.appendChild(span)
    })

    // Single DOM insertion for all spans (avoids 500+ potential layout thrashes)
    textLayerDiv.appendChild(fragment)
  }

  // Render search highlights - uses textContent passed from renderPage to avoid duplicate fetch
  // Optimized: DocumentFragment for batch DOM insertion, cssText for single style assignment
  const renderSearchHighlights = (textContent: TextContent, viewport: pdfjsLib.PageViewport) => {
    if (!highlightLayerRef.current) return

    const highlightLayer = highlightLayerRef.current
    highlightLayer.innerHTML = ''
    highlightLayer.style.cssText = `width:${viewport.width}px;height:${viewport.height}px`

    const pageMatches = searchMatches.filter(m => m.pageNum === currentPage)
    if (pageMatches.length === 0) return

    // Pre-compute match indices for O(1) lookup instead of O(n) findIndex per match
    const matchIndexMap = new Map<string, number>()
    searchMatches.forEach((m, idx) => {
      matchIndexMap.set(`${m.pageNum}-${m.itemIndex}-${m.startIndex}`, idx)
    })

    // Use DocumentFragment for batch DOM insertion
    const fragment = document.createDocumentFragment()

    pageMatches.forEach((match) => {
      const globalIdx = matchIndexMap.get(`${match.pageNum}-${match.itemIndex}-${match.startIndex}`) ?? -1
      const isActive = globalIdx === currentMatchIndex

      const item = textContent.items[match.itemIndex]
      if (!item || !('str' in item)) return
      const textItem = item as TextItemWithTransform

      const [, , , , tx, ty] = textItem.transform
      const fontSize = Math.sqrt(textItem.transform[0] ** 2 + textItem.transform[1] ** 2)

      // Create highlight element
      const highlight = document.createElement('div')
      highlight.className = `search-highlight${isActive ? ' active' : ''}`

      // Approximate position and width
      const charWidth = (textItem.width || fontSize * 0.6) / textItem.str.length
      const left = (tx + match.startIndex * charWidth) * renderScale
      const top = (viewport.height / renderScale - ty) * renderScale - fontSize * renderScale
      const width = (match.endIndex - match.startIndex) * charWidth * renderScale
      const height = fontSize * renderScale * 1.2

      // Single cssText assignment instead of 5 individual style properties
      highlight.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px`

      fragment.appendChild(highlight)
    })

    // Single DOM insertion for all highlights
    highlightLayer.appendChild(fragment)
  }

  useEffect(() => {
    renderPage()
  }, [renderPage])

  // Fit width calculation - uses page cache to avoid redundant page loads
  const calculateFitWidth = useCallback(async () => {
    if (!pdf || !containerRef.current) return

    const page = await getPageCached(pdf, 1)
    const viewport = page.getViewport({ scale: 1 })
    // Leave space for padding around the document
    const containerWidth = containerRef.current.clientWidth - (compact ? 16 : 64)
    // Container not laid out yet (zero/negative width). Returning here avoids
    // computing a negative optimalScale, which would set renderScale negative
    // and render a zero-size (invisible) canvas. The caller retries on resize.
    if (containerWidth <= 0) return
    const optimalScale = (containerWidth / viewport.width) * 0.98 // Slightly smaller for breathing room
    return Math.max(0.1, Math.min(optimalScale, 3)) // Clamp to [10%, 300%]
  }, [pdf, getPageCached, compact])

  // Fit width on initial load - wait for container to have size
  useEffect(() => {
    if (!pdf || !fitWidth || !containerRef.current) return

    const doFitWidth = async () => {
      // Wait a frame for container to be sized
      await new Promise(resolve => requestAnimationFrame(resolve))
      const optimalScale = await calculateFitWidth()
      if (optimalScale) {
        // Only reset transform if render scale is actually changing.
        // On recompile, the page dimensions are the same, so optimalScale matches
        // the current renderScale — skip the transform reset to preserve scroll position.
        if (Math.abs(optimalScale - renderScale) > 0.001) {
          transformRef.current = { x: 0, y: 0, scale: 1 }
          setRenderScale(optimalScale)
        }
      }
    }

    doFitWidth()
  }, [pdf, fitWidth, calculateFitWidth, renderScale])

  // Resize handler - only adjust scale when fitWidth is enabled
  useEffect(() => {
    if (!pdf || !containerRef.current || !fitWidth) return

    // ResizeObserver fires immediately on first observe() — skip the initial call
    // to avoid resetting the transform on recompile (pdf change triggers re-subscription)
    let skipInitial = true
    const resizeObserver = new ResizeObserver(async () => {
      if (skipInitial) {
        skipInitial = false
        return
      }
      const optimalScale = await calculateFitWidth()
      if (optimalScale) {
        transformRef.current = { x: 0, y: 0, scale: 1 }
        setRenderScale(optimalScale)
        // Centering will happen via the renderScale change effect
      }
    })

    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [pdf, fitWidth, calculateFitWidth])

  // Apple-style pinch-to-zoom: Pure transform, no scroll
  // All positioning is done via CSS transform on the page wrapper
  // Render scale only changes when we need sharper content
  const gestureRef = useRef({
    active: false,
    pointers: new Map<number, { x: number; y: number }>(),
    prevMidX: 0,
    prevMidY: 0,
    prevDist: 0,
    // Cached container rect to avoid getBoundingClientRect() on every move
    containerRect: null as DOMRect | null,
    // Timeout for re-rendering at higher resolution after gesture
    renderTimeout: null as ReturnType<typeof setTimeout> | null,
  })

  // Apply current transform to DOM
  const updateTransform = useCallback(() => {
    const wrapper = documentRef.current?.querySelector('.pdf-page-wrapper') as HTMLElement
    if (!wrapper) return
    const { x, y, scale } = transformRef.current
    wrapper.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }, [])

  // Clamp transform to keep content in reasonable bounds
  // Accepts optional cached containerRect to avoid layout thrashing during gestures
  const clampTransform = useCallback((cachedRect?: DOMRect | null) => {
    const container = documentRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const containerRect = cachedRect || container.getBoundingClientRect()
    const t = transformRef.current

    // Content size at current scale
    const contentWidth = canvas.clientWidth * t.scale
    const contentHeight = canvas.clientHeight * t.scale

    // Minimum gutter around document edges (visible when zoomed in)
    const gutter = 20

    // If content is smaller than container, center it
    // If content is larger, allow panning but keep gutter at edges
    if (contentWidth <= containerRect.width) {
      // Center horizontally
      t.x = (containerRect.width - contentWidth) / 2
    } else {
      // Content wider than viewport - clamp with gutter
      const minX = containerRect.width - contentWidth - gutter
      const maxX = gutter
      t.x = Math.max(minX, Math.min(maxX, t.x))
    }

    if (contentHeight <= containerRect.height) {
      // Center vertically (with slight top bias for document feel)
      const padding = Math.min(24, (containerRect.height - contentHeight) / 4)
      t.y = padding
    } else {
      // Content taller than viewport - clamp with gutter
      const minY = containerRect.height - contentHeight - gutter
      const maxY = gutter
      t.y = Math.max(minY, Math.min(maxY, t.y))
    }

    // Clamp scale
    const totalScale = renderScale * t.scale
    if (totalScale < 0.25) t.scale = 0.25 / renderScale
    if (totalScale > 3.5) t.scale = 3.5 / renderScale
  }, [renderScale])

  // Schedule a re-render at appropriate resolution after gesture ends
  const scheduleRender = useCallback(() => {
    if (gestureRef.current.renderTimeout) {
      clearTimeout(gestureRef.current.renderTimeout)
    }

    gestureRef.current.renderTimeout = setTimeout(() => {
      const t = transformRef.current
      const totalScale = renderScale * t.scale

      // If zoomed significantly, re-render at higher resolution
      // Reset transform scale to 1 and update renderScale
      if (Math.abs(t.scale - 1) > 0.1) {
        // Calculate new render scale (this is what we'll render the canvas at)
        const newRenderScale = Math.max(0.25, Math.min(3.5, totalScale))

        // The canvas will change size: newCanvasSize = oldCanvasSize * (newRenderScale / renderScale)
        // To keep the same visual, we need: newTransformScale * newCanvasSize = oldTransformScale * oldCanvasSize
        // So: newTransformScale = oldTransformScale * oldCanvasSize / newCanvasSize
        //                       = oldTransformScale * renderScale / newRenderScale
        //                       = totalScale / newRenderScale
        const newTransformScale = totalScale / newRenderScale

        // The canvas top-left stays at (t.x, t.y) in screen coords
        // But the canvas size changes, so we need to adjust x,y to keep the same content visible
        //
        // Before: a point at canvas pixel (px, py) appears at screen position (t.x + px * t.scale, t.y + py * t.scale)
        // After:  the same content is at new canvas pixel (px * newRenderScale / renderScale, py * newRenderScale / renderScale)
        //         and appears at screen position (newX + newPx * newTransformScale, newY + newPy * newTransformScale)
        //
        // For the visual to stay the same, pick any point - let's use (0,0) which is simple:
        // Before: screen pos = (t.x, t.y)
        // After:  screen pos = (newX, newY)
        // So: newX = t.x, newY = t.y (the top-left corner stays in place!)
        //
        // But wait - we also need the CENTER to stay in place for a good feel.
        // Let's keep the center of the viewport showing the same content.
        const container = documentRef.current
        const canvas = canvasRef.current
        if (container && canvas) {
          const containerRect = container.getBoundingClientRect()
          const viewCenterX = containerRect.width / 2
          const viewCenterY = containerRect.height / 2

          // Content point at view center (in current canvas pixels):
          // screenPos = t.x + canvasPx * t.scale  =>  canvasPx = (screenPos - t.x) / t.scale
          const contentPxX = (viewCenterX - t.x) / t.scale
          const contentPxY = (viewCenterY - t.y) / t.scale

          // After re-render, this content is at new canvas pixel:
          const sizeRatio = newRenderScale / renderScale
          const newContentPxX = contentPxX * sizeRatio
          const newContentPxY = contentPxY * sizeRatio

          // We want this new pixel to appear at view center:
          // viewCenterX = newX + newContentPxX * newTransformScale
          // newX = viewCenterX - newContentPxX * newTransformScale
          t.x = viewCenterX - newContentPxX * newTransformScale
          t.y = viewCenterY - newContentPxY * newTransformScale
        }

        t.scale = newTransformScale
        skipCenterRef.current = true  // Don't auto-center after this re-render
        setRenderScale(newRenderScale)
        setFitWidth(false)
      } else {
        // No re-render needed, but still save state after gesture
        saveViewerState()
      }

      updateTransform()
    }, 150)
  }, [renderScale, updateTransform, saveViewerState])

  revealLocationRef.current = (x, y) => {
    const container = documentRef.current
    if (!container) return
    const transform = transformRef.current
    transform.x = container.clientWidth / 2 - x * transform.scale
    transform.y = container.clientHeight / 2 - y * transform.scale
    clampTransform()
    updateTransform()
    saveViewerState()
  }

  useEffect(() => {
    const container = documentRef.current
    if (!container || !pdf) return

    const getPointerMid = () => {
      const pointers = Array.from(gestureRef.current.pointers.values())
      if (pointers.length < 2) return null
      return {
        x: (pointers[0].x + pointers[1].x) / 2,
        y: (pointers[0].y + pointers[1].y) / 2,
        dist: Math.hypot(pointers[1].x - pointers[0].x, pointers[1].y - pointers[0].y)
      }
    }

    const handlePointerDown = (e: PointerEvent) => {
      // Don't capture pointer if clicking on text layer spans — let the browser
      // handle text selection naturally so inverse sync can work
      const elementUnder = document.elementFromPoint(e.clientX, e.clientY)
      const isOnTextLayer = textLayerRef.current && elementUnder && textLayerRef.current.contains(elementUnder)
      if (isOnTextLayer) {
        // Text layer click — skip gesture tracking entirely to allow text selection
        return
      }
      container.setPointerCapture(e.pointerId)
      gestureRef.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      // Cache container rect on gesture start (avoids getBoundingClientRect per move)
      if (gestureRef.current.pointers.size === 1) {
        gestureRef.current.containerRect = container.getBoundingClientRect()
      }

      if (gestureRef.current.pointers.size === 2) {
        // Starting pinch gesture
        gestureRef.current.active = true
        const mid = getPointerMid()!
        gestureRef.current.prevMidX = mid.x
        gestureRef.current.prevMidY = mid.y
        gestureRef.current.prevDist = mid.dist

        // Cancel any pending render
        if (gestureRef.current.renderTimeout) {
          clearTimeout(gestureRef.current.renderTimeout)
          gestureRef.current.renderTimeout = null
        }
      }
    }

    const handlePointerMove = (e: PointerEvent) => {
      if (!gestureRef.current.pointers.has(e.pointerId)) return
      gestureRef.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      const g = gestureRef.current
      const t = transformRef.current

      if (g.pointers.size === 2 && g.active) {
        // Pinch gesture
        const mid = getPointerMid()!

        let scaleDiff = g.prevDist > 0 ? mid.dist / g.prevDist : 1
        const panX = mid.x - g.prevMidX
        const panY = mid.y - g.prevMidY

        // Clamp scaleDiff to respect zoom limits BEFORE calculating position
        // This prevents position drift when at min/max zoom
        const currentTotal = renderScale * t.scale
        const proposedTotal = currentTotal * scaleDiff
        if (proposedTotal > 3.5) {
          scaleDiff = 3.5 / currentTotal
        } else if (proposedTotal < 0.25) {
          scaleDiff = 0.25 / currentTotal
        }

        // Get origin relative to container (use cached rect for performance)
        const containerRect = g.containerRect!
        const originX = g.prevMidX - containerRect.left
        const originY = g.prevMidY - containerRect.top

        // Apply scale around origin, then pan
        // The key formula: scale around a point, then translate
        const newX = (t.x - originX) * scaleDiff + originX + panX
        const newY = (t.y - originY) * scaleDiff + originY + panY
        const newScale = t.scale * scaleDiff

        t.x = newX
        t.y = newY
        t.scale = newScale

        clampTransform(containerRect)
        updateTransform()

        g.prevMidX = mid.x
        g.prevMidY = mid.y
        g.prevDist = mid.dist
      } else if (g.pointers.size === 1) {
        // Single finger pan
        const pointer = g.pointers.values().next().value
        if (pointer) {
          const panX = e.clientX - pointer.x
          const panY = e.clientY - pointer.y

          t.x += panX
          t.y += panY

          clampTransform(g.containerRect)
          updateTransform()

          g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        }
      }
    }

    const handlePointerUp = (e: PointerEvent) => {
      gestureRef.current.pointers.delete(e.pointerId)
      try {
        container.releasePointerCapture(e.pointerId)
      } catch {
        // Ignore if capture wasn't held
      }

      if (gestureRef.current.pointers.size < 2) {
        gestureRef.current.active = false
      }

      if (gestureRef.current.pointers.size === 0) {
        // Clear cached rect when gesture ends
        gestureRef.current.containerRect = null
        // All fingers lifted - schedule re-render at appropriate resolution
        scheduleRender()
      }
    }

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const t = transformRef.current

      if (e.ctrlKey || e.metaKey) {
        // Zoom
        let scaleDiff = 1 - e.deltaY * 0.01

        // Clamp scaleDiff to respect zoom limits BEFORE calculating position
        const currentTotal = renderScale * t.scale
        const proposedTotal = currentTotal * scaleDiff
        if (proposedTotal > 3.5) {
          scaleDiff = 3.5 / currentTotal
        } else if (proposedTotal < 0.25) {
          scaleDiff = 0.25 / currentTotal
        }

        const containerRect = container.getBoundingClientRect()
        const originX = e.clientX - containerRect.left
        const originY = e.clientY - containerRect.top

        t.x = (t.x - originX) * scaleDiff + originX
        t.y = (t.y - originY) * scaleDiff + originY
        t.scale *= scaleDiff
      } else {
        // Pan
        t.x -= e.deltaX
        t.y -= e.deltaY
      }

      clampTransform()
      updateTransform()
      scheduleRender()
    }

    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('pointermove', handlePointerMove)
    container.addEventListener('pointerup', handlePointerUp)
    container.addEventListener('pointercancel', handlePointerUp)
    container.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('pointermove', handlePointerMove)
      container.removeEventListener('pointerup', handlePointerUp)
      container.removeEventListener('pointercancel', handlePointerUp)
      container.removeEventListener('wheel', handleWheel)
      if (gestureRef.current.renderTimeout) {
        clearTimeout(gestureRef.current.renderTimeout)
      }
    }
  }, [pdf, clampTransform, updateTransform, scheduleRender])

  // Search functionality - streaming approach for memory efficiency
  // Processes pages one at a time and cleans up after each to avoid loading all text content at once
  const performSearch = useCallback(async () => {
    if (!pdf || !searchQuery.trim()) {
      setSearchMatches([])
      return
    }

    // Cancel any previous search
    if (searchAbortRef.current) {
      searchAbortRef.current.abort()
    }

    const abortController = new AbortController()
    searchAbortRef.current = abortController

    const matches: SearchMatch[] = []
    const query = searchQuery.toLowerCase()

    // Process pages one at a time (streaming) to avoid memory spike
    // For 100+ page documents, loading all pages at once would use ~100MB+
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      // Check if search was cancelled (user started new search or unmounted)
      if (abortController.signal.aborted) {
        return
      }

      try {
        const page = await pdf.getPage(pageNum)
        const textContent = await readPdfText(page)

        // Check abort again after async operations
        if (abortController.signal.aborted) {
          page.cleanup()
          return
        }

        textContent.items.forEach((item, itemIndex) => {
          if (!('str' in item)) return
          const text = item.str.toLowerCase()
          let startIndex = 0

          while (true) {
            const idx = text.indexOf(query, startIndex)
            if (idx === -1) break

            matches.push({
              pageNum,
              itemIndex,
              text: item.str.substring(idx, idx + query.length),
              startIndex: idx,
              endIndex: idx + query.length,
            })

            startIndex = idx + 1
          }
        })

        // Clean up page if it's not in our render cache window
        // This prevents search from consuming memory for every page
        const cache = pageCacheRef.current
        if (!cache.has(pageNum)) {
          page.cleanup()
        }
      } catch (err) {
        // If page load fails, continue to next page
        console.warn(`Search: Failed to load page ${pageNum}:`, err)
      }
    }

    // Only update state if search wasn't cancelled
    if (!abortController.signal.aborted) {
      setSearchMatches(matches)

      // Use saved position if resuming, otherwise start at first match
      let targetIdx = 0
      if (savedMatchIndexRef.current > 0 && matches.length > 0) {
        targetIdx = Math.min(savedMatchIndexRef.current, matches.length - 1)
        savedMatchIndexRef.current = 0 // Clear after using
      }
      setCurrentMatchIndex(targetIdx)

      // Navigate to target match
      if (matches.length > 0) {
        setCurrentPage(matches[targetIdx].pageNum)
      }
    }
  }, [pdf, searchQuery])

  // Re-run search when reopening with existing query
  const wasSearchOpenRef = useRef(false)
  useEffect(() => {
    if (showSearch && !wasSearchOpenRef.current && searchQuery.trim()) {
      // Just reopened with existing query - run search (will restore saved position)
      performSearch()
    }
    wasSearchOpenRef.current = showSearch
  }, [showSearch, searchQuery, performSearch])

  // Handle search on Enter/Escape (Cmd+F handled by capture-phase global handler)
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        goToPrevMatch()
      } else {
        if (searchMatches.length === 0) {
          performSearch()
        } else {
          goToNextMatch()
        }
      }
    } else if (e.key === 'Escape') {
      savedMatchIndexRef.current = currentMatchIndex // Save position for next open
      setShowSearch(false)
      // Clear matches (removes highlights) but keep query/position for next open
      setSearchMatches([])
    }
  }

  // Navigate matches
  const goToNextMatch = () => {
    if (searchMatches.length === 0) return
    const nextIndex = (currentMatchIndex + 1) % searchMatches.length
    setCurrentMatchIndex(nextIndex)
    setCurrentPage(searchMatches[nextIndex].pageNum)
  }

  const goToPrevMatch = () => {
    if (searchMatches.length === 0) return
    const prevIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length
    setCurrentMatchIndex(prevIndex)
    setCurrentPage(searchMatches[prevIndex].pageNum)
  }

  // Navigation - reset Y to top but keep zoom
  const goToPrev = () => {
    transformRef.current.y = 24
    setCurrentPage(p => Math.max(1, p - 1))
  }
  const goToNext = () => {
    transformRef.current.y = 24
    setCurrentPage(p => Math.min(pageCount, p + 1))
  }

  const setZoomPreset = (value: number) => {
    setFitWidth(false)
    transformRef.current = { x: 0, y: 0, scale: 1 }
    setRenderScale(value)
    // Centering will happen via the renderScale change effect
    setShowZoomPresets(false)
  }

  const toggleFitWidth = async () => {
    setFitWidth(true)
    const optimalScale = await calculateFitWidth()
    if (optimalScale) {
      transformRef.current = { x: 0, y: 0, scale: 1 }
      setRenderScale(optimalScale)
      // Centering will happen via the renderScale change effect
    }
    setShowZoomPresets(false)
  }

  // Keyboard navigation - use capture phase to intercept Cmd+F before browser default handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + F to toggle search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        // If search is already open, ALWAYS handle Cmd+F to close it
        // (The user opened it via PDF, so we should close it regardless of current focus)
        if (showSearchRef.current) {
          e.preventDefault()
          e.stopPropagation()
          savedMatchIndexRef.current = currentMatchIndexRef.current // Save position for next open
          setShowSearch(false)
          // Clear matches (removes highlights) but keep query/position for next open
          setSearchMatches([])
          containerRef.current?.focus() // Return focus to PDF container
          return
        }

        // Search is closed - only open if PDF viewer has focus
        if (!containerRef.current?.contains(document.activeElement)) {
          return // Let other handlers (like editor) handle this
        }
        e.preventDefault() // Block Chrome's default find
        e.stopPropagation() // Stop event from reaching other handlers
        setShowSearch(true)
        setTimeout(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        }, 0)
        return
      }

      // Page navigation belongs to the PDF, never the source editor or an input.
      const active = document.activeElement as HTMLElement | null
      if (!active || !containerRef.current?.contains(active) || active.closest('input, textarea, [contenteditable="true"]')) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); goToPrev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); goToNext() }
    }

    // Use capture: true to intercept before browser's default Cmd+F handling
    // Note: showSearch is accessed via ref to avoid recreating this listener on every state change
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [pageCount])

  // Close zoom presets when clicking outside
  useEffect(() => {
    if (!showZoomPresets) return

    const handleClick = (e: MouseEvent) => {
      if (zoomButtonRef.current && !zoomButtonRef.current.contains(e.target as Node)) {
        setShowZoomPresets(false)
      }
    }

    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [showZoomPresets])

  return (
    <div className={`pdf-viewer ${dark ? 'pdf-dark-mode' : ''} ${compact ? 'pdf-mobile-view' : ''}`} ref={containerRef} tabIndex={-1}>
      {/* Top toolbar */}
      <div className="pdf-combined-controls">
        <div className="controls-left">
          <button
            className="control-button"
            onClick={() => {
              if (pdfDataCopyRef.current && pdfDataCopyRef.current.length > 0) {
                const blob = new Blob([pdfDataCopyRef.current], { type: 'application/pdf' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'document.pdf'
                a.click()
                URL.revokeObjectURL(url)
              } else if (pdfUrl) {
                window.open(pdfUrl, '_blank')
              }
            }}
            title="Download PDF"
          >
            <Download size={14} />
          </button>
        </div>

        <div className="controls-center">
          {pageCount > 1 && (
            <div className="control-group">
              <button
                className="control-button"
                onClick={goToPrev}
                disabled={currentPage === 1}
                title="Previous page"
              >
                <ChevronLeft size={14} />
              </button>
              <PdfPageControl className="page-info" page={currentPage} count={pageCount} onChange={page => { pendingJumpRef.current = null; setCurrentPage(page) }} />
              <button
                className="control-button"
                onClick={goToNext}
                disabled={currentPage === pageCount}
                title="Next page"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          <div className="control-separator" />

          <div className="control-group" style={{ position: 'relative' }}>
            <button
              ref={zoomButtonRef}
              className="zoom-level"
              onClick={() => setShowZoomPresets(!showZoomPresets)}
              title="Zoom presets"
            >
              {fitWidth ? 'Fit' : `${Math.round(renderScale * transformRef.current.scale * 100)}%`}
            </button>

            {showZoomPresets && (
              <div className="zoom-presets">
                <button
                  className={`zoom-preset${fitWidth ? ' active' : ''}`}
                  onClick={toggleFitWidth}
                >
                  Fit Width
                </button>
                <div className="zoom-presets-separator" />
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    className={`zoom-preset${!fitWidth && Math.abs(renderScale - preset.value) < 0.01 ? ' active' : ''}`}
                    onClick={() => setZoomPreset(preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>

        <div className="controls-right">
          <PdfThemeToggle className="control-button" />
        </div>
      </div>

      {/* Search dropdown - appears below toolbar */}
      {showSearch && (
        <div className="pdf-search-dropdown">
          <input
            ref={searchInputRef}
            type="text"
            className="pdf-search-input"
            placeholder="Find..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            autoFocus
          />
          <span className="pdf-search-count">
            {searchMatches.length > 0 ? `${currentMatchIndex + 1} of ${searchMatches.length}` : 'No results'}
          </span>
          <button className="pdf-search-btn" onClick={goToPrevMatch} title="Previous (Shift+Enter)">
            <ChevronUp size={14} />
          </button>
          <button className="pdf-search-btn" onClick={goToNextMatch} title="Next (Enter)">
            <ChevronDown size={14} />
          </button>
          <button className="pdf-search-btn" onClick={() => {
            setShowSearch(false)
            setSearchQuery('')
            setSearchMatches([])
          }} title="Close (Escape)">
            <X size={14} />
          </button>
        </div>
      )}

      {/* PDF content */}
      <div className="pdf-document" ref={documentRef}>
        {isLoading ? (
          <div className="pdf-loading">Loading PDF...</div>
        ) : error ? (
          <div className="pdf-error"><p>{error}</p><button className="pdf-retry-button" onClick={() => { setError(null); setRenderRetry(value => value + 1) }}>Retry preview</button></div>
        ) : !pdf ? (
          <div className="pdf-empty">
            {isCompiling ? (
              <span>Initializing...</span>
            ) : (
              onCompile && (
                <button
                  className="pdf-compile-button"
                  onClick={onCompile}
                >
                  Compile
                </button>
              )
            )}
          </div>
        ) : (
          <div className="pdf-page-wrapper">
            <div className={`pdf-page-filter ${dark ? 'dark' : ''}`}>
              <canvas ref={canvasRef} className="pdf-page-canvas" />
            </div>
            <div ref={textLayerRef} className="pdf-text-layer" />
            <div ref={highlightLayerRef} className="pdf-search-highlight-layer" />
            {/* SyncTeX highlight band - positioned in canvas-pixel space (pre-transform) */}
            <div
              ref={syncIndicatorRef}
              className="pdf-sync-indicator"
              style={{
                top: syncHighlight ? `${syncHighlight.y}px` : 0,
                display: syncHighlight ? 'block' : 'none',
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
})

export default PDFViewer
