"use strict";
// Code inspection: the readers for a repository's file tree, a file's text and a commit's or a
// comparison's changed files, and what is worked out from them: folders, path search, which files can
// be opened, lines with hidden characters made visible, and diff lines. Synthetic repositories only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSB, mockGitHub, json, sha, blobSha } = require("./helpers");
const F = require("./fixtures");

const SB = loadSB();
const REPO = "acme/garden";
const C = F.CODE_COMMIT;
const BASE = sha("garden-base");

function setup(files = {}, overrides = []) {
  const repos = F.planRepos();
  repos[REPO].files[C] = files;
  const gh = mockGitHub(repos, overrides);
  const session = SB.createSession();
  return { gh, client: SB.createClient(session, gh.fetch), ctx: session.start("synthetic-token") };
}
const route = (path, reply) => [new RegExp("^/repos/" + REPO + path.replace(/[?.]/g, "\\$&") + "$"), () => typeof reply === "number" ? json({ message: "no" }, reply) : reply];
const blob = (path, extra = {}) => Object.assign({ path, mode: "100644", type: "blob", sha: sha(path), size: 10 }, extra);
const dir = path => ({ path, mode: "040000", type: "tree", sha: sha("tree " + path) });
const treeAt = (tree, truncated = false) => route("/git/trees/" + C + "?recursive=1", json({ sha: sha("root"), truncated, tree }));
const commitReply = (s, extra = {}) => Object.assign({ sha: s, commit: { message: "Change the list\n\nmore", committer: { date: "2026-01-02T00:00:00Z" } }, parents: [{ sha: BASE }] }, extra);
const changed = (path, extra = {}) => Object.assign({ filename: path, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }, extra);

test("only the code inspection's exact read paths are allowed, all of them reads", () => {
  for (const ok of ["/repos/a/b/git/trees/" + C + "?recursive=1", "/repos/a/b/contents/src/a.js?ref=" + C, "/repos/a/b/commits/" + C,
                    "/repos/a/b/commits/feature%2Fx", "/repos/a/b/compare/" + BASE + "..." + C + "?per_page=1"]) {
    assert.equal(SB.allowed(ok), true, ok);
  }
  for (const bad of ["/repos/a/b/git/trees/" + C, "/repos/a/b/git/trees/" + C + "?recursive=0", "/repos/a/b/git/trees/main?recursive=1",
                     "/repos/a/b/git/trees/" + C + "?recursive=1&x=1", "/repos/a/b/git/blobs/" + C, "/repos/a/b/git/refs", "/repos/a/b/git/commits",
                     "/repos/a/b/contents/../secret?ref=" + C, "/repos/a/b/contents/src/a.js", "/repos/a/b/contents/src/a.js?ref=main",
                     "/repos/a/b/commits/" + C + "/comments", "/repos/a/b/compare/main...dev", "/repos/a/b/compare/" + BASE + "..." + C,
                     "/repos/a/b/tarball/" + C, "/repos/a/b/zipball/" + C, "/repos/a/b/merges", "/repos/a/b/forks"]) {
    assert.equal(SB.allowed(bad), false, bad);
  }
});

