import { compilerGlueUrl } from './services/CompilerService'
import React from 'react'
import ReactDOM from 'react-dom/client'
import compilerWorkerUrl from '@siglum/engine/worker?url'
import App from './App'
import './index.css'

// Register service worker for caching (instant loads after first visit)
if ('serviceWorker' in navigator && import.meta.env.DEV) {
  // Cached source modules can mask edits and mix different engine/UI versions in development.
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (const registration of registrations) {
      const script = registration.active?.scriptURL ?? registration.waiting?.scriptURL
      if (script && new URL(script).pathname === '/sw.js') void registration.unregister()
    }
  })
}
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('[SW] Registered:', registration.scope)
        void navigator.serviceWorker.ready.then(ready => {
          const loadedAssets = performance.getEntriesByType('resource').map(entry => entry.name)
            .filter(url => new URL(url).origin === location.origin && new URL(url).pathname.startsWith('/assets/'))
          ready.active?.postMessage({ type: 'CACHE_URLS', urls: [...new Set([compilerWorkerUrl, compilerGlueUrl, ...loadedAssets])] })
        })

        // Check for updates periodically
        setInterval(() => {
          registration.update()
        }, 60 * 60 * 1000) // Check every hour
      })
      .catch(error => {
        console.warn('[SW] Registration failed:', error)
      })
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
