/**
 * EventBus - Type-safe pub/sub for cross-module communication
 *
 * Replaces brittle window.dispatchEvent/addEventListener patterns with
 * a strongly-typed, centralized event system.
 *
 * Usage:
 *   // Emit an event
 *   EventBus.emit('toggleCommandPalette')
 *   EventBus.emit('goToLine', { line: 42 })
 *
 *   // Subscribe (returns cleanup function)
 *   const unsub = EventBus.on('toggleCommandPalette', () => { ... })
 *
 *   // In React components
 *   useEffect(() => EventBus.on('goToLine', handler), [])
 */

// Event definitions - single source of truth for all cross-module events
export interface EventMap {
  // Modal events
  toggleCommandPalette: void
  toggleHelp: void
  openIntegrations: void

  // Editor events
  goToLine: { line: number }
  insertText: { text: string }
  triggerCompile: void

  // Document events
  documentChanged: { id: string; content: string }
  documentSwitched: { id: string }
  openDocument: { path: string; line?: number }

  // Project events
  fileSelected: { path: string; lineNumber?: number }
  filesChanged: void
  filesystemChanged: { tree: import('./FileSystemWatcher').FileNode | null }

  // Git events
  gitStatusChanged: { behind: number; ahead: number }
  gitConnected: void
  gitDisconnected: void

  // UI events
  sidebarToggled: { expanded: boolean }

  // PDF/Editor sync events
  syncModeChanged: { enabled: boolean }
  forwardSync: { line: number; lineText: string }
  inverseSync: { context: string; word: string; page: number; yFraction: number }

  // Editor value override — resets echo-suppression flag so the next value prop is applied
  forceEditorSync: void

  // Scroll sync events (text-matching between editor viewport and PDF pages)
  scrollSync: { text: string; source: 'editor' | 'pdf' }

  // Toast notifications
  showToast: { message: string; type?: 'success' | 'error' | 'info' | 'loading'; duration?: number; key?: string; className?: string }
}

type EventCallback<T> = T extends void ? () => void : (payload: T) => void
type Listener = { callback: Function; once: boolean }

class EventBusService {
  private listeners = new Map<keyof EventMap, Set<Listener>>()

  /**
   * Subscribe to an event
   * @returns Unsubscribe function (call in useEffect cleanup)
   */
  on<K extends keyof EventMap>(
    event: K,
    callback: EventCallback<EventMap[K]>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }

    const listener: Listener = { callback, once: false }
    this.listeners.get(event)!.add(listener)

    return () => {
      this.listeners.get(event)?.delete(listener)
    }
  }

  /**
   * Subscribe to an event once (auto-unsubscribes after first call)
   */
  once<K extends keyof EventMap>(
    event: K,
    callback: EventCallback<EventMap[K]>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }

    const listener: Listener = { callback, once: true }
    this.listeners.get(event)!.add(listener)

    return () => {
      this.listeners.get(event)?.delete(listener)
    }
  }

  /**
   * Emit an event to all subscribers
   */
  emit<K extends keyof EventMap>(
    event: K,
    ...args: EventMap[K] extends void ? [] : [EventMap[K]]
  ): void {
    const listeners = this.listeners.get(event)
    if (!listeners) return

    const toRemove: Listener[] = []

    for (const listener of listeners) {
      listener.callback(args[0])
      if (listener.once) {
        toRemove.push(listener)
      }
    }

    // Clean up one-time listeners
    for (const listener of toRemove) {
      listeners.delete(listener)
    }
  }

  /**
   * Remove all listeners for an event (useful for testing)
   */
  off<K extends keyof EventMap>(event: K): void {
    this.listeners.delete(event)
  }

  /**
   * Clear all listeners (useful for testing/cleanup)
   */
  clear(): void {
    this.listeners.clear()
  }

  /**
   * Get listener count for debugging
   */
  listenerCount<K extends keyof EventMap>(event: K): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

// Singleton instance
const EventBus = new EventBusService()

export default EventBus
