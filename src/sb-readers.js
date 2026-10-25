"use strict";
// Readers for the workspace list, a plan's task table, its stored progress
// result and a commit's check runs. Each returns the shared result envelope
// from sb-core.js. Nothing here adds up or recalculates figures: progress is
// shown exactly as the plan's own producer stored it, or not at all.

(function (root) {
  const SB = root.SB;
  const { result } = SB;

  const WORKSPACES_FILE = "sandboard.workspaces.json";
  const WORKSPACES_SCHEMA = "sandboard.workspaces/1";
  const PROGRESS_SCHEMA = "sandboard.progress/1";
  const KINDS = ["project", "kit", "standalone"];
  const PLAN_FILES = ["progress", "producer", "table", "record"];
  // Optional per-task files, as path templates with one "{id}" for the task's ID.
  const TASK_FILES = ["brief", "handover", "crossref"];
  const SCOPES = ["Pilot", "MVP", "Post-MVP", "Whole project"];
  // Schema 1 figures as the producer writes them: hours are numbers, the
  // percentage and every row or status count is a whole number.
  const HOURS = ["estimated_h", "completed_h", "remaining_h"];
  const COUNTS = ["progress_pct", "tbe_rows", "proposed_rows", "provisional_rows", "rows"];
  const STATUSES = ["Not Started", "In Progress", "Blocked", "Ready for Review", "Done", "Removed"];
  const MAX_CHECK_PAGES = 5;
  const BACKSLASH = String.fromCharCode(92);

  const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const isText = (v, max) => typeof v === "string" && v.trim() !== "" && v.length <= max;
  const isPath = v => typeof v === "string" && /^[A-Za-z0-9_.-]+([/][A-Za-z0-9_.-]+)*$/.test(v) &&
    !v.split("/").some(part => part === "." || part === "..");
  const isTemplate = v => typeof v === "string" && v.split("{id}").length === 2 && isPath(v.replace("{id}", "x"));
  const isTaskId = v => typeof v === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(v) && v !== "." && v !== "..";
  const isRef = v => v === undefined || v === null || (typeof v === "string" && /^[A-Za-z0-9_./-]{1,200}$/.test(v));

  function decode(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { return null; }
  }

  // ---- Workspaces: an explicit list from the private plan repo, never guessed from names.

  function validateWorkspaces(doc) {
    if (!isObject(doc) || doc.schema !== WORKSPACES_SCHEMA) return "not a " + WORKSPACES_SCHEMA + " document";
    if (!Array.isArray(doc.workspaces)) return "workspaces is not a list";
    const ids = new Set();
    for (const [i, w] of doc.workspaces.entries()) {
      const where = "workspace " + (i + 1) + ": ";
      if (!isObject(w) || typeof w.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(w.id)) return where + "bad id";
      if (ids.has(w.id)) return where + "repeated id";
      ids.add(w.id);
      if (!isText(w.label, 100)) return where + "bad label";
      if (!KINDS.includes(w.kind)) return where + "bad kind";
      if (w.plan !== null) {
        const p = w.plan;
        if (!isObject(p) || !SB.validRepo(p.repo) || !isRef(p.ref)) return where + "bad plan repository";
        if (!isObject(p.files) || !PLAN_FILES.every(f => isPath(p.files[f])) ||
            !TASK_FILES.every(f => p.files[f] === undefined || isTemplate(p.files[f])) ||
            Object.keys(p.files).some(f => !PLAN_FILES.includes(f) && !TASK_FILES.includes(f))) return where + "bad plan files";
      }
      if (!Array.isArray(w.code) || !w.code.every(c => isObject(c) && SB.validRepo(c.repo) && isRef(c.ref) &&
                                                        isText(c.role, 40))) return where + "bad code repositories";
      if (w.plan === null && w.code.length === 0) return where + "no repository";
    }
    return null;
  }

  function readWorkspaces(ctx, client, repo, ref) {
    return SB.guard(readWorkspacesUnguarded(ctx, client, repo, ref), { repo, ref: ref || null });
  }

  async function readWorkspacesUnguarded(ctx, client, repo, ref) {
    const pinned = await client.pin(ctx, repo, ref);
    if (pinned.state !== "current") return pinned;
    const { commit } = pinned.data;
    const file = await client.readFile(ctx, repo, commit, WORKSPACES_FILE);
    if (file.state !== "current") return file;
    const source = Object.assign({}, file.source, { ref: pinned.data.ref });
    let doc;
    try { doc = JSON.parse(decode(file.data.bytes)); } catch (e) { doc = undefined; }
    const problem = validateWorkspaces(doc);
    if (problem) return result("invalid", null, source, { error: problem });
    const state = doc.workspaces.length ? "current" : "empty";
    return result(state, { workspaces: doc.workspaces, commit, date: pinned.data.date }, source,
                  { schema: WORKSPACES_SCHEMA });
  }

  // ---- Plan table: rows for display, in order, with their fields as text. No totals.

  function splitRow(line) {
    // Cells of a Markdown table row; "\|" inside a cell is a literal bar.
    const cells = [];
    let cell = "";
    const body = line.trim().replace(/^[|]/, "").replace(/[|]$/, "");
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === BACKSLASH && body[i + 1] === "|") { cell += "|"; i++; continue; }
      if (c === "|") { cells.push(cell.trim()); cell = ""; continue; }
      cell += c;
    }
    cells.push(cell.trim());
    return cells;
  }

  function parsePlanTables(text) {
    // Every table whose first header cell is "ID", with the heading above it as its section.
    const lines = String(text).split("\n").map(l => l.replace(/[\r]$/, ""));
    const rows = [];
    const seen = new Set();
    let section = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) { section = heading[1].trim(); continue; }
      if (!line.trim().startsWith("|") || !/^\s*[|]?(\s*:?-+:?\s*[|])+\s*:?-*:?\s*$/.test(lines[i + 1] || "")) continue;
      const headers = splitRow(line);
      if (headers[0] !== "ID") continue;
      i += 2;
      for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
        const cells = splitRow(lines[i]);
        const fields = {};
        headers.forEach((h, n) => { fields[h] = n < cells.length ? cells[n] : ""; });
        let invalid = null;
        if (cells.length !== headers.length) invalid = "has " + cells.length + " cells, expected " + headers.length;
        else if (!fields.ID) invalid = "no ID";
        else if (seen.has(fields.ID)) invalid = "repeated ID";
        if (fields.ID) seen.add(fields.ID);
        rows.push({ id: fields.ID, section, line: i + 1, text: lines[i], fields, invalid });
      }
      i -= 1;
    }
    return rows;
  }

  function readPlan(ctx, client, repo, commit, files) {
    return SB.guard(readPlanUnguarded(ctx, client, repo, commit, files), { repo, commit, path: files.table });
  }

  async function readPlanUnguarded(ctx, client, repo, commit, files) {
    const file = await client.readFile(ctx, repo, commit, files.table);
    if (file.state !== "current") return file;
    const text = decode(file.data.bytes);
    if (text === null) return result("invalid", null, file.source, { error: "not UTF-8 text" });
    const rows = parsePlanTables(text);
    return result(rows.length ? "current" : "empty", { rows, invalid: rows.filter(r => r.invalid).length },
                  file.source);
  }

  // ---- Stored progress: current only if the producer and every input match the hashes inside it.

  function validateProgress(doc, files) {
    const sha = v => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
    const count = v => Number.isInteger(v) && v >= 0;
    const figures = t => isObject(t) && HOURS.every(f => typeof t[f] === "number" && Number.isFinite(t[f]) && t[f] >= 0) &&
      COUNTS.every(f => count(t[f])) && typeof t.verified === "boolean" && t.progress_pct <= 100;
    if (!isObject(doc) || doc.schema !== PROGRESS_SCHEMA) return "not a " + PROGRESS_SCHEMA + " document";
    if (doc.ok !== true) return "the producer reported errors";
    if (!count(doc.subtasks) || !count(doc.steps)) return "missing counts";
    const p = doc.producer;
    const i = doc.inputs;
    if (!isObject(p) || p.path !== files.producer || !sha(p.blob_sha)) return "producer is not this plan's";
    // The table and the record are this plan's; any further input (some producers read more files) is named
    // with its own path and hash, and is checked like the others.
    if (!isObject(i) || Object.keys(i).length > 10) return "inputs are malformed";
    for (const name of ["table", "record"]) {
      if (!isObject(i[name]) || i[name].path !== files[name] || !sha(i[name].blob_sha)) return name + " input is not this plan's";
    }
    for (const [name, item] of Object.entries(i)) {
      if (!/^[a-z_]{1,30}$/.test(name) || !isObject(item) || !isPath(item.path) || !sha(item.blob_sha)) return "input " + name + " is malformed";
    }
    if (!isObject(doc.scopes) || !SCOPES.every(n => figures(doc.scopes[n]))) return "a scope is missing or malformed";
    if (!Array.isArray(doc.phases) || doc.phases.length === 0) return "no phases";
    const goodCounts = c => isObject(c) && Object.keys(c).length === STATUSES.length && STATUSES.every(k => count(c[k]));
    const goodPhase = ph => isObject(ph) && typeof ph.id === "string" && /^P\d+$/.test(ph.id) && typeof ph.name === "string" &&
      figures(ph) && goodCounts(ph.status_counts);
    if (!doc.phases.every(goodPhase)) return "a phase is malformed";
    if (new Set(doc.phases.map(ph => ph.id)).size !== doc.phases.length) return "a phase ID is repeated";
    // Additive blocks: absent means the producer does not supply them; present means fully well formed.
    if (doc.stages !== undefined) {
      const phases = new Set(doc.phases.map(ph => ph.id));
      const used = new Set();
      const ids = new Set();
      const goodStage = st => isObject(st) && typeof st.id === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(st.id) &&
        !ids.has(st.id) && ids.add(st.id) && isText(st.name, 60) && (st.gate === null || isText(st.gate, 100)) &&
        Array.isArray(st.phases) && st.phases.length > 0 &&
        st.phases.every(id => phases.has(id) && !used.has(id) && used.add(id)) && figures(st);
      if (!Array.isArray(doc.stages) || doc.stages.length === 0 || !doc.stages.every(goodStage)) return "a stage is malformed";
    }
    if (doc.approved_results !== undefined) {
      const ids = new Set();
      const goodResult = a => isObject(a) && isTaskId(a.id) && !ids.has(a.id) && ids.add(a.id) && isText(a.approval, 200) &&
        Array.isArray(a.files) && a.files.length <= 50 && a.files.every(isPath) &&
        Array.isArray(a.rejected) && a.rejected.length <= 50 && a.rejected.every(r => typeof r === "string" && r.length <= 500);
      if (!Array.isArray(doc.approved_results) || !doc.approved_results.every(goodResult)) return "approved result files are malformed";
    }
    return null;
  }

  function readProgress(ctx, client, repo, commit, files) {
    return SB.guard(readProgressUnguarded(ctx, client, repo, commit, files), { repo, commit, path: files.progress });
  }

  async function readProgressUnguarded(ctx, client, repo, commit, files) {
    const file = await client.readFile(ctx, repo, commit, files.progress);
    if (file.state === "missing") return result("unavailable", null, file.source, { error: "no stored progress at this commit" });
    if (file.state !== "current") return file;
    let doc;
    try { doc = JSON.parse(decode(file.data.bytes)); } catch (e) { doc = undefined; }
    const problem = validateProgress(doc, files);
    if (problem) return result("invalid", null, file.source, { error: problem });
    for (const [name, item] of [["producer", doc.producer], ...Object.entries(doc.inputs)]) {
      const now = await client.readFile(ctx, repo, commit, item.path);
      if (now.state !== "current") {
        return result("stale", null, file.source, { error: name + " " + item.path + " unreadable at this commit (" + now.state + ")" });
      }
      if (now.data.sha !== item.blob_sha) {
        return result("stale", null, file.source, { error: name + " " + item.path + " changed since the result was made" });
      }
    }
    return result("current", doc, file.source, { schema: PROGRESS_SCHEMA });
  }

  // ---- A task's brief or handover: the configured template with the task's ID, at the pinned commit.

  function readTaskFile(ctx, client, repo, commit, template, id) {
    const path = isTemplate(template) && isTaskId(id) ? template.replace("{id}", id) : null;
    return SB.guard(readTaskFileUnguarded(ctx, client, repo, commit, path), { repo, commit, path });
  }

  async function readTaskFileUnguarded(ctx, client, repo, commit, path) {
    if (!path) return result("invalid", null, { repo, commit, path }, { error: "no valid file for this task" });
    const file = await client.readFile(ctx, repo, commit, path);
    if (file.state !== "current") return file;
    const text = decode(file.data.bytes);
    if (text === null) return result("invalid", null, file.source, { error: "not UTF-8 text" });
    return result(text.trim() ? "current" : "empty", { text }, file.source);
  }

  // ---- Check runs (needs the token's Checks: read; shown as unavailable when not granted).

  function readCheckRuns(ctx, client, repo, commit) {
    return SB.guard(readCheckRunsUnguarded(ctx, client, repo, commit), { repo, commit });
  }

  async function readCheckRunsUnguarded(ctx, client, repo, commit) {
    const source = { repo, commit };
    const runs = [];
    let total = 0;
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const res = await client.get(ctx, "/repos/" + repo + "/commits/" + commit + "/check-runs?per_page=100&page=" + page);
      if (res.status === 403 || res.status === 404) {
        const state = client.stateFor(res);
        if (state === "rate-limited") return result(state, null, source, { error: "HTTP " + res.status });
        return result("unavailable", null, source, { error: "check runs not readable with this token (Checks: read)" });
      }
      if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
      const body = await client.json(ctx, res);
      if (!isObject(body) || !Number.isInteger(body.total_count) || body.total_count < 0 ||
          !Array.isArray(body.check_runs) || body.check_runs.length > 100 ||
          (page > 1 && body.total_count !== total)) {
        return result("invalid", null, source, { error: "unexpected check-runs reply" });
      }
      total = body.total_count;
      for (const run of body.check_runs) {
        if (!isObject(run) || typeof run.name !== "string" || typeof run.status !== "string" ||
            !(run.conclusion === null || typeof run.conclusion === "string")) {
          return result("invalid", null, source, { error: "malformed check run" });
        }
        runs.push({ name: run.name, status: run.status, conclusion: run.conclusion });
      }
      if (runs.length > total) return result("invalid", null, source, { error: "more check runs than the reported total" });
      if (runs.length === total || body.check_runs.length === 0) break;
    }
    // Empty only when GitHub reports none; fewer read than reported is partial, even if none were read.
    if (runs.length < total) return result("partial", { runs }, source, { coverage: { shown: runs.length, total } });
    if (!runs.length) return result("empty", { runs }, source);
    return result("current", { runs }, source);
  }

  // ---- Pull requests and their comments, for a task's review cycle. These are read live,
  // not at the pinned commit: a pull request's state, head and comments are GitHub's now.

  const MAX_PULL_PAGES = 3;
  const MAX_COMMENT_PAGES = 5;
  const PULL_STATES = ["open", "closed"];
  const isSha = v => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
  const isTime = v => v === null || (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)));

  function readPulls(ctx, client, repo) {
    return SB.guard(readPullsUnguarded(ctx, client, repo), { repo });
  }

  async function readPullsUnguarded(ctx, client, repo) {
    const source = { repo };
    const pulls = [];
    for (let page = 1; page <= MAX_PULL_PAGES; page++) {
      const res = await client.get(ctx, "/repos/" + repo + "/pulls?state=all&per_page=100&page=" + page);
      if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
      const body = await client.json(ctx, res);
      if (!Array.isArray(body) || body.length > 100) return result("invalid", null, source, { error: "unexpected pull request list" });
      for (const pr of body) {
        if (!isObject(pr) || !Number.isInteger(pr.number) || pr.number < 1 || typeof pr.title !== "string" ||
            !PULL_STATES.includes(pr.state) || !isObject(pr.head) || !isSha(pr.head.sha) ||
            !isTime(pr.merged_at === undefined ? null : pr.merged_at) ||
            !(pr.merge_commit_sha === null || pr.merge_commit_sha === undefined || isSha(pr.merge_commit_sha)) ||
            !(pr.body === null || pr.body === undefined || typeof pr.body === "string")) {
          return result("invalid", null, source, { error: "malformed pull request" });
        }
        pulls.push({ number: pr.number, title: pr.title.slice(0, 300), state: pr.state, head: pr.head.sha,
                     merged: pr.merged_at || null, mergeCommit: pr.merged_at ? pr.merge_commit_sha || null : null,
                     body: (pr.body || "").slice(0, 20000) });
      }
      // A full last page may hide more: the list is then marked partial.
      if (body.length < 100) return result(pulls.length ? "current" : "empty", { pulls }, source);
    }
    return result("partial", { pulls }, source, { coverage: { shown: pulls.length, total: null } });
  }

  function readComments(ctx, client, repo, number) {
    return SB.guard(readCommentsUnguarded(ctx, client, repo, number), { repo, number });
  }

  async function readCommentsUnguarded(ctx, client, repo, number) {
    const source = { repo, number };
    if (!Number.isInteger(number) || number < 1) return result("invalid", null, source, { error: "not a pull request number" });
    const comments = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const res = await client.get(ctx, "/repos/" + repo + "/issues/" + number + "/comments?per_page=100&page=" + page);
      if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
      const body = await client.json(ctx, res);
      if (!Array.isArray(body) || body.length > 100) return result("invalid", null, source, { error: "unexpected comment list" });
      for (const c of body) {
        if (!isObject(c) || typeof c.body !== "string" || !isTime(c.created_at || null)) {
          return result("invalid", null, source, { error: "malformed comment" });
        }
        comments.push({ body: c.body.slice(0, 20000), at: c.created_at || null });
      }
      if (body.length < 100) return result(comments.length ? "current" : "empty", { comments }, source);
    }
    return result("partial", { comments }, source, { coverage: { shown: comments.length, total: null } });
  }

  // ---- One workspace: every read it needs, in order, each with its own result.
  // A failure stops only the reads that depend on it, never other workspaces.

  async function readWorkspace(ctx, client, w) {
    const entries = [];
    if (w.plan) {
      const pinned = await client.pin(ctx, w.plan.repo, w.plan.ref);
      entries.push({ kind: "plan", label: "Plan " + w.plan.repo, result: pinned });
      if (pinned.state === "current") {
        const commit = pinned.data.commit;
        entries.push({ kind: "table", label: "Task table", result: await readPlan(ctx, client, w.plan.repo, commit, w.plan.files) });
        entries.push({ kind: "progress", label: "Stored progress", result: await readProgress(ctx, client, w.plan.repo, commit, w.plan.files) });
      }
    }
    for (const code of w.code) {
      const pinned = await client.pin(ctx, code.repo, code.ref);
      entries.push({ kind: "code", label: "Code " + code.repo + " (" + code.role + ")", result: pinned });
      if (pinned.state === "current") {
        entries.push({ kind: "checks", label: "Check runs", result: await readCheckRuns(ctx, client, code.repo, pinned.data.commit) });
      }
    }
    return entries;
  }

  Object.assign(SB, { WORKSPACES_FILE, STATUSES, SCOPES, readWorkspace, readTaskFile, isPath, validateWorkspaces, readWorkspaces, splitRow, parsePlanTables, readPlan,
                      validateProgress, readProgress, readCheckRuns, readPulls, readComments });
})(typeof window !== "undefined" ? window : globalThis);
