# Read-only data layer

How the app reads private project data from GitHub, and what it refuses to do. The code is in `src/sb-core.js`, `src/sb-readers.js` and `src/sb-render.js`; `src/app.js` wires it to the page.

## Access

- The owner makes a fine-grained GitHub token limited to the mapped repositories, with read-only **Contents** and **Metadata** (and **Checks** for check runs). It is pasted into a password field and kept only inside one session object in memory, where nothing outside `src/sb-core.js` can read it (only the module's own client turns a live run into the request header): never in browser storage, cookies, the URL, history, logs or error text. The field is cleared at once.
- **Forget token**, leaving the page (`pagehide`, including into the back/forward cache), a page restored from that cache (`pageshow`) and a `401` reply all end the session: pending requests are aborted, the token is dropped and everything read with it is cleared. Reload or a new tab starts signed out.
- The page refuses to run inside a frame.

## Requests

- One client sends every request, always `GET` to `https://api.github.com`, with `credentials: "omit"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"` and `redirect: "error"`. It has no way to send anything else.
- Paths must match an allowlist (`/user`, a repository, a commit, a file at a full commit SHA, a commit's check runs). Anything else is refused before any network call.
- Each run has a context. The session checks it before each request and after each reply, body read and hash, so a reply from a forgotten session or an older run never appears. A new run aborts the old one.
- Tests (`tests/test_app_rules.py`) fail if any browser code uses another network API, an HTTP method other than `GET`, a second network call site, browser storage, HTML parsing or code evaluation, or console logging.

## Pinning

Every view reads one repository at one commit: a branch or tag (the default branch when none is named) is resolved to its commit once, and every file of that view is read at that SHA. A file counts only if its bytes match GitHub's git blob hash.

## Result states

Every reader returns `{state, data, source: {repo, ref, commit, path}, schema, error}`. `state` is one of `loading`, `current`, `empty`, `no-match`, `missing`, `denied`, `rate-limited`, `invalid`, `stale`, `unavailable`, `partial`, `failed`. Only `current`, `empty`, `no-match` and `partial` carry data; `partial` also gives `coverage`. No state is ever shown as zero or success. HTTP `404` is `missing`, `403` is `denied` unless it is a rate limit, `403` with an exhausted limit or `Retry-After`, and `429`, are `rate-limited`, anything else, and a network failure or a reply body that cannot be read, is `failed`. A network failure that arrives after Forget or a newer run is dropped like any late reply. Each reader returns its own state, so one failing repository stops only the reads that depend on it; the other workspaces are still read (`SB.readWorkspace`).

## Workspace list

Read from the private plan repository named at sign-in, file `sandboard.workspaces.json`, at the pinned commit. Missing or invalid: no workspaces are shown, with the reason. Nothing is guessed from repository names.

```json
{
  "schema": "sandboard.workspaces/1",
  "workspaces": [
    {
      "id": "garden", "label": "Example Garden Planner", "kind": "project",
      "plan": { "repo": "owner/plan-repo", "ref": null,
                "files": { "progress": "plan/progress.json", "producer": "tools/progress.py",
                           "table": "plan/tasks.md", "record": "plan/record.md" } },
      "code": [ { "repo": "owner/code-repo", "ref": null, "role": "app" } ]
    }
  ]
}
```

`kind` is `project`, `kit` or `standalone`; `plan` may be `null` when `code` is not empty; `ref` `null` means the default branch. The four plan file paths come from this private file, so the public code names no private file.

## Plan table

Every Markdown table whose first header cell is `ID`, in order, with the heading above it as its section. Each row's fields stay text exactly as written. Rows with the wrong number of cells, no ID or a repeated ID are kept and marked invalid. Nothing is added up.

## Stored progress (`sandboard.progress/1`)

The plan's own producer stores its result in the progress file. It is read at the pinned commit and checked field by field: `schema`, `ok: true`, counts, the producer and exactly two inputs (table and record) at the paths named in the workspace list with 40-hex blob SHAs, all four scopes and every phase with every figure: hours (`estimated_h`, `completed_h`, `remaining_h`) are non-negative numbers; `progress_pct` (at most 100), `tbe_rows`, `proposed_rows`, `provisional_rows` and `rows` are non-negative whole numbers; `verified` is true or false; phase IDs (`P<n>`) are unique and in order; each phase's `status_counts` has exactly the six statuses Not Started, In Progress, Blocked, Ready for Review, Done and Removed, each a non-negative whole number. Then the producer and both inputs are read at the same commit:

- all three blob SHAs match: **current**, shown with its source commit and schema;
- any differs or cannot be read: **stale**, with the reason;
- no progress file: **unavailable**; the progress file itself denied, rate-limited or failed: that state;
- not JSON, wrong schema, `ok` not `true` or any field wrong: **invalid**.

Figures are shown exactly as stored, never recalculated. "Current" means "matches the pinned commit"; there is no time limit, and refresh is manual.

## Check runs

Read for a pinned commit, 100 per page, up to five pages. A `403` or `404` (the token has no **Checks: read**, or it is not proved) is **unavailable**, never "no checks". **Empty** only when GitHub reports none. Fewer runs read than GitHub reports, even none, is **partial**, with the coverage shown. A negative or changing total, or more runs than the total, is **invalid**.

## Rendering repository text

`SB.renderText` puts text only in text nodes; it never parses HTML. A word becomes a link only if it is a plain `https` address without a user name or password; links open in a new tab with `rel="noopener noreferrer"`, and trailing punctuation stays outside. Nothing from a repository is loaded: no images, frames or scripts. Binary content is not shown and text over 100,000 characters is cut, each with a notice. Hostile fixtures are in `tests/fixtures/hostile-text.json`.

## Tests

`python3 -m unittest discover -s tests -v` also runs the browser-module tests in `tests/js/` with Node.js (`node --test`), against a mock of the GitHub API serving synthetic repositories. Node.js 20 or later is needed.

## Not covered yet

- The same lifecycle checks on the published site's own origin, with synthetic data, before first private use there (publishing is off).
- A private read of the owner's real repositories with a real token, run by the owner from a local copy of the built site.
