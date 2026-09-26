# Changelog

All notable changes to the `simforge` CLI and `simforge-oss-gym`. The release
agent writes each section from the commits since the previous tag
(.claude/agents/release.md); the versions follow semver, and a section heading
is exactly `## [X.Y.Z]` or `## [X.Y.Z-rc.N]` (scripts/release/check-versions.py
reads it).

## [Unreleased]

## [0.2.0-rc.0]

The first release candidate of the Rust `simforge` CLI (engine 0.12.1).

### Added
- `simforge` CLI: `package inspect|verify|import` for scenario packages
  (`simforge.scenario-package/v1`) exported from the hosted app, with maps and
  actor models fetched and verified by digest; `maps pull|list`, `assets pull`
  (actor models and sky plates); `timeline build`; `render` with the `training`
  and `showcase` presets, sensor rigs (camera passes, lidar, radar) and video;
  `simulate` (labelled re-simulation); `env serve` (closed-loop episodes over a
  socket, rendered sensors optional); the authoring commands (`template`,
  `sites match`, `instantiate`, `batch`, `catalog`, `locations`, `variation`,
  `validate`, `evaluate`, `export`); `login`/`logout`/`whoami`; `doctor`;
  `skills list|install` for Claude Code, Codex and other agents.
- Every command prints one JSON document; `simforge help --json` describes the
  whole command surface.
- Python: `simforge-oss-gym` (Gymnasium environments, in-process and over
  `env serve`), `simforge-oss-timeline`, `simforge-oss-gpu`,
  `simforge-oss-physics`, `simforge-oss-render`, released together.

### Distribution
- Signed archives and installers for Linux x86_64 (glibc 2.28+) and aarch64
  (glibc 2.30+), macOS arm64 and Windows x86_64; the container image
  `ghcr.io/simforgeinc/simforge` (amd64 and arm64; Mesa lavapipe on CPU, NVIDIA
  through the `nvidia` runtime). Every asset is signed keyless with Sigstore and
  has SLSA build provenance; CycloneDX SBOMs for the binary, the native wheels
  and the image.
- Release candidates are GitHub pre-releases and container tags; PyPI, Homebrew
  and the `latest` tags follow the stable release.

### Notes
- The CLI raises its open-file soft limit to the hard limit at startup and
  bounds the asset files a render holds open, so large maps render under the
  stock limit.
- Sky plates come from `simforge assets pull --only sky`; without them the
  renderer stops with that instruction.
- 0.1.0-rc.* were the TypeScript/Studio preview stack published from
  simforge-oss; they are not continued.
