"use strict";

// Shared pure helpers + cookie reader. Loaded in the popup via <script src> and
// in the service worker via importScripts() — both attach the CD namespace to the
// global object.
(function (g) {
  /** Turn a cookie name into a valid env key. */
  function toEnvKey(name, { upper, prefix }) {
    let key = String(name).replace(/[^A-Za-z0-9_]/g, "_");
    if (/^[0-9]/.test(key)) key = "_" + key; // env keys can't start with a digit
    if (upper) key = key.toUpperCase();
    if (prefix) key = prefix + key;
    return key;
  }

  /** Quote/escape a value for .env consumption. */
  function toEnvValue(value, { quote }) {
    value = String(value);
    const needsQuote = quote || /[\s"'#=$`\\]/.test(value) || value === "";
    if (!needsQuote) return value;
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
    return `"${escaped}"`;
  }

  /** Decide whether the input is a full URL or a bare domain, return a getAll filter. */
  function buildFilter(raw) {
    const input = String(raw || "").trim();
    if (!input) return null;
    if (/^https?:\/\//i.test(input)) return { url: input };
    const domain = input.replace(/^\/\//, "").split("/")[0].replace(/:\d+$/, "");
    return { domain };
  }

  /** Host portion of a filter, for tab matching. */
  function filterHost(filter) {
    if (!filter) return null;
    if (filter.url) {
      try { return new URL(filter.url).hostname; } catch (_) { return null; }
    }
    return filter.domain || null;
  }

  // De-dupe by name (same name may exist on multiple paths); last one wins.
  function dedupeByName(cookies) {
    const seen = new Map();
    for (const c of cookies) seen.set(c.name, c);
    return [...seen.values()];
  }

  // Collision-safe env keys for a cookie list (suffix _2, _3 on key clashes).
  function keyedPairs(cookies, opts) {
    const used = new Map();
    return dedupeByName(cookies).map((c) => {
      let key = toEnvKey(c.name, opts);
      const n = used.get(key) || 0;
      used.set(key, n + 1);
      if (n > 0) key = `${key}_${n + 1}`;
      return { key, name: c.name, value: c.value };
    });
  }

  function shellQuote(v) {
    return "'" + String(v).replace(/'/g, "'\\''") + "'"; // single-quote wrap, safe for sh
  }

  function formatEnv(cookies, opts, { header } = {}) {
    const lines = [];
    if (header) lines.push(header);
    if (!cookies.length) return lines.length ? lines.join("\n") + "\n" : "";
    const body = keyedPairs(cookies, opts).map((p) => `${p.key}=${toEnvValue(p.value, opts)}`);
    body.sort();
    return lines.concat(body).join("\n") + "\n";
  }

  const FORMATS = ["env", "json", "shell", "cookie"];

  // Render cookies in the requested shape. `env` (default) is dotenv-shaped text,
  // `shell` is `export KEY=...` lines, `json` is a {name: value} object.
  function formatCookies(cookies, fmt, opts, { header } = {}) {
    fmt = String(fmt || "env").toLowerCase();
    if (fmt === "json") {
      const obj = {};
      for (const c of dedupeByName(cookies)) obj[c.name] = c.value;
      return JSON.stringify(obj, null, 2) + "\n";
    }
    if (fmt === "shell") {
      const lines = header ? [header] : [];
      if (cookies.length) {
        const body = keyedPairs(cookies, opts).map((p) => `export ${p.key}=${shellQuote(p.value)}`);
        body.sort();
        lines.push(...body);
      }
      return lines.length ? lines.join("\n") + "\n" : "";
    }
    if (fmt === "cookie") {
      // A ready-to-send `Cookie:` header value: original names, store order
      // (no sort, unlike env/shell), last-one-wins dedupe, no escaping — RFC 6265
      // cookie-octet values exclude `;`/whitespace/controls, so a raw join is
      // safe and quoting would corrupt the header. No comment header either: it
      // isn't a valid Cookie value. Empty → "".
      const body = dedupeByName(cookies).map((c) => `${c.name}=${c.value}`).join("; ");
      return body ? body + "\n" : "";
    }
    return formatEnv(cookies, opts, { header }); // env (default)
  }

  /** Promise wrapper around chrome.cookies.getAll (MV3 returns a promise already,
   *  but this keeps both call sites identical and tolerant). */
  function getCookies(filter) {
    return new Promise((resolve, reject) => {
      chrome.cookies.getAll(filter, (cookies) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(cookies || []);
      });
    });
  }

  g.CD = { toEnvKey, toEnvValue, buildFilter, filterHost, formatEnv, formatCookies, FORMATS, getCookies };

  // UMD-ish: also export for Node (the CLI requires the pure helpers; getCookies
  // is browser-only and simply goes unused there).
  if (typeof module !== "undefined" && module.exports) module.exports = g.CD;
})(globalThis);
