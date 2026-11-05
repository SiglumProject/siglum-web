# Siglum documentation

Siglum is a free, open-source LaTeX editor that compiles documents in your browser. It runs TeX Live locally. You can start editing without a Siglum account.

## Try the editor

1. [Open Siglum](https://siglum.org/) and choose **Open the editor**.
2. Edit the sample document or open your LaTeX source files.
3. Compile the document and check the PDF preview. Download the PDF when it is ready.

The editor supports pdfLaTeX and XeLaTeX. Common packages are bundled. Additional packages are fetched as needed and cached in the browser.

Your source files are stored in this browser. Offline compilation needs the engine and the document's dependencies to be cached first. Read [Storage and offline use](https://siglum.org/docs/storage/) before relying on it away from a network connection.

## Optional connections

**GitHub** can synchronize a repository for version control and backup. Connect it in **Help → Integrations** using your repository and access token. Synchronization sends repository files to GitHub through the configured Git proxy.

**Zotero** can supply references to the citation picker. Connect it in **Help → Integrations** using your Zotero user ID and API key. Library requests use the Zotero API through Siglum's package service.

These connections use your provider credentials and need a network connection for synchronization. Local editing and compilation can be used without either connection.

## Use the compiler in your own project

The compiler is available separately as [`@siglum/engine`](https://www.npmjs.com/package/@siglum/engine). Its JavaScript API, worker, hosted runtime, and public package proxy can be used in another browser application. See [Engine and package API](https://siglum.org/docs/engine/) for installation and setup.

## Source repositories

- [siglum-web](https://github.com/SiglumProject/siglum-web) contains the editor and its Cloudflare package-service adapter.
- [siglum](https://github.com/SiglumProject/siglum) contains the compiler SDK, lazy filesystem, bundle tooling, and standalone package proxy.
- [siglum-filesystem](https://github.com/SiglumProject/siglum-filesystem) provides browser storage through OPFS and IndexedDB.
- [siglum-git](https://github.com/SiglumProject/siglum-git) provides browser Git operations and synchronization.
- [BusyTeX fork](https://github.com/SiglumProject/busytex) builds the matching WebAssembly compiler and TeX Live data. It builds on [upstream BusyTeX](https://github.com/busytex/busytex).

Report editor problems in [siglum-web issues](https://github.com/SiglumProject/siglum-web/issues) and compiler or package-resolution problems in [siglum issues](https://github.com/SiglumProject/siglum/issues). Include a small document that reproduces the problem and the browser you used.
