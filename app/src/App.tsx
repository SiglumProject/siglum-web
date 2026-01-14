import React, { useState, useCallback, useEffect, useRef, Suspense, lazy } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import CommandPalette from './components/CommandPalette'
import LaTeXEditor from './components/LaTeXEditor/LaTeXEditor'
import EmptyState from './components/EmptyState'
import type { FileItem } from './components/ProjectSidebar'
import type { CitationItem } from './services/CitationService'

// Lazy load heavy components - only loads when needed
const PDFViewer = lazy(() => import('./components/PDFViewer'))
const DocumentationModal = lazy(() => import('./components/DocumentationModal'))
const ProjectSidebar = lazy(() => import('./components/ProjectSidebar'))
const Onboarding = lazy(() => import('./components/Onboarding/Onboarding'))
import { useDocument } from './hooks/useDocument'
import { useAutoSave } from './hooks/useAutoSave'
import { useCompilation } from './hooks/useCompilation'
import { useModals } from './hooks/useModals'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import DocumentManager from './services/DocumentManager'
import GitService from './services/GitService'
import EventBus from './services/EventBus'
import { useEventBus } from './hooks/useEventBus'
import './App.css'

// Make DocumentManager available globally in development
if (import.meta.env.DEV) {
  (window as any).DocumentManager = DocumentManager;
}

