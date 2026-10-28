"use strict";
// Search over what a visit has already read: which sources are searched and where each result was
// read, task title and ID matching with the optional search inside tasks (off, on, off again), task
// files not read, scope, same IDs in two projects, cut trees, opened files, pull request lists and
// hostile text. The search is worked out from read results only. Synthetic data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, sha } = require("./helpers");

const SB = loadSB();
const docKey = (...parts) => parts.filter(x => x !== undefined).join("|");
const ok = data => SB.result("current", data, null);
const PLAN_A = sha("plan-a"), PLAN_B = sha("plan-b"), CODE = sha("code-a");
const FILES = { brief: "notes/{id}-brief.md", handover: "notes/{id}-handover.md" };

const task = (id, title, fields = {}) => ({ id, title, status: "Not Started", invalid: false, fields: Object.assign({ ID: id, Task: title, Status: "Not Started" }, fields) });

function world() {
  const a = { w: { id: "alpha", label: "Alpha Garden", kind: "project", plan: { repo: "acme/alpha-plan", ref: null, files: FILES },
                   code: [{ repo: "acme/alpha", ref: null, role: "code" }] },
              loading: false, plan: ok({ commit: PLAN_A, meta: { description: "Plans for the garden", topics: ["plans"] } }), table: ok({ rows: [] }),
              code: [{ c: { repo: "acme/alpha", ref: null, role: "code" }, pinned: ok({ commit: CODE, meta: { description: "Watering code", topics: ["pumps"] } }) }],
              tasks: [task("XQ1", "Plant the seeds", { Notes: "Use the blue trowel" }), task("XQ2", "Water the rows"), { id: "XQ3", invalid: true, fields: {}, title: "broken" }] };
  // The same task ID in another project's plan.
  const b = { w: { id: "beta", label: "Beta Orchard", kind: "project", plan: { repo: "acme/beta-plan", ref: null, files: FILES }, code: [] },
              loading: false, plan: ok({ commit: PLAN_B, meta: null }), table: ok({ rows: [] }), code: [],
              tasks: [task("XQ1", "Prune the trees")] };
  const live = new Map([
    [SB.codeKey.tree("acme/alpha", CODE), SB.result("partial", { truncated: true, entries: [
      { path: "src", kind: "dir" }, { path: "src/pump.js", kind: "file" }, { path: "src/seed-list.txt", kind: "file" }, { path: "vendor/lib", kind: "submodule" }] }, null)],
    [SB.codeKey.text("acme/alpha", CODE, "src/pump.js"), ok({ binary: false, text: "line one\nconst flow = 3;\n// the BLUE valve opens here\n" })],
    [SB.codeKey.text("acme/alpha", CODE, "src/logo.bin"), ok({ binary: true, text: null, size: 4, sha: sha("bin") })],
    [SB.feedKey("acme/alpha", CODE), ok({ commit: CODE, readAt: "2026-01-02T03:04:05.000Z",
      pulls: ok({ pulls: [{ number: 7, title: "Add the pump timer", state: "open", head: sha("pr7"), merged: null }] }) })],
    [SB.workKey.list("pulls", "acme/alpha", "closed", 1), SB.result("partial", { end: false, pulls: [
      { number: 7, title: "Add the pump timer", state: "open", head: sha("pr7"), merged: null },
      { number: 3, title: "Seed tray layout", state: "closed", head: sha("pr3"), merged: "2026-01-01T00:00:00Z" }] }, null)],
  ]);
  const docs = new Map([
    [docKey("alpha", "acme/alpha-plan", PLAN_A, "brief", FILES.brief, "XQ2"), ok({ text: "Water early.\nCheck the compost heap before noon.\n" })],
    [docKey("alpha", "acme/alpha-plan", PLAN_A, "handover", FILES.handover, "XQ2"), SB.result("missing", null, null)],
  ]);
  return { entries: [a, b], live, docs };
}

const find = (w, q, scope, inside) => SB.searchFind(SB.searchSources(w.entries, w.live, w.docs, docKey), q, scope, inside);
const ids = list => list.map(h => h.it.projects.map(p => p.id).join("+") + ":" + (h.it.id || h.it.repo + (h.it.path ? "|" + h.it.path : h.it.number ? "#" + h.it.number : "")));

