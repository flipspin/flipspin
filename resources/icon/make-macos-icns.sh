#!/usr/bin/env bash
# The macOS icns, size by size. Run from the repo root after render.mjs.
#
# krobi-macos-1024.png is the artwork on Apple's Big Sur grid (824 px rounded
# square, soft shadow). `tauri icon` overwrites src-tauri/icons/icon.icns with
# a full-bleed square; run this after it.
set -euo pipefail
SRC=resources/icon/krobi-macos-1024.png; T=$(mktemp -d)
mkdir "$T/krobi.iconset"
for px in 16 32 64 128 256 512 1024; do magick "$SRC" -filter Lanczos -resize ${px}x${px} "PNG32:$T/i-$px.png"; done
for s in 16 32 128 256 512; do cp "$T/i-$s.png" "$T/krobi.iconset/icon_${s}x${s}.png"; cp "$T/i-$((s*2)).png" "$T/krobi.iconset/icon_${s}x${s}@2x.png"; done
iconutil -c icns "$T/krobi.iconset" -o src-tauri/icons/icon.icns
echo "wrote src-tauri/icons/icon.icns"
