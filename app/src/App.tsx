import React, { useState, useCallback, useEffect, useRef, Suspense, lazy } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { ChevronLeft, TriangleAlert } from 'lucide-react'
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
import GitConflictModal from './components/GitConflictModal'
import type { GitConflictResolution } from '@siglum/git'
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
const PREVIEW_WIDTH_KEY = 'siglum-desktop-preview-width'
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
  const {
    currentFile, fileTree, isLoading, error, failedRestorePath, dismissFailedRestore,
    openFile, createNewFile, createRecoveryDocument, getRecentPaths,
  } = useFileManager()
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
  const [gitBusy, setGitBusy] = useState(false)
  const reviewedFiles = useRef<ReturnType<typeof GitService.getStatus>['conflictingFiles']>()
  const [showWordCount, setShowWordCount] = useState(false)
  const [showCompileStatus, setShowCompileStatus] = useState(true)

  const editorPanelRef = useRef<ImperativePanelHandle>(null)
  const previewPanelRef = useRef<ImperativePanelHandle>(null)
  const previewDragStart = useRef(0)
  const previewRestoreWidth = useRef(0)
  const rememberPreviewWidth = useCallback((width: number) => {
    previewRestoreWidth.current = width
    try { localStorage.setItem(PREVIEW_WIDTH_KEY, String(width)) } catch { /* Storage may be restricted. */ }
  }, [])
  const setDesktopPreview = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(next => {
    const panel = previewPanelRef.current
    if (!panel) return
    const isVisible = !panel.isCollapsed()
    const visible = typeof next === 'function' ? next(isVisible) : next
    if (visible === isVisible) return
    if (visible) {
      let width = previewRestoreWidth.current
      try { width ||= Number(localStorage.getItem(PREVIEW_WIDTH_KEY)) } catch { /* Use the in-memory width. */ }
      if (width >= 20 && width <= 80) panel.resize(width)
      else panel.expand()
    } else {
      rememberPreviewWidth(panel.getSize())
      panel.collapse()
    }
  }, [rememberPreviewWidth])

  // Compilation state from hook
  const {
    paragraphPatch,
    onParagraphFailure,
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
  } = useCompilation(latexCode, isLoaded, currentFile?.path, !isMobile && showDesktopPreview)

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
    enabled: !error,
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
    setShowDesktopPreview: setDesktopPreview,
    setShowPreview,
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
      setGitBusy(status.isSyncing)
      if (!status.isSyncing && status.hasConflict && status.conflictingFiles?.length && reviewedFiles.current !== status.conflictingFiles) {
        reviewedFiles.current = status.conflictingFiles
        setShowConflictModal(true)
      } else if (!status.conflictingFiles?.length) {
        reviewedFiles.current = undefined
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

  const loadConflict = useCallback(() => GitService.getConflictReview(), [])
  const closeConflict = useCallback(() => setShowConflictModal(false), [])
  const applyConflict = useCallback(async (id: string, choices: GitConflictResolution[]) => {
    await GitService.applyConflictResolution(id, choices)
    const current = fileManager.getCurrentFile()
    await fileManager.refreshOpenGitFiles().catch(error => {
      EventBus.emit('showToast', {
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not refresh open files.',
      })
    })
    const refreshed = fileManager.getCurrentFile()
    if (current && refreshed?.path === current.path && refreshed.content !== latexCodeRef.current) {
      EventBus.emit('forceEditorSync')
      setLatexCode(refreshed.content)
    }
  }, [setLatexCode])

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
    if (!await openFile(filePath)) return

    if (autoCompileRef.current) {
      clearPendingAutoCompile()
      setTimeout(() => compileRef.current(), 0)
    }
  }, [openFile, clearPendingAutoCompile, autoCompileRef, compileRef])

  const handleTabClose = useCallback(async (path: string) => {
    if (path !== currentFile?.path) {
      fileManager.closeFile(path)
      return
    }

    const nextPath = getRecentPaths().find(recentPath => recentPath !== path)
    if (nextPath) {
      if (await openFile(nextPath)) fileManager.closeFile(path)
    } else {
      await createNewFile()
      if (fileManager.getCurrentPath() !== path) fileManager.closeFile(path)
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
    if (!await openFile(filePath)) return
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
    const recoveryFiles = failedRestorePath
      ? fileSystemWatcher.getFilesByExtension('tex').filter(file => file.path !== failedRestorePath)
      : []
    return (
      <div className="app">
        <div className="main-content app-fullscreen-state">
          <div className="app-error-content">
            <div className="app-error-icon"><TriangleAlert size={32} aria-hidden="true" /></div>
            <div className="app-error-message">Error: {error}</div>
            <div className="app-error-actions">
              <button type="button" className="app-error-reload" onClick={() => window.location.reload()}>
                Reload
              </button>
              {failedRestorePath && (
                <button type="button" className="app-error-reload" onClick={createRecoveryDocument}>
                  New document
                </button>
              )}
              {failedRestorePath && <button type="button" className="app-error-reload" onClick={dismissFailedRestore}>
                Continue without this tab
              </button>}
            </div>
            {recoveryFiles.length > 0 && (
              <details className="app-error-files">
                <summary>Choose another file</summary>
                <ul>
                  {recoveryFiles.map(file => (
                    <li key={file.path}>
                      <button type="button" className="app-error-reload" title={file.path} onClick={() => openFile(file.path)}>
                        {file.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
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
            <Panel id="editor" order={1} ref={editorPanelRef} defaultSize={55} minSize={20}>
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
            
            <PanelResizeHandle
              className="resize-handle"
              aria-label="Resize PDF preview"
              onDragging={dragging => {
                if (dragging) previewDragStart.current = previewPanelRef.current?.getSize() ?? 0
                else previewDragStart.current = 0
              }}
            />
            <Panel
              id="preview"
              order={2}
              ref={previewPanelRef}
              defaultSize={45}
              minSize={20}
              collapsible
              onCollapse={() => {
                if (previewDragStart.current > 0) rememberPreviewWidth(previewDragStart.current)
                setShowDesktopPreview(false)
              }}
              onExpand={() => setShowDesktopPreview(true)}
            >
              <div className={`pdf-preview-panel ${isLoaded ? 'loaded' : ''}`} hidden={!showDesktopPreview}>
                <Suspense fallback={<div className="pdf-loading">Loading preview...</div>}>
                  <PDFViewer paragraphPatch={paragraphPatch} onParagraphFailure={onParagraphFailure} pdfData={pdfData ?? undefined} syncTexData={syncTexData ?? undefined} onCompile={compile} isCompiling={compileStatus === 'compiling' || compileStatus === 'initializing'} documentId={currentFile?.path} />
                </Suspense>
              </div>
            </Panel>
          </PanelGroup>
          {!showDesktopPreview && (
            <button
              type="button"
              className="desktop-preview-rail"
              aria-label="Show PDF preview"
              title="Show PDF preview"
              onClick={() => setDesktopPreview(true)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
          )}
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

      {showConflictModal && (
        <GitConflictModal
          repoUrl={GitService.getConfig()?.repoUrl}
          loadReview={loadConflict}
          onApply={applyConflict}
          onClose={closeConflict}
          busy={gitBusy}
        />
      )}
      <ToastContainer />
    </div>
  )
}

export default App
