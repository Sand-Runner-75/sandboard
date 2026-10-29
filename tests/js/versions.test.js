"use strict";
// The Atlas versions: which branches start picked, which reads each version asks for, which pull requests
// each one lists, and which of them are drawn as lanes or marks. Synthetic histories only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, sha } = require("./helpers");

process.env.TZ = "UTC";
const SB = loadSB();
const REPO = "acme/garden";
const K = SB.historyKey;
const DAY = 864e5;
const at = d => new Date(Date.UTC(2026, 0, 1) + d * DAY).toISOString();
const c = (seed, parents, d, title) => ({ sha: sha(seed), title: title || seed, at: at(d), parents: parents.map(sha), author: null });
const refs = list => ({ state: "current", data: { refs: list.map(([name, seed]) => ({ name, sha: sha(seed), protected: null })) } });
const pr = (number, headRef, head, baseRef, more) => Object.assign({ number, title: "Change " + number, state: "closed", draft: false, merged: null,
  head: sha(head), headRef, headRepo: REPO, mergeCommit: null, baseRef, author: "someone", created: at(number), updated: at(number), closed: null }, more);
const behind = (all, head) => {
  const by = new Map(all.map(x => [x.sha, x])), seen = new Set(), todo = [sha(head)];
  while (todo.length) { const s = todo.pop(); if (seen.has(s) || !by.has(s)) continue; seen.add(s); todo.push(...by.get(s).parents); }
  return all.filter(x => seen.has(x.sha)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
};

// Version 1 on main, version 2 on staging: a feature merged into each, one squashed into main, one open
// against staging, and one closed without merging.
const H = {
  commits: [
    c("r0", [], 0, "Initial commit"),
    c("a1", ["r0"], 2, "Add lessons"), c("m1", ["r0", "a1"], 3, "Merge pull request #1 from acme/feature/lessons"),
    c("s0", ["m1"], 5, "Start version 2"), c("b1", ["s0"], 6, "New player"), c("s1", ["s0", "b1"], 7, "Merge pull request #2 from acme/feature/player"),
    c("q1", ["m1"], 8, "Fix typo (#3)"),
    c("o1", ["s1"], 9, "Quiz mode, part 1"), c("o2", ["o1"], 10, "Quiz mode, part 2"),
  ],
  branches: [["main", "q1"], ["staging", "s1"], ["feature/quiz", "o2"], ["feature/old", "r0"]],
  pulls: [
    pr(5, "feature/old", "r0", "staging"),
    pr(4, "feature/quiz", "o2", "staging", { state: "open" }),
    pr(3, "fix/typo", "x9", "main", { merged: at(8), mergeCommit: sha("q1") }),
    pr(2, "feature/player", "b1", "staging", { merged: at(7), mergeCommit: sha("s1") }),
    pr(1, "feature/lessons", "a1", "main", { merged: at(3), mergeCommit: sha("m1") }),
  ],
};

function settle(picked, show = () => 100, shared) {
  const live = new Map();
  for (let i = 0; i < 50; i++) {
    const v = SB.atlasVersions(key => live.get(key), REPO, "main", picked, show, 3, shared);
    if (!v.wanted.length) return { v, live };
    for (const w of v.wanted) {
      if (w.kind === "refs") live.set(K.refs(REPO, w.list), w.list === "branches" ? refs(H.branches) : refs([["v1.0", "m1"]]));
      else if (w.kind === "lane") {
        const list = seedOf(w.head) ? behind(H.commits, seedOf(w.head)) : [];
        live.set(K.lane(REPO, w.head, w.page), { state: list.length ? "current" : "empty", data: { commits: w.page === 1 ? list : [], end: true } });
      } else if (w.kind === "pulls") live.set(SB.workKey.list("pulls", REPO, w.state, w.page), { state: "current", data: { pulls: w.page === 1 ? H.pulls : [], end: true } });
    }
  }
  throw new Error("the versions kept asking");
}
const SEEDS = new Map(["r0", "a1", "m1", "s0", "b1", "s1", "q1", "o1", "o2", "x9"].map(s => [sha(s), s]));
const seedOf = h => SEEDS.get(h);

test("the default branch and the branches named like versions start picked; the rest can be picked", () => {
  const list = ["feature/x", "staging", "main", "release/2", "v2", "topic"].map(name => ({ name, sha: sha(name) }));
  assert.deepEqual(SB.ATLAS.versionStart(list, "main"), ["main", "staging", "v2"]);
  assert.deepEqual(SB.ATLAS.versionStart(list, "topic"), ["topic", "main", "staging", "v2"]);
});

test("the versions ask for the branches first, then each version's commits and one list of pull requests", () => {
  const first = SB.atlasVersions(() => undefined, REPO, "main", null, () => 100, 3);
  assert.deepEqual([first.state, first.wanted], ["loading", [{ kind: "refs", list: "branches" }]]);
  const live = new Map([[K.refs(REPO, "branches"), refs(H.branches)]]);
  const v = SB.atlasVersions(key => live.get(key), REPO, "main", null, () => 100, 3);
  assert.deepEqual(v.picked, ["main", "staging"]);
  assert.deepEqual(v.wanted, [{ kind: "pulls", state: "all", page: 1 }, { kind: "lane", head: sha("q1"), page: 1 }, { kind: "lane", head: sha("s1"), page: 1 }, { kind: "refs", list: "tags" }]);
});

test("each version lists only the pull requests into its branch, and draws merged and open ones as lanes", () => {
  const { v } = settle(null);
  assert.equal(v.state, "current");
  const [main, staging] = v.versions;
  assert.deepEqual([main.name, main.isDefault, staging.name, staging.isDefault], ["main", true, "staging", false]);
  assert.deepEqual(main.pulls.map(p => p.number), [3, 1]);
  assert.deepEqual(staging.pulls.map(p => p.number), [5, 4, 2]);
  assert.deepEqual(main.count, { open: 0, draft: 0, merged: 2, closed: 0 });
  assert.deepEqual(staging.count, { open: 1, draft: 0, merged: 1, closed: 1 });
  // main: its own commits only; #1 is a lane, #3 was squashed so it is a mark on its commit.
  assert.deepEqual(main.win.map(x => seedOf(x.sha)).sort(), ["a1", "m1", "q1", "r0"]);
  assert.deepEqual(main.heads.map(h => [h.name, h.pr]), [["main", undefined], ["feature/lessons", 1]]);
  assert.deepEqual(main.marks, [{ name: "PR #3", sha: sha("q1") }]);
  // staging: only its own commits (none main has), #2 merged as a lane, and the open #4's own commits down to where it leaves staging.
  assert.equal(staging.apart, true);
  assert.deepEqual(staging.win.map(x => seedOf(x.sha)).sort(), ["b1", "o1", "o2", "s0", "s1"]);
  assert.deepEqual(staging.heads.map(h => [h.name, h.pr, !!h.open]), [["staging", undefined, false], ["feature/player", 2, false], ["feature/quiz", 4, true]]);
  assert.equal(v.prs.end, true);
});

test("a version can also show the history it shares with the default branch", () => {
  const { v } = settle(null, () => 100, name => name === "staging");
  const staging = v.versions[1];
  assert.equal(staging.apart, false);
  assert.ok(["r0", "a1", "m1", "s0"].every(s => staging.win.some(x => seedOf(x.sha) === s)));
  assert.ok(!staging.win.some(x => seedOf(x.sha) === "q1"), "a commit only on main is still not in version 2");
});

test("a version's graph is laid out with its own branch first, its pull requests as labelled lanes", () => {
  const { v } = settle(null);
  const staging = v.versions[1];
  const lay = SB.atlasLayout("staging", staging.win, staging.heads, [...v.tags, ...staging.marks]);
  const byName = new Map(lay.key.map(k => [k.name, k]));
  assert.equal(byName.get("staging").color, "#e5534b", "the version's own branch is the first, main-coloured lane");
  assert.equal(byName.get("feature/quiz").label, "PR #4");
  assert.equal(lay.nodes.find(n => n.sha === sha("s1")).y, 40, "the version's merge commit is on the first row");
  const main = v.versions[0];
  const lm = SB.atlasLayout("main", main.win, main.heads, [...v.tags, ...main.marks]);
  assert.ok(lm.flags.some(f => f.kind === "tag" && f.text === "PR #3"), "the squashed pull request is marked on its commit");
});

test("the picked branches are kept in order, unknown ones dropped, and at most six are drawn", () => {
  const { v } = settle(["staging", "gone", "feature/quiz"]);
  assert.deepEqual(v.picked, ["staging", "feature/quiz"]);
  assert.equal(SB.ATLAS.VERSIONS, 6);
});

test("a version shows its newest commits and says when older ones are left", () => {
  const { v } = settle(null, () => 2);
  assert.equal(v.versions[0].win.length, 2);
  assert.equal(v.versions[0].shown, 2);
});

test("pull request pages are read until the list ends, and a failed one says so", () => {
  const live = new Map([[K.refs(REPO, "branches"), refs(H.branches)], [K.refs(REPO, "tags"), refs([])]]);
  const full = Array.from({ length: 100 }, (_, i) => pr(200 - i, "t" + i, "r0", "main"));
  live.set(SB.workKey.list("pulls", REPO, "all", 1), { state: "partial", data: { pulls: full, end: false } });
  let v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main"], () => 100, 3);
  assert.ok(v.wanted.some(w => w.kind === "pulls" && w.page === 2));
  live.set(SB.workKey.list("pulls", REPO, "all", 2), { state: "failed", data: null, error: "HTTP 500" });
  v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main"], () => 100, 3);
  assert.deepEqual([v.prs.failed, v.prs.error, v.retry], [true, "HTTP 500", true]);
  live.set(SB.workKey.list("pulls", REPO, "all", 2), { state: "partial", data: { pulls: full, end: false } });
  live.set(SB.workKey.list("pulls", REPO, "all", 3), { state: "partial", data: { pulls: full, end: false } });
  v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main"], () => 100, 3);
  assert.deepEqual([v.prs.end, v.prs.pages, v.prs.more], [false, 3, true]);
});

test("a commit older than the default branch's history read so far is never called this version's own", () => {
  // main: page 1 holds only newer main commits; the shared commit C is on its unread page 2.
  const mainNew = Array.from({ length: 100 }, (_, i) => c("mn" + i, [i ? "mn" + (i - 1) : "cc"], 200 - i));
  const live = new Map([
    [K.refs(REPO, "branches"), refs([["main", "mn0"], ["staging", "su"]])], [K.refs(REPO, "tags"), refs([])],
    [SB.workKey.list("pulls", REPO, "all", 1), { state: "empty", data: { pulls: [], end: true } }],
    [K.lane(REPO, sha("mn0"), 1), { state: "partial", data: { commits: mainNew, end: false } }],
    [K.lane(REPO, sha("su"), 1), { state: "current", data: { commits: [c("su", ["cc"], 50, "Staging only"), c("cc", ["r0"], 5, "Shared"), c("r0", [], 0)], end: true } }],
  ]);
  let v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main", "staging"], () => 100, 3);
  let st = v.versions[1];
  assert.deepEqual(st.win.map(x => seedOf(x.sha) || x.msg), [], "nothing is shown as staging's own before main is read back far enough");
  assert.equal(st.unknown, 3);
  assert.ok(v.wanted.some(w => w.kind === "lane" && w.head === sha("mn0") && w.page === 2));
  live.set(K.lane(REPO, sha("mn0"), 2), { state: "current", data: { commits: [c("cc", ["r0"], 5, "Shared"), c("r0", [], 0)], end: true } });
  v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main", "staging"], () => 100, 3);
  st = v.versions[1];
  assert.deepEqual([st.win.map(x => x.msg), st.unknown], [["Staging only"], 0], "the shared commit on main's second page is not staging's own");
});

test("an open pull request whose commits cannot be read, past the limit or from a fork is said, not dropped", () => {
  const opens = Array.from({ length: SB.ATLAS.OPEN_LANES + 2 }, (_, i) => pr(50 + i, "topic-" + i, "o2", "staging", { state: "open" }));
  opens.push(pr(90, "theirs", "o2", "staging", { state: "open", headRepo: "someone/fork" }));
  const live = new Map([[K.refs(REPO, "branches"), refs(H.branches)], [K.refs(REPO, "tags"), { state: "failed", data: null, error: "HTTP 502" }],
    [SB.workKey.list("pulls", REPO, "all", 1), { state: "current", data: { pulls: opens, end: true } }]]);
  for (const h of ["q1", "s1"]) live.set(K.lane(REPO, sha(h), 1), { state: "current", data: { commits: behind(H.commits, h), end: true } });
  live.set(K.lane(REPO, sha("o2"), 1), { state: "denied", data: null, error: "HTTP 403" });
  const v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main", "staging"], () => 100, 3);
  const L = v.versions[1].lanes;
  assert.equal(L.failed.length, SB.ATLAS.OPEN_LANES);
  assert.deepEqual([L.failed[0].error, L.capped, L.forks], ["HTTP 403", 2, 1]);
  assert.deepEqual([v.tagState.failed, v.tagState.error, v.retry], [true, "HTTP 502", true]);
});
