# Cookie Dumper

A tiny Chrome extension that dumps cookies for a site pattern into `.env` format,
to make it easy to pull session IDs and other cookie values while debugging your
own applications.

It does the thing you (rightly) wouldn't trust a random store extension to do —
read your `HttpOnly` session cookies and write them to disk — so it's deliberately
small, dependency-free, and readable end to end: a few HTML/JS files plus a ~70-line
Node native host. Read it, then trust it.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the 🍪 icon from the extensions menu

## Quick use (preview / copy / download)

1. Click the toolbar icon — **Site pattern** is pre-filled with the current tab's host.
2. Adjust the pattern:
   - **Bare domain** (`example.com`) → matches that host *and* its subdomains.
   - **Full URL** (`https://app.example.com`) → matches that exact origin/path.
3. **Dump (preview)** renders `.env` lines. **Copy** or **Download .env**.

## Output format

```
# cookiedumper example.com @ 2026-06-10T19:00:00.000Z
CSRFTOKEN="..."
SESSIONID="abc123..."
```

- **UPPER_SNAKE keys** — uppercase; non-alphanumeric chars → `_` (`session-id` → `SESSION_ID`).
- **Quote values** — wrap in double quotes (recommended; values often contain `=`/`;`/spaces).
- **Prefix** — optional string prepended to every key (e.g. `COOKIE_`).

Duplicate names (same name on multiple paths) are de-duped; post-sanitization key
collisions get a numeric suffix.

`HttpOnly` cookies **are** included (the `chrome.cookies` API exposes them, unlike
`document.cookie`) — which is the whole point for session debugging.

## Recurring dumps + write-to-disk (native host)

Chrome extensions are sandboxed and can't write to arbitrary paths. To write a real
file (e.g. `~/projects/app/.env`) on a timer, a small **native messaging host**
(`host.js`, plain Node) does the file write while the extension feeds it cookies.

### One-time setup

1. Load the unpacked extension and copy its **ID** from `chrome://extensions`.
2. Register the host:
   ```bash
   ./install-host.sh <EXTENSION_ID>
   ```
   This drops a manifest into each browser's `NativeMessagingHosts/` dir, pointing
   at `host.js` and locked to your extension's ID.
3. **Fully quit and reopen** the browser (or reload the extension).
4. In the popup, click **Test host** — you should see `Host OK — node …`.

### Using it

In the popup's **Recurring & write-to-disk** section:

- **Target file** — e.g. `~/projects/app/.env`. Must be inside your home dir.
- **Refresh matching tab(s) before each dump** — reloads any open tab on that host
  first (so freshly-rotated session cookies are captured), waits ~1.5s, then dumps.
- **Recurring every N sec** — schedules a background dump via `chrome.alarms`
  (30s floor — Chrome's minimum). The toolbar badge shows the cookie count, or `ERR`.
- **Write now** — runs the full refresh → dump → write cycle immediately.

Settings persist in `chrome.storage` and the background worker re-reads them on change.

> **About "alarms":** that's just the name of Chrome's scheduled-timer API
> (`chrome.alarms`) — the sanctioned way to run code on an interval in a Manifest V3
> worker. It is not a warning and carries no scary permission prompt.

### Uninstall the host

```bash
./uninstall-host.sh
```

## Permissions

| Permission | Why |
|---|---|
| `cookies` + `host_permissions: <all_urls>` | read cookies for any domain you type |
| `tabs` | find + refresh matching open tabs before a dump |
| `alarms` | schedule recurring dumps |
| `storage` | persist your settings + last result |
| `nativeMessaging` | talk to the local `host.js` that writes the file |

## Safety notes

- **Writes are confined to `$HOME`.** `host.js` refuses paths outside your home dir
  unless you set `CD_ALLOW_OUTSIDE_HOME=1` in its environment. Files are written `0600`.
- Dumped `.env` files contain **live session tokens** — treat them as secrets. The
  repo's `.gitignore` excludes `*.env`.
- The host only accepts messages from your specific extension ID (`allowed_origins`).

## License

[MIT](LICENSE) © Aaron Bockelie
