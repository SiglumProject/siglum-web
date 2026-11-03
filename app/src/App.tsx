import React, { useState, useCallback, useEffect, useRef, Suspense, lazy } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { TriangleAlert } from 'lucide-react'
import CommandPalette from './components/CommandPalette'
import LaTeXEditor from './components/LaTeXEditor/LaTeXEditor'
import EmptyState from './components/EmptyState'
import { useIsMobile } from './hooks/useIsMobile'
import type { FileItem } from './components/ProjectSidebar'
import type { CitationItem } from './services/CitationService'

// Lazy load heavy components - only loads when needed
const MobileStudio = lazy(() => import('./components/MobileStudio/MobileStudio'))
const PDFViewer = lazy(() => import('./components/PDFViewer'))
const DocumentationModal = lazy(() => import('./components/DocumentationModal'))
const ProjectSidebar = lazy(() => import('./components/ProjectSidebar'))

import { useFileManager } from './hooks/useFileManager'
import FileReaderService from './services/FileReaderService'
import { useAutoSave } from './hooks/useAutoSave'
import { useCompilation } from './hooks/useCompilation'
import { useModals } from './hooks/useModals'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { fileManager } from './services/FileManager'
import { fileSystemWatcher } from './services/FileSystemWatcher'
import GitService from './services/GitService'
import { ToastContainer } from './components/Toast/Toast'
import { TabBar } from './components/TabBar/TabBar'
import EventBus from './services/EventBus'
import ProjectStore from './services/ProjectStore'
import StateStore from './services/FileStateStore'
import { fileSystem } from '@siglum/filesystem'
import { useEventBus } from './hooks/useEventBus'
import './App.css'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
const TEXT_EXTS = new Set([
  'tex', 'sty', 'cls', 'bib', 'bst', 'dtx', 'ins', 'def', 'cfg', 'fd',
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml',
  'log', 'aux', 'toc', 'lof', 'lot', 'bbl', 'blg', 'idx', 'ind', 'ilg',
  'sh', 'py', 'lua', 'js', 'css', 'html', 'htm', 'tikz', 'pgf',
])
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024 // 50 MB
function getExt(p: string) { return (p.split('.').pop() || '').toLowerCase() }
function isImagePath(p: string) { return IMAGE_EXTS.has(getExt(p)) }
function isTextPath(p: string) {
  const ext = getExt(p)
  return !ext || TEXT_EXTS.has(ext)
}

// Make fileManager available globally in development
if (import.meta.env.DEV) {
  (window as any).fileManager = fileManager;
  (window as any).fileSystemWatcher = fileSystemWatcher;
}