test("the tree keeps files, folders, links and other repositories apart, and says when GitHub cut it", async () => {
  const tree = [dir("src"), blob("src/app.js", { size: 42 }), blob("README.md"), blob("docs/latest.md", { mode: "120000" }),
                { path: "vendor/kit", mode: "160000", type: "commit", sha: sha("kit") }, dir("docs"), dir("vendor")];
  let s = setup({}, [treeAt(tree)]);
  let r = await SB.readTree(s.ctx, s.client, REPO, C);
  assert.equal(r.state, "current");
  assert.deepEqual(r.data.entries.map(e => [e.path, e.kind, e.size]), [["src", "dir", null], ["src/app.js", "file", 42], ["README.md", "file", 10],
    ["docs/latest.md", "symlink", 10], ["vendor/kit", "submodule", null], ["docs", "dir", null], ["vendor", "dir", null]]);
  assert.deepEqual(r.source, { repo: REPO, commit: C });
  assert.deepEqual(s.gh.calls.map(c => [c.url.slice(SB.API.length), c.init.method]), [["/repos/acme/garden/git/trees/" + C + "?recursive=1", "GET"]]);
  const t = SB.codeTree(r.data);
  assert.deepEqual(t.root.kids.map(k => k.name), ["docs", "src", "vendor", "README.md"], "folders first, then files, by name");
  assert.deepEqual([t.files, t.dirs], [4, 3]);
  assert.equal(SB.codeTree(r.data), t, "worked out once per tree read");

  s = setup({}, [treeAt([blob("a/b/c.txt")], true)]);
  r = await SB.readTree(s.ctx, s.client, REPO, C);
  assert.equal(r.state, "partial");
  assert.equal(r.data.truncated, true);
  const cut = SB.codeTree(r.data).root.kids[0];
  assert.deepEqual([cut.name, cut.listed, cut.kids[0].name, cut.kids[0].listed], ["a", false, "b", false], "a folder GitHub did not list is marked so");

  for (const bad of [{ path: "../up", type: "blob" }, { path: "/abs", type: "blob" }, { path: "a//b", type: "blob" }, { path: "a/./b", type: "blob" },
                     { path: "ok", type: "blob", sha: "main" }, { path: "ok", type: "blob", size: -1 }, { path: "ok", type: "tag" }, { path: "a\u0000b", type: "blob" }]) {
    s = setup({}, [treeAt([Object.assign(blob("x"), bad)])]);
    assert.equal((await SB.readTree(s.ctx, s.client, REPO, C)).state, "invalid", JSON.stringify(bad));
  }
  s = setup({}, [route("/git/trees/" + C + "?recursive=1", json({ tree: [] }))]);
  assert.equal((await SB.readTree(s.ctx, s.client, REPO, C)).state, "invalid", "a reply without the truncated flag is not trusted");
  s = setup({}, [treeAt([])]);
  assert.equal((await SB.readTree(s.ctx, s.client, REPO, C)).state, "empty");
  for (const [status, state] of [[404, "missing"], [403, "denied"], [500, "failed"]]) {
    s = setup({}, [route("/git/trees/" + C + "?recursive=1", status)]);
    assert.equal((await SB.readTree(s.ctx, s.client, REPO, C)).state, state);
  }
  s = setup();
  assert.equal((await SB.readTree(s.ctx, s.client, REPO, "main")).state, "invalid", "a branch name is never read as the tree");
  assert.equal(s.gh.calls.length, 0);
});

test("the path search finds files only, every word, and at most two hundred", () => {
  const entries = [{ path: "src", kind: "dir" }, { path: "src/list.js", kind: "file" }, { path: "docs/list.md", kind: "file" }, { path: "src/app.js", kind: "file" },
                   ...Array.from({ length: 250 }, (_, i) => ({ path: "gen/file-" + i + ".txt", kind: "file" }))];
  assert.deepEqual(SB.codeFind({ entries }, "LIST").found.map(e => e.path), ["src/list.js", "docs/list.md"]);
  assert.deepEqual(SB.codeFind({ entries }, "src js").found.map(e => e.path), ["src/list.js", "src/app.js"]);
  assert.deepEqual(SB.codeFind({ entries }, "src").found.map(e => e.path), ["src/list.js", "src/app.js"], "a folder is not a match");
  const many = SB.codeFind({ entries }, "gen");
  assert.deepEqual([many.found.length, many.total], [SB.MAX_FOUND, 250]);
});

test("a file opens only when it is a plain file with a plain path that GitHub gives as text", () => {
  const why = e => SB.codeOpenable(e).ok ? "ok" : SB.codeOpenable(e).why;
  assert.equal(why({ path: "src/a.js", kind: "file", size: 10 }), "ok");
  assert.equal(why({ path: "src/a.js", kind: "file", size: null }), "ok");
  assert.equal(why(undefined), "missing");
  assert.equal(why({ path: "l", kind: "symlink", size: 3 }), "symlink");
  assert.equal(why({ path: "k", kind: "submodule", size: null }), "submodule");
  assert.equal(why({ path: "d", kind: "dir", size: null }), "dir");
  assert.equal(why({ path: "Meeting notes.txt", kind: "file", size: 3 }), "path");
  assert.equal(why({ path: "a/<b>.js", kind: "file", size: 3 }), "path");
  assert.equal(why({ path: "big.bin", kind: "file", size: SB.MAX_READ_BYTES + 1 }), "large");
});

