# sandboard

One place to see all my AI-built projects: tasks, progress, reviews and GitHub activity.

## Status

Early. This repository holds the application code only: the first usable workspace (projects, overview with progress, tasks with their details, briefs and handovers, task tabs; see [docs/WORKSPACE.md](docs/WORKSPACE.md)) on a read-only data layer (sign-in with a read-only token kept in memory, workspace list, plan table, stored progress and check runs; see [docs/DATA-LAYER.md](docs/DATA-LAYER.md)), and a synthetic demo that runs the same code on made-up repositories. Nothing is published; publishing stays off until the owner turns it on (see [docs/RELEASE.md](docs/RELEASE.md)).

## What it will be

A read-only web page that shows, for each project, its tasks, progress, reviews and recent GitHub activity. It runs in the browser and reads from GitHub with a short-lived, read-only token that stays in memory and is dropped when the tab closes.

## What is never in this repository

- Real project data, plans, task records or reviews. Those live in a separate private repository and are read only at run time, after sign-in.
- Personal names, email addresses or any credential.
- Anything other than code and synthetic test data.

A check runs on every pull request and every push to `main` to guard this: it fails if it finds a credential pattern, a private record marker, an unexpected binary or generated file, or a configured private term in the files, their names, the whole git history or the build output. It is a heuristic guard with documented limits; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Work is done by two AI agents, each reviewing the other's pull requests, under the rules in [CONTRIBUTING.md](CONTRIBUTING.md).
