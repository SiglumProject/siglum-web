import React, { useState, useRef, useEffect } from 'react'
import { ChevronRight, File, FolderClosed, FolderOpen, Plus, FolderPlus, FilePlus, Image, Trash2, RefreshCw, Plug } from 'lucide-react'
import type { FileItem } from '../../services/ProjectStore'
import { fileManager } from '../../services/FileManager'
import { fileSystem } from '@siglum/filesystem'
import { fileSystemWatcher } from '../../services/FileSystemWatcher'
import GitService, { type GitStatus } from '../../services/GitService'
import CitationService, { type ZoteroStatus } from '../../services/CitationService'
import EventBus from '../../services/EventBus'
import './ProjectSidebar.css'

// ========================================
// Tree helpers with structural sharing (module-level for zero re-creation cost)
// Only clones nodes along the path to target, reuses unchanged subtrees
// ========================================

type IndexPath = number[]

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

interface ProjectSidebarProps {
  isExpanded: boolean
  onToggle: () => void
  files: FileItem[]
  onFileSelect?: (file: FileItem) => void
  selectedFileId?: string
  triggerGitConnect?: boolean
  onGitConnectTriggered?: () => void
  onOpenIntegrations?: () => void
}

interface FileTreeItemProps {
  item: FileItem
  depth: number
  onRename: (id: string, newName: string) => void
  onAddChild: (parentId: string, type: 'file' | 'folder') => void
  onSelect: (item: FileItem) => void
  onMoveItem: (itemId: string, targetFolderId: string | null) => void
  onContextMenu: (itemId: string, e: React.MouseEvent) => void
  selectedId?: string
  draggedId: string | null
  onDragStart: (id: string) => void
  onDragEnd: () => void
  editingNewId?: string | null
  onEditingComplete?: () => void
  newFileIds?: Set<string>
}

