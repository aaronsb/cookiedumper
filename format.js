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

  function formatEnv(cookies, opts, { header } = {}) {
    const lines = [];
    if (header) lines.push(header);
    if (!cookies.length) return lines.length ? lines.join("\n") + "\n" : "";

    // De-dupe by name (same name may exist on multiple paths); last one wins.
    const seen = new Map();
    for (const c of cookies) seen.set(c.name, c);

    const body = [];
    const usedKeys = new Map();
    for (const c of seen.values()) {
      let key = toEnvKey(c.name, opts);
      const count = usedKeys.get(key) || 0;
      usedKeys.set(key, count + 1);
      if (count > 0) key = `${key}_${count + 1}`;
      body.push(`${key}=${toEnvValue(c.value, opts)}`);
    }
    body.sort();
    return lines.concat(body).join("\n") + "\n";
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

  g.CD = { toEnvKey, toEnvValue, buildFilter, filterHost, formatEnv, getCookies };

  // UMD-ish: also export for Node (the CLI requires the pure helpers; getCookies
  // is browser-only and simply goes unused there).
  if (typeof module !== "undefined" && module.exports) module.exports = g.CD;
})(globalThis);
