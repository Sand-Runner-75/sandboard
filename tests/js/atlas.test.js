"use strict";
// The Atlas branch graph: which branches it draws, which pages of their commits it asks for, how far
// it shows, and where its lanes, rows, labels and key go. Synthetic histories only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, sha } = require("./helpers");

const SB = loadSB();
const REPO = "acme/garden";
const K = SB.historyKey;
const DAY = 864e5;
const at = d => new Date(Date.UTC(2026, 0, 1) + d * DAY).toISOString();
const c = (seed, parents, d, title, author) => ({ sha: sha(seed), title: title || seed, at: at(d), parents: parents.map(sha), author: author || null });
const page = (commits, end = true) => ({ state: commits.length ? (end ? "current" : "partial") : "empty", data: { commits, end } });
const refs = list => ({ state: "current", data: { refs: list.map(([name, seed]) => ({ name, sha: sha(seed), protected: null })) } });
const pulls = list => ({ state: "current", data: { pulls: list.map(([number, headRef, headRepo]) => ({ number, headRef, headRepo: headRepo || REPO })) } });
const liveOf = map => key => map.get(key);
// The commits behind a head, newest first, as the history pages give them.
function behind(all, head) {
  const by = new Map(all.map(x => [x.sha, x])), seen = new Set(), todo = [sha(head)];
  while (todo.length) { const s = todo.pop(); if (seen.has(s) || !by.has(s)) continue; seen.add(s); todo.push(...by.get(s).parents); }
  return all.filter(x => seen.has(x.sha)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
// Every wanted read answered from a synthetic repository, until the graph wants nothing more.
function settle(repo, show = SB.ATLAS.FIRST) {
  const live = new Map();
  for (let i = 0; i < 50; i++) {
    const g = SB.atlasGraph(liveOf(live), REPO, "main", show);
    if (!g.wanted.length) return { g, live };
    for (const w of g.wanted) {
      if (w.kind === "refs") live.set(K.refs(REPO, w.list), refs(w.list === "branches" ? repo.branches : repo.tags || []));
      else if (w.kind === "pulls") live.set(SB.workKey.list("pulls", REPO, w.state, w.page), pulls(repo.pulls || []));
      else {
        const seed = repo.branches.find(([, s]) => sha(s) === w.head)[1];
        const list = behind(repo.commits, seed).slice((w.page - 1) * 100, w.page * 100);
        live.set(K.lane(REPO, w.head, w.page), page(list, list.length < 100));
      }
    }
  }
  throw new Error("the graph kept asking");
}

// A small git-flow history: main with a hotfix merged, develop with a feature merged (its branch deleted),
// a release merge into main, and a feature still open.
const FLOW = {
  commits: [
    c("c0", [], 0, "Initial commit"), c("d1", ["c0"], 5, "Set up project structure"),
    c("h1", ["c0"], 10, "Fix crash on startup"), c("m1", ["c0", "h1"], 12, "Merge branch 'hotfix/startup-crash'"),
    c("d2", ["d1"], 20, "Add settings page"), c("f1", ["d2"], 25, "Add login form"), c("f2", ["f1"], 30, "Validate credentials"),
    c("d3", ["d2", "f2"], 35, "Merge branch 'feature/login' into develop"),
    c("m2", ["m1"], 40, "Update README"), c("d4", ["d3"], 48, "Prepare 1.0 release"),
    c("m3", ["m2", "d4"], 55, "Merge branch 'develop'"), c("d5", ["d4"], 57, "Start the 1.1 cycle"), c("f3", ["d5"], 58, "Add dark mode toggle"),
  ],
  branches: [["main", "m3"], ["develop", "d5"], ["hotfix/startup-crash", "h1"], ["feature/dark-mode", "f3"]],
  tags: [["v0.5", "m1"], ["v1.0", "d3"], ["v1", "m3"]],
  pulls: [[6, "feature/dark-mode"], [3, "hotfix/startup-crash"], [9, "develop", "someone-else/fork"]],
};

test("the graph asks for the branches first, then each drawn branch's newest commits, the tags and the pull requests", () => {
  const first = SB.atlasGraph(() => undefined, REPO, "main", 100);
  assert.deepEqual([first.state, first.wanted], ["loading", [{ kind: "refs", list: "branches" }]]);
  const live = new Map([[K.refs(REPO, "branches"), refs(FLOW.branches)]]);
  const g = SB.atlasGraph(liveOf(live), REPO, "main", 100);
  assert.deepEqual(g.pick.map(b => b.name), ["main", "develop", "hotfix/startup-crash", "feature/dark-mode"], "main, develop, then the short-lived kinds");
  assert.deepEqual(g.wanted.filter(w => w.kind === "lane"), g.pick.map(b => ({ kind: "lane", head: b.sha, page: 1 })));
  assert.deepEqual(g.wanted.filter(w => w.kind !== "lane"), [{ kind: "refs", list: "tags" }, { kind: "pulls", state: "all", page: 1 }]);
  assert.equal(g.state, "loading");
});

test("at most fifteen branches are drawn, in git-flow order", () => {
  const many = Array.from({ length: 20 }, (_, i) => ["topic-" + String(i).padStart(2, "0"), "t" + i]);
  const live = new Map([[K.refs(REPO, "branches"), refs([...many, ["feature/x", "fx"], ["release/2", "r2"], ["dev", "dv"], ["main", "mn"]])]]);
  const g = SB.atlasGraph(liveOf(live), REPO, "main", 100);
  assert.equal(g.pick.length, SB.ATLAS.BRANCHES);
  assert.deepEqual(g.pick.slice(0, 5).map(b => b.name), ["main", "dev", "release/2", "feature/x", "topic-00"]);
  assert.equal(g.total, 24);
});

test("a whole small history is drawn with git-flow lanes, rows, colours, labels and a key", () => {
  const { g } = settle(FLOW);
  assert.equal(g.state, "current");
  assert.equal(g.more, false, "every branch was read to its first commit");
  assert.equal(g.win.length, FLOW.commits.length);
  const lay = SB.atlasLayout("main", g.win, g.heads, g.tags);
  const byName = new Map(lay.key.map(k => [k.name, k]));
  assert.equal(byName.get("main").color, "#e5534b");
  assert.equal(byName.get("develop").color, "#3b76f0");
  assert.equal(byName.get("hotfix/startup-crash").color, "#26a865");
  assert.equal(byName.get("feature/dark-mode").color, "#9b59c9");
  assert.equal(byName.get("feature/dark-mode").label, "PR #6", "a branch with a pull request is labelled by its number");
  assert.equal(byName.get("develop").label, "develop", "a pull request from a fork does not name a branch here");
  assert.deepEqual([byName.get("feature/login").gone, byName.get("feature/login").label], [true, "—"], "a deleted branch is named from its merge message");
  assert.equal(lay.commits, 13);
  assert.equal(lay.tags, 3);
  const node = sha("m3");
  const dot = lay.nodes.find(n => n.sha === node);
  assert.equal(dot.y, 40, "main is the first row");
  assert.match(dot.tip, /^Merge branch 'develop'\n[0-9a-f]{7} on main\n2026-02-25$/);
  const flags = lay.flags.filter(f => f.s === dot.s);
  assert.deepEqual(flags.map(f => [f.kind, f.text]), [["tag", "v1"], ["branch", "main"]]);
  assert.ok(lay.flags.some(f => f.kind === "branch" && f.text === "PR #6"));
  assert.equal(lay.W, 46 * 2 + 12 * 34);
  // Rows: main, hotfix, develop, feature; the two features do not overlap, so they share a row.
  assert.equal(lay.guides.length, 4);
  assert.equal(lay.H, 40 + 3 * 62 + 46);
  // Each step is a commit, oldest first, and never before a parent.
  const x = new Map(lay.nodes.map(n => [n.sha, n.s]));
  for (const k of FLOW.commits) for (const p of k.parents) assert.ok(x.get(p) < x.get(k.sha));
  assert.deepEqual(lay.steps.map(s => s.msg)[0], "Initial commit");
});

test("a long history shows the newest commits first and asks for older pages only when shown further back", () => {
  const commits = Array.from({ length: 250 }, (_, i) => c("l" + i, i ? ["l" + (i - 1)] : [], i));
  const repo = { commits, branches: [["main", "l249"]] };
  const { g, live } = settle(repo);
  assert.equal(g.win.length, 100);
  assert.equal(g.more, true);
  assert.ok(live.has(K.lane(REPO, sha("l249"), 1)) && !live.has(K.lane(REPO, sha("l249"), 2)), "one page is enough for the first hundred");
  const more = SB.ATLAS.older(100);
  assert.equal(more, 300);
  const next = settle(repo, more);
  assert.equal(next.g.win.length, 250);
  assert.equal(next.g.more, false);
});

test("a commit page that could not be read says which branch, and asks for nothing more of it", () => {
  const live = new Map([[K.refs(REPO, "branches"), refs([["main", "m3"]])], [K.lane(REPO, sha("m3"), 1), { state: "rate-limited", data: null, error: "HTTP 429" }]]);
  const g = SB.atlasGraph(liveOf(live), REPO, "main", 100);
  assert.deepEqual(g.failed, { branch: "main", state: "rate-limited", error: "HTTP 429" });
  assert.equal(g.wanted.some(w => w.kind === "lane"), false);
});

test("an empty or unreadable branch list is said as such", () => {
  assert.equal(SB.atlasGraph(liveOf(new Map([[K.refs(REPO, "branches"), { state: "empty", data: { refs: [] } }]])), REPO, "main", 100).state, "empty");
  const denied = SB.atlasGraph(liveOf(new Map([[K.refs(REPO, "branches"), { state: "denied", data: null, error: "HTTP 403" }]])), REPO, "main", 100);
  assert.deepEqual([denied.state, denied.error], ["denied", "HTTP 403"]);
});

test("the layout draws nothing for no commits and a dashed stub where a parent was not read", () => {
  assert.equal(SB.atlasLayout("main", [], [], []), null);
  const lay = SB.atlasLayout("main", [{ sha: sha("x"), parents: [sha("missing")], date: at(1), msg: "x", author: "" }], [{ name: "main", sha: sha("x") }], []);
  assert.deepEqual(lay.edges.map(e => e.dashed), [true]);
});
