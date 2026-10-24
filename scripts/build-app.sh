#!/bin/sh
# Build the Orchestra TV app (IPK) into dist/.
#
# Needs ares-package from @webosose/ares-cli:
#   npm install --no-save @webosose/ares-cli
# If it is not on PATH, point ARES_PACKAGE at it.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
ARES_PACKAGE="${ARES_PACKAGE:-ares-package}"

if ! command -v "$ARES_PACKAGE" >/dev/null 2>&1; then
  echo "ares-package not found. Install @webosose/ares-cli or set ARES_PACKAGE." >&2
  exit 1
fi

mkdir -p "$OUT"
rm -f "$OUT"/com.andrei.orchestra_*.ipk
"$ARES_PACKAGE" --no-minify -o "$OUT" "$ROOT/app"
ls -l "$OUT"/com.andrei.orchestra_*.ipk
