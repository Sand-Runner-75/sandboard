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
  class NotAllowed extends Error {
    constructor() { super("request outside the read-only allowlist"); this.name = "NotAllowed"; }
  }

  function result(state, data, source, extra) {
    if (!STATES.includes(state)) throw new Error("unknown state: " + state);
    return Object.assign({ state, data: WITH_DATA.includes(state) ? data : undefined,
                           source: source || null, schema: null, error: null }, extra || {});
  }

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
      authorization(ctx) {
        session.alive(ctx);
        return "Bearer " + token;
      },
      toJSON() { return { signedIn: token !== null }; },
    };
    return Object.freeze(session);
  }

  const NAME = "[A-Za-z0-9_.-]+";
  const SHA = "[0-9a-f]{40}";
  const FILE_PATH = NAME + "(?:/" + NAME + ")*";
  // The only reads the client makes. Later slices add their own entries here.
  const ALLOWED = [
    new RegExp("^/user$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/commits/[A-Za-z0-9_.%-]+$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/contents/" + FILE_PATH + "[?]ref=" + SHA + "$"),
    new RegExp("^/repos/" + NAME + "/" + NAME + "/commits/" + SHA + "/check-runs[?]per_page=100&page=[1-9][0-9]?$"),
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

    async function get(ctx, path) {
      if (!allowed(path)) throw new NotAllowed();
      const authorization = session.authorization(ctx);
      const res = await send(API + path, {
        method: "GET", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        redirect: "error", signal: ctx.signal,
        headers: { "Accept": "application/vnd.github+json", "Authorization": authorization,
                   "X-GitHub-Api-Version": "2022-11-28" },
      });
      session.alive(ctx);
      if (res.status === 401) {
        session.forget();
        throw new Revoked();
      }
      return res;
    }

    async function json(ctx, res) {
      let value;
      try { value = await res.json(); } catch (e) { session.alive(ctx); return undefined; }
      session.alive(ctx);
      return value;
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
    async function readFile(ctx, repo, commit, path) {
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
    async function pin(ctx, repo, ref) {
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
                                 private: info.private === true },
                    { repo, ref: branch, commit: commit.sha });
    }

    return Object.freeze({ get, json, blobSha, readFile, pin, stateFor });
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

  Object.assign(SB, { API, STATES, Stale, Revoked, NotAllowed, result, createSession, createClient,
                      allowed, validRepo, parseRepoRef });
})(typeof window !== "undefined" ? window : globalThis);
