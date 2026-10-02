#!/usr/bin/env sh
# Installs Quicksilver as a personal Claude Code skill, then detects an exported key (or asks for one once).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/quicksilver"
command -v node >/dev/null 2>&1 || { echo "Quicksilver needs Node 18+ (https://nodejs.org)"; exit 1; }
mkdir -p "$DEST"
cp -R "$DIR/skills/quicksilver/." "$DEST/"
echo "Installed to $DEST"
node "$DEST/scripts/qs.mjs" status >/dev/null 2>&1 || node "$DEST/scripts/qs.mjs" setup
node "$DEST/scripts/qs.mjs" status
