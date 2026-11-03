# Siglum

Browser-based LaTeX editor that compiles entirely in your browser.

**[Try it now at siglum.org](https://siglum.org)**

## Structure

```
siglum/
├── app/        # Frontend React app (Cloudflare Pages)
├── worker/     # API worker (Cloudflare Workers + R2)
```

## Features

- Full LaTeX compilation in browser (pdfTeX, XeTeX)
- CodeMirror 6 editor with LaTeX syntax highlighting
- Live PDF preview
- GitHub sync (clone, pull, push, auto-sync)
- OPFS-based file storage
- Automatic package fetching from CTAN
- Preamble caching for faster compiles

## Local development and release checks

This checkout uses Bun 1.3.4 and four local repositories. The UI root registers
these checkouts as Bun workspaces, so no globally registered `bun link` packages
are needed:

```text
code/
  siglum-engine/
  siglum-filesystem/
  siglum-git/
  webtex/siglum-ui/       # this repository
```

From this repository:

```bash
bun run prepare:local   # frozen installs, build shared packages, sync worker
bun run dev:all         # engine on 8787 and UI on 5174
bun run dev:lan         # phone/tablet access on the same local network
bun run check:all       # all four suites, real browser engine tests, local UI build
bun run build:local     # local preview output in app/dist
bun run snapshot:local  # source/runtime archives, package candidates, checksums
bun run prepare:release # verify staged runtime, build .local-release/site
bun run preview:release # serve the staged production build on 5175
bun run test:release    # isolated desktop/phone production browser checks
```

Local snapshots are saved under `.local-release/` and include uncommitted source
and runtime assets. They exclude local environment secrets and browser documents.

Open http://127.0.0.1:5174/. The start command reuses existing Siglum servers and
only stops processes it started. LAN mode prints this computer's network URL;
compiler requests use the UI proxy, so the engine can stay on loopback. Runtime assets (`busytex.js`, `busytex.wasm`,
`dist/`, and `packages/bundles/`) must already exist in the engine checkout; they
are intentionally separate from the source packages. The engine binds to loopback
by default; set `SIGLUM_DEV_HOST` explicitly for LAN testing.

The preparation command installs the workspace from its frozen lockfile and builds
the shared packages. Workspace links pick up their changes directly. It also aligns the test and release runtime copies with the binaries
in `busytex/build/wasm`, preserving replaced files in `.local-runtime-backups/`. Keep the UI workspace lockfile and the standalone library lockfiles with the source changes. The engine's
local filesystem override is for development; its published dependency remains a
normal version range.

`app/.env.local-preview` configures local builds. Production builds require an
explicit HTTPS `VITE_API_BASE` and a staged `VITE_ENGINE_RELEASE`; see `app/.env.production.example`. The former
localhost production override has been moved to `.env.local-preview.local` on
this computer. Do not use local preview output as a hosted release.

Before publication, finish the dependency releases and decide whether the deployed UI is built from this workspace or from released
library versions. Keep the dependency versions and deployment assets in sync.
Build against the deployed engine URL and verify the deployed TeX Live 2026
runtime assets. Local checks do not publish packages, deploy services, or modify
GitHub PRs.

### Git recovery

Reconnect, clone, and force pull download into a separate staging namespace and
save the previous checkout, including uncommitted files and Git history, before
replacement. Failed installation attempts restore that copy. The most recent
backup remains at `/git-recovery/snapshot` in the `siglum-git-recovery` browser
storage namespace. If rollback itself fails or the browser closes during the
replacement, a pending marker prevents another replacement from overwriting the
backup. After freeing storage, `GitService.recoverCheckout()` retries recovery and
clears the pending marker only when restoration succeeds. Disconnect removes
credentials and retains local files.

## Deployment

### First-time setup

```bash
# Login to Cloudflare
wrangler login

# Create Pages project
wrangler pages project create siglum

# Create R2 bucket (if not exists)
wrangler r2 bucket create siglum-bundles
```

### Release order

The candidate package versions are filesystem 0.3.0, git 0.1.0 and engine 0.2.0.
The filesystem release removes the old worker entry point and adds shared
compression utilities, so it must not replace the published 0.2.1 package.

1. Review and push the four local commits. Publish filesystem 0.3.0 first, then
   git 0.1.0. The engine's npm release job deliberately installs the published
   filesystem dependency instead of the local development override.
2. Deploy `worker/` from this repository with `bun run deploy:worker`. It is the
   canonical adapter, including normalized packages, font aliases, byte ranges,
   versioned assets and the private, read-only Zotero proxy.
3. In the engine repository, run `bun run stage:runtime` and verify the printed
   directory with `scripts/verify-runtime.mjs`. Review
   `DRY_RUN=1 bash scripts/release.sh 0.2.0`, then run the release script without
   DRY_RUN when publication is authorized. Assets upload before runtime.json.
4. Verify `https://packages.siglum.org/releases/<releaseId>` with the engine's
   verification script. A healthy API alone does not prove the runtime exists.
5. Set the two values in `app/.env.production.local` using the example file.
   Build and deploy this tested workspace with `bun run deploy:pages`. Production
   builds reject localhost and missing or malformed release IDs.
6. Test the deployed site on desktop and a physical iPhone. Keep the previous
   Pages deployment and old runtime directories available for rollback.

The legacy unversioned `upload:r2` command is disabled. A local build, test or
snapshot does not publish packages, upload runtime files, or deploy the site.

See [release notes](RELEASE_NOTES.md) for changes, checks and remaining limitations.

## Dependencies

Uses these separate packages:
- [@siglum/engine](https://github.com/SiglumProject/siglum-engine) - TeX Live 2026 compiler (pdfTeX/XeTeX in WASM)
- [@siglum/git](https://github.com/SiglumProject/siglum-git) - Browser-based Git operations
- [@siglum/filesystem](https://github.com/SiglumProject/siglum-filesystem) - Filesystem abstraction

## Tech Stack

- React 18 + TypeScript + Vite
- CodeMirror 6 (editor)
- pdf.js (PDF rendering)
- Cloudflare Workers + R2 (API/storage)
- Cloudflare Pages (hosting)

## License

MIT
