#!/usr/bin/env node
"use strict";

// Native messaging host for Cookie Dumper.
// Chrome speaks to this over stdio: each message is a 4-byte little-endian
// length prefix followed by that many bytes of UTF-8 JSON. We answer in kind.
//
// Only action: {action:"write", path, content} writes a file. Writes are
// confined to $HOME unless CD_ALLOW_OUTSIDE_HOME=1 is set in the host's env.

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();

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

function handle(msg) {
  try {
    if (msg.action === "ping") {
      send({ ok: true, pong: true, home: HOME, node: process.version });
      return;
    }
    if (msg.action === "write") {
      const target = path.resolve(expandHome(msg.path || ""));
      const allowOutside = process.env.CD_ALLOW_OUTSIDE_HOME === "1";
      const insideHome = target === HOME || target.startsWith(HOME + path.sep);
      if (!allowOutside && !insideHome) {
        send({ ok: false, error: `refusing to write outside home: ${target}` });
        return;
      }
      const content = msg.content == null ? "" : String(msg.content);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { mode: 0o600 }); // 0600: it's a secret
      send({ ok: true, path: target, bytes: Buffer.byteLength(content) });
      return;
    }
    send({ ok: false, error: "unknown action: " + msg.action });
  } catch (e) {
    send({ ok: false, error: String((e && e.message) || e) });
  }
}

// Frame reader: accumulate stdin, peel off complete messages.
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) break;
    const body = buffer.subarray(4, 4 + len);
    buffer = buffer.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch (_) {
      send({ ok: false, error: "invalid json" });
      continue;
    }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
