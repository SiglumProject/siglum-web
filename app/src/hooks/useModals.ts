import { useState, useCallback, useEffect, useRef } from 'react'
import EventBus from '../services/EventBus'

type DocumentationTab = 'guide' | 'collaboration' | 'sharing' | 'integrations' | 'faq' | 'support'

interface UseModalsReturn {
  showCommandPalette: boolean
  isClosingCommandPalette: boolean
  showDocumentation: boolean
  isClosingDocumentation: boolean
  documentationOpenedFromPalette: boolean
  documentationDefaultTab: DocumentationTab
  openCommandPalette: () => void
  closeCommandPalette: () => void
  openDocumentation: (fromPalette?: boolean, tab?: DocumentationTab) => void
  closeDocumentation: () => void
  backFromDocumentation: () => void
  setShowCommandPalette: React.Dispatch<React.SetStateAction<boolean>>
}

export function useModals(): UseModalsReturn {
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [isClosingCommandPalette, setIsClosingCommandPalette] = useState(false)
  const [showDocumentation, setShowDocumentation] = useState(false)
  const [isClosingDocumentation, setIsClosingDocumentation] = useState(false)
  const [documentationOpenedFromPalette, setDocumentationOpenedFromPalette] = useState(false)
  const [documentationDefaultTab, setDocumentationDefaultTab] = useState<DocumentationTab>('guide')

  // Track timeout IDs to prevent memory leaks on unmount
  const timeoutRefs = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Helper to track and manage timeouts
  const safeTimeout = useCallback((callback: () => void, delay: number) => {
    const id = setTimeout(() => {
      timeoutRefs.current.delete(id)
      callback()
    }, delay)
    timeoutRefs.current.add(id)
    return id
  }, [])

  // Cleanup all pending timeouts on unmount
  useEffect(() => {
    return () => {
      timeoutRefs.current.forEach(id => clearTimeout(id))
      timeoutRefs.current.clear()
    }
  }, [])

  // Listen for command palette event from editor
  useEffect(() => {
    return EventBus.on('toggleCommandPalette', () => {
      setShowCommandPalette(prev => !prev)
    })
  }, [])

  // Listen for toggleHelp event from editor toolbar
  const showDocumentationRef = useRef(showDocumentation)
  showDocumentationRef.current = showDocumentation
  const closeDocRef = useRef<() => void>(() => {})
  useEffect(() => {
    return EventBus.on('toggleHelp', () => {
      if (showDocumentationRef.current) {
        closeDocRef.current()
      } else {
        setShowDocumentation(true)
      }
    })
  }, [])

  const openCommandPalette = useCallback(() => {
    setIsClosingCommandPalette(false)
    setShowCommandPalette(true)
  }, [])

  const closeCommandPalette = useCallback(() => {
    setIsClosingCommandPalette(true)
    safeTimeout(() => {
      setIsClosingCommandPalette(false)
      setShowCommandPalette(false)
    }, 200)
  }, [safeTimeout])

  const openDocumentation = useCallback((fromPalette: boolean = false, tab: DocumentationTab = 'guide') => {
    setDocumentationDefaultTab(tab)
    if (fromPalette) {
      setDocumentationOpenedFromPalette(true)
      // Close command palette with animation first
      setIsClosingCommandPalette(true)
      safeTimeout(() => {
        setIsClosingCommandPalette(false)
        setShowCommandPalette(false)
      }, 200)
    } else {
      setDocumentationOpenedFromPalette(false)
    }
    setShowDocumentation(true)
  }, [safeTimeout])

  const closeDocumentation = useCallback(() => {
    setIsClosingDocumentation(true)
    safeTimeout(() => {
      setIsClosingDocumentation(false)
      setShowDocumentation(false)
      setDocumentationOpenedFromPalette(false)
    }, 200)
  }, [safeTimeout])
  closeDocRef.current = closeDocumentation

  const backFromDocumentation = useCallback(() => {
    setIsClosingDocumentation(true)
    safeTimeout(() => {
      setIsClosingDocumentation(false)
      setShowDocumentation(false)
      setDocumentationOpenedFromPalette(false)
      setShowCommandPalette(true)
    }, 200)
  }, [safeTimeout])

  return {
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
  }
}
