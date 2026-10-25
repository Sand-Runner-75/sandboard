"use strict";
// Workspace additions: web addresses, task file templates, stages and approved
// result files in stored progress, task rows, filters, links, tab keys and the
// synthetic demo server. All data is made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, sha, WEB } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();

function signedIn(repos, overrides) {
  const gh = mockGitHub(repos, overrides);
  const session = SB.createSession();
  const client = SB.createClient(session, gh.fetch);
  return { gh, session, client, ctx: session.start("synthetic-token") };
}

test("a repository's web address is taken from GitHub's reply only when it is a plain https address of that repository", () => {
  assert.equal(SB.webAddress("https://github.example.invalid/acme/garden", "acme/garden"), "https://github.example.invalid/acme/garden");
  assert.equal(SB.webAddress("https://github.example.invalid/ACME/Garden", "acme/garden"), "https://github.example.invalid/ACME/Garden");
  const withUser = new URL(WEB + "/acme/garden");
  withUser.username = "someone";
  withUser.password = "secret";
  for (const bad of ["http://github.example.invalid/acme/garden", withUser.href,
                     "https://github.example.invalid/acme/other", "https://github.example.invalid/acme/garden?x=1",
                     "https://github.example.invalid/acme/garden#top", "javascript:alert(1)", "", null, 7]) {
    assert.equal(SB.webAddress(bad, "acme/garden"), null, String(bad));
  }
});

test("pinning keeps the web address GitHub gave", async () => {
  const { client, ctx } = signedIn(F.planRepos());
  const pinned = await client.pin(ctx, "acme/garden-plan", "");
  assert.equal(pinned.data.web, WEB + "/acme/garden-plan");
});

test("task file templates are optional, need exactly one {id} and a plain path", () => {
  const withFiles = files => F.workspacesDoc({ workspaces: [{ id: "g", label: "G", kind: "project",
    plan: { repo: "acme/garden-plan", ref: null, files: Object.assign({}, F.FILES, files) }, code: [] }] });
  assert.equal(SB.validateWorkspaces(withFiles({})), null);
  assert.equal(SB.validateWorkspaces(withFiles({ brief: "notes/{id}-brief.md", handover: "notes/{id}.md", crossref: "plan/xref/{id}.md" })), null);
  for (const bad of [{ brief: "notes/brief.md" }, { brief: "notes/{id}-{id}.md" }, { handover: "../{id}.md" }, { crossref: "plan/xref.md" },
                     { handover: "/notes/{id}.md" }, { handover: "notes/{id} x.md" }, { other: "notes/{id}.md" }]) {
    assert.equal(SB.validateWorkspaces(withFiles(bad)), "workspace 1: bad plan files", JSON.stringify(bad));
  }
});

const stage = (over = {}) => Object.assign({ id: "S1", name: "Prepare", phases: ["P1"], gate: "Scope gate", estimated_h: 10,
  completed_h: 4, remaining_h: 6, progress_pct: 40, verified: false, tbe_rows: 0, proposed_rows: 0, provisional_rows: 0, rows: 3 }, over);

test("a stages block, when present, must name known phases once each, with whole figures", () => {
  assert.equal(SB.validateProgress(F.progressDoc(), F.FILES), null);
  assert.equal(SB.validateProgress(F.progressDoc({ stages: [stage(), stage({ id: "S2", name: "Build", phases: ["P2"], gate: null })] }), F.FILES), null);
  const bad = [
    [], [stage({ phases: ["P9"] })], [stage(), stage({ id: "S2", phases: ["P1"] })], [stage({ phases: [] })],
    [stage(), stage()], [stage({ rows: 1.5 })], [stage({ progress_pct: 101 })], [stage({ name: "" })], [stage({ gate: 3 })], "S1",
  ];
  for (const stages of bad) assert.equal(SB.validateProgress(F.progressDoc({ stages }), F.FILES), "a stage is malformed", JSON.stringify(stages));
});

