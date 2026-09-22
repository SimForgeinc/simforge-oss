# Native golden store + regression gate (WSB6)

Status: implemented 2026-08-22. Enforces the byte-exactness policy measured and
documented in `determinism-claim.md` (WSB4): Bevy/wgpu sensor-profile
passes are byte-stable on one pinned GPU; Chrome RGB is provably not
goldenable (0/8 and 5/6 frames byte-equal) and is excluded from this suite.

## Components

| Path | What |
|---|---|
| `qualification/golden-harness/golden.mjs` | record / verify CLI driving the native renderer binary |
| `qualification/golden-harness/scenes/*.json` | scene definitions (corpus files + renderer args + expected passes) |
| `qualification/golden-harness/goldens/<gpuFingerprint>/<scene>.json` | the golden store (committed) |
| `qualification/golden-harness/ci-local.sh` | local execution of the exact CI steps |
| `.github/workflows/native-golden.yml` | self-hosted 5080 runner workflow |

Renderer binary resolution order: `--bin` flag → `scene.binary` →
`renderer/target/release/native-render-job` (`renderer/render-core`). Scenes
with `rendererArgs` are turned into a `simforge.native-render-job/v1` job file
(one sensor camera per `cameras`, `frames` scheduled captures after `warmup`
warmup iterations); the hashed passes are the last scheduled frame's
`rgb.png` / `id.png` / `depth.f32.bin`. Every capture is a single GPU
submission with its copies ordered after the camera passes, so consecutive
frames never carry the previous frame's pixels. The former `native-render`
spike CLI (AgX output, unordered readback) is removed; goldens recorded
against it are retired and must be re-recorded (see `goldens/README.md`).

## GPU fingerprint policy

`gpuFingerprint` = first 16 hex of `sha256(canonical_json({gpus:[{name,
driverVersion, vbiosVersion, pciBusId}], kernel, arch}))`, with GPU facts from
the **same nvidia-smi query** as WSB4's
`qualification/render-determinism/gpu-fingerprint.mjs`
so fingerprint facts are comparable across Chrome evidence manifests and native goldens.
Rationale: same-device wgpu is empirically bitwise-stable; cross-driver/
cross-vendor equality is NOT claimed → goldens are keyed per fingerprint, never
universal. A new GPU/driver means: `record` on that host first, then verify.

## Golden store layout

```
goldens/<gpuFingerprint>/<scene>.json
```

The file is a full evidence manifest (below); the gates read `passHashes` and
`timings.avgFrameMs`. Committed to git so CI verifies against reviewed hashes.

## Manifest schema

Extends `simforge-oss.render-determinism-manifest.v1`; the top-level
`schema/generatedAt/claim/mode/scenario/rendererPath/hardware/verdict` keys stay
compatible. Additions:

```jsonc
{
  "schema": "simforge-oss.render-determinism-manifest.v1",
  "mode": "golden-record" | "golden-verify",
  "profile": "sensor",                    // render profile; only sensor is goldenable today
  "rendererPath": {
    "engine": "native-bevy",              // was chrome/three.js in WSB4 manifests
    "file": "renderer/target/release/native-render",
    "sha256": "…",                        // binary pin
    "invocation": { "args": ["…"] },
    "versions": { "bevy": "0.19.1", "wgpu": "29.0.4", "rustc": "…", "backend": "vulkan" }
  },
  "hardware": {                           // WSB4 host shape, minus chrome/webgl blocks
    "collectedAt": "…",
    "gpuFingerprint": "16-hex",           // NEW: the store key
    "host": { "osPrettyName": …, "kernel": …, "arch": …, "cpuModel": …,
              "hostname": …, "gpus": [{ "name", "driverVersion", "vbiosVersion", "pciBusId" }] }
  },
  "passHashes": {                         // NEW: sha256 per logical pass
    "rgb0":   { "file": "<scene>.rgb0.png",     "sha256": "…", "bytes": N },
    "id0":    { "file": "<scene>.id.png",       "sha256": "…", "bytes": N },
    "depth0": { "file": "<scene>.depth.f32.bin","sha256": "…", "bytes": N }, // raw buffer, not PNG viz
    "legend": { "sha256": "…", "diagnostic": true }                          // metadata, not gated
  },
  "corpusChecksums": [ { "path", "sha256", "bytes" } ],   // NEW: inputs pinned per golden
  "timings": {                            // NEW: perf baseline + budget fields
    "avgFrameMs": …, "p50FrameMs": …, "p99FrameMs": …, "fps": …, "measuredFrames": …,
    "baselineAvgFrameMs": …, "regressionPct": …, "budgetFactor": 1.10   // verify mode
  },
  "twoRunEvidence": { "runsCompared": 2, "byteStable": true, … }, // record mode only
  "verdict": {
    "byteStable": true, "driftedPasses": [],
    "frameTimeBudgetExceeded": false,
    "scope": "sensor-profile pass hashes, single GPU/driver/wgpu backend — cross-hardware reproducibility NOT claimed"
  }
}
```

