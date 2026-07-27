#!/usr/bin/env node
"use strict";

// cookiedumper CLI — an HTTP client for the secure localhost server(s) the
// native host runs. Multi-profile aware: each Chrome profile that loads the
// extension runs its own host on its own port, registered under
// ~/.config/cookiedumper/servers/. The CLI reads the shared token, enumerates
// the running servers, and for a dump auto-picks the profile that actually has
// cookies for the requested site. It never touches Chrome or the cookie store.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync } = require("child_process");
const POLICY = require("./policy.js");

const HOME = os.homedir();
const DIR = process.env.COOKIEDUMPER_DIR || path.join(HOME, ".config", "cookiedumper");
const TOKEN_FILE = path.join(DIR, "token");
const SERVERS_DIR = path.join(DIR, "servers");
const HOST_NAME = "com.aaronsb.cookiedumper";
const HOST_JS = path.join(__dirname, "host.js");
// Fixed extension ID, derived from the public "key" in manifest.json — stable on
// every machine/checkout, so `host install` needs no argument. Pass an explicit
// id only if you load a build without the key (random dev id).
const STABLE_EXT_ID = "ldocjaepomcmbljgaopodjnmnmpgojfm";

function die(msg) {
  console.error("error: " + msg);
  process.exit(1);
}

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) return t;
  } catch (_) { /* none */ }
  die("no token — load the extension and open the browser, then retry.\n(no " + TOKEN_FILE + ")");
}

function listServers() {
  let files = [];
  try { files = fs.readdirSync(SERVERS_DIR).filter((f) => f.endsWith(".json")); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SERVERS_DIR, f), "utf8"));
      if (s.port) out.push(s);
    } catch (_) { /* skip malformed */ }
  }
  return out.sort((a, b) => a.port - b.port);
}

function pruneStale(port) {
  try { fs.unlinkSync(path.join(SERVERS_DIR, port + ".json")); } catch (_) { /* ignore */ }
}

// One HTTP request to a specific port. Resolves {status, body, headers} or {err}.
function reqPort(port, method, pathname, { stream } = {}) {
  const token = loadToken();
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: { authorization: "Bearer " + token } },
      (res) => {
        if (stream) return resolve({ stream: res, status: res.statusCode });
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on("error", (e) => resolve({ err: e.code || e.message }));
    req.end();
  });
}

function runningServers() {
  const servers = listServers();
  if (!servers.length) die("no running server — open the browser with the extension loaded.");
  return servers;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  return args[i + 1];
}

// Version on disk (this checkout) — re-read fresh, not require()'d, so it reflects
// a just-pulled package.json. __dirname is the real install dir (node resolves the
// bin symlink), so it's the same checkout the extension loads from.
function diskVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version; }
  catch (_) { return null; }
}

// Dotted numeric compare: -1 / 0 / 1. ("2.4.0" vs "2.3.0" -> 1)
function verCmp(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The version a running profile currently has loaded (from its /status).
async function runningVersion(port) {
  const r = await reqPort(port, "GET", "/status");
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body).version || null; } catch (_) { return null; }
}

function optsQuery(args) {
  const q = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--refresh") q.set("refresh", "1");
    else if (a === "--no-upper") q.set("upper", "0");
    else if (a === "--no-quote") q.set("quote", "0");
    else if (a === "--prefix") q.set("prefix", args[++i] || "");
    else if (a === "--format") q.set("format", (args[++i] || "env").toLowerCase());
    else if (a === "--json") q.set("format", "json");
    else if (a === "--shell") q.set("format", "shell");
    else if (a === "--cookie") q.set("format", "cookie");
    else if (a === "--port") i++; // consumed elsewhere
  }
  return q;
}

