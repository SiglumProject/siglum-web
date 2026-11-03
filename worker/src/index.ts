// Cloudflare Worker for siglum.org subdomains
// Routes based on hostname:
//   packages.siglum.org - R2 bundle/WASM serving
//   ctan-proxy.siglum.org - CTAN package proxy (JSON processed)
//   + /api/texlive/{pkg} - Raw TexLive .tar.xz proxy (client decompresses)

import { unzipSync } from 'fflate';

// ============================================================================
// TexLive Configuration
// ============================================================================

import { TEXLIVE_YEAR, SUPPORTED_TL_YEARS, fetchTexLiveArchive } from '@siglum/engine/texlive';
type TLYear = number;
const DEFAULT_TL_YEAR = TEXLIVE_YEAR;

interface Env {
  BUNDLES: R2Bucket;
  RUNTIME_PREFIX?: string;
}

// ============================================================================
// Extraction Constants (ported from ctan-core.ts)
// ============================================================================

interface ProcessedFile {
  path: string;
  content: string;
  encoding?: 'base64';
}

interface ProcessedPackage {
  name: string;
  files: Record<string, ProcessedFile>;
  totalFiles: number;
  dependencies: string[];
  source?: string;
  texlivePackage?: string;
  useTexLive?: boolean;
  message?: string;
}

const TEX_EXTENSIONS = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo', '.ltx'];
const FONT_EXTENSIONS = ['.pfb', '.pfm', '.afm', '.tfm', '.vf', '.map', '.enc'];
const REQUIRE_PACKAGE_REGEX = /\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
const VALID_PACKAGE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9\-]*$/;

function isValidPackageName(name: string): boolean {
  if (!name || name.length === 0) return false;
  return VALID_PACKAGE_NAME_REGEX.test(name);
}

function extractDependencies(content: string, excludePkg?: string): string[] {
  const deps = new Set<string>();
  // Reset regex lastIndex for global regex
  const regex = /\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
  for (const match of content.matchAll(regex)) {
    match[1].split(',').map(d => d.trim()).filter(isValidPackageName).forEach(d => deps.add(d));
  }
  if (excludePkg) {
    deps.delete(excludePkg);
  }
  return [...deps];
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, Zotero-API-Key, Zotero-API-Version',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
};

// Bump this to invalidate edge cache for all files
// v24: TeX Live 2026 bundles + WASM engine
// v23: normalized-artifact cache (serve prebuilt build-required packages from R2)
const CACHE_VERSION = 'tl2026-v1';

// Bump this to invalidate CTAN cache in R2 (when path mapping changes)
// v7: TL2026 + normalize pipeline (TDS-routing fix, provider chain) reprocesses packages
// v6: Updated file format to include path field, TL2025 default
const CTAN_CACHE_VERSION = 'tl2026-v8';

// Bootstrap aliases for packages where CTAN lookup fails
const bootstrapAliases: Record<string, string> = {
  'etex': 'etex-pkg',
  'tikz': 'pgf',
};

// Font-file → package index (committed bundle artifact, uploaded to R2 by
// upload-to-r2.sh). TeX requests missing fonts by file stem (phvr8t, ec-lmr10,
// …) which name no package; this maps the stem to its TeX Live package. Cached
// in the isolate after first load. Built by scripts/build-font-file-index.js.
const fontIndexes = new Map<string, Record<string, string>>();
const FONT_FILE_STEM_EXT = /\.(tfm|vf|pfb|pfm|afm|otf|ttf|ttc|map|enc)$/i;

async function getFontFileIndex(env: Env): Promise<Record<string, string>> {
  const prefix = env.RUNTIME_PREFIX || '';
  const cached = fontIndexes.get(prefix); if (cached) return cached;
  let fontFileIndex: Record<string,string>;
  try {
    const obj = await env.BUNDLES.get(prefix + 'font-file-to-package.json');
    fontFileIndex = obj ? ((await obj.json()) as Record<string, string>) : {};
  } catch {
    fontFileIndex = {};
  }
  fontIndexes.set(prefix, fontFileIndex);
  return fontFileIndex;
}

async function resolveFontStem(name: string, env: Env): Promise<string | null> {
  const idx = await getFontFileIndex(env);
  const stem = name.replace(FONT_FILE_STEM_EXT, '');
  return idx[name] || idx[stem] || null;
}

