"use strict";
// The Atlas code tree and the GIF encoder: which reads the tree asks for and how few at once, how agents
// are named from pull request branches, how a playback applies each commit's files, and the GIF bytes.
// Synthetic histories only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, json, sha } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();
const REPO = "acme/garden";
const K = SB.historyKey;
const at = d => new Date(Date.UTC(2026, 0, 1) + d * 864e5).toISOString();
const c = (seed, parents, d, author) => ({ sha: sha(seed), title: "Change " + seed, at: at(d), parents: parents.map(sha), author: author || null });
const liveOf = map => key => map.get(key);
const branches = head => ({ state: "current", data: { refs: [{ name: "main", sha: sha(head), protected: null }] } });
const changes = files => ({ state: files.length ? "current" : "empty", data: { commit: {}, files: files.map(([path, status, from]) => ({ path, status, from: from || null, added: 1, removed: 0, patch: null })) } });

// A linear history c1..cN, newest first, as the history pages give it.
const line = (n, author) => Array.from({ length: n }, (_, i) => c("c" + (n - i), i === n - 1 ? [] : ["c" + (n - i - 1)], n - i, author));

test("nothing is read before the branch list; then the head's pages, the pull requests and each commit's files, a few at a time", () => {
  assert.deepEqual(SB.atlasTree(() => undefined, REPO, "main").wanted, [{ kind: "refs", list: "branches" }]);
  const live = new Map([[K.refs(REPO, "branches"), branches("c20")]]);
  assert.deepEqual(SB.atlasTree(liveOf(live), REPO, "main").wanted, [{ kind: "lane", head: sha("c20"), page: 1 }]);
  live.set(K.lane(REPO, sha("c20"), 1), { state: "current", data: { commits: line(20), end: true } });
  const t = SB.atlasTree(liveOf(live), REPO, "main");
  assert.equal(t.state, "loading");
  // A whole history needs no file tree before it; the reads asked for at once stay within the pool.
  assert.equal(t.wanted.some(w => w.kind === "tree"), false);
  assert.equal(t.wanted.length, SB.TREE.POOL);
  assert.deepEqual(t.wanted[0], { kind: "pulls", state: "all", page: 1 });
  assert.deepEqual(t.wanted[1], { kind: "change", sha: sha("c1") }, "oldest commit first");
  // Reads in flight count against the pool.
  for (const w of t.wanted.slice(1)) live.set(SB.codeKey.commit(REPO, w.sha), { state: "loading" });
  assert.equal(SB.atlasTree(liveOf(live), REPO, "main").wanted.length, 1);
});

test("a window that is not the whole history starts from the files before it; merges are skipped and agents named", () => {
  const commits = line(160);
  const merge = c("m", ["c160", "c159"], 200);  // a merge commit is not played
  const live = new Map([[K.refs(REPO, "branches"), branches("m")],
    [K.lane(REPO, sha("m"), 1), { state: "partial", data: { commits: [merge, ...commits.slice(0, 99)], end: false } }],
    [K.lane(REPO, sha("m"), 2), { state: "current", data: { commits: commits.slice(99), end: true } }]]);
  const first = SB.atlasTree(liveOf(live), REPO, "main");
  // The newest 150 of 161 commits: the oldest played is c12, so the tree is read at c11.
  assert.deepEqual(first.wanted.find(w => w.kind === "tree"), { kind: "tree", commit: sha("c11") });
  live.set(SB.codeKey.tree(REPO, sha("c11")), { state: "current", data: { entries: [{ path: "README.md", kind: "file" }, { path: "src", kind: "dir" }, { path: "src/a.js", kind: "file" }], truncated: false } });
  // A pull request merged from an agent's branch inside the window credits its commits and squash commit to the agent.
  live.set(SB.workKey.list("pulls", REPO, "all", 1), { state: "current", data: { pulls: [
    { number: 7, merged: at(150), headRef: "claude/tidy-20260101", mergeCommit: sha("c151") },
    { number: 8, merged: at(150), headRef: "feature/plain", mergeCommit: sha("c152") },
    { number: 9, merged: null, headRef: "gpt/never-merged", mergeCommit: null }] } });
  const second = SB.atlasTree(liveOf(live), REPO, "main");
  assert.deepEqual(second.wanted.filter(w => w.kind === "pullCommits"), [{ kind: "pullCommits", number: 7 }]);
  live.set(SB.treeKey.pullCommits(REPO, 7), { state: "current", data: { shas: [sha("c149"), sha("c150")] } });
  for (const x of commits.slice(0, 150)) live.set(SB.codeKey.commit(REPO, x.sha), changes([["src/" + x.sha.slice(0, 6) + ".js", "added"]]));
  live.set(SB.codeKey.commit(REPO, sha("c13")), { state: "rate-limited", data: null, error: "HTTP 429" });
  const done = SB.atlasTree(liveOf(live), REPO, "main");
  assert.equal(done.state, "current");
  const d = done.data;
  assert.deepEqual(d.initial, ["README.md", "src/a.js"], "files only, folders left out");
  assert.equal(d.whole, false);
  assert.equal(d.commits.length, 149, "the merge is skipped");
  assert.equal(d.commits[0].sha, sha("c12"));
  assert.equal(d.failed, 1);
  assert.deepEqual(d.commits.find(x => x.sha === sha("c13")).files, []);
  const who = s => d.commits.find(x => x.sha === sha(s));
  assert.deepEqual([who("c150").author, who("c150").inferred], ["Claude", true]);
  assert.deepEqual([who("c151").author, who("c151").inferred], ["Claude", true], "the squash merge commit too");
  assert.deepEqual([who("c152").author, who("c152").inferred], ["someone", false], "a plain branch names no agent");
});

