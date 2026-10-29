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

  // keepMark keeps a leading byte order mark (U+FEFF) as text, so a code view can show it.
  function decode(bytes, keepMark = false) {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: keepMark }).decode(bytes); } catch (e) { return null; }
  }

  // ---- Workspaces: an explicit list from the private plan repo, never guessed from names.

  // A plan's files: every required path, optional per-task templates, nothing else.
  const isPlanFiles = files => isObject(files) && PLAN_FILES.every(f => isPath(files[f])) &&
    TASK_FILES.every(f => files[f] === undefined || isTemplate(files[f])) &&
    !Object.keys(files).some(f => !PLAN_FILES.includes(f) && !TASK_FILES.includes(f));

  function validateWorkspaces(doc) {
    if (!isObject(doc) || doc.schema !== WORKSPACES_SCHEMA) return "not a " + WORKSPACES_SCHEMA + " document";
    if (!Array.isArray(doc.workspaces)) return "workspaces is not a list";
    // Optional: the plan files a repository found through the token is read with.
    if (doc.found !== undefined && !(isObject(doc.found) && isPlanFiles(doc.found.files) && Object.keys(doc.found).length === 1)) return "bad found plan files";
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
        if (!isPlanFiles(p.files)) return where + "bad plan files";
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
    return result(state, { workspaces: doc.workspaces, found: doc.found ? doc.found.files : null, commit, date: pinned.data.date }, source,
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

  // pages: how many pages of 100 to read at most (3 for a review cycle, 1 for an activity feed).
  function readPulls(ctx, client, repo, pages) {
    return SB.guard(readPullsUnguarded(ctx, client, repo, pages || MAX_PULL_PAGES), { repo });
  }

  async function readPullsUnguarded(ctx, client, repo, pages) {
    const source = { repo };
    const pulls = [];
    for (let page = 1; page <= Math.min(pages, MAX_PULL_PAGES); page++) {
      const res = await client.get(ctx, "/repos/" + repo + "/pulls?state=all&per_page=100&page=" + page);
      if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
      const body = await client.json(ctx, res);
      if (!Array.isArray(body) || body.length > 100) return result("invalid", null, source, { error: "unexpected pull request list" });
      for (const pr of body) {
        if (!isObject(pr) || !Number.isInteger(pr.number) || pr.number < 1 || typeof pr.title !== "string" ||
            !PULL_STATES.includes(pr.state) || !isObject(pr.head) || !isSha(pr.head.sha) ||
            !isTime(pr.merged_at === undefined ? null : pr.merged_at) ||
            !isTime(pr.created_at === undefined ? null : pr.created_at) || !isTime(pr.closed_at === undefined ? null : pr.closed_at) ||
            !(pr.merge_commit_sha === null || pr.merge_commit_sha === undefined || isSha(pr.merge_commit_sha)) ||
            !(pr.body === null || pr.body === undefined || typeof pr.body === "string")) {
          return result("invalid", null, source, { error: "malformed pull request" });
        }
        pulls.push({ number: pr.number, title: pr.title.slice(0, 300), state: pr.state, head: pr.head.sha,
                     merged: pr.merged_at || null, mergeCommit: pr.merged_at ? pr.merge_commit_sha || null : null,
                     created: pr.created_at || null, closed: pr.closed_at || null,
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

  // ---- The repository overview: languages, and the recent evidence of an activity feed. Read live:
  // GitHub counts languages on the default branch, and comments are GitHub's now. None of it is progress.

  const COMMIT_LIMIT = 30;
  const REPO_COMMENT_LIMIT = 50;

  // Bytes of code per language, as GitHub counts them; largest first.
  function readLanguages(ctx, client, repo) {
    return SB.guard(readLanguagesUnguarded(ctx, client, repo), { repo });
  }

  async function readLanguagesUnguarded(ctx, client, repo) {
    const source = { repo };
    if (!SB.validRepo(repo)) return result("invalid", null, source, { error: "not a repository name" });
    const res = await client.get(ctx, "/repos/" + repo + "/languages");
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const body = await client.json(ctx, res);
    if (!isObject(body) || Object.keys(body).length > 200 ||
        !Object.entries(body).every(([k, v]) => isText(k, 60) && Number.isSafeInteger(v) && v >= 0)) {
      return result("invalid", null, source, { error: "unexpected languages reply" });
    }
    const languages = Object.entries(body).map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
    return result(languages.length ? "current" : "empty", { languages }, source);
  }

  // The latest commits reachable from a pinned commit, newest first: at most 30, and partial when 30 came back.
  function readCommits(ctx, client, repo, commit) {
    return SB.guard(readCommitsUnguarded(ctx, client, repo, commit), { repo, commit });
  }

  async function readCommitsUnguarded(ctx, client, repo, commit) {
    const source = { repo, commit };
    if (!SB.validRepo(repo) || !isSha(commit)) return result("invalid", null, source, { error: "not a valid repository or commit" });
    const res = await client.get(ctx, "/repos/" + repo + "/commits?sha=" + commit + "&per_page=" + COMMIT_LIMIT);
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const body = await client.json(ctx, res);
    if (!Array.isArray(body) || body.length > COMMIT_LIMIT) return result("invalid", null, source, { error: "unexpected commit list" });
    const commits = [];
    for (const c of body) {
      const at = isObject(c) && isObject(c.commit) && isObject(c.commit.committer) ? c.commit.committer.date : undefined;
      if (!isObject(c) || !isSha(c.sha) || !isObject(c.commit) || typeof c.commit.message !== "string" || !isTime(at === undefined ? null : at)) {
        return result("invalid", null, source, { error: "malformed commit" });
      }
      commits.push({ sha: c.sha, title: c.commit.message.split("\n")[0].slice(0, 200), at: at || null,
                     parents: Array.isArray(c.parents) ? c.parents.length : null });
    }
    if (commits.length === COMMIT_LIMIT) return result("partial", { commits }, source, { coverage: { shown: commits.length, total: null } });
    return result(commits.length ? "current" : "empty", { commits }, source);
  }

  // The latest comments on a repository's issues and pull requests, newest first, each with the number
  // it was posted on. Needs the same permission as a pull request's comments; without it, unavailable.
  function readRepoComments(ctx, client, repo) {
    return SB.guard(readRepoCommentsUnguarded(ctx, client, repo), { repo });
  }

  async function readRepoCommentsUnguarded(ctx, client, repo) {
    const source = { repo };
    if (!SB.validRepo(repo)) return result("invalid", null, source, { error: "not a repository name" });
    const res = await client.get(ctx, "/repos/" + repo + "/issues/comments?sort=created&direction=desc&per_page=" + REPO_COMMENT_LIMIT);
    if (res.status === 403 || res.status === 404) {
      const state = client.stateFor(res);
      if (state === "rate-limited") return result(state, null, source, { error: "HTTP " + res.status });
      return result("unavailable", null, source, { error: "comments not readable with this token (Pull requests: read)" });
    }
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const body = await client.json(ctx, res);
    if (!Array.isArray(body) || body.length > REPO_COMMENT_LIMIT) return result("invalid", null, source, { error: "unexpected comment list" });
    const comments = [];
    for (const c of body) {
      const m = isObject(c) && typeof c.issue_url === "string" ? /[/]issues[/]([1-9][0-9]{0,8})$/.exec(c.issue_url) : null;
      if (!m || typeof c.body !== "string" || !isTime(c.created_at || null)) return result("invalid", null, source, { error: "malformed comment" });
      comments.push({ number: Number(m[1]), body: c.body.slice(0, 20000), at: c.created_at || null });
    }
    if (comments.length === REPO_COMMENT_LIMIT) return result("partial", { comments }, source, { coverage: { shown: comments.length, total: null } });
    return result(comments.length ? "current" : "empty", { comments }, source);
  }

  // The signed-in account's login and type: who the token reads as. Nothing else about the account is read.
  function readUser(ctx, client) {
    return SB.guard(readUserUnguarded(ctx, client), {});
  }

  async function readUserUnguarded(ctx, client) {
    const res = await client.get(ctx, "/user");
    if (!res.ok) return result(client.stateFor(res), null, {}, { error: "HTTP " + res.status });
    const body = await client.json(ctx, res);
    if (!isObject(body) || typeof body.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(body.login)) {
      return result("invalid", null, {}, { error: "unexpected account reply" });
    }
    return result("current", { login: body.login, type: ["User", "Organization", "Bot"].includes(body.type) ? body.type : null }, {});
  }

  // ---- The Atlas account, read only when asked: the account's public profile and its public events.
  // The login is the one the token reads as. Text fields are kept short; nothing else is kept.

  const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
  const nonNegative = v => Number.isInteger(v) && v >= 0 ? v : null;
  const shortText = (v, max) => typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;

  function readProfile(ctx, client, login) {
    return SB.guard(readProfileUnguarded(ctx, client, login), { login });
  }
  async function readProfileUnguarded(ctx, client, login) {
    const source = { login };
    if (typeof login !== "string" || !LOGIN.test(login)) return result("invalid", null, source, { error: "not a login" });
    const res = await client.get(ctx, "/users/" + login);
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const u = await client.json(ctx, res);
    if (!isObject(u) || typeof u.login !== "string" || u.login.toLowerCase() !== login.toLowerCase() || !isTime(time(u.created_at))) {
      return result("invalid", null, source, { error: "unexpected profile reply" });
    }
    return result("current", {
      login: u.login, type: ["User", "Organization", "Bot"].includes(u.type) ? u.type : null,
      name: shortText(u.name, 100), bio: shortText(u.bio, 300), location: shortText(u.location, 100), company: shortText(u.company, 100),
      // The website is kept as text and never linked: only GitHub's own pages are.
      blog: shortText(u.blog, 200),
      followers: nonNegative(u.followers), following: nonNegative(u.following), since: u.created_at ? Date.parse(u.created_at) : null,
      // The profile page only when GitHub gives an https address whose path is this login, as for repositories.
      web: SB.webAddress(u.html_url, u.login),
    }, source);
  }

  // A list about the account, 100 a page and at most 3 pages, newest first as GitHub gives it: each entry
  // kept by pick, or left out and counted when it is not in the expected form. A later page that fails
  // keeps what came before it, said as partial with why; three full pages are partial too.
  const EVENT_PAGES = 3;
  async function userPages(ctx, client, login, path, name, pick, query) {
    const source = { login };
    if (typeof login !== "string" || !LOGIN.test(login)) return result("invalid", null, source, { error: "not a login" });
    const items = [];
    let skipped = 0;
    for (let page = 1; page <= EVENT_PAGES; page++) {
      const res = await client.get(ctx, "/users/" + login + path + "?" + (query || "") + "per_page=100&page=" + page);
      if (!res.ok) {
        if (page > 1) return result("partial", { [name]: items, skipped, stopped: "HTTP " + res.status }, source, { error: "HTTP " + res.status });
        return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
      }
      const body = await client.json(ctx, res);
      if (!Array.isArray(body) || body.length > 100) return result("invalid", null, source, { error: "unexpected " + name + " list" });
      for (const x of body) { const v = isObject(x) ? pick(x, login) : null; if (v) items.push(v); else skipped++; }
      if (body.length < 100) return result(items.length ? "current" : "empty", { [name]: items, skipped, stopped: null }, source);
    }
    return result("partial", { [name]: items, skipped, stopped: null }, source, { coverage: { shown: items.length, total: null } });
  }

  // Public events: GitHub keeps at most 300, from the last 90 days. An event keeps its type, time,
  // repository, a push's commit count, the action word and the kind of ref; never a message or actor.
  function readPublicEvents(ctx, client, login) {
    return SB.guard(userPages(ctx, client, login, "/events/public", "events", e => {
      const p = isObject(e.payload) ? e.payload : {};
      const at = typeof e.created_at === "string" && isTime(e.created_at) ? Date.parse(e.created_at) : NaN;
      if (typeof e.type !== "string" || !/^[A-Za-z]{1,40}$/.test(e.type) || Number.isNaN(at) || !isObject(e.repo) || !SB.validRepo(e.repo.name)) return null;
      const size = nonNegative(p.size) || nonNegative(p.distinct_size) || null;
      return { type: e.type, at, repo: e.repo.name, size: size && size <= 100000 ? size : null,
               action: typeof p.action === "string" && /^[a-z_]{1,30}$/.test(p.action) ? p.action : null,
               refType: ["branch", "tag", "repository"].includes(p.ref_type) ? p.ref_type : null };
    }), { login });
  }

  const timeOf = v => typeof v === "string" && isTime(v) ? Date.parse(v) : null;

  // Repositories the account starred, most recently starred first: name, description, language, stars,
  // last push and its page at GitHub's own address.
  function readStarred(ctx, client, login) {
    return SB.guard(userPages(ctx, client, login, "/starred", "repos", r => {
      if (!SB.validRepo(r.full_name)) return null;
      return { repo: r.full_name, description: shortText(r.description, 300), language: shortText(r.language, 40),
               stars: nonNegative(r.stargazers_count), pushed: timeOf(r.pushed_at), archived: r.archived === true, fork: r.fork === true,
               web: SB.webAddress(r.html_url, r.full_name) };
    }), { login });
  }

  // An account's own public repositories, most recently pushed first (so a cut list keeps the newest
  // work): name, fork, stars, language and last push. Used only to compare two accounts.
  function readUserRepos(ctx, client, login) {
    return SB.guard(userPages(ctx, client, login, "/repos", "repos", r => {
      if (!SB.validRepo(r.full_name)) return null;
      return { repo: r.full_name, fork: r.fork === true, stars: nonNegative(r.stargazers_count), language: shortText(r.language, 40), pushed: timeOf(r.pushed_at) };
    }, "sort=pushed&"), { login });
  }

  // The account's public gists, newest first: description, file names with their language and size,
  // whether GitHub cut its own list of the gist's files (then the count is only a lower bound), times,
  // and the gist's page only when GitHub gives it at an https address ending in its ID.
  const GIST_ID = /^[0-9a-f]{1,64}$/;
  function gistPage(value, login, id) {
    if (typeof value !== "string") return null;
    let url;
    try { url = new URL(value); } catch (e) { return null; }
    const path = url.pathname.toLowerCase();
    if (url.protocol.slice(0, -1) !== "https" || url.username || url.password || url.search || url.hash ||
        !(path === "/" + id || path === "/" + login.toLowerCase() + "/" + id)) return null;
    return url.origin + url.pathname;
  }
  function readGists(ctx, client, login) {
    return SB.guard(userPages(ctx, client, login, "/gists", "gists", (g, who) => {
      if (typeof g.id !== "string" || !GIST_ID.test(g.id) || !isObject(g.files)) return null;
      const files = Object.values(g.files).filter(f => isObject(f) && typeof f.filename === "string" && f.filename && f.filename.length <= 255)
        .slice(0, 50).map(f => ({ name: f.filename, language: shortText(f.language, 40), size: nonNegative(f.size) }));
      return { id: g.id, description: shortText(g.description, 300), files, more: Math.max(0, Object.keys(g.files).length - files.length), cut: g.truncated === true,
               created: timeOf(g.created_at), updated: timeOf(g.updated_at), comments: nonNegative(g.comments), web: gistPage(g.html_url, who, g.id) };
    }), { login });
  }

  // ---- The repositories the token can read, as GitHub lists them: names only, 100 a page, up to 9
  // pages. A list that still goes on after the last page is partial.

  const ACCOUNT_PAGE = 100;
  const MAX_ACCOUNT_PAGES = 9;

  function readAccountRepos(ctx, client) {
    return SB.guard(readAccountReposUnguarded(ctx, client), {});
  }

  async function readAccountReposUnguarded(ctx, client) {
    const repos = [];
    for (let page = 1; page <= MAX_ACCOUNT_PAGES; page++) {
      const res = await client.get(ctx, "/user/repos?per_page=" + ACCOUNT_PAGE + "&page=" + page);
      if (!res.ok) return result(client.stateFor(res), null, {}, { error: "HTTP " + res.status });
      const body = await client.json(ctx, res);
      if (!Array.isArray(body) || body.length > ACCOUNT_PAGE || !body.every(r => isObject(r) && SB.validRepo(r.full_name))) {
        return result("invalid", null, {}, { error: "unexpected repository list" });
      }
      for (const r of body) if (!repos.includes(r.full_name)) repos.push(r.full_name);
      if (body.length < ACCOUNT_PAGE) return result(repos.length ? "current" : "empty", { repos: repos.sort() }, {});
    }
    return result("partial", { repos: repos.sort() }, {}, { coverage: { shown: repos.length, total: null } });
  }

  // ---- The plan repository, when sign-in gives only its owner or nothing: every repository the token
  // can read (of that owner, in any case) is checked for the workspace list file at its default branch,
  // a few at a time, up to FIND_LIMIT. The repositories that have it are returned, with those that
  // could not be checked; the caller uses one only when the search is complete and found only it.
  // Nothing is guessed from names.

  const FIND_LIMIT = 50;
  const FIND_BATCH = 5;

  function findPlanRepos(ctx, client, owner) {
    return SB.guard(findPlanReposUnguarded(ctx, client, owner), { owner: owner || null });
  }

  async function findPlanReposUnguarded(ctx, client, owner) {
    const listed = await readAccountRepos(ctx, client);
    if (!["current", "empty", "partial"].includes(listed.state)) return listed;
    const of = listed.state === "empty" ? [] : listed.data.repos.filter(r => !owner || r.split("/")[0].toLowerCase() === owner.toLowerCase());
    const checked = of.slice(0, FIND_LIMIT);
    const repos = [], unchecked = [];
    for (let i = 0; i < checked.length; i += FIND_BATCH) {
      const batch = await Promise.all(checked.slice(i, i + FIND_BATCH).map(async repo => {
        const pinned = await client.pin(ctx, repo, "");
        // Not found, or a repository with no commits yet (409): it has no workspace list.
        if (pinned.state === "missing" || pinned.error === "HTTP 409") return [repo, "absent"];
        if (pinned.state !== "current") return [repo, "unchecked"];
        const file = await client.readFile(ctx, repo, pinned.data.commit, WORKSPACES_FILE);
        return [repo, file.state === "current" ? "found" : file.state === "missing" ? "absent" : "unchecked"];
      }));
      for (const [repo, how] of batch) if (how === "found") repos.push(repo); else if (how === "unchecked") unchecked.push(repo);
    }
    // The search is complete only when the token's list was whole, under the limit, and every
    // repository in it answered whether it has the file.
    const listedAll = listed.state !== "partial", underLimit = checked.length === of.length;
    return result(repos.length ? "current" : "empty", { repos, checked: checked.length, unchecked, listedAll, underLimit,
                                                       complete: listedAll && underLimit && !unchecked.length }, { owner: owner || null });
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

  // ---- History (branches, tags, the commits behind a pinned commit, and how a branch compares).
  // Every reply says when it may hold more; the commits behind a commit are read page by page with no
  // last page. A login is kept from a commit, never a name or email address.

  const HISTORY_PAGE = 100;
  const MAX_REF_PAGES = 3;
  const isLogin = v => typeof v === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(v);

  // One commit as the list and compare replies give it, or null when it is not in that form.
  function historyCommit(c) {
    const at = isObject(c) && isObject(c.commit) && isObject(c.commit.committer) ? c.commit.committer.date : undefined;
    if (!isObject(c) || !isSha(c.sha) || !isObject(c.commit) || typeof c.commit.message !== "string" || !isTime(at === undefined ? null : at) ||
        !Array.isArray(c.parents) || c.parents.length > 8 || !c.parents.every(p => isObject(p) && isSha(p.sha))) return null;
    return { sha: c.sha, title: c.commit.message.split("\n")[0].slice(0, 200), at: at || null, parents: c.parents.map(p => p.sha),
             author: isObject(c.author) && isLogin(c.author.login) ? c.author.login : null };
  }

  // One page of the history behind a pinned commit, newest first. A full page may have more behind it.
  function readHistoryPage(ctx, client, repo, commit, page) {
    return SB.guard(readHistoryPageUnguarded(ctx, client, repo, commit, page), { repo, commit, page });
  }

  async function readHistoryPageUnguarded(ctx, client, repo, commit, page) {
    const source = { repo, commit, page };
    // The same pages the allowlist lets through: 1 to 999,999,999.
    if (!SB.validRepo(repo) || !isSha(commit) || !Number.isSafeInteger(page) || page < 1 || page > 999999999) {
      return result("invalid", null, source, { error: "not a valid repository, commit or page" });
    }
    const res = await client.get(ctx, "/repos/" + repo + "/commits?sha=" + commit + "&per_page=" + HISTORY_PAGE + "&page=" + page);
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const body = await client.json(ctx, res);
    if (!Array.isArray(body) || body.length > HISTORY_PAGE) return result("invalid", null, source, { error: "unexpected commit list" });
    const commits = body.map(historyCommit);
    if (commits.some(c => !c)) return result("invalid", null, source, { error: "malformed commit" });
    if (commits.length === HISTORY_PAGE) return result("partial", { commits, end: false }, source, { coverage: { shown: commits.length, total: null } });
    return result(commits.length ? "current" : "empty", { commits, end: true }, source);
  }

  // A repository's branches or tags as GitHub lists them now, each with the commit it points at.
  function readRefs(ctx, client, repo, kind) {
    return SB.guard(readRefsUnguarded(ctx, client, repo, kind), { repo, kind });
  }

  async function readRefsUnguarded(ctx, client, repo, kind) {
    const source = { repo, kind };
    if (!SB.validRepo(repo) || !["branches", "tags"].includes(kind)) return result("invalid", null, source, { error: "not a valid repository or list" });
    const refs = [];
    for (let page = 1; page <= MAX_REF_PAGES; page++) {
      const res = await client.get(ctx, "/repos/" + repo + "/" + kind + "?per_page=100&page=" + page);
      if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
      const body = await client.json(ctx, res);
      if (!Array.isArray(body) || body.length > 100) return result("invalid", null, source, { error: "unexpected " + kind + " list" });
      for (const r of body) {
        if (!isObject(r) || typeof r.name !== "string" || !/^[^\u0000-\u001f]{1,250}$/.test(r.name) || !isObject(r.commit) || !isSha(r.commit.sha) ||
            !(r.protected === undefined || typeof r.protected === "boolean")) {
          return result("invalid", null, source, { error: "malformed " + (kind === "tags" ? "tag" : "branch") });
        }
        refs.push(kind === "tags" ? { name: r.name, sha: r.commit.sha } : { name: r.name, sha: r.commit.sha, protected: r.protected === undefined ? null : r.protected });
      }
      if (body.length < 100) return result(refs.length ? "current" : "empty", { refs }, source);
    }
    return result("partial", { refs }, source, { coverage: { shown: refs.length, total: null } });
  }

  // How one commit compares with another: GitHub's ahead and behind counts and their merge base.
  // Only the counts are read here (one commit per page); a branch's own commits are read apart.
  const COMPARE_STATES = ["ahead", "behind", "diverged", "identical"];
  function readCompare(ctx, client, repo, base, head) {
    return SB.guard(readCompareUnguarded(ctx, client, repo, base, head), { repo, base, head });
  }

  async function readCompareUnguarded(ctx, client, repo, base, head) {
    const source = { repo, base, head };
    if (!SB.validRepo(repo) || !isSha(base) || !isSha(head)) return result("invalid", null, source, { error: "not a valid repository or commit" });
    const res = await client.get(ctx, "/repos/" + repo + "/compare/" + base + "..." + head + "?per_page=1");
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const b = await client.json(ctx, res);
    const count = v => Number.isInteger(v) && v >= 0;
    if (!isObject(b) || !COMPARE_STATES.includes(b.status) || !count(b.ahead_by) || !count(b.behind_by) ||
        !(b.merge_base_commit === undefined || b.merge_base_commit === null || (isObject(b.merge_base_commit) && isSha(b.merge_base_commit.sha)))) {
      return result("invalid", null, source, { error: "unexpected comparison" });
    }
    return result("current", { status: b.status, ahead: b.ahead_by, behind: b.behind_by,
                               base: b.merge_base_commit && b.merge_base_commit.sha ? b.merge_base_commit.sha : null }, source);
  }

  // ---- Work evidence: a repository's pull requests (with their reviews), issues, Actions runs and
  // releases, one page of 100 at a time, as GitHub lists them now. Read live, never at the pinned
  // commit, and only ever read: nothing here creates, comments, reviews, merges, reruns or publishes.
  // People are kept by login only.

  const WORK_PAGE = 100;
  const MAX_WORK_PAGES = 9;
  const LIST_STATES = ["open", "closed", "all"];
  const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"];
  const RUN_STATUSES = ["queued", "in_progress", "completed", "waiting", "requested", "pending"];
  const RUN_CONCLUSIONS = ["success", "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale", "startup_failure"];
  const ISSUE_REASONS = ["completed", "not_planned", "reopened", "duplicate"];
  const loginOf = u => isObject(u) && isLogin(u.login) ? u.login : null;
  const time = v => v === undefined ? null : v;
  const isRefName = v => typeof v === "string" && /^[^\u0000-\u001f]{1,250}$/.test(v);
  const logins = list => Array.isArray(list) ? list.map(loginOf).filter(Boolean).slice(0, 50) : [];
  const workPage = (repo, state, page) => SB.validRepo(repo) && (state === null || LIST_STATES.includes(state)) &&
    Number.isInteger(page) && page >= 1 && page <= MAX_WORK_PAGES;
  // A full page may have more behind it; a shorter one is the end of the list.
  const pageResult = (items, extra, source) => items.length === WORK_PAGE
    ? result("partial", Object.assign({ end: false }, extra), source, { coverage: { shown: items.length, total: null } })
    : result(items.length ? "current" : "empty", Object.assign({ end: true }, extra), source);
  // Lists that need a permission the token may lack (pull requests and their reviews, issues, Actions) say so as unavailable.
  async function getList(ctx, client, path, source, permission) {
    const res = await client.get(ctx, path);
    if (permission && (res.status === 403 || res.status === 404)) {
      const state = client.stateFor(res);
      if (state === "rate-limited") return { out: result(state, null, source, { error: "HTTP " + res.status }) };
      return { out: result("unavailable", null, source, { error: "not readable with this token (" + permission + ")" }) };
    }
    if (!res.ok) return { out: result(client.stateFor(res), null, source, { error: "HTTP " + res.status }) };
    return { body: await client.json(ctx, res) };
  }

  function pullOf(pr) {
    if (!isObject(pr) || !Number.isInteger(pr.number) || pr.number < 1 || typeof pr.title !== "string" || !PULL_STATES.includes(pr.state) ||
        !isObject(pr.head) || !isSha(pr.head.sha) || !(pr.head.ref === undefined || isRefName(pr.head.ref)) ||
        !(pr.base === undefined || (isObject(pr.base) && (pr.base.ref === undefined || isRefName(pr.base.ref)))) ||
        !(pr.draft === undefined || typeof pr.draft === "boolean") ||
        !["merged_at", "created_at", "updated_at", "closed_at"].every(k => isTime(time(pr[k])))) return null;
    return { number: pr.number, title: pr.title.slice(0, 300), state: pr.state, draft: pr.draft === true, merged: time(pr.merged_at),
             head: pr.head.sha, headRef: pr.head.ref || null, headRepo: isObject(pr.head.repo) && SB.validRepo(pr.head.repo.full_name) ? pr.head.repo.full_name : null,
             mergeCommit: isSha(pr.merge_commit_sha) ? pr.merge_commit_sha : null, baseRef: pr.base && pr.base.ref ? pr.base.ref : null, author: loginOf(pr.user),
             reviewers: logins(pr.requested_reviewers), teams: Array.isArray(pr.requested_teams) ? pr.requested_teams.length : 0,
             created: time(pr.created_at), updated: time(pr.updated_at), closed: time(pr.closed_at) };
  }

  function readPullPage(ctx, client, repo, state, page) {
    return SB.guard(readPullPageUnguarded(ctx, client, repo, state, page), { repo, state, page });
  }
  async function readPullPageUnguarded(ctx, client, repo, state, page) {
    const source = { repo, state, page };
    if (!workPage(repo, state, page) || state === null) return result("invalid", null, source, { error: "not a valid repository, list or page" });
    const { out, body } = await getList(ctx, client, "/repos/" + repo + "/pulls?state=" + state + "&per_page=" + WORK_PAGE + "&page=" + page, source, "Pull requests: read");
    if (out) return out;
    if (!Array.isArray(body) || body.length > WORK_PAGE) return result("invalid", null, source, { error: "unexpected pull request list" });
    const pulls = body.map(pullOf);
    if (pulls.some(x => !x)) return result("invalid", null, source, { error: "malformed pull request" });
    return pageResult(pulls, { pulls }, source);
  }

  // The commits of a pull request, as GitHub lists them on its first page (at most 100), by ID only.
  function readPullCommits(ctx, client, repo, number) {
    return SB.guard(readPullCommitsUnguarded(ctx, client, repo, number), { repo, number });
  }
  async function readPullCommitsUnguarded(ctx, client, repo, number) {
    const source = { repo, number };
    if (!SB.validRepo(repo) || !Number.isInteger(number) || number < 1 || number > 999999999) return result("invalid", null, source, { error: "not a pull request" });
    const { out, body } = await getList(ctx, client, "/repos/" + repo + "/pulls/" + number + "/commits?per_page=100&page=1", source, "Pull requests: read");
    if (out) return out;
    if (!Array.isArray(body) || body.length > 100 || !body.every(c => isObject(c) && isSha(c.sha))) return result("invalid", null, source, { error: "unexpected commit list" });
    const shas = body.map(c => c.sha);
    return shas.length === 100 ? result("partial", { shas }, source, { coverage: { shown: 100, total: null } }) : result(shas.length ? "current" : "empty", { shas }, source);
  }

  // A pull request's reviews, oldest first, each with the commit it was given at.
  const MAX_REVIEW_PAGES = 3;
  function readReviews(ctx, client, repo, number) {
    return SB.guard(readReviewsUnguarded(ctx, client, repo, number), { repo, number });
  }
  async function readReviewsUnguarded(ctx, client, repo, number) {
    const source = { repo, number };
    if (!SB.validRepo(repo) || !Number.isInteger(number) || number < 1) return result("invalid", null, source, { error: "not a pull request" });
    const reviews = [];
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
      const { out, body } = await getList(ctx, client, "/repos/" + repo + "/pulls/" + number + "/reviews?per_page=100&page=" + page, source, "Pull requests: read");
      if (out) return out;
      if (!Array.isArray(body) || body.length > 100) return result("invalid", null, source, { error: "unexpected review list" });
      for (const r of body) {
        if (!isObject(r) || !REVIEW_STATES.includes(r.state) || !(r.commit_id === null || r.commit_id === undefined || isSha(r.commit_id)) ||
            !isTime(time(r.submitted_at))) return result("invalid", null, source, { error: "malformed review" });
        reviews.push({ state: r.state, commit: r.commit_id || null, by: loginOf(r.user), at: time(r.submitted_at) });
      }
      if (body.length < 100) return result(reviews.length ? "current" : "empty", { reviews }, source);
    }
    return result("partial", { reviews }, source, { coverage: { shown: reviews.length, total: null } });
  }

  // Issues only: GitHub's issue list also holds pull requests, which are counted and left to their own list.
  function readIssuePage(ctx, client, repo, state, page) {
    return SB.guard(readIssuePageUnguarded(ctx, client, repo, state, page), { repo, state, page });
  }
  async function readIssuePageUnguarded(ctx, client, repo, state, page) {
    const source = { repo, state, page };
    if (!workPage(repo, state, page) || state === null) return result("invalid", null, source, { error: "not a valid repository, list or page" });
    const { out, body } = await getList(ctx, client, "/repos/" + repo + "/issues?state=" + state + "&per_page=" + WORK_PAGE + "&page=" + page, source, "Issues: read");
    if (out) return out;
    if (!Array.isArray(body) || body.length > WORK_PAGE) return result("invalid", null, source, { error: "unexpected issue list" });
    const issues = [];
    let pulls = 0;
    for (const i of body) {
      if (!isObject(i) || !Number.isInteger(i.number) || i.number < 1 || typeof i.title !== "string" || !PULL_STATES.includes(i.state) ||
          !(i.state_reason === null || i.state_reason === undefined || ISSUE_REASONS.includes(i.state_reason)) ||
          !(i.comments === undefined || (Number.isInteger(i.comments) && i.comments >= 0)) ||
          !(i.labels === undefined || Array.isArray(i.labels)) || !["created_at", "closed_at"].every(k => isTime(time(i[k])))) {
        return result("invalid", null, source, { error: "malformed issue" });
      }
      if (i.pull_request !== undefined) { pulls += 1; continue; }
      issues.push({ number: i.number, title: i.title.slice(0, 300), state: i.state, reason: i.state_reason || null, author: loginOf(i.user),
                    labels: (i.labels || []).map(l => typeof l === "string" ? l : isObject(l) && typeof l.name === "string" ? l.name : null)
                      .filter(l => l && isRefName(l)).map(l => l.slice(0, 50)).slice(0, 20),
                    assignees: logins(i.assignees), comments: i.comments === undefined ? null : i.comments,
                    created: time(i.created_at), closed: time(i.closed_at) });
    }
    return pageResult(body, { issues, pulls }, source);
  }

  // Workflow runs, newest first, with GitHub's own total. Needs Actions: read.
  // A page of runs, filtered by GitHub when a filter is given (see SB.runQuery).
  function readRunPage(ctx, client, repo, page, filter) {
    return SB.guard(readRunPageUnguarded(ctx, client, repo, page, filter), { repo, page });
  }
  async function readRunPageUnguarded(ctx, client, repo, page, filter) {
    const source = { repo, page };
    if (!workPage(repo, null, page)) return result("invalid", null, source, { error: "not a valid repository or page" });
    const { workflow, query } = SB.runQuery(filter);
    const path = "/repos/" + repo + "/actions/" + (workflow ? "workflows/" + workflow + "/" : "") + "runs?" + (query ? query + "&" : "") +
      "per_page=" + WORK_PAGE + "&page=" + page;
    const { out, body } = await getList(ctx, client, path, source, "Actions: read");
    if (out) return out;
    if (!isObject(body) || !Number.isInteger(body.total_count) || body.total_count < 0 || !Array.isArray(body.workflow_runs) || body.workflow_runs.length > WORK_PAGE) {
      return result("invalid", null, source, { error: "unexpected run list" });
    }
    const runs = [];
    for (const r of body.workflow_runs) {
      if (!isObject(r) || !Number.isSafeInteger(r.id) || r.id < 1 || !(r.name === null || r.name === undefined || typeof r.name === "string") ||
          !(r.run_number === undefined || Number.isInteger(r.run_number)) || !isSha(r.head_sha) ||
          !(r.head_branch === null || r.head_branch === undefined || isRefName(r.head_branch)) ||
          !(r.status === null || r.status === undefined || typeof r.status === "string") ||
          !(r.conclusion === null || r.conclusion === undefined || typeof r.conclusion === "string") ||
          !["created_at", "run_started_at", "updated_at"].every(k => isTime(time(r[k])))) return result("invalid", null, source, { error: "malformed run" });
      runs.push({ id: r.id, name: (r.name || "").slice(0, 200) || null, title: typeof r.display_title === "string" ? r.display_title.slice(0, 300) : null,
                  number: r.run_number === undefined ? null : r.run_number, event: typeof r.event === "string" ? r.event.slice(0, 40) : null,
                  status: RUN_STATUSES.includes(r.status) ? r.status : null, conclusion: RUN_CONCLUSIONS.includes(r.conclusion) ? r.conclusion : null,
                  rawConclusion: r.conclusion === null || r.conclusion === undefined ? null : String(r.conclusion).slice(0, 40),
                  branch: r.head_branch || null, head: r.head_sha, actor: loginOf(r.actor),
                  created: time(r.created_at), started: time(r.run_started_at), updated: time(r.updated_at) });
    }
    // GitHub's total says how many runs there are: a single reply listing more than it counts is not
    // GitHub's list. The end is reached when the runs up to this page cover the total; a page short of
    // it is kept as short (not complete), never as the end, and nothing further is read after it.
    const before = (page - 1) * WORK_PAGE;
    if (runs.length > body.total_count) return result("invalid", null, source, { error: "run list longer than its total" });
    const extra = { runs, total: body.total_count };
    if (before + runs.length >= body.total_count) return result(runs.length ? "current" : "empty", Object.assign({ end: true }, extra), source);
    const short = runs.length < WORK_PAGE;
    return result("partial", Object.assign({ end: false, short }, extra), source,
                  { coverage: { shown: before + runs.length, total: body.total_count } });
  }

  // The repository's workflows, to filter its runs by: the first 100, by ID, name and file.
  function readWorkflows(ctx, client, repo) {
    return SB.guard(readWorkflowsUnguarded(ctx, client, repo), { repo });
  }
  async function readWorkflowsUnguarded(ctx, client, repo) {
    const source = { repo };
    if (!SB.validRepo(repo)) return result("invalid", null, source, { error: "not a valid repository" });
    const { out, body } = await getList(ctx, client, "/repos/" + repo + "/actions/workflows?per_page=" + WORK_PAGE + "&page=1", source, "Actions: read");
    if (out) return out;
    if (!isObject(body) || !Number.isInteger(body.total_count) || !Array.isArray(body.workflows) || body.workflows.length > WORK_PAGE ||
        !body.workflows.every(w => isObject(w) && Number.isSafeInteger(w.id) && w.id > 0 && typeof w.name === "string" && typeof w.path === "string")) {
      return result("invalid", null, source, { error: "unexpected workflow list" });
    }
    const workflows = body.workflows.map(w => ({ id: w.id, name: w.name.slice(0, 200) || w.path.slice(0, 200), path: w.path.slice(0, 300),
                                                 state: typeof w.state === "string" ? w.state.slice(0, 40) : null }));
    const extra = { workflows, total: body.total_count };
    return body.total_count > workflows.length ? result("partial", extra, source, { coverage: { shown: workflows.length, total: body.total_count } })
      : result(workflows.length ? "current" : "empty", extra, source);
  }

  // Releases, newest first, with their assets' names and sizes only: no asset is fetched.
  // A release asset's download address, only when it is GitHub's own download address for this
  // repository's releases; anything else is shown as text and never linked.
  function assetLink(value, repo) {
    if (typeof value !== "string" || value.length > 2000) return null;
    let url;
    try { url = new URL(value); } catch (e) { return null; }
    const base = "/" + String(repo).toLowerCase() + "/releases/download/";
    if (url.protocol.slice(0, -1) !== "https" || url.host !== "github.com" || url.username || url.password || url.search || url.hash ||
        !url.pathname.toLowerCase().startsWith(base) || url.pathname.length === base.length) return null;
    return url.href;
  }

  function readReleasePage(ctx, client, repo, page) {
    return SB.guard(readReleasePageUnguarded(ctx, client, repo, page), { repo, page });
  }
  async function readReleasePageUnguarded(ctx, client, repo, page) {
    const source = { repo, page };
    if (!workPage(repo, null, page)) return result("invalid", null, source, { error: "not a valid repository or page" });
    const { out, body } = await getList(ctx, client, "/repos/" + repo + "/releases?per_page=" + WORK_PAGE + "&page=" + page, source);
    if (out) return out;
    if (!Array.isArray(body) || body.length > WORK_PAGE) return result("invalid", null, source, { error: "unexpected release list" });
    const releases = [];
    for (const r of body) {
      if (!isObject(r) || !Number.isSafeInteger(r.id) || !isRefName(r.tag_name) || !(r.name === null || r.name === undefined || typeof r.name === "string") ||
          typeof r.draft !== "boolean" || typeof r.prerelease !== "boolean" || !["created_at", "published_at"].every(k => isTime(time(r[k]))) ||
          !(r.assets === undefined || (Array.isArray(r.assets) && r.assets.length <= 1000))) return result("invalid", null, source, { error: "malformed release" });
      const assets = [];
      for (const a of r.assets || []) {
        if (!isObject(a) || typeof a.name !== "string" || !Number.isSafeInteger(a.size) || a.size < 0 ||
            !(a.download_count === undefined || (Number.isSafeInteger(a.download_count) && a.download_count >= 0))) {
          return result("invalid", null, source, { error: "malformed release asset" });
        }
        assets.push({ name: a.name.slice(0, 200), size: a.size, downloads: a.download_count === undefined ? null : a.download_count,
                      url: assetLink(a.browser_download_url, repo) });
      }
      releases.push({ id: r.id, tag: r.tag_name, name: r.name ? r.name.slice(0, 200) : null, draft: r.draft, prerelease: r.prerelease,
                      created: time(r.created_at), published: time(r.published_at), author: loginOf(r.author), assets });
    }
    return pageResult(releases, { releases }, source);
  }

  // ---- Code inspection: a repository's file tree and a file's text at a pinned commit, and the
  // changes of one commit or between two. Every read names its commit by full ID, and what it holds is
  // data: shown as text only, never run, rendered as HTML or followed. Nothing is edited or committed.

  const TREE_KINDS = { blob: "file", tree: "dir", commit: "submodule" };
  const MAX_DIFF_FILES = 300;
  const FILE_STATUSES = ["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"];
  const isGitPath = v => typeof v === "string" && v.length <= 4096 && /^[^\u0000/][^\u0000]*$/.test(v) &&
    !v.split("/").some(part => part === "" || part === "." || part === "..");
  const isCount = v => Number.isSafeInteger(v) && v >= 0;

  // The whole tree at a commit as GitHub lists it in one reply; a list GitHub cut short is partial.
  function readTree(ctx, client, repo, commit) {
    return SB.guard(readTreeUnguarded(ctx, client, repo, commit), { repo, commit });
  }

  async function readTreeUnguarded(ctx, client, repo, commit) {
    const source = { repo, commit };
    if (!SB.validRepo(repo) || !isSha(commit)) return result("invalid", null, source, { error: "not a valid repository or commit" });
    const res = await client.get(ctx, "/repos/" + repo + "/git/trees/" + commit + "?recursive=1");
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const body = await client.json(ctx, res);
    if (!isObject(body) || !Array.isArray(body.tree) || typeof body.truncated !== "boolean") return result("invalid", null, source, { error: "unexpected file tree" });
    const entries = [];
    for (const e of body.tree) {
      if (!isObject(e) || !isGitPath(e.path) || !Object.prototype.hasOwnProperty.call(TREE_KINDS, e.type) || typeof e.mode !== "string" || !isSha(e.sha) ||
          !(e.size === undefined || isCount(e.size))) return result("invalid", null, source, { error: "malformed file tree entry" });
      entries.push({ path: e.path, kind: e.type === "blob" && e.mode === "120000" ? "symlink" : TREE_KINDS[e.type], sha: e.sha,
                     size: e.type === "blob" && e.size !== undefined ? e.size : null });
    }
    if (body.truncated) return result("partial", { entries, truncated: true }, source, { coverage: { shown: entries.length, total: null } });
    return result(entries.length ? "current" : "empty", { entries, truncated: false }, source);
  }

  // One file's text at a commit, after readFile has matched its bytes to GitHub's blob ID. Bytes that are
  // not UTF-8 text, or hold a NUL, are kept as binary: their size and ID are given, never their content.
  function readCodeFile(ctx, client, repo, commit, path) {
    return SB.guard(readCodeFileUnguarded(ctx, client, repo, commit, path), { repo, commit, path });
  }

  async function readCodeFileUnguarded(ctx, client, repo, commit, path) {
    const source = { repo, commit, path };
    if (!SB.validRepo(repo) || !isSha(commit)) return result("invalid", null, source, { error: "not a valid repository or commit" });
    if (!isPath(path)) return result("unavailable", null, source, { error: "this app opens only paths made of letters, digits, dots, dashes, underscores and slashes" });
    const file = await client.readFile(ctx, repo, commit, path);
    if (file.state !== "current") return file;
    const { bytes, sha } = file.data;
    const text = bytes.includes(0) ? null : decode(bytes, true);
    if (text === null) return result("current", { binary: true, text: null, size: bytes.length, sha }, file.source);
    return result(text ? "current" : "empty", { binary: false, text, size: bytes.length, sha }, file.source);
  }

  // A changed file as the commit and compare replies give it, or null when it is not in that form.
  function changedFile(f) {
    if (!isObject(f) || !isGitPath(f.filename) || !FILE_STATUSES.includes(f.status) || !isCount(f.additions) || !isCount(f.deletions) ||
        !(f.patch === undefined || typeof f.patch === "string") || !(f.previous_filename === undefined || isGitPath(f.previous_filename))) return null;
    return { path: f.filename, status: f.status, from: f.previous_filename || null, added: f.additions, removed: f.deletions,
             patch: f.patch === undefined ? null : f.patch };
  }

  // GitHub lists at most 300 changed files in one reply; a list that reaches that is partial. A commit's
  // reply also says when its file list goes on (pagesOn); a comparison's next page lists commits, not files.
  function changesResult(files, pagesOn, data, source) {
    if (files.length >= MAX_DIFF_FILES || pagesOn) return result("partial", data, source, { coverage: { shown: files.length, total: null } });
    return result(files.length ? "current" : "empty", data, source);
  }

  // The changed files of a reply: null when the list is missing or one entry is not in the expected form,
  // so a reply without its list is never taken for a change of no files.
  function changedFiles(list) {
    if (!Array.isArray(list)) return null;
    const files = list.map(changedFile);
    return files.some(f => !f) ? null : files;
  }

  // A commit, named by its ID or by a branch or tag (resolved by GitHub now), with the files it changed
  // against its first parent.
  function readCommitChanges(ctx, client, repo, ref) {
    return SB.guard(readCommitChangesUnguarded(ctx, client, repo, ref), { repo, ref });
  }

  async function readCommitChangesUnguarded(ctx, client, repo, ref) {
    const source = { repo, ref };
    if (!SB.validRepo(repo) || typeof ref !== "string" || !/^[A-Za-z0-9_./-]{1,200}$/.test(ref) || ref.split("/").some(part => part === "." || part === "..")) {
      return result("invalid", null, source, { error: "not a valid repository, branch, tag or commit" });
    }
    const res = await client.get(ctx, "/repos/" + repo + "/commits/" + encodeURIComponent(ref));
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const body = await client.json(ctx, res);
    const c = historyCommit(body);
    if (!c) return result("invalid", null, source, { error: "unexpected commit reply" });
    const files = changedFiles(body.files);
    if (!files) return result("invalid", null, source, { error: "no well-formed list of changed files" });
    return changesResult(files, /rel="next"/.test(res.headers.get("link") || ""), { commit: c, files }, Object.assign({ commit: c.sha }, source));
  }

  // The changes from one commit to another since their common ancestor, as GitHub compares them now.
  function readCompareChanges(ctx, client, repo, base, head) {
    return SB.guard(readCompareChangesUnguarded(ctx, client, repo, base, head), { repo, base, head });
  }

  async function readCompareChangesUnguarded(ctx, client, repo, base, head) {
    const source = { repo, base, head };
    if (!SB.validRepo(repo) || !isSha(base) || !isSha(head)) return result("invalid", null, source, { error: "not a valid repository or commit" });
    const res = await client.get(ctx, "/repos/" + repo + "/compare/" + base + "..." + head + "?per_page=1");
    if (!res.ok) return result(client.stateFor(res), null, source, { error: "HTTP " + res.status });
    const b = await client.json(ctx, res);
    if (!isObject(b) || !COMPARE_STATES.includes(b.status) || !isCount(b.ahead_by) || !isCount(b.behind_by) ||
        !(b.merge_base_commit === undefined || b.merge_base_commit === null || (isObject(b.merge_base_commit) && isSha(b.merge_base_commit.sha)))) {
      return result("invalid", null, source, { error: "unexpected comparison" });
    }
    const files = changedFiles(b.files);
    if (!files) return result("invalid", null, source, { error: "no well-formed list of changed files" });
    return changesResult(files, false, { status: b.status, ahead: b.ahead_by, behind: b.behind_by,
                                       mergeBase: b.merge_base_commit && b.merge_base_commit.sha ? b.merge_base_commit.sha : null, files }, source);
  }

  Object.assign(SB, { WORKSPACES_FILE, STATUSES, SCOPES, readWorkspace, readTaskFile, isPath, validateWorkspaces, readWorkspaces, splitRow, parsePlanTables, readPlan,
                      validateProgress, readProgress, readCheckRuns, readPulls, readComments,
                      COMMIT_LIMIT, REPO_COMMENT_LIMIT, readLanguages, readCommits, readRepoComments, readUser, readProfile, EVENT_PAGES, readPublicEvents, readStarred, readGists, readUserRepos, readAccountRepos, FIND_LIMIT, findPlanRepos,
                      HISTORY_PAGE, historyCommit, readHistoryPage, readRefs, readCompare,
                      WORK_PAGE, MAX_WORK_PAGES, readPullPage, readPullCommits, readReviews, readIssuePage, readRunPage, readWorkflows, readReleasePage, assetLink,
                      MAX_DIFF_FILES, readTree, readCodeFile, readCommitChanges, readCompareChanges });
})(typeof window !== "undefined" ? window : globalThis);
