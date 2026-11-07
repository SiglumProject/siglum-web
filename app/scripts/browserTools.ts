import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync, renameSync, lstatSync, realpathSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'

type ProviderSpec = { command: string; kind: 'process' | 'auxiliary'; directory: string; adapter: string; export: string; worker: string; scripts: string[]; connect: string[]; wasm?: boolean }
export type ToolWorkerPolicy = { worker: string; scripts: string[]; connect: string[]; wasm: boolean }
const relative = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\\\0\r\n:?#]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..')
function atomic(path: string, value: string) {
  if (existsSync(path) && readFileSync(path, 'utf8') === value) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path + '.tmp', value)
  renameSync(path + '.tmp', path)
}

/** Content addressing is automatic: changing an adapter, bridge, wheel or notice changes its URL. */
export function prepareBrowserTools(app: string): ToolWorkerPolicy[] {
  const source = join(app, 'tools')
  const specs: ProviderSpec[] = JSON.parse(readFileSync(join(source, 'providers.json'), 'utf8'))
  if (!Array.isArray(specs)) throw Error('Tool providers must be an array')
  const commands = new Set<string>(), policies: ToolWorkerPolicy[] = [], registrations: string[] = []
  for (const spec of specs) {
    if (!spec || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/.test(spec.command) || commands.has(spec.command)
      || !['process', 'auxiliary'].includes(spec.kind) || !relative(spec.directory) || !relative(spec.adapter)
      || !relative(spec.worker) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(spec.export)
      || !Array.isArray(spec.scripts) || !Array.isArray(spec.connect)
      || [...spec.scripts, ...spec.connect].some(path => !relative(path.replace(/\/$/, '')))) throw Error('Invalid tool provider manifest')
    commands.add(spec.command)
    const root = resolve(source, spec.directory), files: string[] = []
    if (lstatSync(root).isSymbolicLink() || !realpathSync(root).startsWith(realpathSync(source) + '/')) throw Error('Tool assets escape their source directory')
    const visit = (directory: string) => {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name), stat = lstatSync(path)
        if (stat.isSymbolicLink()) throw Error('Tool assets must not contain symlinks')
        if (stat.isDirectory()) visit(path)
        else if (stat.isFile()) files.push(path.slice(root.length + 1))
        else throw Error('Unsupported tool asset')
      }
    }
    visit(root)
    if (files.includes('provider-policy.json')) throw Error('Reserved tool asset name')
    if (![spec.adapter, spec.worker, ...spec.scripts].every(path => files.includes(path))) throw Error('Missing provider entry point')
    const hash = createHash('sha256')
    hash.update(JSON.stringify(spec) + '\0')
    for (const path of files) { const data = readFileSync(join(root, path)); hash.update(path + '\0' + data.length + '\0'); hash.update(data) }
    const revision = hash.digest('hex'), prefix = '/tools/providers/' + revision + '/'
    for (const path of files) {
      const target = join(app, 'public', prefix, path)
      mkdirSync(dirname(target), { recursive: true })
      if (existsSync(target)) {
        if (!readFileSync(target).equals(readFileSync(join(root, path)))) throw Error('Immutable tool asset mismatch')
      } else copyFileSync(join(root, path), target)
    }
    const policy = { worker: prefix + spec.worker, scripts: spec.scripts.map(path => prefix + path), connect: spec.connect.map(path => prefix + path), wasm: !!spec.wasm }
    atomic(join(app, 'public', prefix, 'provider-policy.json'), JSON.stringify(policy, null, 2) + '\n')
    policies.push(policy)
    registrations.push(`  { command: ${JSON.stringify(spec.command)}, kind: ${JSON.stringify(spec.kind)}, revision: ${JSON.stringify(revision)}, run: async (request, context) => (await loadTool(${JSON.stringify(prefix + spec.adapter)}))[${JSON.stringify(spec.export)}](request, context) }`)
  }
  // Keep descriptors for immutable assets referenced by older cached application builds.
  const previous = join(app, 'public/tools/providers.json')
  if (existsSync(previous)) {
    for (const policy of JSON.parse(readFileSync(previous, 'utf8')) as ToolWorkerPolicy[]) {
      const prefix = policy.worker?.match(/^\/tools\/providers\/[a-f0-9]{64}\//)?.[0]
      if (!prefix || ![...policy.scripts, ...policy.connect].every(path => path.startsWith(prefix))) throw Error('Invalid previous tool policy')
      const target = join(app, 'public', prefix, 'provider-policy.json')
      if (!existsSync(target)) atomic(target, JSON.stringify(policy, null, 2) + '\n')
    }
  }
  atomic(join(app, 'public/tools/providers.json'), JSON.stringify(policies, null, 2) + '\n')
  atomic(join(app, 'src/generated/browserTools.ts'), "// Generated by scripts/browserTools.ts; edit tools/providers.json and provider sources.\nimport type { ToolProvider } from '@siglum/engine/process-tools'\nconst loadTool = (path: string) => import(/* @vite-ignore */ path)\nexport const browserTools: ToolProvider[] = [\n" + registrations.join(',\n') + '\n]\n')
  return policies
}

export function toolWorkerCsp(policy: ToolWorkerPolicy, origin: string): string {
  return "default-src 'none'; script-src " + ([policy.wasm ? "'wasm-unsafe-eval'" : '', ...policy.scripts.map(path => new URL(path, origin).href)].filter(Boolean).join(' ') || "'none'") + '; connect-src ' + (policy.connect.map(path => new URL(path, origin).href).join(' ') || "'none'")
}
