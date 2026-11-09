#!/bin/sh
# Builds dist/rewind-for-x-<version>.zip for the Chrome Web Store: only the
# files the extension runs, no tests, tools or store assets.
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="dist/rewind-for-x-$version.zip"
mkdir -p dist
rm -f "$out"
zip -qrX "$out" manifest.json background.js content.js _locales icons ocr -x '*.DS_Store'
unzip -l "$out"
