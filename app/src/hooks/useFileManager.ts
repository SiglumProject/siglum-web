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

import { useState, useEffect, useCallback } from 'react'
import { fileManager, type OpenFile } from '../services/FileManager'
import { fileSystemWatcher, type FileNode } from '../services/FileSystemWatcher'
import EventBus from '../services/EventBus'

interface UseFileManagerReturn {
  currentFile: OpenFile | null
  fileTree: FileNode | null
  isLoading: boolean
  error: string | null
  failedRestorePath: string | null
  dismissFailedRestore: () => void
  createRecoveryDocument: () => Promise<void>
  openFile: (path: string) => Promise<boolean>
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
  const [failedRestorePath, setFailedRestorePath] = useState<string | null>(null)

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
          if (cancelled) return
          setCurrentFile(file)
          if (file) setFailedRestorePath(null)
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
            if (cancelled) return
            setFailedRestorePath(urlPath)
            throw new Error(`Could not reopen "${urlPath.split('/').pop()}". Reload to retry or choose another saved document. Your saved selection has been kept.`)
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
            // Let the user choose a recovery action before changing the saved selection.
            setFailedRestorePath(lastPath)
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

  const openFile = useCallback(async (path: string) => {
    const needsEditor = !fileManager.getCurrentFile()
    setError(null)
    if (needsEditor) setIsLoading(true)

    try {
      const opened = await fileManager.openFile(path)
      setFailedRestorePath(null)
      if (fileManager.getFilePathFromURL()) fileManager.setURLParam(opened.path)
      return true
    } catch (err) {
      const name = path.split('/').pop() || path
      const message = `Could not open "${name}".`
      console.warn('[useFileManager] Failed to open:', path, err)
      if (fileManager.getCurrentFile()) {
        EventBus.emit('showToast', { message, type: 'error' })
      } else {
        setError(message)
      }
      return false
    } finally {
      if (needsEditor) setIsLoading(false)
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

      const created = await fileManager.createFile(`${projectRoot}/${name}`, '')
      setFailedRestorePath(null)
      if (fileManager.getFilePathFromURL()) fileManager.setURLParam(created.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create new file')
    }
  }, [])

  const dismissFailedRestore = useCallback(() => {
    if (!failedRestorePath) return
    fileManager.forgetSavedSelection(failedRestorePath)
    setFailedRestorePath(null)
    setError(null)
  }, [failedRestorePath])

  const createRecoveryDocument = useCallback(async () => {
    setIsLoading(true)
    try {
      // A read failure does not prove the saved file is absent. Use a fresh
      // path without probing or writing the unreadable file.
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte =>
        byte.toString(16).padStart(2, '0')
      ).join('')
      const created = await fileManager.createFile(
        `/project/src/untitled-${suffix}.tex`,
        String.raw`\documentclass{article}
\begin{document}

\end{document}
`
      )
      setFailedRestorePath(null)
      if (fileManager.getFilePathFromURL()) fileManager.setURLParam(created.path)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create a recovery document')
    } finally {
      setIsLoading(false)
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
    failedRestorePath,
    dismissFailedRestore,
    createRecoveryDocument,
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
