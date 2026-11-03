/** Local development across the four repositories. No publish or Git mutations. */
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'

const ui = resolve(import.meta.dir, '..')
const code = resolve(ui, '../..')
const repos = {
  filesystem: resolve(code, 'siglum-filesystem'),
  git: resolve(code, 'siglum-git'),
  engine: resolve(code, 'siglum-engine'),
  ui,
}
const bun = process.execPath
async function run(cwd: string, ...args: string[]) {
  console.log(`\n${cwd}: bun ${args.join(' ')}`)
  const child = Bun.spawn([bun, ...args], { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const status = await child.exited
  if (status !== 0) throw new Error(`${args.join(' ')} failed (${status})`)
}
for (const [name, path] of Object.entries(repos)) {
  if (!existsSync(resolve(path, 'package.json'))) throw new Error(`Missing ${name} checkout: ${path}`)
}
function checkAssets() {
  for (const path of ['busytex/build/wasm/busytex.js', 'busytex/build/wasm/busytex.wasm', 'busytex.js', 'busytex.wasm', 'dist/busytex.js', 'dist/busytex.wasm', 'packages/bundles/bundles.json', 'packages/bundles/file-manifest.json']) {
    if (!existsSync(resolve(repos.engine, path))) throw new Error(`Missing engine runtime: ${path}. Restore/build the TeX Live 2026 assets first.`)
  }
}
async function prepare() {
  await run(ui, 'install', '--frozen-lockfile', '--ignore-scripts')
  await run(repos.filesystem, 'run', 'build')
  await run(repos.git, 'run', 'build')
  await run(repos.engine, 'run', 'build:types')
  await run(repos.engine, 'run', 'prepare:runtime')
  await run(resolve(ui, 'app'), 'run', 'postinstall')
  checkAssets()
}
async function check() {
  await prepare()
  await run(repos.filesystem, 'test')
  await run(repos.git, 'test', 'tests')
  for (const task of ['test:run', 'test:browser:run', 'test:types', 'test:proxy', 'test:bun-parity']) {
    await run(repos.engine, 'run', task)
  }
  await run(resolve(ui, 'app'), 'run', 'test')
  await run(resolve(ui, 'worker'), 'run', 'check')
  await run(resolve(ui, 'worker'), 'run', 'test')
  await run(ui, 'run', 'build:local')
  console.log('\nAll four repositories passed. Local preview build: app/dist. Nothing published.')
}
async function start(lan = false) {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === 'IPv4')?.address
  if (lan && !address) throw new Error('No local network address found')
  const uiHost = lan ? '0.0.0.0' : '127.0.0.1'
  const uiUrl = `http://${lan ? address : '127.0.0.1'}:5174/`
  checkAssets()
  const children: ReturnType<typeof Bun.spawn>[] = []
  const stop = () => { for (const child of children) child.kill() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const endpoints = [
    { url: 'http://127.0.0.1:8787/health', cwd: repos.engine, args: ['run', 'dev'], signature: 'siglum-local-dev' },
    { url: uiUrl, cwd: resolve(ui, 'app'), args: ['run', 'dev', '--host', uiHost, '--port', '5174'], signature: '/src/main.tsx' },
  ]
  try {
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(1500) }).catch(() => null)
      if (response) {
        if (!response.ok || !(await response.text()).includes(endpoint.signature)) throw new Error(`Another service is using ${endpoint.url}`)
        console.log(`Already running: ${endpoint.url}`)
        continue
      }
      children.push(Bun.spawn([bun, ...endpoint.args], { cwd: endpoint.cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' }))
    }
    console.log(`Siglum: ${uiUrl} (Ctrl+C stops only servers started by this command)`)
    if (children.length) {
      const code = await Promise.race(children.map(child => child.exited))
      if (code !== 0) throw new Error(`A local server stopped (${code})`)
    }
  } finally { stop() }
}
const command = process.argv[2]
if (command === 'prepare') await prepare()
else if (command === 'check') await check()
else if (command === 'start') await start()
else if (command === 'start-lan') await start(true)
else throw new Error('Usage: bun scripts/local-workspace.ts prepare|check|start|start-lan')
