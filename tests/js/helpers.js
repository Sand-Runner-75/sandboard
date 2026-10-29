"use strict";
// Shared test helpers: load the browser modules into Node, a mock of the
// GitHub API serving synthetic repositories, and a minimal DOM stand-in.
const crypto = require("node:crypto");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "src");
const MODULES = ["sb-core.js", "sb-readers.js", "sb-render.js", "sb-model.js", "sb-demo.js", "sb-gif.js", "sb-atlas-graph.js", "sb-atlas-tree.js"];
const API = "https://api.github.com";
const WEB = "https://github.example.invalid";  // synthetic web address; .invalid never resolves

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
//          languages?, commits? (or commitsAt: {commit: [...]}, per pinned commit), comments? (the repository overview's lists, as the API gives them),
//          history?, branchList?, tagList?, compare? (see the history reads below),
//          info? (more repository reply fields; undefined drops one), checks: {commit: [runs] | {status, headers}}, pulls: [{number, title, state, ..., comments, reviews?}],
//          work? ({path after the repository: reply body or status}, tried first, for the work evidence lists)}}
// overrides: [[RegExp on the path, (path, init) => Response | Promise<Response> | null]], tried first.
function mockGitHub(repos, overrides = []) {
  const calls = [];
  async function fetch(url, init) {
    calls.push({ url, init });
    if (!url.startsWith(API + "/")) throw new Error("unexpected host: " + url);
    const p = url.slice(API.length);
    for (const [re, handler] of overrides) {
      if (!re.test(p)) continue;
      const res = await handler(p, init);  // a handler may return null to let the plain mock answer
      if (res) return res;
    }
    if (p === "/user") return json({ login: "synthetic-user" });
    // The token's own list of repositories: none beyond the workspace list unless a test says so.
    if (/^\/user\/repos\?per_page=100&page=\d+$/.test(p)) return json([]);
    let m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      return r ? json({ full_name: m[1], private: r.private !== false, default_branch: r.default_branch || "main",
                        html_url: WEB + "/" + m[1], ...(r.info || {}) })
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
    // Work evidence: a repository's own replies (work), else lists made from its pulls, issues, runs and releases.
    m = /^\/repos\/([^/]+\/[^/]+)(\/(?:pulls|issues|actions\/runs|releases)(?:\/\d+\/reviews)?\?.*)$/.exec(p);
    if (m && repos[m[1]] && repos[m[1]].work && repos[m[1]].work[m[2]] !== undefined) {
      const v = repos[m[1]].work[m[2]];
      return typeof v === "number" ? json({ message: "no" }, v) : json(v);
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/pulls\?state=(open|closed|all)&per_page=100&page=(\d+)$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      if (!r) return json({ message: "Not Found" }, 404);
      const page = Number(m[3]);
      return json((r.pulls || []).filter(x => m[2] === "all" || x.state === m[2]).slice((page - 1) * 100, page * 100).map(({ comments, reviews, ...pr }) => pr));
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/(?:pulls\/(\d+)\/reviews|issues|actions\/runs|releases)\?(?:state=(open|closed|all)&)?per_page=100&page=(\d+)$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      if (!r) return json({ message: "Not Found" }, 404);
      const at = list => list.slice((Number(m[4]) - 1) * 100, Number(m[4]) * 100);
      if (m[2]) { const pr = (r.pulls || []).find(x => x.number === Number(m[2])); return pr ? json(at(pr.reviews || [])) : json({ message: "Not Found" }, 404); }
      if (p.includes("/issues?")) return json(at((r.issues || []).filter(x => m[3] === "all" || x.state === m[3])));
      if (p.includes("/actions/runs?")) return json({ total_count: (r.runs || []).length, workflow_runs: at(r.runs || []) });
      return json(at(r.releases || []));
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(p);
    if (m) {
      const pr = repos[m[1]] && (repos[m[1]].pulls || []).find(x => x.number === Number(m[2]));
      if (!pr) return json({ message: "Not Found" }, 404);
      const page = Number(m[3]);
      return json((pr.comments || []).slice((page - 1) * 100, page * 100));
    }
    // The repository overview's reads: a synthetic repository gives its own lists, or none.
    m = /^\/repos\/([^/]+\/[^/]+)\/(languages|commits\?sha=[0-9a-f]{40}&per_page=30|issues\/comments\?sort=created&direction=desc&per_page=50)$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      if (!r) return json({ message: "Not Found" }, 404);
      if (m[2] === "languages") return json(r.languages || {});
      if (m[2].startsWith("commits")) { const at = m[2].slice(12, 52); return json((r.commitsAt && r.commitsAt[at]) || r.commits || []); }
      return json(r.comments || []);
    }
    // History: pages behind a commit (history: {commit: [page, ...]}, a page being a list or a status),
    // branches and tags (branchList, tagList: a list or a status), and comparisons (compare: {head: reply or status}).
    m = /^\/repos\/([^/]+\/[^/]+)\/(?:commits\?sha=([0-9a-f]{40})&per_page=100&page=(\d+)|(branches|tags)\?per_page=100&page=(\d+)|compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?per_page=1)$/.exec(p);
    if (m) {
      const r = repos[m[1]];
      if (!r) return json({ message: "Not Found" }, 404);
      const give = v => typeof v === "number" ? json({ message: "no" }, v) : json(v);
      if (m[2]) { const pages = (r.history || {})[m[2]] || []; return give(pages[Number(m[3]) - 1] || []); }
      if (m[4]) { const list = r[m[4] === "branches" ? "branchList" : "tagList"] || []; return typeof list === "number" ? give(list) : json(list.slice((Number(m[5]) - 1) * 100, Number(m[5]) * 100)); }
      const c = (r.compare || {})[m[7]];
      return c === undefined ? json({ message: "Not Found" }, 404) : give(c);
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

module.exports = { loadSB, mockGitHub, blobSha, sha, json, fakeDocument, API, WEB };