// Resolve which server(s) to use: an explicit --port, else all running.
function targetPorts(args) {
  const p = flag(args, "--port");
  if (p) return [Number(p)];
  return runningServers().map((s) => s.port);
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

// POSIX single-quote a string for safe embedding in the generated launcher.
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// The browser execs the native host directly, so the host's `#!/usr/bin/env node`
// is resolved against the BROWSER's PATH — and a GUI-launched browser inherits
// launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin on macOS), which excludes
// /usr/local/bin, /opt/homebrew/bin, and any nvm dir. When node isn't in that set,
// `env` fails with 127 before a single line of JS runs and the browser surfaces
// only "Native host has exited" — no log, no config dir, nothing to go on.
//
// So don't depend on the browser's PATH: point the manifest at a tiny launcher that
// execs the absolute interpreter resolved here, at install time.
const LAUNCHER = path.join(path.dirname(HOST_JS), "host-launcher.sh");
function writeLauncher() {
  const body =
    "#!/bin/sh\n" +
    "# Generated by 'cookiedumper host install' — do not edit.\n" +
    "# Absolute interpreter so a GUI-launched browser, which has a minimal PATH,\n" +
    "# can exec the host. Regenerated on every install.\n" +
    "exec " + shq(process.execPath) + " " + shq(HOST_JS) + ' "$@"\n';
  fs.writeFileSync(LAUNCHER, body, { mode: 0o755 });
  return LAUNCHER;
}

function installHost(extId) {
  if (!extId) extId = STABLE_EXT_ID; // packed build has a fixed id
  if (!/^[a-p]{32}$/.test(extId)) die("invalid extension id (expected 32 chars a-p)");
  if (process.platform === "win32") die("Windows native-host install isn't scripted; see README.");
  fs.chmodSync(HOST_JS, 0o755);
  const target = writeLauncher();
  const manifest = JSON.stringify(
    { name: HOST_NAME, description: "Cookie Dumper native host", path: target, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] },
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
  console.log("host: " + target + "\n  -> " + process.execPath + " " + HOST_JS +
    "\nReload the extension in each profile (↻ on chrome://extensions) to start its server.");
}

function uninstallHost() {
  let n = 0;
  for (const dir of hostManifestDirs()) {
    const f = path.join(dir, HOST_NAME + ".json");
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log("removed: " + f); n++; }
  }
  try { fs.unlinkSync(LAUNCHER); console.log("removed: " + LAUNCHER); } catch (_) { /* absent */ }
  console.log(n ? "done." : "nothing to remove.");
}

// Re-run the canonical installer, which updates an existing checkout in place
// (git pull, or tarball if git is absent), re-chmods, refreshes the bin symlink,
// and re-registers the native host. Extra flags (e.g. --no-host, --dir <p>) are
// forwarded. Args go through bash positional params, not string interpolation,
// so nothing is shell-injected.
const INSTALL_URL = "https://raw.githubusercontent.com/aaronsb/cookiedumper/main/install.sh";
async function cmdUpdate(args) {
  const noReload = args.includes("--no-reload");
  const passthru = args.filter((a) => a !== "--no-reload"); // installer flags (--no-host, --dir …)

  // 1. Re-run the installer — git pull (or tarball) of the whole checkout, which
  //    includes the extension source the browser loads from $DATA_DIR.
  const inner = 'curl -fsSL "$1" | bash -s -- "${@:2}"';
  console.error("# updating via " + INSTALL_URL + (passthru.length ? " (" + passthru.join(" ") + ")" : ""));
  try {
    execFileSync("bash", ["-c", inner, "cookiedumper-update", INSTALL_URL, ...passthru], { stdio: "inherit" });
  } catch (e) {
    die("update failed (exit " + (e.status != null ? e.status : "?") + "). Run it manually:\n  curl -fsSL " + INSTALL_URL + " | bash");
  }
  if (noReload) return;

  // 2. The browser is unpacked (no Web Store auto-update). The new extension code
  //    is on disk now but Chrome is still running the old generation. Reload only
  //    the profiles whose loaded version is older than what we just pulled.
  const disk = diskVersion();
  const servers = listServers();
  if (!servers.length) {
    return console.log("no running browser to reload — the new code loads when the extension next starts.");
  }
  for (const s of servers) {
    const running = await runningVersion(s.port);
    if (disk && running && verCmp(disk, running) <= 0) {
      console.log(`:${s.port} extension already on v${running} — no reload`);
      continue;
    }
    const rr = await reqPort(s.port, "POST", "/reload");
    if (rr.status === 200) console.log(`:${s.port} reloading extension ${running ? "v" + running : "(unknown)"} -> v${disk || "?"}`);
    else console.log(`:${s.port} reload failed (${rr.err || rr.status}); reload it manually in chrome://extensions`);
  }
}

