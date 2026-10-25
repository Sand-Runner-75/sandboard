"use strict";
// What the views show, worked out from what the readers returned. Nothing
// here adds up or recalculates progress: task rows keep their source text,
// filters only choose rows, and owner approval comes only from the
// producer's own list of approved result files.

(function (root) {
  const SB = root.SB;

  // Display order of the six source statuses.
  const ORDER = ["Done", "Ready for Review", "In Progress", "Blocked", "Not Started", "Removed"];

  // "P3. Name" or "P3 Name" as a phase; any other heading is not a phase.
  function phaseOf(section) {
    const m = /^(P\d+)[.]?\s+(.+)$/.exec(section || "");
    return m ? { id: m[1], name: m[2].trim() } : null;
  }

  const field = (f, ...names) => {
    for (const n of names) if (Object.prototype.hasOwnProperty.call(f, n)) return f[n];
    return undefined;
  };

  // One task per table row, in source order. A row with a "Sub-task" column
  // takes its title from there and its task group from "Task".
  function tasksFrom(rows) {
    return rows.map(r => {
      const f = r.fields;
      const hasSub = Object.prototype.hasOwnProperty.call(f, "Sub-task");
      const status = field(f, "Status");
      const prereqText = field(f, "Prerequisites");
      return {
        id: r.id, line: r.line, text: r.text, invalid: r.invalid, section: r.section, phase: phaseOf(r.section), fields: f,
        title: hasSub ? f["Sub-task"] : field(f, "Task", "Title"),
        job: field(f, "Job"), group: hasSub ? field(f, "Task") : undefined,
        status, knownStatus: SB.STATUSES.includes(status),
        est: field(f, "Est. h"), pct: field(f, "%"), pilot: field(f, "Pilot"), mvp: field(f, "MVP"),
        check: field(f, "Check"), expected: field(f, "Expected result"),
        doer: field(f, "Doer"), reviewer: field(f, "Reviewer"), mode: field(f, "Mode"),
        model: field(f, "Model"), effort: field(f, "Effort"), notes: field(f, "Notes"),
        prereqs: prereqText === undefined ? undefined :
          prereqText.split(",").map(x => x.trim()).filter(x => x && x !== "—" && x !== "-"),
        parent: /^(.+)[.]\d+$/.test(r.id || "") ? r.id.replace(/[.]\d+$/, "") : null,
      };
    });
  }

  // Source values keep their meaning: never a zero, never a guess.
  function estimateText(e) {
    if (e === undefined) return "Not given in the table";
    if (e === "TBE") return "To be estimated";
    if (e === "") return "Estimate missing";
    if (e === "—" || e === "-") return "No hours";
    if (e === "step") return "Step: no hours of its own";
    return /^\d+([.]\d+)?$/.test(e) ? e + " h" : "Not a number: " + e;
  }

  const blank = v => v === undefined || v === "" || v === "—";

  // Rows matching every filter. Invalid rows show only when nothing but the stage or phase is filtered.
  // stagePhases: the phases of the chosen stage, when one is chosen.
  function filterTasks(tasks, filters) {
    const q = (filters.q || "").trim().toLowerCase();
    return tasks.filter(t => {
      if (filters.stagePhases && !(t.phase && filters.stagePhases.includes(t.phase.id))) return false;
      if (filters.phase && !(t.phase && t.phase.id === filters.phase)) return false;
      if (t.invalid) return !filters.status && !filters.doer && !q;
      if (filters.status && t.status !== filters.status) return false;
      if (filters.doer && t.doer !== filters.doer) return false;
      return !q || String(t.id).toLowerCase().includes(q) || String(t.title || "").toLowerCase().includes(q);
    });
  }

  // Values for the filter menus, in source order.
  function filterOptions(tasks) {
    const valid = tasks.filter(t => !t.invalid);
    const uniq = list => [...new Set(list.filter(v => !blank(v)))];
    const phases = [];
    for (const t of valid) if (t.phase && !phases.some(p => p.id === t.phase.id)) phases.push(t.phase);
    return { phases, statuses: ORDER.filter(s => valid.some(t => t.status === s)), doers: uniq(valid.map(t => t.doer)) };
  }

  // Tasks waiting on a person: in review or blocked, as the table says.
  const waiting = tasks => tasks.filter(t => !t.invalid && (t.status === "Ready for Review" || t.status === "Blocked"));

  // Prerequisites as evidence: each with its own source status, or "Not in this table".
  function prerequisites(task, tasks) {
    return (task.prereqs || []).map(id => {
      const found = tasks.find(t => t.id === id && !t.invalid);
      return { id, task: found || null };
    });
  }

  // Tasks that list this one as a prerequisite, and its steps (IDs like "DT201.1"), in source order.
  const dependents = (task, tasks) => tasks.filter(t => !t.invalid && (t.prereqs || []).includes(task.id));
  const steps = (task, tasks) => tasks.filter(t => !t.invalid && t.parent === task.id);

  // Owner approval facts from the producer's approved result files, by task ID.
  // null when this producer does not supply them: then nothing is shown as approved.
  function approvals(progress) {
    if (!progress || !Array.isArray(progress.approved_results)) return null;
    return new Map(progress.approved_results.map(a => [a.id, a]));
  }

  // A link to one result file at the commit that was read, or null.
  function resultHref(web, commit, path) {
    if (!web || !/^[0-9a-f]{40}$/.test(commit || "") || !SB.isPath(path)) return null;
    return web + "/blob/" + commit + "/" + path.split("/").map(encodeURIComponent).join("/");
  }

  // Tabs are keyed by project, repository, commit and item, so the same ID in
  // two projects, or at two commits, is two tabs.
  const tabKey = (project, repo, commit, kind, id) => [project, repo, commit, kind, id].join("|");

  // The stage holding a phase, when the producer supplies stages.
  function stageOfPhase(progress, phaseId) {
    return progress && Array.isArray(progress.stages) ? progress.stages.find(s => s.phases.includes(phaseId)) || null : null;
  }

  const short = sha => typeof sha === "string" ? sha.slice(0, 7) : "";

  // ---- A task's review cycle: evidence only. Nothing here sends, approves or merges anything,
  // and none of it is owner approval: that comes only from the producer's approval facts.

  const HANDOFF_STATES = ["READY FOR REVIEW", "CHANGES REQUESTED", "READY FOR RECHECK", "REVIEW PASSED", "BLOCKED", "OWNER DECISION"];
  const ID_CHAR = "A-Za-z0-9_-";

  // Does a pull request title name the task? The ID must stand alone: "XQ02" is not "XQ026",
  // and a step "XQ026.1" is not its sub-task "XQ026".
  function namesTask(title, id) {
    if (typeof title !== "string" || !/^[A-Za-z0-9_.-]{1,40}$/.test(id || "")) return false;
    const re = new RegExp("(^|[^." + ID_CHAR + "])" + id.replace(/[.]/g, "[.]") + "(?![" + ID_CHAR + "]|[.][A-Za-z0-9])");
    return re.test(title);
  }

  // Pull requests of other repositories that a text names: a web link to the pull request,
  // "owner/name#12", or the repository's own name followed by "#12" or "PR #12".
  function linkedPulls(text, repos) {
    const out = [];
    const add = (repo, n) => { const number = Number(n);
      if (number >= 1 && number < 1e9 && !out.some(x => x.repo === repo && x.number === number)) out.push({ repo, number }); };
    for (const repo of repos) {
      const [owner, name] = repo.split("/");
      const esc = v => v.replace(/[.]/g, "[.]");
      const forms = [new RegExp("github[.]com/" + esc(owner) + "/" + esc(name) + "/pull/([0-9]{1,9})(?![0-9])", "gi"),
                     new RegExp("(?:^|[^A-Za-z0-9_.-])" + esc(owner) + "/" + esc(name) + "#([0-9]{1,9})(?![0-9])", "gi"),
                     new RegExp("(?:^|[^A-Za-z0-9_./-])" + esc(name) + "(?: +PR)? *#([0-9]{1,9})(?![0-9])", "gi")];
      for (const re of forms) for (const m of String(text || "").matchAll(re)) add(repo, m[1]);
    }
    return out.slice(0, 10);
  }

  // A comment in the agreed handoff form, or null: FROM, STATE and HEAD lines are needed.
  // Every value is text from the comment, shown as text, never followed or run.
  function handoff(body) {
    const lines = String(body || "").split("\n").map(l => l.trim());
    const value = key => { const l = lines.find(x => x.startsWith(key + ":")); return l === undefined ? null : l.slice(key.length + 1).trim(); };
    let from = value("FROM"), to = value("TO");
    const state = value("STATE"), headLine = value("HEAD");
    if (from === null || state === null || headLine === null) return null;
    const inline = /^(.*?)\s*(?:->|→)\s*TO:\s*(.*)$/.exec(from);
    if (inline) { from = inline[1]; to = to === null ? inline[2] : to; }
    const head = /(?:^|[^0-9a-f])([0-9a-f]{40})(?![0-9a-f])/.exec(headLine);
    const cut = (v, n) => v === null ? null : v.slice(0, n);
    return { from: cut(from, 80) || "unnamed", to: cut(to, 80), state: cut(state, 120),
             kind: HANDOFF_STATES.find(k => state.toUpperCase().startsWith(k)) || null,
             head: head ? head[1] : null, result: cut(value("RESULT"), 600), checks: cut(value("CHECKS"), 300),
             details: cut(value("DETAILS"), 300), next: cut(value("NEXT"), 300) };
  }

  // The handoffs on one pull request, oldest first, each labelled against the pull request's head:
  // for the head it has now, for an older commit, or with no full commit; and superseded when a
  // later handoff from the same sender follows it.
  function handoffs(pr, comments) {
    const list = [];
    let other = 0;
    for (const c of comments) {
      const h = handoff(c.body);
      if (h) list.push(Object.assign(h, { at: c.at })); else other += 1;
    }
    list.forEach((h, i) => {
      h.target = !h.head ? "none" : h.head === pr.head ? "head" : "older";
      h.superseded = list.slice(i + 1).some(x => x.from.toLowerCase() === h.from.toLowerCase());
    });
    return { list, other };
  }

  Object.assign(SB, { ORDER, phaseOf, tasksFrom, estimateText, filterTasks, filterOptions, waiting, prerequisites, dependents, steps,
                      approvals, resultHref, tabKey, stageOfPhase, short,
                      HANDOFF_STATES, namesTask, linkedPulls, handoff, handoffs });
})(typeof window !== "undefined" ? window : globalThis);
