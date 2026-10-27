"use strict";
// Session, read-only client, ref pinning and late-reply handling.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, json, sha, API } = require("./helpers");
const { planRepos, PLAN_COMMIT, FILES, TABLE } = require("./fixtures");

const SB = loadSB();
const TOKEN = "synthetic-token-value";

function setup(repos = planRepos(), overrides) {
  const gh = mockGitHub(repos, overrides);
  const session = SB.createSession();
  const client = SB.createClient(session, gh.fetch);
  return { gh, session, client, ctx: session.start(TOKEN) };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test("every request is a GET to the GitHub API with no cookies, cache or referrer", async () => {
  const { gh, client, ctx } = setup();
  const pinned = await client.pin(ctx, "acme/garden-plan", "");
  await client.readFile(ctx, "acme/garden-plan", pinned.data.commit, FILES.table);
  assert.ok(gh.calls.length >= 3);
  for (const { url, init } of gh.calls) {
    assert.ok(url.startsWith(API + "/"), url);
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, "Bearer " + TOKEN);
  }
});

test("paths outside the allowlist are refused before any network call", async () => {
  const { gh, client, ctx } = setup();
  const refused = ["/repos/acme/garden-plan/issues", "/repos/acme/garden-plan/contents/../x?ref=" + PLAN_COMMIT,
                   "/repos/acme/garden-plan/contents/plan/tasks.md?ref=main", "/repos/acme/garden-plan/git/refs",
                   "//evil.example/x", "/user/repos", "/repos/acme/garden-plan/contents/plan/tasks.md",
                   "/repos/acme/../garden-plan", "/repos/acme/garden-plan/commits/%2e%2e",
                   "/repos/acme/garden-plan/pulls", "/repos/acme/garden-plan/pulls?state=all&per_page=100&page=10",
                   "/repos/acme/garden-plan/pulls/3/merge", "/repos/acme/garden-plan/issues/0/comments?per_page=100&page=1",
                   "/repos/acme/garden-plan/issues/3/comments", "/repos/acme/garden-plan/pulls?state=merged&per_page=100&page=1"];
  for (const p of refused) await assert.rejects(client.get(ctx, p), SB.NotAllowed, p);
  assert.equal(gh.calls.length, 0);
});

test("the client offers no way to send anything but GET", () => {
  const { client } = setup();
  assert.deepEqual(Object.keys(client).sort(), ["blobSha", "get", "json", "pin", "readFile", "stateFor"]);
  assert.ok(Object.isFrozen(client));
});

test("the token is not readable from the session object", () => {
  const session = SB.createSession();
  session.start(TOKEN);
  assert.ok(!JSON.stringify(session).includes(TOKEN));
  assert.ok(!Object.values(session).some(v => v === TOKEN));
  assert.ok(Object.isFrozen(session));
});

test("a ref is pinned to one commit, the default branch when none is named", async () => {
  const { client, ctx } = setup();
  const pinned = await client.pin(ctx, "acme/garden-plan", "");
  assert.equal(pinned.state, "current");
  assert.equal(pinned.data.commit, PLAN_COMMIT);
  assert.equal(pinned.data.ref, "main");
  assert.equal(pinned.source.commit, PLAN_COMMIT);
  const named = await client.pin(ctx, "acme/recipes", "release");
  assert.equal(named.data.commit, sha("recipes-release"));
  assert.equal((await client.pin(ctx, "acme/recipes", "nope")).state, "missing");
  assert.equal((await client.pin(ctx, "acme/unknown", "")).state, "missing");
  assert.equal((await client.pin(ctx, "not a repo", "")).state, "invalid");
});

