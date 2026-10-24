"use strict";
// Workspace list, plan table, stored progress and check-run readers.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, json, blobSha, sha } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();

function setup(repos = F.planRepos(), overrides) {
  const gh = mockGitHub(repos, overrides);
  const session = SB.createSession();
  return { gh, session, client: SB.createClient(session, gh.fetch), ctx: session.start("synthetic-token") };
}

async function progress(options) {
  const { client, ctx } = setup(F.planRepos(options));
  return SB.readProgress(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, F.FILES);
}

test("the workspace list is read from the plan repository at a pinned commit", async () => {
  const { client, ctx } = setup();
  const r = await SB.readWorkspaces(ctx, client, "acme/garden-plan", "");
  assert.equal(r.state, "current");
  assert.equal(r.schema, "sandboard.workspaces/1");
  assert.equal(r.data.commit, F.PLAN_COMMIT);
  assert.deepEqual(r.data.workspaces.map(w => w.id), ["garden", "recipes"]);
  assert.deepEqual(r.source, { repo: "acme/garden-plan", commit: F.PLAN_COMMIT, path: SB.WORKSPACES_FILE, ref: "main" });
});

test("a missing, unreadable or invalid workspace list shows no workspaces", async () => {
  const missing = setup(F.planRepos({ files: { "sandboard.workspaces.json": undefined } }));
  assert.equal((await SB.readWorkspaces(missing.ctx, missing.client, "acme/garden-plan", "")).state, "missing");
  const garbled = setup(F.planRepos({ files: { "sandboard.workspaces.json": "{not json" } }));
  assert.equal((await SB.readWorkspaces(garbled.ctx, garbled.client, "acme/garden-plan", "")).state, "invalid");
  const empty = setup(F.planRepos({ workspaces: F.workspacesDoc({ workspaces: [] }) }));
  assert.equal((await SB.readWorkspaces(empty.ctx, empty.client, "acme/garden-plan", "")).state, "empty");
});

test("workspace entries are validated field by field", () => {
  const base = () => F.workspacesDoc();
  const broken = {
    "wrong schema": d => { d.schema = "sandboard.workspaces/2"; },
    "bad id": d => { d.workspaces[0].id = "Garden Plan"; },
    "repeated id": d => { d.workspaces[1].id = "garden"; },
    "empty label": d => { d.workspaces[0].label = " "; },
    "bad kind": d => { d.workspaces[0].kind = "other"; },
    "bad plan repo": d => { d.workspaces[0].plan.repo = "../x"; },
    "missing plan file": d => { delete d.workspaces[0].plan.files.record; },
    "extra plan file": d => { d.workspaces[0].plan.files.extra = "x.md"; },
    "plan file outside": d => { d.workspaces[0].plan.files.table = "../tasks.md"; },
    "absolute plan file": d => { d.workspaces[0].plan.files.table = "/etc/x"; },
    "bad code repo": d => { d.workspaces[0].code[0].repo = "acme"; },
    "bad ref": d => { d.workspaces[0].code[0].ref = "a b"; },
    "no role": d => { delete d.workspaces[0].code[0].role; },
    "no repository": d => { d.workspaces[1].code = []; },
  };
  assert.equal(SB.validateWorkspaces(base()), null);
  for (const [label, change] of Object.entries(broken)) {
    const d = base();
    change(d);
    assert.notEqual(SB.validateWorkspaces(d), null, label);
  }
});

test("plan rows are read in order, as text, with their section and no totals", async () => {
  const { client, ctx } = setup();
  const r = await SB.readPlan(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, F.FILES);
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.rows.map(x => [x.id, x.section]), [["XQ101", "P1 Start"], ["XQ102", "P1 Start"], ["XQ201", "P2 Build"]]);
  assert.equal(r.data.rows[1].fields.Task, "Pick colours | fonts");
  assert.equal(r.data.rows[2].fields["Est. h"], "5");
  assert.equal(typeof r.data.rows[2].fields["Est. h"], "string");
  assert.deepEqual(Object.keys(r.data).sort(), ["invalid", "rows"]);
  assert.equal(r.data.invalid, 0);
});

