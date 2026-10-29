"use strict";
// Favourites and saved task views kept in this browser: what saved text counts, changes to them,
// and the GitHub address the right-click menu offers.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB } = require("./helpers");

const SB = loadSB();

test("saved text keeps only project and task IDs, view names, filter words and layouts", () => {
  assert.deepEqual(SB.savedMarks(null), { favs: [], views: [] });
  assert.deepEqual(SB.savedMarks("not json"), { favs: [], views: [] });
  assert.deepEqual(SB.savedMarks("[1,2]").favs, []);
  const m = SB.savedMarks(JSON.stringify({
    favs: ["p:demo", "p:demo", "t:demo:DT103", "p:~found-x", "t:demo:DT1:x", "x:demo", "p:demo:extra", 7, "t:demo:" + "A".repeat(41)],
    views: [{ project: "demo", name: "  Mine  ", filters: { status: "Done", q: "secret title", doer: "Agent A", phase: "P2", stage: "S 1", token: "abc" }, layout: "board", extra: "dropped" },
            { project: "demo", name: "Mine", filters: {}, layout: "list" }, { project: "~opened-1", name: "x" }, { project: "demo", name: "   " },
            { project: "demo", name: "Odd", layout: "spiral" }],
    token: "ghp_dropped" }));
  assert.deepEqual(m.favs, ["p:demo", "t:demo:DT103"], "visit-only projects, malformed keys and repeats are dropped");
  assert.deepEqual(m.views, [
    { project: "demo", name: "Mine", filters: { q: "", stage: "", phase: "P2", status: "Done", doer: "" }, layout: "board" },
    { project: "demo", name: "Odd", filters: { q: "", stage: "", phase: "", status: "", doer: "" }, layout: "list" }]);
  assert.equal(JSON.stringify(m).includes("ghp_"), false);
  assert.equal(/secret|Agent A/.test(JSON.stringify(m)), false, "search words and names read from the tables are never kept");
  assert.equal(SB.savedMarks(JSON.stringify({ views: [{ project: "p", name: "v", filters: { status: "Something new" } }] })).views[0].filters.status, "", "only a known status");
  assert.equal(SB.savedMarks(JSON.stringify({ favs: Array.from({ length: 300 }, (_, i) => "p:p" + i) })).favs.length, 200);
  assert.equal(SB.savedMarks(JSON.stringify({ views: Array.from({ length: 80 }, (_, i) => ({ project: "p", name: "v" + i })) })).views.length, 50);
  assert.equal(SB.savedMarks(JSON.stringify({ views: [{ project: "p", name: "x".repeat(90) }] })).views[0].name.length, 40);
});

test("a star toggles; a view replaces one of the same name in its project and can be removed", () => {
  let m = { favs: [], views: [] };
  m = SB.toggleFav(m, SB.favKey("demo"));
  m = SB.toggleFav(m, SB.favKey("demo", "DT103"));
  assert.deepEqual(m.favs, ["p:demo", "t:demo:DT103"]);
  m = SB.toggleFav(m, "p:demo");
  assert.deepEqual(m.favs, ["t:demo:DT103"]);
  const f = { q: "", stage: "", phase: "", status: "", doer: "" };
  m = SB.saveView(m, { project: "demo", name: "A", filters: f, layout: "list" });
  m = SB.saveView(m, { project: "other", name: "A", filters: f, layout: "table" });
  m = SB.saveView(m, { project: "demo", name: "A", filters: f, layout: "board" });
  assert.deepEqual(m.views.map(v => [v.project, v.name, v.layout]), [["other", "A", "table"], ["demo", "A", "board"]]);
  m = SB.dropView(m, "demo", "A");
  assert.deepEqual(m.views.map(v => v.project), ["other"]);
  m = SB.saveView(m, { project: "demo", name: "B", filters: { q: "private words", doer: "Agent A", status: "Blocked", phase: "P1" }, layout: "list" });
  assert.deepEqual(m.views[1].filters, { q: "", stage: "", phase: "P1", status: "Blocked", doer: "" }, "saving keeps no search words or names");
});

test("the limits hold when adding, so nothing confirmed is lost on the next read", () => {
  const f = { q: "", stage: "", phase: "", status: "", doer: "" };
  let m = { favs: Array.from({ length: SB.MARK_LIMITS.favs }, (_, i) => "p:p" + i), views: Array.from({ length: SB.MARK_LIMITS.views }, (_, i) => ({ project: "p", name: "v" + i, filters: f, layout: "list" })) };
  assert.deepEqual([SB.MARK_LIMITS.favs, SB.MARK_LIMITS.views], [200, 50]);
  assert.equal(SB.toggleFav(m, "p:new").favs.length, 200, "a star beyond the limit is not added");
  assert.equal(SB.toggleFav(m, "p:p5").favs.includes("p:p5"), false, "taking one out still works when full");
  assert.equal(SB.saveView(m, { project: "p", name: "new", filters: f, layout: "list" }), null, "a new view beyond the limit is refused");
  const same = SB.saveView(m, { project: "p", name: "v3", filters: f, layout: "board" });
  assert.equal(same.views.length, 50, "a view of the same name is still replaced when full");
  const back = SB.savedMarks(JSON.stringify(same));
  assert.deepEqual([back.favs.length, back.views.length, back.views.some(v => v.name === "v3" && v.layout === "board")], [200, 50, true], "what was saved comes back after a reload");
});

test("the GitHub link is the plan's own address, and a task's is its table at the commit read", () => {
  const sha = "a".repeat(40);
  const e = { w: { plan: { repo: "o/p" }, code: [] }, plan: { state: "current", data: { web: "https://github.com/o/p", commit: sha } },
              table: { state: "current", source: { path: "plan/tasks.md" } }, code: [] };
  assert.equal(SB.githubLink(e, null), "https://github.com/o/p");
  assert.equal(SB.githubLink(e, "DT1"), "https://github.com/o/p/blob/" + sha + "/plan/tasks.md");
  assert.equal(SB.githubLink(Object.assign({}, e, { table: { source: { path: "../x" } } }), "DT1"), "https://github.com/o/p", "an odd path falls back to the repository");
  assert.equal(SB.githubLink(Object.assign({}, e, { plan: { state: "current", data: { web: null, commit: sha } } }), null), null, "no address GitHub did not give");
  const code = { w: { plan: null, code: [{ repo: "o/c" }] }, code: [{ pinned: { state: "current", data: { web: "https://github.com/o/c", commit: sha } } }] };
  assert.equal(SB.githubLink(code, null), "https://github.com/o/c");
});
