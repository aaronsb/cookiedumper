"use strict";

// Service worker — the only thing that can read cookies. It connects to the
// native host (which also runs the localhost HTTP server) and answers relayed
// per-site requests: dump cookies for one site on demand, refresh that site's
// tabs, or subscribe to live updates via cookies.onChanged. Nothing is stored;
// each response is built fresh and handed back over the native port.
importScripts("format.js", "policy.js");

const HOST = "com.aaronsb.cookiedumper";
const ALARM = "cd-keepalive";

let port = null;
let serverInfo = null;
const subs = new Map(); // id -> { site, opts }
const debounce = new Map(); // id -> timer

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (_) {
    port = null;
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    serverInfo = null;
    subs.clear();
  });
}

function reply(msg) {
  if (port) port.postMessage(msg);
}

async function onHostMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case "ready":
      serverInfo = msg.server;
      chrome.storage.local.set({ cdServer: { ...serverInfo, connected: true } });
      return;
    case "hb":
      return; // keepalive; just receiving it keeps us alive
    case "dump": {
      const r = await dump(msg.site, msg.opts, msg.refresh);
      reply({ type: "dumpResult", id: msg.id, ...r });
      return;
    }
    case "refresh": {
      const tabs = await refreshTabs(msg.site);
      reply({ type: "refreshResult", id: msg.id, ok: true, tabs });
      return;
    }
    case "subscribe":
      subs.set(msg.id, { site: msg.site, opts: msg.opts || {} });
      // push an initial snapshot immediately
      emit(msg.id);
      return;
    case "unsubscribe": {
      subs.delete(msg.id);
      const t = debounce.get(msg.id);
      if (t) { clearTimeout(t); debounce.delete(msg.id); }
      return;
    }
    case "checkPolicy": {
      const v = CDPolicy.evaluate(msg.site, await getPolicy());
      reply({ type: "policyResult", id: msg.id, denied: !v.allowed, reason: v.reason });
      return;
    }
    case "getPolicy":
      reply({ type: "policyResult", id: msg.id, policy: await getPolicy() });
      return;
    case "setPolicy":
      try {
        const next = CDPolicy.apply(await getPolicy(), msg.op, msg.pattern);
        await chrome.storage.local.set({ cdPolicy: next });
        reply({ type: "policyResult", id: msg.id, policy: next });
      } catch (e) {
        reply({ type: "policyResult", id: msg.id, error: e.message });
      }
      return;
    case "serverError":
      chrome.storage.local.set({ cdServer: { error: msg.error, connected: false } });
      return;
  }
}

async function getPolicy() {
  const { cdPolicy } = await chrome.storage.local.get("cdPolicy");
  return CDPolicy.normalizePolicy(cdPolicy);
}

async function dump(site, opts, refresh) {
  const filter = CD.buildFilter(site);
  if (!filter) return { ok: false, error: "invalid site" };
  const verdict = CDPolicy.evaluate(site, await getPolicy());
  if (!verdict.allowed) return { ok: true, denied: true, reason: verdict.reason };
  if (refresh) {
    const n = await refreshTabs(site);
    if (n) await new Promise((r) => setTimeout(r, 1500));
  }
  let cookies;
  try {
    cookies = await CD.getCookies(filter);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const stamp = new Date().toISOString();
  const fmt = (opts && opts.format) || "env";
  const header = fmt === "json" ? null : `# cookiedumper ${site} @ ${stamp}`;
  const body = CD.formatCookies(cookies, fmt, opts || {}, { header });
  return { ok: true, body, count: cookies.length };
}

async function refreshTabs(site) {
  const host = CD.filterHost(CD.buildFilter(site));
  if (!host) return 0;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [`*://${host}/*`, `*://*.${host}/*`] });
  } catch (_) {
    return 0;
  }
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id).catch(() => {})));
  return tabs.length;
}

async function emit(id) {
  const sub = subs.get(id);
  if (!sub) return;
  const r = await dump(sub.site, sub.opts, false);
  if (r.ok && !r.denied) reply({ type: "event", id, event: "dump", site: sub.site, count: r.count, body: r.body });
}

// Live capture: when a cookie for a subscribed site changes, re-emit (debounced).
function cookieMatches(site, cookie) {
  const host = CD.filterHost(CD.buildFilter(site));
  if (!host) return false;
  const dom = (cookie.domain || "").replace(/^\./, "");
  return dom === host || dom.endsWith("." + host) || host.endsWith("." + dom);
}
chrome.cookies.onChanged.addListener((info) => {
  for (const [id, sub] of subs) {
    if (!cookieMatches(sub.site, info.cookie)) continue;
    if (debounce.has(id)) clearTimeout(debounce.get(id));
    debounce.set(id, setTimeout(() => { debounce.delete(id); emit(id); }, 400));
  }
});

function setupAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); // backstop: revive the port if reaped
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) connect(); });
chrome.runtime.onInstalled.addListener(() => { connect(); setupAlarm(); });
chrome.runtime.onStartup.addListener(() => { connect(); setupAlarm(); });

// Popup: live preview reads cookies directly; this just surfaces server info.
chrome.runtime.onMessage.addListener((m, _s, replyFn) => {
  if (!m) return false;
  if (m.cmd === "getServer") { connect(); replyFn({ server: serverInfo, connected: !!port }); return false; }
  return false;
});

connect();
setupAlarm();
