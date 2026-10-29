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
