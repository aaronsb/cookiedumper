"use strict";

const $ = (id) => document.getElementById(id);
const FIELDS = ["pattern", "prefix", "target", "intervalSec"];
const CHECKS = ["upper", "quote", "refreshTab", "recurring"];

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
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  for (const f of FIELDS) if (cfg[f] != null) $(f).value = cfg[f];
  for (const c of CHECKS) if (cfg[c] != null) $(c).checked = cfg[c];
}

async function saveConfig() {
  await chrome.storage.local.set({ cdConfig: readForm() });
}

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = cls || "";
}

// ---- preview (inline, no file write) ----
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

// ---- write-to-disk via background + native host ----
async function writeNow() {
  await saveConfig();
  const cfg = readForm();
  if (!cfg.pattern) return setStatus("Enter a pattern first.");
  if (!cfg.target) return setStatus("Set a target file to write.");
  setStatus("Dumping + writing via host…");
  const r = await chrome.runtime.sendMessage({ cmd: "dumpNow", stamp: new Date().toISOString() });
  if (!r || !r.ok) return setStatus("Dump failed: " + ((r && r.error) || "?"), "err");
  $("output").value = r.env || "";
  if (r.writeResult && r.writeResult.ok) {
    setStatus(`Wrote ${r.count} cookie(s) → ${r.writeResult.path}`, "ok");
  } else if (r.writeResult) {
    setStatus("Host error: " + r.writeResult.error, "err");
  } else {
    setStatus(`${r.count} cookie(s) dumped (no target set).`);
  }
}

async function ping() {
  setStatus("Pinging native host…");
  const r = await chrome.runtime.sendMessage({ cmd: "pingHost" });
  if (r && r.ok) setStatus(`Host OK — node ${r.node}, home ${r.home}`, "ok");
  else setStatus("Host unreachable: " + ((r && r.error) || "?") + " — run install-host.sh", "err");
}

async function prefill() {
  const { cdConfig } = await chrome.storage.local.get("cdConfig");
  applyConfig(cdConfig);
  if (!$("pattern").value) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && /^https?:/i.test(tab.url)) $("pattern").value = new URL(tab.url).hostname;
    } catch (_) { /* ignore */ }
  }
  // Reflect the last scheduled run, if any.
  const { cdLast } = await chrome.storage.local.get("cdLast");
  if (cdLast && cdLast.env && !$("output").value) {
    $("output").value = cdLast.env;
    setStatus(`Last ${cdLast.reason} dump: ${cdLast.count} cookie(s) @ ${cdLast.stamp}`);
  }
}

// Save config whenever the form changes (so the background worker stays in sync).
for (const id of [...FIELDS, ...CHECKS]) {
  $(id).addEventListener("change", saveConfig);
}
$("dump").addEventListener("click", dump);
$("copy").addEventListener("click", copy);
$("download").addEventListener("click", download);
$("writeNow").addEventListener("click", writeNow);
$("ping").addEventListener("click", ping);
$("pattern").addEventListener("keydown", (e) => { if (e.key === "Enter") dump(); });

prefill();
