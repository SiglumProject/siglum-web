import { useEffect, useState } from 'react'
import citationService, { type CitationItem } from '../../services/CitationService'

export function useCitationSearch(query: string, active: boolean) {
  const [status, setStatus] = useState(citationService.getStatus())
  const [items, setItems] = useState<CitationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => citationService.onStatus(setStatus), [])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    setError('')
    setItems([])
    const timer = window.setTimeout(async () => {
      try {
        const tracked = citationService.getTrackedCitations().filter(item => `${item.title} ${item.creatorsText} ${item.citeKey}`.toLowerCase().includes(query.toLowerCase()))
        const found = query.trim() ? await citationService.search(query, 12) : tracked
        const byKey = new Map([...tracked, ...found].map(item => [item.citeKey, item]))
        if (!cancelled) setItems([...byKey.values()].slice(0, 12))
      } catch { if (!cancelled) { setItems([]); setError('Could not search your library. Try again.') } } finally { if (!cancelled) setLoading(false) }
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query, active, status.connectedCount, status.usedCitationsCount])
  return { items, loading, status, error }
}