// Normalized-artifact cache (docs/normalized-artifact-cache-plan.md §0/§2). The
// offline prebuild normalizes build-required packages (source-only .ins/.dtx,
// .tds.zip, …) once and ships the result to R2 under normalized/<pkg>.json (via
// upload-to-r2.sh, from packages/bundles/prebuilt/). The Worker serves that
// artifact verbatim — the only way these packages can work in production, since
// a Worker cannot run a WASM TeX build in-request.
//
// Manifest of prebuilt package names, loaded once per isolate from R2 — the same
// pattern as getFontFileIndex above. Gating on it means a lookup for a
// non-prebuilt package (the overwhelming majority) is a Set.has() and skips the
// per-package R2 GET; only a true hit fetches the (large) artifact. The manifest
// (normalized/_index.json) is produced by scripts/prebuild-packages.js and
// shipped by upload-to-r2.sh — the artifacts are not committed to the repo.
const NAME_OK = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const normalizedIndexes = new Map<string, Set<string>>();

async function getNormalizedNames(env: Env): Promise<Set<string>> {
  const prefix = env.RUNTIME_PREFIX || '';
  const cached = normalizedIndexes.get(prefix); if (cached) return cached;
  let normalizedNames: Set<string>;
  try {
    const obj = await env.BUNDLES.get(prefix + 'normalized/_index.json');
    const list = obj ? ((await obj.json()) as string[]) : [];
    normalizedNames = new Set(Array.isArray(list) ? list : []);
  } catch {
    normalizedNames = new Set(); // no manifest yet → behaves as no-cache
  }
  normalizedIndexes.set(prefix, normalizedNames);
  return normalizedNames;
}

// Returns the artifact JSON string (already in ProcessedPackage shape) or null.
// pkgName may be CTAN-derived (parentPkg), so it is validated before it touches
// the R2 key — guards against key injection / traversal.
async function getNormalizedArtifact(pkgName: string, env: Env): Promise<string | null> {
  if (!NAME_OK.test(pkgName)) return null;
  const names = await getNormalizedNames(env);
  if (!names.has(pkgName)) return null; // not prebuilt → skip the per-package GET
  try {
    const obj = await env.BUNDLES.get(`${env.RUNTIME_PREFIX || ''}normalized/${pkgName}.json`);
    return obj ? await obj.text() : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status:405, headers:CORS_HEADERS});
    // Release IDs bind every static byte to a single, immutable runtime manifest.
    const release = url.pathname.match(/^\/releases\/(tl2026-[a-f0-9]{16})\/(.+)$/);
    if (release) {
      if (release[2].startsWith('api/')) {
        url.pathname = '/' + release[2];
        return handlePathBasedRouting(url, {...env, RUNTIME_PREFIX:`releases/${release[1]}/`}, request, ctx);
      }
      const file = release[2].replace(/^bundles\//, '');
      if (file.includes('..') || !/^[a-zA-Z0-9._/-]+$/.test(file)) return new Response('Invalid asset path',{status:400,headers:CORS_HEADERS});
      return handleR2Request(`releases/${release[1]}/${file}`, env, request, ctx);
    }

    // Handle path-based API routes early - ensures they work regardless of hostname routing
    // This is critical for wrangler dev --remote which simulates production hostnames
    if (url.pathname.startsWith('/api/zotero/')) return handleZotero(url, request);
  if (url.pathname.startsWith('/bundles/')) {
      const key = url.pathname.slice(9);
      return handleR2Request(key, env, request, ctx);
    }
    if (url.pathname.startsWith('/wasm/')) {
      return handleR2Request('wasm/' + url.pathname.slice(6), env, request, ctx);
    }
    if (url.pathname.startsWith('/api/')) {
      return handlePathBasedRouting(url, env, request, ctx);
    }
    if (url.pathname === '/xzwasm.js') {
      return handlePathBasedRouting(url, env, request, ctx);
    }
    // Root health check - always use path-based routing
    if (url.pathname === '/' || url.pathname === '/health') {
      return handlePathBasedRouting(url, env, request, ctx);
    }

    if (hostname === 'packages.siglum.org' || hostname.includes('packages')) {
      return handlePackagesHost(url, env, request, ctx);
    }

    if (hostname === 'ctan-proxy.siglum.org' || hostname.includes('ctan')) {
      return handleCtanProxyHost(url, env);
    }

    // Default: use path-based routing (for workers.dev domain during dev)
    return handlePathBasedRouting(url, env, request, ctx);
  },
};

// packages.siglum.org - serve R2 files directly at root
async function handlePackagesHost(url: URL, env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  const key = url.pathname.slice(1);

  if (!key || key === '' || key === 'health') {
    return jsonResponse({ status: 'ok', service: 'packages.siglum.org' });
  }

  return handleR2Request(key, env, request, ctx);
}

