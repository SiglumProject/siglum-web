/**
 * CitationPopover - Inline citation search and insertion
 *
 * Provides a popover interface for searching and inserting citations
 * at the cursor position in the editor. Integrates with Zotero through
 * CitationService.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Search, BookOpen, User, Calendar, X, Check, Loader2 } from 'lucide-react'
import citationService, { type CitationItem, type ZoteroStatus } from '../../services/CitationService'
import './CitationPopover.css'

interface CitationPopoverProps {
  isOpen: boolean
  position: { top: number; left: number }
  onClose: () => void
  onInsert: (citeKey: string, bibtex: string) => void
}

const CitationPopover: React.FC<CitationPopoverProps> = React.memo(({
  isOpen,
  position,
  onClose,
  onInsert
}) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CitationItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchTimeoutRef = useRef<number | null>(null)

  // Subscribe to Zotero status
  useEffect(() => {
    const unsubscribe = citationService.onStatus((status) => {
      setZoteroStatus(status.zotero)
    })
    return unsubscribe
  }, [])

  // Focus input when opened - show tracked citations by default
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
      setQuery('')
      setSelectedIndex(0)
      // Show tracked citations by default
      const tracked = citationService.getTrackedCitations()
      setResults(tracked)
    }
  }, [isOpen])

  // Global Escape key handler (works even when input is disabled)
  useEffect(() => {
    if (!isOpen) return

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleGlobalKeyDown)
    return () => document.removeEventListener('keydown', handleGlobalKeyDown)
  }, [isOpen, onClose])

  // Debounced search - boost tracked citations to top
  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      // Show tracked citations when query is empty
      const tracked = citationService.getTrackedCitations()
      setResults(tracked)
      return
    }

    setIsSearching(true)
    try {
      const searchResults = await citationService.search(searchQuery, 10)
      // Sort: tracked citations first, then by relevance
      const trackedKeys = new Set(citationService.getTrackedCitations().map(c => c.key))
      const sorted = [...searchResults].sort((a, b) => {
        const aTracked = trackedKeys.has(a.key)
        const bTracked = trackedKeys.has(b.key)
        if (aTracked && !bTracked) return -1
        if (!aTracked && bTracked) return 1
        return 0
      })
      setResults(sorted)
      setSelectedIndex(0)
    } catch (error) {
      console.error('Citation search failed:', error)
      setResults([])
    } finally {
      setIsSearching(false)
    }
  }, [])

  // Handle query change with debounce
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }

    if (query.trim()) {
      searchTimeoutRef.current = window.setTimeout(() => {
        performSearch(query)
      }, 200)
    } else {
      // Show tracked citations when query is empty
      const tracked = citationService.getTrackedCitations()
      setResults(tracked)
    }

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [query, performSearch])

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(prev => Math.min(prev + 1, results.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }, [results, selectedIndex, onClose])

  // Handle citation selection
  const handleSelect = useCallback(async (item: CitationItem) => {
    try {
      // Track the citation
      await citationService.trackCitation(item)

      // Get BibTeX for the item
      const bibtex = citationService.getBibtex(item)

      // Insert the citation
      onInsert(item.citeKey, bibtex)
      onClose()
    } catch (error) {
      console.error('Failed to insert citation:', error)
    }
  }, [onInsert, onClose])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && results.length > 0) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex, results.length])

  // Memoize formatted results
  const formattedResults = useMemo(() => {
    return results.map(item => ({
      ...item,
      displayCreators: item.creatorsText || 'Unknown Author',
      displayYear: item.year || 'n.d.',
      displayType: formatItemType(item.itemType)
    }))
  }, [results])

  if (!isOpen) return null

  const isConnected = zoteroStatus?.connected ?? false

  return (
    <div
      className="citation-popover"
      style={{
        top: position.top,
        left: position.left
      }}
    >
      <div className="citation-popover-header">
        <div className="citation-popover-search">
          <Search size={12} className="citation-popover-search-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isConnected ? "Search citations..." : "Connect Zotero to search"}
            disabled={!isConnected}
            className="citation-popover-input"
          />
          {isSearching && <Loader2 size={12} className="citation-popover-spinner" />}
        </div>
        <button className="citation-popover-close" onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      {!isConnected && (
        <div className="citation-popover-empty">
          <BookOpen size={18} />
          <p>Connect to Zotero to search</p>
          <span className="citation-popover-hint">Use the sidebar to connect</span>
        </div>
      )}

      {isConnected && !query && results.length === 0 && (
        <div className="citation-popover-empty">
          <Search size={18} />
          <p>No recent citations</p>
          <span className="citation-popover-hint">Start typing to search</span>
        </div>
      )}

      {isConnected && query && results.length === 0 && !isSearching && (
        <div className="citation-popover-empty">
          <BookOpen size={18} />
          <p>No results found</p>
          <span className="citation-popover-hint">Try a different search term</span>
        </div>
      )}

      {results.length > 0 && (
        <div ref={listRef} className="citation-popover-results">
          {formattedResults.map((item, index) => (
            <div
              key={item.key}
              className={`citation-popover-item ${index === selectedIndex ? 'selected' : ''}`}
              onClick={() => handleSelect(item)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div className="citation-popover-item-header">
                <span className="citation-popover-item-type">{item.displayType}</span>
                <span className="citation-popover-item-key">{item.citeKey}</span>
              </div>
              <div className="citation-popover-item-title">{item.title}</div>
              <div className="citation-popover-item-meta">
                <span className="citation-popover-item-author">
                  <User size={10} />
                  {item.displayCreators}
                </span>
                <span className="citation-popover-item-year">
                  <Calendar size={10} />
                  {item.displayYear}
                </span>
              </div>
              {index === selectedIndex && (
                <div className="citation-popover-item-action">
                  <Check size={10} />
                  <span>Insert</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="citation-popover-footer">
        <span className="citation-popover-status">
          {isConnected ? (
            <>
              <span className="citation-popover-dot connected" />
              {zoteroStatus?.itemCount ?? 0} items
            </>
          ) : (
            <>
              <span className="citation-popover-dot disconnected" />
              Not connected
            </>
          )}
        </span>
        <span className="citation-popover-shortcuts">
          <kbd>↑↓</kbd> navigate
          <kbd>↵</kbd> insert
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  return (
    prevProps.isOpen === nextProps.isOpen &&
    prevProps.position.top === nextProps.position.top &&
    prevProps.position.left === nextProps.position.left
  )
})

function formatItemType(type: string): string {
  const typeMap: Record<string, string> = {
    journalArticle: 'Article',
    book: 'Book',
    bookSection: 'Chapter',
    conferencePaper: 'Conference',
    thesis: 'Thesis',
    report: 'Report',
    webpage: 'Web',
    preprint: 'Preprint',
    manuscript: 'Manuscript',
    patent: 'Patent'
  }
  return typeMap[type] || type
}

export default CitationPopover
