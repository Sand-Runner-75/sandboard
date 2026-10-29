"use strict";
// Local time: every time is shown, and every commit counted, in the viewer's own time zone as the
// device reports it. Each test sets the zone for its own run and puts the old one back.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB } = require("./helpers");

const SB = loadSB();
const inZone = (zone, fn) => { const old = process.env.TZ; process.env.TZ = zone;
  try { fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; } };
const row = at => ({ sha: "x", parents: [], at });

test("times read in a viewer's zone, with the zone named", () => {
  const t = "2026-10-28T22:30:00Z";
  inZone("UTC", () => { assert.equal(SB.localWhen(t), "2026-10-28 22:30 UTC"); assert.equal(SB.localDay(t), "2026-10-28"); });
  inZone("Asia/Riyadh", () => { assert.equal(SB.localWhen(t), "2026-10-29 01:30 UTC+3"); assert.equal(SB.localDay(t), "2026-10-29");
    assert.equal(SB.localStamp(t), "2026-10-29 01:30"); });
  inZone("America/New_York", () => assert.equal(SB.localWhen(t), "2026-10-28 18:30 UTC-4"));
  inZone("Asia/Kolkata", () => assert.equal(SB.localWhen(t), "2026-10-29 04:00 UTC+5:30"));
  inZone("America/St_Johns", () => assert.equal(SB.zoneOf("2026-01-15T12:00:00Z"), "UTC-3:30"));
});

test("a zone's daylight saving change is taken from the time itself", () => {
  inZone("America/New_York", () => {
    assert.equal(SB.localWhen("2026-07-01T12:00:00Z"), "2026-07-01 08:00 UTC-4");
    assert.equal(SB.localWhen("2026-12-01T12:00:00Z"), "2026-12-01 07:00 UTC-5");
  });
});

test("text that is not a time shows nothing rather than a wrong time", () => {
  for (const bad of [null, undefined, "", "soon", "2026-13-45T99:00:00Z"]) {
    assert.equal(SB.localDay(bad), null); assert.equal(SB.localStamp(bad), null); assert.equal(SB.localWhen(bad), "");
  }
});

test("commits are counted on the viewer's local day and in the viewer's local Monday week", () => {
  const commits = [row("2026-01-04T22:30:00Z"), row("2026-01-05T10:00:00Z"), row("2026-01-11T21:30:00Z")];
  inZone("UTC", () => { const t = SB.commitTimes(commits);
    assert.deepEqual(t.weeks, [{ week: "2025-12-29", n: 1 }, { week: "2026-01-05", n: 2 }]);
    assert.deepEqual([t.from, t.to], ["2026-01-04", "2026-01-11"]); });
  inZone("Asia/Riyadh", () => { const t = SB.commitTimes(commits);
    // 22:30 UTC on Sunday is 01:30 on Monday in UTC+3; 21:30 UTC on Sunday the 11th is 00:30 on Monday the 12th.
    assert.deepEqual(t.weeks, [{ week: "2026-01-05", n: 2 }, { week: "2026-01-12", n: 1 }]);
    assert.deepEqual([t.from, t.to], ["2026-01-05", "2026-01-12"]);
    assert.equal(t.days.length, 8);
    assert.deepEqual(t.days.filter(d => d.n).map(d => d.day), ["2026-01-05", "2026-01-12"]); });
  inZone("America/Los_Angeles", () => { const t = SB.commitTimes(commits);
    assert.deepEqual(t.days.filter(d => d.n).map(d => [d.day, d.n]), [["2026-01-04", 1], ["2026-01-05", 1], ["2026-01-11", 1]]); });
});

test("local days stay whole calendar days across a daylight saving change", () => {
  inZone("Europe/London", () => { const t = SB.commitTimes([row("2026-03-27T12:00:00Z"), row("2026-03-31T12:00:00Z")]);
    assert.deepEqual(t.days.map(d => d.day), ["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
    assert.deepEqual(t.weeks.map(w => w.week), ["2026-03-23", "2026-03-30"]); });
});

test("the earliest and latest times a date can hold still count", () => {
  inZone("Asia/Riyadh", () => { const t = SB.commitTimes([row("-271821-04-20T00:00:00Z"), row("+275760-09-13T00:00:00Z")]);
    assert.equal(t.untimed, 0); assert.equal(t.weeks.length, SB.WEEKS_SHOWN); assert.equal(t.to, "+275760-09-13"); });
});