// ctan-proxy.siglum.org - CTAN package fetching
async function handleCtanProxyHost(url: URL, env: Env): Promise<Response> {
  let packageName = url.pathname.slice(1);

  if (packageName.startsWith('fetch/')) {
    packageName = packageName.slice(6);
  }

  if (!packageName || packageName === '' || packageName === 'health') {
    return jsonResponse({ status: 'ok', service: 'ctan-proxy.siglum.org' });
  }

  // Parse tlYear query parameter
  const tlYearParam = url.searchParams.get('tlYear');
  let tlYear: TLYear = DEFAULT_TL_YEAR;
  if (tlYearParam) {
    const year = Number(tlYearParam);
    if (SUPPORTED_TL_YEARS.includes(year as TLYear)) {
      tlYear = year as TLYear;
    }
  }

  return handleCtanFetch(packageName, env, tlYear);
}

// Path-based routing for workers.dev domain
async function handlePathBasedRouting(url: URL, env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  // Note: /bundles/ is now handled at the top of the fetch handler before hostname routing

  if (url.pathname.startsWith('/wasm/')) {
    return handleR2Request('wasm/' + url.pathname.slice(6), env, request, ctx);
  }

  const ctanMatch = url.pathname.match(/^\/api\/fetch\/(.+)$/);
  if (ctanMatch) {
    // Parse tlYear query parameter
    const tlYearParam = url.searchParams.get('tlYear');
    let tlYear: TLYear = DEFAULT_TL_YEAR;
    if (tlYearParam) {
      const year = Number(tlYearParam);
      if (SUPPORTED_TL_YEARS.includes(year as TLYear)) {
        tlYear = year as TLYear;
      } else {
        return jsonResponse({
          error: `Unsupported TexLive year: ${tlYearParam}. Supported: ${SUPPORTED_TL_YEARS.join(', ')}`
        }, 400);
      }
    }
    return handleCtanFetch(ctanMatch[1], env, tlYear);
  }

  // TexLive archive proxy - returns raw .tar.xz for client-side decompression
  const texliveMatch = url.pathname.match(/^\/api\/texlive\/(.+)$/);
  if (texliveMatch) {
    // Parse tlYear query parameter
    const tlYearParam = url.searchParams.get('tlYear');
    let tlYear: TLYear = DEFAULT_TL_YEAR;
    if (tlYearParam) {
      const year = Number(tlYearParam);
      if (SUPPORTED_TL_YEARS.includes(year as TLYear)) {
        tlYear = year as TLYear;
      } else { return jsonResponse({error:'Unsupported TeX Live year'},400); }
    }
    return handleTexLiveProxy(texliveMatch[1], env, tlYear);
  }

  // CTAN package info proxy - returns package metadata including contained_in
  const ctanPkgMatch = url.pathname.match(/^\/api\/ctan-pkg\/(.+)$/);
  if (ctanPkgMatch) {
    return handleCtanPkgInfo(ctanPkgMatch[1]);
  }

  // Serve xzwasm.js from R2 (brotli compressed)
  if (url.pathname === '/xzwasm.js') {
    const object = await env.BUNDLES.get('xzwasm.js.br');
    if (!object) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }
    return new Response(object.body, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/javascript',
        'Content-Encoding': 'br',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return jsonResponse({
      status: 'ok',
      service: 'siglum-api',
      texLiveYear: TEXLIVE_YEAR,
      endpoints: {
        packages: 'packages.siglum.org or /bundles/*',
        ctan: 'ctan-proxy.siglum.org or /api/fetch/*',
      }
    });
  }

  return new Response('Not found', { status: 404, headers: CORS_HEADERS });
}

async function handleR2Request(key: string, env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  const immutable = key.startsWith('releases/');
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('_cv', CACHE_VERSION);
  const cacheKey = new Request(cacheUrl.toString(), {method:'GET'});
  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader && request.method === 'GET') {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  }
  try {
    let range: {offset:number;length:number} | undefined;
    if (rangeHeader) {
      const meta = await env.BUNDLES.head(key);
      if (!meta) return new Response('Not found',{status:404,headers:CORS_HEADERS});
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      let start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0,meta.size-Number(match[2])) : NaN;
      let end = match?.[1] && match?.[2] ? Math.min(meta.size-1,Number(match[2])) : meta.size-1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= meta.size) {
        return new Response(null,{status:416,headers:{...CORS_HEADERS,'Content-Range':`bytes */${meta.size}`}});
      }
      range = {offset:start,length:end-start+1};
    }
    const object = await env.BUNDLES.get(key, range ? {range} : undefined);
    if (!object) return new Response('Not found',{status:404,headers:CORS_HEADERS});
    const type = key.endsWith('.wasm') ? 'application/wasm' : key.endsWith('.js') ? 'application/javascript' : key.endsWith('.json') ? 'application/json' : key.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream';
    const headers: Record<string,string> = {...CORS_HEADERS, 'Content-Type':type,
      'Cache-Control':immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'Accept-Ranges':'bytes', 'Content-Length':String(range?.length ?? object.size), 'ETag':object.httpEtag};
    if (range) headers['Content-Range'] = `bytes ${range.offset}-${range.offset+range.length-1}/${object.size}`;
    if (request.method === 'HEAD') { await object.body.cancel(); return new Response(null,{status:range?206:200,headers}); }
    const response = new Response(object.body,{status:range?206:200,headers});
    if (!range) ctx.waitUntil(caches.default.put(cacheKey,response.clone()));
    return response;
  } catch (error) { return jsonResponse({error:String(error)},502); }
}

