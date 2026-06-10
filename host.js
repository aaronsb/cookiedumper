#!/usr/bin/env node
"use strict";

// Native messaging host for Cookie Dumper (secure / server-only).
//
// The host is spawned by Chrome via chrome.runtime.connectNative, so it is
// bridged to the extension's service worker over stdio (native-messaging
// framing: 4-byte LE length + UTF-8 JSON). It ALSO binds a localhost HTTP
// server, token-gated, that the CLI and your app use to pull cookies on demand.
//
//   HTTP (CLI/app)            host                       extension SW
//   GET /env?site=X  ──►  relay {type:dump}   ──►  read cookies for X
//                    ◄──  text/plain .env     ◄──  {type:dumpResult}
//   GET /events?site=X (SSE) ──► {type:subscribe} ──► cookies.onChanged → live
//
// Nothing cookie-related is written to disk. The only disk artifact is
// ~/.config/cookiedumper/server.json (port + bearer token, mode 0600), so the
// CLI/app know where to connect. The extension authenticates implicitly (Chrome
// only lets the allowed extension ID open the native port), so it needs no token.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const HOME = os.homedir();
const DIR = process.env.COOKIEDUMPER_DIR || path.join(HOME, ".config", "cookiedumper");
const SERVER_JSON = path.join(DIR, "server.json");
const PREFERRED_PORT = Number(process.env.COOKIEDUMPER_PORT) || 8787;
const SW_TIMEOUT_MS = 10000;

let token;
let server;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
const sseClients = new Map(); // id -> http res (for /events)

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
    res.write(`data: ${JSON.stringify({ site: msg.site, count: msg.count, env: msg.env })}\n\n`);
    return;
  }
}

// ---------- token / server.json ----------
function loadOrCreateToken() {
  try {
    const prev = JSON.parse(fs.readFileSync(SERVER_JSON, "utf8"));
    if (prev && typeof prev.token === "string" && prev.token.length >= 32) return prev.token;
  } catch (_) { /* none yet */ }
  return crypto.randomBytes(32).toString("hex");
}

function writeServerJson(port) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SERVER_JSON, JSON.stringify({ host: "127.0.0.1", port, token, pid: process.pid }, null, 2), { mode: 0o600 });
  fs.chmodSync(SERVER_JSON, 0o600);
}

// ---------- HTTP server (token-gated, localhost-only) ----------
function tokenOk(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Defense in depth: loopback Host only, and refuse any browser-origin request
// (a malicious web page's fetch carries an Origin; curl/CLI does not). Blocks
// DNS-rebinding / CSRF against the loopback server.
function localOnly(req) {
  if (req.headers["origin"]) return false;
  const host = String(req.headers["host"] || "");
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

function send(res, code, body, type = "text/plain") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function parseOpts(q) {
  const bool = (v, d) => (v == null ? d : !/^(0|false|no|off)$/i.test(v));
  return { upper: bool(q.get("upper"), true), quote: bool(q.get("quote"), true), prefix: q.get("prefix") || "" };
}

async function handleHttp(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!localOnly(req)) return send(res, 403, "forbidden\n");
  if (!tokenOk(req)) return send(res, 401, "unauthorized\n");

  const q = url.searchParams;

  if (url.pathname === "/status") {
    return send(res, 200, JSON.stringify({ ok: true, version: "2.0.0", port: server.address().port }) + "\n", "application/json");
  }

  if (url.pathname === "/env") {
    const site = (q.get("site") || "").trim();
    if (!site) return send(res, 400, "missing ?site=<domain-or-url>\n");
    try {
      const r = await requestSW("dump", { site, refresh: /^(1|true|yes|on)$/i.test(q.get("refresh") || ""), opts: parseOpts(q) });
      return send(res, 200, r.env || "");
    } catch (e) {
      return send(res, 502, "dump failed: " + e.message + "\n");
    }
  }

  if (url.pathname === "/refresh" && (req.method === "POST" || req.method === "GET")) {
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
    req.on("close", () => {
      clearInterval(ka);
      sseClients.delete(id);
      toSW({ type: "unsubscribe", id });
    });
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
    writeServerJson(actual);
    toSW({ type: "ready", server: { host: "127.0.0.1", port: actual, token } });
  });
}

// ---------- boot ----------
token = loadOrCreateToken();
fs.mkdirSync(DIR, { recursive: true });
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
    try {
      onSWMessage(JSON.parse(body.toString("utf8")));
    } catch (_) { /* ignore malformed */ }
  }
});
process.stdin.on("end", () => {
  clearInterval(hb);
  if (server) server.close();
  process.exit(0);
});
