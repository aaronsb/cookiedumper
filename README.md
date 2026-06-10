# Cookie Dumper

A tiny Chrome extension that dumps cookies for a site pattern into `.env` format,
to make it easy to pull session IDs and other cookie values while debugging your
own applications.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the 🍪 icon from the extensions menu

## Use

1. Click the toolbar icon — the **Site pattern** field is pre-filled with the
   current tab's hostname.
2. Adjust the pattern if needed:
   - **Bare domain** (`example.com`) → matches that host *and* its subdomains.
   - **Full URL** (`https://app.example.com`) → matches that exact origin/path.
3. Click **Dump cookies**. Output appears as `.env` lines.
4. **Copy** to clipboard or **Download .env**.

## Output format

Each cookie becomes one line:

```
SESSIONID="abc123..."
CSRFTOKEN="..."
```

Options:

- **UPPER_SNAKE keys** — uppercase names; non-alphanumeric chars become `_`.
  (e.g. `session-id` → `SESSION_ID`). Uncheck to keep original casing.
- **Quote values** — wrap values in double quotes (recommended; cookie values
  often contain `=`, spaces, or `;`). Always quoted when the value needs it.
- **Prefix** — optional string prepended to every key (e.g. `COOKIE_`).

Duplicate cookie names (same name on different paths) are de-duped; keys that
collide after sanitization get a numeric suffix.

## Permissions

- `cookies` + `host_permissions: <all_urls>` — required to read cookies for any
  domain you type. Everything runs locally in the popup; nothing is sent anywhere.

## Notes

- `HttpOnly` cookies **are** readable here (the `cookies` API exposes them, unlike
  `document.cookie`), which is what makes this useful for session debugging.
- This is a local dev tool. Treat dumped `.env` files as secrets — they contain
  live session tokens.

## License

[MIT](LICENSE) © Aaron Bockelie