test("malformed plan rows are kept and marked invalid", () => {
  const rows = SB.parsePlanTables([
    "| ID | Task | Status |", "|---|---|---|",
    "| XQ1 | Fine | Done |", "| XQ2 | Too few |", "| | No ID | Done |", "| XQ1 | Again | Done |",
    "| XQ3 | Too | many | cells |",
    "", "| Name | Other |", "|---|---|", "| not | a plan table |",
  ].join("\n"));
  assert.deepEqual(rows.map(r => [r.id, r.invalid && r.invalid.split(" ")[0]]),
                   [["XQ1", null], ["XQ2", "has"], ["", "no"], ["XQ1", "repeated"], ["XQ3", "has"]]);
  assert.deepEqual(SB.parsePlanTables("no tables here"), []);
});

test("stored progress is current when producer, table and record all match", async () => {
  const r = await progress();
  assert.equal(r.state, "current");
  assert.equal(r.schema, "sandboard.progress/1");
  assert.equal(r.data.scopes["Whole project"].progress_pct, 20);
  assert.deepEqual(r.source, { repo: "acme/garden-plan", commit: F.PLAN_COMMIT, path: F.FILES.progress });
});

test("stored progress is stale when the producer or an input changed or cannot be read", async () => {
  for (const [file, label] of [[F.FILES.producer, "producer"], [F.FILES.table, "table"], [F.FILES.record, "record"]]) {
    const changed = await progress({ files: { [file]: "changed\n" } });
    assert.equal(changed.state, "stale", label);
    assert.match(changed.error, new RegExp(label));
    assert.equal(changed.data, undefined);
    const gone = await progress({ files: { [file]: undefined } });
    assert.equal(gone.state, "stale", label + " missing");
  }
});

test("stored progress that is absent is unavailable, never zero", async () => {
  const r = await progress({ files: { [F.FILES.progress]: undefined } });
  assert.equal(r.state, "unavailable");
  assert.equal(r.data, undefined);
});

test("every field of the progress contract is enforced", async () => {
  const doc = over => JSON.stringify(F.progressDoc(over));
  const variants = {
    "not JSON": "{",
    "wrong schema": doc({ schema: "sandboard.progress/2" }),
    "ok false": doc({ ok: false, errors: ["x"] }),
    "ok missing": doc({ ok: undefined }),
    "negative subtasks": doc({ subtasks: -1 }),
    "producer path": doc({ producer: { path: "other.py", blob_sha: blobSha(F.PRODUCER) } }),
    "producer replaced by the table": doc({ producer: { path: F.FILES.table, blob_sha: blobSha(F.TABLE) } }),
    "short sha": doc({ producer: { path: F.FILES.producer, blob_sha: "abc" } }),
    "extra input": doc({ inputs: Object.assign({ extra: { path: "x", blob_sha: sha(1) } }, F.progressDoc().inputs) }),
    "table path": doc({ inputs: { table: { path: "x.md", blob_sha: blobSha(F.TABLE) }, record: F.progressDoc().inputs.record } }),
    "missing scope": doc({ scopes: { Pilot: F.progressDoc().scopes.Pilot } }),
    "over 100%": doc({ scopes: Object.assign({}, F.progressDoc().scopes, { MVP: Object.assign({}, F.progressDoc().scopes.MVP, { progress_pct: 101 }) }) }),
    "no phases": doc({ phases: [] }),
    "bad phase id": doc({ phases: [Object.assign({}, F.progressDoc().phases[0], { id: "Phase 1" })] }),
    "bad status count": doc({ phases: [Object.assign({}, F.progressDoc().phases[0], { status_counts: { Done: 1.5 } })] }),
    "string figure": doc({ phases: [Object.assign({}, F.progressDoc().phases[0], { rows: "3" })] }),
  };
  for (const [label, text] of Object.entries(variants)) {
    const r = await progress({ files: { [F.FILES.progress]: text } });
    assert.equal(r.state, "invalid", label);
    assert.equal(r.data, undefined, label);
  }
});

test("progress read failures keep their own state", async () => {
  for (const [res, state] of [[json({}, 403), "denied"], [json({}, 429), "rate-limited"], [json({}, 500), "failed"]]) {
    const { client, ctx } = setup(F.planRepos(), [[/progress[.]json/, () => res.clone()]]);
    assert.equal((await SB.readProgress(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, F.FILES)).state, state);
  }
});

