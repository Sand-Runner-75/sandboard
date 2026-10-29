"use strict";
// Task views: a task's dates are only those of the activity read that names it, and the timeline and
// calendar scales are whole weeks, months and Monday-first weeks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB } = require("./helpers");

const SB = loadSB();

test("a task is dated only by events that name it, a handoff by the pull request it is on", () => {
  const events = [
    { kind: "opened", repo: "o/p", id: "#2", title: "DT103: audience size", at: "2026-01-10T10:00:00Z" },
    { kind: "handoff", repo: "o/p", id: "#2", title: "Agent B: REVIEW PASSED", at: "2026-01-12T10:00:00Z" },
    { kind: "handoff", repo: "o/q", id: "#2", title: "Agent B: READY", at: "2026-01-20T10:00:00Z" },
    { kind: "commit", repo: "o/p", id: "abc1234", title: "DT103.1: a step", at: "2026-01-14T10:00:00Z" },
    { kind: "commit", repo: "o/p", id: "def5678", title: "Tidy", at: "2026-01-15T10:00:00Z" },
  ];
  const got = SB.taskActivity([{ id: "DT103" }, { id: "DT103.1" }, { id: "DT104" }, { id: "X", invalid: "bad" }], events);
  assert.deepEqual([...got.keys()], ["DT103", "DT103.1"], "a task no event names has no dates");
  assert.equal(got.get("DT103").events.length, 2, "DT103.1 is not DT103, and a handoff in another repository does not count");
  assert.equal(got.get("DT103").first < got.get("DT103").last, true);
  assert.equal(got.get("DT103.1").first, got.get("DT103.1").last);
});

test("timeline columns are whole weeks from a Monday or whole months, the newest kept", () => {
  const w = SB.timelineScale("2026-10-20", "2026-11-17", "weeks", 26);
  assert.deepEqual(w.cols, ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"]);
  assert.equal(w.cut, 0);
  assert.equal(w.at("2026-10-19"), 0);
  assert.equal(w.at("2026-11-23"), 1);
  const cut = SB.timelineScale("2026-01-05", "2026-12-28", "weeks", 26);
  assert.equal(cut.cols.length, 26);
  assert.equal(cut.cut > 0, true);
  assert.equal(cut.at("2026-01-05"), 0, "a day before the columns sits at the left edge");
  assert.deepEqual(SB.timelineScale("2025-12-20", "2026-02-02", "months", 18).cols, ["2025-12-01", "2026-01-01", "2026-02-01"]);
});

test("a month's calendar is Monday-first weeks, and months step across years", () => {
  const weeks = SB.monthWeeks("2026-11");
  assert.equal(weeks[0][0], "2026-10-26");
  assert.equal(weeks[weeks.length - 1][6], "2026-12-06");
  assert.equal(weeks.every(x => x.length === 7), true);
  assert.equal(SB.shiftMonth("2026-12", 1), "2027-01");
  assert.equal(SB.shiftMonth("2026-01", -1), "2025-12");
  assert.equal(SB.weekStart("2026-11-01"), "2026-10-26");
});