Pass keys map to renderer outputs: `rgb0`→`<out>.rgb0.png`, `id0`→`<out>.id.png`,
`depth0`→`<out>.depth.f32.bin`, and (when WSB2 ships it) `mv0`→`<out>.mv.f32.bin`.
New passes = new key in `passFiles()` + `expectedPasses` in the scene JSON, then
re-record.

## Gates and exit codes

| Exit | Meaning |
|---|---|
| 0 | all passes match golden, frame-time within budget |
| 2 | pass-hash drift on any non-diagnostic pass |
| 3 | avg frame time regressed >10% vs recorded baseline (`GOLDEN_FRAME_BUDGET` overrides factor) |
| 4 | record-mode nondeterminism: two runs disagreed — no golden written |
| 5 | no golden exists for this GPU fingerprint — record first |
| 1 | environment/usage error (missing binary/corpus) |
| 6 | GPU busy — co-tenant load makes timings/hash evidence unreliable (`GOLDEN_GPU_WAIT` seconds to wait for a quiet window); CI sets it to 300 |
| 7 | vacuous ID pass — an ID pass encodes fewer than `idPass.minInstances` distinct ids or covers less than `idPass.minCoverage` of the frame (checked on record and verify) |
| 8 | observed actor transforms fail parity with the render timeline (`parity` scenes; Bevy profile 1e-3 m / 0.05°) |

Record runs the scene twice and refuses to write a golden unless the two runs
agree byte-for-byte (the determinism evidence itself). Record/verify only run
on a quiet GPU (see exit 6): co-tenant load was measured to inflate frame
times ~5x (4 ms → 19 ms) and occasionally destabilize the lit RGB path. Verify runs once and
applies both gates. Frame-time uses the renderer-reported steady-state
`avg_frame_ms` over ≥30 measured frames after warmup.

## Measured findings baked into this gate (2026-08-22)

1. **Multi-GLB spawn-order hygiene fix.** `check_assets` spawned tile content as
   each GLB finished loading, so entity/draw order raced async load completion.
   Fixed to spawn only after all GLBs resolve, in CLI `--glbs` order
   (`renderer/render-core/src/bin/native-render.rs`; WSB2 notified).
2. **Residual rare RGB instability under co-tenant load.** Even after the fix,
   during heavy GPU sharing (load avg ~30, 10.6/16.3 GiB VRAM in use) ~1-in-10
   processes produced a second RGB population: the same 88 scattered pixels on
   one sunlit facade differing by 1–26 LSB. ID-slot and depth outputs were
   byte-identical in every observation (30+ runs); single-GLB scenes and
   sun-off (`--lux 0`) scenes were always stable. Not correlated with load
   level, frame parity, warmup, or codegen-units in controlled probes.
   Encoded here: record requires two agreeing runs (exit 4 otherwise); gates
   run only on a quiet GPU (exit 6). Escalated to WSB2/WSB4 (lit-path owners).
3. **id0 was vacuous (fixed 2026-09-22: now gated).** Tracked spike source hardcodes
   `id_clones_done: true` at init — no ID clones are built, `.id.png` is solid
   background, no legend is written. The id0 hash stays gated (it will catch
   any accidental change) but carries no semantic evidence until WSB2
   re-enables clone building. Since 2026-09-22 every scene's ID passes are
   decoded (`lib/png.mjs`) and must encode real instances (`idPass`
   thresholds, exit 7), so a hash of a blank pass can no longer be recorded
   or pass verify. `yale-frame0`'s retired spike golden fails this gate by
   construction until it is re-recorded with `native-render-job`.
4. **Perf baselines are load-sensitive.** The recorded baseline (19.45 ms avg)
   was taken under co-tenant load; quiet-GPU steady state is ~4–5 ms (FINDINGS:
   4.33 ms). Re-record during a quiet window before trusting the +10% budget;
   exit 6 keeps CI off loaded windows.
5. **Lighting-independence expectation (stated policy).** depth0 (raw geometry)
   and id0 (unlit slot encoding) are expected to survive lighting/atmosphere
   changes, including WSB4's realism stack; only rgb0 is expected to drift when
   sensor-profile lighting changes. Verify reports per-pass verdicts so an rgb0
   re-record never masks an id0/depth0 regression.

## Golden lifecycle

Invalidation triggers — any of these means the golden must be re-recorded:
- `rendererPath.sha256` changes (new renderer binary; e.g. WSB5's job-mode
  binary uses Tonemapping::None while the spike CLI uses AgX — different RGB by
  construction, keyed separately).
