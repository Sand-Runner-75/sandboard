"use strict";
// History: the readers for pages behind a commit, branches, tags and comparisons, and the graph,
// coverage and counts worked out from them. Synthetic repositories only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, json, sha } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();
const REPO = "acme/garden";
const HEAD = sha("head");

function setup(extra = {}, overrides = []) {
  const repos = F.planRepos();
  Object.assign(repos[REPO], extra);
  const gh = mockGitHub(repos, overrides);
  const session = SB.createSession();
  return { gh, client: SB.createClient(session, gh.fetch), ctx: session.start("synthetic-token") };
}
const api = (seed, parents, at, author) => ({ sha: sha(seed), commit: { message: seed + " title\n\nbody", committer: { date: at || "2026-01-01T00:00:00Z" },
  author: { name: "Real Name", email: "noreply@example.invalid" } }, parents: parents.map(p => ({ sha: sha(p) })), author: author === undefined ? { login: "agent-a" } : author });
const row = (seed, parents, at, author) => ({ sha: sha(seed), title: seed, at: at || "2026-01-01T00:00:00Z", parents: parents.map(sha), author: author || null });

test("only the history's exact read paths are allowed, all of them reads", () => {
  const A = sha("a"), B = sha("b");
  for (const ok of ["/repos/a/b/commits?sha=" + A + "&per_page=100&page=1", "/repos/a/b/commits?sha=" + A + "&per_page=100&page=10",
                    "/repos/a/b/branches?per_page=100&page=3", "/repos/a/b/tags?per_page=100&page=1", "/repos/a/b/compare/" + A + "..." + B + "?per_page=1"]) {
    assert.equal(SB.allowed(ok), true, ok);
  }
  assert.ok(SB.allowed("/repos/a/b/commits?sha=" + A + "&per_page=100&page=11") && SB.allowed("/repos/a/b/commits?sha=" + A + "&per_page=100&page=250"), "history has no last page");
  for (const bad of ["/repos/a/b/commits?sha=" + A + "&per_page=100&page=0", "/repos/a/b/commits?sha=" + A + "&per_page=100&page=01", "/repos/a/b/commits?sha=main&per_page=100&page=1",
                     "/repos/a/b/branches?per_page=100&page=4", "/repos/a/b/branches/main", "/repos/a/b/git/refs/heads/x",
                     "/repos/a/b/compare/main...dev?per_page=1", "/repos/a/b/compare/" + A + "..." + B, "/repos/a/b/merges", "/repos/a/b/stats/contributors",
                     "/repos/a/b/contributors", "/users/a/events"]) {
    assert.equal(SB.allowed(bad), false, bad);
  }
});

test("a history page keeps parents and the login, never a name or email; a full page may hold more", async () => {
  let s = setup({ history: { [HEAD]: [[api("head", ["p1", "p2"]), api("p1", ["root"], null, null), api("root", [])]] } });
  let r = await SB.readHistoryPage(s.ctx, s.client, REPO, HEAD, 1);
  assert.equal(r.state, "current");
  assert.equal(r.data.end, true);
  assert.deepEqual(r.data.commits[0].parents, [sha("p1"), sha("p2")]);
  assert.equal(r.data.commits[0].author, "agent-a");
  assert.equal(r.data.commits[1].author, null);
  assert.ok(!JSON.stringify(r).includes("Real Name") && !JSON.stringify(r).includes("noreply@"), "no name or email is kept");
  const full = Array.from({ length: 100 }, (_, i) => api("c" + i, ["c" + (i + 1)]));
  s = setup({ history: { [HEAD]: [full] } });
  r = await SB.readHistoryPage(s.ctx, s.client, REPO, HEAD, 1);
  assert.equal(r.state, "partial");
  assert.equal(r.data.end, false);
  s = setup({ history: { [HEAD]: [[Object.assign(api("x", []), { parents: [{ sha: "nope" }] })]] } });
  assert.equal((await SB.readHistoryPage(s.ctx, s.client, REPO, HEAD, 1)).state, "invalid");
  s = setup({ history: { [HEAD]: [[api("x", []), Object.assign(api("y", []), { author: { login: "<img>" } })]] } });
  assert.equal((await SB.readHistoryPage(s.ctx, s.client, REPO, HEAD, 1)).data.commits[1].author, null, "a login not in GitHub's form is not kept");
  s = setup({ history: { [HEAD]: [500] } });
  assert.equal((await SB.readHistoryPage(s.ctx, s.client, REPO, HEAD, 1)).state, "failed");
  for (const page of [0, -1, 1.5, "2"]) assert.equal((await SB.readHistoryPage(s.ctx, s.client, REPO, HEAD, page)).state, "invalid");
  assert.equal(s.gh.calls.length, 1, "a page that is not a whole number from 1 is never requested");
  s = setup({ history: { [HEAD]: Array.from({ length: 12 }, (_, p) => Array.from({ length: p < 11 ? 100 : 3 }, (_, i) => api("c" + p + "-" + i, ["x"]))) } });
  r = await SB.readHistoryPage(s.ctx, s.client, REPO, HEAD, 12);
  assert.deepEqual([r.state, r.data.commits.length, r.data.end], ["current", 3, true], "pages past the tenth are read like any other");
  assert.equal(s.gh.calls[0].url, SB.API + "/repos/" + REPO + "/commits?sha=" + HEAD + "&per_page=100&page=12");
});

