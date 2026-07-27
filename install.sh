#!/usr/bin/env bash
# Cookie Dumper installer — XDG-compliant, idempotent.
#
#   curl -fsSL https://raw.githubusercontent.com/aaronsb/cookiedumper/main/install.sh | bash
#
# Installs the code into $XDG_DATA_HOME/cookiedumper, symlinks the CLI into your
# XDG bin dir (~/.local/bin), registers the native messaging host, provisions the
# shared config dir + bearer token, and verifies the host can actually be spawned.
# Re-running updates an existing install.
#
# Run with --help for flags and environment variables. That text lives in usage()
# below rather than up here: when the script is piped from curl — the documented
# way to run it — $0 is `bash` and there is no file to scrape a header out of.
set -euo pipefail

REPO="${COOKIEDUMPER_REPO:-https://github.com/aaronsb/cookiedumper.git}"
BRANCH="${COOKIEDUMPER_BRANCH:-main}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/cookiedumper"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
# Deliberately NOT XDG_CONFIG_HOME: host.js resolves
# `process.env.COOKIEDUMPER_DIR || ~/.config/cookiedumper`, so honouring XDG here
# would put the token somewhere the host never looks.
CONFIG_DIR="${COOKIEDUMPER_DIR:-$HOME/.config/cookiedumper}"
DO_SYMLINK=1
DO_HOST=1
DO_VERIFY=1

# Single source of truth for --help. Quoted heredoc, so the $VARs below are shown
# literally rather than expanded to this machine's values.
usage() {
  cat <<'USAGE'
Cookie Dumper installer — XDG-compliant, idempotent.

  curl -fsSL https://raw.githubusercontent.com/aaronsb/cookiedumper/main/install.sh | bash

Installs the code into $XDG_DATA_HOME/cookiedumper, symlinks the CLI into your
XDG bin dir (~/.local/bin), registers the native messaging host, provisions the
shared config dir + bearer token, and verifies the host can actually be spawned.
Re-running updates an existing install.

Flags (pass via `... | bash -s -- --no-symlink`):
  --no-symlink   don't link the `cookiedumper` command into bin
  --no-host      don't register the native messaging host
  --no-verify    skip the post-install native-host spawn check
  --dir <path>   install location (default $XDG_DATA_HOME/cookiedumper)
  --bin <path>   symlink target dir (default $XDG_BIN_HOME or ~/.local/bin)

Environment:
  COOKIEDUMPER_DIR     config dir. Must match host.js, which reads the same
                       variable and otherwise defaults to ~/.config/cookiedumper.
  COOKIEDUMPER_REPO    clone source and branch. The defaults are baked in, so
  COOKIEDUMPER_BRANCH  running a FORK's copy of this script still installs
                       upstream unless COOKIEDUMPER_REPO is set — the script
                       installs the project, not whatever checkout you ran it from.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-symlink) DO_SYMLINK=0 ;;
    --no-host) DO_HOST=0 ;;
    --no-verify) DO_VERIFY=0 ;;
    --dir) DATA_DIR="$2"; shift ;;
    --bin) BIN_DIR="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
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

# ---- provision the shared config dir + bearer token ----
# host.js creates these lazily on its first successful spawn, which means a fresh
# install has no token until a browser has run. Provisioning here decouples the
# CLI from "has the extension ever connected?", removes the multi-profile
# link()-race on first launch, and makes an absent token diagnostic rather than
# routine. Format must match host.js loadOrCreateToken(): 32 random bytes as hex
# (readToken() accepts any trimmed string >= 32 chars), mode 0600.
say "provisioning config dir $CONFIG_DIR"
mkdir -p "$CONFIG_DIR/servers"
chmod 700 "$CONFIG_DIR" "$CONFIG_DIR/servers" 2>/dev/null || true
if [ -s "$CONFIG_DIR/token" ]; then
  say "shared token already present (left untouched)"
else
  if node -e '
    const fs=require("fs"), crypto=require("crypto");
    const f=process.argv[1], tmp=f+"."+process.pid+".tmp";
    fs.writeFileSync(tmp, crypto.randomBytes(32).toString("hex"), {mode:0o600});
    try { fs.linkSync(tmp, f); } catch (_) { /* a host beat us to it */ }
    finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  ' "$CONFIG_DIR/token" 2>/dev/null && [ -s "$CONFIG_DIR/token" ]; then
    say "created shared token"
  else
    warn "could not pre-create $CONFIG_DIR/token; the host will create it on first spawn"
  fi
fi

