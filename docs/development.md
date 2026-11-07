# Development

## Web app

The web app installs its engine, filesystem, and Git libraries from npm. Clone
only this repository, then run `bun install` and `bun run dev` from its root.
The Vite configuration selects a compatible hosted runtime for the installed
engine. It prefers the SDK-specific discovery endpoint; releases made before
discovery was introduced use the manifest linked in their GitHub release notes.
The verified metadata is cached in `.local-release/` for offline server restarts.
The browser must also have the document's dependencies cached for offline compilation.

Use `bun run build` for a build against the hosted runtime. `bun run build:local`
keeps the existing local compiler-server configuration for integration checks.

```sh
bun run test:setup
bun run --cwd app test
bun run --cwd worker check
bun run --cwd worker test
bun run build
```

The first installation and hosted runtime selection need network access.
To use your own runtime, set `VITE_API_BASE` and `VITE_ENGINE_RELEASE` in your
Vite environment. This bypasses automatic hosted selection.

## Workspace

The multi-repository workspace is optional. Use it when editing the engine,
filesystem, or Git library alongside the web app, or when building compiler
assets and preparing a source release. Clone the repositories in the layout below. The engine checkout is named
`siglum-engine`; its GitHub repository is `SiglumProject/siglum`. Use the Bun
release declared in the root package manifest.

```sh
mkdir siglum-workspace
cd siglum-workspace
git clone https://github.com/SiglumProject/siglum.git siglum-engine
git clone https://github.com/SiglumProject/siglum-filesystem.git
git clone https://github.com/SiglumProject/siglum-git.git
git clone https://github.com/SiglumProject/siglum-web.git webtex/siglum-ui
```

Prepare the compiler runtime using the engine's
[build and restore guide](https://github.com/SiglumProject/siglum/blob/main/docs/building.md)
before starting the workspace. Runtime assets are distributed separately from
the JavaScript packages.

## Local library commands and checks

Use the Bun release declared by the root `package.json` `packageManager` field.
The [CI workflow](../.github/workflows/ci.yml) records the Node toolchain and uses
the root lockfile for published dependencies. The optional preparation command creates an ignored workspace under
`.local-release/workspace/` with these local repositories:

```text
code/
  siglum-engine/
  siglum-filesystem/
  siglum-git/
  webtex/siglum-ui/       # this repository
```

From this repository:

```bash
bun run prepare:local   # install source workspace, build shared packages, sync runtime
bun run dev:all         # engine on 8787 and UI on 5174
bun run dev:lan         # phone/tablet access on the same local network
bun run check:all       # all four suites, real browser engine tests, local UI build
bun run build:local     # local preview output in app/dist
bun run snapshot:local  # source/runtime archives, package candidates, checksums
```

Local snapshots are saved under `.local-release/` and include uncommitted source
and runtime assets. They exclude local environment secrets and browser documents.

Open http://127.0.0.1:5174/. The start command reuses existing Siglum servers and
only stops processes it started. LAN mode prints this computer's network URL;
compiler requests use the UI proxy, so the engine can stay on loopback. Runtime assets (`busytex.js`, `busytex.wasm`,
`dist/`, and `packages/bundles/`) must already exist in the engine checkout; they
are intentionally separate from the source packages. The engine stays on loopback in LAN mode; the browser uses the UI proxy.

The optional preparation command installs the generated workspace and builds
the shared packages. Its lockfile stays inside `.local-release/`; it does not
replace the default npm dependency lockfile. Workspace links pick up source changes directly. It also aligns the test and release runtime copies with the binaries
in `busytex/build/wasm`, preserving replaced files in `.local-runtime-backups/`. Keep the default UI lockfile and the standalone library lockfiles with the source changes. The generated workspace links compatible local library versions;
normal single-checkout installs use the published package ranges.

`app/.env.local-preview` configures builds against the local compiler server.

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

## Packages

| Package | Used for | Source |
| --- | --- | --- |
| [@siglum/engine](https://www.npmjs.com/package/@siglum/engine) | TeX Live compiler (pdfTeX/XeTeX in WASM) | [siglum](https://github.com/SiglumProject/siglum) |
| [@siglum/git](https://www.npmjs.com/package/@siglum/git) | Browser-based Git operations | [siglum-git](https://github.com/SiglumProject/siglum-git) |
| [@siglum/filesystem](https://www.npmjs.com/package/@siglum/filesystem) | Filesystem abstraction | [siglum-filesystem](https://github.com/SiglumProject/siglum-filesystem) |

## Application stack

- React + TypeScript + Vite
- CodeMirror (editor)
- pdf.js (PDF rendering)
- Cloudflare Workers + R2 (API/storage)
- Cloudflare Pages (hosting)

Contributor guidance: [AGENTS.md](../AGENTS.md).

### Coordinated worktrees

`bun run link:local` creates the private source workspace and installs its shared
dependencies without replacing native runtime files. Library worktrees can be
selected with `SIGLUM_ENGINE_SOURCE`, `SIGLUM_FILESYSTEM_SOURCE` and
`SIGLUM_GIT_SOURCE`. Alternatively, keep those three paths under the corresponding
`engine`, `filesystem` and `git` keys in ignored
`.local-release/source-paths.json`. Relative paths are resolved from this checkout.
The published package ranges and normal lockfile stay unchanged.

Use the matching local compiler runtime for the performance branch. The BusyTeX
fork is a Git submodule; npm libraries are selected by this source workspace.
Matching branch names alone do not select another repository's code.