test("check runs: current, empty, partial, and unavailable when the token lacks Checks: read", async () => {
  const read = async checks => {
    const { client, ctx } = setup(F.planRepos({ checks }));
    return SB.readCheckRuns(ctx, client, "acme/garden", F.CODE_COMMIT);
  };
  const ok = await read([{ name: "checks", status: "completed", conclusion: "failure" }]);
  assert.equal(ok.state, "current");
  assert.deepEqual(ok.data.runs, [{ name: "checks", status: "completed", conclusion: "failure" }]);
  const { client, ctx } = setup(F.planRepos());
  assert.equal((await SB.readCheckRuns(ctx, client, "acme/garden-plan", F.PLAN_COMMIT)).state, "empty");
  const many = Array.from({ length: 250 }, (_, i) => ({ name: "c" + i, status: "queued", conclusion: null }));
  assert.equal((await read(many)).state, "current");
  many.total = 900;
  const partial = await read(many);
  assert.equal(partial.state, "partial");
  assert.deepEqual(partial.coverage, { shown: 250, total: 900 });
  assert.equal((await read({ status: 403 })).state, "unavailable");
  assert.equal((await read({ status: 404 })).state, "unavailable");
  assert.equal((await read({ status: 403, headers: { "x-ratelimit-remaining": "0" } })).state, "rate-limited");
  assert.equal((await read({ status: 500 })).state, "failed");
  assert.equal((await read([{ name: 1, status: "completed", conclusion: null }])).state, "invalid");
});

test("a whole private read touches only allowlisted GET paths", async () => {
  const { gh, client, ctx } = setup();
  const ws = await SB.readWorkspaces(ctx, client, "acme/garden-plan", "");
  for (const w of ws.data.workspaces) {
    if (w.plan) {
      const pinned = await client.pin(ctx, w.plan.repo, w.plan.ref);
      await SB.readPlan(ctx, client, w.plan.repo, pinned.data.commit, w.plan.files);
      await SB.readProgress(ctx, client, w.plan.repo, pinned.data.commit, w.plan.files);
    }
    for (const c of w.code) {
      const pinned = await client.pin(ctx, c.repo, c.ref);
      await SB.readCheckRuns(ctx, client, c.repo, pinned.data.commit);
    }
  }
  assert.ok(gh.calls.length > 10);
  for (const { url, init } of gh.calls) {
    assert.equal(init.method, "GET");
    assert.ok(SB.allowed(url.slice(SB.API.length)), url);
  }
});

test("every reader returns a failed result when the network fails", async () => {
  const session = SB.createSession();
  const client = SB.createClient(session, async () => { throw new TypeError("synthetic offline"); });
  const ctx = session.start("synthetic-token");
  const results = {
    workspaces: await SB.readWorkspaces(ctx, client, "acme/garden-plan", ""),
    plan: await SB.readPlan(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, F.FILES),
    progress: await SB.readProgress(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, F.FILES),
    checks: await SB.readCheckRuns(ctx, client, "acme/garden", F.CODE_COMMIT),
  };
  for (const [name, r] of Object.entries(results)) {
    assert.equal(r.state, "failed", name);
    assert.equal(r.data, undefined, name);
    assert.ok(r.source && r.source.repo, name);
  }
});

test("progress is stale with a reason when the producer cannot be fetched", async () => {
  const { client, ctx } = setup(F.planRepos(), [[/contents\/tools\/progress[.]py/, () => { throw new TypeError("offline"); }]]);
  const r = await SB.readProgress(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, F.FILES);
  assert.equal(r.state, "stale");
  assert.match(r.error, /producer .* unreadable .*failed/);
});

test("one workspace failing does not stop the others", async () => {
  const { client, ctx } = setup(F.planRepos(), [[/acme\/garden-plan/, () => { throw new TypeError("offline"); }]]);
  const doc = F.workspacesDoc();
  const garden = await SB.readWorkspace(ctx, client, doc.workspaces[0]);
  assert.deepEqual(garden.map(e => [e.kind, e.result.state]), [["plan", "failed"], ["code", "current"], ["checks", "current"]]);
  const recipes = await SB.readWorkspace(ctx, client, doc.workspaces[1]);
  assert.deepEqual(recipes.map(e => [e.kind, e.result.state]), [["code", "current"], ["checks", "empty"]]);
});

