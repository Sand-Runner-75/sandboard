"use strict";
// Edit mode's write session and write client, against a mocked GitHub API with synthetic repositories.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, json, sha, API } = require("./helpers");
const WEB = "https://github.example.invalid";

const SB = loadSB();
const WRITE = "synthetic-write-value";
const MAPPED = ["acme/garden-plan", "acme/garden", "other-org/elsewhere"];

// A mock that answers GET /user and the repository reads, and records every write.
function mock(over = {}) {
  const calls = [];
  async function fetch(url, init) {
    calls.push({ url, init });
    assert.ok(url.startsWith(API + "/"), url);
    const p = url.slice(API.length);
    for (const [re, handler] of over.routes || []) if (re.test(p) && (!handler.method || handler.method === init.method)) return handler(p, init);
    if (p === "/user") return json({ login: "synthetic-user" }, 200, over.expiry ? { "github-authentication-token-expiration": over.expiry } : {});
    if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return (over.unreachable || []).includes(p.slice(7)) ? json({ message: "Not Found" }, 404) : json({ full_name: p.slice(7), html_url: WEB + "/" + p.slice(7) });
    return new Response(init.method === "POST" && /\/(rerun|rerun-failed-jobs|cancel|dispatches)$/.test(p) ? null : "{}",
                        { status: /\/(rerun|rerun-failed-jobs|cancel)$/.test(p) ? 202 : /\/dispatches$/.test(p) ? 204 : 201 });
  }
  return { calls, fetch, writes: () => calls.filter(c => c.init.method !== "GET") };
}

async function signedIn(over) {
  const gh = mock(over);
  const ws = SB.createWriteSession();
  ws.start(WRITE, "acme", MAPPED);
  const w = SB.createWriter(ws, gh.fetch);
  const said = await w.check();
  return { gh, ws, w, said };
}

test("Edit mode starts only for one owner, with that owner's mapped repositories", () => {
  const ws = SB.createWriteSession();
  assert.throws(() => ws.start("", "acme", MAPPED));
  assert.throws(() => ws.start(WRITE, "nobody", MAPPED));
  assert.throws(() => ws.start(WRITE, "acme/garden", MAPPED));
  ws.start(WRITE, "acme", MAPPED);
  assert.deepEqual(ws.repos, ["acme/garden", "acme/garden-plan"]);
  assert.equal(ws.allows("other-org/elsewhere"), false);
  assert.equal(ws.login, null, "who it acts as is known only from GitHub's answer");
});

test("the write token is never readable from the session or the writer", async () => {
  const { ws, w } = await signedIn();
  assert.ok(!JSON.stringify(ws).includes(WRITE));
  assert.ok(!JSON.stringify(w).includes(WRITE));
  assert.ok(Object.isFrozen(ws) && Object.isFrozen(w));
  assert.deepEqual(Object.keys(w).sort(), ["busy", "check", "current", "dispatch", "prepare"]);
  assert.throws(() => SB.createWriter({ on: true }, () => {}), /createWriteSession/);
});

test("checking the token reads who it acts as, its expiry and which repositories it reaches", async () => {
  const { gh, ws, said } = await signedIn({ expiry: "2026-11-30 00:00:00 UTC", unreachable: ["acme/garden"] });
  assert.equal(said.ok, true);
  assert.equal(said.login, "synthetic-user");
  assert.equal(said.expiry, "2026-11-30 00:00:00 UTC");
  assert.deepEqual(said.reach.map(r => [r.repo, r.ok]), [["acme/garden", false], ["acme/garden-plan", true]]);
  assert.deepEqual(ws.repos, ["acme/garden-plan"], "a repository the write token cannot reach is taken out");
  for (const { init } of gh.calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer " + WRITE);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
  }
  const unknown = await signedIn();
  assert.equal(unknown.said.expiry, null, "no header: expiry unknown, never guessed");
});

test("a refused write token, or one that reaches nothing, ends Edit mode", async () => {
  const revoked = await signedIn({ routes: [[/^\/user$/, () => json({ message: "Bad credentials" }, 401)]] });
  assert.equal(revoked.said.ok, false);
  assert.equal(revoked.ws.on, false);
  const none = await signedIn({ unreachable: ["acme/garden", "acme/garden-plan"] });
  assert.equal(none.said.ok, false);
  assert.equal(none.ws.on, false);
});

test("a token that later answers as someone else is dropped", async () => {
  const { ws } = await signedIn();
  assert.equal(ws.identify("someone-else"), false);
  assert.equal(ws.on, false);
});

