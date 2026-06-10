#!/usr/bin/env bash
# Cookie Dumper uninstaller — removes the CLI symlink and the native host
# registration. Leaves your checkout in place (delete it yourself if you want).
#
#   curl -fsSL https://raw.githubusercontent.com/aaronsb/cookiedumper/main/uninstall.sh | bash
set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/cookiedumper"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if [ -f "$DATA_DIR/cli.js" ] && command -v node >/dev/null 2>&1; then
  node "$DATA_DIR/cli.js" host uninstall >/dev/null 2>&1 || true
  echo "removed native messaging host registration"
fi

if [ -L "$BIN_DIR/cookiedumper" ]; then
  rm -f "$BIN_DIR/cookiedumper"
  echo "removed $BIN_DIR/cookiedumper"
fi

if [ "$PURGE" = 1 ]; then
  rm -rf "$DATA_DIR"
  echo "purged $DATA_DIR"
else
  echo "left code at $DATA_DIR  (re-run with --purge to delete it)"
fi
echo "note: also remove the extension from chrome://extensions"
