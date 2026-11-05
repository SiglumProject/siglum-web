# Engine and package API

Siglum's compiler can be embedded in another browser application. The released SDK is [`@siglum/engine`](https://www.npmjs.com/package/@siglum/engine). Browser storage is provided by [`@siglum/filesystem`](https://www.npmjs.com/package/@siglum/filesystem), and the optional Git connector is [`@siglum/git`](https://www.npmjs.com/package/@siglum/git).

## SDK and runtime

The npm engine package contains the JavaScript API, worker, and TypeScript declarations. The WebAssembly binary, LaTeX formats, fonts, and package bundles are separate runtime assets.

Use [`packages.siglum.org/latest`](https://packages.siglum.org/latest) to inspect the latest published runtime manifest, or [`latest.json`](https://packages.siglum.org/latest.json) for its discovery metadata. Releases update these links automatically. The manifest records the engine version, TeX Live year, release ID, file sizes, and SHA-256 checksums. The [GitHub release](https://github.com/SiglumProject/siglum/releases/latest) also provides the runtime archive.

For an application, `resolveRuntime()` selects the runtime compatible with its installed SDK and verifies the manifest's digest and identity. It returns immutable asset URLs; a running compiler keeps using those URLs when a newer release appears. No release hash needs to be copied into the application.

The editor exposes pdfLaTeX and XeLaTeX. The underlying [BusyTeX fork](https://github.com/SiglumProject/busytex) also builds the tools and data used to produce this runtime.

## Browser integration

Install the SDK:

```sh
npm install @siglum/engine
```

For Vite, apply the [SDK's bundler configuration](https://github.com/SiglumProject/siglum/blob/main/docs/usage.md#usage-with-bundlers-vite-webpack-etc). It includes the workaround required for the optional BLAKE3 dependency. Resolve the runtime once, then pass it with the exported worker URL:

```js
import { SiglumCompiler, resolveRuntime } from '@siglum/engine';
import workerUrl from '@siglum/engine/worker?url';

const runtime = await resolveRuntime();
const compiler = new SiglumCompiler({
  ...runtime,
  workerUrl,
});

await compiler.init();
const result = await compiler.compile(String.raw`\documentclass{article}
\begin{document}
Hello from Siglum.
\end{document}`);

if (!result.success) throw new Error(result.error || 'Compilation failed');
const pdf = new Blob([result.pdf], { type: 'application/pdf' });
```

The `?url` import is Vite syntax. Other bundlers can copy the package's worker into their public assets and pass its served URL. Keep that worker in sync with the engine package.

The resolver caches a verified descriptor and manifest together in Cache Storage. If the network is unavailable, it can reopen that same SDK's verified runtime selection. Offline compilation also requires the runtime files and document dependencies to have been cached; resolving metadata alone does not download them. Invalid metadata fails verification instead of silently selecting another runtime.

Serve browser applications over HTTPS or localhost for browser storage and service-worker support. The engine can compile without SharedArrayBuffer. These response headers enable its faster SharedArrayBuffer-based lazy-file path:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Public package proxy

The resolved base also provides package archives, normalized files, and metadata. For a shell example, discover the latest base and its TeX Live year with `curl` and `jq`:

```sh
runtime="$(curl -fsS https://packages.siglum.org/latest.json)"
base="$(printf '%s' "$runtime" | jq -er .baseUrl)"
manifest_url="$(printf '%s' "$runtime" | jq -er .manifestUrl)"
year="$(curl -fsS "$manifest_url" | jq -er .texLiveYear)"

curl -fL "$base/api/texlive/csquotes?tlYear=$year" -o csquotes.tar.xz
curl -fsS "$base/api/fetch/acrotex?tlYear=$year"
curl -fsS "$base/api/ctan-pkg/enumitem"
```

The first request returns a TeX Live archive. The second returns normalized package files as JSON. Both use the manifest's TeX Live year. The third returns CTAN package metadata. Read the [public package API guide](https://github.com/SiglumProject/siglum/blob/main/docs/ctan-proxy.md#public-package-api) for routes and behavior.

## Host it yourself

The runtime and package proxy can be hosted independently of Siglum's editor. Keep the engine, worker, and runtime assets from compatible releases together. Static hosting serves the runtime files; on-demand package requests also need a package-service implementation.

Follow the [self-hosting guide](https://github.com/SiglumProject/siglum/blob/main/docs/self-hosting.md) or [build the compiler from source](https://github.com/SiglumProject/siglum/blob/main/docs/building.md). For cached dependencies and the limits of browser persistence, see [Storage and offline use](https://siglum.org/docs/storage/).
