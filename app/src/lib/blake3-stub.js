// Stub for blake3-wasm - the actual module has ESM issues with Vite
// The siglum-engine hash.js will fall back to DJB2 when this fails to load
export function hash() {
  throw new Error('blake3-wasm stub - use DJB2 fallback');
}
