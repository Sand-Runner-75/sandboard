"use strict";
// Checks a published copy of the site at its own address (docs/RELEASE.md,
// "After publishing"). It runs in a real Chromium against that origin, but every
// GitHub API request is answered by the synthetic mock through Playwright's
// request interception, so no real token or project data is involved.
// tests/test_browser.py runs it against a local copy on every pull request.
// It prints one JSON object of named checks, never the site's address, and
// exits 1 when any check fails.
// Usage: node live.check.js <playwright module> <site URL> <built site folder>
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require(process.argv[2]);
// GitHub's deploy step may give the address without its final slash.
const SITE = /\/$/.test(process.argv[3] || "") ? process.argv[3] : (process.argv[3] || "") + "/";
const DIST = path.resolve(process.argv[4]);
const { mockGitHub, json } = require("../js/helpers");
const F = require("../js/fixtures");

// Text that only the synthetic private project shows; none of it may survive access loss.
const PRIVATE = ["Example Garden", "Sample Recipe", "acme", "XQ1", "%", "Task "];
const API = "https://api.github.com";
// Other sites, answered here; the framing one shares the site's scheme so the frame is not mixed content.
const FRAMER = (/^http:/.test(SITE || "") ? "http" : "https") + "://framer.invalid/", ELSEWHERE = "https://elsewhere.invalid/";

