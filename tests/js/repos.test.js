"use strict";
// The repository overview: metadata, language, commit and comment readers, and the portfolio,
// analytics and activity feed worked out from them. Synthetic repositories only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, json, sha, WEB } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();
const REPO = "acme/garden";

function setup(overrides = [], repos = F.planRepos()) {
  const gh = mockGitHub(repos, overrides);
  const session = SB.createSession();
  return { gh, client: SB.createClient(session, gh.fetch), ctx: session.start("synthetic-token") };
}
const commit = (seed, title, at, parents = 1) => ({ sha: sha(seed), commit: { message: title + "\n\nbody", committer: { date: at } }, parents: Array(parents).fill({}) });

test("only the overview's exact read paths are allowed", () => {
  const C = sha("c");
  for (const ok of ["/repos/a/b/languages", "/repos/a/b/commits?sha=" + C + "&per_page=30",
                    "/repos/a/b/issues/comments?sort=created&direction=desc&per_page=50"]) assert.ok(SB.allowed(ok), ok);
  for (const bad of ["/repos/a/b/languages?x=1", "/repos/a/b/commits?sha=main&per_page=30", "/repos/a/b/commits?sha=" + C + "&per_page=100",
                     "/repos/a/b/issues/comments", "/repos/a/b/issues/comments?sort=updated&direction=desc&per_page=50",
                     "/repos/a/b/contributors", "/users/a/events", "/user/repos", "/repos/a/b/stats/commit_activity"]) assert.ok(!SB.allowed(bad), bad);
});

test("repository metadata is kept field by field; a malformed field is not given, never zero", () => {
  const m = SB.repoMeta({ private: true, fork: false, archived: true, language: "Go", topics: ["cli", "x"], license: null,
                          stargazers_count: 3, forks_count: 0, open_issues_count: 1, size: 20, created_at: "2025-01-01T00:00:00Z",
                          pushed_at: "2026-01-01T00:00:00Z", description: "<b>hi</b>", homepage: "javascript:alert(1)", default_branch: "main" });
  assert.deepEqual(m, { description: "<b>hi</b>", visibility: "private", fork: false, archived: true, language: "Go", topics: ["cli", "x"],
                        license: "none", branch: "main", stars: 3, forks: 0, issues: 1, size: 20, created: "2025-01-01T00:00:00Z",
                        pushed: "2026-01-01T00:00:00Z", homepage: "javascript:alert(1)" });
  const bad = SB.repoMeta({ visibility: "secret", stargazers_count: -1, forks_count: 1.5, topics: ["Bad Topic"], license: { spdx_id: 7 },
                            created_at: "soon", fork: "no" });
  assert.equal(bad.visibility, null);
  for (const k of ["stars", "forks", "topics", "license", "created", "fork", "language", "pushed"]) assert.equal(bad[k], null, k);
});

test("pinning keeps the metadata with the commit", async () => {
  const { client, ctx } = setup();
  const r = await client.pin(ctx, REPO, null);
  assert.equal(r.state, "current");
  assert.equal(r.data.meta.visibility, "private");
  assert.equal(r.data.meta.stars, null);  // the mock gives no counts: not given, not zero
});

test("languages are read as bytes, largest first; empty, invalid and denied stay apart", async () => {
  let s = setup([[/languages$/, () => json({ CSS: 10, Go: 90, Shell: 10 })]]);
  let r = await SB.readLanguages(s.ctx, s.client, REPO);
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.languages.map(l => l.name), ["Go", "CSS", "Shell"]);
  s = setup([[/languages$/, () => json({})]]);
  assert.equal((await SB.readLanguages(s.ctx, s.client, REPO)).state, "empty");
  for (const body of [{ Go: -1 }, { Go: "9" }, [], { "": 3 }]) {
    s = setup([[/languages$/, () => json(body)]]);
    assert.equal((await SB.readLanguages(s.ctx, s.client, REPO)).state, "invalid", JSON.stringify(body));
  }
  s = setup([[/languages$/, () => json({ message: "no" }, 403)]]);
  assert.equal((await SB.readLanguages(s.ctx, s.client, REPO)).state, "denied");
});

