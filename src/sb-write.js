"use strict";
// Edit mode's write access: the only code allowed to change anything on GitHub. A second, separate
// token is pasted only when Edit mode is turned on and lives in a write session in memory, never
// beside the read token. Callers never pass a method, a path or a body: they build a typed action
// (a frozen descriptor) from a fixed list of kinds, the owner confirms exactly that descriptor, and
// this file maps it to one fixed method and path and builds the body itself. One write at a time,
// never retried, never batched, and every result is reported by what is actually known.

(function (root) {
  const SB = root.SB = root.SB || {};
  const API = SB.API;

  const WRITE_AUTH = new WeakMap();

  // A write session: the write token, the owner it was made for, the login GitHub says it acts as, and
  // the repositories it may change. Every drop bumps the generation, so a confirmation or a reply made
  // under an older one is never acted on. The repositories are the open workspace's mapped ones of that
  // owner; when one is unmapped or unreadable it leaves the set (and the mapping generation moves on),
  // and when none is left the token is dropped.
  function createWriteSession() {
    let token = null;
    let owner = null;
    let login = null;
    let repos = new Set();
    let gen = 0;
    let mapGen = 0;
    let suspended = false;
    const session = {
      start(newToken, newOwner, mapped) {
        session.end();
        if (typeof newToken !== "string" || !newToken) throw new Error("no write token");
        if (!/^[A-Za-z0-9-]{1,39}$/.test(newOwner || "")) throw new Error("not an owner name");
        const mine = [...mapped].filter(r => SB.validRepo(r) && r.split("/")[0].toLowerCase() === newOwner.toLowerCase());
        if (!mine.length) throw new Error("no mapped repository of that owner");
        token = newToken;
        owner = newOwner;
        repos = new Set(mine.map(r => r.toLowerCase()));
        return gen;
      },
      // GitHub's own answer to who the token is; a later answer that names someone else drops it.
      identify(name) {
        if (token === null) return false;
        if (login !== null && login !== name) { session.end(); return false; }
        login = name;
        return true;
      },
      // Keeps only repositories that are still mapped; drops the token when none is left.
      restrict(mapped) {
        if (token === null) return;
        const still = new Set([...mapped].map(r => String(r).toLowerCase()));
        const kept = new Set([...repos].filter(r => still.has(r)));
        if (kept.size === repos.size) return;
        repos = kept;
        mapGen += 1;
        if (!repos.size) session.end();
      },
      // A repository the write token cannot reach, or a read that found it denied or missing.
      remove(repo) { session.restrict([...repos].filter(r => r !== String(repo).toLowerCase())); },
      // While the workspace list is being read again, what it maps is not known: nothing may be changed,
      // and every confirmation made before is void. resume() comes only after restrict() with the new mapping.
      suspend() {
        if (token === null || suspended) return;
        suspended = true;
        mapGen += 1;
      },
      resume() { suspended = false; },
      allows(repo) { return token !== null && !suspended && repos.has(String(repo).toLowerCase()); },
      end() {
        if (token === null && owner === null) return;
        token = null; owner = null; login = null; repos = new Set(); suspended = false;
        gen += 1;
      },
      get on() { return token !== null; },
      get owner() { return owner; },
      get login() { return login; },
      get repos() { return [...repos].sort(); },
      get gen() { return gen; },
      get mapGen() { return mapGen; },
      get suspended() { return suspended; },
      toJSON() { return { on: token !== null, owner, login }; },
    };
    WRITE_AUTH.set(session, g => {
      if (token === null || g !== gen) throw new SB.Stale();
      return "Bearer " + token;
    });
    return Object.freeze(session);
  }

  // ---- Checked fields

  const NUMBER = v => Number.isInteger(v) && v >= 1 && v <= 999999999;
  const ID = v => Number.isInteger(v) && v >= 1 && v <= 999999999999;
  const SHA40 = v => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
  const TEXT = max => v => typeof v === "string" && v.trim() !== "" && v.length <= max;
  const OPTIONAL_TEXT = max => v => v === undefined || (typeof v === "string" && v.length <= max);
  const BRANCH = v => typeof v === "string" && v.length <= 250 && /^[A-Za-z0-9._/-]+$/.test(v) &&
    !/^[/.-]|[/.]$|[.][.]|[/][/]|[/][.]|[.]lock$|[.]lock[/]|@[{]/.test(v);
  const LOGIN = v => typeof v === "string" && /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(v);
  const LOGINS = v => Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every(LOGIN) && new Set(v).size === v.length;
  const LABEL = v => typeof v === "string" && v.trim() !== "" && v.length <= 100 && !/[\u0000-\u001f]/.test(v);
  const LABELS = v => Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every(LABEL) && new Set(v).size === v.length;
  const ONE_OF = (...values) => v => values.includes(v);
  const OPTIONAL = (check) => v => v === undefined || check(v);
  const INPUTS = v => v === undefined || (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= 10 &&
    Object.entries(v).every(([k, x]) => /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(k) && typeof x === "string" && x.length <= 1000));

  // ---- The fixed actions: one method and one path template each, from the accepted design's table.
  // Each later task wires its own buttons to these kinds and proves them first on synthetic data, then on
  // a throwaway test repository. Actions that need a fresh read right before sending (merging, deleting a
  // branch, editing a file) and the account actions are added by their own tasks with those checks.
  // result: "done" when GitHub's answer is the finished change, "requested" when it only accepts a request.
  // hard: needs the item number typed before it is sent.
  const KINDS = {
    "comment": { what: "Comment", method: "POST", path: f => "/issues/" + f.number + "/comments",
      fields: { number: NUMBER, body: TEXT(65536) }, body: f => ({ body: f.body }),
      result: "done", link: f => "/issues/" + f.number, undo: "You can edit or delete the comment there." },
    "review": { what: "Review", method: "POST", path: f => "/pulls/" + f.number + "/reviews",
      fields: { number: NUMBER, commit_id: SHA40, event: ONE_OF("COMMENT", "APPROVE", "REQUEST_CHANGES"), body: OPTIONAL_TEXT(65536) },
      check: f => f.event === "APPROVE" || (typeof f.body === "string" && f.body.trim() !== ""),
      body: f => Object.assign({ commit_id: f.commit_id, event: f.event }, f.body ? { body: f.body } : {}),
      result: "done", link: f => "/pull/" + f.number, undo: "A review can be dismissed there; it cannot be deleted." },
    "update-branch": { what: "Update the pull request's branch", method: "PUT", path: f => "/pulls/" + f.number + "/update-branch",
      fields: { number: NUMBER, expected_head_sha: SHA40 }, body: f => ({ expected_head_sha: f.expected_head_sha }),
      result: "requested", link: f => "/pull/" + f.number, undo: "The merge commit it adds can be reverted on the branch." },
    "open-issue": { what: "Open an issue", method: "POST", path: () => "/issues",
      fields: { title: TEXT(256), body: OPTIONAL_TEXT(65536) },
      body: f => Object.assign({ title: f.title }, f.body ? { body: f.body } : {}),
      result: "done", link: () => "/issues", undo: "You can close it there." },
    "edit-issue": { what: "Change an issue", method: "PATCH", path: f => "/issues/" + f.number,
      fields: { number: NUMBER, title: OPTIONAL(TEXT(256)), body: OPTIONAL_TEXT(65536), state: OPTIONAL(ONE_OF("open", "closed")) },
      check: f => f.title !== undefined || f.body !== undefined || f.state !== undefined,
      body: f => pick(f, ["title", "body", "state"]), hard: f => f.state === "closed",
      result: "done", link: f => "/issues/" + f.number, undo: "You can change it back or reopen it there." },
    "add-labels": { what: "Add labels", method: "POST", path: f => "/issues/" + f.number + "/labels",
      fields: { number: NUMBER, labels: LABELS }, body: f => ({ labels: f.labels.slice() }),
      result: "done", link: f => "/issues/" + f.number, undo: "You can remove them there." },
    "remove-label": { what: "Remove a label", method: "DELETE", path: f => "/issues/" + f.number + "/labels/" + encodeURIComponent(f.label),
      fields: { number: NUMBER, label: LABEL }, body: () => null,
      result: "done", link: f => "/issues/" + f.number, undo: "You can add it again there." },
    "add-assignees": { what: "Assign", method: "POST", path: f => "/issues/" + f.number + "/assignees",
      fields: { number: NUMBER, assignees: LOGINS }, body: f => ({ assignees: f.assignees.slice() }),
      result: "done", link: f => "/issues/" + f.number, undo: "You can unassign them there." },
    "remove-assignees": { what: "Unassign", method: "DELETE", path: f => "/issues/" + f.number + "/assignees",
      fields: { number: NUMBER, assignees: LOGINS }, body: f => ({ assignees: f.assignees.slice() }),
      result: "done", link: f => "/issues/" + f.number, undo: "You can assign them again there." },
    "open-pull": { what: "Open a pull request", method: "POST", path: () => "/pulls",
      fields: { title: TEXT(256), head: BRANCH, base: BRANCH, body: OPTIONAL_TEXT(65536) },
      check: f => f.head !== f.base,
      body: f => Object.assign({ title: f.title, head: f.head, base: f.base }, f.body ? { body: f.body } : {}),
      result: "done", link: () => "/pulls", undo: "You can close it there." },
    "edit-pull": { what: "Change a pull request", method: "PATCH", path: f => "/pulls/" + f.number,
      fields: { number: NUMBER, title: OPTIONAL(TEXT(256)), body: OPTIONAL_TEXT(65536), state: OPTIONAL(ONE_OF("open", "closed")), base: OPTIONAL(BRANCH) },
      check: f => f.title !== undefined || f.body !== undefined || f.state !== undefined || f.base !== undefined,
      body: f => pick(f, ["title", "body", "state", "base"]), hard: f => f.state === "closed",
      result: "done", link: f => "/pull/" + f.number, undo: "You can change it back or reopen it there." },
    "request-reviewers": { what: "Ask for reviews", method: "POST", path: f => "/pulls/" + f.number + "/requested_reviewers",
      fields: { number: NUMBER, reviewers: LOGINS }, body: f => ({ reviewers: f.reviewers.slice() }),
      result: "done", link: f => "/pull/" + f.number, undo: "You can remove the request there." },
    "remove-reviewers": { what: "Withdraw review requests", method: "DELETE", path: f => "/pulls/" + f.number + "/requested_reviewers",
      fields: { number: NUMBER, reviewers: LOGINS }, body: f => ({ reviewers: f.reviewers.slice() }),
      result: "done", link: f => "/pull/" + f.number, undo: "You can ask them again there." },
    "rerun": { what: "Re-run every job", method: "POST", path: f => "/actions/runs/" + f.run + "/rerun",
      fields: { run: ID }, body: () => null,
      result: "requested", link: f => "/actions/runs/" + f.run, undo: "A started run can be cancelled there." },
    "rerun-failed": { what: "Re-run the failed jobs", method: "POST", path: f => "/actions/runs/" + f.run + "/rerun-failed-jobs",
      fields: { run: ID }, body: () => null,
      result: "requested", link: f => "/actions/runs/" + f.run, undo: "A started run can be cancelled there." },
    "cancel-run": { what: "Cancel a run", method: "POST", path: f => "/actions/runs/" + f.run + "/cancel",
      fields: { run: ID }, body: () => null,
      result: "requested", link: f => "/actions/runs/" + f.run, undo: "A cancelled run can be re-run there." },
    "start-workflow": { what: "Start a workflow", method: "POST", path: f => "/actions/workflows/" + f.workflow + "/dispatches",
      fields: { workflow: ID, ref: BRANCH, inputs: INPUTS },
      body: f => Object.assign({ ref: f.ref }, f.inputs ? { inputs: Object.assign({}, f.inputs) } : {}),
      result: "requested", link: () => "/actions", undo: "A started run can be cancelled there." },
    "create-branch": { what: "Create a branch", method: "POST", path: () => "/git/refs",
      fields: { branch: BRANCH, from: SHA40 }, body: f => ({ ref: "refs/heads/" + f.branch, sha: f.from }),
      result: "done", link: f => "/tree/" + f.branch.split("/").map(encodeURIComponent).join("/"), undo: "You can delete the branch there." },
  };

  // How each field is named in the confirmation, in this order.
  const LABELS_OF = [
    ["number", "Number"], ["title", "Title"], ["state", "New state"], ["base", "Base branch"], ["head", "Head branch"],
    ["commit_id", "At commit"], ["expected_head_sha", "Only if the head is still"], ["event", "Review"],
    ["labels", "Labels"], ["label", "Label"], ["assignees", "People"], ["reviewers", "Reviewers"],
    ["run", "Run"], ["workflow", "Workflow"], ["ref", "On branch"], ["inputs", "Inputs"],
    ["branch", "New branch"], ["from", "From commit"], ["body", "Text"],
  ];

  function pick(f, names) {
    const out = {};
    for (const n of names) if (f[n] !== undefined) out[n] = f[n];
    return out;
  }

  class NotSent extends Error {
    constructor(reason) { super(reason); this.name = "NotSent"; }
  }

  // A frozen descriptor holding everything that decides what GitHub does, and who it was built for.
  // Anything that is not one of the kind's checked fields is refused, never passed on.
  function prepare(ws, kind, repo, fields) {
    const k = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
    if (!k) throw new NotSent("not a known action");
    if (!ws.on || ws.login === null) throw new NotSent("Edit mode is off");
    if (!SB.validRepo(repo) || !ws.allows(repo)) throw new NotSent("not a repository Edit mode may change");
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new NotSent("no details");
    const given = Object.keys(fields).filter(n => fields[n] !== undefined);
    if (given.some(n => !Object.prototype.hasOwnProperty.call(k.fields, n))) throw new NotSent("a detail this action does not take");
    for (const [n, ok] of Object.entries(k.fields)) if (!ok(fields[n])) throw new NotSent("the " + n + " is not valid");
    if (k.check && !k.check(fields)) throw new NotSent("the details do not make a complete change");
    const copy = JSON.parse(JSON.stringify(pick(fields, Object.keys(k.fields))));
    deepFreeze(copy);
    return Object.freeze({ kind, repo, fields: copy, login: ws.login, owner: ws.owner, gen: ws.gen, mapGen: ws.mapGen,
                           hard: !!(k.hard && k.hard(copy)) });
  }

  function deepFreeze(o) {
    for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
    return Object.freeze(o);
  }

  // Whether a descriptor still belongs to this write session as it is now.
  function current(ws, d) {
    return !!d && ws.on && d.gen === ws.gen && d.mapGen === ws.mapGen && d.login === ws.login && d.owner === ws.owner && ws.allows(d.repo);
  }

  // What the confirmation shows, as plain label and value pairs; the caller puts them in as text.
  function describe(d) {
    const k = KINDS[d.kind];
    const rows = [["Action", k.what], ["Repository", d.repo], ["Acting as", d.login]];
    for (const [n, label] of LABELS_OF) {
      const v = d.fields[n];
      if (v === undefined) continue;
      rows.push([label, Array.isArray(v) ? v.join(", ") : v && typeof v === "object"
        ? Object.entries(v).map(([a, b]) => a + " = " + b).join("; ") : n === "number" ? "#" + v : String(v)]);
    }
    return rows;
  }

  function createWriter(ws, fetchImpl) {
    const send = fetchImpl || root.fetch.bind(root);
    const authorization = WRITE_AUTH.get(ws);
    if (!authorization) throw new Error("not a session from createWriteSession");
    let busy = false;
    // Every action this writer issued, with its own private copy of the checked details. Only an issued
    // action can be sent, only once, and only with that copy: a look-alike or a frozen clone is refused.
    const issued = new WeakMap();
    // Each repository's web address as GitHub's own reply gave it, for the link under a result.
    const webs = new Map();

    function request(method, path, gen, body) {
      const headers = { "Accept": "application/vnd.github+json", "Authorization": authorization(gen),
                        "X-GitHub-Api-Version": "2022-11-28" };
      if (body !== null) headers["Content-Type"] = "application/json";
      return send(API + path, { method, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
                                redirect: "error", headers, body: body === null ? undefined : JSON.stringify(body) });
    }

    // Who the write token acts as, and when it expires if GitHub says. Then which of the allowed
    // repositories it can actually reach: one it cannot is taken out, and none left drops the token.
    async function check() {
      const gen = ws.gen;
      let res;
      try { res = await request("GET", "/user", gen, null); } catch (e) {
        if (e instanceof SB.Stale) throw e;
        return { ok: false, why: "GitHub could not be reached" };
      }
      if (ws.gen !== gen) throw new SB.Stale();
      if (res.status === 401) { ws.end(); return { ok: false, why: "GitHub refused the write token: it is invalid, expired or revoked" }; }
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (ws.gen !== gen) throw new SB.Stale();
      if (!res.ok || !body || !/^[A-Za-z0-9-]{1,39}$/.test(body.login || "")) {
        ws.end();
        return { ok: false, why: "GitHub did not say who the write token acts as (HTTP " + res.status + ")" };
      }
      if (!ws.identify(body.login)) return { ok: false, why: "the write token acts as someone else now" };
      const expiry = res.headers.get("github-authentication-token-expiration");
      const reach = [];
      for (const repo of ws.repos) {
        let r;
        try { r = await request("GET", "/repos/" + repo, gen, null); } catch (e) {
          if (e instanceof SB.Stale) throw e;
          r = null;
        }
        if (ws.gen !== gen) throw new SB.Stale();
        if (r && r.status === 401) { ws.end(); return { ok: false, why: "GitHub refused the write token: it is invalid, expired or revoked" }; }
        const ok = !!r && r.ok;
        if (ok) {
          let info = null;
          try { info = await r.json(); } catch (e) { info = null; }
          if (ws.gen !== gen) throw new SB.Stale();
          const web = info && SB.webAddress(info.html_url, repo);
          if (web) webs.set(repo, web);
        }
        reach.push({ repo, ok, why: ok ? null : r ? "HTTP " + r.status : "not reached" });
        if (!ok) ws.remove(repo);
      }
      if (!ws.on) return { ok: false, why: "the write token reaches none of this project's repositories of that owner", reach };
      return { ok: true, login: body.login, expiry: expiry && expiry.length <= 60 ? expiry : null, reach };
    }

    // Sends one confirmed descriptor. Returns { outcome, message, link, undo }:
    // "not-sent" (refused before sending), "refused" (GitHub's definite no), "done" or "requested"
    // (GitHub accepted it), "unknown" (it may or may not have happened: never resent, never shown as undone).
    // A hard-to-undo change (closing, and later merging or deleting) is sent only with its number typed.
    function issue(kind, repo, fields) {
      const d = prepare(ws, kind, repo, fields);
      issued.set(d, prepare(ws, kind, repo, fields));
      return d;
    }

    async function dispatch(d, typed) {
      const notSent = why => ({ outcome: "not-sent", message: "Not sent: " + why + ".", link: null, undo: null });
      const mine = d && typeof d === "object" ? issued.get(d) : undefined;
      if (!mine) return notSent("not a confirmed action");
      const k = KINDS[mine.kind];
      if (busy) return notSent("another change is still being sent");
      // Hard-to-undo is decided from the writer's own copy, never from what the caller holds.
      if (mine.hard && String(typed || "").trim() !== String(mine.fields.number)) return notSent("the number was not typed to confirm it");
      issued.delete(d);  // one confirmation sends at most once
      if (!current(ws, mine)) return notSent("Edit mode, the project or the token changed after it was confirmed");
      // The details are checked again as if they were new, under the session as it is now.
      let again;
      try { again = prepare(ws, mine.kind, mine.repo, mine.fields); } catch (e) { return notSent(e.message); }
      d = mine;
      const web = webs.get(d.repo.toLowerCase());
      const link = web ? web + k.link(again.fields) : null;
      busy = true;
      let res;
      try {
        res = await request(k.method, "/repos/" + d.repo + k.path(again.fields), d.gen, k.body(again.fields));
      } catch (e) {
        busy = false;
        if (e instanceof SB.Stale) return notSent("Edit mode ended");
        return { outcome: "unknown", message: "Not sure it happened: check on GitHub.", link, undo: null };
      }
      busy = false;
      if (res.status === 401) {
        ws.end();
        return { outcome: "refused", message: "GitHub refused it: the write token is invalid, expired or revoked. Edit mode ended.", link, undo: null };
      }
      if (res.status >= 400 && res.status < 500) {
        let said = "";
        try { const b = await res.json(); said = b && typeof b.message === "string" ? b.message.slice(0, 300) : ""; } catch (e) { said = ""; }
        return { outcome: "refused", message: "GitHub refused it (HTTP " + res.status + ")" + (said ? ": " + said : "") + ".", link, undo: null };
      }
      if (res.status >= 200 && res.status < 300) {
        const message = k.result === "requested"
          ? "Requested: GitHub accepted the request; it finishes on GitHub." : "Done.";
        return { outcome: k.result, message, link, undo: k.undo };
      }
      return { outcome: "unknown", message: "Not sure it happened: check on GitHub.", link, undo: null };
    }

    return Object.freeze({ check, prepare: issue,
                           current: d => current(ws, d), dispatch, get busy() { return busy; } });
  }

  Object.assign(SB, { createWriteSession, createWriter, WRITE_KINDS: Object.freeze(Object.keys(KINDS)), describeWrite: describe, NotSent });
})(typeof window !== "undefined" ? window : globalThis);