test("agent branch names and failures", () => {
  assert.equal(SB.TREE.agentOf("gpt/fix-1"), "ChatGPT");
  assert.equal(SB.TREE.agentOf("codex-thing"), "ChatGPT");
  assert.equal(SB.TREE.agentOf("Claude/x"), "Claude");
  assert.equal(SB.TREE.agentOf("copilot/y"), "Copilot");
  assert.equal(SB.TREE.agentOf("devin/z"), "Devin");
  assert.equal(SB.TREE.agentOf("feature/claude-support"), null);
  const denied = SB.atlasTree(liveOf(new Map([[K.refs(REPO, "branches"), { state: "denied", data: null, error: "HTTP 403" }]])), REPO, "main");
  assert.deepEqual([denied.state, denied.error], ["denied", "HTTP 403"]);
  assert.equal(SB.atlasTree(liveOf(new Map([[K.refs(REPO, "branches"), branches("x")]])), REPO, "develop").why, "branch");
  const page = new Map([[K.refs(REPO, "branches"), branches("c1")], [K.lane(REPO, sha("c1"), 1), { state: "rate-limited", data: null, error: "HTTP 429" }]]);
  assert.deepEqual(SB.atlasTree(liveOf(page), REPO, "main").state, "rate-limited");
});

test("a playback applies each commit's files: added, changed, renamed and removed, with empty folders going too", () => {
  const data = { initial: ["README.md", "old/a.txt"], whole: false, commits: [
    { sha: "1", date: at(1), msg: "one", author: "ana", files: [{ p: "src/app.js", s: "added" }, { p: "README.md", s: "modified" }] },
    { sha: "2", date: at(2), msg: "two", author: "ben", files: [{ p: "src/main.js", s: "renamed", prev: "src/app.js" }] },
    { sha: "3", date: at(3), msg: "three", author: "ana", files: [{ p: "old/a.txt", s: "removed" }] }] };
  const s = SB.treeStart(data, new Map());
  assert.deepEqual([...s.files.keys()].sort(), ["README.md", "old/a.txt"]);
  s.next();
  assert.deepEqual([...s.files.keys()].sort(), ["README.md", "old/a.txt", "src/app.js"]);
  assert.equal(s.authors.get("ana").targets.length, 2);
  s.next();
  assert.deepEqual([...s.files.keys()].sort(), ["README.md", "old/a.txt", "src/main.js"]);
  s.next();
  assert.deepEqual([...s.files.keys()].sort(), ["README.md", "src/main.js"]);
  assert.equal(s.dirs.has("old"), false, "an emptied folder goes");
  assert.deepEqual([...s.authors.keys()], ["ana", "ben"]);
  s.next();  // past the end, nothing happens
  assert.equal(s.k, 4);
  // Seeking replays from the start, the same each time (folders are placed from a fixed seed).
  const a = SB.treeSeek(data, new Map(), 2), b = SB.treeSeek(data, new Map(), 2);
  assert.deepEqual([a.k, a.files.size], [2, 3]);
  assert.deepEqual([...a.dirs.values()].map(d => [d.path, Math.round(d.x), Math.round(d.y)]), [...b.dirs.values()].map(d => [d.path, Math.round(d.x), Math.round(d.y)]));
  const [x0, y0, x1, y1] = a.bounds();
  assert.ok(x1 > x0 && y1 > y0);
  const cam = SB.treeFit(a, 640, 420, { x: 0, y: 0, s: 1 });
  assert.ok(cam.s > 0 && cam.s <= 2.2);
});

