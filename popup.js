"use strict";

const $ = (id) => document.getElementById(id);

/** Turn a cookie name into a valid env key. */
function toEnvKey(name, { upper, prefix }) {
  let key = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(key)) key = "_" + key; // env keys can't start with a digit
  if (upper) key = key.toUpperCase();
  if (prefix) key = prefix + key;
  return key;
}

/** Quote/escape a value for .env consumption. */
function toEnvValue(value, { quote }) {
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
  const input = raw.trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return { url: input };
  // bare domain (strip any path the user pasted)
  const domain = input.replace(/^\/\//, "").split("/")[0].replace(/:\d+$/, "");
  return { domain };
}

function getCookies(filter) {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll(filter, (cookies) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(cookies || []);
    });
  });
}

function formatEnv(cookies, opts) {
  if (!cookies.length) return "";
  // De-dupe by name (a name may exist on multiple paths); last one wins, but warn-free.
  const seen = new Map();
  for (const c of cookies) seen.set(c.name, c);

  const lines = [];
  const usedKeys = new Map();
  for (const c of seen.values()) {
    let key = toEnvKey(c.name, opts);
    // disambiguate key collisions caused by sanitization
    const count = usedKeys.get(key) || 0;
    usedKeys.set(key, count + 1);
    if (count > 0) key = `${key}_${count + 1}`;
    lines.push(`${key}=${toEnvValue(c.value, opts)}`);
  }
  return lines.sort().join("\n") + "\n";
}

function readOpts() {
  return {
    upper: $("upper").checked,
    quote: $("quote").checked,
    prefix: $("prefix").value.trim(),
  };
}

function setStatus(msg) {
  $("status").textContent = msg;
}

async function dump() {
  const filter = buildFilter($("pattern").value);
  if (!filter) {
    setStatus("Enter a domain or URL first.");
    return;
  }
  setStatus("Reading cookies…");
  try {
    const cookies = await getCookies(filter);
    const env = formatEnv(cookies, readOpts());
    $("output").value = env || "# no cookies matched this pattern";
    const label = filter.url ? filter.url : filter.domain;
    setStatus(`${cookies.length} cookie(s) for ${label}.`);
  } catch (e) {
    setStatus("Error: " + e.message);
  }
}

async function copy() {
  const text = $("output").value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("Copied to clipboard.");
}

function download() {
  const text = $("output").value;
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = ".env";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Downloaded .env");
}

// Pre-fill with the active tab's hostname.
async function prefill() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      $("pattern").value = new URL(tab.url).hostname;
    }
  } catch (_) {
    /* ignore */
  }
}

$("dump").addEventListener("click", dump);
$("copy").addEventListener("click", copy);
$("download").addEventListener("click", download);
$("pattern").addEventListener("keydown", (e) => {
  if (e.key === "Enter") dump();
});

prefill();
