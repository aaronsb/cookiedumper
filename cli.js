#!/usr/bin/env node
"use strict";

// cookiedumper CLI — a thin, validating appender to the command log, plus a
// tailer for the live output and a cross-platform native-host installer.
// It only ever touches the filesystem: it never talks to Chrome directly.

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const DIR = process.env.COOKIEDUMPER_DIR || path.join(HOME, ".config", "cookiedumper");
const CMD_FILE = path.join(DIR, "commands.jsonl");
const EVENT_FILE = path.join(DIR, "events.jsonl");
const HEARTBEAT = path.join(DIR, "heartbeat.json");
const HOST_NAME = "com.aaronsb.cookiedumper";
const HOST_JS = path.join(__dirname, "host.js");

const CONFIG_KEYS = {
  pattern: "string",
  target: "path",
  intervalSec: "int30",
  recurring: "bool",
  refreshTab: "bool",
  live: "bool",
  prefix: "string",
  upper: "bool",
  quote: "bool",
};

// ---- small helpers ----
function die(msg) {
  console.error("error: " + msg);
  process.exit(1);
}
function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of [CMD_FILE, EVENT_FILE]) if (!fs.existsSync(f)) fs.writeFileSync(f, "");
}
function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}
function parseBool(v) {
  if (/^(true|on|yes|1)$/i.test(v)) return true;
  if (/^(false|off|no|0)$/i.test(v)) return false;
  return null;
}
function newId() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
function appendCommand(obj) {
  ensureDir();
  const line = JSON.stringify({ id: newId(), ts: new Date().toISOString(), ...obj });
  fs.appendFileSync(CMD_FILE, line + "\n");
  return line;
}

// Validate a single config key=value (the "syntax enforcer").
function validateConfig(key, raw) {
  const kind = CONFIG_KEYS[key];
  if (!kind) die(`unknown config key '${key}'. valid: ${Object.keys(CONFIG_KEYS).join(", ")}`);
  switch (kind) {
    case "string":
      if (!raw || !raw.trim()) die(`'${key}' must be a non-empty string`);
      return raw;
    case "int30": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 30) die(`'${key}' must be an integer >= 30 (Chrome alarm floor)`);
      return Math.floor(n);
    }
    case "bool": {
      const b = parseBool(raw);
      if (b === null) die(`'${key}' must be true/false`);
      return b;
    }
    case "path": {
      const abs = path.resolve(expandHome(raw));
      const inside = abs === HOME || abs.startsWith(HOME + path.sep);
      if (!inside) die(`'${key}' must be inside your home dir (${HOME}); the host refuses to write elsewhere`);
      return raw; // keep the user's ~-form; the host expands it too
    }
  }
}

function foldConfig() {
  const cfg = {};
  if (!fs.existsSync(CMD_FILE)) return cfg;
  for (const line of fs.readFileSync(CMD_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      if (c.op === "config" && c.set) Object.assign(cfg, c.set);
    } catch (_) { /* skip malformed */ }
  }
  return cfg;
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT, "utf8"));
  } catch (_) {
    return null;
  }
}

// Follow a file: print existing content, then stream appends.
function follow(file, { fromStart = false } = {}) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  let pos = fromStart ? 0 : fs.statSync(file).size;
  if (fromStart) process.stdout.write(fs.readFileSync(file, "utf8"));
  const emit = () => {
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return; }
    if (stat.size < pos) pos = 0;
    if (stat.size > pos) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(stat.size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = stat.size;
      process.stdout.write(buf.toString("utf8"));
    }
  };
  try { fs.watch(file, emit); } catch (_) { /* poll only */ }
  setInterval(emit, 700);
}

// ---- native host install (cross-platform) ----
function hostManifestDirs() {
  const p = process.platform;
  if (p === "darwin") {
    const base = path.join(HOME, "Library", "Application Support");
    return [
      path.join(base, "Google", "Chrome"),
      path.join(base, "Google", "Chrome Beta"),
      path.join(base, "Chromium"),
      path.join(base, "Microsoft Edge"),
      path.join(base, "BraveSoftware", "Brave-Browser"),
    ].map((d) => path.join(d, "NativeMessagingHosts"));
  }
  // linux / other XDG
  const cfg = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
  return [
    "google-chrome", "google-chrome-beta", "google-chrome-unstable",
    "chromium", "microsoft-edge", path.join("BraveSoftware", "Brave-Browser"),
  ].map((d) => path.join(cfg, d, "NativeMessagingHosts"));
}

