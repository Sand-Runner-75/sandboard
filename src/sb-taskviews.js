"use strict";
// Task views: the same filtered rows as the task list, laid out as a board by status, a table of their
// columns, a timeline and a calendar. Nothing here changes a task: a status still only changes in the
// plan's table, and nothing can be dragged. A task's dates are only those of the project's activity read
// that names it (SB.taskActivity): never a due date, never a guess. Text from GitHub only goes into text nodes.

(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, notice, pill, STATUS_CLASS } = V;

  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const LAYOUTS = [["list", "List"], ["board", "Board"], ["table", "Table"], ["timeline", "Timeline"], ["calendar", "Calendar"]];
  const BOARD = ["Not Started", "In Progress", "Blocked", "Ready for Review", "Done", "Removed"];
  const TIMELINE_COLS = { weeks: 26, months: 18 };
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const SHORT = MONTHS.map(m => m.slice(0, 3));
  const EVENT = { commit: "Commit", opened: "Opened", merged: "Merged", closed: "Closed", handoff: "Handoff" };
  const dayName = d => +d.slice(8) + " " + SHORT[+d.slice(5, 7) - 1];

  // The switch between the list and the other layouts.
  function layoutSwitch(S, A) {
    return el("div", { class: "seg layouts", role: "group", "aria-label": "Show tasks as" }, LAYOUTS.map(([k, name]) =>
      el("button", { type: "button", id: "layout-" + k, "aria-pressed": String(S.taskLayout === k), onclick: () => A.taskLayout(k) }, name)));
  }

  const open = (S, A, t) => el("button", { type: "button", class: "linkbtn", "data-task": t.id, "aria-current": S.selected === t.id ? "true" : null,
    onclick: () => A.select(t.id) }, t.id + " " + (t.title || ""));

  // Columns by status, in the order work moves; an empty column says so.
  function board(S, A, rows) {
    const shown = BOARD.filter(s => s !== "Removed" || rows.some(t => t.status === s));
    const other = rows.filter(t => !BOARD.includes(t.status));
    const col = (name, list, cls) => el("section", { class: "bcol", "aria-label": name + ", " + plural(list.length, "task") },
      el("h3", { class: "bhead" }, el("span", { class: "smark " + cls, "aria-hidden": "true" }), name, el("span", { class: "count" }, String(list.length))),
      list.length ? el("ul", { class: "bcards" }, list.map(t => el("li", { class: "bcard" + (S.selected === t.id ? " current" : "") }, open(S, A, t),
        el("div", { class: "qual muted" }, [t.phase ? t.phase.id : t.section, t.doer, SB.estimateText(t.est)].filter(Boolean).join(" · ")))))
        : el("p", { class: "muted plain" }, "None"));
    return el("div", { class: "board", "data-part": "task-board" },
      shown.map(s => col(s, rows.filter(t => t.status === s), "st-" + STATUS_CLASS[s])),
      other.length ? col("Other status", other, "st-invalid") : null);
  }

  // The rows' main columns, in table order.
  function table(S, A, rows) {
    const head = ["Task", "Status", "Phase", "Doer", "Reviewer", "Est.", "Needs"];
    return el("div", { class: "table-wrap", "data-part": "task-table" }, el("table", { class: "grid-table" },
      el("caption", { class: "sr" }, "Tasks in table order"),
      el("thead", {}, el("tr", {}, head.map(h => el("th", { scope: "col" }, h)))),
      el("tbody", {}, rows.map(t => el("tr", { "data-id": t.id, class: S.selected === t.id ? "current" : null },
        el("th", { scope: "row" }, open(S, A, t)), el("td", {}, pill(t.status)),
        el("td", { class: "nowrap" }, t.phase ? t.phase.id : t.section || "—"), el("td", {}, t.doer || "—"), el("td", {}, t.reviewer || "—"),
        el("td", { class: "nowrap" }, SB.estimateText(t.est)), el("td", {}, t.prereqs && t.prereqs.length ? t.prereqs.join(", ") : "—"))))));
  }

  // The project's activity read so far, as Recent activity reads it, with what is still being read or failed.
  function activity(S, A, entry) {
    const rows = SB.portfolio([entry]);
    const sources = [], parts = [];
    let loading = 0, failed = 0;
    for (const r of rows) {
      if (!r.meta) { if (!r.pinned || r.pinned.state === "loading") loading += 1; else failed += 1; continue; }
      const f = A.live(SB.feedKey(r.repo, r.pinned.data.commit));
      if (!f || f.state === "loading") { loading += 1; continue; }
      if (!f.data) { failed += 1; continue; }
      sources.push({ repo: r.repo, web: r.pinned.data.web, commits: f.data.commits, pulls: f.data.pulls, comments: f.data.comments });
      parts.push(...V.feedParts(r.repo, f.data));
    }
    const feed = SB.feedEvents(sources);
    return { events: feed.events, untimed: feed.untimed, parts, loading, failed, read: sources.length };
  }

  function coverage(act, found, rows) {
    const out = [];
    const none = rows.length - found;
    out.push(plural(found, "task") + " named by the activity read" + (none ? "; " + plural(none, "task") + " named by none, so not shown" : "") + ".");
    if (act.loading) out.push("Still reading " + plural(act.loading, "repository", "repositories") + ".");
    if (act.failed) out.push(plural(act.failed, "repository", "repositories") + " could not be read; the overview says why.");
    for (const x of act.parts) out.push(x + ", so a task may be named by more than is shown.");
    if (act.untimed) out.push(plural(act.untimed, "event") + " had no time GitHub gave in a readable form, so " + (act.untimed === 1 ? "it is" : "they are") + " not placed on a day.");
    out.push("Activity read: the latest commits, pull requests and handoff comments of each repository, as Recent activity reads them. Days are your local days. These are not due dates and not progress.");
    return out.map(t => el("p", { class: "qual muted plain" }, t));
  }

  // A bar per task named by the activity read, from its first to its last day, grouped by phase.
  function timeline(S, A, entry, rows) {
    const box = el("div", { class: "stack tight", "data-part": "task-timeline" });
    const act = activity(S, A, entry);
    const dates = SB.taskActivity(rows, act.events);
    if (!dates.size) {
      box.append(act.loading ? notice("loading", "Reading the project's activity.") : el("p", { class: "muted plain" }, "No activity read names any of these tasks, so there is nothing to place on a timeline."), ...coverage(act, 0, rows));
      return box;
    }
    const zoom = S.tlZoom;
    const today = SB.localDay(Date.now());
    const days = [...dates.values()];
    // The scale covers the activity read; today is marked only when it falls inside it.
    const first = days.map(d => d.first).sort()[0], last = days.map(d => d.last).sort().pop();
    const sc = SB.timelineScale(first, last, zoom, TIMELINE_COLS[zoom]);
    box.append(el("div", { class: "acts" },
      el("div", { class: "seg", role: "group", "aria-label": "Timeline scale" }, [["weeks", "Weeks"], ["months", "Months"]].map(([k, name]) =>
        el("button", { type: "button", id: "tl-" + k, "aria-pressed": String(zoom === k), onclick: () => A.timelineZoom(k) }, name)))));
    // Set from script, never as markup: a bar covers its first to its last day, both whole.
    const pos = (node, from, to) => { node.style.left = (sc.at(from) * 100).toFixed(3) + "%";
      node.style.width = (Math.min(1 - sc.at(from), sc.at(to) - sc.at(from) + sc.dayShare) * 100).toFixed(3) + "%"; return node; };
    const scale = el("div", { class: "tl-scale", "aria-hidden": "true" }, sc.cols.map(c => {
      const n = el("span", {}, zoom === "months" ? SHORT[+c.slice(5, 7) - 1] + (c.slice(5, 7) === "01" || c === sc.cols[0] ? " " + c.slice(0, 4) : "") : dayName(c));
      n.style.left = (sc.at(c) * 100).toFixed(3) + "%"; return n; }));
    const lanes = el("div", { class: "tl-lanes" });
    const groups = [];
    for (const t of rows) {
      if (!dates.has(t.id)) continue;
      const key = t.phase ? t.phase.id + " " + t.phase.name : t.section || "No phase";
      let g = groups.find(x => x.key === key);
      if (!g) groups.push(g = { key, tasks: [] });
      g.tasks.push(t);
    }
    for (const g of groups) {
      lanes.append(el("h3", { class: "tl-group" }, g.key));
      for (const t of g.tasks) {
        const d = dates.get(t.id);
        const cut = d.last < sc.start;
        const from = d.first < sc.start ? sc.start : d.first;
        const label = t.id + " " + (t.title || "") + ", " + t.status + ", named from " + d.first + " to " + d.last + " (" + plural(d.events.length, "event") + ")";
        const bar = cut ? null : pos(el("button", { type: "button", class: "tl-bar st-" + (STATUS_CLASS[t.status] || "invalid") + (S.selected === t.id ? " current" : ""),
          "data-task": t.id, "aria-label": label, title: label, onclick: () => A.select(t.id) }, el("span", {}, t.id + " " + (t.title || ""))), from, d.last);
        lanes.append(el("div", { class: "tl-row" }, el("div", { class: "tl-name" }, t.id),
          el("div", { class: "tl-track" }, bar || el("span", { class: "muted qual" }, "Before the dates shown"))));
      }
    }
    const track = el("div", { class: "tl", "aria-label": "Timeline of tasks by the activity that names them" }, el("div", { class: "tl-row tl-head" }, el("div", { class: "tl-name" }), el("div", { class: "tl-track" }, scale)), lanes);
    if (today >= sc.start && today < sc.end) {
      const line = el("div", { class: "tl-today" }, el("span", {}, "Today"));
      line.style.left = (sc.at(today) * 100).toFixed(3) + "%";
      track.append(el("div", { class: "tl-over", "aria-hidden": "true" }, line));
    }
    box.append(el("div", { class: "table-wrap flat tl-wrap" }, track));
    if (sc.cut) box.append(el("p", { class: "qual muted plain" }, plural(sc.cut, zoom === "months" ? "older month is" : "older week is", zoom === "months" ? "older months are" : "older weeks are") + " not shown; bars that start there begin at the left edge."));
    box.append(...coverage(act, dates.size, rows));
    return box;
  }

  // A month of local days with the events that name a task; the month starts at the newest event's.
  function calendar(S, A, entry, rows) {
    const box = el("div", { class: "stack tight", "data-part": "task-calendar" });
    const act = activity(S, A, entry);
    const dates = SB.taskActivity(rows, act.events);
    const byDay = new Map();
    for (const t of rows) {
      const d = dates.get(t.id);
      if (!d) continue;
      for (const ev of d.events) { const day = SB.localDay(ev.at); if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push({ t, ev }); }
    }
    const newest = [...byDay.keys()].sort().pop();
    const month = S.calMonth || (newest || SB.localDay(Date.now())).slice(0, 7);
    const title = MONTHS[+month.slice(5) - 1] + " " + month.slice(0, 4);
    box.append(el("div", { class: "cal-bar" },
      el("button", { type: "button", class: "btn ghost", id: "cal-prev", "aria-label": "Previous month", onclick: () => A.calMonth(SB.shiftMonth(month, -1), "cal-prev") }, "‹"),
      el("h3", { id: "cal-h", class: "cal-title", "aria-live": "polite" }, title),
      el("button", { type: "button", class: "btn ghost", id: "cal-next", "aria-label": "Next month", onclick: () => A.calMonth(SB.shiftMonth(month, 1), "cal-next") }, "›"),
      newest && newest.slice(0, 7) !== month ? el("button", { type: "button", class: "btn ghost", id: "cal-latest", onclick: () => A.calMonth(newest.slice(0, 7), "cal-latest") }, "Latest activity") : null));
    const today = SB.localDay(Date.now());
    let inMonth = 0;
    const weeks = SB.monthWeeks(month);
    box.append(el("div", { class: "table-wrap flat" }, el("table", { class: "cal", "aria-labelledby": "cal-h" },
      el("thead", {}, el("tr", {}, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => el("th", { scope: "col" }, d)))),
      el("tbody", {}, weeks.map(w => el("tr", {}, w.map(day => {
        const items = day.slice(0, 7) === month ? byDay.get(day) || [] : [];
        inMonth += items.length;
        return el("td", { class: (day.slice(0, 7) !== month ? "out" : "") + (day === today ? " today" : ""), "aria-label": dayName(day) + (items.length ? ", " + plural(items.length, "event") : "") },
          el("div", { class: "cal-day" }, String(+day.slice(8))),
          items.length ? el("ul", { class: "cal-items" }, items.slice(0, 4).map(({ t, ev }) => el("li", {},
            el("button", { type: "button", class: "cal-chip st-" + (STATUS_CLASS[t.status] || "invalid"), "data-task": t.id,
              title: EVENT[ev.kind] + " " + ev.id + ": " + ev.title, onclick: () => A.select(t.id) }, EVENT[ev.kind] + " " + t.id))),
            items.length > 4 ? el("li", { class: "qual muted" }, "+" + (items.length - 4) + " more") : null) : null);
      })))))));
    if (!inMonth) box.append(el("p", { class: "muted plain" }, act.loading && !act.events.length ? "Reading the project's activity." : "No activity read names these tasks in " + title + "."));
    box.append(...coverage(act, dates.size, rows));
    return box;
  }

  // The layout picked, for the rows the filters give; the list stays where it was.
  function taskLayout(S, A, entry, rows) {
    if (S.taskLayout === "board") return board(S, A, rows);
    if (S.taskLayout === "table") return table(S, A, rows);
    if (S.taskLayout === "timeline") return timeline(S, A, entry, rows);
    if (S.taskLayout === "calendar") return calendar(S, A, entry, rows);
    return null;
  }

  Object.assign(V, { layoutSwitch, taskLayout, TASK_LAYOUTS: LAYOUTS.map(l => l[0]) });
})(typeof window !== "undefined" ? window : globalThis);