test("approved result files, when present, must be plain paths under unique task IDs", () => {
  const ok = [{ id: "XQ101", approval: "PR #4", files: ["notes/a.md"], rejected: ["../../out.md"] }];
  assert.equal(SB.validateProgress(F.progressDoc({ approved_results: ok }), F.FILES), null);
  assert.equal(SB.validateProgress(F.progressDoc({ approved_results: [] }), F.FILES), null);
  const bad = [
    [ok[0], ok[0]], [Object.assign({}, ok[0], { files: ["../a.md"] })], [Object.assign({}, ok[0], { files: ["https://x.example/a.md"] })],
    [Object.assign({}, ok[0], { approval: "" })], [Object.assign({}, ok[0], { id: "../x" })], [Object.assign({}, ok[0], { rejected: [7] })],
    [Object.assign({}, ok[0], { files: "notes/a.md" })], {},
  ];
  for (const approved_results of bad) {
    assert.equal(SB.validateProgress(F.progressDoc({ approved_results }), F.FILES), "approved result files are malformed", JSON.stringify(approved_results));
  }
});

test("a malformed additive block makes the whole stored progress invalid, never current", async () => {
  const doc = F.progressDoc({ stages: [stage({ phases: ["P9"] })] });
  const { client, ctx } = signedIn(F.planRepos({ files: { [F.FILES.progress]: JSON.stringify(doc) } }));
  const r = await SB.readProgress(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, F.FILES);
  assert.equal(r.state, "invalid");
  assert.equal(r.data, undefined);
});

test("a task's brief or handover is read from its template at the pinned commit", async () => {
  const { client, ctx, gh } = signedIn(F.planRepos({ files: { "notes/XQ101-brief.md": "# Brief\n<script>x()</script>\n", "notes/XQ102-brief.md": "  \n",
                                                             "notes/XQ103-brief.md": undefined } }));
  const read = id => SB.readTaskFile(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, "notes/{id}-brief.md", id);
  const ok = await read("XQ101");
  assert.equal(ok.state, "current");
  assert.equal(ok.data.text, "# Brief\n<script>x()</script>\n");
  assert.equal(ok.source.path, "notes/XQ101-brief.md");
  assert.equal(ok.source.commit, F.PLAN_COMMIT);
  assert.equal((await read("XQ102")).state, "empty");
  assert.equal((await read("XQ103")).state, "missing");
  const before = gh.calls.length;
  for (const id of ["../XQ101", "", "a/b", ".."]) assert.equal((await read(id)).state, "invalid", id);
  assert.equal((await SB.readTaskFile(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, "notes/brief.md", "XQ101")).state, "invalid");
  assert.equal(gh.calls.length, before, "no request for an invalid task file");
});

test("a task file that is not UTF-8 is invalid, and a network failure is a failed result", async () => {
  const { client, ctx } = signedIn(F.planRepos(), [[/contents[/]notes/, () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    const blob = require("node:crypto").createHash("sha1").update("blob 3\0").update(bytes).digest("hex");
    return new Response(JSON.stringify({ type: "file", encoding: "base64", sha: blob, content: bytes.toString("base64") }), { status: 200 });
  }]]);
  assert.equal((await SB.readTaskFile(ctx, client, "acme/garden-plan", F.PLAN_COMMIT, "notes/{id}.md", "XQ101")).state, "invalid");
  const off = signedIn(F.planRepos(), [[/contents[/]notes/, () => { throw new TypeError("offline"); }]]);
  const failed = await SB.readTaskFile(off.ctx, off.client, "acme/garden-plan", F.PLAN_COMMIT, "notes/{id}.md", "XQ101");
  assert.equal(failed.state, "failed");
});

const row = (id, fields, extra = {}) => Object.assign({ id, section: "P2. Build", line: 9, text: "| " + id + " |", fields: Object.assign({ ID: id }, fields), invalid: null }, extra);

