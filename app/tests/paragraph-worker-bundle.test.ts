import { test, expect } from 'bun:test'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { bundleParagraphWorker } from '../scripts/bundleParagraphWorker'

test('the built classic-worker helper exposes its font list and runtime factory', async () => {
  const script = await bundleParagraphWorker(resolve(import.meta.dir, '../src/services/paragraph.mjs'))
  const scope: Record<string, unknown> = {}
  runInNewContext(script, scope)
  expect(scope.FONT_NAMES).toEqual(['cmr10', 'cmr7', 'cmr5', 'cmmi10', 'cmmi7', 'cmmi5', 'cmsy10', 'cmsy7', 'cmsy5', 'cmex10'])
  expect(typeof scope.createParagraphRuntime).toBe('function')
})
