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
  // Provider URLs contain a digest of every executable and data asset.
  /^\/tools\/providers\/[a-f0-9]{64}\//,
  // Static assets
  /\.(js|mjs|css|html)$/,
  // WASM files
  /\.wasm$/,
  /^\/assets\/legacy-tkz-2018-[A-Za-z0-9_-]+\.bin$/,
  /^\/paragraph-runtime\/[^/]+\.(tfm|pfb|tex)$/,
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
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(PRECACHE_ASSETS.map(url => new Request(url, { cache: 'reload' })))
    const shell = await cache.match('/index.html')
    const html = await shell.text()
    const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1])
    await cache.addAll([...new Set(urls)].map(url => new Request(url, { cache: 'reload' })))
    await self.skipWaiting()
  })())
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

  // Vite's hashed assets can stay cached for the lifetime of this build.
  const pathname = new URL(url).pathname
  const immutableAsset = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\./.test(pathname) || /^\/tools\/providers\/[a-f0-9]{64}\//.test(pathname)

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    // A preload and a module request can carry different Origin headers.
    // The same-origin hash identifies the asset across those variants.
    const sameOrigin = new URL(url).origin === self.location.origin
    const cached = await cache.match(event.request, immutableAsset && sameOrigin ? { ignoreVary: true } : undefined)
    if (immutableAsset && cached) return cached

    // A browser HTTP cache hit can yield a bare 304 to a service worker.
    // Fetch a complete response whenever Cache Storage has no immutable asset.
    try {
      const response = await fetch(event.request, immutableAsset ? { cache: 'reload' } : undefined)
      if (response.status === 304 && cached) return cached
      if (response.ok) {
        const write = cache.put(event.request, response.clone()).catch(() => {})
        if (immutableAsset) await write
        else event.waitUntil(write)
      }
      return response
    } catch (error) {
      if (cached) return cached
      // The first visit can register this worker after its navigation already
      // finished. Restore the app shell for document/query URLs on offline reload.
      if (sameOrigin && event.request.mode === 'navigate' && (pathname === '/' || pathname === '/index.html')) {
        const shell = await cache.match('/index.html')
        if (shell) return shell
      }
      throw error
    }
  })())
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
        caches.open(CACHE_NAME).then(cache => Promise.allSettled(urls.map(async url => {
          if (!await cache.match(url)) await cache.add(new Request(url, { cache: 'reload' }))
        })))
      )
    }
  }
})
