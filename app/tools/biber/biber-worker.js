const assets = new URL('./assets/', self.location.href);
const glue = new URL('biber.js', assets).href;
const wasm = new URL('biber.wasm', assets).href;
const data = new URL('biber.data', assets).href;
const outputFile = 'siglum-biber.bbl';
const bcfFile = 'siglum-biber.bcf';
const workDir = '/home/web_user/biber/project';
const originalFetch = self.fetch.bind(self);
const allowedUrls = new Set([wasm, data]);

self.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input, self.location.href).href;
  if (!allowedUrls.has(url)) return Promise.reject(new Error('Unexpected Biber asset request.'));
  return (async () => {
    const cache = await caches.open('siglum-tool-assets:'+new URL('.',self.location.href).pathname);
    const cached = await cache.match(url);
    if (cached) return cached;
    const response = await originalFetch(url, { ...options, redirect: 'error' });
    if (!response.ok) throw new Error('Biber asset load failed: ' + response.status);
    await cache.put(url, response.clone());
    return response;
  })();
};
for (const key of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport']) {
  Object.defineProperty(self, key, { value: undefined });
}

self.addEventListener('message', async ({ data: input }) => {
  const log = [];
  const report = line => { if (log.length < 100) log.push(String(line).slice(0, 2000)); };
  try {
    if (!(input.bcf instanceof Uint8Array) || !Array.isArray(input.files)
      || input.files.some(file => !file || typeof file.path !== 'string' || !(file.bytes instanceof Uint8Array))
      || input.files.reduce((bytes, file) => bytes + file.bytes.byteLength, input.bcf.byteLength) > 16 * 1024 * 1024) {
      throw new Error('Invalid Biber worker input.');
    }
    importScripts(glue);
    const runtime = await biber({
      noInitialRun: true,
      locateFile(name) {
        if (name === 'biber.wasm') return wasm;
        if (name === 'biber.data') return data;
        throw new Error('Unexpected Biber runtime asset.');
      },
      print: report,
      printErr: report,
    });
    allowedUrls.clear();
    const { FS } = runtime;
    FS.mkdirTree(workDir);
    FS.chdir(workDir);
    for (const file of input.files) {
      if (!file.path.endsWith('.bib') || !file.path.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(part))) {
        throw new Error('Invalid Biber data path.');
      }
      const path = workDir + '/' + file.path;
      FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      FS.writeFile(path, file.bytes);
    }
    FS.writeFile(bcfFile, input.bcf);
    const args = ['/opt/perl-wasm/bin/biber', '--noconf', '--nolog', '--output-format=bbl', '--outfile=' + outputFile, bcfFile];
    let status;
    try { status = runtime.callMain(args); }
    catch (error) {
      if (typeof error.status !== 'number') throw error;
      status = error.status;
    }
    if (status !== 0 || !FS.analyzePath(outputFile).exists) {
      throw new Error('Biber did not produce a bibliography (exit ' + status + ').');
    }
    if (FS.stat(outputFile).size > 16 * 1024 * 1024) throw new Error('Biber output size exceeds the adapter limit.');
    const bytes = FS.readFile(outputFile);
    self.postMessage({ ok: true, bytes, log }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, error: [error.message || String(error), ...log.slice(-8)].join('\n') });
  }
}, { once: true });
