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
        id: r.id, line: r.line, text: r.text, invalid: r.invalid, section: r.section, phase: phaseOf(r.section),
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

  // Rows matching every filter. Invalid rows show only when nothing but the phase is filtered.
  function filterTasks(tasks, filters) {
    const q = (filters.q || "").trim().toLowerCase();
    return tasks.filter(t => {
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

  Object.assign(SB, { ORDER, phaseOf, tasksFrom, estimateText, filterTasks, filterOptions, waiting, prerequisites,
                      approvals, resultHref, tabKey, stageOfPhase, short });
})(typeof window !== "undefined" ? window : globalThis);