# ---- verify the native host can actually be spawned ----
# The installer previously told the user to "expect {\"ok\":true,...}" without
# checking anything, so a broken host surfaced only as a silent failure in the
# browser with no way to tell host-side from browser-side.
#
# Two details make this check meaningful rather than decorative:
#   1. It execs the LAUNCHER (what the manifest points at) directly, with no
#      explicit interpreter — exactly how the browser starts the host.
#   2. It does so under launchd's minimal PATH, which is what a GUI-launched
#      browser actually inherits. Verifying under the installing shell's PATH
#      would pass on machines where the browser fails, which is the whole bug.
GUI_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
verify_host() {
  target="$DATA_DIR/host-launcher.sh"
  [ -x "$target" ] || target="$DATA_DIR/host.js"
  COOKIEDUMPER_VERIFY_TARGET="$target" COOKIEDUMPER_GUI_PATH="$GUI_PATH" node -e '
    const {spawn}=require("child_process");
    const target=process.env.COOKIEDUMPER_VERIFY_TARGET;
    const origin="chrome-extension://verify.invalid/";
    const env={PATH:process.env.COOKIEDUMPER_GUI_PATH,HOME:process.env.HOME};
    if(process.env.COOKIEDUMPER_DIR) env.COOKIEDUMPER_DIR=process.env.COOKIEDUMPER_DIR;
    const child=spawn(target,[origin],{stdio:["pipe","pipe","pipe"],env});
    let buf=Buffer.alloc(0), errs="", done=false;
    const finish=(code,msg)=>{ if(done)return; done=true; if(msg)console.log(msg);
      try{child.kill("SIGTERM");}catch(_){} process.exit(code); };
    child.on("error",e=>finish(1,"spawn failed: "+e.message));
    // A host that dies before sending `ready` (syntax error, missing module, bad
    // shebang) exits immediately — report that now instead of waiting for the timeout.
    child.on("exit",(code,sig)=>finish(1,"host exited early (code="+code+" sig="+sig+")"+
      (errs?": "+errs.trim().split("\n").slice(0,2).join(" | "):"")));
    child.stderr.on("data",d=>{errs+=d.toString();});
    child.stdout.on("data",d=>{
      buf=Buffer.concat([buf,d]);
      while(buf.length>=4){
        const n=buf.readUInt32LE(0);
        if(buf.length<4+n) break;
        const msg=JSON.parse(buf.slice(4,4+n).toString("utf8"));
        buf=buf.slice(4+n);
        if(msg.type==="ready") finish(0,"port "+msg.server.port);
      }
    });
    // A host that dies instantly (exit 127 from a bad shebang) closes stdin before
    // this write lands, and an unhandled EPIPE would crash the check with a stack
    // trace instead of reporting the diagnostic below — in exactly the failure case
    // the check exists for. Swallow it and let the exit handler do the reporting.
    child.stdin.on("error",()=>{});
    const body=Buffer.from(JSON.stringify({type:"hello"}),"utf8");
    const len=Buffer.alloc(4); len.writeUInt32LE(body.length,0);
    child.stdin.write(Buffer.concat([len,body]));
    setTimeout(()=>finish(1,"timed out waiting for ready"+(errs?": "+errs.trim().split("\n")[0]:"")),5000);
  ' 2>&1
}

if [ "$DO_VERIFY" = 1 ]; then
  say "verifying the native host can be spawned"
  if out="$(verify_host)"; then
    say "native host OK ($out, under a GUI-minimal PATH)"
  else
    warn "native host did NOT come up: $out"
    warn "the browser side cannot work until this does. checked under PATH=$GUI_PATH,"
    warn "which is what a GUI-launched browser inherits. if the error is 'node: No such"
    warn "file or directory', the launcher is missing or stale — re-run '$CLI_HINT host install'."
    warn "otherwise check '$DATA_DIR/host.js' is executable and 'xattr -l' is clean of"
    warn "com.apple.quarantine."
  fi
fi

cat <<EOF

$(say "cookiedumper installed")
  code   : $DATA_DIR
  config : $CONFIG_DIR
  cli    : $CLI_HINT

Finish in the browser:
  1. chrome://extensions  ->  Developer mode  ->  Load unpacked  ->  $DATA_DIR
  2. Reload the extension (↻) — the native host is already registered
  3. $CLI_HINT status        # expect {"ok":true,...}

If step 3 still reports "no running server" while the verify step above passed,
the host is fine and the fault is browser-side: confirm the extension is enabled,
check its card for an Errors button, and reload it (↻) to wake the service worker.
EOF
