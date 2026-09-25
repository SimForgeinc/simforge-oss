# Native golden store + regression gate

Render goldens are recorded and verified on **Mesa lavapipe** (the CPU Vulkan
driver), the adapter of record. Pass hashes are compared exactly, never with a
tolerance. The merge gate runs the suite (`scripts/gate-local.sh`, step
`goldens`) whenever the renderer, the engine core, the harness, its fixtures or
the catalog changed.

Why lavapipe:
- With every draw order made a function of the scene, two identical runs on an
  RTX 3080 still differed by 1 LSB in a few pixels (2 px in 1 of 64 RGB
  frames, Belmont 8 cameras). That is driver-level, not ours.
- The fixes for draw order (vendored bevy_render: sorted phases tie-break by
  entity, entity-ordered bins; CPU-ordered ID-pass draws) made the ID pass
  identical between runs on the 3080.
- Lavapipe renders byte-identical runs (richmond-06, 120 ticks, twice).

The NVIDIA residual, measured on an RTX 3080 (driver 595.91), Belmont 8 cameras × 24 ticks. Each row is two identical runs:

| Configuration | RGB frames that differ between runs |
|---|---|
| showcase preset | 7 / 216 |
| SSR off | 6 / 216 |
| SSAO and contact shadows off | 2 / 216 |
| SSAO, contact shadows, SSR, bloom and AA all off | 8 / 216 |

Differences are at most 1 LSB in a handful of pixels. They survive with every screen-space effect off and every draw order fixed, while the same code on lavapipe is byte-identical. What remains on the GPU is forward shading, shadow rasterization and the atmosphere/sky compute passes. The residual is treated as driver-level floating-point nondeterminism and is not chased further; goldens stay on lavapipe.

## Components

| Path | What |
|---|---|
| `qualification/golden-harness/golden.mjs` | record / verify / plan CLI driving the renderer binary (plain Node, no dependencies) |
| `qualification/golden-harness/scenes/*.json` | scene definitions (corpus files, render job, expected passes) |
| `qualification/golden-harness/goldens/<gpuFingerprint>/<scene>.json` | the golden store (committed) |
| `qualification/golden-harness/fixtures/` | committed scene-state and render-timeline inputs for the actor scenes |
| `qualification/golden-harness/ci-local.sh` | the suite as the gate runs it: build `simforge-render` and the `render-parity` example, prepare the verified sky plates, plan every scene, then verify (or `record`, then verify) |

Renderer binary resolution order: `--bin` flag → `GOLDEN_RENDER_BIN` →
`target/release/simforge-render` (the one renderer binary,
`cargo build --release -p simforge-render`). Every scene is turned into a
`simforge.render-job/v2` job file (scene spec, optional `sceneState`, the rig,
`ticks`, `passes`) and rendered with `simforge-render job --job <file>`; the
hashed passes are the `<sensor>/<tick:08>.<pass>.png` / `.depth.f32.bin`
artifacts listed with their sha256 in the job's `results.json`. The harness
runs the job on the lavapipe ICD with `SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER=1`.
Every capture is a single submission with its copies ordered after the camera
passes, so consecutive frames never carry the previous frame's pixels.

## Adapter fingerprint policy

`gpuFingerprint` = first 16 hex of `sha256(json({adapter: {deviceName,
driverInfo}, cpuModel, arch}))`. `deviceName` and `driverInfo` come from
`vulkaninfo --summary` on the lavapipe ICD (for example `llvmpipe (LLVM 20.1.2,
256 bits)`, `Mesa 25.2.8 (LLVM 20.1.2)`). The CPU model is included because
llvmpipe's generated code depends on the CPU's features. A new Mesa, LLVM or
CPU model means: `record` on that host first, then verify
(`qualification/golden-harness/lib/fingerprint.mjs`).

## Golden store layout

```
goldens/<gpuFingerprint>/<scene>.json
```

The file is a full evidence manifest (below); the gates read `passHashes`.
Committed to git so the gate verifies against reviewed hashes. The current
entry is listed in `qualification/golden-harness/goldens/README.md`.

## Manifest schema

Schema `simforge-oss.render-determinism-manifest.v1`:

