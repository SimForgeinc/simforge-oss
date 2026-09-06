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

## Keying rules

Goldens are valid ONLY for the exact tuple recorded inside each file:
gpu fingerprint × renderer binary (`rendererPath.sha256`) × render profile ×
scene inputs (`rendererArgs` + `corpusChecksums`). Any element changing ⇒ new
golden required. Known families on this program:
- `native-render-job` (sensor profile, Tonemapping::None linear; identity-stamped
  single-submission captures) — this store, from the 2026-09 migration on.
- WSB3 `sensor-capture` (Tonemapping::None ID cam) — separate instance-hash family.

## Current status (2026-09-05)

The `yale-frame0` golden under `75b333b1506af34f/` was recorded against the
removed `native-render` spike CLI (AgX tonemapping, readback not ordered
against the render graph). It is retired evidence: `verify yale-frame0` will
report drift against it by construction and it must be re-recorded with
`native-render-job` on the qualified GPU before the gate is armed again. The
expected invariants across that re-record are that `id0` and `depth0`
(geometry/unlit passes) match the spike values only if the scene inputs are
identical; `rgb0` changes family (linear sensor output).

| yale-pronto | pronto-cam0.rgb `7d9091c1af4a6a1a` · depth `517cf5171b7016d2` · instance `3b8b2be27a00bd7e` · semantic `8455e0f311aaa64f` · lidar-front-left PLY `e9c48979b3331bff` | sensor-capture (Tonemapping::None ID/semantic) — separate artifact family; rgb/depth independently reproduce WSB3's paired-run hashes |

yale-pronto reads WSB1's decoded corpus (`SCEN_SENSOR_CORPUS_WSB1` →
`.corpus/yale-street`, tiles/ subdir auto-detected), the committed
`run/evidence/scene-state.v1.json`, and `fixtures/yale-header.xodr`.
It has no timing instrumentation — frame-time gate is skipped for it.

## Re-record

```sh
cargo build --release -p render-core --bin native-render-job --manifest-path renderer/Cargo.toml
SCEN_SENSOR_CORPUS=<corpus root> node qualification/golden-harness/golden.mjs record yale-frame0
node qualification/golden-harness/golden.mjs verify all
```