// Force the loaded extension to reload from disk (runtime.reload) on each profile.
async function cmdReload(args) {
  const ports = targetPorts(args);
  for (const p of ports) {
    const r = await reqPort(p, "POST", "/reload");
    console.log(r.status === 200 ? `:${p} reloading extension` : `:${p} ${r.err || r.status}`);
  }
}

const HELP = `cookiedumper — pull cookies for a site over the secure localhost server(s)

  env <site> [--json|--shell|--cookie|--format F] [--refresh] [--prefix P]
             [--no-upper] [--no-quote] [--port N]
                        print cookies for <site> (default: dotenv-shaped text;
                        --json, --shell, or --cookie for other formats). --cookie
                        emits a ready-to-send Cookie: header value (original
                        names, ;-joined; needs --port if >1 profile has the site).
                        With multiple profiles, auto-picks the one with cookies.
  watch <site> [--json|--shell] [--port N]
                        stream a fresh dump on every cookie change (SSE)
  refresh <site> [--port N] reload matching tabs (drive token rotation)
  servers               list running profile servers (port, pid, version; flags a
                        pending update if newer code is on disk)
  policy [list]         show the per-profile allow/exclude site policy
  policy allow <pat>    add an include pattern (e.g. *.example.com); *.tld refused
  policy deny  <pat>    add an exclude pattern
  policy rm <pat> | clear   remove a pattern / clear the policy
  status [--port N]     server status
  token                 print the bearer token (for your app / curl)
  curl <site>           print a ready-to-paste curl command
  host install [ID]     register the native host (ID defaults to the packed
                        build's fixed id; pass one only for an unkeyed dev build)
  host uninstall        remove the native host manifest
  update [--no-reload] [installer flags]
                        update to the latest release by re-running the installer
                        (git pull in place; re-links the CLI and host). Then, since
                        the extension is unpacked, reloads any running profile whose
                        loaded version is older than what was pulled. --no-reload
                        skips that; other flags (--no-host, --dir <path>) forward.
  reload [--port N]     reload the unpacked extension from disk (pick up pulled
                        code) on each running profile

<site> is a bare domain (host + subdomains) or a full URL (exact origin).`;

function cookieCount(r) {
  if (r && r.headers && r.headers["x-cookie-count"] != null) return Number(r.headers["x-cookie-count"]);
  if (!r || !r.body) return 0;
  return r.body.split("\n").filter((l) => /=/.test(l) && !l.startsWith("#")).length;
}

