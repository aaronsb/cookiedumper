#!/usr/bin/env node
"use strict";

// Build the loadable extension: copy only the extension files into dist/ and
// produce a release .zip. The native host (host.js) and CLI (cli.js) are NOT
// part of the extension — they ship via the repo / npm.
//
//   npm run build            -> dist/ + cookiedumper-<version>.zip
//   load dist/ via chrome://extensions "Load unpacked"
//
// The zip is written with Node's zlib (no system `zip` dependency) using a fixed
// timestamp, so the archive is reproducible.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// The extension is exactly these files (everything the manifest references).
const EXT_FILES = ["manifest.json", "background.js", "popup.html", "popup.js", "format.js"];
const ICON_DIR = "icons"; // optional: copied if present

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;

// ---- minimal reproducible ZIP writer (deflate) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipDir(srcDir, outFile) {
  const DOS_TIME = 0, DOS_DATE = 0x21; // 1980-01-01, fixed for reproducibility
  const files = [];
  (function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = prefix ? prefix + "/" + name : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, rel);
      else files.push({ rel, data: fs.readFileSync(abs) });
    }
  })(srcDir, "");

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.rel, "utf8");
    const crc = crc32(f.data);
    const comp = zlib.deflateRawSync(f.data);
    const useStore = comp.length >= f.data.length;
    const method = useStore ? 0 : 8;
    const body = useStore ? f.data : comp;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6); lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(DOS_TIME, 10); lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(body.length, 18); lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(name.length, 26); lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, name, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(DOS_TIME, 12); cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(body.length, 20); cdh.writeUInt32LE(f.data.length, 24);
    cdh.writeUInt16LE(name.length, 28); cdh.writeUInt32LE(0, 42); // extra/comment/disk/attrs = 0
    cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, name]));
    offset += lfh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(outFile, Buffer.concat([...chunks, cd, eocd]));
}

// ---- build ----
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const f of EXT_FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { console.error("missing extension file: " + f); process.exit(1); }
  fs.copyFileSync(src, path.join(DIST, f));
}
if (fs.existsSync(path.join(ROOT, ICON_DIR))) {
  fs.cpSync(path.join(ROOT, ICON_DIR), path.join(DIST, ICON_DIR), { recursive: true });
}

const distManifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
if (!distManifest.key) console.warn('warning: manifest has no "key" — extension id will be random per load.');

console.log(`dist/ built (${EXT_FILES.length} files, v${version})`);

const zipName = `cookiedumper-${version}.zip`;
zipDir(DIST, path.join(ROOT, zipName));
console.log("archive: " + zipName);