test("task rows keep their source text, hierarchy and blanks", () => {
  const [a, b, c, d] = SB.tasksFrom([
    row("XQ201", { "Job": "J2 App", "Task": "T3 Page", "Sub-task": "Build the page", "Status": "Blocked", "Est. h": "TBE",
                   "Prerequisites": "XQ101, XQ999", "Doer": "Agent A", "Model": "", "Notes": "see <b>x</b>" }),
    row("XQ201.1", { "Task": "Draft it", "Status": "Half done", "Prerequisites": "—" }),
    row("XQ300", {}, { section: "Lean notes" }),
    row("XQ301", { "Task": "x" }, { invalid: "has 2 cells, expected 4" }),
  ]);
  assert.deepEqual([a.title, a.job, a.group, a.status, a.est, a.prereqs, a.doer, a.model, a.notes],
                   ["Build the page", "J2 App", "T3 Page", "Blocked", "TBE", ["XQ101", "XQ999"], "Agent A", "", "see <b>x</b>"]);
  assert.deepEqual(a.phase, { id: "P2", name: "Build" });
  assert.equal(a.reviewer, undefined, "a missing column stays missing");
  assert.equal(a.knownStatus, true);
  assert.deepEqual([b.title, b.group, b.parent, b.knownStatus, b.prereqs], ["Draft it", undefined, "XQ201", false, []]);
  assert.equal(c.phase, null);
  assert.equal(c.prereqs, undefined);
  assert.equal(d.invalid, "has 2 cells, expected 4");
});

test("estimates keep their meaning: never zero, never a guess", () => {
  assert.deepEqual(["TBE", "", "—", "step", "2", "1.5", "about 3", undefined].map(SB.estimateText),
    ["To be estimated", "Estimate missing", "No hours", "Step: no hours of its own", "2 h", "1.5 h", "Not a number: about 3", "Not given in the table"]);
});

test("filters only choose rows; invalid rows show unless a non-phase filter is set", () => {
  const tasks = SB.tasksFrom([
    row("XQ101", { "Task": "Sketch", "Status": "Done", "Doer": "Agent A" }, { section: "P1 Start" }),
    row("XQ201", { "Task": "Build the page", "Status": "Blocked", "Doer": "Agent B" }),
    row("XQ202", { "Task": "x" }, { invalid: "no ID" }),
  ]);
  const ids = f => SB.filterTasks(tasks, Object.assign({ q: "", phase: "", status: "", doer: "" }, f)).map(t => t.id);
  assert.deepEqual(ids({}), ["XQ101", "XQ201", "XQ202"]);
  assert.deepEqual(ids({ phase: "P2" }), ["XQ201", "XQ202"]);
  assert.deepEqual(ids({ q: "page" }), ["XQ201"]);
  assert.deepEqual(ids({ q: "xq101" }), ["XQ101"]);
  assert.deepEqual(ids({ status: "Done" }), ["XQ101"]);
  assert.deepEqual(ids({ doer: "Agent B", q: "nothing" }), []);
  const opts = SB.filterOptions(tasks);
  assert.deepEqual(opts.phases.map(p => p.id), ["P1", "P2"]);
  assert.deepEqual(opts.statuses, ["Done", "Blocked"]);
  assert.deepEqual(opts.doers, ["Agent A", "Agent B"]);
  assert.deepEqual(SB.waiting(tasks).map(t => t.id), ["XQ201"]);
  const needs = SB.prerequisites({ prereqs: ["XQ101", "XQ999"] }, tasks);
  assert.deepEqual(needs.map(n => [n.id, n.task && n.task.status]), [["XQ101", "Done"], ["XQ999", null]]);
  // A stage keeps only its own phases' rows (invalid rows included, as with a phase).
  assert.deepEqual(ids({ stagePhases: ["P2"] }), ["XQ201", "XQ202"]);
  assert.deepEqual(ids({ stagePhases: ["P1"], status: "Done" }), ["XQ101"]);
});

test("related tasks: who waits on a task, and its steps, from the table only", () => {
  const tasks = SB.tasksFrom([
    row("XQ101", { "Task": "Sketch", "Status": "Done", "Prerequisites": "—" }),
    row("XQ102", { "Task": "Colours", "Status": "Not Started", "Prerequisites": "XQ101" }),
    row("XQ102.1", { "Task": "Pick", "Status": "Not Started", "Prerequisites": "XQ101, XQ102" }),
    row("XQ103", { "Task": "x" }, { invalid: "has 1 cell" }),
  ]);
  assert.deepEqual(SB.dependents(tasks[0], tasks).map(t => t.id), ["XQ102", "XQ102.1"]);
  assert.deepEqual(SB.steps(tasks[1], tasks).map(t => t.id), ["XQ102.1"]);
  assert.deepEqual(SB.dependents(tasks[2], tasks), []);
  assert.deepEqual(Object.keys(tasks[1].fields), ["ID", "Task", "Status", "Prerequisites"], "every column is kept, in order");
});

