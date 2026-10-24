"use strict";
// App shell. Private data never comes from this file or this site: it is read
// from GitHub at run time with the owner's read-only token and kept in memory
// only. Leaving the page, reloading, "Forget token" or a refused token drops
// the token and everything read with it.

(function () {
  const root = document.documentElement;

  // Refuse to run inside a frame: a meta CSP cannot set frame-ancestors.
  if (window.top !== window.self) {
    root.classList.remove("pending");
    root.classList.add("framed");
    document.getElementById("state").textContent = "This page cannot be shown inside another site.";
    return;
  }
  root.classList.remove("pending");

  const SB = window.SB;
  const $ = id => document.getElementById(id);
  const projectsEl = $("projects");
  const workspacesEl = $("workspaces");
  const session = SB.createSession();
  const client = SB.createClient(session);

  // Text only: data is never parsed as HTML.
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  // ---- Synthetic demo

  function renderProject(project) {
    const li = el("li");
    li.append(el("strong", project.name));
    const pct = Math.max(0, Math.min(100, Number(project.progress) || 0));
    li.append(el("div", pct + "% of baseline hours", "note"));
    const bar = el("div", undefined, "bar");
    const fill = el("span");
    fill.style.width = pct + "%";
    bar.append(fill);
    li.append(bar);
    const tasks = el("ul");
    for (const task of project.tasks || []) {
      tasks.append(el("li", task.id + " " + task.title + " (" + task.status + ")"));
    }
    li.append(tasks);
    return li;
  }

  $("show-demo").addEventListener("click", function () {
    const demo = window.SANDBOARD_DEMO || { projects: [] };
    projectsEl.replaceChildren(...demo.projects.map(renderProject));
    $("signed-out").hidden = true;
    $("demo").hidden = false;
    $("state").textContent = "Demo (synthetic data)";
  });

  // ---- Private read (read-only token, memory only)

  function endSession(notice) {
    session.forget();
    $("token").value = "";
    workspacesEl.replaceChildren();
    $("private").hidden = true;
    $("signed-out").hidden = false;
    $("state").textContent = "Signed out";
    $("private-state").textContent = "";
    if (notice) $("state").textContent = notice;
  }

  function line(label, r) {
    // One labelled result; the state is always shown, never hidden behind a number.
    const item = el("li", undefined, "result " + r.state);
    item.append(el("strong", label + ": "));
    item.append(el("span", r.state, "state-label"));
    if (r.error) item.append(el("span", " (" + r.error + ")"));
    return item;
  }

  function short(sha) {
    return typeof sha === "string" ? sha.slice(0, 7) : "";
  }

  async function showPlan(ctx, ws, list) {
    const pinned = await client.pin(ctx, ws.plan.repo, ws.plan.ref);
    const pinItem = line("Plan " + ws.plan.repo, pinned);
    list.append(pinItem);
    if (pinned.state !== "current") return;
    pinItem.append(el("span", " at " + pinned.data.ref + " " + short(pinned.data.commit) +
                      (pinned.data.date ? ", committed " + pinned.data.date : "")));
    const plan = await SB.readPlan(ctx, client, ws.plan.repo, pinned.data.commit, ws.plan.files);
    const planItem = line("Task table", plan);
    if (plan.data) planItem.append(el("span", ", " + plan.data.rows.length + " rows" +
                                      (plan.data.invalid ? ", " + plan.data.invalid + " invalid" : "")));
    list.append(planItem);
    const progress = await SB.readProgress(ctx, client, ws.plan.repo, pinned.data.commit, ws.plan.files);
    const progressItem = line("Stored progress", progress);
    if (progress.state === "current") {
      const whole = progress.data.scopes["Whole project"];
      progressItem.append(el("span", ", whole project " + whole.progress_pct + "%" +
                             (whole.verified ? "" : " (not verified)") + ", " + progress.data.phases.length +
                             " phases, from " + progress.schema + " at " + short(pinned.data.commit)));
    }
    list.append(progressItem);
  }

  async function showCode(ctx, code, list) {
    const pinned = await client.pin(ctx, code.repo, code.ref);
    const pinItem = line("Code " + code.repo + " (" + code.role + ")", pinned);
    list.append(pinItem);
    if (pinned.state !== "current") return;
    pinItem.append(el("span", " at " + pinned.data.ref + " " + short(pinned.data.commit)));
    const checks = await SB.readCheckRuns(ctx, client, code.repo, pinned.data.commit);
    const checksItem = line("Check runs", checks);
    if (checks.data && checks.data.runs.length) {
      const failing = checks.data.runs.filter(r => r.conclusion && r.conclusion !== "success" &&
                                                   r.conclusion !== "neutral" && r.conclusion !== "skipped").length;
      checksItem.append(el("span", ", " + checks.data.runs.length + " runs, " + failing + " not passing" +
                           (checks.coverage ? ", " + checks.coverage.shown + " of " + checks.coverage.total + " read" : "")));
    }
    list.append(checksItem);
  }

  async function connect(event) {
    event.preventDefault();
    const typed = $("token").value.trim();
    $("token").value = "";
    const target = SB.parseRepoRef($("plan-repo").value.trim());
    if (!typed || !target) {
      $("state").textContent = !typed ? "Enter a read-only token." : "Enter the plan repository as owner/repo or owner/repo@branch.";
      return;
    }
    workspacesEl.replaceChildren();
    const ctx = session.start(typed);
    $("signed-out").hidden = true;
    $("demo").hidden = true;
    $("private").hidden = false;
    $("state").textContent = "Signed in (token in memory only)";
    $("private-state").textContent = "Reading…";
    try {
      const ws = await SB.readWorkspaces(ctx, client, target.repo, target.ref);
      session.alive(ctx);
      if (ws.state !== "current") {
        $("private-state").textContent = "Workspace list: " + ws.state + (ws.error ? " (" + ws.error + ")" : "");
        return;
      }
      $("private-state").textContent = "Workspace list current at " + short(ws.data.commit) + ": " +
        ws.data.workspaces.length + " workspaces";
      for (const w of ws.data.workspaces) {
        const item = el("li", undefined, "workspace");
        item.append(el("h2", w.label));
        const list = el("ul");
        item.append(list);
        workspacesEl.append(item);
        if (w.plan) await showPlan(ctx, w, list);
        for (const code of w.code) await showCode(ctx, code, list);
      }
      session.alive(ctx);
      $("private-state").textContent += "; reading finished";
    } catch (err) {
      if (err instanceof SB.Revoked) {
        endSession("Denied: the token is invalid, expired or revoked. Everything read with it was cleared.");
        return;
      }
      try { session.alive(ctx); } catch (e) { return; }  // a newer run or a forgotten session: show nothing
      $("private-state").textContent = "Reading stopped: " + (err instanceof SB.NotAllowed ? err.message : "network or browser error (" + err.name + ")");
    }
  }

  $("connect").addEventListener("submit", connect);
  $("forget").addEventListener("click", () => endSession("Token forgotten; everything read with it was cleared."));
  // Leaving the page (including into the back/forward cache) ends the session;
  // a restored page starts signed out.
  window.addEventListener("pagehide", () => endSession());
  window.addEventListener("pageshow", e => { if (e.persisted) endSession("Page restored: signed out, data cleared."); });
})();
