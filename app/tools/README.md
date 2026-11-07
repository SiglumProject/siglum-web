# Browser tool providers

`providers.json` explicitly registers optional programs and their adapter entry points. Protocol handling lives in each provider directory. The compiler owns generic arguments, scoped file access, cancellation, limits, output transactions and TeX convergence.

Builds and the Vite plugin automatically generate content-addressed public assets, per-provider worker CSP descriptors and `src/generated/browserTools.ts`. Edit the provider source and descriptor; do not hand-edit generated URLs or version strings. Old immutable assets/policies are retained for cached clients. Provider runtime license files must be preserved; the runtime assets keep their upstream licenses.

The Vite plugin applies worker policies in development and preview. A static deployment must apply the generated per-provider policies at its HTTP layer before publishing new tools. Keep all programs lazy; ordinary documents must not fetch tool runtimes. Run `bun test scripts/browserTools.test.ts scripts/browserToolsPlugin.test.ts` after changing asset packaging.

For the root-cause-first compatibility policy, see the engine's `docs/tool-providers.md`. An adapter supplies a real external program; it must not patch LaTeX packages or fabricate missing project inputs.