const FileTreeItem: React.FC<FileTreeItemProps> = React.memo(({
  item,
  depth,
  onRename,
  onAddChild,
  onSelect,
  onMoveItem,
  onContextMenu,
  selectedId,
  draggedId,
  onDragStart,
  onDragEnd,
  editingNewId,
  onEditingComplete,
  newFileIds
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(editingNewId === item.id)
  const [editValue, setEditValue] = useState(item.name)
  const [isDragOver, setIsDragOver] = useState(false)
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
      const dot = editValue.lastIndexOf('.')
      if (dot > 0) {
        inputRef.current.setSelectionRange(0, dot)
      } else {
        inputRef.current.select()
      }
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
    onContextMenu(item.id, e)
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
        className={`file-tree-row ${isSelected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}${newFileIds?.has(item.id) ? ' file-tree-row-enter' : ''}`}
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

      {isFolder && isOpen && item.children && (
        <div className="file-tree-children">
          {item.children.map(child => (
            <FileTreeItem
              key={child.id}
              item={child}
              depth={depth + 1}
              onRename={onRename}
              onAddChild={onAddChild}
              onSelect={onSelect}
              onMoveItem={onMoveItem}
              onContextMenu={onContextMenu}
              selectedId={selectedId}
              draggedId={draggedId}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              editingNewId={editingNewId}
              onEditingComplete={onEditingComplete}
              newFileIds={newFileIds}
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
    prevProps.editingNewId === nextProps.editingNewId &&
    prevProps.newFileIds === nextProps.newFileIds
  )
})

const ProjectSidebar: React.FC<ProjectSidebarProps> = React.memo(({
  isExpanded,
  onToggle,
  files,
  onFileSelect,
  selectedFileId,
  triggerGitConnect,
  onGitConnectTriggered,
  onOpenIntegrations
}) => {
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; itemId?: string
  } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = sessionStorage.getItem('sidebarWidth')
    return saved ? parseInt(saved, 10) : 240
  })
  const isResizingRef = useRef(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [isExternalDragOver, setIsExternalDragOver] = useState(false)
  const [editingNewId, setEditingNewId] = useState<string | null>(null)
  const [newFileIds, setNewFileIds] = useState<Set<string>>(new Set())
  const prevFileIdsRef = useRef<Set<string> | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus>(GitService.getStatus())
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus>(CitationService.getZoteroStatus())
  const addMenuRef = useRef<HTMLDivElement>(null)

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

  // Handle trigger to open integrations modal
  useEffect(() => {
    if (triggerGitConnect && !gitStatus.isConnected) {
      onOpenIntegrations?.()
      onGitConnectTriggered?.()
    }
  }, [triggerGitConnect, gitStatus.isConnected, onGitConnectTriggered, onOpenIntegrations])

  // Detect newly added files for enter animation
  useEffect(() => {
    const collectIds = (items: FileItem[]): Set<string> => {
      const ids = new Set<string>()
      for (const item of items) {
        ids.add(item.id)
        if (item.children) for (const id of collectIds(item.children)) ids.add(id)
      }
      return ids
    }
    const currentIds = collectIds(files)
    if (prevFileIdsRef.current) {
      const added = new Set<string>()
      for (const id of currentIds) {
        if (!prevFileIdsRef.current.has(id)) added.add(id)
      }
      if (added.size > 0) {
        setNewFileIds(added)
        setTimeout(() => setNewFileIds(new Set()), 300)
      }
    }
    prevFileIdsRef.current = currentIds
  }, [files])

  // Files now come from FileSystemWatcher via App.tsx
  // No need for ProjectStore subscriptions

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

  // Dismiss context menu on click-away or scroll
  // Defer listener registration so the opening event finishes propagating first
  useEffect(() => {
    if (!contextMenu) return
    const dismiss = () => setContextMenu(null)
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', dismiss)
      document.addEventListener('contextmenu', dismiss)
      document.addEventListener('scroll', dismiss, true)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('contextmenu', dismiss)
      document.removeEventListener('scroll', dismiss, true)
    }
  }, [contextMenu])

  const handleFilesContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleItemContextMenu = (itemId: string, e: React.MouseEvent) => {
    setContextMenu({ x: e.clientX, y: e.clientY, itemId })
  }

  // Quick sync handlers
  const handleZoteroSync = async () => {
    try {
      await CitationService.syncZotero()
    } catch (e) {
      console.error('Zotero sync failed:', e)
    }
  }

  const handleSyncNow = async () => {
    try {
      await GitService.sync()
      EventBus.emit('showToast', { message: 'Synced with GitHub', type: 'success' })
    } catch {
      EventBus.emit('showToast', { message: 'Sync failed', type: 'error' })
    }
  }

  const addItem = async (type: 'file' | 'folder') => {
    const name = type === 'folder' ? 'New Folder' : 'untitled.tex'
    const projectRoot = fileManager.getProjectRoot()
    const path = `${projectRoot}/${name}`

    try {
      if (type === 'folder') {
        await fileManager.createDirectory(path)
      } else {
        await fileManager.createFile(path, '')
      }
      // FileSystemWatcher will automatically update the tree
      setShowAddMenu(false)
      // Set editing for the new item - use path as ID
      setEditingNewId(`fs:${path}`)
    } catch (e) {
      console.error('Failed to create item:', e)
    }
  }

  const uploadFileRef = useRef<HTMLInputElement>(null)

  const handleUploadFiles = async (selectedFiles: FileList | null) => {
    if (!selectedFiles || selectedFiles.length === 0) return
    const projectRoot = fileManager.getProjectRoot()

    for (const file of Array.from(selectedFiles)) {
      try {
        const buffer = await file.arrayBuffer()
        const data = new Uint8Array(buffer)
        const filePath = `${projectRoot}/${file.name}`
        await fileSystem.writeBinary(filePath, data, { createParents: true })
      } catch (err) {
        console.error(`Failed to upload file ${file.name}:`, err)
      }
    }
    await fileSystemWatcher.refresh()
    setShowAddMenu(false)
  }

  // ========================================
  // Tree operations using FileManager
  // ========================================

  const deleteItem = async (id: string) => {
    // Find the item to get its path
    const item = findItemById(files, id)
    if (!item) return

    try {
      if (item.type === 'folder') {
        await fileManager.deleteDirectory(item.path)
      } else {
        await fileManager.deleteFile(item.path)
      }
      // FileSystemWatcher will automatically update the tree
    } catch (e) {
      console.error('Failed to delete item:', e)
    }
  }

  const renameItem = async (id: string, newName: string) => {
    // Find the item to get its path
    const item = findItemById(files, id)
    if (!item) return

    // Compute new path
    const oldPath = item.path
    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'))
    const newPath = `${parentPath}/${newName}`

    try {
      await fileManager.renameFile(oldPath, newPath)
      // FileSystemWatcher will automatically update the tree
    } catch (e) {
      console.error('Failed to rename item:', e)
    }
  }

  // Helper to find an item by ID
  const findItemById = (items: FileItem[], id: string): FileItem | null => {
    for (const item of items) {
      if (item.id === id) return item
      if (item.children) {
        const found = findItemById(item.children, id)
        if (found) return found
      }
    }
    return null
  }

  const addChildItem = async (parentId: string, type: 'file' | 'folder') => {
    // Find the parent folder
    const parent = findItemById(files, parentId)
    if (!parent || parent.type !== 'folder') return

    const name = type === 'folder' ? 'New Folder' : 'untitled.tex'
    const childPath = `${parent.path}/${name}`

    try {
      if (type === 'folder') {
        await fileManager.createDirectory(childPath)
      } else {
        await fileManager.createFile(childPath, '')
      }
      // FileSystemWatcher will automatically update the tree
      setEditingNewId(`fs:${childPath}`)
    } catch (e) {
      console.error('Failed to create child item:', e)
    }
  }

  const moveItem = async (itemId: string, targetFolderId: string | null) => {
    // Find the item to move
    const itemToMove = findItemById(files, itemId)
    if (!itemToMove) return

    // Determine new path
    let newPath: string
    if (targetFolderId === null) {
      // Move to root
      const projectRoot = fileManager.getProjectRoot()
      newPath = `${projectRoot}/${itemToMove.name}`
    } else {
      const targetFolder = findItemById(files, targetFolderId)
      if (!targetFolder || targetFolder.type !== 'folder') return
      newPath = `${targetFolder.path}/${itemToMove.name}`
    }

    try {
      // Moving is implemented as rename in FileManager
      await fileManager.renameFile(itemToMove.path, newPath)
      // FileSystemWatcher will automatically update the tree
    } catch (e) {
      console.error('Failed to move item:', e)
    }
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

    const projectRoot = fileManager.getProjectRoot()

    // Read and create each dropped file (binary-safe for images)
    for (const file of droppedFiles) {
      try {
        const filePath = `${projectRoot}/${file.name}`
        if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|svg|webp|pdf|eps)$/i.test(file.name)) {
          const buffer = await file.arrayBuffer()
          await fileSystem.writeBinary(filePath, new Uint8Array(buffer), { createParents: true })
        } else {
          const content = await file.text()
          await fileManager.createFile(filePath, content)
        }
      } catch (err) {
        console.error(`Failed to import file ${file.name}:`, err)
      }
    }
    await fileSystemWatcher.refresh()
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
                <button onClick={() => uploadFileRef.current?.click()}>
                  <Image size={14} />
                  Upload Image
                </button>
              </div>
            )}
            <input
              ref={uploadFileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleUploadFiles(e.target.files); e.target.value = '' }}
            />
          </div>
        </div>

        <div className="sidebar-files" onContextMenu={handleFilesContextMenu}>
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
                onRename={renameItem}
                onAddChild={addChildItem}
                onSelect={handleFileSelect}
                onMoveItem={moveItem}
                onContextMenu={handleItemContextMenu}
                selectedId={selectedFileId}
                draggedId={draggedId}
                onDragStart={setDraggedId}
                onDragEnd={() => setDraggedId(null)}
                editingNewId={editingNewId}
                onEditingComplete={() => setEditingNewId(null)}
                newFileIds={newFileIds}
              />
            ))
          )}
        </div>

        {contextMenu && (
          <div
            className="sidebar-context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {contextMenu.itemId ? (
              <button className="destructive" onClick={() => { deleteItem(contextMenu.itemId!); setContextMenu(null) }}>
                <Trash2 size={14} /> Delete
              </button>
            ) : (
              <>
                <button onClick={() => { addItem('file'); setContextMenu(null) }}>
                  <FilePlus size={14} /> New File
                </button>
                <button onClick={() => { addItem('folder'); setContextMenu(null) }}>
                  <FolderPlus size={14} /> New Folder
                </button>
                <button onClick={() => { uploadFileRef.current?.click(); setContextMenu(null) }}>
                  <Image size={14} /> Upload Image
                </button>
              </>
            )}
          </div>
        )}

        {/* Footer - Sync, Integrations */}
        <div className="sidebar-footer">
          <div className="sidebar-footer-row">
            {(gitStatus.isConnected || zoteroStatus.connected) && (
              <button
                className="sync-btn-compact"
                onClick={() => {
                  if (gitStatus.isConnected) handleSyncNow()
                  if (zoteroStatus.connected) handleZoteroSync()
                }}
                disabled={gitStatus.isSyncing || zoteroStatus.syncing}
                title="Sync"
              >
                <RefreshCw size={14} className={(gitStatus.isSyncing || zoteroStatus.syncing) ? 'spinning' : ''} />
              </button>
            )}
            <button className="integrations-link" onClick={onOpenIntegrations} title="Integrations">
              <Plug size={14} />
              {!gitStatus.isConnected && !zoteroStatus.connected && <span>Integrations</span>}
            </button>
          </div>
        </div>
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
