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


  // ---- The repository overview: the explicitly mapped repositories, their GitHub metadata and
  // activity. These are GitHub's own counts about repositories; none of them is task progress.

  // One row per mapped repository (each workspace's plan and code repositories, and any opened by
  // name this visit), with every project and role it has. Only what the workspace list names appears.
  function portfolio(entries) {
    const rows = new Map();
    const add = (entry, repo, role, pinned) => {
      if (!rows.has(repo)) rows.set(repo, { repo, projects: [], pinned: null });
      const row = rows.get(repo);
      row.projects.push({ id: entry.w.id, label: entry.w.label, role, kind: entry.w.kind, opened: !!entry.w.opened });
      // The first read that answered stands for the repository; a later project's read fills a gap only.
      if (!row.pinned || (row.pinned.state !== "current" && pinned && pinned.state === "current")) row.pinned = pinned || row.pinned;
    };
    for (const e of entries) {
      if (e.w.plan) add(e, e.w.plan.repo, "plan", e.plan);
      e.w.code.forEach((c, i) => add(e, c.repo, c.role, e.code[i] ? e.code[i].pinned : null));
    }
    return [...rows.values()].map(r => Object.assign(r, { meta: r.pinned && r.pinned.state === "current" ? r.pinned.data.meta || null : null }));
  }

  // A feed is read at one pinned commit: the same repository at another ref is another feed.
  const feedKey = (repo, commit) => "feed|" + repo + "@" + commit;

  const typeOf = m => !m || m.fork === null ? null : m.fork ? "fork" : "original";

  // Rows matching every filter. A repository that could not be read shows only when nothing but the name is filtered.
  function filterPortfolio(rows, f) {
    const q = (f.q || "").trim().toLowerCase();
    return rows.filter(r => {
      const m = r.meta;
      if (!m) return !f.visibility && !f.language && !f.type && (!q || r.repo.toLowerCase().includes(q));
      // "-" picks repositories GitHub says have no main language; "?" picks those it gave no value for.
      const pick = (v, want) => !want || (want === "?" ? v === null : v === want);
      if (!pick(m.visibility, f.visibility)) return false;
      if (!pick(m.language, f.language === "-" ? "none" : f.language)) return false;
      if (f.type === "archived" ? m.archived !== true : !pick(typeOf(m), f.type)) return false;
      return !q || r.repo.toLowerCase().includes(q) || (m.description || "").toLowerCase().includes(q) ||
        (m.topics || []).some(t => t.includes(q));
    });
  }

  const SORTS = { name: "Name", stars: "Stars", forks: "Forks", issues: "Open issues", size: "Size", pushed: "Last push" };
  // A copy sorted by one field, largest or newest first (name: A to Z). Unknown values go last, then by name.
  function sortPortfolio(rows, key) {
    const val = r => !r.meta ? null : key === "pushed" ? (r.meta.pushed ? Date.parse(r.meta.pushed) : null) : r.meta[key];
    const byName = (a, b) => a.repo.toLowerCase() < b.repo.toLowerCase() ? -1 : a.repo.toLowerCase() > b.repo.toLowerCase() ? 1 : 0;
    return rows.slice().sort((a, b) => {
      if (key === "name" || !SORTS[key]) return byName(a, b);
      const x = val(a), y = val(b);
      if (x === null || x === undefined) return y === null || y === undefined ? byName(a, b) : 1;
      if (y === null || y === undefined) return -1;
      return y - x || byName(a, b);
    });
  }

  // Values for the portfolio filter menus.
  function portfolioOptions(rows) {
    const read = rows.filter(r => r.meta);
    return { visibilities: ["public", "private", "internal"].filter(v => read.some(r => r.meta.visibility === v)),
             languages: [...new Set(read.map(r => r.meta.language).filter(l => l && l !== "none"))].sort(),
             noLanguage: read.some(r => r.meta.language === "none"),
             unknown: { visibility: read.some(r => r.meta.visibility === null), language: read.some(r => r.meta.language === null),
                        type: read.some(r => typeOf(r.meta) === null) } };
  }

  // Counted values of one field, largest first, with what the field did not give counted apart.
  function tally(values) {
    const map = new Map();
    for (const v of values) map.set(v, (map.get(v) || 0) + 1);
    return [...map.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value)));
  }

  // Everything the activity view draws, from the rows that could be read. Sums are GitHub's own counts
  // added over the repositories that gave them, with how many did; they never feed progress.
  function analytics(rows) {
    const read = rows.filter(r => r.meta);
    const sum = key => { const known = read.filter(r => r.meta[key] !== null);
      return { total: known.reduce((n, r) => n + r.meta[key], 0), known: known.length }; };
    const count = test => read.filter(r => test(r.meta)).length;
    const year = t => t ? Number(t.slice(0, 4)) : null;
    const years = new Map();
    for (const r of read) {
      const y = year(r.meta.created);
      if (y === null) continue;
      const slot = years.get(y) || { year: y, original: 0, fork: 0, unknown: 0 };
      slot[typeOf(r.meta) || "unknown"] += 1;
      years.set(y, slot);
    }
    return {
      mapped: rows.length, read: read.length,
      counters: { public: count(m => m.visibility === "public"), private: count(m => m.visibility === "private"),
                  internal: count(m => m.visibility === "internal"), original: count(m => m.fork === false), fork: count(m => m.fork === true),
                  archived: count(m => m.archived === true), visibilityKnown: count(m => m.visibility !== null),
                  typeKnown: count(m => m.fork !== null), stars: sum("stars"), forks: sum("forks"), issues: sum("issues") },
      languages: tally(read.map(r => r.meta.language)),
      years: [...years.values()].sort((a, b) => a.year - b.year),
      noYear: read.filter(r => year(r.meta.created) === null).length,
      lifespans: read.filter(r => r.meta.created && r.meta.pushed).map(r => ({ repo: r.repo, created: r.meta.created, pushed: r.meta.pushed }))
        .sort((a, b) => Date.parse(a.created) - Date.parse(b.created)),
      scatter: read.filter(r => r.meta.stars !== null && r.meta.pushed).map(r => ({ repo: r.repo, stars: r.meta.stars, pushed: r.meta.pushed })),
      composition: { type: tally(read.map(r => r.meta.archived ? ["Archived", typeOf(r.meta)].filter(Boolean).join(" ") : typeOf(r.meta))),
                     license: tally(read.map(r => r.meta.license)), branch: tally(read.map(r => r.meta.branch)) },
    };
  }

  // Code bytes per language added over the repositories whose language counts were read, with coverage.
  function languageBytes(results) {
    const totals = new Map();
    let read = 0;
    for (const res of results) {
      if (!res || !res.data) continue;
      read += 1;
      for (const l of res.data.languages) totals.set(l.name, (totals.get(l.name) || 0) + l.bytes);
    }
    const all = [...totals.entries()].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    return { languages: all, read, total: results.length, bytes: all.reduce((n, l) => n + l.bytes, 0) };
  }

  // A web address on the repository's own GitHub page, or null when GitHub gave no web address.
  function repoHref(web, kind, id) {
    if (!web) return null;
    if (kind === "commit" && /^[0-9a-f]{40}$/.test(id)) return web + "/commit/" + id;
    if ((kind === "pull" || kind === "issues") && Number.isInteger(id) && id > 0) return web + "/" + kind + "/" + id;
    return null;
  }

  // A project's activity feed: commits, pull requests opened, merged or closed, and handoff comments,
  // from each repository's own reads, newest first. Each event keeps its repository and links to its origin.
  // sources: [{repo, web, commits, pulls, comments}] with reader results. Events with no time are counted, not placed.
  function feedEvents(sources) {
    const events = [];
    let untimed = 0, other = 0;
    const push = e => { if (e.at && !Number.isNaN(Date.parse(e.at))) events.push(e); else untimed += 1; };
    for (const s of sources) {
      const pulls = s.pulls && s.pulls.data ? s.pulls.data.pulls : [];
      if (s.commits && s.commits.data) for (const c of s.commits.data.commits) {
        push({ kind: "commit", repo: s.repo, at: c.at, title: c.title, id: SB.short(c.sha), merge: c.parents > 1, href: repoHref(s.web, "commit", c.sha) });
      }
      for (const pr of pulls) {
        const href = repoHref(s.web, "pull", pr.number);
        push({ kind: "opened", repo: s.repo, at: pr.created, title: pr.title, id: "#" + pr.number, href });
        if (pr.merged) push({ kind: "merged", repo: s.repo, at: pr.merged, title: pr.title, id: "#" + pr.number, href });
        else if (pr.state === "closed" && pr.closed) push({ kind: "closed", repo: s.repo, at: pr.closed, title: pr.title, id: "#" + pr.number, href });
      }
      if (s.comments && s.comments.data) for (const c of s.comments.data.comments) {
        const h = handoff(c.body);
        if (!h) { other += 1; continue; }
        const isPull = pulls.some(p => p.number === c.number);
        push({ kind: "handoff", repo: s.repo, at: c.at, title: h.from + ": " + h.state, id: "#" + c.number, handoff: h,
               href: repoHref(s.web, isPull ? "pull" : "issues", c.number) });
      }
    }
    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { events, untimed, other };
  }

  // ---- History: the commits read, laid out in lanes, and what they say per week, per day and per login.
  // Nothing here is guessed: a parent that was not read leaves its lane open at the bottom, and every
  // figure says it covers only the commits read.

  // Children before parents, newest first among those ready; commits with a bad time sort last.
  function historyOrder(commits) {
    const by = new Map(commits.map(c => [c.sha, c]));
    const kids = new Map(commits.map(c => [c.sha, 0]));
    for (const c of commits) for (const p of c.parents) if (by.has(p)) kids.set(p, kids.get(p) + 1);
    const t = c => { const v = c.at ? Date.parse(c.at) : NaN; return Number.isNaN(v) ? -Infinity : v; };
    const ready = commits.filter(c => kids.get(c.sha) === 0);
    const out = [];
    while (ready.length) {
      let best = 0;
      for (let i = 1; i < ready.length; i++) if (t(ready[i]) > t(ready[best])) best = i;
      const c = ready.splice(best, 1)[0];
      out.push(c);
      for (const p of c.parents) if (by.has(p)) { kids.set(p, kids.get(p) - 1); if (kids.get(p) === 0) ready.push(by.get(p)); }
    }
    return out;
  }

  // The read ref's history plus each compared branch's own commits, as rows with a lane each. A row
  // keeps the lanes open below it and, for each, which lanes above it come down into it.
  function historyGraph(main, branches) {
    const seen = new Map();
    for (const c of main) if (!seen.has(c.sha)) seen.set(c.sha, c);
    for (const b of branches) for (const c of b.commits) if (!seen.has(c.sha)) seen.set(c.sha, c);
    const ordered = historyOrder([...seen.values()]);
    let lanes = [];
    const free = taken => { const i = lanes.findIndex((v, j) => v === null && !taken.includes(j)); return i === -1 ? lanes.length : i; };
    const rows = ordered.map(c => {
      const hits = lanes.map((v, j) => v === c.sha ? j : -1).filter(j => j >= 0);
      const lane = hits.length ? hits[0] : free([]);
      for (const j of hits) lanes[j] = null;
      if (lane >= lanes.length) lanes.push(null);
      const into = {};
      lanes.forEach((v, j) => { if (v !== null) into[j] = [j]; });
      c.parents.forEach((p, n) => {
        const j = lanes.findIndex(v => v === p);
        if (j >= 0) { (into[j] = into[j] || []).push(lane); return; }
        const k = n === 0 && lanes[lane] === null ? lane : free([lane]);
        if (k >= lanes.length) lanes.push(null);
        lanes[k] = p;
        into[k] = [lane];
      });
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
      return { commit: c, lane, merge: c.parents.length > 1, root: c.parents.length === 0, open: lanes.slice(), into };
    });
    const width = Math.max(1, ...rows.map(r => Math.max(r.lane + 1, r.open.length)));
    const last = rows.length ? rows[rows.length - 1].open : [];
    return { rows, width, unread: last.filter(v => v !== null).length };
  }

  // A UTC day as GitHub-style ISO text; years past 9999 or before 0 keep their sign and six digits.
  const isoDay = t => new Date(t).toISOString().split("T")[0];
  // The Monday that starts a time's week, or the earliest day a date can hold when that Monday is before it.
  const mondayOf = t => { const d = new Date(t); const back = (d.getUTCDay() + 6) % 7;
    const m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
    return isoDay(Number.isNaN(m) ? -864e13 : m); };

  // Live reads for a repository's history, by what each one is read at.
  const historyKey = {
    page: (repo, commit, page) => "hist|" + repo + "@" + commit + "|" + page,
    refs: (repo, kind) => kind + "|" + repo,
    compare: (repo, base, head) => "cmp|" + repo + "|" + base + "..." + head,
    lane: (repo, head) => "lane|" + repo + "@" + head,
  };
  const COMPARE_FIRST = 10;
  // The branches compared with the read commit: the first ten GitHub lists, then any the owner asks for.
  const comparedBranches = (repo, branches, asked) => branches.filter((b, i) => i < COMPARE_FIRST || asked.has(repo + "|" + b.name));

  // Everything a repository's history view shows, from the reads made so far (live: key => result).
  // It also says which reads are still wanted: the next page asked for, and each comparison and branch.
  function historyView(live, repo, commit, depth, asked) {
    const K = historyKey;
    const main = [], wanted = [];
    let state = "current", end = false, error = null, pages = 0;
    for (let p = 1; p <= depth; p++) {
      const res = live(K.page(repo, commit, p));
      if (!res || res.state === "loading") { wanted.push({ kind: "page", page: p }); if (p === 1) state = "loading"; break; }
      if (!res.data) { if (p === 1) state = res.state; error = res; break; }
      pages = p;
      main.push(...res.data.commits);
      if (res.data.end) { end = true; break; }
    }
    const inMain = new Set(main.map(c => c.sha));
    const branches = live(K.refs(repo, "branches")), tags = live(K.refs(repo, "tags"));
    if (!branches) wanted.push({ kind: "refs", list: "branches" });
    if (!tags) wanted.push({ kind: "refs", list: "tags" });
    const list = branches && branches.data ? branches.data.refs : [];
    const chosen = new Set(comparedBranches(repo, list, asked).map(b => b.name));
    const compared = list.map(b => {
      if (!chosen.has(b.name)) return { branch: b, cmp: null, asked: false };
      if (b.sha === commit) return { branch: b, cmp: SB.result("current", { status: "identical", ahead: 0, behind: 0, base: commit }, {}), asked: true, commits: [], unread: 0 };
      const cmp = live(K.compare(repo, commit, b.sha));
      if (!cmp) { wanted.push({ kind: "compare", head: b.sha }); return { branch: b, cmp: { state: "loading" }, asked: true }; }
      if (!cmp.data || !cmp.data.ahead) return { branch: b, cmp, asked: true, commits: [], unread: 0 };
      const lane = live(K.lane(repo, b.sha));
      if (!lane) wanted.push({ kind: "lane", head: b.sha });
      const read = lane && lane.data ? lane.data.commits : [];
      // The branch's own commits: those reached from its head before the read history or the merge base.
      const by = new Map(read.map(c => [c.sha, c])), mine = new Set(), todo = [b.sha];
      while (todo.length) {
        const sha = todo.pop();
        if (mine.has(sha) || inMain.has(sha) || sha === cmp.data.base || !by.has(sha)) continue;
        mine.add(sha);
        todo.push(...by.get(sha).parents);
      }
      const own = read.filter(c => mine.has(c.sha));
      return { branch: b, cmp, asked: true, lane: lane || { state: "loading" }, commits: own, unread: Math.max(0, cmp.data.ahead - own.length) };
    });
    const graph = historyGraph(main, compared.filter(x => x.commits && x.commits.length));
    return { state, error, end, pages, main, branches, tags, compared, graph, wanted, more: !end && !error && pages === depth && depth < SB.MAX_HISTORY_PAGES };
  }

  // Commits read per week (Monday, UTC) and per day, for the latest weeks and days of the window from the
  // oldest commit read to the newest: WEEKS_SHOWN weeks and DAYS_SHOWN days, each counting 0 when none was
  // read. Only the shown buckets are built, however far apart the dates are; weekSpan and daySpan say how
  // many weeks and days the whole window has, so the view can say how many it did not draw.
  const WEEKS_SHOWN = 12, DAYS_SHOWN = 26 * 7, DAY = 864e5;
  function commitTimes(commits) {
    const times = commits.map(c => c.at ? Date.parse(c.at) : NaN).filter(t => !Number.isNaN(t));
    if (!times.length) return { weeks: [], days: [], weekSpan: 0, daySpan: 0, from: null, to: null, untimed: commits.length };
    const lo = times.reduce((a, b) => Math.min(a, b)), hi = times.reduce((a, b) => Math.max(a, b));
    const byWeek = new Map(), byDay = new Map();
    for (const t of times) { const w = mondayOf(t), d = isoDay(t); byWeek.set(w, (byWeek.get(w) || 0) + 1); byDay.set(d, (byDay.get(d) || 0) + 1); }
    const span = (first, last, step) => Math.round((Date.parse(last) - Date.parse(first)) / step) + 1;
    const fill = (last, n, step, counts, key) => Array.from({ length: n }, (_, i) => {
      const at = isoDay(Date.parse(last) - (n - 1 - i) * step); return { [key]: at, n: counts.get(at) || 0 }; });
    const weekSpan = span(mondayOf(lo), mondayOf(hi), 7 * DAY), daySpan = span(isoDay(lo), isoDay(hi), DAY);
    return { weeks: fill(mondayOf(hi), Math.min(weekSpan, WEEKS_SHOWN), 7 * DAY, byWeek, "week"),
             days: fill(isoDay(hi), Math.min(daySpan, DAYS_SHOWN), DAY, byDay, "day"),
             weekSpan, daySpan, from: isoDay(lo), to: isoDay(hi), untimed: commits.length - times.length };
  }

  // Commits read per GitHub login, most first. A commit not linked to a GitHub account is counted, never named.
  function contributors(commits) {
    const counts = tally(commits.filter(c => c.author).map(c => c.author));
    return { logins: counts.map(x => ({ login: x.value, n: x.n })), unlinked: commits.filter(c => !c.author).length };
  }

  // ---- Work evidence: a repository's pull requests, issues, Actions runs and releases, read a page
  // at a time as GitHub lists them now. Nothing here is progress, and a review, a passing check or a
  // merge is never the owner's approval.

  const WORK_LISTS = { pulls: "pulls", issues: "issues", runs: "runs", releases: "releases" };
  const workKey = {
    list: (kind, repo, state, page) => "work|" + kind + "|" + repo + "|" + (state || "-") + "|" + page,
    reviews: (repo, number) => "reviews|" + repo + "#" + number,
    checks: (repo, sha) => "checks|" + repo + "@" + sha,
  };

  // The pages read so far of one list, in order, stopping at the first one not read, failed or last.
  // A page that GitHub returned short of the total it reported (runs) ends what can be read: the
  // list is then not complete, and says so. A total that changed between pages is kept as changed.
  function workList(live, kind, repo, state, depth) {
    const items = [], wanted = [];
    let status = "current", end = false, error = null, pages = 0, pulls = 0, total = null, lastTotal = null, short = false;
    for (let p = 1; p <= depth; p++) {
      const res = live(workKey.list(kind, repo, state, p));
      if (!res || res.state === "loading") { wanted.push(p); if (p === 1) status = "loading"; break; }
      if (!res.data) { if (p === 1) status = res.state; error = res; break; }
      pages = p;
      items.push(...res.data[WORK_LISTS[kind]]);
      pulls += res.data.pulls && typeof res.data.pulls === "number" ? res.data.pulls : 0;
      if (Number.isInteger(res.data.total)) { if (p === 1) total = res.data.total; lastTotal = res.data.total; }
      if (res.data.end) { end = true; break; }
      if (res.data.short) { short = true; break; }
    }
    if (status === "current" && !items.length && end) status = "empty";
    return { state: status, error, end, pages, items, wanted, pulls, total, short,
             changed: total !== null && lastTotal !== total ? lastTotal : null,
             more: !end && !error && !short && pages === depth && depth < SB.MAX_WORK_PAGES };
  }

  // A pull request as one word: draft, open, merged or closed without merging.
  const pullState = pr => pr.merged ? "merged" : pr.state === "open" ? (pr.draft ? "draft" : "open") : "closed";

  // Each review with whether it was given at the pull request's current head. GitHub keeps a
  // review on the commit it was given at; one at an older commit is not a review of the head.
  function reviewEvidence(pr, reviews) {
    const list = reviews.map(r => Object.assign({ atHead: r.commit === pr.head }, r));
    const atHead = state => list.filter(r => r.atHead && r.state === state).length;
    return { list, approvedAtHead: atHead("APPROVED"), changesAtHead: atHead("CHANGES_REQUESTED"),
             older: list.filter(r => !r.atHead && r.state !== "COMMENTED").length, unknownCommit: list.filter(r => !r.commit).length };
  }

  // A run's status and conclusion kept apart: a run not completed has no conclusion yet, and is never
  // shown as a success. Its duration is GitHub's start to its last update, only once it completed.
  function runOutcome(run) {
    const done = run.status === "completed";
    const ms = done && run.started && run.updated ? Date.parse(run.updated) - Date.parse(run.started) : null;
    return { done, pending: !done, outcome: done ? run.conclusion || (run.rawConclusion ? "other" : "none") : run.status || "unknown",
             ms: ms !== null && ms >= 0 ? ms : null };
  }

  // The inbox's scope: every mapped repository, split into those whose read answered (their lists can
  // be read) and those still reading or not readable, which are named and never read further.
  function inboxScope(rows) {
    const readable = [], unread = [];
    for (const r of rows) {
      if (r.pinned && r.pinned.state === "current") readable.push(r);
      else unread.push({ repo: r.repo, state: r.pinned ? r.pinned.state : "loading", error: r.pinned ? r.pinned.error || null : null });
    }
    return { readable, unread };
  }

  // The signed-in account's own work in the given repositories only: its open pull requests, open pull
  // requests that ask it for a review, and open issues assigned to it. Read from the first page of
  // each repository's open lists; what was not read is said, and no account-wide list is read.
  function inbox(live, repos, login) {
    const out = { mine: [], review: [], assigned: [], problems: [], partial: [], loading: 0, teams: 0, wanted: [] };
    for (const repo of repos) {
      for (const kind of ["pulls", "issues"]) {
        const res = live(workKey.list(kind, repo, "open", 1));
        if (!res) { out.wanted.push({ repo, kind }); out.loading += 1; continue; }
        if (res.state === "loading") { out.loading += 1; continue; }
        if (!res.data) { out.problems.push({ repo, kind, res }); continue; }
        if (res.state === "partial") out.partial.push({ repo, kind });
        if (!login) continue;
        if (kind === "pulls") for (const pr of res.data.pulls) {
          if (pr.author === login) out.mine.push({ repo, pr });
          if (pr.reviewers.includes(login)) out.review.push({ repo, pr });
          if (pr.teams) out.teams += 1;
        } else for (const issue of res.data.issues) if (issue.assignees.includes(login)) out.assigned.push({ repo, issue });
      }
    }
    return out;
  }

  Object.assign(SB, { SORTS, portfolio, filterPortfolio, sortPortfolio, portfolioOptions, tally, analytics, languageBytes, repoHref, feedEvents, feedKey, typeOf,
                      historyOrder, historyGraph, commitTimes, WEEKS_SHOWN, DAYS_SHOWN, contributors,
                      workKey, workList, pullState, reviewEvidence, runOutcome, inboxScope, inbox, historyKey, COMPARE_FIRST, comparedBranches, historyView,
                      ORDER, phaseOf, tasksFrom, estimateText, filterTasks, filterOptions, waiting, prerequisites, dependents, steps,
                      approvals, resultHref, tabKey, stageOfPhase, short,
                      HANDOFF_STATES, namesTask, linkedPulls, handoff, handoffs });
})(typeof window !== "undefined" ? window : globalThis);
