#!/usr/bin/env node
"use strict";

// Native messaging host for Cookie Dumper (secure / server-only).
//
// Spawned by Chrome via chrome.runtime.connectNative, so it's bridged to the
// extension's service worker over stdio (native-messaging framing: 4-byte LE
// length + UTF-8 JSON). It ALSO binds a localhost HTTP server, token-gated,
// that the CLI and your app use to pull cookies on demand.
//
// Multi-profile aware: every Chrome profile that loads the extension spawns its
// own host on its own port. Hosts share one bearer token (~/.config/cookiedumper/
// token) and each registers itself at ~/.config/cookiedumper/servers/<port>.json
// so the CLI can enumerate and target them. Nothing cookie-related is written to
// disk; the only disk artifacts are the token file and the per-server registry.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const HOME = os.homedir();
const DIR = process.env.COOKIEDUMPER_DIR || path.join(HOME, ".config", "cookiedumper");
const TOKEN_FILE = path.join(DIR, "token");
const SERVERS_DIR = path.join(DIR, "servers");
const PREFERRED_PORT = Number(process.env.COOKIEDUMPER_PORT) || 8787;
const SW_TIMEOUT_MS = 10000;

let VERSION = "0.0.0";
try { VERSION = require(path.join(__dirname, "package.json")).version; } catch (_) { /* installed loosely */ }

let token;
let server;
let registryFile = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
const sseClients = new Map(); // id -> http res

// ---------- native messaging (host <-> service worker) ----------
function toSW(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function requestSW(type, payload) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    toSW({ type, id, ...payload });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("service worker timed out"));
      }
    }, SW_TIMEOUT_MS);
  });
}

function onSWMessage(msg) {
  if (!msg) return;
  if ((msg.type === "dumpResult" || msg.type === "refreshResult") && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error || "failed"));
    return;
  }
  if (msg.type === "event" && sseClients.has(msg.id)) {
    const res = sseClients.get(msg.id);
    res.write(`event: ${msg.event || "dump"}\n`);
    res.write(`data: ${JSON.stringify({ site: msg.site, count: msg.count, body: msg.body })}\n\n`);
  }
}

// ---------- token (shared, race-safe) + per-server registry ----------
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* ignore */ }
}
function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return t.length >= 32 ? t : null;
  } catch (_) {
    return null;
  }
}

function loadOrCreateToken() {
  // Concurrent cold start (two profiles launching at once) races to create the
  // token. Write to a temp file FIRST, then link() it into place atomically:
  // exactly one host wins. Losers spin-read until the winner's token is visible,
  // so everyone converges on one token regardless of scheduling.
  let t = readToken();
  if (t) return t;
  const tok = crypto.randomBytes(32).toString("hex");
  const tmp = TOKEN_FILE + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  let won = false;
  try {
    fs.writeFileSync(tmp, tok, { mode: 0o600 });
    try { fs.linkSync(tmp, TOKEN_FILE); won = true; } // atomic; throws EEXIST if we lost
    catch (_) { /* lost the race */ }
    finally { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
  } catch (_) { /* couldn't write temp; fall through to read */ }
  if (won) return tok;
  for (let i = 0; i < 250; i++) { // ~500ms worst case for the winner's token to appear
    t = readToken();
    if (t) return t;
    sleepMs(2);
  }
  return tok;
}

function register(port) {
  fs.mkdirSync(SERVERS_DIR, { recursive: true });
  registryFile = path.join(SERVERS_DIR, port + ".json");
  fs.writeFileSync(registryFile, JSON.stringify({ host: "127.0.0.1", port, pid: process.pid }, null, 2), { mode: 0o600 });
}

function unregister() {
  try { if (registryFile) fs.unlinkSync(registryFile); } catch (_) { /* ignore */ }
}

// ---------- HTTP server (token-gated, localhost-only) ----------
function tokenOk(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers["authorization"] || "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Loopback Host only, and refuse any browser-origin request (a malicious page's
// fetch carries an Origin; curl/CLI does not). Blocks DNS-rebinding / CSRF.
function localOnly(req) {
  if (req.headers["origin"]) return false;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers["host"] || ""));
}

