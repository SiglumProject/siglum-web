import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
  ],
  define: {
    global: 'globalThis',
  },
  worker: {
    format: 'es'
  },
  build: {
    target: 'esnext',
    rollupOptions: {
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
          'pdf': ['pdfjs-dist'],
          'git': ['isomorphic-git', 'buffer'],
          'react-vendor': ['react', 'react-dom', 'react-resizable-panels'],
        },
      },
    },
  },
  server: {
    // Enable SharedArrayBuffer for WASM workers
    // (localhost is a secure context, network access needs HTTPS)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