test("owner approval comes only from the producer's list; result links only for plain paths at a full commit", () => {
  assert.equal(SB.approvals(F.progressDoc()), null);
  assert.equal(SB.approvals(null), null);
  const map = SB.approvals(F.progressDoc({ approved_results: [{ id: "XQ101", approval: "PR #4", files: ["a.md"], rejected: [] }] }));
  assert.equal(map.get("XQ101").approval, "PR #4");
  assert.equal(map.get("XQ102"), undefined);
  const c = sha("c");
  assert.equal(SB.resultHref(WEB + "/acme/plan", c, "plan/notes/a.md"), WEB + "/acme/plan/blob/" + c + "/plan/notes/a.md");
  assert.equal(SB.resultHref(null, c, "a.md"), null);
  assert.equal(SB.resultHref(WEB + "/acme/plan", "main", "a.md"), null);
  for (const bad of ["../a.md", "/a.md", "a/../b.md", "https://x.example/a.md", "a.md?x", "a.md#y", ""]) {
    assert.equal(SB.resultHref(WEB + "/acme/plan", c, bad), null, bad);
  }
});

test("tab keys tell apart the same ID in two projects or at two commits", () => {
  const keys = new Set([SB.tabKey("a", "o/p", sha(1), "task", "XQ101"), SB.tabKey("b", "o/p", sha(1), "task", "XQ101"),
                        SB.tabKey("a", "o/p", sha(2), "task", "XQ101"), SB.tabKey("a", "o/q", sha(1), "task", "XQ101")]);
  assert.equal(keys.size, 4);
});

const DEMO = {
  sign_in: "demo-org/plan",
  repos: {
    "demo-org/plan": { private: true, default_branch: "main", commit: sha("demo"), date: "2026-01-01T00:00:00Z",
                       files: { "sandboard.workspaces.json": JSON.stringify(F.workspacesDoc({ workspaces: [
                         { id: "d", label: "Demo", kind: "kit", plan: { repo: "demo-org/plan", ref: null, files: F.FILES },
                           code: [{ repo: "demo-org/app", ref: null, role: "app" }] }] })),
                                [F.FILES.table]: F.TABLE, [F.FILES.record]: F.RECORD, [F.FILES.producer]: F.PRODUCER,
                                [F.FILES.progress]: JSON.stringify(F.progressDoc()) } },
    "demo-org/app": { private: false, commit: sha("app"), files: {}, checks: { status: 403 } },
    "demo-org/locked": { status: 403 },
  },
};

test("the demo answers through the real client and readers, with no network and no web address", async () => {
  const session = SB.createSession();
  const client = SB.createClient(session, SB.demoServer(DEMO));
  const ctx = session.start("synthetic-demo");
  const list = await SB.readWorkspaces(ctx, client, "demo-org/plan", "");
  assert.equal(list.state, "current");
  const entries = await SB.readWorkspace(ctx, client, list.data.workspaces[0]);
  assert.deepEqual(entries.map(e => [e.kind, e.result.state]),
    [["plan", "current"], ["table", "current"], ["progress", "current"], ["code", "current"], ["checks", "unavailable"]]);
  assert.equal(entries[0].result.data.web, null);
  assert.equal((await client.pin(ctx, "demo-org/locked", "")).state, "denied");
  assert.equal((await client.pin(ctx, "demo-org/none", "")).state, "missing");
  assert.equal((await client.pin(ctx, "demo-org/plan", "other")).state, "missing");
  await assert.rejects(SB.demoServer(DEMO)("https://elsewhere.example/repos/demo-org/plan"), TypeError);
  session.forget();
  await assert.rejects(SB.readWorkspaces(ctx, client, "demo-org/plan", ""), SB.Stale);
});