async function cmdEnv(args) {
  const site = args[0];
  if (!site || site.startsWith("--")) die("usage: cookiedumper env <site> [opts]");
  const q = optsQuery(args.slice(1));
  q.set("site", site);
  const ports = targetPorts(args);

  if (ports.length === 1) {
    const r = await reqPort(ports[0], "GET", "/env?" + q.toString());
    if (r.err) die(`port ${ports[0]}: ${r.err}`);
    if (r.status !== 200) die(`server ${ports[0]} returned ${r.status}: ${r.body.trim()}`);
    return process.stdout.write(r.body);
  }

  // Multiple profiles: query each, pick the one(s) with cookies.
  const results = await Promise.all(ports.map(async (p) => ({ port: p, r: await reqPort(p, "GET", "/env?" + q.toString()) })));
  for (const x of results) if (x.r.err === "ECONNREFUSED") pruneStale(x.port);
  const reachable = results.filter((x) => x.r.status === 200);
  if (!reachable.length) die("no reachable server answered (stale registrations pruned; reload the extension).");
  const withCookies = reachable.filter((x) => cookieCount(x.r) > 0);

  if (withCookies.length === 1) {
    console.error(`# from profile on port ${withCookies[0].port} (${cookieCount(withCookies[0].r)} cookies)`);
    return process.stdout.write(withCookies[0].r.body);
  }
  if (withCookies.length === 0) {
    console.error(`# no profile has cookies for ${site} (checked ports ${reachable.map((x) => x.port).join(", ")})`);
    return process.stdout.write(reachable[0].r.body);
  }
  // `cookie` is meant to be one ready-to-send header value; concatenating two
  // profiles (with `#` separators that would corrupt a header anyway) is never
  // what you want. Refuse and point at --port instead of emitting garbage.
  if ((q.get("format") || "env") === "cookie") {
    die(`multiple profiles have cookies for ${site} (ports ${withCookies.map((x) => x.port).join(", ")}); ` +
        `a Cookie header can't merge sessions — pick one with --port <N>.`);
  }
  console.error(`# multiple profiles have cookies for ${site}; showing all — use --port to pick one`);
  for (const x of withCookies) {
    process.stdout.write(`\n# ===== port ${x.port} (${cookieCount(x.r)} cookies) =====\n`);
    process.stdout.write(x.r.body);
  }
}

// Policy lives in the extension (chrome.storage, per profile). The CLI views and
// edits it over /policy, which the host relays to the service worker.
async function cmdPolicy(args) {
  const sub = args[0];
  const pattern = args[1] && !args[1].startsWith("--") ? args[1].trim().toLowerCase() : "";
  const ports = targetPorts(args);

  if (!sub || sub === "list") {
    for (const p of ports) {
      const r = await reqPort(p, "GET", "/policy");
      if (r.status !== 200) { console.log(`:${p}  (${r.err || r.status})`); continue; }
      const pol = JSON.parse(r.body);
      console.log(`profile :${p}`);
      console.log("  include (allow)" + (pol.include.length ? ":" : ":  (empty → any site allowed)"));
      pol.include.forEach((x) => console.log("    + " + x));
      console.log("  exclude (deny)" + (pol.exclude.length ? ":" : ":  (none)"));
      pol.exclude.forEach((x) => console.log("    - " + x));
    }
    console.log("always denied: *.tld wildcards (e.g. *.com, *.co.uk)");
    return;
  }
  if (!["allow", "deny", "rm", "clear"].includes(sub)) die("usage: cookiedumper policy [list|allow <p>|deny <p>|rm <p>|clear]");
  if (sub !== "clear" && !pattern) die(`usage: cookiedumper policy ${sub} <pattern>`);
  if (sub === "allow" && POLICY.isTldWildcard(pattern)) die(`refusing '${pattern}': TLD-wide wildcards are always disallowed`);
  const qs = new URLSearchParams({ op: sub });
  if (pattern) qs.set("pattern", pattern);
  for (const p of ports) {
    const r = await reqPort(p, "POST", "/policy?" + qs.toString());
    if (r.status === 200) {
      const pol = JSON.parse(r.body);
      console.log(`:${p}  ${sub}${pattern ? " " + pattern : ""}  → include[${pol.include.length}] exclude[${pol.exclude.length}]`);
    } else {
      console.log(`:${p}  ${r.err || r.status}  ${(r.body || "").trim()}`);
    }
  }
}

