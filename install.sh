#!/usr/bin/env bash
# Cookie Dumper installer — XDG-compliant, idempotent.
#
#   curl -fsSL https://raw.githubusercontent.com/aaronsb/cookiedumper/main/install.sh | bash
#
# Installs the code into $XDG_DATA_HOME/cookiedumper, symlinks the CLI into your
# XDG bin dir (~/.local/bin), and registers the native messaging host. Re-running
# updates an existing install. Flags (pass via `... | bash -s -- --no-symlink`):
#   --no-symlink   don't link the `cookiedumper` command into bin
#   --no-host      don't register the native messaging host
#   --dir <path>   install location (default $XDG_DATA_HOME/cookiedumper)
#   --bin <path>   symlink target dir (default $XDG_BIN_HOME or ~/.local/bin)
set -euo pipefail

REPO="${COOKIEDUMPER_REPO:-https://github.com/aaronsb/cookiedumper.git}"
BRANCH="${COOKIEDUMPER_BRANCH:-main}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/cookiedumper"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DO_SYMLINK=1
DO_HOST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-symlink) DO_SYMLINK=0 ;;
    --no-host) DO_HOST=0 ;;
    --dir) DATA_DIR="$2"; shift ;;
    --bin) BIN_DIR="$2"; shift ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Print a shell-aware PATH hint. We do NOT edit the user's rc — we tell them how.
path_hint() {
  local dir="$1" sh rc
  sh="$(basename "${SHELL:-sh}")"
  case "$sh" in
    zsh)  rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) rc="$HOME/.bashrc" ;;
    *)    rc="$HOME/.profile" ;;
  esac
  warn "$dir is not on your PATH — the 'cookiedumper' command won't be found yet."
  printf "      Not editing your rc. Add it yourself (detected %s):\n" "$sh" >&2
  printf "        echo 'export PATH=\"%s:\$PATH\"' >> %s\n" "$dir" "$rc" >&2
  printf "      …or add %s to your existing PATH statement, then restart your shell.\n" "$dir" >&2
}

command -v node >/dev/null 2>&1 || die "Node.js (>=18) is required and was not found on PATH."

# ---- fetch / update ----
if [ -d "$DATA_DIR/.git" ]; then
  say "updating existing install at $DATA_DIR"
  git -C "$DATA_DIR" pull --ff-only --quiet || warn "git pull failed; keeping current checkout"
elif command -v git >/dev/null 2>&1; then
  say "cloning into $DATA_DIR"
  mkdir -p "$(dirname "$DATA_DIR")"
  rm -rf "$DATA_DIR"
  git clone --depth 1 --branch "$BRANCH" --quiet "$REPO" "$DATA_DIR"
else
  command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 || die "need git, or curl+tar, to fetch the code."
  say "downloading tarball into $DATA_DIR (git not found)"
  mkdir -p "$DATA_DIR"
  tgz="$(mktemp)"
  curl -fsSL "${REPO%.git}/archive/refs/heads/$BRANCH.tar.gz" -o "$tgz"
  tar -xzf "$tgz" -C "$DATA_DIR" --strip-components=1
  rm -f "$tgz"
fi

chmod +x "$DATA_DIR/cli.js" "$DATA_DIR/host.js" 2>/dev/null || true

# ---- symlink the CLI into bin ----
if [ "$DO_SYMLINK" = 1 ]; then
  mkdir -p "$BIN_DIR"
  ln -sf "$DATA_DIR/cli.js" "$BIN_DIR/cookiedumper"
  say "linked $BIN_DIR/cookiedumper -> cli.js"
  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *) path_hint "$BIN_DIR" ;;
  esac
fi

# ---- register native messaging host (id is baked in from the manifest key) ----
if [ "$DO_HOST" = 1 ]; then
  say "registering native messaging host"
  node "$DATA_DIR/cli.js" host install >/dev/null || warn "host install reported an issue"
fi

CLI_HINT="node $DATA_DIR/cli.js"
[ "$DO_SYMLINK" = 1 ] && CLI_HINT="cookiedumper"

cat <<EOF

$(say "cookiedumper installed")
  code : $DATA_DIR
  cli  : $CLI_HINT

Finish in the browser:
  1. chrome://extensions  ->  Developer mode  ->  Load unpacked  ->  $DATA_DIR
  2. Reload the extension (↻) — the native host is already registered
  3. $CLI_HINT status        # expect {"ok":true,...}
EOF