const App: React.FC = () => {
  const { currentDocument, isLoading, error, updateContent, loadDocument, createNewDocument } = useDocument()
  const [latexCode, setLatexCode] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showDesktopPreview, setShowDesktopPreview] = useState(true)
  const [isLoaded, setIsLoaded] = useState(false)
  const [touchStart, setTouchStart] = useState({ x: 0, y: 0 })
  const [sidebarExpanded, setSidebarExpanded] = useState(() => {
    const saved = localStorage.getItem('siglum-sidebar-expanded')
    return saved === 'true'
  })
  const [projectFiles, setProjectFiles] = useState<FileItem[]>(() => {
    const saved = localStorage.getItem('siglum-project-files')
    return saved ? JSON.parse(saved) : []
  })
  const [selectedFileId, setSelectedFileId] = useState<string | undefined>()
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>()
  const [showOnboarding, setShowOnboarding] = useState(() => {
    return !localStorage.getItem('siglum-onboarding-complete')
  })
  const [triggerGitConnect, setTriggerGitConnect] = useState(false)
  const [showConflictModal, setShowConflictModal] = useState(false)
  const editorPanelRef = useRef<ImperativePanelHandle>(null)
  const previewPanelRef = useRef<ImperativePanelHandle>(null)

  // Compilation state from hook
  const {
    pdfData,
    compileStatus,
    compileTimeMs,
    compilerSettings,
    setCompilerSettings,
    compile,
    compileRef,
    autoCompileRef,
    clearPendingAutoCompile,
  } = useCompilation(latexCode, isLoaded)

  // Modal state from hook
  const {
    showCommandPalette,
    isClosingCommandPalette,
    showDocumentation,
    isClosingDocumentation,
    documentationOpenedFromPalette,
    openCommandPalette,
    closeCommandPalette,
    openDocumentation,
    closeDocumentation,
    backFromDocumentation,
    setShowCommandPalette,
  } = useModals()

  // Memoized callbacks for keyboard shortcuts
  const handleCloseCurrentDocument = useCallback(async () => {
    const recentDocs = DocumentManager.getRecentDocuments()
    if (recentDocs.length > 1) {
      await loadDocument(recentDocs[1].id)
    } else {
      await createNewDocument()
    }
  }, [loadDocument, createNewDocument])

  const handleToggleSidebar = useCallback(() => {
    setSidebarExpanded(prev => !prev)
  }, [])

  const handleExpandSidebar = useCallback(() => {
    setSidebarExpanded(true)
  }, [])

  const handleCollapseSidebar = useCallback(() => {
    setSidebarExpanded(false)
  }, [])

  const handleCloseCommandPaletteModal = useCallback(() => {
    setShowCommandPalette(false)
  }, [])

  const handleOpenCommandPaletteModal = useCallback(() => {
    setShowCommandPalette(true)
  }, [])

  const handleGitConnectTriggered = useCallback(() => {
    setTriggerGitConnect(false)
  }, [])

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false)
  }, [])

  const handleConnectGithub = useCallback(() => {
    setTriggerGitConnect(true)
    setSidebarExpanded(true)
  }, [])

  // Keyboard shortcuts hook
  useKeyboardShortcuts({
    showCommandPalette,
    showDesktopPreview,
    showDocumentation,
    onOpenCommandPalette: openCommandPalette,
    onCloseCommandPalette: closeCommandPalette,
    onOpenDocumentation: openDocumentation,
    onCloseDocumentation: closeDocumentation,
    onCreateNewDocument: createNewDocument,
    onCloseCurrentDocument: handleCloseCurrentDocument,
    onToggleSidebar: handleToggleSidebar,
    onSetLatexCode: setLatexCode,
    setShowDesktopPreview,
    setShowPreview,
    editorPanelRef,
    previewPanelRef,
  })

  // Sync local state with current document and update browser title
  useEffect(() => {
    if (currentDocument) {
      setLatexCode(currentDocument.content)
      // Update browser tab title with document title
      const titlePrefix = currentDocument.title === `Untitled ${new Date().toLocaleDateString()}` 
        ? 'Untitled' 
        : currentDocument.title
      document.title = `${titlePrefix} - Siglum`
    } else {
      // Default title when no document
      document.title = 'Siglum - LaTeX Editor'
    }
  }, [currentDocument])

  // Trigger loading animation after initial render
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoaded(true)
    }, 100)
    return () => clearTimeout(timer)
  }, [])



  // Save project files to localStorage when they change
  useEffect(() => {
    localStorage.setItem('siglum-project-files', JSON.stringify(projectFiles))
  }, [projectFiles])

  // Save sidebar state to localStorage
  useEffect(() => {
    localStorage.setItem('siglum-sidebar-expanded', String(sidebarExpanded))
  }, [sidebarExpanded])

  // Subscribe to git status for remote change detection
  const hasShownRemoteModal = useRef(false)
  useEffect(() => {
    const unsubscribe = GitService.subscribeStatus((status) => {
      // Show modal when remote has changes and we haven't shown it yet this session
      if (status.behind > 0 && !showConflictModal && !hasShownRemoteModal.current) {
        hasShownRemoteModal.current = true
        setShowConflictModal(true)
      }
      // Reset the flag when we're caught up
      if (status.behind === 0) {
        hasShownRemoteModal.current = false
      }
    })
    return unsubscribe
  }, [showConflictModal])

  const handleUseRemote = useCallback(async () => {
    await GitService.forcePull()
    // Reload the current file content
    if (selectedFilePath) {
      const content = await GitService.getFileContent(selectedFilePath)
      if (content !== null) {
        setLatexCode(content)
      }
    }
    setShowConflictModal(false)
  }, [selectedFilePath])

  const handleKeepLocal = useCallback(() => {
    setShowConflictModal(false)
    // User will continue editing, conflict resolved on next push
  }, [])

  const handleFileSelect = useCallback(async (file: FileItem) => {
    // Use path if available, otherwise fall back to name (for backwards compatibility)
    const filePath = file.path || `/${file.name}`
    setSelectedFileId(file.id)
    setSelectedFilePath(filePath)

    // Load file content from GitService using the full path
    if (GitService.getStatus().isConnected) {
      const content = await GitService.readFile(filePath)
      if (content !== null) {
        setLatexCode(content)
        // Trigger immediate compile on document switch if auto-compile is enabled
        if (autoCompileRef.current) {
          // Clear any pending debounced compile
          clearPendingAutoCompile()
          // Defer compile to allow state to update
          setTimeout(() => compileRef.current(), 0)
        }
      }
    }
  }, [clearPendingAutoCompile, autoCompileRef, compileRef])

  const handleLatexCodeChange = useCallback((newContent: string) => {
    setLatexCode(newContent)
  }, [])

  // Sync editor changes to git filesystem
  useEffect(() => {
    if (selectedFilePath && GitService.getStatus().isConnected && latexCode) {
      GitService.writeFile(selectedFilePath, latexCode)
    }
  }, [latexCode, selectedFilePath])


  // Auto-save with debouncing
  const saveStatus = useAutoSave(latexCode, {
    delay: 500,
    onSave: updateContent
  })

  // Warn before closing if there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveStatus.hasUnsavedChanges || saveStatus.isSaving) {
        e.preventDefault()
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?'
        return 'You have unsaved changes. Are you sure you want to leave?'
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [saveStatus.hasUnsavedChanges, saveStatus.isSaving])

  // DocumentManager now handles search index updates automatically

  // Type-safe event subscriptions via EventBus
  useEventBus('toggleCommandPalette', () => {
    if (showCommandPalette) {
      closeCommandPalette()
    } else {
      openCommandPalette()
    }
  }, [showCommandPalette, closeCommandPalette, openCommandPalette])

  useEventBus('toggleHelp', () => {
    if (showDocumentation) {
      closeDocumentation()
    } else {
      openDocumentation(false)
    }
  }, [showDocumentation, closeDocumentation, openDocumentation])

  // Command palette handlers
  const handleSelectDocument = useCallback(async (documentId: string) => {
    await loadDocument(documentId)
  }, [loadDocument])

  const handleSelectFile = useCallback(async (filePath: string, lineNumber?: number) => {
    // Find the file in projectFiles by path
    const file = projectFiles.find(f => f.path === filePath)
    if (file) {
      await handleFileSelect(file)
      // After file loads, jump to line if specified
      if (lineNumber) {
        // Delay to let the editor update with new content
        setTimeout(() => {
          EventBus.emit('goToLine', { line: lineNumber })
        }, 100)
      }
    }
  }, [projectFiles, handleFileSelect])

  const handleCreateNewDocument = useCallback(async () => {
    await createNewDocument()
  }, [createNewDocument])

  const handleSelectCitation = useCallback((citation: CitationItem) => {
    EventBus.emit('insertText', { text: `\\cite{${citation.citeKey}}` })
  }, [])

  // Mobile swipe gestures  
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.innerWidth >= 768) return
    setTouchStart({ x: e.touches[0].clientX, y: e.touches[0].clientY })
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (window.innerWidth >= 768) return
    
    const deltaX = e.changedTouches[0].clientX - touchStart.x
    const deltaY = e.changedTouches[0].clientY - touchStart.y
    
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 100) {
      if (deltaX > 0) {
        setShowPreview(false) // Swipe right - show code
      } else {
        setShowPreview(true) // Swipe left - show preview
      }
    }
  }, [touchStart])

  // Handle text selection from editor - placeholder for future cross-highlighting
  const handleEditorSelection = useCallback((_start: number, _end: number, _selectedText: string) => {
    // Selection handling - could be used for cross-highlighting with PDF
  }, [])

  // Modal handlers for command palette integration
  const handleOpenHelp = useCallback(() => {
    openDocumentation(showCommandPalette)
  }, [openDocumentation, showCommandPalette])

  const handleCreateFromTemplate = useCallback(async (template: string) => {
    const DocumentManager = (await import('./services/DocumentManager')).default
    await DocumentManager.createNew(template)
    // Reload the current document to reflect the new creation
    const currentDoc = DocumentManager.getCurrentDocument()
    if (currentDoc) {
      await loadDocument(currentDoc.id)
    }
  }, [loadDocument])

  // Loading state with improved design
  if (isLoading) {
    return (
      <div className="app">
        <div className="main-content" style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          minHeight: '100vh',
          color: '#f5f5f7',
          fontSize: '17px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
          fontWeight: 500,
          letterSpacing: '-0.01em'
        }}>
          <div style={{ 
            textAlign: 'center',
            opacity: 0,
            transform: 'translateY(12px)',
            animation: 'fadeInUp 0.6s cubic-bezier(0.23, 1, 0.32, 1) forwards'
          }}>
            <div style={{ 
              marginBottom: '20px', 
              fontSize: '28px',
              opacity: 0.4,
              animation: 'spin 2s linear infinite'
            }}>
              ⟳
            </div>
            Initializing Siglum...
          </div>
        </div>
      </div>
    )
  }

  // Error state with better design
  if (error) {
    return (
      <div className="app">
        <div className="main-content" style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          minHeight: '100vh',
          color: '#f0f0f0',
          fontSize: '16px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ 
              marginBottom: '16px', 
              fontSize: '32px',
              color: '#ff6b6b' 
            }}>
              ⚠
            </div>
            <div style={{ color: '#ff6b6b' }}>Error: {error}</div>
            <button 
              onClick={() => window.location.reload()} 
              style={{
                marginTop: '20px',
                padding: '8px 16px',
                background: '#2a2a2a',
                color: '#f0f0f0',
                border: '1px solid #333',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Empty state for first-time users
  if (!currentDocument) {
      return (
        <div className="app">
          <CommandPalette
            isOpen={showCommandPalette}
            isClosing={isClosingCommandPalette}
            onClose={handleCloseCommandPaletteModal}
            onSelectDocument={handleSelectDocument}
            onSelectFile={handleSelectFile}
            onSelectCitation={handleSelectCitation}
            onCreateNew={handleCreateNewDocument}
            onOpenHelp={handleOpenHelp}
          />
          <EmptyState
            onOpenCommandPalette={handleOpenCommandPaletteModal}
          />
          {showDocumentation && (
            <Suspense fallback={null}>
              <DocumentationModal
                isOpen={showDocumentation}
                isClosing={isClosingDocumentation}
                onClose={closeDocumentation}
                onBack={documentationOpenedFromPalette ? backFromDocumentation : undefined}
                onCreateFromTemplate={handleCreateFromTemplate}
              />
            </Suspense>
          )}
        </div>
      )
  }

  return (
    <div 
      className="app" 
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <CommandPalette
        isOpen={showCommandPalette}
        isClosing={isClosingCommandPalette}
        onClose={handleCloseCommandPaletteModal}
        onSelectDocument={handleSelectDocument}
        onSelectFile={handleSelectFile}
        onSelectCitation={handleSelectCitation}
        onCreateNew={handleCreateNewDocument}
        onOpenHelp={handleOpenHelp}
      />
      <div className="main-content">
        {/* Desktop: Side-by-side panels */}
        <div className={`desktop-view ${isLoaded ? 'loaded' : ''}`}>
          <PanelGroup direction="horizontal" autoSaveId="editor-preview-panels">
            <Panel ref={editorPanelRef} defaultSize={showDesktopPreview ? 55 : 100} minSize={20}>
              <div className="editor-with-sidebar">
                <Suspense fallback={null}>
                  <ProjectSidebar
                    isExpanded={sidebarExpanded}
                    onToggle={handleToggleSidebar}
                    files={projectFiles}
                    onFilesChange={setProjectFiles}
                    onFileSelect={handleFileSelect}
                    selectedFileId={selectedFileId}
                    triggerGitConnect={triggerGitConnect}
                    onGitConnectTriggered={handleGitConnectTriggered}
                  />
                </Suspense>
                <LaTeXEditor
                  value={latexCode}
                  onChange={handleLatexCodeChange}
                  onSelectionChange={handleEditorSelection}
                  documentId={currentDocument?.id}
                  compilerSettings={compilerSettings}
                  onCompilerSettingsChange={setCompilerSettings}
                  compileStatus={compileStatus}
                  compileTimeMs={compileTimeMs}
                  onCompile={compile}
                />
              </div>
            </Panel>
            
            {showDesktopPreview && (
              <>
                <PanelResizeHandle className="resize-handle" />

                <Panel ref={previewPanelRef} defaultSize={45} minSize={20}>
                  <div className={`pdf-preview-panel ${isLoaded ? 'loaded' : ''}`}>
                    <Suspense fallback={<div className="pdf-loading">Loading preview...</div>}>
                      <PDFViewer pdfData={pdfData ?? undefined} onCompile={compile} isCompiling={compileStatus === 'compiling' || compileStatus === 'initializing'} />
                    </Suspense>
                  </div>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>

        {/* Mobile: Single panel view */}
        <div className={`mobile-view ${isLoaded ? 'loaded' : ''}`}>
          <Suspense fallback={null}>
            <ProjectSidebar
              isExpanded={sidebarExpanded}
              onToggle={handleToggleSidebar}
              files={projectFiles}
              onFilesChange={setProjectFiles}
              onFileSelect={handleFileSelect}
              selectedFileId={selectedFileId}
              triggerGitConnect={triggerGitConnect}
              onGitConnectTriggered={handleGitConnectTriggered}
            />
          </Suspense>
          {sidebarExpanded && (
            <div
              className="mobile-sidebar-overlay"
              onClick={handleCollapseSidebar}
            />
          )}
          {!showPreview ? (
            <LaTeXEditor
              value={latexCode}
              onChange={handleLatexCodeChange}
              onSelectionChange={handleEditorSelection}
              onMenuClick={handleExpandSidebar}
              documentId={currentDocument?.id}
              compilerSettings={compilerSettings}
              onCompilerSettingsChange={setCompilerSettings}
              compileStatus={compileStatus}
              compileTimeMs={compileTimeMs}
              onCompile={compile}
            />
          ) : (
            <div className={`pdf-preview-panel ${isLoaded ? 'loaded' : ''}`}>
              <Suspense fallback={<div className="pdf-loading">Loading preview...</div>}>
                <PDFViewer pdfData={pdfData ?? undefined} onCompile={compile} isCompiling={compileStatus === 'compiling' || compileStatus === 'initializing'} />
              </Suspense>
            </div>
          )}
        </div>
      </div>
      
      {showDocumentation && (
        <Suspense fallback={null}>
          <DocumentationModal
            isOpen={showDocumentation}
            isClosing={isClosingDocumentation}
            onClose={closeDocumentation}
            onBack={documentationOpenedFromPalette ? backFromDocumentation : undefined}
            onCreateFromTemplate={handleCreateFromTemplate}
          />
        </Suspense>
      )}
      {showOnboarding && (
        <Suspense fallback={null}>
          <Onboarding
            onComplete={handleOnboardingComplete}
            onExpandSidebar={handleExpandSidebar}
            onCollapseSidebar={handleCollapseSidebar}
            onConnectGithub={handleConnectGithub}
          />
        </Suspense>
      )}

      {showConflictModal && (
        <div className="conflict-modal-overlay">
          <div className="conflict-modal">
            <h3 className="conflict-modal-title">Remote Changes Detected</h3>
            <a
              href={`https://github.com/${GitService.getConfig()?.repoUrl}/commits`}
              target="_blank"
              rel="noopener noreferrer"
              className="conflict-modal-repo"
            >
              {GitService.getConfig()?.repoUrl}
            </a>
            <p className="conflict-modal-description">
              The remote repository has been updated since you started editing.
              You can pull the remote changes (your local edits will be lost) or
              continue editing (your changes will overwrite remote on next sync).
            </p>
            <div className="conflict-modal-actions">
              <button className="conflict-modal-btn secondary" onClick={handleKeepLocal}>
                Continue Editing
              </button>
              <button className="conflict-modal-btn primary" onClick={handleUseRemote}>
                Use Remote Version
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App