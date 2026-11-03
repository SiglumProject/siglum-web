import { useEffect, useRef } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { fileManager } from '../services/FileManager'

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
  setShowDesktopPreview: React.Dispatch<React.SetStateAction<boolean>>
  setShowPreview: React.Dispatch<React.SetStateAction<boolean>>
  editorPanelRef: React.RefObject<ImperativePanelHandle | null>
  previewPanelRef: React.RefObject<ImperativePanelHandle | null>
  onSelectTabByIndex?: (index: number) => void
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
  setShowDesktopPreview,
  setShowPreview,
  editorPanelRef,
  previewPanelRef,
  onSelectTabByIndex,
}: UseKeyboardShortcutsOptions): void {
  // Use refs for state/callbacks to keep the keydown listener stable (never re-added)
  const refs = useRef({
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
    setShowDesktopPreview,
    setShowPreview,
    onSelectTabByIndex,
  })
  refs.current = {
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
    setShowDesktopPreview,
    setShowPreview,
    onSelectTabByIndex,
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const r = refs.current

      // Command palette shortcuts (global)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()

        if (r.showCommandPalette) {
          r.onCloseCommandPalette()
        } else {
          if (r.showDocumentation) {
            r.onCloseDocumentation()
          }
          r.onOpenCommandPalette()
        }
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault()
        if (r.showCommandPalette) {
          r.onCloseCommandPalette()
        } else {
          if (r.showDocumentation) {
            r.onCloseDocumentation()
          }
          r.onOpenCommandPalette()
        }
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        r.onCreateNewDocument()
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        r.onCloseCurrentDocument()
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
        e.preventDefault()

        if (r.showDocumentation) {
          r.onCloseDocumentation()
        } else {
          r.onOpenDocumentation(r.showCommandPalette)
        }
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        fileManager.exportFile()
        return
      }

      // Cmd+. or Ctrl+. - toggle project sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        r.onToggleSidebar()
        return
      }

      // Cmd+1..9 - switch to tab by index
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        r.onSelectTabByIndex?.(parseInt(e.key, 10) - 1)
        return
      }
      // Cmd+\ - toggle/balance panels
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        if (window.innerWidth >= 768) {
          r.setShowDesktopPreview(prev => !prev)
          if (r.showDesktopPreview) {
            setTimeout(() => {
              editorPanelRef.current?.resize(50)
              previewPanelRef.current?.resize(50)
            }, 0)
          }
        } else {
          r.setShowPreview(prev => !prev)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [editorPanelRef, previewPanelRef]) // Stable refs only — listener never re-added
}
