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
