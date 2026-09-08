# Clip → replayable scene

Input contracts, importers, reconstruction and validity gates for closed-loop evaluation on
recorded clips.

The product claim this module has to keep honest is narrow: **a recorded drive can carry a
policy only inside a region we measured.** Outside it, the renderer extrapolates unobserved
surface and the recorded actors replay a drive that did not happen — so the episode is
truncated, not scored as a model failure. Everything here exists to make that boundary
explicit, measured and enforced.

## Documents

| Schema | Produced by | Meaning |
|---|---|---|
| `simforge.eval-clip/v1` | user upload, dataset export | recorded frames plus the sidecars that make them metrically interpretable |
| `simforge.replay-context/v1` | the importers here | a world a closed loop can execute, with its measured validity envelope |

Canonical bundle file: `<bundleDir>/replay-context.json`.

### Cross-owner field contract (frozen)

The Python episode runner reads the bundle directly, with no TypeScript import. These paths
are a breaking change if renamed:

- `validity.envelope.lateralM` / `.longitudinalS` / `.headingRad`
- `validity.qualified` — `false` means **refuse the model episode**
- `ego.recordedPath[] = {tUs, x, y, headingRad}`, `ego.originUs`, `ego.endUs`
- `cameras[].cameraId` (0..6, the inference-wire camera index)
- `qualification/stock-replay.json` — the G5 verdict the campaign runner checks as a precondition

## What is refused, and why

No input is ever padded to make it evaluable.

| Input | Outcome |
|---|---|
| Video with no calibration / no ego history | `missing_fields` listing `cameras`, `ego`; offered the frame-only text tasks (VQA, meta-actions, auto-labelling), explicitly labelled as not a driving evaluation |
| Calibrated clip, no seed point cloud | reconstruction refused — 3DGUT initialises from a measured point cloud, and seeding from noise would produce a confident scene that is not the user's world |
| Calibrated clip, planar ego path only | reconstruction refused — `ego.recordedPose6dof` required; zero roll/pitch builds a flat world that never existed |
| f-theta rig on the COLMAP reconstruction path | refused — no COLMAP camera model expresses an f-theta polynomial, and refitting to `OPENCV_FISHEYE` would silently change the calibration. Needs the NCore v4 path (`pip install nvidia-ncore`) |
| Encoded video for reconstruction | **supported** — frames are extracted with the pinned ffmpeg the desktop already ships, and every frame's container timestamp is verified against the manifest before it is used. Refused only when timestamps are absent, the frame counts disagree, or the container timing drifts more than 20 ms from the declared timing |
| Scene with no dynamic tracks | refused unless `dynamics` is declared with an explicitly empty track list — "no other road users" and "actors were never tracked" are different facts |
| AlpaSim scene not in the local cache | refused with the exact artifact, revision and path — the dataset is gated and non-redistributable, so nothing is fetched implicitly |

## Gates and thresholds

Thresholds are admission floors, fixed before any result was produced. Each verdict carries
its own `rationale` string, so no consumer has to trust an unexplained constant.

| Gate | Measures | Threshold | Basis |
|---|---|---|---|
| G1 | PSNR/SSIM of re-renders at recorded poses, **worst camera** | ≥ 22 dB and ≥ 0.75 SSIM | Renders at recorded poses are near-training views, so they should beat published novel-view quality comfortably; this floor fails a broken or mis-posed reconstruction while passing a legitimately hard night capture. Provisional: tightened from the measured distribution once three sequences pass (the reconstruction path stays beta until then) |
| G2 | *Newly* unsupported pixels at ±0.5/1.0/1.5 m and ±5°, vs the on-trajectory baseline | ≤ 2% | Above this the renderer is showing unobserved surface as a hole rather than an edge artefact. Baseline subtraction keeps a scene from being punished for its sky |
| G3 | Re-derived 16-step ego history vs the recorded poses | ≤ 0.01 m, ≤ 0.001 rad | Numerical, not physical: both sides come from the same poses, so anything larger is a derivation bug |
| G4 | Track-to-camera time skew; recorded actors intersecting the recorded ego path | ≤ 20 ms; exactly 0 intersections | Half a decision period at 10 Hz. An intersection means tracks and ego disagree about the world |
| G5 | Replaying the recorded trajectory through the full sim/executor/scoring chain | max ≤ 0.35 m, p95 ≤ 0.10 m, 0 infractions | `docs/policy-step.md` bounds the pure-pursuit executor at p95 cross-track ≤ 0.35 m (measured there: p50 0.14 / p95 0.24 / max 0.29); the NuRec importer's own accepted report records ego replay at p95 0.0039 m / max 0.163 m. G5 qualifies our chain, never a model |

