#!/bin/bash
set -euo pipefail
emcc --version > /bench/toolchain.txt
export CFLAGS='-O3'
export CXXFLAGS='-O3'
export LDFLAGS="-O3 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORTED_RUNTIME_METHODS=FS,callMain -s EXPORTED_FUNCTIONS=_main,_siglum_gnuplot_denied_system_calls -s ENVIRONMENT=worker -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=16777216 -s MAXIMUM_MEMORY=67108864 -s ASSERTIONS=0"
if [[ ! -f Makefile ]]; then
emconfigure ./configure --host=wasm32-unknown-emscripten --disable-largefile --disable-plugins --disable-history-file --disable-x11-mbfonts --disable-x11-external --disable-raise-console --disable-wxwidgets --without-libcerf --without-latex --without-kpsexpand --without-x --without-x-dcop --without-aquaterm --without-readline --without-lua --with-cwdrc --without-row-help --without-wx-multithreaded --without-bitmap-terminals --without-tektronix --without-gpic --without-tgif --without-mif --without-regis --without-cairo --without-qt
fi
emcc -O3 -c /bench/native-process-policy.c -o /bench/native-process-policy.o
rm -f src/gnuplot
emmake make -C src -j2 gnuplot LDFLAGS="$LDFLAGS" AM_LDFLAGS="/bench/native-process-policy.o -Wl,--wrap=system -Wl,--wrap=popen -Wl,--wrap=pclose --embed-file ../term/js@/usr/local/share/gnuplot/6.0/js"
mkdir -p /bench/local-built
cp src/gnuplot /bench/local-built/gnuplot.js
cp src/gnuplot.wasm /bench/local-built/gnuplot.wasm
