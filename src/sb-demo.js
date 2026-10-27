"use strict";
// The synthetic demo: a stand-in for the GitHub API that answers from the
// made-up repositories in demo-data.js, so the demo runs through the same
// client, readers and views as a private read. It makes no network request,
// needs no token and holds nothing private.

(function (root) {
  const SB = root.SB;

  function reply(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } });
  }

  function base64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return root.btoa(bin);
  }

  async function blobSha(text) {
    const bytes = new TextEncoder().encode(text);
    const head = new TextEncoder().encode("blob " + bytes.length + "\0");
    const all = new Uint8Array(head.length + bytes.length);
    all.set(head);
    all.set(bytes, head.length);
    const digest = await root.crypto.subtle.digest("SHA-1", all);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }

  // demo: {repos: {"owner/name": {status?, private, default_branch, commit, date, files: {path: text}, checks?, pulls?,
  //         issues?, runs?, releases? (a list in the API's shape, or {status} for a refusal),
  //         changes? (the demo commit's changed files), tree_extra? (tree entries with no file text: links, submodules, large files)}}}
  // Returns the request function SB.createClient takes, answering from memory.
  function demoServer(demo) {
    const repos = (demo && demo.repos) || {};
    return async function serve(url) {
      if (!String(url).startsWith(SB.API + "/")) throw new TypeError("the demo answers only the GitHub API paths");
      const path = String(url).slice(SB.API.length);
      if (path === "/user") return reply({ login: "demo-user", type: "User" });
      // The demo token reads no repository beyond the demo's own workspace list.
      if (/^[/]user[/]repos[?]/.test(path)) return reply([]);
      let m = /^[/]repos[/]([^/]+[/][^/?]+)(.*)$/.exec(path);
      const r = m && Object.prototype.hasOwnProperty.call(repos, m[1]) ? repos[m[1]] : null;
      if (!r) return reply({ message: "Not Found" }, 404);
      if (r.status) return reply({ message: "synthetic refusal" }, r.status);
      const name = m[1], rest = m[2];
      if (rest === "") return reply(Object.assign({ full_name: name, private: r.private !== false, default_branch: r.default_branch || "main" }, r.meta || {}));
      if (rest === "/languages") return r.languages && r.languages.status ? reply({ message: "synthetic refusal" }, r.languages.status) : reply(r.languages || {});
      const all = r.commits || [{ sha: r.commit, commit: { message: "Synthetic commit", committer: { date: r.date || null } }, parents: [] }];
      // The commits behind one, newest first, as GitHub lists them.
      const behind = sha => {
        const by = new Map(all.map(c => [c.sha, c])), seen = new Set(), todo = [sha];
        while (todo.length) { const x = todo.pop(); if (seen.has(x) || !by.has(x)) continue; seen.add(x); todo.push(...by.get(x).parents.map(p => p.sha)); }
        return all.filter(c => seen.has(c.sha)).sort((a, b) => Date.parse(b.commit.committer.date) - Date.parse(a.commit.committer.date));
      };
      if ((m = /^[/]commits[?]sha=([0-9a-f]{40})&per_page=(\d+)(?:&page=(\d+))?$/.exec(rest))) {
        if (!all.some(c => c.sha === m[1])) return reply({ message: "No commit found for SHA" }, 404);
        const per = Number(m[2]), page = Number(m[3] || 1);
        return reply(behind(m[1]).slice((page - 1) * per, page * per));
      }
      if ((m = /^[/](branches|tags)[?]per_page=100&page=(\d+)$/.exec(rest))) {
        const list = r[m[1]] || (m[1] === "branches" ? [{ name: r.default_branch || "main", commit: { sha: r.commit } }] : []);
        return reply(list.slice((Number(m[2]) - 1) * 100, Number(m[2]) * 100));
      }
      if ((m = /^[/]compare[/]([0-9a-f]{40})[.]{3}([0-9a-f]{40})[?]per_page=1$/.exec(rest))) {
        if (!all.some(c => c.sha === m[1]) || !all.some(c => c.sha === m[2])) return reply({ message: "Not Found" }, 404);
        const base = behind(m[1]), head = behind(m[2]);
        const inBase = new Set(base.map(c => c.sha)), inHead = new Set(head.map(c => c.sha));
        const ahead = head.filter(c => !inBase.has(c.sha)).length, back = base.filter(c => !inHead.has(c.sha)).length;
        const common = head.find(c => inBase.has(c.sha));
        return reply({ status: ahead && back ? "diverged" : ahead ? "ahead" : back ? "behind" : "identical", ahead_by: ahead, behind_by: back,
                       merge_base_commit: common ? { sha: common.sha } : null, commits: head.filter(c => !inBase.has(c.sha)).slice(-1),
                       files: m[2] === r.commit && ahead ? r.changes || [] : [] });
      }
      // Files: the tree at the demo commit, with a folder entry for every folder a path is in.
      if ((m = /^[/]git[/]trees[/]([0-9a-f]{40})[?]recursive=1$/.exec(rest))) {
        if (m[1] !== r.commit) return reply({ message: "Not Found" }, 404);
        const entries = [];
        for (const [path, text] of Object.entries(r.files || {})) {
          entries.push({ path, mode: "100644", type: "blob", sha: await blobSha(text), size: new TextEncoder().encode(text).length });
        }
        entries.push(...(r.tree_extra || []));
        const dirs = new Set();
        for (const e of entries) for (let i = e.path.indexOf("/"); i > 0; i = e.path.indexOf("/", i + 1)) dirs.add(e.path.slice(0, i));
        for (const path of dirs) entries.push({ path, mode: "040000", type: "tree", sha: await blobSha("tree " + path) });
        return reply({ sha: r.commit, truncated: false, tree: entries.sort((a, b) => a.path < b.path ? -1 : 1) });
      }
      if (rest === "/issues/comments?sort=created&direction=desc&per_page=50") {
        const all = (r.pulls || []).flatMap(p => (p.comments || []).map(c => Object.assign({ issue_url: SB.API + "/repos/" + name + "/issues/" + p.number }, c)));
        return reply(all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 50));
      }
      if ((m = /^[/]commits[/]([0-9a-f]{40})[/]check-runs[?]per_page=100&page=(\d+)$/.exec(rest))) {
        if (m[1] !== r.commit || !r.checks) return reply({ total_count: 0, check_runs: [] });
        if (r.checks.status) return reply({ message: "synthetic refusal" }, r.checks.status);
        const page = Number(m[2]);
        return reply({ total_count: r.checks.length, check_runs: r.checks.slice((page - 1) * 100, page * 100) });
      }
      // Work evidence: lists by state, newest first, a page of 100 at a time.
      const pageOf = (list, page) => list.slice((page - 1) * 100, page * 100);
      const byState = (list, state) => list.filter(x => state === "all" || x.state === state).sort((a, b) => b.number - a.number);
      if ((m = /^[/]pulls[?]state=(open|closed|all)&per_page=100&page=(\d+)$/.exec(rest))) {
        return reply(pageOf(byState(r.pulls || [], m[1]), Number(m[2])).map(p => {
          const { comments, reviews, ...pr } = p;
          return pr;
        }));
      }
      if ((m = /^[/]pulls[/](\d+)[/]reviews[?]per_page=100&page=(\d+)$/.exec(rest))) {
        const pr = (r.pulls || []).find(p => p.number === Number(m[1]));
        return pr ? reply(pageOf(pr.reviews || [], Number(m[2]))) : reply({ message: "Not Found" }, 404);
      }
      // GitHub's issue list holds the pull requests too, marked as such.
      if ((m = /^[/]issues[?]state=(open|closed|all)&per_page=100&page=(\d+)$/.exec(rest))) {
        if (r.issues && r.issues.status) return reply({ message: "synthetic refusal" }, r.issues.status);
        const pulls = (r.pulls || []).map(p => ({ number: p.number, title: p.title, state: p.state, user: p.user, created_at: p.created_at,
                                                   closed_at: p.closed_at, pull_request: {} }));
        return reply(pageOf(byState([...(r.issues || []), ...pulls], m[1]), Number(m[2])));
      }
      if ((m = /^[/](actions[/]runs|releases)[?]per_page=100&page=(\d+)$/.exec(rest))) {
        const list = m[1] === "releases" ? r.releases || [] : r.runs || [];
        if (list.status) return reply({ message: "synthetic refusal" }, list.status);
        const page = pageOf(list, Number(m[2]));
        return reply(m[1] === "releases" ? page : { total_count: list.length, workflow_runs: page });
      }
      if ((m = /^[/]issues[/](\d+)[/]comments[?]per_page=100&page=(\d+)$/.exec(rest))) {
        const pr = (r.pulls || []).find(p => p.number === Number(m[1]));
        if (!pr) return reply({ message: "Not Found" }, 404);
        const page = Number(m[2]);
        return reply(pr.comments.slice((page - 1) * 100, page * 100));
      }
      // A commit by branch, tag or ID, with the files it changed (only the demo commit has any).
      if ((m = /^[/]commits[/]([^/?]+)$/.exec(rest))) {
        const ref = decodeURIComponent(m[1]);
        const named = [...(r.branches || []), ...(r.tags || [])].find(x => x.name === ref);
        const sha = ref === (r.default_branch || "main") ? r.commit : named ? named.commit.sha : ref;
        const c = all.find(x => x.sha === sha);
        if (!c) return reply({ message: "No commit found" }, 404);
        return reply(Object.assign({}, c, { commit: { message: c.commit.message, committer: { date: c.commit.committer.date || r.date || null } },
                                            files: sha === r.commit ? r.changes || [] : [] }));
      }
      if ((m = /^[/]contents[/](.+)[?]ref=([0-9a-f]{40})$/.exec(rest))) {
        const files = r.files || {};
        if (m[2] !== r.commit || !Object.prototype.hasOwnProperty.call(files, m[1])) return reply({ message: "Not Found" }, 404);
        const text = files[m[1]];
        return reply({ type: "file", encoding: "base64", sha: await blobSha(text), content: base64(text) });
      }
      return reply({ message: "Not Found" }, 404);
    };
  }

  Object.assign(SB, { demoServer });
})(typeof window !== "undefined" ? window : globalThis);
