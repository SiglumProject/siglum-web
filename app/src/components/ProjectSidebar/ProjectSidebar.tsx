import React, { useState, useRef, useEffect } from 'react'
import { ChevronRight, File, FolderClosed, FolderOpen, Plus, FolderPlus, FilePlus, Trash2, X, Github, Check, RefreshCw, AlertCircle, Info } from 'lucide-react'
import type { FileItem } from '../../services/ProjectStore'
import ProjectStore from '../../services/ProjectStore'
import GitService, { type GitStatus, type GitConfig } from '../../services/GitService'
import CitationService, { type ZoteroStatus } from '../../services/CitationService'
import ZoteroIcon from '../icons/ZoteroIcon'
import './ProjectSidebar.css'

// ========================================
// Tree helpers with structural sharing (module-level for zero re-creation cost)
// Only clones nodes along the path to target, reuses unchanged subtrees
// ========================================

type IndexPath = number[]

// Optimized: Uses mutable path array, only creates final array on success
const findIndexPath = (items: FileItem[], id: string): IndexPath | null => {
  const path: number[] = []
  const search = (nodes: FileItem[]): boolean => {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) {
        path.push(i)
        return true
      }
      if (nodes[i].children) {
        path.push(i)
        if (search(nodes[i].children!)) return true
        path.pop()
      }
    }
    return false
  }
  return search(items) ? path : null
}

const getAtPath = (items: FileItem[], path: IndexPath): FileItem | null => {
  if (path.length === 0) return null
  let current: FileItem | undefined = items[path[0]]
  for (let i = 1; i < path.length && current; i++) {
    current = current.children?.[path[i]]
  }
  return current ?? null
}

const updateAtPath = (
  items: FileItem[],
  path: IndexPath,
  updater: (item: FileItem) => FileItem
): FileItem[] => {
  if (path.length === 0) return items
  const idx = path[0]
  const newItems = items.slice()
  if (path.length === 1) {
    newItems[idx] = updater(items[idx])
  } else {
    newItems[idx] = {
      ...items[idx],
      children: updateAtPath(items[idx].children || [], path.slice(1), updater)
    }
  }
  return newItems
}

const removeAtPath = (items: FileItem[], path: IndexPath): FileItem[] => {
  if (path.length === 0) return items
  const idx = path[0]
  if (path.length === 1) {
    return items.slice(0, idx).concat(items.slice(idx + 1))
  }
  const newItems = items.slice()
  newItems[idx] = {
    ...items[idx],
    children: removeAtPath(items[idx].children || [], path.slice(1))
  }
  return newItems
}

const insertAtPath = (
  items: FileItem[],
  path: IndexPath,
  newItem: FileItem
): FileItem[] => {
  if (path.length === 0) return items.concat(newItem)
  const idx = path[0]
  const newItems = items.slice()
  if (path.length === 1) {
    newItems[idx] = {
      ...items[idx],
      children: (items[idx].children || []).concat(newItem)
    }
  } else {
    newItems[idx] = {
      ...items[idx],
      children: insertAtPath(items[idx].children || [], path.slice(1), newItem)
    }
  }
  return newItems
}

const computeParentPath = (items: FileItem[], idxPath: IndexPath): string => {
  let parentPath = ''
  let current = items
  for (let i = 0; i < idxPath.length - 1; i++) {
    const name = current[idxPath[i]].name
    parentPath = parentPath ? `${parentPath}/${name}` : `/${name}`
    current = current[idxPath[i]].children || []
  }
  return parentPath
}

interface ProjectSidebarProps {
  isExpanded: boolean
  onToggle: () => void
  files: FileItem[]
  onFilesChange: (files: FileItem[]) => void
  onFileSelect?: (file: FileItem) => void
  selectedFileId?: string
  triggerGitConnect?: boolean
  onGitConnectTriggered?: () => void
}