test("tasks match by ID and title only, unless search inside tasks is on; turning it off removes content-only matches", () => {
  const w = world();
  assert.deepEqual(ids(find(w, "seeds", "alpha", false).tasks), ["alpha:XQ1"]);
  assert.deepEqual(ids(find(w, "xq2", "alpha", false).tasks), ["alpha:XQ2"]);
  // "compost" is only in XQ2's brief; "trowel" only in XQ1's Notes column.
  assert.deepEqual(find(w, "compost", "alpha", false).tasks, []);
  const on = find(w, "compost", "alpha", true).tasks;
  assert.equal(on.length, 1);
  assert.equal(on[0].it.id, "XQ2");
  assert.equal(on[0].where, "content");
  assert.equal(on[0].in, "brief");
  assert.equal(on[0].excerpt.line, 2);
  assert.match(on[0].excerpt.text, /compost heap/);
  const col = find(w, "trowel", "alpha", true).tasks;
  assert.deepEqual([col[0].it.id, col[0].in], ["XQ1", "Notes"]);
  assert.deepEqual(find(w, "compost", "alpha", false).tasks, []);
  // A title match stays a title match, with no excerpt, when the option is on.
  const t = find(w, "plant", "alpha", true).tasks[0];
  assert.deepEqual([t.where, t.excerpt], ["title", undefined]);
  // Every word must appear: one in the title and one in the brief.
  assert.deepEqual(ids(find(w, "water compost", "alpha", true).tasks), ["alpha:XQ2"]);
  assert.deepEqual(find(w, "water zebra", "alpha", true).tasks, []);
});

test("task files not read are not searched, and coverage says how each task file's read ended", () => {
  const w = world();
  w.docs.clear();
  assert.deepEqual(find(w, "compost", "alpha", true).tasks, []);
  const src = SB.searchSources(w.entries, w.live, w.docs, docKey);
  const c = SB.searchCoverage(src, "alpha", true);
  assert.equal(c.tasks, 2);
  assert.deepEqual(c.taskFiles, { named: 2, searched: 0, complete: 0, unread: 2, notRead: {} });
  // A missing file was read (there is none); a file still loading was not.
  const w2 = world();
  w2.docs.set(docKey("alpha", "acme/alpha-plan", PLAN_A, "brief", FILES.brief, "XQ1"), { state: "loading" });
  const c2 = SB.searchCoverage(SB.searchSources(w2.entries, w2.live, w2.docs, docKey), "alpha", true);
  assert.deepEqual(c2.taskFiles, { named: 2, searched: 1, complete: 1, unread: 1, notRead: {} });
  assert.equal(SB.searchCoverage(src, "alpha", false).taskFiles, null);
});

test("a task file that could not be read is named by how its read ended and is never counted as searched", () => {
  // One file read and one refused: the task is searched by the file read only, and the refusal is named.
  const w = world();
  w.docs.set(docKey("alpha", "acme/alpha-plan", PLAN_A, "handover", FILES.handover, "XQ2"), SB.result("denied", null, null, { error: "no access" }));
  assert.deepEqual(ids(find(w, "compost", "alpha", true).tasks), ["alpha:XQ2"]);
  const c = SB.searchCoverage(SB.searchSources(w.entries, w.live, w.docs, docKey), "alpha", true);
  assert.deepEqual(c.taskFiles, { named: 2, searched: 1, complete: 0, unread: 1, notRead: { denied: 1 } });
  // Every file refused or failed: nothing is searched in them and nothing counts as read.
  const w2 = world();
  w2.docs.clear();
  for (const id of ["XQ1", "XQ2"]) {
    w2.docs.set(docKey("alpha", "acme/alpha-plan", PLAN_A, "brief", FILES.brief, id), SB.result("denied", null, null, { error: "no access" }));
    w2.docs.set(docKey("alpha", "acme/alpha-plan", PLAN_A, "handover", FILES.handover, id), SB.result("failed", null, null, { error: "network" }));
  }
  assert.deepEqual(find(w2, "compost", "alpha", true).tasks, []);
  const c2 = SB.searchCoverage(SB.searchSources(w2.entries, w2.live, w2.docs, docKey), "alpha", true);
  assert.deepEqual(c2.taskFiles, { named: 2, searched: 0, complete: 0, unread: 0, notRead: { denied: 2, failed: 2 } });
});

