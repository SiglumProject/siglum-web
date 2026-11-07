// Local-only preview for immutable runtime assets and a built editor. No publishing.
import { createServer, request as forward } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

function loadRuntime(path) {
    const directory = dirname(resolve(path));
    const config = JSON.parse(readFileSync(path));
    const manifest = JSON.parse(readFileSync(resolve(directory, config.manifest)));
    if (!/^tl\d{4}-[a-f0-9]{16}$/.test(manifest.releaseId) || !manifest.files) throw new Error('Invalid runtime manifest');
    const root = resolve(directory, config.runtimeRoot);
    const overlays = config.files || {};
    for (const [name, path] of Object.entries(overlays)) {
        const expected = manifest.files[name], bytes = readFileSync(resolve(directory, path));
        if (!expected || bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Runtime overlay mismatch: ' + name);
    }
    return { manifest, prefix: '/engine/releases/' + manifest.releaseId + '/',
        file(name) {
            if (!Object.hasOwn(manifest.files, name)) return null;
            return Object.hasOwn(overlays, name) ? resolve(directory, overlays[name]) : resolve(root, name);
        } };
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const sharedHeaders = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin' };
function json(response, data) { const body = Buffer.from(JSON.stringify(data)); response.writeHead(200, { ...sharedHeaders, 'Content-Type': 'application/json', 'Content-Length': body.length }); response.end(body); }
function sendFile(request, response, path, immutable, counts) {
    if (!path || !existsSync(path) || !statSync(path).isFile()) { response.writeHead(404); response.end('Not found'); return; }
    const size = statSync(path).size;
    let start = 0, end = size - 1;
    if (request.headers.range) {
        const range = request.headers.range.match(/^bytes=(\d*)-(\d*)$/);
        if (!range || (!range[1] && !range[2])) { response.writeHead(416, { 'Content-Range': 'bytes */' + size }); response.end(); return; }
        if (range[1]) { start = +range[1]; if (range[2]) end = Math.min(+range[2], size - 1); }
        else { start = Math.max(0, size - Number(range[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || start < 0) { response.writeHead(416, { 'Content-Range': 'bytes */' + size }); response.end(); return; }
    }
    response.writeHead(request.headers.range ? 206 : 200, { ...sharedHeaders, 'Content-Type': types[extname(path)] || 'application/octet-stream',
        'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': immutable ? 'public,max-age=31536000,immutable' : 'no-cache',
        ...(request.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    if (request.method === 'HEAD' || size === 0) { response.end(); return; }
    counts.bytes += end - start + 1;
    const stream = createReadStream(path, { start, end }); stream.on('error', error => response.destroy(error)); response.on('close', () => stream.destroy()); stream.pipe(response);
}
export async function startPreview(port = 5174, options = {}) {
    const configPath = options.config || process.env.SIGLUM_PREVIEW_CONFIG;
    if (!configPath) throw new Error('Set SIGLUM_PREVIEW_CONFIG to a verified local server-config.json');
    const primary = loadRuntime(configPath);
    const runtimes = [primary, ...JSON.parse(process.env.SIGLUM_PREVIEW_FALLBACK_CONFIGS || '[]').map(loadRuntime)];
    const root = resolve(options.directory || process.env.SIGLUM_PREVIEW_DIR || 'dist');
    if (!existsSync(resolve(root, 'index.html'))) throw new Error('Missing built editor index.html');
    const fallbacks = JSON.parse(process.env.SIGLUM_PREVIEW_FALLBACK_DIRS || '[]').map(path => resolve(path));
    const legacyPolicies = JSON.parse(process.env.SIGLUM_PREVIEW_LEGACY_TOOL_POLICIES || '[]');
    const upstream = new URL(options.packageProxy || process.env.SIGLUM_PACKAGE_PROXY || 'http://127.0.0.1:8787');
    if (upstream.protocol !== 'http:') throw new Error('Local package proxy must use HTTP');
    const counts = { requests: 0, bytes: 0, paths: {} };
    const server = createServer((request, response) => {
        counts.requests++;
        try {
            const url = new URL(request.url, 'http://local');
            const pathname = decodeURIComponent(url.pathname);
            counts.paths[pathname] = (counts.paths[pathname] || 0) + 1;
            if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
            if (pathname === '/engine/engines/' + primary.manifest.engineVersion + '/latest.json') {
                const baseUrl = 'http://' + request.headers.host + primary.prefix.replace(/\/$/, '');
                response.setHeader('Cache-Control', 'no-store');
                json(response, { schemaVersion: 1, engineVersion: primary.manifest.engineVersion,
                    releaseId: primary.manifest.releaseId, baseUrl,
                    manifestUrl: baseUrl + '/runtime.json',
                    manifestSha256: createHash('sha256').update(JSON.stringify(primary.manifest)).digest('hex') });
                return;
            }
            const runtime = runtimes.find(value => pathname.startsWith(value.prefix));
            const name = runtime ? pathname.slice(runtime.prefix.length).replace(/^bundles\//, '') : null;
            if (runtime && ['manifest.json', 'runtime.json', 'runtime-manifest.json', 'release.json'].includes(name)) { json(response, runtime.manifest); return; }
            if (runtime && !name.startsWith('api/')) { sendFile(request, response, runtime.file(name), true, counts); return; }
            const proxyPath = runtime && name.startsWith('api/') ? '/' + name : pathname.startsWith('/engine/api/') ? pathname.slice(7) : null;
            if (proxyPath) {
                const proxy = forward({ hostname: upstream.hostname, port: upstream.port || 80, path: proxyPath + url.search, method: request.method }, result => {
                    response.writeHead(result.statusCode, { ...result.headers, ...sharedHeaders }); result.pipe(response);
                });
                proxy.on('error', () => { if (!response.headersSent) response.writeHead(503); response.end('Local package proxy unavailable'); });
                response.on('close', () => proxy.destroy()); proxy.end(); return;
            }
            let file = resolve(root, '.' + pathname);
            if (file === root) file = resolve(root, 'index.html');
            if (!file.startsWith(root + '/')) { response.writeHead(404); response.end(); return; }
            if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, 'index.html');
            if (!existsSync(file) && /^\/(?:assets|tools)\//.test(pathname)) {
                for (const oldRoot of fallbacks) {
                    const candidate = resolve(oldRoot, '.' + pathname);
                    if (candidate.startsWith(oldRoot + '/') && existsSync(candidate) && statSync(candidate).isFile()) { file = candidate; break; }
                }
            }
            const provider = pathname.match(/^\/tools\/providers\/([a-f0-9]{64})\//);
            const descriptorPath = provider ? [root, ...fallbacks].map(base => resolve(base, 'tools/providers', provider[1], 'provider-policy.json')).find(existsSync) : null;
            const policy = descriptorPath ? JSON.parse(readFileSync(descriptorPath)) : legacyPolicies.find(policy => policy.worker === pathname);
            if (policy?.worker === pathname) {
                const origin = 'http://' + request.headers.host;
                const scripts = [...(policy.wasm ? ["'wasm-unsafe-eval'"] : []), ...policy.scripts.map(path => new URL(path, origin).href)];
                response.setHeader('Content-Security-Policy', "default-src 'none'; script-src " + (scripts.join(' ') || "'none'") + '; connect-src ' + (policy.connect.map(path => new URL(path, origin).href).join(' ') || "'none'"));
            }
            sendFile(request, response, file, /^\/(?:assets|tools)\//.test(pathname), counts);
        } catch { if (!response.headersSent) response.writeHead(400); response.end('Invalid local preview request'); }
    });
    const listen = () => new Promise((yes, no) => { const fail = error => no(error); server.once('error', fail); server.listen(port, options.host || process.env.CHECKPOINT_UI_HOST || '127.0.0.1', () => { server.off('error', fail); yes(); }); });
    const stop = () => new Promise(yes => { if (!server.listening) { yes(); return; } server.closeAllConnections(); server.close(yes); });
    await listen(); const actualPort = server.address().port;
    return { url: 'http://127.0.0.1:' + actualPort, counts, server, stop, resume: listen, releaseId: primary.manifest.releaseId };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const preview = await startPreview(Number(process.env.PORT || 5174)); console.log(preview.url + ' runtime=' + preview.releaseId);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.stop().then(() => process.exit()));
}
