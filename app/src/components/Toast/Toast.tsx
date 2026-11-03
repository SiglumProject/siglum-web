import { useState, useEffect, useCallback, useRef } from 'react'
import { Check, X, Info } from 'lucide-react'
import EventBus from '../../services/EventBus'
import './Toast.css'

interface Toast {
  id: string
  key?: string
  message: string
  type: 'success' | 'error' | 'info' | 'loading'
  className?: string
  exiting: boolean
}

const MAX_TOASTS = 4
const EXIT_DURATION = 200

const icons: Record<Toast['type'], React.ReactNode> = {
  success: <Check size={10} strokeWidth={3} />,
  error: <X size={10} strokeWidth={3} />,
  info: <Info size={10} strokeWidth={2.5} />,
  loading: <span className="toast-spinner" />,
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t))
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, EXIT_DURATION)
  }, [])

  useEffect(() => {
    return EventBus.on('showToast', ({ message, type = 'info', duration = 3000, key, className }) => {
      setToasts(prev => {
        // If key provided, update existing toast in-place (same id = no remount)
        if (key) {
          const existingIdx = prev.findIndex(t => t.key === key && !t.exiting)
          if (existingIdx !== -1) {
            const existing = prev[existingIdx]
            // Reset dismiss timer
            const timer = timersRef.current.get(existing.id)
            if (timer) clearTimeout(timer)
            if (duration > 0) {
              timersRef.current.set(existing.id, window.setTimeout(() => {
                timersRef.current.delete(existing.id)
                removeToast(existing.id)
              }, duration))
            }
            // Update message/type/className, keep same id
            const next = [...prev]
            next[existingIdx] = { ...existing, message, type, className }
            return next
          }
        }

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const toast: Toast = { id, key, message, type, className, exiting: false }

        // Schedule dismiss
        if (duration > 0) {
          timersRef.current.set(id, window.setTimeout(() => {
            timersRef.current.delete(id)
            removeToast(id)
          }, duration))
        }

        const next = [...prev, toast]
        if (next.length > MAX_TOASTS) {
          const oldest = next[0]
          const oldTimer = timersRef.current.get(oldest.id)
          if (oldTimer) {
            clearTimeout(oldTimer)
            timersRef.current.delete(oldest.id)
          }
          return next.slice(1)
        }
        return next
      })
    })
  }, [removeToast])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach(t => clearTimeout(t))
      timers.clear()
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast ${toast.type}${toast.exiting ? ' exiting' : ''}${toast.className ? ` ${toast.className}` : ''}`}
        >
          <span className="toast-icon">{icons[toast.type]}</span>
          <span className="toast-message">{toast.message}</span>
        </div>
      ))}
    </div>
  )
}
