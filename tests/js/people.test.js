"use strict";
// Members and teams: only the names the task tables give as doer or reviewer, as written.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB } = require("./helpers");

const SB = loadSB();

const read = (id, tasks) => ({ w: { id, label: id, plan: { repo: "o/" + id }, code: [] }, plan: { state: "current" }, table: { state: "current" }, tasks });
const task = (id, status, doer, reviewer, extra) => Object.assign({ id, status, doer, reviewer }, extra);

test("a cell names nobody when it is empty or a placeholder, and several people when split at commas", () => {
  assert.deepEqual(SB.namesIn(undefined), []);
  assert.deepEqual(SB.namesIn("—"), []);
  assert.deepEqual(SB.namesIn("TBE"), []);
  assert.deepEqual(SB.namesIn(" Agent A , Agent B,,-"), ["Agent A", "Agent B"]);
  assert.deepEqual(SB.namesIn("x".repeat(61)), [], "an over-long cell is not a name");
  assert.deepEqual(SB.namesIn("Agent A, Agent A ,Agent B"), ["Agent A", "Agent B"], "a name written twice in one cell counts once");
});

test("members count open and done work they do, open work they review, and their projects in order", () => {
  const entries = [
    read("p1", [task("A1", "In Progress", "Ann", "Bo"), task("A2", "Done", "Ann", "Bo"), task("A3", "Removed", "Cy", "Bo"), task("A4", "Ready for Review", "Bo", "Ann"),
                { id: "bad", invalid: true, doer: "Dee" }]),
    read("p2", [task("B1", "Blocked", "Bo", "—")]),
    { w: { id: "p3", label: "p3", plan: { repo: "o/p3" }, code: [] }, plan: { state: "failed" }, table: null, tasks: [task("C1", "In Progress", "Eve", "Ann")] },
  ];
  const ms = SB.members(entries);
  assert.deepEqual(ms.map(m => [m.name, m.open, m.done, m.reviewing, m.projects.map(e => e.w.id)]),
    [["Bo", 2, 0, 1, ["p1", "p2"]], ["Ann", 1, 1, 1, ["p1"]]], "removed, invalid and unread rows name no one; most open first");
  assert.deepEqual(ms[0].work.map(w => [w.t.id, w.role]), [["A1", "reviewer"], ["A2", "reviewer"], ["A4", "doer"], ["B1", "doer"]]);
  assert.deepEqual(SB.team(entries[1]).map(m => [m.name, m.open]), [["Bo", 1]], "a team counts its own project only");
});

test("across projects, the same task ID in two projects keeps its own repository's events and its own project", () => {
  const at = d => d + "T10:00:00Z";
  const a = read("alpha", [task("XT1", "In Progress", "Ann", "Bo")]);
  const b = read("beta", [task("XT1", "Ready for Review", "Bo", "Ann")]);
  b.w.code = [{ repo: "o/beta-code" }];
  const events = [
    { kind: "commit", repo: "o/alpha", at: at("2026-01-05"), title: "XT1 first draft", id: "a1" },
    { kind: "merged", repo: "o/beta-code", at: at("2026-02-10"), title: "XT1 build", id: "#2" },
    { kind: "commit", repo: "o/elsewhere", at: at("2026-03-01"), title: "XT1 in a repository no project maps", id: "z" },
  ];
  const got = SB.acrossActivity([a, b], events);
  assert.deepEqual(got.items.map(x => [x.e.w.id, x.t.id, x.t.status, x.d.first, x.d.last, x.d.events.map(ev => ev.id)]),
    [["alpha", "XT1", "In Progress", "2026-01-05", "2026-01-05", ["a1"]], ["beta", "XT1", "Ready for Review", "2026-02-10", "2026-02-10", ["#2"]]]);
  assert.deepEqual([got.found, got.total], [2, 2]);
});

test("a name repeated in one cell counts the task once; the same person as doer and reviewer keeps both roles", () => {
  const ms = SB.members([read("p1", [task("A1", "In Progress", "Ann, Ann", "Ann"), task("A2", "Done", "Ann,Bo,Ann", "Bo, Bo")])]);
  assert.deepEqual(ms.map(m => [m.name, m.open, m.done, m.reviewing, m.work.map(w => w.t.id + ":" + w.role)]),
    [["Ann", 1, 1, 1, ["A1:doer", "A1:reviewer", "A2:doer"]], ["Bo", 0, 1, 0, ["A2:doer", "A2:reviewer"]]]);
});
