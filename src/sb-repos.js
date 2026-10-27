"use strict";
// The repository overview views: all mapped repositories (the portfolio), their activity and
// languages, a fuller repository header, and a project's activity feed. Every figure here is
// GitHub's own count about repositories, never task progress. Only repositories the workspace list
// names (or the owner opened by name for this visit) appear; nothing else from the account is read.
// Text from GitHub only goes into text nodes (or through SB.renderText).

(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, notice, STATE } = V;
  const doc = root.document;

  const TIPS = {
    "All repositories": "Every repository the workspace list names, with what GitHub says about it. Nothing else in the account is listed.",
    "Activity": "GitHub's counts about the mapped repositories: languages, ages, stars and kinds. They describe repositories, not how far a plan has got.",
    "Not progress": "GitHub activity: commits, pull requests, stars and languages say what happened in a repository, not how much of a plan is done. No figure here changes a progress figure.",
    "Opened by name": "A repository you typed in for this visit. It is not in the workspace list, has no plan, and goes when you forget access.",
    "Original": "A repository of its own, not a fork of another one.",
    "Fork": "A copy of another repository, made on GitHub.",
    "Archived": "Read-only on GitHub: its owner archived it.",
    "Code bytes": "How many bytes of code GitHub counted for each language on the default branch.",
    "Lifespan": "From when the repository was created to its last push. A long line is not a finished project.",
    "Recent activity": "The latest commits, pull requests and handoff comments in this project's repositories, newest first. Each links to where it happened. It is evidence of activity, not progress.",
    "Plan progress": "Only a plan's own progress output gives progress. A repository without a plan has none, which is not the same as 0%.",
  };
  Object.assign(V.TIPS, TIPS);
  const tip = (node, key) => { node.setAttribute("data-tip", V.TIPS[key] || key); return node; };
  const lab = (text, key) => tip(el("p", { class: "label" }, text), key || text);
  const day = t => typeof t === "string" ? t.slice(0, 10) : null;
  const when = t => typeof t === "string" ? t.slice(0, 16).replace("T", " ") + " UTC" : "";
  const notGiven = () => el("span", { class: "muted" }, "Not given by GitHub");
  const shown = (v, fmt) => v === null || v === undefined ? notGiven() : fmt ? fmt(v) : String(v);
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  // A main language: GitHub's explicit "none" differs from a value it did not give.
  const langName = v => v === null || v === undefined ? "Not given by GitHub" : v === "none" ? "No main language" : v;
  const typeText = m => m.fork === null ? notGiven() : [m.fork ? "Fork" : "Original", m.archived ? "archived" : null].filter(Boolean).join(", ");
  const sizeText = kb => kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB";
  const stateName = res => (STATE[res.state] || STATE.failed)[2];

  // ---- Bars: one series, so no legend; every bar carries its value as text and a bubble.

  function bars(items, label) {
    const max = Math.max(1, ...items.map(i => i.value));
    return el("ul", { class: "bars", "aria-label": label }, items.map(i => {
      const fill = el("span", { class: "fill" + (i.hatch ? " hatch" : "") });
      fill.style.width = Math.max(i.value ? 2 : 0, (i.value / max) * 100) + "%";
      return el("li", { "data-tip": i.tip || null }, el("span", { class: "bname" }, i.name), el("span", { class: "btrack", "aria-hidden": "true" }, fill),
        el("span", { class: "bval num" }, i.text));
    }));
  }

  // ---- Portfolio

  function sourceNote(rows) {
    const read = rows.filter(r => r.meta).length;
    return tip(el("p", { class: "plain muted" }, "The workspace list names ", el("b", {}, plural(rows.length, "repository", "repositories")),
      "; ", read === rows.length ? "all were read." : read + " could be read.", " Each was read once, at its pinned commit. Nothing else in the account is listed."), "All repositories");
  }

  function openForm(A) {
    const status = el("p", { class: "status-line", role: "status" });
    const input = el("input", { id: "open-repo", type: "text", placeholder: "owner/name", autocomplete: "off", spellcheck: "false" });
    const form = el("form", { class: "filters open-form", onsubmit: e => { e.preventDefault(); A.openByName(input.value, status); input.value = ""; } },
      tip(el("label", {}, "Open a repository by name", input), "Opened by name"), el("button", { type: "submit", class: "btn ghost" }, "Open"));
    return el("div", { class: "stack tight" }, form, status);
  }

  function portfolio(S, A) {
    const rows = SB.portfolio(S.entries);
    const f = S.repoFilters;
    const sec = el("section", { class: "stack", "aria-labelledby": "view-h" },
      el("header", { class: "head" }, el("div", { class: "row1" }, el("h1", { id: "view-h" }, "All repositories"), el("span", { class: "stage-tag" }, "Account")),
        sourceNote(rows)));
    sec.append(openForm(A));
    const opts = SB.portfolioOptions(rows);
    const select = (id, key, values, all) => {
      const s = el("select", { id, onchange: e => A.setRepoFilter(key, e.target.value, id) }, el("option", { value: "" }, all),
        values.map(v => el("option", { value: v[0] }, v[1])));
      s.value = f[key];
      return s;
    };
    const q = el("input", { id: "rq", type: "search", placeholder: "Name, description or topic", autocomplete: "off", spellcheck: "false",
      oninput: e => A.setRepoFilter("q", e.target.value, "rq") });
    q.value = f.q;
    const sort = el("select", { id: "r-sort", onchange: e => A.setRepoFilter("sort", e.target.value, "r-sort") },
      Object.entries(SB.SORTS).map(([k, v]) => el("option", { value: k }, v)));
    sort.value = f.sort;
    const group = el("input", { id: "r-group", type: "checkbox", onchange: e => A.setRepoFilter("group", e.target.checked, "r-group") });
    group.checked = f.group;
    sec.append(el("div", { class: "filters", role: "search" },
      el("label", {}, "Search repositories", q),
      el("label", {}, "Visibility", select("r-vis", "visibility", opts.visibilities.map(v => [v, v[0].toUpperCase() + v.slice(1)]).concat(opts.unknown.visibility ? [["?", "Not given by GitHub"]] : []), "Any")),
      el("label", {}, "Language", select("r-lang", "language", opts.languages.map(l => [l, l]).concat(opts.noLanguage ? [["-", "No main language"]] : [], opts.unknown.language ? [["?", "Not given by GitHub"]] : []), "Any")),
      el("label", {}, "Type", select("r-type", "type", [["original", "Originals"], ["fork", "Forks"], ["archived", "Archived"]].concat(opts.unknown.type ? [["?", "Not given by GitHub"]] : []), "Any")),
      el("label", {}, "Sort by", sort),
      el("label", { class: "check" }, group, "Group by project")));
    const list = SB.sortPortfolio(SB.filterPortfolio(rows, f), f.sort);
    if (!rows.length) { sec.append(notice("empty", "The workspace list names no repositories.")); return sec; }
    if (!list.length) { sec.append(notice("no-match", "Change the search or filters. Nothing was changed by filtering.", "No repositories match")); return sec; }
    if (!f.group) sec.append(table(A, list));
    else {
      // One folded group per project, in the workspace list's order; a repository in two projects is in both.
      for (const e of S.entries) {
        const mine = list.filter(r => r.projects.some(p => p.id === e.w.id));
        if (!mine.length) continue;
        sec.append(el("details", { class: "group", open: true, "data-group": e.w.id },
          el("summary", {}, el("b", {}, e.w.label), " ", el("span", { class: "muted" }, plural(mine.length, "repository", "repositories"))), table(A, mine)));
      }
    }
    sec.append(tip(el("p", { class: "qual muted plain" }, "Stars, forks, issues, sizes and dates are GitHub's own figures about each repository. They are not progress, and filtering or sorting changes none of them."), "Not progress"));
    return sec;
  }

  const COLUMNS = ["Repository", "Projects and roles", "Visibility", "Type", "Main language", "Topics", "Stars", "Forks", "Open issues", "Size", "Last push"];

  function table(A, rows) {
    const body = el("tbody", {}, rows.map(r => {
      const first = r.projects[0];
      const name = el("button", { type: "button", class: "linkbtn mono", "data-repo": r.repo, onclick: () => A.go(first.id, { kind: "repo", repo: r.repo }) }, r.repo);
      const roles = r.projects.map((p, i) => [i ? "; " : "", p.label, " (", p.opened ? tip(el("span", {}, "opened by name"), "Opened by name") : p.role, ")"]);
      if (!r.meta) {
        const res = r.pinned || { state: "loading" };
        return el("tr", { "data-state": res.state }, el("th", { scope: "row" }, name), el("td", {}, roles),
          el("td", { colspan: COLUMNS.length - 2 }, res.state === "loading" ? el("span", { class: "muted" }, "Loading")
            : [el("b", {}, stateName(res)), res.error ? el("span", { class: "muted" }, " (" + res.error + ")") : null, ". Nothing else about it is shown."]));
      }
      const m = r.meta;
      const num = v => el("td", { class: "num" }, shown(v));
      return el("tr", { "data-repo": r.repo }, el("th", { scope: "row" }, name), el("td", {}, roles),
        el("td", {}, shown(m.visibility, v => v[0].toUpperCase() + v.slice(1))), el("td", {}, typeText(m)),
        el("td", {}, m.language === "none" ? el("span", { class: "muted" }, "None") : m.language === null ? notGiven() : m.language),
        el("td", {}, m.topics === null ? notGiven() : m.topics.length ? m.topics.join(", ") : el("span", { class: "muted" }, "None")),
        num(m.stars), num(m.forks), num(m.issues), el("td", { class: "num" }, shown(m.size, sizeText)), el("td", { class: "num" }, shown(m.pushed, day)));
    }));
    return el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
      el("thead", {}, el("tr", {}, COLUMNS.map(c => el("th", { scope: "col" }, c)))), body));
  }

  // ---- Activity and languages

  function activity(S, A) {
    const rows = SB.portfolio(S.entries);
    const a = SB.analytics(rows);
    const sec = el("section", { class: "stack", "aria-labelledby": "view-h" },
      el("header", { class: "head" }, el("div", { class: "row1" }, el("h1", { id: "view-h" }, "Activity and languages"), el("span", { class: "stage-tag" }, "Account")),
        sourceNote(rows)));
    const user = A.live("user");
    sec.append(el("p", { class: "plain", "data-part": "account" }, "Read as ",
      !user || user.state === "loading" ? el("span", { class: "muted" }, "Loading")
        : user.state === "current" ? [el("b", { class: "mono" }, user.data.login), user.data.type ? " (" + user.data.type + ")" : ""]
        : el("span", { class: "muted" }, stateName(user)), ". Only the repositories above are read; no account-wide list, feed or contribution count is."));
    sec.append(tip(el("div", { class: "notice info", role: "status", "data-state": "activity" }, el("span", { class: "glyph", "aria-hidden": "true" }, "i"),
      el("div", {}, el("b", {}, "GitHub activity, not progress"), el("div", {}, "These figures describe the repositories. Only a plan's progress output says how far its work has got."))), "Not progress"));
    if (!a.read) { sec.append(rows.some(r => !r.pinned) ? notice("loading") : notice("unavailable", "No mapped repository could be read, so there is nothing to count.")); return sec; }
    const c = a.counters;
    // Categorical counts say how many repositories gave the field, as the sums do.
    const over = known => el("div", { class: "qual muted" }, known === a.read ? "over " + plural(a.read, "repository", "repositories")
      : "over the " + known + " of " + a.read + " that give it; " + (a.read - known) + " not given by GitHub");
    const sumCard = (name, s) => el("div", { class: "card" }, el("p", { class: "label" }, name), el("div", { class: "big num" }, String(s.total)),
      el("div", { class: "qual muted" }, s.known === a.read ? "over " + plural(a.read, "repository", "repositories") : "over the " + s.known + " of " + a.read + " that give it"));
    sec.append(el("div", { class: "counters", "aria-label": "Counters" },
      el("div", { class: "card" }, el("p", { class: "label" }, "Repositories"), el("div", { class: "big num" }, String(a.read)),
        el("div", { class: "qual muted" }, a.read === a.mapped ? "all mapped ones read" : "read of " + a.mapped + " mapped")),
      el("div", { class: "card" }, el("p", { class: "label" }, "Visibility"), el("div", { class: "num" }, c.public + " public · " + c.private + " private" + (c.internal ? " · " + c.internal + " internal" : "")), over(c.visibilityKnown)),
      el("div", { class: "card" }, tip(el("p", { class: "label" }, "Kind"), "Original"), el("div", { class: "num" }, plural(c.original, "original") + " · " + plural(c.fork, "fork")), over(c.typeKnown),
        c.archived ? el("div", { class: "qual muted" }, c.archived + " archived") : null),
      sumCard("Stars", c.stars), sumCard("Forks", c.forks), sumCard("Open issues", c.issues)));
    const grid = el("div", { class: "grid2" });
    grid.append(chartCard("Languages by number of repositories", "Each repository counts once, by the main language GitHub gives it.",
      bars(a.languages.map(l => ({ name: langName(l.value), value: l.n, text: String(l.n),
        tip: langName(l.value) + ": " + plural(l.n, "repository", "repositories") })), "Languages by number of repositories")));
    grid.append(bytesCard(A, rows.filter(r => r.meta)));
    grid.append(chartCard("Repositories by year created", "Originals as solid bars, forks as hatched bars.",
      a.years.length ? el("ul", { class: "bars", "aria-label": "Repositories by year created" }, a.years.map(y => yearBar(y, a.years))) : el("p", { class: "muted plain" }, "No creation dates given."),
      a.noYear ? el("p", { class: "qual muted plain" }, plural(a.noYear, "repository", "repositories") + " gave no creation date.") : null));
    grid.append(chartCard("Lifespans", "From creation to the last push.", lifespans(a.lifespans), null, "Lifespan"));
    sec.append(grid);
    sec.append(chartCard("Stars and last push", "Each dot is a repository: how recently it was pushed to, and its stars.", scatter(a.scatter)));
    sec.append(el("div", { class: "grid3" },
      tally("Kind", a.composition.type, v => v === null ? "Not given" : v[0].toUpperCase() + v.slice(1)),
      tally("Licence", a.composition.license, v => v === null ? "Not given" : v === "none" ? "No licence" : v),
      tally("Default branch", a.composition.branch, v => v === null ? "Not given" : v)));
    sec.append(el("p", { class: "qual muted plain" }, "Contributions by day and commits per week are read with each repository's history, in a later slice."));
    return sec;
  }

  function chartCard(title, note, body, extra, tipKey) {
    return el("section", { class: "card chart", "aria-label": title }, lab(title, tipKey || "Activity"), note ? el("p", { class: "qual muted plain" }, note) : null, body, extra || null);
  }

  function yearBar(y, years) {
    const max = Math.max(...years.map(x => x.original + x.fork + x.unknown));
    const total = y.original + y.fork + y.unknown;
    const seg = (n, cls) => { const s = el("span", { class: "fill" + cls }); s.style.width = (n / max) * 100 + "%"; return n ? s : null; };
    const parts = [plural(y.original, "original"), plural(y.fork, "fork"), y.unknown ? y.unknown + " not given" : null].filter(Boolean).join(", ");
    return el("li", { "data-tip": y.year + ": " + total + " (" + parts + ")" }, el("span", { class: "bname num" }, String(y.year)),
      el("span", { class: "btrack split", "aria-hidden": "true" }, seg(y.original, ""), seg(y.fork, " hatch"), seg(y.unknown, " hollow")),
      el("span", { class: "bval num" }, total + " (" + parts + ")"));
  }

  function bytesCard(A, rows) {
    const results = rows.map(r => A.live("lang|" + r.repo) || { state: "loading" });
    const loading = results.filter(r => r.state === "loading").length;
    const lb = SB.languageBytes(results);
    const failed = rows.filter((r, i) => !results[i].data && results[i].state !== "loading");
    const body = !lb.read ? (loading ? notice("loading") : notice("unavailable", "No repository's language counts could be read."))
      : lb.languages.length ? bars(lb.languages.slice(0, 12).map(l => { const pct = (l.bytes / lb.bytes) * 100;
          return { name: l.name, value: l.bytes, text: (pct < 0.1 ? "<0.1" : pct.toFixed(1)) + "%", tip: l.name + ": " + l.bytes.toLocaleString("en") + " bytes" }; }), "Languages by code bytes")
      : el("p", { class: "muted plain" }, "GitHub counted no code in these repositories.");
    return chartCard("Languages by code bytes", "Share of all code bytes GitHub counted, over " + plural(lb.read, "repository", "repositories") +
      (lb.read < rows.length ? " of " + rows.length : "") + ".", body,
      [loading ? el("p", { class: "qual muted plain" }, "Still reading " + plural(loading, "repository", "repositories") + ".") : null,
       lb.languages.length > 12 ? el("p", { class: "qual muted plain" }, (lb.languages.length - 12) + " smaller languages not drawn.") : null,
       failed.length ? el("p", { class: "qual muted plain", "data-part": "bytes-missing" }, "Not counted: " + failed.map(r => r.repo + " (" + stateName(A.live("lang|" + r.repo)) + ")").join(", ") + ".") : null],
      "Code bytes");
  }

  function lifespans(list) {
    if (!list.length) return el("p", { class: "muted plain" }, "No repository gave both dates.");
    const t = x => Date.parse(x);
    const lo = Math.min(...list.map(l => t(l.created))), hi = Math.max(...list.map(l => t(l.pushed)), lo + 1);
    return el("ul", { class: "bars spans", "aria-label": "Lifespans" }, list.map(l => {
      const s = el("span", { class: "fill" });
      s.style.marginLeft = ((t(l.created) - lo) / (hi - lo)) * 100 + "%";
      s.style.width = Math.max(1, ((t(l.pushed) - t(l.created)) / (hi - lo)) * 100) + "%";
      const text = day(l.created) + " to " + day(l.pushed);
      return el("li", { "data-tip": l.repo + ": created " + day(l.created) + ", last push " + day(l.pushed) },
        el("span", { class: "bname mono" }, l.repo.split("/")[1]), el("span", { class: "btrack", "aria-hidden": "true" }, s), el("span", { class: "bval num" }, text));
    }));
  }

  // One axis each way: last push across, stars up, drawn as positioned dots. A table with the same values follows.
  function scatter(points) {
    if (!points.length) return el("p", { class: "muted plain" }, "No repository gave both stars and a last push.");
    const xs = points.map(p => Date.parse(p.pushed)), ys = points.map(p => p.stars);
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 864e5), y1 = Math.max(...ys, 1);
    const plot = el("div", { class: "plot", role: "img", "aria-label": "Stars against last push for " + plural(points.length, "repository", "repositories") + "; the same values are in the table below." },
      el("span", { class: "tick y1" }, String(y1)), el("span", { class: "tick y0" }, "0"),
      el("span", { class: "tick x0" }, day(new Date(x0).toISOString())), el("span", { class: "tick x1" }, day(new Date(x1).toISOString())));
    const area = el("div", { class: "plot-area" });
    points.forEach((p, i) => {
      const dot = el("span", { class: "pt", "data-tip": p.repo + ": " + plural(p.stars, "star") + ", last push " + day(p.pushed) });
      dot.style.left = ((xs[i] - x0) / (x1 - x0)) * 100 + "%";
      dot.style.bottom = (p.stars / y1) * 100 + "%";
      area.append(dot);
    });
    plot.append(area);
    const tbl = el("details", {}, el("summary", {}, "Show as a table"), el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Repository"), el("th", { scope: "col" }, "Stars"), el("th", { scope: "col" }, "Last push"))),
      el("tbody", {}, points.map(p => el("tr", {}, el("th", { scope: "row", class: "mono" }, p.repo), el("td", { class: "num" }, String(p.stars)), el("td", { class: "num" }, day(p.pushed))))))));
    return el("div", { class: "stack tight" }, plot, tbl);
  }

  function tally(title, items, name) {
    return el("section", { class: "card", "aria-label": title }, lab(title, "Activity"),
      el("ul", { class: "feed" }, items.map(i => el("li", {}, el("span", {}, name(i.value)), el("b", { class: "num" }, String(i.n))))));
  }

  // ---- One repository: what GitHub says about it, its languages and its recent activity

  function repoDetails(S, A, entry, name, pinned, role) {
    const d = pinned.data;
    const m = d.meta || {};
    const parts = [];
    const props = el("dl", { class: "props", "data-part": "repo-meta" },
      el("dt", {}, "Description"), el("dd", {}, shown(m.description)),
      el("dt", {}, "Type"), el("dd", {}, m.fork === undefined ? notGiven() : typeText(m)),
      el("dt", {}, "Main language"), el("dd", {}, m.language === "none" ? el("span", { class: "muted" }, "None") : shown(m.language)),
      el("dt", {}, "Default branch"), el("dd", { class: "mono" }, shown(m.branch)),
      el("dt", {}, "Licence"), el("dd", {}, m.license === "none" ? "No licence" : shown(m.license)),
      el("dt", {}, "Created"), el("dd", {}, shown(m.created, day)),
      el("dt", {}, "Last push"), el("dd", {}, shown(m.pushed, day)),
      el("dt", {}, "Stars · forks · open issues"), el("dd", { class: "num" }, [shown(m.stars), " · ", shown(m.forks), " · ", shown(m.issues)]),
      el("dt", {}, "Size"), el("dd", {}, shown(m.size, sizeText)),
      el("dt", {}, "Topics"), el("dd", {}, m.topics ? (m.topics.length ? m.topics.join(", ") : el("span", { class: "muted" }, "None")) : notGiven()),
      el("dt", {}, "Homepage"), el("dd", {}, m.homepage ? SB.renderText(doc, m.homepage).node : el("span", { class: "muted" }, "None given")));
    const clone = d.web ? el("span", { class: "mono", id: "clone-url" }, d.web + ".git") : null;
    const status = el("p", { class: "status-line", role: "status" });
    parts.push(el("section", { class: "card", "aria-labelledby": "about-h" }, el("h2", { id: "about-h", class: "label" }, "About"), props,
      clone ? el("div", { class: "actions" }, el("span", {}, "Clone address: ", clone), el("button", { type: "button", class: "btn ghost", "data-copy": "clone",
        onclick: () => A.copy(clone, status) }, "Copy")) : el("p", { class: "muted plain" }, "GitHub gave no web address, so no clone address is shown."),
      status, el("p", { class: "qual muted plain" }, "Nothing here clones or runs the repository; the address is only copied.")));
    if (!entry.w.plan) {
      parts.push(tip(el("div", { class: "notice info", role: "status", "data-state": "no-plan" }, el("span", { class: "glyph", "aria-hidden": "true" }, "○"),
        el("div", {}, el("b", {}, "Plan progress: not available"), el("div", {}, entry.w.opened ? "Opened by name for this visit: it has no plan, so there are no tasks and no progress. It is not 0%."
          : "This project has no plan repository, so there are no tasks and no progress. It is not 0%."))), "Plan progress"));
    }
    const lang = A.live("lang|" + name);
    parts.push(chartCard("Languages", "Share of the code bytes GitHub counted on the default branch.", !lang || lang.state === "loading" ? notice("loading")
      : lang.state === "empty" ? el("p", { class: "muted plain" }, "GitHub counted no code here.")
      : lang.data ? bars(lang.data.languages.map(l => ({ name: l.name, value: l.bytes, text: ((l.bytes / lang.data.languages.reduce((n, x) => n + x.bytes, 0)) * 100).toFixed(1) + "%",
          tip: l.name + ": " + l.bytes.toLocaleString("en") + " bytes" })), "Languages of " + name)
      : notice(lang.state, lang.error), null, "Code bytes"));
    parts.push(feedCard(S, A, entry, [name], "Recent activity in this repository"));
    return parts;
  }

  // ---- A project's activity feed (bounded evidence; never subscriptions, alerts or progress)

  const EVENT = { commit: "Commit", opened: "Pull request opened", merged: "Merged", closed: "Closed without merging", handoff: "Handoff" };
  const FEED_SHOWN = 25;

  function feedCard(S, A, entry, repos, title) {
    const card = el("section", { class: "card", "aria-labelledby": "feed-h", "data-part": "feed" }, tip(el("h2", { id: "feed-h", class: "label" }, title || "Recent activity"), "Recent activity"));
    const rows = SB.portfolio([entry]).filter(r => repos.includes(r.repo));
    if (!rows.length) { card.append(el("p", { class: "muted plain" }, "No repository.")); return card; }
    const sources = [], problems = [];
    let loading = 0;
    for (const r of rows) {
      if (!r.meta) { if (r.pinned && r.pinned.state !== "loading") problems.push(r.repo + ": " + stateName(r.pinned) + ", not read"); else loading += 1; continue; }
      const f = A.live(SB.feedKey(r.repo, r.pinned.data.commit));
      if (!f || f.state === "loading") { loading += 1; continue; }
      if (!f.data) { problems.push(r.repo + ": " + stateName(f)); continue; }
      sources.push({ repo: r.repo, web: r.pinned.data.web, commits: f.data.commits, pulls: f.data.pulls, comments: f.data.comments, ref: r.pinned.data.ref });
      for (const [what, res] of [["commits", f.data.commits], ["pull requests", f.data.pulls], ["comments", f.data.comments]]) {
        if (!res.data) problems.push(r.repo + ": " + what + " " + stateName(res).toLowerCase() + (res.error ? " (" + res.error + ")" : ""));
        else if (res.state === "partial") problems.push(r.repo + ": only the latest " + (what === "pull requests" ? 100 : what === "commits" ? SB.COMMIT_LIMIT : SB.REPO_COMMENT_LIMIT) + " " + what + " were read");
      }
    }
    const feed = SB.feedEvents(sources);
    if (loading && !feed.events.length) card.append(notice("loading"));
    else if (!feed.events.length) card.append(el("p", { class: "muted plain", "data-part": "feed-empty" }, !sources.length ? "Nothing could be read."
      : feed.untimed ? "Activity was read, but no event had a time GitHub gave in a readable form, so none can be listed in order." : "No activity was read."));
    else {
      card.append(el("ol", { class: "feed events", "aria-label": "Recent activity, newest first" }, feed.events.slice(0, FEED_SHOWN).map(ev => {
        const id = ev.href ? el("a", { href: ev.href, target: "_blank", rel: "noopener noreferrer", class: "mono" }, ev.id) : el("span", { class: "mono" }, ev.id);
        return el("li", { "data-kind": ev.kind, "data-repo": ev.repo }, el("span", { class: "ev ev-" + ev.kind }, ev.kind === "commit" && ev.merge ? "Merge commit" : EVENT[ev.kind]),
          rows.length > 1 ? el("span", { class: "muted mono" }, ev.repo.split("/")[1]) : null, id, el("span", { class: "ev-title" }, ev.title),
          el("span", { class: "qual muted" }, when(ev.at)));
      })));
      if (feed.events.length > FEED_SHOWN) card.append(el("p", { class: "qual muted plain" }, (feed.events.length - FEED_SHOWN) + " older events read and not shown."));
    }
    if (loading && feed.events.length) card.append(el("p", { class: "qual muted plain" }, "Still reading " + plural(loading, "repository", "repositories") + "."));
    if (problems.length) card.append(el("ul", { class: "coverage", "data-part": "feed-coverage", "aria-label": "What was not read" }, problems.map(p => el("li", {}, p))));
    if (feed.untimed) card.append(el("p", { class: "qual muted plain", "data-part": "feed-untimed" },
      plural(feed.untimed, "event was", "events were") + " read with no readable time and " + (feed.untimed === 1 ? "is" : "are") + " not listed."));
    if (feed.other) card.append(el("p", { class: "qual muted plain" }, plural(feed.other, "other comment") + " not in the handoff form, not shown."));
    card.append(tip(el("p", { class: "qual muted plain" }, "From each repository: the latest " + SB.COMMIT_LIMIT + " commits at the pinned commit, the latest 100 pull requests and the latest " +
      SB.REPO_COMMENT_LIMIT + " comments, read live. Older events are not read. Activity is not progress, and no event changes a figure. Refresh reads it again."), "Not progress"));
    return card;
  }

  Object.assign(V, { portfolio, activity, repoDetails, feedCard });
})(typeof window !== "undefined" ? window : globalThis);
