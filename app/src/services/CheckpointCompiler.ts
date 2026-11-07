/** Binary selection is separate from checkpointing: split pdfTeX and the
 * matching combined XeTeX runtime both use the ordinary SDK checkpoint driver. */
import API_URL from '@siglum/engine/checkpoint?url'
import GLUE_URL from '../assets/checkpoint/pdftex.js?url'
import WASM_URL from '../assets/checkpoint/pdftex.wasm?url'
import IO_GLUE_URL from '../assets/checkpoint/pdftex-io.js?url'
import IO_WASM_URL from '../assets/checkpoint/pdftex-io.wasm?url'
import { checkpointIdentity, checkpointIoIdentity } from './checkpointRuntime'

// Enable the validated runtime at the ordinary local editor URL. Keep an
// explicit legacy control for profiling; production activation is separate.
export const checkpointPreviewEnabled = (import.meta.env.DEV || import.meta.env.MODE === 'local-preview')
  && !new URLSearchParams(location.search).has('legacyEngine')
// The ordinary fast-preview URL selects the tested low-memory I/O runtime.
// The SDK capability check preserves the normal resolver without shared memory.
export const syncInputEnabled = checkpointPreviewEnabled && !new URLSearchParams(location.search).has('legacyInputs')
export const checkpointRuntime = {
  apiUrl: new URL(API_URL, location.origin).href,
  jsUrl: new URL(syncInputEnabled ? IO_GLUE_URL : GLUE_URL, location.origin).href,
  wasmUrl: new URL(syncInputEnabled ? IO_WASM_URL : WASM_URL, location.origin).href,
  identity: syncInputEnabled ? checkpointIoIdentity : checkpointIdentity,
  syncInputs: syncInputEnabled,
  maximumBytes: 48 * 1024 * 1024,
  engines: ['pdflatex', 'xelatex'],
}
export type CheckpointOptions = {
  mainFile?: string
  projectId?: string
  additionalFiles?: Record<string, string | Uint8Array>
  focus?: { path: string; offsetUTF16?: number; line?: number }
  cachePreamble?: boolean
  forceFull?: boolean
}
