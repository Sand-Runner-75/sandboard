"use strict";
// Atlas account: the signed-in account's public profile, its public activity over the last 90 days as a
// calendar of days, and its latest public events. Adapted from the owner's own earlier app (the same
// author's profile header, activity heatmap and event feed), reused with the owner's permission and
// changed to read through this site's read-only client, only after it is asked for. Days are the
// viewer's own local days. Asked for apart: the starred repositories and gists, and the account beside
// another one in eight rounds of public numbers, as the earlier app compared them. Everything is GitHub's
// public activity, never progress.

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
    repos: login => "account|repos|" + login,
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

  // The longest run of days in a row that had anything.
  function bestStreak(days) {
    let best = 0, run = 0;
    for (const d of days) { run = d.count ? run + 1 : 0; if (run > best) best = run; }
    return best;
  }

  const year = t => { const d = SB.localDay(t); return d ? Number(d.slice(0, 4)) : null; };

  // One account's public numbers, to put beside another's: from its profile, its own public repositories
  // and its public events of the last 90 days, as the earlier app counted them (stars and languages from
  // repositories that are not forks). The lists are reads as the client gives them. A number is a lower
  // bound (low) when its list is partial, left entries out, or lacks a value it adds up.
  function accountStats(profile, repos, events, now) {
    now = now === undefined ? Date.now() : now;
    const R = repos.data.repos, own = R.filter(r => !r.fork);
    const lc = new Map();
    for (const r of own) if (r.language) lc.set(r.language, (lc.get(r.language) || 0) + 1);
    const total = [...lc.values()].reduce((a, n) => a + n, 0);
    const langs = [...lc].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MIX).map(([name, n]) => ({ name, share: n / total }));
    const top = own.reduce((a, r) => (r.stars || 0) > (a ? a.stars : 0) ? r : a, null);
    const days = activityDays(events.data.events, now);
    return {
      login: profile.login, name: profile.name || profile.login, web: profile.web || null, followers: profile.followers, since: year(profile.since),
      repos: R.length, stars: own.reduce((a, r) => a + (r.stars || 0), 0), langCount: lc.size, langs,
      top: top ? { repo: top.repo, stars: top.stars } : null,
      active: R.filter(r => r.pushed !== null && now - r.pushed < 30 * DAY).length,
      actions: days.reduce((a, d) => a + d.count, 0), streak: bestStreak(days),
      low: lowBounds(repos, events, own, R),
    };
  }

  function lowBounds(repos, events, own, R) {
    const reposLow = repos.state === "partial" || repos.data.skipped > 0, eventsLow = events.state === "partial" || events.data.skipped > 0;
    return { stars: reposLow || own.some(r => r.stars === null), repos: reposLow, langCount: reposLow,
             active: reposLow || R.some(r => r.pushed === null), actions: eventsLow, streak: eventsLow, followers: false, years: false };
  }

  // The eight rounds. A round is won only when it is proven: the higher number wins unless the other side's
  // number is a lower bound (lowA, lowB) that could reach it; a number not known wins nothing.
  function duelRows(a, b, now) {
    const thisYear = year(now === undefined ? Date.now() : now);
    const yrs = s => s.since === null || thisYear === null ? null : thisYear - s.since;
    const rows = [
      ["Stars earned", "stars"], ["Public repositories", "repos"], ["Followers", "followers"], ["Actions, 90 days", "actions"],
      ["Best streak (days)", "streak"], ["Languages", "langCount"], ["Years on GitHub", "years"], ["Active repositories, 30 days", "active"],
    ];
    return rows.map(([label, key]) => {
      const x = key === "years" ? yrs(a) : a[key], y = key === "years" ? yrs(b) : b[key];
      const lowA = x !== null && a.low[key], lowB = y !== null && b.low[key];
      return { label, a: x, b: y, lowA, lowB,
               win: x === null || y === null ? null : x > y && !lowB ? "a" : y > x && !lowA ? "b" : null };
    });
  }

  // GitHub's own colours for common languages; any other gets a steady colour from its name.
  const LANG = { JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Java: "#b07219", C: "#555555", "C++": "#f34b7d", "C#": "#178600",
    Go: "#00ADD8", Rust: "#dea584", Ruby: "#701516", PHP: "#4F5D95", Swift: "#F05138", Kotlin: "#A97BFF", Dart: "#00B4AB", HTML: "#e34c26",
    CSS: "#663399", SCSS: "#c6538c", Shell: "#89e051", "Jupyter Notebook": "#DA5B0B", Vue: "#41b883", Svelte: "#ff3e00", Lua: "#000080", R: "#198CE7",
    Scala: "#c22d40", Haskell: "#5e5086", Elixir: "#6e4a7e", Dockerfile: "#384d54", PowerShell: "#012456", "Objective-C": "#438eff", Julia: "#a270ba",
    Zig: "#ec915c", Nix: "#7e7eff", HCL: "#844FBA", Astro: "#ff5a03", GDScript: "#355570", OCaml: "#ef7a08", Elm: "#60B5CC" };
  function langColor(name) {
    if (!name) return "#9d9d9d";
    if (Object.prototype.hasOwnProperty.call(LANG, name)) return LANG[name];
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return "hsl(" + h + " 55% 52%)";
  }

  // A short number for the badge: 12,345 as 12.3k and 2,000,000 as 2M.
  const shortNumber = n => n === null ? "?" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/[.]0$/, "") + "M" : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/[.]0$/, "") + "k" : n.toLocaleString("en");

  // The README badge's four numbers, as the earlier app's card shows them; a lower bound gets a "+".
  function badgeNumbers(s) {
    const plus = key => s.low[key] ? "+" : "";
    return [["Stars", shortNumber(s.stars) + plus("stars")], ["Repos", shortNumber(s.repos) + plus("repos")],
            ["Actions (90d)", shortNumber(s.actions) + plus("actions")], ["Best streak", s.streak + "d" + plus("streak")]];
  }

  SB.ACCOUNT = { DAYS, FEED, MIX };
  Object.assign(SB, { accountKey, starMatch, bestStreak, accountStats, duelRows, langColor, shortNumber, badgeNumbers, eventLine, eventKind: kindName, eventMark: kindMark, activityDays, heatLevels, busiest, eventMix });
})(typeof window !== "undefined" ? window : globalThis);
