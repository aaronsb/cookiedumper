#!/usr/bin/env bash
# Remove the Cookie Dumper native messaging host manifest from all browsers.
set -euo pipefail

HOST_NAME="com.aaronsb.cookiedumper"
removed=0
for base in \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/google-chrome-beta" \
  "$HOME/.config/google-chrome-unstable" \
  "$HOME/.config/chromium" \
  "$HOME/.config/microsoft-edge" \
  "$HOME/.config/BraveSoftware/Brave-Browser"; do
  f="$base/NativeMessagingHosts/$HOST_NAME.json"
  if [[ -f "$f" ]]; then
    rm -f "$f"
    echo "removed: $f"
    removed=1
  fi
done

[[ "$removed" == 1 ]] && echo "Done." || echo "Nothing to remove."