async function handleTexLiveProxy(pkgName: string, env: Env, tlYear: TLYear = DEFAULT_TL_YEAR): Promise<Response> {
  try {
    // Validate package name
    if (!pkgName || pkgName.length < 2 || pkgName.length > 50) {
      return jsonResponse({ error: 'Invalid package name' }, 400);
    }
    if (/[^a-zA-Z0-9_-]/.test(pkgName)) {
      return jsonResponse({ error: 'Invalid package name characters' }, 400);
    }

    // Use year-suffixed cache key
    const cacheKey = `texlive-cache/tl${tlYear}/${pkgName}.tar.xz`;

    // Check R2 cache first
    const cached = await env.BUNDLES.get(cacheKey);
    if (cached) {
      console.log(`TexLive ${tlYear} cache hit for ${pkgName}`);
      return new Response(cached.body, {
        headers: {
          'Content-Type': 'application/x-xz',
          'Content-Length': cached.size.toString(),
          'X-Cache': 'HIT',
          'X-TL-Year': tlYear.toString(),
          ...CORS_HEADERS,
        },
      });
    }

    // Fetch from TexLive archive
    const response = await fetchTexLiveArchive(pkgName, tlYear);

    if (!response.ok) {
      if (response.status === 404) {
        return jsonResponse({ error: `Package not found in TexLive ${tlYear}` }, 404);
      }
      return jsonResponse({ error: `TexLive fetch failed: ${response.status}` }, 502);
    }

    // Get the body as ArrayBuffer for caching
    const body = await response.arrayBuffer();

    // Cache in R2
    await env.BUNDLES.put(cacheKey, body, {
      httpMetadata: { contentType: 'application/x-xz' },
    });
    console.log(`Cached ${pkgName}.tar.xz (TL${tlYear}) to R2 (${(body.byteLength / 1024).toFixed(1)} KB)`);

    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-xz',
        'Content-Length': body.byteLength.toString(),
        'X-Cache': 'MISS',
        'X-TL-Year': tlYear.toString(),
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    console.error('TexLive proxy error:', e);
    return jsonResponse({ error: 'TexLive proxy error: ' + (e as Error).message }, 500);
  }
}

// CTAN package info - returns metadata including contained_in for package lookup
async function handleCtanPkgInfo(pkgName: string): Promise<Response> {
  try {
    // Validate package name
    if (!pkgName || pkgName.length < 2 || pkgName.length > 50) {
      return jsonResponse({ error: 'Invalid package name' }, 400);
    }
    if (/[^a-zA-Z0-9_-]/.test(pkgName)) {
      return jsonResponse({ error: 'Invalid package name characters' }, 400);
    }

    // Query CTAN API
    const response = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'siglum-engine/1.0' },
    });

    if (!response.ok) {
      return jsonResponse({ error: 'Package not found' }, 404);
    }

    const data = await response.json() as any;
    if (data.errors) {
      return jsonResponse({ error: 'Package not found' }, 404);
    }

    // Return relevant fields for package lookup
    return jsonResponse({
      name: data.name || pkgName,
      contained_in: data.texlive || data.miktex || null,
      ctan_path: data.ctan?.path || null,
    });
  } catch (e) {
    console.error('CTAN pkg info error:', e);
    return jsonResponse({ error: 'CTAN lookup error: ' + (e as Error).message }, 500);
  }
}

