"use strict";
// Browser checks of the built site (run by tests/test_browser.py). The demo
// runs on its own synthetic repositories; the private path runs against a
// mock of the GitHub API with synthetic repositories, through Playwright's
// request interception, so nothing leaves the machine. Prints one JSON object.
// Usage: node workspace.check.js <playwright module> <built site folder>
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.argv[2]);
const DIST = path.resolve(process.argv[3]);
const { mockGitHub, json, sha, blobSha } = require("../js/helpers");
const F = require("../js/fixtures");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/frame.html") { res.end("<iframe src=\"/index.html\" width=\"600\" height=\"400\"></iframe>"); return; }
  if (url === "/other.html") { res.end("<p>another page</p>"); return; }
  const file = path.join(DIST, url === "/" ? "index.html" : path.normalize(url));
  if (!file.startsWith(DIST)) { res.statusCode = 404; res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
});

// Private fixture: the reader fixtures plus approved result files and briefs.
const APPROVED = [{ id: "XQ101", approval: "PR #4", files: ["notes/XQ101-result.md", "plan/tasks.md"], rejected: ["../../outside.md"] }];
function privateRepos() {
  const ws = F.workspacesDoc();
  ws.workspaces[0].plan.files = Object.assign({}, F.FILES, { brief: "notes/{id}-brief.md", crossref: "plan/xref/{id}.md" });
  ws.workspaces.push({ id: "locked", label: "Locked Garden", kind: "project",
                       plan: { repo: "acme/locked-plan", ref: null, files: F.FILES }, code: [] });
  // A phase with a huge supplied count must not become as many page elements.
  const progress = F.progressDoc({ approved_results: APPROVED });
  progress.phases[1].status_counts["Not Started"] = 1000000000;
  // Check runs with every kind of outcome, including a finished run with no conclusion.
  const checks = [["passes", "completed", "success"], ["fails", "completed", "failure"], ["queued", "queued", null],
                  ["skipped", "completed", "skipped"], ["unfinished conclusion", "completed", null], ["odd", "completed", "something_new"]]
    .map(([name, status, conclusion]) => ({ name, status, conclusion }));
  return F.planRepos({ workspaces: ws, checks, files: {
    [F.FILES.progress]: JSON.stringify(progress, null, 1),
    "notes/XQ101-brief.md": "Synthetic brief for XQ101.\n",
    "plan/xref/XQ101.md": "# XQ101 cross-references\n\n- Synthetic rules file\n",
  } });
}

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const BASE = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch();
  const out = { errors: [], requests: [], dialogs: 0 };

  async function open(opts = {}) {
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 } }, opts));
    const page = await context.newPage();
    page.on("pageerror", e => out.errors.push(e.message));
    // A refused reply from the mock API is logged by the browser itself; anything else is a page error.
    page.on("console", m => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) out.errors.push(m.text()); });
    page.on("dialog", d => { out.dialogs += 1; d.dismiss(); });
    page.on("request", r => { if (!r.url().startsWith(BASE)) out.requests.push(r.method() + " " + r.url()); });
    await page.goto(BASE + "/index.html");
    return page;
  }
  const demo = async page => { await page.click("#show-demo"); await page.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent) || document.querySelectorAll("#tree [role=treeitem]").length > 20); await page.waitForTimeout(300); };
  // Projects start collapsed, so a place deeper in the tree is reached by opening its groups' arrows first.
  const expand = async (page, id) => { const n = await page.$(`#tree [data-id="${id}"][aria-expanded="false"] > .ti > .tw`); if (n) { await n.click(); await page.waitForTimeout(50); } };
  const tree = async (page, id) => {
    const sel = `#tree [data-id="${id}"] > .ti`, [kind, ws] = id.split(":");
    if (!(await page.$(sel))) {
      for (const g of ["p:", ...({ st: ["stages:"], ph: ["stages:", "phases:"], r: ["repos:"] }[kind] || [])]) await expand(page, g + ws);
      if (kind === "ph" && !(await page.$(sel)))
        for (const st of await page.$$eval(`#tree [data-id^="st:${ws}:"][aria-expanded="false"]`, n => n.map(x => x.dataset.id))) { await expand(page, st); if (await page.$(sel)) break; }
    }
    return page.click(sel);
  };
  const text = (page, sel) => page.$eval(sel, n => n.textContent).catch(() => null);
  const active = page => page.evaluate(() => { const a = document.activeElement;
    return { id: a.id, key: a.dataset.key || a.dataset.id || "", tag: a.tagName, role: a.getAttribute("role"), outline: getComputedStyle(a).outlineWidth }; });

  // 1. Keyboard-only journey on the demo.
  let p = await open();
  const k = out.keys = {};
  await p.keyboard.press("Tab"); k.first = await active(p);
  await p.keyboard.press("Enter"); k.afterSkip = await active(p);
  await p.focus("#show-demo"); await p.keyboard.press("Enter");
  await p.waitForSelector("#tree [data-id='p:demo']"); await p.waitForTimeout(400);
  await p.keyboard.press("/"); k.search = await active(p);
  await p.keyboard.type("trace");
  k.rows = await p.$$eval("#task-list .row", r => r.map(x => x.dataset.id));
  for (let i = 0; i < 5; i++) await p.keyboard.press("Tab");  // stage, phase, status and doer filters, then the list
  k.onRow = await active(p);
  await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  k.panel = await text(p, "#inspector");
  k.rowFocus = await active(p);
  await p.keyboard.press("t"); k.tab = await active(p);
  k.tabPanel = await text(p, "#tab-panel");
  await p.keyboard.press("ArrowLeft"); k.viewTab = await active(p);
  await p.keyboard.press("ArrowRight"); await p.keyboard.press("Delete");
  k.tabsAfterClose = await p.$$eval(".tabs [role=tab]", t => t.length);
  await p.keyboard.press("?"); k.help = await p.$eval("#help", d => d.open);
  await p.keyboard.press("Escape"); k.helpClosed = await p.$eval("#help", d => !d.open);
  await p.focus('#tree [tabindex="0"]'); k.treeStart = await active(p);
  await p.keyboard.press("ArrowDown"); k.treeNext = await active(p);
  await p.keyboard.press("Enter"); k.treeOpened = await text(p, "#main h1#view-h");
  await p.keyboard.press("Control+k"); k.gotoOpen = await p.$eval("#goto", d => d.open);
  await p.keyboard.type("second project: tasks"); await p.keyboard.press("Enter");
  k.gotoWent = await text(p, "#view-h");
  k.outlines = [k.search, k.onRow, k.tab, k.viewTab, k.treeNext].map(x => x.outline);
  await p.close();

  // 2. Progress shapes and filters on the demo.
  p = await open(); await demo(p);
  const prog = out.progress = {};
  const whole = () => text(p, "#whole-cards");
  prog.whole = await whole();
  prog.phases = await p.$$eval(".phase", n => n.map(x => [x.dataset.phase, x.textContent]));
  // The overview's lower part: every task beside the recent activity; a stage chip opens Tasks instead.
  const lower = () => p.evaluate(() => ({ columns: [...document.querySelectorAll("[data-part=overview-lower] > section")].map(n => n.dataset.part || ""),
    title: (document.getElementById("all-tasks-h") || {}).textContent || "", count: (document.querySelector("[data-part=overview-tasks-count]") || {}).textContent || "",
    ids: [...document.querySelectorAll("[data-part=overview-tasks] li")].map(n => n.dataset.task),
    sideBySide: (() => { const s = [...document.querySelectorAll("[data-part=overview-lower] > section")].map(n => n.getBoundingClientRect()); return s.length === 2 && Math.abs(s[0].top - s[1].top) < 2 && s[0].right <= s[1].left; })() }));
  prog.lowerAll = await lower();
  await p.click(".chips [data-stage='S1']"); await p.waitForTimeout(100);
  prog.lowerStage = await lower();
  prog.stageView = { tasks: await p.$$eval("#task-list", n => n.length), stage: await p.$eval("#f-stage", n => n.value) };
  prog.stagePhases = await p.$$eval(".phase", n => n.map(x => x.dataset.phase));
  prog.stageCards = await text(p, "#stage-cards");
  prog.wholeWithStage = await whole();
  prog.stageInTree = await p.$eval("#tree [data-id='st:demo:S1'] > .ti", n => n.classList.contains("current")).catch(() => "no stage item");
  await p.click(".phase[data-phase='P2']"); await p.waitForTimeout(100);
  prog.phaseRows = await p.$$eval("#task-list .row", r => r.map(x => x.dataset.id || "invalid"));
  prog.wholeAfterPhase = await whole();
  await p.fill("#q", "zzz-no-such-task"); await p.waitForTimeout(100);
  prog.noMatch = await p.$eval("#task-area .notice", n => n.dataset.state).catch(() => null);
  prog.wholeAfterNoMatch = await whole();
  await p.selectOption("#f-phase", ""); await p.fill("#q", ""); await p.selectOption("#f-status", "Done");
  prog.doneRows = await p.$$eval("#task-list .row", r => r.map(x => x.dataset.id));
  prog.wholeAfterStatus = await whole();
  // Approval only from the producer's list; demo has no web address, so files are listed without links.
  await p.selectOption("#f-status", "");
  await p.click("#task-list .row[data-id='DT102']"); await p.waitForTimeout(200);
  prog.doneNotApproved = await text(p, "#inspector");
  await p.click("#task-list .row[data-id='DT101']"); await p.waitForTimeout(200);
  prog.approved = await text(p, "#inspector");
  prog.demoLinks = await p.$$eval("a[href]", a => a.map(x => x.getAttribute("href")).filter(h => !h.startsWith("#")));
  await p.click("#task-list .row[data-id='DT103']"); await p.waitForTimeout(300);
  prog.hostile = await text(p, "#handover-text");
  prog.scripts = await p.$$eval("script", s => s.length);
  prog.imgs = await p.$$eval("img", s => s.length);
  // Other projects: stale, unavailable, kit, denied, code only.
  const view = async id => { await tree(p, "p:" + id); await p.waitForTimeout(150);
    return { h1: await text(p, "#view-h"), states: await p.$$eval("#workspace .notice", n => n.map(x => x.dataset.state)),
             phases: await p.$$eval(".phase", n => n.length), ring: await p.$$eval(".ring.none", n => n.length),
             body: await text(p, "#workspace") }; };
  for (const id of ["second", "notes", "kit", "locked", "tools"]) prog[id] = await view(id);
  await tree(p, "v:kit:tasks"); await p.waitForTimeout(150);
  prog.kitRows = await p.$$eval("#task-list .row", r => r.map(x => x.textContent));
  await tree(p, "v:locked:tasks"); await p.waitForTimeout(150);
  prog.lockedTasks = await text(p, "#workspace");
  await p.keyboard.press("Control+k"); await p.keyboard.type("DT1");
  prog.gotoOnLocked = await p.$$eval("#goto-list li", l => l.map(x => x.textContent));
  await p.keyboard.press("Escape");
  prog.writeControls = await p.$$eval("button, a", n => n.map(x => x.textContent.trim())
    .filter(t => /\b(edit|merge|approve|assign|re-?run|publish|delete|mark|star|cancel)\b/i.test(t)));
  await p.close();

  // 3. Tabs keep their source; Forget (with Go to open) clears every surface.
  p = await open(); await demo(p);
  await tree(p, "v:demo:tasks"); await p.click("#task-list .row[data-id='DT201']"); await p.waitForTimeout(300);
  await p.click("#inspector >> text=Open as tab"); await p.waitForTimeout(200);
  const life = out.lifecycle = {};
  life.tabKey = await p.$eval(".tabs [role=tab][aria-selected=true]", n => n.dataset.key);
  life.tabSource = await text(p, "#tab-panel .source");
  await tree(p, "v:second:tasks"); await p.waitForTimeout(150);
  life.tabsInSecond = await p.$$eval(".tabs [role=tab]", t => t.map(x => x.textContent));
  await tree(p, "v:demo:overview"); await p.waitForTimeout(150);
  life.tabsBack = await p.$$eval(".tabs [role=tab]", t => t.map(x => x.textContent));
  await p.keyboard.press("Control+k");
  life.gotoWasOpen = await p.$eval("#goto", d => d.open);
  await p.evaluate(() => document.getElementById("forget").click());  // as if Forget ran while Go to was open
  await p.waitForTimeout(150);
  life.afterForget = await p.evaluate(() => document.body.innerText);
  life.gotoOpen = await p.$eval("#goto", d => d.open);
  life.gotoDisabled = await p.$eval("#goto-open", b => b.disabled);
  life.gotoItems = await p.$$eval("#goto-list li", l => l.length);
  // Leaving the page and coming back shows a signed-out page.
  await demo(p);
  await p.goto(BASE + "/other.html"); await p.goBack(); await p.waitForTimeout(300);
  life.afterBack = await p.evaluate(() => document.body.innerText);
  await p.close();

  // 3b. Search: Go to opens it, the keyboard reaches its controls, it fits a phone screen, and Forget
  // access or leaving the page drops the words, the option and the results.
  const ls = out.searchLife = {};
  p = await open({ viewport: { width: 320, height: 640 } }); await demo(p);
  await p.keyboard.press("Control+k"); await p.keyboard.type("search what"); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  ls.heading = await text(p, "#main h1#view-h");
  await p.focus("#sq"); await p.keyboard.type("dt1"); await p.waitForTimeout(100);
  ls.typedFocus = await active(p);
  ls.results = await p.$$eval("[data-part=search-tasks] [data-result=task]", n => n.length);
  await p.keyboard.press("Tab"); ls.nextFocus = await active(p);
  await p.click("#s-inside"); await p.waitForTimeout(100);
  ls.overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  // Refresh starts a new run: the words, the option and the results go with the old run.
  await p.evaluate(() => document.getElementById("refresh").click()); await p.waitForTimeout(400);
  ls.afterRefresh = { q: await p.inputValue("#sq"), inside: await p.$eval("#s-inside", n => n.getAttribute("aria-pressed")),
                      results: await p.$$eval("[data-result]", n => n.length) };
  await p.fill("#sq", "dt1"); await p.waitForTimeout(100);
  await p.evaluate(() => document.getElementById("forget").click()); await p.waitForTimeout(150);
  ls.afterForget = await p.evaluate(() => document.body.innerText);
  await demo(p);
  await p.keyboard.press("Control+k"); await p.keyboard.type("search what"); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  ls.again = { q: await p.inputValue("#sq"), inside: await p.$eval("#s-inside", n => n.getAttribute("aria-pressed")),
               results: await p.$$eval("[data-result]", n => n.length) };
  await p.fill("#sq", "dt1"); await p.waitForTimeout(100);
  await p.goto(BASE + "/other.html"); await p.goBack(); await p.waitForTimeout(300);
  ls.afterBack = await p.evaluate(() => document.body.innerText);
  await p.close();

  // 4. Copy: the copied text is exactly the shown text; a refused clipboard says so.
  p = await open({ permissions: ["clipboard-read", "clipboard-write"] }); await demo(p);
  await tree(p, "v:demo:tasks"); await p.click("#task-list .row[data-id='DT201']"); await p.waitForTimeout(300);
  await p.click("[data-copy='brief']"); await p.waitForTimeout(150);
  out.copy = { shown: await text(p, "#brief-text"), copied: await p.evaluate(() => navigator.clipboard.readText()),
               status: await text(p, "[data-file='brief'] .status-line") };
  await p.close();
  p = await open(); await demo(p);
  await p.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } }); });
  await tree(p, "v:demo:tasks"); await p.click("#task-list .row[data-id='DT201']"); await p.waitForTimeout(300);
  await p.click("[data-copy='brief']"); await p.waitForTimeout(150);
  out.copy.refused = await text(p, "[data-file='brief'] .status-line");
  out.copy.selected = await p.evaluate(() => String(getSelection()));
  await p.close();

  // 5. Layout: no sideways page scroll at four widths, in both themes, overview and tasks.
  out.layout = {};
  for (const width of [320, 390, 860, 1280]) {
    for (const theme of ["light", "dark"]) {
      p = await open({ viewport: { width, height: 800 }, colorScheme: theme }); await demo(p);
      const r = {};
      for (const v of ["overview", "tasks"]) {
        if (width <= 860) { await p.click("#menu"); }
        await tree(p, "v:demo:" + v); await p.waitForTimeout(100);
        if (v === "tasks") { await p.click("#task-list .row[data-id='DT104']"); await p.waitForTimeout(150); }
        r[v] = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      }
      r.bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
      r.menuShown = await p.$eval("#menu", b => getComputedStyle(b).display !== "none");
      out.layout[width + theme] = r;
      await p.close();
    }
  }
  p = await open({ colorScheme: "dark" });
  await p.click("[data-theme-choice=light]");
  out.layout.switched = await p.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]);
  await p.close();

  // 5b. Accessibility checks the design names (WCAG 2.2): target size, focus not obscured, roles and states.
  out.a11y = {};
  for (const width of [320, 1280]) {
    p = await open({ viewport: { width, height: 640 } }); await demo(p);
    if (width <= 860) { await p.click("#menu"); }
    await tree(p, "v:demo:tasks"); await p.waitForTimeout(100);
    await p.click("#task-list .row[data-id='DT103']"); await p.waitForTimeout(300);
    await p.click("#inspector >> text=Open as tab"); await p.waitForTimeout(200);
    await p.click("#tab-view"); await p.waitForTimeout(100);
    const a = out.a11y[width] = {};
    // 2.5.8: every control is at least 24 by 24 CSS px (inline text links are exempt).
    a.small = await p.$$eval("button, input, select, summary, [role=tab], [role=option], #tree .ti", els => els
      .filter(e => e.offsetParent !== null)
      .map(e => { const r = e.getBoundingClientRect(); return [e.id || e.dataset.id || e.dataset.key || e.textContent.trim().slice(0, 20), Math.round(r.width), Math.round(r.height)]; })
      .filter(([, w, h]) => w < 24 || h < 24));
    // 2.4.11: Tab through the page from the top; the sticky top bar never hides the focused item entirely.
    a.hidden = [];
    await p.evaluate(() => { window.scrollTo(0, 0); document.activeElement.blur(); });
    for (let i = 0; i < 40; i++) {
      await p.keyboard.press("Tab");
      const r = await p.evaluate(() => {
        const e = document.activeElement, top = document.querySelector(".top");
        if (!e || e === document.body || top.contains(e)) return null;
        const box = e.getBoundingClientRect(), bar = top.getBoundingClientRect();
        const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return box.bottom <= bar.bottom + 1 && at && top.contains(at) ? (e.id || e.dataset.id || e.dataset.key || e.tagName) : null;
      });
      if (r) a.hidden.push(r);
    }
    // 4.1.2: the roles and states the design lists are in the page.
    a.roles = await p.evaluate(() => ["tree", "treeitem", "listbox", "option", "tablist", "tab", "combobox", "dialog"]
      .filter(r => document.querySelector(r === "dialog" ? "dialog" : "[role=" + r + "]")));
    a.states = await p.evaluate(() => ({
      expanded: document.querySelectorAll("#tree [aria-expanded]").length > 0,
      selectedOption: document.querySelectorAll("#task-list [aria-selected=true]").length,
      selectedTab: document.querySelectorAll(".tabs [aria-selected=true]").length,
      pressed: document.querySelectorAll("[aria-pressed]").length > 0,
      current: document.querySelectorAll("#tree [aria-current]").length,
      unnamed: [...document.querySelectorAll("button, input, select, [role=tab], [role=option], [role=treeitem]")]
        .filter(e => e.offsetParent !== null && !(e.getAttribute("aria-label") || e.textContent.trim() || (e.labels && e.labels.length) || e.title))
        .map(e => e.id || e.tagName) }));
    await p.close();
  }

  // 6. Private path against the mocked API: links at the pinned commit, GET only, 401 clears everything.
  const priv = out.private = { methods: [], auth: [], hosts: [] };
  let revoke = false;
  let denyTable = false;
  const repos = privateRepos();
  const gh = mockGitHub(repos, [[/^[/]repos[/]acme[/]locked-plan/, () => json({ message: "denied" }, 403)],
                                         [/contents[/]plan[/]tasks[.]md/, (path, init) => denyTable ? json({ message: "denied" }, 403) : null]]);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    priv.methods.push(req.method());
    priv.auth.push(req.headers()["authorization"] === "Bearer synthetic-token");
    const res = revoke ? json({ message: "Bad credentials" }, 401) : await gh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  const finished = async () => { await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300); };
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished();
  priv.bigPhase = { label: await p.$eval(".phase[data-phase='P2']", n => n.getAttribute("aria-label")),
                    dots: await p.$$eval(".phase[data-phase='P2'] .dots > *", n => n.length) };
  await tree(p, "repos:garden"); await p.waitForTimeout(100);
  await tree(p, "r:garden:acme/garden"); await p.waitForTimeout(150);
  priv.checksAll = await p.evaluate(() => document.getElementById("workspace").innerText);
  priv.tokenField = await p.inputValue("#token");
  await tree(p, "v:garden:tasks"); await p.waitForTimeout(150);
  priv.rowLinks = await p.$$eval("#task-list .row[data-id='XQ101'] a", a => a.map(x => [x.getAttribute("href"), x.target, x.rel, x.tabIndex]));
  priv.otherRowLinks = await p.$$eval("#task-list .row:not([data-id='XQ101']) a", a => a.length);
  await p.click("#task-list .row[data-id='XQ101']"); await p.waitForTimeout(300);
  priv.panelLinks = await p.$$eval("#inspector .results a", a => a.map(x => [x.getAttribute("href"), x.target, x.rel]));
  priv.panel = await text(p, "#inspector");
  // A finished task: result files first, brief folded, cross-references linked at the commit.
  priv.panelOrder = await p.$$eval("#inspector > *", n => n.map(x => x.className || x.tagName.toLowerCase()));
  priv.briefFolded = await p.$eval("#inspector [data-file='brief']", n => n.tagName === "DETAILS" && !n.open);
  priv.xrefLink = await p.$$eval("#inspector [data-file='crossref-link'] a", a => a.map(x => [x.getAttribute("href"), x.target, x.rel]));
  // Search over what is read: it reads nothing. The brief read above counts only with Search inside tasks,
  // which is off by default; turning it off again drops the match. A result opens the task.
  const sr = priv.search = {};
  const before = priv.methods.length;
  await tree(p, "a:search"); await p.waitForTimeout(150);
  sr.heading = await text(p, "#main h1#view-h");
  const searchHits = () => p.$$eval("[data-part=search-tasks] [data-result=task]", n => n.map(x => x.dataset.task));
  await p.fill("#sq", "synthetic brief"); await p.waitForTimeout(100);
  sr.pressedAtFirst = await p.$eval("#s-inside", n => n.getAttribute("aria-pressed"));
  sr.off = await searchHits();
  await p.click("#s-inside"); await p.waitForTimeout(100);
  sr.on = await searchHits();
  sr.excerpt = await text(p, "[data-part=search-tasks] [data-part=excerpt]");
  sr.focus = await active(p);
  await p.click("#s-inside"); await p.waitForTimeout(100);
  sr.offAgain = await searchHits();
  await p.fill("#sq", "xq101 sketch"); await p.waitForTimeout(100);
  sr.byId = await searchHits();
  sr.source = await text(p, "[data-part=search-tasks] [data-result=task] .qual");
  sr.coverage = await text(p, "[data-part=search-coverage]");
  sr.requests = priv.methods.length - before;
  await p.click("[data-part=search-tasks] [data-open='task|garden|XQ101']"); await p.waitForTimeout(300);
  sr.opened = await p.$eval("#task-list .row[aria-selected=true]", n => n.dataset.id).catch(() => null);
  await expand(p, "p:garden"); await expand(p, "phases:garden");
  priv.phaseGroup = await p.$$eval("#tree [data-id^='ph:garden:']", n => n.map(x => x.dataset.id));
  priv.stageFilter = await p.$$eval("#f-stage", n => n.length);
  priv.commit = F.PLAN_COMMIT;
  // A plan that turns unreadable on refresh takes its open tabs and details with it.
  await p.click("#inspector >> text=Open as tab"); await p.waitForTimeout(200);
  priv.tabsBeforeDenial = await p.$$eval(".tabs [role=tab]", t => t.length);
  denyTable = true;
  await p.click("#refresh");
  await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent), null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(200);
  priv.tabsAfterDenial = await p.$$eval(".tabs [role=tab]", t => t.length);
  await tree(p, "v:garden:tasks"); await p.waitForTimeout(150);
  priv.tasksAfterDenial = await p.evaluate(() => document.getElementById("workspace").innerText);
  denyTable = false;
  // The branch moves on: a tab keeps its own commit's brief, a new read shows the new one.
  const plan = repos["acme/garden-plan"];
  const A = plan.branches.main;
  await p.click("#refresh"); await finished();
  await tree(p, "v:garden:tasks"); await p.waitForTimeout(150);
  await p.click("#task-list .row[data-id='XQ101']"); await p.waitForTimeout(300);
  await p.click("#inspector >> text=Open as tab"); await p.waitForTimeout(300);
  await p.click("#sub-brief"); await p.waitForTimeout(150);
  priv.tabBriefA = await text(p, "#tab-brief-text");
  const B = sha("plan-b");
  plan.files[B] = Object.assign({}, plan.files[A], { "notes/XQ101-brief.md": "Changed brief at the newer commit.\n" });
  plan.branches.main = B;
  await p.click("#refresh"); await finished();
  priv.tabBriefAfterAdvance = await text(p, "#tab-brief-text");
  priv.tabSourceAfterAdvance = await text(p, "#tab-panel .source");
  await p.click("#tab-view"); await p.waitForTimeout(150);
  await p.click("#task-list .row[data-id='XQ101']"); await p.waitForTimeout(300);
  priv.briefB = await text(p, "#brief-text");
  // The same project ID now maps another repository: the old repository's tab and details go.
  await p.click("#inspector >> text=Open as tab"); await p.waitForTimeout(300);
  priv.tabsBeforeRemap = await p.$$eval(".tabs [role=tab]", t => t.length);
  const ws = JSON.parse(plan.files[B]["sandboard.workspaces.json"]);
  ws.workspaces[0].plan.repo = "acme/replacement-plan";
  const R = sha("replacement");
  repos["acme/replacement-plan"] = { default_branch: "main", branches: { main: R },
    files: { [R]: Object.assign({}, plan.files[B], { "notes/XQ101-brief.md": "Brief in the replacement repository.\n" }) } };
  const C = sha("plan-c");
  plan.files[C] = Object.assign({}, plan.files[B], { "sandboard.workspaces.json": JSON.stringify(ws) });
  plan.branches.main = C;
  await p.click("#refresh"); await finished();
  priv.tabsAfterRemap = await p.$$eval(".tabs [role=tab]", t => t.length);
  priv.afterRemap = await p.evaluate(() => document.getElementById("workspace").innerText);
  await tree(p, "v:garden:tasks"); await p.waitForTimeout(150);
  await p.click("#task-list .row[data-id='XQ101']"); await p.waitForTimeout(300);
  priv.remapBrief = await text(p, "#brief-text");
  priv.remapSource = await text(p, "[data-file='brief'] .label");
  plan.branches.main = A;
  await p.click("#refresh"); await finished();
  await tree(p, "p:locked"); await p.waitForTimeout(150);
  priv.locked = await p.$$eval("#workspace .notice", n => n.map(x => x.dataset.state));
  priv.storage = await p.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length);
  revoke = true;
  await p.click("#refresh"); await p.waitForTimeout(500);
  priv.afterRevoke = await p.evaluate(() => document.body.innerText);
  priv.hosts = [...new Set(out.requests.map(r => new URL(r.split(" ")[1]).host))];
  await p.close();

  // 8. The owner's first-use findings: tree, details, task tabs, stage filter, layout, bubbles.
  const fu = out.firstUse = {};
  p = await open(); await demo(p);
  const kids = id => p.$$eval(`#tree [data-id="${id}"] > ul > li`, n => n.map(x => x.dataset.id));
  // Every project starts closed; the arrow opens and closes it; the name never closes it.
  fu.startsClosed = await p.$$eval('#tree [data-id^="p:"]', n => n.map(x => x.getAttribute("aria-expanded")));
  await p.click('#tree [data-id="p:demo"] > .ti > .tw'); await p.waitForTimeout(100);
  fu.openKids = await kids("p:demo");
  await p.click('#tree [data-id="p:demo"] > .ti > .tw'); await p.waitForTimeout(100);
  fu.closed = { expanded: await p.$eval('#tree [data-id="p:demo"]', n => n.getAttribute("aria-expanded")), kids: await kids("p:demo") };
  await p.click("#refresh"); await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent)); await p.waitForTimeout(200);
  fu.closedAfterRefresh = await p.$eval('#tree [data-id="p:demo"]', n => n.getAttribute("aria-expanded"));
  await p.click('#tree [data-id="p:demo"] > .ti > .tw'); await p.waitForTimeout(100);
  fu.reopened = await kids("p:demo");
  // Phases sit under their stage.
  await expand(p, "stages:demo");
  await p.click('#tree [data-id="st:demo:S1"] > .ti > .tw'); await p.waitForTimeout(100);
  fu.stagePhases = await kids("st:demo:S1");
  // A stage picked in the tree opens the Tasks view filtered to it, never the two-column overview.
  await tree(p, "st:demo:S1"); await p.waitForTimeout(150);
  fu.treeStage = { tasks: await p.$$eval("#task-list", n => n.length), lower: await p.$$eval("[data-part=overview-lower]", n => n.length),
    stage: await p.$eval("#f-stage", n => n.value), phase: await p.$eval("#f-phase", n => n.value),
    current: await p.$eval('#tree [data-id="st:demo:S1"] > .ti', n => n.classList.contains("current")) };
  await tree(p, "ph:demo:P2"); await p.waitForTimeout(150);
  fu.phaseRows = await p.$$eval("#task-list .row", r => r.map(x => x.dataset.id));
  fu.phaseCurrent = await p.$eval('#tree [data-id="ph:demo:P2"] > .ti', n => n.classList.contains("current"));
  // Back to all of the phase's stage: the stage it was shown under stays chosen.
  fu.phaseStage = await p.$eval("#f-stage", n => n.value);
  await p.selectOption("#f-phase", ""); await p.waitForTimeout(100);
  fu.allInStage = { stage: await p.$eval("#f-stage", n => n.value), rows: await p.$$eval("#task-list .row", r => r.map(x => x.dataset.id)) };
  await p.click(".phase[data-phase='P1']"); await p.waitForTimeout(150);
  await p.selectOption("#f-phase", ""); await p.waitForTimeout(100);
  fu.allInCardStage = { stage: await p.$eval("#f-stage", n => n.value), phases: await p.$$eval("#f-phase option", o => o.map(x => x.value)) };
  // Expand all and Collapse all.
  await p.click("#expand-all"); await p.waitForTimeout(100);
  fu.expandAll = await p.$$eval("#tree [aria-expanded]", n => n.filter(x => x.getAttribute("aria-expanded") === "false").length);
  fu.itemsExpanded = await p.$$eval("#tree [role=treeitem]", n => n.length);
  await p.click("#collapse-all"); await p.waitForTimeout(100);
  fu.itemsCollapsed = await p.$$eval("#tree [role=treeitem]", n => n.map(x => x.dataset.id));
  await p.click("#expand-all"); await p.waitForTimeout(100);
  // Stage filter: a stage keeps its own phases only.
  await tree(p, "v:demo:tasks"); await p.waitForTimeout(150);
  fu.wholeBefore = await text(p, "#whole-cards");
  await p.selectOption("#f-stage", "S1"); await p.waitForTimeout(100);
  fu.stageRows = await p.$$eval("#task-list .row", r => r.map(x => x.dataset.id));
  fu.stagePhaseOptions = await p.$$eval("#f-phase option", o => o.map(x => x.value));
  fu.wholeAfter = await text(p, "#whole-cards");
  await p.selectOption("#f-stage", ""); await p.waitForTimeout(100);
  // Layout: the list takes the whole width with nothing open; an open task gets a wide share.
  fu.listOnly = await p.evaluate(() => { const w = document.querySelector(".work"); return [w.children.length, Math.round(w.firstElementChild.getBoundingClientRect().width / w.getBoundingClientRect().width * 100)]; });
  await p.click("#task-list .row[data-id='DT202']"); await p.waitForTimeout(300);
  fu.withDetails = await p.evaluate(() => { const w = document.querySelector(".work").getBoundingClientRect().width;
    return Math.round(document.getElementById("inspector").getBoundingClientRect().width / w * 100); });
  // Prerequisites and the tasks waiting on one, each opening its own tab.
  fu.needs = await p.$$eval("#inspector .related li", n => n.map(x => x.textContent));
  fu.notesLabel = await text(p, "#inspector details > summary");
  await p.click("#inspector [data-open='DT201']"); await p.waitForTimeout(300);
  fu.openedTab = await p.$eval(".tabs [role=tab][aria-selected=true]", n => n.dataset.key);
  // A task tab holds every column, in sections.
  fu.sections = await p.$$eval(".subtabs [role=tab]", t => t.map(x => x.textContent));
  fu.details = await text(p, "#sub-panel");
  await p.focus("#sub-details"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(100);
  fu.subKey = await active(p);
  fu.briefInTab = await text(p, "#tab-brief-text");
  await p.click("#sub-related"); await p.waitForTimeout(100);
  fu.related = await text(p, "#sub-panel");
  await p.click("#sub-crossref"); await p.waitForTimeout(150);
  fu.crossref = await text(p, "#sub-panel");
  // Tab bar: sideways scroll only.
  fu.tabBar = await p.$eval(".tabs", n => [getComputedStyle(n).overflowY, n.scrollHeight <= n.clientHeight]);
  // Bubbles: on hover of a status, Esc hides it; on keyboard focus, described by it.
  await p.click("#tab-view"); await p.waitForTimeout(100);
  await p.hover("#task-list .row[data-id='DT203'] .pill"); await p.waitForTimeout(600);
  fu.hoverSoon = await p.$eval("#tip", n => n.hidden);
  await p.waitForTimeout(900);
  fu.hoverTip = await p.$eval("#tip", n => [n.hidden, n.textContent]);
  await p.keyboard.press("Escape"); await p.waitForTimeout(50);
  fu.escHides = await p.$eval("#tip", n => n.hidden);
  fu.detailsStillOpen = await p.$$eval("#inspector", n => n.length);
  // The tree shows no bubble on hover or click; the keyboard still gets one.
  await p.hover("#tree .ti[data-tip]"); await p.waitForTimeout(1500);
  fu.treeHover = await p.$eval("#tip", n => n.hidden);
  await p.click("#tree [role='treeitem'] > .ti[data-tip]"); await p.waitForTimeout(1500);
  fu.treeClick = await p.$eval("#tip", n => n.hidden);
  await p.focus("#tree [role='treeitem']:has(> .ti[data-tip])");
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowUp"); await p.waitForTimeout(100);
  fu.treeKey = await p.evaluate(() => [document.getElementById("tip").hidden, document.activeElement.getAttribute("role")]);
  await p.focus(".phase[data-phase='P1']"); await p.waitForTimeout(100);
  fu.focusTip = await p.evaluate(() => [document.getElementById("tip").hidden, document.activeElement.getAttribute("aria-describedby")]);
  await p.keyboard.press("?"); await p.waitForTimeout(100);
  fu.glossary = await p.$$eval("#glossary dt", n => n.map(x => x.textContent));
  await p.keyboard.press("Escape");
  await p.close();

  // 9. Related tasks in a tab open at the tab's own commit, after the branch has moved on.
  const rel = out.relatedRevisions = {};
  const tableAt = rows => ["# Synthetic plan", "", "## P1 Start", "", "| ID | Task | Status | Est. h | Prerequisites |", "|---|---|---|---|---|", ...rows, ""].join("\n");
  const filesAt = table => { const pr = F.progressDoc(); pr.inputs.table.blob_sha = blobSha(table);
    return { [F.FILES.table]: table, [F.FILES.progress]: JSON.stringify(pr, null, 1) }; };
  const tA = tableAt(["| XQ101 | Sketch the layout | Done | 2 | — |", "| XQ102 | Pick colours | In Progress | 3 | XQ101, XQ103 |",
                      "| XQ102.1 | Mix swatches | Not Started | 1 | — |", "| XQ103 | Gather samples | Not Started | 1 | — |"]);
  const tB = tableAt(["| XQ101 | Sketch the layout again | In Progress | 2 | — |", "| XQ102 | Pick colours | In Progress | 3 | XQ101 |"]);
  const rrepos = F.planRepos({ files: filesAt(tA) });
  const rplan = rrepos["acme/garden-plan"];
  const RA = rplan.branches.main, RB = sha("related-b");
  rplan.files[RB] = Object.assign({}, rplan.files[RA], filesAt(tB));
  const rgh = mockGitHub(rrepos);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const res = await rgh.fetch(route.request().url(), { method: route.request().method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished();
  await tree(p, "v:garden:tasks"); await p.waitForTimeout(150);
  await p.click("#task-list .row[data-id='XQ102']"); await p.waitForTimeout(300);
  await p.click("#inspector >> text=Open as tab"); await p.waitForTimeout(300);
  await p.click("#sub-related"); await p.waitForTimeout(100);
  rplan.branches.main = RB;
  await p.click("#refresh"); await finished();
  rel.related = await text(p, "#sub-panel");
  const opened = async id => { await p.click(`#sub-panel [data-open='${id}']`); await p.waitForTimeout(300);
    return { key: await p.$eval(".tabs [role=tab][aria-selected=true]", n => n.dataset.key), title: await text(p, "#tab-panel .tab-title"),
             live: await text(p, "#live") }; };
  rel.changed = await opened("XQ101");
  await p.click(`.tabs [role=tab][data-key$='|task|XQ102']`); await p.waitForTimeout(150);
  rel.deleted = await opened("XQ103");
  // Needed by and Steps open at the same commit as well (the step is gone from the newer table too).
  await p.click("#sub-related"); await p.waitForTimeout(100);
  rel.neededBy = await opened("XQ102");
  rel.step = await opened("XQ102.1");
  await p.click("#tab-view"); await p.waitForTimeout(150);
  await p.click("#task-list .row[data-id='XQ101']"); await p.waitForTimeout(300);
  await p.click("#inspector >> text=Open as tab"); await p.waitForTimeout(300);
  rel.current = { key: await p.$eval(".tabs [role=tab][aria-selected=true]", n => n.dataset.key), title: await text(p, "#tab-panel .tab-title") };
  rel.commits = [RA, RB];
  await p.close();

  // 10. A task's review cycle: brief, pull requests, handoffs against the head, checks, merge and owner decision, each apart.
  const cy = out.cycle = {};
  p = await open(); await demo(p);
  await tree(p, "v:demo:tasks"); await p.waitForTimeout(150);
  const cycleOf = async id => {
    await p.click(`#task-list .row[data-id='${id}']`); await p.waitForTimeout(300);
    await p.click("#open-cycle"); await p.waitForTimeout(500);
    const r = await p.evaluate(() => {
      const panel = document.getElementById("sub-panel");
      return { sub: document.querySelector(".subtabs [aria-selected=true]").dataset.sub,
               pulls: [...panel.querySelectorAll("[data-pull]")].map(n => n.dataset.pull),
               handoffs: [...panel.querySelectorAll(".handoff")].map(n => [n.dataset.kind, n.dataset.target, n.classList.contains("superseded")]),
               links: [...panel.querySelectorAll("[data-part=cycle-pulls] a")].map(a => [a.getAttribute("href"), a.target, a.rel]),
               buttons: [...panel.querySelectorAll("button")].map(b => b.textContent),
               brief: panel.querySelector("[data-part=cycle-brief]").textContent,
               owner: panel.querySelector("[data-part=cycle-owner]").textContent,
               text: panel.textContent };
    });
    await p.click("#tab-view"); await p.waitForTimeout(150);
    return r;
  };
  cy.complete = await cycleOf("DT101");
  cy.disputed = await cycleOf("DT103");
  cy.moved = await cycleOf("DT201");
  cy.missing = await cycleOf("DT202");
  // The section keys move through Review cycle like the others.
  await p.click(".tabs [role=tab][data-key$='|task|DT101']"); await p.waitForTimeout(150);
  await p.focus("#sub-results"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(300);
  cy.keyTo = await active(p);
  await p.close();
  // The private path: links at the pull requests' own web addresses, and only GET reads.
  const crepos = F.planRepos();
  crepos["acme/garden-plan"].pulls = [{ number: 9, title: "XQ101: sketch the layout", state: "open", merged_at: null, merge_commit_sha: null,
    head: { sha: sha("xq101-head") }, body: "Code in acme/garden#2.",
    comments: [{ body: "FROM: Reviewer\nSTATE: REVIEW PASSED\nHEAD: " + sha("xq101-head"), created_at: "2026-01-02T03:04:05Z" }] }];
  // XQ102: eleven plan pull requests name it, and the first links a code pull request, so the cap leaves out one of each.
  for (let n = 20; n <= 30; n++) {
    crepos["acme/garden-plan"].pulls.push({ number: n, title: "XQ102: part " + n, state: "open", merged_at: null, merge_commit_sha: null,
      head: { sha: sha("xq102-" + n) }, body: n === 20 ? "Code in acme/garden#2." : "", comments: [] });
  }
  crepos["acme/garden"].pulls = [{ number: 2, title: "Layout", state: "open", merged_at: null, merge_commit_sha: null, head: { sha: sha("code-head") }, body: "", comments: [] }];
  const cgh = mockGitHub(crepos);
  const creads = [], cmethods = [];
  // While holding, the plan's pull request list is answered as it is now, but only when released (as a failure if asked).
  let holding = false;
  const held = [];
  const reply = (route, status, body) => route.fulfill({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body });
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    cmethods.push(req.method());
    const m = /[/](pulls|comments)[?]/.exec(req.url());
    if (m) creads.push(m[1]);
    const res = await cgh.fetch(req.url(), { method: req.method() });
    const body = await res.text();
    if (holding && /garden-plan[/]pulls[?]/.test(req.url())) { held.push({ route, status: res.status, body }); return; }
    await reply(route, res.status, body);
  });
  const release = async fail => { for (const h of held.splice(0)) await reply(h.route, fail ? 500 : h.status, fail ? "{}" : h.body); };
  const cyclePanel = () => p.evaluate(() => { const panel = document.getElementById("sub-panel");
    return { pulls: [...panel.querySelectorAll("[data-pull]")].map(n => n.dataset.pull),
             notices: [...panel.querySelectorAll("[data-part=cycle-pulls] .notice")].map(n => [n.dataset.state, n.textContent]),
             text: panel.querySelector("[data-part=cycle-pulls]").textContent }; });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished();
  await tree(p, "v:garden:tasks"); await p.waitForTimeout(150);
  await p.click("#task-list .row[data-id='XQ101']"); await p.waitForTimeout(300);
  await p.click("#open-cycle"); await p.waitForTimeout(600);
  cy.private = await p.evaluate(() => { const panel = document.getElementById("sub-panel");
    return { links: [...panel.querySelectorAll("[data-part=cycle-pulls] a")].map(a => [a.getAttribute("href"), a.target, a.rel]),
             handoffs: [...panel.querySelectorAll(".handoff")].map(n => [n.dataset.kind, n.dataset.target, n.classList.contains("superseded")]),
             owner: panel.querySelector("[data-part=cycle-owner]").textContent }; });
  cy.private.reads = creads.slice();
  cy.private.methods = cmethods;
  await p.click("#cycle-again"); await p.waitForTimeout(600);
  cy.private.readsAfterAgain = creads.length;
  // An older Read again that answers late, with data or with a failure, never replaces the newer answer.
  cy.race = {};
  for (const fail of [false, true]) {
    crepos["acme/garden-plan"].pulls[0].title = "XQ101: old answer";
    holding = true;
    await p.click("#cycle-again"); await p.waitForTimeout(300);
    holding = false;
    crepos["acme/garden-plan"].pulls[0].title = "XQ101: new answer";
    await p.click("#cycle-again"); await p.waitForTimeout(600);
    const before = await cyclePanel();
    await release(fail); await p.waitForTimeout(600);
    cy.race[fail ? "failure" : "data"] = { held: before, after: await cyclePanel() };
  }
  // More than ten pull requests: the cap is shown, with what it left out.
  await p.click("#tab-view"); await p.waitForTimeout(150);
  await p.click("#task-list .row[data-id='XQ102']"); await p.waitForTimeout(300);
  await p.click("#open-cycle"); await p.waitForTimeout(800);
  cy.capped = await cyclePanel();
  await p.close();

  // 8. Repository overview: only mapped repositories, GitHub counts kept apart from progress, the
  // activity feed, a standalone repository, and a repository opened by name for this visit only.
  const ro = out.repos = {};
  p = await open();
  await demo(p);
  const wholePct = () => text(p, "#whole-cards .big");
  ro.pctBefore = await wholePct();
  ro.feed = await p.evaluate(() => { const f = document.querySelector("[data-part=feed]");
    return f ? { kinds: [...f.querySelectorAll(".events li")].map(n => n.dataset.kind), coverage: (f.querySelector("[data-part=feed-coverage]") || {}).textContent || "",
                 text: f.textContent } : null; });
  await tree(p, "a:portfolio"); await p.waitForTimeout(300);
  const rowsNow = () => p.$$eval(".grid-table tbody tr", n => n.map(r => [r.querySelector("[data-repo]") ? r.querySelector("[data-repo]").dataset.repo : "", r.dataset.state || "read"]));
  ro.rows = await rowsNow();
  ro.rowText = await p.$eval(".grid-table tbody", n => n.textContent);
  await p.selectOption("#r-type", "fork"); await p.waitForTimeout(150); ro.forks = await rowsNow();
  await p.selectOption("#r-type", ""); await p.selectOption("#r-lang", "Go"); await p.waitForTimeout(150); ro.go = await rowsNow();
  await p.selectOption("#r-lang", ""); await p.fill("#rq", "locked"); await p.waitForTimeout(150); ro.locked = await rowsNow();
  await p.fill("#rq", ""); await p.selectOption("#r-sort", "stars"); await p.waitForTimeout(150); ro.byStars = (await rowsNow()).map(r => r[0]);
  await p.check("#r-group"); await p.waitForTimeout(150);
  ro.groups = await p.$$eval("details.group", n => n.map(d => d.dataset.group));
  await p.uncheck("#r-group");
  await tree(p, "a:activity"); await p.waitForTimeout(600);
  ro.activity = await p.evaluate(() => ({ account: document.querySelector("[data-part=account]").textContent,
    cards: [...document.querySelectorAll(".counters .card")].map(c => c.textContent),
    charts: [...document.querySelectorAll(".chart")].map(c => c.getAttribute("aria-label")),
    missing: (document.querySelector("[data-part=bytes-missing]") || {}).textContent || "",
    notice: (document.querySelector("[data-state=activity]") || {}).textContent || "",
    bars: document.querySelectorAll(".bars li").length, dots: document.querySelectorAll(".plot .pt").length }));
  await tree(p, "v:demo:overview"); await p.waitForTimeout(300);
  ro.pctAfter = await wholePct();
  // A repository page: hostile description and homepage stay text; the standalone one has no plan progress.
  await tree(p, "repos:demo"); await p.waitForTimeout(150);
  await tree(p, "r:demo:example-org/demo-app"); await p.waitForTimeout(500);
  ro.app = await p.evaluate(() => { const m = document.querySelector("[data-part=repo-meta]");
    return { text: m.textContent, links: [...m.querySelectorAll("a")].map(a => a.getAttribute("href")), imgs: document.querySelectorAll("main img").length }; });
  await tree(p, "p:tools"); await p.waitForTimeout(500);
  ro.tools = await p.evaluate(() => ({ noPlan: (document.querySelector("[data-state=no-plan]") || {}).textContent || "",
    langs: [...document.querySelectorAll(".chart .bars li .bname")].map(n => n.textContent),
    feed: [...document.querySelectorAll("[data-part=feed] .events li")].map(n => n.dataset.kind) }));
  // Opened by name: shown and marked, kept by a refresh, gone after leaving.
  await tree(p, "a:portfolio"); await p.waitForTimeout(200);
  await p.fill("#open-repo", "example-org/unlisted"); await p.click(".open-form button"); await p.waitForTimeout(600);
  ro.opened = { head: await text(p, "#view-h"), tree: await p.$$eval("#tree [role=treeitem]", n => n.filter(x => /opened by name/.test(x.getAttribute("aria-label"))).map(x => x.dataset.id)) };
  await p.click("#refresh"); await p.waitForTimeout(1200);
  await tree(p, "a:portfolio"); await p.waitForTimeout(300);
  ro.opened.afterRefresh = (await rowsNow()).map(r => r[0]).includes("example-org/unlisted");
  ro.opened.marked = await p.$eval(".grid-table tbody", n => /opened by name/.test(n.textContent));
  await p.fill("#open-repo", "not a name"); await p.click(".open-form button"); await p.waitForTimeout(200);
  ro.opened.badName = await text(p, ".open-form + .status-line");
  await p.click("#forget"); await p.waitForTimeout(200);
  await demo(p);
  await tree(p, "a:portfolio"); await p.waitForTimeout(300);
  ro.opened.afterLeave = (await rowsNow()).map(r => r[0]).includes("example-org/unlisted");
  // Narrow screens: the page never scrolls sideways; the table scrolls in its own box.
  await p.setViewportSize({ width: 320, height: 800 }); await p.waitForTimeout(200);
  ro.narrow = { portfolio: await p.evaluate(() => document.documentElement.scrollWidth) };
  await p.click("#menu"); await tree(p, "a:activity"); await p.waitForTimeout(400);
  ro.narrow.activity = await p.evaluate(() => document.documentElement.scrollWidth);
  await p.close();
  // The private path: links at the repositories' own web addresses, an unmapped repository never read,
  // comments that the token cannot read shown as such, and only GET reads.
  const orepos = F.planRepos();
  // The same repository at two refs (mapped at main, opened by name at release), each with its own commits;
  // metadata GitHub says is none, or does not give; and commits with no readable time.
  const REL = sha("garden-release");
  const at = (seed, title, date) => ({ sha: sha(seed), commit: { message: title, committer: { date } }, parents: [{}] });
  orepos["acme/garden"].branches.release = REL;
  orepos["acme/garden"].files[REL] = {};
  orepos["acme/garden"].commitsAt = { [F.CODE_COMMIT]: [{ sha: F.CODE_COMMIT, commit: { message: "Add the layout <b>now</b>", committer: { date: "2026-01-03T00:00:00Z" } }, parents: [{}] }],
                                      [REL]: [at("rel-1", "Release notes", "2026-02-01T00:00:00Z"), at("rel-2", "Undated release fix", null)] };
  orepos["acme/garden-plan"].info = { language: null, fork: false };
  orepos["acme/recipes"].info = { private: undefined, language: "Go", fork: false };
  orepos["acme/recipes"].commits = [at("rec-1", "Undated recipe", null)];
  orepos["acme/garden"].pulls = [{ number: 2, title: "Layout", state: "open", merged_at: null, merge_commit_sha: null, head: { sha: sha("code-head") }, body: "",
                                   created_at: "2026-01-02T00:00:00Z", comments: [] }];
  orepos["acme/garden"].comments = [{ issue_url: "https://api.github.com/repos/acme/garden/issues/2", body: "FROM: B\nSTATE: REVIEW PASSED\nHEAD: " + sha("code-head"), created_at: "2026-01-04T00:00:00Z" }];
  orepos["acme/unmapped"] = { default_branch: "main", branches: { main: sha("u") }, files: { [sha("u")]: {} } };
  const ogh = mockGitHub(orepos, [[/garden-plan\/issues\/comments/, () => json({ message: "no" }, 403)]]);
  const ourls = [];
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    ourls.push(req.method() + " " + req.url());
    const res = await ogh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(600);
  ro.private = await p.evaluate(() => { const f = document.querySelector("[data-part=feed]");
    return { links: [...f.querySelectorAll(".events a")].map(a => [a.getAttribute("href"), a.target, a.rel]),
             kinds: [...f.querySelectorAll(".events li")].map(n => n.dataset.kind), coverage: (f.querySelector("[data-part=feed-coverage]") || {}).textContent || "",
             bold: f.querySelectorAll("b").length };
  });
  const feedNow = () => p.evaluate(() => { const f = document.querySelector("[data-part=feed]");
    return { titles: [...f.querySelectorAll(".events .ev-title")].map(n => n.textContent), empty: (f.querySelector("[data-part=feed-empty]") || {}).textContent || "",
             untimed: (f.querySelector("[data-part=feed-untimed]") || {}).textContent || "", head: document.getElementById("view-h").textContent }; });
  const open1 = async id => { const ex = await p.$eval(`#tree [data-id="${id}"]`, n => n.getAttribute("aria-expanded")).catch(() => null);
    if (ex === "false") { await tree(p, id); await p.waitForTimeout(100); } };
  const garden = async () => { await open1("p:garden"); await open1("repos:garden"); await tree(p, "r:garden:acme/garden"); await p.waitForTimeout(500); };
  const refs = ro.refs = {};
  await garden();
  refs.main = await feedNow();
  await tree(p, "a:portfolio"); await p.waitForTimeout(200);
  await p.fill("#open-repo", "acme/garden@release"); await p.click(".open-form button"); await p.waitForTimeout(800);
  refs.release = await feedNow();
  await garden();
  refs.mainAgain = await feedNow();
  await p.click("#refresh"); await finished(); await p.waitForTimeout(800);
  refs.mainRefreshed = await feedNow();
  await tree(p, "p:~opened-1"); await p.waitForTimeout(800);
  refs.releaseRefreshed = await feedNow();
  await tree(p, "p:recipes"); await p.waitForTimeout(800);
  ro.recipes = Object.assign(await feedNow(), { visibility: await p.$eval(".grid3 .card:nth-child(3)", n => n.textContent),
    meta: await p.$eval("[data-part=repo-meta]", n => n.textContent) });
  await tree(p, "a:portfolio"); await p.waitForTimeout(300);
  ro.privateRows = await p.$$eval(".grid-table tbody tr", n => n.map(r => [...r.querySelectorAll("th, td")].map(c => c.textContent)));
  ro.privateOptions = await p.$$eval("#r-lang option, #r-vis option, #r-type option", n => n.map(o => o.parentElement.id + ":" + o.value));
  await tree(p, "a:activity"); await p.waitForTimeout(600);
  ro.privateActivity = await p.evaluate(() => ({ cards: [...document.querySelectorAll(".counters .card")].map(c => c.textContent),
    langs: [...document.querySelectorAll(".chart[aria-label='Languages by number of repositories'] .bname")].map(n => n.textContent) }));
  ro.private.urls = ourls;
  await p.close();

  // 9. History: the read commit's history in lanes with branches compared against it and tags; zoom,
  // fit and older commits; counts from the commits read; and, on a mocked private plan, a refused
  // branch list, a tag outside the commits read and an older page that fails. Reads only.
  const hi = out.history = {};
  p = await open();
  await demo(p);
  await tree(p, "repos:demo"); await p.waitForTimeout(150);
  await tree(p, "r:demo:example-org/demo-app"); await p.waitForTimeout(400);
  await p.focus("#rs-overview"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(1500);
  const histNow = () => p.evaluate(() => ({
    rows: [...document.querySelectorAll(".hist-rows li")].map(n => [n.querySelector(".mono").textContent, n.dataset.lane, n.dataset.kind,
      [...n.querySelectorAll(".ref")].map(r => r.textContent)]),
    titles: [...document.querySelectorAll(".hist-rows .ev-title")].map(n => n.textContent), bold: document.querySelectorAll(".hist-rows b").length,
    coverage: (document.querySelector("[data-part=history-coverage]") || {}).textContent || "",
    open: (document.querySelector("[data-part=history-open]") || {}).textContent || "",
    branches: [...document.querySelectorAll("[data-part=branches] tbody tr")].map(r => [...r.children].map(c => c.textContent)),
    branchesText: (document.querySelector("[data-part=branches]") || {}).textContent || "",
    tags: [...document.querySelectorAll("[data-part=tags] li")].map(n => n.textContent),
    canvas: (() => { const c = document.querySelector(".hist-canvas"); return c ? [c.width, c.height] : null; })(),
    rowHeight: (() => { const li = document.querySelector(".hist-rows li"); return li ? li.getBoundingClientRect().height : 0; })(),
    older: !!document.getElementById("g-older"), zoomOut: (document.getElementById("g-out") || {}).disabled,
    scrollTop: (document.querySelector(".hist-graph") || {}).scrollTop || 0,
    focus: document.activeElement.id, notice: (document.querySelector("[data-state=history]") || {}).textContent || "",
    weeks: document.querySelectorAll("[aria-label='Commits per week'] li").length,
    contributors: [...document.querySelectorAll("[data-part=contributors] li")].map(n => n.textContent),
    unlinked: (document.querySelector("[data-part=unlinked]") || {}).textContent || "",
    heat: document.querySelectorAll(".heat span:not(.pad)").length,
    controls: [...document.querySelectorAll("main button")].map(b => b.textContent) }));
  hi.demo = await histNow();
  await p.click("#g-in"); await p.waitForTimeout(300);
  hi.zoomed = await histNow();
  await p.click("#g-fit"); await p.waitForTimeout(300);
  hi.fit = await histNow();
  await tree(p, "repos:second"); await p.waitForTimeout(150);
  await tree(p, "r:second:example-org/second-site"); await p.waitForTimeout(400);
  await p.click("#rs-history"); await p.waitForTimeout(1500);
  hi.paged = { first: await histNow() };
  // Scrolling to the end of the list reads the next page by itself, and the list stays where it was.
  await p.$eval(".hist-graph", b => { b.scrollTop = b.scrollHeight; }); await p.waitForTimeout(1500);
  hi.paged.second = await histNow();
  await p.setViewportSize({ width: 320, height: 800 }); await p.waitForTimeout(300);
  hi.narrow = await p.evaluate(() => document.documentElement.scrollWidth);
  await p.close();
  const hrepos = F.planRepos();
  const hrow = (i, at) => ({ sha: sha("hist-" + i), commit: { message: "Step " + i, committer: { date: at } }, parents: [{ sha: sha("hist-" + (i + 1)) }], author: { login: "agent-" + (i % 3) } });
  const full = Array.from({ length: 100 }, (_, i) => Object.assign(hrow(i, new Date(Date.UTC(2026, 0, 20) - i * 864e5).toISOString()), i ? {} : { sha: F.CODE_COMMIT }));
  hrepos["acme/garden"].history = { [F.CODE_COMMIT]: [full, 500] };
  hrepos["acme/garden"].branchList = 403;
  hrepos["acme/garden"].tagList = [{ name: "v0.1", commit: { sha: sha("far-older") } }];
  const hgh = mockGitHub(hrepos);
  const hurls = [];
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    hurls.push(req.method() + " " + req.url());
    const res = await hgh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  await garden();
  await p.click("#rs-history"); await p.waitForTimeout(1200);
  hi.private = { first: await histNow() };
  await p.focus("#g-older"); await p.keyboard.press("Enter"); await p.waitForTimeout(1200);
  hi.private.second = await histNow();
  hi.private.urls = hurls;
  await p.close();
  // Branches ahead of the read commit whose own commits fail, are refused or come back empty: each says so,
  // with GitHub's counts kept in the branch table.
  const lrepos = F.planRepos();
  const lhead = { sha: F.CODE_COMMIT, commit: { message: "Read here", committer: { date: "2026-01-20T00:00:00Z" } }, parents: [], author: null };
  lrepos["acme/garden"].history = { [F.CODE_COMMIT]: [[lhead]], [sha("dev-head")]: [500], [sha("gone-head")]: [403], [sha("empty-head")]: [[]] };
  lrepos["acme/garden"].branchList = [{ name: "main", commit: { sha: F.CODE_COMMIT }, protected: true }, { name: "dev", commit: { sha: sha("dev-head") }, protected: false },
                                      { name: "gone", commit: { sha: sha("gone-head") }, protected: false }, { name: "empty", commit: { sha: sha("empty-head") }, protected: false }];
  lrepos["acme/garden"].tagList = [];
  lrepos["acme/garden"].compare = { [sha("dev-head")]: { status: "diverged", ahead_by: 4, behind_by: 1, merge_base_commit: { sha: sha("base") } },
                                    [sha("gone-head")]: { status: "ahead", ahead_by: 2, behind_by: 0 }, [sha("empty-head")]: { status: "ahead", ahead_by: 1, behind_by: 0 } };
  const lgh = mockGitHub(lrepos);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    const res = await lgh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  await garden();
  await p.click("#rs-history"); await p.waitForTimeout(1200);
  hi.lanes = Object.assign(await histNow(), await p.evaluate(() => ({
    laneNotes: [...document.querySelectorAll("[data-part=lane-unread]")].map(n => [n.dataset.branch, n.dataset.state, n.textContent]) })));
  await p.close();

  // 11. Work evidence: pull requests with reviews at their own commit and checks at the head, issues
  // apart from pull requests, runs that have not finished never shown as passing, releases with asset
  // names only, and the inbox over the mapped repositories; then, on a mocked private run, links at the
  // repository's web address, a refused Actions list and reviews, an older page that fails, and reads only.
  const wo = out.work = {};
  p = await open();
  await demo(p);
  await tree(p, "repos:demo"); await p.waitForTimeout(150);
  await tree(p, "r:demo:example-org/demo-app"); await p.waitForTimeout(400);
  const workNow = () => p.evaluate(() => { const c = document.querySelector("[data-part^=work-]");
    const rows = sel => [...document.querySelectorAll(sel)].map(r => [...r.children].map(x => x.textContent));
    return { kind: c ? c.dataset.part : "", tabs: [...document.querySelectorAll(".subtabs [role=tab]")].map(n => n.textContent),
      selected: (document.querySelector(".subtabs [aria-selected=true]") || {}).id || "", notice: (document.querySelector("[data-state=work]") || {}).textContent || "",
      pulls: rows("tr[data-pull]"), issues: rows("tr[data-issue]"), runs: [...document.querySelectorAll("tr[data-run]")].map(r => [r.dataset.status, r.dataset.result, r.children[3].textContent]),
      releases: [...document.querySelectorAll("li[data-release]")].map(n => n.dataset.release), reviews: [...document.querySelectorAll("li[data-review]")].map(n => [n.dataset.review, n.dataset.at]),
      reviewText: (document.querySelector("[data-part=reviews]") || {}).textContent || "", checks: (document.querySelector("[data-part=pull-checks]") || {}).textContent || "",
      coverage: (document.querySelector("[data-part=work-coverage]") || {}).textContent || "", issuePulls: (document.querySelector("[data-part=issue-pulls]") || {}).textContent || "",
      runTotal: (document.querySelector("[data-part=run-total]") || {}).textContent || "", text: c ? c.textContent : "", older: !!document.getElementById("w-older"),
      links: [...document.querySelectorAll("#rs-panel a")].slice(0, 3).map(a => [a.getAttribute("href"), a.target, a.rel]),
      linkCount: document.querySelectorAll("#rs-panel a").length,
      linksSafe: [...document.querySelectorAll("#rs-panel a")].every(a => a.target === "_blank" && a.rel === "noopener noreferrer" && a.href.startsWith("https://")),
      bold: document.querySelectorAll("#rs-panel .ev-title *").length, focus: document.activeElement.id || document.activeElement.dataset.evidence || "",
      controls: [...document.querySelectorAll("#rs-panel button")].map(b => b.textContent) }; });
  await p.focus("#rs-history"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(800);
  wo.pulls = await workNow();
  await p.click('[data-evidence="2"]'); await p.waitForTimeout(800);
  wo.evidence = await workNow();
  await p.click("#wf-closed"); await p.waitForTimeout(800);
  wo.closed = await workNow();
  await p.click("#rs-issues"); await p.waitForTimeout(800);
  wo.issues = await workNow();
  await p.click("#wf-all"); await p.waitForTimeout(800);
  wo.issuesAll = await workNow();
  await p.click("#rs-runs"); await p.waitForTimeout(800);
  wo.runs = await workNow();
  await p.click("#rs-releases"); await p.waitForTimeout(800);
  wo.releases = Object.assign(await workNow(), { assets: await p.$$eval("[data-part=releases] details li", n => n.map(x => x.textContent)) });
  await tree(p, "r:demo:example-org/demo-plan"); await p.waitForTimeout(400);
  await p.click("#rs-runs"); await p.waitForTimeout(800);
  wo.planRuns = await workNow();
  await tree(p, "a:inbox"); await p.waitForTimeout(1500);
  const inboxNow = () => p.evaluate(() => ({ head: document.getElementById("view-h").textContent,
    mine: [...document.querySelectorAll("[data-part=inbox-mine] li")].map(n => n.dataset.pull),
    review: [...document.querySelectorAll("[data-part=inbox-review] li")].map(n => n.dataset.pull),
    assigned: [...document.querySelectorAll("[data-part=inbox-assigned] li")].map(n => n.dataset.issue),
    coverage: [...document.querySelectorAll("[data-part=inbox-coverage] li")].map(n => n.textContent),
    notice: (document.querySelector("[data-state=inbox]") || {}).textContent || "", text: document.getElementById("workspace").textContent }));
  wo.inbox = await inboxNow();
  await p.setViewportSize({ width: 320, height: 800 }); await p.waitForTimeout(200);
  wo.narrowInbox = await p.evaluate(() => document.documentElement.scrollWidth);
  await p.click("#menu"); await tree(p, "r:demo:example-org/demo-app"); await p.waitForTimeout(400);
  await p.click("#rs-runs"); await p.waitForTimeout(600);
  wo.narrowRuns = await p.evaluate(() => document.documentElement.scrollWidth);
  await p.close();
  const wrepos = F.planRepos();
  const OLD = sha("garden-old-head"), HEAD2 = sha("garden-pr-7");
  const wpull = (n, extra) => Object.assign({ number: n, title: "Change " + n, state: "open", draft: false, merged_at: null, merge_commit_sha: null,
    head: { sha: sha("garden-pr-" + n), ref: "topic-" + n }, base: { ref: "main" }, user: { login: "agent-" + (n % 2) }, requested_reviewers: [],
    requested_teams: [], body: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", closed_at: null }, extra);
  const page1 = Array.from({ length: 100 }, (_, i) => wpull(200 - i, i === 0 ? { title: "XQ101 layout <b>now</b>", user: { login: "synthetic-user" } }
    : i === 1 ? { number: 7, head: { sha: HEAD2, ref: "topic-7" }, requested_reviewers: [{ login: "synthetic-user" }] } : i === 2 ? { draft: true } : {}));
  wrepos["acme/garden"].work = {
    "/pulls?state=open&per_page=100&page=1": page1, "/pulls?state=open&per_page=100&page=2": 502,
    "/pulls/7/reviews?per_page=100&page=1": [{ state: "APPROVED", commit_id: OLD, user: { login: "agent-1" }, submitted_at: "2026-01-02T00:00:00Z" }],
    "/pulls/200/reviews?per_page=100&page=1": 403,
    "/actions/runs?per_page=100&page=1": 403,
    "/issues?state=open&per_page=100&page=1": [{ number: 300, title: "Assigned to you", state: "open", user: { login: "agent-1" }, labels: [],
      assignees: [{ login: "synthetic-user" }], comments: 0, created_at: "2026-01-03T00:00:00Z", closed_at: null }],
    "/releases?per_page=100&page=1": [{ id: 1, tag_name: "v1.0", name: "One", draft: false, prerelease: false, created_at: "2026-01-01T00:00:00Z",
      published_at: "2026-01-01T00:00:00Z", author: { login: "agent-1" }, assets: [{ name: "a.zip", size: 10, download_count: 1, browser_download_url: "https://example.invalid/a.zip" },
        { name: "b.zip", size: 20, download_count: 2, browser_download_url: "https://github.com/acme/garden/releases/download/v1.0/b.zip" }] }],
  };
  wrepos["acme/garden"].checks[HEAD2] = [{ name: "pending", status: "in_progress", conclusion: null }];
  // GitHub's issue list can fill a page with pull requests only; the issue is on page 2.
  wrepos["acme/garden"].work["/issues?state=all&per_page=100&page=1"] = Array.from({ length: 100 }, (_, i) => ({ number: 400 - i, title: "Pull " + i, state: "open",
    user: { login: "agent-1" }, labels: [], assignees: [], comments: 0, created_at: "2026-01-01T00:00:00Z", closed_at: null, pull_request: {} }));
  wrepos["acme/garden"].work["/issues?state=all&per_page=100&page=2"] = [{ number: 12, title: "On page two", state: "closed", state_reason: "completed",
    user: { login: "agent-1" }, labels: [], assignees: [], comments: 1, created_at: "2025-12-01T00:00:00Z", closed_at: "2025-12-02T00:00:00Z" }];
  // GitHub counts runs it does not list; and a mapped repository that cannot be read at all.
  wrepos["acme/garden-plan"].work = { "/pulls?state=open&per_page=100&page=1": 403, "/actions/runs?per_page=100&page=1": { total_count: 5, workflow_runs: [] } };
  delete wrepos["acme/recipes"];
  const wgh = mockGitHub(wrepos);
  const wurls = [];
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    wurls.push(req.method() + " " + req.url());
    const res = await wgh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  await garden();
  await p.click("#rs-pulls"); await p.waitForTimeout(1000);
  wo.private = { first: await workNow() };
  await p.click('[data-evidence="7"]'); await p.waitForTimeout(800);
  wo.private.evidence = await workNow();
  await p.click('[data-evidence="200"]'); await p.waitForTimeout(800);
  wo.private.denied = await p.$eval('tr[data-detail="200"]', n => n.textContent);
  await p.click("#w-older"); await p.waitForTimeout(1000);
  wo.private.second = await workNow();
  await p.click("#rs-runs"); await p.waitForTimeout(800);
  wo.private.runs = await workNow();
  await p.click("#rs-releases"); await p.waitForTimeout(800);
  wo.private.releases = await workNow();
  await p.click("#rs-issues"); await p.waitForTimeout(600);
  await p.click("#wf-all"); await p.waitForTimeout(800);
  wo.private.prOnly = Object.assign(await workNow(), { noneRead: await text(p, "[data-part=work-none-read]"), empty: await text(p, "[data-part=work-empty]") });
  await p.click("#w-older"); await p.waitForTimeout(800);
  wo.private.prOnlyNext = await workNow();
  await tree(p, "r:garden:acme/garden-plan"); await p.waitForTimeout(400);
  await p.click("#rs-runs"); await p.waitForTimeout(800);
  wo.private.countedRuns = Object.assign(await workNow(), { noneRead: await text(p, "[data-part=work-none-read]"), empty: await text(p, "[data-part=work-empty]") });
  await tree(p, "a:inbox"); await p.waitForTimeout(1500);
  wo.private.inbox = await inboxNow();
  wo.private.urls = wurls;
  await p.close();

  // 12. Files: the tree and a file's text at the pinned commit, every hostile line as text with hidden
  // characters shown by their code, links, submodules, large, binary and unusual paths never read as text,
  // and the changes of the commit or against another ref; then, on a mocked private run, links at the
  // repository's web address, a refused tree, a branch resolved by GitHub, and reads only.
  const co = out.code = {};
  p = await open();
  await demo(p);
  const startTitle = await p.title();
  await tree(p, "repos:demo"); await p.waitForTimeout(150);
  await tree(p, "r:demo:example-org/demo-app"); await p.waitForTimeout(400);
  const codeNow = () => p.evaluate(() => {
    const q = sel => document.querySelector(sel);
    const pre = q("[data-part=file-text]") || q("[data-part=diff-text]");
    return { tabs: [...document.querySelectorAll(".subtabs [role=tab]")].map(n => n.textContent), selected: (q(".subtabs [aria-selected=true]") || {}).id || "",
      notice: (q("[data-state=code]") || {}).textContent || "", tree: [...document.querySelectorAll("[data-part=code-tree] .fnode")].map(n => [n.dataset.path, n.getAttribute("aria-expanded"), n.getAttribute("aria-current")]),
      coverage: (q("[data-part=tree-coverage]") || {}).textContent || "", viewer: (q("[data-part=code-viewer]") || {}).textContent || "",
      treeState: (q("[data-part=code-tree] .notice") || { dataset: {} }).dataset.state || "", changeCoverage: (q("[data-part=change-coverage]") || {}).textContent || "",
      state: (q("[data-part=code-viewer] .notice, [data-part=code-changes] .notice") || {}).dataset ? q("[data-part=code-viewer] .notice, [data-part=code-changes] .notice").dataset.state : "",
      lines: pre ? [...pre.children].map(r => r.lastElementChild.textContent) : [], kinds: pre ? [...pre.children].map(r => r.dataset.kind || "") : [],
      hidden: pre ? [...pre.querySelectorAll(".hid")].map(n => n.textContent) : [], hiddenNote: (q("[data-part=hidden-chars]") || {}).textContent || "",
      preTags: pre ? [...new Set([...pre.querySelectorAll("*")].map(n => n.tagName))].sort() : [],
      active: [...document.querySelectorAll("#rs-panel img, #rs-panel iframe, #rs-panel script, #rs-panel object, #rs-panel embed, #rs-panel pre a")].length,
      meta: (q("[data-part=file-meta]") || {}).textContent || "", files: [...document.querySelectorAll("tr[data-file]")].map(r => [...r.children].map(x => x.textContent)),
      pressed: (q("[data-diff][aria-pressed=true]") || {}).textContent || "", changes: (q("[data-part=code-changes]") || {}).textContent || "",
      source: (q("[data-part=change-source]") || {}).textContent || "", status: (q("#code-status") || {}).textContent || "", against: (q("#code-against") || {}).value,
      found: [...document.querySelectorAll(".found .fnode")].map(n => n.dataset.path), focus: document.activeElement.id || document.activeElement.dataset.path || document.activeElement.dataset.diff || "",
      links: [...document.querySelectorAll("#rs-panel a")].map(a => [a.getAttribute("href"), a.target, a.rel]), title: document.title }; });
  await p.focus("#rs-releases"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(800);
  co.tree = await codeNow();
  await p.focus('[data-path="src"]'); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  co.opened = await codeNow();
  await p.click('[data-path="src/access.js"]'); await p.waitForTimeout(600);
  co.access = await codeNow();
  await p.click('[data-path="docs"]'); await p.waitForTimeout(200);
  await p.click('[data-path="docs/untrusted.html"]'); await p.waitForTimeout(600);
  co.html = await codeNow();
  await p.click('[data-path="docs/links.md"]'); await p.waitForTimeout(600);
  co.links = await codeNow();
  co.kinds = {};
  await p.click('[data-path="assets"]'); await p.click('[data-path="vendor"]'); await p.waitForTimeout(200);
  for (const path of ["docs/latest.md", "docs/Meeting notes.txt", "vendor/ui-kit", "assets/intro.mp4", "assets/data.bin"]) {
    await p.click(`[data-path="${path}"]`); await p.waitForTimeout(500);
    co.kinds[path] = await codeNow();
  }
  await p.fill("#code-q", "list"); await p.waitForTimeout(300);
  co.find = await codeNow();
  await p.click('.found [data-path="src/list.js"]'); await p.waitForTimeout(600);
  co.found = await codeNow();
  await p.fill("#code-q", ""); await p.waitForTimeout(200);
  await p.click("#cm-changes"); await p.waitForTimeout(800);
  co.changes = await codeNow();
  await p.click('[data-diff="src/access.js"]'); await p.waitForTimeout(300);
  co.diff = await codeNow();
  await p.click('[data-diff="docs/untrusted.html"]'); await p.waitForTimeout(300);
  co.diffHtml = await codeNow();
  await p.click('[data-diff="assets/data.bin"]'); await p.waitForTimeout(300);
  co.diffBin = await codeNow();
  await p.fill("#code-against", "v0.2.0"); await p.press("#code-against", "Enter"); await p.waitForTimeout(900);
  co.compare = await codeNow();
  await p.fill("#code-against", "no-such-ref"); await p.click("#code-compare"); await p.waitForTimeout(900);
  co.missing = await codeNow();
  await p.fill("#code-against", "a b"); await p.click("#code-compare"); await p.waitForTimeout(300);
  co.badRef = await codeNow();
  await p.click("#code-own"); await p.waitForTimeout(600);
  co.own = await codeNow();
  co.titleAfter = await p.title();
  co.startTitle = startTitle;
  await p.keyboard.press("Control+k"); await p.keyboard.type("demo-app files"); await p.waitForTimeout(200);
  co.goto = await p.$$eval("#goto-list li", n => n.map(x => x.textContent).slice(0, 3));
  await p.keyboard.press("Escape");
  await p.setViewportSize({ width: 320, height: 800 }); await p.waitForTimeout(200);
  co.narrowChanges = await p.evaluate(() => document.documentElement.scrollWidth);
  await p.click("#cm-files"); await p.waitForTimeout(300);
  co.narrowFiles = await p.evaluate(() => document.documentElement.scrollWidth);
  await p.close();
  const frepos = F.planRepos();
  const FC = F.CODE_COMMIT, FBASE = sha("garden-release");
  const ftext = "Visit https://example.invalid/phish and <a href=\"javascript:alert(1)\">this</a>\n";
  frepos["acme/garden"].files[FC] = { "src/main.js": ftext };
  const fblob = (path, size) => ({ path, mode: "100644", type: "blob", sha: sha(path), size });
  const freply = (body, status = 200) => json(body, status);
  const fgh = mockGitHub(frepos, [
    [new RegExp("^/repos/acme/garden/git/trees/" + FC + "\\?recursive=1$"), () => freply({ sha: sha("t"), truncated: true,
      tree: [{ path: "src", mode: "040000", type: "tree", sha: sha("src") }, fblob("src/main.js", ftext.length), fblob("deep/cut/file.txt", 3)] })],
    [new RegExp("^/repos/acme/garden-plan/git/trees/"), () => freply({ message: "no" }, 403)],
    [new RegExp("^/repos/acme/garden/commits/" + FC + "$"), () => freply({ sha: FC, commit: { message: "Merge the list", committer: { date: "2026-01-02T00:00:00Z" } },
      parents: [{ sha: FBASE }, { sha: sha("other") }], files: Array.from({ length: 300 }, (_, i) => ({ filename: "gen/f" + i + ".txt", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x" })) })],
    [new RegExp("^/repos/acme/garden/commits/release$"), () => freply({ sha: FBASE, commit: { message: "Release", committer: { date: "2026-01-01T00:00:00Z" } }, parents: [], files: [] })],
    // A reply with no list of changed files is not a change of no files.
    [new RegExp("^/repos/acme/garden/commits/nofiles$"), () => freply({ sha: sha("nofiles"), commit: { message: "Odd", committer: { date: "2026-01-01T00:00:00Z" } }, parents: [] })],
    // Three commits ahead at one commit a page: GitHub's next page lists commits, and every changed file is here.
    [new RegExp("^/repos/acme/garden/compare/" + FBASE + "\\.\\.\\." + FC + "\\?per_page=1$"), () => json({ status: "ahead", ahead_by: 3, behind_by: 0,
      merge_base_commit: { sha: FBASE }, files: [{ filename: "src/main.js", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n x\n+https://example.invalid/more" }] },
      200, { link: '<https://api.github.com/repos/acme/garden/compare/x?per_page=1&page=2>; rel="next"' })],
  ]);
  const furls = [];
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    furls.push(req.method() + " " + req.url());
    const res = await fgh.fetch(req.url(), { method: req.method() });
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "link" };
    if (res.headers.get("link")) headers.link = res.headers.get("link");
    await route.fulfill({ status: res.status, headers, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  await garden();
  await p.click("#rs-files"); await p.waitForTimeout(800);
  co.private = { tree: await codeNow() };
  await p.click('[data-path="src"]'); await p.waitForTimeout(150);
  await p.click('[data-path="src/main.js"]'); await p.waitForTimeout(700);
  co.private.file = await codeNow();
  await p.click("#cm-changes"); await p.waitForTimeout(800);
  co.private.changes = await codeNow();
  await p.fill("#code-against", "release"); await p.click("#code-compare"); await p.waitForTimeout(1000);
  co.private.compare = await codeNow();
  await p.fill("#code-against", "nofiles"); await p.click("#code-compare"); await p.waitForTimeout(900);
  co.private.noFiles = await codeNow();
  await tree(p, "r:garden:acme/garden-plan"); await p.waitForTimeout(400);
  await p.click("#rs-files"); await p.waitForTimeout(800);
  co.private.denied = await codeNow();
  co.private.urls = furls;
  await p.close();

  // Found through the token: every repository it can read and the list does not name is shown, as a
  // plan when it has a task table at the usual place, else as code only; a list that cannot be read is said.
  const found = out.found = {};
  const nrepos = F.planRepos({ workspaces: F.workspacesDoc({ found: { files: F.FILES } }) });
  const NP = sha("found-plan"), NC = sha("found-code");
  nrepos["acme/found-plan"] = { default_branch: "main", branches: { main: NP }, files: { [NP]: { [F.FILES.table]: F.TABLE } } };
  nrepos["acme/found-code"] = { default_branch: "main", branches: { main: NC }, files: { [NC]: {} } };
  nrepos["beta/found-plan"] = { default_branch: "main", branches: { main: NC }, files: { [NC]: {} } };
  let tokenRepos = () => json(["acme/garden-plan", "ACME/Garden", "acme/found-plan", "acme/found-code", "beta/found-plan"].map(full_name => ({ full_name })));
  const ngh = mockGitHub(nrepos, [[/^[/]user[/]repos[?]/, () => tokenRepos()]]);
  const nurls = [];
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    nurls.push(req.method() + " " + req.url());
    const res = await ngh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  const projectsNow = () => p.$$eval("#tree [role=treeitem][data-id^='p:']", n => n.map(x => [x.dataset.id, x.getAttribute("aria-label")]));
  found.projects = await projectsNow();
  await tree(p, "p:~found-acme/found-plan"); await p.waitForTimeout(400);
  found.planTasks = await p.$$eval("[data-part=overview-lower] li[data-task]", n => n.map(x => x.dataset.task));
  await tree(p, "p:~found-acme/found-code"); await p.waitForTimeout(500);
  found.codeNoPlan = (await p.$eval("[data-state=no-plan]", n => n.textContent).catch(() => ""));
  await tree(p, "a:portfolio"); await p.waitForTimeout(300);
  found.note = await p.$eval("[data-part=found]", n => n.textContent).catch(() => "");
  found.rows = await p.$$eval(".grid-table tbody tr", n => n.map(r => [...r.querySelectorAll("th, td")].slice(0, 2).map(c => c.textContent)));
  tokenRepos = () => json({ message: "denied" }, 403);
  await p.click("#refresh"); await finished(); await p.waitForTimeout(400);
  found.deniedProjects = (await projectsNow()).map(x => x[0]);
  await tree(p, "a:portfolio"); await p.waitForTimeout(300);
  found.denied = await p.$eval("#workspace .notice[data-state=denied]", n => n.textContent).catch(() => "");
  // A valid list that names no project: the found repositories fill it; with none found it says so.
  nrepos["acme/garden-plan"].files[F.PLAN_COMMIT]["sandboard.workspaces.json"] = JSON.stringify(F.workspacesDoc({ workspaces: [], found: { files: F.FILES } }));
  tokenRepos = () => json(["acme/found-plan", "acme/found-code"].map(full_name => ({ full_name })));
  await p.click("#refresh"); await finished(); await p.waitForTimeout(400);
  found.emptyList = (await projectsNow()).map(x => x[0]);
  found.emptyHead = await text(p, "#view-h");
  tokenRepos = () => json([]);
  await p.click("#refresh"); await finished(); await p.waitForTimeout(400);
  found.nothing = await p.$eval("#workspace .notice[data-state=empty]", n => n.textContent).catch(() => "");
  // An empty list with a token list that cannot be read says why, never that nothing was found.
  found.unread = {};
  for (const [status, headers] of [[403, {}], [500, {}], [429, { "retry-after": "60" }]]) {
    tokenRepos = () => json({ message: "no" }, status, headers);
    await p.click("#refresh"); await finished(); await p.waitForTimeout(300);
    found.unread[status] = await p.$eval("#workspace .notice", n => [n.dataset.state, n.textContent]).catch(() => null);
  }
  found.urls = nurls;
  await p.close();

  // Only the owner, or nothing, at sign-in: the one repository the token reads with the workspace list is
  // used; several, none, or a name that is neither form are said, and nothing is guessed from names.
  const discover = out.discover = {};
  const drepos = F.planRepos();
  const DP = sha("second-plan");
  drepos["beta/second-plan"] = { default_branch: "main", branches: { main: DP }, files: { [DP]: { "sandboard.workspaces.json": JSON.stringify(F.workspacesDoc()) } } };
  const NOBODY = sha("nobody-plan");
  const dUsual = ["acme/garden-plan", "acme/garden", "acme/recipes", "beta/second-plan"];
  let dTokenList = () => json(dUsual.map(full_name => ({ full_name })));
  // A held reply waits until it is released, so a refresh can come while the search is still going.
  let dHold = null;
  const dHolding = (key, re) => [re, async () => { if (dHold && dHold.key === key) await dHold.done; return null; }];
  const dRelease = () => { const h = dHold; dHold = null; if (h) h.go(); };
  const dHoldOn = key => { let go; dHold = { key, done: new Promise(r => { go = r; }), go }; };
  const dgh = mockGitHub(drepos, [dHolding("listing", /^[/]user[/]repos[?]/), [/^[/]user[/]repos[?]/, () => dTokenList()],
                                  dHolding("checking", /contents[/]sandboard[.]workspaces[.]json/),
                                  [/^[/]repos[/]acme[/]locked/, () => json({ message: "denied" }, 403)]]);
  const durls = [];
  const dErrorsBefore = out.errors.length;
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    durls.push(req.method() + " " + req.url());
    const res = await dgh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  const dSubmit = async name => { await p.fill("#plan-repo", name); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]"); };
  const dSignIn = async name => { await dSubmit(name); await finished(); await p.waitForTimeout(300); };
  const dNotice = () => p.$eval("#workspace .notice", n => [n.dataset.state, n.textContent]).catch(() => null);
  const dProjects = () => p.$$eval("#tree [role=treeitem][data-id^='p:']", n => n.map(x => x.dataset.id));
  const dForget = async () => { await p.click("#forget"); await p.waitForTimeout(200); };
  const dRefresh = async () => { await p.click("#refresh"); await finished(); await p.waitForTimeout(300); };
  await dSignIn("acme");
  discover.owner = { projects: await dProjects(), notice: await dNotice() };
  await dForget();
  await dSignIn("");
  discover.several = await dNotice();
  await dForget();
  // None found; then the owner's plan appears, and a refresh searches again and uses it.
  await dSignIn("nobody");
  discover.none = await dNotice();
  drepos["nobody/plan"] = { default_branch: "main", branches: { main: NOBODY }, files: { [NOBODY]: { "sandboard.workspaces.json": JSON.stringify(F.workspacesDoc()) } } };
  dTokenList = () => json(dUsual.concat("nobody/plan").map(full_name => ({ full_name })));
  await dRefresh();
  discover.noneThenRefresh = { projects: await dProjects(), notice: await dNotice() };
  await dForget();
  // One found, but another repository could not be checked: nothing is chosen, and the found one is named.
  dTokenList = () => json(["acme/garden-plan", "acme/locked"].map(full_name => ({ full_name })));
  await dSignIn("acme");
  discover.unchecked = { notice: await dNotice(), projects: await dProjects() };
  await dForget();
  // The token's list cannot be read (denied, then a passing failure that a refresh gets past).
  dTokenList = () => json({ message: "no" }, 403);
  await dSignIn("acme");
  discover.denied = await dNotice();
  await dForget();
  dTokenList = () => json({ message: "no" }, 500);
  await dSignIn("acme");
  discover.failed = await dNotice();
  dTokenList = () => json(dUsual.map(full_name => ({ full_name })));
  await dRefresh();
  discover.failedThenRefresh = { projects: await dProjects(), notice: await dNotice() };
  await dForget();
  // Refresh while the token's list is still being read, and while the repositories are being checked.
  for (const what of ["listing", "checking"]) {
    dHoldOn(what);
    await dSubmit("acme"); await p.waitForTimeout(300);
    await p.click("#refresh"); await p.waitForTimeout(200);
    dRelease();
    await finished(); await p.waitForTimeout(400);
    discover["refreshWhile" + what] = { projects: await dProjects(), notice: await dNotice() };
    await dForget();
  }
  await dSignIn("acme/");
  discover.bad = { state: await p.textContent("#state"), signedOut: await p.isVisible("#signed-out") };
  discover.errors = out.errors.slice(dErrorsBefore);
  discover.urls = durls;
  await p.close();

  // 6c. The round refresh on a project's overview reads only that project again: its plan and code
  // repositories at their branches now, never the workspace list, the token's list or another project.
  // While it reads, the button is off; a full Refresh during it wins, and its late answer is dropped.
  const one = out.refreshOne = {};
  const orepos1 = F.planRepos();
  const P2 = sha("garden-plan-second");
  const oUrls = [];
  let oHold = null;
  const ogh1 = mockGitHub(orepos1, [[/^[/]repos[/]acme[/]garden-plan[/]commits[/]main/, async () => { if (oHold) await oHold.done; return null; }]]);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    oUrls.push(req.method() + " " + req.url());
    const res = await ogh1.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  const oDone = async () => { await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300); };
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await oDone();
  await tree(p, "v:garden:overview"); await p.waitForTimeout(300);
  one.button = await p.$eval("#refresh-one", b => ({ label: b.getAttribute("aria-label"), glyph: b.textContent, round: getComputedStyle(b).borderRadius }));
  one.before = await p.$eval("#view-h + *, .head", n => n.textContent).catch(() => "");
  // The plan branch moves on; only the project refresh may see it.
  orepos1["acme/garden-plan"].files[P2] = orepos1["acme/garden-plan"].files[F.PLAN_COMMIT];
  orepos1["acme/garden-plan"].branches.main = P2;
  const projectsBefore = await p.$$eval("#tree [role=treeitem][data-id^='p:']", n => n.map(x => x.dataset.id));
  oUrls.length = 0;
  await p.focus("#refresh-one"); await p.keyboard.press("Enter"); await oDone();
  one.urls = oUrls.slice();
  one.after = await p.$eval(".head", n => n.textContent).catch(() => "");
  one.projects = await p.$$eval("#tree [role=treeitem][data-id^='p:']", n => n.map(x => x.dataset.id));
  one.projectsBefore = projectsBefore;
  one.focusKept = await p.evaluate(() => document.activeElement && document.activeElement.id);
  // Held: the button is off while it reads; a full Refresh then wins and the held answer changes nothing.
  let oGo; oHold = { done: new Promise(r => { oGo = r; }) };
  await p.click("#refresh-one"); await p.waitForTimeout(200);
  one.whileReading = await p.$eval("#refresh-one", b => b.getAttribute("aria-disabled")).catch(() => null);
  oHold = null;
  await p.click("#refresh"); await oDone();
  oGo(); await p.waitForTimeout(400);
  one.afterRace = { head: await p.$eval(".head", n => n.textContent).catch(() => ""), disabled: await p.$eval("#refresh-one", b => b.getAttribute("aria-disabled")).catch(() => null) };
  // A repository page has the same button, for the project the repository belongs to.
  await tree(p, "repos:garden"); await p.waitForTimeout(100);
  await tree(p, "r:garden:acme/garden"); await p.waitForTimeout(300);
  one.onRepo = await p.$eval("#refresh-one", b => b.getAttribute("aria-label")).catch(() => null);
  await p.close();

  // 7. Framed: the page refuses to show.
  p = await open();
  await p.goto(BASE + "/frame.html"); await p.waitForTimeout(400);
  const frame = p.frames()[1];
  out.framed = { state: await frame.textContent("#state"),
                 shell: await frame.evaluate(() => getComputedStyle(document.getElementById("shell")).visibility) };
  await p.close();

  // Text grows a little with the screen, from the browser's own size to an eighth more.
  out.textSize = {};
  for (const width of [390, 1280, 1920]) {
    p = await open({ viewport: { width, height: 900 } });
    out.textSize[width] = await p.evaluate(() => [getComputedStyle(document.documentElement).fontSize, getComputedStyle(document.body).fontSize]);
    await p.close();
  }

  await browser.close();
  server.close();
  process.stdout.write(JSON.stringify(out));
})().catch(e => { process.stdout.write(JSON.stringify({ crashed: String(e && e.stack || e) })); process.exit(1); });
