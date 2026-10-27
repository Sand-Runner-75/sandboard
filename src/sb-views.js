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

  // Short explanations shown in a bubble on hover or keyboard focus (app.js shows them), and
  // listed in the help dialog for anyone who cannot hover.
  const TIPS = {
    "Done": "The plan's table marks this task finished. Only the owner's approval, recorded by the plan's progress script, makes it count.",
    "Ready for Review": "The work is finished and waits for the other AI's review or the owner's decision.",
    "In Progress": "Work on this task has started.",
    "Blocked": "Work cannot go on until something else happens; see what it needs.",
    "Not Started": "No work has started yet.",
    "Removed": "Dropped from the plan. The row stays for history and its hours no longer count. Its original plan notes usually say where the work went.",
    "Invalid row": "This table row is not in the expected form, so it is shown as its raw text and not counted.",
    "Verified": "Every row counted here has an hour estimate, so the figure is firm.",
    "Not verified": "Some rows are still to be estimated, so this figure can change once they get hours.",
    "To be estimated": "No hours have been estimated yet; the row is not counted in the figures.",
    "No active work": "Nothing in this phase or scope is counted yet, so no percentage is shown.",
    "Whole project": "Share of all estimated hours approved as done, as the plan's own progress script worked it out.",
    "Remaining": "Estimated hours not yet approved as done.",
    "Forecast": "A finish date. The plan's progress output gives none, so none is shown rather than a guess.",
    "Next gate": "A readiness check the owner approves before work moves to the next stage.",
    "Approval not supplied": "The progress output does not say the owner approved this gate, so it is not shown as approved.",
    "Pilot": "Tasks needed for the first version used for real with one partner.",
    "MVP": "Tasks needed for the first full version.",
    "Post-MVP": "Tasks planned for after the first full version.",
    "Stage": "A group of phases that ends at a readiness gate.",
    "Phase": "A step of the plan, as the task table's headings name it.",
    "Dots": "One dot per task: filled for done or started, hollow for not started, dashed for removed. Past 40 tasks, one dot per status with its count.",
    "Commit": "Everything on this page was read from the plan at exactly this commit.",
    "Evidence": "What the table says and what the owner approved are shown apart, because a Done row is not proof of approval.",
    "Result files": "The files the task produced. Links appear only once the owner's approval is recorded.",
    "Needs": "Tasks that must be finished before this one starts. Pick one to open it as a tab.",
    "Needed by": "Tasks that wait for this one. Pick one to open it as a tab.",
    "Steps": "Smaller steps of this task, with no hours of their own.",
    "Original plan notes": "The Notes column of this task's row in the plan's task table, copied as written.",
    "Cross-references": "The plan's index of everything related to this task: rules, research, decisions and other files.",
    "Brief": "The instructions given to whoever does the task.",
    "Handover": "What the doer wrote when handing the work over for review.",
    "Check runs": "Automatic checks GitHub ran on this commit. Passing checks are not the owner's approval.",
    "plan": "The repository that holds this project's plan, task table and records.",
    "code": "A repository with this project's code.",
    "Read-only": "Sandboard only reads. Nothing here can change a plan, a task or a repository.",
    "Task tab": "A task opened on its own, as it was read at that commit. It stays as it was until you close it.",
    "Review cycle": "The task's brief, its pull requests, the reviews posted on them, their checks and merges, and the owner's decision, each shown apart. Read live from GitHub.",
    "Handoff": "A pull request comment in the agreed form (FROM, TO, STATE, HEAD, RESULT, NEXT) that one AI leaves for the other. Its verdict is the reviewer's, not the owner's approval.",
    "Older commit": "The review was given for a commit that is no longer the pull request's head, so it may not cover the latest changes.",
    "Superseded": "The same sender posted a later handoff on this pull request; the later one is their current word.",
    "Pull requests and reviews": "Pull requests whose title names the task, and the code pull requests they link, with the handoffs posted on them, their checks and their merges.",
    "Owner decision": "The owner's approval, as the plan's progress script records it. A review, a passing check or a merge never stands in for it.",
  };
  // Attaches an explanation to a node; returns the node.
  function tip(node, key) {
    const text = TIPS[key] || key;
    if (text) node.setAttribute("data-tip", text);
    return node;
  }

  const STATUS_CLASS = { "Done": "done", "Ready for Review": "review", "In Progress": "progress", "Blocked": "blocked",
                         "Not Started": "not", "Removed": "removed" };
  const DOT_LIMIT = 40;
  // GitHub's check-run conclusions that mean the check did not pass.
  const NOT_PASSING = ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"];
  const pill = status => STATUS_CLASS[status] ? tip(el("span", { class: "pill st-" + STATUS_CLASS[status] }, status), status)
    : el("span", { class: "pill st-invalid" }, status ? "Unknown status: " + status : "No status");
  const lab = (text, key, attrs) => tip(el("p", Object.assign({ class: "label" }, attrs || {}), text), key || text);
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
    return el("p", { class: "source" }, tip(plan, "Commit"), code,
      tip(el("span", {}, KIND[w.kind] || w.kind), w.kind === "project" ? "A project in use, with its own plan." : w.kind === "kit" ? "A reusable starting kit, not a project in use." : "Code only: there is no plan, so no tasks or progress."));
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
        el("div", {}, lab(label, TIPS[label] ? label : "Stage"),
          el("div", { class: "big num" + (active ? "" : " muted") }, active ? f.progress_pct + "%" : "No active work"),
          active ? tip(el("div", { class: "qual" + (f.verified ? "" : " muted") }, verifiedText(f)), f.verified ? "Verified" : "Not verified")
            : tip(el("div", { class: "qual muted" }, "Nothing to count in this scope."), "No active work"),
          f.proposed_rows ? el("div", { class: "qual muted" }, f.proposed_rows + " proposed percentages not counted until approved") : null)),
      el("div", { class: "card" }, lab("Remaining"),
        el("div", { class: "big num" + (active ? "" : " muted") }, active ? hours(f.remaining_h) : "—"),
        el("div", { class: "qual muted" }, active ? "of " + hours(f.estimated_h) + " estimated" + (f.verified ? "" : ", not verified") : "No estimated work.")),
      el("div", { class: "card" }, lab("Forecast"), el("div", { class: "big muted" }, "Not supplied"),
        el("div", { class: "qual muted" }, "The progress output gives no finish date, so none is shown.")),
      el("div", { class: "card" }, lab("Next gate"),
        gateName ? el("div", {}, el("b", {}, gateName + " "), tip(el("span", { class: "pill hollow st-not" }, "Approval not supplied"), "Approval not supplied"))
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
      tip(el("p", { class: "qual muted plain" }, "From " + d.producer.path + " (" + p.schema + ") at " + short(p.source.commit) +
        ", matching the task table and record at that commit. Search, filters and tabs never change these figures."), "Commit"));
  }

  function scopeRow(entry) {
    const p = progressOf(entry);
    if (p.state !== "current") return null;
    return el("div", { class: "scopes", "aria-label": "Figures by scope" }, ["Pilot", "MVP", "Post-MVP"].map(name => {
      const f = p.data.scopes[name];
      const active = f.rows > 0;
      return el("div", { class: "card", "data-scope": name }, lab(name),
        el("div", { class: "num" }, active ? el("b", {}, f.progress_pct + "%") : el("span", { class: "muted" }, "No active work"),
          active ? " · " + hours(f.remaining_h) + " of " + hours(f.estimated_h) + " remaining" : ""),
        active ? tip(el("div", { class: "qual" + (f.verified ? "" : " muted") }, verifiedText(f)), f.verified ? "Verified" : "Not verified") : null);
    }));
  }

  function phaseCard(S, A, entry, ph) {
    const active = ph.rows > 0;
    // One dot per row while that stays small; past DOT_LIMIT rows, one dot per status with its exact count,
    // so a large supplied count never turns into as many page elements.
    const dots = el("span", { class: "dots", "aria-hidden": "true" });
    const dot = s => el("span", { class: "dot st-" + STATUS_CLASS[s] + (s === "Removed" ? " removed" : s === "Not Started" ? "" : " fill") });
    const total = SB.ORDER.reduce((n, s) => n + ph.status_counts[s], 0);
    for (const s of SB.ORDER) {
      if (total > DOT_LIMIT) { if (ph.status_counts[s]) dots.append(dot(s), el("span", { class: "dot-n" }, "×" + ph.status_counts[s])); }
      else for (let i = 0; i < ph.status_counts[s]; i++) dots.append(dot(s));
    }
    const counts = SB.ORDER.filter(s => ph.status_counts[s]).map(s => ph.status_counts[s] + " " + s).join(", ") || "no rows";
    const bar = el("span", { class: "bar" + (active && !ph.verified ? " unverified" : "") });
    if (active) { const fill = el("span"); fill.style.width = ph.progress_pct + "%"; bar.append(fill); }
    const pressed = S.view.kind === "tasks" && S.filters.phase === ph.id;
    const btn = el("button", { type: "button", class: "phase", "data-phase": ph.id, "aria-pressed": String(pressed),
        "aria-label": ph.id + " " + ph.name + ": " + (active ? ph.progress_pct + "% " + (ph.verified ? "verified" : "not verified") : "no active work") +
          ". " + counts + ". Show its tasks.",
        onclick: () => A.showPhase(entry.w.id, ph.id) },
      el("span", { class: "top2" }, el("b", {}, ph.id + " " + ph.name)),
      el("span", { class: "top2" }, el("span", { class: "num" + (active ? "" : " muted") }, active ? ph.progress_pct + "%" : "No active work"),
        el("span", { class: "qual muted" }, active ? (ph.verified ? "verified" : "not verified") : "")),
      bar, dots);
    return tip(btn, "Tasks: " + counts + ". " + TIPS.Dots + " Pick it to see its tasks.");
  }

  const pctText = f => f.rows ? f.progress_pct + "% of its estimated hours approved as done" + (f.verified ? "" : " (not verified)") : "no active work yet";
  const stageTip = x => "Stage: phases " + x.phases.join(", ") + "; " + pctText(x) + ". Gate: " + (x.gate || "none") + ".";

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
          "data-tip": stageTip(x), onclick: () => A.showStage(entry.w.id, x.id) }, (i + 1) + " " + x.name,
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
        kids.push({ id: "v:" + w.id + ":tasks", label: "Tasks", act: () => A.go(w.id, { kind: "tasks" }, { phase: "" }),
                    cur: at("tasks", () => !S.filters.phase && !S.filters.stage) });
        const p = progressOf(entry);
        if (p.state === "current") {
          // Phases sit under their stage when the progress output supplies stages, else under the project.
          const phase = ph => ({ id: "ph:" + w.id + ":" + ph.id, label: ph.id + " " + ph.name, sub: ph.rows ? ph.progress_pct + "%" : "—",
            tip: "Phase " + ph.id + ": " + pctText(ph) + ". Pick it to see its tasks.",
            act: () => A.showPhase(w.id, ph.id), cur: at("tasks", () => S.filters.phase === ph.id) });
          if (Array.isArray(p.data.stages)) {
            kids.push({ id: "stages:" + w.id, label: "Stages", tip: TIPS.Stage, kids: p.data.stages.map((st, i) => ({
              id: "st:" + w.id + ":" + st.id, label: (i + 1) + " " + st.name, sub: st.rows ? st.progress_pct + "%" : "—", tip: stageTip(st),
              act: () => A.showStage(w.id, st.id),
              kids: p.data.phases.filter(ph => st.phases.includes(ph.id)).map(phase),
              cur: at("overview", () => S.view.stage === st.id) || at("tasks", () => !S.filters.phase && S.filters.stage === st.id) })) });
          } else {
            kids.push({ id: "phases:" + w.id, label: "Phases", tip: TIPS.Phase, kids: p.data.phases.map(phase) });
          }
        }
      }
      const repos = [w.plan && { repo: w.plan.repo, role: "plan" }, ...w.code].filter(Boolean);
      kids.push({ id: "repos:" + w.id, label: "Repositories", kids: repos.map(r => ({
        id: "r:" + w.id + ":" + r.repo, label: r.repo.split("/")[1], sub: r.role, tip: r.repo + ": " + (r.role === "plan" ? TIPS.plan : TIPS.code + " Its role here: " + r.role + "."),
        act: () => A.go(w.id, { kind: "repo", repo: r.repo }), cur: at("repo", () => S.view.repo === r.repo) })) });
      const plan = planState(entry);
      const sub = entry.loading ? "loading" : plan !== "current" && plan !== "none" ? (STATE[plan] || STATE.failed)[2].toLowerCase()
        : w.kind === "kit" ? "kit" : w.kind === "standalone" ? "code only" : "";
      projects.kids.push({ id: "p:" + w.id, label: w.label, sub: w.opened ? "opened by name" : sub, kids,
        act: () => A.go(w.id, w.plan ? { kind: "overview" } : { kind: "repo", repo: w.code[0].repo }) });
    }
    // The account views cover every mapped repository, so they sit apart from the projects.
    const account = { id: "g:account", label: "Account", tip: TIPS["All repositories"], kids: [
      { id: "a:portfolio", label: "All repositories", tip: TIPS["All repositories"], act: () => A.goAccount("portfolio"), cur: !S.activeTab && S.view.kind === "portfolio" },
      { id: "a:activity", label: "Activity and languages", tip: TIPS.Activity, act: () => A.goAccount("activity"), cur: !S.activeTab && S.view.kind === "activity" },
      { id: "a:inbox", label: "Inbox", tip: TIPS.Inbox, act: () => A.goAccount("inbox"), cur: !S.activeTab && S.view.kind === "inbox" }] };
    return [projects, account];
  }

  // The IDs of every tree item that has children (for Expand all).
  function treeGroups(S, A) {
    const out = [];
    const walk = nodes => { for (const n of nodes) if (n.kids && n.kids.length) { out.push(n.id); walk(n.kids); } };
    walk(treeData(S, A));
    return out;
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
      // The arrow opens and closes a group; the name goes to the place (and opens its group).
      li.append(el("span", { class: "ti" + (n.cur ? " current" : ""), "data-tip": n.tip || null, onclick: e => { e.stopPropagation(); activate(n); } },
        el("span", { class: "tw", "aria-hidden": "true", onclick: hasKids ? e => { e.stopPropagation(); toggle(n); } : null }, hasKids ? (open ? "▾" : "▸") : ""),
        el("span", { class: "tl" }, n.label), n.sub ? el("span", { class: "sub", "aria-hidden": "true" }, n.sub) : null));
      flat.push({ n, li, parent });
      if (open) li.append(el("ul", { role: "group" }, build(n.kids, level + 1, n)));
      return li;
    });
    const toggle = n => {
      S.treeFocus = n.id;
      S.expanded.has(n.id) ? S.expanded.delete(n.id) : S.expanded.add(n.id);
      A.render(); focusTree(S);
    };
    const activate = n => {
      if (!n.act) { toggle(n); return; }
      S.treeFocus = n.id;
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
    sec.append(V.feedCard(S, A, entry, [w.plan.repo, ...w.code.map(c => c.repo)]));
    return sec;
  }

  function waitingCard(S, A, entry) {
    const card = el("section", { class: "card", "aria-labelledby": "wait-h" }, tip(el("h2", { id: "wait-h", class: "label" }, "Waiting on someone"), "Tasks in review or blocked, as the table says: someone has to act before they move on."));
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
    // Each run counts only by what it states: passing needs an explicit success, and a finished run
    // without a conclusion, or with one not known here, is never counted as passing.
    const runs = res.data.runs;
    const count = test => runs.filter(test).length;
    const done = r => r.status === "completed";
    const groups = [[count(r => done(r) && r.conclusion === "success"), "passing"],
      [count(r => done(r) && NOT_PASSING.includes(r.conclusion)), "not passing"],
      [count(r => !done(r)), "running or queued"],
      [count(r => done(r) && ["neutral", "skipped"].includes(r.conclusion)), "neutral or skipped"],
      [count(r => done(r) && !r.conclusion), "finished with no conclusion"]];
    const other = runs.length - groups.reduce((n, g) => n + g[0], 0);
    if (other) groups.push([other, "with a conclusion not known here"]);
    const text = groups.filter((g, i) => i < 3 || g[0]).map(g => g[0] + " " + g[1]).join(", ");
    return el("span", {}, res.state === "empty" ? "No check runs" : runs.length + (runs.length === 1 ? " check run: " : " check runs: ") + text,
      res.coverage ? " (" + res.coverage.shown + " of " + res.coverage.total + " read)" : "");
  }

  function repoCard(entry) {
    const card = el("section", { class: "card", "aria-labelledby": "repos-h" }, tip(el("h2", { id: "repos-h", class: "label" }, "Code repositories"), "code"));
    if (!entry.w.code.length) { card.append(el("p", { class: "muted plain" }, "No code repository assigned. Nothing is guessed from names.")); return card; }
    card.append(el("ul", { class: "feed" }, entry.code.map(c => el("li", {}, el("b", { class: "mono" }, c.c.repo), "(" + c.c.role + ")",
      !c.pinned ? el("span", { class: "muted" }, "Loading") : c.pinned.state === "current"
        ? [el("span", { class: "mono", title: c.pinned.data.commit }, c.pinned.data.ref + " → " + short(c.pinned.data.commit)), checksSummary(c.checks)]
        : el("span", {}, (STATE[c.pinned.state] || STATE.failed)[2])))));
    card.append(el("p", { class: "qual muted plain" }, "Recent commits and pull requests are under Recent activity; each repository has History, Pull requests, Issues, Actions and Releases tabs, and files come in a later slice. Activity is never progress."));
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
    const stage = chosenStage(S, entry);
    sec.append(wholeCards(entry), progressBlock(S, A, entry, stage ? stage.id : null));
    const left = el("div", { class: "stack tight" }, el("h2", { id: "tasks-h", class: "label", tabindex: "-1" }, "Tasks"), filterBar(S, A, entry), taskList(S, A, entry));
    // The list takes the whole width; with a task open, the details get a wide share beside it.
    const task = rowsVisible(entry) && S.selected ? entry.tasks.find(t => t.id === S.selected && !t.invalid) : null;
    const area = el("div", { class: "work" + (task ? " with-details" : "") }, left);
    if (task) area.append(inspector(S, A, entry, task, null));
    sec.append(area);
    return sec;
  }

  const stagesOf = entry => { const p = progressOf(entry); return p.state === "current" && Array.isArray(p.data.stages) ? p.data.stages : null; };
  // The ID of the stage holding a phase, or "" when there is none.
  function stageIdOf(entry, phase) {
    const stages = entry && phase ? stagesOf(entry) : null;
    const st = stages ? SB.stageOfPhase({ stages }, phase) : null;
    return st ? st.id : "";
  }
  // The stage the task filters are on: the one picked, or the one holding the picked phase.
  function chosenStage(S, entry) {
    const stages = stagesOf(entry);
    if (!stages) return null;
    if (S.filters.phase) return SB.stageOfPhase({ stages }, S.filters.phase);
    return stages.find(x => x.id === S.filters.stage) || null;
  }
  function activeFilters(S, entry) {
    const st = !S.filters.phase && S.filters.stage ? chosenStage(S, entry) : null;
    return st ? Object.assign({}, S.filters, { stagePhases: st.phases }) : S.filters;
  }

  function filterBar(S, A, entry) {
    const opts = rowsVisible(entry) ? SB.filterOptions(entry.tasks) : { phases: [], statuses: [], doers: [] };
    const stages = stagesOf(entry);
    const st = chosenStage(S, entry);
    const select = (id, key, values, all) => {
      const s = el("select", { id, onchange: e => A.setFilter(key, e.target.value, id) },
        el("option", { value: "" }, all), values.map(v => el("option", { value: v.value }, v.label)));
      s.value = key === "stage" ? (st ? st.id : "") : S.filters[key];
      return s;
    };
    const phases = st ? opts.phases.filter(p => st.phases.includes(p.id)) : opts.phases;
    const q = el("input", { id: "q", type: "search", placeholder: "ID or title", autocomplete: "off", spellcheck: "false",
      oninput: e => A.setFilter("q", e.target.value, "q") });
    q.value = S.filters.q;
    return el("div", { class: "filters", role: "search" },
      el("label", {}, "Search tasks", q),
      stages ? tip(el("label", {}, "Stage", select("f-stage", "stage", stages.map((x, i) => ({ value: x.id, label: (i + 1) + " " + x.name })), "All stages")), "Stage") : null,
      tip(el("label", {}, "Phase", select("f-phase", "phase", phases.map(p => ({ value: p.id, label: p.id + " " + p.name })), st ? "All phases in this stage" : "All phases")), "Phase"),
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
    const rows = SB.filterTasks(entry.tasks, activeFilters(S, entry));
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
          el("span", { class: "id" }, t.id || "—"), tip(el("span", { class: "pill st-invalid" }, "Invalid row"), "Invalid row"), el("span", { class: "muted qual" }, "line " + t.line + ": " + t.invalid),
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
    const box = el("div", { class: "results" }, lab("Result files"));
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

  // ---- Task details: a short summary beside the list, everything in a task tab

  const factsOf = entry => SB.approvals(entry.progress && entry.progress.state === "current" ? entry.progress.data : null);

  function evidence(task, approved, fact) {
    return tip(el("div", { class: "facts" }, lab("Evidence, shown separately", "Evidence"),
      el("ul", {},
        el("li", {}, "Source status: " + (task.status || "none") + (task.pct !== undefined && task.pct !== "" ? ", " + task.pct + " in the table" : "")),
        el("li", {}, fact ? "Owner approval: recorded (" + fact.approval + ")"
          : !approved ? "Owner approval: not supplied by this plan's progress output"
          : task.status === "Done" ? "Owner approval: not recorded. Done in the table is not owner approval." : "Owner approval: not recorded"),
        el("li", {}, "Earned credit: counted only by the progress output, never here"))), "Evidence");
  }

  // A task named by another task: its ID opens it as a tab, with its status beside it. From a task
  // tab, it opens at that tab's own commit, the revision the list was read from.
  function taskRef(A, entry, id, task, from) {
    return el("li", {}, task ? el("button", { type: "button", class: "linkbtn id", "data-open": id, "aria-label": "Open " + id + " as a tab",
        onclick: () => A.openTab(entry.w.id, id, from) }, id) : el("span", { class: "id" }, id), " ",
      task ? [task.title ? el("span", { class: "ref-title" }, task.title) : null, " ", pill(task.status)]
        : tip(el("span", { class: "pill st-invalid" }, "Not in this table"), "This ID is not a row of this plan's task table."));
  }

  function related(A, entry, task, full, from) {
    const box = el("div", { class: "stack tight related" });
    const list = (name, items, empty) => box.append(el("div", {}, lab(name),
      items.length ? el("ul", { class: "needs" }, items) : el("p", { class: "muted plain" }, empty)));
    list("Needs", task.prereqs === undefined ? [] : SB.prerequisites(task, entry.tasks).map(n => taskRef(A, entry, n.id, n.task, from)),
      task.prereqs === undefined ? "No prerequisites column in the table" : "None");
    list("Needed by", SB.dependents(task, entry.tasks).map(t => taskRef(A, entry, t.id, t, from)), "No task lists this one as a prerequisite.");
    if (full) {
      const parent = task.parent ? entry.tasks.find(t => t.id === task.parent && !t.invalid) : null;
      if (task.parent) box.append(el("div", {}, lab("Step of", "Steps"), el("ul", { class: "needs" }, taskRef(A, entry, task.parent, parent, from))));
      list("Steps", SB.steps(task, entry.tasks).map(t => taskRef(A, entry, t.id, t, from)), "No steps.");
    }
    return box;
  }

  function notesBox(task, open) {
    if (task.notes === undefined || task.notes === "") return null;
    const notes = el("p", { class: "doc" });
    notes.append(SB.renderText(doc, task.notes).node);
    return el("details", { open }, tip(el("summary", { class: "label" }, "Original plan notes"), "Original plan notes"), notes);
  }

  // The short summary beside the task list.
  function inspector(S, A, entry, task) {
    const approved = factsOf(entry);
    const fact = approved ? approved.get(task.id) : null;
    const box = el("aside", { class: "inspector", "aria-label": "Task details", id: "inspector" });
    box.append(el("header", {}, el("div", {}, el("div", { class: "id" }, task.id), el("h3", {}, task.title || "No title")),
      el("button", { type: "button", class: "btn ghost", "aria-label": "Close details", onclick: () => A.closeDetails() }, "Close")));
    // Approved result files come first: for a finished task they are what there is to look at.
    if (fact && task.status !== "Removed") box.append(resultLinks(entry, task, approved, false));
    const model = task.model === undefined ? given(undefined) : task.model ? task.model + (task.effort ? ", " + task.effort : "") : el("span", { class: "muted" }, "Not given in the table");
    box.append(el("dl", { class: "props" },
      el("dt", {}, "Status"), el("dd", {}, pill(task.status)),
      tip(el("dt", {}, "Phase"), "Phase"), el("dd", {}, task.phase ? task.phase.id + " " + task.phase.name : task.section || el("span", { class: "muted" }, "Not under a phase")),
      el("dt", {}, "Job / task"), el("dd", {}, [task.job, task.group].filter(x => x).join(" · ") || el("span", { class: "muted" }, "Not given in the table")),
      task.parent ? [tip(el("dt", {}, "Step of"), "Steps"), el("dd", { class: "id" }, task.parent)] : null,
      el("dt", {}, "Doer"), el("dd", {}, given(task.doer)), el("dt", {}, "Reviewer"), el("dd", {}, given(task.reviewer)),
      tip(el("dt", {}, "Mode"), "How the doer works on it, as the table says (for example Chat or Code)."), el("dd", {}, given(task.mode)),
      tip(el("dt", {}, "Model"), "The AI model and effort the table chose for the task."), el("dd", {}, model),
      el("dt", {}, "Estimate"), el("dd", {}, task.est === "TBE" ? tip(el("span", {}, SB.estimateText(task.est)), "To be estimated") : SB.estimateText(task.est)),
      tip(el("dt", {}, "Pilot / MVP"), "Whether the task is needed for the Pilot and for the MVP, as the table says."),
      el("dd", {}, task.pilot === undefined && task.mvp === undefined ? given(undefined) : (task.pilot || "—") + " / " + (task.mvp || "—")),
      tip(el("dt", {}, "Check"), "How the result is checked, as the table says (for example DOC, CODE or TEST)."), el("dd", {}, given(task.check)),
      el("dt", {}, "Expected result"), el("dd", {}, given(task.expected))));
    box.append(evidence(task, approved, fact));
    if (!fact && task.status !== "Removed") box.append(resultLinks(entry, task, approved, false));
    box.append(related(A, entry, task, false));
    const notes = notesBox(task, false);
    if (notes) box.append(notes);
    box.append(crossref(S, A, entry, task, false));
    // A finished task's brief and handover stay folded until opened.
    for (const kind of ["brief", "handover"]) box.append(taskFile(S, A, entry, task, kind, false, task.status === "Done"));
    box.append(el("div", { class: "actions" }, tip(el("button", { type: "button", class: "btn ghost", onclick: () => A.openTab(entry.w.id, task.id) }, "Open as tab"),
      "Opens everything about this task in its own tab, with sections for details, brief, handover, results, review cycle, cross-references and related tasks."),
      tip(el("button", { type: "button", class: "btn ghost", id: "open-cycle", onclick: () => A.openTab(entry.w.id, task.id, undefined, "cycle") }, "Review cycle"), "Review cycle")));
    return box;
  }

  const FILE_NAMES = { brief: "Brief", handover: "Handover", crossref: "Cross-references" };

  // The task's file of one kind, read at the plan commit. folded: inside a closed details element.
  function taskFile(S, A, entry, task, kind, tab, folded) {
    const name = FILE_NAMES[kind];
    const files = entry.w.plan.files;
    const wrap = el(folded ? "details" : "div", { class: "stack tight", "data-file": kind });
    const head = (text) => tip(el(folded ? "summary" : "p", { class: "label" }, text), name);
    if (!files[kind]) {
      wrap.append(head(name), el("p", { class: "muted plain" }, "This workspace names no " + kind + " file."));
      return wrap;
    }
    const commit = entry.plan.data.commit;
    const res = S.docs.get(A.docKey(entry.w.id, entry.w.plan.repo, commit, kind, files[kind], task.id));
    wrap.append(head(name + " · " + entry.w.plan.repo + " @ " + short(commit)));
    if (!res || res.state === "loading") { wrap.append(el("p", { class: "muted plain" }, "Loading")); return wrap; }
    if (res.state !== "current") {
      wrap.append(res.state === "missing" ? el("p", { class: "muted plain" }, "No " + (kind === "crossref" ? "cross-reference file" : kind) + " for " + task.id + " at this commit.")
        : notice(res.state, res.error));
      return wrap;
    }
    const id = (tab ? "tab-" : "") + kind + "-text";
    const text = el("pre", { class: "doc", id, tabindex: "0", "aria-label": name + " text" });
    const shown = SB.renderText(doc, res.data.text);
    text.append(shown.node);
    const status = el("p", { class: "status-line", role: "status" });
    wrap.append(text, el("div", { class: "actions" }, el("button", { type: "button", class: "btn", "data-copy": kind,
      onclick: () => A.copy(text, status) }, "Copy " + (kind === "crossref" ? "cross-references" : kind))), status);
    return wrap;
  }

  // The task's cross-references: a link to the file on GitHub, and in a tab its text as well.
  function crossref(S, A, entry, task, tab) {
    const template = entry.w.plan.files.crossref;
    const box = el("div", { class: "stack tight", "data-file": "crossref-link" }, lab("Cross-references"));
    if (!template) { box.append(el("p", { class: "muted plain" }, "This project has no cross-reference files.")); return box; }
    const commit = entry.plan.data.commit;
    const res = S.docs.get(A.docKey(entry.w.id, entry.w.plan.repo, commit, "crossref", template, task.id));
    if (!res || res.state === "loading") { box.append(el("p", { class: "muted plain" }, "Loading")); return box; }
    if (res.state !== "current") {
      box.append(res.state === "missing" ? el("p", { class: "muted plain" }, "No cross-reference file for this task.") : notice(res.state, res.error));
      return box;
    }
    const path = template.replace("{id}", task.id);
    box.append(el("p", { class: "plain" }, fileLink(entry, path, false)));
    if (tab) box.append(taskFile(S, A, entry, task, "crossref", true, false));
    return box;
  }

  // ---- A task's review cycle (F008): evidence read live from GitHub, each kind shown apart.
  // Nothing here sends, approves or merges; a review, a passing check or a merge is never owner approval.

  const when = t => typeof t === "string" ? t.slice(0, 16).replace("T", " ") + " UTC" : "";

  function cycleView(S, A, entry, task, tab, approved, fact) {
    const box = el("div", { class: "stack tight cycle", "data-part": "cycle" });
    box.append(tip(el("p", { class: "muted plain qual" }, "Read live from GitHub, not at the plan commit. A plan pull request belongs here when its title names ",
      el("span", { class: "id" }, task.id), ", and a code pull request when such a plan pull request's description links it. Only comments in the handoff form count as reviews. Nothing here can send, approve or merge anything."), "Review cycle"));
    // The brief, as read at the plan commit.
    const template = entry.w.plan.files.brief;
    const brief = template ? S.docs.get(A.docKey(entry.w.id, entry.w.plan.repo, entry.plan.data.commit, "brief", template, task.id)) : null;
    box.append(el("div", { "data-part": "cycle-brief" }, lab("Brief"), el("p", { class: "plain" },
      !template ? el("span", { class: "muted" }, "This project names no brief files.")
        : !brief || brief.state === "loading" ? el("span", { class: "muted" }, "Loading")
        : brief.state === "current" || brief.state === "empty" ? ["Written: ", fileLink(entry, template.replace("{id}", task.id), false)]
        : brief.state === "missing" ? el("span", { class: "muted" }, "No brief at this commit.") : (STATE[brief.state] || STATE.failed)[2])));
    // Pull requests, with their reviews, checks and merges.
    const prs = el("div", { class: "stack tight", "data-part": "cycle-pulls" }, lab("Pull requests and reviews"));
    const res = S.docs.get(A.cycleKey(entry, task.id));
    if (!res || res.state === "loading") prs.append(el("p", { class: "muted plain" }, "Loading"));
    else if (res.state === "no-match") {
      prs.append(el("p", { class: "muted plain" }, "No pull request in " + entry.w.plan.repo + " names " + task.id + " in its title (" +
        res.data.searched + " read" + (res.data.listState === "partial" ? "; the list was cut off" : "") + ")."));
    } else if (res.state !== "current") prs.append(notice(res.state, res.error));
    else {
      if (res.data.listState === "partial") prs.append(notice("partial", "Only the first " + res.data.searched + " pull requests were read."));
      const left = res.data.left;
      if (left.named || left.linked) {
        const parts = [];
        if (left.named) parts.push(left.named + " more pull request" + (left.named === 1 ? "" : "s") + " naming " + task.id + " in " + entry.w.plan.repo);
        if (left.linked) parts.push(left.linked + " linked code pull request" + (left.linked === 1 ? "" : "s"));
        prs.append(notice("partial", "At most 10 pull requests are shown. Not shown or read: " + parts.join(", and ") + "."));
      }
      for (const it of res.data.items) prs.append(pullCard(it));
      prs.append(el("p", { class: "muted plain qual" }, "Read at " + when(res.data.readAt) + "."));
    }
    if (tab) prs.append(el("div", { class: "actions" }, el("button", { type: "button", class: "btn ghost", id: "cycle-again", onclick: () => A.readCycleAgain(tab.key) }, "Read again")));
    box.append(prs);
    // The owner's decision: only the producer's approval fact.
    box.append(el("div", { "data-part": "cycle-owner" }, lab("Owner decision"), el("p", { class: "plain" },
      fact ? "Owner approval: recorded (" + fact.approval + ")" : !approved ? "Owner approval: not supplied by this plan's progress output"
        : "Owner approval: not recorded. A review, passing checks or a merge are not owner approval.")));
    return box;
  }

  function pullCard(it) {
    const name = it.repo + " #" + it.number;
    const card = el("section", { class: "card pull", "data-pull": name });
    card.append(el("h4", {}, it.web ? el("a", { href: it.web + "/pull/" + it.number, target: "_blank", rel: "noopener noreferrer", class: "mono" }, name)
      : el("span", { class: "mono" }, name), it.pr ? " " + it.pr.title : ""));
    if (it.via) card.append(el("p", { class: "muted plain qual" }, "Linked from the description of plan pull request #" + it.via + "."));
    if (!it.pr) {
      card.append(el("p", { class: "muted plain" }, it.listState === "current" || it.listState === "empty" ? "Not among that repository's pull requests."
        : "That repository's pull requests could not be read fully (" + (STATE[it.listState] || STATE.failed)[2] + ")."));
      return card;
    }
    const pr = it.pr;
    card.append(el("dl", { class: "props" },
      el("dt", {}, "State"), el("dd", {}, pr.merged ? "Merged " + when(pr.merged) + (pr.mergeCommit ? " as " + SB.short(pr.mergeCommit) : "")
        : pr.state === "open" ? "Open" : "Closed without merging"),
      el("dt", {}, "Head"), el("dd", { class: "mono", title: pr.head }, SB.short(pr.head)),
      tip(el("dt", {}, "Checks at the head"), "Check runs"), el("dd", {}, checksSummary(it.checks))));
    const c = it.comments;
    if (!c || !c.data) card.append(notice(c ? c.state : "failed", c && c.error, "Comments not read"));
    else {
      const h = SB.handoffs(pr, c.data.comments);
      card.append(h.list.length ? el("ol", { class: "handoffs" }, h.list.map(handoffItem))
        : el("p", { class: "muted plain" }, "No handoff comment on this pull request."));
      if (h.other) card.append(el("p", { class: "muted plain qual" }, h.other + " other comment" + (h.other === 1 ? "" : "s") + " not in the handoff form, not shown."));
      if (c.state === "partial") card.append(notice("partial", "Only the first " + c.data.comments.length + " comments were read."));
    }
    if (pr.merged) card.append(el("p", { class: "muted plain qual" }, "A merge shows only that the change reached the branch; it is not the owner's approval."));
    return card;
  }

  function handoffItem(h) {
    const target = h.target === "head" ? el("span", { class: "qual" }, "for the head")
      : h.target === "older" ? tip(el("span", { class: "qual warn-text" }, "for an older commit, " + SB.short(h.head)), "Older commit")
      : el("span", { class: "qual warn-text" }, "names no full commit");
    return el("li", { class: "handoff" + (h.superseded ? " superseded" : ""), "data-kind": h.kind || "other", "data-target": h.target },
      el("div", {}, el("b", {}, h.from), h.to ? " to " + h.to : "", ": ", tip(el("span", { class: "hstate" }, h.state), "Handoff"), " ", target,
        h.superseded ? tip(el("span", { class: "qual muted" }, " · superseded"), "Superseded") : null,
        h.at ? el("span", { class: "qual muted" }, " · " + when(h.at)) : null),
      h.result ? el("div", { class: "plain" }, h.result) : null,
      h.next ? el("div", { class: "muted plain qual" }, "Next: " + h.next) : null);
  }

  // Every column of the task's row, in the table's order, as written.
  function fullRow(A, entry, task) {
    const dl = el("dl", { class: "props wide" });
    for (const [name, value] of Object.entries(task.fields || {})) {
      let shown;
      if (value === "") shown = el("span", { class: "muted" }, "Blank in the table");
      else if (name === "Status") shown = pill(value);
      else if (name === "Est. h") shown = SB.estimateText(value) === value + " h" ? value + " h" : [value, el("span", { class: "muted" }, " (" + SB.estimateText(value) + ")")];
      else { shown = el("span", {}); shown.append(SB.renderText(doc, value).node); }
      dl.append(name === "Notes" ? tip(el("dt", {}, "Original plan notes"), "Original plan notes") : el("dt", {}, name), el("dd", {}, shown));
    }
    return dl;
  }

  const SECTIONS = [["details", "Details"], ["brief", "Brief"], ["handover", "Handover"], ["results", "Results"],
                    ["cycle", "Review cycle"], ["crossref", "Cross-references"], ["related", "Related"]];

  // ---- Tabs

  function tabBar(S, A) {
    const bar = el("div", { class: "tabs", role: "tablist", "aria-label": "Open items" });
    const names = { overview: "Overview", tasks: "Tasks", repo: "Repository", portfolio: "All repositories", activity: "Activity", inbox: "Inbox" };
    bar.append(el("div", { class: "tab" + (S.activeTab ? "" : " on") }, el("button", { type: "button", role: "tab", id: "tab-view",
      "aria-selected": String(!S.activeTab), tabindex: S.activeTab ? "-1" : "0", onclick: () => A.showTab(null),
      onkeydown: e => tabKeys(e, A) }, el("span", { class: "kind" }, "View"), names[S.view.kind] || "View")));
    for (const t of A.visibleTabs()) {
      bar.append(el("div", { class: "tab" + (S.activeTab === t.key ? " on" : "") },
        el("button", { type: "button", role: "tab", "data-key": t.key, "aria-selected": String(S.activeTab === t.key),
          tabindex: S.activeTab === t.key ? "0" : "-1", "data-tip": TIPS["Task tab"] + " Read from " + t.repo + " @ " + short(t.commit) + ".", onclick: () => A.showTab(t.key),
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

  // A tab keeps the task as it was read, at its own commit, with everything about it in sections.
  function taskTab(S, A, tab, entry) {
    const task = tab.task;
    const sec = el("section", { class: "stack tight", "aria-labelledby": "view-h", id: "tab-panel" },
      el("h1", { id: "view-h" }, "Task " + tab.id),
      el("p", { class: "tab-title" }, task.title || el("span", { class: "muted" }, "No title"), " ", pill(task.status)),
      tip(el("p", { class: "source" }, "Read from ", el("b", { class: "mono" }, tab.repo), " @ ", el("span", { class: "mono", title: tab.commit }, short(tab.commit)),
        " in ", entry.w.label), "Task tab"));
    // The workspace mapping as it was when the tab opened (its repository and file templates), with today's code repositories.
    const snapshot = Object.assign({}, entry, { w: Object.assign({}, entry.w, { plan: tab.source }), plan: tab.plan, progress: tab.progress, tasks: tab.tasks });
    const sub = tab.sub || "details";
    const bar = el("div", { class: "subtabs", role: "tablist", "aria-label": "Task sections" },
      SECTIONS.map(([id, name]) => el("button", { type: "button", role: "tab", id: "sub-" + id, "data-sub": id, "aria-selected": String(sub === id),
        "aria-controls": "sub-panel", tabindex: sub === id ? "0" : "-1", onclick: () => A.showSection(tab.key, id), onkeydown: e => subKeys(e, A, tab) }, name)));
    const panel = el("div", { role: "tabpanel", id: "sub-panel", "aria-labelledby": "sub-" + sub, class: "stack tight sub-panel" });
    const approved = factsOf(snapshot);
    const fact = approved ? approved.get(task.id) : null;
    if (sub === "details") panel.append(fullRow(A, snapshot, task), evidence(task, approved, fact));
    else if (sub === "brief" || sub === "handover") panel.append(taskFile(S, A, snapshot, task, sub, true, false));
    else if (sub === "results") panel.append(resultLinks(snapshot, task, approved, false));
    else if (sub === "crossref") panel.append(crossref(S, A, snapshot, task, true));
    else if (sub === "cycle") panel.append(cycleView(S, A, snapshot, task, tab, approved, fact));
    else panel.append(related(A, snapshot, task, true, tab.key));
    sec.append(bar, panel);
    return sec;
  }

  function subKeys(e, A, tab) {
    const ids = SECTIONS.map(x => x[0]);
    const i = ids.indexOf(e.currentTarget.dataset.sub);
    const go = j => { e.preventDefault(); A.showSection(tab.key, ids[(j + ids.length) % ids.length]); };
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(ids.length - 1);
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
      el("div", { class: "card" }, lab("Role in this project", role === "plan" ? "plan" : "code"), el("div", {}, role)),
      el("div", { class: "card" }, lab("Read at", "Everything for this repository was read at exactly this commit of this branch."), el("div", { class: "mono" }, d.ref + " → " + short(d.commit)),
        el("div", { class: "qual muted" }, d.date ? "Committed " + d.date : "No commit date")),
      el("div", { class: "card" }, lab("Visibility", "Whether GitHub shows this repository to everyone (Public) or only to people given access (Private)."), el("div", {}, d.meta && d.meta.visibility ? d.meta.visibility[0].toUpperCase() + d.meta.visibility.slice(1)
        : el("span", { class: "muted" }, "Not given by GitHub")))));
    if (code) sec.append(el("div", { class: "card" }, lab("Check runs at this commit", "Check runs"), checksSummary(code.checks),
      code.checks && code.checks.data && code.checks.data.runs.length ? el("ul", { class: "feed" }, code.checks.data.runs.map(r =>
        el("li", {}, el("b", {}, r.name), r.status === "completed" ? (r.conclusion || "no conclusion") : r.status))) : null,
      el("p", { class: "qual muted plain" }, "Checks passing is not owner approval.")));
    // Overview, History and the work evidence as tabs of the repository; Left and Right move between them.
    const SUBS = [["overview", "Overview"], ["history", "History"], ["pulls", "Pull requests"], ["issues", "Issues"], ["runs", "Actions"], ["releases", "Releases"]];
    const sub = SUBS.some(x => x[0] === S.view.sub) ? S.view.sub : "overview";
    const pick = k => A.go(entry.w.id, { kind: "repo", repo: name, sub: k }, { focus: "rs-" + k });
    sec.append(el("div", { class: "subtabs", role: "tablist", "aria-label": "Repository views" }, SUBS.map(([k, l], i) =>
      el("button", { type: "button", role: "tab", id: "rs-" + k, "aria-selected": String(sub === k), "aria-controls": "rs-panel", tabindex: sub === k ? "0" : "-1",
        onclick: () => pick(k),
        onkeydown: e => { if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return; e.preventDefault();
          pick(SUBS[(i + (e.key === "ArrowRight" ? 1 : SUBS.length - 1)) % SUBS.length][0]); } }, l))));
    const panel = el("div", { class: "stack", role: "tabpanel", id: "rs-panel", "aria-labelledby": "rs-" + sub });
    if (sub === "history") panel.append(...V.history(S, A, entry, name, pinned));
    else if (V.WORK_SUBS.includes(sub)) panel.append(...V.work(S, A, entry, name, pinned, sub));
    else panel.append(...V.repoDetails(S, A, entry, name, pinned, role));
    sec.append(panel);
    sec.append(el("p", { class: "qual muted plain" }, "Files come in a later slice."));
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
    if (!S.activeTab && (S.view.kind === "portfolio" || S.view.kind === "activity" || S.view.kind === "inbox")) {
      box.replaceChildren(tabBar(S, A), S.view.kind === "portfolio" ? V.portfolio(S, A) : S.view.kind === "inbox" ? V.inbox(S, A) : V.activity(S, A));
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

  const V = SB.views = { el, notice, checksSummary, tree, treeGroups, focusTree, main, planState, tableState, rowsVisible, progressOf, stageIdOf, STATE, TIPS };
})(typeof window !== "undefined" ? window : globalThis);