test("file colours: known types keep theirs, others get one of their own", () => {
  assert.equal(SB.TREE.colorOf(SB.TREE.extOf("src/a.js")), "#f1e05a");
  assert.equal(SB.TREE.extOf(".gitignore"), "gitignore");
  assert.equal(SB.TREE.extOf("Makefile"), "makefile");
  assert.match(SB.TREE.colorOf("zzz"), /^hsl\(\d+ 65% 60%\)$/);
});

test("the GIF writer makes a looping GIF89a with one frame per frame added", () => {
  const W = 4, H = 3, px = colour => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < a.length; i += 4) a.set([...colour, 255], i); return a; };
  const red = px([255, 0, 0]), blue = px([0, 0, 255]);
  const both = new Uint8ClampedArray([...red.slice(0, 24), ...blue.slice(24)]);
  const pal = SB.gifPalette(both);
  assert.equal(pal.colors.length, 2);
  assert.notEqual(pal.index(255, 0, 0), pal.index(0, 0, 255));
  const gif = SB.gifWriter(W, H, pal);
  gif.add(red, 100); gif.add(blue, 2500);
  const bytes = gif.finish();
  assert.equal(Buffer.from(bytes.slice(0, 6)).toString(), "GIF89a");
  assert.deepEqual([bytes[6], bytes[7], bytes[8], bytes[9]], [W, 0, H, 0]);
  assert.equal(bytes[bytes.length - 1], 0x3b);
  assert.equal(gif.frames, 2);
  assert.ok(Buffer.from(bytes).includes(Buffer.from("NETSCAPE2.0")), "it loops");
  // The second frame's delay is 250 hundredths of a second.
  const gce = [];
  for (let i = 0; i < bytes.length - 3; i++) if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 4) gce.push(bytes[i + 4] | bytes[i + 5] << 8);
  assert.deepEqual(gce, [10, 250]);
});

test("a pull request's commits are read from its first page only, by ID, and nothing else of it is allowed", async () => {
  assert.equal(SB.allowed("/repos/a/b/pulls/12/commits?per_page=100&page=1"), true);
  for (const bad of ["/repos/a/b/pulls/12/commits?per_page=100&page=2", "/repos/a/b/pulls/12/commits", "/repos/a/b/pulls/0/commits?per_page=100&page=1",
                     "/repos/a/b/pulls/12/files?per_page=100&page=1", "/repos/a/b/pulls/12/merge"]) assert.equal(SB.allowed(bad), false, bad);
  const list = n => Array.from({ length: n }, (_, i) => ({ sha: sha("pc-" + i), commit: { message: "x" } }));
  const replies = { 3: json(list(3)), 4: json(list(100)), 5: json([{ sha: "not-a-sha" }]), 6: json({ message: "no" }, 403) };
  const gh = mockGitHub(F.planRepos(), [[/[/]pulls[/](\d+)[/]commits/, (m) => replies[Number(/[/]pulls[/](\d+)[/]/.exec(m)[1])] || null]]);
  const session = SB.createSession(), client = SB.createClient(session, gh.fetch), ctx = session.start("synthetic-token");
  const three = await SB.readPullCommits(ctx, client, REPO, 3);
  assert.deepEqual([three.state, three.data.shas.length, three.data.shas[0]], ["current", 3, sha("pc-0")]);
  assert.equal((await SB.readPullCommits(ctx, client, REPO, 4)).state, "partial", "a full first page may have more behind it");
  assert.equal((await SB.readPullCommits(ctx, client, REPO, 5)).state, "invalid");
  const refused = await SB.readPullCommits(ctx, client, REPO, 6);
  assert.deepEqual([!refused.data, ["denied", "unavailable"].includes(refused.state)], [true, true], "a refusal is never an empty list");
  assert.equal((await SB.readPullCommits(ctx, client, REPO, 0)).state, "invalid");
});

