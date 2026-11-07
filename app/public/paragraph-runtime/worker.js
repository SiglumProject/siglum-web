importScripts('./pdftex.js', './paragraph.js');

let runtime;
async function init() {
  const names = [...FONT_NAMES.flatMap(font => [font + '.tfm', font + '.pfb']), 'hyphen.tex'];
  const [wasmModule, entries] = await Promise.all([
    WebAssembly.compileStreaming(fetch('./pdftex.wasm')),
    Promise.all(names.map(async name => {
      const response = await fetch('./' + name);
      if (!response.ok) throw new Error('Missing paragraph runtime file ' + name);
      return ['/' + name, new Uint8Array(await response.arrayBuffer())];
    })),
  ]);
  return createParagraphRuntime({ factory: pdftex, wasmModule, assets: new Map(entries), useEnglishPatterns: true });
}

self.onmessage = async ({ data }) => {
  try {
    runtime ??= init().catch(error => {
      runtime = undefined;
      throw error;
    });
    const engine = await runtime;
    if (data.text === undefined) {
      self.postMessage({ id: data.id });
      return;
    }
    const pdf = await engine.typeset(data.text);
    self.postMessage({ id: data.id, pdf }, [pdf.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
