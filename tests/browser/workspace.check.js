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
  const tree = (page, id) => page.click(`#tree [data-id="${id}"] > .ti`);
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
  await p.click(".chips [data-stage='S1']"); await p.waitForTimeout(100);
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
  // The arrow closes and opens a project; the name never closes it.
  fu.openKids = await kids("p:demo");
  await p.click('#tree [data-id="p:demo"] > .ti > .tw'); await p.waitForTimeout(100);
  fu.closed = { expanded: await p.$eval('#tree [data-id="p:demo"]', n => n.getAttribute("aria-expanded")), kids: await kids("p:demo") };
  await p.click("#refresh"); await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent)); await p.waitForTimeout(200);
  fu.closedAfterRefresh = await p.$eval('#tree [data-id="p:demo"]', n => n.getAttribute("aria-expanded"));
  await p.click('#tree [data-id="p:demo"] > .ti > .tw'); await p.waitForTimeout(100);
  fu.reopened = await kids("p:demo");
  // Phases sit under their stage.
  await p.click('#tree [data-id="st:demo:S1"] > .ti > .tw'); await p.waitForTimeout(100);
  fu.stagePhases = await kids("st:demo:S1");
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
  fu.hoverTip = await p.$eval("#tip", n => [n.hidden, n.textContent]);
  await p.keyboard.press("Escape"); await p.waitForTimeout(50);
  fu.escHides = await p.$eval("#tip", n => n.hidden);
  fu.detailsStillOpen = await p.$$eval("#inspector", n => n.length);
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

  // 7. Framed: the page refuses to show.
  p = await open();
  await p.goto(BASE + "/frame.html"); await p.waitForTimeout(400);
  const frame = p.frames()[1];
  out.framed = { state: await frame.textContent("#state"),
                 shell: await frame.evaluate(() => getComputedStyle(document.getElementById("shell")).visibility) };
  await p.close();

  await browser.close();
  server.close();
  process.stdout.write(JSON.stringify(out));
})().catch(e => { process.stdout.write(JSON.stringify({ crashed: String(e && e.stack || e) })); process.exit(1); });
