# Changelog

All notable changes to the `simforge` CLI and `simforge-oss-gym`. The release
agent writes each section from the commits since the previous tag
(.claude/agents/release.md); the versions follow semver, and a section heading
is exactly `## [X.Y.Z]` or `## [X.Y.Z-rc.N]` (scripts/release/check-versions.py
reads it).

## [Unreleased]

## [0.2.0-rc.0]

Release candidate (dry run) of the first Rust CLI release; see the notes below.

- First release of the Rust `simforge` CLI (0.2.0): scenario packages
  (`simforge.scenario-package/v1`), content-addressed maps and actor assets,
  the deterministic renderer (`training` and `showcase` presets), re-simulation,
  the closed-loop environment server and `simforge doctor`.
- Distribution: signed archives and installers (Linux x86_64/aarch64, macOS
  arm64, Windows x86_64), `ghcr.io/simforgeinc/simforge`, the
  Python wheels (`simforge-oss-gym` and its four siblings), the Homebrew tap, and
  agent skills (`skills/`, for Claude Code, Codex and other agents).
- 0.1.0-rc.* were the TypeScript/Studio preview stack published from
  simforge-oss; they are not continued.