function installHost(extId) {
  if (!extId || !/^[a-p]{32}$/.test(extId)) {
    die("usage: cookiedumper host install <EXTENSION_ID>  (32-char id from chrome://extensions)");
  }
  if (process.platform === "win32") die("Windows native-host install isn't scripted; see README (registry).");
  fs.chmodSync(HOST_JS, 0o755);
  const manifest = JSON.stringify(
    { name: HOST_NAME, description: "Cookie Dumper native host", path: HOST_JS, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] },
    null, 2
  );
  let n = 0;
  for (const dir of hostManifestDirs()) {
    const parent = path.dirname(dir);
    if (!fs.existsSync(parent)) continue; // browser not installed
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, HOST_NAME + ".json"), manifest + "\n");
    console.log("installed: " + path.join(dir, HOST_NAME + ".json"));
    n++;
  }
  if (!n) die("no supported browser profile dir found");
  console.log("host: " + HOST_JS + "\nFully quit & reopen the browser (or reload the extension) to pick it up.");
}

function uninstallHost() {
  let n = 0;
  for (const dir of hostManifestDirs()) {
    const f = path.join(dir, HOST_NAME + ".json");
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log("removed: " + f); n++; }
  }
  console.log(n ? "done." : "nothing to remove.");
}

// ---- commands ----
function cmdStatus() {
  const cfg = foldConfig();
  const hb = readHeartbeat();
  console.log("control dir : " + DIR);
  console.log("config      :");
  for (const k of Object.keys(CONFIG_KEYS)) if (cfg[k] != null) console.log(`  ${k} = ${cfg[k]}`);
  if (!hb) {
    console.log("extension   : never seen (no heartbeat) — is the host installed and the browser open?");
  } else {
    const ageMs = Date.now() - new Date(hb.ts).getTime();
    const age = Math.round(ageMs / 1000);
    const live = ageMs < 90000;
    console.log(`extension   : ${live ? "ALIVE" : "stale"} (last beat ${age}s ago, offset ${hb.offset})`);
  }
  const last = lastEvent();
  if (last) console.log("last event  : " + last);
}

function lastEvent() {
  try {
    const lines = fs.readFileSync(EVENT_FILE, "utf8").trim().split("\n").filter(Boolean);
    return lines[lines.length - 1] || null;
  } catch (_) {
    return null;
  }
}

const HELP = `cookiedumper — control the Cookie Dumper extension via a command log

  set <key> <value>     append a config change
                        keys: ${Object.keys(CONFIG_KEYS).join(", ")}
  get                   show the derived config
  on | off              enable/disable recurring dumps
  live <on|off>         enable/disable cookies.onChanged live capture
  dump                  request an immediate dump
  refresh               request a tab refresh now
  status                config + extension liveness + last event
  tail [--env] [--all]  follow events.jsonl (or the target .env with --env)
  log                   print the whole event log
  path                  print the control dir
  host install <ID>     register the native host (id from chrome://extensions)
  host uninstall        remove the native host manifest

Commands are validated, then appended to ${CMD_FILE}.
The extension's native host watches that file and executes them.`;

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    case "path":
      console.log(DIR);
      return;
    case "get":
      console.log(JSON.stringify(foldConfig(), null, 2));
      return;
    case "status":
      cmdStatus();
      return;
    case "set": {
      const [key, ...vparts] = rest;
      if (!key || !vparts.length) die("usage: cookiedumper set <key> <value>");
      const value = validateConfig(key, vparts.join(" "));
      appendCommand({ op: "config", set: { [key]: value } });
      console.log(`set ${key} = ${value}`);
      return;
    }
    case "on":
      appendCommand({ op: "config", set: { recurring: true } });
      console.log("recurring: on");
      return;
    case "off":
      appendCommand({ op: "config", set: { recurring: false } });
      console.log("recurring: off");
      return;
    case "live": {
      const b = parseBool(rest[0] || "on");
      if (b === null) die("usage: cookiedumper live <on|off>");
      appendCommand({ op: "config", set: { live: b } });
      console.log("live capture: " + (b ? "on" : "off"));
      return;
    }
    case "dump":
      appendCommand({ op: "dump" });
      console.log("queued: dump");
      return;
    case "refresh":
      appendCommand({ op: "refresh" });
      console.log("queued: refresh");
      return;
    case "tail": {
      const all = rest.includes("--all");
      if (rest.includes("--env")) {
        const cfg = foldConfig();
        if (!cfg.target) die("no target set — run: cookiedumper set target ~/path/.env");
        follow(path.resolve(expandHome(cfg.target)), { fromStart: true });
      } else {
        follow(EVENT_FILE, { fromStart: all });
      }
      return;
    }
    case "log":
      try { process.stdout.write(fs.readFileSync(EVENT_FILE, "utf8")); } catch (_) { /* empty */ }
      return;
    case "host": {
      const sub = rest[0];
      if (sub === "install") return installHost(rest[1]);
      if (sub === "uninstall") return uninstallHost();
      die("usage: cookiedumper host <install <ID>|uninstall>");
      return;
    }
    default:
      die(`unknown command '${cmd}'. run 'cookiedumper help'.`);
  }
}

main(process.argv.slice(2));
