---
name: simforge-quickstart
description: Install the SimForge CLI (simforge), check the machine with `simforge doctor`, and do a first render of a scenario package exported from the SimForge hosted app. Use when someone wants to get started with SimForge locally, set it up on a new machine or container, or turn an exported .scenario.zip into frames.
---

# SimForge quickstart

`simforge` is one binary: it verifies scenario packages exported from the
hosted app (simforge.ai, "Export for CLI"), pulls the map and actor assets they
name by digest, renders them with the deterministic renderer, re-simulates, and
serves closed-loop episodes. Every command prints ONE JSON document on stdout;
failures print `{code, path?, reason, detail?}` on stderr. Read the JSON, not
the prose.

## 1. Install

Pick one (details and verification: [references/install.md](references/install.md)):

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/SimForgeinc/simforge-sdk/releases/latest/download/simforge-installer.sh | sh
brew install simforgeinc/tap/simforge
docker pull ghcr.io/simforgeinc/simforge:latest     # CPU or NVIDIA: references/container.md
```

## 2. Check the machine

```sh
simforge doctor
```

Exit `0`: ready. Exit `2`: at least one check has `"status": "fail"`; each
check carries `detail` and usually `fix`. On a fresh machine, fetch the sky
plates first: `simforge assets pull --only sky`. Other common first-run fails:
no Vulkan/Metal adapter, no ffmpeg (only needed for video). A CPU-only machine
(Mesa lavapipe) fails the gpu check until you opt in explicitly with
`SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER=1` (or `--allow-software-adapter` on
`render`/`env serve`). Use
`simforge doctor --offline` on an air-gapped machine (the registry check is
then `skipped`, never `ok`). For anything else, use the simforge-troubleshoot skill.

## 3. First render of an exported package

```sh
simforge package verify scene.scenario.zip          # exit 2 = the package is damaged or too new
simforge package import scene.scenario.zip --into ws
simforge render ws --preset training --out out      # default rig: one front RGB camera
```

- `package import` verifies the package, then fetches the map release and the
  actor models it names BY DIGEST from the public stores (installed ones are
  reused). `--offline` fetches nothing and reports what this machine lacks;
  then `simforge maps pull name@version` / `simforge assets pull` by hand.
- `simforge package inspect scene.scenario.zip` shows which map release and
  actor closure the package pins.
- `--rig rig.json` renders your own sensor rig (see simforge-render).
- No GPU? Add `--allow-software-adapter` to render on lavapipe (CPU). It is
  slow, and the CLI refuses a software adapter unless you ask for it.
- `out/results.json` lists every pass with its sha256 and the adapter used.

Next: presets, rigs and outputs in simforge-render; closed loop in
simforge-closed-loop.

## Reference

<!-- simforge:reference doctor -->
_Generated from `simforge --help` (CLI 0.2.0) by scripts/skills/skills.py; do not edit._

#### `simforge doctor`

Check this machine: GPU adapter, ffmpeg, cache roots, disk, registry reachability

Usage: `simforge doctor [flags]`

| Argument / flag | | What |
|---|---|---|
| `--offline` |  | Do not probe the registry (the check is reported as skipped, never as ok) |
| `--registry URL` |  | Registry to probe. Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the logged-in account's registry (`simforge login`), then the public registry |
| `--timeout SECONDS` | default `10` | Network timeout for the registry probe |

Exit codes: `0` ok; `1` command error: the command could not run; `2` findings: the command ran and found something wrong with its input.
<!-- /simforge:reference -->