```jsonc
{
  "schema": "simforge-oss.render-determinism-manifest.v1",
  "mode": "golden-record" | "golden-verify",
  "rendererPath": {
    "engine": "native-bevy",
    "file": "target/release/simforge-render",
    "sha256": "…",                        // binary pin
    "invocation": { "args": [ … ], "job": { … } },   // the command and the full render job
    "versions": { "bevy": "0.19.1", "wgpu": "…", "rustc": "…", "backend": "vulkan" }
  },
  "hardware": {
    "collectedAt": "…",
    "gpuFingerprint": "16-hex",           // the store key
    "host": { "adapter": …, "osPrettyName": …, "kernel": …, "arch": …, "cpuModel": …, "cpuCount": … }
  },
  "renderConfig": { … },
  "passHashes": {                         // sha256 per logical pass (the scene's expectedPasses)
    "chase.t60.rgb": { "file": "chase/00000060.rgb.png", "sha256": "…", "bytes": N },
    "chase.t60.id":  { "file": "chase/00000060.id.png",  "sha256": "…", "bytes": N }
  },
  "idPasses": { … },                      // decoded instance counts and coverage per ID pass
  "parity": { … },                        // parity scenes: observed transforms vs the timeline sampler
  "corpusChecksums": [ { "path", "sha256", "bytes" } ],   // inputs pinned per golden
  "sceneStateSha256": "…",
  "timings": { "avgFrameMs": …, "p50FrameMs": …, "p99FrameMs": …, "fps": …, "measuredFrames": … },
  "twoRunEvidence": { "runsCompared": 2, "byteStable": true, … }, // record mode only
  "previousVersions": [ … ],              // superseded goldens, append-only
  "verdict": {
    "byteStable": true, "driftedPasses": [],
    "scope": "render-job pass hashes (pinned capture clock), one lavapipe build on one CPU model (the adapter of record) — cross-adapter reproducibility NOT claimed"
  }
}
```

Pass keys are the scene's `expectedPasses`; `passPaths` maps each to its
artifact under the job's output directory. A new pass is a new key in both,
then a re-record.

## Gates and exit codes

| Exit | Meaning |
|---|---|
| 0 | all passes match golden (and frame time within budget when `GOLDEN_FRAME_BUDGET` is set) |
| 1 | environment/usage error (missing binary/corpus) |
| 2 | pass-hash drift on any non-diagnostic pass |
| 3 | avg frame time regressed beyond `GOLDEN_FRAME_BUDGET` (e.g. 1.10) vs the recorded baseline; opt-in, since lavapipe times measure the CPU host |
| 4 | record-mode nondeterminism: two runs disagreed — no golden written |
| 5 | no golden exists for this adapter fingerprint — record first |
| 7 | vacuous ID pass — an ID pass encodes fewer than `idPass.minInstances` distinct ids or covers less than `idPass.minCoverage` of the frame (checked on record and verify) |
| 8 | observed actor transforms fail parity with the render timeline (`parity` scenes; Bevy profile 1e-3 m / 0.05°) |
| 9 | non-finite (NaN/inf) pixels in a frame before tone mapping |
| 10 | the scene declares `recording: "unrecorded"`: it has no hashes yet, so verifying it fails |

Record runs the scene twice and refuses to write a golden unless the two runs
agree byte-for-byte (the determinism evidence itself). Verify runs once.

Pass expectations: depth (raw geometry) and ID (unlit slot encoding) passes
are expected to survive lighting and atmosphere changes; only RGB is expected
to drift when lighting changes. Verify reports per-pass verdicts so an RGB
re-record never masks an ID or depth regression.

Instance ids are assigned deterministically: every mesh is numbered by
sorting on `(name, glTF sub-asset label <file>#MeshN/PrimitiveM, world pose)`,
with entity bits only as the last tie-break for exact duplicates, and unnamed
meshes are named `unnamed_mesh`. Scene-state playback uses the same ordering.

## Golden lifecycle

Goldens are valid only for the exact tuple recorded in each file. Any of these
means the golden must be re-recorded:
- `rendererPath.sha256` changes (a new renderer binary);
- `corpusChecksums` or `sceneStateSha256` change (new scene inputs);
- the render config or job changes (sun, EV100, weather, resolution, rig);
- the adapter fingerprint changes (a new Mesa, LLVM or CPU model).

