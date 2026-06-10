#!/usr/bin/env node
"use strict";

// Integrity guard: the extension ID derived from manifest.json's "key" must match
// the STABLE_EXT_ID baked into cli.js (used as the default for `host install`).
// If they drift, `host install` would register the host against the wrong id and
// the native messaging connection would silently fail. Run in CI and locally.

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const ROOT = path.join(__dirname, "..");

function idFromKey(b64) {
  const der = Buffer.from(b64, "base64");
  const h = createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i++) { id += String.fromCharCode(97 + (h[i] >> 4)); id += String.fromCharCode(97 + (h[i] & 0xf)); }
  return id;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
if (!manifest.key) {
  console.error('FAIL: manifest.json has no "key" — extension id would be random per load.');
  process.exit(1);
}
const derived = idFromKey(manifest.key);

const cli = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
const m = cli.match(/STABLE_EXT_ID = "([a-p]{32})"/);
if (!m) { console.error("FAIL: STABLE_EXT_ID not found in cli.js"); process.exit(1); }
const baked = m[1];

if (derived !== baked) {
  console.error(`FAIL: id drift\n  manifest key -> ${derived}\n  cli.js baked -> ${baked}`);
  process.exit(1);
}
console.log("ok: extension id consistent (" + derived + ")");
