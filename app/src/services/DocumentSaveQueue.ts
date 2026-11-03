export interface SaveStatus {
  isSaving: boolean
  lastSaved: Date | null
  error: string | null
  hasUnsavedChanges: boolean
}

/** Debounce by path and serialize writes, so a tab switch cannot retarget a save. */
export class DocumentSaveQueue {
  private pending = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | null = null
  private listeners = new Set<(status: SaveStatus) => void>()
  private status: SaveStatus = { isSaving: false, lastSaved: null, error: null, hasUnsavedChanges: false }

  constructor(private write: (path: string, content: string) => Promise<void>, private delay = 500) {}

  subscribe(listener: (status: SaveStatus) => void) {
    this.listeners.add(listener)
    listener(this.status)
    return () => { this.listeners.delete(listener) }
  }

  private update(patch: Partial<SaveStatus>) {
    this.status = { ...this.status, ...patch }
    this.listeners.forEach(listener => listener(this.status))
  }

  schedule(path: string, content: string) {
    this.pending.set(path, content)
    this.update({ hasUnsavedChanges: true, error: null })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, this.delay)
  }

  flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.running) return this.running
    this.running = this.drain().finally(() => { this.running = null })
    return this.running
  }

  async flushOrThrow(): Promise<void> {
    await this.flush()
    if (this.status.error) throw new Error(this.status.error)
  }

  private async drain() {
    this.update({ isSaving: true })
    while (this.pending.size) {
      const [path, content] = this.pending.entries().next().value!
      this.pending.delete(path)
      try {
        await this.write(path, content)
        this.update({ lastSaved: new Date(), error: null })
      } catch (error) {
        // Keep the newest draft available for retry, including edits made during the write.
        if (!this.pending.has(path)) this.pending.set(path, content)
        this.update({ isSaving: false, hasUnsavedChanges: true,
          error: error instanceof Error ? error.message : 'Save failed' })
        return
      }
    }
    this.update({ isSaving: false, hasUnsavedChanges: false })
  }
}
