"use strict";
// The left tree's project order, kept in this browser only: what saved text counts as an order, how the
// saved order meets the projects shown now, and a move.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB } = require("./helpers");

const SB = loadSB();

test("saved text that is not a list of short IDs counts as no order", () => {
  assert.deepEqual(SB.savedOrder(null), []);
  assert.deepEqual(SB.savedOrder("not json"), []);
  assert.deepEqual(SB.savedOrder('{"a":1}'), []);
  assert.deepEqual(SB.savedOrder('["b", 3, "", null, "a", "b", "' + "x".repeat(201) + '"]'), ["b", "a"]);
  assert.equal(SB.savedOrder(JSON.stringify(Array.from({ length: 2000 }, (_, i) => "p" + i))).length, 1000);
});

test("only the workspace list's own project IDs are kept; found and opened repositories hold their place for the visit", () => {
  const visit = ["~found-acme/private-thing", "garden", "~opened-1", "recipes"];
  assert.deepEqual(SB.keptOrder(visit), ["garden", "recipes"], "no repository name or visit place is kept");
  assert.deepEqual(SB.savedOrder(JSON.stringify(visit)), ["garden", "recipes"], "an older saved order with them is read without them");
  // The next visit opens another repository by name as ~opened-1: it does not take the first one's place.
  const next = SB.orderedIds(["garden", "recipes", "~opened-1"], SB.savedOrder(JSON.stringify(SB.keptOrder(visit))));
  assert.deepEqual(next, ["garden", "recipes", "~opened-1"]);
});

test("saved projects come first in their saved order, then the rest as the list gives them", () => {
  assert.deepEqual(SB.orderedIds(["a", "b", "c", "d"], []), ["a", "b", "c", "d"]);
  assert.deepEqual(SB.orderedIds(["a", "b", "c", "d"], ["c", "gone", "a"]), ["c", "a", "b", "d"]);
});

test("a move puts one project at a place and keeps saved projects not shown now", () => {
  assert.deepEqual(SB.moveId(["a", "b", "c"], [], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(SB.moveId(["a", "b", "c"], [], "a", 2), ["b", "c", "a"]);
  assert.deepEqual(SB.moveId(["a", "b", "c"], ["demo-1", "a"], "b", 0), ["b", "a", "c", "demo-1"]);
  assert.deepEqual(SB.moveId(["a", "b"], ["x"], "missing", 0), ["x"]);
  assert.deepEqual(SB.moveId(["a", "b"], [], "a", 99), ["b", "a"]);
});

test("the look kept in the browser is only known words, else the default", () => {
  assert.deepEqual(SB.savedLook(null), { density: "comfortable", accent: "blue" });
  assert.deepEqual(SB.savedLook("not json"), { density: "comfortable", accent: "blue" });
  assert.deepEqual(SB.savedLook('{"density":"compact","accent":"teal"}'), { density: "compact", accent: "teal" });
  assert.deepEqual(SB.savedLook('{"density":"tiny","accent":"#ff0000","token":"x"}'), { density: "comfortable", accent: "blue" });
  assert.deepEqual(SB.savedLook("[1,2]"), { density: "comfortable", accent: "blue" });
});

test("Home names every activity list that could not be read or was read only in part", () => {
  const ok = { state: "current", data: {} };
  assert.deepEqual(SB.feedGaps({ commits: ok, pulls: ok, comments: ok }), []);
  assert.deepEqual(SB.feedGaps({ commits: { state: "partial", data: {} }, pulls: { state: "denied", error: "403" }, comments: { state: "partial", data: {} } }),
    [{ what: "commits", limit: SB.COMMIT_LIMIT }, { what: "pull requests", state: "denied", error: "403" }, { what: "comments", limit: SB.REPO_COMMENT_LIMIT }]);
  assert.deepEqual(SB.feedGaps({ commits: ok, pulls: ok }), [{ what: "comments", state: "failed", error: null }]);
});

test("Home's day groups: today, yesterday, two to six days ago, earlier", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const back = d => new Date(now - d * 864e5).toISOString();
  assert.deepEqual([0, 1, 2, 6, 7].map(d => SB.dayGroup(back(d), now)), ["today", "yesterday", "week", "week", "earlier"]);
});
