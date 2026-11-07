import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { prepareBrowserTools, toolWorkerCsp, type ToolWorkerPolicy } from './browserTools'

/** The policy travels with the immutable provider, including older cached versions. */
export function toolPolicyMiddleware(publicRoot: string) {
  return (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    let pathname: string
    try { pathname = decodeURIComponent((request.url || '').split('?')[0]) }
    catch (error) { next(error); return }
    const provider = pathname.match(/^\/tools\/providers\/([a-f0-9]{64})\//)
    if (!provider) { next(); return }
    const descriptor = resolve(publicRoot, 'tools/providers', provider[1], 'provider-policy.json')
    try {
      if (!existsSync(descriptor)) { response.statusCode = 404; response.end('Unknown tool provider'); return }
      const policy: ToolWorkerPolicy = JSON.parse(readFileSync(descriptor, 'utf8'))
      if (policy.worker === pathname) {
        const https = 'encrypted' in request.socket && request.socket.encrypted
        const origin = (https ? 'https://' : 'http://') + request.headers.host
        response.setHeader('Content-Security-Policy', toolWorkerCsp(policy, origin))
      }
      // Packaged runtimes are opaque immutable assets, including ?import requests.
      // Letting the dev transform pipeline rewrite them breaks their loader protocol.
      const root = resolve(publicRoot, 'tools/providers', provider[1])
      const file = resolve(publicRoot, '.' + pathname)
      if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) {
        response.statusCode = 404; response.end('Unknown tool asset'); return
      }
      const type = /\.m?js$/.test(file) ? 'text/javascript' : /\.wasm$/.test(file) ? 'application/wasm'
        : /\.json$/.test(file) ? 'application/json' : 'application/octet-stream'
      // A raw route bypasses Vite's later headers middleware. Workers must
      // retain the parent's embedder policy to stay cross-origin isolated.
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      response.setHeader('Content-Type', type)
      response.setHeader('Content-Length', statSync(file).size)
      response.setHeader('Cache-Control', 'public,max-age=31536000,immutable')
      if (request.method === 'HEAD') { response.end(); return }
      createReadStream(file).on('error', error => {
        if (response.headersSent) response.destroy(error)
        else next(error)
      }).pipe(response)
    } catch (error) { next(error) }
  }
}

export function browserToolsPlugin(appRoot: string): Plugin {
  return {
    name: 'siglum-browser-tools',
    configResolved() { prepareBrowserTools(appRoot) },
    configureServer(server) {
      server.middlewares.use(toolPolicyMiddleware(resolve(appRoot, 'public')))
    },
    configurePreviewServer(server) {
      server.middlewares.use(toolPolicyMiddleware(resolve(appRoot, server.config.build.outDir)))
    },
  }
}
