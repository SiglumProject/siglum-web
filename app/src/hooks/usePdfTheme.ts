import { useSyncExternalStore } from 'react'

const key = 'siglum.pdf.darkMode'
const readPreference = () => {
  try { return localStorage.getItem(key) !== 'false' } catch { return true }
}
let dark = readPreference()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(listener => listener())
const onStorage = (event: StorageEvent) => {
  if (event.key !== key && event.key !== null) return
  dark = readPreference()
  notify()
}
const subscribe = (listener: () => void) => {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}
const toggle = () => {
  dark = !dark
  try { localStorage.setItem(key, String(dark)) } catch { /* Keep the choice for this session. */ }
  notify()
}
export function usePdfTheme() {
  return { dark: useSyncExternalStore(subscribe, () => dark, () => true), toggle }
}