(async () => {
  if (!/^https?:\/\/[^/?#]+\/([^?#]*\/)?$/.test(SITE)) throw new Error("the site URL must be an http(s) address with no query or fragment");
  const origin = new URL(SITE).origin;
  const checks = [];
  const check = (name, pass, detail) => checks.push(detail === undefined ? { name, pass: !!pass } : { name, pass: !!pass, detail });
  // A local copy (as in tests/test_browser.py) is a private address, which Chromium will not frame
  // from another site; the published site is public and needs no such switch.
  const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(SITE);
  const browser = await chromium.launch(local ? { args: ["--disable-features=LocalNetworkAccessChecks"] } : {});
  const errors = [], others = new Set(), methods = new Set();
  let revoke = false;
  const gh = mockGitHub(F.planRepos());

  async function open(context) {
    context = context || await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === origin) return route.continue();
      if (req.url() === FRAMER) return route.fulfill({ contentType: "text/html", body: `<iframe src="${SITE}" width="600" height="400"></iframe>` });
      if (req.url() === ELSEWHERE) return route.fulfill({ contentType: "text/html", body: "<p>another site</p>" });
      if (url.origin !== API) { others.add(url.host); return route.abort(); }
      methods.add(req.method());
      const res = revoke ? json({ message: "Bad credentials" }, 401) : await gh.fetch(req.url(), { method: req.method() });
      await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
    });
    const page = await context.newPage();
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("dialog", d => { errors.push("dialog"); d.dismiss(); });
    await page.goto(SITE);
    return page;
  }
  const finished = async p => { await p.waitForFunction(() => /Reading finished/.test(document.getElementById("live").textContent), null, { timeout: 10000 }).catch(() => {}); await p.waitForTimeout(300); };
  const body = p => p.evaluate(() => document.body.innerText);
  let connects = 0, opened = 0;
  const connect = async p => {
    await p.fill("#plan-repo", "acme/garden-plan"); await p.fill("#token", "synthetic-token"); await p.click("#connect button[type=submit]");
    await finished(p);
    connects += 1; if ((await body(p)).includes("Example Garden")) opened += 1;
  };
  const signedOut = async (p, name) => {
    const text = await body(p);
    const left = PRIVATE.filter(m => text.includes(m));
    check(name, left.length === 0 && text.includes("Nothing loaded.") && await p.inputValue("#token") === "", left.length ? "left: " + left.join(", ") : undefined);
  };
  const expand = async (p, id) => { const n = await p.$(`#tree [data-id="${id}"][aria-expanded="false"] > .ti > .tw`); if (n) { await n.click(); await p.waitForTimeout(50); } };
  const tabs = p => p.$$eval(".tabs [role=tab]", t => t.map(x => x.textContent));

  // 1. The served files are exactly this build, byte for byte. A query the site ignores keeps a
  // copy cached by GitHub's servers from before the deploy out of the comparison.
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "build-manifest.json"), "utf8"));
  const request = (await browser.newContext()).request;
  const differ = [];
  for (const name of Object.keys(manifest).concat("build-manifest.json")) {
    const res = await request.get(SITE + name + "?fresh=" + crypto.randomUUID(), { headers: { "cache-control": "no-cache" } });
    const local = fs.readFileSync(path.join(DIST, name));
    const served = res.ok() ? await res.body() : null;
    if (!served || !served.equals(local)) differ.push(name);
    if (name in manifest && served && crypto.createHash("sha256").update(served).digest("hex") !== manifest[name]) differ.push(name + " (hash)");
  }
  check("served files equal the reviewed build", differ.length === 0, differ.length ? differ.join(", ") : undefined);

  // 2. First visit is signed out and loads nothing from anywhere else.
  let p = await open();
  check("first visit is signed out", (await p.textContent("#state")) === "Signed out");
  check("nothing stored on first visit", await p.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length) === 0);

  // 3. Connect, then switch project: the other project's tab is not in the page.
  await connect(p);
  await expand(p, "p:garden");
  await p.click('#tree [data-id="v:garden:tasks"] > .ti'); await p.waitForTimeout(150);
  await p.click("#task-list .row[data-id='XQ101']"); await p.waitForTimeout(300);
  await p.click("#inspector >> text=Open as tab"); await p.waitForTimeout(200);
  const withTab = await tabs(p);
  await p.click('#tree [data-id="p:recipes"] > .ti'); await p.waitForTimeout(200);
  const inOther = await tabs(p);
  await p.click('#tree [data-id="p:garden"] > .ti'); await p.waitForTimeout(200);
  check("a task tab stays with its own project", withTab.includes("TaskXQ101") && !inOther.includes("TaskXQ101") && (await tabs(p)).includes("TaskXQ101"),
        JSON.stringify({ withTab, inOther }));
  check("nothing stored while connected", await p.evaluate(async () => localStorage.length + sessionStorage.length + document.cookie.length +
    (await caches.keys()).length + (indexedDB.databases ? (await indexedDB.databases()).length : 0)) === 0);

  // 4. A second tab of the same browser starts signed out.
  const second = await p.context().newPage();
  await second.goto(SITE);
  await signedOut(second, "a new tab starts signed out");
  await second.close();

  // 5. Reload signs out.
  await p.reload(); await p.waitForTimeout(300);
  await signedOut(p, "reload signs out");

  // 6. Leaving and coming back (back, then forward and back again) stays signed out.
  await connect(p);
  await p.goto(ELSEWHERE); await p.goBack(); await p.waitForTimeout(300);
  await signedOut(p, "back after leaving stays signed out");
  await p.goForward(); await p.goBack(); await p.waitForTimeout(300);
  await signedOut(p, "forward and back again stays signed out");

  // 7. Forget access clears every surface.
  await connect(p);
  await p.click("#forget"); await p.waitForTimeout(200);
  await signedOut(p, "Forget access clears everything");

  // 8. A revoked token (401) clears everything and says so.
  await connect(p);
  revoke = true;
  await p.click("#refresh"); await p.waitForTimeout(600);
  await signedOut(p, "a revoked token clears everything");
  check("a revoked token is reported", (await body(p)).includes("No access: the token is invalid, expired or revoked."));
  revoke = false;
  await p.context().close();

  // 9. Inside another site's frame the page refuses to show.
  p = await open();
  await p.goto(FRAMER); await p.waitForTimeout(600);
  const frame = p.frames()[1];
  check("framed page refuses to show", frame && await frame.textContent("#state") === "This page cannot be shown inside another site." &&
        await frame.evaluate(() => getComputedStyle(document.getElementById("shell")).visibility) === "hidden");
  await p.context().close();

  // Every signed-out check above follows a connect that really opened the private project.
  check("every connect opened the synthetic private project", connects === 4 && opened === connects, opened + " of " + connects);
  check("no page errors or dialogs", errors.length === 0, errors.length ? errors.slice(0, 5).join(" | ") : undefined);
  check("no request to any other host", others.size === 0, others.size ? [...others].join(", ") : undefined);
  check("GitHub API requests are GET only", methods.size === 1 && methods.has("GET"), [...methods].join(", "));

  await browser.close();
  const pass = checks.every(c => c.pass);
  process.stdout.write(JSON.stringify({ pass, checks }, null, 1) + "\n");
  process.exit(pass ? 0 : 1);
})().catch(e => {
  // The site's address stays out of the output, as everywhere else in this file.
  const message = String(e && e.message || e).split(SITE || "\0").join("<site>/");
  process.stdout.write(JSON.stringify({ pass: false, crashed: message }) + "\n"); process.exit(1);
});
