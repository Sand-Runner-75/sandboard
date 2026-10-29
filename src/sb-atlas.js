"use strict";
// The Atlas: a second main view beside the dashboard, with the repository pictures the dashboard does not
// have. First the branch graph: git-flow lanes, zoom, drag, the files a commit changed, older commits and
// a replay of the history. Its look and controls are adapted from the owner's own earlier app (the same
// author's branch graph and its zoom), reused with the owner's permission; here it is drawn with DOM
// calls, never parsed markup, and reads only through the read-only client. Text from GitHub only goes
// into text nodes and attributes.

(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, notice } = V;
  const doc = root.document;
  // The picture namespace, from the page's own empty picture, so no address is written here.
  const ns = () => doc.getElementById("svg-ns").namespaceURI;

  Object.assign(V.TIPS, {
    "Atlas": "Pictures of a repository as GitHub has it now: its branch graph to start with. Read live, not at the commit a project pins. Nothing here changes anything, and none of it is progress.",
    "Branch graph": "The newest commits of the branches drawn, a lane each, coloured by the kind of branch: main red, hotfix green, release orange, develop blue, feature purple, any other its own colour. Merges join lanes; tags sit above their commit, branch names below.",
  });

  function svg(tag, attrs, ...kids) {
    const node = doc.createElementNS(ns(), tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
    for (const kid of kids.flat(Infinity)) if (kid) node.append(typeof kid === "object" ? kid : doc.createTextNode(String(kid)));
    return node;
  }
  const plural = (n, one, many) => n.toLocaleString("en") + " " + (n === 1 ? one : many || one + "s");
  // A bubble's lines as one spoken sentence each.
  const spoken = text => text.split("\n").filter(Boolean).join(". ");
  const tip = (node, key) => { node.setAttribute("data-tip", V.TIPS[key] || key); return node; };

  // ---- The two main tabs: Progress (the dashboard, everything as it was) and Atlas.

  const MAJOR = [["dashboard", "Progress"], ["atlas", "Atlas"]];
  function majorTabs(S, A) {
    return el("div", { class: "major", role: "tablist", "aria-label": "Main views" }, MAJOR.map(([k, l], i) =>
      el("button", { type: "button", role: "tab", id: "major-" + k, "aria-selected": String(S.major === k), tabindex: S.major === k ? "0" : "-1",
        onclick: () => A.setMajor(k),
        onkeydown: e => { if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return; e.preventDefault();
          A.setMajor(MAJOR[(i + 1) % MAJOR.length][0], true); } }, l)));
  }

  // ---- The Atlas page: a repository to show, then its pictures.

  function atlas(S, A) {
    const sec = el("section", { class: "stack atlas", role: "tabpanel", id: "atlas-panel", "aria-labelledby": "major-atlas" },
      el("h1", { id: "atlas-h", class: "sr" }, "Atlas"));
    const rows = A.atlasRepos();
    if (!rows.length) { sec.append(notice("empty", "No repository here has been read yet. The Atlas shows the repositories your projects read.")); return sec; }
    const r = A.atlasRepo();
    sec.append(el("div", { class: "filters" },
      el("label", {}, "Repository ", el("select", { id: "atlas-repo", onchange: e => A.setAtlasRepo(e.target.value) },
        rows.map(x => el("option", { value: x.repo, selected: x.repo === r.repo }, x.repo)))),
      tip(el("span", { class: "qual muted" }, "Read live from GitHub now"), "Atlas")));
    sec.append(graphPanel(S, A, r));
    return sec;
  }

  // ---- Branch graph

  function graphPanel(S, A, r) {
    const repo = r.repo, def = r.meta.branch;
    const g = SB.atlasGraph(A.live, repo, def, A.atlasShow(repo));
    const replaying = A.atlasBox(repo) && A.atlasBox(repo).box.replay;
    const head = el("div", { class: "ph" }, tip(el("h2", { id: "ag-h" }, "Branch graph"), "Branch graph"));
    const panel = el("section", { class: "card atlas-panel", "aria-labelledby": "ag-h" }, head);
    if (!g.win || !g.win.length) {
      panel.append(g.state === "loading" || g.reading ? notice("loading", "Reading the branches and their newest commits.")
        : g.state === "empty" ? notice("empty", "This repository has no branches yet.")
        : g.state === "current" ? notice("empty", "No commits to draw.")
        : notice(g.state, "The branch graph could not be read" + (g.failed ? " (the newest commits of " + g.failed.branch + ")" : "") + (g.error ? ": " + g.error : "") + "."));
      if (g.retry) panel.append(retryRow(A, repo, g));
      return panel;
    }
    const lay = SB.atlasLayout(def, g.win, g.heads, g.tags);
    const sum = el("div", { class: "legend", id: "ag-sum" },
      el("span", {}, el("b", {}, lay.commits.toLocaleString("en")), " " + (g.more ? "newest commits" : lay.commits === 1 ? "commit (whole history)" : "commits (whole history)")),
      el("span", {}, el("b", {}, String(lay.lines)), lay.lines === 1 ? " line of work" : " lines of work"),
      tagsSpan(g.meta.tags, lay.tags),
      g.total > g.heads.length ? el("span", {}, "Drawing " + g.heads.length + " of " + g.total + (g.partialBranches ? "+" : "") + " branches") : null,
      g.more ? el("button", { type: "button", class: "btn ghost small", id: "ag-older", "aria-disabled": g.reading ? "true" : null,
        onclick: () => { if (!g.reading) A.atlasOlder(repo); } }, g.reading ? "Loading older commits…" : "Load older commits") : null);
    head.append(sum, el("span", { class: "phacts" },
      el("button", { type: "button", class: "btn ghost small", id: "ag-replay", "aria-pressed": replaying ? "true" : "false",
        onclick: () => toggleReplay(A, repo) }, replaying ? "Stop" : "Replay history")));
    const sig = JSON.stringify([def, r.web, lay.W, lay.H, g.win.map(c => c.sha).join(","), g.heads, g.tags]);
    const holder = A.atlasBox(repo, sig, () => drawGraph(A, repo, r.web, lay));
    const box = holder.box;
    // The commit the keyboard is on keeps the focus when the page is drawn again, even in a new drawing.
    const was = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest(".atlas-graph .gc[data-sha]");
    const focusSha = was ? was.getAttribute("data-sha") : null;
    box.atlasMore = g.more && !g.reading && !g.failed;
    box.atlasOlder = () => A.atlasOlder(repo);
    filesTips(A, repo, box);
    panel.append(box);
    if (g.retry) panel.append(retryRow(A, repo, g));
    else if (g.meta.pulls.state === "loading") panel.append(el("div", { class: "qual plain" }, "Reading the pull requests, to label branches with their pull request numbers."));
    else if (g.meta.pulls.state === "partial") panel.append(el("div", { class: "qual plain" }, "Branch labels name pull requests from the newest 100 and the open ones only; any other branch shows its name."));
    panel.append(keyTable(lay));
    panel.append(el("div", { class: "cthint" }, "Scroll to zoom · Drag to look around · Hover a dot to see the commit and its files" + (g.more ? " · Reaching the left edge loads older commits" : "") + " ",
      el("button", { type: "button", class: "linkbtn", id: "ag-zin", "aria-label": "Zoom in", onclick: () => zoomBy(box, 1.25) }, "Zoom in"), " ",
      el("button", { type: "button", class: "linkbtn", id: "ag-zout", "aria-label": "Zoom out", onclick: () => zoomBy(box, 0.8) }, "Zoom out"), " ",
      el("button", { type: "button", class: "linkbtn", id: "ag-zreset", onclick: () => resetZoom(box) }, "Reset zoom")));
    // A box taken out of the page and put back loses its scroll position; it goes back where it was.
    Promise.resolve().then(() => {
      place(box);
      const item = focusSha && box.querySelector('.gc[data-sha="' + focusSha + '"]');
      if (item && doc.activeElement !== item) {
        for (const n of box.querySelectorAll('.gc[tabindex="0"]')) n.setAttribute("tabindex", "-1");
        item.setAttribute("tabindex", "0");
        item.focus({ preventScroll: true });
      }
    });
    return panel;
  }

  // The tag count says when the tag list is still being read, could not be read, or goes on past what was read.
  function tagsSpan(meta, n) {
    if (meta.state === "loading") return el("span", {}, "Reading the tags");
    if (meta.failed) return el("span", {}, "Tags could not be read");
    return el("span", {}, el("b", {}, n.toLocaleString("en") + (meta.state === "partial" ? "+" : "")), n === 1 && meta.state !== "partial" ? " tag" : " tags");
  }
  // What could not be read, each with its error, and one button that reads only those again.
  function retryRow(A, repo, g) {
    const parts = [];
    if (g.failed && g.win && g.win.length) parts.push("Older commits of " + g.failed.branch + " (" + (g.failed.error || g.failed.state) + ")");
    if (g.meta && g.meta.tags.failed) parts.push("the tags (" + (g.meta.tags.error || g.meta.tags.state) + "), so none are drawn");
    if (g.meta && g.meta.pulls.failed) parts.push("the pull requests (" + (g.meta.pulls.error || g.meta.pulls.state) + "), so branch labels show branch names");
    const text = parts.length ? "Could not be read: " + parts.join("; ") + ". " : "";
    return el("div", { class: "qual plain", role: "alert", id: "ag-failed" }, text,
      el("button", { type: "button", class: "linkbtn", id: "ag-retry", onclick: () => A.atlasRetry(repo) }, "Read again"));
  }

  function keyTable(lay) {
    const dot = c => svg("svg", { width: 10, height: 10, viewBox: "0 0 10 10", "aria-hidden": "true" }, svg("circle", { cx: 5, cy: 5, r: 5, fill: c }));
    return el("table", { class: "gkey" }, el("caption", { class: "sr" }, "Branch colours"),
      el("thead", {}, el("tr", {}, el("th", {}, el("span", { class: "sr" }, "Colour")), el("th", {}, "Label"), el("th", {}, "Branch"))),
      el("tbody", {}, lay.key.map(k => el("tr", {}, el("td", {}, dot(k.color)), el("td", { class: "mono" }, k.label),
        el("td", { title: k.name }, k.name, k.gone ? el("span", { class: "muted" }, " (deleted)") : null))),
        lay.hidden ? el("tr", {}, el("td", {}), el("td", {}), el("td", { class: "muted" }, "+" + plural(lay.hidden, "older deleted branch", "older deleted branches") + " (hover a dot to see its branch)")) : null));
  }

  function drawGraph(A, repo, web, lay) {
    const edges = svg("g", { fill: "none", "stroke-width": 2.5, "stroke-linecap": "round", opacity: ".85" },
      lay.edges.map(e => svg("path", { "data-s": e.s, d: e.d, stroke: e.color, "stroke-dasharray": e.dashed ? "3 4" : null })));
    // Each commit is one focusable item named by its details: a link to the commit on GitHub when there is
    // an address, else a picture item. Only one is in the Tab order; Left and Right move between them.
    const last = lay.nodes.length - 1;
    const nodes = lay.nodes.map((n, i) => {
      const dot = svg("g", { class: "gn" }, svg("circle", { cx: n.x, cy: n.y, r: n.r, fill: n.color }));
      const href = SB.repoHref(web, "commit", n.sha);
      const item = href ? svg("a", { href, target: "_blank", rel: "noopener noreferrer" }, dot) : svg("g", { role: "img" }, dot);
      for (const [k, v] of [["class", "gc"], ["data-s", n.s], ["data-sha", n.sha], ["data-tip", n.tip], ["aria-label", spoken(n.tip)], ["tabindex", i === last ? "0" : "-1"]]) item.setAttribute(k, String(v));
      item.dataset.base = n.tip;
      return item;
    });
    const flags = lay.flags.map(f => svg("g", { "data-s": f.s, "data-tip": f.tip, class: "flag-" + f.kind },
      svg("polygon", { points: f.points.map(p => p.join(",")).join(" "), fill: f.color }),
      svg("rect", { x: f.x, y: f.y, width: f.w, height: f.h, rx: 3, fill: f.color }),
      svg("text", { class: "fl", fill: "#fff", x: f.x + f.w / 2, y: f.y + 11.5, "text-anchor": "middle" }, f.text)));
    const guides = lay.guides.map(y => svg("line", { class: "guide", x1: 0, x2: lay.W, y1: y, y2: y, "stroke-dasharray": "3 6" }));
    const pic = svg("svg", { viewBox: "0 0 " + lay.W + " " + lay.H, width: lay.W, height: lay.H, role: "img", "aria-label": "Branch graph of the " + plural(lay.commits, "commit") + " drawn" },
      guides, edges, nodes, flags);
    const box = el("div", { class: "atlas-graph", id: "ag-box", tabindex: "0", role: "group",
      "aria-label": "Branch graph. Plus and minus zoom, arrow keys move, 0 resets the zoom. Tab moves to the newest commit; Left and Right move between commits, and each commit's details and changed files are read out." }, pic);
    box.steps = lay.steps;
    box.zoom = 1;
    setup(box);
    return box;
  }

  // ---- Zoom and hover. Zooming sizes the picture through its style only, so its own width and height
  // keep meaning the unzoomed graph.

  const ZMIN = 0.2, ZMAX = 3, WAIT = 350, SHOW = 8;
  function size(box) {
    const pic = box.querySelector("svg");
    if (!pic) return;
    const z = box.zoom || 1;
    pic.style.width = pic.getAttribute("width") * z + "px";
    pic.style.height = pic.getAttribute("height") * z + "px";
  }
  // Zoom to z, keeping the graph point under (cx, cy) where it is. Zooming out stops once the whole graph fits.
  function zoomTo(box, z, cx, cy) {
    const W = Number(box.querySelector("svg").getAttribute("width")), fit = Math.min(1, box.clientWidth / W);
    const z0 = box.zoom || 1;
    z = Math.max(Math.max(ZMIN, fit), Math.min(ZMAX, z));
    if (Math.abs(z - z0) < 0.001) return;
    const b = box.getBoundingClientRect();
    if (cx === undefined || cx === null) { cx = b.left + box.clientWidth / 2; cy = b.top + box.clientHeight / 2; }
    const gx = (box.scrollLeft + cx - b.left) / z0, gy = (box.scrollTop + cy - b.top) / z0;
    box.zoom = z; size(box);
    box.scrollLeft = gx * z - (cx - b.left); box.scrollTop = gy * z - (cy - b.top);
    remember(box);
  }
  const zoomBy = (box, k) => zoomTo(box, (box.zoom || 1) * k);
  function resetZoom(box) {
    const z = box.zoom || 1, fromRight = box.scrollWidth - box.scrollLeft;
    zoomTo(box, 1);
    if (z !== 1) box.scrollLeft = box.scrollWidth - fromRight / z;
    remember(box);
  }
  // Where the view is, measured from the newest end, so older commits added on the left keep it in place.
  function remember(box) { box.fromRight = box.scrollWidth - box.scrollLeft; box.top = box.scrollTop; }
  function place(box) {
    if (!box.isConnected) return;
    size(box);
    box.placing = true;
    box.scrollLeft = box.fromRight === undefined ? box.scrollWidth : box.scrollWidth - box.fromRight;
    box.scrollTop = box.top || 0;
    box.placing = false;
  }

  function setup(box) {
    box.addEventListener("wheel", e => {
      if (e.ctrlKey && !e.deltaY) return;
      // Sideways scrolling (a touchpad, or Shift and the wheel) still moves along the history.
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      zoomTo(box, (box.zoom || 1) * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
    box.addEventListener("scroll", () => {
      if (box.placing) return;
      remember(box);
      if (box.scrollLeft < 120 && box.scrollWidth > box.clientWidth && !box.replay && box.atlasMore) { box.atlasMore = false; box.atlasOlder(); }
    }, { passive: true });
    box.addEventListener("keydown", e => {
      const item = e.target.closest && e.target.closest(".gc[data-sha]");
      if (item && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")) {
        e.preventDefault();
        const all = [...box.querySelectorAll(".gc[data-sha]")].sort((a, b) => a.getAttribute("data-s") - b.getAttribute("data-s"));
        const at = all.indexOf(item);
        const to = all[e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.max(0, Math.min(all.length - 1, at + (e.key === "ArrowLeft" ? -1 : 1)))];
        if (to && to !== item) { item.setAttribute("tabindex", "-1"); to.setAttribute("tabindex", "0"); to.focus(); }
        return;
      }
      if (e.target !== box) return;
      const move = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60] }[e.key];
      if (move) { e.preventDefault(); box.scrollLeft += move[0]; box.scrollTop += move[1]; }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(box, 1.25); }
      else if (e.key === "-") { e.preventDefault(); zoomBy(box, 0.8); }
      else if (e.key === "0") { e.preventDefault(); resetZoom(box); }
    });
    // Dragging moves the view; a press that barely moves is still a click that opens the commit.
    let drag = null, moved = false;
    box.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, l: box.scrollLeft, t: box.scrollTop, id: e.pointerId }; moved = false;
    });
    box.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!moved && dx * dx + dy * dy < 25) return;
      if (!moved) { moved = true; box.classList.add("dragging"); try { box.setPointerCapture(drag.id); } catch (err) { /* the pointer is already gone */ } }
      box.scrollLeft = drag.l - dx; box.scrollTop = drag.t - dy;
    });
    const end = () => { drag = null; box.classList.remove("dragging"); };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    box.addEventListener("click", e => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
    box.addEventListener("dragstart", e => e.preventDefault());
    // A commit's files are read only after the pointer rests on its dot, once per commit.
    let timer = null;
    box.addEventListener("pointerover", e => {
      const dot = e.target.closest && e.target.closest(".gc[data-sha]");
      clearTimeout(timer);
      if (!dot || drag) return;
      timer = setTimeout(() => { if (box.askFiles) box.askFiles(dot.getAttribute("data-sha")); }, WAIT);
    });
    box.addEventListener("pointerleave", () => clearTimeout(timer));
    // A commit reached by the keyboard reads its files at once; its bubble shows them when they come.
    box.addEventListener("focusin", e => {
      const item = e.target.closest && e.target.closest(".gc[data-sha]");
      if (item && box.askFiles) box.askFiles(item.getAttribute("data-sha"));
    });
  }

  // The files of each commit asked for, under the commit's own lines in its bubble.
  const short = p => p.length > 36 ? "…" + p.slice(-35) : p;
  function filesTips(A, repo, box) {
    box.askFiles = sha => {
      box.asked = box.asked || new Set();
      if (box.asked.has(sha)) return;  // asked once per commit; the bubble shows the read as it goes
      box.asked.add(sha);
      A.atlasFiles(repo, sha);
    };
    for (const sha of box.asked || []) {
      const dot = box.querySelector('.gc[data-sha="' + sha + '"]');
      if (!dot) continue;
      const res = A.live(SB.codeKey.commit(repo, sha));
      const files = res && res.data ? res.data.files : null;
      const text = !res || res.state === "loading" ? "Reading the files…" : !files ? "The files could not be read"
        : [(files.length ? files.length + (res.state === "partial" ? "+" : "") + (files.length === 1 ? " file changed" : " files changed") : "No files changed"),
           ...files.slice(0, SHOW).map(f => (f.status === "added" ? "+" : f.status === "removed" ? "−" : f.status === "renamed" ? "→" : "•") + " " + short(f.path) + "  +" + f.added + " −" + f.removed),
           ...(files.length > SHOW ? ["and " + (files.length - SHOW) + " more"] : [])].join("\n");
      dot.setAttribute("data-tip", dot.dataset.base + "\n\n" + text);
      dot.setAttribute("aria-label", spoken(dot.dataset.base + "\n" + text));
      A.retip(dot);
    }
  }

  // ---- Replay: the graph drawn again commit by commit.

  function showUpTo(pic, k) { for (const n of pic.querySelectorAll("[data-s]")) n.style.opacity = Number(n.getAttribute("data-s")) <= k ? "" : "0"; }
  function stopReplay(box, finish) {
    const rp = box.replay;
    if (!rp) return;
    clearInterval(rp.timer);
    box.replay = null;
    if (finish && rp.pic.isConnected) showUpTo(rp.pic, Infinity);
  }
  function toggleReplay(A, repo) {
    const holder = A.atlasBox(repo);
    if (!holder) return;
    const box = holder.box, pic = box.querySelector("svg"), steps = box.steps;
    if (box.replay) { stopReplay(box, true); A.render(); return; }
    if (!pic || !steps || !steps.length) return;
    let k = 0;
    box.replay = { pic, timer: null };
    showUpTo(pic, 0);
    box.scrollLeft = 0;
    box.replay.timer = setInterval(() => {
      if (!pic.isConnected) { stopReplay(box, false); return; }
      k++;
      showUpTo(pic, k);
      const x = steps[Math.min(k, steps.length - 1)].x;
      box.scrollLeft = Math.max(0, x * (box.zoom || 1) - box.clientWidth * 0.7);
      remember(box);
      if (k >= steps.length - 1) { stopReplay(box, true); A.render(); }
    }, Math.max(60, Math.min(220, 6000 / steps.length)));
    A.render();
  }

  Object.assign(V, { majorTabs, atlas });
})(typeof window !== "undefined" ? window : globalThis);
