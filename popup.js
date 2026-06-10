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
    $("server").textContent = "server: not connected — run  cookiedumper host install <id>  then reopen the browser";
    $("server").className = "hint";
  }
}

$("preview").addEventListener("click", preview);
$("copy").addEventListener("click", copyOut);
$("copyToken").addEventListener("click", copyToken);
$("site").addEventListener("keydown", (e) => { if (e.key === "Enter") preview(); });

init();
