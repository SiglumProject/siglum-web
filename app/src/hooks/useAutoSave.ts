import { useEffect, useState } from 'react'
import type { DocumentSaveQueue, SaveStatus } from '../services/DocumentSaveQueue'

export type AutoSaveStatus = SaveStatus

export function useAutoSave(queue: DocumentSaveQueue): SaveStatus {
  const [status, setStatus] = useState<SaveStatus>({
    isSaving: false, lastSaved: null, error: null, hasUnsavedChanges: false,
  })
  useEffect(() => {
    const unsubscribe = queue.subscribe(setStatus)
    return () => { unsubscribe(); void queue.flush() }
  }, [queue])
  return status
}