The **envelope** is the largest probed offset that passed *with every smaller offset also
passing*. A scene that fails at 0.5 m but passes at 1.5 m yields a zero-width envelope, not a
1.5 m one. Zero width is a valid on-trajectory-replay-only scene, not an error.

`validity.qualified` is true only when all five gates pass. A `synthetic-fixture` bundle can
never be qualified — the schema rejects it.

## Reconstruction

Real upstream tooling, driven not reimplemented:

1. clip → COLMAP text dataset (`sparse/0/{cameras,images,points3D}.txt`), poses converted to
   COLMAP's world-to-camera convention;
2. `python train.py --config-name apps/colmap_3dgut.yaml path=<dataset> out_dir=<runs>
   experiment_name=<id> export_usd.enabled=true export_usd.format=nurec`
   (upstream [`nv-tlabs/3dgrut`](https://github.com/nv-tlabs/3dgrut));
3. exported NuRec `.usdz` → `importUserBundle` → gates.

Rendering for G1/G2 uses the shipped `simforge-oss-splat` durable job
(`simforge.render-bundle-nurec/v1`, `renderer/splat/python/simforge_splat/job.py`). No
renderer code is modified by this module.

### External prerequisites (not satisfiable in-repo)

| Prerequisite | Needed for | Status on this host |
|---|---|---|
| 3DGRUT checkout + compiled tracer (`THREEDGRUT_ROOT`) | reconstruction **and** splat rendering | pinned, not yet provisioned on this host |
| NVIDIA Kaolin for the installed torch/CUDA | splat rendering | pinned, not yet provisioned |
| CUDA PyTorch | both | present (torch 2.11.0+cu128, CUDA 12.8, device available) |
| numpy + Pillow | `replay_measure.py` | present |
| ffmpeg/ffprobe built from pinned source | frame extraction from encoded video | shipped by the desktop (`studio/desktop/encoders.lock.json`); resolved at runtime |
| `nvidia-ncore` | the NCore v4 reconstruction path (f-theta rigs) | optional; absence is an explicit capability restriction, never a silent remap |
| A NuRec `.usdz` scene package | any import/render of a real scene | not in-repo; gated, non-redistributable |

These are **installable prerequisites, provisioned onto product-owned worker images and
storage** — not permanent blockers, and never satisfied by borrowing a research host or
allocation. The pins live in `tier-lock.ts` as the single source of truth:

| Component | Pin |
|---|---|
| 3DGRUT | `nv-tlabs/3dgrut` @ `a37ef721012dea0f29c0fcfff2d525023b4e854a` — the same revision `renderer/splat/PROVENANCE.json` documents the NuRec splat port against, so the reconstruction tier and the shipped renderer share one upstream revision |
| Kaolin | NVIDIA Kaolin `0.18.0` from NVIDIA's index for the image's exact torch/CUDA (the PyPI project of the same name is unrelated and is never a substitute) |
| torch | `>=2.8`, CUDA build matching the driver; the tracer compiles against it, so they are resolved together |

`BUILD_VERIFIED` is `false` and stays false until every item in `BUILD_EVIDENCE` has been
produced on the image that will run the work. `preflightReconstruction` compares a resolved
checkout's `HEAD` against the pin and fails when they differ — gate numbers measured against a
different upstream revision are not comparable with anything else recorded.

Provisioned and exercised on this host (2026-09-08): the tracer compiles and imports, Kaolin
0.18.0 matches the pin, and a real scene renders through `simforge-oss-splat` at four cameras.
The reconstruction path has not yet been exercised, which is why the flag stays false.

### Measured on a real scene

Scene `007a5809` (PhysicalAI-AV NuRec; package sha256 verified against the digest pinned in its
own `background.json`), through the provisioned tier:

| Gate | Measured | Threshold | Verdict |
|---|---|---|---|
| G1 on-trajectory | 19.67 dB (30° tele; the three 120° cameras are 22.9–25.3 dB) | ≥ 22 dB | **fail** |
| G2 off-trajectory | 0.84% at 0.5 m, 1.59% at 1.0 m, 2.15% at 1.5 m, 6.80% at 5° | ≤ 2% | pass, envelope 1.0 m |
| G3 ego-history parity | 0.000 m | ≤ 0.01 m | pass |
| G4 dynamics | 197.3 ms | ≤ 200 ms | pass |

The bundle is `qualified: false` with a **zero-width** envelope: the 1.0 m G2 measured is not
written, because an envelope means nothing on a scene whose on-trajectory renders did not hold
up. The tele failure was investigated, not excused — rendering at the frames' exact instants
instead of on the 10 Hz tick grid moved it 0.19 dB, refuting temporal quantisation and leaving
genuine reconstruction quality at distance. So this scene cannot serve any rig preset
containing the tele camera. Every superseded measurement is retained in `GATE-CHANGES.md`.

Absence surfaces as a `capability_error` from `scene reconstruct --preflight-only` and from
the render tier, before any GPU is allocated — never as a crash or a fake success.

## CLI

```sh
S=node packages/evaluation/dist/replay-context/cli.js   # or tsx src/replay-context/cli.ts

$S admit       --clip <dir>                                   # what can this clip do, and why not
$S import      --package <usdz> --license <id> --out <dir>    # NuRec artifact  -> bundle
$S import      --scene-dir <dir> --license <id> --out <dir>   # imported scene  -> bundle
$S import      --alpasim-root <dir> --scene <id> --suite public_2601 --license <id> --out <dir>
$S import      --clip <dir> --geometry <usdz> --out <dir>     # user bundle     -> bundle
$S qualify     --bundle <dir> --scene-dir <dir> --catalog <dir> --hood none
$S reconstruct --preflight-only
$S reconstruct --clip <dir> --out <dir> [--iterations N] \
               [--ffmpeg <path> --ffprobe <path> | --desktop-manifest <runtime-manifest.json>]
```

Exit codes follow `AGENTS.md`: `0` done, `1` could not run (bad flags or a missing
capability), `2` ran and refused the input. Errors print the compute worker envelope
`{error: {code, retryable: false, message, fields?}}` on stderr, so a refusal is classified
non-retryable instead of re-billing the same rejection.

## Proof commands

Run these in the integrated validation phase, not mid-flight.

**Behaviour regressions (no GPU, no dataset, fixtures are in-repo and license-clean):**

```sh
cd packages/evaluation && npx vitest run src/replay-context/__tests__/replay-context.test.ts
```

Covers: video-only refusal with the exact field list, reconstruction refusal without seed
geometry, camera-set family capability, envelope truncation at 2 m with `envelope_exceeded`,
in-envelope acceptance at 0.5 m, path-projection (not vertex-snap) deviation, time-support
exit, the G2 first-failure envelope rule, G4 ego/track intersection, and the schema
invariants that a bundle cannot claim qualification with a failing gate or as a synthetic
fixture.

**Negative envelope proof, standalone:**

```sh
node --experimental-strip-types -e "
  const {loadReplayContext,createEnvelopeMonitor}=await import('./packages/evaluation/src/replay-context/index.ts');
  const b=await loadReplayContext('packages/evaluation/src/replay-context/fixtures/straight-envelope');
  const m=createEnvelopeMonitor(b);
  console.log(JSON.stringify(m.check({tUs:b.ego.originUs+1e6,x:10,y:2,headingRad:0}),null,2));"
```

Expected: `inside: false`, `term: "envelope_exceeded"`, `breached: ["lateral"]`.

**Capability probe (no GPU work, expected to fail on a host without 3DGRUT):**

```sh
node packages/evaluation/dist/replay-context/cli.js reconstruct --preflight-only
# exit 1, stderr: {"error":{"code":"capability_error","retryable":false,...}}
```

**Real calibrated scene (needs the gated dataset package on the executing host):**

```sh
# 1. import an imported NuRec scene directory + its source package
$S import --scene-dir <sceneDir> \
          --package <.../<uuid>.usdz> \
          --license "NVIDIA PhysicalAI-AV Dataset License (non-redistributable)" \
          --out /tmp/rc-bundle

# 2. measure G1/G2 and write the envelope (requires THREEDGRUT_ROOT + CUDA + Kaolin)
$S qualify --bundle /tmp/rc-bundle --scene-dir <sceneDir> \
           --catalog <glbCatalogDir> --hood <hoodDir|none> --threedgrut-root $THREEDGRUT_ROOT
```

A local imported-scene fixture of the shape step 1 consumes exists outside the repo at
`/home/path/tmp/scenario-generation-rethink-2026-09-04/implementation/nurec-fixture/007a5809-8a56-40b5-8af5-7e0f65229496`
(sidecars only; its `.usdz` is the external, gated prerequisite). It is **not** copied into
the repository: it derives from the PhysicalAI-AV NuRec dataset, which is gated and
non-redistributable.

## Frame extraction

Encoded calibrated video is extracted with the `ffmpeg`/`ffprobe` the desktop stage builds
from Git-pinned source (`studio/desktop/encoders.lock.json` → `studio/tools/`), spawned as
separate programs and never linked. That build keeps FFmpeg's internal decoders (H.264, HEVC,
VP9, MJPEG, ProRes, AV1) but is `--disable-network`, so an input is always a local file — a URL
is refused up front rather than failing later as a protocol error that reads like a corrupt
clip. Resolution order: explicit paths, then
`SIMFORGE_FFMPEG`/`SIMFORGE_FFPROBE`, then the staged desktop runtime manifest, then `PATH`
(recorded as an unpinned build in provenance).

Timestamp integrity is the point of the step, not a side effect. Two independent sources must
agree before a frame is used: the container's own per-frame presentation timestamps (via
`ffprobe`, preferring `best_effort_timestamp_time`) and the clip manifest's declared
`cameras[].timing`. Frames are extracted one-per-decoded-frame (`-vsync 0`, no re-encode, no
resampling) and named `<absoluteTimestampUs>.png`, matching the NuRec packages' own convention.
Extraction refuses — rather than renumbering to fit — when timestamps are unreadable, the
counts disagree, or elapsed time drifts more than 20 ms (the same bound G4 applies to
actor/camera alignment). Each of those is a real defect that would shear the imagery against
the ego history.

## Truncated episodes never become scores

`outcome.ts` owns one rule: an episode that left the envelope produced real numbers up to the
breach and nothing trustworthy after it. `classifyEpisodeOutcome` marks it
`succeeded: false`, `aggregateEligible: false`, `diagnosticsOnly: true` regardless of how far
it got, and `partitionOutcomes` is the single place a run is split into `aggregate` (complete,
in-envelope — the only episodes a headline score, comparison or promotion may use) and
`diagnostic` (retained, reported, never averaged in). The partition also returns counts, so a
report always states how many episodes were held out and why. "It drove well for eight seconds
before the world ran out" is a statement about the scene, not a model result.

## Licensing and provenance

- Every bundle records `source.license` (never guessed — the importers require it) and
  `source.redistributable`, which is `false` for all dataset-derived scenes.
- Dataset bytes, NuRec packages and reconstructions of licensed clips are never committed and
  are never release assets.
- In-repo fixtures are authored here, contain no third-party bytes, and are marked
  `source.kind: "synthetic-fixture"` so they cannot be scored.
- AlpaSim imports record the suite, artifact uuid, NRE version and dataset revision, which is
  the only basis on which a SimForge number and an AlpaSim number could be compared.
