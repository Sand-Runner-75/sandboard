# Instructions for AI agents (ChatGPT / Codex)

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for all work in this repository: never push to `main`, work on `gpt/<topic>-<yyyymmdd>` branches, open one pull request per update, commit only code and synthetic test data, and keep the public audit check green.

## Independent review: gbt only (Ahmed, 2026-11-14)

Ahmed's instruction, for all projects, chats and repositories: "Stop posting @codex review, @codex security review, or other commands requesting Codex bot reviews on any repository. Remove these requests from your standing workflow. Request independent review from gbt only. Keep required CI and the existing bilateral same-commit approval and Doer-only merge rules."

- No assistant posts `@codex review`, `@codex security review` or any other request for a Codex bot review, on any pull request.
- Independent review comes from gbt only, asked for in a `FROM: Claude` comment on the pull request.
- Required CI, both AIs approving the same commit, and Doer-only merge stay exactly as written in this repository's rules.
