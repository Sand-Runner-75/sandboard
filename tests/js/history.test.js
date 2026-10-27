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
  author: { name: "Real Name", email: "someone@example.invalid" } }, parents: parents.map(p => ({ sha: sha(p) })), author: author === undefined ? { login: "agent-a" } : author });
const row = (seed, parents, at, author) => ({ sha: sha(seed), title: seed, at: at || "2026-01-01T00:00:00Z", parents: parents.map(sha), author: author || null });

test("only the history's exact read paths are allowed, all of them reads", () => {
  const A = sha("a"), B = sha("b");
  for (const ok of ["/repos/a/b/commits?sha=" + A + "&per_page=100&page=1", "/repos/a/b/commits?sha=" + A + "&per_page=100&page=10",
                    "/repos/a/b/branches?per_page=100&page=3", "/repos/a/b/tags?per_page=100&page=1", "/repos/a/b/compare/" + A + "..." + B + "?per_page=1"]) {
    assert.equal(SB.allowed(ok), true, ok);
  }
  for (const bad of ["/repos/a/b/commits?sha=" + A + "&per_page=100&page=11", "/repos/a/b/commits?sha=main&per_page=100&page=1",
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
  assert.ok(!JSON.stringify(r).includes("Real Name") && !JSON.stringify(r).includes("example.invalid"), "no name or email is kept");
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
  for (const page of [0, 11, 1.5]) assert.equal((await SB.readHistoryPage(s.ctx, s.client, REPO, HEAD, page)).state, "invalid");
  assert.equal(s.gh.calls.length, 1, "a page out of bounds is never requested");
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
  assert.deepEqual(h.wanted, [{ kind: "lane", head: sha("dev2") }]);
  live.set(K.lane(REPO, sha("dev2")), SB.result("current", { commits: [row("dev2", ["dev1"]), row("dev1", ["p1"]), row("p1", ["p2"])], end: false }, {}));
  h = SB.historyView(get, REPO, HEAD, 1, new Set());
  assert.deepEqual(h.compared[1].commits.map(c => c.sha), [sha("dev2"), sha("dev1")], "a branch's own commits stop at the history already read");
  assert.equal(h.compared[1].unread, 3, "GitHub counts 5 ahead; 2 were read");
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
  assert.deepEqual(SB.commitTimes([]).weeks, []);
  const c = SB.contributors([row("a", [], null, "agent-b"), row("b", [], null, "agent-a"), row("c", [], null, "agent-b"), row("d", [])]);
  assert.deepEqual(c.logins, [{ login: "agent-b", n: 2 }, { login: "agent-a", n: 1 }]);
  assert.equal(c.unlinked, 1);
});
