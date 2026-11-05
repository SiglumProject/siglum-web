import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

export function prerenderLanding(): Plugin {
  return {
    name: 'prerender-landing',
    apply: 'build',
    async transformIndexHtml(html) {
      const marker = '<!--landing-html-->'
      if (!html.includes(marker)) throw new Error('Landing HTML marker is missing')

      const server = await createServer({
        root: import.meta.dirname,
        configFile: false,
        appType: 'custom',
        plugins: [react()],
        server: { middlewareMode: true, watch: null, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
      })
      try {
        const { default: EmptyState } = await server.ssrLoadModule('/src/components/EmptyState.tsx')
        const landing = renderToStaticMarkup(createElement(
          'div',
          { className: 'app', 'data-prerendered': '' },
          createElement(EmptyState),
        ))
        return html.replace(marker, landing)
      } finally {
        await server.close()
      }
    },
  }
}
