# TeX Live 2026 release candidate

## Changes

- TeX Live 2026 pdfLaTeX and XeLaTeX run in-browser. Automatic BibTeX execution
  resolves project citations, supports nested source files, and rebuilds changed
  bibliographies. Failed bibliography or rerun passes report errors.
- Package sources default to 2026, with explicit older-year fallbacks isolated.
  Production preserves normalized packages and font aliases.
- Immutable runtime manifests bind WASM, formats, compressed/raw bundles and
  prebuilt packages to one release. Runtime-dependent caches use that identity.
  HTTP byte ranges return exact bytes; partial responses cannot poison full caches.
- Compiler initialization and overlapping compiles are serialized. Project paths,
  source dependencies, transferred byte slices and compile-result types are corrected.
- Search indexes document content. Help text, contrast and iconography are clearer.
- Mobile editing includes compact insertion sheets, stable table cell editing,
  citation search through Zotero, context shortcuts, error cards, PDF peek and lens.
  PDF preview scrolls, zooms and shares desktop night-mode colors. The compatibility
  PDF.js renderer supports browsers missing newer JavaScript APIs.
- Storage and Git replacement protect existing documents with staging and recovery.
- Production Zotero requests use a fixed read-only upstream, forward credentials
  without logging them, and never cache private responses.

## Verification

The final four-repository check passes 559 tests: 61 filesystem, 16 Git,
404 engine unit/integration, 48 real WASM browser, 25 UI and 5 API adapter tests.
The four-repository check covers filesystem and Git tests, engine unit/integration
and real WASM browser compiles, UI tests, production-adapter tests, declarations,
and the app build. Separate browser checks cover a real citation-to-PDF flow,
initialization/compile concurrency, desktop rendering, 320px mobile editing,
keyboard-height layouts, PDF scrolling/zoom/night mode and lens panning.

Runtime candidate: `tl2026-a609e31ad3926333` (164 files, all SHA-256 verified).
The staged production build is exercised locally against the exact immutable
runtime. Remote upload and deployment are separate steps, followed by remote
checksum verification. See README.md for the release order.

## Known limits and final device check

Biber is not bundled. Use BibTeX, biblatex's BibTeX backend, or a prebuilt `.bbl`.
A real iPhone check is still required; Chromium touch emulation and WebKit tests
cannot fully reproduce the device keyboard or memory limits. No release has been
published by the local preparation commands.
