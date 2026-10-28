"use strict";
// Search over what this visit has already read: task rows, repositories, pull requests listed so far,
// file paths of the trees read and the files opened. Nothing is read for a search: a source not read
// yet is named as not searched, never fetched. The words, the results and their excerpts live only in
// this page's memory and go with everything else on Forget access, leaving or a refused token.
// Every result says where it was read: its repository and commit, or for a pull request, that it is
// GitHub's list as read on this visit. Text from a repository only goes into text nodes, and
// characters that print nothing or turn the text's direction are shown by their code.
(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, notice, STATE } = V;

  Object.assign(V.TIPS, {
    "Search": "Searches only what Sandboard has already read on this visit. It never reads anything to search: open a view to add what it reads.",
    "Search inside tasks": "Also searches each task's other columns and the briefs, handovers and cross-references already read. A task file not opened yet is not searched and is not read for it.",
  });

  const tip = (node, key) => { node.setAttribute("data-tip", V.TIPS[key] || key); return node; };
  const short = sha => typeof sha === "string" ? sha.slice(0, 7) : "";
  const plural = (n, one, many) => n.toLocaleString("en") + " " + (n === 1 ? one : many || one + "s");
  const stateName = state => (STATE[state] || STATE.failed)[2].toLowerCase();
  const FILE_NAME = { brief: "brief", handover: "handover", crossref: "cross-references" };
  const GROUPS = [["tasks", "Tasks"], ["repos", "Repositories"], ["pulls", "Pull requests"], ["paths", "File paths"], ["files", "Opened files"]];

  // Plain text with hidden characters shown by their code, as the file viewer shows them.
  const shown = text => el("span", { class: "excerpt" }, SB.textPieces(text).map(p => p.hidden
    ? el("span", { class: "hid", title: "Hidden character " + p.hidden }, p.hidden) : p.text));
  const at = (repo, commit) => el("span", { class: "qual muted" }, repo + " @ ", el("span", { class: "mono", title: commit }, short(commit)));

  function search(S, A) {
    const s = S.search;
    const current = S.entries.find(e => e.w.id === S.current) || null;
    const scope = s.all || !current ? null : current.w.id;
    const sec = el("section", { class: "stack", "aria-labelledby": "view-h" },
      el("header", { class: "head" }, el("div", { class: "row1" }, el("h1", { id: "view-h" }, "Search"), el("span", { class: "stage-tag" }, "Account"))));
    sec.append(tip(el("div", { class: "notice info", role: "status", "data-state": "search" }, el("span", { class: "glyph", "aria-hidden": "true" }, "i"),
      el("div", {}, el("b", {}, "Only what this visit has already read"),
        el("div", {}, "Nothing is read to search, and nothing typed here is kept or sent. Results are GitHub evidence and plan rows as read, never progress or approval."))), "Search"));
    const q = el("input", { id: "sq", type: "search", value: s.q, placeholder: "Words to find", autocomplete: "off", spellcheck: "false",
      oninput: e => A.setSearch("q", e.target.value, "sq") });
    sec.append(el("div", { class: "filters", role: "search" }, el("label", {}, "Search what is read", q)),
      el("div", { class: "row1" },
        el("div", { class: "chips", role: "group", "aria-label": "Where to search" },
          current ? el("button", { type: "button", id: "ss-project", "aria-pressed": String(scope !== null), onclick: () => A.setSearch("all", false, "ss-project") }, current.w.label) : null,
          el("button", { type: "button", id: "ss-all", "aria-pressed": String(scope === null), onclick: () => A.setSearch("all", true, "ss-all") }, "Every project")),
        tip(el("button", { type: "button", class: "tool small", id: "s-inside", "aria-pressed": String(s.inside),
          onclick: () => A.setSearch("inside", !s.inside, "s-inside") }, "Search inside tasks: " + (s.inside ? "on" : "off")), "Search inside tasks")));
    const src = SB.searchSources(S.entries, S.live, S.docs, A.docKey);
    const found = SB.searchFind(src, s.q, scope, s.inside);
    if (found.words.length) {
      const total = GROUPS.reduce((n, [g]) => n + found.totals[g], 0);
      sec.append(el("p", { class: "qual muted plain", role: "status", "data-part": "search-count" },
        total ? plural(total, "result") + (scope ? " in " + current.w.label : " in every project") + "." : "Nothing read so far holds every word."));
      for (const [g, title] of GROUPS) if (found[g].length) sec.append(group(A, g, title, found, scope));
    } else sec.append(el("p", { class: "muted plain", "data-part": "search-empty" }, "Type words to find. Every word must appear."));
    sec.append(coverage(SB.searchCoverage(src, scope, s.inside), s.inside));
    return sec;
  }

  // The project a result opens in: the one searched, or the first that read it.
  const projectOf = (hit, scope) => (hit.it.projects.find(p => p.id === scope) || hit.it.projects[0]);

  function group(A, g, title, found, scope) {
    const list = found[g];
    const more = found.totals[g] - list.length;
    return el("section", { class: "card", "aria-labelledby": "sr-" + g + "-h", "data-part": "search-" + g },
      el("h2", { id: "sr-" + g + "-h", class: "label" }, title + " (" + found.totals[g] + ")"),
      el("ul", { class: "feed found-list" }, list.map(hit => item(A, hit, projectOf(hit, scope), scope))),
      more > 0 ? el("p", { class: "qual muted plain" }, "Showing the first " + list.length + "; " + plural(more, "more is", "more are") + " not shown. Type more words to narrow them.") : null);
  }

  function item(A, hit, project, scope) {
    const it = hit.it;
    const where = scope ? null : el("span", { class: "qual muted" }, "in " + project.label);
    const open = (label, act, attrs) => el("button", Object.assign({ type: "button", class: "linkbtn", onclick: act }, attrs || {}), label);
    if (it.kind === "task") {
      return el("li", { "data-result": "task", "data-task": it.id },
        open(el("span", {}, el("span", { class: "id" }, it.id), " ", it.title || "No title"), () => A.go(project.id, { kind: "tasks" }, { phase: "", select: it.id }),
          { "data-open": "task|" + project.id + "|" + it.id }),
        at(it.repo, it.commit), where,
        hit.where === "content" ? el("div", { class: "hit", "data-part": "excerpt" },
          el("span", { class: "kind" }, (FILE_NAME[hit.in] || hit.in) + (hit.excerpt ? ", line " + hit.excerpt.line : "")), " ", hit.excerpt ? shown(hit.excerpt.text) : null) : null);
    }
    if (it.kind === "repo") {
      return el("li", { "data-result": "repo" }, open(el("span", { class: "mono" }, it.repo), () => A.go(project.id, { kind: "repo", repo: it.repo }), { "data-open": "repo|" + project.id + "|" + it.repo }),
        at(it.repo, it.commit), where, it.description ? el("span", { class: "ev-title" }, shown(it.description)) : null);
    }
    if (it.kind === "pull") {
      return el("li", { "data-result": "pull" }, open(el("span", {}, el("span", { class: "mono" }, it.repo + " #" + it.number), " ", shown(it.title)),
          () => A.go(project.id, { kind: "repo", repo: it.repo, sub: "pulls" }), { "data-open": "pull|" + project.id + "|" + it.repo + "#" + it.number }),
        el("span", { class: "qual muted" }, (it.merged ? "merged" : it.state) + " · head ", el("span", { class: "mono", title: it.head }, short(it.head)),
          " · as GitHub listed it " + (it.readAt ? "at " + it.readAt.slice(0, 16).replace("T", " ") + " UTC" : "on this visit")), where);
    }
    const label = el("span", { class: "mono" }, it.path);
    return el("li", { "data-result": it.kind }, open(label, () => A.openFound(project.id, it.repo, it.path), { "data-open": it.kind + "|" + project.id + "|" + it.repo + "|" + it.path }),
      at(it.repo, it.commit), where,
      it.kind === "path" && it.entry !== "file" ? el("span", { class: "qual muted" }, it.entry === "symlink" ? "link, not followed" : "another repository, not opened") : null,
      hit.excerpt ? el("div", { class: "hit", "data-part": "excerpt" }, el("span", { class: "kind" }, "line " + hit.excerpt.line), " ", shown(hit.excerpt.text)) : null);
  }

  // What was searched, and what was not because it has not been read on this visit.
  function coverage(c, inside) {
    const notes = [];
    notes.push(plural(c.plansRead, "plan") + " read: " + (c.plansRead === 1 ? "its" : "their") + " task rows are searched by ID and title" + (inside ? ", and with Search inside tasks by their other columns too." : "."));
    for (const p of c.plansNot) notes.push(p.project.label + ": the plan " + (p.state === "loading" ? "is still being read" : "could not be read (" + stateName(p.state) + ")") + ", so its tasks are not searched.");
    if (inside) notes.push("Task files: " + plural(c.tasksFilesRead, "task") + " of " + c.tasks + " had a brief, handover or cross-references read; the others are searched by their table row only. Opening a task reads its files.");
    notes.push(plural(c.reposRead, "repository", "repositories") + " searched by name, description and topics.");
    for (const r of c.reposNot) notes.push(r.repo + (r.state === "loading" ? " is still being read" : " could not be read (" + stateName(r.state) + ")") + ", so nothing in it is searched.");
    notes.push(c.trees.length ? plural(c.trees.length, "file tree") + " read and searched by path" + (c.trees.some(t => t.partial) ? "; GitHub cut " + c.trees.filter(t => t.partial).map(t => t.repo).join(", ") + ", so some paths there are not searched." : ".")
      : "No file tree read yet: open a repository's Files to search its paths.");
    notes.push(c.files ? plural(c.files, "opened file") + " searched by its text." : "No file opened yet, so no file text is searched.");
    notes.push(c.pullLists.length ? "Pull requests: only those in the " + plural(c.pullLists.length, "list") + " read on this visit (activity feeds and Pull requests pages), by number, title and head." +
      (c.pullLists.some(l => l.partial) ? " Some of those lists stop before the end." : "") : "No pull request list read yet: open an overview or a repository's Pull requests.");
    return el("ul", { class: "coverage", "data-part": "search-coverage", "aria-label": "What was searched" }, notes.map(n => el("li", {}, n)));
  }

  Object.assign(V, { search });
})(typeof window !== "undefined" ? window : globalThis);
