/** Select hosted assets for the installed npm SDK. No sibling checkout needed. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SERVICE = 'https://packages.siglum.org'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
type Selection = { version: string; manifestUrl: string; manifestText: string; manifestSha256: string }
type Options = { version: string; year: number; cacheFile: string; fetchResource?: typeof fetch }

function verify(selection: Selection, version: string, year: number) {
  if (selection.version !== version || digest(selection.manifestText) !== selection.manifestSha256) throw new Error('Hosted runtime metadata does not match this SDK')
  const manifest = JSON.parse(selection.manifestText)
  if (manifest.engineVersion !== version || manifest.texLiveYear !== year || !manifest.files || Array.isArray(manifest.files)) throw new Error('Hosted runtime is incompatible with this SDK')
  const identity = { texLiveYear: manifest.texLiveYear, engineVersion: manifest.engineVersion, files: manifest.files }
  const releaseId = `tl${year}-${digest(JSON.stringify(identity)).slice(0, 16)}`
  if (manifest.releaseId !== releaseId || selection.manifestUrl !== `${SERVICE}/releases/${releaseId}/runtime.json`) throw new Error('Hosted runtime identity is invalid')
  for (const name of ['wasm/busytex.js', 'wasm/busytex.wasm', 'bundles.json', 'file-manifest.json', 'xzwasm.js']) {
    const file = manifest.files[name]
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Hosted runtime is missing valid ${name}`)
  }
  return { apiBase: SERVICE, releaseId }
}

class NetworkError extends Error {}

export async function resolveHostedRuntime({ version, year, cacheFile, fetchResource = fetch }: Options) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) throw new Error('Invalid installed SDK version')
  const request = async (url: string) => {
    let response: Response
    try { response = await fetchResource(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) }) }
    catch (cause) { throw new NetworkError('Could not reach runtime metadata service', { cause }) }
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new NetworkError(`Runtime metadata: HTTP ${response.status}`)
    return response
  }
  const readText = async (response: Response) => {
    try { return await response.text() }
    catch (cause) { throw new NetworkError('Could not read runtime metadata response', { cause }) }
  }
  try {
    const response = await request(`${SERVICE}/engines/${encodeURIComponent(version)}/latest.json`)
    let manifestUrl: string
    let expectedDigest: string | undefined
    if (response.status === 404) {
      // Releases before discovery was introduced link their manifest in the notes.
      const release = await request(`https://api.github.com/repos/SiglumProject/siglum/releases/tags/v${version}`)
      if (!release.ok) throw new Error(`No hosted runtime published for installed SDK ${version}`)
      const metadata = JSON.parse(await readText(release)) as { body?: unknown; tag_name?: unknown; draft?: unknown }
      const links = [...new Set(String(metadata.body ?? '').match(/https:\/\/packages\.siglum\.org\/releases\/tl\d{4}-[a-f0-9]{16}\/runtime\.json/g) ?? [])]
      if (metadata.tag_name !== `v${version}` || metadata.draft || links.length !== 1) throw new Error('Release metadata does not identify one compatible runtime')
      manifestUrl = links[0]
    } else {
      if (!response.ok) throw new Error(`Runtime discovery: HTTP ${response.status}`)
      const descriptor = JSON.parse(await readText(response)) as Record<string, unknown>
      if (descriptor.schemaVersion !== 1 || descriptor.engineVersion !== version ||
          typeof descriptor.releaseId !== 'string' || typeof descriptor.manifestUrl !== 'string' ||
          typeof descriptor.manifestSha256 !== 'string' ||
          !/^tl\d{4}-[a-f0-9]{16}$/.test(descriptor.releaseId) ||
          descriptor.baseUrl !== `${SERVICE}/releases/${descriptor.releaseId}` ||
          descriptor.manifestUrl !== `${descriptor.baseUrl}/runtime.json` ||
          !/^[a-f0-9]{64}$/.test(descriptor.manifestSha256)) throw new Error('Invalid hosted runtime descriptor')
      manifestUrl = descriptor.manifestUrl
      expectedDigest = descriptor.manifestSha256
    }
    const manifestResponse = await request(manifestUrl)
    if (!manifestResponse.ok) throw new Error(`Runtime manifest: HTTP ${manifestResponse.status}`)
    const manifestText = await readText(manifestResponse)
    const selection = { version, manifestUrl, manifestText, manifestSha256: expectedDigest ?? digest(manifestText) }
    const result = verify(selection, version, year)
    try {
      await mkdir(dirname(cacheFile), { recursive: true })
      await writeFile(cacheFile, JSON.stringify(selection) + '\n')
    } catch { console.warn('Could not cache hosted runtime metadata; starting offline may require explicit runtime configuration.') }
    return result
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error
    try { return verify(JSON.parse(await readFile(cacheFile, 'utf8')), version, year) }
    catch { throw new Error('Hosted runtime metadata is unavailable. Connect once to select compatible assets, or set VITE_API_BASE and VITE_ENGINE_RELEASE for your own runtime.', { cause: error }) }
  }
}

export async function resolveInstalledRuntime(appDirectory: string) {
  const require = createRequire(resolve(appDirectory, 'package.json'))
  let directory = dirname(require.resolve('@siglum/engine'))
  let info
  while (true) {
    try { info = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) } catch { /* entry can be in src/ or dist/ */ }
    if (info?.name === '@siglum/engine') break
    const parent = dirname(directory)
    if (parent === directory) throw new Error('Could not locate the installed engine package metadata')
    directory = parent
  }
  const { TEXLIVE_YEAR } = await import(pathToFileURL(require.resolve('@siglum/engine/texlive')).href)
  return resolveHostedRuntime({ version: info.version, year: TEXLIVE_YEAR,
    cacheFile: resolve(appDirectory, '../.local-release/hosted-runtime.json') })
}
