# Instructions for Claude

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for all work in this repository: never push to `main`, work on `claude/<topic>-<yyyymmdd>` branches, open one pull request per update, commit only code and synthetic test data, and keep the public audit check green.

## Independent review: no Codex bot (Ahmed, 2026-11-14)

Ahmed's message to Claude, 2026-11-14 16:26 UTC, in a claude.ai project thread (transcribed by Claude): "Stop posting @codex review, @codex security review, or other commands requesting Codex bot reviews on any repository. Remove these requests from your standing workflow. Request independent review from gbt only. Keep required CI and the existing bilateral same-commit approval and Doer-only merge rules."

- No assistant posts `@codex review`, `@codex security review` or any other request for a Codex bot review, and no review depends on a Codex bot.
- When Claude is the Doer, it asks gbt for the independent review, in a `FROM: Claude` comment on the pull request. When gbt is the Doer, Claude stays the independent Reviewer. Neither assistant independently approves its own work.
- Required CI, both AIs approving the same commit, and Doer-only merge stay unchanged.