test("branches and tags are read with their commits; a full third page is partial; a bad one is invalid", async () => {
  let s = setup({ branchList: [{ name: "main", commit: { sha: HEAD }, protected: true }, { name: "dev/x", commit: { sha: sha("d") } }],
                  tagList: [{ name: "v1", commit: { sha: sha("t") } }] });
  const b = await SB.readRefs(s.ctx, s.client, REPO, "branches");
  assert.deepEqual(b.data.refs, [{ name: "main", sha: HEAD, protected: true }, { name: "dev/x", sha: sha("d"), protected: null }]);
  assert.deepEqual((await SB.readRefs(s.ctx, s.client, REPO, "tags")).data.refs, [{ name: "v1", sha: sha("t") }]);
  s = setup({ branchList: Array.from({ length: 300 }, (_, i) => ({ name: "b" + i, commit: { sha: sha(i) } })) });
  const many = await SB.readRefs(s.ctx, s.client, REPO, "branches");
  assert.equal(many.state, "partial");
  assert.equal(many.data.refs.length, 300);
  s = setup({ tagList: [{ name: "bad", commit: { sha: "main" } }] });
  assert.equal((await SB.readRefs(s.ctx, s.client, REPO, "tags")).state, "invalid");
  s = setup({ branchList: 403 });
  assert.equal((await SB.readRefs(s.ctx, s.client, REPO, "branches")).state, "denied");
  assert.equal((await SB.readRefs(s.ctx, s.client, REPO, "refs")).state, "invalid");
});

test("a comparison gives GitHub's counts and merge base, and nothing else is trusted", async () => {
  const D = sha("d");
  let s = setup({ compare: { [D]: { status: "diverged", ahead_by: 2, behind_by: 4, merge_base_commit: { sha: sha("base") }, files: [{ filename: "x" }] } } });
  const c = await SB.readCompare(s.ctx, s.client, REPO, HEAD, D);
  assert.deepEqual(c.data, { status: "diverged", ahead: 2, behind: 4, base: sha("base") });
  assert.equal(s.gh.calls[0].url.endsWith("/compare/" + HEAD + "..." + D + "?per_page=1"), true);
  s = setup({ compare: { [D]: { status: "merged", ahead_by: 1, behind_by: 0 } } });
  assert.equal((await SB.readCompare(s.ctx, s.client, REPO, HEAD, D)).state, "invalid");
  s = setup({ compare: { [D]: { status: "ahead", ahead_by: -1, behind_by: 0 } } });
  assert.equal((await SB.readCompare(s.ctx, s.client, REPO, HEAD, D)).state, "invalid");
  assert.equal((await SB.readCompare(s.ctx, s.client, REPO, HEAD, "main")).state, "invalid");
});

