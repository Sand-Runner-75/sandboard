"use strict";
// Members and teams: the people the task tables name as doer or reviewer, as written (SB.members). A
// member's page lists the tasks naming them across projects; a team is the members one project's table
// names. Nothing here is a GitHub account, a permission or a guess, and nothing can be assigned or changed.
// Names come from the tables, so they only go into text nodes.

(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, pill } = V;

  const TIPS = {
    "Members": "Everyone the task tables name as doer or reviewer, as written there, with their open and done tasks across projects. Not GitHub accounts.",
    "Teams": "Each project's team: the members its own task table names, with what each does there.",
  };
  Object.assign(V.TIPS, TIPS);
  const tip = (node, key) => { node.setAttribute("data-tip", V.TIPS[key] || key); return node; };
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

  // A member's initials in a round mark, and their name as a button to their page.
  const face = name => el("span", { class: "initial", "aria-hidden": "true" }, V.initials(name));
  const toMember = (A, name, cls) => el("button", { type: "button", class: "linkbtn " + (cls || ""), "data-member": name, onclick: () => A.goMember(name) }, face(name), name);
  const projectChip = (S, A, e) => el("button", { type: "button", class: "chip linkchip", "data-project": e.w.id,
    onclick: () => A.go(e.w.id, e.w.plan ? { kind: "overview" } : { kind: "repo", repo: e.w.code[0].repo }) }, e.w.label);

  // What could not be read, so a member or team may be missing someone.
  function unread(S) {
    const all = V.orderedEntries(S).filter(e => e.w.plan);
    const left = all.filter(e => !V.rowsVisible(e));
    if (!left.length) return null;
    const reading = left.filter(e => e.loading).length;
    return el("p", { class: "qual muted plain" }, (reading ? "Still reading " + plural(reading, "task table") + ". " : "") +
      (left.length - reading ? plural(left.length - reading, "project's task table", "projects' task tables") + " could not be read, so " + (left.length - reading === 1 ? "its" : "their") + " people are not counted." : ""));
  }
  const head = (title, line) => el("header", { class: "head" }, el("h1", { id: "view-h", tabindex: "-1" }, title), el("p", { class: "muted plain" }, line));

  function members(S, A) {
    const list = SB.members(V.orderedEntries(S));
    const box = el("section", { class: "stack", "aria-labelledby": "view-h", "data-part": "members" },
      head("Members", plural(list.length, "person", "people") + " named as doer or reviewer in the task tables that could be read"));
    if (!list.length) box.append(el("p", { class: "muted plain empty-note" }, "No task table names anyone yet."));
    else box.append(tip(el("div", { class: "card" }, el("div", { class: "table-wrap flat" }, el("table", { class: "grid-table" },
      el("caption", { class: "sr" }, "Members, most open tasks first"),
      el("thead", {}, el("tr", {}, ["Member", "Projects", "Open tasks", "Reviewing", "Done"].map(h => el("th", { scope: "col" }, h)))),
      el("tbody", {}, list.map(m => el("tr", { "data-member-row": m.name },
        el("th", { scope: "row" }, toMember(A, m.name, "pname")),
        el("td", {}, el("span", { class: "pchips" }, m.projects.map(e => projectChip(S, A, e)))),
        el("td", { class: "num" }, String(m.open)), el("td", { class: "num" }, String(m.reviewing)), el("td", { class: "num" }, String(m.done)))))))), "Members"));
    box.append(el("p", { class: "qual muted plain" }, "Open tasks and Done count the tasks a member does; Reviewing counts the open tasks they review. Removed rows are not counted."));
    const gap = unread(S); if (gap) box.append(gap);
    return box;
  }

  const ROLE = { doer: "Doer", reviewer: "Reviewer" };
  function member(S, A) {
    const name = S.view.name;
    const m = SB.members(V.orderedEntries(S)).find(x => x.name === name);
    const back = el("div", { class: "acts" }, el("button", { type: "button", class: "btn ghost", id: "back-members", onclick: () => A.goAccount("members") }, "All members"));
    if (!m) return el("section", { class: "stack", "aria-labelledby": "view-h", "data-part": "member" }, head(String(name || "Member"), "No task table that could be read names this person now."), back);
    const cells = [["Open tasks", m.open], ["Reviewing", m.reviewing], ["Done", m.done], ["Projects", m.projects.length]];
    const box = el("section", { class: "stack", "aria-labelledby": "view-h", "data-part": "member" },
      el("header", { class: "head member-head" }, el("span", { class: "initial big", "aria-hidden": "true" }, V.initials(m.name)),
        el("div", {}, el("h1", { id: "view-h", tabindex: "-1" }, m.name), el("p", { class: "muted plain" }, "Named in the task table" + (m.projects.length === 1 ? " of one project" : "s of " + m.projects.length + " projects")))),
      back,
      el("section", { class: "kcells card", "aria-label": "Counts for " + m.name, "data-part": "member-counts" }, cells.map(([label, v]) =>
        el("div", { class: "kcell" }, el("p", { class: "label" }, label), el("div", { class: "kv num" }, String(v))))));
    // Open work first, by status as work moves, then done; each row says the role and the project.
    const ORDER = ["Blocked", "Ready for Review", "In Progress", "Not Started", "Done"];
    const rank = s => { const i = ORDER.indexOf(s); return i < 0 ? ORDER.length : i; };
    const work = m.work.slice().sort((a, b) => rank(a.t.status) - rank(b.t.status));
    box.append(el("section", { class: "card", "aria-labelledby": "member-work-h", "data-part": "member-work" },
      el("h2", { id: "member-work-h", class: "label" }, "Tasks naming " + m.name),
      el("ul", { class: "feed task-list" }, work.map(({ t, e, role }) => el("li", { "data-task": t.id, "data-project": e.w.id }, pill(t.status),
        el("button", { type: "button", class: "linkbtn", onclick: () => A.go(e.w.id, { kind: "tasks" }, { phase: "", select: t.id }) }, t.id + " " + (t.title || "")),
        el("span", { class: "chip" }, e.w.label), el("span", { class: "qual muted" }, ROLE[role]))))));
    return box;
  }

  function teams(S, A) {
    const entries = V.orderedEntries(S).filter(e => e.w.plan && V.rowsVisible(e));
    const box = el("section", { class: "stack", "aria-labelledby": "view-h", "data-part": "teams" },
      head("Teams", "Each project's team is the people its own task table names"));
    if (!entries.length) box.append(el("p", { class: "muted plain empty-note" }, "No task table could be read yet."));
    const grid = el("div", { class: "team-grid" });
    V.orderedEntries(S).forEach((e, i) => {
      if (!entries.includes(e)) return;
      const crew = SB.team(e);
      grid.append(tip(el("section", { class: "card team", "aria-label": e.w.label + " team", "data-team": e.w.id },
        el("h2", { class: "team-h" }, V.tile(e.w.label, i), projectChip(S, A, e), el("span", { class: "count" }, String(crew.length))),
        crew.length ? el("ul", { class: "team-list" }, crew.map(m => el("li", {}, toMember(A, m.name),
          el("span", { class: "qual muted" }, [m.open ? m.open + " open" : null, m.reviewing ? "reviews " + m.reviewing : null, m.done ? m.done + " done" : null].filter(Boolean).join(" · ") || "no open work"))))
          : el("p", { class: "muted plain" }, "The table names no one.")), "Teams"));
    });
    if (entries.length) box.append(grid);
    const gap = unread(S); if (gap) box.append(gap);
    return box;
  }

  Object.assign(V, { members, member, teams });
})(typeof window !== "undefined" ? window : globalThis);
