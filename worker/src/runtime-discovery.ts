interface RuntimeDescriptor {
  schemaVersion: 1;
  engineVersion: string;
  releaseId: string;
  baseUrl: string;
  manifestUrl: string;
  manifestSha256: string;
}

const VERSION_NUMBER = '(?:0|[1-9][0-9]*)';
const PRERELEASE_PART = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const SDK_VERSION = new RegExp(
  `^${VERSION_NUMBER}\\.${VERSION_NUMBER}\\.${VERSION_NUMBER}` +
  `(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?` +
  '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);
const RELEASE_ID = /^tl[0-9]{4}-[a-f0-9]{16}$/;

function isRuntimeDescriptor(value: unknown, engineVersion?: string): value is RuntimeDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptor = value as Record<string, unknown>;
  if (descriptor.schemaVersion !== 1 ||
      typeof descriptor.engineVersion !== 'string' || !SDK_VERSION.test(descriptor.engineVersion) ||
      (engineVersion !== undefined && descriptor.engineVersion !== engineVersion) ||
      typeof descriptor.releaseId !== 'string' || !RELEASE_ID.test(descriptor.releaseId) ||
      typeof descriptor.baseUrl !== 'string' ||
      descriptor.manifestUrl !== `${descriptor.baseUrl}/runtime.json` ||
      typeof descriptor.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.manifestSha256)) {
    return false;
  }
  try {
    const base = new URL(descriptor.baseUrl);
    return base.protocol === 'https:' &&
      descriptor.baseUrl === `${base.origin}/releases/${descriptor.releaseId}`;
  } catch {
    return false;
  }
}

/** Resolve a mutable descriptor once; all runtime asset URLs remain immutable. */
export async function handleRuntimeDiscovery(
  url: URL,
  request: Request,
  bucket: R2Bucket,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const latest = url.pathname === '/latest.json' || url.pathname === '/latest' || url.pathname === '/latest/';
  const engine = url.pathname.match(/^\/engines\/([^/]+)\/latest\.json$/);
  const directory = url.pathname.match(/^\/releases\/(tl[0-9]{4}-[a-f0-9]{16})\/?$/);
  const reserved = url.pathname.startsWith('/latest/') || url.pathname.startsWith('/latest.json') || url.pathname.startsWith('/engines/');
  if (!latest && !engine && !directory && !reserved) return null;

  const respond = (body: string, status: number, extraHeaders: Record<string, string> = {}) => new Response(
    request.method === 'HEAD' ? null : body,
    {status, headers: {
      ...corsHeaders,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(body).length),
      ...extraHeaders,
    }},
  );
  const error = (message: string, status: number) => respond(JSON.stringify({error: message}), status);
  if (request.method === 'OPTIONS') return respond('', 200);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return respond(JSON.stringify({error: 'Method not allowed'}), 405, {Allow: 'GET, HEAD, OPTIONS'});
  }
  if (directory) return respond('', 302, {Location: `${url.origin}/releases/${directory[1]}/runtime.json`});
  if (!latest && !engine) return error('Not found', 404);

  let version: string | undefined;
  if (engine) {
    try { version = decodeURIComponent(engine[1]); } catch { return error('Invalid engine version', 400); }
    if (!SDK_VERSION.test(version)) return error('Invalid engine version', 400);
  }
  const key = version ? `engines/${version}/latest.json` : 'channels/latest.json';
  try {
    const object = await bucket.get(key);
    if (!object) return error('Runtime discovery is not published', 404);
    const body = await object.text();
    const descriptor: unknown = JSON.parse(body);
    if (!isRuntimeDescriptor(descriptor, version)) return error('Invalid runtime discovery descriptor', 502);
    if (url.pathname === '/latest' || url.pathname === '/latest/') {
      return respond('', 302, {Location: descriptor.manifestUrl});
    }
    return respond(body, 200, {ETag: object.httpEtag});
  } catch {
    return error('Runtime discovery is unavailable or invalid', 502);
  }
}
