/**
 * Siglum Service Worker
 *
 * Provides caching for static assets and WASM files for instant loads after first visit.
 * Uses stale-while-revalidate strategy for most assets.
 */

const CACHE_NAME = 'siglum-v3'

// Core assets to precache on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html'
]

// Patterns for assets to cache on first fetch
const CACHEABLE_PATTERNS = [
  // Static assets
  /\.(js|css|html)$/,
  // WASM files
  /\.wasm$/,
  // Worker scripts
  /worker.*\.js$/,
  // PDF.js
  /pdf\.worker/,
  // Fonts
  /\.(woff2?|ttf|otf)$/
]

// Patterns to never cache (API calls, dynamic content)
const NEVER_CACHE_PATTERNS = [
  /\/api\//,
  /\/share\//,
  /\?/  // URLs with query strings (may be dynamic)
]

/**
 * Check if a URL should be cached
 */
function shouldCache(url) {
  const parsed = new URL(url)
  const pathname = parsed.pathname
  // Development modules must always come from Vite.
  if (/^\/(?:src|node_modules|@vite|@react-refresh)\//.test(pathname)) return false

  // Never cache certain patterns
  for (const pattern of NEVER_CACHE_PATTERNS) {
    if (pattern.test(pathname) || pattern.test(url)) {
      return false
    }
  }

  // Cache if matches cacheable patterns
  for (const pattern of CACHEABLE_PATTERNS) {
    if (pattern.test(pathname)) {
      return true
    }
  }

  return false
}

/**
 * Install event - precache core assets
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())  // Activate immediately
  )
})

/**
 * Activate event - clean up old caches
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => /^siglum-v\d+$/.test(name) && name !== CACHE_NAME)
            .map(name => caches.delete(name))
        )
      })
      .then(() => self.clients.claim())  // Take control immediately
  )
})

/**
 * Fetch event - stale-while-revalidate strategy
 */
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return
  }

  const url = event.request.url

  // Skip non-cacheable URLs
  if (event.request.mode !== 'navigate' && !shouldCache(url)) {
    return
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(event.request).then(cachedResponse => {
        // Fetch fresh version in background
        const fetchPromise = fetch(event.request)
          .then(networkResponse => {
            // Only cache successful responses
            if (networkResponse.ok) {
              cache.put(event.request, networkResponse.clone())
            }
            return networkResponse
          })
          .catch(error => {
            // Network failed - return cached response or throw
            if (cachedResponse) {
              return cachedResponse
            }
            // No cache and network failed - rethrow to trigger error handling
            throw error
          })

        // Return cached immediately if available (stale-while-revalidate)
        // Otherwise wait for network (cache-first with network fallback)
        // HTML and the unversioned engine worker must be fresh when online.
        // Hashed production assets are immutable and safe to serve from cache.
        const pathname = new URL(url).pathname
        const immutableAsset = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\./.test(pathname)
        event.waitUntil(fetchPromise.then(() => undefined, () => undefined))
        return immutableAsset ? (cachedResponse || fetchPromise) : fetchPromise
      })
    })
  )
})

/**
 * Handle messages from the main thread
 */
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting()
  }

  if (event.data === 'clearCache') {
    caches.delete(CACHE_NAME)
  }

  if (event.data?.type === 'CACHE_URLS') {
    // Precache specific URLs
    const urls = event.data.urls
    if (Array.isArray(urls)) {
      event.waitUntil(
        caches.open(CACHE_NAME).then(cache => Promise.all(urls.map(async url => {
          if (!await cache.match(url)) await cache.add(new Request(url, { cache: 'reload' }))
        })))
      )
    }
  }
})
