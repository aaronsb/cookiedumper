# Cookie Dumper

Dump cookies for a site pattern into `.env` format — **live**, so the file keeps
reflecting fresh session tokens as they rotate. Built for debugging your own apps:
pull session IDs / CSRF tokens straight into a `.env` your tools can read.

It does the thing you (rightly) wouldn't trust a random store extension to do —
read your `HttpOnly` session cookies and write them to disk — so it's deliberately
small, dependency-free, and readable end to end. Read it, then trust it.

## How it's wired

The cookie reading lives in the **extension** (`chrome.cookies` works on every OS —
no DB decryption, no keyring, no `peanuts`). A tiny **CLI** never touches Chrome; it
just validates and appends commands to a log file. A **native host** (plain Node)
bridges the filesystem to the extension. The command log is the single source of
truth — the CLI and the popup both drive it.

```
CLI (validating appender)            filesystem                  extension + native host
──────────────────────────     ──────────────────────      ─────────────────────────────────
cookiedumper set/dump/...   ─►   commands.jsonl   ◄── fs.watch ──►  service worker (chrome.cookies)
cookiedumper tail           ◄─   events.jsonl     ◄── append   ◄──  reports each action
cookiedumper status         ◄─   heartbeat.json   ◄── stamp    ◄──  liveness + offset
                                 <your>/.env      ◄── write    ◄──  dump output (0600)
```

**Live capture** rides `chrome.cookies.onChanged` (an MV3 event that *wakes* the
worker), debounced → re-dump → write. Pair it with the periodic tab-refresh that
*drives* rotation, and the loop is: refresh tab → server issues new cookie →
`onChanged` fires → `.env` rewritten. The on-disk file stays continuously current.

Control dir (override with `COOKIEDUMPER_DIR`): `~/.config/cookiedumper/`.

## Setup

### 1. Load the extension

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
2. Copy the extension **ID** from its card.

### 2. Install the CLI + native host

```bash
npm link                              # puts `cookiedumper` on your PATH (no deps)
cookiedumper host install <EXTENSION_ID>
```

`host install` writes a native-messaging manifest (pointing at `host.js`, locked to
your extension ID) into each installed Chromium-family browser's config dir, on Linux
**and** macOS. Then **fully quit and reopen** the browser so it picks up the host.

> Prefer not to use npm? Run the CLI as `node cli.js …`, and the Linux-only
> `./install-host.sh <EXTENSION_ID>` does the same host registration.

### 3. Verify

```bash
cookiedumper status        # should show extension ALIVE once the browser is open
```
…or click **Test host** in the popup.

## CLI

```bash
cookiedumper set pattern example.com      # bare domain (+subdomains) or full URL
cookiedumper set target ~/projects/app/.env   # must be inside $HOME
cookiedumper live on                      # rewrite .env on every cookie change
cookiedumper set refreshTab true          # reload matching tabs on each tick
cookiedumper on                           # enable the recurring tick
cookiedumper set intervalSec 60           # tick period (30s floor — Chrome's limit)

cookiedumper dump                         # one-shot dump now
cookiedumper refresh                      # reload matching tabs now
cookiedumper get                          # show derived config
cookiedumper status                       # config + liveness + last event
cookiedumper tail                         # follow events.jsonl
cookiedumper tail --env                   # follow the target .env as it rewrites
cookiedumper path                         # print the control dir
cookiedumper host install <ID> | uninstall
```

Every command is **validated** (target inside `$HOME`, interval ≥ 30, known keys,
booleans) and appended as one JSON line to `commands.jsonl`. The extension's host
watches that file and executes within milliseconds.

## Popup

The popup is a live-preview + manual-trigger UI over the same command log:

- **Dump (preview)** / **Copy** / **Download .env** — inline, no file write.
- **Target / Live / Refresh / Recurring** — write through to the command log, so
  the CLI sees the same settings (and vice-versa).
- **Write now**, **Refresh tabs**, **Test host**.

## Output format

```
# cookiedumper example.com @ 2026-06-10T19:00:00.000Z
CSRFTOKEN="..."
SESSIONID="abc123..."
```

- **UPPER_SNAKE keys** — uppercase; non-alphanumeric → `_` (`session-id` → `SESSION_ID`).
- **Quote values** — wrap in double quotes (values often contain `=`/`;`/spaces).
- **Prefix** — optional string prepended to every key.

`HttpOnly` cookies **are** included (the `chrome.cookies` API exposes them, unlike
`document.cookie`) — the whole point for session debugging. Duplicate names are
de-duped; post-sanitization key collisions get a numeric suffix.

## Permissions

| Permission | Why |
|---|---|
| `cookies` + `host_permissions: <all_urls>` | read cookies for any domain you type |
| `tabs` | find + refresh matching open tabs |
| `alarms` | recurring tick + revive the worker / port |
| `storage` | persist derived config + offset |
| `nativeMessaging` | talk to the local `host.js` (the only thing that touches disk) |

## Safety notes

- **Writes are confined to `$HOME`.** Both the CLI (refuses to even queue an outside
  path) and `host.js` enforce this; `CD_ALLOW_OUTSIDE_HOME=1` in the host's env overrides.
  Files are written `0600`.
- Dumped `.env` files contain **live session tokens** — treat them as secrets.
  `.gitignore` excludes `*.env`.
- The host only accepts connections from your specific extension ID (`allowed_origins`).

## License

[MIT](LICENSE) © Aaron Bockelie
