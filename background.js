"use strict";

// Service worker — the executor. Connects to the native host (held open as a
// long-lived port), receives command lines the host reads from commands.jsonl,
// and does the actual cookie work, writing results back through the host.
// The command log is the single source of truth; config is derived by folding
// "config" ops. Live capture rides chrome.cookies.onChanged.
importScripts("format.js");

const HOST = "com.aaronsb.cookiedumper";
const ALARM = "cd-tick";

let port = null;
let cfg = {};
let dumpTimer = null;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadState() {
  const o = await chrome.storage.local.get(["cdCfg", "cdOffset"]);
  cfg = o.cdCfg || {};
  return o.cdOffset || 0;
}
async function saveCfg() {
  await chrome.storage.local.set({ cdCfg: cfg });
}

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (_) {
    port = null;
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => { port = null; });
  loadState().then((off) => {
    if (port) port.postMessage({ type: "hello", offset: off });
  });
}

function logEvent(event) {
  if (port) port.postMessage({ type: "event", event });
}
function sendState() {
  if (port) port.postMessage({ type: "state", state: { cfg } });
}
function setBadge(text, bad) {
  chrome.action.setBadgeBackgroundColor({ color: bad ? "#c0392b" : "#2d7d46" });
  chrome.action.setBadgeText({ text: String(text).slice(0, 4) });
}

async function onHostMessage(msg) {
  if (!msg) return;
  if (msg.type === "commands") {
    for (const line of msg.lines) await applyCommand(line, msg.initial === true);
    await chrome.storage.local.set({ cdOffset: msg.offset });
    sendState();
    return;
  }
  if (msg.type === "writeResult") {
    if (msg.ok) logEvent({ kind: "write", path: msg.path, bytes: msg.bytes });
    else logEvent({ kind: "error", error: msg.error });
    setBadge(msg.ok ? "ok" : "ERR", !msg.ok);
    return;
  }
  // "ready" / "hb" / "pong" need no action (hb just keeps us alive).
}

async function applyCommand(line, isInitial) {
  let c;
  try { c = JSON.parse(line); } catch (_) { return; }
  if (c.op === "config" && c.set) {
    Object.assign(cfg, c.set);
    await saveCfg();
    setupAlarm();
    if (!isInitial) logEvent({ kind: "config", set: c.set });
    return;
  }
  if (isInitial) return; // don't replay historical one-shot actions on cold start
  if (c.op === "dump") await doDump("cmd");
  else if (c.op === "refresh") await refreshTabs();
}

async function refreshTabs() {
  const filter = CD.buildFilter(cfg.pattern);
  const host = CD.filterHost(filter);
  if (!host) return 0;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [`*://${host}/*`, `*://*.${host}/*`] });
  } catch (_) {
    return 0;
  }
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id).catch(() => {})));
  if (tabs.length) logEvent({ kind: "refresh", tabs: tabs.length, host });
  return tabs.length;
}

async function doDump(reason) {
  const filter = CD.buildFilter(cfg.pattern);
  if (!filter) return;
  let cookies;
  try {
    cookies = await CD.getCookies(filter);
  } catch (e) {
    logEvent({ kind: "error", error: e.message });
    return;
  }
  const stamp = new Date().toISOString();
  const env = CD.formatEnv(cookies, cfg, { header: `# cookiedumper ${cfg.pattern} @ ${stamp}` });
  logEvent({ kind: "dump", reason, count: cookies.length, pattern: cfg.pattern, target: cfg.target || null });
  if (cfg.target && port) port.postMessage({ type: "write", id: stamp, path: cfg.target, content: env });
  setBadge(String(cookies.length), false);
  await chrome.storage.local.set({ cdLast: { stamp, count: cookies.length, env, reason } });
}

// Live capture: re-dump (debounced) when a matching cookie changes.
function matchesPattern(cookie) {
  const filter = CD.buildFilter(cfg.pattern);
  const host = CD.filterHost(filter);
  if (!host) return false;
  const dom = (cookie.domain || "").replace(/^\./, "");
  return dom === host || dom.endsWith("." + host) || host.endsWith("." + dom);
}
chrome.cookies.onChanged.addListener((info) => {
  if (!cfg.pattern || !cfg.live) return;
  if (!matchesPattern(info.cookie)) return;
  if (dumpTimer) clearTimeout(dumpTimer);
  dumpTimer = setTimeout(() => doDump("live"), 400);
});

function setupAlarm() {
  const minutes = Math.max(0.5, (Number(cfg.intervalSec) || 60) / 60);
  chrome.alarms.create(ALARM, { periodInMinutes: minutes });
}
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  connect(); // revive the port if the worker had been killed
  if (cfg.recurring && cfg.refreshTab) {
    const n = await refreshTabs();
    if (n) await wait(Number(cfg.refreshWaitMs) || 1500);
  }
  if (cfg.recurring && !cfg.live) await doDump("timer");
});

chrome.runtime.onInstalled.addListener(() => { connect(); setupAlarm(); });
chrome.runtime.onStartup.addListener(() => { connect(); setupAlarm(); });

// Popup commands. setConfig routes through the command log (host append) so the
// popup and CLI share one source of truth.
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (!m) return false;
  if (m.cmd === "setConfig" && m.set) {
    connect();
    const line = JSON.stringify({ op: "config", ts: new Date().toISOString(), set: m.set });
    if (port) port.postMessage({ type: "append", line });
    reply({ ok: !!port });
    return false;
  }
  if (m.cmd === "dumpNow") { doDump("manual").then(() => reply({ ok: true })); return true; }
  if (m.cmd === "refresh") { refreshTabs().then((n) => reply({ ok: true, tabs: n })); return true; }
  if (m.cmd === "ping") { connect(); reply({ ok: !!port }); return false; }
  if (m.cmd === "getState") { reply({ cfg, connected: !!port }); return false; }
  return false;
});

connect();
setupAlarm();
