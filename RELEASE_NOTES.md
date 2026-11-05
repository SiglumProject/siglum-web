# TeX Live 2026 release candidate

## Changes

- TeX Live 2026 pdfLaTeX and XeLaTeX run in-browser. Automatic BibTeX execution
  resolves project citations, supports nested source files, and rebuilds changed
  bibliographies. Failed bibliography or rerun passes report errors.
- Package sources default to 2026, with explicit older-year fallbacks isolated.
  Production preserves normalized packages and font aliases.
- The 2026 API deploys as a separate Worker on release-prefixed routes. Existing
  package URLs, CTAN proxy routes and stored legacy assets remain in place.
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

The final four-repository check passes 560 tests: 61 filesystem, 16 Git,
404 engine unit/integration, 48 real WASM browser, 25 UI and 6 API adapter tests.
The four-repository check covers filesystem and Git tests, engine unit/integration
and real WASM browser compiles, UI tests, production-adapter tests, declarations,
and the app build. Separate browser checks cover a real citation-to-PDF flow,
initialization/compile concurrency, desktop rendering, 320px mobile editing,
keyboard-height layouts, PDF scrolling/zoom/night mode and lens panning.

Runtime candidate: `tl2026-a609e31ad3926333` (164 files, all SHA-256 verified).
The staged production build is exercised locally against the exact immutable
runtime. Remote upload and deployment are separate steps, followed by remote
checksum verification.

## Known limits and device confirmation

Biber is not bundled. Use BibTeX, biblatex's BibTeX backend, or a prebuilt `.bbl`.
Adam confirmed the local preview works on his physical iPhone after checking
compilation, PDF scrolling/zooming, and table editing. This completes the requested
physical-device check alongside the automated browser tests.

No release has been published by the local preparation commands. The deployed
site still needs verification after publication.
