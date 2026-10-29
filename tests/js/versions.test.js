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

// GitHub's comparison of two heads in a synthetic history: the merge base and how many commits head has that base has not.
function compare(all, baseSeed, headSeed) {
  const anc = seed => new Set(behind(all, seed).map(x => x.sha));
  const a = anc(baseSeed), h = anc(headSeed), common = [...h].filter(x => a.has(x));
  const by = new Map(all.map(x => [x.sha, x]));
  const reaches = (from, to) => behind(all, SEEDS.get(from)).some(x => x.sha === to);
  const best = common.find(x => !common.some(y => y !== x && reaches(y, x)));
  return { state: "current", data: { status: "diverged", ahead: [...h].filter(x => !a.has(x)).length, behind: 0, base: best || null } };
}

function settle(picked, show = () => 100, shared) {
  const live = new Map();
  for (let i = 0; i < 50; i++) {
    const v = SB.atlasVersions(key => live.get(key), REPO, "main", picked, show, 3, shared);
    if (!v.wanted.length) return { v, live };
    for (const w of v.wanted) {
      if (w.kind === "compare") live.set(K.compare(REPO, w.base, w.head), compare(H.commits, seedOf(w.base), seedOf(w.head)));
      else if (w.kind === "refs") live.set(K.refs(REPO, w.list), w.list === "branches" ? refs(H.branches) : refs([["v1.0", "m1"]]));
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
  assert.deepEqual(v.wanted, [{ kind: "pulls", state: "all", page: 1 }, { kind: "lane", head: sha("q1"), page: 1 },
    { kind: "compare", base: sha("q1"), head: sha("s1") }, { kind: "refs", list: "tags" }], "a version beside the default branch is compared with it before its commits are read");
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

test("a shared commit is never called a version's own, whatever the commit dates say", () => {
  // C is dated after its own descendants on main, and is on main's second page; only ancestry decides.
  const all = [c("r0", [], 0), c("cc", ["r0"], 300, "Shared, dated late"), c("m1", ["cc"], 10, "Main 1"), c("m2", ["m1"], 11, "Main 2"),
    c("su", ["cc"], 50, "Staging only")];
  const seeds = new Map([[sha("r0"), "r0"], [sha("cc"), "cc"], [sha("m1"), "m1"], [sha("m2"), "m2"], [sha("su"), "su"]]);
  for (const [k, v] of seeds) SEEDS.set(k, v);
  const live = new Map([
    [K.refs(REPO, "branches"), refs([["main", "m2"], ["staging", "su"]])], [K.refs(REPO, "tags"), refs([])],
    [SB.workKey.list("pulls", REPO, "all", 1), { state: "empty", data: { pulls: [], end: true } }],
    [K.lane(REPO, sha("m2"), 1), { state: "current", data: { commits: behind(all, "m2"), end: true } }],
    [K.lane(REPO, sha("su"), 1), { state: "partial", data: { commits: behind(all, "su").slice(0, 2), end: false } }],
  ]);
  let v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main", "staging"], () => 100, 3);
  assert.deepEqual(v.versions[1].win, [], "nothing is drawn as its own before the comparison is read");
  assert.ok(v.wanted.some(w => w.kind === "compare" && w.base === sha("m2") && w.head === sha("su")));
  live.set(K.compare(REPO, sha("m2"), sha("su")), compare(all, "m2", "su"));
  v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main", "staging"], () => 100, 3);
  const st = v.versions[1];
  assert.deepEqual([st.win.map(x => x.msg), st.unknown, st.ahead], [["Staging only"], 0, 1]);
  assert.ok(!v.wanted.some(w => w.kind === "lane" && w.head === sha("su") && w.page === 2), "once every own commit is proved, no more pages are read");
});

test("a commit whose side is not proved yet is counted as unknown, and a failed comparison draws nothing as own", () => {
  // The merge base's history is not read and fewer own commits are proved than GitHub counts.
  const all = [c("r0", [], 0), c("x1", ["r0"], 1, "Old staging work"), c("mb", ["r0"], 2, "Main"), c("sm", ["x1", "mb"], 3, "Merge main"), c("sn", ["sm"], 4, "New")];
  for (const x of all) SEEDS.set(x.sha, x.title);
  const live = new Map([
    [K.refs(REPO, "branches"), refs([["main", "mb"], ["staging", "sn"]])], [K.refs(REPO, "tags"), refs([])],
    [SB.workKey.list("pulls", REPO, "all", 1), { state: "empty", data: { pulls: [], end: true } }],
    [K.lane(REPO, sha("mb"), 1), { state: "current", data: { commits: behind(all, "mb"), end: true } }],
    [K.lane(REPO, sha("sn"), 1), { state: "partial", data: { commits: behind(all, "sn").slice(0, 4), end: false } }],
    [K.lane(REPO, sha("sn"), 2), { state: "failed", data: null, error: "HTTP 500" }],
    [K.compare(REPO, sha("mb"), sha("sn")), { state: "current", data: { status: "diverged", ahead: 3, behind: 0, base: sha("mb") } }],
  ]);
  let v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main", "staging"], () => 100, 3);
  let st = v.versions[1];
  assert.deepEqual(st.win.map(x => x.msg).sort(), ["Merge main", "New"]);
  assert.equal(st.unknown, 1, "the old staging commit is neither proved own nor shared");
  live.set(K.compare(REPO, sha("mb"), sha("sn")), { state: "failed", data: null, error: "HTTP 502" });
  v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main", "staging"], () => 100, 3);
  st = v.versions[1];
  assert.deepEqual([st.win, st.failed.error, v.retry], [[], "HTTP 502", true]);
});

test("an open pull request line longer than what is read is drawn and said to be cut", () => {
  const long = [c("r0", [], 0), c("t0", ["r0"], 1)];
  for (let i = 1; i < 350; i++) long.push(c("t" + i, ["t" + (i - 1)], 1 + i / 1000));
  const base = [c("r0", [], 0), c("bh", ["r0"], 0.5, "Base head")];
  const live = new Map([
    [K.refs(REPO, "branches"), refs([["main", "bh"], ["topic", "t349"]])], [K.refs(REPO, "tags"), refs([])],
    [SB.workKey.list("pulls", REPO, "all", 1), { state: "current", data: { pulls: [pr(9, "topic", "t349", "main", { state: "open" })], end: true } }],
    [K.lane(REPO, sha("bh"), 1), { state: "current", data: { commits: behind(base, "bh"), end: true } }],
  ]);
  const newest = long.slice().reverse();
  for (let pg = 1; pg <= 3; pg++) live.set(K.lane(REPO, sha("t349"), pg), { state: "partial", data: { commits: newest.slice((pg - 1) * 100, pg * 100), end: false } });
  const v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main"], () => 100, 3);
  const m = v.versions[0];
  assert.deepEqual(m.lanes.cut, [9]);
  assert.ok(m.heads.some(h => h.pr === 9 && h.open));
  assert.ok(!v.wanted.some(w => w.kind === "lane" && w.head === sha("t349") && w.page === 4), "at most three pages of an open line are read");
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

test("an open line is joined by parents only: older or mixed commit dates never hide it or its cut notice", () => {
  const base = [c("r0", [], 0)];
  for (let i = 1; i <= 10; i++) base.push(c("b" + i, ["b" + (i - 1) === "b0" ? "r0" : "b" + (i - 1)], 100 + i));
  const make = (prefix, dateOf) => { const l = []; for (let i = 0; i < 400; i++) l.push(c(prefix + i, [i ? prefix + (i - 1) : "zz"], dateOf(i))); return l.reverse(); };
  const older = make("o", i => 1 + i / 1000);                    // every commit dated before the version's window
  const mixed = make("n", i => i === 399 ? 500 : 1 + i / 1000);   // a newer head on older parents
  const live = new Map([
    [K.refs(REPO, "branches"), refs([["main", "b10"]])], [K.refs(REPO, "tags"), refs([])],
    [SB.workKey.list("pulls", REPO, "all", 1), { state: "current", data: { pulls: [pr(21, "old-line", "o399", "main", { state: "open" }), pr(22, "new-head", "n399", "main", { state: "open" })], end: true } }],
    [K.lane(REPO, sha("b10"), 1), { state: "current", data: { commits: behind(base, "b10"), end: true } }],
  ]);
  for (const [head, list] of [["o399", older], ["n399", mixed]])
    for (let pg = 1; pg <= 3; pg++) live.set(K.lane(REPO, sha(head), pg), { state: "partial", data: { commits: list.slice((pg - 1) * 100, pg * 100), end: false } });
  const v = SB.atlasVersions(key => live.get(key), REPO, "main", ["main"], () => 100, 3);
  const m = v.versions[0];
  assert.deepEqual(m.lanes.cut, [21, 22], "both lines are said to be cut off");
  assert.deepEqual(m.heads.filter(h => h.open).map(h => h.pr), [21, 22], "neither head is dropped");
  assert.equal(m.win.length, 10 + 1 + 2 * 100, "each line draws its newest hundred commits");
});
