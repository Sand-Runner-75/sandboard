"use strict";
// A task's review cycle: pull request and comment readers, and the evidence worked out from them.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, json, sha } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();
const A = sha("head-a"), B = sha("head-b");

function pull(number, title, extra = {}) {
  return Object.assign({ number, title, state: "open", merged_at: null, merge_commit_sha: null, head: { sha: B }, body: "", comments: [] }, extra);
}

function setup(pulls, overrides) {
  const repos = F.planRepos();
  repos["acme/garden-plan"].pulls = pulls;
  const gh = mockGitHub(repos, overrides);
  const session = SB.createSession();
  return { gh, client: SB.createClient(session, gh.fetch), ctx: session.start("synthetic-token") };
}

test("pull requests are read live, field by field, and a cut-off list is partial", async () => {
  const merged = pull(3, "XQ101: sketch", { state: "closed", merged_at: "2026-01-02T03:04:05Z", merge_commit_sha: sha("m"), body: null });
  const { client, ctx } = setup([merged, pull(4, "Tidy")]);
  let r = await SB.readPulls(ctx, client, "acme/garden-plan");
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.pulls[0], { number: 3, title: "XQ101: sketch", state: "closed", head: B, merged: "2026-01-02T03:04:05Z",
                                      mergeCommit: sha("m"), body: "", created: null, closed: null });
  assert.equal(r.data.pulls[1].merged, null);
  const many = Array.from({ length: 300 }, (_, i) => pull(i + 1, "PR " + (i + 1)));
  const big = setup(many);
  r = await SB.readPulls(big.ctx, big.client, "acme/garden-plan");
  assert.equal(r.state, "partial");
  assert.equal(r.data.pulls.length, 300);
  const none = setup([]);
  assert.equal((await SB.readPulls(none.ctx, none.client, "acme/garden-plan")).state, "empty");
});

test("a malformed pull request or a refused list shows nothing as current", async () => {
  for (const bad of [{ head: { sha: "abc" } }, { state: "merged" }, { number: 0 }, { merged_at: "soon" }, { body: 7 }, { merge_commit_sha: "x" }]) {
    const { client, ctx } = setup([pull(1, "XQ101", bad)]);
    assert.equal((await SB.readPulls(ctx, client, "acme/garden-plan")).state, "invalid", JSON.stringify(bad));
  }
  const denied = setup([], [[/pulls/, () => json({ message: "denied" }, 403)]]);
  assert.equal((await SB.readPulls(denied.ctx, denied.client, "acme/garden-plan")).state, "denied");
  const off = setup([], [[/pulls/, () => { throw new TypeError("offline"); }]]);
  assert.equal((await SB.readPulls(off.ctx, off.client, "acme/garden-plan")).state, "failed");
});

test("comments are read as text, and a long thread is partial", async () => {
  const comments = [{ body: "FROM: B\nSTATE: REVIEW PASSED\nHEAD: " + B, created_at: "2026-01-02T03:04:05Z" }, { body: "<b>hi</b>", created_at: null }];
  let { client, ctx } = setup([pull(5, "XQ101", { comments })]);
  let r = await SB.readComments(ctx, client, "acme/garden-plan", 5);
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.comments[1], { body: "<b>hi</b>", at: null });
  ({ client, ctx } = setup([pull(5, "XQ101", { comments: Array.from({ length: 500 }, () => ({ body: "x", created_at: null })) })]));
  r = await SB.readComments(ctx, client, "acme/garden-plan", 5);
  assert.equal(r.state, "partial");
  ({ client, ctx } = setup([pull(5, "XQ101", { comments: [{ body: 3 }] })]));
  assert.equal((await SB.readComments(ctx, client, "acme/garden-plan", 5)).state, "invalid");
  assert.equal((await SB.readComments(ctx, client, "acme/garden-plan", 0)).state, "invalid");
  assert.equal((await SB.readComments(ctx, client, "acme/garden-plan", 9)).state, "missing");
});

test("a title names a task only when the ID stands alone", () => {
  assert.ok(SB.namesTask("[Claude] XQ101: sketch", "XQ101"));
  assert.ok(SB.namesTask("Records for XQ100/XQ101.", "XQ101"));
  assert.ok(!SB.namesTask("XQ1011: other", "XQ101"));
  assert.ok(!SB.namesTask("AXQ101", "XQ101"));
  assert.ok(!SB.namesTask("XQ101.1: a step", "XQ101"), "a step is not its sub-task");
  assert.ok(SB.namesTask("XQ101.1: a step", "XQ101.1"));
  assert.ok(!SB.namesTask("XQ101", "XQ1.*"), "an ID that is not plain never matches");
});

test("code pull requests are linked only by their own repository's name", () => {
  const text = "Code in acme/garden#4, garden PR #5, see https://github.com/acme/garden/pull/6; garden-plan#7 and acme/gardens#8 are others; garden #4 again.";
  assert.deepEqual(SB.linkedPulls(text, ["acme/garden"]).map(x => x.number).sort(), [4, 5, 6]);
  assert.deepEqual(SB.linkedPulls(null, ["acme/garden"]), []);
});

test("a handoff needs FROM, STATE and HEAD; its head is a full commit or none", () => {
  const h = SB.handoff("FROM: Agent B -> TO: Agent A\r\nSTATE: CHANGES REQUESTED (two findings)\r\nHEAD: " + A + "\r\nRESULT: <script>x()</script>\r\nNEXT: fix");
  assert.deepEqual([h.from, h.to, h.kind, h.head, h.result, h.next], ["Agent B", "Agent A", "CHANGES REQUESTED", A, "<script>x()</script>", "fix"]);
  assert.equal(SB.handoff("FROM: X\nSTATE: Merge\nHEAD: abc1234").head, null);
  assert.equal(SB.handoff("FROM: X\nSTATE: Merge\nHEAD: abc1234").kind, null);
  assert.equal(SB.handoff("STATE: REVIEW PASSED\nHEAD: " + A), null);
  assert.equal(SB.handoff("Looks good!"), null);
});

test("handoffs are labelled against the pull request's head, and superseded by the same sender's later one", () => {
  const say = (from, state, head) => ({ body: "FROM: " + from + "\nSTATE: " + state + "\nHEAD: " + head, at: null });
  const h = SB.handoffs({ head: B }, [say("Agent A", "READY FOR REVIEW", A), say("Agent B", "CHANGES REQUESTED", A),
    { body: "thanks", at: null }, say("agent b", "REVIEW PASSED", B), say("Agent C", "BLOCKED", "none")]);
  assert.deepEqual(h.list.map(x => [x.kind, x.target, x.superseded]),
    [["READY FOR REVIEW", "older", false], ["CHANGES REQUESTED", "older", true], ["REVIEW PASSED", "head", false], ["BLOCKED", "none", false]]);
  assert.equal(h.other, 1);
});