test("error taxonomy: 404 missing, 403 denied, rate limits, other failures", async () => {
  const cases = [
    [json({}, 404), "missing"], [json({}, 403), "denied"],
    [json({}, 403, { "x-ratelimit-remaining": "0" }), "rate-limited"], [json({}, 403, { "retry-after": "60" }), "rate-limited"],
    [json({}, 429), "rate-limited"], [json({}, 500), "failed"], [json({}, 502), "failed"],
  ];
  for (const [res, state] of cases) {
    const { client, ctx } = setup(planRepos(), [[/^\/repos\/acme\/garden-plan$/, () => res.clone()]]);
    const r = await client.pin(ctx, "acme/garden-plan", "");
    assert.equal(r.state, state, String(res.status));
    assert.equal(r.data, undefined);
  }
});

test("a file is current only when its bytes match GitHub's blob hash", async () => {
  const ok = setup();
  const file = await ok.client.readFile(ok.ctx, "acme/garden-plan", PLAN_COMMIT, FILES.table);
  assert.equal(file.state, "current");
  assert.equal(new TextDecoder().decode(file.data.bytes), TABLE);
  const tampered = setup(planRepos(), [[/contents/, () => json({ type: "file", encoding: "base64", sha: sha("other"),
                                                                    content: Buffer.from("x").toString("base64") })]]);
  assert.equal((await tampered.client.readFile(tampered.ctx, "acme/garden-plan", PLAN_COMMIT, FILES.table)).state, "invalid");
  const big = setup(planRepos(), [[/contents/, () => json({ type: "file", encoding: "none", sha: sha("big"), content: "" })]]);
  assert.equal((await big.client.readFile(big.ctx, "acme/garden-plan", PLAN_COMMIT, FILES.table)).state, "unavailable");
  const dir = setup(planRepos(), [[/contents/, () => json([{ name: "a" }])]]);
  assert.equal((await dir.client.readFile(dir.ctx, "acme/garden-plan", PLAN_COMMIT, "plan")).state, "invalid");
  assert.equal((await ok.client.readFile(ok.ctx, "acme/garden-plan", "main", FILES.table)).state, "invalid");
});

test("401 ends the session and nothing more is read", async () => {
  const { gh, session, client, ctx } = setup(planRepos(), [[/^\/repos\/acme\/garden-plan$/, () => json({}, 401)]]);
  await assert.rejects(client.pin(ctx, "acme/garden-plan", ""), SB.Revoked);
  assert.equal(session.signedIn, false);
  const before = gh.calls.length;
  await assert.rejects(client.get(ctx, "/user"), SB.Stale);
  assert.equal(gh.calls.length, before);
});

test("a reply that arrives after Forget is dropped", async () => {
  const gate = deferred();
  const { session, client, ctx } = setup(planRepos(), [[/^\/user$/, () => gate.promise]]);
  const pending = client.get(ctx, "/user");
  session.forget();
  gate.resolve(json({ login: "late" }));
  await assert.rejects(pending, SB.Stale);
  assert.equal(session.signedIn, false);
});

test("a body still being read when Forget is pressed is dropped", async () => {
  const gate = deferred();
  const slowBody = { ok: true, status: 200, headers: new Headers(), text: () => gate.promise };
  const { session, client, ctx } = setup(planRepos(), [[/^\/user$/, () => slowBody]]);
  const res = await client.get(ctx, "/user");
  const body = client.json(ctx, res);
  session.forget();
  gate.resolve('{"login": "late"}');
  await assert.rejects(body, SB.Stale);
});

test("a new run aborts the old one and the old run's late replies are dropped", async () => {
  const gate = deferred();
  let first = true;
  const { session, client, ctx } = setup(planRepos(), [[/^\/user$/, (p, init) => {
    if (!first) return json({ login: "new" });
    first = false;
    assert.equal(init.signal.aborted, false);
    return gate.promise.then(() => { assert.equal(init.signal.aborted, true); return json({ login: "old" }); });
  }]]);
  const old = client.get(ctx, "/user");
  const ctx2 = session.start();
  gate.resolve();
  await assert.rejects(old, SB.Stale);
  const fresh = await client.get(ctx2, "/user");
  assert.equal(fresh.status, 200);
  assert.throws(() => session.alive(ctx), SB.Stale);
});

