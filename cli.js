#!/usr/bin/env node
"use strict";

// cookiedumper CLI — an HTTP client for the secure localhost server the native
// host runs. It reads the port + bearer token from ~/.config/cookiedumper/
// server.json (written by the host) and pulls cookies for a specific site on
// demand. It never touches Chrome or the cookie store directly.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const HOME = os.homedir();
const DIR = process.env.COOKIEDUMPER_DIR || path.join(HOME, ".config", "cookiedumper");
const SERVER_JSON = path.join(DIR, "server.json");
const HOST_NAME = "com.aaronsb.cookiedumper";
const HOST_JS = path.join(__dirname, "host.js");

function die(msg) {
  console.error("error: " + msg);
  process.exit(1);
}

function loadServer() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(SERVER_JSON, "utf8"));
  } catch (_) {
    die("server not running — load the extension and open the browser, then retry.\n" +
        "(no " + SERVER_JSON + ")");
  }
  if (!s.port || !s.token) die("server.json is incomplete; reload the extension.");
  return s;
}

function request(method, pathname, { stream } = {}) {
  const s = loadServer();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: s.port, method, path: pathname, headers: { authorization: "Bearer " + s.token } },
      (res) => {
        if (stream) return resolve(res); // caller consumes the stream (SSE)
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", (e) => {
      if (e.code === "ECONNREFUSED") reject(new Error("connection refused — is the browser open with the extension loaded?"));
      else reject(e);
    });
    req.end();
  });
}

function ok(r) {
  if (r.status < 200 || r.status >= 300) die(`server returned ${r.status}: ${r.body.trim()}`);
  return r.body;
}

function optsQuery(args) {
  const q = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--refresh") q.set("refresh", "1");
    else if (a === "--no-upper") q.set("upper", "0");
    else if (a === "--no-quote") q.set("quote", "0");
    else if (a === "--prefix") q.set("prefix", args[++i] || "");
  }
  return q;
}

// ---- native host install (cross-platform: Linux + macOS) ----
function hostManifestDirs() {
  if (process.platform === "darwin") {
    const base = path.join(HOME, "Library", "Application Support");
    return ["Google/Chrome", "Google/Chrome Beta", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser"]
      .map((d) => path.join(base, d, "NativeMessagingHosts"));
  }
  const cfg = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
  return ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"]
    .map((d) => path.join(cfg, d, "NativeMessagingHosts"));
}

function installHost(extId) {
  if (!extId || !/^[a-p]{32}$/.test(extId)) die("usage: cookiedumper host install <EXTENSION_ID> (32-char id from chrome://extensions)");
  if (process.platform === "win32") die("Windows native-host install isn't scripted; see README.");
  fs.chmodSync(HOST_JS, 0o755);
  const manifest = JSON.stringify(
    { name: HOST_NAME, description: "Cookie Dumper native host", path: HOST_JS, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] },
    null, 2
  );
  let n = 0;
  for (const dir of hostManifestDirs()) {
    if (!fs.existsSync(path.dirname(dir))) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, HOST_NAME + ".json"), manifest + "\n");
    console.log("installed: " + path.join(dir, HOST_NAME + ".json"));
    n++;
  }
  if (!n) die("no supported browser profile dir found");
  console.log("host: " + HOST_JS + "\nFully quit & reopen the browser (or reload the extension) to start the server.");
}

function uninstallHost() {
  let n = 0;
  for (const dir of hostManifestDirs()) {
    const f = path.join(dir, HOST_NAME + ".json");
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log("removed: " + f); n++; }
  }
  console.log(n ? "done." : "nothing to remove.");
}

const HELP = `cookiedumper — pull cookies for a site over the secure localhost server

  env <site> [--refresh] [--prefix P] [--no-upper] [--no-quote]
                        print .env for <site> (bare domain or full URL)
  watch <site> [opts]   stream a fresh .env every time the site's cookies change (SSE)
  refresh <site>        reload matching open tabs (drive token rotation)
  status                server status + where the token lives
  token                 print the bearer token (for your app / curl)
  curl <site>           print a ready-to-paste curl command
  host install <ID>     register the native host (id from chrome://extensions)
  host uninstall        remove the native host manifest

Examples
  cookiedumper env app.example.com > .env
  curl -H "Authorization: Bearer $(cookiedumper token)" \\
       "http://127.0.0.1:$(cookiedumper status --port)/env?site=app.example.com"`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined: case "-h": case "--help": case "help":
      console.log(HELP); return;

    case "token":
      console.log(loadServer().token); return;

    case "status": {
      const s = loadServer();
      if (rest.includes("--port")) { console.log(s.port); return; }
      try {
        const r = await request("GET", "/status");
        console.log(ok(r).trim());
      } catch (e) {
        die(e.message);
      }
      console.log("server.json : " + SERVER_JSON + "  (port " + s.port + ")");
      return;
    }

    case "env": {
      const site = rest[0];
      if (!site || site.startsWith("--")) die("usage: cookiedumper env <site> [opts]");
      const q = optsQuery(rest.slice(1));
      q.set("site", site);
      const r = await request("GET", "/env?" + q.toString());
      process.stdout.write(ok(r));
      return;
    }

    case "refresh": {
      const site = rest[0];
      if (!site) die("usage: cookiedumper refresh <site>");
      const r = await request("POST", "/refresh?site=" + encodeURIComponent(site));
      console.log(ok(r).trim());
      return;
    }

    case "watch": {
      const site = rest[0];
      if (!site || site.startsWith("--")) die("usage: cookiedumper watch <site> [opts]");
      const q = optsQuery(rest.slice(1));
      q.set("site", site);
      const res = await request("GET", "/events?" + q.toString(), { stream: true });
      if (res.statusCode !== 200) die("server returned " + res.statusCode);
      console.error(`# watching ${site} — fresh .env on every cookie change (Ctrl-C to stop)`);
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const d = JSON.parse(line.slice(5).trim());
            if (d.env) { process.stdout.write("\n" + d.env); }
          } catch (_) { /* skip */ }
        }
      });
      res.on("end", () => process.exit(0));
      return;
    }

    case "curl": {
      const site = rest[0] || "<site>";
      const s = loadServer();
      console.log(`curl -H "Authorization: Bearer ${s.token}" "http://127.0.0.1:${s.port}/env?site=${site}"`);
      return;
    }

    case "host":
      if (rest[0] === "install") return installHost(rest[1]);
      if (rest[0] === "uninstall") return uninstallHost();
      die("usage: cookiedumper host <install <ID>|uninstall>");
      return;

    default:
      die(`unknown command '${cmd}'. run 'cookiedumper help'.`);
  }
}

main(process.argv.slice(2)).catch((e) => die(e.message));
