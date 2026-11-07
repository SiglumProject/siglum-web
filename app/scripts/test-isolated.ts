import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Bun module mocks survive mock.restore(). Each suite gets its own process so
// compiler-service doubles cannot replace the real service in another suite.
const files = readdirSync('tests', { recursive: true }).filter((name): name is string =>
  typeof name === 'string' && /\.test\.tsx?$/.test(name)).sort()
for (const file of files) {
  const run = Bun.spawn([process.execPath, 'test', resolve('tests', file)], { stdout: 'inherit', stderr: 'inherit' })
  const status = await run.exited
  if (status !== 0) process.exit(status)
}
