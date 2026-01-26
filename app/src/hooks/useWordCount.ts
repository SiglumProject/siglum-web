import { useState, useEffect, useRef } from 'react'
import { countWords } from '../utils/texcount'

interface WordCountState {
  count: number | null
  isLoading: boolean
  error: string | null
}

// Debounce for word count - no need for instant updates
const DEBOUNCE_MS = 500

export function useWordCount(
  latexCode: string,
  enabled: boolean
): WordCountState {
  const [state, setState] = useState<WordCountState>({
    count: null,
    isLoading: false,
    error: null,
  })

  const lastCodeRef = useRef<string>('')
  const debounceRef = useRef<number | null>(null)

  // Count words when code changes (debounced)
  useEffect(() => {
    if (!enabled) return

    // Skip if code hasn't changed
    if (lastCodeRef.current === latexCode) return
    lastCodeRef.current = latexCode

    // Clear pending debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    // Debounce - wait for user to stop typing
    debounceRef.current = window.setTimeout(() => {
      if (!latexCode.trim()) {
        setState({ count: 0, isLoading: false, error: null })
        return
      }

      try {
        // Count words using TeXcount-based algorithm
        const count = countWords(latexCode)
        setState({ count, isLoading: false, error: null })
      } catch (err) {
        console.warn('[WordCount] Count failed:', err)
        // Keep previous count on error
      }
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [latexCode, enabled])

  return state
}