test("the graph puts diverging branches, a merge and a tag's commit in lanes, joined by their parents", () => {
  // main: head -> merge(m1, b2); b2 -> b1 -> base; m1 -> base. Branch x: x2 -> x1 -> base (not merged).
  const main = [row("head", ["merge"], "2026-01-06T00:00:00Z"), row("merge", ["m1", "b2"], "2026-01-05T00:00:00Z"), row("b2", ["b1"], "2026-01-04T00:00:00Z"),
                row("m1", ["base"], "2026-01-03T12:00:00Z"), row("b1", ["base"], "2026-01-03T00:00:00Z"), row("base", [], "2026-01-01T00:00:00Z")];
  const x = { commits: [row("x2", ["x1"], "2026-01-05T12:00:00Z"), row("x1", ["base"], "2026-01-02T00:00:00Z")] };
  const g = SB.historyGraph(main, [x]);
  const at = seed => g.rows.find(r => r.commit.sha === sha(seed));
  assert.equal(g.rows.length, 8);
  assert.equal(at("head").lane, 0);
  assert.equal(at("merge").merge, true);
  assert.equal(at("merge").lane, 0);
  assert.notEqual(at("x2").lane, 0, "an unmerged branch has its own lane");
  assert.notEqual(at("b2").lane, at("m1").lane, "a merged branch's commits stay apart from the first parent's");
  assert.equal(at("base").root, true);
  assert.equal(g.rows[g.rows.length - 1].commit.sha, sha("base"), "parents always come after their children");
  assert.equal(g.unread, 0, "every parent was read");
  // Every lane open below a row is either the next row's commit or passes down to a later row.
  g.rows.forEach((r, i) => { for (const k of Object.keys(r.into)) assert.ok(r.open[k], "row " + i + " lane " + k + " goes somewhere"); });
});

test("a parent that was not read leaves its lane open at the bottom", () => {
  const g = SB.historyGraph([row("a", ["b"]), row("b", ["older"])], []);
  assert.equal(g.unread, 1);
  assert.equal(g.rows[1].open[0], sha("older"));
});

test("the history view asks for what it still needs and says where history stops", () => {
  const K = SB.historyKey, live = new Map();
  const get = k => live.get(k);
  let h = SB.historyView(get, REPO, HEAD, 1, new Set());
  assert.equal(h.state, "loading");
  assert.deepEqual(h.wanted.map(w => w.kind).sort(), ["page", "refs", "refs"]);
  const page = (seed, n, end) => SB.result(end ? "current" : "partial", { commits: Array.from({ length: n }, (_, i) => row(seed + i, [seed + (i + 1)])), end }, {});
  live.set(K.page(REPO, HEAD, 1), page("p", 100, false));
  live.set(K.refs(REPO, "branches"), SB.result("current", { refs: [{ name: "main", sha: HEAD, protected: true }, { name: "dev", sha: sha("dev2"), protected: false }] }, {}));
  live.set(K.refs(REPO, "tags"), SB.result("empty", null, {}));
  h = SB.historyView(get, REPO, HEAD, 1, new Set());
  assert.equal(h.more, true, "a full page offers older commits");
  assert.equal(h.end, false);
  assert.deepEqual(h.compared[0].cmp.data, { status: "identical", ahead: 0, behind: 0, base: HEAD }, "the read commit's own branch needs no request");
  assert.deepEqual(h.wanted, [{ kind: "compare", head: sha("dev2") }]);
  live.set(K.compare(REPO, HEAD, sha("dev2")), SB.result("current", { status: "diverged", ahead: 5, behind: 1, base: sha("p1") }, {}));
  h = SB.historyView(get, REPO, HEAD, 1, new Set());
  assert.deepEqual(h.wanted, [{ kind: "lane", head: sha("dev2"), page: 1 }]);
  live.set(K.lane(REPO, sha("dev2")), SB.result("current", { commits: [row("dev2", ["dev1"]), row("dev1", ["p1"]), row("p1", ["p2"])], end: false }, {}));
  h = SB.historyView(get, REPO, HEAD, 1, new Set());
  assert.deepEqual(h.compared[1].commits.map(c => c.sha), [sha("dev2"), sha("dev1")], "a branch's own commits stop at the history already read");
  assert.equal(h.compared[1].unread, 3, "GitHub counts 5 ahead; 2 were read");
  assert.deepEqual(h.wanted, [], "a branch whose own commits all reach the history read asks for no more of them");
  assert.equal(h.graph.rows.length, 102);
  // Two pages asked for: the second is wanted, then a failure stops the history there and says so.
  h = SB.historyView(get, REPO, HEAD, 2, new Set());
  assert.deepEqual(h.wanted, [{ kind: "page", page: 2 }]);
  live.set(K.page(REPO, HEAD, 2), SB.result("rate-limited", null, {}, { error: "HTTP 429" }));
  h = SB.historyView(get, REPO, HEAD, 2, new Set());
  assert.equal(h.main.length, 100);
  assert.equal(h.error.state, "rate-limited");
  assert.equal(h.more, false, "a failed page offers no older commits on top of it");
  live.set(K.page(REPO, HEAD, 2), page("q", 7, true));
  h = SB.historyView(get, REPO, HEAD, 2, new Set());
  assert.equal(h.end, true);
  assert.equal(h.main.length, 107);
  // Pages go on as far as they are asked for: there is no last page.
  for (let p = 2; p <= 14; p++) live.set(K.page(REPO, HEAD, p), page("d" + p + "-", p < 14 ? 100 : 5, p === 14));
  h = SB.historyView(get, REPO, HEAD, 13, new Set());
  assert.deepEqual([h.main.length, h.more, h.end], [1300, true, false], "thirteen pages read and more offered");
  h = SB.historyView(get, REPO, HEAD, 14, new Set());
  assert.deepEqual([h.main.length, h.more, h.end], [1305, false, true]);
});