test("what the tree misses is kept apart: cut file lists, pull requests not read, agent commits not read; Read again only for failures", () => {
  const commits = line(5);
  const live = new Map([[K.refs(REPO, "branches"), branches("c5")], [K.lane(REPO, sha("c5"), 1), { state: "current", data: { commits, end: true } }]]);
  const many = Array.from({ length: 300 }, (_, i) => ["big/f" + i + ".txt", "added"]);
  for (const x of commits) live.set(SB.codeKey.commit(REPO, x.sha), changes([["a.js", "modified"]]));
  live.set(SB.codeKey.commit(REPO, sha("c2")), Object.assign(changes(many), { state: "partial" }));
  live.set(SB.workKey.list("pulls", REPO, "all", 1), { state: "denied", data: null, error: "HTTP 403" });
  const denied = SB.atlasTree(liveOf(live), REPO, "main");
  assert.equal(denied.state, "current");
  assert.deepEqual([denied.data.cut, denied.data.failed, denied.data.names.state, denied.data.names.error, denied.retry], [1, 0, "failed", "HTTP 403", true]);
  assert.equal(denied.data.commits[1].files.length, 300, "a cut list still plays what it has");
  assert.match(SB.treeNote(denied.data, null), /1 commit with only GitHub's first 300 files · agents not fully named/);
  // A partial pull request list names agents from what it has and needs no Read again; one agent
  // pull request's commits failing does.
  live.set(SB.workKey.list("pulls", REPO, "all", 1), { state: "partial", data: { pulls: [
    { number: 3, merged: at(4), headRef: "gpt/a", mergeCommit: null }, { number: 4, merged: at(5), headRef: "claude/b", mergeCommit: null }] } });
  live.set(SB.treeKey.pullCommits(REPO, 3), { state: "rate-limited", data: null, error: "HTTP 429" });
  live.set(SB.treeKey.pullCommits(REPO, 4), { state: "partial", data: { shas: [sha("c5")] } });
  const some = SB.atlasTree(liveOf(live), REPO, "main");
  assert.deepEqual(some.data.names, { state: "partial", error: null, failedPulls: 1, partialPulls: 1, listed: 2 });
  assert.equal(some.retry, true);
  assert.equal(some.data.commits[4].author, "Claude");
  // Read again brings the failed read back: nothing is left to read again, and the agent is named.
  live.set(SB.treeKey.pullCommits(REPO, 3), { state: "current", data: { shas: [sha("c4")] } });
  const back = SB.atlasTree(liveOf(live), REPO, "main");
  assert.deepEqual([back.retry, back.data.names.failedPulls, back.data.commits[3].author], [false, 0, "ChatGPT"]);
  assert.equal(SB.treeNote(back.data, null), "1 commit with only GitHub's first 300 files · agents named from part of GitHub's list",
               "a partial list or partial agent commits still say so in a saved picture");
  // Only an agent pull request's commits partial: the note still says it.
  live.set(SB.workKey.list("pulls", REPO, "all", 1), { state: "current", data: { pulls: [
    { number: 3, merged: at(4), headRef: "gpt/a", mergeCommit: null }, { number: 4, merged: at(5), headRef: "claude/b", mergeCommit: null }] } });
  const cutOnly = SB.atlasTree(liveOf(live), REPO, "main");
  assert.deepEqual([cutOnly.data.names.state, cutOnly.data.names.partialPulls, cutOnly.retry], ["current", 1, false]);
  assert.equal(SB.treeNote(cutOnly.data, null), "1 commit with only GitHub's first 300 files · agents named from part of GitHub's list");
  // All read in full: nothing about agents.
  live.set(SB.treeKey.pullCommits(REPO, 4), { state: "current", data: { shas: [sha("c5")] } });
  assert.equal(SB.treeNote(SB.atlasTree(liveOf(live), REPO, "main").data, null), "1 commit with only GitHub's first 300 files");
});

test("the tree draws at most its file limit and says how many it leaves out", () => {
  const max = SB.TREE.MAX_FILES;
  const initial = Array.from({ length: max + 1 }, (_, i) => "f/" + String(i).padStart(5, "0") + ".js");
  const data = { initial, commits: [{ sha: "x", date: at(1), msg: "m", author: "a", inferred: false, files: [{ p: initial[max], s: "removed" }, { p: "g/new.js", s: "added" }] }],
                 whole: true, failed: 0, cut: 0, names: { state: "current" }, treeMissing: false, treePartial: false };
  const s = SB.treeStart(data, new Map());
  assert.equal(s.files.size, max);
  assert.equal(s.over.size, 1);
  assert.equal(SB.treeNote(data, s), "1 file not drawn (at most " + max.toLocaleString("en") + ")");
  s.next();
  assert.equal(s.files.has("g/new.js"), false, "still full");
  assert.deepEqual([...s.over], ["g/new.js"], "the file left out was removed; the new one is left out instead");
  // A drawn file goes, so there is room: the file left out is drawn and no longer counted as left out.
  s.remove(initial[0], 2);
  assert.ok(s.add("g/new.js", 2));
  assert.deepEqual([s.files.has("g/new.js"), s.over.size, SB.treeNote(data, s)], [true, 0, ""]);
});
