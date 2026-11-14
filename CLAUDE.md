# Instructions for Claude

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for all work in this repository: never push to `main`, work on `claude/<topic>-<yyyymmdd>` branches, open one pull request per update, commit only code and synthetic test data, and keep the public audit check green.

## No Codex bot reviews (owner's rule, 2026-11-14)

- No agent posts `@codex review`, `@codex security review` or any other request for a Codex bot review, and no review depends on a Codex bot.
- When Claude wrote the pull request, ChatGPT gives the independent review; when ChatGPT wrote it, Claude does. Neither agent approves its own work.
- Required checks, both agents approving the same commit, and the merge rules in [CONTRIBUTING.md](CONTRIBUTING.md) stay unchanged.
