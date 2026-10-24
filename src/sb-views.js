"use strict";
// The workspace views: tree, project overview, tasks with their details,
// task tabs and a repository's read state. Every value comes from a reader's
// result; text from a repository only ever goes into text nodes (or through
// SB.renderText). Views read the app state S and call actions in A; they
// keep no state of their own.

(function (root) {
  const SB = root.SB;
  const doc = root.document;

  // ---- Small builders

  function el(tag, attrs, ...kids) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(typeof kid === "object" ? kid : doc.createTextNode(String(kid)));
    }
    return node;
  }

  // Each state's title, glyph and colour family; never colour alone.
  const STATE = {
    "loading": ["info", "…", "Loading", "Reading from GitHub."],
    "empty": ["info", "○", "Nothing here yet", "Nothing to show at this commit."],
    "no-match": ["info", "∅", "No tasks match", "Change the search or filters. Progress is unchanged."],
    "missing": ["warn", "?", "Not found", "It is not there at this commit."],
    "denied": ["bad", "×", "No access", "Your token cannot read this. Nothing from it is shown."],
    "rate-limited": ["warn", "⏸", "GitHub asked us to wait", "Nothing is shown as current. Refresh later."],
    "invalid": ["bad", "!", "Can't be read", "It is not in the expected form, so nothing from it is shown."],
    "stale": ["warn", "↻", "Out of date", "It does not match the files at this commit, so no figure is shown."],
    "unavailable": ["warn", "–", "Not available", "This source does not supply it."],
    "partial": ["warn", "◐", "Partly loaded", "What is shown is real; the rest is missing."],
    "failed": ["bad", "×", "Couldn't load", "The request failed. Nothing is shown as current. Try Refresh."],
    "none": ["info", "○", "No plan", "This project has no plan repository, so there is no plan progress."],
  };

  function notice(state, detail, title) {
    const [kind, glyph, name, text] = STATE[state] || STATE.failed;
    return el("div", { class: "notice " + kind, role: kind === "info" ? "status" : "alert", "data-state": state },
      el("span", { class: "glyph", "aria-hidden": "true" }, glyph),
      el("div", {}, el("b", {}, title || name), el("div", {}, detail || text)));
  }

  const STATUS_CLASS = { "Done": "done", "Ready for Review": "review", "In Progress": "progress", "Blocked": "blocked",
                         "Not Started": "not", "Removed": "removed" };
  const pill = status => STATUS_CLASS[status] ? el("span", { class: "pill st-" + STATUS_CLASS[status] }, status)
    : el("span", { class: "pill st-invalid" }, status ? "Unknown status: " + status : "No status");
  const hours = h => String(h) + " h";
  const short = SB.short;
  const given = v => v === undefined ? el("span", { class: "muted" }, "Not given in the table")
    : v === "" ? el("span", { class: "muted" }, "Blank in the table") : v;
  const KIND = { project: "Live project", kit: "Reusable kit, not a live project", standalone: "Code only, no plan" };

  // ---- What one workspace's reads allow

  // entry: {w, plan, table, progress, code: [{c, pinned, checks}], tasks}
  function planState(entry) {
    if (!entry.w.plan) return "none";
    return entry.plan ? entry.plan.state : "loading";
  }

  function tableState(entry) {
    const p = planState(entry);
    if (p !== "current") return p;
    return entry.table ? entry.table.state : "loading";
  }

  // Task rows (and everything derived from them) show only while the table itself may be shown.
  const rowsVisible = entry => tableState(entry) === "current";

  function progressOf(entry) {
    const p = planState(entry);
    if (p !== "current") return { state: p };
    if (!entry.progress) return { state: "loading" };
    return entry.progress;
  }

  // ---- Source line

  function sourceLine(entry) {
    const w = entry.w;
    const plan = w.plan ? el("span", {}, "Plan ", el("b", { class: "mono" }, w.plan.repo),
      planState(entry) === "current"
        ? [" at ", el("span", { class: "mono" }, entry.plan.data.ref), " → ", el("span", { class: "mono", title: entry.plan.data.commit }, short(entry.plan.data.commit)),
           entry.plan.data.date ? ", committed " + entry.plan.data.date : ""]
        : " (not read)") : el("span", {}, "No plan repository");
    const code = el("span", {}, w.code.length ? ["Code ", w.code.map((c, i) => [i ? ", " : "", el("b", { class: "mono" }, c.repo), " (" + c.role + ")"])]
      : "No code repository assigned");
    return el("p", { class: "source" }, plan, code, el("span", {}, KIND[w.kind] || w.kind));
  }

  function header(id, title, entry, extra) {
    return el("header", { class: "head" }, el("div", { class: "row1" }, el("h1", { id }, title), extra || null), entry ? sourceLine(entry) : null);
  }

  // ---- Progress shapes: every figure exactly as the producer stored it

  // The ring is drawn with CSS: a conic gradient of the supplied percentage, or a dashed empty ring.
  function ring(pct) {
    const r = el("span", { class: "ring" + (pct === null ? " none" : ""), "aria-hidden": "true" }, el("span", { class: "hole" }));
    if (pct !== null) r.style.background = "conic-gradient(var(--accent) " + pct + "%, var(--sunken) 0)";
    return r;
  }

  function verifiedText(f) {
    return f.verified ? "Verified" : "Not verified: " + f.tbe_rows + (f.tbe_rows === 1 ? " row" : " rows") + " still to be estimated";
  }

  function scopeCards(label, f, gateName, id) {
    const active = f.rows > 0;
    return el("div", { class: "summary", id, "aria-label": label + " figures" },
      el("div", { class: "card ring-card" }, ring(active ? f.progress_pct : null),
        el("div", {}, el("p", { class: "label" }, label),
          el("div", { class: "big num" + (active ? "" : " muted") }, active ? f.progress_pct + "%" : "No active work"),
          el("div", { class: "qual" + (f.verified ? "" : " muted") }, active ? verifiedText(f) : "Nothing to count in this scope."),
          f.proposed_rows ? el("div", { class: "qual muted" }, f.proposed_rows + " proposed percentages not counted until approved") : null)),
      el("div", { class: "card" }, el("p", { class: "label" }, "Remaining"),
        el("div", { class: "big num" + (active ? "" : " muted") }, active ? hours(f.remaining_h) : "—"),
        el("div", { class: "qual muted" }, active ? "of " + hours(f.estimated_h) + " estimated" + (f.verified ? "" : ", not verified") : "No estimated work.")),
      el("div", { class: "card" }, el("p", { class: "label" }, "Forecast"), el("div", { class: "big muted" }, "Not supplied"),
        el("div", { class: "qual muted" }, "The progress output gives no finish date, so none is shown.")),
      el("div", { class: "card" }, el("p", { class: "label" }, "Next gate"),
        gateName ? el("div", {}, el("b", {}, gateName + " "), el("span", { class: "pill hollow st-not" }, "Approval not supplied"))
          : el("div", { class: "muted" }, gateName === null ? "No gate in this scope" : "Not supplied"),
        el("div", { class: "qual muted" }, "Gate approvals are not in this progress output, so no gate is shown as approved.")));
  }

  function unavailableCards(state) {
    return el("div", { class: "summary", "aria-label": "Whole project figures unavailable" },
      el("div", { class: "card ring-card" }, ring(null), el("div", {}, el("p", { class: "label" }, "Whole project"),
        el("div", { class: "big muted" }, state === "loading" ? "Loading" : "Unavailable"),
        el("div", { class: "qual muted" }, "No figure is shown rather than a guess."))),
      el("div", { class: "card" }, el("p", { class: "label" }, "Remaining"), el("div", { class: "big muted" }, "—")),
      el("div", { class: "card" }, el("p", { class: "label" }, "Forecast"), el("div", { class: "big muted" }, "—")),
      el("div", { class: "card" }, el("p", { class: "label" }, "Next gate"), el("div", { class: "big muted" }, "—")));
  }

  function progressNotice(p) {
    if (p.state === "none") return notice("none");
    if (p.state === "unavailable") return notice("unavailable", "No stored progress at this commit. Tasks can still be read.", "Progress not available");
    if (p.state === "stale") return notice("stale", (p.error ? p.error + ". " : "") + "No figure is shown until the progress is made again.", "Progress is out of date");
    if (p.state === "invalid") return notice("invalid", p.error || null, "Progress can't be read");
    return notice(p.state, p.error ? "Progress: " + p.error : null);
  }

  function wholeCards(entry) {
    const p = progressOf(entry);
    if (p.state !== "current") return el("div", { class: "stack tight" }, p.state === "loading" ? null : progressNotice(p), unavailableCards(p.state));
    const d = p.data;
    return el("div", { class: "stack tight" }, scopeCards("Whole project", d.scopes["Whole project"], undefined, "whole-cards"),
      el("p", { class: "qual muted plain" }, "From " + d.producer.path + " (" + p.schema + ") at " + short(p.source.commit) +
        ", matching the task table and record at that commit. Search, filters and tabs never change these figures."));
  }

  function scopeRow(entry) {
    const p = progressOf(entry);
    if (p.state !== "current") return null;
    return el("div", { class: "scopes", "aria-label": "Figures by scope" }, ["Pilot", "MVP", "Post-MVP"].map(name => {
      const f = p.data.scopes[name];
      const active = f.rows > 0;
      return el("div", { class: "card", "data-scope": name }, el("p", { class: "label" }, name),
        el("div", { class: "num" }, active ? el("b", {}, f.progress_pct + "%") : el("span", { class: "muted" }, "No active work"),
          active ? " · " + hours(f.remaining_h) + " of " + hours(f.estimated_h) + " remaining" : ""),
        active ? el("div", { class: "qual" + (f.verified ? "" : " muted") }, verifiedText(f)) : null);
    }));
  }

  function phaseCard(S, A, entry, ph) {
    const active = ph.rows > 0;
    const dots = el("span", { class: "dots", "aria-hidden": "true" });
    for (const s of SB.ORDER) {
      for (let i = 0; i < ph.status_counts[s]; i++) {
        dots.append(el("span", { class: "dot st-" + STATUS_CLASS[s] + (s === "Removed" ? " removed" : s === "Not Started" ? "" : " fill") }));
      }
    }
    const counts = SB.ORDER.filter(s => ph.status_counts[s]).map(s => ph.status_counts[s] + " " + s).join(", ") || "no rows";
    const bar = el("span", { class: "bar" + (active && !ph.verified ? " unverified" : "") });
    if (active) { const fill = el("span"); fill.style.width = ph.progress_pct + "%"; bar.append(fill); }
    const pressed = S.view.kind === "tasks" && S.filters.phase === ph.id;
    return el("button", { type: "button", class: "phase", "data-phase": ph.id, "aria-pressed": String(pressed),
        "aria-label": ph.id + " " + ph.name + ": " + (active ? ph.progress_pct + "% " + (ph.verified ? "verified" : "not verified") : "no active work") +
          ". " + counts + ". Show its tasks.",
        onclick: () => A.showPhase(entry.w.id, ph.id) },
      el("span", { class: "top2" }, el("b", {}, ph.id + " " + ph.name)),
      el("span", { class: "top2" }, el("span", { class: "num" + (active ? "" : " muted") }, active ? ph.progress_pct + "%" : "No active work"),
        el("span", { class: "qual muted" }, active ? (ph.verified ? "verified" : "not verified") : "")),
      bar, dots);
  }

  function progressBlock(S, A, entry, stageId) {
    const p = progressOf(entry);
    const sec = el("section", { class: "stack", "aria-labelledby": "prog-h" });
    const d = p.state === "current" ? p.data : null;
    const stages = d && Array.isArray(d.stages) ? d.stages : null;
    sec.append(el("h2", { id: "prog-h", class: "label" }, stages ? "Progress by stage" : "Progress by phase"));
    if (!d) { sec.append(el("p", { class: "muted plain" }, "No stage or phase figures: see the notice above.")); return sec; }
    const st = stages && stageId ? stages.find(x => x.id === stageId) || null : null;
    if (stages) {
      sec.append(el("div", { class: "chips", role: "group", "aria-label": "Stage" },
        el("button", { type: "button", "aria-pressed": String(!st), onclick: () => A.showStage(entry.w.id, null) }, "All stages"),
        stages.map((x, i) => el("button", { type: "button", "data-stage": x.id, "aria-pressed": String(!!st && st.id === x.id),
          onclick: () => A.showStage(entry.w.id, x.id) }, (i + 1) + " " + x.name,
          el("span", { class: "sr" }, x.rows ? ", " + x.progress_pct + "%" : ", no active work")))));
    } else {
      sec.append(el("p", { class: "qual muted plain" }, "Stage figures are not in this progress output, so phases are shown without stages."));
    }
    const strip = el("ol", { class: "strip", "aria-label": st ? "Phases in " + st.name : "Phases" });
    for (const ph of d.phases.filter(x => !st || st.phases.includes(x.id))) strip.append(el("li", {}, phaseCard(S, A, entry, ph)));
    sec.append(el("div", { class: "strip-wrap" }, strip));
    if (st) sec.append(scopeCards("Stage " + (stages.indexOf(st) + 1) + ": " + st.name, st, st.gate, "stage-cards"));
    else if (stages) sec.append(el("p", { class: "qual muted plain" }, "Pick a stage to see only its phases and its own figures."));
    return sec;
  }

  // ---- Tree

  function treeData(S, A) {
    const projects = { id: "g:projects", label: "Projects", kids: [] };
    for (const entry of S.entries) {
      const w = entry.w, kids = [];
      const at = (kind, extra) => S.current === w.id && !S.activeTab && S.view.kind === kind && (!extra || extra());
      if (w.plan) {
        kids.push({ id: "v:" + w.id + ":overview", label: "Overview", act: () => A.go(w.id, { kind: "overview" }), cur: at("overview", () => !S.view.stage) });
        kids.push({ id: "v:" + w.id + ":tasks", label: "Tasks", act: () => A.go(w.id, { kind: "tasks" }, { phase: "" }), cur: at("tasks", () => !S.filters.phase) });
        const p = progressOf(entry);
        if (p.state === "current" && Array.isArray(p.data.stages)) {
          kids.push({ id: "stages:" + w.id, label: "Stages", kids: p.data.stages.map((st, i) => ({
            id: "st:" + w.id + ":" + st.id, label: (i + 1) + " " + st.name, sub: st.rows ? st.progress_pct + "%" : "—",
            act: () => A.showStage(w.id, st.id),
            cur: at("overview", () => S.view.stage === st.id) || at("tasks", () => st.phases.includes(S.filters.phase)) })) });
        }
      }
      const repos = [w.plan && { repo: w.plan.repo, role: "plan" }, ...w.code].filter(Boolean);
      kids.push({ id: "repos:" + w.id, label: "Repositories", kids: repos.map(r => ({
        id: "r:" + w.id + ":" + r.repo, label: r.repo.split("/")[1], sub: r.role,
        act: () => A.go(w.id, { kind: "repo", repo: r.repo }), cur: at("repo", () => S.view.repo === r.repo) })) });
      const plan = planState(entry);
      const sub = entry.loading ? "loading" : plan !== "current" && plan !== "none" ? (STATE[plan] || STATE.failed)[2].toLowerCase()
        : w.kind === "kit" ? "kit" : w.kind === "standalone" ? "code only" : "";
      projects.kids.push({ id: "p:" + w.id, label: w.label, sub, kids,
        act: () => A.go(w.id, w.plan ? { kind: "overview" } : { kind: "repo", repo: w.code[0].repo }) });
    }
    return [projects];
  }

  function tree(S, A) {
    const root = doc.getElementById("tree");
    if (!S.signedIn) {
      root.replaceChildren(el("li", { role: "none", class: "empty" }, "Nothing loaded. Sign in, or show the synthetic demo."));
      return;
    }
    const flat = [];
    const build = (nodes, level, parent) => nodes.map(n => {
      const hasKids = !!(n.kids && n.kids.length);
      const open = hasKids && S.expanded.has(n.id);
      const li = el("li", { role: "treeitem", "aria-level": level, "aria-expanded": hasKids ? String(open) : null, "data-id": n.id,
        tabindex: "-1", "aria-current": n.cur ? "page" : null, "aria-label": n.label + (n.sub ? ", " + n.sub : "") });
      li.append(el("span", { class: "ti" + (n.cur ? " current" : ""), onclick: e => { e.stopPropagation(); activate(n); } },
        el("span", { class: "tw", "aria-hidden": "true" }, hasKids ? (open ? "▾" : "▸") : ""), el("span", {}, n.label),
        n.sub ? el("span", { class: "sub", "aria-hidden": "true" }, n.sub) : null));
      flat.push({ n, li, parent });
      if (open) li.append(el("ul", { role: "group" }, build(n.kids, level + 1, n)));
      return li;
    });
    const activate = n => {
      S.treeFocus = n.id;
      if (!n.act) { S.expanded.has(n.id) ? S.expanded.delete(n.id) : S.expanded.add(n.id); A.render(); focusTree(S); return; }
      if (n.kids && n.kids.length) S.expanded.add(n.id);
      A.closeMenu();
      n.act();
    };
    root.replaceChildren(...build(treeData(S, A), 1, null));
    const focusId = S.treeFocus && flat.some(f => f.n.id === S.treeFocus) ? S.treeFocus : (flat.find(f => f.n.cur) || flat[0]).n.id;
    for (const f of flat) if (f.n.id === focusId) f.li.tabIndex = 0;
    root.onkeydown = e => {
      const i = flat.findIndex(f => f.li === doc.activeElement);
      if (i < 0) return;
      const f = flat[i];
      const hasKids = !!(f.n.kids && f.n.kids.length);
      const move = j => {
        if (j < 0 || j >= flat.length) return;
        S.treeFocus = flat[j].n.id;
        for (const x of flat) x.li.tabIndex = -1;
        flat[j].li.tabIndex = 0;
        flat[j].li.focus();
      };
      const reopen = id => { S.treeFocus = id; A.render(); focusTree(S); };
      if (e.key === "ArrowDown") { e.preventDefault(); move(i + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(i - 1); }
      else if (e.key === "Home") { e.preventDefault(); move(0); }
      else if (e.key === "End") { e.preventDefault(); move(flat.length - 1); }
      else if (e.key === "ArrowRight" && hasKids) {
        e.preventDefault();
        if (!S.expanded.has(f.n.id)) { S.expanded.add(f.n.id); reopen(f.n.id); } else move(i + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (hasKids && S.expanded.has(f.n.id)) { S.expanded.delete(f.n.id); reopen(f.n.id); }
        else if (f.parent) reopen(f.parent.id);
      } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(f.n); }
    };
  }

  function focusTree(S) {
    for (const li of doc.querySelectorAll("#tree [role=treeitem]")) if (li.dataset.id === S.treeFocus) { li.focus(); return; }
  }

  // ---- Overview

  function overview(S, A, entry) {
    const w = entry.w;
    const p = progressOf(entry);
    const stages = p.state === "current" && Array.isArray(p.data.stages) ? p.data.stages : null;
    const st = stages && S.view.stage ? stages.find(x => x.id === S.view.stage) : null;
    const sec = el("section", { class: "stack", "aria-labelledby": "view-h" },
      header("view-h", st ? w.label + ": " + st.name : w.label, entry, el("span", { class: "stage-tag" }, "Overview")));
    const plan = planState(entry);
    if (plan !== "current" && plan !== "none" && plan !== "loading") {
      sec.append(notice(plan, plan === "denied" ? "Your token cannot read the plan repository " + w.plan.repo +
        ". No progress, commit or task from it is shown." : (entry.plan.error ? entry.plan.error : null)));
      sec.append(repoCard(entry));
      return sec;
    }
    sec.append(...[wholeCards(entry), scopeRow(entry), progressBlock(S, A, entry, S.view.stage)].filter(Boolean));
    sec.append(el("div", { class: "grid2" }, waitingCard(S, A, entry), repoCard(entry)));
    return sec;
  }

  function waitingCard(S, A, entry) {
    const card = el("section", { class: "card", "aria-labelledby": "wait-h" }, el("h2", { id: "wait-h", class: "label" }, "Waiting on someone"));
    const ts = tableState(entry);
    if (ts !== "current") { card.append(ts === "none" ? el("p", { class: "muted plain" }, "No plan, so no tasks.") : notice(ts, entry.table && entry.table.error)); return card; }
    const list = SB.waiting(entry.tasks);
    card.append(list.length ? el("ul", { class: "feed" }, list.map(t => el("li", {}, pill(t.status),
      el("button", { type: "button", class: "linkbtn", onclick: () => A.go(entry.w.id, { kind: "tasks" }, { phase: "", select: t.id }) }, t.id + " " + (t.title || "")),
      el("span", { class: "qual muted" }, t.status === "Blocked" ? (t.prereqs && t.prereqs.length ? "needs " + t.prereqs.join(", ") : "blocked")
        : t.reviewer ? "Reviewer " + t.reviewer : "")))) : el("p", { class: "muted plain" }, "Nothing is in review or blocked."));
    return card;
  }

  function checksSummary(res) {
    if (!res) return el("span", { class: "muted" }, "Not read");
    if (!["current", "partial", "empty"].includes(res.state)) {
      return el("span", {}, (STATE[res.state] || STATE.failed)[2], res.error ? el("span", { class: "muted" }, " (" + res.error + ")") : null);
    }
    const runs = res.data.runs;
    const failing = runs.filter(r => r.conclusion && !["success", "neutral", "skipped"].includes(r.conclusion)).length;
    const running = runs.filter(r => r.status !== "completed").length;
    return el("span", {}, res.state === "empty" ? "No check runs" : runs.length + " check runs: " + (runs.length - failing - running) + " passing, " +
      failing + " not passing, " + running + " running", res.coverage ? " (" + res.coverage.shown + " of " + res.coverage.total + " read)" : "");
  }

  function repoCard(entry) {
    const card = el("section", { class: "card", "aria-labelledby": "repos-h" }, el("h2", { id: "repos-h", class: "label" }, "Code repositories"));
    if (!entry.w.code.length) { card.append(el("p", { class: "muted plain" }, "No code repository assigned. Nothing is guessed from names.")); return card; }
    card.append(el("ul", { class: "feed" }, entry.code.map(c => el("li", {}, el("b", { class: "mono" }, c.c.repo), "(" + c.c.role + ")",
      !c.pinned ? el("span", { class: "muted" }, "Loading") : c.pinned.state === "current"
        ? [el("span", { class: "mono", title: c.pinned.data.commit }, c.pinned.data.ref + " → " + short(c.pinned.data.commit)), checksSummary(c.checks)]
        : el("span", {}, (STATE[c.pinned.state] || STATE.failed)[2])))));
    card.append(el("p", { class: "qual muted plain" }, "Commits, pull requests and files come in a later slice. Activity is never progress."));
    return card;
  }

  // ---- Tasks

  function tasks(S, A, entry) {
    const w = entry.w;
    const sec = el("section", { class: "stack", "aria-labelledby": "view-h" },
      header("view-h", w.label + ": tasks", entry, el("span", { class: "stage-tag" }, "Tasks")));
    const plan = planState(entry);
    if (plan !== "current" && plan !== "loading") {
      sec.append(plan === "none" ? notice("none") : notice(plan, plan === "denied" ? "Your token cannot read the plan repository " + w.plan.repo +
        ". No task from it is shown." : entry.plan.error));
      return sec;
    }
    const stage = S.filters.phase ? SB.stageOfPhase(progressOf(entry).data, S.filters.phase) : null;
    sec.append(wholeCards(entry), progressBlock(S, A, entry, stage ? stage.id : null));
    const left = el("div", { class: "stack tight" }, el("h2", { id: "tasks-h", class: "label", tabindex: "-1" }, "Tasks"), filterBar(S, A, entry), taskList(S, A, entry));
    const area = el("div", { class: "work" }, left);
    const task = rowsVisible(entry) && S.selected ? entry.tasks.find(t => t.id === S.selected && !t.invalid) : null;
    if (task) area.append(inspector(S, A, entry, task, null));
    sec.append(area);
    return sec;
  }

  function filterBar(S, A, entry) {
    const opts = rowsVisible(entry) ? SB.filterOptions(entry.tasks) : { phases: [], statuses: [], doers: [] };
    const select = (id, key, values, all) => {
      const s = el("select", { id, onchange: e => A.setFilter(key, e.target.value, id) },
        el("option", { value: "" }, all), values.map(v => el("option", { value: v.value }, v.label)));
      s.value = S.filters[key];
      return s;
    };
    const q = el("input", { id: "q", type: "search", placeholder: "ID or title", autocomplete: "off", spellcheck: "false",
      oninput: e => A.setFilter("q", e.target.value, "q") });
    q.value = S.filters.q;
    return el("div", { class: "filters", role: "search" },
      el("label", {}, "Search tasks", q),
      el("label", {}, "Phase", select("f-phase", "phase", opts.phases.map(p => ({ value: p.id, label: p.id + " " + p.name })), "All phases")),
      el("label", {}, "Status", select("f-status", "status", opts.statuses.map(s => ({ value: s, label: s })), "All statuses")),
      el("label", {}, "Doer", select("f-doer", "doer", opts.doers.map(d => ({ value: d, label: d })), "Anyone")));
  }

  function taskList(S, A, entry) {
    const out = el("div", { id: "task-area", class: "stack tight" });
    let state = tableState(entry);
    if (state === "loading") { out.append(notice("loading")); return out; }
    if (state !== "current") {
      out.append(state === "empty" ? notice("empty", "The task table at this commit has no task rows.", "No tasks yet")
        : notice(state, entry.table && entry.table.error));
      return out;
    }
    const rows = SB.filterTasks(entry.tasks, S.filters);
    const invalid = entry.tasks.filter(t => t.invalid).length;
    if (invalid) out.append(notice("partial", invalid + (invalid === 1 ? " row is" : " rows are") + " not in the expected form; each is marked \"Invalid row\" with its source text.", "Some rows can't be read"));
    if (!rows.length) { out.append(notice("no-match")); return out; }
    const approved = SB.approvals(entry.progress && entry.progress.state === "current" ? entry.progress.data : null);
    const ul = el("ul", { class: "list", role: "listbox", "aria-label": "Tasks", id: "task-list" });
    const focusId = S.selected && rows.some(t => t.id === S.selected && !t.invalid) ? S.selected : null;
    rows.forEach((t, i) => {
      const focusable = focusId ? t.id === focusId && !t.invalid : i === 0;
      if (t.invalid) {
        ul.append(el("li", { class: "row", role: "option", "aria-selected": "false", "data-line": t.line, tabindex: focusable ? "0" : "-1", onkeydown: e => listKeys(e, S, A, entry) },
          el("span", { class: "id" }, t.id || "—"), el("span", { class: "pill st-invalid" }, "Invalid row"), el("span", { class: "muted qual" }, "line " + t.line + ": " + t.invalid),
          el("span", { class: "raw mono" }, t.text)));
        return;
      }
      const meta = [t.phase ? t.phase.id : t.section, t.job, t.group, t.doer ? "Doer " + t.doer : null, SB.estimateText(t.est),
                    t.parent ? "step of " + t.parent : null].filter(x => x).join(" · ");
      ul.append(el("li", { class: "row", role: "option", "aria-selected": String(S.selected === t.id), "data-id": t.id,
          tabindex: focusable ? "0" : "-1", onclick: () => A.select(t.id), onkeydown: e => listKeys(e, S, A, entry) },
        el("span", { class: "id" }, t.id), el("span", {}, t.title || el("span", { class: "muted" }, "No title")), pill(t.status),
        el("span", { class: "meta" }, meta), resultLinks(entry, t, approved, true)));
    });
    out.append(ul);
    return out;
  }

  function listKeys(e, S, A, entry) {
    const all = [...doc.querySelectorAll("#task-list .row")];
    const i = all.indexOf(e.currentTarget);
    const to = n => { for (const x of all) x.tabIndex = -1; n.tabIndex = 0; n.focus(); };
    const id = e.currentTarget.dataset.id;
    const task = id ? entry.tasks.find(t => t.id === id && !t.invalid) : null;
    if (e.key === "ArrowDown") { e.preventDefault(); to(all[Math.min(i + 1, all.length - 1)]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); to(all[Math.max(i - 1, 0)]); }
    else if (e.key === "Home") { e.preventDefault(); to(all[0]); }
    else if (e.key === "End") { e.preventDefault(); to(all[all.length - 1]); }
    else if ((e.key === "Enter" || e.key === " ") && task) { e.preventDefault(); A.select(task.id); }
    else if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey && task) { e.preventDefault(); A.openTab(entry.w.id, task.id); }
  }

  // Result files (owner approval recorded by the producer): links at the plan
  // commit that was read. In a list row they are pointer shortcuts with no Tab
  // stop; the details panel has the same links for the keyboard.
  function resultLinks(entry, task, approved, inRow) {
    const fact = approved ? approved.get(task.id) : null;
    if (inRow) {
      if (!fact || !(fact.files.length + fact.rejected.length)) return null;
      return el("span", { class: "meta results" }, "Results: ", fact.files.map((f, i) => [i ? ", " : "", fileLink(entry, f, true)]),
        fact.rejected.map(r => [", ", el("span", { class: "pill st-invalid", title: r }, "Invalid link")]));
    }
    const box = el("div", { class: "results" }, el("p", { class: "label" }, "Result files"));
    if (!approved) box.append(el("p", { class: "muted plain" }, "This plan's progress output does not list approved result files, so none are linked."));
    else if (!fact) box.append(el("p", { class: "muted plain" }, "Links appear here once the owner approves the result files."));
    else {
      box.firstChild.textContent = "Result files · approved in " + fact.approval;
      if (!fact.files.length && !fact.rejected.length) box.append(el("p", { class: "muted plain" }, "None listed."));
      else box.append(el("ul", {}, fact.files.map(f => el("li", {}, fileLink(entry, f, false))),
        fact.rejected.map(r => el("li", {}, el("span", { class: "pill st-invalid" }, "Invalid link"), " ", el("span", { class: "mono" }, r)))));
      box.append(el("p", { class: "qual muted plain" }, entry.plan.data.web ? "Each opens the file at " + entry.w.plan.repo + " @ " + short(entry.plan.data.commit) + " in a new tab."
        : "GitHub gave no web address for this repository, so the files are listed without links."));
    }
    return box;
  }

  function fileLink(entry, path, inRow) {
    const href = SB.resultHref(entry.plan.data.web, entry.plan.data.commit, path);
    const label = inRow ? path.split("/").pop() : path;
    if (!href) return el("span", { class: "mono", title: path }, label);
    return el("a", { href, target: "_blank", rel: "noopener noreferrer", class: "mono", tabindex: inRow ? "-1" : null,
      title: path + " at " + short(entry.plan.data.commit), onclick: e => e.stopPropagation() }, label);
  }

  // ---- Task details (side panel or tab)

  function inspector(S, A, entry, task, tab) {
    const approved = SB.approvals(entry.progress && entry.progress.state === "current" ? entry.progress.data : null);
    const fact = approved ? approved.get(task.id) : null;
    const box = el("aside", { class: "inspector" + (tab ? " in-tab" : ""), "aria-label": "Task details", id: tab ? "tab-details" : "inspector" });
    box.append(el("header", {}, el("div", {}, el("div", { class: "id" }, task.id), el("h3", {}, task.title || "No title")),
      tab ? null : el("button", { type: "button", class: "btn ghost", "aria-label": "Close details", onclick: () => A.closeDetails() }, "Close")));
    const model = task.model === undefined ? given(undefined) : task.model ? task.model + (task.effort ? ", " + task.effort : "") : el("span", { class: "muted" }, "Not given in the table");
    box.append(el("dl", { class: "props" },
      el("dt", {}, "Status"), el("dd", {}, pill(task.status)),
      el("dt", {}, "Phase"), el("dd", {}, task.phase ? task.phase.id + " " + task.phase.name : task.section || el("span", { class: "muted" }, "Not under a phase")),
      el("dt", {}, "Job / task"), el("dd", {}, [task.job, task.group].filter(x => x).join(" · ") || el("span", { class: "muted" }, "Not given in the table")),
      task.parent ? [el("dt", {}, "Step of"), el("dd", { class: "id" }, task.parent)] : null,
      el("dt", {}, "Doer"), el("dd", {}, given(task.doer)), el("dt", {}, "Reviewer"), el("dd", {}, given(task.reviewer)),
      el("dt", {}, "Mode"), el("dd", {}, given(task.mode)), el("dt", {}, "Model"), el("dd", {}, model),
      el("dt", {}, "Estimate"), el("dd", {}, SB.estimateText(task.est)),
      el("dt", {}, "Pilot / MVP"), el("dd", {}, task.pilot === undefined && task.mvp === undefined ? given(undefined) : (task.pilot || "—") + " / " + (task.mvp || "—")),
      el("dt", {}, "Check"), el("dd", {}, given(task.check)),
      el("dt", {}, "Expected result"), el("dd", {}, given(task.expected))));
    box.append(el("div", { class: "facts" }, el("p", { class: "label" }, "Evidence, shown separately"),
      el("ul", {},
        el("li", {}, "Source status: " + (task.status || "none") + (task.pct !== undefined && task.pct !== "" ? ", " + task.pct + " in the table" : "")),
        el("li", {}, fact ? "Owner approval: recorded (" + fact.approval + ")"
          : !approved ? "Owner approval: not supplied by this plan's progress output"
          : task.status === "Done" ? "Owner approval: not recorded. Done in the table is not owner approval." : "Owner approval: not recorded"),
        el("li", {}, "Earned credit: counted only by the progress output, never here"))));
    if (task.status !== "Removed") box.append(resultLinks(entry, task, approved, false));
    const needs = SB.prerequisites(task, entry.tasks);
    box.append(el("div", {}, el("p", { class: "label" }, "Needs"), task.prereqs === undefined ? el("p", { class: "muted plain" }, "No prerequisites column in the table")
      : needs.length ? el("ul", { class: "needs" }, needs.map(n => el("li", {}, el("span", { class: "id" }, n.id), " ",
          n.task ? pill(n.task.status) : el("span", { class: "pill st-invalid" }, "Not in this table"))))
      : el("p", { class: "muted plain" }, "None")));
    if (task.notes !== undefined && task.notes !== "") {
      const notes = el("p", { class: "doc" });
      notes.append(SB.renderText(doc, task.notes).node);
      box.append(el("details", {}, el("summary", { class: "label" }, "Notes from the table"), notes));
    }
    for (const kind of ["brief", "handover"]) box.append(taskFile(S, A, entry, task, kind, tab));
    if (!tab) box.append(el("div", { class: "actions" }, el("button", { type: "button", class: "btn ghost", onclick: () => A.openTab(entry.w.id, task.id) }, "Open as tab")));
    return box;
  }

  function taskFile(S, A, entry, task, kind, tab) {
    const name = kind === "brief" ? "Brief" : "Handover";
    const files = entry.w.plan.files;
    const wrap = el("div", { class: "stack tight", "data-file": kind });
    if (!files[kind]) {
      wrap.append(el("p", { class: "label" }, name), el("p", { class: "muted plain" }, "This workspace names no " + kind + " file."));
      return wrap;
    }
    const commit = entry.plan.data.commit;
    const res = S.docs.get(A.docKey(entry.w.id, commit, kind, task.id));
    wrap.append(el("p", { class: "label" }, name + " · " + entry.w.plan.repo + " @ " + short(commit)));
    if (!res || res.state === "loading") { wrap.append(el("p", { class: "muted plain" }, "Loading")); return wrap; }
    if (res.state !== "current") {
      wrap.append(res.state === "missing" ? el("p", { class: "muted plain" }, "No " + kind + " for " + task.id + " at this commit.")
        : notice(res.state, res.error));
      return wrap;
    }
    const id = (tab ? "tab-" : "") + kind + "-text";
    const text = el("pre", { class: "doc", id, tabindex: "0", "aria-label": name + " text" });
    const shown = SB.renderText(doc, res.data.text);
    text.append(shown.node);
    const status = el("p", { class: "status-line", role: "status" });
    wrap.append(text, el("div", { class: "actions" }, el("button", { type: "button", class: "btn", "data-copy": kind,
      onclick: () => A.copy(text, status) }, "Copy " + kind)), status);
    return wrap;
  }

  // ---- Tabs

  function tabBar(S, A) {
    const bar = el("div", { class: "tabs", role: "tablist", "aria-label": "Open items" });
    const names = { overview: "Overview", tasks: "Tasks", repo: "Repository" };
    bar.append(el("div", { class: "tab" + (S.activeTab ? "" : " on") }, el("button", { type: "button", role: "tab", id: "tab-view",
      "aria-selected": String(!S.activeTab), tabindex: S.activeTab ? "-1" : "0", onclick: () => A.showTab(null),
      onkeydown: e => tabKeys(e, A) }, el("span", { class: "kind" }, "View"), names[S.view.kind] || "View")));
    for (const t of A.visibleTabs()) {
      bar.append(el("div", { class: "tab" + (S.activeTab === t.key ? " on" : "") },
        el("button", { type: "button", role: "tab", "data-key": t.key, "aria-selected": String(S.activeTab === t.key),
          tabindex: S.activeTab === t.key ? "0" : "-1", title: t.repo + " @ " + short(t.commit), onclick: () => A.showTab(t.key),
          onkeydown: e => tabKeys(e, A) }, el("span", { class: "kind" }, "Task"), el("span", { class: "id" }, t.id)),
        el("button", { type: "button", class: "x", "aria-label": "Close task " + t.id, onclick: () => A.closeTab(t.key) }, "×")));
    }
    return bar;
  }

  function tabKeys(e, A) {
    const all = [...doc.querySelectorAll(".tabs [role=tab]")];
    const i = all.indexOf(e.currentTarget);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
      A.showTab(next.dataset.key || null);
    } else if (e.key === "Delete" && e.currentTarget.dataset.key) { e.preventDefault(); A.closeTab(e.currentTarget.dataset.key); }
  }

  // A tab keeps the task as it was read, at its own commit.
  function taskTab(S, A, tab, entry) {
    const sec = el("section", { class: "stack tight", "aria-labelledby": "view-h", id: "tab-panel" },
      el("h1", { id: "view-h" }, "Task " + tab.id),
      el("p", { class: "source" }, "Read from ", el("b", { class: "mono" }, tab.repo), " @ ", el("span", { class: "mono", title: tab.commit }, short(tab.commit)),
        " in ", entry.w.label));
    const snapshot = Object.assign({}, entry, { plan: tab.plan, progress: tab.progress, tasks: tab.tasks });
    sec.append(inspector(S, A, snapshot, tab.task, tab));
    return sec;
  }

  // ---- One repository's read state

  function repo(S, A, entry, name) {
    const sec = el("section", { class: "stack", "aria-labelledby": "view-h" },
      header("view-h", name, entry, el("span", { class: "stage-tag" }, "Repository")));
    const isPlan = entry.w.plan && entry.w.plan.repo === name;
    const code = entry.code.find(c => c.c.repo === name);
    const pinned = isPlan ? entry.plan : code ? code.pinned : null;
    const role = isPlan ? "plan" : code ? code.c.role : null;
    if (!role) { sec.append(notice("missing", "This repository is not in this project's workspace.")); return sec; }
    if (!pinned) { sec.append(notice("loading")); return sec; }
    if (pinned.state !== "current") { sec.append(notice(pinned.state, pinned.error)); return sec; }
    const d = pinned.data;
    sec.append(el("div", { class: "grid3" },
      el("div", { class: "card" }, el("p", { class: "label" }, "Role in this project"), el("div", {}, role)),
      el("div", { class: "card" }, el("p", { class: "label" }, "Read at"), el("div", { class: "mono" }, d.ref + " → " + short(d.commit)),
        el("div", { class: "qual muted" }, d.date ? "Committed " + d.date : "No commit date")),
      el("div", { class: "card" }, el("p", { class: "label" }, "Visibility"), el("div", {}, d.private ? "Private" : "Public"))));
    if (code) sec.append(el("div", { class: "card" }, el("p", { class: "label" }, "Check runs at this commit"), checksSummary(code.checks),
      code.checks && code.checks.data && code.checks.data.runs.length ? el("ul", { class: "feed" }, code.checks.data.runs.map(r =>
        el("li", {}, el("b", {}, r.name), r.status === "completed" ? (r.conclusion || "no conclusion") : r.status))) : null,
      el("p", { class: "qual muted plain" }, "Checks passing is not owner approval.")));
    sec.append(el("p", { class: "qual muted plain" }, "History, pull requests, Actions, releases and files come in a later slice."));
    return sec;
  }

  // ---- The whole main area

  function main(S, A) {
    const box = doc.getElementById("workspace");
    if (!S.signedIn) { box.replaceChildren(); return; }
    if (S.list.state !== "current") {
      box.replaceChildren(S.list.state === "loading" ? notice("loading", "Reading the workspace list from " + S.planRepo + ".")
        : S.list.state === "empty" ? notice("empty", "The workspace list names no projects.", "No projects yet")
        : notice(S.list.state, "Workspace list (" + SB.WORKSPACES_FILE + ") in " + S.planRepo + ": " + (S.list.error || (STATE[S.list.state] || STATE.failed)[3])));
      return;
    }
    const entry = S.entries.find(e => e.w.id === S.current);
    if (!entry) { box.replaceChildren(notice("missing", "Pick a project in the tree.")); return; }
    const parts = [tabBar(S, A)];
    const tab = S.activeTab && A.visibleTabs().find(t => t.key === S.activeTab);
    if (tab) parts.push(taskTab(S, A, tab, entry));
    else if (S.view.kind === "tasks") parts.push(tasks(S, A, entry));
    else if (S.view.kind === "repo") parts.push(repo(S, A, entry, S.view.repo));
    else parts.push(overview(S, A, entry));
    box.replaceChildren(...parts);
  }

  SB.views = { el, notice, tree, focusTree, main, planState, tableState, rowsVisible, progressOf, STATE };
})(typeof window !== "undefined" ? window : globalThis);
