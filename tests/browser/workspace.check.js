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
const { mockGitHub, json, sha } = require("../js/helpers");
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
  ws.workspaces[0].plan.files = Object.assign({}, F.FILES, { brief: "notes/{id}-brief.md" });
  ws.workspaces.push({ id: "locked", label: "Locked Garden", kind: "project",
                       plan: { repo: "acme/locked-plan", ref: null, files: F.FILES }, code: [] });
  return F.planRepos({ workspaces: ws, files: {
    [F.FILES.progress]: JSON.stringify(F.progressDoc({ approved_results: APPROVED }), null, 1),
    "notes/XQ101-brief.md": "Synthetic brief for XQ101.\n",
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
  for (let i = 0; i < 4; i++) await p.keyboard.press("Tab");
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

  // 6. Private path against the mocked API: links at the pinned commit, GET only, 401 clears everything.
  const priv = out.private = { methods: [], auth: [], hosts: [] };
  let revoke = false;
  let denyTable = false;
  const gh = mockGitHub(privateRepos(), [[/^[/]repos[/]acme[/]locked-plan/, () => json({ message: "denied" }, 403)],
                                         [/contents[/]plan[/]tasks[.]md/, (path, init) => denyTable ? json({ message: "denied" }, 403) : null]]);
  p = await open();
  await p.route("https://api.github.com/**", async route => {
    const req = route.request();
    priv.methods.push(req.method());
    priv.auth.push(req.headers()["authorization"] === "Bearer synthetic-token");
    const res = revoke ? json({ message: "Bad credentials" }, 401) : await gh.fetch(req.url(), { method: req.method() });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
  await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent), null, { timeout: 8000 }).catch(() => {});
  priv.tokenField = await p.inputValue("#token");
  await tree(p, "v:garden:tasks"); await p.waitForTimeout(150);
  priv.rowLinks = await p.$$eval("#task-list .row[data-id='XQ101'] a", a => a.map(x => [x.getAttribute("href"), x.target, x.rel, x.tabIndex]));
  priv.otherRowLinks = await p.$$eval("#task-list .row:not([data-id='XQ101']) a", a => a.length);
  await p.click("#task-list .row[data-id='XQ101']"); await p.waitForTimeout(300);
  priv.panelLinks = await p.$$eval("#inspector .results a", a => a.map(x => [x.getAttribute("href"), x.target, x.rel]));
  priv.panel = await text(p, "#inspector");
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
  await tree(p, "p:locked"); await p.waitForTimeout(150);
  priv.locked = await p.$$eval("#workspace .notice", n => n.map(x => x.dataset.state));
  priv.storage = await p.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length);
  revoke = true;
  await p.click("#refresh"); await p.waitForTimeout(500);
  priv.afterRevoke = await p.evaluate(() => document.body.innerText);
  priv.hosts = [...new Set(out.requests.map(r => new URL(r.split(" ")[1]).host))];
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
