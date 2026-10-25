# Workspace

The first usable workspace, built on the read-only data layer in [DATA-LAYER.md](DATA-LAYER.md). Everything shown comes from what the data layer read at one pinned commit per repository; the page computes no progress figure of its own and has no control that writes anything.

## Places

- **Tree** (left, a menu button on narrow screens): projects, each with Overview, Tasks, its stages (when the progress output supplies them) and its repositories. Arrow keys move, open and close groups, as in the WAI-ARIA tree pattern.
- **Overview**: the supplied figures for the whole plan and each scope (Pilot, MVP, Post-MVP) with what they are based on, then stage chips, a phase strip, the tasks waiting to start, and the repositories. A denied plan shows only its notice and the repositories that could be read.
- **Tasks**: the same whole-plan figures, the phase strip, filters (search, phase, status, doer), the task list and an inspector. Filters, stages and phases choose which rows and cards are shown; they never change a figure.
- **Inspector**: the row's properties; evidence, shown separately from status ("Done" in the table is not owner approval); prerequisites, with any not in the table marked; notes; the task's brief and handover when the workspace names where they are; result-file links; and **Open as tab**.
- **Tabs**: a task tab keeps the project, repository, file templates and commit it was read from, and says so ("Read from … @ commit"); its brief and handover stay those of that commit after the branch moves on. Tabs of another project are not in the page. On refresh, a tab closes when its repository is no longer mapped to its project or can no longer be read, and its documents go with it.
- **Repository**: role, when it was read, visibility and check runs. A run counts as passing only on an explicit success; a finished run with no conclusion, or one not known here, is shown as such, never as passing. Later slices add more.
- **Go to** (Ctrl K or ⌘K): places only (projects, views, the current project's tasks, themes). It does not search inside files.

## States

Every surface shows one of the data layer's states with a glyph, a title and a sentence, never a blank or a zero standing in for "unknown": loading, empty, no match, missing, denied, rate limited, invalid, stale, unavailable, partial, failed and none. A phase with no rows says "No active work", never 0% or 100%. Phase dots show one dot per row up to 40 rows, then one dot per status with its exact count. Stale progress is never shown as figures. Invalid table rows are listed with their line and raw text.

## Result files

A result-file link appears only for a task whose owner approval the progress output records (`approved_results`, see DATA-LAYER.md), at the pinned commit, in a new tab. Paths the producer rejected show as "Invalid link". Without a web address from GitHub, no link is made.

## Access lifecycle

Forget, leaving the demo, a revoked or expired token, leaving the page and coming back from the browser's page cache all end the session the same way: the token field is cleared, every tree item, view, tab, dialog, Go to entry and live message is removed, and the page returns to "Nothing loaded". A refresh that loses access to a plan removes its tasks and tabs.

## Keyboard

The help dialog (**?**) lists the keys: Ctrl K or ⌘K for Go to, **/** for search, arrows, Home and End in the tree and the task list, Enter to open, **T** to open a task as a tab, arrows and Delete on tabs, and Esc to close. The first Tab stop is a skip link to the main area. Focus stays where it was when the page redraws, and the focus ring is 3 px.

## Theme

Device, Light or Dark, for this visit only. The choice is not remembered, because the page stores nothing in the browser.

## Synthetic demo

**Show the synthetic demo** runs the same code against made-up repositories in `fixtures/demo/`, built into `demo-data.js`, with no network. It covers a current plan with stages and approved result files, a stale plan, a plan without progress, a kit with broken rows, a denied plan and a code-only project. Brief and handover text includes hostile HTML that must show as text.

## Tests

- `tests/test_browser.py` builds the site and runs `tests/browser/workspace.check.js` in Chromium: the keyboard journey, figures that filters never change, states, tabs, the access lifecycle, copy, layouts at 320 to 1280 px in both themes, result-file links and GET-only requests against a mocked private plan, the framed-page refusal, and WCAG 2.2 target size (24 px), focus not hidden under the top bar, and the roles and states of the tree, list, tabs, Go to and dialogs. It needs Node.js and Playwright and is skipped without them, as on CI; set `SANDBOARD_PLAYWRIGHT` to the playwright module's folder when it is not found.
- `tests/test_style.py` checks that both dark palettes match, text contrast is at least 4.5:1, borders and the focus ring at least 3:1, in both themes.
- `tests/test_demo.py` checks the demo's stored progress against its files.

## Not covered yet

- Account views and the fuller repository view.
- Browser checks on CI (Playwright is not installed there).
- A pass with a real screen reader; the browser checks cover roles, names and states only.
