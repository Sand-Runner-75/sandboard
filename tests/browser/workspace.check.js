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
    // A viewer in UTC unless a check names another zone; times are shown in the viewer's own zone.
    const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC" }, opts));
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
  for (let i = 0; i < 11; i++) await p.keyboard.press("Tab");  // stage, phase, status and doer filters, the five layouts, Save this view, then the list
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
  // Edit mode's own controls exist in the page but are never shown in the demo; no other control writes.
  prog.editHidden = await p.$$eval("#edit-open, #edit-bar", n => n.map(x => x.hidden));
  prog.writeControls = await p.$$eval("button, a", n => n.filter(x => !x.closest("#edit, #write-confirm, #edit-bar") && x.id !== "edit-open").map(x => x.textContent.trim())
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
  await p.hover("#tree [role='treeitem']:not([data-id='a:home']) > .ti[data-tip]"); await p.waitForTimeout(1500);
  fu.treeHover = await p.$eval("#tip", n => n.hidden);
  await p.click("#tree [role='treeitem']:not([data-id='a:home']) > .ti[data-tip]"); await p.waitForTimeout(1500);
  fu.treeClick = await p.$eval("#tip", n => n.hidden);
  await p.focus("#tree [role='treeitem']:not([data-id='a:home']):has(> .ti[data-tip])");
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
  // Every status mark on the page, hollow ones of closed issues included, keeps its pill's colour, in both themes.
  const badMarks = () => p.$$eval(".pill", n => n.filter(x => getComputedStyle(x, "::before").borderTopColor !== getComputedStyle(x).color).map(x => x.className + ": " + x.textContent));
  wo.marks = { count: await p.$$eval(".pill.hollow", n => n.length), light: await badMarks() };
  await p.click('[data-theme-choice="dark"]'); await p.waitForTimeout(100);
  wo.marks.dark = await badMarks();
  await p.click('[data-theme-choice="device"]'); await p.waitForTimeout(100);
  await p.click("#rs-runs"); await p.waitForTimeout(800);
  wo.runs = await workNow();
  // Actions filters: GitHub filters by workflow, result, trigger, branch, who started it and created days;
  // the search keeps runs read; Clear filters brings the whole list back.
  const runIds = () => p.$$eval("tr[data-run]", n => n.map(x => x.dataset.run));
  const pick = async (id, value) => { await p.selectOption("#" + id, value); await p.waitForTimeout(500); };
  const typeIn = async (id, value) => { await p.fill("#" + id, value); await p.press("#" + id, "Enter"); await p.waitForTimeout(500); };
  const rf = wo.runFilters = {};
  rf.workflows = await p.$$eval("#af-workflow option", n => n.map(x => x.textContent));
  rf.clearOff = await p.$eval("#af-clear", b => b.disabled);
  await pick("af-status", "failure"); rf.failure = await runIds(); rf.focus = await p.evaluate(() => document.activeElement.id);
  rf.label = await p.$eval("[data-part=work-coverage]", n => n.textContent).catch(() => "");
  await pick("af-status", ""); await pick("af-workflow", { label: "Tests" }); rf.tests = await runIds();
  await pick("af-workflow", ""); await pick("af-event", "schedule"); rf.schedule = await runIds();
  await pick("af-event", ""); await typeIn("af-branch", "feature/search"); rf.branch = await runIds();
  await typeIn("af-branch", ""); await typeIn("af-from", "2026-01-15"); rf.from = await runIds();
  await typeIn("af-to", "2026-01-14"); rf.backwards = { ids: await runIds(), note: await p.$eval("[data-part=run-filter-note]", n => n.textContent).catch(() => "") };
  await p.click("#af-clear"); await p.waitForTimeout(500);
  rf.cleared = { ids: await runIds(), off: await p.$eval("#af-clear", b => b.disabled), focus: await p.evaluate(() => document.activeElement.id) };
  await typeIn("af-actor", "not a login"); rf.badActor = { ids: await runIds(), note: await p.$eval("[data-part=run-filter-note]", n => n.textContent).catch(() => "") };
  await typeIn("af-actor", "demo-claude"); rf.actor = await runIds();
  await p.click("#af-clear"); await p.waitForTimeout(400);
  await typeIn("af-actor", "not a login"); rf.invalidOnly = await p.$eval("#af-clear", b => b.disabled);
  await p.click("#af-clear"); await p.waitForTimeout(400);
  await p.type("#af-q", "zzz"); await p.waitForTimeout(400);
  rf.miss = { ids: await runIds(), note: await p.$eval("[data-part=run-search]", n => n.textContent).catch(() => ""),
              empty: await p.$("[data-part=work-empty]") !== null, coverage: await p.$eval("[data-part=work-coverage]", n => n.textContent).catch(() => "") };
  await p.click("#af-clear"); await p.waitForTimeout(400);
  await p.type("#af-q", "night"); await p.waitForTimeout(400);
  rf.search = { ids: await runIds(), note: await p.$eval("[data-part=run-search]", n => n.textContent).catch(() => ""), focus: await p.evaluate(() => document.activeElement.id),
                value: await p.$eval("#af-q", n => n.value) };
  await p.click("#af-clear"); await p.waitForTimeout(400);
  await p.click("#rs-releases"); await p.waitForTimeout(800);
  wo.releases = Object.assign(await workNow(), { assets: await p.$$eval("[data-part=releases] details li", n => n.map(x => x.textContent)) });
  wo.marks.releases = await badMarks();
  await tree(p, "r:demo:example-org/demo-plan"); await p.waitForTimeout(400);
  await p.click("#rs-runs"); await p.waitForTimeout(800);
  wo.planRuns = await workNow();
  // The same closed pull requests for a viewer in UTC+3: each time moves to their zone and names it.
  const utcPage = p;
  p = await open({ timezoneId: "Asia/Riyadh" });
  await demo(p);
  await tree(p, "repos:demo"); await p.waitForTimeout(150);
  await tree(p, "r:demo:example-org/demo-app"); await p.waitForTimeout(400);
  await p.focus("#rs-history"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(800);
  await p.click("#wf-closed"); await p.waitForTimeout(800);
  wo.zone = Object.assign(await workNow(), { heads: await p.$$eval("#rs-panel th[scope=col]", n => n.map(x => x.textContent)),
    updated: await p.$$eval("tr[data-pull] td.num span[title]", n => n.map(x => [x.textContent, x.title])) });
  await p.context().close();
  p = utcPage;
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
  wrepos["acme/garden"].work["/actions/workflows?per_page=100&page=1"] = { total_count: 150, workflows: [{ id: 1, name: "Checks", path: ".github/workflows/checks.yml" }] };
  wrepos["acme/garden-plan"].work = { "/pulls?state=open&per_page=100&page=1": 403, "/actions/workflows?per_page=100&page=1": 403, "/actions/runs?per_page=100&page=1": { total_count: 5, workflow_runs: [] } };
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
  wo.private.runs = Object.assign(await workNow(), { flowNote: await text(p, "[data-part=run-workflow-note]") });
  await p.click("#rs-releases"); await p.waitForTimeout(800);
  wo.private.releases = await workNow();
  await p.click("#rs-issues"); await p.waitForTimeout(600);
  await p.click("#wf-all"); await p.waitForTimeout(800);
  wo.private.prOnly = Object.assign(await workNow(), { noneRead: await text(p, "[data-part=work-none-read]"), empty: await text(p, "[data-part=work-empty]") });
  await p.click("#w-older"); await p.waitForTimeout(800);
  wo.private.prOnlyNext = await workNow();
  await tree(p, "r:garden:acme/garden-plan"); await p.waitForTimeout(400);
  await p.click("#rs-runs"); await p.waitForTimeout(800);
  wo.private.countedRuns = Object.assign(await workNow(), { flowNote: await text(p, "[data-part=run-workflow-note]"), noneRead: await text(p, "[data-part=work-none-read]"), empty: await text(p, "[data-part=work-empty]") });
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
  // A found repository moved to the top keeps its place for this visit only: only the listed projects' IDs
  // are stored, and signing in again puts it back in its listed place.
  nrepos["acme/garden-plan"].files[F.PLAN_COMMIT]["sandboard.workspaces.json"] = JSON.stringify(F.workspacesDoc({ found: { files: F.FILES } }));
  tokenRepos = () => json(["acme/found-plan", "acme/found-code"].map(full_name => ({ full_name })));
  await p.click("#refresh"); await finished(); await p.waitForTimeout(400);
  for (let i = 0; i < 2; i++) { await p.focus('#tree [data-id="p:~found-acme/found-code"]'); await p.keyboard.press("Alt+ArrowUp"); await p.waitForTimeout(150); }
  found.moved = (await projectsNow()).map(x => x[0]);
  found.stored = await p.evaluate(() => Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]));
  await p.click("#forget"); await p.waitForTimeout(200);
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  found.again = (await projectsNow()).map(x => x[0]);
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
  discover.none = { notice: await dNotice(), projects: await dProjects(), state: await p.textContent("#state") };
  drepos["nobody/plan"] = { default_branch: "main", branches: { main: NOBODY }, files: { [NOBODY]: { "sandboard.workspaces.json": JSON.stringify(F.workspacesDoc()) } } };
  dTokenList = () => json(dUsual.concat("nobody/plan").map(full_name => ({ full_name })));
  await dRefresh();
  discover.noneThenRefresh = { projects: await dProjects(), notice: await dNotice(), state: await p.textContent("#state") };
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
  // A held reply answers with the commit the branch had when it was asked, so a stale answer is visible.
  const ogh1 = mockGitHub(orepos1, [[/^[/]repos[/]acme[/]garden-plan[/]commits[/]main$/, async () => {
    if (!oHold) return null;
    const asked = orepos1["acme/garden-plan"].branches.main;
    await oHold.done;
    return json({ sha: asked, commit: { committer: { date: "2026-01-02T03:04:05Z" } } });
  }]]);
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
  // Another project's reads stay: its files tree is read once, before and not again after.
  await tree(p, "p:recipes"); await p.waitForTimeout(400);
  await p.click("#rs-files"); await p.waitForTimeout(600);
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
  oUrls.length = 0;
  await tree(p, "p:recipes"); await p.waitForTimeout(300);
  await p.click("#rs-files"); await p.waitForTimeout(500);
  one.otherReadAgain = oUrls.filter(u => /acme[/]recipes/.test(u) && /git[/]trees|contents/.test(u));
  await tree(p, "v:garden:overview"); await p.waitForTimeout(300);
  // Held: the button is off while it reads. The held reply is of an older commit (P3); a full Refresh
  // then reads the newer one (P4) and wins, and releasing the held reply changes nothing.
  const P3 = sha("garden-plan-third"), P4 = sha("garden-plan-fourth");
  for (const c of [P3, P4]) orepos1["acme/garden-plan"].files[c] = orepos1["acme/garden-plan"].files[F.PLAN_COMMIT];
  orepos1["acme/garden-plan"].branches.main = P3;
  let oGo; oHold = { done: new Promise(r => { oGo = r; }) };
  await p.click("#refresh-one"); await p.waitForTimeout(300);
  one.whileReading = await p.$eval("#refresh-one", b => b.getAttribute("aria-disabled")).catch(() => null);
  oHold = null;
  orepos1["acme/garden-plan"].branches.main = P4;
  await p.click("#refresh"); await oDone();
  oGo(); await p.waitForTimeout(600);
  one.afterRace = { head: await p.$eval(".head", n => n.textContent).catch(() => ""), disabled: await p.$eval("#refresh-one", b => b.getAttribute("aria-disabled")).catch(() => null) };
  // Moving to another project while it reads: the late answer does not take the focus back.
  orepos1["acme/garden-plan"].branches.main = P3;
  oHold = { done: new Promise(r => { oGo = r; }) };
  await p.focus("#refresh-one"); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  oHold = null;
  await tree(p, "p:recipes"); await p.waitForTimeout(300);
  const focusMoved = await p.evaluate(() => document.activeElement && (document.activeElement.dataset.id || document.activeElement.id));
  oGo(); await p.waitForTimeout(600);
  one.navigated = { before: focusMoved, after: await p.evaluate(() => document.activeElement && (document.activeElement.dataset.id || document.activeElement.id)) };
  // A repository page has the same button, for the project the repository belongs to.
  await tree(p, "repos:garden"); await p.waitForTimeout(100);
  await tree(p, "r:garden:acme/garden"); await p.waitForTimeout(300);
  one.onRepo = await p.$eval("#refresh-one", b => b.getAttribute("aria-label")).catch(() => null);
  // Forget access while it reads: the late answer shows nothing.
  await tree(p, "v:garden:overview"); await p.waitForTimeout(300);
  oHold = { done: new Promise(r => { oGo = r; }) };
  await p.click("#refresh-one"); await p.waitForTimeout(300);
  oHold = null;
  await p.click("#forget"); await p.waitForTimeout(200);
  oGo(); await p.waitForTimeout(600);
  one.afterForget = await p.evaluate(() => document.body.innerText);
  await p.close();

  // 6d. The Atlas: a second main tab beside the dashboard, with the branch graph of a repository the
  // projects read. Its tabs work by keyboard; the graph draws every commit with git-flow colours, labels,
  // tags and a key; zoom, replay and a commit's files work; leaving takes it all away.
  const atl = out.atlas = {};
  p = await open();
  await demo(p);
  atl.tabs = await p.$$eval("#workspace .major [role=tab]", n => n.map(x => [x.textContent, x.getAttribute("aria-selected")]));
  atl.dashboardFirst = await p.evaluate(() => { const m = document.querySelector("#workspace .major"); return m && m.nextElementSibling && m.nextElementSibling.className; });
  await p.focus("#major-dashboard"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(300);
  atl.byKey = await p.evaluate(() => [document.activeElement.id, document.getElementById("major-atlas").getAttribute("aria-selected"), !!document.getElementById("atlas-panel")]);
  await p.waitForFunction(() => document.querySelectorAll("#ag-box .gn").length > 0, null, { timeout: 8000 }).catch(() => {});
  atl.repo = await p.$eval("#atlas-repo", n => n.value);
  atl.graph = await p.evaluate(() => ({
    dots: document.querySelectorAll("#ag-box .gn").length,
    colours: [...new Set([...document.querySelectorAll("#ag-box .gn circle")].map(c => c.getAttribute("fill")))].sort(),
    labels: [...document.querySelectorAll("#ag-box text.fl")].map(t => t.textContent).sort(),
    key: [...document.getElementById("ag-box").parentElement.querySelectorAll(".gkey tbody tr")].map(r => [...r.cells].slice(1).map(c => c.textContent)),
    summary: document.getElementById("ag-sum").textContent,
    links: [...new Set([...document.querySelectorAll("#ag-box a")].map(a => a.getAttribute("target") + " " + a.getAttribute("rel")))],
    html: [...document.querySelectorAll("#ag-box *")].some(n => n.namespaceURI !== "http://www.w3.org/2000/svg"),
  }));
  // The versions: the default branch to start with, one card each with its own graph and the pull requests into it;
  // another branch picked from the rest adds its own card.
  const versions = () => p.evaluate(() => ({
    picked: [...document.querySelectorAll("#av-pick input:checked")].map(n => n.value),
    cards: [...document.querySelectorAll("#av-panel .vcard")].map(c => [c.dataset.version, c.querySelectorAll(".atlas-graph .gn").length,
      [...c.querySelectorAll(".vpulls tbody tr")].map(r => r.dataset.pull)]),
    boxes: [...document.querySelectorAll("#av-panel .atlas-graph")].map(b => b.id),
  }));
  atl.versions = { start: await versions() };
  await p.click("#av-more summary"); await p.waitForTimeout(100);
  await p.check('#av-pick input[value="list-data"]'); await p.waitForTimeout(600);
  atl.versions.added = await versions();
  atl.versions.focus = await p.evaluate(() => document.activeElement && document.activeElement.value);
  atl.versions.ownText = await p.$eval("#av-1", n => n.textContent).catch(() => null);
  await p.check('#av-panel input[data-shared="list-data"]'); await p.waitForTimeout(600);
  atl.versions.shared = await versions();
  // Taking the first version away moves the second one up: its kept graph takes the new place's name.
  await p.uncheck('#av-pick input[value="main"]'); await p.waitForTimeout(400);
  atl.versions.moved = await versions();
  await p.check('#av-pick input[value="main"]'); await p.waitForTimeout(400);
  const width = () => p.$eval("#ag-box svg", n => parseFloat(n.style.width));
  atl.zoom = { start: await width() };
  await p.click("#ag-zin"); await p.waitForTimeout(100); atl.zoom.in = await width();
  await p.click("#ag-zreset"); await p.waitForTimeout(100); atl.zoom.reset = await width();
  await p.focus("#ag-box"); await p.keyboard.press("+"); await p.waitForTimeout(100); atl.zoom.key = await width();
  await p.keyboard.press("0"); await p.waitForTimeout(100);
  // The zoom stays when the page is drawn again for another reason.
  await p.click("#ag-zin"); await p.waitForTimeout(100);
  await p.click("#major-dashboard"); await p.waitForTimeout(200); await p.click("#major-atlas"); await p.waitForTimeout(400);
  atl.zoom.kept = await width();
  await p.click("#ag-zreset"); await p.waitForTimeout(100);
  // Replay: everything is hidden, then shown commit by commit, then all of it again.
  await p.click("#ag-replay"); await p.waitForTimeout(150);
  atl.replay = { during: await p.$eval("#ag-replay", n => [n.textContent, n.getAttribute("aria-pressed")]),
                hidden: await p.$$eval("#ag-box [data-s]", n => n.filter(x => x.style.opacity === "0").length) };
  await p.waitForFunction(() => document.getElementById("ag-replay").textContent === "Replay history", null, { timeout: 8000 }).catch(() => {});
  atl.replay.after = await p.$$eval("#ag-box [data-s]", n => n.filter(x => x.style.opacity === "0").length);
  // A commit's files show in its bubble once the pointer rests on its dot.
  const dot = (await p.$$("#ag-box .gn"))[0];
  await dot.hover(); await p.waitForTimeout(1200);
  atl.bubble = await p.evaluate(() => { const t = document.getElementById("tip"); return t.hidden ? null : t.textContent; });
  // The keyboard reaches the same details: Tab goes from the graph to its newest commit, its files are read
  // at once, and Left moves to the commit before.
  await p.mouse.move(0, 0); await p.focus("#ag-box"); await p.keyboard.press("Tab"); await p.waitForTimeout(1200);
  const focused = () => p.evaluate(() => { const n = document.activeElement; return { sha: n.getAttribute("data-sha"), s: n.getAttribute("data-s"), label: n.getAttribute("aria-label"),
    tabbable: document.querySelectorAll("#ag-box [data-sha][tabindex='0']").length, tip: document.getElementById("tip").hidden ? null : document.getElementById("tip").textContent }; });
  atl.keys = { first: await focused() };
  await p.keyboard.press("ArrowLeft"); await p.waitForTimeout(1200);
  atl.keys.left = await focused();
  // The code tree reads nothing until Play; then it plays the demo's commits, seeks, changes speed, and saves
  // the playback as a GIF and the tree as a picture; the branch graph's replay saves as a GIF too.
  const ct = atl.tree = { before: await p.evaluate(() => [!!document.getElementById("ct-start"), !!document.getElementById("ct-canvas")]) };
  await p.click("#ct-start");
  await p.waitForFunction(() => document.getElementById("ct-where") && document.getElementById("ct-where").textContent === "5/5" &&
    document.getElementById("ct-play").textContent === "Play", null, { timeout: 10000 }).catch(() => {});
  ct.sub = await p.$eval("#ct-sub", n => n.textContent).catch(() => null);
  ct.played = await p.evaluate(() => [document.getElementById("ct-where").textContent, document.getElementById("ct-play").textContent, document.getElementById("ct-canvas").getAttribute("aria-label")]);
  await p.$eval("#ct-time", n => { n.value = "2"; n.dispatchEvent(new Event("input")); }); await p.waitForTimeout(100);
  ct.seek = await p.$eval("#ct-where", n => n.textContent);
  await p.click("#ct-speed-4"); ct.speed = await p.$$eval("[id^=ct-speed-]", n => n.map(x => x.getAttribute("aria-pressed")));
  await p.focus("#ct-canvas"); await p.keyboard.press("Home"); await p.keyboard.press("Space"); await p.waitForTimeout(100);
  ct.keys = await p.evaluate(() => [document.getElementById("ct-play").getAttribute("aria-pressed"), document.getElementById("ct-where").textContent]);
  await p.keyboard.press("Space");
  // Without a pointer: the files at the playback point as a list, opened by keyboard.
  await p.focus("#ct-canvas"); await p.keyboard.press("End"); await p.waitForTimeout(150);
  await p.focus("#ct-files > summary"); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  ct.files = await p.evaluate(() => ({ head: (document.querySelector("#ct-files-body > p") || {}).textContent || "", changed: [...document.querySelectorAll("#ct-changed li")].map(n => n.textContent) }));
  await p.focus("#ct-all > summary"); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  ct.allFiles = await p.evaluate(() => [(document.querySelector("#ct-all > summary") || {}).textContent, [...document.querySelectorAll("#ct-all li")].map(n => n.textContent)]);
  await p.focus("#ct-files > summary"); await p.keyboard.press("Enter");
  // The graph GIF's frames: every picture handed to the browser is kept, to count the commit dots shown in each.
  await p.evaluate(() => { const I = window.Image; window.frames_ = [];
    window.Image = class extends I { set src(v) { if (String(v).startsWith("data:image/svg")) window.frames_.push(v); super.src = v; } get src() { return super.src; } }; });
  const saved = async (button, out) => {
    await p.click(button); await p.waitForSelector(out + " img", { timeout: 60000 }).catch(() => {});
    const info = await p.evaluate(o => { const n = document.querySelector(o); return n ? { src: (n.querySelector("img") || {}).src ? n.querySelector("img").src.slice(0, 15) : null, text: n.textContent } : null; }, out);
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 10000 }).catch(() => null), p.click(out + "-dl").catch(() => {})]);
    if (dl && info) { const file = await dl.path(); info.name = dl.suggestedFilename(); info.head = file ? fs.readFileSync(file).slice(0, 6).toString("latin1") : null; }
    return info;
  };
  ct.gif = await saved("#ct-gif", "#ct-saved");
  ct.png = await saved("#ct-png", "#ct-saved");
  ct.graphGif = await saved("#ag-gif", "#ag-saved");
  ct.graphFrames = await p.evaluate(() => {
    const dots = src => { const d = new DOMParser().parseFromString(decodeURIComponent(src.slice(src.indexOf(",") + 1)), "image/svg+xml");
      return [...d.querySelectorAll("circle")].filter(c => { for (let e = c; e && e.getAttribute; e = e.parentNode) if (e.getAttribute("opacity") === "0") return false; return true; }).length; };
    const f = window.frames_;  // the first picture sets the palette; then one per frame
    return { pictures: f.length, first: f.length > 1 ? dots(f[1]) : null, second: f.length > 2 ? dots(f[2]) : null, last: f.length ? dots(f[f.length - 1]) : null }; });
  await p.click("#ag-saved-close").catch(() => {}); await p.waitForTimeout(200);
  ct.graphClosed = await p.evaluate(() => !document.getElementById("ag-saved"));
  ct.requests = out.requests.filter(r => !/^GET /.test(r));
  // In the Atlas, a repository picked in the tree is shown there; a project's overview goes to the dashboard.
  await tree(p, "r:demo:example-org/demo-plan").catch(() => {}); await p.waitForTimeout(500);
  atl.treePick = await p.evaluate(() => [document.getElementById("major-atlas").getAttribute("aria-selected"), (document.getElementById("atlas-repo") || {}).value || null]);
  await tree(p, "v:demo:overview"); await p.waitForTimeout(300);
  atl.overview = await p.evaluate(() => [document.getElementById("major-dashboard").getAttribute("aria-selected"), !!document.getElementById("atlas-panel")]);
  // Go to reaches it, and a phone screen has no sideways page scroll.
  await p.keyboard.press("Control+k"); await p.fill("#goto-q", "branch graph"); await p.waitForTimeout(100);
  atl.goto = await p.$$eval("#goto-list [role=option]", n => n.map(x => x.textContent).slice(0, 3));
  await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  atl.gotoShown = await p.evaluate(() => !!document.getElementById("atlas-panel"));
  await p.setViewportSize({ width: 390, height: 800 }); await p.waitForTimeout(300);
  atl.phone = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await p.setViewportSize({ width: 1280, height: 900 });
  // Leaving while a graph GIF is being made: the code tree views go, and the GIF never shows up later.
  atl.viewsBefore = await p.evaluate(() => window.SB.views.atlasViews());
  await p.click("#ag-gif").catch(() => {});
  await p.click("#forget"); await p.waitForTimeout(300);
  atl.afterLeave = await p.evaluate(() => [document.querySelectorAll(".atlas-graph, .major").length, document.getElementById("workspace").textContent]);
  atl.viewsAfter = await p.evaluate(() => window.SB.views.atlasViews());
  await demo(p);
  atl.again = await p.evaluate(() => document.getElementById("major-dashboard").getAttribute("aria-selected"));
  await p.click("#major-atlas"); await p.waitForTimeout(3000);
  atl.lateGif = await p.evaluate(() => [!!document.getElementById("atlas-panel"), !!document.getElementById("ag-saved"), !!document.getElementById("ct-canvas"), window.SB.views.atlasViews()]);
  await p.close();
  // With reduced motion asked for, Play shows the finished tree still instead of playing it.
  p = await open({ reducedMotion: "reduce" });
  await demo(p);
  await p.click("#major-atlas"); await p.waitForTimeout(800);
  await p.click("#ct-start"); await p.waitForSelector("#ct-where", { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(400);
  atl.treeReduced = await p.evaluate(() => [document.getElementById("ct-where").textContent, document.getElementById("ct-play").getAttribute("aria-pressed")]);
  // The graph replay goes one commit at a time on request, and nothing moves by itself.
  const stepNow = () => p.evaluate(() => ({ hidden: [...document.querySelectorAll("#ag-box [data-s]")].filter(x => x.style.opacity === "0").length,
    step: (document.getElementById("ag-step") || {}).textContent || null, prev: (document.getElementById("ag-prev") || { getAttribute: () => "none" }).getAttribute("aria-disabled"),
    focus: document.activeElement.id, button: document.getElementById("ag-replay").textContent }));
  await p.click("#ag-replay"); await p.waitForTimeout(100);
  const rs = atl.replayReduced = { start: await stepNow() };
  await p.click("#ag-next"); await p.waitForTimeout(100);
  rs.next = await stepNow();
  await p.waitForTimeout(1200);
  rs.still = await stepNow();
  await p.keyboard.press("Enter"); await p.waitForTimeout(100);
  rs.third = await stepNow();
  await p.click("#ag-replay"); await p.waitForTimeout(100);
  rs.stopped = await stepNow();
  await p.close();
  // On a mocked private run, reads that fail are said with their error and read again on request: first the
  // only commit page, then the tags and the pull requests, which are never shown as none.
  const arepos = F.planRepos();
  const ahead = { sha: F.CODE_COMMIT, commit: { message: "Only commit", committer: { date: "2026-01-20T00:00:00Z" } }, parents: [], author: null };
  arepos["acme/garden"].history = { [F.CODE_COMMIT]: [429] };
  arepos["acme/garden"].branchList = [{ name: "main", commit: { sha: F.CODE_COMMIT }, protected: true }];
  arepos["acme/garden"].tagList = 403;
  arepos["acme/garden"].work = { "/pulls?state=all&per_page=100&page=1": 429 };
  const agh = mockGitHub(arepos);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    const res = await agh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  await garden();
  await p.click("#major-atlas"); await p.waitForTimeout(1200);
  const aNow = () => p.evaluate(() => ({ text: (document.getElementById("atlas-panel") || {}).textContent || "", dots: document.querySelectorAll("#ag-box [data-sha]").length,
    retry: !!document.getElementById("ag-retry"), failed: (document.getElementById("ag-failed") || {}).textContent || null, sum: (document.getElementById("ag-sum") || {}).textContent || null }));
  atl.fail = { first: await aNow() };
  arepos["acme/garden"].history = { [F.CODE_COMMIT]: [[ahead]] };
  await p.click("#ag-retry"); await p.waitForTimeout(1200);
  atl.fail.commits = await aNow();
  arepos["acme/garden"].tagList = [];
  delete arepos["acme/garden"].work;
  await p.click("#ag-retry"); await p.waitForTimeout(1200);
  atl.fail.all = await aNow();
  // The code tree on the same run: a commit whose files fail to read is said, with Read again for it, and
  // the playback is made anew from what Read again brings.
  arepos["acme/garden"].changes = { [F.CODE_COMMIT]: 429 };
  const tNow = () => p.evaluate(() => ({ gaps: (document.getElementById("ct-gaps") || {}).textContent || null, retry: !!document.getElementById("ct-retry"),
    sub: (document.getElementById("ct-sub") || {}).textContent || null, views: window.SB.views.atlasViews() }));
  await p.click("#ct-start"); await p.waitForSelector("#ct-sub", { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300);
  atl.fail.tree = await tNow();
  arepos["acme/garden"].changes = { [F.CODE_COMMIT]: Object.assign({}, ahead, { files: [{ filename: "src/only.js", status: "added", additions: 1, deletions: 0, changes: 1 }] }) };
  await p.click("#ct-retry"); await p.waitForFunction(() => document.getElementById("ct-sub") && !document.getElementById("ct-gaps"), null, { timeout: 8000 }).catch(() => {});
  atl.fail.treeAgain = await tNow();
  await p.close();

  // 6e. The Atlas account: nothing is read until asked; then the public profile, the activity calendar of the
  // last 91 local days, the kinds of event and the latest events. Go to reaches it, by keyboard too.
  const acc = out.account = {};
  p = await open();
  await demo(p);
  await p.click("#major-atlas"); await p.waitForTimeout(500);
  await p.focus("#atlas-part-repo"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(300);
  acc.parts = await p.evaluate(() => [document.activeElement.id, [...document.querySelectorAll(".atlas-parts button")].map(b => [b.textContent, b.getAttribute("aria-pressed")]),
    !!document.getElementById("ac-start"), !!document.getElementById("ac-profile"), !!document.getElementById("ag-box")]);
  await p.click("#ac-start");
  await p.waitForSelector("#ac-feed", { timeout: 8000 }).catch(() => {});
  acc.demo = await p.evaluate(() => ({
    name: (document.getElementById("ac-name") || {}).textContent, login: (document.querySelector("#ac-profile .ac-who > .muted") || {}).textContent,
    links: document.querySelectorAll("#ac-profile a").length, meta: (document.querySelector(".ac-meta") || {}).textContent,
    cells: document.querySelectorAll("#ac-heat rect").length, levels: [...new Set([...document.querySelectorAll("#ac-heat rect")].map(r => r.getAttribute("class")))].sort(),
    labels: [...document.querySelectorAll("#ac-heat text")].map(t => t.textContent), lastTip: document.querySelector("#ac-heat rect:last-of-type").getAttribute("data-tip"),
    busiest: (document.getElementById("ac-busiest") || {}).textContent, total: (document.getElementById("ac-total") || {}).textContent,
    days: document.querySelectorAll("#ac-days li").length, mix: [...document.querySelectorAll("#ac-mix .lbl")].map(n => n.textContent),
    feed: [...document.querySelectorAll("#ac-feed li")].map(n => n.textContent), gaps: !!document.getElementById("ac-gaps"), retry: !!document.getElementById("ac-retry") }));
  await p.focus("#ac-days > summary"); await p.keyboard.press("Enter"); await p.waitForTimeout(150);
  acc.daysOpen = await p.$eval("#ac-days", n => [n.open, n.querySelectorAll("li").length]);
  // The starred repositories and public gists only once asked for too; the starred list narrows as words
  // are typed, keeping the box's focus and saying how many are shown.
  acc.extrasBefore = await p.evaluate(() => [!!document.getElementById("ac-extras-start"), !!document.getElementById("ac-starred"), !!document.getElementById("ac-gists")]);
  await p.click("#ac-extras-start");
  await p.waitForSelector("#ac-gist-list", { timeout: 8000 }).catch(() => {});
  const starsNow = () => p.evaluate(() => ({ count: (document.getElementById("ac-star-count") || {}).textContent,
    shown: [...document.querySelectorAll("#ac-star-list > li")].filter(li => !li.hidden).map(li => li.querySelector(".ac-star-name").textContent),
    focus: document.activeElement ? document.activeElement.id : null, live: (document.getElementById("ac-star-count") || { getAttribute: () => null }).getAttribute("aria-live") }));
  acc.stars = await starsNow();
  acc.gists = await p.$$eval("#ac-gist-list > li", n => n.map(x => x.textContent));
  acc.gistHead = await p.$eval("#ac-gists .legend", n => n.textContent).catch(() => null);
  await p.focus("#ac-star-q"); await p.keyboard.type("svg"); await p.waitForTimeout(150);
  acc.starsSvg = await starsNow();
  await p.keyboard.press("Control+a"); await p.keyboard.type("JAVASCRIPT kit"); await p.waitForTimeout(150);
  acc.starsKit = await starsNow();
  await p.keyboard.press("Control+a"); await p.keyboard.type("nothing-like-this"); await p.waitForTimeout(150);
  acc.starsNone = await starsNow();
  await p.keyboard.press("Control+a"); await p.keyboard.press("Backspace"); await p.waitForTimeout(150);
  acc.starsAll = await starsNow();
  // Compare with another account: a login not in GitHub's form and your own are said by the box, which keeps
  // focus, and read nothing; another made-up account is read and put beside yours in eight rounds.
  const vsNow = () => p.evaluate(() => ({ said: (document.getElementById("ac-vs-said") || {}).textContent || null, focus: document.activeElement ? document.activeElement.id : null,
    invalid: (document.getElementById("ac-vs-q") || { getAttribute: () => null }).getAttribute("aria-invalid"),
    score: (document.getElementById("ac-vs-score") || {}).textContent || null, verdict: (document.getElementById("ac-vs-verdict") || {}).textContent || null,
    rows: [...document.querySelectorAll("#ac-vs-table tbody tr")].map(tr => [...tr.children].map(c => c.textContent)),
    heads: [...document.querySelectorAll("#ac-vs-table thead th")].map(c => c.textContent), wins: document.querySelectorAll("#ac-vs-table td.win").length,
    langs: [...document.querySelectorAll(".ac-vs-langs")].map(n => n.textContent), table: !!document.getElementById("ac-vs-table") }));
  acc.vsBefore = await vsNow();
  await p.focus("#ac-vs-q"); await p.keyboard.type("not a login!"); await p.keyboard.press("Enter"); await p.waitForTimeout(150);
  acc.vsBad = await vsNow();
  await p.fill("#ac-vs-q", "@Demo-User"); await p.keyboard.press("Enter"); await p.waitForTimeout(150);
  acc.vsSelf = await vsNow();
  await p.fill("#ac-vs-q", "sample-builder"); await p.keyboard.press("Enter");
  await p.waitForSelector("#ac-vs-table", { timeout: 8000 }).catch(() => {});
  acc.vs = await vsNow();
  await p.click("#ac-vs-clear"); await p.waitForTimeout(150);
  acc.vsCleared = await vsNow();
  await p.keyboard.press("Enter"); await p.waitForSelector("#ac-vs-table", { timeout: 8000 }).catch(() => {});
  // The README badge: offered until asked, then a picture of the public numbers in two colourings, a file
  // to download and the README line to copy.
  acc.badgeBefore = await p.evaluate(() => [!!document.getElementById("ac-badge-start"), !!document.getElementById("ac-badge-svg")]);
  await p.click("#ac-badge-start");
  await p.waitForSelector("#ac-badge-svg", { timeout: 8000 }).catch(() => {});
  const badgeNow = () => p.evaluate(() => { const s = document.getElementById("ac-badge-svg");
    return { label: s && s.getAttribute("aria-label"), role: s && s.getAttribute("role"), texts: s ? [...s.querySelectorAll("text")].map(t => t.textContent) : [],
      bg: s && s.querySelector("rect").getAttribute("fill"), squares: s ? s.querySelectorAll("rect[width='4']").length : 0,
      pressed: ["dark", "light"].map(k => document.getElementById("ac-badge-" + k).getAttribute("aria-pressed")), focus: document.activeElement.id,
      line: (document.getElementById("ac-badge-md") || {}).textContent, dl: (document.getElementById("ac-badge-dl") || {}).textContent }; });
  acc.badge = await badgeNow();
  await p.focus("#ac-badge-light"); await p.keyboard.press("Enter"); await p.waitForTimeout(150);
  acc.badgeLight = await badgeNow();
  const [badgeFile] = await Promise.all([p.waitForEvent("download", { timeout: 8000 }).catch(() => null), p.click("#ac-badge-dl")]);
  acc.badgeFile = badgeFile ? { name: badgeFile.suggestedFilename(), text: require("fs").readFileSync(await badgeFile.path(), "utf8") } : null;
  if (acc.badgeFile) acc.badgeFile = { name: acc.badgeFile.name, start: acc.badgeFile.text.slice(0, 4), script: /<script|onload|href=/i.test(acc.badgeFile.text),
    hasName: acc.badgeFile.text.includes("Demo User"), svgNs: /^<svg[^>]* xmlns="[^"]+[/]svg"/.test(acc.badgeFile.text) };
  await p.click("#ac-badge-copy"); await p.waitForTimeout(150);
  acc.badgeCopy = await p.textContent("#ac-badge-status");
  await p.setViewportSize({ width: 390, height: 800 }); await p.waitForTimeout(300);
  acc.phone = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.click("#major-dashboard"); await p.waitForTimeout(200);
  await p.keyboard.press("Control+k"); await p.fill("#goto-q", "your account"); await p.waitForTimeout(100);
  acc.goto = await p.$$eval("#goto-list [role=option]", n => n.map(x => x.textContent).slice(0, 2));
  await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  acc.gotoShown = await p.evaluate(() => [document.getElementById("major-atlas").getAttribute("aria-selected"), document.getElementById("atlas-part-account").getAttribute("aria-pressed"), !!document.getElementById("ac-feed")]);
  await p.click("#forget"); await p.waitForTimeout(300); await demo(p);
  await p.click("#major-atlas"); await p.waitForTimeout(400);
  const partNow = await p.$eval("#atlas-part-repo", n => n.getAttribute("aria-pressed"));
  await p.click("#atlas-part-account"); await p.waitForTimeout(300);
  acc.afterForget = await p.evaluate(part => [part, !!document.getElementById("ac-start"), !!document.getElementById("ac-profile")], partNow);
  await p.close();
  // On a mocked private run: no account read until asked; a failed event list is said with its error and
  // read again on request; GitHub's text is shown as text; only GET reads of the allowed paths.
  const accUrls = [];
  let eventsReply = () => json({ message: "boom" }, 500);
  const acgh = mockGitHub(F.planRepos(), [
    [/^[/]users[/]synthetic-user$/, () => json({ login: "synthetic-user", type: "User", name: "<img src=x onerror=alert(1)>", bio: "Writes <b>tests</b>", followers: 1,
      following: 0, blog: "javascript:alert(1)", created_at: "2020-01-01T00:00:00Z", html_url: "https://elsewhere.example.invalid/x" })],
    [/^[/]users[/]synthetic-user[/]events[/]public[?]/, path => eventsReply(Number(/&page=(\d+)$/.exec(path)[1]))],
    [/^[/]users[/]synthetic-user[/]starred[?]/, () => json([
      { full_name: "acme/garden", description: "<img src=x onerror=alert(2)>", language: "JavaScript", stargazers_count: 3, pushed_at: "2026-01-02T00:00:00Z", html_url: "javascript:alert(3)" },
      { full_name: "not a repository" }])],
    [/^[/]users[/]synthetic-user[/]gists[?]/, () => gistsReply()],
    [/^[/]users[/]synthetic-user[/]repos[?]/, () => json([{ full_name: "synthetic-user/garden", fork: false, stargazers_count: 2, language: "Go", pushed_at: "2026-01-02T00:00:00Z" }])],
    [/^[/]users[/]synthetic-other$/, () => otherProfile()],
    [/^[/]users[/]synthetic-other[/]events[/]public[?]/, () => json([])],
    [/^[/]users[/]synthetic-other[/]repos[?]/, path => otherRepos(Number(/&page=(\d+)$/.exec(path)[1]))]]);
  const otherRepo = i => ({ full_name: "synthetic-other/r" + i, fork: false, stargazers_count: 0, language: "Go", pushed_at: "2025-01-01T00:00:00Z" });
  let otherProfile = () => json({ message: "Not Found" }, 404);
  let otherRepos = n => n === 1 ? json(Array.from({ length: 100 }, (_, i) => otherRepo(i))) : json({ message: "boom" }, 500);
  let gistsReply = () => json({ message: "boom" }, 500);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    accUrls.push(req.method() + " " + req.url());
    const res = await acgh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  await p.click("#major-atlas"); await p.waitForTimeout(400);
  await p.click("#atlas-part-account"); await p.waitForTimeout(400);
  acc.before = accUrls.filter(u => /[/]users[/]/.test(u)).length;
  await p.click("#ac-start");
  await p.waitForSelector("#ac-retry", { timeout: 8000 }).catch(() => {});
  const accNow = () => p.evaluate(() => ({ text: (document.getElementById("ac-panel") || {}).textContent || "", retry: !!document.getElementById("ac-retry"),
    imgs: document.querySelectorAll("#ac-panel img").length, links: [...document.querySelectorAll("#ac-panel a")].map(a => a.getAttribute("href")),
    name: (document.getElementById("ac-name") || {}).textContent, cells: document.querySelectorAll("#ac-heat rect").length }));
  acc.failed = await accNow();
  // Read again: the first page now comes back full and the second fails, so what was read is shown, said as
  // partial, with Read again; then the second page comes back and the list is whole.
  const push = i => ({ type: "PushEvent", created_at: new Date(Date.now() - 3600e3 - i * 60e3).toISOString(), repo: { name: "acme/garden" }, payload: { size: 2 } });
  eventsReply = n => n === 1 ? json(Array.from({ length: 100 }, (_, i) => push(i))) : json({ message: "boom" }, 500);
  await p.click("#ac-retry"); await p.waitForSelector("#ac-feed", { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300);
  acc.later = Object.assign(await accNow(), { gaps: await p.$eval("#ac-gaps", n => n.textContent).catch(() => null) });
  eventsReply = n => n === 1 ? json(Array.from({ length: 100 }, (_, i) => push(i))) : json([push(100)]);
  await p.click("#ac-retry"); await p.waitForFunction(() => !document.getElementById("ac-retry"), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300);
  acc.again = Object.assign(await accNow(), { gaps: await p.$eval("#ac-gaps", n => n.textContent).catch(() => null) });
  acc.urls = accUrls.filter(u => /[/]users[/]/.test(u)).map(u => u.replace("https://api.github.com", ""));
  // The starred repositories and gists: a failed gist list is said and read again on request, alone.
  const urlsBefore = accUrls.length;
  await p.click("#ac-extras-start");
  await p.waitForSelector("#ac-star-list", { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300);
  const extrasNow = () => p.evaluate(() => ({ text: (document.getElementById("ac-extras") || {}).textContent || "", retry: !!document.getElementById("ac-retry"),
    imgs: document.querySelectorAll("#ac-extras img").length, links: [...document.querySelectorAll("#ac-extras a")].map(a => a.getAttribute("href")),
    gists: document.querySelectorAll("#ac-gist-list > li").length, gistFiles: [...document.querySelectorAll("#ac-gist-list > li > .muted")].map(n => n.textContent) }));
  acc.extrasFailed = await extrasNow();
  gistsReply = () => json([{ id: "abc123", description: "", comments: 0, updated_at: "2026-01-02T00:00:00Z",
    html_url: "https://gist.example.invalid/synthetic-user/abc123", files: { "a.txt": { filename: "a.txt", language: "Text", size: 3 } } },
    { id: "def456", description: "Big", comments: 0, updated_at: "2026-01-01T00:00:00Z", truncated: true,
      files: { "b.txt": { filename: "b.txt", language: "Text", size: 1 }, "c.txt": { filename: "c.txt", size: 1 } } },
    { id: "../nope", files: {} }]);
  await p.click("#ac-retry"); await p.waitForSelector("#ac-gist-list", { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300);
  acc.extrasAgain = await extrasNow();
  acc.extraUrls = accUrls.slice(urlsBefore).map(u => u.replace("https://api.github.com", ""));
  // Compare with an account GitHub does not find: said with its error and Read again, and only GET reads.
  const vsFrom = accUrls.length;
  await p.fill("#ac-vs-q", "synthetic-other"); await p.click("#ac-vs-go");
  await p.waitForFunction(() => /Cannot compare/.test((document.getElementById("ac-vs") || {}).textContent || ""), null, { timeout: 8000 }).catch(() => {});
  acc.vsFail = await p.evaluate(() => [(document.getElementById("ac-vs") || {}).textContent, !!document.getElementById("ac-retry"), !!document.getElementById("ac-vs-table")]);
  acc.vsUrls = accUrls.slice(vsFrom).map(u => u.replace("https://api.github.com", "")).sort();
  // Read again: the account is found, but the second page of its repositories still fails after a full first page.
  // The comparison shows "at least" numbers that win nothing they are not sure of, says the failed page's
  // error apart from any cap, and offers Read again; then the page comes back and the numbers are exact.
  otherProfile = () => json({ login: "synthetic-other", type: "User", followers: 0, created_at: "2024-01-01T00:00:00Z" });
  await p.click("#ac-retry"); await p.waitForSelector("#ac-vs-table", { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300);
  const vsRead = () => p.evaluate(() => ({ rows: [...document.querySelectorAll("#ac-vs-table tbody tr")].map(tr => [...tr.children].map(c => c.textContent)),
    gaps: (document.getElementById("ac-vs-gaps") || {}).textContent || null, retry: !!document.getElementById("ac-retry"), score: (document.getElementById("ac-vs-score") || {}).textContent }));
  acc.vsPartial = await vsRead();
  otherRepos = n => n === 1 ? json(Array.from({ length: 100 }, (_, i) => otherRepo(i))) : json([otherRepo(100)]);
  await p.click("#ac-retry"); await p.waitForFunction(() => !document.getElementById("ac-retry"), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300);
  acc.vsWhole = await vsRead();
  acc.methods = [...new Set(accUrls.map(u => u.split(" ")[0]))];
  await p.close();

  // The README badge on a mocked private run: a later page of the repositories and of the events fails, so the
  // picture marks those numbers + and says so itself, the page names each failure's error and count read, and
  // Read again makes them exact.
  const bUrls = [];
  let bPage2 = () => json({ message: "boom" }, 500);
  const bRepo = i => ({ full_name: "synthetic-user/r" + i, fork: false, stargazers_count: 1, language: i % 2 ? "Go" : "C", pushed_at: "2025-01-01T00:00:00Z" });
  // All 100 events fall on one local day (the last local noon and the 99 minutes before it), whatever hour the test runs.
  const bNoon = new Date(); bNoon.setHours(12, 0, 0, 0); if (bNoon > Date.now()) bNoon.setDate(bNoon.getDate() - 1);
  const bEvent = i => ({ type: "PushEvent", created_at: new Date(bNoon.getTime() - i * 60e3).toISOString(), repo: { name: "synthetic-user/r1" }, payload: { size: 1 } });
  const bgh = mockGitHub(F.planRepos(), [
    [/^[/]users[/]synthetic-user$/, () => json({ login: "synthetic-user", type: "User", followers: 1, created_at: "2020-01-01T00:00:00Z" })],
    [/^[/]users[/]synthetic-user[/]events[/]public[?]/, path => /&page=1$/.test(path) ? json(Array.from({ length: 100 }, (_, i) => bEvent(i))) : bPage2(path)],
    [/^[/]users[/]synthetic-user[/]repos[?]/, path => /&page=1$/.test(path) ? json(Array.from({ length: 100 }, (_, i) => bRepo(i))) : bPage2(path)]]);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    bUrls.push(req.method() + " " + req.url());
    const res = await bgh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await finished(); await p.waitForTimeout(400);
  await p.click("#major-atlas"); await p.waitForTimeout(400);
  await p.click("#atlas-part-account"); await p.waitForTimeout(300);
  await p.click("#ac-start"); await p.waitForSelector("#ac-feed", { timeout: 8000 }).catch(() => {});
  await p.click("#ac-badge-start"); await p.waitForSelector("#ac-badge-svg", { timeout: 8000 }).catch(() => {});
  const badgeRead = () => p.evaluate(() => { const s = document.getElementById("ac-badge-svg");
    return { label: s && s.getAttribute("aria-label"), texts: s ? [...s.querySelectorAll("text")].map(t => t.textContent) : [],
      note: (document.getElementById("ac-badge-note") || {}).textContent || null, gaps: (document.getElementById("ac-badge-gaps") || {}).textContent || null,
      retry: !!document.getElementById("ac-retry") }; });
  acc.badgePartial = await badgeRead();
  const [bFile] = await Promise.all([p.waitForEvent("download", { timeout: 8000 }).catch(() => null), p.click("#ac-badge-dl")]);
  acc.badgePartialFile = bFile ? require("fs").readFileSync(await bFile.path(), "utf8").includes("+ means at least") : null;
  bPage2 = () => json([]);
  await p.click("#ac-retry"); await p.waitForFunction(() => !document.getElementById("ac-retry"), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(300);
  acc.badgeWhole = await badgeRead();
  acc.badgeUrls = bUrls.filter(u => /[/]users[/]/.test(u)).map(u => u.replace("https://api.github.com", ""));
  acc.badgeMethods = [...new Set(bUrls.map(u => u.split(" ")[0]))];
  await p.close();

  // 13. Project order: a project dragged or moved with Alt and an arrow, the move announced, the order kept
  // in this browser only (as project IDs under one key) across a reload, and only projects can be dragged.
  const po = out.order = {};
  p = await open(); await demo(p);
  const orderNow = () => p.$$eval('#tree [data-id="g:projects"] > ul > li', n => n.map(x => x.dataset.id));
  po.start = await orderNow();
  await p.dragAndDrop(`#tree [data-id="${po.start[po.start.length - 1]}"] > .ti`, `#tree [data-id="${po.start[0]}"] > .ti`, { targetPosition: { x: 30, y: 4 } });
  await p.waitForTimeout(200);
  po.dragged = await orderNow();
  po.dragLive = await p.textContent("#live");
  po.marks = await p.$$eval("#tree .drop-before, #tree .drop-after", n => n.length);
  await p.focus(`#tree [data-id="${po.dragged[0]}"]`); await p.keyboard.press("Alt+ArrowDown"); await p.waitForTimeout(150);
  po.keyed = await orderNow();
  po.keyLive = await p.textContent("#live");
  po.focus = await p.evaluate(() => document.activeElement.dataset.id);
  await p.focus(`#tree [data-id="${po.keyed[0]}"]`); await p.keyboard.press("Alt+ArrowUp"); await p.waitForTimeout(150);
  po.atTop = await orderNow();
  po.storage = await p.evaluate(() => Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]));
  po.draggable = await p.$$eval("#tree [draggable=true]", n => n.map(x => x.parentElement.dataset.id));
  await p.reload(); await demo(p);
  po.reloaded = await orderNow();
  await p.close();

  // 7. Framed: the page refuses to show.
  p = await open();
  await p.goto(BASE + "/frame.html"); await p.waitForTimeout(400);
  const frame = p.frames()[1];
  out.framed = { state: await frame.textContent("#state"),
                 shell: await frame.evaluate(() => getComputedStyle(document.getElementById("shell")).visibility) };
  await p.close();

  // 14. Settings: density and accent change the page, are kept under one key as plain words, and come back
  // after a reload; the swatches move with the arrow keys; junk under the key counts as the default.
  p = await open();
  await demo(p);
  const look = out.look = {};
  look.before = await p.evaluate(() => [document.documentElement.dataset.density || "", document.documentElement.dataset.accent || "", localStorage.length]);
  await p.click("#settings-open"); await p.waitForTimeout(100);
  look.open = await p.evaluate(() => document.getElementById("settings").open);
  await p.click('[data-density-choice="compact"]');
  await p.focus('[data-accent-choice="blue"]'); await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight");
  look.focused = await p.evaluate(() => document.activeElement.dataset.accentChoice);
  look.checked = await p.$$eval("[data-accent-choice]", n => n.filter(b => b.getAttribute("aria-checked") === "true").map(b => b.dataset.accentChoice));
  await p.keyboard.press("Escape");
  look.after = await p.evaluate(() => [document.documentElement.dataset.density || "", document.documentElement.dataset.accent || "",
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()]);
  look.stored = await p.evaluate(() => Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]));
  await p.reload(); await p.waitForTimeout(200);
  look.reloaded = await p.evaluate(() => [document.documentElement.dataset.density || "", document.documentElement.dataset.accent || ""]);
  await p.evaluate(() => localStorage.setItem("sandboard.look", '{"density":"huge","accent":"red"}'));
  await p.reload(); await p.waitForTimeout(200);
  look.junk = await p.evaluate(() => [document.documentElement.dataset.density || "", document.documentElement.dataset.accent || ""]);
  await p.close();
  // Each pill's mark keeps its status colour: its ring is the pill's own colour, never the surface.
  p = await open();
  await demo(p);
  await p.click("#tree [data-id='p:demo'] > .ti"); await p.waitForTimeout(800);
  await p.keyboard.press("Control+k"); await p.keyboard.type("tasks"); await p.keyboard.press("Enter"); await p.waitForTimeout(1200);
  look.marks = await p.$$eval("#task-list .pill", n => [...new Set(n.map(x => x.className))].map(c => {
    const x = n.find(y => y.className === c);
    return [c, getComputedStyle(x, "::before").borderTopColor === getComputedStyle(x).color];
  }));
  await p.close();

  // 15. Home: first in the tree, counts of task rows, one row per project, open work by status, activity
  // grouped by local day; nothing from GitHub becomes markup, and no sideways page scroll on a phone.
  p = await open();
  await demo(p);
  const home = out.home = {};
  home.first = await p.$eval("#tree [role=treeitem]", n => [n.dataset.id, n.getAttribute("aria-label")]);
  await p.click("#tree [role=treeitem][data-id='a:home'] > .ti"); await p.waitForTimeout(1500);
  home.head = await text(p, "#view-h");
  home.counts = await p.$$eval(".kcell .kv", n => n.map(x => x.textContent));
  home.rows = await p.$$eval("[data-part=home-projects] tbody tr", n => n.map(x => x.dataset.project));
  home.tabs = await p.$$eval("[data-part=home-work] [role=tab]", n => n.map(x => [x.textContent, x.getAttribute("aria-selected")]));
  await p.click("[data-part=home-work] [role=tab]:has-text('Blocked')"); await p.waitForTimeout(100);
  home.blocked = await p.$$eval("[data-part=home-work] [role=tabpanel] .pill", n => n.map(x => x.textContent));
  home.days = await p.$$eval("[data-part=home-activity] .day-h", n => n.map(x => x.textContent));
  home.markup = await p.$eval("[data-part=home-activity]", n => [n.textContent.includes("<b>draft</b>"), [...n.querySelectorAll("b")].filter(b => b.textContent === "draft").length]);
  home.inline = await p.$$eval("[data-part=home-projects] [style]", n => n.map(x => x.getAttribute("style")));
  await p.setViewportSize({ width: 390, height: 900 }); await p.waitForTimeout(200);
  home.phone = await p.evaluate(() => [document.getElementById("view-h").textContent, document.documentElement.scrollWidth <= window.innerWidth]);
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.click("[data-home-project='demo']"); await p.waitForTimeout(500);
  home.opened = await text(p, "#view-h");
  await p.close();

  // 16. Task views: the same filtered rows as a board, a table, a timeline and a calendar; nothing drags;
  // a task's dates come only from the activity read that names it; picking one opens its details.
  p = await open();
  await demo(p);
  await p.click("#tree [data-id='p:demo'] > .ti"); await p.waitForTimeout(800);
  await p.keyboard.press("Control+k"); await p.keyboard.type("tasks"); await p.keyboard.press("Enter"); await p.waitForTimeout(1200);
  const tv = out.taskViews = {};
  tv.layouts = await p.$$eval(".layouts button", n => n.map(b => [b.textContent, b.getAttribute("aria-pressed")]));
  await p.click("#layout-board"); await p.waitForTimeout(300);
  tv.focus = await p.evaluate(() => document.activeElement.id);
  tv.board = await p.$$eval(".bcol", n => n.map(c => [c.querySelector(".bhead").textContent, c.querySelectorAll(".bcard").length]));
  tv.draggable = await p.$$eval("[data-part=task-board] [draggable=true]", n => n.length);
  await p.selectOption("#f-doer", "Agent A"); await p.waitForTimeout(300);
  tv.filtered = await p.$$eval(".bcard [data-task]", n => n.map(x => x.dataset.task));
  await p.selectOption("#f-doer", ""); await p.waitForTimeout(300);
  await p.click("#layout-table"); await p.waitForTimeout(300);
  tv.table = await p.$$eval("[data-part=task-table] tbody tr", n => n.length);
  await p.click("#layout-timeline"); await p.waitForTimeout(1500);
  tv.bars = await p.$$eval(".tl-bar", n => n.map(b => b.dataset.task));
  tv.barStyle = await p.$$eval("[data-part=task-timeline] [style]", n => n.every(x => /^(left|width): [0-9.]+%; ?(width: [0-9.]+%;)?$/.test(x.getAttribute("style"))));
  await p.click("#tl-months"); await p.waitForTimeout(300);
  tv.months = await p.$$eval(".tl-scale span", n => n.map(x => x.textContent));
  await p.click(".tl-bar[data-task='DT103']"); await p.waitForTimeout(500);
  tv.picked = await p.$$eval("#inspector", n => n.length);
  await p.click("#layout-calendar"); await p.waitForTimeout(500);
  tv.month = await text(p, "#cal-h");
  tv.chips = await p.$$eval(".cal-chip", n => n.length);
  // A day with more events than shown opens all of them from the keyboard, repeated tasks included.
  tv.more = await p.$$eval(".cal-more", n => n.map(b => [b.id, b.textContent, b.getAttribute("aria-expanded")]));
  await p.focus("#cal-more-2026-01-09"); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  tv.opened = [await p.$$eval("td[aria-label^='9 Jan'] .cal-chip", n => n.map(x => x.textContent)), await p.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute("aria-expanded")])];
  await p.keyboard.press("Tab"); await p.waitForTimeout(50);
  tv.afterMore = await p.evaluate(() => [document.activeElement.className, document.activeElement.dataset.task, document.activeElement.textContent, document.activeElement.closest("td").getAttribute("aria-label")]);
  await p.click("#cal-next"); await p.waitForTimeout(300);
  tv.next = [await text(p, "#cal-h"), await p.$$eval(".cal-chip", n => n.length), await p.evaluate(() => document.activeElement.id)];
  // Latest activity leaves the page, so the focus goes to the month's heading, which can hold it.
  await p.focus("#cal-latest"); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  tv.latest = [await text(p, "#cal-h"), await p.evaluate(() => [document.activeElement.id, document.activeElement.tabIndex])];
  await p.setViewportSize({ width: 390, height: 900 }); await p.waitForTimeout(200);
  tv.phone = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await p.close();

  // 17. Across projects: every project's tasks on one timeline and calendar, grouped by project and matched
  // only against each project's own repositories; members and teams are the names the tables give.
  p = await open();
  await demo(p);
  const ac = out.across = {};
  ac.group = await p.$eval("#tree [data-id='g:across']", n => [n.getAttribute("aria-label"), [...n.querySelectorAll("[role=treeitem]")].map(x => x.dataset.id)]);
  await p.click("#tree [data-id='a:timeline'] > .ti"); await p.waitForTimeout(1500);
  ac.head = await text(p, "#view-h");
  ac.groups = await p.$$eval("[data-part=all-timeline] .tl-group", n => n.map(x => [x.dataset.group, x.textContent]));
  ac.bars = await p.$$eval("[data-part=all-timeline] .tl-bar", n => n.map(b => b.dataset.task));
  ac.tlUnread = await p.$$eval("[data-part=all-timeline] p.qual", n => n.map(x => x.textContent).filter(t => /task table/.test(t)));
  ac.inline = await p.$$eval("[data-part=all-timeline] [style]", n => n.every(x => /^(left|width): [0-9.]+%; ?(width: [0-9.]+%;)?$/.test(x.getAttribute("style"))));
  await p.click(".tl-bar[data-task='demo:DT103']"); await p.waitForTimeout(800);
  ac.opened = [await text(p, "#view-h"), await p.$$eval("#inspector", n => n.length)];
  await p.click("#tree [data-id='a:calendar'] > .ti"); await p.waitForTimeout(800);
  ac.calendar = [await text(p, "#cal-h"), await p.$$eval("[data-part=all-calendar] .cal-chip", n => n.length), await p.$eval("#all-calendar", b => b.getAttribute("aria-pressed"))];
  ac.chipName = await p.$eval("[data-part=all-calendar] .cal-chip", n => [n.dataset.task, n.getAttribute("aria-label"), n.textContent]);
  await p.click("#tree [data-id='a:members'] > .ti"); await p.waitForTimeout(500);
  ac.members = await p.$$eval("[data-part=members] tbody tr", n => n.map(r => [...r.children].map(c => c.textContent)));
  ac.badge = await p.$eval("#tree [data-id='a:members']", n => n.getAttribute("aria-label"));
  await p.click("[data-part=members] [data-member='Agent B']"); await p.waitForTimeout(500);
  ac.member = [await text(p, "#view-h"), await p.$$eval("[data-part=member-counts] .kv", n => n.map(x => x.textContent)),
    await p.$$eval("[data-part=member-work] li", n => n.length), await p.$eval("#tree [data-id='a:members'] > .ti", n => n.classList.contains("current")),
    await p.$$eval("[data-part=member] > p.qual", n => n.map(x => x.textContent))];
  await p.click("#tree [data-id='a:teams'] > .ti"); await p.waitForTimeout(500);
  ac.teams = await p.$$eval("[data-team]", n => n.map(t => [t.dataset.team, [...t.querySelectorAll("[data-member]")].map(m => m.dataset.member)]));
  ac.unread = await p.$$eval("[data-part=teams] > p.qual", n => n.map(x => x.textContent));
  await p.keyboard.press("Control+k"); await p.keyboard.type("Agent A"); await p.keyboard.press("Enter"); await p.waitForTimeout(500);
  ac.goto = await text(p, "#view-h");
  await p.setViewportSize({ width: 390, height: 900 });
  for (const k of ["timeline", "members", "teams"]) {
    await p.evaluate(k => document.querySelector("#tree [data-id='a:" + k + "'] > .ti").click(), k); await p.waitForTimeout(400);
    ac["phone_" + k] = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  }
  await p.close();

  // 18. Marks and quick ways: favourites and saved views kept in this browser only, commands in
  // Go to, "g then a letter", the right-click menu from the keyboard, confirmations, and motion that only
  // runs when the place changes and never with reduced motion.
  p = await open();
  await demo(p);
  const mk = out.marks = {};
  mk.before = await p.evaluate(() => [localStorage.getItem("sandboard.marks"), document.querySelectorAll("#tree [data-id='g:favs']").length]);
  // The fade is on the area itself, so a redraw of the same place does not cut it short.
  const fading = page => page.evaluate(() => { const w = document.getElementById("workspace"); return [w.classList.contains("arrive"), getComputedStyle(w).animationName]; });
  await p.click("#tree [data-id='p:demo'] > .ti"); await p.waitForTimeout(300);
  mk.arrive = await fading(p);
  await p.click("#fav-project"); await p.waitForTimeout(200);
  mk.star = [await p.$eval("#fav-project", b => [b.getAttribute("aria-pressed"), b.getAttribute("aria-label")]), await p.evaluate(() => document.activeElement.id),
    await text(p, "#toast"), await text(p, "#live"), await p.$$eval("#tree [data-id='g:favs'] [role=treeitem]", n => n.map(x => x.dataset.id))];
  await p.keyboard.press("Control+k"); await p.keyboard.type("tasks as board"); await p.keyboard.press("Enter"); await p.waitForTimeout(600);
  mk.command = [await p.$eval("#layout-board", b => b.getAttribute("aria-pressed")), await p.evaluate(() => document.activeElement.id)];
  await p.selectOption("#f-status", "In Progress"); await p.waitForTimeout(200);
  await p.selectOption("#f-doer", { index: 1 }); await p.waitForTimeout(200);
  await p.click("#save-view"); await p.waitForTimeout(100);
  mk.naming = [await p.evaluate(() => document.activeElement.id), await text(p, "#view-note")];
  await p.keyboard.type("Doing <b>now</b>"); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  mk.saved = [await p.evaluate(() => JSON.parse(localStorage.getItem("sandboard.marks"))), await p.evaluate(() => document.activeElement.id),
    await p.$$eval("[data-part=saved-views] [data-view]", n => n.map(x => x.textContent)), await p.$$eval("[data-part=saved-views] b", n => n.length)];
  // The right-click menu from the keyboard on a board card: open, star, nothing else without a GitHub address.
  await p.focus(".bcard .linkbtn"); await p.keyboard.press("Shift+F10"); await p.waitForTimeout(100);
  mk.menu = [await p.$$eval("#ctx [role=menuitem]", n => n.map(x => x.textContent)), await p.evaluate(() => document.activeElement.getAttribute("role"))];
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  mk.starred = [await p.evaluate(() => JSON.parse(localStorage.getItem("sandboard.marks")).favs), await p.$eval("#ctx", n => n.hidden)];
  await p.focus(".bcard .linkbtn"); await p.keyboard.press("Shift+F10"); await p.waitForTimeout(100); await p.keyboard.press("Escape"); await p.waitForTimeout(100);
  mk.escaped = [await p.$eval("#ctx", n => n.hidden), await p.evaluate(() => document.activeElement.classList.contains("linkbtn")), await p.$eval("#ctx", n => n.getAttribute("aria-label"))];
  // Ending the session with the menu and a confirmation still showing (as when access is lost, with no
  // pointer press first) leaves neither, and moving to another place closes an open menu.
  await p.focus(".bcard .linkbtn"); await p.keyboard.press("Shift+F10"); await p.waitForTimeout(100);
  await p.evaluate(() => document.getElementById("refresh").click()); await p.waitForTimeout(100);
  mk.refreshed = await p.$eval("#ctx", n => n.hidden);
  await p.waitForTimeout(800);
  // Closing a menu that is already hidden still clears any project name left on it.
  await p.evaluate(() => document.getElementById("ctx").setAttribute("aria-label", "Actions for a stale name"));
  await p.evaluate(() => document.getElementById("refresh").click()); await p.waitForTimeout(800);
  mk.hiddenClosed = await p.$eval("#ctx", n => [n.hidden, n.getAttribute("aria-label")]);
  await p.focus(".bcard .linkbtn"); await p.keyboard.press("Shift+F10"); await p.waitForTimeout(100);
  mk.openName = await p.$eval("#ctx", n => n.getAttribute("aria-label").startsWith("Actions for "));
  await p.evaluate(() => document.getElementById("forget").click()); await p.waitForTimeout(100);
  mk.ended = await p.evaluate(() => [document.getElementById("ctx").hidden, document.getElementById("ctx").children.length, document.getElementById("toast").hidden, document.getElementById("toast").textContent, document.getElementById("ctx").getAttribute("aria-label")]);
  // A fresh visit on the same browser: the marks come back; the saved view opens its filters and layout.
  await p.evaluate(() => { document.getElementById("live").textContent = ""; });
  await demo(p);
  await p.waitForSelector("#tree [data-id='p:demo']");
  mk.back = await p.$$eval("#tree [data-id='g:favs'] [role=treeitem]", n => n.map(x => x.dataset.id));
  await p.click("#tree [data-id='p:demo'] > .ti > .tw"); await p.waitForTimeout(200);
  await p.click("#tree [data-id='sv:demo'] > .ti > .tw"); await p.waitForTimeout(200);
  await p.click("#tree [data-id='sv:demo:Doing <b>now</b>'] > .ti"); await p.waitForTimeout(600);
  mk.opened = [await p.$eval("#f-status", s => s.value), await p.$eval("#layout-board", b => b.getAttribute("aria-pressed"))];
  await p.click("[data-part=saved-views] .sv-x"); await p.waitForTimeout(200);
  mk.dropped = await p.evaluate(() => JSON.parse(localStorage.getItem("sandboard.marks")).views.length);
  // "g then a letter", never while typing.
  await p.focus("#q"); await p.keyboard.press("g"); await p.keyboard.press("m"); await p.waitForTimeout(200);
  mk.typing = await p.$eval("#q", n => n.value);
  await p.focus("#main"); await p.keyboard.press("g"); await p.keyboard.press("m"); await p.waitForTimeout(400);
  mk.gm = await text(p, "#view-h");
  await p.keyboard.press("g"); await p.keyboard.press("d"); await p.waitForTimeout(200);
  mk.gd = await p.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await p.keyboard.press("g"); await p.keyboard.press("h"); await p.waitForTimeout(1200);
  mk.home = await p.$$eval("[data-part=home-counts] .kv", n => n.map(x => x.textContent));
  await p.close();
  p = await open({ reducedMotion: "reduce" });
  await demo(p);
  await p.click("#tree [data-id='a:home'] > .ti");
  mk.still = [await fading(p), await p.$$eval("[data-part=home-counts] .kv", n => n.map(x => x.textContent))];
  await p.close();

  // Edit mode: a separate write token, checked with GitHub by GET only, a constant marker while it is held,
  // and dropped by Leave Edit mode, Forget access and a refused token. Nothing but GET is ever sent here.
  const ed = out.edit = { auth: [] };
  let refuseWrite = false;
  const egh = mockGitHub(privateRepos(), [[/^[/]repos[/]acme[/]locked-plan/, () => json({ message: "denied" }, 403)]]);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    const auth = req.headers()["authorization"];
    if (auth === "Bearer synthetic-write") ed.auth.push(req.method() + " " + req.url().slice("https://api.github.com".length));
    const res = refuseWrite && auth === "Bearer synthetic-write" ? json({ message: "Bad credentials" }, 401) : await egh.fetch(req.url(), { method: req.method() });
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "github-authentication-token-expiration" };
    if (req.url().endsWith("/user") && auth === "Bearer synthetic-write") headers["github-authentication-token-expiration"] = "2026-12-01 00:00:00 UTC";
    await route.fulfill({ status: res.status, headers, body: await res.text() });
  });
  const editOn = async () => {
    await p.click("#edit-open");
    await p.fill("#write-token", "synthetic-write");
    await p.click("#edit-form button[type=submit]");
    await p.waitForFunction(() => !document.getElementById("edit").open, null, { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(150);
  };
  const editSeen = () => p.evaluate(() => ({ bar: document.getElementById("edit-bar").hidden ? null : document.getElementById("edit-bar").textContent,
    button: !document.getElementById("edit-open").hidden, mode: document.getElementById("mode").textContent,
    result: document.getElementById("write-result").hidden ? null : document.getElementById("write-result").textContent,
    field: document.getElementById("write-token").value, dialog: document.getElementById("edit").open }));
  ed.signedOutButton = await p.$eval("#edit-open", n => !n.hidden);
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent), null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(300);
  ed.before = await editSeen();
  await p.click("#edit-open");
  ed.owners = await p.$$eval("#edit-owner option", o => o.map(x => x.value));
  ed.fieldType = await p.$eval("#write-token", n => n.type);
  await p.click("#edit-cancel");
  await editOn();
  ed.on = await editSeen();
  await p.click("#refresh");
  await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent), null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(300);
  ed.afterRefresh = await editSeen();
  await p.click("#edit-leave"); await p.waitForTimeout(100);
  ed.left = await editSeen();
  await editOn();
  await p.click("#forget"); await p.waitForTimeout(100);
  ed.forgot = await editSeen();
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent), null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(300);
  refuseWrite = true;
  await editOn();
  ed.refused = await editSeen();
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
