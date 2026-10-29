"use strict";
// The Atlas: a second main view beside the dashboard, with the repository pictures the dashboard does not
// have: the branch graph (git-flow lanes, zoom, drag, the files a commit changed, older commits, a replay
// of the history and that replay saved as a GIF) and the code tree (the files played back commit by
// commit, with speed, seeking, zoom, and the playback saved as a GIF or a picture), and, as its second part,
// the account's public profile, activity calendar and latest public events. Its look and controls are adapted from the owner's own earlier app (the same
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
    "Your account": "The account the token reads as: its public GitHub profile, its public activity of the last 90 days by your local day, and its latest public events. GitHub activity, not progress; private activity is not read.",
    "Atlas": "Pictures of a repository as GitHub has it now: its branch graph to start with. Read live, not at the commit a project pins. Nothing here changes anything, and none of it is progress.",
    "Code tree": "The repository's files as a tree, played back commit by commit: folders joined by lines, files as dots coloured by type, and each coder (shown by their initial) flying to the files they change. Read live from the default branch's newest commits, only after Play is pressed.",
    "Versions": "One graph per version branch you pick (say the default branch for one version and a staging branch for the next): the commits behind that branch, each pull request merged into it as its own lane, the open ones that target it, and the list of every pull request whose base is that branch. Read live; nothing here changes anything.",
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

  const PARTS = [["repo", "Repository"], ["account", "Your account"]];
  function atlas(S, A) {
    const sec = el("section", { class: "stack atlas", role: "tabpanel", id: "atlas-panel", "aria-labelledby": "major-atlas" },
      el("h1", { id: "atlas-h", class: "sr" }, "Atlas"));
    // Two parts: a repository's pictures, and the signed-in account's public profile and activity.
    const part = S.atlas.part === "account" ? "account" : "repo";
    sec.append(el("div", { class: "seg atlas-parts", role: "group", "aria-label": "Atlas part" }, PARTS.map(([k, l], i) =>
      el("button", { type: "button", id: "atlas-part-" + k, "aria-pressed": String(part === k), onclick: () => A.setAtlasPart(k),
        onkeydown: e => { if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return; e.preventDefault(); A.setAtlasPart(PARTS[(i + 1) % PARTS.length][0], true); } }, l))));
    if (part === "account") { sec.append(accountPanel(S, A)); return sec; }
    const rows = A.atlasRepos();
    if (!rows.length) { sec.append(notice("empty", "No repository here has been read yet. The Atlas shows the repositories your projects read.")); return sec; }
    const r = A.atlasRepo();
    sec.append(el("div", { class: "filters" },
      el("label", {}, "Repository ", el("select", { id: "atlas-repo", onchange: e => A.setAtlasRepo(e.target.value) },
        rows.map(x => el("option", { value: x.repo, selected: x.repo === r.repo }, x.repo)))),
      tip(el("span", { class: "qual muted" }, "Read live from GitHub now"), "Atlas")));
    sec.append(graphPanel(S, A, r), versionsPanel(S, A, r), treePanel(S, A, r));
    return sec;
  }

  // ---- Your account: the public profile, the public activity of the last 90 days as a calendar of days,
  // and the latest public events. Read only once asked for.

  function accountPanel(S, A) {
    const head = el("div", { class: "ph" }, tip(el("h2", { id: "ac-h" }, "Your account"), "Your account"));
    const panel = el("section", { class: "card atlas-panel", id: "ac-panel", "aria-labelledby": "ac-h" }, head);
    if (!S.atlas.account) {
      panel.append(el("div", { class: "ct-start" },
        el("button", { type: "button", class: "btn", id: "ac-start", onclick: () => A.atlasAccountRead() }, "Show your public profile and activity"),
        el("p", { class: "muted" }, "Reads, only after you press it, the public profile of the account the token reads as and its public events from the last " +
          "90 days (GitHub keeps at most 300): up to 5 GitHub reads. Private activity and the contribution calendar are not read.")));
      return panel;
    }
    const user = A.live("user"), login = user && user.data ? user.data.login : null;
    const prof = login ? A.live(SB.accountKey.profile(login)) : null, evs = login ? A.live(SB.accountKey.events(login)) : null;
    // A failure to read again: a read that gave nothing, or an event list a later page of which failed
    // (GitHub's own 300-event limit is not a failure).
    const stars = login && S.atlas.extras ? A.live(SB.accountKey.starred(login)) : null, gists = login && S.atlas.extras ? A.live(SB.accountKey.gists(login)) : null;
    const vs = login && S.atlas.vs, vsReads = vs ? [A.live(SB.accountKey.repos(login)), A.live(SB.accountKey.profile(vs)), A.live(SB.accountKey.events(vs)), A.live(SB.accountKey.repos(vs))] : [];
    const myRepos = login && (vs || S.atlas.badge) ? A.live(SB.accountKey.repos(login)) : null;
    const failed = [user, prof, evs, stars, gists, myRepos, ...vsReads].some(x => x && x.state !== "loading" && (!x.data || !!x.data.stopped));
    const retry = failed ? el("button", { type: "button", class: "linkbtn", id: "ac-retry", onclick: () => A.atlasAccountRetry() }, "Read again") : null;
    if (!login) {
      panel.append(!user || user.state === "loading" ? notice("loading", "Reading who the token reads as.")
        : el("div", {}, notice(user.state, "Who the token reads as could not be read" + (user.error ? " (" + user.error + ")" : "") + "."), retry));
      return panel;
    }
    panel.append(profileBlock(prof, login));
    if (!evs || evs.state === "loading") panel.append(notice("loading", "Reading your public events."));
    else if (!evs.data) panel.append(notice(evs.state, "Your public events could not be read" + (evs.error ? " (" + evs.error + ")" : "") + ". The activity calendar and the feed need them."));
    else panel.append(activityBlock(evs));
    panel.append(extrasBlock(S, A, stars, gists), compareBlock(S, A, prof, evs, vsReads), badgeBlock(S, A, prof, evs, myRepos));
    if (retry) panel.append(el("p", {}, retry));
    return panel;
  }

  // What a list about the account leaves out, in words: a later page that failed, GitHub's 300 read, and
  // entries not in the expected form.
  function gapsText(res, one, many, capped) {
    const said = [];
    if (res.state === "partial") said.push(res.data.stopped ? "A later page could not be read (" + res.data.stopped + "), so some are missing" : "Only " + (capped || "the first 300") + " are read");
    if (res.data.skipped) said.push(plural(res.data.skipped, one, many) + " not in the expected form " + (res.data.skipped === 1 ? "was" : "were") + " left out");
    return said.length ? said.join(". ") + "." : "";
  }
  function listGaps(res, one, many) {
    const said = gapsText(res, one, many);
    return said ? el("p", { class: "qual" }, said) : null;
  }

  // The starred repositories and public gists, read only once asked for.
  function extrasBlock(S, A, stars, gists) {
    const out = el("div", { class: "stack", id: "ac-extras" });
    if (!S.atlas.extras) {
      out.append(el("div", { class: "ct-start" },
        el("button", { type: "button", class: "btn ghost", id: "ac-extras-start", onclick: () => A.atlasAccountExtras() }, "Show your starred repositories and public gists"),
        el("p", { class: "muted" }, "Reads up to 3 pages of each (300 at most): up to 6 GitHub reads, only after you press it. Secret gists are not read.")));
      return out;
    }
    out.append(starBlock(A, stars), gistBlock(gists));
    return out;
  }

  // Your account beside another one, in eight rounds of public numbers, as the earlier app put it; read only
  // once a login is given. None of it is progress.
  function compareBlock(S, A, prof, evs, reads) {
    const box = el("section", { class: "stack", id: "ac-vs", "aria-labelledby": "ac-vs-h" }, el("h3", { id: "ac-vs-h" }, "Compare with another account"));
    const said = S.atlas.vsSaid;
    const input = el("input", { type: "text", id: "ac-vs-q", value: A.atlasCompareAsk(), autocomplete: "off", spellcheck: "false", maxlength: "40",
      "aria-invalid": said ? "true" : null, "aria-describedby": said ? "ac-vs-said" : null, oninput: e => A.atlasCompareAsk(e.target.value) });
    box.append(el("form", { class: "ac-vs-form", id: "ac-vs-form", onsubmit: e => { e.preventDefault(); A.atlasCompare(input.value); } },
      el("label", { class: "ac-search" }, "Their GitHub login ", input), el("button", { type: "submit", class: "btn ghost", id: "ac-vs-go" }, "Compare")));
    if (said) box.append(el("p", { class: "qual", id: "ac-vs-said" }, said));
    if (!S.atlas.vs) {
      box.append(el("p", { class: "muted" }, "Reads, only after you press Compare, that account's public profile, its own public repositories and its public " +
        "events, and your own public repositories: up to 10 GitHub reads. Public numbers only; private work is not counted."));
      return box;
    }
    const [mine, theirProf, theirEvs, theirs] = reads, vs = S.atlas.vs;
    const missing = [[prof, "your public profile"], [evs, "your public events"], [mine, "your public repositories"],
      [theirProf, "@" + vs + "'s public profile"], [theirEvs, "@" + vs + "'s public events"], [theirs, "@" + vs + "'s public repositories"]];
    if (missing.some(([x]) => !x || x.state === "loading")) { box.append(notice("loading", "Reading @" + vs + " and your public repositories to compare.")); return box; }
    const bad = missing.filter(([x]) => !x.data);
    if (bad.length) {
      box.append(notice(bad[0][0].state, "Cannot compare: " + bad.map(([x, what]) => what + (x.error ? " (" + x.error + ")" : "")).join(", ") + " could not be read."));
      return box;
    }
    const now = Date.now(), a = SB.accountStats(prof.data, mine, evs, now), b = SB.accountStats(theirProf.data, theirs, theirEvs, now);
    const rows = SB.duelRows(a, b, now), sa = rows.filter(r => r.win === "a").length, sb = rows.filter(r => r.win === "b").length;
    const who = s => s.web ? el("a", { href: s.web, target: "_blank", rel: "noopener noreferrer" }, s.name) : s.name;
    box.append(el("p", { class: "ac-vs-score", id: "ac-vs-score" }, who(a), " ", el("strong", {}, sa + " – " + sb), " ", who(b)),
      el("p", { class: "muted", id: "ac-vs-verdict" }, (sa === sb ? "A tie" : (sa > sb ? a : b).name + " leads " + Math.max(sa, sb) + " of " + rows.length + " rounds") +
        ", by public numbers only. A round is won only when it is sure: one with an unknown number, or an \"at least\" number that could reach the other, is won by neither."));
    const val = (n, cut) => n === null ? "unknown" : (cut ? "at least " : "") + n.toLocaleString("en");
    const bar = (n, max, win) => { const fil = el("span", { class: "fil" + (win ? " win" : "") }); fil.style.width = Math.round((n || 0) / max * 100) + "%"; return el("span", { class: "trk", "aria-hidden": "true" }, fil); };
    box.append(el("div", { class: "table-wrap" }, el("table", { class: "ac-vs-table", id: "ac-vs-table" },
      el("caption", { class: "muted" }, "Eight rounds; the higher number wins each. Not progress."),
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Round"), el("th", { scope: "col" }, a.name), el("th", { scope: "col" }, b.name))),
      el("tbody", {}, rows.map(r => {
        const max = Math.max(r.a || 0, r.b || 0) || 1;
        const cell = (n, side) => el("td", { class: r.win === side ? "win" : null }, el("span", { class: "val" }, val(n, side === "a" ? r.lowA : r.lowB)),
          bar(n, max, r.win === side), r.win === side ? el("span", { class: "ac-won" }, " won") : null);
        return el("tr", {}, el("th", { scope: "row" }, r.label), cell(r.a, "a"), cell(r.b, "b"));
      })))));
    const shared = a.langs.filter(l => b.langs.some(m => m.name === l.name)).map(l => l.name);
    const langs = s => el("div", { class: "ac-vs-langs" }, el("h4", {}, s.name + "'s languages"),
      s.langs.length ? el("ul", { class: "ac-list" }, s.langs.map(l => el("li", {}, shared.includes(l.name) ? el("strong", {}, l.name) : l.name, " " + Math.round(l.share * 100) + "%")))
        : el("p", { class: "muted" }, "None named."),
      s.top ? el("p", { class: "muted" }, "Most starred: " + s.top.repo + " (★ " + s.top.stars.toLocaleString("en") + ")") : null);
    box.append(el("div", { class: "ac-vs-pair" }, langs(a), langs(b)));
    if (shared.length) box.append(el("p", { class: "muted" }, "Both write " + shared.join(", ") + "."));
    // What each side's lists leave out, with the reason: a later page that failed (with its error, and Read
    // again), GitHub's 300 read on purpose, entries not in the expected form, and values GitHub did not give.
    const gapSaid = [[a, mine, evs], [b, theirs, theirEvs]].flatMap(([s, rr, ee]) => [
      gapsText(rr, "repository", "repositories", "the 300 most recently pushed"), gapsText(ee, "event", "events", "the 300 newest")]
      .map((t, i) => t ? s.name + "'s public " + (i ? "events" : "repositories") + ": " + t : null)
      .concat(s.low.stars && !s.low.repos ? [s.name + "'s stars: a repository's star count was not given"] : [],
              s.low.active && !s.low.repos ? [s.name + "'s active repositories: a repository's last push was not given"] : []))
      .filter(Boolean);
    if (gapSaid.length) box.append(el("div", { class: "qual", id: "ac-vs-gaps" }, el("p", {}, "These make some numbers lower bounds (\"at least\"):"),
      el("ul", {}, gapSaid.map(t => el("li", {}, t)))));
    box.append(el("p", {}, el("button", { type: "button", class: "linkbtn", id: "ac-vs-clear", onclick: () => A.atlasCompareClear() }, "Compare with someone else")));
    return box;
  }

  // A README badge of the account's public numbers, as the earlier app drew its card: a picture made here
  // from what was read, to download and add to a README by hand. It does not update by itself.
  const BADGE = {
    dark: { bg: "#0d1117", border: "#30363d", ink: "#e6edf3", muted: "#8d96a0", accent: "#4daafc", track: "#21262d", heat: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"] },
    light: { bg: "#ffffff", border: "#d0d7de", ink: "#1f2328", muted: "#656d76", accent: "#0969da", track: "#eaeef2", heat: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"] },
  };
  function badgeSvg(s, days, theme) {
    const t = BADGE[theme] || BADGE.dark, W = 495, H = 195;
    // The picture carries its own completeness: a + on a lower bound, and a note when one is shown or the
    // languages come from only the repositories read.
    const note = SB.badgeNote(s);
    const label = s.name + ": " + SB.badgeNumbers(s).map(([k, v]) => v + " " + k.toLowerCase()).join(", ") + (note ? ". " + note : "");
    const out = svg("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label, id: "ac-badge-svg", class: "ac-badge" },
      svg("title", {}, label));
    const g = svg("g", { "font-family": "'Segoe UI', -apple-system, Ubuntu, sans-serif" });
    out.append(g);
    g.append(svg("rect", { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 6, fill: t.bg, stroke: t.border }),
      svg("text", { x: 25, y: 35, fill: t.ink, "font-size": 17, "font-weight": 600 }, s.name.length > 26 ? s.name.slice(0, 25) + "…" : s.name),
      svg("text", { x: 25, y: 53, fill: t.muted, "font-size": 12 }, "@" + s.login + (s.since ? " · on GitHub since " + s.since : "")));
    // The last 13 weeks as a strip of squares at the top right, by the viewer's local day.
    const levels = SB.heatLevels(days), weeks = Math.ceil(days.length / 7);
    days.forEach((d, i) => g.append(svg("rect", { x: W - 25 - (weeks - Math.floor(i / 7)) * 5 + 1, y: 18 + (i % 7) * 5, width: 4, height: 4, rx: 1, fill: t.heat[levels[i]] })));
    SB.badgeNumbers(s).forEach(([k, v], i) => g.append(svg("g", { transform: "translate(" + (25 + i * 115) + ",78)" },
      svg("text", { y: 0, fill: t.ink, "font-size": 22, "font-weight": 600 }, v), svg("text", { y: 18, fill: t.muted, "font-size": 11 }, k))));
    const bw = W - 50;
    g.append(svg("rect", { x: 25, y: 122, width: bw, height: 8, rx: 4, fill: t.track }));
    let x = 25, lx = 25;
    for (const l of s.langs) { const w = Math.max(2, l.share * bw); g.append(svg("rect", { x: x.toFixed(1), y: 122, width: w.toFixed(1), height: 8, fill: SB.langColor(l.name) })); x += w; }
    for (const l of s.langs.slice(0, 4)) {
      const text = l.name + " " + Math.round(l.share * 100) + "%";
      if (lx + 22 + text.length * 6.2 >= W - 20) break;
      g.append(svg("g", { transform: "translate(" + lx + ",150)" }, svg("circle", { cx: 4, cy: -4, r: 4, fill: SB.langColor(l.name) }),
        svg("text", { x: 12, y: 0, fill: t.muted, "font-size": 11 }, text)));
      lx += 22 + text.length * 6.2;
    }
    // The note takes the whole bottom line, so it never runs into the footer.
    g.append(note ? svg("text", { x: 25, y: H - 14, fill: t.muted, "font-size": 10, id: "ac-badge-note", textLength: W - 50, lengthAdjust: "spacingAndGlyphs" }, note)
      : svg("text", { x: W - 25, y: H - 14, fill: t.muted, "font-size": 10, "text-anchor": "end" }, "Public GitHub numbers"));
    return out;
  }
  function badgeBlock(S, A, prof, evs, repos) {
    const box = el("section", { class: "stack", id: "ac-badge", "aria-labelledby": "ac-badge-h" }, el("h3", { id: "ac-badge-h" }, "README badge"));
    if (!S.atlas.badge) {
      box.append(el("div", { class: "ct-start" },
        el("button", { type: "button", class: "btn ghost", id: "ac-badge-start", onclick: () => A.atlasBadge() }, "Make a README badge"),
        el("p", { class: "muted" }, "Draws a card of your public numbers to download and put in a README by hand. Reads your own public repositories " +
          "(up to 3 GitHub reads), only after you press it. Nothing is posted or changed on GitHub.")));
      return box;
    }
    if (!repos || repos.state === "loading" || !prof || prof.state === "loading" || !evs || evs.state === "loading") { box.append(notice("loading", "Reading your public repositories for the badge.")); return box; }
    const bad = [[prof, "your public profile"], [evs, "your public events"], [repos, "your public repositories"]].filter(([x]) => !x.data);
    if (bad.length) { box.append(notice(bad[0][0].state, "Cannot draw the badge: " + bad.map(([x, what]) => what + (x.error ? " (" + x.error + ")" : "")).join(", ") + " could not be read.")); return box; }
    const now = Date.now(), s = SB.accountStats(prof.data, repos, evs, now), theme = S.atlas.badgeTheme;
    const pic = badgeSvg(s, SB.activityDays(evs.data.events, now), theme);
    const file = "github-stats-" + theme + ".svg";
    const dl = () => download(new root.Blob([new root.XMLSerializer().serializeToString(pic)], { type: "image/svg+xml" }), file);
    const line = el("code", { id: "ac-badge-md" }, "![GitHub stats](./" + file + ")");
    const status = el("span", { class: "muted", id: "ac-badge-status", "aria-live": "polite" });
    box.append(el("div", { class: "seg", role: "group", "aria-label": "Badge colours" },
      ["dark", "light"].map(k => el("button", { type: "button", id: "ac-badge-" + k, "aria-pressed": String(theme === k), onclick: () => A.atlasBadgeTheme(k) }, k === "dark" ? "Dark" : "Light"))),
      el("div", { class: "ac-badge-box" }, pic),
      el("div", { class: "acts" }, el("button", { type: "button", class: "btn", id: "ac-badge-dl", onclick: dl }, "Download " + file)),
      el("p", { class: "muted" }, "To show it: add the file to your profile repository and put this line in its README. ",
        line, " ", el("button", { type: "button", class: "linkbtn", id: "ac-badge-copy", onclick: () => A.copy(line, status) }, "Copy the line"), " ", status),
      el("p", { class: "muted" }, "A picture of today's public numbers: it does not update by itself. It shows your name, login and public numbers to anyone who sees it. " +
        "The file is saved by your browser; nothing is posted or sent from here."));
    // Why, in words beside the picture: how many were read, a later page that failed with its error (and Read
    // again), the deliberate 300 cap, entries left out, a star count not given.
    const gaps = [gapsText(repos, "repository", "repositories", "the 300 most recently pushed"), gapsText(evs, "event", "events", "the 300 newest")];
    if (gaps[0] || gaps[1] || s.low.stars) {
      box.append(el("div", { class: "qual", id: "ac-badge-gaps" }, el("p", {}, "A number with + is a lower bound (\"at least\"):"),
        el("ul", {}, [gaps[0] ? "Your public repositories (" + repos.data.repos.length.toLocaleString("en") + " read): " + gaps[0] : null,
          gaps[1] ? "Your public events (" + evs.data.events.length.toLocaleString("en") + " read): " + gaps[1] : null,
          s.low.stars && !s.low.repos ? "A repository's star count was not given." : null].filter(Boolean).map(t => el("li", {}, t)))));
    }
    return box;
  }

  function starBlock(A, res) {
    const box = el("section", { class: "stack", id: "ac-starred", "aria-labelledby": "ac-star-h" });
    const head = el("div", { class: "ph" }, el("h3", { id: "ac-star-h" }, "Starred repositories"));
    box.append(head);
    if (!res || res.state === "loading") { box.append(notice("loading", "Reading the repositories you starred.")); return box; }
    if (!res.data) { box.append(notice(res.state, "The repositories you starred could not be read" + (res.error ? " (" + res.error + ")" : "") + ".")); return box; }
    const R = res.data.repos;
    const count = el("span", { class: "legend", id: "ac-star-count", "aria-live": "polite" });
    head.append(count);
    const gaps = listGaps(res, "repository", "repositories");
    if (gaps) box.append(gaps);
    if (!R.length) { box.append(notice("empty", "You have not starred any repository.")); return box; }
    const rows = R.map(r => el("li", {},
      el("div", { class: "ac-star-name" }, r.web ? el("a", { href: r.web, target: "_blank", rel: "noopener noreferrer" }, r.repo) : r.repo,
        r.archived ? el("span", { class: "ref" }, "archived") : null, r.fork ? el("span", { class: "ref" }, "fork") : null),
      r.description ? el("div", { class: "muted" }, r.description) : null,
      el("div", { class: "ac-meta" }, r.language ? el("span", {}, r.language) : null, r.stars !== null ? el("span", {}, "★ " + r.stars.toLocaleString("en")) : null,
        r.pushed !== null ? el("span", {}, "Last push " + (SB.localDay(r.pushed) || "")) : null)));
    const list = el("ul", { class: "ac-list", id: "ac-star-list" }, rows);
    // The list narrows itself as words are typed, so the box keeps its focus and nothing is read.
    const narrow = q => {
      let shown = 0;
      R.forEach((r, i) => { const hit = SB.starMatch(r, q); rows[i].hidden = !hit; if (hit) shown++; });
      count.textContent = (q.trim() ? shown.toLocaleString("en") + " of " : "") + plural(R.length, "repository", "repositories") + " read";
    };
    const input = el("input", { type: "search", id: "ac-star-q", value: A.atlasStarQuery(), "aria-controls": "ac-star-list",
      oninput: e => { A.atlasStarQuery(e.target.value); narrow(e.target.value); } });
    box.append(el("label", { class: "ac-search" }, "Search starred ", input), list);
    narrow(A.atlasStarQuery());
    return box;
  }

  function gistBlock(res) {
    const box = el("section", { class: "stack", id: "ac-gists", "aria-labelledby": "ac-gist-h" });
    const head = el("div", { class: "ph" }, el("h3", { id: "ac-gist-h" }, "Public gists"));
    box.append(head);
    if (!res || res.state === "loading") { box.append(notice("loading", "Reading your public gists.")); return box; }
    if (!res.data) { box.append(notice(res.state, "Your public gists could not be read" + (res.error ? " (" + res.error + ")" : "") + ".")); return box; }
    const G = res.data.gists;
    head.append(el("span", { class: "legend" }, plural(G.length, "gist") + " read"));
    const gaps = listGaps(res, "gist", "gists");
    if (gaps) box.append(gaps);
    if (!G.length) { box.append(notice("empty", "You have no public gists.")); return box; }
    box.append(el("ul", { class: "ac-list", id: "ac-gist-list" }, G.map(g => {
      const title = g.description || (g.files[0] ? g.files[0].name : g.id);
      const names = g.files.map(f => f.name + (f.language ? " (" + f.language + ")" : "")).join(", ") + (g.more ? ", and " + g.more + " more" : "") +
        (g.cut ? ", and more GitHub did not list" : "");
      // GitHub cuts the file list of a very large gist, so its total is then only a lower bound.
      const files = (g.cut ? "At least " : "") + plural(g.files.length + g.more, "file");
      return el("li", {},
        el("div", { class: "ac-star-name" }, g.web ? el("a", { href: g.web, target: "_blank", rel: "noopener noreferrer" }, title) : title),
        el("div", { class: "muted" }, files + (names ? ": " + names : "")),
        el("div", { class: "ac-meta" }, g.updated !== null ? el("span", { title: SB.localWhen(g.updated) }, "Updated " + (SB.localStamp(g.updated) || "")) : null,
          g.comments ? el("span", {}, plural(g.comments, "comment")) : null));
    })));
    return box;
  }

  function profileBlock(prof, login) {
    if (!prof || prof.state === "loading") return notice("loading", "Reading your public profile.");
    if (!prof.data) return notice(prof.state, "Your public profile could not be read" + (prof.error ? " (" + prof.error + ")" : "") + ".");
    const u = prof.data, title = u.name || u.login;
    const bits = [
      u.type === "Organization" ? el("span", {}, "Organization") : null,
      u.followers !== null ? el("span", { id: "ac-followers" }, el("b", {}, u.followers.toLocaleString("en")), u.followers === 1 ? " follower" : " followers") : null,
      u.following !== null && u.type !== "Organization" ? el("span", {}, el("b", {}, u.following.toLocaleString("en")), " following") : null,
      u.location ? el("span", {}, u.location) : null,
      u.company ? el("span", {}, u.company) : null,
      u.since !== null ? el("span", {}, "On GitHub since ", el("b", {}, (SB.localDay(u.since) || "").slice(0, 4))) : null,
      u.blog ? el("span", { title: "Your website, as text: it is not opened from here" }, u.blog) : null,
    ].filter(Boolean);
    return el("div", { class: "ac-profile", id: "ac-profile" },
      el("div", { class: "ac-avatar", "aria-hidden": "true" }, title.charAt(0).toUpperCase()),
      el("div", { class: "ac-who" },
        el("h3", { id: "ac-name" }, title),
        el("div", { class: "muted" }, u.web ? el("a", { href: u.web, target: "_blank", rel: "noopener noreferrer" }, "@" + u.login) : "@" + u.login),
        u.bio ? el("p", { id: "ac-bio" }, u.bio) : null,
        el("div", { class: "ac-meta" }, bits)));
  }

  function activityBlock(evs) {
    const E = evs.data.events, days = SB.activityDays(E), lv = SB.heatLevels(days), top = SB.busiest(days);
    const total = days.reduce((a, d) => a + d.count, 0);
    const out = el("div", { class: "stack", id: "ac-activity" });
    const said = [];
    if (evs.state === "partial") said.push(evs.data.stopped ? "A later page of events could not be read (" + evs.data.stopped + "), so older events are missing" : "GitHub gives at most 300 events, so older ones in the 90 days may be missing");
    if (evs.data.skipped) said.push(plural(evs.data.skipped, "event", "events") + " not in the expected form " + (evs.data.skipped === 1 ? "was" : "were") + " left out");
    out.append(el("div", { class: "ph" }, el("h3", {}, "Public activity, last 90 days"),
      el("span", { class: "legend", id: "ac-total" }, plural(total, "action") + " in public events (pushes count their commits when GitHub says how many), by your local day")));
    if (said.length) out.append(el("p", { class: "qual", id: "ac-gaps" }, said.join(". ") + "."));
    out.append(heatSvg(days, lv));
    out.append(el("div", { class: "ac-legend" }, el("span", {}, "Less"), [0, 1, 2, 3, 4].map(l => el("i", { class: "ac-cell ac-l" + l, "aria-hidden": "true" })), el("span", {}, "More"),
      el("span", { class: "ac-busy", id: "ac-busiest" }, "Busiest day: ", el("b", {}, top ? top.count + " on " + top.day : "none"))));
    const active = days.filter(d => d.count);
    out.append(el("details", { class: "ct-files", id: "ac-days" }, el("summary", {}, "Days with activity, as a list (" + active.length + ")"),
      active.length ? el("ul", { class: "ct-paths" }, active.slice().reverse().map(d => el("li", {}, d.day + ": " + plural(d.count, "action")))) : el("p", { class: "muted" }, "None.")));
    // The kinds of event most seen, and the latest events.
    const mix = SB.eventMix(E), max = mix.length ? mix[0].n : 1;
    out.append(el("div", { class: "ph" }, el("h3", {}, "Latest public events"),
      el("span", { class: "legend" }, E.length ? plural(E.length, "event") + " read · since " + (SB.localWhen(E[E.length - 1].at) || "") : "")));
    if (!E.length) { out.append(notice("empty", "No public events in the last 90 days.")); return out; }
    // Bar widths are set through the style object, which the page's rules allow, never a style attribute.
    out.append(el("div", { class: "ac-mix", id: "ac-mix" }, mix.map(m => {
      const fil = el("span", { class: "fil" });
      fil.style.width = Math.round(m.n / max * 100) + "%";
      return el("div", { class: "ac-bar" }, el("span", { class: "lbl" }, m.name), el("span", { class: "trk", "aria-hidden": "true" }, fil), el("span", { class: "val" }, String(m.n)));
    })));
    out.append(el("ol", { class: "ac-feed", id: "ac-feed" }, E.slice(0, SB.ACCOUNT.FEED).map(e => el("li", {},
      el("span", { class: "ac-mark", "aria-hidden": "true" }, SB.eventMark(e.type)), el("span", {}, SB.eventLine(e)),
      el("span", { class: "muted", title: SB.localWhen(e.at) }, SB.localStamp(e.at) || "")))));
    return out;
  }

  // The calendar: a column per week from Sunday, a square per day, Mon, Wed and Fri named, and each
  // month named over the week it starts in.
  function heatSvg(days, lv) {
    const cs = 11, g = 3, left = 28, top = 18, pad = days.length ? days[0].dow : 0;
    const weeks = Math.ceil((days.length + pad) / 7), W = left + weeks * (cs + g), H = top + 7 * (cs + g);
    const pic = svg("svg", { viewBox: "0 0 " + W + " " + H, class: "ac-heat", id: "ac-heat", role: "img",
      "aria-label": "Public activity by day over the last " + days.length + " days; the list below names each day with activity." });
    let lastM = null;
    days.forEach((d, i) => {
      const idx = i + pad, w = Math.floor(idx / 7), x = left + w * (cs + g), y = top + d.dow * (cs + g);
      const rect = svg("rect", { x, y, width: cs, height: cs, rx: 2, class: "ac-cell ac-l" + lv[i], "data-day": d.day,
        "data-tip": plural(d.count, "action") + " · " + d.day });
      pic.append(rect);
      const m = d.day.slice(0, 7);
      if (m !== lastM && d.dow <= 3) {
        pic.append(svg("text", { x, y: 11, class: "ac-lbl" }, MONTHS[Number(d.day.slice(5, 7)) - 1]));
        lastM = m;
      }
    });
    [[1, "Mon"], [3, "Wed"], [5, "Fri"]].forEach(([r, t]) => pic.append(svg("text", { x: 0, y: top + r * (cs + g) + 9, class: "ac-lbl" }, t)));
    return el("div", { class: "ac-heat-box" }, pic);
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---- Versions: one graph per version branch, each with the pull requests that target it.

  function versionsPanel(S, A, r) {
    const repo = r.repo, def = r.meta.branch;
    const v = SB.atlasVersions(A.live, repo, def, A.atlasVersionPick(repo), name => A.atlasVersionShow(repo, name), A.atlasVersionPrPages(repo), name => A.atlasVersionShared(repo, name));
    const head = el("div", { class: "ph" }, tip(el("h2", { id: "av-h" }, "Versions"), "Versions"));
    const panel = el("section", { class: "card atlas-panel", id: "av-panel", "aria-labelledby": "av-h" }, head);
    if (v.state !== "current") {
      panel.append(v.state === "loading" ? notice("loading", "Reading the branches.")
        : v.state === "empty" ? notice("empty", "This repository has no branches yet.")
        : notice(v.state, "The branches could not be read" + (v.error ? ": " + v.error : "") + "."));
      if (v.retry) panel.append(el("p", {}, el("button", { type: "button", class: "linkbtn", id: "av-retry", onclick: () => A.atlasRetry(repo) }, "Read again")));
      return panel;
    }
    panel.append(versionPicker(A, repo, def, v));
    if (!v.picked.length) { panel.append(notice("empty", "Pick at least one branch to draw it as a version.")); return panel; }
    const prs = v.prs;
    if (prs.state === "loading") panel.append(el("div", { class: "qual plain" }, "Reading the pull requests."));
    else if (prs.failed) panel.append(el("div", { class: "qual plain", role: "alert" }, "The pull requests could not be read" + (prs.error ? " (" + prs.error + ")" : "") + ", so none are listed. ",
      el("button", { type: "button", class: "linkbtn", id: "av-retry", onclick: () => A.atlasRetry(repo) }, "Read again")));
    else if (!prs.end) panel.append(el("div", { class: "qual plain", id: "av-prs-cut" }, "Pull requests are taken from the newest " + (prs.pages * 100).toLocaleString("en") + " of this repository's; older ones are not listed. ",
      prs.more ? el("button", { type: "button", class: "linkbtn", id: "av-prs-more", onclick: () => A.atlasVersionPrMore(repo) }, "Read 100 more") : null));
    if (v.tagState.failed) panel.append(el("div", { class: "qual plain", role: "alert" }, "The tags could not be read (" + (v.tagState.error || v.tagState.state) + "), so none are drawn. ",
      el("button", { type: "button", class: "linkbtn", onclick: () => A.atlasRetry(repo) }, "Read again")));
    v.versions.forEach((ver, i) => panel.append(versionCard(A, r, v, ver, i)));
    return panel;
  }

  // The branches to draw as versions: the ones picked, the ones whose names say version, then the rest.
  function versionPicker(A, repo, def, v) {
    const picked = new Set(v.picked), full = v.picked.length >= v.max;
    const box = name => el("label", { class: "vpick" }, el("input", { type: "checkbox", value: name, "data-key": "vpick|" + name, checked: picked.has(name),
      disabled: !picked.has(name) && full, onchange: e => A.atlasVersionToggle(repo, name, e.target.checked, v.picked) }), " ", el("span", { class: "mono" }, name),
      name === def ? el("span", { class: "muted" }, " (default)") : null);
    const first = [...new Set([...v.picked, ...v.start])], rest = v.branches.filter(n => !first.includes(n));
    return el("fieldset", { class: "vpicker", id: "av-pick" }, el("legend", {}, "Version branches (up to " + v.max + ")"),
      el("div", { class: "vpicks" }, first.map(box)),
      rest.length ? el("details", { id: "av-more" }, el("summary", {}, "Other branches (" + rest.length.toLocaleString("en") + (v.partialBranches ? "+" : "") + ")"),
        el("div", { class: "vpicks" }, rest.map(box))) : null);
  }

  const PULL_LOOK = { draft: ["Draft", "st-not hollow"], open: ["Open", "st-progress"], merged: ["Merged", "st-done"], closed: ["Closed without merging", "st-removed"] };
  const dayOf = t => typeof t === "string" ? SB.localWhen(t) || t : "";

  function versionCard(A, r, v, ver, i) {
    const repo = r.repo, slot = "v|" + repo + "|" + ver.name, id = "av-" + i;
    const card = el("section", { class: "vcard", id: id, "aria-labelledby": id + "-h", "data-version": ver.name });
    const c = ver.count, total = ver.pulls.length;
    card.append(el("div", { class: "ph" }, el("h3", { id: id + "-h" }, "Version " + (i + 1) + ": ", el("span", { class: "mono" }, ver.name), ver.isDefault ? el("span", { class: "muted" }, " (default branch)") : null),
      el("div", { class: "legend" },
        el("span", {}, el("b", {}, ver.shown.toLocaleString("en")), " " + (ver.apart ? (ver.more ? "newest commits" : ver.shown === 1 ? "commit" : "commits") + " not on " + v.def
          : ver.more ? "newest commits" : ver.shown === 1 ? "commit (whole history)" : "commits (whole history)")),
        el("span", {}, el("b", {}, total.toLocaleString("en")), total === 1 ? " pull request" : " pull requests"),
        c.merged ? el("span", {}, c.merged + " merged") : null, c.open ? el("span", {}, c.open + " open") : null,
        c.draft ? el("span", {}, c.draft + " draft") : null, c.closed ? el("span", {}, c.closed + " closed") : null,
        ver.more ? el("button", { type: "button", class: "btn ghost small", id: id + "-older", "aria-disabled": ver.reading ? "true" : null,
          onclick: () => { if (!ver.reading) A.atlasVersionOlder(repo, ver.name); } }, ver.reading ? "Loading older commits…" : "Load older commits") : null)));
    if (ver.canApart) card.append(el("label", { class: "vshare" }, el("input", { type: "checkbox", "data-shared": ver.name, "data-key": "vshare|" + ver.name, checked: !ver.apart,
      onchange: e => A.atlasVersionShare(repo, ver.name, e.target.checked) }), " Also show the history it shares with ", el("span", { class: "mono" }, v.def)));
    if (ver.failed) card.append(el("div", { class: "qual plain", role: "alert" }, "The commits of " + ver.failed.branch + " could not be read" + (ver.failed.error ? " (" + ver.failed.error + ")" : "") + ". ",
      el("button", { type: "button", class: "linkbtn", onclick: () => A.atlasRetry(repo) }, "Read again")));
    if (!ver.win.length) {
      if (!ver.failed) card.append(notice(ver.reading ? "loading" : "empty", ver.reading ? "Reading the newest commits of " + ver.name + "."
        : ver.apart ? ver.name + " has no commits that " + v.def + " does not have." : "No commits to draw."));
    } else {
      const lay = SB.atlasLayout(ver.name, ver.win, ver.heads, [...v.tags, ...ver.marks]);
      const sig = JSON.stringify([ver.name, r.web, lay.W, lay.H, ver.win.map(x => x.sha).join(","), ver.heads, v.tags, ver.marks]);
      const holder = A.atlasBox(slot, sig, () => drawGraph(A, repo, r.web, lay, id + "-box", "Graph of " + ver.name));
      const box = holder.box;
      // A graph kept from an earlier drawing takes this card's place in the list, so it takes its name too.
      box.id = id + "-box";
      box.atlasMore = ver.more && !ver.reading;
      box.atlasOlder = () => A.atlasVersionOlder(repo, ver.name);
      filesTips(A, repo, box);
      card.append(box, keyTable(lay));
      Promise.resolve().then(() => place(box));
    }
    // What the graph leaves out, said in words.
    const L = ver.lanes, gaps = [
      ver.unknown ? plural(ver.unknown, "commit read is", "commits read are") + " not drawn: from what was read it is not yet proved whether " + (ver.unknown === 1 ? "it is" : "they are") + " on " + v.def + (ver.more ? " (Load older commits reads further)" : "") : null,
      ver.apart && ver.ahead !== null && ver.ahead > ver.shown && !ver.more ? "GitHub counts " + ver.ahead.toLocaleString("en") + " commits on " + ver.name + " that " + v.def + " does not have; " + ver.shown.toLocaleString("en") + " are drawn" : null,
      L.cut.length ? "The line" + (L.cut.length === 1 ? " of " : "s of ") + L.cut.map(n => "#" + n).join(", ") + " did not reach " + ver.name + " within its newest " + (SB.ATLAS.OPEN_PAGES * 100) + " commits, so " + (L.cut.length === 1 ? "it is" : "they are") + " drawn cut off" : null,
      L.capped ? plural(L.capped, "more open pull request is", "more open pull requests are") + " listed but not drawn (at most " + SB.ATLAS.OPEN_LANES + " are)" : null,
      L.forks ? plural(L.forks, "open pull request comes", "open pull requests come") + " from another repository, so " + (L.forks === 1 ? "it is" : "they are") + " listed but not drawn" : null,
      L.failed.length ? "The commits of " + L.failed.map(f => "#" + f.number + " (" + (f.error || f.state) + ")").join(", ") + " could not be read, so " + (L.failed.length === 1 ? "it is" : "they are") + " not drawn" : null,
    ].filter(Boolean);
    if (gaps.length) card.append(el("p", { class: "qual plain", id: id + "-gaps", role: L.failed.length ? "alert" : null }, gaps.join(". ") + ". ",
      L.failed.length ? el("button", { type: "button", class: "linkbtn", onclick: () => A.atlasRetry(repo) }, "Read again") : null));
    card.append(versionPulls(r.web, ver, v.prs));
    return card;
  }

  // Every pull request whose base is this version's branch, newest first.
  const PR_SHOW = 25;
  function versionPulls(web, ver, prs) {
    if (prs.state === "loading" || prs.failed) return null;
    if (!ver.pulls.length) return el("p", { class: "muted vnone" }, "No pull request" + (prs.end ? "" : " among those read") + " targets " + ver.name + ".");
    const row = pr => {
      const [text, cls] = PULL_LOOK[SB.pullState(pr)];
      const href = SB.repoHref(web, "pull", pr.number);
      const lane = ver.heads.some(h => h.pr === pr.number) ? " · drawn as a lane" : ver.marks.some(m => m.name === "PR #" + pr.number) ? " · marked on its commit" : "";
      return el("tr", { "data-pull": String(pr.number) },
        el("th", { scope: "row" }, href ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, "#" + pr.number) : "#" + pr.number),
        el("td", { class: "wide" }, pr.title, lane ? el("span", { class: "qual muted" }, lane) : null),
        el("td", {}, el("span", { class: "pill " + cls }, text), pr.merged ? el("div", { class: "qual muted" }, dayOf(pr.merged)) : null),
        el("td", { class: "mono" }, pr.headRef || "?", " → ", pr.baseRef || "?"),
        el("td", {}, pr.author || el("span", { class: "muted" }, "Not given")),
        el("td", { class: "num" }, pr.created ? dayOf(pr.created) : el("span", { class: "muted" }, "Not given")));
    };
    const shown = ver.pulls.slice(0, PR_SHOW), rest = ver.pulls.slice(PR_SHOW);
    const table = list => el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
      el("caption", { class: "sr" }, "Pull requests into " + ver.name),
      el("thead", {}, el("tr", {}, ["Number", "Title", "State", "From → into", "Author", "Opened"].map(h => el("th", { scope: "col" }, h)))),
      el("tbody", {}, list.map(row))));
    return el("div", { class: "vpulls" }, el("h4", {}, "Pull requests into ", el("span", { class: "mono" }, ver.name)), table(shown),
      rest.length ? el("details", {}, el("summary", {}, "Show " + rest.length.toLocaleString("en") + " older"), table(rest)) : null);
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
        onclick: () => toggleReplay(A, repo) }, replaying ? "Stop" : "Replay history"),
      el("button", { type: "button", class: "btn ghost small", id: "ag-gif", onclick: e => graphGif(A, r, lay, e.currentTarget) }, "Save as GIF")));
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
    if (box.replay && box.replay.step) panel.append(stepBar(A, repo, box));
    if (g.retry) panel.append(retryRow(A, repo, g));
    else if (g.meta.pulls.state === "loading") panel.append(el("div", { class: "qual plain" }, "Reading the pull requests, to label branches with their pull request numbers."));
    else if (g.meta.pulls.state === "partial") panel.append(el("div", { class: "qual plain" }, "Branch labels name pull requests from the newest 100 and the open ones only; any other branch shows its name."));
    if (box.saved) panel.append(box.saved);
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

  function drawGraph(A, repo, web, lay, id, title) {
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
    const name = title || "Branch graph";
    const pic = svg("svg", { viewBox: "0 0 " + lay.W + " " + lay.H, width: lay.W, height: lay.H, role: "img", "aria-label": name + " of the " + plural(lay.commits, "commit") + " drawn" },
      guides, edges, nodes, flags);
    const box = el("div", { class: "atlas-graph", id: id || "ag-box", tabindex: "0", role: "group",
      "aria-label": name + ". Plus and minus zoom, arrow keys move, 0 resets the zoom. Tab moves to the newest commit; Left and Right move between commits, and each commit's details and changed files are read out." }, pic);
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
  function stepTo(box, k) {
    const rp = box.replay, steps = box.steps;
    rp.k = Math.max(0, Math.min(steps.length - 1, k));
    showUpTo(rp.pic, rp.k);
    box.scrollLeft = Math.max(0, steps[rp.k].x * (box.zoom || 1) - box.clientWidth * 0.7);
    remember(box);
  }
  // The step-by-step replay's controls: the commit shown so far, and the one before or after it.
  function stepBar(A, repo, box) {
    const rp = box.replay, steps = box.steps, s = steps[rp.k], last = steps.length - 1;
    const go = (d, id) => { if (rp.k + d < 0 || rp.k + d > last) return; stepTo(box, rp.k + d); A.render(); const b = doc.getElementById(id); if (b) b.focus(); };
    return el("div", { class: "acts", id: "ag-steps", role: "group", "aria-label": "Replay one commit at a time" },
      el("button", { type: "button", class: "btn ghost small", id: "ag-prev", "aria-disabled": rp.k === 0 ? "true" : null, onclick: () => go(-1, "ag-prev") }, "Previous commit"),
      el("button", { type: "button", class: "btn ghost small", id: "ag-next", "aria-disabled": rp.k >= last ? "true" : null, onclick: () => go(1, "ag-next") }, "Next commit"),
      el("span", { class: "mono", id: "ag-step", "aria-live": "polite" }, (rp.k + 1) + "/" + steps.length + " · " + (SB.localDay(s.date) || "no time given") + " · " + s.msg));
  }
  function toggleReplay(A, repo) {
    const holder = A.atlasBox(repo);
    if (!holder) return;
    const box = holder.box, pic = box.querySelector("svg"), steps = box.steps;
    if (box.replay) { stopReplay(box, true); A.render(); return; }
    if (!pic || !steps || !steps.length) return;
    // With reduced motion asked for, nothing moves by itself: the replay goes one commit at a time on request.
    if (reduced()) { box.replay = { pic, timer: null, k: 0, step: true }; stepTo(box, 0); A.render(); return; }
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


  // ---- Saving a picture: a preview, a download button and what the file shows. Nothing is sent anywhere;
  // the file goes to the browser's downloads and stays there after signing out.

  const readUrl = blob => new Promise(ok => { const fr = new root.FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(null); fr.readAsDataURL(blob); });
  function download(blob, name) {
    const url = root.URL.createObjectURL(blob), a = doc.createElement("a");
    // Not added to the page: it only hands the file to the browser.
    a.href = url; a.download = name; a.click();
    setTimeout(() => root.URL.revokeObjectURL(url), 30000);
  }
  async function savedOutput(id, blob, name, alt, about, close) {
    const src = await readUrl(blob);
    const box = el("div", { class: "saved", id, role: "group", "aria-label": "Saved picture" },
      src ? el("img", { class: "preview", src, alt }) : null,
      el("div", { class: "acts" },
        el("button", { type: "button", class: "btn", id: id + "-dl", onclick: () => download(blob, name) }, "Download " + name.split(".").pop().toUpperCase()),
        el("button", { type: "button", class: "btn ghost", id: id + "-close", onclick: close }, "Close")),
      el("p", { class: "muted" }, about + " (" + (blob.size / 1048576).toFixed(1) + " MB). It shows this repository's name, its file paths or commit titles and who made them: anyone you send it to sees them. The file is saved by your browser and stays there after you sign out; nothing is posted or sent from here."));
    return box;
  }
  const css = name => root.getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
  const MONO = "ui-monospace, Menlo, Consolas, monospace", FONT = "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif";
  function clip(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    while (text.length > 1 && ctx.measureText(text + "…").width > max) text = text.slice(0, -1);
    return text + "…";
  }

  // ---- The branch graph's history as an animated GIF: the newest commits (at most GIF_STEPS) appear one by
  // one, with the repository, each commit's day and title, and the colour key. Drawn from a copy of the
  // graph with its colours written in, since a picture cannot see the page's styles.

  const GIF_STEPS = 60;
  function standalone(copy, x0, k) {
    for (const n of copy.querySelectorAll("[data-s]")) n.setAttribute("opacity", Number(n.getAttribute("data-s")) <= k ? "1" : "0");
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new root.XMLSerializer().serializeToString(copy));
  }
  function loadImage(src) {
    return new Promise(ok => { const img = new root.Image(); img.onload = () => ok(img); img.onerror = () => ok(null); img.src = src; });
  }
  async function graphGif(A, r, lay, button) {
    const holder = A.atlasBox(r.repo), box = holder && holder.box, pic = box && box.querySelector("svg");
    if (!pic || button.getAttribute("aria-disabled") === "true") return;
    stopReplay(box, true);
    button.setAttribute("aria-disabled", "true"); button.textContent = "Making the GIF…";
    const steps = lay.steps, first = Math.max(0, steps.length - GIF_STEPS), shown = steps.slice(first), x0 = first ? Math.max(0, shown[0].x - 46) : 0;
    const W0 = lay.W - x0, H0 = lay.H;
    // The copy: no links, no page styles, the theme's colours written in, cropped to the commits played.
    const copy = pic.cloneNode(true);
    copy.removeAttribute("style");
    if (x0 > 0) { copy.setAttribute("viewBox", x0 + " 0 " + W0 + " " + H0); copy.setAttribute("width", W0); }
    // Links go, but each commit's reveal step stays on a plain group in the link's place.
    for (const a of copy.querySelectorAll("a")) {
      const g = doc.createElementNS(a.namespaceURI, "g");
      for (const name of ["class", "data-s"]) if (a.hasAttribute(name)) g.setAttribute(name, a.getAttribute(name));
      g.append(...a.childNodes);
      a.replaceWith(g);
    }
    for (const n of copy.querySelectorAll("[style]")) n.removeAttribute("style");
    for (const c of copy.querySelectorAll(".gn circle")) { c.setAttribute("stroke", css("--surface") || "#ffffff"); c.setAttribute("stroke-width", "3"); }
    for (const g of copy.querySelectorAll(".guide")) g.setAttribute("stroke", css("--line") || "#cccccc");
    for (const t of copy.querySelectorAll("text")) { t.setAttribute("font-family", MONO); t.setAttribute("font-size", "10"); t.setAttribute("font-weight", "600"); }
    const scale = Math.min(1.5, 1100 / W0), PAD = 24, HEAD = 64, FOOT = 34;
    const W = Math.round(Math.max(560, W0 * scale + PAD * 2));
    const canvas = doc.createElement("canvas");
    canvas.width = W;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.font = "12px " + MONO;
    let kx = PAD, ky = 0;
    const keyAt = lay.key.map(e => {
      const text = clip(ctx, (e.label ? e.label + "  " : "") + e.name, W - PAD * 2 - 20), w = ctx.measureText(text).width + 34;
      if (kx > PAD && kx + w > W - PAD) { kx = PAD; ky += 20; }
      const at = { color: e.color, text, x: kx, y: ky };
      kx += w;
      return at;
    });
    const KEY = keyAt.length ? ky + 30 : 0, H = Math.round(H0 * scale + HEAD + KEY + FOOT);
    canvas.height = H;
    const bg = css("--surface") || "#ffffff", ink = css("--fg") || "#000000", muted = css("--muted") || "#666666", n = shown.length;
    const frame = async k => {
      const img = await loadImage(standalone(copy, x0, first + k));
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
      ctx.fillStyle = ink; ctx.font = "600 18px " + FONT; ctx.fillText(clip(ctx, r.repo, W - 200), PAD, 30);
      ctx.fillStyle = muted; ctx.font = "13px " + MONO;
      ctx.fillText(clip(ctx, (SB.localDay(shown[k].date) || "") + " · " + shown[k].msg, W - PAD * 2), PAD, 52);
      ctx.textAlign = "right"; ctx.fillText((k + 1) + "/" + n, W - PAD, 30);
      if (img) ctx.drawImage(img, PAD, HEAD, W0 * scale, H0 * scale);
      ctx.textAlign = "left"; ctx.font = "12px " + MONO;
      for (const e of keyAt) {
        const y = HEAD + H0 * scale + 10 + e.y;
        ctx.fillStyle = e.color; ctx.beginPath(); ctx.arc(e.x + 6, y + 6, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = muted; ctx.fillText(e.text, e.x + 18, y + 10);
      }
      ctx.textAlign = "right"; ctx.fillStyle = muted; ctx.font = "600 12px " + FONT; ctx.fillText("Made with Sandboard", W - PAD, H - 12);
      return ctx.getImageData(0, 0, W, H).data;
    };
    // Work stops, and nothing is shown, once the session ends or the graph is drawn anew.
    const same = () => A.atlasBox(r.repo) === holder;
    let blob = null;
    try {
      const gif = SB.gifWriter(W, H, SB.gifPalette(await frame(n - 1)));
      for (let k = 0; k < n && same(); k++) {
        gif.add(await frame(k), k === n - 1 ? 2600 : Math.max(80, Math.min(200, 7000 / n)));
        if (k % 8 === 0) await new Promise(ok => setTimeout(ok));
      }
      blob = new root.Blob([gif.finish()], { type: "image/gif" });
    } catch (err) { blob = null; }
    if (!same()) return;
    const name = r.repo.split("/")[1] + "-history.gif";
    const saved = blob ? await savedOutput("ag-saved", blob, name, "The branch history replayed commit by commit",
      (first ? "The newest " + n : n) + " commits, " + n + " frames", () => { box.saved = null; A.render(); })
      : el("div", { class: "qual plain", role: "alert", id: "ag-saved" }, "The GIF could not be made in this browser.");
    if (!same()) return;
    box.saved = saved;
    A.render();
    const dl = doc.getElementById("ag-saved-dl");
    if (dl) dl.focus();
  }

  // ---- Code tree. Nothing is read until Play is pressed; then the commits, the files before them and each
  // commit's files are read, and the playback runs on a canvas kept across the page being drawn again.

  const TREE_HINT = "Scroll to zoom · Drag to look around · Hover a dot to see the file · With the tree focused: Space plays or pauses, plus and minus zoom, arrow keys move, F fits, Home and End go to the start and end";
  function treePanel(S, A, r) {
    const repo = r.repo, def = r.meta.branch;
    const head = el("div", { class: "ph" }, tip(el("h2", { id: "ct-h" }, "Code tree"), "Code tree"));
    const panel = el("section", { class: "card atlas-panel", "aria-labelledby": "ct-h" }, head);
    const holder = A.atlasTree(repo);
    if (!holder) {
      const n = SB.TREE.WANT;
      head.append(el("span", { class: "legend" }, "Every file as a dot, every coder flying to the files they change"));
      panel.append(el("div", { class: "ct-start" },
        el("button", { type: "button", class: "btn", id: "ct-start", onclick: () => A.atlasTreePlay(repo) }, "Play the code tree"),
        el("p", { class: "muted" }, "Reads the newest " + n + " commits of " + def + " and the files each one changed: up to about " + SB.TREE.cost(n) +
          " GitHub reads, only after you press Play. Coders are named by their GitHub login; work merged from an agent's branch (claude/, gpt/, copilot/ …) is credited to that agent and marked.")));
      return panel;
    }
    const t = SB.atlasTree(A.live, repo, def);
    if (!t.data) {
      const p = t.progress;
      if (t.state === "loading") panel.append(notice("loading", p && t.step === "files" ? "Reading the files each commit changed: " + p.done + " of " + p.of + "." : "Reading the newest commits."));
      else if (t.state === "empty") panel.append(notice("empty", t.why === "branch" ? "The default branch " + def + " was not found among the branches." : "No commits to play."));
      else panel.append(notice(t.state, "The code tree could not be read" + (t.error ? ": " + t.error : "") + "."),
        el("button", { type: "button", class: "linkbtn", id: "ct-retry", onclick: () => A.atlasTreeRetry(repo) }, "Read again"));
      return panel;
    }
    // A view is kept while its data is the same; once Read again brings more, it is made anew.
    const d = t.data, sig = [d.commits.length, d.failed, d.cut, d.names.state, d.names.failedPulls, d.names.partialPulls, d.initial.length, d.treeMissing, d.treePartial].join("|");
    if (holder.view && holder.sig !== sig) { holder.view.dispose(); holder.view = null; }
    if (!holder.view) { holder.view = treeView(A, r, d); holder.sig = sig; }
    head.append(holder.view.sub);
    panel.append(holder.view.node);
    holder.view.shown();
    return panel;
  }

  // Every code tree view on the page, to pause when the tab is hidden; a view leaves when it is disposed.
  const views = new Set();
  doc.addEventListener("visibilitychange", () => { if (doc.hidden) for (const v of views) v.pause(); });
  // When the session ends: every code tree view and graph replay of it stops and lets go of what it holds.
  function atlasDispose(at) {
    for (const t of at.trees.values()) if (t.view) t.view.dispose();
    for (const h of at.boxes.values()) if (h.box.replay) { clearInterval(h.box.replay.timer); h.box.replay = null; }
    for (const v of [...views]) v.dispose();
  }
  const atlasViews = () => views.size;
  const reduced = () => !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function treeView(A, r, data) {
    const T = SB.TREE, n = data.commits.length;
    const V = { sim: null, keep: new Map(), cam: { x: 0, y: 0, s: 1 }, free: false, playing: false, speed: 1, raf: 0, last: 0, hits: [], acc: 0, settle: 0, gone: false };
    const inferred = data.commits.some(c => c.inferred);
    const sub = el("span", { class: "legend", id: "ct-sub" },
      el("span", {}, el("b", {}, n.toLocaleString("en")), (n === 1 ? " commit" : " commits") + (data.whole ? " (whole history)" : " (the newest)")),
      el("span", {}, data.initial.length ? el("b", {}, data.initial.length.toLocaleString("en")) : null, data.initial.length ? " files to start with" : data.treeMissing ? "The files before them could not be read; growing from the first commit" : "Growing from the first commit"),
      data.treePartial ? el("span", {}, "GitHub listed only part of the files") : null,
      data.failed ? el("span", {}, plural(data.failed, "commit's files", "commits' files") + " could not be read") : null,
      inferred ? el("span", {}, "* named from the pull request's branch") : null);
    // What the playback is missing, said in words, with Read again for reads that failed.
    const nm = data.names, gaps = [
      data.cut ? plural(data.cut, "commit lists", "commits list") + " only the first 300 files GitHub gives" : null,
      nm.state === "failed" ? "The pull requests could not be read" + (nm.error ? " (" + nm.error + ")" : "") + ", so agents are not named" : null,
      nm.state === "partial" ? "Agents are named from the newest " + nm.listed + " pull requests only" : null,
      nm.failedPulls ? plural(nm.failedPulls, "agent pull request's", "agent pull requests'") + " commits could not be read, so some of their work is under the account that committed it" : null,
      nm.partialPulls ? plural(nm.partialPulls, "agent pull request has", "agent pull requests have") + " more than 100 commits; only the first 100 are named" : null,
    ].filter(Boolean);
    const gapNote = gaps.length || data.retry ? el("p", { class: "qual", id: "ct-gaps" }, gaps.join(". ") + (gaps.length ? ". " : ""),
      data.retry ? el("button", { type: "button", class: "linkbtn", id: "ct-retry", onclick: () => A.atlasTreeRetry(r.repo) }, "Read again what failed") : null) : null;
    const play = el("button", { type: "button", class: "btn", id: "ct-play", "aria-pressed": "false", onclick: () => toggle() }, "Play");
    const speeds = el("div", { class: "seg", role: "group", "aria-label": "Speed" }, [1, 2, 4].map(x =>
      el("button", { type: "button", class: "btn ghost small", id: "ct-speed-" + x, "aria-pressed": String(x === 1), onclick: e => {
        V.speed = x;
        for (const b of speeds.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      } }, x + "×")));
    const gifBtn = el("button", { type: "button", class: "btn ghost small", id: "ct-gif", onclick: () => saveGif() }, "Save as GIF");
    const pngBtn = el("button", { type: "button", class: "btn ghost small", id: "ct-png", onclick: () => savePicture() }, "Save picture");
    const cv = el("canvas", { id: "ct-canvas", tabindex: "0", role: "img", "aria-label": "The repository's files as a tree, played back commit by commit. " + TREE_HINT });
    const tipBox = el("div", { class: "ct-tip", hidden: true, "aria-hidden": "true" });
    const range = el("input", { type: "range", id: "ct-time", min: "0", max: String(n), value: "0", step: "1", "aria-label": "Commit", oninput: e => seek(Number(e.target.value)) });
    const at = el("span", { class: "mono", id: "ct-where" });
    const cap = el("span", { class: "qual", id: "ct-cap", hidden: true });
    const out = el("div", { class: "ct-out" });
    // The files, in words: the commit at the playback point and what it changed, and every file in the tree.
    const filesBody = el("div", { id: "ct-files-body" });
    const filesBox = el("details", { class: "ct-files", id: "ct-files", ontoggle: () => list() }, el("summary", {}, "Files at this point, as a list"), filesBody);
    const node = el("div", { class: "ct" }, gapNote,
      el("div", { class: "ct-tools" }, play, speeds, gifBtn, pngBtn),
      el("div", { class: "ct-wrap" }, cv, tipBox),
      el("div", { class: "ct-bar" }, range, at, cap, el("button", { type: "button", class: "btn ghost small", id: "ct-fit", onclick: () => fitNow() }, "Fit")),
      el("div", { class: "cthint" }, TREE_HINT), filesBox, out);

    function size() { return [cv.clientWidth || 600, cv.clientHeight || 400]; }
    let listed = -1, listing = 0;
    function list() {
      clearTimeout(listing); listing = 0;
      if (V.gone || !filesBox.open) return;
      const s = V.sim, c = s.k ? data.commits[s.k - 1] : null;
      listed = s.k;
      const STATUS = { added: "added", removed: "removed", modified: "changed", renamed: "renamed", copied: "copied", changed: "changed" };
      const all = el("details", { id: "ct-all", ontoggle: e => { if (e.currentTarget.open) e.currentTarget.append(el("ol", { class: "ct-paths mono" }, [...s.files.keys()].sort().map(p => el("li", {}, p)))); else { const ol = e.currentTarget.querySelector("ol"); if (ol) ol.remove(); } } },
        el("summary", {}, "Every file in the tree now (" + s.files.size.toLocaleString("en") + (s.over.size ? ", and " + s.over.size.toLocaleString("en") + " not drawn" : "") + ")"));
      filesBody.replaceChildren(
        el("p", {}, c ? "Commit " + s.k + " of " + n + ": " + (SB.localDay(c.date) || "no time given") + ", " + c.msg + " by " + c.author + (c.inferred ? " (named from the pull request's branch)" : "") : "Before the first commit played: the files the playback starts with."),
        c ? (c.files.length ? el("ul", { class: "ct-paths mono", id: "ct-changed", "aria-label": "Files this commit changed" }, c.files.map(f => el("li", {}, (STATUS[f.s] || f.s) + ": " + f.p + (f.prev ? " (was " + f.prev + ")" : ""))))
          : el("p", { class: "muted" }, "No files listed for this commit.")) : null,
        all);
    }
    function where() {
      if (V.gone) return;
      const s = V.sim, c = data.commits[Math.max(0, s.k - 1)];
      range.value = String(s.k);
      at.textContent = s.k + "/" + n;
      cap.hidden = !s.over.size;
      cap.textContent = s.over.size ? s.over.size.toLocaleString("en") + " files not drawn (the tree shows at most " + T.MAX_FILES.toLocaleString("en") + ")" : "";
      if (filesBox.open && listed !== s.k && !listing) listing = setTimeout(list, 250);
      cv.setAttribute("aria-label", "Code tree at commit " + s.k + " of " + n + (s.k && c ? ": " + (SB.localDay(c.date) || "no time given") + ", " + c.msg + " by " + c.author : "") +
        ". " + s.files.size.toLocaleString("en") + " files. " + TREE_HINT);
    }
    function seek(k) {
      if (V.gone) return;
      V.sim = SB.treeSeek(data, V.keep, Math.max(0, Math.min(n, k)));
      V.acc = 0; V.settle = 90;
      if (!V.free) { const [W, H] = size(); SB.treeFit(V.sim, W, H, V.cam); }
      where(); paint();
    }
    function toggle(on) {
      if (V.gone) return;
      V.playing = (on === undefined ? !V.playing : on) && cv.isConnected;
      if (V.playing && V.sim.k >= n) seek(0);
      play.textContent = V.playing ? "Pause" : "Play";
      play.setAttribute("aria-pressed", String(V.playing));
      V.last = root.performance.now();
      paint();
    }
    function fitNow() { V.free = false; V.settle = 60; paint(); }
    function paint() {
      if (V.raf) return;
      if (V.gone) return;
      V.raf = root.requestAnimationFrame(now => {
        V.raf = 0;
        if (V.gone) return;
        if (!cv.isConnected) { if (V.playing) toggle(false); return; }
        const dpr = root.devicePixelRatio || 1, [W, H] = size();
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const ctx = cv.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const dt = Math.min(0.1, (now - V.last) / 1000), s = V.sim;
        V.last = now;
        if (V.playing) {
          V.acc += dt * T.RATE * V.speed;
          while (V.acc >= 1 && s.k < n) { s.next(); V.acc -= 1; }
          if (s.k >= n && V.acc > 4) toggle(false);
          where();
        }
        s.step(dt);
        if (!V.free) SB.treeFit(s, W, H, V.cam, reduced() ? 1 : 0.06);
        V.hits = SB.treeDraw(ctx, W, H, s, V.cam);
        // Keep drawing while something still moves or glows.
        if (V.playing || s.t - s.busy < 7 || V.settle-- > 0) paint();
      });
    }
    // Pointer: drag to look around, wheel to zoom, rest on a dot for its name.
    let drag = null;
    cv.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY }; try { cv.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is already gone */ } });
    cv.addEventListener("pointermove", e => {
      if (drag) { V.cam.x -= (e.clientX - drag.x) / V.cam.s; V.cam.y -= (e.clientY - drag.y) / V.cam.s; drag.x = e.clientX; drag.y = e.clientY; V.free = true; paint(); return; }
      const b = cv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      const h = [...V.hits].reverse().find(q => (q.x - x) ** 2 + (q.y - y) ** 2 <= q.r * q.r);
      if (!h) { tipBox.hidden = true; return; }
      tipBox.textContent = h.tip;
      tipBox.hidden = false;
      tipBox.style.left = Math.min(x + 12, Math.max(0, b.width - 260)) + "px";
      tipBox.style.top = (y + 14) + "px";
    });
    const up = () => { drag = null; };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", () => { tipBox.hidden = true; });
    const zoom = k => { V.cam.s = Math.max(0.05, Math.min(8, V.cam.s * k)); V.free = true; paint(); };
    cv.addEventListener("wheel", e => { e.preventDefault(); zoom(Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    cv.addEventListener("keydown", e => {
      const move = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60] }[e.key];
      if (move) { V.cam.x += move[0] / V.cam.s; V.cam.y += move[1] / V.cam.s; V.free = true; paint(); }
      else if (e.key === " " || e.key === "k") toggle();
      else if (e.key === "+" || e.key === "=") zoom(1.25);
      else if (e.key === "-") zoom(0.8);
      else if (e.key === "f" || e.key === "0") fitNow();
      else if (e.key === "Home") seek(0);
      else if (e.key === "End") seek(n);
      else if (e.key === "PageUp") seek(V.sim.k - 10);
      else if (e.key === "PageDown") seek(V.sim.k + 10);
      else return;
      e.preventDefault();
    });
    const ro = root.ResizeObserver ? new root.ResizeObserver(() => paint()) : null;
    if (ro) ro.observe(cv);

    // Saving: the whole playback as a GIF, or the tree as it is now as a picture.
    const title = r.repo, footer = "Made with Sandboard";
    async function show(blob, name, alt, about) {
      const saved = await savedOutput("ct-saved", blob, name, alt, about, () => out.replaceChildren());
      if (V.gone) return;
      out.replaceChildren(saved);
      const dl = doc.getElementById("ct-saved-dl");
      if (dl) dl.focus();
    }
    async function saveGif() {
      if (gifBtn.getAttribute("aria-disabled") === "true") return;
      toggle(false);
      gifBtn.setAttribute("aria-disabled", "true");
      const canvas = doc.createElement("canvas");
      canvas.width = 640; canvas.height = 420;
      try {
        // A view disposed while recording stops the recording at its next step.
        const made = await SB.treeGif(data, canvas, title, footer, (f, of) => { if (V.gone) throw new Error("gone"); gifBtn.textContent = "Making the GIF… " + Math.round(f / of * 100) + "%"; });
        if (V.gone) return;
        await show(new root.Blob([made.bytes], { type: "image/gif" }), r.repo.split("/")[1] + "-tree.gif", "The code tree playing back", made.commits + " commits, " + made.frames + " frames");
      } catch (err) {
        if (V.gone) return;
        out.replaceChildren(el("div", { class: "qual plain", role: "alert", id: "ct-saved" }, "The GIF could not be made in this browser."));
      }
      gifBtn.removeAttribute("aria-disabled");
      gifBtn.textContent = "Save as GIF";
    }
    async function savePicture() {
      const W = 1600, H = 900, canvas = doc.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const cam = SB.treeFit(V.sim, W, H, { x: 0, y: 0, s: 1 });
      SB.treeDraw(canvas.getContext("2d"), W, H, V.sim, cam, { title, footer, note: SB.treeNote(data, V.sim) });
      const blob = await new Promise(ok => canvas.toBlob(ok, "image/png"));
      if (blob && !V.gone) await show(blob, r.repo.split("/")[1] + "-tree.png", "The code tree at commit " + V.sim.k + " of " + n, "The tree at commit " + V.sim.k + " of " + n);
    }

    // Disposed when the session ends, the project is read again or Read again brings new data: drawing,
    // timers, the size watch and any recording stop, and the view lets go of the data and pictures.
    function dispose() {
      if (V.gone) return;
      V.gone = true; V.playing = false;
      if (V.raf) root.cancelAnimationFrame(V.raf);
      clearTimeout(listing);
      if (ro) ro.disconnect();
      views.delete(v);
      for (const box of [node, sub, out, filesBody]) box.replaceChildren();
      V.sim = null; V.keep.clear(); V.hits = [];
      data = null;
    }
    const v = {
      sub, node, dispose, stop: dispose,
      pause: () => { if (V.playing) toggle(false); },
      // Each time the panel is shown: draw again (playing stops while the tree is not on the page).
      shown: () => { if (!V.gone) { views.add(v); Promise.resolve().then(() => paint()); } },
    };
    // Play starts at once, as asked; with reduced motion, the finished tree is shown still instead.
    Promise.resolve().then(() => { if (V.gone) return; if (reduced()) seek(n); else { seek(0); toggle(true); } });
    V.sim = SB.treeSeek(data, V.keep, 0);
    where();
    return v;
  }

  Object.assign(V, { majorTabs, atlas, atlasDispose, atlasViews });
})(typeof window !== "undefined" ? window : globalThis);
