"use strict";
// The Atlas account: the public profile and public events readers, the reads they may make, and the
// activity calendar, mix and feed lines worked out from them. Synthetic accounts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, json, WEB } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();
const HOUR = 36e5, DAY = 864e5;

function setup(overrides = []) {
  const gh = mockGitHub(F.planRepos(), overrides);
  const session = SB.createSession();
  return { gh, client: SB.createClient(session, gh.fetch), ctx: session.start("synthetic-token") };
}
const paths = s => s.gh.calls.map(c => c.url.replace(/^https:\/\/api\.github\.com/, ""));
const zone = (tz, fn) => { const was = process.env.TZ; process.env.TZ = tz; try { return fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; } };

test("only the account's public profile and three pages of its public events may be read", () => {
  for (const ok of ["/users/synthetic-user", "/users/a-1/events/public?per_page=100&page=1", "/users/a-1/events/public?per_page=100&page=3"]) {
    assert.equal(SB.allowed(ok), true, ok);
  }
  for (const bad of ["/users/a/events/public?per_page=100&page=4", "/users/a/events?per_page=100&page=1", "/users/a/received_events",
                     "/users/a/events/public", "/users/a/repos", "/users/a/starred", "/users/a/followers", "/users/a_b", "/users/a/orgs",
                     "/graphql", "/users/" + "a".repeat(40)]) assert.equal(SB.allowed(bad), false, bad);
});

