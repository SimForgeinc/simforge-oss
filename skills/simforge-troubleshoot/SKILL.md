---
name: simforge-troubleshoot
description: Diagnose SimForge CLI failures from `simforge doctor` output and the structured errors every command prints ({code, reason, detail} on stderr, exit 1 or 2), including GPU/Vulkan adapter problems, missing ffmpeg or sky assets, map or closure mismatches, and render gate failures. Use when a simforge command fails, exits non-zero, or behaves differently on another machine.
---

# Troubleshooting simforge

## Read the contract first

- stdout: one JSON document (the result). stderr on failure:
  `{"code", "path"?, "reason", "detail"?}`.
- Exit `0` ok; `1` the command could not run (bad flags, I/O, missing input);
  `2` it ran and found something wrong with its input (findings).
- `simforge <command> --help` prints that command's flags as JSON (`--pretty`
  for text): check a flag there before guessing.

## Start with doctor

```sh
simforge doctor --pretty
```

Each check has `status` (`ok`, `warn`, `fail`, `skipped`), `detail`, and
usually `fix`. Checks: the GPU adapter (the one a render would choose), ffmpeg,
the sky assets, the cache roots (free disk), and the registry.

## Common codes

| Code | Meaning | Do |
|---|---|---|
| `bad_value` | a flag's value is invalid | read `path` (the flag) and the command's `--help` |
| `workspace_invalid` | not an imported workspace | `simforge package import pkg --into ws` first |
| `map_not_found` / `unknown_map` | the package's map release is not installed | `simforge package inspect`, then `simforge maps pull name@version` |
| `map_invalid` | the installed map differs from the package's closure | pull the pinned release; `--allow-map-drift` only on purpose (recorded) |
| `closure_invalid` / `attribution_invalid` | the actor closure is incomplete or unlicensed | `simforge assets pull --closure <digest>` again |
| `sky_assets_missing` | the renderer's sky plates are absent | `simforge assets pull --only sky` |
| `ffmpeg_broken` | video requested but ffmpeg is missing or fails | install ffmpeg, or `--video off` |
| `render_rig_invalid` | the rig document is wrong | validate it as `simforge.render-rig/v1` |
| `parity_rejected` / `timeline_rejected` | the rebuilt timeline or sampled poses disagree with the package | the package is from a newer engine or damaged: upgrade the CLI or re-export |
| `texture_tier_miss` / `gpu_memory_unmeasured` | texture staging or VRAM admission | `--textures bc7-512`, or pass `--vram-budget` |
| `render_failed` | the renderer failed | `detail` has the renderer's error; retry on another adapter |
| `episode_not_reset` / `episode_invalid` / `unknown_op` | env serve protocol misuse | reset before step; check the client version |
| `version_ahead` (package finding) | the package needs a newer CLI | upgrade simforge |

## GPU and adapters

- No adapter: install the Vulkan driver (Linux/Windows) or check Metal (macOS).
  On a headless Linux box without a GPU, install Mesa (`mesa-vulkan-drivers`)
  and pass `--allow-software-adapter` to `render`/`env serve`: the CLI never
  falls back to the CPU on its own.
- In the container, `SIMFORGE_DEVICE=gpu` makes a missing NVIDIA driver a hard
  error; use the `nvidia` runtime (simforge-quickstart, references/container.md).
- Different pixels on another machine are expected across GPU models and
  drivers; traces and timelines are identical everywhere.

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
