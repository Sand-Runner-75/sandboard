"use strict";
// A repository's work evidence: its pull requests with their reviews and checks, its issues, its
// Actions runs and its releases, and the account's inbox over the mapped repositories. All of it is
// read live from GitHub as it is now, a page of 100 at a time, and shown as GitHub's evidence:
// nothing here creates, comments, reviews, merges, reruns, cancels or publishes anything, and none
// of it is progress or the owner's approval. Text from GitHub only goes into text nodes.

(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, notice, STATE } = V;

  Object.assign(V.TIPS, {
    "Pull requests": "This repository's pull requests as GitHub lists them now, newest first. A review or passing checks are GitHub evidence, never the owner's approval.",
    "Issues": "This repository's issues as GitHub lists them now, newest first. GitHub's issue list also holds pull requests; they are left to Pull requests.",
    "Actions": "This repository's workflow runs as GitHub lists them now, newest first. A run not finished has no result yet.",
    "Releases": "This repository's releases as GitHub lists them now. An asset links to GitHub's own download address only; nothing is fetched or opened here.",
    "Inbox": "Your open pull requests, reviews asked of you and issues assigned to you, in the repositories mapped to your projects only.",
    "Reviews": "Each review stays on the commit it was given at. A review at an older commit is not a review of the current head.",
  });

  const tip = (node, key) => { node.setAttribute("data-tip", V.TIPS[key] || key); return node; };
  const short = sha => typeof sha === "string" ? sha.slice(0, 7) : "";
  const when = t => typeof t === "string" ? t.slice(0, 16).replace("T", " ") + " UTC" : "";
  const at = t => el("span", { title: t }, t.slice(0, 16).replace("T", " "));
  const plural = (n, one, many) => n.toLocaleString("en") + " " + (n === 1 ? one : many || one + "s");
  const stateName = res => (STATE[res.state] || STATE.failed)[2];
  const muted = text => el("span", { class: "muted" }, text);
  const link = (href, text, cls = "mono") => href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", class: cls }, text) : el("span", { class: cls }, text);
  const person = login => login ? el("span", { class: "mono" }, login) : muted("Not linked to an account");

  const KINDS = { pulls: ["Pull requests", "pull request"], issues: ["Issues", "issue"], runs: ["Actions", "run"], releases: ["Releases", "release"] };
  const STATES = [["open", "Open"], ["closed", "Closed"], ["all", "All"]];
  const PULL = { draft: ["Draft", "st-not hollow"], open: ["Open", "st-progress"], merged: ["Merged", "st-done"], closed: ["Closed without merging", "st-removed"] };
  const REVIEW = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented", DISMISSED: "Dismissed", PENDING: "Pending (not submitted)" };
  const RUN_STATUS = { queued: "Queued", in_progress: "In progress", waiting: "Waiting", requested: "Requested", pending: "Pending", unknown: "Status not given" };
  const RESULT = { success: ["Success", "st-done"], failure: ["Failure", "st-blocked"], cancelled: ["Cancelled", "st-removed"], skipped: ["Skipped", "st-not"],
                   neutral: ["Neutral", "st-not"], timed_out: ["Timed out", "st-blocked"], action_required: ["Action required", "st-review"],
                   stale: ["Stale", "st-not"], startup_failure: ["Startup failure", "st-blocked"], none: ["Finished with no result", "st-not hollow"],
                   other: ["Result not known here", "st-not hollow"] };

  const bytes = n => n < 1024 ? plural(n, "byte") : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";

  function duration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + " s";
    const m = Math.floor(s / 60);
    return m < 60 ? m + " min " + (s % 60) + " s" : Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  function intro(kind) {
    return tip(el("div", { class: "notice info", role: "status", "data-state": "work" }, el("span", { class: "glyph", "aria-hidden": "true" }, "i"),
      el("div", {}, el("b", {}, KINDS[kind][0] + " as GitHub lists them now"),
        el("div", {}, "Read live, not at the pinned commit. Nothing here creates, comments, reviews, merges, reruns, cancels or publishes anything, and none of it is progress."))), KINDS[kind][0]);
  }

  // What was read of the list, and what was not: never a full list unless GitHub's last page was read.
  function coverage(kind, w, label) {
    const what = plural(w.items.length, KINDS[kind][1]) + (label ? " (" + label + ")" : "");
    const read = plural(w.pages, "page") + " of 100 read";
    const text = w.end ? (w.items.length === 1 ? "Showing the only " : "Showing all ") + what + ": " + read + ", to the end of GitHub's list."
      : w.short ? "Showing " + what + ": " + read + ". GitHub counts " + plural(w.total, KINDS[kind][1]) + " but its last page read was short of that, so the list is not complete and nothing more can be read now."
      : w.error ? "Showing " + what + ". The next page could not be read (" + stateName(w.error) + "); older ones are not shown."
      : w.wanted.length ? "Showing " + what + ". Reading older ones."
      : w.more ? "Showing the latest " + what + ", " + read + ". Older ones are read only when you ask; nothing is guessed for them."
      : "Showing the latest " + what + ", " + read + ", as many as this view reads. Older ones are not read.";
    return el("p", { class: "qual muted plain", id: "w-end", tabindex: "-1", "data-part": "work-coverage" }, text);
  }

  // ---- One repository's list, with its state filter where GitHub has one.

  function work(S, A, entry, name, pinned, kind) {
    const web = pinned.data.web;
    const state = kind === "pulls" || kind === "issues" ? A.workState(name, kind) : null;
    const w = SB.workList(A.live, kind, name, state, A.workDepth(name, kind, state));
    const parts = [intro(kind)];
    const card = el("section", { class: "card stack tight", "aria-labelledby": "work-h", "data-part": "work-" + kind },
      tip(el("h2", { id: "work-h", class: "label" }, KINDS[kind][0]), KINDS[kind][0]));
    if (state) card.append(el("div", { class: "chips", role: "group", "aria-label": "Show " + KINDS[kind][0].toLowerCase() }, STATES.map(([k, l]) =>
      el("button", { type: "button", id: "wf-" + k, "aria-pressed": String(state === k), onclick: () => A.setWorkState(name, kind, k) }, l))));
    const label = state ? STATES.find(x => x[0] === state)[1].toLowerCase() : "";
    const none = (label && state !== "all" ? label + " " : "") + KINDS[kind][1] + "s";
    if (w.state === "loading") card.append(notice("loading"));
    else if (!w.pages) card.append(notice(w.error.state, w.error.error));
    else {
      // Pages were read: what they held, and always what was and was not read, even when they held
      // nothing to show here (an issue page of pull requests only, or runs GitHub counts but did not list).
      if (w.items.length) card.append(kind === "pulls" ? pullTable(S, A, entry, name, web, w.items) : kind === "issues" ? issueTable(web, w.items)
        : kind === "runs" ? runTable(web, w.items) : releaseList(web, w.items));
      else if (w.end) card.append(el("p", { class: "muted plain", "data-part": "work-empty" }, "GitHub lists no " + none + " here."));
      else card.append(el("p", { class: "muted plain", "data-part": "work-none-read" }, "No " + none + " in the " + plural(w.pages, "page") +
        " read. That is not the whole list: " + (w.more ? "older ones may be on the next page." : "the rest is not shown.")));
      if (w.items.length || !w.end) card.append(coverage(kind, w, label));
      if (w.more) card.append(el("div", { class: "actions" }, el("button", { type: "button", class: "btn ghost", id: "w-older",
        onclick: () => A.olderWork(name, kind, state) }, "Load older " + KINDS[kind][0].toLowerCase())));
    }
    if (kind === "issues" && w.pulls) card.append(el("p", { class: "qual muted plain", "data-part": "issue-pulls" },
      plural(w.pulls, "pull request") + " in GitHub's issue list " + (w.pulls === 1 ? "is" : "are") + " left to Pull requests."));
    if (kind === "runs" && w.total !== null && w.pages) card.append(el("p", { class: "qual muted plain", "data-part": "run-total" },
      plural(w.items.length, "run") + " read of the " + w.total.toLocaleString("en") + " GitHub counts" +
      (w.changed !== null ? "; its count changed to " + w.changed.toLocaleString("en") + " while the pages were read, so the list may have shifted between them." : ".")));
    if (!web) card.append(el("p", { class: "qual muted plain" }, "GitHub gave no web address for this repository, so nothing here links to it."));
    card.append(el("p", { class: "qual muted plain" }, kind === "pulls" ? "A review, passing checks or a merge are GitHub evidence, not the owner's approval."
      : kind === "runs" ? "A run that has not finished has no result yet; it is never shown as a success. No run is started, rerun or cancelled from here."
      : kind === "releases" ? "An asset links only to GitHub's own download address for this repository; any other address is shown as text. No asset is fetched or opened here, and nothing is published."
      : "No issue is edited, assigned, commented on or closed from here."));
    parts.push(card);
    return parts;
  }

  function pullTable(S, A, entry, name, web, pulls) {
    const ids = entry.tasks.filter(t => !t.invalid).map(t => t.id);
    const body = el("tbody", {});
    for (const pr of pulls) {
      const [text, cls] = PULL[SB.pullState(pr)];
      const open = A.evidenceOpen(name, pr.number);
      const task = ids.find(id => SB.namesTask(pr.title, id));
      body.append(el("tr", { "data-pull": String(pr.number) },
        el("th", { scope: "row" }, link(web && web + "/pull/" + pr.number, "#" + pr.number)),
        el("td", { class: "wide" }, el("span", { class: "ev-title" }, pr.title), task ? el("span", { class: "qual muted", "data-task": task }, " · names " + task) : null),
        el("td", {}, el("span", { class: "pill " + cls }, text), pr.merged ? el("div", { class: "qual muted" }, when(pr.merged)) : null),
        el("td", {}, person(pr.author)),
        el("td", { class: "mono" }, pr.headRef || "?", " → ", pr.baseRef || "?"),
        el("td", { class: "mono", title: pr.head }, short(pr.head)),
        el("td", { class: "num" }, pr.updated ? at(pr.updated) : muted("Not given")),
        el("td", {}, el("button", { type: "button", class: "linkbtn", "aria-expanded": String(open), "data-evidence": String(pr.number),
          "aria-label": (open ? "Hide" : "Show") + " the reviews and checks of #" + pr.number, onclick: () => A.toggleEvidence(name, pr.number) }, open ? "Hide" : "Show"))));
      if (open) body.append(el("tr", { class: "detail", "data-detail": String(pr.number) }, el("td", { colspan: 8 }, evidence(A, name, pr))));
    }
    return el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
      el("thead", {}, el("tr", {}, ["Pull request", "Title", "State", "Author", "Branch", "Head", "Updated (UTC)", "Evidence"].map(t => el("th", { scope: "col" }, t)))), body));
  }

  // A pull request's reviews, each at its own commit, and the check runs at its current head.
  function evidence(A, name, pr) {
    const box = el("div", { class: "stack tight", "data-part": "pull-evidence" });
    const rv = A.live(SB.workKey.reviews(name, pr.number));
    const rvBox = el("div", { "data-part": "reviews" }, tip(el("p", { class: "label" }, "Reviews"), "Reviews"));
    if (!rv || rv.state === "loading") rvBox.append(notice("loading"));
    else if (!rv.data) rvBox.append(notice(rv.state, rv.error, "Reviews not read"));
    else if (!rv.data.reviews.length) rvBox.append(el("p", { class: "muted plain" }, "No review on this pull request."));
    else {
      const e = SB.reviewEvidence(pr, rv.data.reviews);
      rvBox.append(el("p", { class: "plain" }, "At the head " + short(pr.head) + ": " + plural(e.approvedAtHead, "approval") + ", " +
        plural(e.changesAtHead, "request", "requests") + " for changes." + (e.older ? " " + (e.older === 1 ? "1 review at an older commit does" : e.older + " reviews at older commits do") + " not count for the head." : "")));
      rvBox.append(el("ol", { class: "feed" }, e.list.map(r => el("li", { "data-review": r.state, "data-at": r.atHead ? "head" : r.commit ? "older" : "unknown" },
        el("b", {}, REVIEW[r.state]), person(r.by), r.commit ? el("span", { class: "mono", title: r.commit }, "at " + short(r.commit)) : muted("commit not given"),
        el("span", { class: "qual" }, r.atHead ? "the current head" : r.commit ? "an older commit, not the current head" : "not known to be the head"),
        r.at ? el("span", { class: "qual muted" }, when(r.at)) : null))));
      if (rv.state === "partial") rvBox.append(notice("partial", "Only the first " + rv.data.reviews.length + " reviews were read."));
    }
    const ck = A.live(SB.workKey.checks(name, pr.head));
    const ckBox = el("div", { "data-part": "pull-checks" }, tip(el("p", { class: "label" }, "Check runs at the head " + short(pr.head)), "Check runs"),
      !ck || ck.state === "loading" ? notice("loading") : el("p", { class: "plain" }, V.checksSummary(ck)));
    box.append(rvBox, ckBox, el("p", { class: "qual muted plain" }, "Commit statuses from the older status API are not read here."));
    return box;
  }

  function issueTable(web, issues) {
    const stateText = i => i.state === "open" ? "Open" : i.reason === "not_planned" ? "Closed: not planned" : i.reason === "completed" ? "Closed: completed"
      : i.reason === "duplicate" ? "Closed: duplicate" : "Closed";
    return el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
      el("thead", {}, el("tr", {}, ["Issue", "Title and labels", "State", "Author", "Assignees", "Comments", "Opened (UTC)"].map(t => el("th", { scope: "col" }, t)))),
      el("tbody", {}, issues.map(i => el("tr", { "data-issue": String(i.number) },
        el("th", { scope: "row" }, link(web && web + "/issues/" + i.number, "#" + i.number)),
        el("td", { class: "wide" }, el("span", { class: "ev-title" }, i.title),
          el("div", { class: "qual muted", "data-part": "labels" }, i.labels.length ? "Labels: " + i.labels.join(", ") : "No labels")),
        el("td", {}, el("span", { class: "pill " + (i.state === "open" ? "st-progress" : "st-done hollow") }, stateText(i)),
          i.state === "open" ? null : el("div", { class: "qual muted" }, i.closed ? "Closed " + when(i.closed) : "Close time not given")),
        el("td", {}, person(i.author)),
        el("td", {}, i.assignees.length ? el("span", { class: "mono" }, i.assignees.join(", ")) : muted("None")),
        el("td", { class: "num" }, i.comments === null ? muted("Not given") : String(i.comments)),
        el("td", { class: "num" }, i.created ? at(i.created) : muted("Not given")))))));
  }

  function runTable(web, runs) {
    return el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
      el("thead", {}, el("tr", {}, ["Run", "Title and event", "Branch and head", "Result", "Duration", "Started (UTC)"].map(t => el("th", { scope: "col" }, t)))),
      el("tbody", {}, runs.map(r => {
        const o = SB.runOutcome(r);
        const [text, cls] = o.done ? RESULT[o.outcome] || RESULT.other : ["Not finished: no result yet", "st-review hollow"];
        return el("tr", { "data-run": String(r.id), "data-status": r.status || "unknown", "data-result": o.done ? o.outcome : "pending" },
          el("th", { scope: "row" }, link(web && web + "/actions/runs/" + r.id, (r.name || "Workflow run") + (r.number !== null ? " #" + r.number : ""), "")),
          el("td", { class: "wide" }, r.title ? el("span", { class: "ev-title" }, r.title) : muted("No title"),
            el("div", { class: "qual muted" }, r.event ? "On " + r.event : "Event not given")),
          el("td", { class: "mono" }, (r.branch || "?") + " → ", el("span", { title: r.head }, short(r.head))),
          el("td", {}, el("span", { class: "pill " + cls }, text),
            o.done ? (o.outcome === "other" ? el("div", { class: "qual muted" }, "GitHub says: " + r.rawConclusion) : null)
              : el("div", { class: "qual muted", "data-part": "run-status" }, RUN_STATUS[o.outcome] || RUN_STATUS.unknown)),
          el("td", { class: "num" }, o.ms !== null ? el("span", { "data-tip": "From GitHub's start time to its last update of the run." }, duration(o.ms)) : muted(o.done ? "Not given" : "—")),
          el("td", { class: "num" }, r.started ? at(r.started) : r.created ? at(r.created) : muted("Not given")));
      }))));
  }

  function releaseList(web, releases) {
    const kind = r => r.draft ? ["Draft", "st-not hollow"] : r.prerelease ? ["Pre-release", "st-review"] : ["Release", "st-done"];
    return el("ul", { class: "feed", "data-part": "releases" }, releases.map(r => {
      const [text, cls] = kind(r);
      const href = web && !r.draft ? web + "/releases/tag/" + encodeURIComponent(r.tag) : null;
      return el("li", { "data-release": r.tag },
        link(href, r.tag), r.name && r.name !== r.tag ? el("span", { class: "ev-title" }, r.name) : null,
        el("span", { class: "pill " + cls }, text),
        el("span", { class: "qual muted" }, r.published ? "Published " + when(r.published) : r.draft ? "Not published" : "Publish time not given"),
        person(r.author),
        r.assets.length ? el("details", {}, el("summary", {}, plural(r.assets.length, "asset")), el("ul", { class: "plain-list" }, r.assets.map(a =>
          el("li", { "data-asset": a.url ? "link" : "text" }, a.url ? link(a.url, a.name) : el("span", { class: "mono" }, a.name), el("span", { class: "qual muted" }, " " + bytes(a.size) +
            (a.downloads === null ? "" : ", " + plural(a.downloads, "download")) + (a.url ? "" : ", no GitHub download address"))))))
          : el("span", { class: "qual muted" }, "No assets"));
    }));
  }

  // ---- The inbox: the signed-in account's own open work, in the mapped repositories only.

  function inbox(S, A) {
    const sec = el("section", { class: "stack", "aria-labelledby": "view-h" },
      el("header", { class: "head" }, el("div", { class: "row1" }, el("h1", { id: "view-h" }, "Inbox"), el("span", { class: "stage-tag" }, "Account"))));
    const all = SB.portfolio(S.entries);
    const { readable: rows, unread } = SB.inboxScope(all);
    const user = A.live("user");
    const login = user && user.data ? user.data.login : null;
    sec.append(tip(el("div", { class: "notice info", role: "status", "data-state": "inbox" }, el("span", { class: "glyph", "aria-hidden": "true" }, "i"),
      el("div", {}, el("b", {}, "Your open work in " + plural(all.length, "mapped repository", "mapped repositories")),
        el("div", {}, "Read from each repository's latest 100 open pull requests and 100 open issues, live. GitHub notifications and repositories outside your projects are not read, and nothing is marked as read."))), "Inbox"));
    if (!user || user.state === "loading") { sec.append(notice("loading")); return sec; }
    if (!login) { sec.append(notice(user.state, user.error, "Signed-in account not read")); return sec; }
    const box = SB.inbox(A.live, rows.map(r => r.repo), login);
    const webOf = repo => { const r = rows.find(x => x.repo === repo); return r && r.pinned.data.web; };
    const pullItem = x => el("li", { "data-pull": x.repo + "#" + x.pr.number }, link(webOf(x.repo) && webOf(x.repo) + "/pull/" + x.pr.number, x.repo + " #" + x.pr.number),
      el("span", { class: "ev-title" }, x.pr.title), el("span", { class: "pill " + PULL[SB.pullState(x.pr)][1] }, PULL[SB.pullState(x.pr)][0]),
      x.pr.updated ? el("span", { class: "qual muted" }, "Updated " + when(x.pr.updated)) : null);
    const issueItem = x => el("li", { "data-issue": x.repo + "#" + x.issue.number }, link(webOf(x.repo) && webOf(x.repo) + "/issues/" + x.issue.number, x.repo + " #" + x.issue.number),
      el("span", { class: "ev-title" }, x.issue.title), x.issue.created ? el("span", { class: "qual muted" }, "Opened " + when(x.issue.created)) : null);
    const group = (id, title, list, item, none) => el("section", { class: "card", "aria-labelledby": id + "-h", "data-part": id },
      el("h2", { id: id + "-h", class: "label" }, title + " (" + list.length + ")"),
      list.length ? el("ul", { class: "feed" }, list.map(item)) : el("p", { class: "muted plain" }, box.loading ? "Still reading."
        : none + (unread.length ? " " + plural(unread.length, "mapped repository", "mapped repositories") + " not read; see below." : "")));
    sec.append(el("p", { class: "qual muted plain" }, "Signed in as ", el("span", { class: "mono" }, login), "."));
    sec.append(group("inbox-mine", "Your open pull requests", box.mine, pullItem, "None in the open pull requests read."),
      group("inbox-review", "Reviews asked of you", box.review, pullItem, "None asked of you by name in the open pull requests read."),
      group("inbox-assigned", "Issues assigned to you", box.assigned, issueItem, "None assigned to you in the open issues read."));
    const notes = [];
    // A mapped repository that could not be read is named; none of its lists is read.
    for (const u of unread) notes.push(u.repo + ": " + (u.state === "loading" ? "the repository is still being read, so its lists are not read yet"
      : "the repository could not be read (" + stateName(u).toLowerCase() + (u.error ? ", " + u.error : "") + "), so its lists are not read"));
    if (box.loading) notes.push("Still reading " + plural(box.loading, "list") + ".");
    for (const p of box.problems) notes.push(p.repo + ": open " + (p.kind === "pulls" ? "pull requests" : "issues") + " " + stateName(p.res).toLowerCase() + (p.res.error ? " (" + p.res.error + ")" : "") + ", not read");
    for (const p of box.partial) notes.push(p.repo + ": only the latest 100 open " + (p.kind === "pulls" ? "pull requests" : "issues") + " were read");
    if (box.teams) notes.push(plural(box.teams, "open pull request asks", "open pull requests ask") + " a team for review. Team membership is not read, so a review asked of a team is not counted as asked of you.");
    if (notes.length) sec.append(el("ul", { class: "coverage", "data-part": "inbox-coverage", "aria-label": "What was not read" }, notes.map(n => el("li", {}, n))));
    return sec;
  }

  Object.assign(V, { work, inbox, WORK_SUBS: ["pulls", "issues", "runs", "releases"] });
})(typeof window !== "undefined" ? window : globalThis);