test("commits are read at the pinned commit; a full page is partial; a malformed one is invalid", async () => {
  const C = sha("code-main");
  let seen;
  let s = setup([[/commits\?sha=/, p => { seen = p; return json([commit("a", "Two", "2026-01-02T00:00:00Z", 2), commit("b", "One", "2026-01-01T00:00:00Z")]); }]]);
  let r = await SB.readCommits(s.ctx, s.client, REPO, C);
  assert.equal(seen, "/repos/" + REPO + "/commits?sha=" + C + "&per_page=30");
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.commits[0], { sha: sha("a"), title: "Two", at: "2026-01-02T00:00:00Z", parents: 2 });
  s = setup([[/commits\?sha=/, () => json(Array.from({ length: 30 }, (_, i) => commit("c" + i, "C", "2026-01-01T00:00:00Z")))]]);
  r = await SB.readCommits(s.ctx, s.client, REPO, C);
  assert.equal(r.state, "partial");
  s = setup([[/commits\?sha=/, () => json([{ sha: "abc", commit: { message: "x" } }])]]);
  assert.equal((await SB.readCommits(s.ctx, s.client, REPO, C)).state, "invalid");
  assert.equal((await SB.readCommits(s.ctx, s.client, REPO, "main")).state, "invalid");
});

test("repository comments carry their number; without the permission they are unavailable, not empty", async () => {
  const c = (n, body, at) => ({ issue_url: "https://api.github.com/repos/" + REPO + "/issues/" + n, body, created_at: at });
  let s = setup([[/issues\/comments/, () => json([c(4, "hi", "2026-01-01T00:00:00Z")])]]);
  let r = await SB.readRepoComments(s.ctx, s.client, REPO);
  assert.deepEqual(r.data.comments, [{ number: 4, body: "hi", at: "2026-01-01T00:00:00Z" }]);
  s = setup([[/issues\/comments/, () => json({ message: "no" }, 403)]]);
  assert.equal((await SB.readRepoComments(s.ctx, s.client, REPO)).state, "unavailable");
  s = setup([[/issues\/comments/, () => json({ message: "wait" }, 403, { "x-ratelimit-remaining": "0" })]]);
  assert.equal((await SB.readRepoComments(s.ctx, s.client, REPO)).state, "rate-limited");
  s = setup([[/issues\/comments/, () => json(Array.from({ length: 50 }, () => c(1, "x", null)))]]);
  assert.equal((await SB.readRepoComments(s.ctx, s.client, REPO)).state, "partial");
  s = setup([[/issues\/comments/, () => json([{ issue_url: "https://api.github.com/repos/x/y/pulls/1", body: "x" }])]]);
  assert.equal((await SB.readRepoComments(s.ctx, s.client, REPO)).state, "invalid");
});

test("the account read gives only a login and its type", async () => {
  let s = setup();
  assert.deepEqual((await SB.readUser(s.ctx, s.client)).data, { login: "synthetic-user", type: null });
  s = setup([[/^\/user$/, () => json({ login: "bad login" })]]);
  assert.equal((await SB.readUser(s.ctx, s.client)).state, "invalid");
});