test("a file's text is read at the pinned commit and checked against GitHub's hash; binary bytes are never shown", async () => {
  const hostile = "<script>document.title = 'ran'</script>\n[x](javascript:alert(1)) https://example.invalid/phish\n";
  let s = setup({ "src/page.html": hostile, "empty.txt": "", "nul.txt": "a\u0000b" });
  let r = await SB.readCodeFile(s.ctx, s.client, REPO, C, "src/page.html");
  assert.deepEqual([r.state, r.data.binary, r.data.text, r.data.size, r.data.sha], ["current", false, hostile, Buffer.byteLength(hostile), blobSha(hostile)]);
  assert.deepEqual(r.source, { repo: REPO, commit: C, path: "src/page.html" });
  assert.equal(s.gh.calls[0].url, SB.API + "/repos/acme/garden/contents/src/page.html?ref=" + C);
  r = await SB.readCodeFile(s.ctx, s.client, REPO, C, "empty.txt");
  assert.deepEqual([r.state, r.data.text], ["empty", ""]);
  r = await SB.readCodeFile(s.ctx, s.client, REPO, C, "nul.txt");
  assert.deepEqual([r.state, r.data.binary, r.data.text, r.data.size], ["current", true, null, 3]);
  const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]);  // "café" in Latin-1, not UTF-8
  s = setup({}, [route("/contents/latin.txt?ref=" + C, json({ type: "file", encoding: "base64", sha: require("node:crypto").createHash("sha1")
    .update("blob 4\0").update(latin).digest("hex"), content: latin.toString("base64") }))]);
  r = await SB.readCodeFile(s.ctx, s.client, REPO, C, "latin.txt");
  assert.deepEqual([r.state, r.data.binary, r.data.text], ["current", true, null], "not UTF-8 is kept as binary, never guessed");
  s = setup({ "bom.txt": "\uFEFFx\n" });
  r = await SB.readCodeFile(s.ctx, s.client, REPO, C, "bom.txt");
  assert.equal(r.data.text, "\uFEFFx\n", "a leading byte order mark is kept as text, not dropped by the decoder");
  assert.deepEqual(SB.textPieces(SB.textLines(r.data.text).lines[0]), [{ hidden: "U+FEFF" }, { text: "x" }], "and is shown by its code");
  s = setup({}, [route("/contents/a.txt?ref=" + C, json({ type: "file", encoding: "base64", sha: sha("other"), content: Buffer.from("x").toString("base64") }))]);
  assert.equal((await SB.readCodeFile(s.ctx, s.client, REPO, C, "a.txt")).state, "invalid", "bytes that do not match the blob ID are not shown");
  s = setup({}, [route("/contents/big.bin?ref=" + C, json({ type: "file", encoding: "none", sha: sha("big"), content: "" }))]);
  assert.equal((await SB.readCodeFile(s.ctx, s.client, REPO, C, "big.bin")).state, "unavailable");
  s = setup({}, [route("/contents/link?ref=" + C, json({ type: "symlink", target: "../../etc", sha: sha("l") }))]);
  assert.equal((await SB.readCodeFile(s.ctx, s.client, REPO, C, "link")).state, "invalid", "a link is never followed");
  s = setup();
  assert.equal((await SB.readCodeFile(s.ctx, s.client, REPO, C, "missing.js")).state, "missing");
  for (const path of ["Meeting notes.txt", "../secret", "a/../b", "/etc/passwd", "a%2F..%2Fb"]) {
    assert.equal((await SB.readCodeFile(s.ctx, s.client, REPO, C, path)).state, "unavailable", path);
  }
  assert.equal((await SB.readCodeFile(s.ctx, s.client, REPO, "main", "a.js")).state, "invalid");
  assert.equal(s.gh.calls.length, 1, "only the missing file was asked for");
});

test("lines keep their text; characters that hide or turn text are shown by their code", () => {
  assert.deepEqual(SB.textPieces('if (role !== "owner‮ ⁦// x⁩ ⁦") {'), [{ text: 'if (role !== "owner' }, { hidden: "U+202E" }, { text: " " },
    { hidden: "U+2066" }, { text: "// x" }, { hidden: "U+2069" }, { text: " " }, { hidden: "U+2066" }, { text: '") {' }]);
  assert.deepEqual(SB.textPieces("a​b­c﻿\u0007 "), [{ text: "a" }, { hidden: "U+200B" }, { text: "b" }, { hidden: "U+00AD" }, { text: "c" },
    { hidden: "U+FEFF" }, { hidden: "U+0007" }, { hidden: "U+2028" }]);
  assert.deepEqual(SB.textPieces("\tkeep <b>tabs</b> and café"), [{ text: "\tkeep <b>tabs</b> and café" }]);
  assert.deepEqual(SB.textPieces(""), [{ text: "" }]);
  assert.deepEqual(SB.textLines("a\r\nb\r\n"), { lines: ["a", "b"], total: 2, crlf: true });
  assert.deepEqual(SB.textLines("a\n\nb"), { lines: ["a", "", "b"], total: 3, crlf: false });
  const long = SB.textLines("x\n".repeat(SB.MAX_TEXT_LINES + 5));
  assert.deepEqual([long.lines.length, long.total], [SB.MAX_TEXT_LINES, SB.MAX_TEXT_LINES + 5]);
});

