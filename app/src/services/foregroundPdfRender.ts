import type { RenderTask } from 'pdfjs-dist/types/src/display/api'
import { checkpointPreviewEnabled } from './CheckpointCompiler'

/** Experimental scheduling adapter for the installed PDF.js version.
 * Rendering still uses PDF.js, its cancellation and its bounded operator chunks.
 * Capability failure keeps the ordinary frame-scheduled renderer.
 */
export function scheduleForegroundPdfRender(task: RenderTask): boolean {
  if (!checkpointPreviewEnabled) return false
  const internal = (task as unknown as {
    _internalRenderTask?: { _useRequestAnimationFrame?: boolean }
  })._internalRenderTask
  if (!internal || typeof internal._useRequestAnimationFrame !== 'boolean' || task.onContinue) return false
  internal._useRequestAnimationFrame = false
  let sliceStarted = performance.now()
  task.onContinue = (resume: () => void) => {
    if (performance.now() - sliceStarted < 8) resume()
    else setTimeout(() => { sliceStarted = performance.now(); resume() }, 0)
  }
  return true
}