test("a whole workspace read with every source readable", async () => {
  const { client, ctx } = setup();
  const entries = await SB.readWorkspace(ctx, client, F.workspacesDoc().workspaces[0]);
  assert.deepEqual(entries.map(e => [e.kind, e.result.state]),
                   [["plan", "current"], ["table", "current"], ["progress", "current"], ["code", "current"], ["checks", "current"]]);
});

test("a revoked token mid-workspace ends the session instead of showing a state", async () => {
  const { session, client, ctx } = setup(F.planRepos(), [[/acme\/garden$/, () => json({}, 401)]]);
  await assert.rejects(SB.readWorkspace(ctx, client, F.workspacesDoc().workspaces[0]), SB.Revoked);
  assert.equal(session.signedIn, false);
});

test("check-run counts must agree: missing runs are partial, never empty; contradictions are invalid", async () => {
  const reply = pages => setup(F.planRepos(), [[/check-runs/, p => {
    const page = Number(/&page=(\d+)/.exec(p)[1]);
    return json(pages[page - 1] || { total_count: 0, check_runs: [] });
  }]]);
  const run = i => ({ name: "c" + i, status: "completed", conclusion: "success" });
  const read = async pages => { const s = reply(pages); return SB.readCheckRuns(s.ctx, s.client, "acme/garden", F.CODE_COMMIT); };
  const zeroShown = await read([{ total_count: 2, check_runs: [] }]);
  assert.equal(zeroShown.state, "partial");
  assert.deepEqual(zeroShown.coverage, { shown: 0, total: 2 });
  const cutLater = await read([{ total_count: 250, check_runs: Array.from({ length: 100 }, (_, i) => run(i)) },
                               { total_count: 250, check_runs: [] }]);
  assert.equal(cutLater.state, "partial");
  assert.deepEqual(cutLater.coverage, { shown: 100, total: 250 });
  assert.equal((await read([{ total_count: -1, check_runs: [] }])).state, "invalid");
  assert.equal((await read([{ total_count: 1, check_runs: [run(1), run(2)] }])).state, "invalid");
  assert.equal((await read([{ total_count: 150, check_runs: Array.from({ length: 100 }, (_, i) => run(i)) },
                            { total_count: 120, check_runs: [run(101)] }])).state, "invalid");
  assert.equal((await read([{ total_count: 1.5, check_runs: [] }])).state, "invalid");
  assert.equal((await read([{ total_count: 0, check_runs: [] }])).state, "empty");
});

test("progress counts must be whole numbers, phase IDs unique and every status counted", async () => {
  const base = F.progressDoc();
  const phase0 = over => [Object.assign({}, base.phases[0], over), base.phases[1]];
  const variants = {
    "fractional rows in a scope": { scopes: Object.assign({}, base.scopes, { Pilot: Object.assign({}, base.scopes.Pilot, { rows: 1.5 }) }) },
    "fractional percentage": { scopes: Object.assign({}, base.scopes, { MVP: Object.assign({}, base.scopes.MVP, { progress_pct: 20.5 }) }) },
    "fractional phase count": { phases: phase0({ tbe_rows: 0.5 }) },
    "repeated phase ID": { phases: [base.phases[0], Object.assign({}, base.phases[1], { id: base.phases[0].id })] },
    "empty status counts": { phases: phase0({ status_counts: {} }) },
    "a status missing": { phases: phase0({ status_counts: Object.fromEntries(Object.entries(base.phases[0].status_counts).slice(1)) }) },
    "an extra status": { phases: phase0({ status_counts: Object.assign({ Parked: 0 }, base.phases[0].status_counts) }) },
  };
  for (const [label, over] of Object.entries(variants)) {
    const r = await progress({ files: { [F.FILES.progress]: JSON.stringify(F.progressDoc(over)) } });
    assert.equal(r.state, "invalid", label);
    assert.equal(r.data, undefined, label);
  }
});
