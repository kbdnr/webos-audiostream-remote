#!/bin/sh
# Cross-compiles native/dile-capture.c for the TV's 32-bit soft-float ARM userland
# (interpreter /lib/ld-linux.so.3) in a Debian container. Bullseye's glibc 2.31 still
# emits the old GLIBC_2.4 symbol versions that webOS 4's libc provides.
set -e
cd "$(dirname "$0")/.."
ENGINE=$(command -v podman || command -v docker) || { echo "needs podman or docker" >&2; exit 1; }
mkdir -p native/build
"$ENGINE" run --rm -v "$PWD/native:/src" -w /src debian:bullseye sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq gcc-arm-linux-gnueabi >/dev/null &&
  arm-linux-gnueabi-gcc -O2 -Wall -Wextra -march=armv7-a -mfloat-abi=soft \
    -o build/dile-capture dile-capture.c -ldl &&
  arm-linux-gnueabi-strip build/dile-capture'
echo "built native/build/dile-capture"
