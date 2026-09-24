# Native render benchmark

Measures the throughput of the native render pipeline exactly as the Studio
worker runs it: `@simforge-oss/render` native engine → `simforge-render serve`
(Bevy, retained scene, shm frame bundles) → lidar/radar rasterizers → ffmpeg.
The fixture is a real Studio render job (Richmond Field Station, 20 s clip,
ego rig of 7 dash cameras + trailing chase camera at 1280×720/24 fps, one
64-beam lidar, one front radar).

**The number to beat is `msPerTick`** for the full rig. At the Apple M4
baseline it is ~4.6 s/tick (idle machine, 48 ticks), which puts the 20 s clip (480 ticks) at ~37 min. The baseline workspace with its videos is at `~/simforge-bench/results/baseline-m4` on that machine; PSNR checks need it.

## Run it

```sh
# once per machine: build the runtime the engine binds to (service + ffmpeg
# + actor closure); the Studio onboarding "Render on this machine" step does
# the same thing, or:
node scripts/native-runtime/package-runtime.mjs --no-gpu-interop
node scripts/native-runtime/install-runtime.mjs dist/native-runtime/<archive>.tar.gz

# build the TS packages the bench imports
pnpm --filter @simforge-oss/render --filter @simforge-oss/scenario --filter @simforge-oss/openscenario run build

# benchmark: 2 s of the clip (48 ticks), all sources
node scripts/bench/native-render/run.mjs --fixture ~/simforge-bench/richmond --out /tmp/bench-1

# compare against the committed baseline (fails on regressions or broken output)
node scripts/bench/native-render/run.mjs --fixture ~/simforge-bench/richmond \
  --baseline scripts/bench/native-render/baseline-apple-m4.json --label my-change
```

Flags: `--seconds N` (clip length, default 2), `--sources all|rgb|lidar|radar|<outputName,…>`
(isolate a modality), `--binary <path>` (a locally built `simforge-render`
instead of the installed runtime; `cargo build --release -p simforge-render`
under `renderer/`), `--label`.

Rebuilding the TS engine (`pnpm --filter @simforge-oss/render run build`) is
required after changing `packages/render`; the bench imports `dist/`.

## What is reported

| field | meaning |
| --- | --- |
| `msPerTick` | wall time between the first and last tick, per tick. The score. |
| `msPerSourceTick` | `msPerTick` divided by the number of sources; comparable across `--sources` runs. |
| `serviceMs` / `serviceShareOfLoop` | time the service reported spending inside `render_bundle`, and its share of the loop. ~100% means the Bevy side is the bottleneck; well under 100% means the Node side (frame readback, RGBA padding strip, rasterizers, ffmpeg stdin) is. |
| `startupMs` | scene lowering + service spawn + prewarm + first bundle. Not part of the score but paid once per job. |
| `encodeFlushMs` | closing the encoders after the last tick. |
| `projectedFullClipMin` | `msPerTick × 480` — what the Studio user would wait for the fixture's 20 s clip. |

The result is written as `bench-result.json` next to the rendered workspace
(`video/`, `trace/`, `manifest/`, `diagnostics/`).

## Correctness gate (`--baseline`)

A faster render that draws the wrong thing is not faster. With `--baseline`
the run fails unless:

- the trace digest is identical (the simulated scene state — actor poses,
  clock — must not change; only rendering may),
- every video has the same frame count as the baseline,
- every video scores ≥ 35 dB PSNR against the baseline's video (needs the
  baseline workspace on disk; otherwise PSNR is skipped and reported as such).

Anything that changes the image on purpose (lighting model, sky, LOD policy)
must re-baseline explicitly and say so; the gate exists to catch dropped
frames, skipped passes and stale retained state, not to freeze the look.

## Rules for optimizers

- Optimise the real path: `packages/render/src/native/engine.ts`,
  `service-client.ts`, `shm-bundles.ts`, `sensor-video.ts`, and the service in
  `renderer/service` + `renderer/render-core`. No bench-only code paths, no
  detecting the fixture.
- The Studio contract stays: fixed-step clock, every source time-locked to the
  same tick, one H.264 mp4 per source, lidar PLY / radar CSV archives when
  requested, the same `native-render.json` / `native-run.json` evidence.
- Report `msPerTick` with and without `--baseline`, on the same machine as the
  baseline you compare with, plus `--sources rgb` and `--sources lidar` so the
  win is attributable.
- Keep `startupMs` honest: moving work from the loop into startup is fine when
  it is real (asset upload, pipeline warmup), and must show up there.

## Capturing a different fixture

`capture-fixture.mjs` turns any Studio job into a fixture:

```sh
node scripts/bench/native-render/capture-fixture.mjs \
  --intent <render intent json> \
  --worker-dir ~/.simforge/cloud/worker/usrj_<job>-<catalog> \
  --map-dir ~/.simforge/cloud/maps/<usmap_…>/semantic \
  --out ~/simforge-bench/<name>
```

The intent is `simforge.render_jobs.render_intent` in the local Studio
database; the worker directory holds the job's downloaded inputs; the map
directory is the host's prepared map. Map members are referenced in place
(they are ~1 GB) and matched by content digest, so the fixture directory itself
is small and the map must stay where it was captured.
