/**
 * useFileManager - React hook for file management
 *
 * Provides a clean React interface to the FileManager service.
 * Handles initialization, subscriptions, and state management.
 *
 * Usage:
 * ```tsx
 * const {
 *   currentFile,
 *   isLoading,
 *   error,
 *   openFile,
 *   saveFile,
 *   createFile,
 *   deleteFile
 * } = useFileManager()
 * ```
 */

import { useState, useEffect, useCallback, startTransition } from 'react'
import { fileManager, type OpenFile } from '../services/FileManager'
import { fileSystemWatcher, type FileNode } from '../services/FileSystemWatcher'

interface UseFileManagerReturn {
  currentFile: OpenFile | null
  fileTree: FileNode | null
  isLoading: boolean
  error: string | null
  openFile: (path: string) => Promise<void>
  saveFile: (path: string, content: string) => Promise<void>
  updateContent: (content: string) => Promise<void>
  createFile: (path: string, content?: string) => Promise<void>
  deleteFile: (path: string) => Promise<void>
  renameFile: (oldPath: string, newPath: string) => Promise<void>
  createDirectory: (path: string) => Promise<void>
  deleteDirectory: (path: string) => Promise<void>
  createNewFile: () => Promise<void>
  getRecentPaths: () => string[]
}

export function useFileManager(): UseFileManagerReturn {
  const [currentFile, setCurrentFile] = useState<OpenFile | null>(null)
  const [fileTree, setFileTree] = useState<FileNode | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Initialize and subscribe to changes
  useEffect(() => {
    let cancelled = false
    let fileUnsubscribe: (() => void) | null = null
    let treeUnsubscribe: (() => void) | null = null

    const initialize = async () => {
      try {
        setIsLoading(true)
        setError(null)

        // Initialize file manager
        await fileManager.initialize()
        if (cancelled) return

        // Subscribe to file changes
        fileUnsubscribe = fileManager.subscribe((file) => {
          if (!cancelled) setCurrentFile(file)
        })

        // Subscribe to file tree changes
        treeUnsubscribe = fileSystemWatcher.subscribe((tree) => {
          if (!cancelled) setFileTree(tree)
        })

        // Helper: open file and update state directly (belt + suspenders)
        const restoreFile = async (path: string) => {
          const file = await fileManager.openFile(path)
          if (!cancelled) setCurrentFile(file)
        }

        // Try to restore last file from URL or localStorage
        const urlPath = fileManager.getFilePathFromURL()
        if (urlPath) {
          try {
            await restoreFile(urlPath)
            if (cancelled) return
            return
          } catch {
            fileManager.clearURLFile()
            if (cancelled) return
          }
        }

        // Try to restore from localStorage
        let lastPath: string | null = null
        try {
          lastPath = localStorage.getItem('siglum_current_file')
        } catch { /* localStorage unavailable */ }

        if (lastPath) {
          try {
            await restoreFile(lastPath)
            if (cancelled) return
            return
          } catch (err) {
            console.warn('[useFileManager] Failed to restore:', lastPath, err)
            if (cancelled) return
            // Preserve the pointer instead of silently opening a welcome/unrelated file.
            throw new Error(`Could not reopen "${lastPath.split('/').pop()}". Reload to retry. Your saved document selection has been kept.`)
          }
        }

        // Only auto-open a file if the user has previously entered the editor
        // (otherwise show the landing page)
        if (localStorage.getItem('siglum_entered_editor')) {
          const texFiles = fileSystemWatcher.getFilesByExtension('tex')
          if (texFiles.length > 0) {
            await restoreFile(texFiles[0].path)
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to initialize file manager')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    initialize()

    return () => {
      cancelled = true
      if (fileUnsubscribe) fileUnsubscribe()
      if (treeUnsubscribe) treeUnsubscribe()
    }
  }, [])

  // Open file
  const openFile = useCallback(async (path: string) => {
    try {
      setError(null)
      startTransition(() => {
        setIsLoading(true)
      })
      await fileManager.openFile(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open file')
    } finally {
      startTransition(() => {
        setIsLoading(false)
      })
    }
  }, [])

  // Save file
  const saveFile = useCallback(async (path: string, content: string) => {
    try {
      setError(null)
      await fileManager.saveFile(path, content)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save file')
    }
  }, [])

  // Update content (used for auto-save)
  const updateContent = useCallback(async (content: string) => {
    try {
      setError(null)
      await fileManager.updateContent(content)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update content')
    }
  }, [])

  // Create new file
  const createFile = useCallback(async (path: string, content: string = '') => {
    try {
      setError(null)
      await fileManager.createFile(path, content)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create file')
    }
  }, [])

  // Delete file
  const deleteFile = useCallback(async (path: string) => {
    try {
      setError(null)
      await fileManager.deleteFile(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete file')
    }
  }, [])

  // Rename file
  const renameFile = useCallback(async (oldPath: string, newPath: string) => {
    try {
      setError(null)
      await fileManager.renameFile(oldPath, newPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename file')
    }
  }, [])

  // Create directory
  const createDirectory = useCallback(async (path: string) => {
    try {
      setError(null)
      await fileManager.createDirectory(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create directory')
    }
  }, [])

  // Delete directory
  const deleteDirectory = useCallback(async (path: string) => {
    try {
      setError(null)
      await fileManager.deleteDirectory(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete directory')
    }
  }, [])

  // Create a new untitled file
  const createNewFile = useCallback(async () => {
    try {
      setError(null)
      const projectRoot = fileManager.getProjectRoot()

      // Find a unique name
      let name = 'untitled.tex'
      let counter = 1
      while (await fileManager.exists(`${projectRoot}/${name}`)) {
        name = `untitled-${counter}.tex`
        counter++
      }

      await fileManager.createFile(`${projectRoot}/${name}`, '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create new file')
    }
  }, [])

  // Get recent paths
  const getRecentPaths = useCallback(() => {
    return fileManager.getRecentPaths()
  }, [])

  return {
    currentFile,
    fileTree,
    isLoading,
    error,
    openFile,
    saveFile,
    updateContent,
    createFile,
    deleteFile,
    renameFile,
    createDirectory,
    deleteDirectory,
    createNewFile,
    getRecentPaths
  }
}

export default useFileManager
