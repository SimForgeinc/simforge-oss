# Contributing

**This repository is a mirror; development happens upstream; PRs are imported manually.**

The SimForge SDK is developed in SimForge's private platform repository, at
`sdk/`, where each change is tested together with the hosted app built on it.
Every change there is exported to this repository's `main` within minutes, as
one commit named `Export simcloud-platform <sha>`. `main` here only ever moves
by that export.

Pull requests and issues are still welcome:

1. Open the PR against `main` and say what changed, why, and how you verified
   it (`scripts/gate-local.sh`, or the targeted `cargo nextest` / pytest /
   goldens for what you touched; see [AGENTS.md](AGENTS.md)).
2. A maintainer imports it upstream by hand, keeping you as the author.
3. The PR is closed with a link once an export carries the change.

Releases are cut by tagging an export commit (`release.yml`).
