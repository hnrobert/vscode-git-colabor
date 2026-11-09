#!/usr/bin/env bash
# One-command LOCAL dev loop for the Git Colabor extension.
#
# build → package → install the vsix into local VS Code (--force) →
# rewrite the dev-reload marker so every running window picks the new code
# up (each window watches the marker; a matching package.json hash restarts
# just the extension host, a mismatch forces a full window reload for new
# menu/command contributions) → verify from the extension-host logs.
#
# The marker content is the sha256 of the INSTALLED package.json (same
# contract as remote-dev.sh): matching our own package.json = code-only.
#
# Usage:
#   build-scripts/local-dev.sh          # full loop (default)
#   build-scripts/local-dev.sh --fast   # skip build; package the tree as-is

set -euo pipefail

cd "$(dirname "$0")/.."

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

echo "==> build"
if [ "$FAST" -eq 0 ]; then
  pnpm build >/dev/null
fi

echo "==> package"
VSIX="$(pnpm package 2>/dev/null | grep -o '[^ ]*\.vsix' | tail -1)"
if [ -z "$VSIX" ] || [ ! -f "$VSIX" ]; then
  echo "error: packaging produced no vsix" >&2
  exit 1
fi
echo "    $VSIX"

echo "==> install (local VS Code)"
code --install-extension "$VSIX" --force >/dev/null 2>&1

EXT_ID="hnrobert.vscode-git-colabor"
EXT_DIR="$(ls -dt ~/.vscode/extensions/${EXT_ID}-* 2>/dev/null | head -1)"
if [ -z "$EXT_DIR" ]; then
  echo "error: installed extension dir not found" >&2
  exit 1
fi
echo "    $EXT_DIR"

echo "==> dev-reload marker"
HASH="$(shasum -a 256 "$EXT_DIR/package.json" | awk '{print $1}')"
MARKER="${XDG_CONFIG_HOME:-$HOME/.config}/git-colabor/dev-reload"
mkdir -p "$(dirname "$MARKER")"
printf '%s' "$HASH" > "$MARKER"
echo "    $MARKER"

echo "==> waiting for extension-host restarts"
sleep 4
RESTARTS="$(grep -h "dev-reload marker changed" "$HOME/Library/Application Support/Code/logs"/*/window*/exthost/${EXT_ID}/Git\ Colabor.log 2>/dev/null | tail -2 | wc -l | tr -d ' ')"
if [ "$RESTARTS" -gt 0 ]; then
  echo "    $RESTARTS window(s) reloading"
else
  echo "    no running window picked it up yet (they poll every 2s — or none is open)"
fi

echo "done."