test("a branch's own commits are read page after page until they reach the history read", () => {
  const K = SB.historyKey, live = new Map(), get = k => live.get(k);
  live.set(K.page(REPO, HEAD, 1), SB.result("current", { commits: [Object.assign(row("head", [sha("base")]), { sha: HEAD }), row("base", [])], end: true }, {}));
  live.set(K.refs(REPO, "branches"), SB.result("current", { refs: [{ name: "long", sha: sha("b0"), protected: false }] }, {}));
  live.set(K.refs(REPO, "tags"), SB.result("empty", null, {}));
  live.set(K.compare(REPO, HEAD, sha("b0")), SB.result("current", { status: "diverged", ahead: 150, behind: 1, base: sha("base") }, {}));
  const lanePage = (from, n, end) => SB.result(end ? "current" : "partial", { commits: Array.from({ length: n }, (_, i) =>
    row("b" + (from + i), [from + i === 149 ? "base" : "b" + (from + i + 1)])), end }, {});
  live.set(K.lane(REPO, sha("b0"), 1), lanePage(0, 100, false));
  let h = SB.historyView(get, REPO, HEAD, 1, new Set());
  assert.deepEqual(h.wanted, [{ kind: "lane", head: sha("b0"), page: 2 }], "its commits go on past the first page");
  assert.deepEqual([h.compared[0].commits.length, h.compared[0].unread], [100, 50]);
  live.set(K.lane(REPO, sha("b0"), 2), lanePage(100, 100, false));
  h = SB.historyView(get, REPO, HEAD, 1, new Set());
  assert.deepEqual(h.wanted, [], "once all 150 are read, no more is asked for");
  assert.deepEqual([h.compared[0].commits.length, h.compared[0].unread], [150, 0]);
  assert.equal(h.graph.rows.length, 152);
});

test("a branch ahead whose own commits fail, are refused or come back empty keeps its counts and says why it has no lane", () => {
  const K = SB.historyKey;
  const base = () => {
    const live = new Map();
    live.set(K.page(REPO, HEAD, 1), SB.result("current", { commits: [row("head", [])].map(c => Object.assign(c, { sha: HEAD })), end: true }, {}));
    live.set(K.refs(REPO, "branches"), SB.result("current", { refs: [{ name: "dev", sha: sha("dev2"), protected: false }] }, {}));
    live.set(K.refs(REPO, "tags"), SB.result("empty", null, {}));
    live.set(K.compare(REPO, HEAD, sha("dev2")), SB.result("current", { status: "diverged", ahead: 4, behind: 1, base: sha("base") }, {}));
    return live;
  };
  for (const state of ["failed", "denied", "rate-limited", "invalid"]) {
    const live = base();
    live.set(K.lane(REPO, sha("dev2")), SB.result(state, null, {}, { error: "synthetic" }));
    const h = SB.historyView(k => live.get(k), REPO, HEAD, 1, new Set());
    const x = h.compared[0];
    assert.equal(x.lane.state, state);
    assert.deepEqual(x.cmp.data, { status: "diverged", ahead: 4, behind: 1, base: sha("base") }, state + ": the comparison is kept");
    assert.deepEqual([x.commits, x.unread], [[], 4], state + ": none of its commits read");
    assert.equal(h.graph.rows.length, 1, state + ": no lane is drawn for it");
    assert.deepEqual(h.wanted, [], state + ": a finished read is not asked for again");
  }
  // Zero rows: the read succeeds but has none of the branch's own commits.
  for (const lane of [SB.result("empty", { commits: [], end: true }, {}), SB.result("current", { commits: [row("base", [])], end: true }, {})]) {
    const live = base();
    live.set(K.lane(REPO, sha("dev2")), lane);
    const x = SB.historyView(k => live.get(k), REPO, HEAD, 1, new Set()).compared[0];
    assert.deepEqual([x.lane.state, x.commits.length, x.unread], [lane.state, 0, 4]);
  }
  const live = base();
  assert.equal(SB.historyView(k => live.get(k), REPO, HEAD, 1, new Set()).compared[0].lane.state, "loading", "a lane not read yet says it is loading");
});

