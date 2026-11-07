import { defineConfig, searchForWorkspaceRoot, loadEnv } from 'vite'
import type { UserConfig } from 'vite'
import { refreshCheckpointAssets } from './scripts/checkpointAssets'
import { browserToolsPlugin } from './scripts/browserToolsPlugin'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { resolve, dirname } from 'path'
import { copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { prerenderLanding } from './prerender'
import { resolveInstalledRuntime } from '../scripts/hosted-runtime'

const require = createRequire(import.meta.url)
const engineDirectory = dirname(require.resolve('@siglum/engine'))

// https://vite.dev/config/
export default defineConfig(async ({ command, mode }): Promise<UserConfig> => {
  const env = loadEnv(mode, __dirname, 'VITE_')
  const hosted = !env.VITE_API_BASE && !env.VITE_ENGINE_RELEASE
    ? await resolveInstalledRuntime(__dirname)
    : null
  return ({
  // Keep diagnostics in dev; remove routine logs from application and dependency bundles.
  // Warnings, errors, and compiler log callbacks remain intact.
  esbuild: command === 'build' ? { pure: ['console.log', 'console.info', 'console.debug'] } : undefined,
  plugins: [
    browserToolsPlugin(__dirname),
    {
      name: 'sync-engine-worker',
      configResolved(config) {
        refreshCheckpointAssets(__dirname)
        copyFileSync(resolve(engineDirectory, 'worker.js'), resolve(__dirname, 'public/worker.js'))
        if (hosted) {
          config.env.VITE_API_BASE = hosted.apiBase
          config.env.VITE_ENGINE_RELEASE = hosted.releaseId
        }
        const api = config.env.VITE_API_BASE
        if (config.command === 'build' && config.mode === 'production') {
          if (!/^tl\d{4}-[a-f0-9]{16}$/.test(config.env.VITE_ENGINE_RELEASE || '')) throw new Error('Production builds require VITE_ENGINE_RELEASE from the staged runtime manifest.');
          if (!api) throw new Error('Set VITE_API_BASE to the deployed engine for a production build. Use bun run build:local for local preview.')
          const hostname = new URL(api).hostname
          if (new URL(api).protocol !== 'https:' || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]') {
            throw new Error('Production API must use an HTTPS deployment URL. Use bun run build:local for local preview.')
          }
        }
      },
      configureServer(server) {
        const worker = resolve(engineDirectory, 'worker.js')
        const inputs = [worker, resolve(engineDirectory, 'checkpoint-api.bundle.mjs'),
          resolve(__dirname, 'src/assets/checkpoint/pdftex.js'), resolve(__dirname, 'src/assets/checkpoint/pdftex.wasm'),
          resolve(__dirname, 'src/assets/checkpoint/pdftex-io.js'), resolve(__dirname, 'src/assets/checkpoint/pdftex-io.wasm')]
        server.watcher.add(inputs)
        const changed = (path: string) => {
          if (!inputs.includes(path)) return
          copyFileSync(worker, resolve(__dirname, 'public/worker.js'))
          refreshCheckpointAssets(__dirname)
          server.ws.send({ type: 'full-reload' })
        }
        server.watcher.on('change', changed)
        server.httpServer?.once('close', () => server.watcher.off('change', changed))
      },
      buildStart() {
        if (command === 'build') {
          copyFileSync(resolve(engineDirectory, 'worker.js'), resolve(__dirname, 'public/worker.js'))
        }
      },
    },
    react(),
    wasm(),
    prerenderLanding(),
  ],
  define: {
    global: 'globalThis',
    ...(hosted ? {
      'import.meta.env.VITE_API_BASE': JSON.stringify(hosted.apiBase),
      'import.meta.env.VITE_ENGINE_RELEASE': JSON.stringify(hosted.releaseId),
    } : {}),
  },
  optimizeDeps: {
    exclude: ['blake3-wasm', '@siglum/filesystem', '@siglum/engine'],
    include: ['buffer'],
  },
  resolve: {
    // All packages must share the same filesystem singleton and mounted roots.
    dedupe: ['@siglum/filesystem'],
    alias: {
      // blake3-wasm has broken ESM exports with Vite - use stub (DJB2 fallback)
      'blake3-wasm/browser.js': resolve(__dirname, 'src/lib/blake3-stub.js'),
    },
  },
  worker: {
    format: 'es'
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      external: ['blake3-wasm'],
      output: {
        manualChunks: {
          // Split vendor chunks for better caching
          'codemirror': [
            '@codemirror/autocomplete',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/lint',
            '@codemirror/state',
            '@codemirror/view',
            '@lezer/highlight',
            'codemirror',
            'codemirror-lang-latex',
          ],
          'pdf': ['pdfjs-dist/legacy/build/pdf.mjs'],
          'git': ['isomorphic-git', 'buffer'],
          'react-vendor': ['react', 'react-dom', 'react-resizable-panels'],
        },
      },
    },
  },
  server: {
    fs: {
      // Worker helpers and binary assets in the linked SDK are loaded by URL.
      allow: [searchForWorkspaceRoot(__dirname), engineDirectory],
    },
    port: 5174,
    proxy: {
      '/citations/api/zotero': {
        target: 'https://api.zotero.org',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/citations\/api\/zotero/, ''),
      },
      '/engine': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/engine/, ''),
      },
    },
    // Enable SharedArrayBuffer for WASM workers
    // (localhost is a secure context, network access needs HTTPS)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Tauri expects a fixed port, fail if that port is not available
    strictPort: true,
  },
  preview: {
    // Same headers for preview server
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  })
})
