"use strict";
// Work evidence: the readers for pull requests and their reviews, issues, Actions runs and releases,
// and what is worked out from them: pages read so far, reviews at the head, a run's outcome and the
// inbox. Synthetic repositories only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, sha } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();
const REPO = "acme/garden";

function setup(extra = {}, overrides = []) {
  const repos = F.planRepos();
  Object.assign(repos[REPO], extra);
  const gh = mockGitHub(repos, overrides);
  const session = SB.createSession();
  return { gh, client: SB.createClient(session, gh.fetch), ctx: session.start("synthetic-token") };
}
const pull = (n, extra = {}) => Object.assign({ number: n, title: "Pull " + n, state: "open", draft: false, merged_at: null, head: { sha: sha("head-" + n), ref: "topic-" + n },
  base: { ref: "main" }, user: { login: "agent-a" }, requested_reviewers: [], requested_teams: [], created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z", closed_at: null, body: "x" }, extra);
const issue = (n, extra = {}) => Object.assign({ number: n, title: "Issue " + n, state: "open", state_reason: null, user: { login: "agent-b" },
  labels: [{ name: "bug" }], assignees: [], comments: 0, created_at: "2026-01-01T00:00:00Z", closed_at: null }, extra);
const run = (id, status, conclusion, extra = {}) => Object.assign({ id, name: "Tests", display_title: "Run " + id, run_number: id, event: "push",
  status, conclusion, head_branch: "main", head_sha: sha("run-" + id), actor: { login: "agent-a" },
  created_at: "2026-01-01T00:00:00Z", run_started_at: "2026-01-01T00:00:10Z", updated_at: "2026-01-01T00:02:10Z" }, extra);

test("only the work evidence's exact read paths are allowed, all of them reads", () => {
  for (const ok of ["/repos/a/b/pulls?state=open&per_page=100&page=1", "/repos/a/b/pulls?state=closed&per_page=100&page=9",
                    "/repos/a/b/pulls?state=all&per_page=100&page=2", "/repos/a/b/pulls/12/reviews?per_page=100&page=3",
                    "/repos/a/b/issues?state=all&per_page=100&page=1", "/repos/a/b/actions/runs?per_page=100&page=1",
                    "/repos/a/b/releases?per_page=100&page=4"]) {
    assert.equal(SB.allowed(ok), true, ok);
  }
  for (const bad of ["/repos/a/b/pulls?state=merged&per_page=100&page=1", "/repos/a/b/pulls?state=open&per_page=100&page=10",
                     "/repos/a/b/pulls/12/reviews?per_page=100&page=4", "/repos/a/b/pulls/12/merge", "/repos/a/b/pulls/12/files",
                     "/repos/a/b/issues?state=open&per_page=100&page=1&assignee=x", "/repos/a/b/issues?filter=assigned&per_page=100&page=1",
                     "/repos/a/b/actions/runs/5/rerun", "/repos/a/b/actions/runs/5/logs", "/repos/a/b/actions/artifacts",
                     "/repos/a/b/releases/assets/5", "/repos/a/b/releases/latest", "/repos/a/b/statuses/" + sha("x"),
                     "/notifications", "/user/issues", "/search/issues?q=x"]) {
    assert.equal(SB.allowed(bad), false, bad);
  }
});

test("a pull request page keeps logins, branches and draft; a full page may hold more", async () => {
  let s = setup({ work: { "/pulls?state=open&per_page=100&page=1": [pull(2, { draft: true, requested_reviewers: [{ login: "me" }, { login: "<b>" }],
    requested_teams: [{ slug: "t" }], user: { login: "agent-a", name: "Real Name" } })] } });
  let r = await SB.readPullPage(s.ctx, s.client, REPO, "open", 1);
  assert.equal(r.state, "current");
  assert.equal(r.data.end, true);
  const pr = r.data.pulls[0];
  assert.deepEqual([pr.draft, pr.headRef, pr.baseRef, pr.author, pr.reviewers, pr.teams], [true, "topic-2", "main", "agent-a", ["me"], 1]);
  assert.ok(!JSON.stringify(r).includes("Real Name"), "no name is kept");
  assert.equal(SB.pullState(pr), "draft");
  s = setup({ work: { "/pulls?state=all&per_page=100&page=1": Array.from({ length: 100 }, (_, i) => pull(i + 1)) } });
  r = await SB.readPullPage(s.ctx, s.client, REPO, "all", 1);
  assert.equal(r.state, "partial");
  assert.equal(r.data.end, false);
  s = setup({ work: { "/pulls?state=open&per_page=100&page=1": [pull(1, { head: { sha: "nope" } })] } });
  assert.equal((await SB.readPullPage(s.ctx, s.client, REPO, "open", 1)).state, "invalid");
  for (const [state, page] of [["merged", 1], ["open", 0], ["open", 10], [null, 1]]) {
    assert.equal((await SB.readPullPage(s.ctx, s.client, REPO, state, page)).state, "invalid", state + " " + page);
  }
  assert.equal(s.gh.calls.length, 1, "a list or page out of bounds is never requested");
});

test("reviews keep their own commit, and a token that cannot read them says so", async () => {
  const H = sha("head-4"), OLD = sha("old");
  let s = setup({ work: { "/pulls/4/reviews?per_page=100&page=1": [
    { state: "CHANGES_REQUESTED", commit_id: OLD, user: { login: "agent-b" }, submitted_at: "2026-01-01T00:00:00Z", body: "x" },
    { state: "APPROVED", commit_id: OLD, user: { login: "agent-c" }, submitted_at: "2026-01-02T00:00:00Z" },
    { state: "APPROVED", commit_id: H, user: { login: "agent-b" }, submitted_at: "2026-01-03T00:00:00Z" },
    { state: "COMMENTED", commit_id: null, user: null, submitted_at: null }] } });
  const r = await SB.readReviews(s.ctx, s.client, REPO, 4);
  assert.equal(r.state, "current");
  const e = SB.reviewEvidence({ head: H }, r.data.reviews);
  assert.deepEqual([e.approvedAtHead, e.changesAtHead, e.older, e.unknownCommit], [1, 0, 2, 1], "an approval at an older commit is not one of the head");
  assert.deepEqual(e.list.map(x => x.atHead), [false, false, true, false]);
  s = setup({ work: { "/pulls/4/reviews?per_page=100&page=1": 403 } });
  const denied = await SB.readReviews(s.ctx, s.client, REPO, 4);
  assert.equal(denied.state, "unavailable");
  assert.match(denied.error, /Pull requests: read/);
  s = setup({ work: { "/pulls/4/reviews?per_page=100&page=1": [{ state: "MERGED", commit_id: H }] } });
  assert.equal((await SB.readReviews(s.ctx, s.client, REPO, 4)).state, "invalid");
});

test("issues leave pull requests to their own list and keep the close reason", async () => {
  const s = setup({ work: { "/issues?state=all&per_page=100&page=1": [issue(9, { assignees: [{ login: "me" }], labels: ["plain", { name: "bug" }, { color: "x" }] }),
    issue(8, { pull_request: {} }), issue(7, { state: "closed", state_reason: "not_planned", closed_at: "2026-01-05T00:00:00Z" })] } });
  const r = await SB.readIssuePage(s.ctx, s.client, REPO, "all", 1);
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.issues.map(i => i.number), [9, 7]);
  assert.equal(r.data.pulls, 1);
  assert.deepEqual(r.data.issues[0].labels, ["plain", "bug"]);
  assert.equal(r.data.issues[1].reason, "not_planned");
  // A full page of GitHub's list may hold more, even when some of it was pull requests.
  const full = Array.from({ length: 100 }, (_, i) => issue(i + 1, i % 2 ? { pull_request: {} } : {}));
  const t = setup({ work: { "/issues?state=open&per_page=100&page=1": full } });
  const f = await SB.readIssuePage(t.ctx, t.client, REPO, "open", 1);
  assert.deepEqual([f.state, f.data.end, f.data.issues.length, f.data.pulls], ["partial", false, 50, 50]);
});

test("a run not finished is never a success, and a token without Actions access says so", async () => {
  let s = setup({ work: { "/actions/runs?per_page=100&page=1": { total_count: 340, workflow_runs: [run(3, "in_progress", null), run(2, "completed", "success"),
    run(1, "completed", "brand_new"), run(4, "completed", null)] } } });
  const r = await SB.readRunPage(s.ctx, s.client, REPO, 1);
  assert.equal(r.data.total, 340);
  const o = r.data.runs.map(SB.runOutcome);
  assert.deepEqual(o.map(x => [x.done, x.outcome]), [[false, "in_progress"], [true, "success"], [true, "other"], [true, "none"]]);
  assert.equal(o[0].ms, null, "a run still going has no duration");
  assert.equal(o[1].ms, 120000);
  assert.equal(r.data.runs[2].rawConclusion, "brand_new");
  assert.equal(SB.runOutcome({ status: "completed", conclusion: "success", started: "2026-01-02T00:00:00Z", updated: "2026-01-01T00:00:00Z" }).ms, null,
    "an end before the start gives no duration");
  for (const status of [403, 404]) {
    s = setup({ work: { "/actions/runs?per_page=100&page=1": status } });
    const d = await SB.readRunPage(s.ctx, s.client, REPO, 1);
    assert.equal(d.state, "unavailable");
    assert.match(d.error, /Actions: read/);
  }
  s = setup({ work: { "/actions/runs?per_page=100&page=1": 500 } });
  assert.equal((await SB.readRunPage(s.ctx, s.client, REPO, 1)).state, "failed");
  s = setup({ work: { "/actions/runs?per_page=100&page=1": { workflow_runs: [] } } });
  assert.equal((await SB.readRunPage(s.ctx, s.client, REPO, 1)).state, "invalid");
});

test("a release asset links only to GitHub's own download address for its repository", async () => {
  const asset = (name, url) => ({ name, size: 2048, download_count: 3, browser_download_url: url });
  const s = setup({ work: { "/releases?per_page=100&page=1": [
    { id: 2, tag_name: "v2", name: "Two", draft: true, prerelease: false, created_at: "2026-01-02T00:00:00Z", published_at: null, author: { login: "agent-a" },
      assets: [asset("app.zip", "https://example.invalid/app.zip"), asset("ok.zip", "https://github.com/acme/garden/releases/download/v2/ok.zip"),
               asset("other.zip", "https://github.com/acme/other/releases/download/v2/other.zip"), asset("http.zip", "http://github.com/acme/garden/releases/download/v2/http.zip"),
               asset("query.zip", "https://github.com/acme/garden/releases/download/v2/q.zip?token=x"), asset("user.zip", "https://x" + String.fromCharCode(64) + "github.com/acme/garden/releases/download/v2/u.zip"),
               asset("script.zip", "javascript:alert(1)"), asset("bare.zip", "https://github.com/acme/garden/releases/download/"), { name: "none.zip", size: 1 }] },
    { id: 1, tag_name: "v1", name: null, draft: false, prerelease: false, created_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z", author: null }] } });
  const r = await SB.readReleasePage(s.ctx, s.client, REPO, 1);
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.releases[0].assets[0], { name: "app.zip", size: 2048, downloads: 3, url: null });
  assert.deepEqual(r.data.releases[0].assets.filter(a => a.url).map(a => [a.name, a.url]),
    [["ok.zip", "https://github.com/acme/garden/releases/download/v2/ok.zip"]], "only this repository's GitHub download address, plain https");
  assert.ok(!JSON.stringify(r).includes("example.invalid"), "no other address is kept");
  assert.equal(r.data.releases[0].assets.at(-1).downloads, null);
  assert.equal(r.data.releases[1].author, null);
  const t = setup({ work: { "/releases?per_page=100&page=1": [{ id: 1, tag_name: "v1", draft: "no", prerelease: false }] } });
  assert.equal((await SB.readReleasePage(t.ctx, t.client, REPO, 1)).state, "invalid");
});

test("a list shows the pages read so far, asks for what is missing and never reads past its depth", () => {
  const live = new Map();
  const at = key => live.get(key);
  const K = (p, state = "open") => SB.workKey.list("pulls", REPO, state, p);
  let w = SB.workList(at, "pulls", REPO, "open", 1);
  assert.deepEqual([w.state, w.wanted], ["loading", [1]]);
  live.set(K(1), SB.result("partial", { pulls: [pull(1)].map(() => ({ number: 1 })), end: false }, {}));
  w = SB.workList(at, "pulls", REPO, "open", 1);
  assert.deepEqual([w.state, w.end, w.more, w.wanted], ["current", false, true, []], "older pages are read only when asked");
  w = SB.workList(at, "pulls", REPO, "open", 2);
  assert.deepEqual([w.wanted, w.items.length], [[2], 1]);
  live.set(K(2), SB.result("failed", null, {}, { error: "HTTP 500" }));
  w = SB.workList(at, "pulls", REPO, "open", 2);
  assert.deepEqual([w.state, w.error.state, w.more, w.items.length], ["current", "failed", false, 1], "a failed older page keeps what was read and says so");
  w = SB.workList(at, "pulls", REPO, "open", SB.MAX_WORK_PAGES);
  assert.equal(w.more, false);
  live.set(K(1, "closed"), SB.result("empty", { pulls: [], end: true }, {}));
  assert.equal(SB.workList(at, "pulls", REPO, "closed", 1).state, "empty");
  live.set(SB.workKey.list("issues", REPO, "all", 1), SB.result("denied", null, {}, { error: "HTTP 403" }));
  assert.equal(SB.workList(at, "issues", REPO, "all", 1).state, "denied");
});

test("the inbox lists the account's own work in the given repositories and says what it did not read", () => {
  const live = new Map();
  const ok = (pulls, end = true) => SB.result(end ? "current" : "partial", { pulls, end }, {});
  live.set(SB.workKey.list("pulls", "acme/a", "open", 1), ok([{ number: 1, author: "me", reviewers: [], teams: 0 },
    { number: 2, author: "other", reviewers: ["me"], teams: 1 }, { number: 3, author: "other", reviewers: [], teams: 2 }], false));
  live.set(SB.workKey.list("issues", "acme/a", "open", 1), SB.result("current", { issues: [{ number: 5, assignees: ["me", "x"] }, { number: 6, assignees: [] }], end: true }, {}));
  live.set(SB.workKey.list("pulls", "acme/b", "open", 1), SB.result("denied", null, {}, { error: "HTTP 403" }));
  live.set(SB.workKey.list("issues", "acme/b", "open", 1), { state: "loading" });
  const box = SB.inbox(key => live.get(key), ["acme/a", "acme/b", "acme/c"], "me");
  assert.deepEqual(box.mine.map(x => x.pr.number), [1]);
  assert.deepEqual(box.review.map(x => x.pr.number), [2]);
  assert.deepEqual(box.assigned.map(x => x.issue.number), [5]);
  assert.equal(box.teams, 2, "a review asked of a team is counted, not taken as asked of the account");
  assert.deepEqual(box.problems.map(p => p.repo + " " + p.kind), ["acme/b pulls"]);
  assert.deepEqual(box.partial.map(p => p.repo + " " + p.kind), ["acme/a pulls"]);
  assert.equal(box.loading, 3);
  assert.deepEqual(box.wanted, [{ repo: "acme/c", kind: "pulls" }, { repo: "acme/c", kind: "issues" }]);
});

test("runs are reconciled with GitHub's total: a short page is never the end, and more runs than counted is not a list", async () => {
  const at = async (page, body) => { const s = setup({ work: { ["/actions/runs?per_page=100&page=" + page]: body } }); return SB.readRunPage(s.ctx, s.client, REPO, page); };
  let r = await at(1, { total_count: 0, workflow_runs: [] });
  assert.deepEqual([r.state, r.data.end], ["empty", true], "zero counted and none listed is empty");
  r = await at(1, { total_count: 5, workflow_runs: [] });
  assert.deepEqual([r.state, r.data.end, r.data.short, r.data.total], ["partial", false, true, 5], "counted but not listed is not empty");
  r = await at(1, { total_count: 150, workflow_runs: [run(1, "completed", "success")] });
  assert.deepEqual([r.state, r.data.end, r.data.short], ["partial", false, true], "a page short of the total is not the end");
  r = await at(1, { total_count: 100, workflow_runs: Array.from({ length: 100 }, (_, i) => run(i + 1, "completed", "success")) });
  assert.deepEqual([r.state, r.data.end], ["current", true], "a full page that covers the total is the end");
  r = await at(1, { total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, i) => run(i + 1, "completed", "success")) });
  assert.deepEqual([r.state, r.data.end, r.data.short], ["partial", false, false], "a full page short of the total may have more");
  r = await at(2, { total_count: 120, workflow_runs: Array.from({ length: 20 }, (_, i) => run(i + 1, "completed", "success")) });
  assert.deepEqual([r.state, r.data.end], ["current", true]);
  r = await at(2, { total_count: 110, workflow_runs: Array.from({ length: 20 }, (_, i) => run(i + 1, "completed", "success")) });
  assert.deepEqual([r.state, r.data.end], ["current", true], "a total that shrank while paging ends the list; the change is shown from the totals");
  r = await at(1, { total_count: 1, workflow_runs: [run(1, "queued", null), run(2, "queued", null)] });
  assert.equal(r.state, "invalid", "one reply listing more runs than it counts is not GitHub's list");
});

test("a list stops at a short page, says a changed total, and an issue page of pull requests only still pages", () => {
  const live = new Map();
  const at = key => live.get(key);
  const K = (kind, p, state) => SB.workKey.list(kind, REPO, state, p);
  live.set(K("runs", 1, null), SB.result("partial", { runs: [], total: 5, end: false, short: true }, {}));
  let w = SB.workList(at, "runs", REPO, null, 3);
  assert.deepEqual([w.state, w.end, w.short, w.more, w.wanted, w.pages], ["current", false, true, false, [], 1], "nothing is read after a short page");
  live.set(K("runs", 1, null), SB.result("partial", { runs: [{ id: 1 }], total: 150, end: false }, {}));
  live.set(K("runs", 2, null), SB.result("current", { runs: [{ id: 2 }], total: 101, end: true }, {}));
  w = SB.workList(at, "runs", REPO, null, 2);
  assert.deepEqual([w.total, w.changed, w.end], [150, 101, true]);
  live.set(K("issues", 1, "open"), SB.result("partial", { issues: [], pulls: 100, end: false }, {}));
  w = SB.workList(at, "issues", REPO, "open", 1);
  assert.deepEqual([w.state, w.items.length, w.pulls, w.more], ["current", 0, 100, true], "an issue page of pull requests only is not an empty list");
  live.set(K("issues", 2, "open"), SB.result("current", { issues: [{ number: 3 }], pulls: 0, end: true }, {}));
  w = SB.workList(at, "issues", REPO, "open", 2);
  assert.deepEqual([w.items.map(i => i.number), w.end], [[3], true]);
});

test("the inbox's scope keeps every mapped repository and names the ones that could not be read", () => {
  const rows = [{ repo: "acme/a", pinned: SB.result("current", { meta: null }, {}) }, { repo: "acme/b", pinned: SB.result("denied", null, {}, { error: "HTTP 403" }) },
                { repo: "acme/c", pinned: null }, { repo: "acme/d", pinned: { state: "loading" } }];
  const scope = SB.inboxScope(rows);
  assert.deepEqual(scope.readable.map(r => r.repo), ["acme/a"], "a repository read without metadata is still in scope");
  assert.deepEqual(scope.unread.map(u => [u.repo, u.state, u.error]), [["acme/b", "denied", "HTTP 403"], ["acme/c", "loading", null], ["acme/d", "loading", null]]);
});

test("a pull request list the token cannot read says which permission it needs", async () => {
  const s = setup({ work: { "/pulls?state=open&per_page=100&page=1": 403 } });
  const r = await SB.readPullPage(s.ctx, s.client, REPO, "open", 1);
  assert.equal(r.state, "unavailable");
  assert.match(r.error, /Pull requests: read/);
});
