"use strict";
// A repository's files at the commit its project reads: the file tree, one file's text, and the changes
// of that commit or from another branch, tag or commit to it. Every read names its commit by full ID and
// the view says which. Content is data: it is shown as plain text only, so nothing in a file or a change
// runs, no HTML, Markdown, SVG or image is rendered and no address in it becomes a link. Characters that
// print nothing or turn the text's direction are shown by their code. Nothing is edited or committed.

(function (root) {
  const SB = root.SB;
  const V = SB.views;
  const { el, notice } = V;

  Object.assign(V.TIPS, {
    "Files": "The repository's files at exactly the commit this project reads. A file is shown as plain text: nothing in it runs or is rendered.",
    "Changes": "What a commit changed against its first parent, or what changed from another branch, tag or commit to this one since their common ancestor.",
    "Hidden characters": "Characters that print nothing or turn the direction of the text around them, so a line could read differently from what it holds. Each is shown by its code, such as U+202E.",
  });

  const tip = (node, key) => { node.setAttribute("data-tip", V.TIPS[key] || key); return node; };
  const short = sha => typeof sha === "string" ? sha.slice(0, 7) : "";
  const plural = (n, one, many) => n.toLocaleString("en") + " " + (n === 1 ? one : many || one + "s");
  const bytes = n => n < 1024 ? plural(n, "byte") : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
  const muted = (text, part) => el("p", { class: "qual muted plain", "data-part": part || null }, text);
  const out = (href, text, id) => href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", id: id || null }, text) : null;
  const blobHref = (web, commit, path) => web && web + "/blob/" + commit + "/" + path.split("/").map(encodeURIComponent).join("/");
  const MODES = [["files", "Files"], ["changes", "Changes"]];
  const KIND = { "file": ["·", ""], symlink: ["↪", "link, not followed"], submodule: ["⧉", "another repository, not opened"] };
  const STATUS = { added: "Added", removed: "Removed", modified: "Changed", renamed: "Renamed", copied: "Copied", changed: "Changed (mode)", unchanged: "Unchanged" };

  function code(S, A, entry, name, pinned) {
    const d = pinned.data;
    const c = A.codeView(name);
    return [
      tip(el("div", { class: "notice info", role: "status", "data-state": "code" }, el("span", { class: "glyph", "aria-hidden": "true" }, "i"),
        el("div", {}, el("b", {}, "Files read at " + d.ref + " → " + short(d.commit)),
          el("div", {}, "Every file and change here is read at a commit named by its full ID. It is shown as plain text: nothing in it runs, no HTML, Markdown or image is rendered, and no address in it is a link. Nothing is edited or committed from here."))), "Files"),
      el("div", { class: "chips", role: "group", "aria-label": "Show files or changes" }, MODES.map(([k, l]) =>
        tip(el("button", { type: "button", id: "cm-" + k, "aria-pressed": String(c.mode === k), onclick: () => A.setCodeMode(name, k) }, l), l))),
      c.mode === "changes" ? changes(A, name, d, c) : files(A, name, d, c),
    ];
  }

  // ---- The tree and the file viewer beside it

  function files(A, name, d, c) {
    const res = A.live(SB.codeKey.tree(name, d.commit));
    const side = el("section", { class: "card stack tight", "aria-labelledby": "ft-h", "data-part": "code-tree" },
      tip(el("h2", { id: "ft-h", class: "label" }, "Files at " + d.ref + " → " + short(d.commit)), "Files"));
    if (!res || res.state === "loading") side.append(notice("loading"));
    else if (!res.data) side.append(notice(res.state, res.error, "File tree not read"));
    else {
      const t = SB.codeTree(res.data);
      side.append(el("label", { class: "find" }, "Find a file by path",
        el("input", { id: "code-q", type: "search", value: c.query, autocomplete: "off", spellcheck: "false", oninput: e => A.setCodeQuery(name, e.target.value) })));
      if (c.query.trim()) {
        const f = SB.codeFind(res.data, c.query);
        side.append(f.found.length ? el("ul", { class: "ftree found" }, f.found.map(e => el("li", {}, fileButton(A, name, c, e, e.path))))
          : el("p", { class: "muted plain" }, "No file path holds that."),
          muted(f.total > f.found.length ? "Showing the first " + f.found.length + " of " + plural(f.total, "match", "matches") + "; type more to narrow them." : plural(f.total, "match", "matches") + ".", "code-found"));
      } else side.append(t.root.kids.length ? treeList(A, name, t.root, c) : el("p", { class: "muted plain", "data-part": "tree-empty" }, "GitHub lists no files at this commit."));
      side.append(muted(res.data.truncated
        ? "GitHub cut its list of this tree at " + plural(res.data.entries.length, "entry", "entries") + ", so some files and folders are not listed; nothing is guessed for them."
        : plural(t.files, "file") + " and " + plural(t.dirs, "folder") + ": the whole tree GitHub lists at this commit.", "tree-coverage"));
    }
    // With no tree there is nothing to pick a file from, so no viewer is shown.
    return el("div", { class: "files" }, side, res && !res.data && res.state !== "loading" ? null : viewer(A, name, d, c, res));
  }

  function treeList(A, name, node, c) {
    return el("ul", { class: "ftree" }, node.kids.map(k => {
      if (k.kind !== "dir") return el("li", {}, fileButton(A, name, c, k, k.name));
      const open = c.open.has(k.path);
      return el("li", {}, el("button", { type: "button", class: "fnode", "aria-expanded": String(open), "data-path": k.path, onclick: () => A.toggleCodeDir(name, k.path) },
        el("span", { class: "tw", "aria-hidden": "true" }, open ? "▾" : "▸"), el("span", { class: "fname" }, k.name),
        k.listed ? null : el("span", { class: "qual muted" }, " folder not listed by GitHub")), open ? treeList(A, name, k, c) : null);
    }));
  }

  function fileButton(A, name, c, e, label) {
    const cur = c.path === e.path;
    return el("button", { type: "button", class: "fnode" + (cur ? " current" : ""), "aria-current": cur ? "true" : null, "data-path": e.path, "data-kind": e.kind,
      onclick: () => A.openCodeFile(name, e.path) },
      el("span", { class: "tw", "aria-hidden": "true" }, KIND[e.kind][0]), el("span", { class: "fname" }, label),
      KIND[e.kind][1] ? el("span", { class: "qual muted" }, " " + KIND[e.kind][1]) : null);
  }

  // One file at the read commit, or why it is not shown. A path not in this commit's tree is never taken from another commit.
  function viewer(A, name, d, c, tree) {
    const card = el("section", { class: "card stack tight", "aria-labelledby": "fv-h", "data-part": "code-viewer" });
    if (!c.path) {
      card.append(el("h2", { id: "fv-h", class: "label" }, "File"), el("p", { class: "muted plain" }, "Pick a file in the tree to see its text at this commit."));
      return card;
    }
    card.append(el("h2", { id: "fv-h", class: "fpath mono" }, c.path),
      el("p", { class: "qual muted plain", "data-part": "file-source" }, "At " + d.ref + " → ", el("span", { class: "mono", title: d.commit }, short(d.commit)),
        d.web ? [" · ", out(blobHref(d.web, d.commit, c.path), "Open on GitHub", "code-web")] : null));
    if (!tree || tree.state === "loading") { card.append(notice("loading")); return card; }
    if (!tree.data) { card.append(notice(tree.state, tree.error, "File tree not read")); return card; }
    const e = tree.data.entries.find(x => x.path === c.path);
    const o = SB.codeOpenable(e);
    if (!o.ok) { card.append(why(o.why, e, d, tree.data.truncated)); return card; }
    const res = A.live(SB.codeKey.text(name, d.commit, c.path));
    if (!res || res.state === "loading") card.append(notice("loading"));
    else if (!res.data) card.append(notice(res.state, res.error, "File not read"));
    else if (res.data.binary) card.append(notice("unavailable", "It is not UTF-8 text (a binary file, or another encoding), so its content is not shown. " + bytes(res.data.size) + ", blob " + short(res.data.sha) + ".", "Not shown as text"));
    else if (!res.data.text) card.append(el("p", { class: "muted plain", "data-part": "file-empty" }, "This file is empty at this commit."));
    else card.append(...textBlock(res.data, c.path, d.commit));
    return card;
  }

  function why(reason, e, d, cut) {
    if (reason === "missing") return notice("missing", (cut ? "It is not in the part of the tree GitHub listed at " : "There is no such file in the tree at ") + short(d.commit) +
      ". Nothing is shown from another commit or branch in its place.", "Not at this commit");
    if (reason === "symlink") return notice("unavailable", "This is a symbolic link. It is not followed, so nothing it points to is read.", "Link not followed");
    if (reason === "submodule") return notice("unavailable", "This is another repository, pinned at commit " + short(e.sha) + ". It is not opened from here.", "Another repository");
    if (reason === "large") return notice("unavailable", bytes(e.size) + ": larger than the 1 MB GitHub gives as text, so it is not read.", "Too large to show");
    return notice("unavailable", "This app opens only paths made of letters, digits, dots, dashes, underscores and slashes. This one has other characters, so it is not read.", "Path not opened");
  }

  // A line's text, with each hidden character shown by its code; count is told how many there were.
  function lineText(line, count) {
    const span = el("span", { class: "tx" });
    for (const p of SB.textPieces(line)) {
      if (p.hidden) { count(); span.append(el("span", { class: "hid", title: "Hidden character " + p.hidden }, p.hidden)); }
      else span.append(p.text);
    }
    return span;
  }

  function hiddenNote(n) {
    return n ? tip(el("p", { class: "qual warn-text plain", "data-part": "hidden-chars" }, plural(n, "hidden character") + " (that print nothing or turn the text's direction) " +
      (n === 1 ? "is" : "are") + " shown by " + (n === 1 ? "its code" : "their codes") + ", such as U+202E."), "Hidden characters") : null;
  }

  function textBlock(file, path, commit) {
    const t = SB.textLines(file.text);
    let hidden = 0;
    const count = () => { hidden += 1; };
    const pre = el("pre", { class: "code", tabindex: "0", "aria-label": "Text of " + path + " at " + short(commit), "data-part": "file-text" },
      t.lines.map((line, i) => el("div", {}, el("span", { class: "ln", "aria-hidden": "true" }, String(i + 1)), lineText(line, count))));
    return [pre, hiddenNote(hidden),
      muted(plural(t.total, "line") + ", " + bytes(file.size) + ", blob " + short(file.sha) + " (matched to GitHub's hash)." +
        (t.total > t.lines.length ? " Only the first " + plural(t.lines.length, "line") + " are shown." : "") +
        (t.crlf ? " Windows line ends are not shown." : "") + " Shown as plain text: nothing in it is run or rendered.", "file-meta")].filter(Boolean);
  }

  // ---- Changes: the read commit's own, or from another branch, tag or commit to it

  function changes(A, name, d, c) {
    const card = el("section", { class: "card stack tight", "aria-labelledby": "ch-h", "data-part": "code-changes" });
    const form = el("form", { class: "filters cmp-form", "aria-label": "Compare", onsubmit: e => { e.preventDefault(); A.setCodeAgainst(name, e.currentTarget.elements.namedItem("against").value); } },
      el("label", {}, "Compare with a branch, tag or commit",
        el("input", { id: "code-against", name: "against", value: c.againstError ? c.typed : c.against, autocomplete: "off", spellcheck: "false", placeholder: "main, v1.0 or a commit ID" })),
      el("div", { class: "actions" }, el("button", { type: "submit", class: "btn ghost", id: "code-compare" }, "Compare"),
        c.against ? el("button", { type: "button", class: "btn ghost", id: "code-own", onclick: () => A.setCodeAgainst(name, "") }, "Show this commit's own changes") : null));
    card.append(form, el("p", { class: "status-line", id: "code-status", role: "status" }, c.againstError));
    let res;
    if (!c.against) {
      res = A.live(SB.codeKey.commit(name, d.commit));
      card.append(tip(el("h2", { id: "ch-h", class: "label" }, "Changes in " + d.ref + " → " + short(d.commit)), "Changes"));
      if (res && res.data) {
        const p = res.data.commit.parents;
        card.append(el("p", { class: "plain", "data-part": "change-source" }, el("span", { class: "ev-title" }, res.data.commit.title), " ",
          el("span", { class: "qual muted" }, !p.length ? "The first commit: every file in it is new." : p.length === 1 ? "Against its parent " + short(p[0]) + "."
            : "A merge commit: shown against its first parent " + short(p[0]) + ", not its " + plural(p.length - 1, "other parent") + "."),
          d.web ? [" ", out(d.web + "/commit/" + d.commit, "Open on GitHub", "code-web")] : null));
      }
    } else {
      const b = A.live(SB.codeKey.commit(name, c.against));
      const base = b && b.data ? b.data.commit.sha : null;
      card.append(tip(el("h2", { id: "ch-h", class: "label" }, "Changes from " + c.against + (base ? " → " + short(base) : "") + " to " + d.ref + " → " + short(d.commit)), "Changes"));
      if (!b || b.state === "loading") { card.append(notice("loading")); return card; }
      if (!b.data) {
        card.append(notice(b.state, (b.state === "missing" ? "GitHub finds no branch, tag or commit called “" + c.against + "” in " + name + "."
          : "“" + c.against + "” could not be read (" + (b.error || b.state) + ").") + " Nothing else is compared in its place.", "Not compared"));
        return card;
      }
      res = A.live(SB.codeKey.compare(name, base, d.commit));
      if (res && res.data) card.append(el("p", { class: "plain", "data-part": "change-source" },
        res.data.status === "identical" ? "The two are the same commit." : d.ref + " is " + plural(res.data.ahead, "commit") + " ahead of " + c.against + " and " + plural(res.data.behind, "commit") + " behind it, as GitHub compares them now.",
        el("span", { class: "qual muted" }, res.data.mergeBase ? " The changes are counted from their common ancestor " + short(res.data.mergeBase) + "." : " GitHub gives no common ancestor."),
        d.web ? [" ", out(d.web + "/compare/" + base + "..." + d.commit, "Open on GitHub", "code-web")] : null));
    }
    if (!res || res.state === "loading") { card.append(notice("loading")); return card; }
    if (!res.data) { card.append(notice(res.state, res.error, "Changes not read")); return card; }
    const list = res.data.files;
    if (!list.length) { card.append(el("p", { class: "muted plain", "data-part": "change-empty" }, "No file changed.")); return card; }
    const shown = list.find(f => f.path === c.diff) || list[0];
    card.append(el("div", { class: "table-wrap" }, el("table", { class: "grid-table", "data-part": "change-files" },
      el("thead", {}, el("tr", {}, ["File", "Change", "Lines added", "Lines removed"].map(t => el("th", { scope: "col" }, t)))),
      el("tbody", {}, list.map(f => el("tr", { "data-file": f.path },
        el("th", { scope: "row" }, el("button", { type: "button", class: "linkbtn mono", "data-diff": f.path, "aria-pressed": String(f === shown), onclick: () => A.showCodeDiff(name, f.path) }, f.path),
          f.from ? el("div", { class: "qual muted" }, "from " + f.from) : null),
        el("td", {}, STATUS[f.status]), el("td", { class: "num" }, "+" + f.added), el("td", { class: "num" }, "−" + f.removed)))))));
    card.append(muted(res.state === "partial" ? "GitHub lists at most " + SB.MAX_DIFF_FILES + " changed files in one reply. These are the first " + plural(list.length, "file") + "; the rest are not shown."
      : plural(list.length, "file") + " changed: the whole list GitHub gives.", "change-coverage"));
    card.append(diffBlock(shown));
    return card;
  }

  function diffBlock(f) {
    const box = el("div", { class: "stack tight", "data-part": "diff" }, el("h3", { class: "fpath mono", id: "diff-h" }, f.path));
    if (f.patch === null) {
      box.append(notice("unavailable", "GitHub gives no text diff for this file (a binary file, or a change too large to show). It counts " + f.added + " added and " + f.removed + " removed lines.", "No text diff"));
      return box;
    }
    const dl = SB.diffLines(f.patch);
    let hidden = 0;
    const count = () => { hidden += 1; };
    const MARK = { add: "+", del: "−", ctx: " ", hunk: "", note: "", plain: "" };
    box.append(el("pre", { class: "code diff", tabindex: "0", "aria-labelledby": "diff-h", "data-part": "diff-text" }, dl.lines.map(l =>
      el("div", { class: l.kind, "data-kind": l.kind },
        el("span", { class: "ln", "aria-hidden": "true" }, l.old === undefined || l.old === null ? "" : String(l.old)),
        el("span", { class: "ln", "aria-hidden": "true" }, l.new === undefined || l.new === null ? "" : String(l.new)),
        el("span", { class: "mk" }, MARK[l.kind]), lineText(l.text, count)))));
    box.append(...[hiddenNote(hidden),
      dl.ok ? null : muted("This patch is not in the unified diff form, so its lines are shown as they are, without line numbers.", "diff-plain"),
      dl.total > dl.lines.length ? muted("Only the first " + plural(dl.lines.length, "line") + " of " + dl.total.toLocaleString("en") + " are shown.", "diff-cut") : null,
      muted("Shown as plain text: nothing in it is run or rendered.")].filter(Boolean));
    return box;
  }

  Object.assign(V, { code });
})(typeof window !== "undefined" ? window : globalThis);
