"use strict";
// Atlas account: the signed-in account's public profile, its public activity over the last 90 days as a
// calendar of days, and its latest public events. Adapted from the owner's own earlier app (the same
// author's profile header, activity heatmap and event feed), reused with the owner's permission and
// changed to read through this site's read-only client, only after it is asked for. Days are the
// viewer's own local days. Everything is GitHub's public activity, never progress.

(function (root) {
  const SB = root.SB;

  // The days the calendar shows, the events the feed lists, and the kinds the mix names.
  const DAYS = 91, FEED = 9, MIX = 5;
  const DAY = 864e5;

  // Keys of the reads. The "account" family belongs to no repository.
  const accountKey = {
    profile: login => "account|profile|" + login,
    events: login => "account|events|" + login,
    starred: login => "account|starred|" + login,
    gists: login => "account|gists|" + login,
  };

  const SPACES = /[ \t\n\r\f\v]+/;
  // A starred repository matches when every word is in its name, description or language, in any case.
  function starMatch(r, q) {
    const words = String(q || "").toLowerCase().split(SPACES).filter(Boolean);
    const hay = [r.repo, r.description || "", r.language || ""].join(" ").toLowerCase();
    return words.every(w => hay.includes(w));
  }

  // Each kind of public event: a short mark for the feed and its name in the mix.
  const KINDS = {
    PushEvent: ["push", "Pushes"], PullRequestEvent: ["PR", "Pull requests"], PullRequestReviewEvent: ["rev", "Reviews"],
    PullRequestReviewCommentEvent: ["rev", "Review comments"], IssuesEvent: ["iss", "Issues"], IssueCommentEvent: ["cmt", "Comments"],
    CreateEvent: ["new", "Created"], DeleteEvent: ["del", "Deleted"], WatchEvent: ["★", "Starred"], ForkEvent: ["fork", "Forked"],
    ReleaseEvent: ["rel", "Releases"], PublicEvent: ["pub", "Made public"], MemberEvent: ["mem", "Collaborators"],
    GollumEvent: ["wiki", "Wiki edits"], CommitCommentEvent: ["cmt", "Commit comments"],
  };
  const kindName = type => (KINDS[type] || [null, type.replace(/Event$/, "")])[1];
  const kindMark = type => (KINDS[type] || ["•"])[0];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // An event in one line of plain text, as the feed says it.
  function eventLine(e) {
    switch (e.type) {
      case "PushEvent": return e.size ? "Pushed " + e.size + " commit" + (e.size === 1 ? "" : "s") + " to " + e.repo : "Pushed to " + e.repo;
      case "PullRequestEvent": return cap((e.action || "updated") + " a pull request in " + e.repo);
      case "IssuesEvent": return cap((e.action || "updated") + " an issue in " + e.repo);
      case "IssueCommentEvent": return "Commented in " + e.repo;
      case "PullRequestReviewEvent": return "Reviewed a pull request in " + e.repo;
      case "CreateEvent": return "Created " + (e.refType || "repository") + " in " + e.repo;
      case "DeleteEvent": return "Deleted " + (e.refType || "a ref") + " in " + e.repo;
      case "WatchEvent": return "Starred " + e.repo;
      case "ForkEvent": return "Forked " + e.repo;
      case "ReleaseEvent": return "Published a release in " + e.repo;
      default: return kindName(e.type) + " · " + e.repo;
    }
  }

  // How much an event counts for its day: a push counts its commits when GitHub says how many.
  const weight = e => e.type === "PushEvent" && e.size ? e.size : 1;

  // The last DAYS local days up to today, oldest first, each with what happened on it.
  function activityDays(events, now) {
    const today = SB.localDay(now === undefined ? Date.now() : now);
    if (!today) return [];
    const end = Date.parse(today), counts = new Map();
    for (const e of events || []) { const d = SB.localDay(e.at); if (d) counts.set(d, (counts.get(d) || 0) + weight(e)); }
    const out = [];
    for (let i = DAYS - 1; i >= 0; i--) { const t = end - i * DAY, day = new Date(t).toISOString().slice(0, 10); out.push({ day, dow: new Date(t).getUTCDay(), count: counts.get(day) || 0 }); }
    return out;
  }

  // Four levels above none, from the quarters of the days that had anything, as the earlier app drew them.
  function heatLevels(days) {
    const nz = days.map(d => d.count).filter(Boolean).sort((a, b) => a - b);
    const q = [0.25, 0.5, 0.75].map(p => nz[Math.floor(p * (nz.length - 1))] || 1);
    return days.map(d => d.count === 0 ? 0 : d.count <= q[0] ? 1 : d.count <= q[1] ? 2 : d.count <= q[2] ? 3 : 4);
  }

  // The busiest day, the first of equals; null when nothing happened.
  const busiest = days => days.reduce((a, d) => d.count > (a ? a.count : 0) ? d : a, null);

  // The kinds of event most seen, most first (ties by name), at most MIX.
  function eventMix(events) {
    const m = new Map();
    for (const e of events || []) m.set(e.type, (m.get(e.type) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || kindName(a[0]).localeCompare(kindName(b[0]))).slice(0, MIX).map(([type, n]) => ({ type, name: kindName(type), n }));
  }

  SB.ACCOUNT = { DAYS, FEED, MIX };
  Object.assign(SB, { accountKey, starMatch, eventLine, eventKind: kindName, eventMark: kindMark, activityDays, heatLevels, busiest, eventMix });
})(typeof window !== "undefined" ? window : globalThis);
