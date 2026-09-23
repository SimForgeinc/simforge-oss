# Golden store

```
goldens/<gpuFingerprint>/<scene>.json
```

- `<gpuFingerprint>`: first 16 hex of sha256 over canonical
  `{gpus:[{name,driverVersion,vbiosVersion,pciBusId}], kernel, arch}` from the
  same nvidia-smi query as WSB4's `qualification/render-determinism/gpu-fingerprint.mjs`.
  Current entry: `75b333b1506af34f` = NVIDIA GeForce RTX 5080, driver 595.84,
  vbios 98.03.6C.00.3E, PCI 00000000:02:00.0.
- One file per scene; full evidence manifest (schema
  `simforge-oss.render-determinism-manifest.v1`, extensions in
  `docs/native-golden-ci.md`). Gates read `passHashes` + `timings.avgFrameMs`.
- `0c79cc9fe7b267f4` = NVIDIA GeForce RTX 3080, driver 595.91.07 (the dev
  Bevy worker box): render-timeline actor scenes (`richmond-06-timeline`,
  `yale-05-timeline`).

## Renderer

Every scene renders through `simforge-render job --job <run>.job.json`
(schema `simforge.render-job/v2`: the render service's own request path,
`training` preset, pinned capture clock). The harness writes the job from the
scene's `job` block (adding the corpus GLBs, the scene-state stream, `outDir`
and, for parity scenes, `observe`); the manifest records the binary
(`rendererPath.file`, `sha256`) and the full job (`rendererPath.invocation`).
Artifacts follow the job layout: `<outDir>/<sensor>/<tick:08>.<pass>.png`
(`rgb`, `id`, `semantic`), `.depth.f32.bin`, lidar `<tick:08>.ply`, plus
`results.json` (per-tick timings, which feed the frame-time gate; one-tick
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

The hash files under `75b333b1506af34f/` and `0c79cc9fe7b267f4/` were
recorded with the retired renderer binaries (single-shot job, timeline
playback, Pronto capture) and their Sensor look, under the old artifact layout. They
are retired evidence: every scene must be re-recorded with `simforge-render`
(rc.75) before the gate is armed again; `verify` reports missing keys as
drift until then.

The timeline scenes' fixtures were regenerated on 2026-09-23 from their
source traces (edge cases 05/06, engine 0.7.0; trace `inputHash`
`1ebb3cb0…` / `7defd6a3…`) with today's timeline builder on the maps' xodr
elevation (`simforge render timeline <trace> --map <map>`, no ground
derivative in those map versions), then `simforge render scene-state
<timeline> --fps 24 --end 6`. They carry `contactOrigin`, `wheelSpinRad`,
`bodyAttitude` and `wheelDropM`, so the two-wheelers render with their posed
riders and `simforge render parity` reads the timelines. The job writes
`observed-frames.jsonl` (`observe`), which the parity gate grades.

## Re-record

```sh
cargo build --release -p simforge-render --manifest-path renderer/Cargo.toml
SIMFORGE_CORPUS_RICHMOND=<richmond corpus root> SIMFORGE_CORPUS_YALE=<yale corpus root> \
SCEN_SENSOR_CORPUS_WSB1=<WSB1 decoded yale corpus> SCEN_SENSOR_CORPUS=<spike corpus> \
  node qualification/golden-harness/golden.mjs plan all
node qualification/golden-harness/golden.mjs record <scene>
node qualification/golden-harness/golden.mjs verify all
```