async function cmdServers() {
  const servers = listServers();
  if (!servers.length) return console.log("no servers registered (open the browser with the extension loaded).");
  const disk = diskVersion();
  let pending = false;
  for (const s of servers) {
    const r = await reqPort(s.port, "GET", "/status");
    if (r.err === "ECONNREFUSED") { console.log(`  :${s.port}  pid ${s.pid}  DEAD (pruning)`); pruneStale(s.port); continue; }
    if (r.status !== 200) { console.log(`  :${s.port}  pid ${s.pid}  HTTP ${r.status}`); continue; }
    let v = null; try { v = JSON.parse(r.body).version; } catch (_) { /* old host w/o version */ }
    const stale = disk && v && verCmp(disk, v) > 0;
    if (stale) pending = true;
    console.log(`  :${s.port}  pid ${s.pid}  ok  v${v || "?"}` + (stale ? `  → v${disk} on disk (update pending)` : ""));
  }
  if (pending) console.log("run 'cookiedumper reload' to load the new code (or 'cookiedumper update' to pull + reload).");
}

async function cmdWatch(args) {
  const site = args[0];
  if (!site || site.startsWith("--")) die("usage: cookiedumper watch <site> [--port N]");
  let port = flag(args, "--port");
  if (port) port = Number(port);
  else {
    // pick the profile that has cookies for the site
    const ports = runningServers().map((s) => s.port);
    if (ports.length === 1) port = ports[0];
    else {
      const probes = await Promise.all(ports.map(async (p) => ({ p, n: cookieCount(await reqPort(p, "GET", "/env?site=" + encodeURIComponent(site))) })));
      const hit = probes.filter((x) => x.n > 0);
      if (hit.length !== 1) die(`can't auto-pick a profile (${hit.length} have cookies); use --port. See 'cookiedumper servers'.`);
      port = hit[0].p;
    }
  }
  const q = optsQuery(args.slice(1));
  q.set("site", site);
  const { stream, status } = await reqPort(port, "GET", "/events?" + q.toString(), { stream: true });
  if (status !== 200) die("server returned " + status);
  console.error(`# watching ${site} on port ${port} — fresh .env on every cookie change (Ctrl-C to stop)`);
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try { const d = JSON.parse(line.slice(5).trim()); if (d.body) process.stdout.write("\n" + d.body); } catch (_) { /* skip */ }
    }
  });
  stream.on("end", () => process.exit(0));
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined: case "-h": case "--help": case "help":
      return console.log(HELP);
    case "token":
      return console.log(loadToken());
    case "servers":
      return cmdServers();
    case "policy":
      return cmdPolicy(rest);
    case "status": {
      const ports = targetPorts(rest);
      for (const p of ports) {
        const r = await reqPort(p, "GET", "/status");
        console.log(r.err ? `:${p} ${r.err}` : r.body.trim());
      }
      return;
    }
    case "env":
      return cmdEnv(rest);
    case "watch":
      return cmdWatch(rest);
    case "refresh": {
      const site = rest[0];
      if (!site) die("usage: cookiedumper refresh <site> [--port N]");
      const ports = targetPorts(rest);
      for (const p of ports) {
        const r = await reqPort(p, "POST", "/refresh?site=" + encodeURIComponent(site));
        if (r.status === 200) console.log(`:${p} ${r.body.trim()}`);
      }
      return;
    }
    case "curl": {
      const site = rest[0] || "<site>";
      const token = loadToken();
      for (const s of runningServers()) {
        console.log(`curl -H "Authorization: Bearer ${token}" "http://127.0.0.1:${s.port}/env?site=${site}"`);
      }
      return;
    }
    case "host":
      if (rest[0] === "install") return installHost(rest[1]);
      if (rest[0] === "uninstall") return uninstallHost();
      return die("usage: cookiedumper host <install <ID>|uninstall>");
    case "update":
      return cmdUpdate(rest);
    case "reload":
      return cmdReload(rest);
    default:
      die(`unknown command '${cmd}'. run 'cookiedumper help'.`);
  }
}

main(process.argv.slice(2)).catch((e) => die(e.message));
