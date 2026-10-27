"use strict";
// App shell and access lifecycle. Private data never comes from this file or
// this site: it is read from GitHub at run time with the owner's read-only
// token and kept in memory only. Forget access, leaving the page, a page
// restored from the back/forward cache and a refused token all end the
// session and clear every surface: tree, views, task details, tabs, Go to,
// dialogs and announcements. The synthetic demo runs the same readers and
// views against made-up repositories, with no network and no token.

(function () {
  const root = document.documentElement;

  // Refuse to run inside a frame: a meta CSP cannot set frame-ancestors.
  if (window.top !== window.self) {
    root.classList.remove("pending");
    root.classList.add("framed");
    document.getElementById("state").textContent = "This page cannot be shown inside another site.";
    return;
  }
  root.classList.remove("pending");

  const SB = window.SB;
  const V = SB.views;
  const $ = id => document.getElementById(id);
  const gotoBox = $("goto");
  const helpBox = $("help");

  let session = null;
  let client = null;

  const noFilters = () => ({ q: "", stage: "", phase: "", status: "", doer: "" });
  const noRepoFilters = () => ({ q: "", visibility: "", language: "", type: "", sort: "name", group: false });
  const MAX_OPENED = 10;

  // Everything shown comes from here, and everything here is dropped on sign-out.
  function freshState() {
    return {
      signedIn: false, demo: false, planRepo: "", run: null,
      list: { state: "loading" }, entries: [], current: null,
      view: { kind: "overview" }, filters: noFilters(), selected: null,
      tabs: [], activeTab: null, docs: new Map(), mapped: new Map(),
      expanded: new Set(["g:projects", "g:account"]), treeFocus: null,
      // Repository overview: live reads by repository (languages, activity feed, the account), the
      // portfolio filters, and repositories opened by name for this visit only.
      live: new Map(), repoFilters: noRepoFilters(), opened: [],
      // The repositories the token can read, as GitHub listed them at the last reading.
      found: null,
      // History: how many pages each read commit's history goes back, the branches the owner asked
      // to compare beyond the first ones, and the graph's zoom.
      histDepth: new Map(), histScroll: new Map(), histAsk: new Set(), histZoom: 1,
      // Work evidence: each list's state filter (open, closed or all) and how many pages it goes back,
      // and the pull requests whose reviews and checks are shown.
      workState: new Map(), workDepth: new Map(), workOpen: new Set(),
      // Files: per repository, files or changes, the open file and folders, the path search, and the
      // branch, tag or commit its changes are compared with.
      code: new Map(),
    };
  }
  let S = freshState();

  // ---- Rendering

  function render() {
    $("goto-open").disabled = !S.signedIn;
    $("refresh").hidden = !S.signedIn;
    $("forget").hidden = !S.signedIn;
    $("forget").textContent = S.demo ? "Leave demo" : "Forget access";
    $("tree-tools").hidden = !(S.signedIn && S.entries.length);
    $("mode").textContent = !S.signedIn ? "read-only" : S.demo ? "synthetic demo · made-up data" : "private · read-only";
    $("signed-out").hidden = S.signedIn;
    $("workspace").hidden = !S.signedIn;
    const focus = focusMark();
    hideTip();
    V.tree(S, A);
    V.main(S, A);
    restoreFocus(focus);
    ensureReads();
    if (gotoBox.open) renderGoto();  // an open Go to never keeps places the current access no longer allows
  }

  // Views are rebuilt on every change; keep keyboard focus on the same item when it is still there.
  const MARKS = ["id", "data-id", "data-key", "data-phase", "data-stage", "data-copy", "data-sub", "data-open", "data-evidence", "data-path", "data-diff"];
  function focusMark() {
    const a = document.activeElement;
    if (!a || !(a.closest("#workspace") || a.closest("#tree"))) return null;
    const mark = { area: a.closest("#tree") ? "tree" : "workspace", tag: a.tagName };
    for (const m of MARKS) if (a.hasAttribute(m)) mark[m] = a.getAttribute(m);
    if (a.tagName === "INPUT") mark.caret = a.selectionStart;
    return mark;
  }
  function restoreFocus(mark) {
    if (!mark || (document.activeElement && document.activeElement !== document.body)) return;
    for (const n of $(mark.area).querySelectorAll(mark.tag)) {
      if (MARKS.every(m => (mark[m] === undefined) === !n.hasAttribute(m) && (mark[m] === undefined || n.getAttribute(m) === mark[m]))) {
        n.focus({ preventScroll: true });
        if (mark.caret !== undefined && mark.caret !== null) n.setSelectionRange(mark.caret, mark.caret);
        return;
      }
    }
  }

  let liveTimer;
  function announce(text) {
    clearTimeout(liveTimer);
    $("live").textContent = text;
    liveTimer = setTimeout(() => { $("live").textContent = ""; }, 4000);
  }

  // ---- Reading

  function entryFrom(w, entries) {
    const of = kind => entries.filter(x => x.kind === kind).map(x => x.result);
    const plan = w.plan ? of("plan")[0] || null : null;
    const table = of("table")[0] || null;
    const pins = of("code");
    const checks = of("checks");
    let k = 0;
    const code = w.code.map((c, i) => {
      const pinned = pins[i] || null;
      return { c, pinned, checks: pinned && pinned.state === "current" ? checks[k++] || null : null };
    });
    const tasks = table && table.state === "current" ? SB.tasksFrom(table.data.rows) : [];
    return { w, loading: false, plan, table, progress: of("progress")[0] || null, code, tasks };
  }

  async function load(ctx) {
    S.run = ctx;
    S.list = { state: "loading" };
    S.entries = [];
    render();
    try {
      const target = SB.parseRepoRef(S.planRepo);
      const list = await SB.readWorkspaces(ctx, client, target.repo, target.ref);
      session.alive(ctx);
      S.list = list;
      const none = () => { S.tabs = []; S.activeTab = null; S.selected = null; S.docs = new Map(); S.mapped = new Map(); render(); };
      // An empty list is still a list: the repositories found through the token can fill it.
      if (list.state !== "current" && list.state !== "empty") { none(); return; }
      // Every repository the token can read that the list does not name is shown too, marked as found.
      const found = await SB.readAccountRepos(ctx, client);
      session.alive(ctx);
      S.found = found;
      const named = new Set(list.data.workspaces.flatMap(w => [w.plan && w.plan.repo, ...w.code.map(c => c.repo)]).filter(Boolean).map(r => r.toLowerCase()));
      const extra = found.data ? shortNames(found.data.repos.filter(r => !named.has(r.toLowerCase()))).map(([r, label]) => foundWorkspace(r, label, list.data.found)) : [];
      S.entries = list.data.workspaces.concat(extra, S.opened.map(openedWorkspace)).map(w => ({ w, loading: true, plan: null, table: null, progress: null,
                                                   code: w.code.map(c => ({ c, pinned: null, checks: null })), tasks: [] }));
      if (!S.entries.length) { none(); announce("Reading finished."); return; }
      if (!S.entries.some(e => e.w.id === S.current)) { S.current = S.entries[0].w.id; S.view = startView(S.entries[0].w); }
      // A project seen for the first time opens with its stages or phases showing; a refresh keeps what was opened or closed.
      const known = new Set(S.mapped.keys());
      keepMapped();
      for (const e of S.entries) if (!known.has(e.w.id)) for (const g of ["p:", "stages:", "phases:"]) S.expanded.add(g + e.w.id);
      render();
      for (let i = 0; i < S.entries.length; i++) {
        let w = S.entries[i].w;
        let read = await SB.readWorkspace(ctx, client, w);
        session.alive(ctx);
        if (w.found && w.plan && noTable(read)) {
          w = codeOnly(w);
          read = await SB.readWorkspace(ctx, client, w);
          session.alive(ctx);
          if (w.id === S.current && S.view.kind !== "repo") S.view = startView(w);
        }
        S.entries[i] = entryFrom(w, read);
        dropUnreadableTabs(S.entries[i]);
        render();
        if (w.id === S.current && S.selected) loadDocs(S.entries[i], S.selected);
        for (const t of S.tabs) if (t.project === w.id) { loadDocs(tabSource(t), t.id); if (t.sub === "cycle") loadCycle(tabSource(t), t.id); }
      }
      announce("Reading finished.");
    } catch (err) {
      if (err instanceof SB.Revoked) { endSession("revoked"); return; }
      try { session.alive(ctx); } catch (e) { return; }  // a newer run or an ended session: show nothing
      S.list = SB.result("failed", null, null, { error: err instanceof SB.NotAllowed ? err.message : "browser error (" + err.name + ")" });
      render();
    }
  }

  const planRepo = w => (w.plan ? w.plan.repo : null);
  // A project opens on its overview; one with no plan opens on its first repository.
  const startView = w => (w.plan ? { kind: "overview" } : { kind: "repo", repo: w.code[0].repo });

  // A repository the token can read that the workspace list does not name: read as a plan with the
  // list's found plan files, and as code only when it has no task table there (or the list gives none).
  // Its ID cannot clash with a listed one (listed IDs have no "~").
  const foundWorkspace = (repo, label, files) => {
    const w = { id: "~found-" + repo.toLowerCase(), label, kind: "project", plan: { repo, ref: null, files }, code: [], found: true };
    return files ? w : codeOnly(w);
  };
  // Each found repository is labelled by its name alone, or by owner and name when two share a name.
  const shortNames = repos => {
    const name = r => r.split("/")[1].toLowerCase();
    return repos.map(r => [r, repos.filter(x => name(x) === name(r)).length > 1 ? r : r.split("/")[1]]);
  };
  const codeOnly = w => Object.assign({}, w, { kind: "standalone", plan: null, code: [{ repo: w.plan.repo, ref: null, role: "code" }] });
  const noTable = read => read.some(x => x.kind === "table" && x.result.state === "missing");

  // A repository opened by name for this visit: a code-only workspace that is not in the workspace
  // list, marked as such. Its ID cannot clash with a listed one (listed IDs have no "~").
  const openedWorkspace = (o, i) => ({ id: "~opened-" + (i + 1), label: o.repo + (o.ref ? "@" + o.ref : ""), kind: "standalone", plan: null,
                                       code: [{ repo: o.repo, ref: o.ref || null, role: "opened by name" }], opened: true });

  // ---- Live reads for the repository overview, by repository: its languages and its activity feed
  // (latest commits at the pinned commit, latest pull requests, latest comments), and the account.
  // They are GitHub's now, not pinned to a plan commit; Refresh reads them again. None is progress.

  async function loadLive(key, read) {
    if (!session || S.live.has(key)) return;
    const ctx = S.run;
    const pending = { state: "loading" };
    S.live.set(key, pending);
    try {
      const res = await read(ctx);
      session.alive(ctx);
      if (S.live.get(key) !== pending) return;
      S.live.set(key, res);
      render();
    } catch (err) {
      if (err instanceof SB.Revoked) { endSession("revoked"); return; }
      if (S.live.get(key) !== pending) return;
      try { session.alive(ctx); } catch (e) { S.live.delete(key); return; }
      S.live.set(key, SB.result("failed", null, null, { error: "browser error (" + err.name + ")" }));
      render();
    }
  }

  const readFeed = (repo, commit) => async ctx => {
    const commits = await SB.readCommits(ctx, client, repo, commit);
    session.alive(ctx);
    const pulls = await SB.readPulls(ctx, client, repo, 1);
    session.alive(ctx);
    const comments = await SB.readRepoComments(ctx, client, repo);
    return SB.result("current", { commit, commits, pulls, comments, readAt: new Date().toISOString() }, { repo, commit });
  };

  // The reads the shown view needs and does not have yet. Called after every render; each read starts once.
  function ensureReads() {
    if (!S.signedIn || !session || !S.run || !S.entries.length || S.activeTab) return;
    const feed = r => loadLive(SB.feedKey(r.repo, r.pinned.data.commit), readFeed(r.repo, r.pinned.data.commit));
    if (S.view.kind === "activity") {
      loadLive("user", ctx => SB.readUser(ctx, client));
      for (const r of SB.portfolio(S.entries)) if (r.meta) loadLive("lang|" + r.repo, ctx => SB.readLanguages(ctx, client, r.repo));
      return;
    }
    // The inbox reads the account and the first page of each mapped repository's open lists.
    if (S.view.kind === "inbox") {
      loadLive("user", ctx => SB.readUser(ctx, client));
      for (const r of SB.inboxScope(SB.portfolio(S.entries)).readable) for (const kind of ["pulls", "issues"]) workRead(r.repo, kind, "open", 1);
      return;
    }
    // A project's own views read its repositories at its own pins, as the feed card shows them.
    const e = entryOf(S.current);
    if (!e) return;
    const mine = SB.portfolio([e]).filter(r => r.meta);
    if (S.view.kind === "repo") {
      const r = mine.find(x => x.repo === S.view.repo);
      if (!r) return;
      if (S.view.sub === "history") return historyReads(r.repo, r.pinned.data.commit);
      if (V.WORK_SUBS.includes(S.view.sub)) return workReads(r.repo, S.view.sub);
      if (S.view.sub === "files") return codeReads(r.repo, r.pinned.data.commit);
      loadLive("lang|" + r.repo, ctx => SB.readLanguages(ctx, client, r.repo)); feed(r);
    } else if (S.view.kind === "overview") {
      for (const r of mine) feed(r);
    }
  }

  // A repository's history reads what its view still wants: pages, the branch and tag lists, each
  // comparison with the read commit, and each compared branch's own commits.
  const depthKey = (repo, commit) => repo + "@" + commit;
  function historyReads(repo, commit) {
    const K = SB.historyKey;
    const h = SB.historyView(key => S.live.get(key), repo, commit, S.histDepth.get(depthKey(repo, commit)) || 1, S.histAsk);
    for (const w of h.wanted) {
      if (w.kind === "page") loadLive(K.page(repo, commit, w.page), ctx => SB.readHistoryPage(ctx, client, repo, commit, w.page));
      else if (w.kind === "refs") loadLive(K.refs(repo, w.list), ctx => SB.readRefs(ctx, client, repo, w.list));
      else if (w.kind === "compare") loadLive(K.compare(repo, commit, w.head), ctx => SB.readCompare(ctx, client, repo, commit, w.head));
      else if (w.kind === "lane") loadLive(K.lane(repo, w.head, w.page), ctx => SB.readHistoryPage(ctx, client, repo, w.head, w.page));
    }
  }

  // A repository's work evidence reads the pages its list still wants, and for each pull request whose
  // evidence is shown, its reviews and the check runs at its current head.
  const workSlot = (repo, kind, state) => kind + "|" + repo + "|" + (state || "-");
  const workStateOf = (repo, kind) => kind === "pulls" || kind === "issues" ? S.workState.get(repo + "|" + kind) || "open" : null;
  function workRead(repo, kind, state, page) {
    const key = SB.workKey.list(kind, repo, state, page);
    if (kind === "pulls") loadLive(key, ctx => SB.readPullPage(ctx, client, repo, state, page));
    else if (kind === "issues") loadLive(key, ctx => SB.readIssuePage(ctx, client, repo, state, page));
    else if (kind === "runs") loadLive(key, ctx => SB.readRunPage(ctx, client, repo, page));
    else loadLive(key, ctx => SB.readReleasePage(ctx, client, repo, page));
  }
  function workReads(repo, kind) {
    const state = workStateOf(repo, kind);
    const w = SB.workList(key => S.live.get(key), kind, repo, state, S.workDepth.get(workSlot(repo, kind, state)) || 1);
    for (const page of w.wanted) workRead(repo, kind, state, page);
    if (kind !== "pulls") return;
    for (const pr of w.items) {
      if (!S.workOpen.has(repo + "#" + pr.number)) continue;
      loadLive(SB.workKey.reviews(repo, pr.number), ctx => SB.readReviews(ctx, client, repo, pr.number));
      loadLive(SB.workKey.checks(repo, pr.head), ctx => SB.readCheckRuns(ctx, client, repo, pr.head));
    }
  }

  // Files read the tree at the pinned commit and the open file in it, or the changes of that commit, or
  // the branch, tag or commit it is compared with and then the comparison of those two commits.
  const codeView = repo => {
    if (!S.code.has(repo)) S.code.set(repo, { mode: "files", path: null, open: new Set(), query: "", against: "", typed: "", againstError: "", diff: null });
    return S.code.get(repo);
  };
  function codeReads(repo, commit) {
    const K = SB.codeKey, c = codeView(repo);
    if (c.mode === "changes") {
      if (!c.against) { loadLive(K.commit(repo, commit), ctx => SB.readCommitChanges(ctx, client, repo, commit)); return; }
      loadLive(K.commit(repo, c.against), ctx => SB.readCommitChanges(ctx, client, repo, c.against));
      const base = S.live.get(K.commit(repo, c.against));
      if (base && base.data) loadLive(K.compare(repo, base.data.commit.sha, commit), ctx => SB.readCompareChanges(ctx, client, repo, base.data.commit.sha, commit));
      return;
    }
    loadLive(K.tree(repo, commit), ctx => SB.readTree(ctx, client, repo, commit));
    const tree = S.live.get(K.tree(repo, commit));
    const e = c.path && tree && tree.data ? tree.data.entries.find(x => x.path === c.path) : null;
    if (SB.codeOpenable(e).ok) loadLive(K.text(repo, commit, c.path), ctx => SB.readCodeFile(ctx, client, repo, commit, c.path));
  }

  // Tabs and documents belong to a project's plan repository. When the refreshed workspace list no
  // longer maps that repository to the project (removed, or the ID reused for another repository),
  // they go before anything is drawn.
  function keepMapped() {
    const mapped = new Map(S.entries.map(e => [e.w.id, planRepo(e.w)]));
    if (S.mapped.get(S.current) !== mapped.get(S.current)) S.selected = null;
    S.mapped = mapped;
    S.tabs = S.tabs.filter(t => mapped.get(t.project) === t.repo);
    if (S.activeTab && !S.tabs.some(t => t.key === S.activeTab)) S.activeTab = null;
    pruneDocs();
  }

  // A plan that can no longer be read shows none of its tasks, in tabs either.
  function dropUnreadableTabs(entry) {
    if (V.tableState(entry) === "current") return;
    S.tabs = S.tabs.filter(t => t.project !== entry.w.id);
    if (S.activeTab && !S.tabs.some(t => t.key === S.activeTab)) S.activeTab = null;
    if (entry.w.id === S.current) S.selected = null;
    pruneDocs();
  }

  // Documents are kept only for plans that are mapped and not known to be unreadable.
  function pruneDocs() {
    const keep = S.entries.filter(e => e.w.plan && (e.loading || V.tableState(e) === "current")).map(e => docKey(e.w.id, e.w.plan.repo, ""));
    for (const key of [...S.docs.keys()]) if (!keep.some(k => key.startsWith(k))) S.docs.delete(key);
  }

  // Full source identity: project, repository, commit, file kind and template, task ID.
  function docKey(project, repo, commit, kind, template, id) {
    return [project, repo, commit, kind, template, id].filter(x => x !== undefined).join("|");
  }

  // What a tab was read from, in the shape loadDocs reads: its own repository, templates and commit.
  const tabSource = t => ({ w: { id: t.project, plan: t.source }, plan: t.plan });

  // The task's brief, handover and cross-references, read once per source and commit and kept in memory with the rest.
  async function loadDocs(entry, id) {
    if (V.planState(entry) !== "current") return;
    const ctx = S.run;
    const commit = entry.plan.data.commit;
    for (const kind of ["brief", "handover", "crossref"]) {
      const template = entry.w.plan.files[kind];
      const key = docKey(entry.w.id, entry.w.plan.repo, commit, kind, template, id);
      if (!template || S.docs.has(key)) continue;
      S.docs.set(key, { state: "loading" });
      try {
        const res = await SB.readTaskFile(ctx, client, entry.w.plan.repo, commit, template, id);
        session.alive(ctx);
        S.docs.set(key, res);
        render();
      } catch (err) {
        if (err instanceof SB.Revoked) { endSession("revoked"); return; }
        // A newer run or an ended session: leave no Loading behind, so the newer run reads it again.
        try { session.alive(ctx); } catch (e) { if (S.docs.get(key) && S.docs.get(key).state === "loading") S.docs.delete(key); return; }
        S.docs.set(key, SB.result("failed", null, null, { error: "browser error (" + err.name + ")" }));
        render();
      }
    }
  }

  // A task's review cycle, read live from GitHub when it is asked for: the plan repository's pull
  // requests whose title names the task, the code pull requests their descriptions link to, and
  // each one's comments and check runs at its head. Kept under the plan repository, so it goes
  // with the plan; a refresh reads it again.
  const MAX_CYCLE_PULLS = 10;
  const cycleKey = (entry, id) => docKey(entry.w.id, entry.w.plan.repo, "live", "cycle", "", id);
  async function loadCycle(entry, id) {
    if (V.planState(entry) !== "current") return;
    const key = cycleKey(entry, id);
    if (S.docs.has(key)) return;
    const ctx = S.run;
    const now = entryOf(entry.w.id);
    const code = (now ? now.code : []).filter(c => c.pinned && c.pinned.state === "current").map(c => ({ repo: c.c.repo, web: c.pinned.data.web }));
    // Only this read's own Loading entry may be replaced: Read again or a refresh puts a newer one
    // in its place, and then this read's late answer, or its failure, changes nothing.
    const pending = { state: "loading" };
    const mine = () => S.docs.get(key) === pending;
    S.docs.set(key, pending);
    render();
    try {
      const list = await SB.readPulls(ctx, client, entry.w.plan.repo);
      session.alive(ctx);
      if (!mine()) return;
      let res;
      if (!list.data) res = SB.result(list.state, null, list.source, { error: list.error });
      else {
        // At most ten pull requests in all; what is left out is counted and shown, never dropped silently.
        const named = list.data.pulls.filter(p => SB.namesTask(p.title, id));
        const shown = named.slice(0, MAX_CYCLE_PULLS);
        const items = shown.map(pr => ({ repo: entry.w.plan.repo, web: entry.plan.data.web, number: pr.number, pr, via: null }));
        const left = new Set();
        const codeLists = new Map();
        for (const pr of shown) for (const link of SB.linkedPulls(pr.body, code.map(c => c.repo))) {
          if (items.some(x => x.repo === link.repo && x.number === link.number)) continue;
          if (items.length >= MAX_CYCLE_PULLS) { left.add(link.repo + "#" + link.number); continue; }
          if (!codeLists.has(link.repo)) { codeLists.set(link.repo, await SB.readPulls(ctx, client, link.repo)); session.alive(ctx); if (!mine()) return; }
          const pulls = codeLists.get(link.repo);
          const found = pulls.data ? pulls.data.pulls.find(p => p.number === link.number) || null : null;
          items.push({ repo: link.repo, web: code.find(c => c.repo === link.repo).web, number: link.number, pr: found, via: pr.number,
                       listState: pulls.state });
        }
        for (const it of items) {
          if (!it.pr) continue;
          it.comments = await SB.readComments(ctx, client, it.repo, it.number);
          session.alive(ctx);
          if (!mine()) return;
          it.checks = await SB.readCheckRuns(ctx, client, it.repo, it.pr.head);
          session.alive(ctx);
          if (!mine()) return;
        }
        res = SB.result(items.length ? "current" : "no-match", { items, searched: list.data.pulls.length, listState: list.state,
                                                                  left: { named: named.length - shown.length, linked: left.size },
                                                                  readAt: new Date().toISOString() }, { repo: entry.w.plan.repo });
      }
      if (!mine()) return;
      S.docs.set(key, res);
      render();
    } catch (err) {
      if (err instanceof SB.Revoked) { endSession("revoked"); return; }
      if (!mine()) return;
      try { session.alive(ctx); } catch (e) { S.docs.delete(key); return; }
      S.docs.set(key, SB.result("failed", null, null, { error: "browser error (" + err.name + ")" }));
      render();
    }
  }

  function start(demo) {
    S = freshState();
    session = SB.createSession();
    client = SB.createClient(session, demo ? SB.demoServer(window.SANDBOARD_DEMO) : undefined);
    S.signedIn = true;
    S.demo = demo;
  }

  async function connect(event) {
    event.preventDefault();
    const typed = $("token").value.trim();
    $("token").value = "";
    const planRepo = $("plan-repo").value.trim();
    if (!typed || !SB.parseRepoRef(planRepo)) {
      $("state").textContent = !typed ? "Enter a read-only token." : "Enter the plan repository as owner/repo or owner/repo@branch.";
      return;
    }
    start(false);
    S.planRepo = planRepo;
    $("state").textContent = "Signed in. The token is in this page's memory only.";
    const ctx = session.start(typed);
    $("main").focus();
    await load(ctx);
  }

  async function showDemo() {
    start(true);
    S.planRepo = window.SANDBOARD_DEMO.sign_in;
    $("state").textContent = "Synthetic demo: every project here is made up. Nothing is read from GitHub.";
    const ctx = session.start("synthetic-demo");
    $("main").focus();
    await load(ctx);
  }

  // Ends the session and clears every surface. why: forget | left | restored | revoked | demo
  function endSession(why) {
    if (session) session.forget();
    session = null;
    client = null;
    S = freshState();
    $("token").value = "";
    if (gotoBox.open) gotoBox.close();
    if (helpBox.open) helpBox.close();
    $("goto-list").replaceChildren();
    $("goto-q").value = "";
    clearTimeout(liveTimer);
    $("live").textContent = "";
    hideTip();
    setMenu(false);
    render();
    $("state").textContent = {
      forget: "Access forgotten. The token and everything read with it were cleared, and open tabs were closed.",
      demo: "Left the demo.",
      left: "Signed out when you left the page.",
      restored: "Page restored: signed out, nothing old is kept.",
      revoked: "No access: the token is invalid, expired or revoked. Everything read with it was cleared.",
    }[why] || "Signed out";
  }

  // ---- Actions the views call

  const entryOf = id => S.entries.find(e => e.w.id === id);

  const A = {
    render,
    docKey,
    live: key => S.live.get(key),
    historyDepth: (repo, commit) => S.histDepth.get(depthKey(repo, commit)) || 1,
    // The next page of commits: asked for by scrolling to the end of the list (keepFocus) or by the button.
    olderHistory(repo, commit, keepFocus) {
      const k = depthKey(repo, commit);
      S.histDepth.set(k, (S.histDepth.get(k) || 1) + 1);
      render();
      if (keepFocus) return;
      const n = $("g-older") || $("g-end");
      if (n) n.focus();
    },
    // Where the history list was scrolled to, kept across renders so reading more does not jump to the top.
    historyScroll: (repo, commit, at) => at ? S.histScroll.set(depthKey(repo, commit), at) : S.histScroll.get(depthKey(repo, commit)),
    compareBranch(repo, branch) {
      S.histAsk.add(repo + "|" + branch);
      render();
      const row = document.querySelector('[data-part=branches] tr[data-branch="' + CSS.escape(branch) + '"] th');
      if (row) { row.tabIndex = -1; row.focus(); }
    },
    zoomHistory(zoom, focusId) {
      S.histZoom = zoom;
      render();
      const n = $(focusId);
      if (n && !n.disabled) n.focus(); else { const f = $("g-fit"); if (f) f.focus(); }
    },
    workState: workStateOf,
    workDepth: (repo, kind, state) => S.workDepth.get(workSlot(repo, kind, state)) || 1,
    setWorkState(repo, kind, state) {
      S.workState.set(repo + "|" + kind, state);
      render();
      const n = $("wf-" + state);
      if (n) n.focus();
    },
    olderWork(repo, kind, state) {
      const k = workSlot(repo, kind, state);
      S.workDepth.set(k, Math.min(SB.MAX_WORK_PAGES, (S.workDepth.get(k) || 1) + 1));
      render();
      const n = $("w-older") || $("w-end");
      if (n) n.focus();
    },
    codeView,
    setCodeMode(repo, mode) {
      codeView(repo).mode = mode;
      render();
      const n = $("cm-" + mode);
      if (n) n.focus();
    },
    toggleCodeDir(repo, path) {
      const open = codeView(repo).open;
      if (open.has(path)) open.delete(path); else open.add(path);
      render();
      focusData("data-path", path);
    },
    // A file picked from the tree or the path search; its folders open so the tree shows where it is.
    openCodeFile(repo, path) {
      const c = codeView(repo);
      c.path = path;
      for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) c.open.add(path.slice(0, i));
      render();
      focusData("data-path", path);
    },
    setCodeQuery(repo, q) {
      codeView(repo).query = q;
      const caret = $("code-q").selectionStart;
      render();
      const n = $("code-q");
      if (n) { n.focus(); n.setSelectionRange(caret, caret); }
    },
    // Changes against another branch, tag or commit typed by the owner; only a name of the plain form is
    // read, and an empty one goes back to the commit's own changes.
    setCodeAgainst(repo, text) {
      const c = codeView(repo), ref = String(text || "").trim();
      const plain = /^[A-Za-z0-9_./-]{1,200}$/.test(ref) && !ref.split("/").some(part => part === "." || part === "..");
      c.againstError = ref && !plain ? "Type a branch, tag or commit made of letters, digits, dots, dashes, underscores and slashes." : "";
      c.typed = ref;
      if (!ref || plain) { c.against = ref; c.diff = null; }
      render();
      const n = $(ref && plain ? "code-own" : "code-against") || $("code-against");
      if (n) n.focus();
      if (ref && plain) announce("Comparing with " + ref + ".");
    },
    showCodeDiff(repo, path) {
      codeView(repo).diff = path;
      render();
      focusData("data-diff", path);
    },
    evidenceOpen: (repo, number) => S.workOpen.has(repo + "#" + number),
    toggleEvidence(repo, number) {
      const k = repo + "#" + number;
      if (S.workOpen.has(k)) S.workOpen.delete(k); else S.workOpen.add(k);
      render();
      const n = document.querySelector('[data-evidence="' + number + '"]');
      if (n) n.focus();
    },
    // The account views (all mapped repositories, their activity, and the inbox) belong to no single project.
    goAccount(kind) {
      S.view = { kind };
      S.activeTab = null;
      render();
      $("main").focus();
    },
    setRepoFilter(key, value, focusId) {
      S.repoFilters[key] = value;
      const caret = key === "q" ? $("rq").selectionStart : null;
      render();
      const n = $(focusId);
      if (n) { n.focus(); if (caret !== null) n.setSelectionRange(caret, caret); }
    },
    // Opens a repository typed as owner/name (or owner/name@ref) for this visit, as a code-only project
    // that is not in the workspace list. A repository the list already maps is shown where it is mapped.
    async openByName(text, status) {
      const target = SB.parseRepoRef(String(text || "").trim());
      if (!target) { status.textContent = "Type a repository as owner/name or owner/name@branch."; return; }
      const mapped = S.entries.find(e => planRepo(e.w) === target.repo || e.w.code.some(c => c.repo === target.repo));
      if (mapped && !target.ref) { A.go(mapped.w.id, { kind: "repo", repo: target.repo }); announce(target.repo + " is already in " + mapped.w.label + "."); return; }
      if (S.opened.length >= MAX_OPENED) { status.textContent = "At most " + MAX_OPENED + " repositories can be opened by name in one visit. Refresh keeps them; Forget access clears them."; return; }
      S.opened.push({ repo: target.repo, ref: target.ref || null });
      const w = openedWorkspace(S.opened[S.opened.length - 1], S.opened.length - 1);
      const entry = { w, loading: true, plan: null, table: null, progress: null, code: [{ c: w.code[0], pinned: null, checks: null }], tasks: [] };
      S.entries.push(entry);
      S.expanded.add("p:" + w.id);
      A.go(w.id, { kind: "repo", repo: target.repo });
      const ctx = S.run;
      try {
        const read = await SB.readWorkspace(ctx, client, w);
        session.alive(ctx);
        const i = S.entries.indexOf(entry);
        if (i < 0) return;
        S.entries[i] = entryFrom(w, read);
        render();
        announce("Opened " + target.repo + " for this visit.");
      } catch (err) {
        if (err instanceof SB.Revoked) endSession("revoked");
      }
    },
    closeMenu: () => setMenu(false),
    go(project, view, opts) {
      if (project !== S.current) { S.filters = noFilters(); S.selected = null; }
      S.current = project;
      S.view = view;
      S.activeTab = null;
      // A phase picked from the tree or a phase card brings its stage with it, as the filters show it.
      if (opts && opts.phase !== undefined) S.filters = Object.assign(noFilters(), { stage: V.stageIdOf(entryOf(project), opts.phase), phase: opts.phase });
      if (opts && opts.select !== undefined) S.selected = opts.select;
      render();
      if (S.selected) loadDocs(entryOf(project), S.selected);
      if (opts && opts.focus) { const n = $(opts.focus); if (n) { n.focus(); return; } }
      $("main").focus();
    },
    showStage(project, stage) { A.go(project, { kind: "overview", stage: stage || null }); },
    showPhase(project, phase) { A.go(project, { kind: "tasks" }, { phase, focus: "tasks-h" }); },
    setFilter(key, value, focusId) {
      S.filters[key] = value;
      if (key === "stage") S.filters.phase = "";  // a new stage starts from all of its phases
      if (key === "phase" && value) S.filters.stage = V.stageIdOf(entryOf(S.current), value);  // clearing the phase keeps its stage
      if (key !== "q") S.selected = null;
      const caret = key === "q" ? $("q").selectionStart : null;
      render();
      const n = $(focusId);
      if (n) { n.focus(); if (caret !== null) n.setSelectionRange(caret, caret); }
    },
    select(id) {
      S.selected = id;
      render();
      focusRow(id);
      loadDocs(entryOf(S.current), id);
    },
    closeDetails() {
      const id = S.selected;
      S.selected = null;
      render();
      focusRow(id);
    },
    visibleTabs: () => S.tabs.filter(t => t.project === S.current),
    // Opens a task as a tab, read as the project is now, or, from another tab (its key in `from`), at
    // that tab's own commit and mapping. Either way the plan must still be readable and mapped.
    openTab(project, id, from, section) {
      const entry = entryOf(project);
      if (!entry || !V.rowsVisible(entry)) { announce("Task " + id + " cannot be opened: its plan is not readable now."); return; }
      const src = from ? S.tabs.find(t => t.key === from) : { repo: entry.w.plan.repo, commit: entry.plan.data.commit, source: entry.w.plan,
                                                               plan: entry.plan, progress: entry.progress, tasks: entry.tasks };
      if (!src || src.repo !== entry.w.plan.repo) { announce("Task " + id + " cannot be opened: that tab's plan is no longer this project's."); return; }
      const task = src.tasks.find(t => t.id === id && !t.invalid);
      if (!task) { announce("Task " + id + " is not a row of the task table at " + SB.short(src.commit) + "."); return; }
      const key = SB.tabKey(project, src.repo, src.commit, "task", id);
      if (!S.tabs.some(t => t.key === key)) {
        S.tabs.push({ key, project, id, repo: src.repo, commit: src.commit, source: src.source,
                      plan: src.plan, progress: src.progress, tasks: src.tasks, task });
      }
      S.activeTab = key;
      if (section) S.tabs.find(t => t.key === key).sub = section;
      render();
      focusTab(key);
      announce("Opened task " + id + " as a tab.");
      loadDocs(tabSource(S.tabs.find(t => t.key === key)), id);
      if (section === "cycle") loadCycle(tabSource(S.tabs.find(t => t.key === key)), id);
    },
    cycleKey,
    readCycleAgain(key) {
      const tab = S.tabs.find(t => t.key === key);
      if (!tab) return;
      S.docs.delete(cycleKey(tabSource(tab), tab.id));
      loadCycle(tabSource(tab), tab.id);
    },
    showTab(key) { S.activeTab = key; render(); focusTab(key); },
    showSection(key, section) {
      const tab = S.tabs.find(t => t.key === key);
      if (!tab) return;
      tab.sub = section;
      render();
      if (section === "cycle") loadCycle(tabSource(tab), tab.id);
      const n = $("sub-" + section);
      if (n) n.focus();
    },
    closeTab(key) {
      const mine = A.visibleTabs();
      const i = mine.findIndex(t => t.key === key);
      S.tabs = S.tabs.filter(t => t.key !== key);
      if (S.activeTab === key) S.activeTab = (mine[i + 1] || mine[i - 1] || {}).key || null;
      render();
      focusTab(S.activeTab);
      announce("Closed the tab.");
    },
    async copy(node, status) {
      const text = node.textContent;
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = "Copied. Nothing was sent anywhere.";
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        status.textContent = "Copy didn't work here, so nothing was copied. The text is selected: press Ctrl+C or ⌘C.";
      }
    },
  };

  function focusData(attr, value) {
    for (const n of document.querySelectorAll("[" + attr + "]")) if (n.getAttribute(attr) === value) { n.focus(); return; }
  }
  function focusRow(id) {
    for (const n of document.querySelectorAll("#task-list .row")) if (n.dataset.id === id) { n.focus(); return; }
  }
  function focusTab(key) {
    if (!key) { const v = $("tab-view"); if (v) v.focus(); return; }
    for (const n of document.querySelectorAll(".tabs [role=tab]")) if (n.dataset.key === key) { n.focus(); return; }
  }

  function refresh() {
    if (!session) return;
    // A document read at a commit stays right for that commit; only reads that did not finish
    // with an answer about the file are dropped, so they are tried again.
    for (const [key, res] of [...S.docs]) if (!["current", "empty", "missing", "invalid"].includes(res.state) || key.includes("|live|")) S.docs.delete(key);
    S.live = new Map();  // languages, feeds, history and the account are read again
    S.histDepth = new Map();
    S.histScroll = new Map();
    S.workDepth = new Map();
    const ctx = session.start();  // same token, new run: replies to the old run are dropped
    announce("Refreshing.");
    load(ctx);
  }

  // ---- Go to: places only (projects, views, repositories, the open project's tasks, themes)

  let gotoItems = [];
  let gotoSel = 0;

  function places() {
    const out = [["All repositories", "Account", () => A.goAccount("portfolio")], ["Activity and languages", "Account", () => A.goAccount("activity")],
                 ["Inbox", "Account", () => A.goAccount("inbox")]];
    for (const e of S.entries) {
      const w = e.w;
      if (w.plan) {
        out.push([w.label + ": overview", "Project", () => A.go(w.id, { kind: "overview" })]);
        out.push([w.label + ": tasks", "Project", () => A.go(w.id, { kind: "tasks" }, { phase: "" })]);
      }
      for (const r of [w.plan && w.plan.repo, ...w.code.map(c => c.repo)].filter(Boolean)) {
        out.push([r + " (" + w.label + ")", "Repository", () => A.go(w.id, { kind: "repo", repo: r })]);
        out.push([r + " history (" + w.label + ")", "Repository", () => A.go(w.id, { kind: "repo", repo: r, sub: "history" })]);
        for (const [sub, label] of [["pulls", "pull requests"], ["issues", "issues"], ["runs", "Actions"], ["releases", "releases"], ["files", "files"]]) {
          out.push([r + " " + label + " (" + w.label + ")", "Repository", () => A.go(w.id, { kind: "repo", repo: r, sub })]);
        }
      }
    }
    const current = entryOf(S.current);
    if (current && V.rowsVisible(current)) {
      for (const t of current.tasks.filter(x => !x.invalid)) {
        out.push([t.id + " " + (t.title || ""), "Task", () => A.go(current.w.id, { kind: "tasks" }, { phase: "", select: t.id })]);
      }
    }
    out.push(["Light theme", "Setting", () => setTheme("light")], ["Dark theme", "Setting", () => setTheme("dark")],
             ["Device theme", "Setting", () => setTheme("device")]);
    return out;
  }

  function renderGoto() {
    if (!S.signedIn) { gotoItems = []; $("goto-list").replaceChildren(); return; }
    const q = $("goto-q").value.trim().toLowerCase();
    gotoItems = places().filter(p => !q || p[0].toLowerCase().includes(q)).slice(0, 12);
    gotoSel = Math.min(gotoSel, Math.max(0, gotoItems.length - 1));
    $("goto-list").replaceChildren(...(gotoItems.length ? gotoItems.map((p, i) => V.el("li", { role: "option", id: "goto-" + i,
      "aria-selected": String(i === gotoSel), onclick: () => runGoto(i) }, V.el("span", {}, p[0]), V.el("span", { class: "kind" }, p[1])))
      : [V.el("li", { role: "option", "aria-disabled": "true" }, "No place matches")]));
    $("goto-q").setAttribute("aria-activedescendant", gotoItems.length ? "goto-" + gotoSel : "");
  }

  function runGoto(i) {
    const p = gotoItems[i];
    if (!p) return;
    gotoBox.close();
    p[2]();
  }

  function openGoto() {
    if (!S.signedIn) return;
    $("goto-q").value = "";
    gotoSel = 0;
    renderGoto();
    gotoBox.showModal();
    $("goto-q").focus();
  }

  // ---- Theme: device setting by default; a choice lasts for this visit only (nothing is stored)

  function setTheme(choice) {
    if (choice === "device") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
    for (const b of document.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b.dataset.themeChoice === choice));
  }

  function setMenu(open) {
    $("shell").classList.toggle("menu-open", open);
    $("menu").setAttribute("aria-expanded", String(open));
  }

  // ---- Explanation bubbles: shown on hover or keyboard focus of anything with data-tip.
  // The bubble can be hovered, stays until the pointer or focus leaves, and Esc hides it.

  const tipBox = $("tip");
  // The pointer rests this long before a bubble shows, so passing over a name shows nothing.
  const TIP_WAIT = 1200;
  let tipFor = null;
  let tipTimer;

  function tipNode(node, focus) {
    if (!(node instanceof Element) || !node.closest("#workspace, #tree, .top")) return null;
    if (focus && node.getAttribute("role") === "treeitem") return node.querySelector(":scope > .ti[data-tip]");
    return node.closest("[data-tip]");
  }

  function showTip(node, describe) {
    clearTimeout(tipTimer);
    if (!node || !node.isConnected) return;
    tipFor = node;
    tipBox.textContent = node.getAttribute("data-tip");
    tipBox.hidden = false;
    const r = node.getBoundingClientRect(), w = tipBox.offsetWidth, h = tipBox.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6 + h <= window.innerHeight;
    tipBox.style.left = left + "px";
    tipBox.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + "px";
    if (describe && !describe.hasAttribute("aria-describedby")) { describe.setAttribute("aria-describedby", "tip"); describe.dataset.tipDescribed = "1"; }
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipFor = null;
    tipBox.hidden = true;
    tipBox.textContent = "";
    for (const n of document.querySelectorAll("[data-tip-described]")) { n.removeAttribute("aria-describedby"); delete n.dataset.tipDescribed; }
  }

  document.addEventListener("mouseover", e => {
    if (tipBox.contains(e.target)) { clearTimeout(tipTimer); return; }
    const node = tipNode(e.target, false);
    if (node === tipFor) { clearTimeout(tipTimer); return; }
    clearTimeout(tipTimer);
    tipTimer = node ? setTimeout(() => showTip(node, null), TIP_WAIT) : setTimeout(hideTip, 200);
  });
  document.addEventListener("focusin", e => {
    const node = tipNode(e.target, true);
    if (node) showTip(node, e.target); else hideTip();
  });
  document.addEventListener("focusout", () => hideTip());
  // Esc hides a bubble first, before anything else Esc does.
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !tipBox.hidden) { hideTip(); e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  // The help dialog lists the same explanations, for anyone who cannot hover.
  $("glossary").replaceChildren(...Object.entries(V.TIPS).flatMap(([word, text]) =>
    [V.el("dt", {}, { plan: "plan (repository role)", code: "Code repository" }[word] || word), V.el("dd", {}, text)]));

  // ---- Events

  $("expand-all").addEventListener("click", () => { for (const id of V.treeGroups(S, A)) S.expanded.add(id); render(); });
  $("collapse-all").addEventListener("click", () => { S.expanded = new Set(["g:projects", "g:account"]); render(); });
  $("connect").addEventListener("submit", connect);
  $("show-demo").addEventListener("click", showDemo);
  $("forget").addEventListener("click", () => { endSession(S.demo ? "demo" : "forget"); $("main").focus(); });
  $("refresh").addEventListener("click", refresh);
  $("goto-open").addEventListener("click", openGoto);
  $("help-open").addEventListener("click", () => helpBox.showModal());
  $("help-close").addEventListener("click", () => helpBox.close());
  $("menu").addEventListener("click", () => {
    const open = !$("shell").classList.contains("menu-open");
    setMenu(open);
    if (open) V.focusTree(S);
  });
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.addEventListener("click", () => setTheme(b.dataset.themeChoice));
  $("goto-q").addEventListener("input", () => { gotoSel = 0; renderGoto(); });
  $("goto-q").addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); gotoSel = Math.min(gotoSel + 1, gotoItems.length - 1); renderGoto(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); gotoSel = Math.max(gotoSel - 1, 0); renderGoto(); }
    else if (e.key === "Enter") { e.preventDefault(); runGoto(gotoSel); }
  });

  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (gotoBox.open) gotoBox.close(); else openGoto();
    } else if (gotoBox.open || helpBox.open) {
      return;
    } else if (e.key === "/" && !typing && S.signedIn) {
      const entry = entryOf(S.current);
      if (!entry || !entry.w.plan) return;
      e.preventDefault();
      if (S.view.kind !== "tasks" || S.activeTab) A.go(S.current, { kind: "tasks" }, { focus: "q" });
      else $("q").focus();
    } else if (e.key === "?" && !typing) {
      e.preventDefault();
      helpBox.showModal();
    } else if (e.key === "Escape" && S.selected && !typing && !S.activeTab) {
      A.closeDetails();
    }
  });

  // Leaving the page (including into the back/forward cache) ends the session;
  // a restored page starts signed out.
  window.addEventListener("pagehide", () => endSession("left"));
  window.addEventListener("pageshow", e => { if (e.persisted) endSession("restored"); });

  render();
})();
