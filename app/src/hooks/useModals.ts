import { useState, useCallback, useEffect, useRef } from 'react'
import EventBus from '../services/EventBus'

interface UseModalsReturn {
  showCommandPalette: boolean
  isClosingCommandPalette: boolean
  showDocumentation: boolean
  isClosingDocumentation: boolean
  documentationOpenedFromPalette: boolean
  openCommandPalette: () => void
  closeCommandPalette: () => void
  openDocumentation: (fromPalette?: boolean) => void
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
  useEffect(() => {
    return EventBus.on('toggleHelp', () => {
      if (showDocumentation) {
        closeDocumentation()
      } else {
        setShowDocumentation(true)
      }
    })
  }, [showDocumentation])

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

  const openDocumentation = useCallback((fromPalette: boolean = false) => {
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
    openCommandPalette,
    closeCommandPalette,
    openDocumentation,
    closeDocumentation,
    backFromDocumentation,
    setShowCommandPalette,
  }
}