const App: React.FC = () => {
  const isMobile = useIsMobile()
  const { currentFile, fileTree, isLoading, error, openFile, createNewFile, getRecentPaths } = useFileManager()
  const [editorDraft, setEditorDraft] = useState({ path: '', content: '' })
  // Keep document identity and source coherent in the first render after a tab switch.
  const latexCode = editorDraft.path === currentFile?.path ? editorDraft.content : currentFile?.content ?? ''
  const setLatexCode = useCallback((content: string) => {
    setEditorDraft({ path: currentFile?.path ?? '', content })
  }, [currentFile?.path])
  const [showPreview, setShowPreview] = useState(false)
  const [showDesktopPreview, setShowDesktopPreview] = useState(true)
  const [isLoaded, setIsLoaded] = useState(false)
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [stateLoaded, setStateLoaded] = useState(false)

  // Image preview — tracked separately to avoid text read/autosave corruption
  const [imageFilePath, setImageFilePath] = useState<string | null>(null)
  const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)

  useEffect(() => {
    if (!imageFilePath) {
      setImageBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
      setImageError(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const stats = await fileSystem.stat(imageFilePath)
        if (cancelled) return
        if (stats.size > MAX_PREVIEW_BYTES) {
          setImageError(`File too large to preview (${(stats.size / 1024 / 1024).toFixed(0)} MB)`)
          setImageBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
          return
        }
        const data = await fileSystem.readBinary(imageFilePath, { autoDecompress: false })
        if (cancelled) return
        const ext = (imageFilePath.split('.').pop() || 'png').toLowerCase()
        const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
        const url = URL.createObjectURL(new Blob([data], { type: mime }))
        setImageBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url })
        setImageError(null)
      } catch {
        if (!cancelled) {
          setImageBlobUrl(null)
          setImageError('Failed to load image')
        }
      }
    })()
    return () => {
      cancelled = true
      setImageBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    }
  }, [imageFilePath])

  // Convert fileTree to FileItem array for sidebar compatibility
  const projectFiles = React.useMemo((): FileItem[] => {
    if (!fileTree?.children) return []
    const convert = (node: typeof fileTree): FileItem => ({
      id: node.id,
      name: node.name,
      path: node.path,
      type: node.type === 'directory' ? 'folder' : 'file',
      children: node.children?.map(convert)
    })
    return fileTree.children.map(convert)
  }, [fileTree])

  // Keep ProjectStore in sync so autocomplete/plugins can access the file list
  React.useEffect(() => {
    ProjectStore.setFiles(projectFiles)
  }, [projectFiles])

  // Current file path from fileManager
  const selectedFilePath = currentFile?.path
  // Sidebar highlights image if viewing one, otherwise the open text file
  const selectedFileId = (imageFilePath || selectedFilePath) ? `fs:${imageFilePath || selectedFilePath}` : undefined
  const [triggerGitConnect, setTriggerGitConnect] = useState(false)
  const [showConflictModal, setShowConflictModal] = useState(false)
  const [showWordCount, setShowWordCount] = useState(false)
  const [showCompileStatus, setShowCompileStatus] = useState(true)

  const editorPanelRef = useRef<ImperativePanelHandle>(null)
  const previewPanelRef = useRef<ImperativePanelHandle>(null)

  // Compilation state from hook
  const {
    pdfData,
    syncTexData,
    compileStatus,
    compileTimeMs,
    compilerSettings,
    setCompilerSettings,
    compile,
    compileRef,
    autoCompileRef,
    clearPendingAutoCompile,
    diagnostics,
  } = useCompilation(latexCode, isLoaded, currentFile?.path)

  // Modal state from hook
  const {
    showCommandPalette,
    isClosingCommandPalette,
    showDocumentation,
    isClosingDocumentation,
    documentationOpenedFromPalette,
    documentationDefaultTab,
    openCommandPalette,
    closeCommandPalette,
    openDocumentation,
    closeDocumentation,
    backFromDocumentation,
    setShowCommandPalette,
  } = useModals()

  // Memoized callbacks for keyboard shortcuts
  const handleCloseCurrentDocument = useCallback(async () => {
    const recentPaths = getRecentPaths()
    if (recentPaths.length > 1) {
      await openFile(recentPaths[1])
    } else {
      await createNewFile()
    }
  }, [openFile, createNewFile, getRecentPaths])

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

  const handleGitConnectTriggered = useCallback(() => {
    setTriggerGitConnect(false)
  }, [])

  // Tab bar state
  const tabsRef = useRef<string[]>([])
  const handleTabsChanged = useCallback((tabs: string[]) => {
    tabsRef.current = tabs
  }, [])
  const selectTabByIndex = useCallback((index: number) => {
    const tabs = tabsRef.current
    if (index < tabs.length) {
      openFile(tabs[index])
    }
  }, [openFile])

  // Keyboard shortcuts hook
  useKeyboardShortcuts({
    showCommandPalette,
    showDesktopPreview,
    showDocumentation,
    onOpenCommandPalette: openCommandPalette,
    onCloseCommandPalette: closeCommandPalette,
    onOpenDocumentation: openDocumentation,
    onCloseDocumentation: closeDocumentation,
    onCreateNewDocument: createNewFile,
    onCloseCurrentDocument: handleCloseCurrentDocument,
    onToggleSidebar: handleToggleSidebar,
    setShowDesktopPreview,
    setShowPreview,
    editorPanelRef,
    previewPanelRef,
    onSelectTabByIndex: selectTabByIndex,
  })

  // Sync local state with current file and update browser title
  useEffect(() => {
    if (currentFile) {
      setLatexCode(currentFile.content)
      // Update browser tab title with file name
      const fileName = currentFile.path.split('/').pop() || 'Untitled'
      const titlePrefix = fileName.replace(/\.tex$/, '')
      document.title = `${titlePrefix} - Siglum`
    } else {
      // Default title when no file
      document.title = 'Siglum - LaTeX Editor'
    }
  }, [currentFile])

  // Update title when viewing an image
  useEffect(() => {
    if (imageFilePath) {
      const name = imageFilePath.split('/').pop() || 'Image'
      document.title = `${name} - Siglum`
    }
  }, [imageFilePath])

  // Trigger loading animation when editor becomes visible
  const hasFile = !!currentFile
  useEffect(() => {
    if (!hasFile) {
      setIsLoaded(false)
      return
    }
    const timer = setTimeout(() => {
      setIsLoaded(true)
    }, 100)
    return () => clearTimeout(timer)
  }, [hasFile])

  // Save sidebar state to StateStore
  useEffect(() => {
    if (stateLoaded) {
      StateStore.setSidebarExpanded(sidebarExpanded)
    }
  }, [sidebarExpanded, stateLoaded])

  // Load app state on mount — raw localStorage, zero module dependencies
  useEffect(() => {
    try {
      const raw = localStorage.getItem('siglum_app_state')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed.sidebarExpanded !== undefined) setSidebarExpanded(parsed.sidebarExpanded)
        // projectFiles now comes from FileSystemWatcher, no need to load from localStorage
        if (parsed.showWordCount !== undefined) setShowWordCount(parsed.showWordCount)
        if (parsed.showCompileStatus !== undefined) setShowCompileStatus(parsed.showCompileStatus)
      }
    } catch { /* localStorage empty or corrupted — use defaults */ }
    setStateLoaded(true)
  }, [])

  // Save word count setting to StateStore when it changes
  const handleShowWordCountChange = useCallback((show: boolean) => {
    setShowWordCount(show)
    StateStore.setShowWordCount(show)
  }, [])

  // Save compile status setting to StateStore when it changes
  const handleShowCompileStatusChange = useCallback((show: boolean) => {
    setShowCompileStatus(show)
    StateStore.setShowCompileStatus(show)
  }, [])

  // Subscribe to git status - only show conflict modal for actual conflicts
  const lastSyncTimeRef = useRef<Date | null>(null)
  const latexCodeRef = useRef(latexCode)
  latexCodeRef.current = latexCode
  const selectedFilePathRef = useRef(selectedFilePath)
  selectedFilePathRef.current = selectedFilePath
  useEffect(() => {
    const unsubscribe = GitService.subscribeStatus(async (status) => {
      // Only show modal for actual conflicts (same files edited locally and remotely)
      if (status.hasConflict && status.conflictingFiles && status.conflictingFiles.length > 0) {
        setShowConflictModal(true)
      }

      // If sync happened and current file might have changed, reload it
      if (status.lastSync && lastSyncTimeRef.current !== status.lastSync && selectedFilePath) {
        lastSyncTimeRef.current = status.lastSync
        // Reload the current file in case it was updated from remote
        try {
          const content = await FileReaderService.readFile(selectedFilePath)
          // Guard: file may have switched during the async read
          if (selectedFilePathRef.current !== selectedFilePath) return
          if (content !== null && content !== latexCodeRef.current) {
            EventBus.emit('forceEditorSync')
            setLatexCode(content)
          }
        } catch {
          // File might not exist, ignore
        }
      }
    })
    return unsubscribe
  }, [selectedFilePath])

  const handleUseRemote = useCallback(async () => {
    try {
      await GitService.forcePull()
      if (selectedFilePath && selectedFilePathRef.current === selectedFilePath) {
        const content = await FileReaderService.readFile(selectedFilePath)
        if (selectedFilePathRef.current !== selectedFilePath) return
        if (content !== null) {
          EventBus.emit('forceEditorSync')
          setLatexCode(content)
        }
      }
      setShowConflictModal(false)
    } catch (error) {
      EventBus.emit('showToast', {
        type: 'error', duration: 10000,
        message: error instanceof Error ? error.message : 'Could not download the remote version. Please try again.',
      })
    }
  }, [selectedFilePath])

  const handleKeepLocal = useCallback(() => {
    setShowConflictModal(false)
    // User will continue editing, conflict resolved on next push
  }, [])

  const handleFileSelect = useCallback(async (file: FileItem) => {
    const filePath = file.path || `/${file.name}`

    if (isImagePath(filePath)) {
      setImageError(null)
      setImageFilePath(filePath)
      return
    }

    if (!isTextPath(filePath)) {
      setImageFilePath(null)
      setImageError(`Cannot preview .${getExt(filePath)} files`)
      return
    }

    setImageFilePath(null)
    setImageError(null)
    await openFile(filePath)

    if (autoCompileRef.current) {
      clearPendingAutoCompile()
      setTimeout(() => compileRef.current(), 0)
    }
  }, [openFile, clearPendingAutoCompile, autoCompileRef, compileRef])

  const handleTabClose = useCallback(async (path: string) => {
    const isActive = path === currentFile?.path
    // Evict from recents and cache
    fileManager.closeFile(path)
    if (isActive) {
      // Switch to next recent tab
      const remaining = getRecentPaths()
      if (remaining.length > 0) {
        await openFile(remaining[0])
      } else {
        await createNewFile()
      }
    }
  }, [currentFile?.path, getRecentPaths, openFile, createNewFile])

  const saveStatus = useAutoSave(fileManager.saveQueue)
  const handleLatexCodeChange = useCallback((newContent: string) => {
    setLatexCode(newContent)
    if (currentFile) {
      fileManager.stageContent(currentFile.path, newContent)
    }
  }, [currentFile])

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

  useEventBus('openIntegrations', () => {
    openDocumentation(false, 'integrations')
  }, [openDocumentation])

  // Command palette handlers
  const handleSelectFile = useCallback(async (filePath: string, lineNumber?: number) => {
    if (isImagePath(filePath)) {
      setImageError(null)
      setImageFilePath(filePath)
      return
    }
    if (!isTextPath(filePath)) {
      setImageFilePath(null)
      setImageError(`Cannot preview .${getExt(filePath)} files`)
      return
    }
    setImageFilePath(null)
    setImageError(null)
    await openFile(filePath)
    if (lineNumber) {
      setTimeout(() => {
        EventBus.emit('goToLine', { line: lineNumber })
      }, 100)
    }
  }, [openFile])

  // Handle openDocument event from outline panel (for cross-document sections)
  useEventBus('openDocument', ({ path, line }: { path: string; line?: number }) => {
    handleSelectFile(path, line)
  }, [handleSelectFile])

  const handleCreateNewDocument = useCallback(async () => {
    await createNewFile()
  }, [createNewFile])

  const handleSelectCitation = useCallback((citation: CitationItem) => {
    EventBus.emit('insertText', { text: `\\cite{${citation.citeKey}}` })
  }, [])

  // Modal handlers for command palette integration
  const handleOpenHelp = useCallback(() => {
    openDocumentation(showCommandPalette)
  }, [openDocumentation, showCommandPalette])

  const handleOpenIntegrations = useCallback(() => {
    openDocumentation(false, 'integrations')
  }, [openDocumentation])

  // Handle citation insertion - add bibtex entry to references.bib
  const handleCitationInsert = useCallback(async (citeKey: string, bibtex: string) => {
    const bibPath = '/project/src/references.bib'

    // Read existing content or start fresh
    let existingContent = ''
    try {
      if (await fileManager.exists(bibPath)) {
        existingContent = await fileManager.readFile(bibPath)
      }
    } catch {
      // File doesn't exist yet
    }

    // Check if this citation already exists (by citeKey)
    if (existingContent.includes(`@`) && existingContent.includes(`{${citeKey},`)) {
      // Citation already exists, don't duplicate
      return
    }

    // Append the new bibtex entry
    const newContent = existingContent
      ? `${existingContent.trimEnd()}\n\n${bibtex}`
      : bibtex

    // Write to filesystem - fileSystemWatcher will automatically update the tree
    await fileManager.writeFile(bibPath, newContent)
  }, [])

  const handleEditorSelection = useCallback((_start: number, _end: number, _selectedText: string) => {
    // reserved for future selection-based features
  }, [])

  // Loading state with improved design
  if (isLoading) {
    return (
      <div className="app">
        <div className="main-content app-fullscreen-state">
          <div className="app-loading-content">
            <div className="app-loading-spinner">⟳</div>
            Initializing Siglum...
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="app">
        <div className="main-content app-fullscreen-state">
          <div className="app-error-content">
            <div className="app-error-icon"><TriangleAlert size={32} aria-hidden="true" /></div>
            <div className="app-error-message">Error: {error}</div>
            <button className="app-error-reload" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Empty state for first-time users
  if (!currentFile) {
      return (
        <div className="app">
          <CommandPalette
            isOpen={showCommandPalette}
            isClosing={isClosingCommandPalette}
            onClose={handleCloseCommandPaletteModal}
            onSelectFile={handleSelectFile}
            onSelectCitation={handleSelectCitation}
            onCreateNew={handleCreateNewDocument}
            onOpenHelp={handleOpenHelp}
          />
          <EmptyState />
          {showDocumentation && (
            <Suspense fallback={null}>
              <DocumentationModal
                isOpen={showDocumentation}
                isClosing={isClosingDocumentation}
                onClose={closeDocumentation}
                onBack={documentationOpenedFromPalette ? backFromDocumentation : undefined}
                defaultTab={documentationDefaultTab}
              />
            </Suspense>
          )}
        </div>
      )
  }

  return (
    <div 
      className="app" 
    >
      <CommandPalette
        isOpen={showCommandPalette}
        isClosing={isClosingCommandPalette}
        onClose={handleCloseCommandPaletteModal}
        onSelectFile={handleSelectFile}
        onSelectCitation={handleSelectCitation}
        onCreateNew={handleCreateNewDocument}
        onOpenHelp={handleOpenHelp}
      />
      <div className="main-content">
        {/* Desktop: Side-by-side panels */}
        {!isMobile && <div className={`desktop-view ${isLoaded ? 'loaded' : ''}`}>
          <PanelGroup direction="horizontal" autoSaveId="editor-preview-panels">
            <Panel ref={editorPanelRef} defaultSize={showDesktopPreview ? 55 : 100} minSize={20}>
              <div className="editor-with-sidebar">
                <Suspense fallback={null}>
                  <ProjectSidebar
                    isExpanded={sidebarExpanded}
                    onToggle={handleToggleSidebar}
                    files={projectFiles}
                    onFileSelect={handleFileSelect}
                    selectedFileId={selectedFileId}
                    triggerGitConnect={triggerGitConnect}
                    onGitConnectTriggered={handleGitConnectTriggered}
                    onOpenIntegrations={handleOpenIntegrations}
                  />
                </Suspense>
                <div className="editor-with-tabs">
                  <TabBar
                    currentPath={currentFile?.path}
                    onTabSelect={(path) => openFile(path)}
                    onTabClose={handleTabClose}
                    onTabsChanged={handleTabsChanged}
                  />
                  {imageFilePath || imageError ? (
                    <div className="image-preview-pane">
                      {imageBlobUrl && <img src={imageBlobUrl} alt={imageFilePath?.split('/').pop()} />}
                      {imageError && <span className="image-preview-error">{imageError}</span>}
                    </div>
                  ) : (
                    <LaTeXEditor
                      value={latexCode}
                      onChange={handleLatexCodeChange}

                      documentId={currentFile?.path}
                      compilerSettings={compilerSettings}
                      onCompilerSettingsChange={setCompilerSettings}
                      compileStatus={compileStatus}
                      compileTimeMs={compileTimeMs}
                      onCompile={compile}
                      onCitationInsert={handleCitationInsert}
                      showWordCount={showWordCount}
                      onShowWordCountChange={handleShowWordCountChange}
                      showCompileStatus={showCompileStatus}
                      onShowCompileStatusChange={handleShowCompileStatusChange}
                      diagnostics={diagnostics}
                    />
                  )}
                </div>
              </div>
            </Panel>
            
            {showDesktopPreview && (
              <>
                <PanelResizeHandle className="resize-handle" />

                <Panel ref={previewPanelRef} defaultSize={45} minSize={20}>
                  <div className={`pdf-preview-panel ${isLoaded ? 'loaded' : ''}`}>
                    <Suspense fallback={<div className="pdf-loading">Loading preview...</div>}>
                      <PDFViewer pdfData={pdfData ?? undefined} syncTexData={syncTexData ?? undefined} onCompile={compile} isCompiling={compileStatus === 'compiling' || compileStatus === 'initializing'} documentId={currentFile?.path} />
                    </Suspense>
                  </div>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>}

        {/* Mobile: Single panel view */}
        {isMobile && <div className={`mobile-view ${isLoaded ? 'loaded' : ''}`}>
          <Suspense fallback={null}>
            <ProjectSidebar
              isExpanded={sidebarExpanded}
              onToggle={handleToggleSidebar}
              files={projectFiles}
              onFileSelect={handleFileSelect}
              selectedFileId={selectedFileId}
              triggerGitConnect={triggerGitConnect}
              onGitConnectTriggered={handleGitConnectTriggered}
              onOpenIntegrations={handleOpenIntegrations}
            />
          </Suspense>
          {sidebarExpanded && (
            <div
              className="mobile-sidebar-overlay"
              onClick={handleCollapseSidebar}
            />
          )}
          {imageFilePath || imageError ? (
            <div className="image-preview-pane">
              {imageBlobUrl && <img src={imageBlobUrl} alt={imageFilePath?.split('/').pop()} />}
              {imageError && <span className="image-preview-error">{imageError}</span>}
            </div>
          ) : <Suspense fallback={<div className="pdf-loading">Loading editor…</div>}><MobileStudio
            files={projectFiles}
            pdfData={pdfData}
            syncTexData={syncTexData}
            showPreview={showPreview}
            onPreviewChange={setShowPreview}
            editorProps={{
              value: latexCode,
              onChange: handleLatexCodeChange,
              onSelectionChange: handleEditorSelection,
              onMenuClick: handleExpandSidebar,
              documentId: currentFile?.path,
              compilerSettings,
              onCompilerSettingsChange: setCompilerSettings,
              compileStatus,
              compileTimeMs,
              onCompile: compile,
              onCitationInsert: handleCitationInsert,
              showWordCount,
              onShowWordCountChange: handleShowWordCountChange,
              showCompileStatus,
              onShowCompileStatusChange: handleShowCompileStatusChange,
              diagnostics,
            }}
          /></Suspense>}
        </div>}
      </div>
      
      {showDocumentation && (
        <Suspense fallback={null}>
          <DocumentationModal
            isOpen={showDocumentation}
            isClosing={isClosingDocumentation}
            onClose={closeDocumentation}
            onBack={documentationOpenedFromPalette ? backFromDocumentation : undefined}
            defaultTab={documentationDefaultTab}
          />
        </Suspense>
      )}

      {showConflictModal && (() => {
        const config = GitService.getConfig()
        const status = GitService.getStatus()
        const repoPath = config?.repoUrl?.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
        const currentBranch = config?.branch
        const isSameBranch = status.conflictSource === 'same-branch'
        const otherBranch = !isSameBranch ? status.conflictSource : undefined
        const canShowCompare = config?.provider === 'github' && repoPath && otherBranch && currentBranch

        return (
          <div className="conflict-modal-overlay">
            <div className="conflict-modal">
              <h3 className="conflict-modal-title">Conflicting Changes</h3>
              {repoPath && (
                <a
                  href={`https://github.com/${repoPath}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="conflict-modal-repo"
                >
                  {repoPath}
                </a>
              )}
              {status.conflictingFiles && (
                <ul className="conflict-modal-files">
                  {status.conflictingFiles.map(file => (
                    <li key={file.path}>
                      <span className="conflict-file-name">{file.path}</span>
                      {file.linesChanged !== undefined && (
                        <span className="conflict-file-lines">
                          {file.linesChanged} {file.linesChanged === 1 ? 'line' : 'lines'} different
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="conflict-modal-description">
                This version and the GitHub version are different.
              </p>
              {canShowCompare && (
                <a
                  href={`https://github.com/${repoPath}/compare/${otherBranch}...${currentBranch}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="conflict-modal-compare-link"
                >
                  Compare on GitHub →
                </a>
              )}
              <div className="conflict-modal-actions">
                <button className="conflict-modal-btn secondary" onClick={handleKeepLocal}>
                  Keep This Version
                </button>
                <button className="conflict-modal-btn primary" onClick={handleUseRemote}>
                  Use Latest from GitHub
                </button>
              </div>
            </div>
          </div>
        )
      })()}
      <ToastContainer />
    </div>
  )
}

export default App