test("the same repository pinned at two commits gives one result per pin, each with its own description", () => {
  const w = world();
  const NEW = sha("code-b");
  w.entries[1].w.code = [{ repo: "acme/alpha", ref: null, role: "code" }];
  w.entries[1].code = [{ c: w.entries[1].w.code[0], pinned: ok({ commit: NEW, meta: { description: "Newer drip code", topics: [] } }) }];
  const beta = find(w, "acme/alpha", "beta", false).repos;
  assert.deepEqual(beta.map(h => [h.it.commit, h.it.description, h.it.projects.map(p => p.id).join("+")]), [[NEW, "Newer drip code", "beta"]]);
  assert.deepEqual(find(w, "drip", "beta", false).repos.map(h => h.it.commit), [NEW]);
  assert.deepEqual(find(w, "drip", "alpha", false).repos, []);
  assert.deepEqual(find(w, "watering", "alpha", false).repos.map(h => h.it.commit), [CODE]);
  assert.deepEqual(find(w, "acme/alpha", null, false).repos.filter(h => h.it.repo === "acme/alpha").map(h => h.it.commit).sort(), [CODE, NEW].sort());
});

test("a pull request listed at two heads keeps each head as read", () => {
  const w = world();
  w.live.set(SB.workKey.list("pulls", "acme/alpha", "open", 1), ok({ end: true, pulls: [{ number: 7, title: "Add the pump timer", state: "open", head: sha("pr7-new"), merged: null }] }));
  assert.deepEqual(find(w, "#7", "alpha", false).pulls.map(h => h.it.head).sort(), [sha("pr7"), sha("pr7-new")].sort());
});

test("the search is scoped to the current project unless every project is chosen; the same ID stays apart", () => {
  const w = world();
  assert.deepEqual(ids(find(w, "xq1", "alpha", false).tasks), ["alpha:XQ1"]);
  assert.deepEqual(ids(find(w, "xq1", "beta", false).tasks), ["beta:XQ1"]);
  const all = find(w, "xq1", null, false).tasks;
  assert.deepEqual(ids(all), ["alpha:XQ1", "beta:XQ1"]);
  assert.deepEqual(all.map(h => h.it.repo + "@" + h.it.commit), ["acme/alpha-plan@" + PLAN_A, "acme/beta-plan@" + PLAN_B]);
  assert.deepEqual(find(w, "pump", "beta", false).paths, []);
});

test("a plan that is not readable gives no tasks and is named; invalid rows are never results", () => {
  const w = world();
  w.entries[1].table = SB.result("invalid", null, null, { error: "bad table" });
  assert.deepEqual(find(w, "prune", null, false).tasks, []);
  assert.deepEqual(find(w, "broken", null, true).tasks, []);
  const c = SB.searchCoverage(SB.searchSources(w.entries, w.live, w.docs, docKey), null, false);
  assert.deepEqual(c.plansNot.map(p => [p.project.id, p.state]), [["beta", "invalid"]]);
  w.entries[1] = Object.assign({}, w.entries[1], { loading: true, plan: null, table: null });
  const c2 = SB.searchCoverage(SB.searchSources(w.entries, w.live, w.docs, docKey), "beta", false);
  assert.deepEqual(c2.plansNot.map(p => p.state), ["loading"]);
  assert.deepEqual(c2.reposNot.map(r => [r.repo, r.state]), [["acme/beta-plan", "loading"]]);
});

test("paths come from trees read at the pinned commit, folders left out, and a cut tree is marked", () => {
  const w = world();
  const p = find(w, "src seed", "alpha", false).paths;
  assert.deepEqual(p.map(h => [h.it.path, h.it.commit, h.it.truncated]), [["src/seed-list.txt", CODE, true]]);
  assert.deepEqual(find(w, "vendor", "alpha", false).paths.map(h => h.it.entry), ["submodule"]);
  assert.equal(find(w, "src", "alpha", false).totals.paths, 2);
  const c = SB.searchCoverage(SB.searchSources(w.entries, w.live, w.docs, docKey), "alpha", false);
  assert.deepEqual(c.trees.map(t => [t.repo, t.partial]), [["acme/alpha", true]]);
  // A tree read at another commit than the project's pin is not this project's.
  const w2 = world();
  w2.entries[0].code[0].pinned = ok({ commit: sha("newer"), meta: null });
  assert.deepEqual(find(w2, "pump", "alpha", false).paths, []);
});