- `corpusChecksums` change (spike corpus → WSB1 `.corpus/<mapId>/` decoded
  corpus alters texture/material sampling paths).
- `profile` / renderer-arg change (sun, EV100, weather, resolution, rig).
- WSB4 realism-stack landing: current yale-frame0 rgb0 golden
  (`e7185b3ae850c644…`) is **pre-realism-stack**; WSB4's default rung-2
  sensor lighting (IBL sky + 100k lux + fixed EV100) will invalidate it.

Re-record procedure:

```sh
cargo build --release -p render-core --bin native-render-job --manifest-path renderer/Cargo.toml
SIMFORGE_SENSOR_CORPUS=<corpus-root> node qualification/golden-harness/golden.mjs record yale-frame0
node qualification/golden-harness/golden.mjs verify all
```

Record appends the superseded golden to `previousVersions` in the stored JSON
(append-only), so rgb0 history is preserved across re-records and id0/depth0
lineage stays auditable. Scenes may carry `"extraArgs": [...]` appended
verbatim to the renderer invocation for forward-compatible flags (e.g.
WSB4's `--rung`, `--profile`, `--weather`).

## CI

`.github/workflows/native-golden.yml` targets `[self-hosted, Linux, X64,
gpu-rtx5080]`; jobs are serialized (`concurrency: native-golden-gpu`) because
the 5080 is shared. The runner itself may not be registered yet — until then
the workflow queues indefinitely; run `qualification/golden-harness/ci-local.sh`
locally (identical steps; log committed under
`qualification/golden-harness/evidence/`).
Registration steps are documented at the top of the workflow file.

## Render-timeline scenes (2026-09-22)

Actor scenes replay the render contract (`docs/engineering/render-timeline.md`):
a committed `simforge.scene-state.v1` document sampled from a render
timeline (`fixtures/<scene>.scene-state.json.gz`, from
`simforge render scene-state --fps 24`) is played by `scen-play
--authored-height`, so every body sits at the timeline's baked XODR height
with its road + body attitude. Three gates per run:

1. pass hashes (`frame60.rgb`, `frame60.id`), two-run byte stability on record;
2. the ID pass encodes the map's and actors' instances (`idPass`, exit 7);
3. `observed-frames.jsonl` matches the timeline sampler within the Bevy
   parity profile (`parity`, exit 8; `simforge render parity`, or
   `GOLDEN_PARITY_CMD`).

| Scene | Map | Actors | GPU fingerprint recorded |
|---|---|---|---|
| `richmond-06-timeline` | richmond-field-station | 4 (car, motorcycle, bus, wrong-way sedan) | `0c79cc9fe7b267f4` (RTX 3080, driver 595.91.07) |
| `yale-05-timeline` | yale-street | 4 (truck, car, cyclist, pedestrian) | `0c79cc9fe7b267f4` |

Corpus roots: `SIMFORGE_CORPUS_RICHMOND` / `SIMFORGE_CORPUS_YALE` →
`${SIMFORGE_MAPS_CACHE_ROOT:-~/.local/share/simforge/maps}/.corpus/<map>`.
Recorded parity (both runs): richmond max 7.8e-6 m / 1.3e-5° heading,
yale max 6.2e-5 m / 6.3e-6° heading (f32 world coordinates at ~1.8 km).

### Instance-ID assignment was not deterministic (fixed 2026-09-22)

`richmond-frame0` (static `native-render-job` over the richmond master) was
not byte-stable in `id0`: 6 of 306,176 pixels carried a different instance
id from run to run while RGB and depth were identical. It was not a depth
tie. `SceneApp::finalize_scene` numbers every mesh by sorting on
`(name, entity bits)`, and entity allocation follows async asset-load
completion; unnamed meshes were even named after their entity. So two
same-named meshes (a split primitive, an instanced prop) could swap ids.

The sort is now `(name, glTF sub-asset label `<file>#MeshN/PrimitiveM`,
world pose)`, with entity bits only as the last tie-break for exact
duplicates, and unnamed meshes are named `unnamed_mesh`. Evidence on the RTX
5080 under co-tenant load, 6 runs each:

| build | distinct id0 hashes | rgb0 | depth0 |
|---|---|---|---|
| before (entity-bit order) | 3 (`b82aee85…`, `713742cf…` ×4, `92d28b92…`) | 1 | 1 |
| after | 1 (`b3feedec…`, 12/12 runs) | 1 | 1 |

Instance ids of existing scenes are renumbered once by this change (goldens
that hash an ID pass must be re-recorded). `richmond-frame0` is committed as a
scene; record its golden per GPU with a quiet window.
