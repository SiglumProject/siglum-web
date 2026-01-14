/**
 * useEventBus - React hook for type-safe event subscription
 *
 * Automatically handles cleanup on unmount.
 *
 * Usage:
 *   // Subscribe to single event
 *   useEventBus('goToLine', ({ line }) => {
 *     editor.goToLine(line)
 *   })
 *
 *   // Subscribe with dependencies (re-subscribes when deps change)
 *   useEventBus('documentSwitched', ({ id }) => {
 *     console.log('Switched to:', id, currentMode)
 *   }, [currentMode])
 */

import { useEffect } from 'react'
import EventBus, { type EventMap } from '../services/EventBus'

type EventCallback<T> = T extends void ? () => void : (payload: T) => void

/**
 * Subscribe to an EventBus event with automatic cleanup
 */
export function useEventBus<K extends keyof EventMap>(
  event: K,
  callback: EventCallback<EventMap[K]>,
  deps: React.DependencyList = []
): void {
  useEffect(() => {
    return EventBus.on(event, callback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps])
}

/**
 * Subscribe to an event once (auto-unsubscribes after first trigger)
 */
export function useEventBusOnce<K extends keyof EventMap>(
  event: K,
  callback: EventCallback<EventMap[K]>,
  deps: React.DependencyList = []
): void {
  useEffect(() => {
    return EventBus.once(event, callback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps])
}

export default useEventBus
