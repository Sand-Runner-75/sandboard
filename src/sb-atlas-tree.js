"use strict";
// Atlas code tree: a repository's files as a living tree, played back commit by commit. Folders are
// joined by lines, files are dots coloured by type around their folder, and each coder flies to the
// files they change. Adapted from the owner's own earlier app (the same author's code tree: its
// simulation, drawing, camera, agent naming and recording), reused with the owner's permission and
// changed to read through this site's read-only client: the commits, the file tree before them and each
// commit's files come from cached reads, at most a few at a time, and only after Play is pressed.
// Coders are shown by their initial, never by a picture fetched from elsewhere. Everything is read-only
// GitHub evidence and none of it is progress.

(function (root) {
  const SB = root.SB;

  // The newest commits of the default branch played, the reads in flight at once, the agent pull
  // requests looked into, the files kept, and commits a second at 1×.
  const WANT = 150, POOL = 6, AGENT_PRS = 20, MAX_FILES = 4000, RATE = 3;
  const BG = "#0b0e14", INK = "#e6edf3", MUTED = "#8b949e";
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', MONO = 'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';

  const treeKey = { pullCommits: (repo, number) => "pullcommits|" + repo + "|" + number };

  // ---- File colours: a colour for each common file type, and a colour of its own for any other.

  const EXT = {
    js: "#f1e05a", mjs: "#f1e05a", cjs: "#f1e05a", jsx: "#f1e05a", ts: "#3178c6", tsx: "#3178c6", py: "#3572a5", java: "#b07219",
    c: "#a8b9cc", h: "#a8b9cc", cpp: "#f34b7d", cc: "#f34b7d", hpp: "#f34b7d", cs: "#178600", go: "#00add8", rs: "#dea584", rb: "#cc342d",
    php: "#4f5d95", swift: "#f05138", kt: "#a97bff", dart: "#00b4ab", html: "#e34c26", htm: "#e34c26", css: "#a06cd5", scss: "#c6538c",
    sh: "#89e051", bash: "#89e051", vue: "#41b883", svelte: "#ff3e00", r: "#198ce7", scala: "#c22d40", ex: "#9b6fb8", exs: "#9b6fb8",
    ipynb: "#da5b0b", zig: "#ec915c", nix: "#7e7eff", tf: "#844fba", sol: "#aa6746", astro: "#ff5a03", mdx: "#fcb32c", jl: "#a270ba",
    md: "#e6edf3", txt: "#c9d1d9", json: "#cbcb41", yml: "#e5534b", yaml: "#e5534b", toml: "#c47e3e", lock: "#768390", xml: "#3fb950",
    png: "#a371f7", jpg: "#a371f7", jpeg: "#a371f7", gif: "#a371f7", svg: "#ffb000", ico: "#a371f7", gitignore: "#f78166", csv: "#56d4dd", sql: "#e38c00",
  };
  const extOf = path => {
    const name = path.split("/").pop(), i = name.lastIndexOf(".");
    return (i > 0 ? name.slice(i + 1) : i === 0 ? name.slice(1) : name).toLowerCase().slice(0, 14);
  };
  const colorMemo = new Map();
  function colorOf(ext) {
    if (colorMemo.has(ext)) return colorMemo.get(ext);
    let c = EXT[ext];
    if (!c) { let h = 0; for (const ch of ext) h = (h * 31 + ch.charCodeAt(0)) % 360; c = "hsl(" + h + " 65% 60%)"; }
    colorMemo.set(ext, c);
    return c;
  }
  const AUTHOR = ["#58a6ff", "#f778ba", "#3fb950", "#ffa657", "#d2a8ff", "#56d4dd", "#ff7b72", "#e3b341"];

  // ---- Agents. Coding agents often commit under the owner's own account, so their work shows only in
  // the branch name (gpt/..., claude/...). Commits that came in through a merged pull request from such a
  // branch are credited to the agent, and marked as named from the branch.

  const AGENTS = [[/^(gpt|chatgpt|codex|openai)[/-]/i, "ChatGPT"], [/^claude[/-]/i, "Claude"], [/^copilot[/-]/i, "Copilot"],
                  [/^(cursor|devin|jules|gemini)[/-]/i, ref => ref.split(/[/-]/)[0].replace(/^./, x => x.toUpperCase())]];
  const BOTS = { "copilot-swe-agent[bot]": "Copilot", "chatgpt-codex-connector[bot]": "ChatGPT" };
  function agentOf(ref) {
    for (const [re, name] of AGENTS) if (re.test(ref)) return typeof name === "function" ? name(ref) : name;
    return null;
  }

  // ---- The data: what the code tree of a repository can play from the reads in live (key => result),
  // and the reads it still wants, at most POOL in flight at once: the branch list (for the default
  // branch's head), pages of that head's commits, the file tree just before the newest WANT of them, the
  // pull requests (to name agents) and each agent pull request's commits, then each commit's files.
  // Merges are skipped, since their changes already came with the commits they merged.
  function atlasTree(live, repo, def, want) {
    want = want || WANT;
    const K = SB.historyKey;
    const br = live(K.refs(repo, "branches"));
    if (!br) return { state: "loading", step: "commits", wanted: [{ kind: "refs", list: "branches" }] };
    if (br.state === "loading") return { state: "loading", step: "commits", wanted: [] };
    if (!br.data) return { state: br.state, error: br.error || null, wanted: [] };
    const headRef = br.data.refs.find(b => b.name === def);
    if (!headRef) return { state: "empty", why: "branch", wanted: [] };
    const head = headRef.sha;
    // The newest commits, page by page.
    const list = [];
    let ended = false;
    for (let p = 1; list.length < want; p++) {
      const res = live(K.lane(repo, head, p));
      if (!res) return { state: "loading", step: "commits", head, wanted: [{ kind: "lane", head, page: p }] };
      if (res.state === "loading") return { state: "loading", step: "commits", head, wanted: [] };
      if (!res.data) return { state: res.state, error: res.error || null, head, wanted: [] };
      list.push(...res.data.commits);
      if (res.data.end) { ended = true; break; }
    }
    const whole = ended && list.length <= want;
    const win = list.slice(0, want).reverse();
    if (!win.length) return { state: "empty", why: "commits", head, wanted: [] };
    const need = [];
    let busy = 0;
    const ask = (key, w) => { const res = live(key); if (!res) need.push(w); else if (res.state === "loading") busy++; return res; };
    // Unless this is the whole history, start from the files as they were just before the window.
    const before = whole ? null : win[0].parents[0] || null;
    const tree = before ? ask(SB.codeKey.tree(repo, before), { kind: "tree", commit: before }) : null;
    const commits = win.filter(c => c.parents.length < 2);
    const since = win[0].at;
    // Pull requests merged inside the window from an agent's branch: their merge commit and commits.
    const pulls = ask(SB.workKey.list("pulls", repo, "all", 1), { kind: "pulls", state: "all", page: 1 });
    const bySha = new Map();
    if (pulls && pulls.data) {
      const prs = pulls.data.pulls.filter(p => p.merged && (!since || p.merged >= since) && p.headRef && agentOf(p.headRef)).slice(0, AGENT_PRS);
      for (const p of prs) {
        const who = agentOf(p.headRef);
        if (p.mergeCommit) bySha.set(p.mergeCommit, who);  // a squash merge lands as this one commit
        const res = ask(treeKey.pullCommits(repo, p.number), { kind: "pullCommits", number: p.number });
        if (res && res.data) for (const sha of res.data.shas) bySha.set(sha, who);
      }
    }
    // Each commit's files.
    let done = 0, failed = 0;
    const out = commits.map(c => {
      const res = ask(SB.codeKey.commit(repo, c.sha), { kind: "change", sha: c.sha });
      let files = [];
      if (res && res.state !== "loading") { done++; if (res.data) files = res.data.files.map(f => ({ p: f.path, s: f.status, prev: f.from })); else failed++; }
      const login = c.author || "", named = bySha.get(c.sha) || BOTS[login] || null;
      return { sha: c.sha, date: c.at, msg: c.title, author: named && named !== login ? named : login || "someone", inferred: !!(named && named !== login), files };
    });
    const wanted = need.slice(0, Math.max(0, POOL - busy));
    const settled = !need.length && !busy;
    const progress = { done, of: commits.length };
    if (!settled) return { state: "loading", step: "files", head, wanted, progress };
    const initial = tree && tree.data ? tree.data.entries.filter(e => e.kind === "file" || e.kind === "symlink").map(e => e.path) : [];
    return { state: out.length ? "current" : "empty", why: out.length ? null : "commits", head, wanted: [], progress,
             data: { initial, commits: out, whole, failed, treeMissing: !!(tree && !tree.data), treePartial: !!(tree && tree.state === "partial") } };
  }

  // The number of reads a code tree of want commits costs at most: the commit pages, the tree, the pull
  // requests and their commits, and one per commit.
  const treeCost = want => Math.ceil(want / 100) + 2 + AGENT_PRS + want;

  // ---- The simulation. One per playback: the view has one, a recording makes its own. t is in seconds
  // of playback time. Folder positions are kept across restarts (keep), so seeking does not reshuffle
  // the picture; a fixed seed puts new folders in the same places each time.

  class Sim {
    constructor(data, keep) {
      this.data = data; this.keep = keep || new Map();
      this.dirs = new Map(); this.files = new Map(); this.dying = []; this.authors = new Map(); this.k = 0; this.t = 0; this.busy = -99;
      this.seed = 7;
      this.root = this.dir("");
      for (const p of data.initial) this.add(p, -10);
      this.date = data.commits[0] ? data.commits[0].date : null;
    }
    rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
    dir(path) {
      let d = this.dirs.get(path);
      if (d) return d;
      const parent = path ? this.dir(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "") : null;
      const kept = this.keep.get(path), a = this.rnd() * Math.PI * 2;
      d = { path, name: path.split("/").pop() || "/", parent, kids: new Set(), files: [], vx: 0, vy: 0, r: 10, hot: -99,
            x: kept ? kept[0] : parent ? parent.x + Math.cos(a) * 60 : 0, y: kept ? kept[1] : parent ? parent.y + Math.sin(a) * 60 : 0 };
      if (parent) parent.kids.add(d);
      this.dirs.set(path, d);
      return d;
    }
    add(path, t) {
      let f = this.files.get(path);
      if (!f) {
        if (this.files.size >= MAX_FILES) return null;
        const d = this.dir(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""), ext = extOf(path);
        f = { path, d, ext, c: colorOf(ext), born: t, hot: -99, x: d.x, y: d.y };
        this.files.set(path, f); d.files.push(f); d.r = 8 + 4.2 * Math.sqrt(d.files.length);
      }
      return f;
    }
    remove(path, t) {
      const f = this.files.get(path);
      if (!f) return;
      this.files.delete(path);
      const d = f.d;
      d.files.splice(d.files.indexOf(f), 1); d.r = 8 + 4.2 * Math.sqrt(d.files.length);
      this.dying.push(Object.assign({}, f, { died: t }));
      // Empty folders go too, up to the first one that still holds something.
      for (let e = d; e.parent && !e.files.length && !e.kids.size; e = e.parent) { e.parent.kids.delete(e); this.dirs.delete(e.path); }
    }
    // Applies the next commit: files appear, light up or fade out, and their author flies over.
    next() {
      const c = this.data.commits[this.k++];
      if (!c) return;
      this.date = c.date; this.busy = this.t;
      const touched = [];
      for (const ch of c.files) {
        if (ch.s === "removed") { this.remove(ch.p, this.t); continue; }
        if (ch.s === "renamed" && ch.prev) this.remove(ch.prev, this.t);
        const f = this.add(ch.p, this.t);
        if (f) { f.hot = this.t; f.d.hot = this.t; touched.push(f); }
      }
      let a = this.authors.get(c.author);
      if (!a) {
        const anchor = touched[0] ? touched[0].d : this.root, n = this.authors.size;
        a = { name: c.author, inferred: c.inferred, c: AUTHOR[n % AUTHOR.length], x: anchor.x + 160, y: anchor.y - 120, vx: 0, vy: 0 };
        this.authors.set(c.author, a);
      }
      a.last = this.t; a.targets = touched; a.msg = c.msg;
    }
    // Moves everything one step: folders push apart and pull towards their parent, coders glide to their files.
    step(dt) {
      this.t += dt;
      const dirs = [...this.dirs.values()], n = dirs.length;
      for (let i = 0; i < n; i++) {
        const a = dirs[i];
        for (let j = i + 1; j < n; j++) {
          const b = dirs[j], dx = b.x - a.x, dy = b.y - a.y, min = a.r + b.r + 26, d2 = dx * dx + dy * dy;
          if (d2 > min * min * 2.2) continue;
          const d = Math.sqrt(d2) || 0.1, push = (min * 1.48 - d) / d * 0.06;
          if (push > 0) { a.vx -= dx * push; a.vy -= dy * push; b.vx += dx * push; b.vy += dy * push; }
        }
        const p = a.parent;
        if (!p) continue;
        const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy) || 0.1, want = p.r + a.r + 34, pull = (d - want) / d * 0.08;
        a.vx -= dx * pull; a.vy -= dy * pull; p.vx += dx * pull * 0.3; p.vy += dy * pull * 0.3;
        // Away from the grandparent, so branches grow outwards like a tree.
        if (p.parent) { const gx = p.x - p.parent.x, gy = p.y - p.parent.y, g = Math.hypot(gx, gy) || 1; a.vx += gx / g * 0.35; a.vy += gy / g * 0.35; }
      }
      for (const d of dirs) {
        if (!d.parent) { d.x *= 0.9; d.y *= 0.9; d.vx = d.vy = 0; continue; }
        d.vx *= 0.82; d.vy *= 0.82; d.x += d.vx; d.y += d.vy;
        this.keep.set(d.path, [d.x, d.y]);
      }
      // Files sit in a sunflower around their folder.
      for (const d of dirs) d.files.forEach((f, i) => { const a = i * 2.39996, r = 4.2 * Math.sqrt(i + 0.6); f.x = d.x + Math.cos(a) * r; f.y = d.y + Math.sin(a) * r; });
      for (const a of this.authors.values()) {
        if (!a.targets || !a.targets.length) continue;
        let cx = 0, cy = 0;
        for (const f of a.targets) { cx += f.x; cy += f.y; }
        cx /= a.targets.length; cy /= a.targets.length;
        const tx = cx + 70, ty = cy - 60;
        a.vx = (a.vx + (tx - a.x) * 0.02) * 0.8; a.vy = (a.vy + (ty - a.y) * 0.02) * 0.8; a.x += a.vx; a.y += a.vy;
      }
      // Coders keep a little apart, so two working in one folder do not sit on top of each other.
      const people = [...this.authors.values()];
      for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
        const a = people[i], b = people[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.1;
        if (d < 60) { const k = (60 - d) / d * 0.1; a.x -= dx * k; a.y -= dy * k; b.x += dx * k; b.y += dy * k; }
      }
      this.dying = this.dying.filter(f => this.t - f.died < 1.5);
    }
    bounds() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const d of this.dirs.values()) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
      return x0 === Infinity ? [-100, -100, 100, 100] : [x0, y0, x1, y1];
    }
  }

  // A new playback from the start, settled so the first frame is not a heap in the middle.
  function treeStart(data, keep) {
    const s = new Sim(data, keep);
    for (let i = 0; i < (data.initial.length ? 260 : 20); i++) s.step(0);
    return s;
  }
  // A playback just after commit k, replayed from the start (cheap: only the file lists are replayed).
  function treeSeek(data, keep, k) {
    const s = treeStart(data, keep);
    while (s.k < k) { s.next(); if (s.k % 4 === 0) s.step(0); }
    for (let i = 0; i < 30; i++) s.step(0);
    s.t = 10;
    for (const f of s.files.values()) f.hot = -99;
    for (const a of s.authors.values()) a.last = -99;
    return s;
  }

  // ---- Drawing. cam is { x, y, s }: the world point at the centre and the zoom. Returns what was
  // drawn where, for the hover bubble.
  const day = t => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleString("en", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
  function treeDraw(ctx, W, H, sim, cam, opt) {
    opt = opt || {};
    const t = sim.t, X = x => W / 2 + (x - cam.x) * cam.s, Y = y => H / 2 + (y - cam.y) * cam.s, hits = [];
    const glow = (age, span) => Math.max(0, 1 - age / span);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    // Folder lines
    ctx.lineCap = "round";
    for (const d of sim.dirs.values()) {
      if (!d.parent) continue;
      const g = glow(t - d.hot, 2);
      ctx.strokeStyle = "rgba(220,230,245," + (0.22 + g * 0.5) + ")"; ctx.lineWidth = Math.max(1, (1.6 + g * 1.5) * Math.min(1.4, cam.s));
      ctx.beginPath(); ctx.moveTo(X(d.parent.x), Y(d.parent.y)); ctx.lineTo(X(d.x), Y(d.y)); ctx.stroke();
    }
    // Files: new ones grow in, changed ones flare, deleted ones fade away.
    const fr = Math.max(1.2, 2.1 * cam.s);
    for (const f of sim.files.values()) {
      const g = glow(t - f.hot, 1.2), grow = Math.min(1, (t - f.born) / 0.4 + 0.15), x = X(f.x), y = Y(f.y);
      if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      ctx.fillStyle = f.c; ctx.globalAlpha = 0.85 + g * 0.15;
      if (g > 0) { ctx.shadowColor = f.c; ctx.shadowBlur = 14 * g; }
      ctx.beginPath(); ctx.arc(x, y, fr * grow * (1 + g * 0.8), 0, Math.PI * 2); ctx.fill();
      if (g > 0) ctx.shadowBlur = 0;
      hits.push({ x, y, r: fr + 2, tip: f.path });
    }
    for (const f of sim.dying) { ctx.globalAlpha = Math.max(0, 1 - (t - f.died) / 1.5) * 0.7; ctx.fillStyle = f.c; ctx.beginPath(); ctx.arc(X(f.x), Y(f.y), fr, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
    // Names of folders that are busy right now
    ctx.font = "12px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const d of sim.dirs.values()) {
      const g = glow(t - d.hot, 3);
      if (g <= 0 || !d.parent) continue;
      ctx.globalAlpha = g; ctx.fillStyle = INK; ctx.fillText(d.name, X(d.x), Y(d.y) - d.r * cam.s - 8);
    }
    // Coders, each a circle with their initial, with beams to the files they just changed
    for (const a of sim.authors.values()) {
      const idle = t - a.last, fade = idle < 4 ? 1 : Math.max(0, 1 - (idle - 4) / 2);
      if (fade <= 0) continue;
      const ax = X(a.x), ay = Y(a.y), beam = glow(idle, 1.4), R = 13;
      if (beam > 0) for (const f of a.targets) {
        const gr = ctx.createLinearGradient(ax, ay, X(f.x), Y(f.y)); gr.addColorStop(0, a.c); gr.addColorStop(1, "rgba(255,255,255,0)");
        ctx.globalAlpha = beam * 0.75 * fade; ctx.strokeStyle = gr; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(X(f.x), Y(f.y)); ctx.stroke();
      }
      ctx.globalAlpha = fade;
      ctx.fillStyle = a.c; ctx.beginPath(); ctx.arc(ax, ay, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = BG; ctx.font = "700 13px " + FONT; ctx.fillText((a.name[0] || "?").toUpperCase(), ax, ay + 1);
      ctx.fillStyle = a.c; ctx.font = "600 12px " + FONT; ctx.fillText(a.name + (a.inferred ? "*" : ""), ax, ay + R + 11);
      hits.push({ x: ax, y: ay, r: R + 2, tip: a.name + (a.inferred ? " (named from the pull request's branch)" : "") + "\n" + (a.msg || "") });
    }
    ctx.globalAlpha = 1;
    // File types and how many of each, top left
    const counts = new Map();
    for (const f of sim.files.values()) counts.set(f.ext, (counts.get(f.ext) || 0) + 1);
    const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, opt.legend || Math.max(4, Math.floor((H - 40) / 19)));
    ctx.textAlign = "left"; ctx.font = "12px " + MONO;
    rows.forEach(([ext, n], i) => {
      const y = 14 + i * 19, w = 86;
      const gr = ctx.createLinearGradient(10, 0, 10 + w, 0); gr.addColorStop(0, colorOf(ext)); gr.addColorStop(1, "rgba(255,255,255,.08)");
      ctx.fillStyle = gr; ctx.fillRect(10, y, w, 16);
      ctx.fillStyle = "#fff"; ctx.fillText(ext.length > 11 ? ext.slice(0, 10) + "…" : ext, 14, y + 8.5);
      ctx.fillStyle = INK; ctx.fillText(n.toLocaleString("en"), 10 + w + 7, y + 8.5);
    });
    // The date at the top, the repository name and a footer in the corners
    ctx.textAlign = "center"; ctx.fillStyle = "#79c0ff"; ctx.font = "15px " + FONT;
    if (sim.date) ctx.fillText(day(sim.date), W / 2, 22);
    ctx.textAlign = "right";
    if (opt.title) { ctx.fillStyle = INK; ctx.font = "600 14px " + FONT; ctx.fillText(opt.title, W - 14, 22); }
    if (opt.footer) { ctx.fillStyle = MUTED; ctx.font = "600 12px " + FONT; ctx.fillText(opt.footer, W - 14, H - 14); }
    return hits;
  }

  // A camera that keeps the whole tree in view; ease below 1 moves it part of the way.
  function treeFit(sim, W, H, cam, ease) {
    ease = ease === undefined ? 1 : ease;
    const [x0, y0, x1, y1] = sim.bounds(), pad = 70;
    const s = Math.min(2.2, (W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0));
    cam.x += ((x0 + x1) / 2 - cam.x) * ease; cam.y += ((y0 + y1) / 2 - cam.y) * ease; cam.s += (s - cam.s) * ease;
    return cam;
  }

  // ---- Recording: the whole playback as an animated GIF. Each commit gets a few frames, then a short
  // pause on the finished tree; a long window plays two commits a frame. The palette comes from the
  // finished tree, so a first quick pass plays to the end before the frames are written.
  const pause = () => new Promise(ok => setTimeout(ok));
  async function treeGif(data, canvas, title, footer, onStep) {
    const W = canvas.width, H = canvas.height, FPS = 12, n = data.commits.length;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const per = Math.max(1, Math.min(5, Math.round(150 / Math.max(1, n)))), step = Math.max(1, Math.ceil(n / 150)), total = Math.ceil(n / step) * per + 24;
    const play = async each => {
      const s = treeStart(data, new Map()), cam = treeFit(s, W, H, { x: 0, y: 0, s: 1 });
      for (let f = 0; f < total; f++) {
        if (f % per === 0) for (let j = 0; j < step; j++) s.next();
        s.step(1 / FPS); treeFit(s, W, H, cam, 0.15);
        if (each) {
          treeDraw(ctx, W, H, s, cam, { title, footer, legend: 14 });
          each(ctx.getImageData(0, 0, W, H).data, f === total - 1 ? 2500 : Math.round(1000 / FPS));
          if (onStep) onStep(f + 1, total);
          if (f % 10 === 0) await pause();
        }
      }
      return { s, cam };
    };
    const end = await play(null);
    treeDraw(ctx, W, H, end.s, end.cam, { title, footer, legend: 14 });
    const gif = SB.gifWriter(W, H, SB.gifPalette(ctx.getImageData(0, 0, W, H).data));
    await play((px, delay) => gif.add(px, delay));
    return { bytes: gif.finish(), frames: gif.frames, commits: n };
  }

  Object.assign(SB, {
    TREE: { WANT, POOL, AGENT_PRS, MAX_FILES, RATE, BG, FONT, MONO, agentOf, extOf, colorOf, cost: treeCost },
    treeKey, atlasTree, TreeSim: Sim, treeStart, treeSeek, treeDraw, treeFit, treeGif,
  });
})(typeof window !== "undefined" ? window : globalThis);
