import { useEffect, useCallback } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import DocumentManager from '../services/DocumentManager'

interface UseKeyboardShortcutsOptions {
  showCommandPalette: boolean
  showDesktopPreview: boolean
  showDocumentation: boolean
  onOpenCommandPalette: () => void
  onCloseCommandPalette: () => void
  onOpenDocumentation: (fromPalette?: boolean) => void
  onCloseDocumentation: () => void
  onCreateNewDocument: () => Promise<void>
  onCloseCurrentDocument: () => Promise<void>
  onToggleSidebar: () => void
  onSetLatexCode: (content: string) => void
  setShowDesktopPreview: React.Dispatch<React.SetStateAction<boolean>>
  setShowPreview: React.Dispatch<React.SetStateAction<boolean>>
  editorPanelRef: React.RefObject<ImperativePanelHandle | null>
  previewPanelRef: React.RefObject<ImperativePanelHandle | null>
}

export function useKeyboardShortcuts({
  showCommandPalette,
  showDesktopPreview,
  showDocumentation,
  onOpenCommandPalette,
  onCloseCommandPalette,
  onOpenDocumentation,
  onCloseDocumentation,
  onCreateNewDocument,
  onCloseCurrentDocument,
  onToggleSidebar,
  onSetLatexCode,
  setShowDesktopPreview,
  setShowPreview,
  editorPanelRef,
  previewPanelRef,
}: UseKeyboardShortcutsOptions): void {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Command palette shortcuts (global)
    if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()

      if (showCommandPalette) {
        onCloseCommandPalette()
      } else {
        if (showDocumentation) {
          onCloseDocumentation()
        }
        onOpenCommandPalette()
      }
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'F') {
      e.preventDefault()
      if (showCommandPalette) {
        onCloseCommandPalette()
      } else {
        if (showDocumentation) {
          onCloseDocumentation()
        }
        onOpenCommandPalette()
      }
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault()
      onCreateNewDocument()
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
      e.preventDefault()
      onCloseCurrentDocument()
      return
    }

    // Undo/Redo shortcuts
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      DocumentManager.undo().then(result => {
        if (result) {
          onSetLatexCode(result.content)
        }
      })
      return
    }

    if ((e.metaKey || e.ctrlKey) && ((e.shiftKey && e.key === 'z') || e.key === 'y')) {
      e.preventDefault()
      DocumentManager.redo().then(result => {
        if (result) {
          onSetLatexCode(result.content)
        }
      })
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
      e.preventDefault()

      if (showDocumentation) {
        onCloseDocumentation()
      } else {
        onOpenDocumentation(showCommandPalette)
      }
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
      e.preventDefault()
      DocumentManager.exportDocument()
      return
    }

    // Cmd+. or Ctrl+. - toggle project sidebar
    if ((e.metaKey || e.ctrlKey) && e.key === '.') {
      e.preventDefault()
      onToggleSidebar()
      return
    }

    // Cmd+1 - show only editor
    if ((e.metaKey || e.ctrlKey) && e.key === '1') {
      e.preventDefault()
      if (window.innerWidth >= 768) {
        setShowDesktopPreview(false)
      } else {
        setShowPreview(false)
      }
    }
    // Cmd+2 - show editor and preview
    else if ((e.metaKey || e.ctrlKey) && e.key === '2') {
      e.preventDefault()
      if (window.innerWidth >= 768) {
        setShowDesktopPreview(true)
        setTimeout(() => {
          editorPanelRef.current?.resize(50)
          previewPanelRef.current?.resize(50)
        }, 0)
      } else {
        setShowPreview(true)
      }
    }
    // Cmd+\ - toggle/balance panels
    else if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault()
      if (window.innerWidth >= 768) {
        setShowDesktopPreview(prev => !prev)
        if (showDesktopPreview) {
          setTimeout(() => {
            editorPanelRef.current?.resize(50)
            previewPanelRef.current?.resize(50)
          }, 0)
        }
      } else {
        setShowPreview(prev => !prev)
      }
    }
  }, [
    showCommandPalette,
    showDesktopPreview,
    showDocumentation,
    onOpenCommandPalette,
    onCloseCommandPalette,
    onOpenDocumentation,
    onCloseDocumentation,
    onCreateNewDocument,
    onCloseCurrentDocument,
    onToggleSidebar,
    onSetLatexCode,
    setShowDesktopPreview,
    setShowPreview,
    editorPanelRef,
    previewPanelRef,
  ])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])
}
