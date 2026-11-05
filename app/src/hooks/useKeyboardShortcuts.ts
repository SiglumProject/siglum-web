import { useEffect, useRef } from 'react'
import { fileManager } from '../services/FileManager'
import EventBus from '../services/EventBus'

interface UseKeyboardShortcutsOptions {
  enabled: boolean
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
  onSelectTabByIndex?: (index: number) => void
}

export function useKeyboardShortcuts({
  enabled,
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
}: UseKeyboardShortcutsOptions): void {
  // Use refs for state/callbacks to keep the keydown listener stable (never re-added)
  const refs = useRef({
    enabled,
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
    enabled,
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
      if (e.defaultPrevented || e.isComposing) return
      const r = refs.current
      if (!r.enabled) return
      const key = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey

      // Compile from the editor, PDF, or toolbar; the editor keymap alone misses
      // the shortcut as soon as focus leaves CodeMirror.
      if (mod && key === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) EventBus.emit('triggerCompile')
        return
      }

      // Command palette shortcuts (global)
      if ((e.metaKey || e.ctrlKey) && key === 'k' && !e.shiftKey && !e.altKey) {
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

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (key === 'f' || key === 'k')) {
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

      if ((e.metaKey || e.ctrlKey) && key === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        r.onCreateNewDocument()
        return
      }

      if ((e.metaKey || e.ctrlKey) && key === 'w' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        r.onCloseCurrentDocument()
        return
      }

      if ((e.metaKey || e.ctrlKey) && key === 'h' && !e.shiftKey && !e.altKey) {
        e.preventDefault()

        if (r.showDocumentation) {
          r.onCloseDocumentation()
        } else {
          r.onOpenDocumentation(r.showCommandPalette)
        }
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === 'e' && !e.altKey) {
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

      // Match the layout shortcuts shown in Help. Alt+number selects a tab.
      if (mod && !e.shiftKey && !e.altKey && (key === '1' || key === '2')) {
        e.preventDefault()
        e.stopPropagation()
        const visible = key === '2'
        if (window.innerWidth >= 768) {
          r.setShowDesktopPreview(visible)
        } else r.setShowPreview(visible)
        return
      }
      if (mod && e.altKey && !e.shiftKey && e.code.startsWith('Digit') && e.code >= 'Digit1' && e.code <= 'Digit9') {
        e.preventDefault()
        e.stopPropagation()
        r.onSelectTabByIndex?.(Number(e.code.slice(-1)) - 1)
        return
      }
      // Cmd+\ - toggle PDF preview
      if (mod && !e.shiftKey && !e.altKey && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault()
        if (window.innerWidth >= 768) {
          r.setShowDesktopPreview(prev => !prev)
        } else {
          r.setShowPreview(prev => !prev)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, []) // State and callbacks are read from refs.
}
