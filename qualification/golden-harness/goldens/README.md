# Golden store

```
goldens/<gpuFingerprint>/<scene>.json
```

- `<gpuFingerprint>`: the adapter-of-record fingerprint (lavapipe build + CPU
  model; `lib/fingerprint.mjs`, docs/engineering/native-golden-ci.md). Goldens
  are recorded and verified on Mesa lavapipe, never on a GPU: NVIDIA drivers
  are not run-to-run byte-stable for this renderer.
  Current entry: `c398eadcadbd2754` = llvmpipe (LLVM 20.1.2, 256 bits), Mesa
  25.2.8-0ubuntu0.24.04.2, Intel Core Ultra 9 285K.
- One file per scene; full evidence manifest (schema
  `simforge-oss.render-determinism-manifest.v1`, extensions in
  `docs/engineering/native-golden-ci.md`). Gates read `passHashes`.

## Renderer

Every scene renders through `simforge-render job --job <run>.job.json`
(schema `simforge.render-job/v2`: the render service's own request path,
`training` preset, pinned capture clock). The harness writes the job from the
scene's `job` block (adding the corpus GLBs, the scene-state stream, `outDir`
and, for parity scenes, `observe`); the manifest records the binary
(`rendererPath.file`, `sha256`) and the full job (`rendererPath.invocation`).
Artifacts follow the job layout: `<outDir>/<sensor>/<tick:08>.<pass>.png`
(`rgb`, `id`, `semantic`), `.depth.f32.bin`, lidar `<tick:08>.ply`, plus
`results.json` (per-tick timings, recorded and gated only with GOLDEN_FRAME_BUDGET; one-tick
jobs have none).

Actor substitutions a scene declares (`actorModelRefs`,
`actorCatalogSubstitutions`, `allowPrimitiveActors`) are recorded in the
manifest's `actorSubstitutions`.

## Keying rules

Goldens are valid ONLY for the exact tuple recorded inside each file:
gpu fingerprint × renderer binary (`rendererPath.sha256`) × render config
(`renderConfig`) × scene inputs (the job + `corpusChecksums` +
`sceneStateSha256`). Any element changing ⇒ new golden required.

## Current status

Recorded 2026-09-23 on lavapipe (`c398eadcadbd2754`) with `simforge-render`
(dash-cam camera model with the calibrated defaults, canopy sky occlusion,
CPU-ordered draws under the pinned clock), each scene rendered twice at record
time with identical pass hashes and verified by a third render. The yale-05
fixtures name the wrong-way rider's class `cyclist` (the scene-state
vocabulary). The yale-frame0 and yale-pronto scenes render the yale-street
master. `package-smoke-richmond` is `recording: "unrecorded"` until its first
lavapipe record.

The timeline scenes' fixtures were regenerated on 2026-09-23 from their
source traces (edge cases 05/06, engine 0.7.0; trace `inputHash`
`1ebb3cb0…` / `7defd6a3…`): a render timeline built on the maps' xodr
elevation (no ground derivative in those map versions; today
`simforge timeline build --trace <trace> --map-dir <map> --height xodr`),
sampled into a scene-state document at 24 fps over 0 to 6 s. They carry
`contactOrigin`, `wheelSpinRad`, `bodyAttitude` and `wheelDropM`, so the
two-wheelers render with their posed riders, and the timelines are committed
beside them for the parity gate. The job writes `observed-frames.jsonl`
(`observe`), which the `render-parity` grader checks against the timeline.

## Re-record

```sh
# every scene (builds the renderer, then records and verifies):
SIMFORGE_CORPUS_RICHMOND=<richmond corpus root> SIMFORGE_CORPUS_YALE=<yale corpus root> \
  qualification/golden-harness/ci-local.sh record

# one scene:
cargo build --release -p simforge-render
node qualification/golden-harness/golden.mjs record <scene>
node qualification/golden-harness/golden.mjs verify all
```

A corpus root is a map's native install, `<maps cache>/.corpus/<map>`
(`simforge maps pull <map>`).
