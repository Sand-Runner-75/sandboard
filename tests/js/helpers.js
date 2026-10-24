"use strict";
// Shared test helpers: load the browser modules into Node, a mock of the
// GitHub API serving synthetic repositories, and a minimal DOM stand-in.
const crypto = require("node:crypto");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "src");
const MODULES = ["sb-core.js", "sb-readers.js", "sb-render.js"];
const API = "https://api.github.com";

function loadSB() {
  delete globalThis.SB;
  for (const name of MODULES) {
    const file = require.resolve(path.join(SRC, name));
    delete require.cache[file];
    require(file);
  }
  return globalThis.SB;
}

function blobSha(text) {
  const buf = Buffer.from(text, "utf8");
  return crypto.createHash("sha1").update("blob " + buf.length + "\0").update(buf).digest("hex");
}

const sha = seed => crypto.createHash("sha1").update(String(seed)).digest("hex");

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ "content-type": "application/json" }, headers) });
}

// repos: {"owner/name": {private, default_branch, branches: {name: commit}, files: {commit: {path: text}},
//          checks: {commit: [runs] | {status, headers}}}}
// overrides: [[RegExp on the path, (path, init) => Response | Promise<Response>]], tried first.
function mockGitHub(repos, overrides = []) {
  const calls = [];
  async function fetch(url, init) {
    calls.push({ url, init });
    if (!url.startsWith(API + "/")) throw new Error("unexpected host: " + url);
    const p = url.slice(API.length);
    for (const [re, handler] of overrides) if (re.test(p)) return handler(p, init);
    if (p === "/user") return json({ login: "synthetic-user" });
    let m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      return r ? json({ full_name: m[1], private: r.private !== false, default_branch: r.default_branch || "main" })
               : json({ message: "Not Found" }, 404);
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})\/check-runs\?per_page=100&page=(\d+)$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      const checks = r && r.checks && r.checks[m[2]];
      if (!checks) return json({ total_count: 0, check_runs: [] });
      if (!Array.isArray(checks)) return json({ message: "denied" }, checks.status, checks.headers || {});
      const page = Number(m[3]);
      const total = checks.total === undefined ? checks.length : checks.total;
      return json({ total_count: total, check_runs: checks.slice((page - 1) * 100, page * 100) });
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/?]+)$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      const ref = decodeURIComponent(m[2]);
      const commit = r && (r.branches[ref] || (/^[0-9a-f]{40}$/.test(ref) && r.files[ref] ? ref : null));
      return commit ? json({ sha: commit, commit: { committer: { date: "2026-01-02T03:04:05Z" } } })
                    : json({ message: "No commit found" }, 404);
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      const text = r && r.files[m[3]] && r.files[m[3]][m[2]];
      if (text === undefined) return json({ message: "Not Found" }, 404);
      return json({ type: "file", encoding: "base64", sha: blobSha(text),
                    content: Buffer.from(text, "utf8").toString("base64").replace(/(.{60})/g, "$1\n") });
    }
    return json({ message: "no mock for " + p }, 500);
  }
  return { fetch, calls };
}

// Minimal DOM stand-in that records exactly what the renderer builds.
function fakeDocument() {
  function node(type, props) {
    return Object.assign({ type, children: [], attributes: {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(k, v) { this.attributes[k] = String(v); } }, props);
  }
  return {
    createDocumentFragment: () => node("fragment"),
    createTextNode: text => node("text", { text: String(text) }),
    createElement: tag => {
      const n = node("element", { tag });
      Object.defineProperty(n, "textContent", { set(v) { this.children = [{ type: "text", text: String(v) }]; },
                                                get() { return this.children.map(c => c.text).join(""); } });
      return n;
    },
  };
}

module.exports = { loadSB, mockGitHub, blobSha, sha, json, fakeDocument, API };