Record appends the superseded golden to `previousVersions` in the stored JSON
(append-only), so RGB history is preserved across re-records and ID/depth
lineage stays auditable.

## Running it

Corpus roots come from each scene's `corpusRootEnv`: `SIMFORGE_CORPUS_RICHMOND`
and `SIMFORGE_CORPUS_YALE`, which default in the gate to
`${SIMFORGE_MAPS_CACHE_ROOT:-~/.local/share/simforge/maps}/.corpus/<map>`, the
native install that `simforge maps pull <map>` writes. Actor scenes also read
the CARLA model packs pinned in `catalog/closures.lock.json`, fetched by digest
and verified before any render.

```sh
qualification/golden-harness/ci-local.sh           # plan + verify every recorded scene
qualification/golden-harness/ci-local.sh record    # re-record every scene, then verify

# One scene by hand:
cargo build --release -p simforge-render
node qualification/golden-harness/golden.mjs plan all
node qualification/golden-harness/golden.mjs record <scene>
node qualification/golden-harness/golden.mjs verify all
```

## In the merge gate

Goldens run in the merge gate (`scripts/gate-local.sh`, step `goldens`,
sandboxed, on lavapipe) whenever the renderer, the engine core, Cargo, the
harness or `catalog/` changed, beside the `rust` and `python` steps, which start
at the same time.

- **Scheduling** (`ci-local.sh`): scenes start longest first (the last run's
  per-scene durations, kept in the XDG cache), each once the memory not yet used
  (the cgroup's limit minus its anonymous memory, and the host's MemAvailable)
  covers `GOLDEN_MEM_GB` (15; a map scene holds up to ~14 GB on lavapipe) plus what
  the running scenes may still grow into; the first always starts; at most
  `GOLDEN_JOBS` (3).
- **Skip by content, never by path**: `golden.mjs key <scene|all>` hashes
  everything a scene's verify reads (the built `simforge-render` and
  `render-parity` binaries, the job with paths normalised and every file it names,
  the pinned packs, the sky pins, the parity timeline, the golden record, the
  lavapipe identity and environment, the harness sources). A scene whose key a
  sandboxed merge-gate PASS recorded in `$GATE_HOME/goldens-pass.jsonl` (HMAC'd
  with the gate key; the step never sees the key or writes the ledger) is not
  rendered again. Release builds are deterministic (two clean builds of `main`:
  identical binaries), so any change that reaches the renderer binary re-renders.
- **Nightly full run**: the merge service runs the gate on `main` with
  `GOLDENS_FULL=1` (every scene, no skips) each night; a red night invalidates the
  ledger, so every later gate renders every scene until a full PASS.

Local runs (`ci-local.sh verify`, or the gate without a sandbox) render every
scene unless you point `GOLDEN_PASS_LEDGER` at `<key> <sha>` lines you trust.

## Render-timeline scenes

Actor scenes replay the render contract (`docs/engineering/render-timeline.md`):
a committed `simforge.scene-state.v1` document sampled from a render
timeline (`fixtures/<scene>.scene-state.json.gz`, sampled at 24 fps) is played by `simforge-render job
--job` (the job's `sceneState`), so every body sits at the timeline's baked
height with its road + body attitude. Three gates per run:

1. pass hashes, with two-run byte stability on record;
2. the ID pass encodes the map's and actors' instances (`idPass`, exit 7);
3. `observed-frames.jsonl` matches the timeline sampler within the Bevy
   parity profile (`parity`, exit 8; graded by the `simforge-core` example
   `render-parity`, which `ci-local.sh` builds, or by `GOLDEN_PARITY_CMD`).

| Scene | Map | Actors |
|---|---|---|
| `richmond-06-timeline` | richmond-field-station | 4 (car, motorcycle, bus, wrong-way sedan) |
| `yale-05-timeline` | yale-street | 4 (truck, car, cyclist, pedestrian) |
| `package-smoke-richmond` | richmond-field-station | 1 (ambulance), from the release smoke package `fixtures/scenario-package/smoke/richmond-public.scenario.zip`; declares `recording: "unrecorded"` until its first lavapipe record |