test("the weekly and daily counts build only the weeks and days shown, however far apart the dates are", () => {
  for (const [a, b] of [["1900-01-01T00:00:00Z", "2100-12-31T00:00:00Z"], ["1970-01-01T00:00:00Z", "9999-12-31T23:59:59Z"],
                        ["-271821-04-20T00:00:00Z", "+275760-09-13T00:00:00Z"]]) {
    const t = SB.commitTimes([row("new", [], b), row("old", [], a)]);
    assert.equal(t.weeks.length, SB.WEEKS_SHOWN, a + " to " + b);
    assert.equal(t.days.length, SB.DAYS_SHOWN);
    assert.equal(t.weeks.reduce((n, w) => n + w.n, 0) + t.days.reduce((n, d) => n + d.n, 0), 2, "only the newest commit is inside both windows");
    assert.equal(t.days[t.days.length - 1].day, t.to);
    assert.ok(t.weekSpan > 10000 && t.daySpan > 70000, "the whole window is still counted, not built");
    assert.deepEqual([t.from, t.to], [SB.commitTimes([row("x", [], a)]).from, SB.commitTimes([row("x", [], b)]).to]);
  }
  const t = SB.commitTimes([row("a", [], "2026-01-07T10:00:00Z"), row("b", [], "2025-01-07T10:00:00Z")]);
  assert.deepEqual(t.weeks.map(w => w.n), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], "weeks with none read count 0 inside the window");
  assert.equal(t.weekSpan, 53);
  assert.equal(t.daySpan, 366);
});

test("only the first branches are compared until the owner asks for another", () => {
  const branches = Array.from({ length: 12 }, (_, i) => ({ name: "b" + i, sha: sha(i), protected: false }));
  assert.equal(SB.comparedBranches(REPO, branches, new Set()).length, SB.COMPARE_FIRST);
  assert.deepEqual(SB.comparedBranches(REPO, branches, new Set([REPO + "|b11"])).map(b => b.name).slice(-1), ["b11"]);
  assert.equal(SB.comparedBranches("other/repo", branches, new Set([REPO + "|b11"])).length, SB.COMPARE_FIRST, "a request is for its own repository");
});

test("weeks start on Monday and count only inside the commits read; logins are counted, the rest only counted", () => {
  const t = SB.commitTimes([row("a", [], "2026-01-07T10:00:00Z"), row("b", [], "2026-01-05T00:30:00Z"), row("c", [], "2025-12-28T23:00:00Z"),
                            Object.assign(row("d", []), { at: null })]);
  assert.deepEqual(t.weeks, [{ week: "2025-12-22", n: 1 }, { week: "2025-12-29", n: 0 }, { week: "2026-01-05", n: 2 }]);
  assert.equal(t.days.length, 11);
  assert.equal(t.untimed, 1);
  assert.deepEqual([t.from, t.to], ["2025-12-28", "2026-01-07"]);
  assert.deepEqual([t.weekSpan, t.daySpan], [3, 11]);
  assert.deepEqual(SB.commitTimes([]).weeks, []);
  const c = SB.contributors([row("a", [], null, "agent-b"), row("b", [], null, "agent-a"), row("c", [], null, "agent-b"), row("d", [])]);
  assert.deepEqual(c.logins, [{ login: "agent-b", n: 2 }, { login: "agent-a", n: 1 }]);
  assert.equal(c.unlinked, 1);
});