// Full CTAN proxy - checks R2 cache first, then tries CTAN
async function handleCtanFetch(requestedPkg: string, env: Env, tlYear: TLYear = DEFAULT_TL_YEAR): Promise<Response> {
  try {
    // Validate package name
    if (!requestedPkg || requestedPkg.length < 2 || requestedPkg.length > 50) {
      return jsonResponse({ error: 'Invalid package name' }, 400);
    }
    if (/[^a-zA-Z0-9_-]/.test(requestedPkg)) {
      return jsonResponse({ error: 'Invalid package name characters' }, 400);
    }

    if (tlYear !== TEXLIVE_YEAR) return jsonResponse({error:'Use /api/texlive for year-specific archives'},400);

    // Normalized-artifact cache first (plan §2): a pre-normalized, build-required
    // package is served verbatim — no live CTAN flow, no in-Worker build. Checked
    // under the requested name; the parent-package name is checked again below
    // once CTAN resolution runs (so e.g. insdljs → acrotex hits the artifact).
    const normalized = await getNormalizedArtifact(requestedPkg, env);
    if (normalized) {
      console.log(`Normalized-cache hit for ${requestedPkg}`);
      return new Response(normalized, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
          'X-Source': 'normalized',
          ...CORS_HEADERS,
        },
      });
    }

    // Use year-suffixed cache key for non-default years
    const cacheKeySuffix = `@tl${tlYear}`;
    const cacheKey = `${env.RUNTIME_PREFIX || ''}ctan-cache/${CTAN_CACHE_VERSION}/${requestedPkg}${cacheKeySuffix}.json`;

    // Check R2 cache first
    const cached = await env.BUNDLES.get(cacheKey);
    if (cached) {
      console.log(`Cache hit for ${requestedPkg}`);
      const cachedData = await cached.text();
      return new Response(cachedData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
          ...CORS_HEADERS,
        },
      });
    }

    console.log(`Cache miss for ${requestedPkg}, fetching from CTAN...`);

    // Check bootstrap aliases
    let pkgName = bootstrapAliases[requestedPkg] || requestedPkg;

    console.log(`Fetching package: ${requestedPkg}${pkgName !== requestedPkg ? ` (via ${pkgName})` : ''}`);

    // Query CTAN to find the parent package (miktex or texlive field)
    const infoResponse = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'siglum-engine/1.0' },
    });

    let parentPkg = pkgName;
    let ctanFound = false;
    if (infoResponse.ok) {
      const info = await infoResponse.json() as any;
      if (!info.errors) {
        parentPkg = info.miktex || info.texlive || pkgName;
        ctanFound = true;
        console.log(`CTAN says ${pkgName} is part of ${parentPkg}`);
      }
    }

    // The requested name missed the normalized cache, but its parent bundle may
    // have a prebuilt artifact (e.g. insdljs is shipped by the prebuilt acrotex).
    if (parentPkg !== requestedPkg) {
      const normalizedParent = await getNormalizedArtifact(parentPkg, env);
      if (normalizedParent) {
        console.log(`Normalized-cache hit for ${requestedPkg} via parent ${parentPkg}`);
        return new Response(normalizedParent, {
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
            'X-Source': 'normalized-parent',
            ...CORS_HEADERS,
          },
        });
      }
    }

    // Try TexLive archive first (before CTAN)
    const tlResponse = await fetchTexLiveArchive(parentPkg, tlYear, fetch, {method:'HEAD'});

    if (tlResponse.ok) {
      // TexLive found - return redirect-like response for client to use /api/texlive/
      const result: ProcessedPackage = {
        name: requestedPkg,
        texlivePackage: parentPkg,
        message: `Package ${requestedPkg} is available from TexLive ${tlYear}. Use /api/texlive/${parentPkg} for raw tar.xz.`,
        useTexLive: true,
        files: {},
        totalFiles: 0,
        dependencies: [],
        source: `texlive-${tlYear}`,
      };
      const jsonData = JSON.stringify(result);
      await env.BUNDLES.put(cacheKey, jsonData, {
        httpMetadata: { contentType: 'application/json' },
      });
      return new Response(jsonData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
          'X-Source': `texlive-${tlYear}`,
          ...CORS_HEADERS,
        },
      });
    }

    // Not a package by that name — it may be a font file stem (phvr8t, ec-lmr10,
    // …) TeX requested directly. Resolve it to the package that ships it via the
    // committed font-file index and redirect the client to that package's tar.
    const fontPkg = await resolveFontStem(pkgName, env);
    if (fontPkg && fontPkg !== parentPkg) {
      const fontTlResp = await fetchTexLiveArchive(fontPkg, tlYear, fetch, {method:'HEAD'});
      if (fontTlResp.ok) {
        console.log(`Font stem ${pkgName} resolves to package ${fontPkg}`);
        const result: ProcessedPackage = {
          name: requestedPkg,
          texlivePackage: fontPkg,
          message: `Font ${requestedPkg} is provided by ${fontPkg}. Use /api/texlive/${fontPkg} for raw tar.xz.`,
          useTexLive: true,
          files: {},
          totalFiles: 0,
          dependencies: [],
          source: `texlive-${tlYear}-font`,
        };
        const jsonData = JSON.stringify(result);
        await env.BUNDLES.put(cacheKey, jsonData, {
          httpMetadata: { contentType: 'application/json' },
        });
        return new Response(jsonData, {
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'MISS',
            'X-Source': `texlive-${tlYear}-font`,
            ...CORS_HEADERS,
          },
        });
      }
    }

    // If CTAN doesn't know this package, try prefix fallback via TexLive archive
    // e.g., latex-lab-testphase-names → latex-lab-testphase → latex-lab
    if (!ctanFound && pkgName.includes('-')) {
      console.log(`CTAN doesn't know ${pkgName}, trying prefix fallback...`);
      const parts = pkgName.split('-');
      for (let i = parts.length - 1; i >= 1; i--) {
        const prefix = parts.slice(0, i).join('-');
        console.log(`  Trying prefix: ${prefix}`);

        // Try TexLive archive directly for this prefix
        const prefixTlResponse = await fetchTexLiveArchive(prefix, tlYear, fetch, {method:'HEAD'});

        if (prefixTlResponse.ok) {
          console.log(`  Found ${prefix} in TexLive ${tlYear} archive`);
          // Use the TexLive proxy which handles caching
          // Return a redirect-like response that tells client to use TexLive
          const result: ProcessedPackage = {
            name: requestedPkg,
            texlivePackage: prefix,
            message: `Package ${requestedPkg} is part of ${prefix}. Use /api/texlive/${prefix} for raw tar.xz.`,
            useTexLive: true,
            files: {},
            totalFiles: 0,
            dependencies: [],
            source: `texlive-${tlYear}-prefix`,
          };
          const jsonData = JSON.stringify(result);
          await env.BUNDLES.put(cacheKey, jsonData, {
            httpMetadata: { contentType: 'application/json' },
          });
          return new Response(jsonData, {
            headers: {
              'Content-Type': 'application/json',
              'X-Cache': 'MISS',
              'X-Source': 'texlive-prefix-fallback',
              ...CORS_HEADERS,
            },
          });
        }
      }
      console.log(`  Prefix fallback exhausted for ${pkgName}`);
    }

    // Try CTAN TDS zip (processed server-side)
    // For packages needing older versions, client should use /api/texlive/{pkg} directly
    const ctanResult = await tryCtanTdsZip(parentPkg);
    if (ctanResult) {
      const jsonData = JSON.stringify(ctanResult);
      await env.BUNDLES.put(cacheKey, jsonData, {
        httpMetadata: { contentType: 'application/json' },
      });
      console.log(`Cached ${requestedPkg} from CTAN to R2 (${(jsonData.length / 1024).toFixed(1)} KB)`);
      return new Response(jsonData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
          'X-Source': 'ctan',
          ...CORS_HEADERS,
        },
      });
    }

    // Try alternate: source zip from CTAN path
    const altResult = await tryCtanSourceZip(pkgName);
    if (altResult) {
      const jsonData = JSON.stringify(altResult);
      await env.BUNDLES.put(cacheKey, jsonData, {
        httpMetadata: { contentType: 'application/json' },
      });
      console.log(`Cached ${requestedPkg} from CTAN source to R2 (${(jsonData.length / 1024).toFixed(1)} KB)`);
      return new Response(jsonData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
          'X-Source': 'ctan-source',
          ...CORS_HEADERS,
        },
      });
    }

    // Try single file fetch (for packages like res.cls that are just one file)
    const singleFileResult = await tryCtanSingleFile(pkgName);
    if (singleFileResult) {
      const jsonData = JSON.stringify(singleFileResult);
      await env.BUNDLES.put(cacheKey, jsonData, {
        httpMetadata: { contentType: 'application/json' },
      });
      console.log(`Cached ${requestedPkg} from CTAN single file to R2 (${(jsonData.length / 1024).toFixed(1)} KB)`);
      return new Response(jsonData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
          'X-Source': 'ctan-single-file',
          ...CORS_HEADERS,
        },
      });
    }

    return jsonResponse({ error: 'Package not found' }, 404);
  } catch (e) {
    console.error('CTAN fetch error:', e);
    return jsonResponse({ error: 'CTAN fetch error: ' + (e as Error).message }, 500);
  }
}

