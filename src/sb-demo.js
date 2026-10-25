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

  // demo: {repos: {"owner/name": {status?, private, default_branch, commit, date, files: {path: text}, checks?}}}
  // Returns the request function SB.createClient takes, answering from memory.
  function demoServer(demo) {
    const repos = (demo && demo.repos) || {};
    return async function serve(url) {
      if (!String(url).startsWith(SB.API + "/")) throw new TypeError("the demo answers only the GitHub API paths");
      const path = String(url).slice(SB.API.length);
      let m = /^[/]repos[/]([^/]+[/][^/?]+)(.*)$/.exec(path);
      const r = m && Object.prototype.hasOwnProperty.call(repos, m[1]) ? repos[m[1]] : null;
      if (!r) return reply({ message: "Not Found" }, 404);
      if (r.status) return reply({ message: "synthetic refusal" }, r.status);
      const rest = m[2];
      if (rest === "") return reply({ full_name: m[1], private: r.private !== false, default_branch: r.default_branch || "main" });
      if ((m = /^[/]commits[/]([0-9a-f]{40})[/]check-runs[?]per_page=100&page=(\d+)$/.exec(rest))) {
        if (m[1] !== r.commit || !r.checks) return reply({ total_count: 0, check_runs: [] });
        if (r.checks.status) return reply({ message: "synthetic refusal" }, r.checks.status);
        const page = Number(m[2]);
        return reply({ total_count: r.checks.length, check_runs: r.checks.slice((page - 1) * 100, page * 100) });
      }
      if ((m = /^[/]commits[/]([^/?]+)$/.exec(rest))) {
        const ref = decodeURIComponent(m[1]);
        if (ref !== (r.default_branch || "main") && ref !== r.commit) return reply({ message: "No commit found" }, 404);
        return reply({ sha: r.commit, commit: { committer: { date: r.date || null } } });
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
