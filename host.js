#!/usr/bin/env node
"use strict";

// Native messaging host for Cookie Dumper — the filesystem agent.
//
// The extension holds this open via chrome.runtime.connectNative (a long-lived
// port). The host watches commands.jsonl and streams new command lines to the
// service worker, writes the .env output the worker produces, appends events,
// and stamps a heartbeat (which also keeps the worker alive).
//
// Protocol is native-messaging framing: 4-byte LE length prefix + UTF-8 JSON.
//
//   SW -> host : {type:"hello", offset}      start; resume reading from offset
//                {type:"write", id, path, content}   write a file (.env)
//                {type:"append", line}        append a command (from the popup)
//                {type:"event", event}        append a line to events.jsonl
//                {type:"state", state}        update heartbeat payload
//                {type:"ping"}
//   host -> SW : {type:"ready", offset, dir}
//                {type:"commands", initial, lines, offset}
//                {type:"writeResult", id, ok, path|error, bytes}
//                {type:"hb"}                  keepalive (also refreshes heartbeat)
//                {type:"pong", ...}/{type:"error", error}

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const DIR = process.env.COOKIEDUMPER_DIR || path.join(HOME, ".config", "cookiedumper");
const CMD_FILE = path.join(DIR, "commands.jsonl");
const EVENT_FILE = path.join(DIR, "events.jsonl");
const HEARTBEAT = path.join(DIR, "heartbeat.json");

let offset = 0;
let lastState = null;

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of [CMD_FILE, EVENT_FILE]) if (!fs.existsSync(f)) fs.writeFileSync(f, "");
}

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}
function insideHome(t) {
  return t === HOME || t.startsWith(HOME + path.sep);
}

// Read complete lines appended since `offset`; advance `offset` past them.
function readNewLines(initial) {
  let stat;
  try {
    stat = fs.statSync(CMD_FILE);
  } catch (_) {
    if (initial) send({ type: "commands", initial: true, lines: [], offset });
    return;
  }
  if (stat.size < offset) offset = 0; // file was truncated/rotated
  let lines = [];
  if (stat.size > offset) {
    const fd = fs.openSync(CMD_FILE, "r");
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl >= 0) {
      const complete = text.slice(0, lastNl);
      offset += Buffer.byteLength(text.slice(0, lastNl + 1), "utf8");
      lines = complete.split("\n").filter((l) => l.trim().length);
    }
  }
  if (initial) send({ type: "commands", initial: true, lines, offset });
  else if (lines.length) send({ type: "commands", initial: false, lines, offset });
}

function writeHeartbeat() {
  try {
    fs.writeFileSync(
      HEARTBEAT,
      JSON.stringify({ ts: new Date().toISOString(), offset, state: lastState, pid: process.pid, node: process.version }, null, 2)
    );
  } catch (_) { /* ignore */ }
}

function handle(msg) {
  try {
    switch (msg.type) {
      case "hello": {
        ensure();
        offset = Number(msg.offset) || 0;
        const size = fs.existsSync(CMD_FILE) ? fs.statSync(CMD_FILE).size : 0;
        if (offset > size) offset = 0;
        send({ type: "ready", offset, dir: DIR });
        readNewLines(true);
        return;
      }
      case "write": {
        const target = path.resolve(expandHome(msg.path || ""));
        const allow = process.env.CD_ALLOW_OUTSIDE_HOME === "1";
        if (!allow && !insideHome(target)) {
          send({ type: "writeResult", id: msg.id, ok: false, error: "refusing to write outside home: " + target });
          return;
        }
        const content = msg.content == null ? "" : String(msg.content);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, { mode: 0o600 }); // 0600: it's a secret
        send({ type: "writeResult", id: msg.id, ok: true, path: target, bytes: Buffer.byteLength(content) });
        return;
      }
      case "append": {
        ensure();
        const line = String(msg.line || "");
        fs.appendFileSync(CMD_FILE, line.endsWith("\n") ? line : line + "\n");
        return; // the watcher will read it back and echo it as a command
      }
      case "event": {
        ensure();
        fs.appendFileSync(EVENT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...msg.event }) + "\n");
        return;
      }
      case "state":
        lastState = msg.state;
        writeHeartbeat();
        return;
      case "ping":
        send({ type: "pong", home: HOME, dir: DIR, node: process.version });
        return;
    }
  } catch (e) {
    send({ type: "error", error: String((e && e.message) || e) });
  }
}

ensure();
try {
  fs.watch(CMD_FILE, { persistent: true }, () => readNewLines(false));
} catch (_) { /* fs.watch unsupported here; the poll below covers it */ }
const pollTimer = setInterval(() => readNewLines(false), 1000); // safety net for missed fs.watch events
const hbTimer = setInterval(() => { send({ type: "hb" }); writeHeartbeat(); }, 20000); // keepalive + liveness

// stdin framing
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const n = buffer.readUInt32LE(0);
    if (buffer.length < 4 + n) break;
    const body = buffer.subarray(4, 4 + n);
    buffer = buffer.subarray(4 + n);
    let m;
    try {
      m = JSON.parse(body.toString("utf8"));
    } catch (_) {
      send({ type: "error", error: "invalid json" });
      continue;
    }
    handle(m);
  }
});
process.stdin.on("end", () => {
  clearInterval(pollTimer);
  clearInterval(hbTimer);
  process.exit(0);
});
