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