test("only the fixed kinds with every detail checked become a frozen action", async () => {
  const { w } = await signedIn();
  const bad = [
    ["no-such-kind", "acme/garden", { number: 1 }],
    ["comment", "other-org/elsewhere", { number: 1, body: "hi" }],
    ["comment", "acme/unmapped", { number: 1, body: "hi" }],
    ["comment", "acme/garden", { number: 0, body: "hi" }],
    ["comment", "acme/garden", { number: 1, body: "  " }],
    ["comment", "acme/garden", { number: 1, body: "hi", method: "DELETE" }],
    ["comment", "acme/garden", { number: 1, body: "hi", path: "/user" }],
    ["review", "acme/garden", { number: 2, commit_id: "main", event: "APPROVE" }],
    ["review", "acme/garden", { number: 2, commit_id: sha("h"), event: "REQUEST_CHANGES" }],
    ["create-branch", "acme/garden", { branch: "../main", from: sha("b") }],
    ["create-branch", "acme/garden", { branch: "x.lock", from: sha("b") }],
    ["open-pull", "acme/garden", { title: "t", head: "main", base: "main" }],
    ["edit-issue", "acme/garden", { number: 3 }],
    ["add-assignees", "acme/garden", { number: 3, assignees: ["not a login"] }],
    ["start-workflow", "acme/garden", { workflow: 7, ref: "main", inputs: { "a b": "x" } }],
    ["toString", "acme/garden", {}],
  ];
  for (const [kind, repo, fields] of bad) assert.throws(() => w.prepare(kind, repo, fields), SB.NotSent, kind + " " + JSON.stringify(fields));
  const d = w.prepare("comment", "acme/garden", { number: 4, body: "Synthetic comment" });
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.fields));
  assert.equal(d.login, "synthetic-user");
  assert.equal(d.owner, "acme");
  assert.equal(d.hard, false);
  assert.equal(w.prepare("edit-issue", "acme/garden", { number: 4, state: "closed" }).hard, true);
});

test("each action is sent as its one fixed method, path and body", async () => {
  const { gh, w } = await signedIn();
  const head = sha("head"), base = sha("base");
  const cases = [
    ["comment", { number: 4, body: "Synthetic comment" }, "POST", "/repos/acme/garden/issues/4/comments", { body: "Synthetic comment" }, "done"],
    ["review", { number: 5, commit_id: head, event: "APPROVE" }, "POST", "/repos/acme/garden/pulls/5/reviews", { commit_id: head, event: "APPROVE" }, "done"],
    ["update-branch", { number: 5, expected_head_sha: head }, "PUT", "/repos/acme/garden/pulls/5/update-branch", { expected_head_sha: head }, "requested"],
    ["add-labels", { number: 4, labels: ["bug", "needs review"] }, "POST", "/repos/acme/garden/issues/4/labels", { labels: ["bug", "needs review"] }, "done"],
    ["remove-label", { number: 4, label: "needs review" }, "DELETE", "/repos/acme/garden/issues/4/labels/needs%20review", undefined, "done"],
    ["remove-reviewers", { number: 5, reviewers: ["octo-cat"] }, "DELETE", "/repos/acme/garden/pulls/5/requested_reviewers", { reviewers: ["octo-cat"] }, "done"],
    ["rerun-failed", { run: 123456 }, "POST", "/repos/acme/garden/actions/runs/123456/rerun-failed-jobs", undefined, "requested"],
    ["start-workflow", { workflow: 77, ref: "main", inputs: { level: "low" } }, "POST", "/repos/acme/garden/actions/workflows/77/dispatches", { ref: "main", inputs: { level: "low" } }, "requested"],
    ["create-branch", { branch: "feature/synthetic", from: base }, "POST", "/repos/acme/garden/git/refs", { ref: "refs/heads/feature/synthetic", sha: base }, "done"],
  ];
  for (const [kind, fields, method, path, body, outcome] of cases) {
    const before = gh.writes().length;
    const r = await w.dispatch(w.prepare(kind, "acme/garden", fields));
    assert.equal(r.outcome, outcome, kind);
    const sent = gh.writes().slice(before);
    assert.equal(sent.length, 1, kind + " is sent once");
    assert.equal(sent[0].init.method, method, kind);
    assert.equal(sent[0].url, API + path, kind);
    assert.deepEqual(sent[0].init.body === undefined ? undefined : JSON.parse(sent[0].init.body), body, kind);
    assert.equal(sent[0].init.headers.Authorization, "Bearer " + WRITE);
    assert.equal(sent[0].init.credentials, "omit");
    assert.equal(sent[0].init.referrerPolicy, "no-referrer");
    assert.equal(sent[0].init.redirect, "error");
    assert.ok(r.link.startsWith(WEB + "/acme/garden/"), r.link);
  }
});

test("a changed or copied action is never sent", async () => {
  const { gh, ws, w } = await signedIn();
  const d = w.prepare("comment", "acme/garden", { number: 4, body: "Synthetic" });
  const copy = Object.assign({}, d, { fields: { number: 4, body: "Changed" } });
  assert.equal((await w.dispatch(copy)).outcome, "not-sent");
  // The project's mapping changed: confirmations made before are void.
  ws.restrict(["acme/garden", "acme/garden-plan", "acme/extra"]);
  assert.equal(w.current(d), true, "a mapping that still holds everything changes nothing");
  ws.restrict(["acme/garden"]);
  assert.equal((await w.dispatch(d)).outcome, "not-sent");
  assert.equal(gh.writes().length, 0);
});

