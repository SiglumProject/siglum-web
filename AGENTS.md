# Siglum editor and package-service adapter

Siglum is free software. This repository contains the browser editor in `app/`
and the Cloudflare package-service adapter in `worker/`.

## Repository map

- `SiglumProject/siglum-web` contains this editor and hosted service adapter.
- `SiglumProject/siglum` publishes `@siglum/engine` and the versioned TeX runtime.
- `SiglumProject/siglum-filesystem` publishes `@siglum/filesystem`.
- `SiglumProject/siglum-git` publishes `@siglum/git`.
- `SiglumProject/busytex` contains the compiler fork and its build provenance.

## Workspace and validation

Use the Bun release declared by the root `package.json` `packageManager` field.
The default install uses the published npm packages and requires only this
checkout. `bun run dev` selects a compatible hosted compiler runtime; explicit
Vite runtime configuration overrides that selection.

```sh
bun install --frozen-lockfile
bun run test:setup
bun run --cwd app test
node --check app/public/sw.js
bun run --cwd worker check
bun run --cwd worker test
bun run build
```

For changes spanning the libraries, follow the optional source
[workspace setup](docs/development.md#workspace). `prepare:local` installs a
generated workspace under `.local-release/`, keeping the normal package
manifests and lockfile unchanged. The source-integration `dev:all`, `dev:lan`,
and `check:all` commands still need the local libraries and compiler assets.

Use the shared filesystem instance across the editor, compiler, and Git
connector. Preserve document save ordering, recovery behavior, and separate
files when changing storage code.

Keep the README focused on what the editor is and its quick start. Contributor
setup and checks belong in [development](docs/development.md). Keep maintainer
publication and deployment procedures in ignored local notes, outside public
documentation.

## Public documentation

`app/public/docs/` contains static HTML and matching Markdown. Update both when
changing documentation and verify their links against the package exports and
runtime manifest. `llms.txt` indexes the public pages. `sitemap.xml` lists actual
HTML pages. Keep canonical URLs consistent with the public site.

Keep evergreen setup instructions versionless. Read package and tool versions
from the manifests, lockfiles, and CI pins. Read runtime identity, format dates,
and checksums from the matching release artifacts. Link published releases
instead of repeating the current version or content hash in explanatory text.

`app/prerender.ts` renders the existing landing component during a Vite build.
Browser storage access belongs in effects and event handlers so that the static
render can run without browser globals.

## Release boundaries

Runtime assets and LaTeX formats must come from compatible releases. Browser
checks live in `scripts/`.

Publishing packages, uploading runtime assets, and deploying the site require
user authorization. Discovery documentation must reflect released behavior and
retain upstream credits. Keep document contents and compiler timings local.
