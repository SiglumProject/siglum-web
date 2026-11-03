import React, { useState, useEffect, useCallback, useRef, useDeferredValue } from 'react'
import { Search, Plus, RotateCw, HelpCircle, File, BookOpen } from 'lucide-react'
import ProjectSearcher from '../services/ProjectSearcher'
import type { FileSearchResult } from '../services/ProjectSearcher'
import citationService, { type CitationItem } from '../services/CitationService'
import './CommandPalette.css'

interface CommandPaletteProps {
  isOpen: boolean
  isClosing?: boolean
  onClose: () => void
  onSelectFile?: (filePath: string, lineNumber?: number) => void
  onSelectCitation?: (citation: CitationItem) => void
  onCreateNew: () => void
  onOpenHelp?: () => void
}

interface Command {
  id: string
  title: string
  subtitle?: string
  icon: React.ReactNode
  action: () => void
  category?: 'action' | 'navigation'
  shortcut?: string
}

const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  isClosing = false,
  onClose,
  onSelectFile,
  onSelectCitation,
  onCreateNew,
  onOpenHelp
}) => {
  const [query, setQuery] = useState('')
  // useDeferredValue keeps the input responsive while search runs
  // React can interrupt low-priority deferred work if typing continues
  const deferredQuery = useDeferredValue(query)
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [citationResults, setCitationResults] = useState<CitationItem[]>([])
  const [commands, setCommands] = useState<Command[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [internalClosing, setInternalClosing] = useState(false)
  const searchRequestRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Total selectable items count
  const totalItems = commands.length + citationResults.length + fileResults.length

  // Get all available commands
  const getDefaultCommands = useCallback((): Command[] => {
    const commands: Command[] = [
      {
        id: 'new-document',
        title: 'New Document',
        icon: <Plus size={16} />,
        category: 'action',
        action: () => {
          onCreateNew()
          onClose()
        }
      }
    ]

    // Add help command if handler provided
    if (onOpenHelp) {
      commands.push({
        id: 'help',
        title: 'Help',
        subtitle: 'Documentation, guides, and templates',
        icon: <HelpCircle size={16} />,
        category: 'navigation',
        action: () => {
          onOpenHelp()
          onClose()
        }
      })
    }

    return commands
  }, [onCreateNew, onClose, onOpenHelp])

  // Natural language intent detection
  const detectIntent = useCallback((query: string) => {
    const lowerQuery = query.toLowerCase().trim()
    const allCommands = getDefaultCommands()
    
    // Intent keywords mapping
    const intentMap = {
      // Creation intents
      create: ['create', 'new', 'make', 'start', 'begin', 'add'],
      help: ['help', 'docs', 'guide', 'documentation', 'tutorial', 'how', 'what', 'info', 'template', 'example', 'sample', 'starter'],

      // Direct command matching
      exact: allCommands.map(cmd => ({
        command: cmd,
        triggers: [
          cmd.title.toLowerCase(),
          ...(cmd.subtitle ? [cmd.subtitle.toLowerCase()] : [])
        ]
      }))
    }

    // Check for intent keywords
    const relevantCommands = []

    // Direct exact matches first
    for (const { command, triggers } of intentMap.exact) {
      if (triggers.some(trigger =>
        trigger.includes(lowerQuery) || lowerQuery.includes(trigger)
      )) {
        relevantCommands.push(command)
      }
    }

    // Intent-based matching
    if (intentMap.create.some(word => lowerQuery.includes(word))) {
      const newDocCmd = allCommands.find(cmd => cmd.id === 'new-document')
      if (newDocCmd && !relevantCommands.includes(newDocCmd)) {
        relevantCommands.push(newDocCmd)
      }
    }

    if (intentMap.help.some(word => lowerQuery.includes(word))) {
      const helpCmd = allCommands.find(cmd => cmd.id === 'help')
      if (helpCmd && !relevantCommands.includes(helpCmd)) {
        relevantCommands.push(helpCmd)
      }
    }

    return relevantCommands
  }, [getDefaultCommands])

  // Search for files and commands with smart context
  const performSearch = useCallback(async (searchQuery: string) => {
    const requestId = ++searchRequestRef.current
    if (!searchQuery.trim()) {
      // Empty state: show recent project files
      const recentFiles = await ProjectSearcher.search('', { maxResults: 8 })
      if (requestId !== searchRequestRef.current) return
      setIsSearching(false)
      setCommands([])
      setFileResults(recentFiles)
      setCitationResults([])
      return
    }

    setIsSearching(true)
    try {
      // Search for project files and citations in parallel
      const [projectFileResults, citations] = await Promise.all([
        ProjectSearcher.search(searchQuery, {
          maxResults: 10,
          searchContent: true
        }),
        citationService.isZoteroConnected()
          ? citationService.search(searchQuery, 5)
          : Promise.resolve([])
      ])

      if (requestId !== searchRequestRef.current) return

      // Use natural language intent detection
      const intentBasedCommands = detectIntent(searchQuery)

      setFileResults(projectFileResults)
      setCitationResults(citations)
      setCommands(intentBasedCommands)
    } catch (error) {
      if (requestId !== searchRequestRef.current) return
      console.error('Search error:', error)
      setFileResults([])
      setCitationResults([])
      setCommands([])
    } finally {
      if (requestId === searchRequestRef.current) setIsSearching(false)
    }
  }, [detectIntent])

  // Search triggered by deferred query (keeps input responsive)
  // The 150ms timeout is still useful for very fast typing
  useEffect(() => {
    if (!isOpen) return
    ++searchRequestRef.current
    const timeoutId = setTimeout(() => {
      performSearch(deferredQuery)
    }, 100) // Reduced since useDeferredValue already provides debouncing

    return () => { clearTimeout(timeoutId); ++searchRequestRef.current }
  }, [isOpen, deferredQuery, performSearch])

  // Handle close with animation (for internal triggers like ESC, overlay click)
  const handleClose = useCallback(() => {
    setInternalClosing(true)
    setTimeout(() => {
      setInternalClosing(false)
      onClose()
    }, 200) // Match animation duration
  }, [onClose])

  // Combined closing state - either external or internal
  const isCurrentlyClosing = isClosing || internalClosing

  // Reset when opening/closing
  useEffect(() => {
    if (isOpen) {
      setInternalClosing(false)
      setQuery('')
      setSelectedIndex(0)
      performSearch('')
      // Focus input after a brief delay to ensure it's rendered
      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
    }
  }, [isOpen, performSearch])

  // Update selected index when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [fileResults, citationResults, commands])

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault()
          handleClose()
          break

        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => totalItems ? (prev + 1) % totalItems : 0)
          break

        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => totalItems ? (prev - 1 + totalItems) % totalItems : 0)
          break

        case 'Enter':
          e.preventDefault()
          handleItemClick(selectedIndex)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedIndex, totalItems, handleClose, onSelectFile, onSelectCitation])

  // Scroll selected item into view - using 'instant' to avoid jank
  // CSS scroll-margin handles the padding, so no layout thrashing
  useEffect(() => {
    if (listRef.current) {
      const selectableItems = listRef.current.querySelectorAll('[data-selectable-index]')
      const selectedElement = selectableItems[selectedIndex] as HTMLElement
      if (selectedElement) {
        selectedElement.scrollIntoView({
          block: 'nearest',
          behavior: 'instant'
        })
      }
    }
  }, [selectedIndex])

  const handleItemClick = (index: number) => {
    if (index < commands.length) {
      // Command item clicked
      if (commands[index]) {
        commands[index].action()
      }
    } else if (index < commands.length + citationResults.length) {
      // Citation item clicked
      const citationIndex = index - commands.length
      const citation = citationResults[citationIndex]
      if (citation && onSelectCitation) {
        onSelectCitation(citation)
        handleClose()
      }
    } else {
      // Project file item clicked
      const fileIndex = index - commands.length - citationResults.length
      const result = fileResults[fileIndex]
      if (result && onSelectFile) {
        onSelectFile(result.file.path, result.lineNumber)
        handleClose()
      }
    }
  }

  if (!isOpen) return null

  return (
    <div className={`command-palette-overlay ${isCurrentlyClosing ? 'closing' : ''}`} onClick={handleClose}>
      <div className="command-palette-container">
        {/* Main Command Palette */}
        <div className={`command-palette-glow ${isCurrentlyClosing ? 'closing' : ''}`}>
        <div className={`command-palette ${isCurrentlyClosing ? 'closing' : ''}`} onClick={e => e.stopPropagation()}>
          <div className="command-palette-header">
            <div className="search-icon">
              <Search size={16} />
            </div>
            <input
              ref={inputRef}
              type="text"
              placeholder={query ? "Search or type a command..." : "Search documents or type a command..."}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="command-palette-input"
            />
            <div className="command-palette-hint">
              <kbd>↑</kbd><kbd>↓</kbd> navigate • <kbd>↵</kbd> select • <kbd>esc</kbd> close
            </div>
          </div>
          
          <div className="command-palette-results" ref={listRef}>
            {isSearching && (
              <div className="command-palette-loading">
                <div className="loading-spinner">
                  <RotateCw size={16} />
                </div>
                Searching...
              </div>
            )}

            {!isSearching && (
              <>
                {/* Commands Section - shown when searching */}
                {commands.length > 0 && (
                  <div className="commands-section">
                    <div className="section-header">Commands</div>
                    {commands.map((command, index) => {
                      const itemIndex = index
                      return (
                        <div
                          key={command.id}
                          data-selectable-index={itemIndex}
                          className={`command-palette-item command-item ${itemIndex === selectedIndex ? 'selected' : ''}`}
                          onClick={() => handleItemClick(itemIndex)}
                        >
                          <div className="item-icon">{command.icon}</div>
                          <div className="item-content">
                            <div className="item-title">{command.title}</div>
                            {command.subtitle && (
                              <div className="item-subtitle">{command.subtitle}</div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Citations Section */}
                {citationResults.length > 0 && (
                  <div className="citations-section">
                    <div className="section-header">Citations</div>
                    {citationResults.map((citation, index) => {
                      const itemIndex = commands.length + index
                      return (
                        <div
                          key={citation.key}
                          data-selectable-index={itemIndex}
                          className={`command-palette-item citation-item ${itemIndex === selectedIndex ? 'selected' : ''}`}
                          onClick={() => handleItemClick(itemIndex)}
                        >
                          <div className="item-icon">
                            <BookOpen size={16} />
                          </div>
                          <div className="item-content">
                            <div className="item-title">{citation.title}</div>
                            <div className="item-subtitle">
                              {citation.creatorsText}{citation.year ? ` (${citation.year})` : ''} · {citation.citeKey}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Project Files Section */}
                {fileResults.length > 0 && (
                  <div className="files-section">
                    <div className="section-header">{query ? 'Files' : 'Project files'}</div>
                    {fileResults.map((result, index) => {
                      const itemIndex = commands.length + citationResults.length + index
                      return (
                        <div
                          key={result.file.path}
                          data-selectable-index={itemIndex}
                          className={`command-palette-item file-item ${itemIndex === selectedIndex ? 'selected' : ''}`}
                          onClick={() => handleItemClick(itemIndex)}
                        >
                          <div className="item-icon">
                            <File size={16} />
                          </div>
                          <div className="item-content">
                            <div className="item-title">{result.file.name}</div>
                            <div className="item-subtitle">
                              {result.matchType === 'content' && result.lineNumber
                                ? `Line ${result.lineNumber}`
                                : result.file.path.replace('/project/src/', '')}
                            </div>
                            {result.snippet && (
                              <div className="item-snippet">{result.snippet}</div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Empty State */}
                {fileResults.length === 0 && citationResults.length === 0 && commands.length === 0 && (
                  <div className="command-palette-empty">
                    {query ? (
                      <div className="empty-with-suggestion">
                        <div className="empty-message">No results for "{query}"</div>
                        <div className="empty-suggestion">
                          Try "new" or "help"
                        </div>
                      </div>
                    ) : (
                      <div className="empty-welcome">
                        <div className="empty-message">No files yet</div>
                        <div className="empty-suggestion">
                          Type "new" to create a file
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

export default CommandPalette