#!/usr/bin/env bash
# Register the Cookie Dumper native messaging host with installed Chromium-family
# browsers. Run after loading the unpacked extension so you have its ID.
set -euo pipefail

HOST_NAME="com.aaronsb.cookiedumper"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="$DIR/host.js"

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  cat <<EOF
Usage: $0 <EXTENSION_ID>

Find the EXTENSION_ID at chrome://extensions with Developer mode on,
under the "Cookie Dumper" card (a 32-char string like 'abcdef... ').
EOF
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "warning: 'node' not found on PATH — the host won't run until it is." >&2
fi

chmod +x "$HOST_JS"

read -r -d '' MANIFEST <<JSON || true
{
  "name": "$HOST_NAME",
  "description": "Cookie Dumper native host",
  "path": "$HOST_JS",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON

installed=0
for base in \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/google-chrome-beta" \
  "$HOME/.config/google-chrome-unstable" \
  "$HOME/.config/chromium" \
  "$HOME/.config/microsoft-edge" \
  "$HOME/.config/BraveSoftware/Brave-Browser"; do
  if [[ -d "$base" ]]; then
    dest="$base/NativeMessagingHosts"
    mkdir -p "$dest"
    printf '%s\n' "$MANIFEST" > "$dest/$HOST_NAME.json"
    echo "installed: $dest/$HOST_NAME.json"
    installed=1
  fi
done

if [[ "$installed" != 1 ]]; then
  echo "No supported browser profile dir found under ~/.config." >&2
  exit 1
fi

echo "host path: $HOST_JS"
echo "Done. Fully quit and reopen the browser (or reload the extension) to pick it up."