test("opened files are searched by text with the line of the first word; binary files are not", () => {
  const w = world();
  const f = find(w, "blue valve", "alpha", false).files;
  assert.equal(f.length, 1);
  assert.equal(f[0].it.path, "src/pump.js");
  assert.equal(f[0].excerpt.line, 3);
  assert.match(f[0].excerpt.text, /BLUE valve/);
  assert.deepEqual(find(w, "logo", "alpha", false).files, []);
  assert.equal(SB.searchCoverage(SB.searchSources(w.entries, w.live, w.docs, docKey), "alpha", false).files, 1);
});

test("pull requests come from the lists read on this visit, once each, by number, title and head", () => {
  const w = world();
  assert.deepEqual(ids(find(w, "pump timer", "alpha", false).pulls), ["alpha:acme/alpha#7"]);
  assert.deepEqual(ids(find(w, "#3", "alpha", false).pulls), ["alpha:acme/alpha#3"]);
  assert.deepEqual(ids(find(w, sha("pr3").slice(0, 10), "alpha", false).pulls), ["alpha:acme/alpha#3"]);
  const c = SB.searchCoverage(SB.searchSources(w.entries, w.live, w.docs, docKey), "alpha", false);
  assert.deepEqual(c.pullLists.map(l => [l.from, l.partial]), [["feed", false], ["list", true]]);
});

test("repositories match by name, description and topics; one not read is named, not searched", () => {
  const w = world();
  assert.deepEqual(ids(find(w, "watering", null, false).repos), ["alpha:acme/alpha"]);
  assert.deepEqual(ids(find(w, "pumps", null, false).repos), ["alpha:acme/alpha"]);
  w.entries[0].code[0].pinned = SB.result("denied", null, null, { error: "HTTP 404" });
  assert.deepEqual(find(w, "watering", null, false).repos, []);
  assert.deepEqual(find(w, "pump", "alpha", false).paths, []);
  const c = SB.searchCoverage(SB.searchSources(w.entries, w.live, w.docs, docKey), "alpha", false);
  assert.deepEqual(c.reposNot.map(r => [r.repo, r.state]), [["acme/alpha", "denied"]]);
});

test("no words find nothing; results are capped per kind with the full count kept", () => {
  const w = world();
  assert.equal(find(w, "   ", null, true).totals.tasks, 0);
  w.entries[0].tasks = Array.from({ length: SB.MAX_SEARCH + 5 }, (_, i) => task("ZZ" + i, "Mulch bed " + i));
  const r = find(w, "mulch", "alpha", false);
  assert.equal(r.tasks.length, SB.MAX_SEARCH);
  assert.equal(r.totals.tasks, SB.MAX_SEARCH + 5);
});

test("hostile text stays text in excerpts, hidden characters are kept for the view to show by code, and nothing read is changed", () => {
  const w = world();
  const evil = "<img src=x onerror=alert(1)> drop ‮txt.exe‬ here";
  w.docs.set(docKey("alpha", "acme/alpha-plan", PLAN_A, "handover", FILES.handover, "XQ1"), ok({ text: evil }));
  const before = [w.live.size, w.docs.size];
  const hit = find(w, "drop", "alpha", true).tasks[0];
  assert.equal(hit.in, "handover");
  assert.ok(hit.excerpt.text.includes("<img src=x onerror=alert(1)>"));
  assert.ok(SB.textPieces(hit.excerpt.text).some(p => p.hidden === "U+202E"));
  assert.deepEqual([w.live.size, w.docs.size], before);
  // A long text is cut around the word, on one line.
  w.live.set(SB.codeKey.text("acme/alpha", CODE, "src/long.txt"), ok({ binary: false, text: "a".repeat(500) + "\n\nneedle\n\n" + "b".repeat(500) }));
  const ex = find(w, "needle", "alpha", false).files[0].excerpt;
  assert.ok(ex.text.startsWith("…") && ex.text.endsWith("…") && !ex.text.includes("\n"));
  assert.ok(ex.text.length < 140);
});