test("losing the last repository drops the token; losing one of several keeps it", async () => {
  const { ws, w } = await signedIn();
  const onPlan = w.prepare("comment", "acme/garden-plan", { number: 1, body: "x" });
  ws.remove("acme/garden");
  assert.equal(ws.on, true);
  assert.equal(ws.allows("acme/garden"), false);
  assert.throws(() => w.prepare("comment", "acme/garden", { number: 1, body: "x" }), SB.NotSent);
  assert.equal(w.current(onPlan), false, "the mapping generation moved on");
  ws.remove("acme/garden-plan");
  assert.equal(ws.on, false);
});

test("after Edit mode ends nothing is sent", async () => {
  const { gh, ws, w } = await signedIn();
  const d = w.prepare("comment", "acme/garden", { number: 4, body: "Synthetic" });
  ws.end();
  const r = await w.dispatch(d);
  assert.equal(r.outcome, "not-sent");
  assert.equal(gh.writes().length, 0);
  assert.throws(() => w.prepare("comment", "acme/garden", { number: 4, body: "x" }), SB.NotSent);
});

test("a hard-to-undo change needs its number typed", async () => {
  const { gh, w } = await signedIn();
  const d = w.prepare("edit-pull", "acme/garden", { number: 9, state: "closed" });
  assert.equal((await w.dispatch(d)).outcome, "not-sent");
  assert.equal((await w.dispatch(d, "8")).outcome, "not-sent");
  assert.equal(gh.writes().length, 0);
  assert.equal((await w.dispatch(d, " 9 ")).outcome, "done");
});

test("one write at a time", async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const { gh, w } = await signedIn({ routes: [[/\/comments$/, async () => { await held; return json({}, 201); }]] });
  const first = w.dispatch(w.prepare("comment", "acme/garden", { number: 1, body: "one" }));
  assert.equal(w.busy, true);
  const second = await w.dispatch(w.prepare("comment", "acme/garden", { number: 1, body: "two" }));
  assert.equal(second.outcome, "not-sent");
  release();
  assert.equal((await first).outcome, "done");
  assert.equal(gh.writes().length, 1);
});

test("results say only what is known, and nothing is retried", async () => {
  const say = (status, body) => [/\/comments$/, () => new Response(body === undefined ? "{}" : JSON.stringify(body), { status })];
  const refused = await signedIn({ routes: [say(422, { message: "Validation <b>failed</b>" })] });
  let r = await refused.w.dispatch(refused.w.prepare("comment", "acme/garden", { number: 1, body: "x" }));
  assert.equal(r.outcome, "refused");
  assert.match(r.message, /HTTP 422.*Validation <b>failed<\/b>/, "GitHub's message is kept as plain text");
  const broken = await signedIn({ routes: [say(502)] });
  r = await broken.w.dispatch(broken.w.prepare("comment", "acme/garden", { number: 1, body: "x" }));
  assert.equal(r.outcome, "unknown");
  assert.match(r.message, /Not sure it happened/);
  assert.equal(broken.gh.writes().length, 1);
  const lost = await signedIn({ routes: [[/\/comments$/, () => { throw new TypeError("network"); }]] });
  r = await lost.w.dispatch(lost.w.prepare("comment", "acme/garden", { number: 1, body: "x" }));
  assert.equal(r.outcome, "unknown");
  assert.equal(lost.gh.writes().length, 1);
  assert.equal(lost.w.busy, false);
});

test("a write refused as unauthorised ends Edit mode", async () => {
  const { ws, w } = await signedIn({ routes: [[/\/comments$/, () => json({ message: "Bad credentials" }, 401)]] });
  const r = await w.dispatch(w.prepare("comment", "acme/garden", { number: 1, body: "x" }));
  assert.equal(r.outcome, "refused");
  assert.equal(ws.on, false);
});

test("a reply that arrives after Edit mode ended is still reported, never as undone", async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const { ws, w } = await signedIn({ routes: [[/\/comments$/, async () => { await held; return json({}, 201); }]] });
  const pending = w.dispatch(w.prepare("comment", "acme/garden", { number: 1, body: "x" }));
  ws.end();
  release();
  const r = await pending;
  assert.ok(["done", "unknown"].includes(r.outcome));
  assert.ok(r.link, "a link to check it on GitHub");
});

test("the confirmation lists every detail as plain text", async () => {
  const { w } = await signedIn();
  const text = "<img src=x onerror=alert(1)> **bold**";
  const rows = SB.describeWrite(w.prepare("review", "acme/garden", { number: 5, commit_id: sha("h"), event: "COMMENT", body: text }));
  assert.deepEqual(rows.map(r => r[0]), ["Action", "Repository", "Acting as", "Number", "At commit", "Review", "Text"]);
  assert.deepEqual(rows.find(r => r[0] === "Text"), ["Text", text]);
  assert.deepEqual(rows.find(r => r[0] === "Acting as"), ["Acting as", "synthetic-user"]);
});
