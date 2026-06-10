"use strict";

const $ = (id) => document.getElementById(id);

function opts() {
  return { upper: $("upper").checked, quote: $("quote").checked, prefix: "" };
}
function setStatus(msg, cls) {
  $("status").textContent = msg;
  $("status").className = cls || "";
}

// Live preview reads cookies directly (the popup has chrome.cookies access);
// it does not touch the server or disk.
async function preview() {
  const site = $("site").value.trim();
  const filter = CD.buildFilter(site);
  if (!filter) return setStatus("Enter a site first.");
  setStatus("Reading cookies…");
  try {
    const cookies = await CD.getCookies(filter);
    $("output").value = CD.formatEnv(cookies, opts()) || "# no cookies matched this site";
    setStatus(`${cookies.length} cookie(s) for ${filter.url || filter.domain}.`);
  } catch (e) {
    setStatus("Error: " + e.message, "err");
  }
}

async function copyOut() {
  if (!$("output").value) return;
  await navigator.clipboard.writeText($("output").value);
  setStatus("Copied.", "ok");
}

let TOKEN = null;
let PORT = null;

async function copyToken() {
  if (!TOKEN) return;
  await navigator.clipboard.writeText(TOKEN);
  setStatus("Token copied.", "ok");
}

// ---- site policy (persisted in chrome.storage, per profile) ----
async function loadPolicy() {
  const { cdPolicy } = await chrome.storage.local.get("cdPolicy");
  return CDPolicy.normalizePolicy(cdPolicy);
}
function renderList(el, items, emptyText) {
  el.innerHTML = "";
  if (!items.length) {
    const s = document.createElement("span");
    s.className = "hint";
    s.textContent = emptyText;
    el.appendChild(s);
    return;
  }
  for (const it of items) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = it + " ";
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "remove";
    x.addEventListener("click", () => removePattern(it));
    chip.appendChild(x);
    el.appendChild(chip);
  }
}
function renderPolicy(p) {
  renderList($("includeList"), p.include, "(empty → any site allowed)");
  renderList($("excludeList"), p.exclude, "(none)");
}
async function addPattern(kind) {
  const input = kind === "include" ? $("includeInput") : $("excludeInput");
  const pat = input.value.trim().toLowerCase();
  if (!pat) return;
  if (kind === "include" && CDPolicy.isTldWildcard(pat)) {
    return setStatus(`refused '${pat}': *.tld is always disallowed`, "err");
  }
  const p = await loadPolicy();
  const arr = kind === "include" ? p.include : p.exclude;
  if (!arr.includes(pat)) arr.push(pat);
  input.value = "";
  await chrome.storage.local.set({ cdPolicy: p });
  renderPolicy(p);
  setStatus(`${kind === "include" ? "allow" : "deny"} ${pat}`, "ok");
}
async function removePattern(pat) {
  const p = await loadPolicy();
  p.include = p.include.filter((x) => x !== pat);
  p.exclude = p.exclude.filter((x) => x !== pat);
  await chrome.storage.local.set({ cdPolicy: p });
  renderPolicy(p);
}

async function init() {
  // Prefill the active tab's host.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/i.test(tab.url)) $("site").value = new URL(tab.url).hostname;
  } catch (_) { /* ignore */ }

  let state = null;
  try { state = await chrome.runtime.sendMessage({ cmd: "getServer" }); } catch (_) { /* worker waking */ }
  const s = state && state.server;
  if (s && state.connected) {
    TOKEN = s.token; PORT = s.port;
    $("server").textContent = `server: http://127.0.0.1:${s.port}  •  connected`;
    $("server").className = "ok";
    $("token").textContent = s.token.slice(0, 12) + "…" + s.token.slice(-4);
    const site = $("site").value || "app.example.com";
    $("example").innerHTML = `<code>curl -H "Authorization: Bearer &lt;token&gt;" "http://127.0.0.1:${s.port}/env?site=${site}"</code>`;
  } else {
    $("server").textContent = "server: not connected — run  cookiedumper host install  then reload the extension";
    $("server").className = "hint";
  }
  renderPolicy(await loadPolicy());
}

$("preview").addEventListener("click", preview);
$("copy").addEventListener("click", copyOut);
$("copyToken").addEventListener("click", copyToken);
$("site").addEventListener("keydown", (e) => { if (e.key === "Enter") preview(); });
$("addInclude").addEventListener("click", () => addPattern("include"));
$("addExclude").addEventListener("click", () => addPattern("exclude"));
$("includeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addPattern("include"); });
$("excludeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addPattern("exclude"); });

init();