test("a patch becomes numbered diff lines, or plain lines when it is not in the diff form", () => {
  const d = SB.diffLines("@@ -3,3 +3,4 @@ function x() {\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file\n");
  assert.equal(d.ok, true);
  assert.deepEqual(d.lines.map(l => [l.kind, l.old, l.new, l.text]), [["hunk", undefined, undefined, "@@ -3,3 +3,4 @@ function x() {"], ["ctx", 3, 3, "a"],
    ["del", 4, null, "b"], ["add", null, 4, "c"], ["add", null, 5, "d"], ["ctx", 5, 6, "e"], ["note", undefined, undefined, "No newline at end of file"]]);
  assert.deepEqual(SB.diffLines("@@ -0,0 +1 @@\n+<script>x</script>").lines[1], { kind: "add", old: null, new: 1, text: "<script>x</script>" });
  const plain = SB.diffLines("Binary files a and b differ\n+x");
  assert.deepEqual([plain.ok, plain.lines.map(l => l.kind), plain.lines[0].text], [false, ["plain", "plain"], "Binary files a and b differ"]);
  assert.equal(SB.diffLines("@@ -1 +1 @@\n*odd").ok, false);
  const big = SB.diffLines("@@ -1 +1 @@\n" + "+x\n".repeat(SB.MAX_DIFF_LINES + 10));
  assert.deepEqual([big.lines.length, big.total], [SB.MAX_DIFF_LINES, SB.MAX_DIFF_LINES + 11]);
});

test("a commit's changes name the commit and its parents; a branch is resolved by GitHub, never guessed", async () => {
  const files = [changed("src/list.js"), changed("docs/new.md", { status: "renamed", previous_filename: "docs/old.md" }), changed("logo.png", { status: "added", patch: undefined, additions: 0, deletions: 0 })];
  let s = setup({}, [route("/commits/" + C, json(commitReply(C, { files }))), route("/commits/feature%2Fsearch", json(commitReply(BASE, { parents: [], files: [] })))]);
  let r = await SB.readCommitChanges(s.ctx, s.client, REPO, C);
  assert.equal(r.state, "current");
  assert.deepEqual([r.data.commit.sha, r.data.commit.title, r.data.commit.parents], [C, "Change the list", [BASE]]);
  assert.deepEqual(r.data.files.map(f => [f.path, f.status, f.from, f.added, f.removed, f.patch]), [["src/list.js", "modified", null, 1, 1, "@@ -1 +1 @@\n-a\n+b"],
    ["docs/new.md", "renamed", "docs/old.md", 1, 1, "@@ -1 +1 @@\n-a\n+b"], ["logo.png", "added", null, 0, 0, null]]);
  assert.deepEqual(r.source, { commit: C, repo: REPO, ref: C });
  r = await SB.readCommitChanges(s.ctx, s.client, REPO, "feature/search");
  assert.deepEqual([r.state, r.data.commit.sha, r.source.commit], ["empty", BASE, BASE]);
  assert.equal(s.gh.calls[1].url, SB.API + "/repos/acme/garden/commits/feature%2Fsearch");
  s = setup({}, [route("/commits/" + C, json(commitReply(C, { files: Array.from({ length: 300 }, (_, i) => changed("f" + i)) })))]);
  assert.equal((await SB.readCommitChanges(s.ctx, s.client, REPO, C)).state, "partial", "GitHub's 300-file cap is never shown as the whole change");
  s = setup({}, [route("/commits/" + C, json(commitReply(C, { files: [changed("a")] }), 200, { link: '<https://api.github.com/x?page=2>; rel="next"' }))]);
  assert.equal((await SB.readCommitChanges(s.ctx, s.client, REPO, C)).state, "partial", "a commit's file list that goes on is partial");
  s = setup({}, [route("/commits/" + C, json(commitReply(C, { files: [] }), 200, { link: '<https://api.github.com/x?page=2>; rel="next"' }))]);
  assert.deepEqual(await SB.readCommitChanges(s.ctx, s.client, REPO, C).then(x => [x.state, x.data.files.length]), ["partial", 0], "no file on this page is not no change");
  s = setup({}, [route("/commits/" + C, json(commitReply(C)))]);
  r = await SB.readCommitChanges(s.ctx, s.client, REPO, C);
  assert.deepEqual([r.state, r.data == null], ["invalid", true], "a reply without its list of files is never a change of no files");
  for (const bad of [{ filename: "../x" }, { status: "exploded" }, { additions: -1 }, { patch: 5 }, { previous_filename: "/abs" }]) {
    s = setup({}, [route("/commits/" + C, json(commitReply(C, { files: [changed("a", bad)] })))]);
    assert.equal((await SB.readCommitChanges(s.ctx, s.client, REPO, C)).state, "invalid", JSON.stringify(bad));
  }
  s = setup({}, [route("/commits/" + C, json({ sha: C }))]);
  assert.equal((await SB.readCommitChanges(s.ctx, s.client, REPO, C)).state, "invalid");
  s = setup();
  for (const ref of ["a..b/../c", "x y", "", "a;b", "<b>", "../main"]) assert.equal((await SB.readCommitChanges(s.ctx, s.client, REPO, ref)).state, "invalid", ref);
  assert.equal(s.gh.calls.length, 0, "an unusable name is never sent");
  assert.equal((await SB.readCommitChanges(s.ctx, s.client, REPO, "no-such-branch")).state, "missing");
});