test("hashing finishes after Forget: the result is dropped", async () => {
  const { session, client, ctx } = setup();
  const pending = client.blobSha(ctx, new Uint8Array([1, 2, 3]));
  session.forget();
  await assert.rejects(pending, SB.Stale);
});

test("repository names and refs are parsed strictly", () => {
  assert.deepEqual(SB.parseRepoRef("acme/garden-plan"), { repo: "acme/garden-plan", ref: "" });
  assert.deepEqual(SB.parseRepoRef("acme/garden-plan@feature/x"), { repo: "acme/garden-plan", ref: "feature/x" });
  for (const bad of ["acme", "acme/a/b", "../x", "acme/..", "acme/x@", "acme/x@a b", "https:x/y", " acme/x"]) {
    assert.equal(SB.parseRepoRef(bad), null, bad);
  }
});

test("result envelope carries data only for states that have it", () => {
  for (const state of SB.STATES) {
    const r = SB.result(state, { x: 1 }, { repo: "acme/x" });
    assert.deepEqual(Object.keys(r).sort(), ["data", "error", "schema", "source", "state"]);
    assert.equal(r.data !== undefined, ["current", "empty", "no-match", "partial"].includes(state), state);
  }
  assert.throws(() => SB.result("ok"), /unknown state/);
});

test("a network failure of the live run is a failed result, not a thrown error", async () => {
  const offline = async () => { throw new TypeError("synthetic offline"); };
  const session = SB.createSession();
  const client = SB.createClient(session, offline);
  const ctx = session.start(TOKEN);
  const pinned = await client.pin(ctx, "acme/garden-plan", "");
  assert.equal(pinned.state, "failed");
  assert.equal(pinned.error, "network error");
  assert.deepEqual(pinned.source, { repo: "acme/garden-plan", ref: null });
  const file = await client.readFile(ctx, "acme/garden-plan", PLAN_COMMIT, FILES.table);
  assert.equal(file.state, "failed");
  assert.equal(session.signedIn, true);
});

test("a body that cannot be read is a failed result; a body that is not JSON is invalid", async () => {
  const broken = { ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError("cut off"); } };
  const cut = setup(planRepos(), [[/contents/, () => broken]]);
  assert.equal((await cut.client.readFile(cut.ctx, "acme/garden-plan", PLAN_COMMIT, FILES.table)).state, "failed");
  const garbled = setup(planRepos(), [[/contents/, () => new Response("<html>", { status: 200 })]]);
  assert.equal((await garbled.client.readFile(garbled.ctx, "acme/garden-plan", PLAN_COMMIT, FILES.table)).state, "invalid");
});

test("a network failure that arrives after Forget or a new run stays silent", async () => {
  for (const end of ["forget", "new run"]) {
    const gate = deferred();
    const { session, client, ctx } = setup(planRepos(), [[/^\/repos\/acme\/garden-plan$/, () => gate.promise]]);
    const pending = client.pin(ctx, "acme/garden-plan", "");
    if (end === "forget") session.forget(); else session.start();
    gate.resolve(Promise.reject(new TypeError("late offline")));
    await assert.rejects(pending, SB.Stale, end);
  }
});

test("the token header cannot be read from the session object", () => {
  const session = SB.createSession();
  const ctx = session.start(TOKEN);
  assert.equal(session.authorization, undefined);
  for (const key of Object.getOwnPropertyNames(session)) {
    const value = Object.getOwnPropertyDescriptor(session, key).value;
    if (typeof value === "function" && value.length === 1) {
      assert.doesNotThrow(() => {
        const out = key === "alive" ? value(ctx) : undefined;
        assert.ok(!String(out).includes(TOKEN));
      });
    }
  }
  assert.throws(() => SB.createClient({ alive() {} }, async () => json({})), /not a session/);
});