interface FileTreeItemProps {
  item: FileItem
  depth: number
  onDelete: (id: string) => void
  onRename: (id: string, newName: string) => void
  onAddChild: (parentId: string, type: 'file' | 'folder') => void
  onSelect: (item: FileItem) => void
  onMoveItem: (itemId: string, targetFolderId: string | null) => void
  selectedId?: string
  draggedId: string | null
  onDragStart: (id: string) => void
  onDragEnd: () => void
  editingNewId?: string | null
  onEditingComplete?: () => void
}

const FileTreeItem: React.FC<FileTreeItemProps> = React.memo(({
  item,
  depth,
  onDelete,
  onRename,
  onAddChild,
  onSelect,
  onMoveItem,
  selectedId,
  draggedId,
  onDragStart,
  onDragEnd,
  editingNewId,
  onEditingComplete
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(editingNewId === item.id)
  const [editValue, setEditValue] = useState(item.name)
  const [isDragOver, setIsDragOver] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Start editing when this item is the newly created one
  useEffect(() => {
    if (editingNewId === item.id) {
      setIsEditing(true)
      setEditValue(item.name)
    }
  }, [editingNewId, item.id, item.name])

  const isFolder = item.type === 'folder'
  const isSelected = item.id === selectedId
  const isDragging = draggedId === item.id

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleEditSubmit = () => {
    if (editValue.trim() && editValue !== item.name) {
      onRename(item.id, editValue.trim())
    } else {
      setEditValue(item.name)
    }
    setIsEditing(false)
    onEditingComplete?.()
  }

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleEditSubmit()
    } else if (e.key === 'Escape') {
      setEditValue(item.name)
      setIsEditing(false)
    }
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isFolder) {
      setIsOpen(!isOpen)
    } else {
      onSelect(item)
    }
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsEditing(true)
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setShowDeleteConfirm(true)
  }

  const handleConfirmDelete = () => {
    onDelete(item.id)
    setShowDeleteConfirm(false)
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation()
    e.dataTransfer.setData('text/plain', item.id)
    e.dataTransfer.effectAllowed = 'move'
    onDragStart(item.id)
  }

  const handleDragEnd = (e: React.DragEvent) => {
    e.stopPropagation()
    onDragEnd()
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (isFolder && draggedId && draggedId !== item.id) {
      e.dataTransfer.dropEffect = 'move'
      setIsDragOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const draggedItemId = e.dataTransfer.getData('text/plain')
    if (draggedItemId && isFolder && draggedItemId !== item.id) {
      onMoveItem(draggedItemId, item.id)
      setIsOpen(true)
    }
  }

  return (
    <div className="file-tree-item">
      <div
        className={`file-tree-row ${isSelected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''} ${showDeleteConfirm ? 'delete-pending' : ''}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        draggable={!isEditing}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isFolder ? (
          <>
            <ChevronRight
              size={12}
              className={`folder-chevron ${isOpen ? 'open' : ''}`}
            />
            {isOpen ? <FolderOpen size={14} /> : <FolderClosed size={14} />}
          </>
        ) : (
          <File size={14} />
        )}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            className="file-name-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleEditSubmit}
            onKeyDown={handleEditKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="file-name">{item.name}</span>
        )}
      </div>

      {showDeleteConfirm && (
        <div className="delete-confirm" style={{ paddingLeft: `${8 + depth * 12}px` }}>
          <span>Delete?</span>
          <div className="delete-confirm-actions">
            <button className="delete-confirm-cancel" onClick={() => setShowDeleteConfirm(false)}>
              <X size={12} />
            </button>
            <button className="delete-confirm-delete" onClick={handleConfirmDelete}>
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      )}

      {isFolder && isOpen && item.children && (
        <div className="file-tree-children">
          {item.children.map(child => (
            <FileTreeItem
              key={child.id}
              item={child}
              depth={depth + 1}
              onDelete={onDelete}
              onRename={onRename}
              onAddChild={onAddChild}
              onSelect={onSelect}
              onMoveItem={onMoveItem}
              selectedId={selectedId}
              draggedId={draggedId}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              editingNewId={editingNewId}
              onEditingComplete={onEditingComplete}
            />
          ))}
        </div>
      )}
    </div>
  )
}, (prevProps, nextProps) => {
  // Custom comparison for tree item - re-render if selection, drag state, or item changes
  return (
    prevProps.item === nextProps.item &&
    prevProps.depth === nextProps.depth &&
    prevProps.selectedId === nextProps.selectedId &&
    prevProps.draggedId === nextProps.draggedId &&
    prevProps.editingNewId === nextProps.editingNewId
  )
})

const ProjectSidebar: React.FC<ProjectSidebarProps> = React.memo(({
  isExpanded,
  onToggle,
  files,
  onFilesChange,
  onFileSelect,
  selectedFileId,
  triggerGitConnect,
  onGitConnectTriggered
}) => {
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = sessionStorage.getItem('sidebarWidth')
    return saved ? parseInt(saved, 10) : 240
  })
  const isResizingRef = useRef(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [isExternalDragOver, setIsExternalDragOver] = useState(false)
  const [editingNewId, setEditingNewId] = useState<string | null>(null)
  const [showGitSetup, setShowGitSetup] = useState(false)
  const [gitStatus, setGitStatus] = useState<GitStatus>(GitService.getStatus())
  // Zotero state
  const [showZoteroSetup, setShowZoteroSetup] = useState(false)
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus>(CitationService.getZoteroStatus())
  const [zoteroUserId, setZoteroUserId] = useState('')
  const [zoteroApiKey, setZoteroApiKey] = useState('')
  const [isZoteroConnecting, setIsZoteroConnecting] = useState(false)
  const [zoteroSetupStep, setZoteroSetupStep] = useState<'connect' | 'done'>('connect')
  const zoteroUserIdInputRef = useRef<HTMLInputElement>(null)
  const [gitConfig, setGitConfig] = useState<Partial<GitConfig>>(() => {
    const saved = GitService.getConfig()
    return saved || {
      provider: 'github',
      repoUrl: '',
      branch: 'main',
      token: '',
      username: '',
      syncInterval: 'manual',
      conflictResolution: 'newest',
      autoSync: true
    }
  })
  const [setupStep, setSetupStep] = useState<'connect' | 'create-repo' | 'done'>('connect')
  const [isConnecting, setIsConnecting] = useState(false)
  const [pendingRepoName, setPendingRepoName] = useState<string>('')
  const [branchInput, setBranchInput] = useState('')
  const [isSwitchingBranch, setIsSwitchingBranch] = useState(false)
  const [showAutoPushInfo, setShowAutoPushInfo] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const gitSetupRef = useRef<HTMLDivElement>(null)
  const repoInputRef = useRef<HTMLInputElement>(null)

  // Subscribe to git status updates
  useEffect(() => {
    const unsubscribe = GitService.subscribeStatus(setGitStatus)
    return unsubscribe
  }, [])

  // Subscribe to Zotero status updates
  useEffect(() => {
    const unsubscribe = CitationService.onStatus((status) => {
      setZoteroStatus(status.zotero)
    })
    return unsubscribe
  }, [])

  // Handle trigger from onboarding
  useEffect(() => {
    if (triggerGitConnect && !gitStatus.isConnected) {
      setShowGitSetup(true)
      onGitConnectTriggered?.()
    }
  }, [triggerGitConnect, gitStatus.isConnected, onGitConnectTriggered])

  // Focus input when git setup opens
  useEffect(() => {
    if (showGitSetup && !gitStatus.isConnected && setupStep === 'connect') {
      setTimeout(() => repoInputRef.current?.focus(), 50)
    }
  }, [showGitSetup, gitStatus.isConnected, setupStep])

  // Track last files received from store to avoid redundant updates
  const lastStoreFilesRef = useRef<FileItem[] | null>(null)

  // Subscribe to ProjectStore changes (from Git sync)
  useEffect(() => {
    const unsubscribe = ProjectStore.subscribe((newFiles) => {
      // Skip if same reference as last time (common case: our own setFiles call)
      if (newFiles === lastStoreFilesRef.current) return
      lastStoreFilesRef.current = newFiles

      // Only update if store has different reference than current props
      if (newFiles !== files) {
        onFilesChange(newFiles)
      }
    })
    return unsubscribe
  }, [files, onFilesChange])

  // Sync files to ProjectStore whenever they change locally
  useEffect(() => {
    ProjectStore.setFiles(files)
  }, [files])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false)
      }
    }
    if (showAddMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showAddMenu])

  const handleGitConnect = async () => {
    if (!gitConfig.repoUrl?.trim() || !gitConfig.token?.trim()) return

    setIsConnecting(true)
    try {
      await GitService.connect(gitConfig as GitConfig)
      setSetupStep('done')
      setTimeout(() => {
        setShowGitSetup(false)
        setSetupStep('connect')
      }, 1200)
    } catch (error) {
      if (error instanceof Error && error.message === 'REPO_NOT_FOUND') {
        // Extract repo name from URL (e.g., "username/repo-name" -> "repo-name")
        const repoPath = gitConfig.repoUrl?.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '') || ''
        const repoName = repoPath.split('/').pop() || repoPath
        setPendingRepoName(repoName)
        setSetupStep('create-repo')
      } else {
        console.error('Git connect failed:', error)
      }
    } finally {
      setIsConnecting(false)
    }
  }

  const handleCreateRepo = async () => {
    if (!pendingRepoName) return

    setIsConnecting(true)
    try {
      await GitService.createRepo(pendingRepoName, true)
      setSetupStep('done')
      setTimeout(() => {
        setShowGitSetup(false)
        setSetupStep('connect')
        setPendingRepoName('')
      }, 1200)
    } catch (error) {
      console.error('Failed to create repo:', error)
    } finally {
      setIsConnecting(false)
    }
  }

  const handleGitDisconnect = async () => {
    await GitService.disconnect()
    setGitConfig({
      provider: 'github',
      repoUrl: '',
      branch: 'main',
      token: '',
      username: '',
      syncInterval: 'manual'
    })
    setSetupStep('connect')
  }

  // Zotero handlers
  const handleZoteroConnect = async () => {
    if (!zoteroUserId.trim() || !zoteroApiKey.trim()) return

    setIsZoteroConnecting(true)
    try {
      await CitationService.connectZotero(zoteroUserId.trim(), zoteroApiKey.trim())
      setZoteroSetupStep('done')
      setTimeout(() => {
        setShowZoteroSetup(false)
        setZoteroSetupStep('connect')
        setZoteroUserId('')
        setZoteroApiKey('')
      }, 1200)
    } catch (error) {
      console.error('Zotero connect failed:', error)
    } finally {
      setIsZoteroConnecting(false)
    }
  }

  const handleZoteroDisconnect = async () => {
    await CitationService.disconnectZotero()
    setZoteroSetupStep('connect')
    setZoteroUserId('')
    setZoteroApiKey('')
  }

  const handleZoteroSync = async () => {
    try {
      await CitationService.syncZotero()
    } catch (e) {
      console.error('Zotero sync failed:', e)
    }
  }

  const handleSyncNow = async () => {
    await GitService.sync()
  }

  const handleBranchSwitch = async () => {
    const currentBranch = GitService.getConfig()?.branch || 'main'
    const newBranch = branchInput.trim()

    if (!newBranch || newBranch === currentBranch) {
      setBranchInput('')
      return
    }

    setIsSwitchingBranch(true)
    try {
      await GitService.switchBranch(newBranch)
      setBranchInput('')
    } catch (error) {
      console.error('Branch switch failed:', error)
    } finally {
      setIsSwitchingBranch(false)
    }
  }

  const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  const addItem = (type: 'file' | 'folder') => {
    const newId = generateId()
    const name = type === 'folder' ? 'New Folder' : 'untitled.tex'
    const newItem: FileItem = {
      id: newId,
      name,
      path: `/${name}`,
      type,
      ...(type === 'folder' ? { children: [] } : {})
    }
    onFilesChange([...files, newItem])
    setShowAddMenu(false)
    setEditingNewId(newId)
  }

  // ========================================
  // Tree operations using structural sharing
  // ========================================

  const deleteItem = (id: string) => {
    const path = findIndexPath(files, id)
    if (!path) return
    onFilesChange(removeAtPath(files, path))
  }

  const renameItem = (id: string, newName: string) => {
    const path = findIndexPath(files, id)
    if (!path) return

    const parentPath = computeParentPath(files, path)
    const newFilePath = parentPath ? `${parentPath}/${newName}` : `/${newName}`

    onFilesChange(updateAtPath(files, path, item => ({ ...item, name: newName, path: newFilePath })))
  }

  const addChildItem = (parentId: string, type: 'file' | 'folder') => {
    const path = findIndexPath(files, parentId)
    if (!path) return

    const parent = getAtPath(files, path)
    if (!parent || parent.type !== 'folder') return

    const name = type === 'folder' ? 'New Folder' : 'untitled.tex'
    const newItem: FileItem = {
      id: generateId(),
      name,
      path: `${parent.path}/${name}`,
      type,
      ...(type === 'folder' ? { children: [] } : {})
    }

    onFilesChange(insertAtPath(files, path, newItem))
  }

  const moveItem = (itemId: string, targetFolderId: string | null) => {
    const sourcePath = findIndexPath(files, itemId)
    if (!sourcePath) return

    const itemToMove = getAtPath(files, sourcePath)
    if (!itemToMove) return

    let newFiles = removeAtPath(files, sourcePath)

    if (targetFolderId === null) {
      newFiles = [...newFiles, itemToMove]
    } else {
      const targetPath = findIndexPath(newFiles, targetFolderId)
      if (!targetPath) return

      const targetFolder = getAtPath(newFiles, targetPath)
      if (!targetFolder || targetFolder.type !== 'folder') return

      newFiles = insertAtPath(newFiles, targetPath, itemToMove)
    }

    onFilesChange(newFiles)
  }

  const handleFileSelect = (file: FileItem) => {
    if (onFileSelect && file.type === 'file') {
      onFileSelect(file)
    }
  }

  // Find first .tex file in tree
  const findFirstTexFile = (items: FileItem[]): FileItem | null => {
    for (const item of items) {
      if (item.type === 'file' && item.name.endsWith('.tex')) {
        return item
      }
      if (item.children) {
        const found = findFirstTexFile(item.children)
        if (found) return found
      }
    }
    return null
  }

  // Auto-select first .tex file when files change and none selected
  useEffect(() => {
    if (files.length > 0 && !selectedFileId && onFileSelect) {
      const firstTex = findFirstTexFile(files)
      if (firstTex) {
        onFileSelect(firstTex)
      }
    }
  }, [files, selectedFileId, onFileSelect])

  const handleExternalDragOver = (e: React.DragEvent) => {
    // Only handle external file drops, not internal reordering
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIsExternalDragOver(true)
    }
  }

  const handleExternalDragLeave = (e: React.DragEvent) => {
    // Only reset if leaving the sidebar entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsExternalDragOver(false)
    }
  }

  const handleExternalDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsExternalDragOver(false)

    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length === 0) return

    const newItems: FileItem[] = droppedFiles.map(file => ({
      id: generateId(),
      name: file.name,
      path: `/${file.name}`,
      type: 'file' as const
    }))

    onFilesChange([...files, ...newItems])
  }

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRef.current = true
    const startX = e.clientX
    const startWidth = sidebarWidth

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return
      const delta = e.clientX - startX
      const newWidth = Math.max(235, Math.min(400, startWidth + delta))
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      isResizingRef.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  // Save sidebar width when it changes
  useEffect(() => {
    sessionStorage.setItem('sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  return (
    <div
      className={`project-sidebar ${isExpanded ? 'expanded' : 'collapsed'} ${isExternalDragOver ? 'drag-over' : ''}`}
      style={isExpanded ? { width: sidebarWidth } : undefined}
      onDragOver={handleExternalDragOver}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
    >
      {isExpanded && <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />}
      {/* Collapsed state - subtle bar with chevron */}
      <div className="sidebar-collapsed-zone" onClick={onToggle}>
        <ChevronRight size={14} className="expand-icon" />
      </div>

      {/* Expanded state - full sidebar */}
      <div className="sidebar-expanded-content">
        <div className="sidebar-toolbar">
          <div className="sidebar-toolbar-left">
            <button className="sidebar-collapse-btn" onClick={onToggle} title="Collapse sidebar">
              <ChevronRight size={14} className="collapse-icon" />
            </button>
            <span className="sidebar-title">Project</span>
          </div>
          <div className="sidebar-add-wrapper" ref={addMenuRef}>
            <button
              className="sidebar-add-btn"
              title="Add file or folder"
              onClick={() => setShowAddMenu(!showAddMenu)}
            >
              <Plus size={14} />
            </button>
            {showAddMenu && (
              <div className="sidebar-add-menu">
                <button onClick={() => addItem('file')}>
                  <FilePlus size={14} />
                  New File
                </button>
                <button onClick={() => addItem('folder')}>
                  <FolderPlus size={14} />
                  New Folder
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-files">
          {files.length === 0 ? (
            <div className="sidebar-empty">
              <p>Drop files here, or</p>
              <button onClick={() => addItem('file')}>
                <FilePlus size={14} />
                Create New
              </button>
            </div>
          ) : (
            files.map(item => (
              <FileTreeItem
                key={item.id}
                item={item}
                depth={0}
                onDelete={deleteItem}
                onRename={renameItem}
                onAddChild={addChildItem}
                onSelect={handleFileSelect}
                onMoveItem={moveItem}
                selectedId={selectedFileId}
                draggedId={draggedId}
                onDragStart={setDraggedId}
                onDragEnd={() => setDraggedId(null)}
                editingNewId={editingNewId}
                onEditingComplete={() => setEditingNewId(null)}
              />
            ))
          )}
        </div>

        {/* Integrations Section - unified wrapper */}
        <div className="sidebar-integrations">
          <div className="integrations-header">Integrations</div>
          <div className="integration-items">
            {/* Git Sync */}
            <div className="sidebar-git-section" ref={gitSetupRef}>
              {gitStatus.isConnected ? (
            <div className={`git-connected-inline ${showGitSetup ? 'expanded' : ''}`}>
              <button
                className={`git-status-btn ${gitStatus.isSyncing ? 'syncing' : ''}`}
                onClick={() => setShowGitSetup(!showGitSetup)}
              >
                <div className="git-status-info">
                  <Github size={14} />
                  <span className="git-status-text">
                    {GitService.getConfig()?.repoUrl || 'repo'}
                  </span>
                </div>
                {gitStatus.isSyncing ? (
                  <RefreshCw size={12} className="git-sync-spinner" />
                ) : gitStatus.error ? (
                  <AlertCircle size={12} className="git-error-icon" />
                ) : gitStatus.behind > 0 ? (
                  <span className="git-behind-badge" title="Remote has changes">↓</span>
                ) : null}
                <ChevronRight size={12} className={`git-setup-chevron ${showGitSetup ? 'open' : ''}`} />
              </button>

              <div className="git-settings-content">
                <div className="git-settings-inner">
                  {gitStatus.error && (
                    <div className="git-error-banner">
                      {gitStatus.error}
                    </div>
                  )}

                  <div className="git-setting-row">
                    <span className="git-setting-label">Branch</span>
                    <input
                      type="text"
                      className="git-branch-input"
                      placeholder={GitService.getConfig()?.branch || 'main'}
                      value={branchInput}
                      onChange={(e) => setBranchInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleBranchSwitch()
                        } else if (e.key === 'Escape') {
                          setBranchInput('')
                          ;(e.target as HTMLInputElement).blur()
                        }
                      }}
                      onBlur={handleBranchSwitch}
                      disabled={isSwitchingBranch}
                    />
                  </div>

                  <div className="git-setting-row">
                    <div className="git-setting-label-with-info">
                      <span className="git-setting-label">Auto-push</span>
                      <button
                        className="git-info-btn"
                        onClick={() => setShowAutoPushInfo(!showAutoPushInfo)}
                        onBlur={() => setTimeout(() => setShowAutoPushInfo(false), 150)}
                      >
                        <Info size={12} />
                      </button>
                      {showAutoPushInfo && (
                        <div className="git-info-popover">
                          Automatically pushes changes every 5 minutes when enabled
                        </div>
                      )}
                    </div>
                    <button
                      className={`git-toggle ${gitConfig.autoSync ? 'active' : ''}`}
                      onClick={() => setGitConfig(prev => ({ ...prev, autoSync: !prev.autoSync }))}
                    >
                      <div className="git-toggle-knob" />
                    </button>
                  </div>

                  <div className="git-setting-row">
                    <span className="git-setting-label">On conflict</span>
                    <select
                      className="git-setting-select"
                      value={gitConfig.conflictResolution}
                      onChange={(e) => setGitConfig(prev => ({ ...prev, conflictResolution: e.target.value as GitConfig['conflictResolution'] }))}
                    >
                      <option value="newest">Keep newest</option>
                      <option value="local">Keep local</option>
                      <option value="remote">Keep remote</option>
                    </select>
                  </div>

                  {gitStatus.lastSync && !gitStatus.hasConflict && (
                    <div className="git-last-sync-info">
                      Last synced {new Date(gitStatus.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}

                  {gitStatus.hasConflict ? (
                    <div className="git-conflict-section">
                      <div className="git-conflict-message">
                        Local and remote both have changes
                      </div>
                      <div className="git-conflict-actions">
                        <button
                          className="git-conflict-btn keep-local"
                          onClick={() => GitService.forcePush()}
                          disabled={gitStatus.isSyncing}
                        >
                          Keep local
                        </button>
                        <button
                          className="git-conflict-btn keep-remote"
                          onClick={() => GitService.forcePull()}
                          disabled={gitStatus.isSyncing}
                        >
                          Keep remote
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="git-actions-row">
                      <button
                        className="git-sync-btn"
                        onClick={handleSyncNow}
                        disabled={gitStatus.isSyncing}
                      >
                        <RefreshCw size={12} className={gitStatus.isSyncing ? 'git-sync-spinner' : ''} />
                        {gitStatus.isSyncing ? 'Syncing...' : 'Sync now'}
                      </button>
                      <button className="git-disconnect-btn" onClick={handleGitDisconnect}>
                        Disconnect
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className={`git-setup-inline ${showGitSetup ? 'expanded' : ''}`}>
              <button className="git-setup-btn" onClick={() => setShowGitSetup(!showGitSetup)}>
                <Github size={14} />
                <span>Connect to GitHub</span>
                <ChevronRight size={12} className={`git-setup-chevron ${showGitSetup ? 'open' : ''}`} />
              </button>

              <div className="git-setup-content">
                {setupStep === 'connect' && (
                  <div className="git-config-form">
                    <input
                      ref={repoInputRef}
                      type="text"
                      className="git-input"
                      placeholder="username/repository"
                      value={gitConfig.repoUrl}
                      onChange={(e) => setGitConfig(prev => ({ ...prev, repoUrl: e.target.value }))}
                    />
                    <input
                      type="password"
                      className="git-input"
                      placeholder="Personal access token"
                      value={gitConfig.token}
                      onChange={(e) => setGitConfig(prev => ({ ...prev, token: e.target.value }))}
                    />
                    <a
                      href="https://github.com/settings/tokens/new?description=Siglum&scopes=repo"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="git-token-link"
                    >
                      Generate token on GitHub
                    </a>
                    <button
                      className="git-connect-btn"
                      onClick={handleGitConnect}
                      disabled={!gitConfig.repoUrl?.trim() || !gitConfig.token?.trim() || isConnecting}
                    >
                      {isConnecting ? 'Connecting...' : 'Connect'}
                    </button>
                  </div>
                )}

                {setupStep === 'create-repo' && (
                  <div className="git-create-repo">
                    <p className="git-create-repo-message">
                      Repository not found. Create it?
                    </p>
                    <div className="git-create-repo-actions">
                      <button
                        className="git-create-repo-btn secondary"
                        onClick={() => {
                          setSetupStep('connect')
                          setPendingRepoName('')
                        }}
                        disabled={isConnecting}
                      >
                        Cancel
                      </button>
                      <button
                        className="git-create-repo-btn primary"
                        onClick={handleCreateRepo}
                        disabled={isConnecting}
                      >
                        {isConnecting ? 'Creating...' : `Create ${pendingRepoName}`}
                      </button>
                    </div>
                  </div>
                )}

                {setupStep === 'done' && (
                  <div className="git-setup-done">
                    <Check size={20} className="git-check-icon" />
                    <span>Connected</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Zotero Section */}
        <div className="sidebar-zotero-section">
          {zoteroStatus.connected ? (
            <div className={`zotero-connected-inline ${showZoteroSetup ? 'expanded' : ''}`}>
              <button
                className="zotero-status-btn"
                onClick={() => setShowZoteroSetup(!showZoteroSetup)}
              >
                <div className="zotero-status-info">
                  <ZoteroIcon size={14} />
                  <span className="zotero-status-text">
                    Zotero ({zoteroStatus.itemCount} cached)
                  </span>
                </div>
                <ChevronRight size={12} className={`zotero-setup-chevron ${showZoteroSetup ? 'open' : ''}`} />
              </button>

              <div className="zotero-settings-content">
                <div className="zotero-settings-inner">
                  <div className="zotero-setting-row">
                    <span className="zotero-setting-label">User ID</span>
                    <span className="zotero-setting-value">{zoteroStatus.userId}</span>
                  </div>
                  <div className="zotero-actions-row">
                    <button
                      className="zotero-sync-btn"
                      onClick={handleZoteroSync}
                      disabled={zoteroStatus.syncing}
                    >
                      <RefreshCw size={12} className={zoteroStatus.syncing ? 'zotero-sync-spinner' : ''} />
                      {zoteroStatus.syncing ? 'Syncing...' : 'Sync now'}
                    </button>
                    <button className="zotero-disconnect-btn" onClick={handleZoteroDisconnect}>
                      Disconnect
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className={`zotero-setup-inline ${showZoteroSetup ? 'expanded' : ''}`}>
              <button className="zotero-setup-btn" onClick={() => setShowZoteroSetup(!showZoteroSetup)}>
                <ZoteroIcon size={14} />
                <span>Connect Zotero</span>
                <ChevronRight size={12} className={`zotero-setup-chevron ${showZoteroSetup ? 'open' : ''}`} />
              </button>

              <div className="zotero-setup-content">
                {zoteroSetupStep === 'connect' && (
                  <div className="zotero-config-form">
                    <input
                      ref={zoteroUserIdInputRef}
                      type="text"
                      className="zotero-input"
                      placeholder="User ID (from zotero.org/settings/keys)"
                      value={zoteroUserId}
                      onChange={(e) => setZoteroUserId(e.target.value)}
                    />
                    <input
                      type="password"
                      className="zotero-input"
                      placeholder="API Key"
                      value={zoteroApiKey}
                      onChange={(e) => setZoteroApiKey(e.target.value)}
                    />
                    <a
                      href="https://www.zotero.org/settings/keys/new"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="zotero-key-link"
                    >
                      Get API key from Zotero
                    </a>
                    <button
                      className="zotero-connect-btn"
                      onClick={handleZoteroConnect}
                      disabled={!zoteroUserId.trim() || !zoteroApiKey.trim() || isZoteroConnecting}
                    >
                      {isZoteroConnecting ? 'Connecting...' : 'Connect'}
                    </button>
                  </div>
                )}

                {zoteroSetupStep === 'done' && (
                  <div className="zotero-setup-done">
                    <Check size={20} className="zotero-check-icon" />
                    <span>Connected</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        </div>{/* integration-items */}
        </div>{/* sidebar-integrations */}
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  // Re-render only when significant props change
  return (
    prevProps.isExpanded === nextProps.isExpanded &&
    prevProps.files === nextProps.files &&
    prevProps.selectedFileId === nextProps.selectedFileId &&
    prevProps.triggerGitConnect === nextProps.triggerGitConnect
  )
})

export default ProjectSidebar
