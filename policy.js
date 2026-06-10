"use strict";

// Site-access policy logic for the HTTP API: include/exclude glob patterns
// (multiple entries each) plus a hardwired guard that ALWAYS refuses TLD-wide
// wildcards (`*.com`, `*.co.uk`, …) — those would scope the endpoint to a whole
// top-level domain, defeating the point.
//
// Pure logic only; the policy DATA lives in the extension's chrome.storage
// (persistent, per-profile, edited in the popup). This module is loaded by the
// service worker (importScripts), the popup (<script>), and the CLI (require).
//
// Evaluation order against the requested site's host:
//   1. exclude match            -> deny
//   2. include set non-empty and nothing matches -> deny
//   3. otherwise                -> allow
// A `*.tld` entry in `include` is ignored (never grants access); in `exclude`
// it is honored (denying is always safe).
(function (g) {
  // Heuristic public-suffix set for common multi-label TLDs (not the full PSL).
  const MULTI_SUFFIXES = new Set([
    "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "co.jp", "co.kr", "co.nz",
    "co.za", "com.au", "net.au", "org.au", "com.br", "com.cn", "com.mx",
    "com.tr", "com.sg", "com.hk", "co.in", "co.il",
  ]);

  function siteHost(site) {
    let s = String(site || "").trim().toLowerCase();
    if (/^https?:\/\//.test(s)) { try { return new URL(s).hostname; } catch (_) { return ""; } }
    return s.replace(/^\*\./, "").replace(/^\/\//, "").split("/")[0].replace(/:\d+$/, "");
  }

  // Is this pattern a TLD-wide wildcard? (`*`, `*.com`, `*.co.uk`)
  function isTldWildcard(pattern) {
    const p = String(pattern || "").trim().toLowerCase();
    if (p === "*" || p === "*.*") return true;
    const m = /^\*\.(.+)$/.exec(p);
    if (!m) return false;
    const labels = m[1].split(".").filter(Boolean);
    if (labels.length < 2) return true;                              // *.com
    if (labels.length === 2 && MULTI_SUFFIXES.has(m[1])) return true; // *.co.uk
    return false;
  }

  // Does a concrete host match a pattern? Exact, or `*.domain` => domain + subdomains.
  function matchPattern(host, pattern) {
    host = String(host).toLowerCase();
    const p = String(pattern || "").trim().toLowerCase();
    const w = /^\*\.(.+)$/.exec(p);
    if (w) return host === w[1] || host.endsWith("." + w[1]);
    return host === p;
  }

  function normalizePolicy(policy) {
    policy = policy || {};
    return { include: Array.isArray(policy.include) ? policy.include : [], exclude: Array.isArray(policy.exclude) ? policy.exclude : [] };
  }

  // Evaluate a requested site against a policy. Returns { allowed, reason }.
  function evaluate(site, policy) {
    const p = normalizePolicy(policy);
    const host = siteHost(site);
    if (!host) return { allowed: false, reason: "invalid site" };
    for (const ex of p.exclude) if (matchPattern(host, ex)) return { allowed: false, reason: `excluded by '${ex}'` };
    // If the user set ANY include, restriction applies. *.tld entries never grant
    // access (filtered out for matching) — so an include list of only *.tld fails
    // CLOSED (nothing matches), never collapses to allow-all.
    if (p.include.length) {
      const valid = p.include.filter((x) => !isTldWildcard(x));
      if (!valid.some((inc) => matchPattern(host, inc))) return { allowed: false, reason: "not in the include list" };
    }
    return { allowed: true };
  }

  // Apply a mutation to a policy object and return the new one. Throws on a
  // disallowed allow-pattern. ops: allow | deny | rm | clear.
  function apply(policy, op, pattern) {
    const p = normalizePolicy(policy);
    pattern = String(pattern || "").trim().toLowerCase();
    if (op === "clear") return { include: [], exclude: [] };
    if (!pattern) throw new Error("pattern required");
    if (op === "allow") {
      if (isTldWildcard(pattern)) throw new Error(`refusing '${pattern}': TLD-wide wildcards are always disallowed`);
      if (!p.include.includes(pattern)) p.include.push(pattern);
    } else if (op === "deny") {
      if (!p.exclude.includes(pattern)) p.exclude.push(pattern);
    } else if (op === "rm") {
      p.include = p.include.filter((x) => x !== pattern);
      p.exclude = p.exclude.filter((x) => x !== pattern);
    } else {
      throw new Error("unknown op: " + op);
    }
    return p;
  }

  g.CDPolicy = { siteHost, isTldWildcard, matchPattern, normalizePolicy, evaluate, apply };
  if (typeof module !== "undefined" && module.exports) module.exports = g.CDPolicy;
})(typeof globalThis !== "undefined" ? globalThis : this);
