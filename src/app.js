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
  // Edit mode: a separate write session, its writer, and the one change waiting for confirmation.
  let write = null;
  let writer = null;
  let pendingWrite = null;
  // The write session still being checked with GitHub; Cancel or Esc ends it, whatever GitHub answered so far.
  let checkingWrite = null;

  const noFilters = () => ({ q: "", stage: "", phase: "", status: "", doer: "" });
  const noRepoFilters = () => ({ q: "", visibility: "", language: "", type: "", sort: "name", group: false });
  const MAX_OPENED = 10;

  // The one thing kept in the browser, by the owner's choice: the order of projects in the left tree, as
  // the IDs the workspace list gives its projects, in this browser only. Never the token, a repository
  // name found through the token or opened by name (their places hold for this visit), or any other read.
  // When storage is off or full, the order holds for this visit.
  const ORDER_KEY = "sandboard.projectOrder";
  const orderStore = {
    read() { try { return SB.savedOrder(window.localStorage.getItem(ORDER_KEY)); } catch (e) { return []; } },
    write(ids) { try { window.localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch (e) { /* kept for this visit */ } },
  };

  // The look chosen in Settings (density and accent colour) is the one other thing kept in this browser,
  // by the owner's choice: two plain words under one key, never anything read from GitHub.
  const LOOK_KEY = "sandboard.look";
  const lookStore = {
    read() { try { return SB.savedLook(window.localStorage.getItem(LOOK_KEY)); } catch (e) { return SB.savedLook(null); } },
    write(look) { try { window.localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch (e) { /* kept for this visit */ } },
  };

  // Favourite projects and tasks and saved task views are kept in this browser too, by the owner's
  // choice, under one more key: workspace-list project IDs, task IDs, view names, statuses, stage and phase IDs, and layouts.
  const MARKS_KEY = "sandboard.marks";
  const marksStore = {
    read() { try { return SB.savedMarks(window.localStorage.getItem(MARKS_KEY)); } catch (e) { return SB.savedMarks(null); } },
    // What is written passes the same check as what is read, so only allowed fields are ever stored.
    write(raw) { const marks = SB.savedMarks(JSON.stringify(raw));
      try { window.localStorage.setItem(MARKS_KEY, JSON.stringify(marks)); } catch (e) { /* kept for this visit */ } },
  };

  // Everything shown comes from here, and everything here is dropped on sign-out.
  function freshState() {
    return {
      signedIn: false, demo: false, planRepo: "", findOwner: null, noList: false, run: null,
      list: { state: "loading" }, entries: [], current: null,
      view: { kind: "overview" }, filters: noFilters(), selected: null,
      tabs: [], activeTab: null, docs: new Map(), mapped: new Map(),
      expanded: new Set(["g:favs", "g:projects", "g:across", "g:account"]), treeFocus: null, order: orderStore.read(), marks: marksStore.read(),
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
      // Actions filters, by repository, for this visit: what GitHub is asked for, and the search over titles.
      runFilters: new Map(),
      // Files: per repository, files or changes, the open file and folders, the path search, and the
      // branch, tag or commit its changes are compared with.
      code: new Map(),
      // Search: the words typed, every project or only the current one, and whether task details count.
      search: { q: "", all: false, inside: false },
      // The two main tabs, and the Atlas: its part (a repository's pictures or the account), the repository
      // it shows, how many commits each repository's branch graph shows, each drawn graph kept with what it
      // was drawn from, and whether the account's public profile and activity were asked for.
      // Tasks: the layout they are shown in, the timeline's scale and the calendar's month (null: the newest activity's).
      taskLayout: "list", tlZoom: "weeks", calMonth: null, calDay: null,
      homeWork: "Ready for Review", saving: false, major: "dashboard", atlas: { part: "repo", repo: null, show: new Map(), boxes: new Map(), trees: new Map(), account: false, extras: false, starQ: "", vs: null, vsAsk: "", vsSaid: null, badge: false, badgeTheme: "dark",
        // Versions: the branches picked per repository (none yet: the starting ones), how many commits each
        // version shows (by repository and branch), how many pages of pull requests are read per repository,
        // and the versions that also show the commits they share with the default branch.
        vpick: new Map(), vshow: new Map(), vprs: new Map(), vshared: new Set() },
    };
  }
  let S = freshState();

  // ---- Rendering

  function render() {
    $("goto-open").disabled = !S.signedIn;
    $("refresh").hidden = !S.signedIn;
    $("forget").hidden = !S.signedIn;
    $("forget").textContent = S.demo ? "Leave demo" : "Forget access";
    syncWrite();
    $("tree-tools").hidden = !(S.signedIn && S.entries.length);
    $("mode").textContent = !S.signedIn ? "read-only" : S.demo ? "synthetic demo · made-up data" : write && write.on ? "private · Edit mode" : "private · read-only";
    $("signed-out").hidden = S.signedIn;
    $("workspace").hidden = !S.signedIn;
    const focus = focusMark();
    // A bubble goes with its node; a node kept across drawing (the Atlas graph's dots) keeps its bubble.
    const tipped = tipFor;
    hideTip();
    V.tree(S, A);
    V.main(S, A);
    arrive();
    restoreFocus(focus);
    if (tipped && tipped.isConnected) showTip(tipped, null);
    ensureReads();
    if (gotoBox.open) renderGoto();  // an open Go to never keeps places the current access no longer allows
  }

  // A little motion when another view opens: it fades in, and Home's counts run up to their numbers. Only
  // when the place changes, never on a redraw of the same place, and nothing moves with reduced motion.
  let placeShown = "";
  const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function arrive() {
    const place = [S.signedIn, S.major, S.view.kind, S.view.name || "", S.current, S.activeTab].join("|");
    if (place === placeShown) return;
    placeShown = place;
    closeCtx(false);  // a menu for the place left would act on what is no longer shown
    // The fade is on the area itself, which stays across redraws, so a redraw does not cut it short.
    const box = $("workspace");
    box.classList.remove("arrive");
    if (!S.signedIn || still()) return;
    void box.offsetWidth;
    box.classList.add("arrive");
    if (S.major === "dashboard" && !S.activeTab && S.view.kind === "home") countUp();
  }
  function countUp() {
    const cells = [...document.querySelectorAll("[data-part=home-counts] .kv")].map(n => ({ n, to: Number(n.textContent) })).filter(c => Number.isInteger(c.to) && c.to > 0);
    const start = performance.now(), span = 450;
    const step = now => {
      const k = Math.min(1, (now - start) / span), ease = 1 - Math.pow(1 - k, 3);
      for (const c of cells) if (c.n.isConnected) c.n.textContent = String(k < 1 ? Math.round(c.to * ease) : c.to);
      if (k < 1) requestAnimationFrame(step);
    };
    for (const c of cells) c.n.setAttribute("aria-label", String(c.to));
    requestAnimationFrame(step);
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

  // A short confirmation shown in the corner for a moment; screen readers hear it through announce.
  let toastTimer, surfaceRun = 0;
  function dropSurfaces() {
    surfaceRun += 1;
    clearTimeout(toastTimer);
    $("toast").hidden = true;
    $("toast").textContent = "";
    closeCtx(false);
    ctxBack = null;
  }
  function toast(text) {
    clearTimeout(toastTimer);
    const box = $("toast");
    box.textContent = text;
    box.hidden = false;
    box.classList.remove("show"); void box.offsetWidth; box.classList.add("show");
    toastTimer = setTimeout(() => { box.hidden = true; box.classList.remove("show"); }, 2600);
    announce(text);
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
      // No repository the token reads has the workspace list: an empty list, filled by what the token finds.
      const target = S.noList ? null : SB.parseRepoRef(S.planRepo);
      const list = S.noList ? SB.result("empty", { workspaces: [], found: null }, null) : await SB.readWorkspaces(ctx, client, target.repo, target.ref);
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
      // Every project starts collapsed in the tree; a refresh keeps what was opened or closed.
      keepMapped();
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
    if (!S.signedIn || !session || !S.run || !S.entries.length) return;
    if (S.major === "atlas") return atlasReads();
    if (S.activeTab) return;
    if (S.view.kind === "search") return;  // a search reads nothing
    const feed = r => loadLive(SB.feedKey(r.repo, r.pinned.data.commit), readFeed(r.repo, r.pinned.data.commit));
    // Home reads the activity of the listed projects' repositories, at most V.HOME_REPOS of them.
    // The timeline and calendar across projects read the same repositories as Home.
    if (["home", "timeline", "calendar"].includes(S.view.kind)) { for (const r of V.homeRepos(S).rows) if (r.meta) feed(r); return; }
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
    } else if (S.view.kind === "overview" || (S.view.kind === "tasks" && ["timeline", "calendar"].includes(S.taskLayout))) {
      for (const r of mine) feed(r);
    }
  }

  // The Atlas reads what its branch graph still wants: the branch and tag lists, pages of each drawn
  // branch's commits, and the pull requests that name branches. They share the history's and the work
  // evidence's reads, so a refresh drops them the same way.
  function atlasReads() {
    if (S.atlas.part === "account") return accountReads();
    const r = A.atlasRepo();
    if (!r) return;
    const K = SB.historyKey, repo = r.repo;
    const g = SB.atlasGraph(key => S.live.get(key), repo, r.meta.branch, A.atlasShow(repo));
    for (const w of g.wanted) {
      if (w.kind === "refs") loadLive(K.refs(repo, w.list), ctx => SB.readRefs(ctx, client, repo, w.list));
      else if (w.kind === "lane") loadLive(K.lane(repo, w.head, w.page), ctx => SB.readHistoryPage(ctx, client, repo, w.head, w.page));
      else if (w.kind === "pulls") workRead(repo, "pulls", w.state, w.page);
    }
    // The versions read the same lists: each picked branch's commits, open pull requests' newest commits,
    // and the repository's pull requests page by page.
    const v = SB.atlasVersions(key => S.live.get(key), repo, r.meta.branch, A.atlasVersionPick(repo), name => A.atlasVersionShow(repo, name), A.atlasVersionPrPages(repo), name => A.atlasVersionShared(repo, name));
    for (const w of v.wanted) {
      if (w.kind === "compare") loadLive(K.compare(repo, w.base, w.head), ctx => SB.readCompare(ctx, client, repo, w.base, w.head));
      else if (w.kind === "refs") loadLive(K.refs(repo, w.list), ctx => SB.readRefs(ctx, client, repo, w.list));
      else if (w.kind === "lane") loadLive(K.lane(repo, w.head, w.page), ctx => SB.readHistoryPage(ctx, client, repo, w.head, w.page));
      else if (w.kind === "pulls") workRead(repo, "pulls", w.state, w.page);
    }
    // The code tree reads only once Play was pressed for this repository, a few reads at a time.
    if (!S.atlas.trees.has(repo)) return;
    const t = SB.atlasTree(key => S.live.get(key), repo, r.meta.branch);
    for (const w of t.wanted) {
      if (w.kind === "refs") loadLive(K.refs(repo, w.list), ctx => SB.readRefs(ctx, client, repo, w.list));
      else if (w.kind === "lane") loadLive(K.lane(repo, w.head, w.page), ctx => SB.readHistoryPage(ctx, client, repo, w.head, w.page));
      else if (w.kind === "tree") loadLive(SB.codeKey.tree(repo, w.commit), ctx => SB.readTree(ctx, client, repo, w.commit));
      else if (w.kind === "pulls") workRead(repo, "pulls", w.state, w.page);
      else if (w.kind === "pullCommits") loadLive(SB.treeKey.pullCommits(repo, w.number), ctx => SB.readPullCommits(ctx, client, repo, w.number));
      else if (w.kind === "change") loadLive(SB.codeKey.commit(repo, w.sha), ctx => SB.readCommitChanges(ctx, client, repo, w.sha));
    }
  }

  // The Atlas account reads only once it is asked for: who the token reads as, then that login's public
  // profile and public events.
  function accountReads() {
    if (!S.atlas.account) return;
    loadLive("user", ctx => SB.readUser(ctx, client));
    const user = S.live.get("user"), login = user && user.data ? user.data.login : null;
    if (!login) return;
    loadLive(SB.accountKey.profile(login), ctx => SB.readProfile(ctx, client, login));
    loadLive(SB.accountKey.events(login), ctx => SB.readPublicEvents(ctx, client, login));
    // The starred repositories and public gists only once they are asked for too.
    if (S.atlas.extras) {
      loadLive(SB.accountKey.starred(login), ctx => SB.readStarred(ctx, client, login));
      loadLive(SB.accountKey.gists(login), ctx => SB.readGists(ctx, client, login));
    }
    // The README badge, or a comparison, once asked for: the account's own public repositories; a comparison
    // also reads the other account's own public repositories, profile and events.
    const vs = S.atlas.vs;
    if (vs || S.atlas.badge) loadLive(SB.accountKey.repos(login), ctx => SB.readUserRepos(ctx, client, login));
    if (!vs) return;
    loadLive(SB.accountKey.profile(vs), ctx => SB.readProfile(ctx, client, vs));
    loadLive(SB.accountKey.events(vs), ctx => SB.readPublicEvents(ctx, client, vs));
    loadLive(SB.accountKey.repos(vs), ctx => SB.readUserRepos(ctx, client, vs));
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
  const runFilterOf = repo => S.runFilters.get(repo) || SB.noRunFilter();
  const workStateOf = (repo, kind) => kind === "pulls" || kind === "issues" ? S.workState.get(repo + "|" + kind) || "open"
    : kind === "runs" ? SB.runState(runFilterOf(repo)) : null;
  function workRead(repo, kind, state, page) {
    const key = SB.workKey.list(kind, repo, state, page);
    if (kind === "pulls") loadLive(key, ctx => SB.readPullPage(ctx, client, repo, state, page));
    else if (kind === "issues") loadLive(key, ctx => SB.readIssuePage(ctx, client, repo, state, page));
    else if (kind === "runs") { const f = runFilterOf(repo); loadLive(key, ctx => SB.readRunPage(ctx, client, repo, page, f)); }
    else loadLive(key, ctx => SB.readReleasePage(ctx, client, repo, page));
  }
  function workReads(repo, kind) {
    const state = workStateOf(repo, kind);
    const w = SB.workList(key => S.live.get(key), kind, repo, state, S.workDepth.get(workSlot(repo, kind, state)) || 1);
    for (const page of w.wanted) workRead(repo, kind, state, page);
    if (kind === "runs") loadLive(SB.workKey.workflows(repo), ctx => SB.readWorkflows(ctx, client, repo));
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

  const SIGNED_IN = "Signed in. The token is in this page's memory only.";

  async function connect(event) {
    event.preventDefault();
    const typed = $("token").value.trim();
    $("token").value = "";
    const planRepo = $("plan-repo").value.trim();
    // Only an owner, or nothing: the plan repository is looked for among the token's repositories.
    const owner = /^[A-Za-z0-9-]*$/.test(planRepo) ? planRepo : null;
    if (!typed || (owner === null && !SB.parseRepoRef(planRepo))) {
      $("state").textContent = !typed ? "Enter a read-only token." : "Enter the plan repository as owner/repo or owner/repo@branch, only its owner, or nothing.";
      return;
    }
    start(false);
    S.planRepo = owner === null ? planRepo : "";
    S.findOwner = owner;
    $("state").textContent = SIGNED_IN;
    const ctx = session.start(typed);
    $("main").focus();
    await read(ctx);
  }

  // A sign-in or refresh with no plan repository yet looks for it first.
  async function read(ctx) {
    if (!S.planRepo && S.findOwner !== null && !await findPlan(ctx, S.findOwner)) return;
    await load(ctx);
  }

  // The plan repository is used only when it is the one repository the token reads (of that owner)
  // with the workspace list, and every one of them was checked. When none has it, every repository the
  // token reads is shown as found, and the page says so. Otherwise nothing is loaded, and the page says
  // why, with what to type instead.
  async function findPlan(ctx, owner) {
    if (S.noList) $("state").textContent = SIGNED_IN;
    S.noList = false;
    S.list = { state: "loading" };
    render();
    try {
      const found = await SB.findPlanRepos(ctx, client, owner);
      session.alive(ctx);
      const d = found.data;
      if (found.state === "current" && d.complete && d.repos.length === 1) { S.planRepo = d.repos[0]; return true; }
      const of = owner ? " of " + owner : "";
      const again = "Forget access, then sign in with ";
      // Why a search that found one, or none, cannot be trusted to be the whole answer.
      const gaps = d ? [!d.listedAll && "the token's list of repositories is longer than can be read",
                        !d.underLimit && "only the first " + SB.FIND_LIMIT + " were checked",
                        d.unchecked.length && "these could not be checked: " + d.unchecked.join(", ")].filter(Boolean) : [];
      if (d && !d.repos.length) {
        S.noList = true;
        $("state").textContent = "No repository" + of + " that the token reads has the workspace list (" + SB.WORKSPACES_FILE + ")" +
          (gaps.length ? " among those checked (" + gaps.join("; ") + ")" : "") + ", so every repository the token reads is shown, marked found.";
        return true;
      }
      S.list = !d ? SB.result(found.state, null, null, { error: "the token's list of repositories could not be read (" + (found.error || found.state) + "). " + again + "the plan repository as owner/repo." })
        : d.repos.length > 1 ? SB.result("invalid", null, null, { error: "more than one repository" + of + " has it (" + d.repos.join(", ") + "). " + again + "the one to use as owner/repo." })
        : d.repos.length === 1 ? SB.result("partial", null, null, { error: d.repos[0] + " has it, but the search is not complete (" + gaps.join("; ") + "). " + again + d.repos[0] + " to use it." })
        : SB.result(gaps.length ? "partial" : "missing", null, null, { error: "no repository" + of + " that the token reads has it" +
            (gaps.length ? " among those checked (" + gaps.join("; ") + ")" : "") + ". " + again + "the plan repository as owner/repo." });
      render();
      announce("Reading finished.");
      return false;
    } catch (err) {
      if (err instanceof SB.Revoked) { endSession("revoked"); return false; }
      try { session.alive(ctx); } catch (e) { return false; }
      S.list = SB.result("failed", null, null, { error: "browser error (" + err.name + ")" });
      render();
      return false;
    }
  }

  async function showDemo() {
    start(true);
    S.planRepo = window.SANDBOARD_DEMO.sign_in;
    $("state").textContent = "Synthetic demo: every project here is made up. Nothing is read from GitHub.";
    const ctx = session.start("synthetic-demo");
    $("main").focus();
    await load(ctx);
  }

  // ---- Edit mode

  // The repositories Edit mode may change: those the workspace list maps to its projects (never ones only
  // found through the read token or opened by name), less any whose read was denied or missing.
  function writableRepos() {
    const gone = r => r && (r.state === "missing" || r.state === "denied");
    const out = [];
    for (const e of S.entries) {
      if (e.w.found || e.w.opened) continue;
      if (e.w.plan && !gone(e.plan)) out.push(e.w.plan.repo);
      for (const c of e.code) if (!gone(c.pinned)) out.push(c.c.repo);
    }
    return out;
  }
  // Only a finished reading of the workspace list changes what Edit mode may reach.
  const settled = () => S.signedIn && !S.demo && (S.list.state === "current" || S.list.state === "empty") && S.entries.every(e => !e.loading);

  // Repositories whose read was found denied or missing, as soon as each read ends.
  function goneRepos() {
    const gone = r => r && (r.state === "missing" || r.state === "denied");
    const out = [];
    for (const e of S.entries) {
      if (e.w.plan && gone(e.plan)) out.push(e.w.plan.repo);
      for (const c of e.code) if (gone(c.pinned)) out.push(c.c.repo);
    }
    return out;
  }

  // Keeps the marker, the button and the waiting confirmation in step with the write session. A repository
  // found denied or missing leaves the set at once; while the list is read again nothing may be changed,
  // and the set follows the new mapping only once every project has been read.
  function syncWrite() {
    if (write && write.on) {
      for (const r of goneRepos()) write.remove(r);
      if (!settled()) write.suspend();
      else if (write.on) { write.restrict(writableRepos()); write.resume(); }
    }
    if (write && !write.on && !checkingWrite) endWrite("Edit mode ended: the write token was refused or no repository it may change is left. Reading goes on.");
    const on = !!(write && write.on && write.login);
    $("edit-open").hidden = !S.signedIn || S.demo || !!write;
    $("edit-bar").hidden = !on;
    $("edit-who").textContent = on ? "acting as " + write.login + " on " + write.repos.join(", ") + (write.suspended ? " (paused while the projects are read again)" : "") : "";
    if (pendingWrite && !(writer && writer.current(pendingWrite))) closeWrite("Not sent: Edit mode, the project or the token changed after it was opened.");
  }

  function showWriteResult(text, link, undo) {
    const box = $("write-result");
    box.replaceChildren();
    if (!text) { box.hidden = true; return; }
    box.append(text);
    if (link) box.append(" ", V.el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "Open on GitHub"));
    if (undo) box.append(" " + undo);
    box.hidden = false;
    announce(text);
  }

  function openEdit() {
    if (!S.signedIn || S.demo || write) return;
    const owners = [...new Set(writableRepos().map(r => r.split("/")[0]))].sort();
    $("edit-owner").replaceChildren(...owners.map(o => V.el("option", { value: o }, o)));
    $("edit-state").textContent = owners.length ? "" : "No repository is mapped in the workspace list yet, so there is nothing Edit mode could change.";
    $("write-token").value = "";
    $("edit").showModal();
  }

  async function startEdit(event) {
    event.preventDefault();
    if (checkingWrite) return;  // one acquisition at a time
    const typed = $("write-token").value.trim();
    $("write-token").value = "";
    const owner = $("edit-owner").value;
    if (!typed || !owner) { $("edit-state").textContent = !owner ? "Choose an owner." : "Paste the write token."; return; }
    const mine = SB.createWriteSession();
    try { mine.start(typed, owner, writableRepos()); } catch (e) { $("edit-state").textContent = "No mapped repository of " + owner + " can be changed."; return; }
    write = mine;
    writer = SB.createWriter(mine);
    checkingWrite = mine;
    $("edit-state").textContent = "Checking the write token with GitHub…";
    render();
    let said;
    try { said = await writer.check(); } catch (e) { if (e instanceof SB.Stale) return; throw e; }
    if (write !== mine || checkingWrite !== mine) return;  // cancelled, left, signed out or replaced while GitHub answered
    checkingWrite = null;
    if (!said.ok) {
      endWrite("Edit mode is off: " + said.why + ".");
      render();
      return;
    }
    $("edit").close();
    const missed = said.reach.filter(r => !r.ok).map(r => r.repo + " (" + r.why + ")");
    showWriteResult("Edit mode on, acting as " + said.login + ". It can change " + mine.repos.join(", ") +
      (missed.length ? "; the write token does not reach " + missed.join(", ") : "") +
      ". Token expiry: " + (said.expiry || "unknown") + ".", null, null);
    render();
  }

  // Drops the write token and everything that came with it; the read session stays.
  function endWrite(text) {
    checkingWrite = null;
    if (write) write.end();
    write = null;
    writer = null;
    $("write-token").value = "";
    if ($("edit").open) $("edit").close();
    closeWrite(null);
    showWriteResult(text, null, null);
  }

  // The one confirmation every write action uses. Later actions call A.confirmWrite with their kind.
  function confirmWrite(kind, repo, fields) {
    if (!writer) { showWriteResult("Not sent: Edit mode is off.", null, null); return; }
    let d;
    try { d = writer.prepare(kind, repo, fields); } catch (e) {
      if (!(e instanceof SB.NotSent)) throw e;
      showWriteResult("Not sent: " + e.message + ".", null, null);
      return;
    }
    pendingWrite = d;
    $("write-fields").replaceChildren(...SB.describeWrite(d).flatMap(([k, v]) => [V.el("dt", null, k), V.el("dd", null, v)]));
    $("write-type-row").hidden = !d.hard;
    $("write-type-what").textContent = d.hard ? String(d.fields.number) : "";
    $("write-type").value = "";
    $("write-confirm").showModal();
  }

  function closeWrite(text) {
    pendingWrite = null;
    $("write-fields").replaceChildren();
    $("write-type").value = "";
    if ($("write-confirm").open) $("write-confirm").close();
    if (text) showWriteResult(text, null, null);
  }

  async function sendWrite() {
    const d = pendingWrite, mine = write, typed = $("write-type").value;
    if (!d || !writer) return;
    const w = writer;
    closeWrite(null);
    showWriteResult("Sending…", null, null);
    const r = await w.dispatch(d, typed);
    // Edit mode was left or the session ended while GitHub answered: what happened is not known here.
    if (write !== mine && r.outcome !== "not-sent") { showWriteResult("Not sure it happened: check on GitHub.", r.link, null); return; }
    showWriteResult(r.message, r.link, r.undo);
    if (write === mine && !mine.on) { write = null; writer = null; render(); }
  }

  // Ends the session and clears every surface. why: forget | left | restored | revoked | demo
  function endSession(why) {
    endWrite(null);
    if (session) session.forget();
    session = null;
    client = null;
    // The Atlas's code trees and graph replays stop and let go of what they hold before the state goes.
    V.atlasDispose(S.atlas);
    S = freshState();
    $("token").value = "";
    $("write-token").value = "";
    if (gotoBox.open) gotoBox.close();
    if (helpBox.open) helpBox.close();
    $("goto-list").replaceChildren();
    $("goto-q").value = "";
    clearTimeout(liveTimer);
    $("live").textContent = "";
    hideTip();
    setMenu(false);
    // The right-click menu and the confirmation hold names and links of what was read: they go too,
    // and a copy still finishing can no longer show a message.
    dropSurfaces();
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
    // Every write action goes through the one confirmation, with its kind, repository and details.
    confirmWrite,
    // Moves a project to a place in the left tree (by dragging, or Alt with an arrow) and keeps the order.
    moveProject(id, to) {
      const shown = SB.orderedIds(S.entries.map(e => e.w.id), S.order);
      const from = shown.indexOf(id);
      if (from < 0 || to < 0 || to >= shown.length || to === from) return;
      S.order = SB.moveId(shown, S.order, id, to);
      orderStore.write(SB.keptOrder(S.order));
      S.treeFocus = "p:" + id;
      render(); V.focusTree(S);
      const entry = S.entries.find(e => e.w.id === id);
      announce("Moved " + entry.w.label + " to place " + (to + 1) + " of " + shown.length + ".");
    },
    refreshProject,
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
    runFilter: runFilterOf,
    // One Actions filter changed: GitHub is asked again for the runs it now matches, from the first page.
    setRunFilter(repo, key, value, focusId) {
      const f = Object.assign(runFilterOf(repo), { [key]: String(value || "").trim() === "" ? "" : key === "q" ? String(value) : String(value).trim() });
      const caret = key === "q" && $("af-q") ? $("af-q").selectionStart : null;
      S.runFilters.set(repo, f);
      render();
      const n = $(focusId);
      if (n) { n.focus(); if (caret !== null) n.setSelectionRange(caret, caret); }
    },
    clearRunFilter(repo) {
      S.runFilters.delete(repo);
      render();
      const n = $("af-workflow");
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
    // Home's open work: which status it lists.
    // Task layouts change only how the filtered rows are laid out; the focus stays on the control pressed.
    taskLayout(kind) {
      if (!V.TASK_LAYOUTS.includes(kind)) return;
      S.taskLayout = kind;
      render();
      const n = $("layout-" + kind); if (n) n.focus();
    },
    timelineZoom(zoom) {
      S.tlZoom = zoom === "months" ? "months" : "weeks";
      render();
      const n = $("tl-" + S.tlZoom); if (n) n.focus();
    },
    calMonth(month, focus) {
      S.calMonth = month;
      S.calDay = null;
      render();
      const n = $(focus) || $("cal-h"); if (n) n.focus();
    },
    // One calendar day shown with all of its events, or none; the focus stays on its button.
    calDay(day, focus) {
      S.calDay = day;
      render();
      const n = $(focus); if (n) n.focus();
    },
    homeWork(status, focus) {
      S.homeWork = status;
      render();
      if (focus) { const n = $("work-tab-" + status.replace(/ /g, "-")); if (n) n.focus(); }
    },
    // The account views (all mapped repositories, their activity, and the inbox) belong to no single project.
    goAccount(kind) {
      S.major = "dashboard";
      if (["timeline", "calendar"].includes(kind) && !["timeline", "calendar"].includes(S.view.kind)) { S.calMonth = null; S.calDay = null; }
      S.view = { kind };
      S.activeTab = null;
      render();
      $("main").focus();
    },
    // ---- Marks kept in this browser: favourites and saved views.
    toggleFav(project, task, focusId) {
      if (String(project).charAt(0) === "~") { toast("A repository found or opened by name can't be a favourite: its name is never stored."); return; }
      const key = SB.favKey(project, task);
      const on = !S.marks.favs.includes(key);
      if (on && S.marks.favs.length >= SB.MARK_LIMITS.favs) { toast("Favourites are full (" + SB.MARK_LIMITS.favs + "). Take one out first."); return; }
      S.marks = SB.toggleFav(S.marks, key);
      marksStore.write(S.marks);
      render();
      if (focusId) { const n = $(focusId); if (n) n.focus(); }
      toast((task || (entryOf(project) || { w: { label: project } }).w.label) + (on ? " added to favourites" : " taken out of favourites"));
    },
    saveView(name) {
      const e = entryOf(S.current);
      const clean = String(name || "").trim().slice(0, 40);
      if (!e || !clean) return false;
      if (S.current.charAt(0) === "~") { toast("A view of a repository found or opened by name can't be saved: its name is never stored."); return false; }
      const next = SB.saveView(S.marks, { project: S.current, name: clean, filters: S.filters, layout: S.taskLayout });
      if (!next) { toast("Saved views are full (" + SB.MARK_LIMITS.views + "). Remove one first."); return false; }
      S.marks = next;
      marksStore.write(S.marks);
      S.saving = false;
      render();
      const n = $("save-view"); if (n) n.focus();
      toast("Saved the view “" + clean + "”");
      return true;
    },
    savingView(on) { S.saving = !!on; render(); const n = $(on ? "view-name" : "save-view"); if (n) n.focus(); },
    openView(project, name) {
      const v = S.marks.views.find(x => x.project === project && x.name === name);
      if (v) A.go(project, { kind: "tasks" }, { filters: v.filters, layout: v.layout, focus: "tasks-h" });
    },
    dropView(project, name) {
      S.marks = SB.dropView(S.marks, project, name);
      marksStore.write(S.marks);
      render();
      const n = $("save-view"); if (n) n.focus();
      toast("Removed the view “" + name + "”");
    },
    toast,
    // A member's page: the tasks naming them across projects.
    goMember(name) {
      S.major = "dashboard";
      S.view = { kind: "member", name: String(name) };
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
    setSearch(key, value, focusId) {
      S.search[key] = value;
      const caret = key === "q" ? $("sq").selectionStart : null;
      render();
      const n = $(focusId);
      if (n) { n.focus(); if (caret !== null) n.setSelectionRange(caret, caret); }
    },
    // A file path or opened file found by the search, shown in its repository's Files at the same commit.
    openFound(project, repo, path) {
      A.go(project, { kind: "repo", repo, sub: "files" });
      const c = codeView(repo);
      c.mode = "files";
      A.openCodeFile(repo, path);
    },
    closeMenu: () => setMenu(false),
    setMajor(kind, focus) {
      S.major = kind;
      render();
      const n = $("major-" + kind);
      if (focus && n) n.focus();
    },
    // The repositories the Atlas can show: every one a project has read, once each.
    atlasRepos: () => SB.portfolio(S.entries).filter(r => r.meta && r.meta.branch && r.pinned && r.pinned.data),
    // The one it shows: the one picked, else the open repository, else the open project's first, else the first.
    atlasRepo() {
      const rows = A.atlasRepos();
      const e = entryOf(S.current);
      const mine = e ? [S.view.kind === "repo" ? S.view.repo : null, ...e.w.code.map(c => c.repo), planRepo(e.w)] : [];
      for (const want of [S.atlas.repo, ...mine]) { const r = want && rows.find(x => x.repo === want); if (r) return Object.assign({ web: r.pinned.data.web }, r); }
      return rows[0] ? Object.assign({ web: rows[0].pinned.data.web }, rows[0]) : null;
    },
    setAtlasRepo(repo) { S.atlas.repo = repo; render(); },
    setAtlasPart(part, focus) {
      S.atlas.part = part === "account" ? "account" : "repo";
      render();
      const n = $("atlas-part-" + S.atlas.part);
      if (focus && n) n.focus();
    },
    // The account's public profile and activity are read only once asked for.
    atlasAccountRead() {
      S.atlas.account = true;
      render();
      announce("Reading your public profile and activity.");
    },
    atlasAccountExtras() {
      S.atlas.extras = true;
      render();
      announce("Reading your starred repositories and public gists.");
    },
    // The words the starred list is narrowed by; the list narrows itself, so nothing is drawn again.
    atlasStarQuery(q) { if (q !== undefined) S.atlas.starQ = String(q); return S.atlas.starQ; },
    // Another account to put beside yours, by its login. Nothing is read for text that is not a login, or
    // for your own account; what is wrong is said by the box, which keeps focus.
    atlasCompare(text) {
      const login = String(text || "").trim().replace(/^@/, "");
      const user = S.live.get("user"), me = user && user.data ? user.data.login : null;
      S.atlas.vsAsk = login;
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) S.atlas.vsSaid = "A GitHub login is 1 to 39 letters, digits or hyphens.";
      else if (me && login.toLowerCase() === me.toLowerCase()) S.atlas.vsSaid = "That is your own account. Pick another one.";
      else { S.atlas.vsSaid = null; S.atlas.vs = login; }
      render();
      if (S.atlas.vsSaid) { const n = $("ac-vs-q"); if (n) n.focus(); }
      else announce("Reading @" + login + " to compare.");
    },
    atlasBadge() {
      S.atlas.badge = true;
      render();
      announce("Reading your public repositories for the badge.");
    },
    atlasBadgeTheme(theme) {
      S.atlas.badgeTheme = theme === "light" ? "light" : "dark";
      render();
      const n = $("ac-badge-" + S.atlas.badgeTheme);
      if (n) n.focus();
    },
    atlasCompareAsk(q) { if (q !== undefined) S.atlas.vsAsk = String(q); return S.atlas.vsAsk; },
    atlasCompareClear() {
      S.atlas.vs = null;
      render();
      const n = $("ac-vs-q");
      if (n) n.focus();
    },
    // What the account could not read is dropped, so it is read again, with an event list a later page of
    // which failed; what worked, and the profile, are kept.
    atlasAccountRetry() {
      for (const [key, res] of [...S.live]) {
        if ((key === "user" || key.startsWith("account|")) && res.state !== "loading" && (!res.data || res.data.stopped)) S.live.delete(key);
      }
      render();
    },
    atlasShow: repo => S.atlas.show.get(repo) || SB.ATLAS.FIRST,
    atlasOlder(repo) {
      S.atlas.show.set(repo, SB.ATLAS.older(A.atlasShow(repo)));
      render();
      announce("Reading older commits.");
    },
    // What the graph could not read is dropped, so it is read again: the branch and tag lists, pages of the
    // branches' commits and the pull request lists. Reads that worked are kept.
    atlasRetry(repo) {
      const mine = key => key === SB.historyKey.refs(repo, "branches") || key === SB.historyKey.refs(repo, "tags") ||
        key.startsWith("lane|" + repo + "@") || key.startsWith("work|pulls|" + repo + "|");
      for (const [key, res] of [...S.live]) if (mine(key) && res.state !== "loading" && !res.data) S.live.delete(key);
      render();
    },
    // Versions: the branches picked (null until one is changed), how far back each one shows, and how
    // many pages of pull requests are read for them, and which also show the commits they share with the default branch.
    atlasVersionPick: repo => S.atlas.vpick.get(repo) || null,
    atlasVersionToggle(repo, name, on, now) {
      const list = now.filter(n => n !== name);
      if (on) list.push(name);
      S.atlas.vpick.set(repo, list.slice(0, SB.ATLAS.VERSIONS));
      render();
      const n = [...document.querySelectorAll("#av-pick input")].find(x => x.value === name);
      if (n) n.focus();
    },
    atlasVersionShow: (repo, name) => S.atlas.vshow.get(repo + "|" + name) || SB.ATLAS.FIRST,
    atlasVersionOlder(repo, name) {
      S.atlas.vshow.set(repo + "|" + name, SB.ATLAS.older(A.atlasVersionShow(repo, name)));
      render();
      announce("Reading older commits of " + name + ".");
    },
    atlasVersionShared: (repo, name) => S.atlas.vshared.has(repo + "|" + name),
    atlasVersionShare(repo, name, on) {
      S.atlas.vshared[on ? "add" : "delete"](repo + "|" + name);
      render();
      const n = [...document.querySelectorAll("#av-panel input[data-shared]")].find(x => x.dataset.shared === name);
      if (n) n.focus();
    },
    atlasVersionPrPages: repo => S.atlas.vprs.get(repo) || SB.ATLAS.PR_FIRST,
    atlasVersionPrMore(repo) {
      S.atlas.vprs.set(repo, Math.min(SB.ATLAS.PR_MAX, A.atlasVersionPrPages(repo) + 1));
      render();
      announce("Reading more pull requests.");
    },
    // The graph drawn for a repository, kept while what it is drawn from is the same, so its zoom, scroll
    // and replay survive the page being drawn again. A new drawing keeps the old one's zoom and place.
    atlasBox(repo, sig, build) {
      const old = S.atlas.boxes.get(repo) || null;
      if (sig === undefined || (old && old.sig === sig)) return old;
      const box = build();
      if (old) {
        if (old.box.replay) { clearInterval(old.box.replay.timer); old.box.replay = null; }
        Object.assign(box, { zoom: old.box.zoom, fromRight: old.box.fromRight, top: old.box.top, asked: old.box.asked });
      }
      const holder = { sig, box };
      S.atlas.boxes.set(repo, holder);
      return holder;
    },
    // The code tree of a repository: nothing until Play is pressed, then its playback, kept across drawing.
    atlasTree: repo => S.atlas.trees.get(repo) || null,
    atlasTreePlay(repo) {
      if (!S.atlas.trees.has(repo)) S.atlas.trees.set(repo, { view: null });
      render();
      announce("Reading the code tree.");
    },
    // What the code tree could not read is dropped, so it is read again.
    atlasTreeRetry(repo) {
      const mine = key => key === SB.historyKey.refs(repo, "branches") || key.startsWith("lane|" + repo + "@") || key.startsWith("tree|" + repo + "@") ||
        key.startsWith("work|pulls|" + repo + "|") || key.startsWith("pullcommits|" + repo + "|") || key.startsWith("change|" + repo + "|");
      for (const [key, res] of [...S.live]) if (mine(key) && res.state !== "loading" && !res.data) S.live.delete(key);
      render();
    },
    atlasFiles(repo, sha) { loadLive(SB.codeKey.commit(repo, sha), ctx => SB.readCommitChanges(ctx, client, repo, sha)); render(); },
    // A bubble showing for a node gets the node's new text.
    retip(node) { if (tipFor === node && !tipBox.hidden) tipBox.textContent = node.getAttribute("data-tip"); },
    go(project, view, opts) {
      if (project !== S.current) { S.filters = noFilters(); S.selected = null; S.calMonth = null; S.calDay = null; }
      S.current = project;
      S.view = view;
      S.activeTab = null;
      // In the Atlas, a repository picked in the tree is shown there; anything else is on the dashboard.
      if (S.major === "atlas" && view.kind === "repo") { S.atlas.repo = view.repo; S.atlas.part = "repo"; }
      else S.major = "dashboard";
      // A phase picked from the tree or a phase card brings its stage with it, as the filters show it.
      if (opts && opts.phase !== undefined) S.filters = Object.assign(noFilters(), { stage: V.stageIdOf(entryOf(project), opts.phase), phase: opts.phase });
      // A stage picked from the tree or a stage chip opens its tasks with the filters, like a phase.
      if (opts && opts.stage !== undefined) S.filters = Object.assign(noFilters(), { stage: opts.stage });
      if (opts && opts.select !== undefined) S.selected = opts.select;
      // A saved view brings its filters and layout.
      if (opts && opts.filters) { S.filters = Object.assign(noFilters(), opts.filters); S.selected = null; }
      if (opts && opts.layout && V.TASK_LAYOUTS.includes(opts.layout)) S.taskLayout = opts.layout;
      render();
      if (S.selected) loadDocs(entryOf(project), S.selected);
      if (opts && opts.focus) { const n = $(opts.focus); if (n) { n.focus(); return; } }
      $("main").focus();
    },
    showStage(project, stage) { A.go(project, { kind: "overview", stage: stage || null }); },
    showPhase(project, phase) { A.go(project, { kind: "tasks" }, { phase, focus: "tasks-h" }); },
    showStageTasks(project, stage) { A.go(project, { kind: "tasks" }, { stage, focus: "tasks-h" }); },
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
    V.atlasDispose(S.atlas);
    S.atlas.show = new Map();
    S.atlas.boxes = new Map();
    S.atlas.trees = new Map();
    S.atlas.vshow = new Map();
    S.atlas.vprs = new Map();
    S.search = freshState().search;  // a new run searches nothing read before it
    const ctx = session.start();  // same token, new run: replies to the old run are dropped
    closeCtx(false);
    toast("Refreshing.");
    read(ctx);
  }

  // One project read again on its own: its plan and repositories at their branches now, their live
  // reads, and its task files that did not finish with an answer. The workspace list, the other
  // projects, the tabs of other projects and the search stay as they are. It reads in the current run,
  // so a full Refresh or an ended session drops its replies; its late answer changes nothing then.
  async function refreshProject(id) {
    const i = S.entries.findIndex(e => e.w.id === id);
    if (!session || !S.run || i < 0 || S.entries[i].loading) return;
    const ctx = S.run;
    let w = S.entries[i].w;
    const repos = [planRepo(w), ...w.code.map(c => c.repo)].filter(Boolean);
    // Only reads whose own repository slot is one of this project's (never a path or ref inside a key).
    for (const key of [...S.live.keys()]) if (repos.includes(SB.liveKeyRepo(key))) S.live.delete(key);
    for (const m of [S.histDepth, S.histScroll]) for (const key of [...m.keys()]) if (repos.includes(key.split("@")[0])) m.delete(key);
    for (const key of [...S.workDepth.keys()]) if (repos.includes(key.split("|")[1])) S.workDepth.delete(key);
    for (const repo of repos) {
      const t = S.atlas.trees.get(repo), h = S.atlas.boxes.get(repo);
      if (t && t.view) t.view.dispose();
      if (h && h.box.replay) { clearInterval(h.box.replay.timer); h.box.replay = null; }
    }
    for (const m of [S.atlas.show, S.atlas.boxes, S.atlas.trees, S.atlas.vprs]) for (const repo of repos) m.delete(repo);
    // A version's graph and how far back it shows, kept by repository and branch.
    for (const key of [...S.atlas.vshow.keys()]) if (repos.includes(key.split("|")[0])) S.atlas.vshow.delete(key);
    for (const [key, h] of [...S.atlas.boxes]) if (key.startsWith("v|") && repos.includes(key.split("|")[1])) { if (h.box.replay) clearInterval(h.box.replay.timer); S.atlas.boxes.delete(key); }
    for (const [key, res] of [...S.docs]) {
      if (key.startsWith(id + "|") && (!["current", "empty", "missing", "invalid"].includes(res.state) || key.includes("|live|"))) S.docs.delete(key);
    }
    const pending = { w, loading: true, plan: null, table: null, progress: null, code: w.code.map(c => ({ c, pinned: null, checks: null })), tasks: [] };
    const mine = () => S.run === ctx && S.entries[i] === pending;
    S.entries[i] = pending;
    announce("Refreshing " + w.label + ".");
    render();
    try {
      let read = await SB.readWorkspace(ctx, client, w);
      session.alive(ctx);
      if (!mine()) return;
      if (w.found && w.plan && noTable(read)) {
        w = codeOnly(w);
        read = await SB.readWorkspace(ctx, client, w);
        session.alive(ctx);
        if (!mine()) return;
        if (w.id === S.current && S.view.kind !== "repo") S.view = startView(w);
      }
      S.entries[i] = entryFrom(w, read);
      dropUnreadableTabs(S.entries[i]);
      render();
      if (w.id === S.current && S.selected) loadDocs(S.entries[i], S.selected);
      for (const t of S.tabs) if (t.project === w.id) { loadDocs(tabSource(t), t.id); if (t.sub === "cycle") loadCycle(tabSource(t), t.id); }
      announce("Reading finished.");
    } catch (err) {
      if (err instanceof SB.Revoked) { endSession("revoked"); return; }
      if (!mine()) return;
      try { session.alive(ctx); } catch (e) { return; }
      const failed = () => SB.result("failed", null, null, { error: "browser error (" + err.name + ")" });
      S.entries[i] = entryFrom(w, [...(w.plan ? [{ kind: "plan", result: failed() }] : []), ...w.code.map(() => ({ kind: "code", result: failed() }))]);
      dropUnreadableTabs(S.entries[i]);
      render();
    }
  }

  // ---- Go to: places only (projects, views, repositories, the open project's tasks, themes)

  let gotoItems = [];
  let gotoSel = 0;

  function places() {
    const out = [["Home", "Every project", () => A.goAccount("home")], ["All repositories", "Account", () => A.goAccount("portfolio")], ["Activity and languages", "Account", () => A.goAccount("activity")],
                 ["Inbox", "Account", () => A.goAccount("inbox")], ["Search what is read", "Account", () => A.goAccount("search")],
                 ["Timeline of every project", "Across projects", () => A.goAccount("timeline")], ["Calendar of every project", "Across projects", () => A.goAccount("calendar")],
                 ["Members", "Across projects", () => A.goAccount("members")], ["Teams", "Across projects", () => A.goAccount("teams")],
                 ["Atlas", "View", () => A.setMajor("atlas")], ["Progress (main tab)", "View", () => A.setMajor("dashboard")],
                 ["Your account (Atlas)", "Atlas", () => { S.atlas.part = "account"; A.setMajor("atlas"); $("main").focus(); }]];
    for (const m of SB.members(S.entries)) out.push([m.name, "Member", () => A.goMember(m.name)]);
    for (const e of S.entries) {
      const w = e.w;
      if (w.plan) {
        out.push([w.label + ": overview", "Project", () => A.go(w.id, { kind: "overview" })]);
        out.push([w.label + ": tasks", "Project", () => A.go(w.id, { kind: "tasks" }, { phase: "" })]);
      }
      for (const r of [w.plan && w.plan.repo, ...w.code.map(c => c.repo)].filter(Boolean)) {
        out.push([r + " (" + w.label + ")", "Repository", () => A.go(w.id, { kind: "repo", repo: r })]);
        out.push([r + " history (" + w.label + ")", "Repository", () => A.go(w.id, { kind: "repo", repo: r, sub: "history" })]);
        out.push([r + " branch graph (Atlas)", "Atlas", () => { S.atlas.repo = r; S.atlas.part = "repo"; A.setMajor("atlas"); $("main").focus(); }]);
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
    // Commands: things to do rather than places to go. None of them writes anywhere.
    out.push(["Refresh everything", "Command", refresh], ["Open Settings", "Command", () => $("settings").showModal()],
             ["Keyboard help", "Command", () => helpBox.showModal()]);
    if (current && current.w.plan) {
      for (const [k, name] of [["list", "List"], ["board", "Board"], ["table", "Table"], ["timeline", "Timeline"], ["calendar", "Calendar"]]) {
        out.push(["Show tasks as " + name, "Command", () => A.go(current.w.id, { kind: "tasks" }, { layout: k, focus: "layout-" + k })]);
      }
      if (current.w.id.charAt(0) !== "~") out.push([(S.marks.favs.includes(SB.favKey(current.w.id)) ? "Take " : "Add ") + current.w.label + (S.marks.favs.includes(SB.favKey(current.w.id)) ? " out of favourites" : " to favourites"), "Command", () => A.toggleFav(current.w.id, null)]);
    }
    for (const v of S.marks.views) {
      const e = entryOf(v.project);
      if (e) out.push([e.w.label + ": " + v.name, "Saved view", () => A.openView(v.project, v.name)]);
    }
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

  // ---- Look: density and accent colour, from Settings
  let look = lookStore.read();
  function applyLook(next, keep) {
    look = SB.savedLook(JSON.stringify(next));
    if (look.density === "comfortable") root.removeAttribute("data-density"); else root.setAttribute("data-density", look.density);
    if (look.accent === "blue") root.removeAttribute("data-accent"); else root.setAttribute("data-accent", look.accent);
    for (const b of document.querySelectorAll("[data-density-choice]")) b.setAttribute("aria-pressed", String(b.dataset.densityChoice === look.density));
    for (const b of document.querySelectorAll("[data-accent-choice]")) {
      const on = b.dataset.accentChoice === look.accent;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (keep) lookStore.write(look);
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
    // The tree shows no bubble on hover or click, only when the keyboard moves to an item.
    if (node.closest("#tree") && !(focus && node.matches(":focus-visible"))) return null;
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
    // A bubble shown for the keyboard's place stays while the pointer is over nothing with a bubble of its own,
    // as when the page is drawn again under a resting pointer.
    if (!node && tipFor && tipFor.contains(document.activeElement)) return;
    clearTimeout(tipTimer);
    // The branch graph's dots and labels answer quickly, as a picture's details do.
    tipTimer = node ? setTimeout(() => showTip(node, null), node.closest(".atlas-graph") ? 150 : TIP_WAIT) : setTimeout(hideTip, 200);
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
  $("collapse-all").addEventListener("click", () => { S.expanded = new Set(["g:favs", "g:projects", "g:across", "g:account"]); render(); });
  $("connect").addEventListener("submit", connect);
  $("show-demo").addEventListener("click", showDemo);
  $("forget").addEventListener("click", () => { endSession(S.demo ? "demo" : "forget"); $("main").focus(); });
  $("refresh").addEventListener("click", refresh);
  $("edit-open").addEventListener("click", openEdit);
  $("edit-form").addEventListener("submit", startEdit);
  $("edit-cancel").addEventListener("click", () => { if (checkingWrite) endWrite("Edit mode is off: cancelled."); $("edit").close(); render(); });
  $("edit-leave").addEventListener("click", () => { endWrite("Left Edit mode. The write token was dropped; reading goes on."); render(); });
  $("write-send").addEventListener("click", sendWrite);
  $("write-cancel").addEventListener("click", () => closeWrite("Not sent: cancelled."));
  $("write-confirm").addEventListener("close", () => { if (pendingWrite) closeWrite("Not sent: cancelled."); });
  $("edit").addEventListener("close", () => { $("write-token").value = ""; if (checkingWrite) { endWrite("Edit mode is off: cancelled."); render(); } });
  $("goto-open").addEventListener("click", openGoto);
  $("help-open").addEventListener("click", () => helpBox.showModal());
  $("settings-open").addEventListener("click", () => $("settings").showModal());
  $("settings-close").addEventListener("click", () => $("settings").close());
  for (const b of document.querySelectorAll("[data-density-choice]")) b.addEventListener("click", () => applyLook({ ...look, density: b.dataset.densityChoice }, true));
  const swatches = [...document.querySelectorAll("[data-accent-choice]")];
  for (const b of swatches) {
    b.addEventListener("click", () => applyLook({ ...look, accent: b.dataset.accentChoice }, true));
    b.addEventListener("keydown", e => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = swatches[(swatches.indexOf(b) + step + swatches.length) % swatches.length];
      applyLook({ ...look, accent: next.dataset.accentChoice }, true);
      next.focus();
    });
  }
  applyLook(look, false);
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

  // "g then a letter" goes to a place; "g then d" switches between dark and light.
  const G_KEYS = { h: () => A.goAccount("home"), p: () => A.setMajor("dashboard"), a: () => A.setMajor("atlas"), t: () => A.goAccount("timeline"),
                   c: () => A.goAccount("calendar"), m: () => A.goAccount("members"), e: () => A.goAccount("teams"), i: () => A.goAccount("inbox"),
                   s: () => A.goAccount("search"), r: () => A.goAccount("portfolio"),
                   d: () => { const dark = root.getAttribute("data-theme") === "dark" || (!root.hasAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
                              setTheme(dark ? "light" : "dark"); toast(dark ? "Light theme" : "Dark theme"); } };
  let gAt = 0;
  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (typing || e.ctrlKey || e.metaKey || e.altKey || !S.signedIn || gotoBox.open || helpBox.open || $("settings").open) { gAt = 0; return; }
    const k = e.key.toLowerCase();
    if (gAt && Date.now() - gAt < 1500 && G_KEYS[k]) { e.preventDefault(); gAt = 0; closeCtx(false); G_KEYS[k](); return; }
    gAt = k === "g" && !e.shiftKey ? Date.now() : 0;
  });

  // ---- Right-click (or the menu key, or Shift F10) on a project or a task: open it, star it, or copy or
  // open its address on GitHub. The address is the plan repository's own web address as GitHub gave it.
  const ctxBox = $("ctx");
  let ctxBack = null;
  function ctxTarget(node) {
    if (!node || !node.closest || !S.signedIn) return null;
    const t = node.closest("#workspace [data-task]");
    if (t) {
      const raw = t.dataset.task;
      const [a, b] = raw.includes(":") ? raw.split(":") : [null, raw];
      const holder = t.closest("[data-project]");
      const project = a || (holder && holder.dataset.project) || S.current;
      return entryOf(project) ? { project, task: b, node: t } : null;
    }
    const p = node.closest("#tree [data-project], #workspace [data-home-project], #workspace [data-team]");
    if (!p) return null;
    const project = p.dataset.project || p.dataset.homeProject || p.dataset.team;
    return entryOf(project) ? { project, task: null, node: p } : null;
  }
  // Closing always empties the menu and puts back its plain name, even when it was already hidden, so
  // nothing read from a project stays on the page.
  function closeCtx(back) {
    const was = !ctxBox.hidden;
    ctxBox.hidden = true;
    ctxBox.replaceChildren();
    ctxBox.setAttribute("aria-label", "Actions");
    if (was && back && ctxBack && ctxBack.isConnected) ctxBack.focus();
    ctxBack = null;
  }
  function openCtx(target, x, y) {
    const e = entryOf(target.project);
    const key = SB.favKey(target.project, target.task);
    const fav = S.marks.favs.includes(key);
    const web = SB.githubLink(e, target.task);
    const name = target.task || e.w.label;
    const item = (label, run, extra) => V.el("button", Object.assign({ type: "button", role: "menuitem", tabindex: "-1", onclick: () => { closeCtx(false); run(); } }, extra || {}), label);
    const items = [item("Open " + name, () => target.task ? A.go(e.w.id, { kind: "tasks" }, { phase: "", select: target.task }) : A.go(e.w.id, e.w.plan ? { kind: "overview" } : { kind: "repo", repo: e.w.code[0].repo }))];
    if (e.w.id.charAt(0) !== "~") items.push(item(fav ? "Take out of favourites" : "Add to favourites", () => A.toggleFav(e.w.id, target.task || null)));
    if (web) {
      items.push(item("Copy GitHub link", async () => { const run = surfaceRun;
        let said;
        try { await navigator.clipboard.writeText(web); said = "Link copied"; } catch (err) { said = "Copy didn't work here, so nothing was copied."; }
        if (run === surfaceRun) toast(said); }));
      items.push(V.el("a", { role: "menuitem", tabindex: "-1", href: web, target: "_blank", rel: "noopener noreferrer", onclick: () => closeCtx(false) }, "Open on GitHub"));
    }
    ctxBox.replaceChildren(...items);
    ctxBox.setAttribute("aria-label", "Actions for " + name);
    ctxBox.hidden = false;
    ctxBack = target.node.matches("button, a, [tabindex]") ? target.node : target.node.querySelector("button, a, [tabindex]") || document.activeElement;
    const r = ctxBox.getBoundingClientRect();
    ctxBox.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + "px";
    ctxBox.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + "px";
    items[0].focus();
  }
  document.addEventListener("contextmenu", e => {
    const t = ctxTarget(e.target);
    if (!t) { closeCtx(false); return; }
    e.preventDefault();
    openCtx(t, e.clientX, e.clientY);
  });
  document.addEventListener("keydown", e => {
    if (!ctxBox.hidden) {
      const items = [...ctxBox.querySelectorAll("[role=menuitem]")];
      const i = items.indexOf(document.activeElement);
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step) { e.preventDefault(); items[(i + step + items.length) % items.length].focus(); }
      else if (e.key === "Home" || e.key === "End") { e.preventDefault(); items[e.key === "Home" ? 0 : items.length - 1].focus(); }
      else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); closeCtx(true); }
      return;
    }
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const t = ctxTarget(document.activeElement);
      if (!t) return;
      e.preventDefault();
      const r = document.activeElement.getBoundingClientRect();
      openCtx(t, r.left + 8, r.bottom + 2);
    }
  }, true);
  document.addEventListener("pointerdown", e => { if (!ctxBox.hidden && !ctxBox.contains(e.target)) closeCtx(false); });
  window.addEventListener("resize", () => closeCtx(false));

  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (gotoBox.open) gotoBox.close(); else openGoto();
    } else if (gotoBox.open || helpBox.open || $("settings").open) {
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
