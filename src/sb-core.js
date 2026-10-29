"use strict";
// Read-only GitHub access. The token lives only inside a session object in
// memory. Every read is a GET to the GitHub API on an allowlisted path, and
// anything that arrives after the session ended or a newer run started is
// dropped. Works in the browser and, for tests, in Node.

(function (root) {
  const SB = root.SB = root.SB || {};
  const API = "https://api.github.com";

  // Every state a reader can return. Only "current", "empty", "no-match" and
  // "partial" carry data, and each has its own label: none is shown as zero.
  const STATES = ["loading", "current", "empty", "no-match", "missing", "denied", "rate-limited",
                  "invalid", "stale", "unavailable", "partial", "failed"];
  const WITH_DATA = ["current", "empty", "no-match", "partial"];

  class Stale extends Error {
    constructor() { super("this run was replaced or the session ended"); this.name = "Stale"; }
  }
  class Revoked extends Error {
    constructor() { super("token invalid, expired or revoked"); this.name = "Revoked"; }
  }
  class TransportFailure extends Error {
    constructor() { super("network error"); this.name = "TransportFailure"; }
  }
  class NotAllowed extends Error {
    constructor() { super("request outside the read-only allowlist"); this.name = "NotAllowed"; }
  }

  function result(state, data, source, extra) {
    if (!STATES.includes(state)) throw new Error("unknown state: " + state);
    return Object.assign({ state, data: WITH_DATA.includes(state) ? data : undefined,
                           source: source || null, schema: null, error: null }, extra || {});
  }

  const AUTHORIZATION = new WeakMap();

  // One session per signed-in page. start() begins a run and returns its
  // context; a newer start(), forget() or a 401 makes every older context stale.
  function createSession() {
    let token = null;
    let run = 0;
    let controller = null;
    const session = {
      start(newToken) {
        if (controller) controller.abort();
        if (newToken) token = newToken;
        if (!token) throw new Error("no token");
        controller = new AbortController();
        run += 1;
        return Object.freeze({ session, run, signal: controller.signal });
      },
      alive(ctx) {
        if (!ctx || ctx.session !== session || ctx.run !== run || token === null) throw new Stale();
      },
      forget() {
        if (controller) controller.abort();
        controller = null;
        token = null;
        run += 1;
      },
      get signedIn() { return token !== null; },
      toJSON() { return { signedIn: token !== null }; },
    };
    // Only clients made in this file can turn a live context into the header.
    AUTHORIZATION.set(session, ctx => { session.alive(ctx); return "Bearer " + token; });
    return Object.freeze(session);
  }

  const NAME = "[A-Za-z0-9_.-]+";
  const SHA = "[0-9a-f]{40}";
  const FILE_PATH = NAME + "(?:/" + NAME + ")*";
  // The only reads the client makes. Later slices add their own entries here.
  const ALLOWED = [
    new RegExp("^/user$"),
    // The repositories the token can read, by name, so every one of them is listed.
    new RegExp("^/user/repos[?]per_page=100&page=[1-9]$"),
    // The Atlas account, only when asked: the account's public profile and up to 3 pages of its public events.
    new RegExp("^/users/[A-Za-z0-9-]{1,39}$"),
    new RegExp("^/users/[A-Za-z0-9-]{1,39}/events/public[?]per_page=100&page=[1-3]$"),
    // and, asked for apart, up to 3 pages each of the repositories it starred and its public gists.
    new RegExp("^/users/[A-Za-z0-9-]{1,39}/(?:starred|gists)[?]per_page=100&page=[1-3]$"),
    // To compare two accounts, when asked: up to 3 pages of each one's own public repositories.
    new RegExp("^/users/[A-Za-z0-9-]{1,39}/repos[?]sort=pushed&per_page=100&page=[1-3]$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/commits/[A-Za-z0-9_.%-]+$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/contents/" + FILE_PATH + "[?]ref=" + SHA + "$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/commits/" + SHA + "/check-runs[?]per_page=100&page=[1-9][0-9]?$"),
    // A task's review cycle: the repository's pull requests, and the comments on one of them.
    new RegExp("^/repos/" + NAME + "/" + NAME + "/pulls[?]state=(?:open|closed|all)&per_page=100&page=[1-9]$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/issues/[1-9][0-9]{0,8}/comments[?]per_page=100&page=[1-9]$"),
    // The repository overview: a repository's languages, and the recent evidence of its activity feed
    // (the latest commits at a pinned commit, the latest comments on its issues and pull requests).
    new RegExp("^/repos/" + NAME + "/" + NAME + "/languages$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/commits[?]sha=" + SHA + "&per_page=30$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/issues/comments[?]sort=created&direction=desc&per_page=50$"),
    // History: pages of commits behind a pinned commit, branches and tags, and how two commits compare.
    new RegExp("^/repos/" + NAME + "/" + NAME + "/commits[?]sha=" + SHA + "&per_page=100&page=[1-9][0-9]{0,8}$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/(?:branches|tags)[?]per_page=100&page=[1-3]$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/compare/" + SHA + "[.]{3}" + SHA + "[?]per_page=1$"),
    // Work evidence: pull requests by state with each one's reviews, issues by state, Actions runs and releases.
    new RegExp("^/repos/" + NAME + "/" + NAME + "/pulls/[1-9][0-9]{0,8}/reviews[?]per_page=100&page=[1-3]$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/issues[?]state=(?:open|closed|all)&per_page=100&page=[1-9]$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/(?:actions/runs|releases)[?]per_page=100&page=[1-9]$"),
    // Code inspection: the whole file tree at a pinned commit. A file's text is read by readFile above,
    // and a commit's changes, or the changes between two commits, by the commit and compare reads above.
    new RegExp("^/repos/" + NAME + "/" + NAME + "/git/trees/" + SHA + "[?]recursive=1$"),
    // The Atlas code tree: the commits of a merged pull request (its first page), to tell whose branch they came from.
    new RegExp("^/repos/" + NAME + "/" + NAME + "/pulls/[1-9][0-9]{0,8}/commits[?]per_page=100&page=1$"),
  ];

  function allowed(path) {
    return ALLOWED.some(re => re.test(path)) &&
      !path.split(/[/?&]/).some(part => part === "." || part === ".." || /^%2e/i.test(part));
  }

  function stateFor(res) {
    const limited = res.status === 429 || (res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    if (limited) return "rate-limited";
    if (res.status === 404) return "missing";
    if (res.status === 403) return "denied";
    return "failed";
  }

  function createClient(session, fetchImpl) {
    const send = fetchImpl || root.fetch.bind(root);
    const authorization = AUTHORIZATION.get(session);
    if (!authorization) throw new Error("not a session from createSession");

    async function get(ctx, path) {
      if (!allowed(path)) throw new NotAllowed();
      let res;
      try {
        res = await send(API + path, {
          method: "GET", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
          redirect: "error", signal: ctx.signal,
          headers: { "Accept": "application/vnd.github+json", "Authorization": authorization(ctx),
                     "X-GitHub-Api-Version": "2022-11-28" },
        });
      } catch (e) {
        session.alive(ctx);  // an aborted or late failure of an ended run stays silent
        if (e instanceof Stale) throw e;
        throw new TransportFailure();
      }
      session.alive(ctx);
      if (res.status === 401) {
        session.forget();
        throw new Revoked();
      }
      return res;
    }

    // The reply body as JSON; undefined if it is not JSON. A body that cannot
    // be read at all is a network failure, not invalid content.
    async function json(ctx, res) {
      let text;
      try { text = await res.text(); } catch (e) { session.alive(ctx); throw new TransportFailure(); }
      session.alive(ctx);
      try { return JSON.parse(text); } catch (e) { return undefined; }
    }

    async function blobSha(ctx, bytes) {
      // A git blob ID is sha1("blob <length>\0" + content); GitHub reports it as a file's sha.
      const head = new TextEncoder().encode("blob " + bytes.length + "\0");
      const all = new Uint8Array(head.length + bytes.length);
      all.set(head);
      all.set(bytes, head.length);
      const digest = await root.crypto.subtle.digest("SHA-1", all);
      session.alive(ctx);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    }

    // One file at a pinned commit; current only if its bytes match GitHub's blob sha.
    function readFile(ctx, repo, commit, path) {
      return guard(readFileUnguarded(ctx, repo, commit, path), { repo, commit, path });
    }

    async function readFileUnguarded(ctx, repo, commit, path) {
      const source = { repo, commit, path };
      if (!SB.validRepo(repo) || !new RegExp("^" + SHA + "$").test(commit) ||
          !new RegExp("^" + FILE_PATH + "$").test(path)) {
        return result("invalid", null, source, { error: "not a valid repository, commit or path" });
      }
      const res = await get(ctx, "/repos/" + repo + "/contents/" + path + "?ref=" + commit);
      if (!res.ok) return result(stateFor(res), null, source, { error: "HTTP " + res.status });
      const body = await json(ctx, res);
      if (!body || body.type !== "file" || typeof body.sha !== "string") {
        return result("invalid", null, source, { error: "not a file" });
      }
      if (body.encoding !== "base64" || typeof body.content !== "string") {
        return result("unavailable", null, source, { error: "too large to read through this API (over 1 MB)" });
      }
      let bytes;
      try {
        bytes = Uint8Array.from(root.atob(body.content.replace(/[\r\n]/g, "")), c => c.charCodeAt(0));
      } catch (e) {
        return result("invalid", null, source, { error: "content is not valid base64" });
      }
      if (await blobSha(ctx, bytes) !== body.sha) {
        return result("invalid", null, source, { error: "content does not match GitHub's hash" });
      }
      return result("current", { bytes, sha: body.sha }, source);
    }

    // Resolves a branch, tag or commit (default branch when ref is empty) to
    // one commit, which every read of a view then uses.
    function pin(ctx, repo, ref) {
      return guard(pinUnguarded(ctx, repo, ref), { repo, ref: ref || null });
    }

    async function pinUnguarded(ctx, repo, ref) {
      const source = { repo, ref: ref || null };
      if (!SB.validRepo(repo)) return result("invalid", null, source, { error: "not a repository name" });
      const meta = await get(ctx, "/repos/" + repo);
      if (!meta.ok) return result(stateFor(meta), null, source, { error: "HTTP " + meta.status });
      const info = await json(ctx, meta);
      if (!info || typeof info.default_branch !== "string") {
        return result("invalid", null, source, { error: "unexpected repository reply" });
      }
      const branch = ref || info.default_branch;
      const res = await get(ctx, "/repos/" + repo + "/commits/" + encodeURIComponent(branch));
      if (!res.ok) return result(stateFor(res), null, { repo, ref: branch }, { error: "HTTP " + res.status });
      const commit = await json(ctx, res);
      if (!commit || !new RegExp("^" + SHA + "$").test(commit.sha)) {
        return result("invalid", null, { repo, ref: branch }, { error: "unexpected commit reply" });
      }
      const date = commit.commit && commit.commit.committer && commit.commit.committer.date;
      return result("current", { commit: commit.sha, ref: branch, date: typeof date === "string" ? date : null,
                                 private: info.private === true, web: webAddress(info.html_url, repo), meta: repoMeta(info) },
                    { repo, ref: branch, commit: commit.sha });
    }

    return Object.freeze({ get, json, blobSha, readFile, pin, stateFor });
  }

  // A reader's promise, with a network failure of the live run turned into a
  // "failed" result. Revoked, Stale and programming errors pass through.
  async function guard(promise, source) {
    try {
      return await promise;
    } catch (e) {
      if (e instanceof TransportFailure) return result("failed", null, source, { error: "network error" });
      throw e;
    }
  }

  // What GitHub says about a repository, field by field. A field that is missing or not in the
  // expected form is null, and the view says "not given": it is never guessed or shown as zero.
  function repoMeta(info) {
    const text = (v, max) => typeof v === "string" && v.trim() !== "" ? v.slice(0, max) : null;
    const count = v => Number.isInteger(v) && v >= 0 ? v : null;
    const flag = v => typeof v === "boolean" ? v : null;
    const time = v => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null;
    const visibility = ["public", "private", "internal"].includes(info.visibility) ? info.visibility
      : typeof info.private === "boolean" ? (info.private ? "private" : "public") : null;
    const topics = Array.isArray(info.topics) && info.topics.length <= 30 && info.topics.every(t => typeof t === "string" && /^[a-z0-9][a-z0-9-]{0,49}$/.test(t))
      ? info.topics.slice() : null;
    const license = info.license === null ? "none" : info.license && typeof info.license === "object" ? text(info.license.spdx_id, 60) : null;
    return { description: text(info.description, 500), visibility, fork: flag(info.fork), archived: flag(info.archived),
             language: info.language === null ? "none" : text(info.language, 60), topics, license, branch: text(info.default_branch, 200),
             stars: count(info.stargazers_count), forks: count(info.forks_count), issues: count(info.open_issues_count),
             size: count(info.size), created: time(info.created_at), pushed: time(info.pushed_at),
             homepage: text(info.homepage, 300) };
  }

  // The repository's web address as GitHub's own reply gives it, for links the
  // owner clicks; null unless it is a plain https address ending in the repository's name.
  function webAddress(value, repo) {
    if (typeof value !== "string") return null;
    let url;
    try { url = new URL(value); } catch (e) { return null; }
    if (url.protocol.slice(0, -1) !== "https" || url.username || url.password || url.search || url.hash ||
        url.pathname.toLowerCase() !== "/" + String(repo).toLowerCase()) return null;
    return url.origin + url.pathname;
  }

  function validRepo(repo) {
    return typeof repo === "string" && /^[A-Za-z0-9-]+[/][A-Za-z0-9_.-]+$/.test(repo) &&
      !repo.split("/").some(part => part === "." || part === "..");
  }

  // "owner/repo" or "owner/repo@ref"; null if not of that form.
  function parseRepoRef(text) {
    if (typeof text !== "string") return null;
    const at = text.indexOf("@");
    const repo = at < 0 ? text : text.slice(0, at);
    const ref = at < 0 ? "" : text.slice(at + 1);
    if (!validRepo(repo) || (at >= 0 && !/^[A-Za-z0-9_./-]+$/.test(ref))) return null;
    return { repo, ref };
  }

  Object.assign(SB, { API, STATES, Stale, Revoked, NotAllowed, TransportFailure, result, guard, createSession, createClient,
                      allowed, validRepo, parseRepoRef, webAddress, repoMeta });
})(typeof window !== "undefined" ? window : globalThis);
