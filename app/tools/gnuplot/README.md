# Browser Gnuplot provider

The application explicitly registers this optional process provider for real
Gnuplot scripts emitted by LaTeX packages. It runs Gnuplot in a disposable worker,
loads requested project/generated files through the scoped tool protocol, and
returns generated files only after a successful exit. It does not emulate script
syntax or modify LaTeX input. Source/package discovery stays in the engine.

Each invocation has a timeout, bounded file transfers and output, cancellation,
and native subprocess denial. Its immutable assets are cached by the application
for subsequent offline use. A fresh offline browser still needs to download the
tool and document dependencies once.

The upstream copyright and source/build hashes are included here. The build
recipe in `build/` reproduces the assets from the pinned source archive and
Emscripten image. The small source patch fixes an unconditional error in the
no-fenv special-function fallback; the version identifies this local modification.
