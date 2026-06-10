"use strict";

// Service worker: scheduled dumps via chrome.alarms, optional tab refresh,
// and write-to-disk through the native messaging host.
importScripts("format.js");

const ALARM = "cd-dump";
const HOST = "com.aaronsb.cookiedumper";

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getConfig() {
  const { cdConfig } = await chrome.storage.local.get("cdConfig");
  return cdConfig || {};
}

async function setupAlarm() {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM);
  if (cfg.recurring && cfg.pattern) {
    // Chrome clamps the floor to 30s (0.5 min); anything smaller is bumped up.
    const minutes = Math.max(0.5, (Number(cfg.intervalSec) || 60) / 60);
    chrome.alarms.create(ALARM, { periodInMinutes: minutes });
  }
}

async function refreshTabs(filter) {
  const host = CD.filterHost(filter);
  if (!host) return 0;
  const patterns = [`*://${host}/*`, `*://*.${host}/*`];
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch (_) {
    return 0;
  }
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id).catch(() => {})));
  return tabs.length;
}

function writeViaHost(target, content) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, { action: "write", path: target, content }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp || { ok: false, error: "no response from host" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) });
    }
  });
}

function pingHost() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, { action: "ping" }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp || { ok: false, error: "no response" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) });
    }
  });
}

function setBadge(text, failed) {
  chrome.action.setBadgeBackgroundColor({ color: failed ? "#c0392b" : "#2d7d46" });
  chrome.action.setBadgeText({ text: String(text).slice(0, 4) });
}

async function runDump(reason, isoStamp) {
  const cfg = await getConfig();
  if (!cfg.pattern) return { ok: false, error: "no pattern configured" };
  const filter = CD.buildFilter(cfg.pattern);
  if (!filter) return { ok: false, error: "invalid pattern" };

  let refreshed = 0;
  if (cfg.refreshTab) {
    refreshed = await refreshTabs(filter);
    if (refreshed) await wait(Number(cfg.refreshWaitMs) || 1500);
  }

  let cookies;
  try {
    cookies = await CD.getCookies(filter);
  } catch (e) {
    setBadge("ERR", true);
    return { ok: false, error: e.message };
  }

  const stamp = isoStamp || new Date().toISOString();
  const env = CD.formatEnv(cookies, cfg, {
    header: `# cookiedumper ${cfg.pattern} @ ${stamp}`,
  });

  let writeResult = null;
  if (cfg.target) writeResult = await writeViaHost(cfg.target, env);

  const last = { stamp, count: cookies.length, env, reason, refreshed, writeResult };
  await chrome.storage.local.set({ cdLast: last });
  setBadge(writeResult && writeResult.ok === false ? "ERR" : String(cookies.length),
           !!(writeResult && writeResult.ok === false));
  return { ok: true, ...last };
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runDump("alarm");
});
chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(setupAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.cdConfig) setupAlarm();
});

// Commands from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.cmd === "dumpNow") {
    runDump("manual", msg.stamp).then(sendResponse);
    return true; // async
  }
  if (msg && msg.cmd === "pingHost") {
    pingHost().then(sendResponse);
    return true;
  }
  return false;
});
