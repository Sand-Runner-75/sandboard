"use strict";
// Atlas branch graph, the model: which branches are drawn, how far back their commits are read, and
// where every commit, line, label and key entry goes. Git-flow lanes: one lane per branch, coloured by
// the kind of branch, with merges and tags. Adapted from the owner's own earlier app (the same author's
// branch graph: its lane, window and layout rules, colours and sizes), reused with the owner's permission
// and changed to read through this site's read-only client: commits come from the cached pages of each
// branch's head, so nothing here fetches, and the layout is plain data for the view to draw.
// Everything is read-only GitHub evidence and none of it is progress.

(function (root) {
  const SB = root.SB;

  const FLOW = [
    { k: "main", c: "#e5534b", t: (n, def) => n === def || /^(main|master|trunk)$/i.test(n) },
    { k: "hotfix", c: "#26a865", t: n => /^(hotfix|bugfix|fix)[/-]/i.test(n) },
    { k: "release", c: "#d9821b", t: n => /^release[/-]/i.test(n) },
    { k: "develop", c: "#3b76f0", t: n => /^(develop|development|dev|next)$/i.test(n) },
    { k: "feature", c: "#9b59c9", t: n => /^(feature|feat)[/-]/i.test(n) },
    { k: "other", c: "#7d8b92", t: () => true },
  ];
  const flowOf = (name, def) => FLOW.find(f => f.t(name, def));
  // Branches that fit no git-flow kind each get their own colour, so they can be told apart.
  const OTHER = ["#17a2a2", "#d4508e", "#b39a1b", "#45a6d6", "#e07a5f", "#86b32a", "#a0785a", "#7d8b92"];
  // Which branch claims a commit first: main, then develop, then the short-lived kinds.
  const RANK = ["main", "develop", "release", "hotfix", "feature", "other"];
  const rankOf = (name, def) => RANK.indexOf(flowOf(name, def).k);
  // The graph starts with the newest commits and shows older ones a step at a time.
  const FIRST = 100, MORE = 200, REACH = 500, BRANCHES = 15;
  const time = c => c && c.date ? Date.parse(c.date) : 0;
  const K = () => SB.historyKey;

  const older = show => show + Math.min(2000, Math.max(MORE, Math.round(show / 2)));

  // What the graph of a repository can show from the reads in live (key => result), and the reads it
  // still wants: the branch list, then pages of each drawn branch's commits until the newest `show`
  // gap-free commits are in (back to where each branch left the default branch), the tags, and the
  // pull requests that name branches.
  function atlasGraph(live, repo, def, show) {
    const wanted = [];
    const br = live(K().refs(repo, "branches"));
    if (!br) return { state: "loading", wanted: [{ kind: "refs", list: "branches" }] };
    if (br.state === "loading") return { state: "loading", wanted };
    if (!br.data) return { state: br.state, error: br.error || null, wanted, retry: true };
    const list = br.data.refs;
    if (!list.length) return { state: "empty", wanted };
    const pick = list.slice().sort((a, b) => rankOf(a.name, def) - rankOf(b.name, def) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, BRANCHES);
    const g = { pick, commits: new Map(), page: new Map(), oldest: new Map(), more: new Set(pick.map(b => b.name)), def, show };
    let reading = false, failed = null;
    for (const b of pick) {
      for (let p = 1; ; p++) {
        const res = live(K().lane(repo, b.sha, p));
        if (!res) break;
        if (res.state === "loading") { reading = true; break; }
        if (!res.data) { failed = failed || { branch: b.name, state: res.state, error: res.error || null }; break; }
        for (const c of res.data.commits) {
          if (!g.commits.has(c.sha)) g.commits.set(c.sha, { sha: c.sha, parents: c.parents, date: c.at, msg: c.title, author: c.author || "" });
        }
        g.page.set(b.name, p);
        if (res.data.commits.length) g.oldest.set(b.name, res.data.commits[res.data.commits.length - 1].sha);
        if (res.data.end) { g.more.delete(b.name); break; }
      }
    }
    const w = graphWindow(g);
    if (w.need && w.open.length && !reading && !failed) {
      const edge = Math.min(w.all[show - 1] ? time(w.all[show - 1]) : -Infinity, w.oldest);
      for (const b of w.open) {
        if (g.oldest.has(b.name) && time(g.commits.get(g.oldest.get(b.name))) < edge) continue;
        wanted.push({ kind: "lane", head: b.sha, page: (g.page.get(b.name) || 0) + 1 });
      }
    }
    // Tags, and the newest pull request opened from each branch so labels can say "PR #12".
    const tags = live(K().refs(repo, "tags"));
    if (!tags) wanted.push({ kind: "refs", list: "tags" });
    const all = live(SB.workKey.list("pulls", repo, "all", 1));
    if (!all) wanted.push({ kind: "pulls", state: "all", page: 1 });
    // A busy repository has more than the newest 100; its open pull requests are the ones its branches most likely have.
    const open = all && all.data && all.data.pulls.length === 100 ? live(SB.workKey.list("pulls", repo, "open", 1)) : null;
    if (all && all.data && all.data.pulls.length === 100 && !open) wanted.push({ kind: "pulls", state: "open", page: 1 });
    const prOf = new Map();
    for (const res of [all, open]) {
      if (!res || !res.data) continue;
      for (const p of res.data.pulls) if (p.headRef && (!p.headRepo || p.headRepo === repo) && !prOf.has(p.headRef)) prOf.set(p.headRef, p.number);
    }
    const heads = pick.map(b => ({ name: b.name, sha: b.sha, pr: prOf.get(b.name) }));
    const tagList = tags && tags.data ? tags.data.refs.map(t => ({ name: t.name, sha: t.sha })) : [];
    const loading = reading || wanted.some(x => x.kind === "lane");
    // The tags and pull requests are read apart from the commits: their own state goes with the graph, so a
    // list that could not be read is never shown as one GitHub gave empty.
    const meta = { tags: readState(tags), pulls: open && open.data === null ? readState(open) : readState(all) };
    if (meta.pulls.state === "current" && all && all.state === "partial" && !(open && open.data)) meta.pulls = { state: "partial", error: null };
    const retry = !!failed || meta.tags.failed || meta.pulls.failed;
    return { state: failed ? failed.state : loading && !w.win.length ? "loading" : "current", error: failed ? failed.error : null,
             failed, reading: loading, wanted, retry, meta,
             pick, total: list.length, partialBranches: br.state === "partial", win: w.win, more: w.more, heads, tags: tagList };
  }
  // A list's read state: loading, read (current, empty or partial), or failed with its error.
  function readState(res) {
    if (!res || res.state === "loading") return { state: "loading", error: null, failed: false };
    if (!res.data) return { state: res.state, error: res.error || null, failed: true };
    return { state: res.state, error: null, failed: false };
  }

  // Branches that may still have older commits on GitHub. A branch whose oldest read commit already has its
  // parents read (they came with another branch) is skipped, since that branch brings the rest.
  const graphOpen = g => g.pick.filter(b => {
    const c = g.commits.get(g.oldest.get(b.name));
    return g.more.has(b.name) && !(c && c.parents.every(p => g.commits.has(p)));
  });
  // Only commits newer than every open branch's oldest read commit are known to have no gaps.
  function graphComplete(g) {
    const open = graphOpen(g), all = [...g.commits.values()].sort((a, b) => time(b) - time(a));
    const cut = open.length ? Math.max(...open.map(b => g.oldest.has(b.name) ? time(g.commits.get(g.oldest.get(b.name))) : Infinity)) : -Infinity;
    return { open, all, done: all.filter(c => time(c) >= cut) };
  }
  // The commits a window must reach so its lines join up: the default branch's head, and where each shown
  // branch left the default branch's history. Fork points far back (over REACH commits past the window) are left out.
  function graphAnchors(g, all) {
    const at = new Map(all.map((c, i) => [c.sha, i])), mainSet = new Set();
    const defHead = (g.pick.find(b => b.name === g.def) || {}).sha;
    for (const st = defHead ? [defHead] : []; st.length;) {
      const sha = st.pop();
      if (mainSet.has(sha) || !g.commits.has(sha)) continue;
      mainSet.add(sha); st.push(...g.commits.get(sha).parents);
    }
    const out = defHead && at.has(defHead) ? [defHead] : [];
    for (const b of g.pick) {
      if (b.name === g.def || !(at.get(b.sha) < g.show)) continue;
      let c = g.commits.get(b.sha);
      while (c && !mainSet.has(c.sha)) c = g.commits.get(c.parents[0]);
      if (c) out.push(c.sha);
    }
    return out.filter(sha => at.get(sha) < g.show + REACH).map(sha => g.commits.get(sha));
  }
  // The commits to draw: the newest `show` gap-free ones, reaching back to the anchors when they are in.
  function graphWindow(g) {
    const { open, all, done } = graphComplete(g), anchors = graphAnchors(g, all);
    const oldest = anchors.reduce((t, c) => Math.min(t, time(c)), Infinity);
    let n = Math.min(g.show, done.length);
    while (n < done.length && time(done[n]) >= oldest) n++;
    const last = done.length ? time(done[done.length - 1]) : Infinity;
    return { open, all, done, win: done.slice(0, n), more: open.length > 0 || done.length > n,
             need: anchors.some(c => time(c) < last) || done.length < g.show, oldest };
  }

  // ---- Layout: where everything goes, as plain data.

  const COL = 34, ROW = 62, PADL = 46, TOP = 40, R = 8;
  const day = t => typeof t === "string" ? SB.localDay(t) || t.slice(0, 10) : "no time given";
  const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;

  function atlasLayout(def, all, heads, tags) {
    const win = new Map(all.map(c => [c.sha, Object.assign({}, c)]));
    if (!win.size) return null;
    // Oldest first, but never before a parent (commit dates can be out of order).
    const order = [], placed = new Set(), left = [...win.values()].sort((a, b) => time(a) - time(b));
    const ready = c => c.parents.every(p => !win.has(p) || placed.has(p));
    for (let first = 0; order.length < left.length;) {
      while (placed.has(left[first].sha)) first++;
      let i = first;
      while (i < left.length && (placed.has(left[i].sha) || !ready(left[i]))) i++;
      const c = left[i < left.length ? i : first];
      c.x = order.length; order.push(c); placed.add(c.sha);
    }
    // Each branch claims its first-parent chain, most important branches first.
    const lanes = [], laneOf = new Map();
    const walk = (sha, lane) => {
      lane.commits = [];
      for (let c = win.get(sha); c && !laneOf.has(c.sha); c = win.get(c.parents[0])) { laneOf.set(c.sha, lane); lane.commits.push(c); }
      if (lane.commits.length) lanes.push(lane);
    };
    // Of two branches of one kind sharing commits, the one with the older pull request claims them.
    const byPr = (a, b) => (a.pr ? 0 : 1) - (b.pr ? 0 : 1) || (a.pr || 0) - (b.pr || 0);
    // The branch the graph is drawn for claims its commits before any other.
    const own = b => b.name === def ? 0 : 1;
    for (const b of heads.slice().sort((a, b) => own(a) - own(b) || rankOf(a.name, def) - rankOf(b.name, def) || byPr(a, b))) walk(b.sha, { name: b.name, flow: flowOf(b.name, def), pr: b.pr });
    // The first commit that merged each commit in.
    const mergedBy = new Map();
    for (const k of order) for (const p of k.parents.slice(1)) if (!mergedBy.has(p)) mergedBy.set(p, k);
    // What is left was merged from a branch that has since been deleted; it is named from the merge message.
    for (const c of order.slice().reverse()) {
      if (laneOf.has(c.sha)) continue;
      const m = (mergedBy.get(c.sha) || {}).msg || "";
      const named = /Merge branch '([^']+)'/.exec(m) || /Merge pull request #\d+ from [^\s/]+[/](\S+)/.exec(m);
      const name = named ? named[1] : "merged branch";
      const pr = /Merge pull request #(\d+)/.exec(m);
      walk(c.sha, { name, flow: flowOf(name, def), pr: pr ? Number(pr[1]) : undefined, gone: true });
    }
    // A lane spans from the commit it forked from to the last commit it merged into.
    for (const k of order) for (const p of k.parents.slice(1)) { const l = laneOf.get(p); if (l) (l.into = l.into || []).push(k.x); }
    for (const l of lanes) {
      const base = win.get(l.commits[l.commits.length - 1].parents[0]);
      const xs = [...l.commits.map(c => c.x), ...(base ? [base.x] : []), ...(l.into || [])];
      l.lo = Math.min(...xs); l.hi = Math.max(...xs);
    }
    // Rows go main, hotfix, release, develop, feature, other; branches of one kind share a row when they don't overlap.
    const rows = [];
    lanes.sort((a, b) => FLOW.indexOf(a.flow) - FLOW.indexOf(b.flow) || a.lo - b.lo);
    for (const l of lanes) {
      let row = rows.find(r => r.flow === l.flow && r.hi + 3 < l.lo);
      if (!row) rows.push(row = { flow: l.flow });
      row.hi = l.hi; l.row = rows.indexOf(row);
    }
    let nOther = 0;
    for (const l of lanes) l.c = l.flow.k === "other" ? OTHER[nOther++ % OTHER.length] : l.flow.c;
    const laneNamed = new Map(lanes.map(l => [l.name, l]));
    const W = PADL * 2 + (order.length - 1) * COL, H = TOP + (rows.length - 1) * ROW + 46;
    const X = c => PADL + c.x * COL, Y = c => TOP + laneOf.get(c.sha).row * ROW;
    const path = (p, c, merge) => {
      const x1 = X(p), y1 = Y(p), x2 = X(c), y2 = Y(c);
      if (y1 === y2) return "M" + x1 + " " + y1 + "H" + x2;
      // Branch-offs turn right after the parent, merges turn right before the child.
      const xb = merge ? x2 - COL / 2 : x1 + COL / 2, s = y2 > y1 ? 1 : -1, r = Math.min(10, Math.abs(y2 - y1) / 2);
      return "M" + x1 + " " + y1 + "H" + (xb - r) + "Q" + xb + " " + y1 + " " + xb + " " + (y1 + s * r) + "V" + (y2 - s * r) + "Q" + xb + " " + y2 + " " + (xb + r) + " " + y2 + "H" + x2;
    };
    // s is the step each piece appears at, so the replay can reveal the graph commit by commit. Each line takes its
    // branch's colour: a merge line the merged branch's, any other line the child's.
    const edges = [];
    for (const c of order) c.parents.forEach((p, i) => {
      if (win.has(p)) edges.push({ s: c.x, d: path(win.get(p), c, i > 0), color: laneOf.get(i > 0 ? p : c.sha).c });
      else if (i === 0) edges.push({ s: c.x, d: "M" + (X(c) - COL * 0.7) + " " + Y(c) + "H" + X(c), color: laneOf.get(c.sha).c, dashed: true });
    });
    const at = list => { const m = new Map(); for (const t of list) if (win.has(t.sha)) m.set(t.sha, [...(m.get(t.sha) || []), t.name]); return m; };
    const tagsAt = at(tags), headsAt = at(heads);
    // Branch labels show just the pull request number when there is one; the key names each colour.
    const prNamed = new Map(heads.filter(b => b.pr).map(b => [b.name, b.pr]));
    const short = name => prNamed.has(name) ? "PR #" + prNamed.get(name) : name;
    const flag = (x, y, names, color, above, s, label) => {
      let text = cut(label || names[0], 24);
      if (names.length > 1) text += " +" + (names.length - 1);
      const w = text.length * 6.1 + 12, h = 16, fx = Math.min(W - w - 2, Math.max(2, x - w / 2)), fy = above ? y - R - 6 - h : y + R + 6;
      const points = above ? [[x - 4, fy + h], [x + 4, fy + h], [x, fy + h + 4]] : [[x - 4, fy], [x + 4, fy], [x, fy - 4]];
      return { s, x: fx, y: fy, w, h, text, color, tip: names.join("\n"), points, kind: above ? "tag" : "branch" };
    };
    const nodes = order.map(c => {
      const l = laneOf.get(c.sha);
      return { s: c.x, sha: c.sha, x: X(c), y: Y(c), r: R, color: l.c,
               tip: c.msg + "\n" + c.sha.slice(0, 7) + " on " + l.name + (l.gone ? " (deleted)" : "") + "\n" + (c.author ? c.author + " · " : "") + day(c.date) };
    });
    const flags = [];
    for (const c of order) {
      const t = tagsAt.get(c.sha), h = headsAt.get(c.sha);
      if (t) flags.push(flag(X(c), Y(c), t, laneOf.get(c.sha).c, true, c.x));
      if (h) flags.push(flag(X(c), Y(c), h, (laneNamed.get(h[0]) || laneOf.get(c.sha)).c, false, c.x, short(h[0])));
    }
    const guides = rows.map((_, i) => TOP + i * ROW);
    const nTags = [...tagsAt.values()].reduce((a, t) => a + t.length, 0);
    // A long history merges many deleted branches; the key lists only the newest of them.
    const uniq = [...new Map(lanes.map(l => [l.name + l.c, l])).values()], goneAll = uniq.filter(l => l.gone).sort((a, b) => b.hi - a.hi);
    const keyed = uniq.filter(l => !l.gone || goneAll.indexOf(l) < 8), hidden = goneAll.length - Math.min(8, goneAll.length);
    return { W, H, guides, edges, nodes, flags, commits: order.length, lines: lanes.length, tags: nTags, hidden,
             key: keyed.map(l => ({ color: l.c, label: l.pr ? "PR #" + l.pr : l.gone ? "—" : cut(l.name, 24), name: l.name, gone: !!l.gone })),
             steps: order.map(c => ({ date: c.date, msg: c.msg, x: X(c) })) };
  }

  // ---- Versions: the long-lived branches a repository keeps a version of its product on (its default
  // branch and, say, a staging branch), each drawn on its own: the commits behind that branch, the pull
  // requests merged into it as lanes of their own, the open ones that target it, and every pull request
  // whose base is that branch. Plain data from the same cached reads as the branch graph.

  // Branch names that usually hold a version, offered first and picked to start with.
  const VERSION = /^(main|master|trunk|staging|stage|stg|develop|development|dev|next|preview|beta|alpha|production|prod|live|v\d+(?:\.\d+)*|version[-_/]?\d+)$/i;
  const VERSIONS = 6, START = 4, PR_FIRST = 3, PR_MAX = 9, OPEN_LANES = 8, VERSION_PAGES = 30, OPEN_PAGES = 3, OPEN_DRAW = 100;

  // The version branches to start with: the default branch, then the others whose names say version.
  function versionStart(list, def) {
    const named = list.filter(b => b.name !== def && VERSION.test(b.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return [...list.filter(b => b.name === def), ...named].slice(0, START).map(b => b.name);
  }

  // What the versions of a repository can show from the reads in live, and the reads they still want.
  // picked: the chosen branch names (null: the starting ones); showOf(name): how many commits that version
  // shows; prPages: how many pages of the repository's pull requests (newest first) are read.
  function atlasVersions(live, repo, def, picked, showOf, prPages, sharedOf) {
    const wanted = [];
    const br = live(K().refs(repo, "branches"));
    if (!br) return { state: "loading", wanted: [{ kind: "refs", list: "branches" }] };
    if (br.state === "loading") return { state: "loading", wanted };
    if (!br.data) return { state: br.state, error: br.error || null, wanted, retry: true };
    const list = br.data.refs;
    if (!list.length) return { state: "empty", wanted };
    const byName = new Map(list.map(b => [b.name, b]));
    const start = versionStart(list, def);
    const names = (picked || start).filter(n => byName.has(n)).slice(0, VERSIONS);
    // The repository's pull requests, newest first, page by page: one list serves every version.
    const pulls = [], pages = Math.max(1, Math.min(PR_MAX, prPages || PR_FIRST));
    let prState = "current", prError = null, prEnd = false, prRead = 0;
    for (let p = 1; p <= pages; p++) {
      const res = live(SB.workKey.list("pulls", repo, "all", p));
      if (!res) { wanted.push({ kind: "pulls", state: "all", page: p }); prState = "loading"; break; }
      if (res.state === "loading") { prState = "loading"; break; }
      if (!res.data) { prState = res.state; prError = res.error || null; break; }
      pulls.push(...res.data.pulls); prRead = p;
      if (res.data.end) { prEnd = true; break; }
    }
    const prs = { state: prState, error: prError, failed: !["current", "loading"].includes(prState), end: prEnd, pages: prRead, more: !prEnd && prRead >= pages && pages < PR_MAX };
    let failed = null;
    const defBranch = byName.get(def);
    const versions = names.map(name => {
      const b = byName.get(name), show = showOf(name) || FIRST;
      // A version other than the default branch shows only its own commits: those not in the default
      // branch's history. sharedOf(name) shows the shared ones too.
      const apart = name !== def && !!defBranch && !(sharedOf && sharedOf(name)) && defBranch.sha !== b.sha;
      // Which commits are its own is proved from ancestry, never from dates. GitHub's comparison of the two
      // heads gives their merge base and how many commits the version has that the default branch has not.
      // A commit the merge base reaches is shared; one that reaches the merge base, or reaches a commit
      // proved its own, is its own; once the merge base's whole history is read, or as many own commits are
      // proved as the comparison counts, every other commit read is known too. Anything else is unknown:
      // counted and said, never drawn as the version's own. (With more than one merge base, which a criss-
      // cross merge can make, GitHub names one; the shared side is then still never shown as own.)
      let cmp = null, cmpFailed = null;
      if (apart) {
        const res = live(K().compare(repo, defBranch.sha, b.sha));
        if (!res) wanted.push({ kind: "compare", base: defBranch.sha, head: b.sha });
        else if (res.state !== "loading" && !res.data) cmpFailed = { branch: name, state: res.state, error: res.error || null };
        else if (res.data) cmp = res.data;
      }
      const seen = [];
      let reading = false, end = false, broke = null, pB = 0;
      let mark = new Map();  // sha => "own" | "shared"
      const prove = () => {
        mark = new Map();
        if (!cmp) return;
        const at = new Map(seen.map(c => [c.sha, c]));
        if (cmp.base === null) { for (const c of seen) mark.set(c.sha, "own"); return; }
        // The merge base and everything it reaches inside what was read is shared.
        let whole = at.has(cmp.base);
        for (const st = [cmp.base]; st.length;) {
          const sha = st.pop();
          if (mark.has(sha)) continue;
          const c = at.get(sha);
          if (!c) { whole = false; continue; }
          mark.set(sha, "shared"); st.push(...c.parents);
        }
        // Oldest first: a commit with a parent that is the merge base or its own is its own.
        for (let i = seen.length - 1; i >= 0; i--) {
          const c = seen[i];
          if (!mark.has(c.sha) && c.parents.some(p => p === cmp.base || mark.get(p) === "own")) mark.set(c.sha, "own");
        }
        for (let again = true; again;) {
          again = false;
          for (const c of seen) if (!mark.has(c.sha) && c.parents.some(p => mark.get(p) === "own")) { mark.set(c.sha, "own"); again = true; }
        }
        const owned = seen.filter(c => mark.get(c.sha) === "own").length, left = seen.filter(c => !mark.has(c.sha));
        if (owned >= cmp.ahead) for (const c of left) mark.set(c.sha, "shared");
        // The merge base's whole history read: the rest are its own, if their count agrees with GitHub's.
        else if (whole && owned + left.length === cmp.ahead) for (const c of left) mark.set(c.sha, "own");
      };
      const own = () => apart ? seen.filter(c => mark.get(c.sha) === "own") : seen;
      const allKnown = () => !apart || (cmp && own().length >= cmp.ahead);
      while (!cmpFailed && !(apart && !cmp) && own().length < show && !(apart && allKnown()) && !end && pB < VERSION_PAGES) {
        const res = live(K().lane(repo, b.sha, pB + 1));
        if (!res) { wanted.push({ kind: "lane", head: b.sha, page: pB + 1 }); reading = true; break; }
        if (res.state === "loading") { reading = true; break; }
        if (!res.data) { broke = { branch: name, state: res.state, error: res.error || null }; break; }
        pB++; seen.push(...res.data.commits);
        if (res.data.end) end = true;
        prove();
      }
      if (apart && cmp && !pB) prove();
      broke = broke || cmpFailed;
      if (apart && !cmp && !cmpFailed) reading = true;
      const unknown = apart ? seen.filter(c => !mark.has(c.sha)).length : 0;
      failed = failed || broke;
      const mineAll = own();
      const win = mineAll.slice(0, show).map(c => ({ sha: c.sha, parents: c.parents, date: c.at, msg: c.title, author: c.author || "" }));
      const inWin = new Map(win.map(c => [c.sha, c]));
      const mine = pulls.filter(p => p.baseRef === name);
      // Merged pull requests whose last commit is in the window are lanes of their own; one merged by
      // squash or rebase left no commit of its own here, so its mark sits on the commit it became.
      const heads = [{ name, sha: b.sha }], marks = [];
      for (const p of mine) {
        if (!p.merged) continue;
        if (inWin.has(p.head)) heads.push({ name: p.headRef || "PR #" + p.number, sha: p.head, pr: p.number });
        else if (p.mergeCommit && inWin.has(p.mergeCommit)) marks.push({ name: "PR #" + p.number, sha: p.mergeCommit });
      }
      // Open pull requests from this repository's own branches: their newest commits, down to where they
      // leave this version, drawn as lanes too (at most OPEN_LANES of them).
      // What is not drawn is said: open ones from forks, those past the limit, and those whose commits could not be read.
      const openAll = mine.filter(p => p.state === "open"), ownOpen = openAll.filter(p => !p.headRepo || p.headRepo === repo);
      const open = ownOpen.slice(0, OPEN_LANES);
      const lanes = { forks: openAll.length - ownOpen.length, capped: ownOpen.length - open.length, failed: [] };
      let openReading = false;
      lanes.cut = [];
      for (const p of open) {
        // Its newest commits, page by page (at most OPEN_PAGES), until its first-parent line reaches this version.
        const by = new Map();
        let stop = null;
        for (let pg = 1; pg <= OPEN_PAGES; pg++) {
          const res = live(K().lane(repo, p.head, pg));
          if (!res) { wanted.push({ kind: "lane", head: p.head, page: pg }); stop = "wait"; break; }
          if (res.state === "loading") { stop = "wait"; break; }
          if (!res.data) { stop = { state: res.state, error: res.error || null }; break; }
          for (const c of res.data.commits) by.set(c.sha, c);
          if (res.data.end) break;
          let c = by.get(p.head);
          while (c && !inWin.has(c.sha) && by.has(c.parents[0])) c = by.get(c.parents[0]);
          if (c && (inWin.has(c.sha) || inWin.has(c.parents[0]) || !c.parents.length)) break;
        }
        if (stop === "wait") { openReading = true; continue; }
        if (stop) { lanes.failed.push(Object.assign({ number: p.number }, stop)); continue; }
        // Joined only by parent evidence: its first-parent line reaches a commit drawn for this version, or
        // its first commit. Anything else (not read that far, or longer than is drawn) is drawn cut off and said.
        const extra = [];
        let joined = false, c = by.get(p.head);
        for (; c && !inWin.has(c.sha) && extra.length < OPEN_DRAW; c = by.get(c.parents[0])) {
          extra.push({ sha: c.sha, parents: c.parents, date: c.at, msg: c.title, author: c.author || "" });
          if (!c.parents.length) { joined = true; break; }
        }
        if (c && inWin.has(c.sha)) joined = true;
        if (!joined) lanes.cut.push(p.number);
        if (!extra.length) continue;
        for (const c of extra) if (!inWin.has(c.sha)) { inWin.set(c.sha, c); win.push(c); }
        heads.push({ name: p.headRef || "PR #" + p.number, sha: p.head, pr: p.number, open: true });
      }
      const count = { open: 0, draft: 0, merged: 0, closed: 0 };
      for (const p of mine) count[p.merged ? "merged" : p.state === "open" ? (p.draft ? "draft" : "open") : "closed"]++;
      return { name, sha: b.sha, isDefault: name === def, apart, canApart: name !== def && !!defBranch, show, win, heads, marks, pulls: mine, count,
               unknown, ahead: cmp ? cmp.ahead : null, lanes, more: (mineAll.length > show || (!end && pB < VERSION_PAGES && !allKnown())) && !broke, reading: reading || openReading, failed: broke, shown: Math.min(mineAll.length, show) };
    });
    const tags = live(K().refs(repo, "tags"));
    if (!tags) wanted.push({ kind: "refs", list: "tags" });
    const tagList = tags && tags.data ? tags.data.refs.map(t => ({ name: t.name, sha: t.sha })) : [];
    const tagState = readState(tags);
    const laneFailed = versions.some(x => x.lanes.failed.length);
    // One read is wanted once, however many versions want it.
    const once = [...new Map(wanted.map(w => [JSON.stringify(w), w])).values()];
    return { state: "current", wanted: once, def, branches: list.map(b => b.name), start, picked: names, max: VERSIONS,
             partialBranches: br.state === "partial", versions, prs, tags: tagList, tagState, failed, retry: !!failed || prs.failed || tagState.failed || laneFailed };
  }

  Object.assign(SB, { ATLAS: { FLOW, OTHER, RANK, FIRST, MORE, BRANCHES, VERSIONS, PR_FIRST, PR_MAX, OPEN_LANES, VERSION_PAGES, OPEN_PAGES, flowOf, rankOf, older, versionStart }, atlasGraph, atlasLayout, atlasVersions });
})(typeof window !== "undefined" ? window : globalThis);
