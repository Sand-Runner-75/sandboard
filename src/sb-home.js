"use strict";
// Home: one page across every project. A greeting with the local date, four counts of task rows, a
// table of the projects with each one's own progress figure, the open work by status, and the recent
// activity of the projects' repositories grouped by local day. Every count here is a count of task rows
// as the tables say, and every percentage is the project's own progress output, shown as supplied.
// Text from GitHub only goes into text nodes.

(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, notice, STATE, pill, progressOf, planState } = V;

  const TIPS = {
    "Home": "Every project on one page: counts of task rows as the tables say, each project's own progress figure, the open work and recent activity. Nothing here adds up or changes a progress figure.",
    "Task counts": "Counts of task rows in the plans' tables that could be read. Removed rows are not counted. These are not progress: progress is each project's own figure.",
    "Open work": "Tasks in review, blocked or in progress, as the tables say, across every project.",
    "Activity by day": "The latest commits, pull requests and handoff comments in the projects' repositories, grouped by your local day. It is evidence of activity, not progress.",
  };
  Object.assign(V.TIPS, TIPS);
  const tip = (node, key) => { node.setAttribute("data-tip", V.TIPS[key] || key); return node; };
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  // Home reads the activity of at most this many repositories, the listed projects' own, in tree order.
  const HOME_REPOS = 12;
  const FEED_SHOWN = 20;

  // Up to two initials from a name: "Agent B" gives "AB".
  const initials = n => String(n).trim().split(" ").filter(Boolean).slice(0, 2).map(x => x[0]).join("").toUpperCase();
  // The entries in the tree's order.
  const ordered = S => { const by = new Map(S.entries.map(e => [e.w.id, e])); return SB.orderedIds([...by.keys()], S.order).map(id => by.get(id)); };

  // A project's tile: its first letter on one of six colours, chosen by its place in the tree.
  const TILES = ["t1", "t2", "t3", "t4", "t5", "t6"];
  const tile = (label, i) => el("span", { class: "ptile " + TILES[i % TILES.length], "aria-hidden": "true" }, (String(label).trim()[0] || "?").toUpperCase());

  // The repositories Home reads activity from: the listed projects' plan and code repositories, at most HOME_REPOS.
  function homeRepos(S) {
    const rows = SB.portfolio(ordered(S).filter(e => !e.w.found && !e.w.opened));
    return { rows: rows.slice(0, HOME_REPOS), left: Math.max(0, rows.length - HOME_REPOS) };
  }

  function greetingLine(S, figs) {
    const now = new Date();
    const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    const waiting = figs.review + figs.blocked;
    return el("header", { class: "head home-head" },
      el("h1", { id: "view-h", tabindex: "-1" }, SB.greeting(now.getHours())),
      el("p", { class: "muted plain" }, date + " · " + (waiting ? plural(waiting, "task") + " waiting on someone" : "nothing waiting on anyone") +
        " across " + plural(figs.read, "project") + " whose tables could be read"));
  }

  function countCells(figs) {
    const cell = (label, value, line, cls, part) => el("div", { class: "kcell", "data-part": part }, el("p", { class: "label" }, label),
      el("div", { class: "kv num" + (cls === "bad" && value ? " bad" : "") }, String(value)), el("div", { class: "qual " + (cls === "bad" && value ? "bad" : cls === "good" ? "good" : "muted") }, line));
    return tip(el("section", { class: "kcells card", "aria-label": "Task counts across projects", "data-part": "home-counts" },
      cell("Projects with a plan", figs.plans, figs.read === figs.plans ? "all tables read" : figs.read + " tables read", "", "plans"),
      cell("Open tasks", figs.open, figs.progress + " in progress", "", "open"),
      cell("Done tasks", figs.done, "of " + plural(figs.tasks, "task"), "good", "done"),
      cell("Blocked", figs.blocked, figs.blocked ? "need attention" : "nothing blocked", "bad", "blocked")), "Task counts");
  }

  // One row per project: its tile, kind or state, its own whole-project figure, its task rows, and what waits.
  function projectTable(S, A) {
    const head = ["Project", "Progress", "Tasks", "Waiting", "Who"];
    const rows = ordered(S).map((e, i) => {
      const w = e.w, p = progressOf(e), plan = planState(e);
      const go = el("button", { type: "button", class: "linkbtn pname", "data-home-project": w.id,
        onclick: () => A.go(w.id, w.plan ? { kind: "overview" } : { kind: "repo", repo: w.code[0].repo }) }, tile(w.label, i), w.label);
      const state = e.loading ? el("span", { class: "muted" }, "Reading")
        : !w.plan ? el("span", { class: "muted" }, w.opened ? "Opened by name" : "Code only")
        : plan !== "current" ? el("span", { class: "muted" }, (STATE[plan] || STATE.failed)[2])
        : el("span", {}, w.kind === "kit" ? "Kit" : "Live project", w.found ? el("span", { class: "muted" }, ", found") : null);
      let prog;
      if (p.state === "current") {
        const f = p.data.scopes["Whole project"];
        if (f.rows > 0) {
          const fill = el("span");
          fill.style.width = Math.max(0, Math.min(100, f.progress_pct)) + "%";
          prog = el("span", { class: "hbar" }, el("span", { class: "bar" + (f.verified ? "" : " unverified"), "aria-hidden": "true" }, fill),
            el("span", { class: "num" }, f.progress_pct + "%"), f.verified ? null : el("span", { class: "sr" }, " not verified"));
        } else prog = el("span", { class: "muted" }, "No active work");
      } else prog = el("span", { class: "muted" }, !w.plan ? "No plan" : p.state === "loading" ? "Reading" : "Not available");
      const read = SB.homeFigures([e]);
      const tasks = read.read ? el("span", { class: "num" }, read.done + " of " + read.tasks + " done") : el("span", { class: "muted" }, "—");
      const wait = read.read ? (read.review || read.blocked ? el("span", { class: "waits" },
        read.review ? el("span", { class: "pill st-review" }, read.review + " in review") : null,
        read.blocked ? el("span", { class: "pill st-blocked" }, read.blocked + " blocked") : null) : el("span", { class: "muted" }, "Nothing")) : el("span", { class: "muted" }, "—");
      const names = read.read ? [...new Set(e.tasks.filter(t => !t.invalid && t.status !== "Done" && t.status !== "Removed").map(t => t.reviewer).filter(r => r && r !== "—" && r !== "-"))] : [];
      const who = names.length ? el("span", { class: "who" }, names.slice(0, 4).map(n => el("span", { class: "initial", title: n, "aria-label": n }, initials(n))),
        names.length > 4 ? el("span", { class: "muted" }, "+" + (names.length - 4)) : null) : el("span", { class: "muted" }, "—");
      return el("tr", { "data-project": w.id }, el("th", { scope: "row" }, go, el("div", { class: "qual muted pstate" }, state)), el("td", {}, prog), el("td", { class: "nowrap" }, tasks), el("td", {}, wait), el("td", {}, who));
    });
    return el("section", { class: "card home-table", "aria-labelledby": "home-proj-h", "data-part": "home-projects" },
      el("h2", { id: "home-proj-h", class: "label" }, "Projects"),
      el("div", { class: "table-wrap flat" }, el("table", { class: "grid-table" },
        el("thead", {}, el("tr", {}, head.map(h => el("th", { scope: "col" }, h)))), el("tbody", {}, rows))),
      el("p", { class: "qual muted plain" }, "Progress is each project's own whole-project figure, as its progress output supplies it; a dashed bar is not verified. Who: the reviewers named on open tasks."));
  }

  const WORK = [["Ready for Review", "In review"], ["Blocked", "Blocked"], ["In Progress", "In progress"]];
  function openWorkCard(S, A) {
    const pick = WORK.some(([s]) => s === S.homeWork) ? S.homeWork : WORK[0][0];
    const lists = new Map(WORK.map(([s]) => [s, SB.openWork(ordered(S), s)]));
    const tabs = el("div", { class: "seg", role: "tablist", "aria-label": "Open work by status" }, WORK.map(([s, name]) =>
      el("button", { type: "button", role: "tab", id: "work-tab-" + s.replace(/ /g, "-"), "aria-selected": String(s === pick), "aria-pressed": String(s === pick),
        "aria-controls": "work-panel", tabindex: s === pick ? "0" : "-1", onclick: () => A.homeWork(s),
        onkeydown: ev => { const i = WORK.findIndex(x => x[0] === s), step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
          if (step) { ev.preventDefault(); A.homeWork(WORK[(i + step + WORK.length) % WORK.length][0], true); } } },
        name, el("span", { class: "count" }, String(lists.get(s).length)))));
    const list = lists.get(pick);
    const panel = el("div", { id: "work-panel", role: "tabpanel", "aria-labelledby": "work-tab-" + pick.replace(/ /g, "-") },
      list.length ? el("ul", { class: "feed task-list" }, list.slice(0, 30).map(({ t, e }) => el("li", { "data-task": t.id, "data-project": e.w.id }, pill(t.status),
        el("button", { type: "button", class: "linkbtn", onclick: () => A.go(e.w.id, { kind: "tasks" }, { phase: "", select: t.id }) }, t.id + " " + (t.title || "")),
        el("span", { class: "chip" }, e.w.label), t.phase ? el("span", { class: "qual muted" }, t.phase.id) : null)))
        : el("p", { class: "muted plain" }, "Nothing " + WORK.find(x => x[0] === pick)[1].toLowerCase() + " across the projects."),
      list.length > 30 ? el("p", { class: "qual muted plain" }, (list.length - 30) + " more; each project's Tasks lists them all.") : null);
    return tip(el("section", { class: "card", "aria-labelledby": "home-work-h", "data-part": "home-work" },
      el("div", { class: "row1 spread" }, el("h2", { id: "home-work-h", class: "label" }, "Open work"), tabs), panel), "Open work");
  }

  const GROUPS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "2 to 6 days ago"], ["earlier", "Earlier"]];
  const MARK = { commit: "C", opened: "PR", merged: "M", closed: "X", handoff: "H" };
  const EVENT = { commit: "Commit", opened: "Pull request opened", merged: "Merged", closed: "Closed without merging", handoff: "Handoff" };

  // What a repository's activity read left out, in words.
  const feedParts = (repo, data) => SB.feedGaps(data).map(g => repo + ": " + (g.limit ? "only the latest " + g.limit + " " + g.what + " were read"
    : g.what + " " + (STATE[g.state] || STATE.failed)[2].toLowerCase() + (g.error ? " (" + g.error + ")" : "")));

  function activityCard(S, A) {
    const card = el("section", { class: "card", "aria-labelledby": "home-act-h", "data-part": "home-activity" },
      tip(el("h2", { id: "home-act-h", class: "label" }, "Recent activity by day"), "Activity by day"));
    const { rows, left } = homeRepos(S);
    if (!rows.length) { card.append(el("p", { class: "muted plain" }, "No repository.")); return card; }
    const sources = [], parts = [];
    let loading = 0, failed = 0;
    for (const r of rows) {
      if (!r.meta) { if (!r.pinned || r.pinned.state === "loading") loading += 1; else failed += 1; continue; }
      const f = A.live(SB.feedKey(r.repo, r.pinned.data.commit));
      if (!f || f.state === "loading") { loading += 1; continue; }
      if (!f.data) { failed += 1; continue; }
      sources.push({ repo: r.repo, web: r.pinned.data.web, commits: f.data.commits, pulls: f.data.pulls, comments: f.data.comments });
      parts.push(...feedParts(r.repo, f.data));
    }
    const feed = SB.feedEvents(sources);
    const now = Date.now();
    if (loading && !feed.events.length) card.append(notice("loading", "Reading the projects' recent activity."));
    else if (!feed.events.length) card.append(el("p", { class: "muted plain" }, sources.length ? "No activity was read." : "Nothing could be read."));
    else {
      const shown = feed.events.slice(0, FEED_SHOWN);
      for (const [key, name] of GROUPS) {
        const evs = shown.filter(ev => SB.dayGroup(ev.at, now) === key);
        if (!evs.length) continue;
        card.append(el("h3", { class: "day-h" }, name, el("span", { class: "count" }, String(evs.length))),
          el("ol", { class: "timeline", "aria-label": name }, evs.map(ev => el("li", { "data-kind": ev.kind, "data-repo": ev.repo },
            el("span", { class: "tmark tm-" + ev.kind, "aria-hidden": "true" }, MARK[ev.kind]),
            el("div", { class: "tbody" },
              el("div", {}, el("b", {}, ev.kind === "commit" && ev.merge ? "Merge commit" : EVENT[ev.kind]), " ",
                ev.href ? el("a", { href: ev.href, target: "_blank", rel: "noopener noreferrer", class: "mono" }, ev.id) : el("span", { class: "mono" }, ev.id),
                " in ", el("span", { class: "mono" }, ev.repo.split("/")[1])),
              el("div", { class: "ev-title" }, ev.title),
              el("div", { class: "qual muted" }, SB.localWhen(ev.at)))))));
      }
      if (feed.events.length > FEED_SHOWN) card.append(el("p", { class: "qual muted plain" }, (feed.events.length - FEED_SHOWN) + " older events read and not shown."));
    }
    const notes = [];
    if (loading && feed.events.length) notes.push("Still reading " + plural(loading, "repository", "repositories") + ".");
    if (failed) notes.push(plural(failed, "repository", "repositories") + " could not be read; each project's overview says why.");
    for (const x of parts) notes.push(x + ".");
    if (feed.untimed) notes.push(plural(feed.untimed, "event") + " had no time GitHub gave in a readable form, so " + (feed.untimed === 1 ? "it is" : "they are") + " not placed on a day.");
    if (left) notes.push("Read from the first " + HOME_REPOS + " repositories of the listed projects, in tree order; " + plural(left, "more is", "more are") + " not read here.");
    for (const n of notes) card.append(el("p", { class: "qual muted plain" }, n));
    card.append(el("p", { class: "qual muted plain" }, "Times are your local time. Activity is not progress, and no event changes a figure."));
    return card;
  }

  function home(S, A) {
    const figs = SB.homeFigures(S.entries);
    return el("section", { class: "stack home", "aria-labelledby": "view-h", "data-part": "home" },
      greetingLine(S, figs), countCells(figs),
      el("div", { class: "home-grid" }, el("div", { class: "stack" }, projectTable(S, A), openWorkCard(S, A)), activityCard(S, A)));
  }

  Object.assign(V, { home, homeRepos, HOME_REPOS, feedParts });
})(typeof window !== "undefined" ? window : globalThis);
