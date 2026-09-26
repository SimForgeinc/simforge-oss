---
name: simforge-render
description: Render a SimForge scenario workspace offline with `simforge render`, choosing the training or showcase preset, a sensor rig (cameras, lidar, radar), passes, texture tier and video, and reading results.json. Use when producing frames, ground truth (instance id, depth, semantic), lidar/radar or videos from an imported scenario package, or when a render fails or differs between machines.
---

# Rendering with simforge

One renderer, two presets:

| Preset | For |
|---|---|
| `training` | datasets and closed loop: the passes models consume, at a fixed cost per frame |
| `showcase` | video: the same scene with the expensive lighting and post-processing on |

A render REPLAYS the workspace's trace: `render` builds the render timeline
from the trace and checks it against the one the package carries, then lowers
it to scene states. Poses never come from a second simulation. (To change the
motion, re-simulate first: `simforge simulate ws`, which is labelled
"re-simulated".)

## Typical runs

```sh
simforge render ws --preset training --rig rig.json --out out
simforge render ws --preset showcase --rig rig.json --out out-video --passes rgb --video required
simforge render ws --preset training --rig rig.json --out out-cpu --allow-software-adapter   # lavapipe
```

- `--rig` is a `simforge.render-rig/v1` document: the camera/lidar/radar
  sources, the sensor hosts they mount on, the clip and the video settings (the
  same document the hosted render uses).
- `--out` must not exist or be empty.
- `--passes rgb,id,depth,semantic` selects camera passes; `--set key=value`
  overrides preset settings (repeatable, e.g. `--set aa.mode=fxaa`).
- `--video auto` encodes with ffmpeg when it is on PATH; `required` fails
  without it; `off` never encodes.
- `--textures bc7-512` stages the smaller texture tier for small GPUs.
- The map is found in the cache by content. `--allow-map-drift` renders on an
  installed release whose members differ from the package's map closure; the
  drift is recorded in the result and the default refuses.

## Outputs

`out/results.json` lists every pass with its sha256, the adapter (GPU name,
driver, or lavapipe) and the gates that ran. Frames, id/depth/semantic images,
lidar (PLY) and radar (CSV) sit beside it.

## Reproducibility

Traces and timelines are byte-identical everywhere. Pixels are identical run
to run on the same GPU model and driver; lavapipe (CPU) is byte-stable across
runs and is what the golden images are recorded on. A GPU and lavapipe render
of the same scene differ in pixels: compare like with like.

## Reference

<!-- simforge:reference render, timeline build -->
_Generated from `simforge --help` (CLI 0.2.0-rc.1) by scripts/skills/skills.py; do not edit._

#### `simforge render`

Render a workspace offline: frames, id/depth/seg, lidar/radar, results.json, video

Usage: `simforge render <workspace> [flags]`

| Argument / flag | | What |
|---|---|---|
| `<workspace>` | required | The workspace directory (an imported scenario package) |
| `--preset PRESET` | required; one of `training`, `showcase` | The render preset |
| `--rig RIG.JSON` |  | The sensor rig (`simforge.render-rig/v1`: the hosted render's sources, sensorHosts, clip and video). Default: one front RGB camera (1280x720, 20 fps, 90 degree FOV) on the scenario's first actor (the first authored actor by id, else the first actor), recorded in render.json and results.json |
| `--out DIR` | required | Output directory (created; must be empty if it exists) |
| `--passes PASSES` | one of `rgb`, `id`, `depth`, `semantic`; default `rgb,id,depth,semantic`; repeatable | Camera passes, comma-separated |
| `--set KEY=VALUE` | repeatable | Render-config overrides on the preset (`key=value`, e.g. `aa.mode=fxaa`); repeatable |
| `--textures TEXTURES` | one of `uastc-full`, `bc7-512`; default `uastc-full` | The staged texture tier |
| `--video VIDEO` | one of `auto`, `required`, `off`; default `auto` | Encode videos with ffmpeg |
| `--vram-budget BYTES` |  | A texture budget in bytes; without it the device capacity is unmeasured and admission is skipped (reported) |
| `--allow-software-adapter` |  | Render on a software (CPU) Vulkan adapter such as lavapipe, explicitly. Slow; pixels differ from a GPU's |
| `--map-dir DIR` |  | Use this native map directory (`.corpus/<map>`) instead of the installed map found by content |
| `--cache-root DIR` |  | Map cache root to search. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps |
| `--assets-root DIR` |  | Actor-asset root. Default: SIMFORGE_ACTOR_ASSETS_ROOT, then $XDG_DATA_HOME/simforge/actor-assets |
| `--actor-closure SHA256` |  | The actor closure to bind, instead of the workspace's `catalog.actorClosureDigest` |
| `--allow-map-drift` |  | Render on the installed map release even where its members differ from the workspace's map closure (recorded in the result; the default refuses) |

#### `simforge timeline build`

Build the render timeline for a workspace's trace (deterministic, content-keyed)

Usage: `simforge timeline build <workspace> [flags]`

| Argument / flag | | What |
|---|---|---|
| `<workspace>` | optional | The workspace directory (an imported scenario package). Omit it and pass --trace instead |
| `--trace FILE` |  | A trace file (JSON or gzip; any released trace format) instead of a workspace |
| `--recorded-trace-sha256 SHA256` |  | The identity recorded next to the stored trace (bound to an upgraded trace; checked against a current one) |
| `--catalog-digest SHA256` |  | Actor-catalog closure digest to key the timeline by (a workspace supplies its own) |
| `--height HEIGHT` | one of `auto`, `ground`, `xodr`, `flat`; default `auto` | The height source |
| `--flat-z METRES` |  | Elevation of the plane for --height flat |
| `--map-dir DIR` |  | Use this map directory (map.xodr + topology-index.json.gz [+ derived/ground]) instead of the installed map found by content |
| `--cache-root DIR` |  | Map cache root to search. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps |
| `--out FILE` |  | Write the canonical timeline here (`.gz` compresses). Default: the workspace's timeline/<sha256>.json; with --trace, nothing is written |

Exit codes: `0` ok; `1` command error: the command could not run; `2` findings: the command ran and found something wrong with its input.
<!-- /simforge:reference -->
