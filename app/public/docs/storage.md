# Storage and offline use

Siglum compiles LaTeX on your device. Source files, editor state, and downloaded dependencies use browser storage.

## Where your work lives

The editor uses the browser's Origin Private File System (OPFS) when it is available and writable. IndexedDB provides a fallback. The filesystem remembers the selected backend and can recover existing IndexedDB documents when an older installation selected an empty OPFS store.

Storage belongs to a particular site origin and browser profile. An origin includes the protocol, host, and port. Your work on `https://siglum.org` and your work on a local development server occupy separate storage. Use an exported copy or a Git repository to move a project between them.

Browser storage is not a backup. Clearing site data, removing a browser profile, private-browsing cleanup, or browser storage eviction can remove documents and cached dependencies. Keep an external copy of your source files or synchronize a repository with the optional GitHub connection.

## Prepare for offline work

1. Open the editor while online and load your project.
2. Compile the documents you plan to work on. This downloads the engine, packages, and fonts those documents need.
3. Disconnect from the network, reopen the editor, and compile an edit to confirm that the project is ready.

The app caches its shell and runtime assets. The engine also caches downloaded TeX dependencies. A document that introduces an uncached package or font needs a connection to fetch it. A new runtime release can need its own downloads because caches are separated by runtime version.

GitHub synchronization and Zotero library requests need a network connection. Keep the source and bibliography files you need in the project before going offline.

## What uses the network

- The editor downloads its application files, compiler runtime, and requested TeX packages or fonts.
- Connecting GitHub synchronizes the selected repository through the configured Git proxy.
- Connecting Zotero sends authenticated library requests through the package service to Zotero.

Compilation runs in the browser. The package service supplies TeX dependencies; your document is compiled locally.

## If saved work does not reopen

Return to the same site and browser profile where you saved it. If the editor reports a temporary storage-access error, use its reload control to retry. An error reading a file can differ from a file that has been deleted, so preserve the browser's existing site data while investigating.

Recovery after site data has been removed depends on an exported or synchronized copy. [GitHub integration](https://siglum.org/docs/#optional-connections) is one way to keep that copy outside the browser.

For implementation details, see the [`@siglum/filesystem` README](https://github.com/SiglumProject/siglum-filesystem#readme) and the [editor's Git recovery documentation](https://github.com/SiglumProject/siglum-web/blob/main/docs/development.md#git-recovery).
