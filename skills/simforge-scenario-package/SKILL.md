---
name: simforge-scenario-package
description: Work with SimForge scenario packages (simforge.scenario-package/v1, the .scenario.zip the hosted app exports): inspect, verify and import them into a workspace, understand the thin and full forms, minCli version checks, and the package error codes and exit codes. Use when a package will not verify or import, when checking what a package pins, or when moving scenarios between machines or air-gapped sites.
---

# Scenario packages

A scenario package is the one verifiable form of an authored scenario revision:
a strict ZIP whose `manifest.json` sha256 is the package id. It holds the
document, the simulated trace and resolution, the render timeline, the map and
actor closure digests, the catalog entries, optionally a derived
`export/scenario.xosc` and a render pin, and, in the full form, the blobs.

- **Thin** (the hosted app's default "Export for CLI", a few MB): the map and
  actor models are referenced by digest and fetched with `simforge maps pull` /
  `simforge assets pull`.
- **Full** (air-gapped): the blobs travel inside the package.

Promises: replay, not re-simulation; nothing re-bound by name (map and actors by
digest; a missing piece fails, never substituted); every byte verified.

## Commands

```sh
simforge package inspect scene.scenario.zip           # manifest, producer, members; no unpacking
simforge package verify scene.scenario.zip            # every member digest; exit 2 on any finding
simforge package import scene.scenario.zip --into ws  # verify, then unpack into a new workspace
```

`import` also checks the map cache and the actor-asset root for what the
package pins (`--cache-root`, `--assets-root`) and says what is missing.

## Versions

The manifest's `producer` names the app and the oldest CLI that reads the
package (`minCli`). A CLI older than that refuses the package (a `version_ahead`
/ `cli_version` finding) instead of guessing: upgrade the CLI. Packages with an
older trace format are upgraded on read by the trace upgrader chain.

## Reading failures

`verify` exits `2` with findings: each has a rule id (for example
`member_sha256`, `member_missing`, `member_unlisted`, `trace_sha256`,
`timeline_sha256`, `resolution_mismatch`, `not_a_zip`, `not_canonical`,
`version_ahead`) and the member path. Exit `1` means the command could not run
(`package_io_error`, a bad argument). A digest finding means the file changed
after export: re-export it; do not edit members by hand, the manifest pins
them all.

## Reference

<!-- simforge:reference package inspect, package verify, package import -->
_Generated from `simforge --help` (CLI 0.2.0-rc.1) by scripts/skills/skills.py; do not edit._

#### `simforge package inspect`

Print a package's manifest, producer and members without unpacking it

Usage: `simforge package inspect <package.zip> [flags]`

| Argument / flag | | What |
|---|---|---|
| `<package.zip>` | required | The package file |

#### `simforge package verify`

Verify the manifest and every member digest; exit 2 on any mismatch

Usage: `simforge package verify <package.zip> [flags]`

| Argument / flag | | What |
|---|---|---|
| `<package.zip>` | required | The package file |

#### `simforge package import`

Verify, then unpack into a local workspace

Usage: `simforge package import <package.zip> [flags]`

| Argument / flag | | What |
|---|---|---|
| `<package.zip>` | required | The package file |
| `--into DIR` | required | The workspace directory to create (must not exist, or be empty) |
| `--cache-root DIR` |  | Map cache root to check for the package's map. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps |
| `--assets-root DIR` |  | Actor-asset root to check for the package's actor closure. Default: SIMFORGE_ACTOR_ASSETS_ROOT, then $XDG_DATA_HOME/simforge/actor-assets |
| `--offline` |  | Fetch nothing: report the map and actor closure this machine still lacks |
| `--registry URL` |  | Map registry to resolve the package's map from. Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the logged-in account's registry (a private map needs no access URL then), then the public registry |
| `--host HOST` |  | SimForge host whose account registry resolves the map (see `simforge login`). Default: SIMFORGE_HOST, then simforge.ai |
| `--assets-base-url URL` |  | Asset store for the actor closure. Default: SIMFORGE_ACTOR_ASSETS_BASE_URL, then the public store |

Exit codes: `0` ok; `1` command error: the command could not run; `2` findings: the command ran and found something wrong with its input.
<!-- /simforge:reference -->
