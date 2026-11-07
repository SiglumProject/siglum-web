import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
export function refreshCheckpointAssets(root: string) {
  const require = createRequire(resolve(root, 'package.json'))
  const engine = dirname(require.resolve('@siglum/engine'))
  const hash = createHash('sha256')
  for (const path of [resolve(engine, 'checkpoint-api.bundle.mjs'), resolve(engine, 'worker.js'),
    resolve(root, 'src/assets/checkpoint/pdftex.js'), resolve(root, 'src/assets/checkpoint/pdftex.wasm')]) {
    hash.update(readFileSync(path))
  }
  const ioHash = createHash('sha256')
  for (const path of [resolve(engine, 'checkpoint-api.bundle.mjs'), resolve(engine, 'worker.js'),
    resolve(root, 'src/assets/checkpoint/pdftex-io.js'), resolve(root, 'src/assets/checkpoint/pdftex-io.wasm')]) {
    if (existsSync(path)) ioHash.update(readFileSync(path))
  }
  const text = `// Generated from the native runtime and worker semantics.\nexport const checkpointIdentity = '${hash.digest('hex').slice(0, 24)}'\nexport const checkpointIoIdentity = '${ioHash.digest('hex').slice(0, 24)}'\n`
  const target = resolve(root, 'src/services/checkpointRuntime.ts')
  if (!existsSync(target) || readFileSync(target, 'utf8') !== text) writeFileSync(target, text)
}