test("the token's list of repositories is read by name, page by page, up to nine pages", async () => {
  for (const ok of ["/user/repos?per_page=100&page=1", "/user/repos?per_page=100&page=9"]) assert.ok(SB.allowed(ok), ok);
  for (const bad of ["/user/repos?per_page=100&page=10", "/user/repos?per_page=100&page=0", "/user/repos?per_page=50&page=1",
                     "/user/repos?per_page=100&page=1&visibility=all", "/users/a/repos?per_page=100&page=1"]) assert.ok(!SB.allowed(bad), bad);
  const names = n => Array.from({ length: n }, (_, i) => ({ full_name: "acme/r" + String(i).padStart(4, "0"), private: true }));
  let s = setup([[/^\/user\/repos/, () => json([{ full_name: "acme/zeta" }, { full_name: "acme/alpha" }])]]);
  let r = await SB.readAccountRepos(s.ctx, s.client);
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.repos, ["acme/alpha", "acme/zeta"]);
  // A full page asks for the next one; a shorter one is the end.
  const all = names(150);
  s = setup([[/^\/user\/repos\?per_page=100&page=(\d)$/, p => json(all.slice((Number(p.slice(-1)) - 1) * 100, Number(p.slice(-1)) * 100))]]);
  r = await SB.readAccountRepos(s.ctx, s.client);
  assert.equal(r.data.repos.length, 150);
  assert.equal(s.gh.calls.length, 2);
  // Nine full pages: the list is partial, and no tenth page is asked for.
  s = setup([[/^\/user\/repos/, p => json(names(100).map(x => ({ full_name: x.full_name + "-" + p.slice(-1) })))]]);
  r = await SB.readAccountRepos(s.ctx, s.client);
  assert.equal(r.state, "partial");
  assert.equal(r.data.repos.length, 900);
  assert.equal(s.gh.calls.length, 9);
  s = setup([[/^\/user\/repos/, () => json([])]]);
  assert.equal((await SB.readAccountRepos(s.ctx, s.client)).state, "empty");
  s = setup([[/^\/user\/repos/, () => json([{ full_name: "not a name" }])]]);
  assert.equal((await SB.readAccountRepos(s.ctx, s.client)).state, "invalid");
  s = setup([[/^\/user\/repos/, () => json({ message: "no" }, 403)]]);
  r = await SB.readAccountRepos(s.ctx, s.client);
  assert.equal(r.state, "denied");
  assert.ok(r.data == null);
});

