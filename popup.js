"use strict";

const $ = (id) => document.getElementById(id);
const TEXT = ["pattern", "prefix", "target", "intervalSec"];
const CHECK = ["upper", "quote", "refreshTab", "recurring", "live"];

function readForm() {
  return {
    pattern: $("pattern").value.trim(),
    prefix: $("prefix").value.trim(),
    target: $("target").value.trim(),
    intervalSec: Math.max(30, Number($("intervalSec").value) || 60),
    upper: $("upper").checked,
    quote: $("quote").checked,
    refreshTab: $("refreshTab").checked,
    recurring: $("recurring").checked,
    live: $("live").checked,
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  for (const f of TEXT) if (cfg[f] != null) $(f).value = cfg[f];
  for (const c of CHECK) if (cfg[c] != null) $(c).checked = cfg[c];
}

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = cls || "";
}

// Persist config through the background worker -> command log (shared with CLI).
async function saveConfig() {
  await chrome.runtime.sendMessage({ cmd: "setConfig", set: readForm() });
}

// ---- live preview (inline, no file write) ----
async function dump() {
  const cfg = readForm();
  const filter = CD.buildFilter(cfg.pattern);
  if (!filter) return setStatus("Enter a domain or URL first.");
  setStatus("Reading cookies…");
  try {
    const cookies = await CD.getCookies(filter);
    $("output").value = CD.formatEnv(cookies, cfg) || "# no cookies matched this pattern";
    setStatus(`${cookies.length} cookie(s) for ${filter.url || filter.domain}.`);
  } catch (e) {
    setStatus("Error: " + e.message, "err");
  }
}

async function copy() {
  if (!$("output").value) return;
  await navigator.clipboard.writeText($("output").value);
  setStatus("Copied to clipboard.", "ok");
}

function download() {
  const text = $("output").value;
  if (!text) return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = ".env";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Downloaded .env", "ok");
}

async function writeNow() {
  await saveConfig();
  const cfg = readForm();
  if (!cfg.pattern) return setStatus("Enter a pattern first.");
  setStatus("Dumping + writing via host…");
  const r = await chrome.runtime.sendMessage({ cmd: "dumpNow" });
  if (!r || !r.ok) return setStatus("Dump failed.", "err");
  const { cdLast } = await chrome.storage.local.get("cdLast");
  if (cdLast) {
    $("output").value = cdLast.env || "";
    setStatus(`Dumped ${cdLast.count} cookie(s)${cfg.target ? " → " + cfg.target : " (no target)"}.`, "ok");
  }
}

async function refresh() {
  await saveConfig();
  const r = await chrome.runtime.sendMessage({ cmd: "refresh" });
  setStatus(r && r.ok ? `Refreshed ${r.tabs} tab(s).` : "Refresh failed.", r && r.ok ? "ok" : "err");
}

async function ping() {
  const r = await chrome.runtime.sendMessage({ cmd: "ping" });
  setStatus(r && r.ok ? "Native host connected." : "Host unreachable — run: cookiedumper host install <ID>",
            r && r.ok ? "ok" : "err");
}

async function init() {
  // Pull current config from the worker (single source of truth).
  let state = null;
  try { state = await chrome.runtime.sendMessage({ cmd: "getState" }); } catch (_) { /* worker waking */ }
  if (state) {
    applyConfig(state.cfg);
    $("conn").textContent = state.connected ? "native host: connected" : "native host: not connected (run host install)";
    $("conn").className = state.connected ? "ok" : "hint";
  }
  if (!$("pattern").value) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && /^https?:/i.test(tab.url)) $("pattern").value = new URL(tab.url).hostname;
    } catch (_) { /* ignore */ }
  }
  const { cdLast } = await chrome.storage.local.get("cdLast");
  if (cdLast && cdLast.env && !$("output").value) $("output").value = cdLast.env;
}

for (const id of [...TEXT, ...CHECK]) $(id).addEventListener("change", saveConfig);
$("dump").addEventListener("click", dump);
$("copy").addEventListener("click", copy);
$("download").addEventListener("click", download);
$("writeNow").addEventListener("click", writeNow);
$("refresh").addEventListener("click", refresh);
$("ping").addEventListener("click", ping);
$("pattern").addEventListener("keydown", (e) => { if (e.key === "Enter") dump(); });

init();
