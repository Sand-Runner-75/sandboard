# Building, publishing and rolling back

## Build

```sh
python3 scripts/build.py --out dist
```

The build copies `src/`, turns `fixtures/demo-workspace.json` (synthetic data) into `demo-data.js`, and writes `build-manifest.json` with a SHA-256 hash of every file. The same commit always gives the same bytes. If any rule below is broken, the build writes no site at all.

- `src/` holds only `.html`, `.js` and `.css` files.
- HTML is parsed, so a tag inside a comment, `<noscript>` or `<template>` does not count. The exact Content-Security-Policy and no-referrer meta tags must be active elements directly inside `<head>`, once each, before any element other than `<meta>` or `<title>` and before any text.
- No inline script, style block, style attribute, event handler, `javascript:` URL or element-level `referrerpolicy`.
- Every URL in a URL attribute (`src`, `href`, `srcset` and the like) and in CSS `url()` or `@import` is relative to the site.
- No file mentions any network origin other than `https://api.github.com`, after escaped or encoded slashes, backslashes and colons are decoded. IP addresses, `localhost` and protocol-relative `//host` references count as other origins. Write code comments as `// text`, with a space.

**Limit:** the origin check reads the source; it cannot see a URL built at run time (by joining strings, from character codes or by decoding). The page's Content-Security-Policy is the guard for that case: the browser refuses any connection except to the GitHub API.

The page also refuses to show itself inside a frame.

`dist/` is never committed. CI builds it on every pull request and runs the public audit on it.

## CI output

The test and build steps never print their output directly. `scripts/ci_step.py` sends it to `ci-log.txt` in the job's workspace, audits it with the public audit rules whether the command passed or failed, and only then prints it, line by line through the audit's redaction. If the audit finds anything, only the kind of finding is printed and the step fails. The final audit step runs even after a failed step and reads the whole log again. Without the `PUBLIC_AUDIT_TERMS` secret nothing is printed and the step fails, so pull requests from forks, which get no secrets, fail their checks.

## What gets published

Only `dist/`: the app shell and synthetic demo data. Real project data is never part of the site; it is read from GitHub in the visitor's browser after sign-in and kept in memory.

## Publishing is off

`.github/workflows/pages.yml` runs only when started by hand **and** the repository variable `PAGES_ENABLED` is `true`. Neither is set, so nothing is published. Turning it on makes the site public and is the owner's decision alone:

1. Settings, Pages: set Source to "GitHub Actions".
2. Settings, Secrets and variables, Actions, Variables: add `PAGES_ENABLED` = `true`.
3. Actions, Pages, Run workflow, ref `main`.

The workflow runs the tests, the build and the public audit (files, history, build output, its own log) before uploading anything. If any step fails, nothing is uploaded and the live site stays as it was.

## Rolling back

- **To an earlier version:** Actions, Pages, Run workflow, and enter the earlier commit's ID as `ref`. That commit is tested, built, audited and published in place of the current site. Only a commit that already contains this build, test and audit path can be used: anything older than the commit that added `scripts/build.py` and `scripts/ci_step.py` fails at the first step and publishes nothing.
- **Before Pages is first turned on:** rehearse a rollback between two eligible commits, so the path is proven before it is needed.
- **To take the site down:** set `PAGES_ENABLED` to `false` (stops new deploys), then Settings, Pages, "Unpublish site".
- **If something private was published:** unpublish first, then tell the owner. Do not try to fix it with a new commit alone: it stays in git history and possibly in caches.