// Try CTAN TDS (TeX Directory Structure) zip
async function tryCtanTdsZip(pkgName: string): Promise<any | null> {
  try {
    // Get package info to find install path
    const infoResp = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'siglum-engine/1.0' },
    });

    if (!infoResp.ok) return null;

    const info = await infoResp.json() as any;
    if (info.errors) return null;

    let downloadUrl: string | null = null;

    // Try install path first (TDS zip)
    if (info.install) {
      downloadUrl = `https://mirrors.ctan.org/install${info.install}`;
    } else if (info.ctan?.path) {
      // Try TDS zip from ctan path
      downloadUrl = `https://mirrors.ctan.org${info.ctan.path}.tds.zip`;
    }

    if (!downloadUrl) return null;

    console.log(`Trying CTAN TDS: ${downloadUrl}`);
    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'siglum-engine/1.0' },
      redirect: 'follow',
    });

    if (!response.ok) {
      // Try alternate TDS location
      if (info.ctan?.path && !downloadUrl.includes('.tds.zip')) {
        const altUrl = `https://mirrors.ctan.org${info.ctan.path}.tds.zip`;
        const altResp = await fetch(altUrl, {
          headers: { 'User-Agent': 'siglum-engine/1.0' },
          redirect: 'follow',
        });
        if (altResp.ok) {
          return processZip(await altResp.arrayBuffer(), pkgName);
        }
      }
      return null;
    }

    return processZip(await response.arrayBuffer(), pkgName);
  } catch (e) {
    console.log(`TDS zip failed for ${pkgName}:`, e);
    return null;
  }
}