test("the profile keeps short text fields, counts and the profile page at GitHub's own address", async () => {
  let s = setup([[/^\/users\/synthetic-user$/, () => json({ login: "Synthetic-User", type: "User", name: " Sam Example ", bio: "x".repeat(400),
    location: "", company: "Example Org", blog: "javascript:alert(1)", followers: 3, following: -1, created_at: "2019-04-02T08:00:00Z",
    html_url: WEB + "/Synthetic-User", email: "not kept" })]]);
  const p = await SB.readProfile(s.ctx, s.client, "synthetic-user");
  assert.equal(p.state, "current");
  assert.deepEqual(p.data, { login: "Synthetic-User", type: "User", name: "Sam Example", bio: "x".repeat(300), location: null, company: "Example Org",
    blog: "javascript:alert(1)", followers: 3, following: null, since: Date.parse("2019-04-02T08:00:00Z"), web: WEB + "/Synthetic-User" });
  assert.deepEqual(paths(s), ["/users/synthetic-user"]);
  // A profile page anywhere else is not linked; another login, or no creation time, is not this account.
  s = setup([[/^\/users\//, () => json({ login: "synthetic-user", created_at: null, html_url: WEB + "/someone-else" })]]);
  assert.equal((await SB.readProfile(s.ctx, s.client, "synthetic-user")).data.web, null);
  s = setup([[/^\/users\//, () => json({ login: "someone-else", created_at: null })]]);
  assert.equal((await SB.readProfile(s.ctx, s.client, "synthetic-user")).state, "invalid");
  s = setup([[/^\/users\//, () => json({ message: "no" }, 403)]]);
  assert.deepEqual([(await SB.readProfile(s.ctx, s.client, "synthetic-user")).state, paths(s).length], ["denied", 1]);
  s = setup();
  assert.equal((await SB.readProfile(s.ctx, s.client, "bad login")).state, "invalid");
  assert.equal(s.gh.calls.length, 0, "a login not of the plain form is never sent");
});

const event = (i, type, payload, extra) => Object.assign({ id: String(i), type, created_at: new Date(Date.parse("2026-01-15T12:00:00Z") - i * HOUR).toISOString(),
  repo: { name: "acme/garden" }, payload: payload || {}, actor: { login: "synthetic-user" } }, extra || {});

test("public events are read 100 a page up to 3 pages, keep only what the feed needs, and say what they leave out", async () => {
  const page1 = [event(1, "PushEvent", { size: 3, commits: [{ message: "not kept" }] }), event(2, "PullRequestEvent", { action: "opened", pull_request: { title: "not kept" } }),
    event(3, "CreateEvent", { ref_type: "tag" }), event(4, "Odd Event"), event(5, "IssuesEvent", { action: "<b>" }), { type: "PushEvent" }];
  let s = setup([[/events\/public/, () => json(page1)]]);
  let r = await SB.readPublicEvents(s.ctx, s.client, "synthetic-user");
  assert.equal(r.state, "current");
  assert.equal(r.data.skipped, 2, "an event type not of the plain form, and one with no time or repository");
  assert.deepEqual(r.data.events.map(e => [e.type, e.size, e.action, e.refType]),
    [["PushEvent", 3, null, null], ["PullRequestEvent", null, "opened", null], ["CreateEvent", null, null, "tag"], ["IssuesEvent", null, null, null]]);
  assert.deepEqual(Object.keys(r.data.events[0]).sort(), ["action", "at", "refType", "repo", "size", "type"], "no message, title or actor is kept");
  assert.deepEqual(paths(s), ["/users/synthetic-user/events/public?per_page=100&page=1"]);
  // Three full pages: GitHub keeps no more, so it is partial and no fourth page is asked for.
  const full = Array.from({ length: 100 }, (_, i) => event(i, "WatchEvent", { action: "started" }));
  s = setup([[/events\/public/, () => json(full)]]);
  r = await SB.readPublicEvents(s.ctx, s.client, "synthetic-user");
  assert.deepEqual([r.state, r.data.events.length, paths(s).length, r.data.stopped], ["partial", 300, 3, null]);
  // A later page that fails keeps the first, said as partial with why.
  s = setup([[/page=2$/, () => json({ message: "slow down" }, 429, { "retry-after": "60" })], [/events\/public/, () => json(full)]]);
  r = await SB.readPublicEvents(s.ctx, s.client, "synthetic-user");
  assert.deepEqual([r.state, r.data.events.length, r.data.stopped], ["partial", 100, "HTTP 429"]);
  // The first page refused or not a list.
  s = setup([[/events\/public/, () => json({ message: "no" }, 404)]]);
  assert.equal((await SB.readPublicEvents(s.ctx, s.client, "synthetic-user")).state, "missing");
  s = setup([[/events\/public/, () => json({ events: [] })]]);
  assert.equal((await SB.readPublicEvents(s.ctx, s.client, "synthetic-user")).state, "invalid");
  s = setup([[/events\/public/, () => json([])]]);
  assert.deepEqual((await SB.readPublicEvents(s.ctx, s.client, "synthetic-user")).state, "empty");
});

test("the activity calendar is the last 91 local days, pushes counting their commits", () => {
  const now = Date.parse("2026-01-15T22:30:00Z");
  const events = [{ type: "PushEvent", at: Date.parse("2026-01-15T21:30:00Z"), size: 4 }, { type: "WatchEvent", at: Date.parse("2026-01-15T10:00:00Z") },
                  { type: "PushEvent", at: Date.parse("2026-01-14T23:30:00Z"), size: null }, { type: "IssuesEvent", at: Date.parse("2025-01-01T00:00:00Z") }];
  const utc = zone("UTC", () => SB.activityDays(events, now));
  assert.equal(utc.length, 91);
  assert.deepEqual([utc[0].day, utc[90].day, utc[90].dow], ["2025-10-17", "2026-01-15", 4]);
  assert.deepEqual([utc[90].count, utc[89].count], [5, 1], "a push of 4 commits and a star; a push GitHub gives no size for counts 1");
  assert.equal(utc.reduce((a, d) => a + d.count, 0), 6, "an event before the 91 days is not drawn");
  // In UTC+3 it is already the 16th: the late push falls on it, and the other two on the 15th.
  const riyadh = zone("Asia/Riyadh", () => SB.activityDays(events, now));
  assert.deepEqual([riyadh[90].day, riyadh[90].count, riyadh[89].count], ["2026-01-16", 4, 2]);
  assert.deepEqual(SB.busiest(utc), utc[90]);
  assert.equal(SB.busiest(SB.activityDays([], now)), null);
});

test("levels split the active days in quarters; the mix and feed lines are plain text", () => {
  const days = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(count => ({ count }));
  assert.deepEqual(SB.heatLevels(days), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual(SB.heatLevels([{ count: 0 }, { count: 7 }]), [0, 1], "one active day is the first level, as the earlier app drew it");
  const ev = (type, more) => Object.assign({ type, repo: "acme/garden", size: null, action: null, refType: null }, more);
  assert.deepEqual([ev("PushEvent", { size: 1 }), ev("PushEvent"), ev("PullRequestEvent", { action: "closed" }), ev("IssuesEvent"), ev("CreateEvent", { refType: "branch" }),
                    ev("WatchEvent"), ev("GollumEvent"), ev("SomethingNewEvent"), ev("PullRequestReviewEvent")].map(SB.eventLine),
    ["Pushed 1 commit to acme/garden", "Pushed to acme/garden", "Closed a pull request in acme/garden", "Updated an issue in acme/garden",
     "Created branch in acme/garden", "Starred acme/garden", "Wiki edits · acme/garden", "SomethingNew · acme/garden", "Reviewed a pull request in acme/garden"]);
  const mix = SB.eventMix([ev("PushEvent"), ev("WatchEvent"), ev("PushEvent"), ev("ForkEvent"), ev("IssuesEvent"), ev("CreateEvent"), ev("DeleteEvent")]);
  assert.deepEqual(mix.map(m => [m.name, m.n]), [["Pushes", 2], ["Created", 1], ["Deleted", 1], ["Forked", 1], ["Issues", 1]]);
});

test("the account's reads belong to no repository, so a project's refresh never drops them", () => {
  assert.equal(SB.liveKeyRepo(SB.accountKey.profile("synthetic-user")), null);
  assert.equal(SB.liveKeyRepo(SB.accountKey.events("synthetic-user")), null);
  assert.equal(SB.liveKeyRepo("lane|acme/garden@" + "0".repeat(40) + "|1"), "acme/garden");
});

test("the demo answers the made-up account's profile and events, dated before the moment it is asked", async () => {
  const serve = SB.demoServer({ repos: {}, account: { profile: { name: "Demo User", created_at: "2019-04-02T08:00:00Z" },
    events: [[2, "PushEvent", "example-org/demo-app", { size: 2 }], [30, "WatchEvent", "example-org/tools", {}]] } });
  const before = Date.now();
  const prof = await (await serve(SB.API + "/users/demo-user")).json();
  assert.deepEqual([prof.login, prof.name, prof.html_url], ["demo-user", "Demo User", undefined]);
  const evs = await (await serve(SB.API + "/users/demo-user/events/public?per_page=100&page=1")).json();
  assert.deepEqual(evs.map(e => [e.type, e.repo.name]), [["PushEvent", "example-org/demo-app"], ["WatchEvent", "example-org/tools"]]);
  assert.ok(Math.abs(Date.parse(evs[0].created_at) - (before - 2 * HOUR)) < DAY / 24);
  assert.deepEqual(await (await serve(SB.API + "/users/demo-user/events/public?per_page=100&page=2")).json(), []);
  assert.equal((await SB.demoServer({ repos: {} })(SB.API + "/users/demo-user")).status, 404);
});

test("starred repositories and public gists are read only by these paths, three pages at most", () => {
  for (const ok of ["/users/a-1/starred?per_page=100&page=1", "/users/a-1/gists?per_page=100&page=3"]) assert.equal(SB.allowed(ok), true, ok);
  for (const bad of ["/users/a/starred?per_page=100&page=4", "/users/a/gists", "/users/a/starred", "/user/starred?per_page=100&page=1",
                     "/gists?per_page=100&page=1", "/gists/abc", "/users/a/gists?per_page=30&page=1", "/user/starred/a/b"]) assert.equal(SB.allowed(bad), false, bad);
});

test("a starred repository keeps its name, short text, counts, times and its page at GitHub's own address", async () => {
  const star = (name, more) => Object.assign({ full_name: name, description: "d".repeat(400), language: "JavaScript", stargazers_count: 7, pushed_at: "2026-01-02T03:04:05Z",
    archived: false, fork: false, html_url: WEB + "/" + name, owner: { login: "not kept" } }, more || {});
  const s = setup([[/starred/, () => json([star("acme/garden"), star("acme/x", { html_url: WEB + "/someone/else", archived: true, stargazers_count: -2 }), star("not a repo"), "x"])]]);
  const r = await SB.readStarred(s.ctx, s.client, "synthetic-user");
  assert.equal(r.state, "current");
  assert.equal(r.data.skipped, 2);
  assert.deepEqual(r.data.repos[0], { repo: "acme/garden", description: "d".repeat(300), language: "JavaScript", stars: 7, pushed: Date.parse("2026-01-02T03:04:05Z"),
                                      archived: false, fork: false, web: WEB + "/acme/garden" });
  assert.deepEqual([r.data.repos[1].web, r.data.repos[1].archived, r.data.repos[1].stars], [null, true, null]);
  assert.deepEqual(paths(s), ["/users/synthetic-user/starred?per_page=100&page=1"]);
});

test("a public gist keeps its files by name, its times and its page only at an address ending in its ID", async () => {
  const gist = (id, more) => Object.assign({ id, description: "Notes", public: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-03T00:00:00Z", comments: 2,
    html_url: WEB + "/" + id, files: { "a.md": { filename: "a.md", language: "Markdown", size: 12, content: "not kept" }, "b.sh": { filename: "b.sh", language: null, size: 3 } } }, more || {});
  const many = {}; for (let i = 0; i < 60; i++) many["f" + i] = { filename: "f" + i, size: 1 };
  const s = setup([[/gists/, () => json([gist("abc123"), gist("def456", { html_url: WEB + "/synthetic-user/def456", description: null }),
    gist("0a0a", { html_url: WEB + "/someone/0a0a", files: many, truncated: true }), gist("not-hex"), gist("fff", { files: null })])]]);
  const r = await SB.readGists(s.ctx, s.client, "synthetic-user");
  assert.equal(r.data.skipped, 2);
  assert.deepEqual(r.data.gists[0], { id: "abc123", description: "Notes", files: [{ name: "a.md", language: "Markdown", size: 12 }, { name: "b.sh", language: null, size: 3 }],
                                      more: 0, cut: false, created: Date.parse("2026-01-01T00:00:00Z"), updated: Date.parse("2026-01-03T00:00:00Z"), comments: 2, web: WEB + "/abc123" });
  assert.deepEqual([r.data.gists[1].web, r.data.gists[1].description], [WEB + "/synthetic-user/def456", null], "the owner's own path is GitHub's too");
  assert.deepEqual([r.data.gists[2].web, r.data.gists[2].files.length, r.data.gists[2].more], [null, 50, 10], "another account's path is not linked; 50 file names at most");
  assert.deepEqual([r.data.gists[0].cut, r.data.gists[1].cut, r.data.gists[2].cut], [false, false, true], "GitHub's own cut list is kept per gist, a complete one is not");
});

test("the starred list narrows by every word typed, in name, description or language", () => {
  const r = { repo: "acme/Garden-Tools", description: "Charts for plants", language: "TypeScript" };
  assert.equal(SB.starMatch(r, ""), true);
  assert.equal(SB.starMatch(r, "  garden\tcharts "), true);
  assert.equal(SB.starMatch(r, "typescript plants"), true);
  assert.equal(SB.starMatch(r, "garden python"), false);
  assert.equal(SB.starMatch({ repo: "a/b", description: null, language: null }, "b"), true);
});

test("the demo answers the made-up account's starred repositories and gists", async () => {
  const serve = SB.demoServer({ repos: {}, account: { profile: {}, events: [], starred: [["acme/x", "d", "Go", 3, 2, false], ["acme/fork-y", null, null, 0, 9, true]],
    gists: [["abc", "g", [["a.md", "Markdown", 5]], 1, 0]] } });
  const st = await (await serve(SB.API + "/users/demo-user/starred?per_page=100&page=1")).json();
  assert.deepEqual(st.map(r => [r.full_name, r.archived, r.fork]), [["acme/x", false, false], ["acme/fork-y", true, true]]);
  const gs = await (await serve(SB.API + "/users/demo-user/gists?per_page=100&page=1")).json();
  assert.deepEqual([gs[0].id, Object.keys(gs[0].files), gs[0].html_url], ["abc", ["a.md"], undefined]);
});

test("to compare, only three pages of an account's own public repositories, most recently pushed first, may be read", () => {
  for (const ok of ["/users/a-1/repos?sort=pushed&per_page=100&page=1", "/users/a-1/repos?sort=pushed&per_page=100&page=3"]) assert.equal(SB.allowed(ok), true, ok);
  for (const bad of ["/users/a/repos?sort=pushed&per_page=100&page=4", "/users/a/repos?per_page=100&page=1", "/users/a/repos?type=all&sort=pushed&per_page=100&page=1",
                     "/users/a/repos", "/orgs/a/repos?sort=pushed&per_page=100&page=1"]) assert.equal(SB.allowed(bad), false, bad);
});

test("an account's public repositories keep only name, fork, stars, language and last push; three full pages are partial", async () => {
  const repo = (name, more) => Object.assign({ full_name: name, fork: false, stargazers_count: 4, language: "Go", pushed_at: "2026-01-02T00:00:00Z", description: "not kept" }, more || {});
  let s = setup([[/\/repos\?/, () => json([repo("sam/one"), repo("sam/two", { fork: true, stargazers_count: -1, language: null }), repo("bad name")])]]);
  let r = await SB.readUserRepos(s.ctx, s.client, "sam");
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.repos, [{ repo: "sam/one", fork: false, stars: 4, language: "Go", pushed: Date.parse("2026-01-02T00:00:00Z") },
                                  { repo: "sam/two", fork: true, stars: null, language: null, pushed: Date.parse("2026-01-02T00:00:00Z") }]);
  assert.equal(r.data.skipped, 1);
  assert.deepEqual(paths(s), ["/users/sam/repos?sort=pushed&per_page=100&page=1"]);
  s = setup([[/\/repos\?/, path => json(Array.from({ length: 100 }, (_, i) => repo("sam/r" + path.slice(-1) + "-" + i)))]]);
  r = await SB.readUserRepos(s.ctx, s.client, "sam");
  assert.deepEqual([r.state, r.data.repos.length, paths(s).length], ["partial", 300, 3]);
});

test("two accounts are compared in eight rounds of public numbers; unknown wins nothing and a cut list is a lower bound", () => zone("UTC", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const live = (state, data) => ({ state, data });
  const ev = (days, size) => ({ type: "PushEvent", at: now - days * DAY, repo: "x/y", size, action: null, refType: null });
  const a = SB.accountStats({ login: "sam", name: "Sam", followers: 5, since: Date.parse("2019-05-01T00:00:00Z"), web: null },
    live("current", { repos: [{ repo: "sam/a", fork: false, stars: 10, language: "Go", pushed: now - DAY }, { repo: "sam/b", fork: false, stars: 2, language: "Go", pushed: now - 40 * DAY },
                              { repo: "sam/c", fork: true, stars: 99, language: "C", pushed: now - DAY }] }),
    live("current", { events: [ev(0, 2), ev(1, null), ev(2, 1), ev(5, 1)] }), now);
  assert.deepEqual([a.repos, a.stars, a.langCount, a.langs, a.top, a.active, a.actions, a.streak, a.since, a.reposCut],
                   [3, 12, 1, [{ name: "Go", share: 1 }], { repo: "sam/a", stars: 10 }, 2, 5, 3, 2019, false], "forks add no stars or languages");
  const b = SB.accountStats({ login: "kim", name: null, followers: null, since: Date.parse("2016-01-01T00:00:00Z"), web: null },
    live("partial", { repos: [{ repo: "kim/a", fork: false, stars: 3, language: "Go", pushed: null }, { repo: "kim/b", fork: false, stars: 3, language: "Rust", pushed: now }] }),
    live("current", { events: [] }), now);
  assert.equal(b.name, "kim");
  const rows = SB.duelRows(a, b, now);
  assert.deepEqual(rows.map(r => [r.label, r.a, r.b, r.win]), [
    ["Stars earned", 12, 6, "a"], ["Public repositories", 3, 2, "a"], ["Followers", 5, null, null], ["Actions, 90 days", 5, 0, "a"],
    ["Best streak (days)", 3, 0, "a"], ["Languages", 1, 2, "b"], ["Years on GitHub", 7, 10, "b"], ["Active repositories, 30 days", 2, 1, "a"]]);
  assert.deepEqual(rows.map(r => [r.cutA, r.cutB]).filter(([x, y]) => x || y).length, 4, "the four rounds from repositories are lower bounds for the cut side");
  assert.deepEqual([rows[0].cutA, rows[0].cutB, rows[3].cutB, rows[2].cutB], [false, true, false, false]);
}));

test("the demo answers another made-up account and each one's own public repositories", async () => {
  const serve = SB.demoServer({ repos: {}, account: { profile: {}, events: [], repos: [["demo-user/a", "Go", 3, 1, false]],
    others: { "sample-x": { profile: { name: "X", created_at: "2020-01-01T00:00:00Z" }, events: [[1, "PushEvent", "sample-x/b", { size: 1 }]], repos: [["sample-x/b", "C", 9, 0, true]] } } } });
  assert.equal((await (await serve(SB.API + "/users/sample-x")).json()).name, "X");
  const mine = await (await serve(SB.API + "/users/demo-user/repos?sort=pushed&per_page=100&page=1")).json();
  assert.deepEqual(mine.map(r => [r.full_name, r.language, r.stargazers_count, r.fork]), [["demo-user/a", "Go", 3, false]]);
  const theirs = await (await serve(SB.API + "/users/sample-x/repos?sort=pushed&per_page=100&page=1")).json();
  assert.deepEqual(theirs.map(r => [r.full_name, r.fork]), [["sample-x/b", true]]);
  assert.equal((await (await serve(SB.API + "/users/sample-x/events/public?per_page=100&page=1")).json()).length, 1);
  assert.equal((await serve(SB.API + "/users/nobody-here")).status, 404);
  assert.equal((await serve(SB.API + "/users/nobody-here/repos?sort=pushed&per_page=100&page=1")).status, 404);
});

test("the README badge's numbers are short, lower bounds get a plus, and every language has a steady colour", () => {
  assert.deepEqual([0, 999, 9999, 12345, 2000000, 2500000, null].map(SB.shortNumber), ["0", "999", "9,999", "12.3k", "2M", "2.5M", "?"]);
  const s = { stars: 15000, repos: 300, actions: 40, streak: 3, reposCut: true, eventsCut: false };
  assert.deepEqual(SB.badgeNumbers(s), [["Stars", "15k+"], ["Repos", "300+"], ["Actions (90d)", "40"], ["Best streak", "3d"]]);
  assert.equal(SB.langColor("Go"), "#00ADD8");
  assert.equal(SB.langColor(null), "#9d9d9d");
  assert.equal(SB.langColor("Made-up Lang"), SB.langColor("Made-up Lang"));
  assert.match(SB.langColor("Made-up Lang"), /^hsl\(\d+ 55% 52%\)$/);
  assert.equal(SB.langColor("constructor"), SB.langColor("constructor"));
  assert.match(SB.langColor("constructor"), /^hsl/, "a name that is also an object key is not taken for a colour");
});
