const namespace = 'https://sourceforge.net/projects/biblatex';
const maxInputBytes = 16 * 1024 * 1024;
const maxOutputBytes = 16 * 1024 * 1024;
const outputHeader = '% $ biblatex auxiliary file $\n% $ biblatex bbl format version 3.3 $\n';

export function isLocalBibPath(path) {
  return typeof path === 'string' && path.length <= 1024 && path.endsWith('.bib')
    && path.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(part));
}

export function verifyBbl(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxOutputBytes) {
    throw new Error('Invalid Biber output size.');
  }
  const output = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!output.startsWith(outputHeader) || output.includes('\0') || !/\\endinput\s*$/.test(output)) {
    throw new Error('Biber did not produce a complete biblatex 3.3 bibliography.');
  }
  return bytes;
}

// The UI thread owns DOMParser. The compiler should call this only for an
// actual generated .bcf that has no project-supplied .bbl.
export async function prepareLocalBiber(bcf, readProjectFile) {
  if (!(bcf instanceof Uint8Array) || bcf.byteLength > maxInputBytes) {
    throw new Error('Invalid Biber control file size.');
  }
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bcf);
  const body = xml.replace(/^<\?xml [^?]*\?>/, '');
  if (/<!DOCTYPE|<!ENTITY|<\?/.test(body)) throw new Error('XML directives are not allowed in Biber inputs.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (document.doctype || document.getElementsByTagName('parsererror').length
    || root.localName !== 'controlfile' || root.namespaceURI !== namespace
    || root.getAttribute('version') !== '3.11') {
    throw new Error('Biber expects a biblatex 3.11 control file.');
  }
  const sourcePaths = new Set();
  for (const element of document.getElementsByTagNameNS('*', 'datasource')) {
    const path = element.textContent;
    if (element.namespaceURI !== namespace || element.parentElement?.localName !== 'bibdata'
      || element.parentElement.namespaceURI !== namespace || element.parentElement.parentElement !== root
      || element.getAttribute('type') !== 'file' || element.getAttribute('datatype') !== 'bibtex'
      || element.getAttribute('glob') !== 'false' || element.children.length || !isLocalBibPath(path)) {
      throw new Error('This Biber adapter accepts local .bib files without wildcards.');
    }
    sourcePaths.add(path);
  }
  if (!sourcePaths.size) throw new Error('No local Biber data sources were found.');

  let size = bcf.byteLength;
  const files = [];
  for (const path of sourcePaths) {
    // Resolve relative to the TeX root within the current project only.
    const bytes = await readProjectFile(path);
    if (!(bytes instanceof Uint8Array)) throw new Error('Missing project bibliography: ' + path);
    size += bytes.byteLength;
    if (size > maxInputBytes) throw new Error('Biber input size exceeds the adapter limit.');
    files.push({ path, bytes: bytes.slice() });
  }
  return { bcf: bcf.slice(), files };
}

export async function runLocalBiber(bcf, readProjectFile, signal) {
  const request = await prepareLocalBiber(bcf, readProjectFile);
  const worker = new Worker(new URL('./biber-worker.js', import.meta.url), { name: 'local-biber' });
  try {
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Biber cancelled.')); return; }
      signal?.addEventListener('abort', () => reject(new Error('Biber cancelled.')), { once: true });
      const timeout = setTimeout(() => reject(new Error('Biber timed out.')), 45_000);
      worker.addEventListener('error', error => {
        clearTimeout(timeout);
        reject(new Error(error.message || 'Biber worker failed.'));
      }, { once: true });
      worker.addEventListener('messageerror', () => {
        clearTimeout(timeout);
        reject(new Error('Biber returned an unreadable message.'));
      }, { once: true });
      worker.addEventListener('message', ({ data }) => {
        clearTimeout(timeout);
        if (!data?.ok) {
          reject(new Error(data?.error || 'Biber did not complete.'));
          return;
        }
        try { resolve({ bytes: verifyBbl(data.bytes), log: data.log }); }
        catch (error) { reject(error); }
      }, { once: true });
      try {
        worker.postMessage(request, [request.bcf.buffer, ...request.files.map(({ bytes }) => bytes.buffer)]);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  } finally {
    worker.terminate();
  }
}