// Try CTAN source zip
async function tryCtanSourceZip(pkgName: string): Promise<any | null> {
  try {
    const infoResp = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'siglum-engine/1.0' },
    });

    if (!infoResp.ok) return null;

    const info = await infoResp.json() as any;
    if (info.errors || !info.ctan?.path) return null;

    const downloadUrl = `https://mirrors.ctan.org${info.ctan.path}.zip`;
    console.log(`Trying CTAN source: ${downloadUrl}`);

    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'siglum-engine/1.0' },
      redirect: 'follow',
    });

    if (!response.ok) return null;

    return processZip(await response.arrayBuffer(), pkgName);
  } catch (e) {
    console.log(`Source zip failed for ${pkgName}:`, e);
    return null;
  }
}

// Try fetching a single file from CTAN (for packages that are just one .cls/.sty file)
async function tryCtanSingleFile(pkgName: string): Promise<any | null> {
  try {
    const infoResp = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`, {
      headers: { 'User-Agent': 'siglum-engine/1.0' },
    });

    if (!infoResp.ok) return null;

    const info = await infoResp.json() as any;
    if (info.errors || !info.ctan?.path) return null;

    const ctanPath = info.ctan.path;

    // Check if the path looks like a single file (ends with a known extension)
    const singleFileExtensions = ['.cls', '.sty', '.def', '.cfg', '.tex', '.fd', '.clo', '.ltx'];
    const ext = ctanPath.substring(ctanPath.lastIndexOf('.')).toLowerCase();

    if (!singleFileExtensions.includes(ext)) {
      console.log(`CTAN path ${ctanPath} doesn't look like a single file, skipping`);
      return null;
    }

    const downloadUrl = `https://mirrors.ctan.org${ctanPath}`;
    console.log(`Trying CTAN single file: ${downloadUrl}`);

    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'siglum-engine/1.0' },
      redirect: 'follow',
    });

    if (!response.ok) {
      console.log(`Single file fetch failed with status ${response.status}`);
      return null;
    }

    const content = await response.text();
    const fileName = ctanPath.split('/').pop() || `${pkgName}${ext}`;

    // Determine target directory based on extension
    const targetDir = ext === '.cls'
      ? `/texlive/texmf-dist/tex/latex/${pkgName}`
      : `/texlive/texmf-dist/tex/latex/${pkgName}`;

    const result: Record<string, { content: string; encoding: string }> = {};
    result[`${targetDir}/${fileName}`] = {
      content: content,
      encoding: 'text',
    };

    // Scan for dependencies
    const detectedDeps = new Set<string>();
    const reqMatches = content.matchAll(/\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g);
    for (const match of reqMatches) {
      const deps = match[1].split(',').map(d => d.trim());
      deps.filter(d => /^[a-zA-Z][a-zA-Z0-9-]*$/.test(d)).forEach(d => detectedDeps.add(d));
    }

    const dependencies = [...detectedDeps].filter(d => d !== pkgName);
    console.log(`Fetched single file ${fileName} (${content.length} bytes), deps: ${dependencies.join(', ') || 'none'}`);

    return {
      name: pkgName,
      files: result,
      totalFiles: 1,
      dependencies,
    };
  } catch (e) {
    console.log(`Single file fetch failed for ${pkgName}:`, e);
    return null;
  }
}