function send(res, code, body, type = "text/plain") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const FORMATS = ["env", "json", "shell"];
const CONTENT_TYPE = { env: "text/plain", shell: "text/plain", json: "application/json" };

function parseOpts(q) {
  const bool = (v, d) => (v == null ? d : !/^(0|false|no|off)$/i.test(v));
  const format = (q.get("format") || "env").toLowerCase();
  return { upper: bool(q.get("upper"), true), quote: bool(q.get("quote"), true), prefix: q.get("prefix") || "", format };
}

async function handleHttp(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!localOnly(req)) return send(res, 403, "forbidden\n");
  if (!tokenOk(req)) return send(res, 401, "unauthorized\n");
  const q = url.searchParams;

  if (url.pathname === "/status") {
    return send(res, 200, JSON.stringify({ ok: true, version: VERSION, port: server.address().port, pid: process.pid }) + "\n", "application/json");
  }

  if (url.pathname === "/env") {
    const site = (q.get("site") || "").trim();
    if (!site) return send(res, 400, "missing ?site=<domain-or-url>\n");
    const opts = parseOpts(q);
    if (!FORMATS.includes(opts.format)) return send(res, 400, `bad format '${opts.format}'; one of ${FORMATS.join(", ")}\n`);
    try {
      const r = await requestSW("dump", { site, refresh: /^(1|true|yes|on)$/i.test(q.get("refresh") || ""), opts });
      res.setHeader("x-cookie-count", String(r.count || 0));
      return send(res, 200, r.body || "", CONTENT_TYPE[opts.format]);
    } catch (e) {
      return send(res, 502, "dump failed: " + e.message + "\n");
    }
  }

  if (url.pathname === "/refresh") {
    const site = (q.get("site") || "").trim();
    if (!site) return send(res, 400, "missing ?site=\n");
    try {
      const r = await requestSW("refresh", { site });
      return send(res, 200, JSON.stringify({ ok: true, tabs: r.tabs }) + "\n", "application/json");
    } catch (e) {
      return send(res, 502, "refresh failed: " + e.message + "\n");
    }
  }

  if (url.pathname === "/events") {
    const site = (q.get("site") || "").trim();
    if (!site) return send(res, 400, "missing ?site=\n");
    const id = nextId++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": subscribed\n\n");
    sseClients.set(id, res);
    toSW({ type: "subscribe", id, site, opts: parseOpts(q) });
    const ka = setInterval(() => res.write(": keepalive\n\n"), 20000);
    req.on("close", () => { clearInterval(ka); sseClients.delete(id); toSW({ type: "unsubscribe", id }); });
    return;
  }

  send(res, 404, "not found\n");
}

function startServer(port, attempt = 0) {
  const srv = http.createServer((req, res) => {
    handleHttp(req, res).catch((e) => send(res, 500, "error: " + e.message + "\n"));
  });
  srv.on("error", (e) => {
    if (e.code === "EADDRINUSE" && attempt < 6) {
      setTimeout(() => startServer(attempt < 5 ? port : 0, attempt + 1), 200); // retry, then ephemeral
    } else {
      toSW({ type: "serverError", error: e.message });
    }
  });
  srv.listen(port, "127.0.0.1", () => {
    server = srv;
    const actual = srv.address().port;
    register(actual);
    toSW({ type: "ready", server: { host: "127.0.0.1", port: actual, token } });
  });
}

// ---------- boot ----------
fs.mkdirSync(DIR, { recursive: true }); // must exist before we write the token file
token = loadOrCreateToken();
startServer(PREFERRED_PORT);
const hb = setInterval(() => toSW({ type: "hb" }), 20000); // keep the MV3 worker alive

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const n = buffer.readUInt32LE(0);
    if (buffer.length < 4 + n) break;
    const body = buffer.subarray(4, 4 + n);
    buffer = buffer.subarray(4 + n);
    try { onSWMessage(JSON.parse(body.toString("utf8"))); } catch (_) { /* ignore */ }
  }
});
function shutdown() { clearInterval(hb); unregister(); if (server) server.close(); process.exit(0); }
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
