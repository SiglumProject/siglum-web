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
explicit HTTPS `VITE_API_BASE` and a staged `VITE_ENGINE_RELEASE`. Use
`app/.env.production.example` as the template for the hosted app.

Build against the deployed engine URL and verify the staged TeX Live 2026
runtime before publishing the app. See the release order below.

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

1. Prepare the immutable runtime in the reviewed engine checkout. For the June
   2026 update, upload and verify the runtime, then publish the matching
   `@siglum/engine@0.2.1` patch before releasing the app.
   [Engine release steps](https://github.com/SiglumProject/siglum/blob/main/docs/releasing.md)
2. Deploy `worker/` with `bun run deploy:worker` for first-time setup or when
   the adapter changes. The `siglum-api-2026` Worker serves `/releases/tl2026-*`
   on both package hosts and `/api/zotero/*` on the package host. Keep the
   existing `siglum-api` Worker and its catch-all routes for older clients.
3. Verify `https://packages.siglum.org/releases/<releaseId>` with the engine's
   `scripts/verify-runtime.mjs`. The existing release routes serve new immutable
   runtime IDs as soon as the assets are uploaded.
4. Run `bun run prepare:release`, then `bun run preview:release` and
   `bun run test:release` against the staged runtime. Deploy the tested
   artifact with `wrangler pages deploy .local-release/site --project-name siglum`.
   For a manual production build, set both values in `app/.env.production.local`
   using the example file.
5. Test the deployed site on desktop and a physical iPhone. Keep the previous
   Pages deployment and old runtime directories available for rollback.

The legacy unversioned `upload:r2` command is disabled. A local build, test or
snapshot does not publish packages, upload runtime files, or deploy the site.

See the [initial TeX Live 2026 release notes](RELEASE_NOTES.md) for the 0.2.0 rollout.

## Dependencies

Uses these separate packages:
- [@siglum/engine](https://github.com/SiglumProject/siglum) - TeX Live 2026 compiler (pdfTeX/XeTeX in WASM)
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
