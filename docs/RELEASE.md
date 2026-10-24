# Building, publishing and rolling back

## Build

```sh
python3 scripts/build.py --out dist
```

The build copies `src/`, turns `fixtures/demo-workspace.json` (synthetic data) into `demo-data.js`, and writes `build-manifest.json` with a SHA-256 hash of every file. The same commit always gives the same bytes. The build fails if a page loses its Content-Security-Policy or no-referrer meta tag, gains an inline script, style or event handler, or refers to any origin other than `https://api.github.com`. The page also refuses to show itself inside a frame.

`dist/` is never committed. CI builds it on every pull request and runs the public audit on it and on the job's own log.

## What gets published

Only `dist/`: the app shell and synthetic demo data. Real project data is never part of the site; it is read from GitHub in the visitor's browser after sign-in and kept in memory.

## Publishing is off

`.github/workflows/pages.yml` runs only when started by hand **and** the repository variable `PAGES_ENABLED` is `true`. Neither is set, so nothing is published. Turning it on makes the site public and is the owner's decision alone:

1. Settings, Pages: set Source to "GitHub Actions".
2. Settings, Secrets and variables, Actions, Variables: add `PAGES_ENABLED` = `true`.
3. Actions, Pages, Run workflow, ref `main`.

The workflow runs the tests, the build and the public audit (files, history, build output, its own log) before uploading anything. If any step fails, nothing is uploaded and the live site stays as it was.

## Rolling back

- **To an earlier version:** Actions, Pages, Run workflow, and enter the earlier commit's ID as `ref`. That commit is tested, built, audited and published in place of the current site.
- **To take the site down:** set `PAGES_ENABLED` to `false` (stops new deploys), then Settings, Pages, "Unpublish site".
- **If something private was published:** unpublish first, then tell the owner. Do not try to fix it with a new commit alone: it stays in git history and possibly in caches.
