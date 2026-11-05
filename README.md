# Siglum

A free, open-source LaTeX editor that compiles TeX Live in your browser.
Documents are stored locally. Cached dependencies support offline compilation.
GitHub sync and Zotero references are optional.

[Open Siglum](https://siglum.org/) · [Documentation](https://siglum.org/docs/)

## Quick start

```sh
git clone https://github.com/SiglumProject/siglum-web.git
cd siglum-web
bun install
bun run dev
```

Open the local URL printed by Vite. Published npm packages and the hosted
compiler runtime are selected automatically.

[Development](docs/development.md) covers working on the libraries locally.
See the reusable
[compiler SDK](https://github.com/SiglumProject/siglum), and the
[package API](https://github.com/SiglumProject/siglum/blob/main/docs/ctan-proxy.md#public-package-api).

MIT licensed.