test("only an owner, or nothing, at sign-in finds the plan repository by its workspace list file", async () => {
  const repos = F.planRepos();
  const OTHER = sha("beta-plan");
  repos["beta/other-plan"] = { default_branch: "main", branches: { main: OTHER }, files: { [OTHER]: { [SB.WORKSPACES_FILE]: "{}" } } };
  const token = list => [[/^\/user\/repos/, () => json(list.map(full_name => ({ full_name })))]];
  const all = ["acme/garden", "acme/garden-plan", "acme/recipes", "beta/other-plan"];
  const whole = { unchecked: [], listedAll: true, underLimit: true, complete: true };
  // The owner's repositories only, in any case; a repository without the file is not a plan, whatever its name.
  let s = setup(token(all), repos);
  let r = await SB.findPlanRepos(s.ctx, s.client, "ACME");
  assert.equal(r.state, "current");
  assert.deepEqual(r.data, Object.assign({ repos: ["acme/garden-plan"], checked: 3 }, whole));
  assert.ok(!s.gh.calls.some(c => c.url.includes("/beta/")), "another owner's repository is not read");
  assert.ok(s.gh.calls.every(c => (c.init.method || "GET") === "GET"));
  // Nothing given: every repository the token reads is checked, and two with the file are both returned.
  s = setup(token(all), repos);
  assert.deepEqual((await SB.findPlanRepos(s.ctx, s.client, "")).data.repos, ["acme/garden-plan", "beta/other-plan"]);
  s = setup(token(all), repos);
  r = await SB.findPlanRepos(s.ctx, s.client, "nobody");
  assert.equal(r.state, "empty");
  assert.deepEqual(r.data, Object.assign({ repos: [], checked: 0 }, whole));
  // Not found (404) and a repository with no commits (409) have no list; the search stays complete.
  const absent = [[/^\/repos\/acme\/gone$/, () => json({ message: "Not Found" }, 404)],
                  [/^\/repos\/acme\/blank$/, () => json({ full_name: "acme/blank", default_branch: "main" })],
                  [/^\/repos\/acme\/blank\/commits\//, () => json({ message: "Git Repository is empty." }, 409)]];
  s = setup(token(["acme/garden-plan", "acme/gone", "acme/blank", "acme/garden"]).concat(absent), repos);
  r = await SB.findPlanRepos(s.ctx, s.client, "acme");
  assert.deepEqual(r.data, Object.assign({ repos: ["acme/garden-plan"], checked: 4 }, whole));
  // A repository whose metadata, commit or file cannot be read is unchecked, never taken as having no list.
  const fail = (re, status, headers) => [re, () => json({ message: "no" }, status, headers || {})];
  for (const [what, override] of [["metadata denied", fail(/^\/repos\/acme\/garden$/, 403)],
                                  ["metadata rate-limited", fail(/^\/repos\/acme\/garden$/, 429)],
                                  ["metadata failed", fail(/^\/repos\/acme\/garden$/, 500)],
                                  ["commit failed", fail(/^\/repos\/acme\/garden\/commits\//, 500)],
                                  ["file denied", fail(/^\/repos\/acme\/garden\/contents\//, 403)],
                                  ["file not valid", [/^\/repos\/acme\/garden\/contents\//, () => json({ type: "dir" })]]]) {
    s = setup(token(["acme/garden-plan", "acme/garden"]).concat([override]), repos);
    r = await SB.findPlanRepos(s.ctx, s.client, "acme");
    assert.deepEqual(r.data, { repos: ["acme/garden-plan"], checked: 2, unchecked: ["acme/garden"], listedAll: true, underLimit: true, complete: false }, what);
  }
  // At most FIND_LIMIT are checked; one found among them is not complete.
  const many = Array.from({ length: SB.FIND_LIMIT + 10 }, (_, i) => "acme/r" + String(i).padStart(3, "0"));
  s = setup(token(["acme/garden-plan"].concat(many)), repos);
  r = await SB.findPlanRepos(s.ctx, s.client, "acme");
  assert.deepEqual(r.data, { repos: ["acme/garden-plan"], checked: SB.FIND_LIMIT, unchecked: [], listedAll: true, underLimit: false, complete: false });
  assert.equal(s.gh.calls.filter(c => /\/repos\/acme\/r\d+$/.test(c.url)).length, SB.FIND_LIMIT - 1);
  // A token list longer than can be read (nine full pages) is not complete either.
  s = setup([[/^\/user\/repos\?per_page=100&page=(\d)$/, p => json(p.endsWith("=1") ? [{ full_name: "acme/garden-plan" }].concat(Array.from({ length: 99 }, (_, i) => ({ full_name: "zed/p1-" + i })))
                                                                     : Array.from({ length: 100 }, (_, i) => ({ full_name: "zed/p" + p.slice(-1) + "-" + i })))]], repos);
  r = await SB.findPlanRepos(s.ctx, s.client, "acme");
  assert.deepEqual(r.data, { repos: ["acme/garden-plan"], checked: 1, unchecked: [], listedAll: false, underLimit: true, complete: false });
  // A token list that cannot be read is said as such; a revoked token ends the session.
  s = setup([[/^\/user\/repos/, () => json({ message: "no" }, 403)]], repos);
  assert.equal((await SB.findPlanRepos(s.ctx, s.client, "acme")).state, "denied");
  s = setup([[/^\/user\/repos/, () => json({ message: "Bad credentials" }, 401)]], repos);
  await assert.rejects(SB.findPlanRepos(s.ctx, s.client, "acme"), SB.Revoked);
  s = setup(token(["acme/garden-plan", "acme/garden"]).concat([[/^\/repos\/acme\/garden$/, () => json({ message: "Bad credentials" }, 401)]]), repos);
  await assert.rejects(SB.findPlanRepos(s.ctx, s.client, "acme"), SB.Revoked);
});

test("the workspace list may give the plan files a found repository is read with", () => {
  const doc = found => Object.assign(F.workspacesDoc(), found === undefined ? {} : { found });
  assert.equal(SB.validateWorkspaces(doc()), null);
  assert.equal(SB.validateWorkspaces(doc({ files: F.FILES })), null);
  assert.equal(SB.validateWorkspaces(doc({ files: Object.assign({ brief: "notes/{id}.md" }, F.FILES) })), null);
  for (const bad of [null, {}, { files: { table: "plan/tasks.md" } }, { files: Object.assign({ extra: "x.md" }, F.FILES) },
                     { files: Object.assign({}, F.FILES, { table: "../x.md" }) }, { files: F.FILES, more: 1 }]) {
    assert.equal(SB.validateWorkspaces(doc(bad)), "bad found plan files", JSON.stringify(bad));
  }
});

test("an activity feed reads one page of pull requests", async () => {
  const s = setup();
  await SB.readPulls(s.ctx, s.client, REPO, 1);
  assert.equal(s.gh.calls.filter(x => /pulls/.test(x.url)).length, 1);
});

// ---- Portfolio, analytics and feed

const meta = over => Object.assign(SB.repoMeta({ private: false, fork: false, archived: false, language: "Go", topics: [], license: null,
  stargazers_count: 1, forks_count: 0, open_issues_count: 0, size: 10, created_at: "2025-01-01T00:00:00Z", pushed_at: "2025-06-01T00:00:00Z",
  default_branch: "main" }), over);
const pinned = m => SB.result("current", { commit: sha("x"), ref: "main", web: WEB + "/x", meta: m }, {});
function entries() {
  return [
    { w: { id: "a", label: "A", kind: "project", plan: { repo: "o/a-plan" }, code: [{ repo: "o/app", role: "app" }] },
      plan: pinned(meta({ language: "Python", stars: 5 })), code: [{ pinned: pinned(meta({ fork: true, stars: null, created: "2024-03-01T00:00:00Z" })) }] },
    { w: { id: "b", label: "B", kind: "standalone", plan: null, code: [{ repo: "o/app", role: "site" }, { repo: "o/locked", role: "app" }] },
      code: [{ pinned: pinned(meta({})) }, { pinned: SB.result("denied", null, {}) }] },
  ];
}

test("the portfolio lists each mapped repository once, with every project and role", () => {
  const rows = SB.portfolio(entries());
  assert.deepEqual(rows.map(r => r.repo), ["o/a-plan", "o/app", "o/locked"]);
  assert.deepEqual(rows[1].projects.map(p => p.id + ":" + p.role), ["a:app", "b:site"]);
  assert.equal(rows[2].meta, null);
});

test("filters choose rows and change no value; an unreadable repository shows only under a name search", () => {
  const rows = SB.portfolio(entries());
  const before = JSON.stringify(rows);
  assert.deepEqual(SB.filterPortfolio(rows, { type: "fork" }).map(r => r.repo), ["o/app"]);
  assert.deepEqual(SB.filterPortfolio(rows, { language: "Python" }).map(r => r.repo), ["o/a-plan"]);
  assert.deepEqual(SB.filterPortfolio(rows, { q: "lock" }).map(r => r.repo), ["o/locked"]);
  assert.deepEqual(SB.filterPortfolio(rows, { visibility: "public" }).map(r => r.repo), ["o/a-plan", "o/app"]);
  assert.equal(JSON.stringify(rows), before);
  // Unknown values sort last, never as zero.
  assert.deepEqual(SB.sortPortfolio(rows, "stars").map(r => r.repo), ["o/a-plan", "o/app", "o/locked"]);
});

test("analytics count only what GitHub gave, and say over how many", () => {
  const a = SB.analytics(SB.portfolio(entries()));
  assert.equal(a.mapped, 3);
  assert.equal(a.read, 2);
  assert.deepEqual(a.counters.stars, { total: 5, known: 1 });
  assert.equal(a.counters.fork, 1);
  assert.deepEqual(a.years.map(y => [y.year, y.original, y.fork]), [[2024, 0, 1], [2025, 1, 0]]);
  assert.deepEqual(a.composition.license, [{ value: "none", n: 2 }]);
  const lb = SB.languageBytes([SB.result("current", { languages: [{ name: "Go", bytes: 3 }] }, {}), SB.result("denied", null, {})]);
  assert.deepEqual([lb.read, lb.total, lb.bytes], [1, 2, 3]);
});

test("the feed is newest first, links each event to its origin, and counts what it cannot place", () => {
  const H = sha("head");
  const res = (state, data) => SB.result(state, data, {});
  const f = SB.feedEvents([{ repo: "o/app", web: WEB + "/o/app",
    commits: res("current", { commits: [{ sha: H, title: "Merge", at: "2026-01-03T00:00:00Z", parents: 2 }] }),
    pulls: res("current", { pulls: [{ number: 2, title: "T", state: "closed", merged: "2026-01-02T00:00:00Z", created: "2026-01-01T00:00:00Z", closed: "2026-01-02T00:00:00Z" },
                                    { number: 3, title: "U", state: "open", merged: null, created: null, closed: null }] }),
    comments: res("current", { comments: [{ number: 2, body: "FROM: A\nSTATE: REVIEW PASSED\nHEAD: " + H, at: "2026-01-04T00:00:00Z" },
                                          { number: 9, body: "FROM: A\nSTATE: BLOCKED\nHEAD: none", at: "2026-01-00" }, { number: 2, body: "thanks", at: "2026-01-05T00:00:00Z" }] }) }]);
  assert.deepEqual(f.events.map(e => e.kind), ["handoff", "commit", "merged", "opened"]);
  assert.equal(f.events[0].href, WEB + "/o/app/pull/2");
  assert.equal(f.events[1].href, WEB + "/o/app/commit/" + H);
  assert.ok(f.events[1].merge);
  assert.equal(f.other, 1);
  assert.equal(f.untimed, 2);  // the open pull request with no creation time, and a comment with an unreadable one
  const none = SB.feedEvents([{ repo: "o/x", web: null, commits: res("current", { commits: [{ sha: H, title: "c", at: "2026-01-01T00:00:00Z" }] }) }]);
  assert.equal(none.events[0].href, null);
});

// ---- Unknown is not none; a feed belongs to one pinned commit; undatable events are disclosed

test("a main language GitHub says is none differs from one it did not give or gave malformed", () => {
  assert.equal(SB.repoMeta({ language: null }).language, "none");
  assert.equal(SB.repoMeta({}).language, null);
  assert.equal(SB.repoMeta({ language: 7 }).language, null);
  assert.equal(SB.repoMeta({ language: "  " }).language, null);
  assert.equal(SB.repoMeta({}).visibility, null);
  assert.equal(SB.repoMeta({ visibility: "secret" }).visibility, null);
});

test("unknown visibility, type and language are counted and filtered apart from known values", () => {
  const e = (id, m) => ({ w: { id, label: id, kind: "standalone", plan: null, code: [{ repo: "o/" + id, role: "app" }] }, code: [{ pinned: pinned(m) }] });
  const rows = SB.portfolio([e("go", meta({})), e("none", meta({ language: "none" })),
    e("unknown", meta({ language: null, visibility: null, fork: null })), e("bad", SB.repoMeta({ language: 3, private: "yes" }))]);
  const a = SB.analytics(rows);
  assert.deepEqual(a.languages.map(l => [l.value, l.n]), [[null, 2], ["Go", 1], ["none", 1]]);
  assert.equal(a.counters.public, 2);
  assert.equal(a.counters.visibilityKnown, 2);
  assert.equal(a.counters.typeKnown, 2);
  const o = SB.portfolioOptions(rows);
  assert.deepEqual(o.languages, ["Go"]);
  assert.equal(o.noLanguage, true);
  assert.deepEqual(o.unknown, { visibility: true, language: true, type: true });
  const pick = f => SB.filterPortfolio(rows, f).map(r => r.repo);
  assert.deepEqual(pick({ language: "-" }), ["o/none"]);
  assert.deepEqual(pick({ language: "?" }), ["o/unknown", "o/bad"]);
  assert.deepEqual(pick({ visibility: "?" }), ["o/unknown", "o/bad"]);
  assert.deepEqual(pick({ type: "?" }), ["o/unknown", "o/bad"]);
  assert.deepEqual(pick({ visibility: "public" }), ["o/go", "o/none"]);
});

test("the same repository at two pinned commits has two feeds", () => {
  assert.notEqual(SB.feedKey("o/app", sha("main")), SB.feedKey("o/app", sha("release")));
  assert.equal(SB.feedKey("o/app", sha("main")), SB.feedKey("o/app", sha("main")));
});

test("events with no readable time are counted, whether some or all of them are", () => {
  const src = commits => [{ repo: "o/app", web: WEB + "/app", ref: "main", commits: SB.result("current", { commits }, {}),
    pulls: SB.result("current", { pulls: [] }, {}), comments: SB.result("current", { comments: [] }, {}) }];
  const all = SB.feedEvents(src([{ sha: sha("a"), title: "One", at: null, parents: 1 }]));
  assert.equal(all.events.length, 0);
  assert.equal(all.untimed, 1);
  const mixed = SB.feedEvents(src([{ sha: sha("a"), title: "One", at: null, parents: 1 }, { sha: sha("b"), title: "Two", at: "2026-01-01T00:00:00Z", parents: 1 }]));
  assert.equal(mixed.events.length, 1);
  assert.equal(mixed.untimed, 1);
});
