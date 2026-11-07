#!/bin/bash
set -euo pipefail
recipe="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work="${1:?Pass a disposable build directory}"
mkdir -p "$work"
work="$(cd -- "$work" && pwd)"
curl --fail --location 'https://downloads.sourceforge.net/project/gnuplot/gnuplot/6.0.2/gnuplot-6.0.2.tar.gz' --output "$work/source.tar.gz"
echo 'f68a3b0bbb7bbbb437649674106d94522c00bf2f285cce0c19c3180b1ee7e738  '"$work/source.tar.gz" | shasum -a 256 --check
tar -xzf "$work/source.tar.gz" -C "$work"
patch -d "$work/gnuplot-6.0.2" -p1 < "$recipe/gnuplot-wasm.patch"
cp "$recipe/build-inside.sh" "$recipe/native-process-policy.c" "$work/"
docker run --rm --network none --platform linux/amd64 --mount "type=bind,src=$work,dst=/bench" --workdir /bench/gnuplot-6.0.2 'emscripten/emsdk@sha256:e856cd59d54fd143366c2df314043d63a1ca23ab43521e0f30f9d9a7ce6d43e0' bash /bench/build-inside.sh
printf 'Built artifacts: %s/local-built\n' "$work"
