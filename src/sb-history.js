"use strict";
// A repository's history: the commits behind the commit a project reads, laid out in lanes with the
// branches compared against it, its tags, and what the commits read say per week, per day and per
// login. Everything is read-only GitHub evidence: no checkout, branch, reset or merge is offered, and
// no figure here is progress. History is only what was read; the view says where it stops.
// Text from GitHub only goes into text nodes.

(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, notice, STATE } = V;
  const doc = root.document;

  Object.assign(V.TIPS, {
    "History": "The commits behind the commit this project reads, newest first, with the branches compared against it and the tags that point into it. Only what was read is drawn.",
    "Ahead and behind": "GitHub's count of commits a branch has that the read commit does not (ahead), and the other way round (behind).",
    "Commits per week": "Commits read here, counted by the week they were committed (weeks start on Monday, UTC). It is activity, not progress.",
    "Commits by day": "Commits read here, counted by the day they were committed (UTC). This is not GitHub's contribution calendar, which is account-wide.",
    "Contributors": "GitHub accounts that made the commits read here, by login only. Commits not linked to an account are counted, not named.",
  });

  const tip = (node, key) => { node.setAttribute("data-tip", V.TIPS[key] || key); return node; };
  const lab = (text, key) => tip(el("p", { class: "label" }, text), key || text);
  const short = sha => sha.slice(0, 7);
  const day = t => typeof t === "string" ? t.slice(0, 10) : null;
  const plural = (n, one, many) => n.toLocaleString("en") + " " + (n === 1 ? one : many || one + "s");
  const stateName = res => (STATE[res.state] || STATE.failed)[2];
  const ZOOMS = [1, 1.5, 2];
  const ROW = 30, LANE = 16;

  function history(S, A, entry, name, pinned) {
    const d = pinned.data;
    const h = SB.historyView(A.live, name, d.commit, A.historyDepth(name, d.commit), S.histAsk);
    const parts = [];
    parts.push(tip(el("div", { class: "notice info", role: "status", "data-state": "history" }, el("span", { class: "glyph", "aria-hidden": "true" }, "i"),
      el("div", {}, el("b", {}, "History read at " + d.ref + " → " + short(d.commit)),
        el("div", {}, "Commits are read from this commit back; branches and tags as GitHub lists them now. Nothing here checks out, creates, resets or merges anything, and none of it is progress."))), "History"));
    if (h.state === "loading") { parts.push(notice("loading")); return parts; }
    if (!h.main.length) { parts.push(h.error ? notice(h.error.state, h.error.error) : notice(h.state === "current" ? "empty" : h.state, "No commits were read at this commit.")); return parts; }
    parts.push(graphCard(S, A, name, d, h));
    parts.push(branchCard(A, name, d, h));
    parts.push(tagCard(h));
    const grid = el("div", { class: "grid2" });
    grid.append(weeksCard(h, d), contributorsCard(h, d));
    parts.push(grid, daysCard(h, d));
    return parts;
  }

  // ---- The graph: one row per commit read, a lane each, drawn on a canvas beside the rows' text.

  function graphCard(S, A, name, d, h) {
    const g = h.graph, zoom = S.histZoom;
    const web = d.web;
    const refsAt = new Map();
    const add = (sha, label) => { if (!refsAt.has(sha)) refsAt.set(sha, []); refsAt.get(sha).push(label); };
    add(d.commit, { kind: "read", text: "read here: " + d.ref });
    if (h.branches && h.branches.data) for (const b of h.branches.data.refs) add(b.sha, { kind: "branch", text: b.name });
    if (h.tags && h.tags.data) for (const t of h.tags.data.refs) add(t.sha, { kind: "tag", text: "tag " + t.name });
    const rowH = ROW * zoom, laneW = LANE * zoom, gutter = Math.max(1, g.width) * laneW + 12;
    const list = el("ol", { class: "hist-rows", "aria-label": "Commits read, newest first" }, g.rows.map(r => {
      const c = r.commit;
      const href = SB.repoHref(web, "commit", c.sha);
      const kind = r.merge ? "merge" : r.root ? "root" : "commit";
      const labels = (refsAt.get(c.sha) || []).map(l => el("span", { class: "ref ref-" + l.kind }, l.text));
      const li = el("li", { "data-sha": c.sha, "data-lane": String(r.lane), "data-kind": kind },
        href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", class: "mono" }, short(c.sha)) : el("span", { class: "mono" }, short(c.sha)),
        el("span", { class: "ev-title" }, c.title), ...labels,
        el("span", { class: "qual muted" }, (c.at ? day(c.at) : "no time given") + (r.merge ? " · merge of " + c.parents.length : "") + (r.root ? " · first commit" : "")));
      li.style.minHeight = rowH + "px";
      li.style.paddingLeft = gutter + "px";
      return li;
    }));
    const canvas = el("canvas", { class: "hist-canvas", "aria-hidden": "true" });
    const box = el("div", { class: "hist-graph", tabindex: "0", role: "group", "aria-label": "Branch graph; scroll sideways to pan when zoomed in" }, canvas, list);
    box.style.setProperty("--row", rowH + "px");
    const i = ZOOMS.indexOf(zoom);
    const btn = (id, text, disabled, act) => el("button", { type: "button", class: "btn ghost", id, disabled: disabled ? "" : null, onclick: act }, text);
    const tools = el("div", { class: "actions", role: "group", "aria-label": "Graph view" },
      btn("g-in", "Zoom in", i === ZOOMS.length - 1, () => A.zoomHistory(ZOOMS[i + 1], "g-in")),
      btn("g-out", "Zoom out", i === 0, () => A.zoomHistory(ZOOMS[i - 1], "g-out")),
      btn("g-fit", "Fit", false, () => A.zoomHistory(1, "g-fit")),
      h.more ? btn("g-older", "Load older commits", false, () => A.olderHistory(name, d.commit)) : null);
    const pageNote = h.end ? "Showing all " + plural(h.main.length, "commit") + " behind " + short(d.commit) + ": this is the start of the history."
      : h.error ? "Showing the latest " + plural(h.main.length, "commit") + ". The next page could not be read (" + stateName(h.error) + "); older history is not shown."
      : h.wanted.some(w => w.kind === "page") ? "Showing the latest " + plural(h.main.length, "commit") + ". Reading older commits."
      : h.more ? "Showing the latest " + plural(h.main.length, "commit") + ". Older history is read only when you ask; nothing is guessed for it."
      : "Showing the latest " + plural(h.main.length, "commit") + ", as many as this view reads. Older history is not read.";
    const extra = g.rows.length - h.main.length;
    const notes = [el("p", { class: "qual muted plain", id: "g-end", tabindex: "-1", "data-part": "history-coverage" }, pageNote +
      (extra ? " The other " + plural(extra, "row is a compared branch's own commit", "rows are compared branches' own commits") + "." : ""))];
    if (g.unread) notes.push(el("p", { class: "qual muted plain", "data-part": "history-open" }, plural(g.unread, "line continues", "lines continue") + " past the last row into commits not read (dashed)."));
    const lanes = h.compared.filter(x => x.commits && x.commits.length);
    for (const x of lanes) if (x.unread) notes.push(el("p", { class: "qual muted plain", "data-part": "lane-unread" }, x.branch.name + ": " + plural(x.unread, "more commit") + " on this branch not read."));
    const card = el("section", { class: "card", "aria-labelledby": "graph-h", "data-part": "history-graph" },
      tip(el("h2", { id: "graph-h", class: "label" }, "Branches, merges and tags"), "History"), tools, box, ...notes);
    // Drawn once the rows are laid out, so each node sits beside its own row.
    root.requestAnimationFrame(() => draw(canvas, list, g, laneW));
    return card;
  }

  function draw(canvas, list, g, laneW) {
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx || !list.isConnected) return;
    const items = [...list.children];
    const ys = items.map(li => li.offsetTop + Math.min(li.offsetHeight, 2 * parseFloat(getComputedStyle(li).minHeight)) / 2);
    const bottom = list.offsetTop + list.offsetHeight;
    const width = Math.max(1, g.width) * laneW + 8, ratio = root.devicePixelRatio || 1;
    canvas.style.width = width + "px";
    canvas.style.height = bottom + "px";
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(bottom * ratio);
    ctx.scale(ratio, ratio);
    const css = getComputedStyle(canvas);
    const ink = css.getPropertyValue("--accent").trim() || "#1f5a8c", muted = css.getPropertyValue("--control").trim() || "#7d8996";
    const surface = css.getPropertyValue("--surface").trim() || "#ffffff";
    const x = lane => 8 + lane * laneW;
    ctx.lineWidth = 2;
    ctx.strokeStyle = ink;
    g.rows.forEach((r, i) => {
      const next = g.rows[i + 1];
      for (const [k, sources] of Object.entries(r.into)) {
        const lane = Number(k);
        const target = r.open[lane];
        for (const from of sources) {
          ctx.beginPath();
          ctx.setLineDash(next ? [] : [3, 3]);
          ctx.strokeStyle = next ? ink : muted;
          ctx.moveTo(x(from), ys[i]);
          if (next) {
            const to = next.commit.sha === target ? next.lane : lane;
            const mid = (ys[i] + ys[i + 1]) / 2;
            ctx.bezierCurveTo(x(from), mid, x(to), mid, x(to), ys[i + 1]);
          } else ctx.lineTo(x(lane), bottom);
          ctx.stroke();
        }
      }
    });
    ctx.setLineDash([]);
    g.rows.forEach((r, i) => {
      ctx.beginPath();
      ctx.arc(x(r.lane), ys[i], r.merge ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = r.merge ? surface : ink;
      ctx.strokeStyle = ink;
      ctx.fill();
      ctx.stroke();
    });
  }

  // ---- Branches compared with the read commit, and tags

  function branchCard(A, name, d, h) {
    const card = el("section", { class: "card", "aria-labelledby": "br-h", "data-part": "branches" }, tip(el("h2", { id: "br-h", class: "label" }, "Branches compared with " + d.ref + " → " + short(d.commit)), "Ahead and behind"));
    const b = h.branches;
    if (!b || b.state === "loading") { card.append(notice("loading")); return card; }
    if (!b.data) { card.append(notice(b.state, b.error)); return card; }
    const cell = x => {
      if (!x.asked) return [el("td", { colspan: 3 }, el("button", { type: "button", class: "btn ghost", "data-compare": x.branch.name, onclick: () => A.compareBranch(name, x.branch.name) }, "Compare"))];
      if (!x.cmp || x.cmp.state === "loading") return [el("td", { colspan: 3, class: "muted" }, "Loading")];
      if (!x.cmp.data) return [el("td", { colspan: 3 }, el("b", {}, stateName(x.cmp)), x.cmp.error ? el("span", { class: "muted" }, " (" + x.cmp.error + ")") : null)];
      const c = x.cmp.data;
      return [el("td", { class: "num" }, String(c.ahead)), el("td", { class: "num" }, String(c.behind)), el("td", {}, c.status[0].toUpperCase() + c.status.slice(1))];
    };
    card.append(el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
      el("thead", {}, el("tr", {}, ["Branch", "Head", "Protected", "Ahead", "Behind", "State"].map(t => el("th", { scope: "col" }, t)))),
      el("tbody", {}, h.compared.map(x => el("tr", { "data-branch": x.branch.name },
        el("th", { scope: "row", class: "mono" }, x.branch.name), el("td", { class: "mono" }, short(x.branch.sha)),
        el("td", {}, x.branch.protected === null ? el("span", { class: "muted" }, "Not given by GitHub") : x.branch.protected ? "Yes" : "No"), ...cell(x)))))));
    const notes = ["Each branch's head is compared with " + short(d.commit) + " as GitHub counts it. The first " + SB.COMPARE_FIRST + " branches are compared; Compare reads one more."];
    if (b.state === "partial") notes.push("Only the first " + plural(b.data.refs.length, "branch", "branches") + " GitHub lists were read.");
    card.append(...notes.map(n => el("p", { class: "qual muted plain" }, n)));
    return card;
  }

  function tagCard(h) {
    const card = el("section", { class: "card", "aria-labelledby": "tag-h", "data-part": "tags" }, el("h2", { id: "tag-h", class: "label" }, "Tags"));
    const t = h.tags;
    if (!t || t.state === "loading") { card.append(notice("loading")); return card; }
    if (!t.data) { card.append(t.state === "empty" ? el("p", { class: "muted plain" }, "This repository has no tags.") : notice(t.state, t.error)); return card; }
    const read = new Set(h.graph.rows.map(r => r.commit.sha));
    card.append(el("ul", { class: "feed" }, t.data.refs.map(x => el("li", { "data-tag": x.name }, el("b", { class: "mono" }, x.name), el("span", { class: "mono" }, short(x.sha)),
      el("span", { class: "qual muted" }, read.has(x.sha) ? "in the history shown" : "not in the commits read")))));
    if (t.state === "partial") card.append(el("p", { class: "qual muted plain" }, "Only the first " + plural(t.data.refs.length, "tag") + " GitHub lists were read."));
    return card;
  }

  // ---- What the commits read say: per week, per day and per login. Never progress.

  function coverage(h, d) {
    return "From the " + plural(h.main.length, "commit") + " read behind " + short(d.commit) + (h.end ? " (the whole history)" : " (not the whole history)") + ". GitHub activity, not progress.";
  }

  function weeksCard(h, d) {
    const t = SB.commitTimes(h.main);
    const shown = t.weeks.slice(-12);
    const body = shown.length ? V.bars(shown.map(w => ({ name: w.week, value: w.n, text: String(w.n), tip: "Week of " + w.week + ": " + plural(w.n, "commit") })), "Commits per week")
      : el("p", { class: "muted plain" }, "No commit read gives a time.");
    return V.chartCard("Commits per week", coverage(h, d), body, [
      t.weeks.length > shown.length ? el("p", { class: "qual muted plain" }, (t.weeks.length - shown.length) + " earlier weeks read and not drawn.") : null,
      t.untimed ? el("p", { class: "qual muted plain" }, plural(t.untimed, "commit") + " with no readable time not counted.") : null], "Commits per week");
  }

  function daysCard(h, d) {
    const t = SB.commitTimes(h.main);
    const days = t.days.slice(-26 * 7);
    if (!days.length) return V.chartCard("Commits by day", coverage(h, d), el("p", { class: "muted plain" }, "No commit read gives a time."), null, "Commits by day");
    const level = n => n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4;
    const lead = (new Date(days[0].day + "T00:00:00Z").getUTCDay() + 6) % 7;
    const grid = el("div", { class: "heat", role: "img", "aria-label": "Commits by day from " + days[0].day + " to " + days[days.length - 1].day + "; the same counts are in the table below." },
      ...Array.from({ length: lead }, () => el("span", { class: "pad" })),
      ...days.map(x => el("span", { class: "h" + level(x.n), "data-tip": x.day + ": " + plural(x.n, "commit") })));
    const busy = days.filter(x => x.n);
    const tbl = el("details", {}, el("summary", {}, "Show as a table"), el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Day"), el("th", { scope: "col" }, "Commits"))),
      el("tbody", {}, busy.map(x => el("tr", {}, el("th", { scope: "row", class: "num" }, x.day), el("td", { class: "num" }, String(x.n))))))));
    const legend = el("p", { class: "legend qual muted plain" }, "Fewer ", ...[0, 1, 2, 3, 4].map(l => el("span", { class: "sw h" + l, "aria-hidden": "true" })), " more (0, 1, 2–3, 4–6, 7 or more)");
    return V.chartCard("Commits by day", coverage(h, d) + " Not GitHub's contribution calendar.", el("div", { class: "stack tight" }, grid, legend, tbl),
      t.days.length > days.length ? el("p", { class: "qual muted plain" }, "Days before " + days[0].day + " read and not drawn.") : null, "Commits by day");
  }

  function contributorsCard(h, d) {
    const c = SB.contributors(h.main);
    const body = c.logins.length ? el("ul", { class: "feed", "data-part": "contributors" }, c.logins.slice(0, 20).map(x =>
      el("li", {}, el("span", { class: "mono" }, x.login), el("b", { class: "num" }, plural(x.n, "commit")))))
      : el("p", { class: "muted plain" }, "No commit read is linked to a GitHub account.");
    return V.chartCard("Contributors", coverage(h, d), body, [
      c.logins.length > 20 ? el("p", { class: "qual muted plain" }, (c.logins.length - 20) + " more logins not listed.") : null,
      c.unlinked ? el("p", { class: "qual muted plain", "data-part": "unlinked" }, plural(c.unlinked, "commit") + " not linked to a GitHub account: counted, not named.") : null,
      el("p", { class: "qual muted plain" }, "Logins only: no names or email addresses are read or shown.")], "Contributors");
  }

  Object.assign(V, { history });
})(typeof window !== "undefined" ? window : globalThis);