// Process a ZIP file and extract relevant TeX files
function processZip(zipBuffer: ArrayBuffer, pkgName: string): any {
  const zipData = new Uint8Array(zipBuffer);
  console.log(`Extracting ZIP (${(zipData.length / 1024).toFixed(1)} KB)`);

  const files = unzipSync(zipData);
  const result: Record<string, { content: string; encoding: string }> = {};

  const texExtensions = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo', '.ltx'];
  const fontExtensions = ['.pfb', '.pfm', '.afm', '.tfm', '.vf', '.map', '.enc'];
  const detectedDeps = new Set<string>();

  for (const [filePath, content] of Object.entries(files)) {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const fileName = filePath.split('/').pop() || '';

    // Skip docs and source directories (paths may or may not have leading slash)
    if (filePath.includes('/doc/') || filePath.startsWith('doc/') ||
        filePath.includes('/source/') || filePath.startsWith('source/')) continue;

    if (texExtensions.includes(ext)) {
      // Determine target path - preserve TDS structure
      let targetDir = `/texlive/texmf-dist/tex/latex/${pkgName}`;

      if (filePath.includes('/tex/latex/')) {
        const match = filePath.match(/\/tex\/latex\/([^/]+)/);
        if (match) targetDir = `/texlive/texmf-dist/tex/latex/${match[1]}`;
      } else if (filePath.includes('/tex/generic/')) {
        const match = filePath.match(/\/tex\/generic\/([^/]+)/);
        if (match) targetDir = `/texlive/texmf-dist/tex/generic/${match[1]}`;
      }

      const textContent = new TextDecoder().decode(content);
      result[`${targetDir}/${fileName}`] = {
        content: textContent,
        encoding: 'text',
      };

      // Scan for \RequirePackage dependencies
      const reqMatches = textContent.matchAll(/\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g);
      for (const match of reqMatches) {
        const deps = match[1].split(',').map(d => d.trim());
        deps.filter(d => /^[a-zA-Z][a-zA-Z0-9-]*$/.test(d)).forEach(d => detectedDeps.add(d));
      }
    } else if (fontExtensions.includes(ext)) {
      // Font files - preserve TDS structure
      // Match paths like "fonts/type1/public/pkg/..." or "pkg/fonts/tfm/..."
      const fontsMatch = filePath.match(/(?:^|\/)fonts\/(type1|tfm|vf|afm|enc|map|opentype|truetype)(\/[^/]+)*\/([^/]+)$/);
      let targetDir: string;

      if (fontsMatch) {
        // Extract the fonts/... portion of the path
        const fontsIdx = filePath.indexOf('fonts/');
        const fontsPath = filePath.substring(fontsIdx, filePath.lastIndexOf('/'));
        targetDir = `/texlive/texmf-dist/${fontsPath}`;
      } else {
        // Fallback: place by extension in appropriate TDS location
        const extToDir: Record<string, string> = {
          '.pfb': 'fonts/type1/public',
          '.pfm': 'fonts/type1/public',
          '.afm': 'fonts/afm/public',
          '.tfm': 'fonts/tfm/public',
          '.vf': 'fonts/vf/public',
          '.map': 'fonts/map/dvips',
          '.enc': 'fonts/enc/dvips',
        };
        const baseDir = extToDir[ext] || 'fonts/type1/public';
        targetDir = `/texlive/texmf-dist/${baseDir}/${pkgName}`;
      }

      // Encode binary fonts as base64
      const base64Content = arrayBufferToBase64(content);
      result[`${targetDir}/${fileName}`] = {
        content: base64Content,
        encoding: 'base64',
      };
    }
  }

  const fileCount = Object.keys(result).length;
  const dependencies = [...detectedDeps].filter(d => d !== pkgName);
  console.log(`Extracted ${fileCount} files, deps: ${dependencies.join(', ') || 'none'}`);

  if (fileCount === 0) {
    return null;
  }

  return {
    name: pkgName,
    files: result,
    totalFiles: fileCount,
    dependencies,
  };
}

function arrayBufferToBase64(buffer: Uint8Array): string {
  let binary = '';
  const len = buffer.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary);
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

async function handleZotero(url: URL, request: Request): Promise<Response> {
  const path = url.pathname.slice('/api/zotero'.length);
  if (!/^\/users\/\d+\/items(?:\/[A-Z0-9]+)?$/.test(path)) return jsonResponse({error:'Unsupported Zotero route'},400);
  const headers = new Headers({'Zotero-API-Version':'3'});
  const key = request.headers.get('Zotero-API-Key'); if (key) headers.set('Zotero-API-Key',key);
  const response = await fetch('https://api.zotero.org' + path + url.search, {headers, redirect:'error'});
  return new Response(response.body, {status:response.status, headers:{...CORS_HEADERS, 'Content-Type':response.headers.get('Content-Type') || 'application/json', 'Cache-Control':'private, no-store'}});
}