test("a comparison gives GitHub's counts, common ancestor and changed files between two commit IDs", async () => {
  let s = setup({}, [route("/compare/" + BASE + "..." + C + "?per_page=1", json({ status: "diverged", ahead_by: 2, behind_by: 1, merge_base_commit: { sha: sha("mb") },
    files: [changed("src/a.js")] }))]);
  let r = await SB.readCompareChanges(s.ctx, s.client, REPO, BASE, C);
  assert.deepEqual([r.state, r.data.status, r.data.ahead, r.data.behind, r.data.mergeBase, r.data.files.length], ["current", "diverged", 2, 1, sha("mb"), 1]);
  // With one commit a page, GitHub's next page of a comparison lists more commits; its files are all on the first page.
  s = setup({}, [route("/compare/" + BASE + "..." + C + "?per_page=1", json({ status: "ahead", ahead_by: 2, behind_by: 0, merge_base_commit: { sha: BASE },
    files: [changed("src/a.js")] }, 200, { link: '<https://api.github.com/x?per_page=1&page=2>; rel="next"' }))]);
  assert.equal((await SB.readCompareChanges(s.ctx, s.client, REPO, BASE, C)).state, "current", "more commits are not more files");
  s = setup({}, [route("/compare/" + BASE + "..." + C + "?per_page=1", json({ status: "ahead", ahead_by: 400, behind_by: 0,
    files: Array.from({ length: 300 }, (_, i) => changed("f" + i)) }, 200, { link: '<https://api.github.com/x?per_page=1&page=2>; rel="next"' }))]);
  r = await SB.readCompareChanges(s.ctx, s.client, REPO, BASE, C);
  assert.deepEqual([r.state, r.coverage], ["partial", { shown: 300, total: null }], "GitHub's 300-file cap is never shown as the whole comparison");
  s = setup({}, [route("/compare/" + BASE + "..." + C + "?per_page=1", json({ status: "ahead", ahead_by: 1, behind_by: 0 }))]);
  r = await SB.readCompareChanges(s.ctx, s.client, REPO, BASE, C);
  assert.deepEqual([r.state, r.data == null], ["invalid", true], "a comparison without its list of files is never a change of no files");
  s = setup({}, [route("/compare/" + C + "..." + C + "?per_page=1", json({ status: "identical", ahead_by: 0, behind_by: 0, merge_base_commit: { sha: C }, files: [] }))]);
  assert.equal((await SB.readCompareChanges(s.ctx, s.client, REPO, C, C)).state, "empty");
  s = setup({}, [route("/compare/" + BASE + "..." + C + "?per_page=1", json({ status: "ahead", ahead_by: -1, behind_by: 0 }))]);
  assert.equal((await SB.readCompareChanges(s.ctx, s.client, REPO, BASE, C)).state, "invalid");
  s = setup();
  assert.equal((await SB.readCompareChanges(s.ctx, s.client, REPO, "main", C)).state, "invalid", "only commit IDs are compared");
  assert.equal(s.gh.calls.length, 0);
});

test("the code reads use their own keys per repository and commit", () => {
  assert.notEqual(SB.codeKey.tree(REPO, C), SB.codeKey.tree(REPO, BASE));
  assert.notEqual(SB.codeKey.text(REPO, C, "a"), SB.codeKey.text("acme/other", C, "a"));
  assert.notEqual(SB.codeKey.commit(REPO, "main"), SB.codeKey.commit(REPO, C));
  assert.notEqual(SB.codeKey.compare(REPO, BASE, C), SB.historyKey.compare(REPO, BASE, C), "file lists are not the history's counts");
});
