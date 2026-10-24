"use strict";
// Synthetic plan repositories for the reader tests. Every name, ID and figure is made up.
const { blobSha, sha } = require("./helpers");

const FILES = { progress: "plan/progress.json", producer: "tools/progress.py",
                table: "plan/tasks.md", record: "plan/record.md" };

const TABLE = [
  "# Synthetic plan",
  "",
  "## P1 Start",
  "",
  "| ID | Task | Status | Est. h |",
  "|---|---|---|---|",
  "| XQ101 | Sketch the layout | Done | 2 |",
  "| XQ102 | Pick colours \\| fonts | In Progress | 3 |",
  "",
  "## P2 Build",
  "",
  "| ID | Task | Status | Est. h |",
  "|---|---|---|---|",
  "| XQ201 | Build the page | Not Started | 5 |",
  "",
].join("\n");
const RECORD = "# Synthetic record\n\nNothing private here.\n";
const PRODUCER = "print('synthetic producer')\n";

function totals(pct) {
  return { estimated_h: 10, completed_h: pct / 10, remaining_h: 10 - pct / 10, progress_pct: pct,
           tbe_rows: 0, proposed_rows: 0, provisional_rows: 0, rows: 3, verified: false };
}

function progressDoc(over = {}) {
  const doc = {
    schema: "sandboard.progress/1", ok: true, subtasks: 3, steps: 0,
    producer: { path: FILES.producer, blob_sha: blobSha(PRODUCER) },
    inputs: { table: { path: FILES.table, blob_sha: blobSha(TABLE) },
              record: { path: FILES.record, blob_sha: blobSha(RECORD) } },
    scopes: { "Pilot": totals(20), "MVP": totals(20), "Post-MVP": totals(0), "Whole project": totals(20) },
    phases: [Object.assign({ id: "P1", name: "Start", status_counts: { "Done": 1, "In Progress": 1 } }, totals(40)),
             Object.assign({ id: "P2", name: "Build", status_counts: { "Not Started": 1 } }, totals(0))],
  };
  return Object.assign(doc, over);
}

const PLAN_COMMIT = sha("plan-main");
const CODE_COMMIT = sha("code-main");

function workspacesDoc(over = {}) {
  return Object.assign({
    schema: "sandboard.workspaces/1",
    workspaces: [
      { id: "garden", label: "Example Garden Planner", kind: "project",
        plan: { repo: "acme/garden-plan", ref: null, files: Object.assign({}, FILES) },
        code: [{ repo: "acme/garden", ref: null, role: "app" }] },
      { id: "recipes", label: "Sample Recipe Box", kind: "standalone", plan: null,
        code: [{ repo: "acme/recipes", ref: "release", role: "app" }] },
    ],
  }, over);
}

// files: overrides for the plan commit's files (undefined value removes a file).
function planRepos({ files = {}, workspaces = workspacesDoc(), checks } = {}) {
  const planFiles = Object.assign({
    "sandboard.workspaces.json": JSON.stringify(workspaces, null, 1),
    [FILES.table]: TABLE, [FILES.record]: RECORD, [FILES.producer]: PRODUCER,
    [FILES.progress]: JSON.stringify(progressDoc(), null, 1),
  }, files);
  for (const k of Object.keys(planFiles)) if (planFiles[k] === undefined) delete planFiles[k];
  return {
    "acme/garden-plan": { default_branch: "main", branches: { main: PLAN_COMMIT }, files: { [PLAN_COMMIT]: planFiles } },
    "acme/garden": { default_branch: "main", branches: { main: CODE_COMMIT }, files: { [CODE_COMMIT]: {} },
                     checks: { [CODE_COMMIT]: checks || [{ name: "checks", status: "completed", conclusion: "success" }] } },
    "acme/recipes": { default_branch: "main", branches: { release: sha("recipes-release") },
                      files: { [sha("recipes-release")]: {} } },
  };
}

module.exports = { FILES, TABLE, RECORD, PRODUCER, progressDoc, workspacesDoc, planRepos, PLAN_COMMIT, CODE_COMMIT };
