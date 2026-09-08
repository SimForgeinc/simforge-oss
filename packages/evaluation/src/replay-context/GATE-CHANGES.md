# Gate change record

A validity gate that can be adjusted after seeing a result is not a gate. This file records
every change to what a gate measures or where its threshold sits, together with the
measurements that were superseded, so a later reader can check that a scene passed because it
is good rather than because the bar moved.

Rules this record exists to keep honest:

- A gate definition or threshold may change **before** the measurement it governs has produced
  a result, and the reasoning must be independent of any scene's numbers.
- A superseded measurement is written down here, not deleted.
- A threshold is never moved to make a specific scene pass. If a real scene sits close to a
  bound, that closeness is reported rather than smoothed away.

---

## 2026-09-07 — G4 changed from clock-coincidence skew to track sampling interval

**Status when changed:** no renderer had been run and no G1/G2/G5 result existed. G4 and G3
are the CPU-only gates, so this change was made before any rendered evidence could have
influenced it.

**Scene used:** PhysicalAI-AV NuRec `007a5809-8a56-40b5-8af5-7e0f65229496`, package sha256
`36665d69be03ff99b6e2f44916a6b3712e1b8d74b6dfeb837e10e575a3d592f7`, verified against the digest
pinned in the scene's `background.json`. Gated, non-redistributable; read in place from
product-owned storage, never copied into the repository.

### What G4 measured before

"Maximum `|actor track sample time − camera timestamp|`, threshold 20 ms (half a decision
period at 10 Hz)", with camera timestamps taken from the package's `frames/<sensor>/<us>.jpeg`
members.

### Superseded measurements, retained

| Attempt | Metric | Measured | Threshold | Verdict |
|---|---|---|---|---|
| 1 | skew vs. camera timestamps read from `frames/` members | **19,840,559 µs** (19.84 s) | 20,000 µs | FAIL |
| 2 | skew vs. the recorded rig clock (`ego.recordedPath`) | **70,629 µs** (70.6 ms) | 20,000 µs | FAIL |
| 3 (current) | coarsest actor-track sampling interval | **197,318 µs** (197.3 ms) | 200,000 µs | pass, margin 1.3% |

### Why the first two were wrong

Attempt 1 rested on a false assumption about the data: the NuRec AV releases publish **one
reference frame per camera**, not the recorded sequence. This package contains four members
under `frames/`, one per camera, for a 20 s four-camera drive. Treating those instants as a
capture timeline turned the scene into four one-frame cameras and produced a ~20 s "skew" that
described our misreading, not the scene. Camera timing now carries an explicit
`reference-frames` kind so the instants are labelled for what they are.

Attempt 2 fixed the data misreading but kept a metric that cannot mean what it claimed.
Recorded actors are replayed by **interpolating** their trajectories at the render instant
(`providers/nurec.Traj.at`: position lerp, quaternion nlerp), so coincidence between a track
sample and any clock tick is irrelevant to render fidelity. Worse, nearest-tick distance is
bounded by half the clock period by construction — ~50 ms at 10 Hz — so the measurement was
reporting a property of the sampling grid, and a 20 ms threshold on it was unsatisfiable for
any 10 Hz source regardless of scene quality.

### What G4 measures now, and why 200 ms

The quantity that actually limits replay fidelity is how far apart the samples being
interpolated are. For a vehicle turning at yaw rate ω, the chord-vs-arc error over a sampling
gap Δt is approximately `v·Δt²·ω/8`. At 15 m/s and 0.3 rad/s that is ~2 cm at 200 ms and ~14 cm
at 500 ms. A bound of 200 ms — two decision periods — keeps an interpolated actor pose well
inside its own footprint between samples. The threshold follows from that error model, not
from any measured scene.

G4 additionally requires zero recorded-actor/recorded-ego footprint intersections (an
intersection means tracks and ego are not in the same frame or clock) and zero published camera
reference instants outside the recorded window (which would mean the frames and the trajectory
are different drives).

### Reported honestly

The real scene passes at **197.3 ms against a 200 ms bound — a 1.3% margin**. The sparsest
track in a published NVIDIA scene sits essentially at this threshold. That is recorded here
rather than presented as a comfortable pass, and it means the bound cannot be tightened without
failing upstream scenes. If a future scene fails G4 marginally, the question to ask is whether
its tracks are genuinely sparser, not whether the threshold should move.

### Unchanged by this

G1, G2, G3 and G5 definitions and thresholds are untouched. G1/G2/G5 remain unmeasured: they
need the renderer, which needs the 3DGRUT tracer build.


---

## 2026-09-07 — G4's frame-window check re-pointed at the reconstruction's time support

**Status when changed:** still no renderer result; G1/G2/G5 unmeasured.

**Same scene** as above, imported through the *scene-directory* path (sidecars +
hash-verified package) rather than the package-only path.

### Superseded measurement, retained

| Metric | Measured | Verdict |
|---|---|---|
| published reference instants outside the **episode** window | **4 of 4** | FAIL |
| published reference instants outside the **reconstruction's time support** | **0 of 4** | pass |

### Why the first was wrong

The two windows are not the same thing and the check was using the wrong one:

- reconstruction time support (`background.metadata.timeRangeUs`): 7,109,278,000 – 7,129,278,000 µs
- evaluated episode (`ego-reference.json`): 7,112,500,060 – 7,132,500,060 µs
- the four published reference frames: 7,109,393,945 – 7,109,458,707 µs

The frames sit **3.1 s before the episode starts** but comfortably inside the reconstruction.
They are frames of the same drive; the episode is simply a 20 s window selected from a longer
recording. Failing them said only that we had compared against the wrong interval. The check's
purpose — "do the frames and the trajectory describe the same drive?" — is answered by the
reconstruction's extent, so the bundle now carries `geometry.timeSupportUs` and G4 uses it.

### A real finding this surfaced, kept rather than smoothed

The episode's ego reference runs **3,222,060 µs (3.22 s) past the end of the reconstruction's
support** (`egoBeyondSupportUs`). Those last 3.22 s cannot be rendered at all — the splat
backend rejects a tick outside support — so an episode driven to the end of the ego reference
would leave the renderable world before it ran out of trajectory.

This is now enforced rather than merely reported: `createEnvelopeMonitor` clamps the
enforceable window to the **intersection** of the episode and the reconstruction support, so
an episode entering that tail truncates with `envelope_exceeded` / `time-support` instead of
being rendered from geometry that does not exist. G4 reports the overhang in its detail so the
scene's shortfall is visible in the bundle.


---

## 2026-09-08 — G2's unsupported-pixel test could never fire

**Status when changed:** found by the first real render, and fixed before the coverage numbers
it produces were used for anything. Both the vacuous and the corrected measurements are below.

### The defect

`_unsupported_mask` treated a pixel as having no surface when its depth was non-finite or
non-positive. A splat render never produces either: sky and no-hit pixels come back as finite,
positive depth in the hundreds to thousands of metres. Measured on the real renders, `<=0`
pixels: **0 of 2,073,600** per frame; depth ranged 2.12 m – 19,011 m.

So G2 measured **exactly zero newly-unsupported pixels at every offset** and passed
unconditionally. A gate that cannot fail is worse than one that fails wrongly: it had already
"passed" at ±1.5 m and 5°, which would have written a 1.5 m envelope licensing renders nobody
had checked.

### Corrected definition

A pixel is unsupported when depth is non-finite, non-positive, **or at/beyond the camera's
calibrated far plane** (`farM`, 1000 m for this rig) — the renderer's own statement of "no
surface within range". Baseline subtraction against the on-trajectory render is unchanged, so
a scene is not charged for its standing sky.

### Superseded and corrected measurements, same renders

| Probe | Vacuous mask | Corrected mask | vs 2% |
|---|---|---|---|
| lateral 0.5 m | 0.000 | **0.0084** | pass |
| lateral 1.0 m | 0.000 | **0.0159** | pass |
| lateral 1.5 m | 0.000 | **0.0215** | FAIL |
| heading 5° | 0.000 | **0.0680** | FAIL |

The corrected numbers rise monotonically with displacement, which is the behaviour the metric
claims to have and the vacuous one could not exhibit.

---

## 2026-09-08 — First real G1/G2 measurement (result, not a change)

Scene `007a5809`, package sha256 `36665d69…`, rendered through the provisioned tier: 3DGRUT at
the pinned `a37ef721…`, Kaolin 0.18.0, torch 2.8.0+cu128, CUDA 12.8.1, `simforge-oss-splat`.
Four cameras (ids 0, 1, 2, 6), 4 ticks per probe, 5 probes.

| Gate | Measured | Threshold | Verdict |
|---|---|---|---|
| G1 on-trajectory fidelity (worst camera) | **19.67 dB / 0.760 SSIM** | ≥ 22 dB / 0.75 | **FAIL** |
| G2 off-trajectory coverage | largest passing offset **1.0 m lateral**, 5° heading fails | ≤ 2% | pass |
| G3 ego-history parity | 0.000 m | ≤ 0.01 m | pass |
| G4 dynamics | 197.3 ms | ≤ 200 ms | pass |

**`validity.qualified` is false and the recorded envelope is zero-width.** G1 failed, so the
1.0 m envelope G2 measured is deliberately *not* written into the bundle — an envelope is only
meaningful on a scene whose on-trajectory renders were trustworthy in the first place.

Per-camera G1, on trajectory:

| Camera | PSNR | SSIM |
|---|---|---|
| cross-left 120° | 24.07 dB | 0.905 |
| front-wide 120° | 22.89 dB | 0.872 |
| cross-right 120° | 25.32 dB | 0.913 |
| **front-tele 30°** | **19.67 dB** | **0.760** |

Three of four cameras clear the bar; the 30° tele fails it. The threshold is **not** being
lowered to accommodate this. Two candidate explanations are untested and are recorded as
hypotheses, not conclusions:

1. *Temporal quantisation.* Renders are placed on a 10 Hz tick grid while the ground-truth
   frames sit at arbitrary instants; the tele frame is 19.3 ms from its nearest tick, ~0.19 m
   of ego motion at this speed. A narrow-FoV camera is penalised far more than a 120° one by
   the same longitudinal error, which is consistent with the tele being the only failure.
2. *Genuine reconstruction quality.* Distant structure carries most of a tele frame, and it is
   where a Gaussian reconstruction is weakest.

Distinguishing them requires rendering at the frames' exact instants rather than on the tick
grid. That is a change to *when* we sample, not to what passes, and if it is made the number
above stays on the record alongside the new one.


---

## 2026-09-08 — Tick-quantisation hypothesis TESTED AND REFUTED

The G1 result above listed two candidate explanations for the 30° tele camera failing. The
first was testable, so it was tested rather than left as a caveat.

**Method.** Each camera was re-rendered with the episode anchored so that a 10 Hz tick lands
*exactly* on that camera's published frame instant — offset 0 ms instead of up to 50 ms. Four
separate single-camera renders, same scene, same package, same tier, nothing else changed.

| Camera | On the tick grid (up to 50 ms off) | At the exact frame instant (0 ms) | Δ |
|---|---|---|---|
| cross-left 120° | 24.07 dB / 0.905 | 23.95 dB / 0.901 | −0.12 dB |
| front-wide 120° | 22.89 dB / 0.872 | 23.00 dB / 0.875 | +0.11 dB |
| cross-right 120° | 25.32 dB / 0.913 | 25.02 dB / 0.905 | −0.30 dB |
| **front-tele 30°** | **19.67 dB / 0.760** | **19.86 dB / 0.763** | **+0.19 dB** |

**Conclusion.** Temporal quantisation is not the cause. Removing the tele frame's 19.3 ms
offset entirely moved it 0.19 dB — nowhere near the 2.3 dB it needs to reach the bar, and
within the scatter seen on the cameras that were already passing. The remaining explanation
stands: **this reconstruction is genuinely weaker at the distances a 30° tele camera looks at.**

**What that means for the product, stated rather than smoothed:** scene `007a5809` does not
qualify for any rig preset that includes the tele camera — which is both `alpamayo-2cam`
([1, 6]) and `alpamayo-4cam` ([0, 1, 2, 6]), i.e. every preset Alpamayo 1 can use. Its three
120° cameras reconstruct well (22.9–25.3 dB); the tele does not. G1 stays at 22 dB and the
scene stays unqualified.

No threshold was moved at any point in this investigation.


---

## 2026-09-08 — Qualification made explicitly per camera profile

**Not a threshold change.** No threshold moved; the failing 4-camera measurement above stands
exactly as recorded.

A reconstruction can be faithful for wide cameras and not for a narrow tele looking much
further down the road, which is precisely what this scene showed. "Scene 007a5809 is
qualified" was therefore never a well-formed statement: qualification is a property of a
scene **and a camera set**.

`validity.profileCameraIds` now records the camera ids the gates were measured over, the schema
rejects a bundle qualified over cameras it does not have or over none at all, and
`servesProfile(bundle, cameraIds)` refuses a rig needing any camera outside the qualified set.

### Wide-camera profile [0, 1, 2], measured on the same renders

| Gate | Measured | Threshold | Verdict |
|---|---|---|---|
| G1 | 22.89 dB / 0.872 SSIM (worst: front-wide) | ≥ 22 dB / 0.75 | pass |
| G2 | 0.84% / 1.59% / 2.15% / 6.80% by probe | ≤ 2% | pass, largest passing 1.0 m |
| G3 | 0.000 m | ≤ 0.01 m | pass |
| G4 | 197.3 ms | ≤ 200 ms | pass |
| **G5** | **not measured** | — | **outstanding** |

`validity.qualified` is **still false**, because G5 has not run. Four of five gates passing is
not qualification, and the envelope stays zero-width until the stock replay proves the
sim/executor/scoring chain on this world.

### What this does and does not license

- It does **not** relabel the failed 4-camera result. Camera 6 was measured, failed, and is
  excluded from the profile — not dropped to improve an average, and its number stays on the
  record above.
- Alpamayo 1 requires exactly [0, 1, 2, 6] and has no camera-count conditioning, so this scene
  remains unusable for A1 whatever happens with G5.
- Alpamayo 1.5 accepts a variable camera set, so [0, 1, 2] is a contract-supported rig rather
  than an invented one.


---

## 2026-09-08 — Reconstruction pipeline exercised end to end

Not a gate change; the result of running the reconstruction path for real.

**Input, and why it is this one.** The only calibrated AV capture on this host is the gated
PhysicalAI-AV scene; neither it nor a reconstruction of it may be committed or published, so
it cannot serve as this path's evidence. `python/make_calibration_capture.py` generates a
product-owned one instead — authored here, no third-party asset, no dataset byte, no captured
content, Apache-2.0. 24 orbiting views at 640×480, one PINHOLE intrinsic used both to project
the geometry and to write `cameras.txt`, exact authored poses in COLMAP world-to-camera
convention, and a 3,888-point seed cloud sampled from the scene's actual surfaces. It refuses
to seed from noise for the same reason `reconstructionRefusal` does.

**Run.** `train.py --config-name apps/colmap_3dgut.yaml path=<capture> out_dir=<runs>
experiment_name=sf-capture-v1 n_iterations=3000 export_usd.enabled=true
export_usd.format=nurec`, in the pinned tier (3DGRUT `a37ef721…`, Kaolin 0.18.0, torch
2.8.0+cu128, CUDA 12.8.1).

**Result.** Training completed; test PSNR 36.10, SSIM 0.981, LPIPS 0.072 over 3 held-out
frames. Exported `export_last_nurec.usdz`, 5,246,764 B, "1 camera(s) to NuRec USD from 21
frames". So the documented upstream commands work at the pinned revision and produce the
artifact the rest of the path consumes.

### What this proved about the architecture, by refusing

Importing that export directly through `importNurecPackage` **fails**, correctly:

```
{"error":{"code":"input_error","retryable":false,
  "message":"… is not a NuRec scene package",
  "fields":["rig_trajectories.json","sequence_tracks.json"]}}
```

A 3DGUT NuRec export contains `default.usda`, `export_last_nurec.nurec` and `gauss.usda` —
Gaussians and nothing else. It has no rig trajectory, no dynamic-actor tracks and no camera
calibration metadata, because a reconstruction is geometry and appearance; it is not a
recording of a drive. A replayable scene needs both, and the missing half comes from the clip
the reconstruction was built from.

`reconstructClip` already routes this way — geometry from the export, calibration/ego/dynamics
from the clip's own `simforge.eval-clip/v1`, joined by `importUserBundle`. The refusal above is
that separation being enforced rather than assumed, and it is the reason a reconstructed bundle
cannot quietly acquire an ego path nobody recorded.

**Not qualified, and cannot be.** A bundle from this capture is `source.kind:
synthetic-fixture`, which the schema structurally bars from ever being `qualified` or scored.
It exercises the pipeline; it sets no product state.


---

## 2026-09-08 — G5 measured and FAILED; scene 007a5809 is fully gated and unqualified

All five gates now have a verdict on this scene. G5 was run by the evaluation owner as a
forced-recorded-trajectory episode against a form-A spec built from the scene's own
ClipGT-derived topology (a real 217-lane graph; `nearest_lane(recordedPath[0])` landed 0.50 m
from lane 12:0:-2, so the lane graph and the recorded path are in the same frame and nothing
was invented). Bounded to the reconstruction's 20.0 s support window, 200 decisions at 10 Hz.

| Measurement | Value | Bound | Verdict |
|---|---|---|---|
| max lateral deviation (rig pose) | 1.0128 m | ≤ 0.35 m | fail |
| p95 lateral deviation (rig pose) | 0.9001 m | ≤ 0.10 m | fail |
| infractions | 3 (off-road 1, wrong-way 2) | 0 | fail |

**Frame question, settled before accepting the number.** `ego.recordedPath` is the RIG pose
(`rig_trajectories[0].T_rig_worlds`), while the executor reports the vehicle reference pose.
The rig→vehicle transform is `rig_bbox.centroid = [1.3120, 0, 0.7195]` — a pure longitudinal
offset with zero lateral component, which converts to lateral error only through curvature at
≈ L²/(2R): ~1.7 cm at R = 50 m, and needing R ≈ 0.96 m to produce 0.9 m. Measured both ways it
moves centimetres (vehicle pose: max 0.9111, p95 0.9078). The residual is not a frame
convention.

**Verdict recorded, not explained away.** `qualification/stock-replay.json` holds the failing
G5, and the bundle is `validity.qualified: false` with a zero-width envelope. The bounds are
`docs/policy-step.md`'s own executor envelope and were not touched. The cause is that this
spec's dynamics do not reproduce the recorded drive to 0.10 m p95 — the executor tracks its own
issued plan well (max cross-track 1.048 m to a plan that is itself off the recorded path).

Infractions carry `provenance: derived-from-reconstruction, confidence: low`, because
off-road and wrong-way are computed against a ClipGT-derived lane graph rather than an
authoritative map. They do not change the verdict, which had already failed on deviation.

**State of the scene:** G1 22.89 dB pass · G2 pass (largest passing offset 1.0 m) · G3 0.000 m
pass · G4 197.3 ms pass · **G5 fail** — for the [0, 1, 2] profile. Not qualified. No scene on
this host has passed all five gates.


---

## 2026-09-08 — Second and third real scenes: attempts kept, no scene admitted

Selection rule and full candidate ranking: `work/SELECTION-RULE.md`, fixed before any gate ran
(all four Alpamayo cameras present; lowest mean absolute heading rate; amended before any
measurement to require path length >= 100 m after the top-ranked candidate turned out to cover
23 m in 20 s, which would make G5 trivial). Both scenes fetched from the licensed catalogue
with the dev credential onto product storage; neither committed.

| Scene | selection rank | G1 worst camera | G2 | G3 | G4 | qualified |
|---|---|---|---|---|---|---|
| 007a5809 (first, pre-existing imported dir) | — | **22.89 dB** (profile [0,1,2]) | pass, 1.0 m | 0.000 m | 197.3 ms | no (G5 failed) |
| clipgt-000a3a34 | 1st eligible after amendment | **16.18 dB** | pass | 0.000 m | **202.5 ms fail** | no |
| clipgt-00064c58 | 2nd | **17.90 dB** | pass | 0.000 m | 199.9 ms | no |

### G4 at the data's natural scale

Track sampling is ~100 ms (000a3a34: p50 100.010 ms, p95 102.770 ms). The failures are not a
low sampling rate — they are **isolated dropped detections**, one missing sample producing a
single double-length gap, in 16 of 250 tracks. Three scenes land at 197.3 / 199.9 / 202.5 ms
against a 200 ms bound, i.e. within ±1.5% of it.

The bound is not being moved. But its derivation (interpolation error over a gap) puts it
exactly at twice the data's native 100 ms track period, so real scenes scatter either side of
it for reasons unrelated to replay fidelity. That is a genuine weakness in the gate's *choice of
statistic* — a max over all gaps is dominated by single dropped detections — and it needs a
principled re-derivation with evidence, not a nudge. Recorded as an open question; no scene was
admitted by touching it.

### G1: a confound in MY pipeline, not a conclusion about these scenes

The first scene rendered from a **pre-existing imported scene directory** and scored 22.89 dB.
The two new scenes rendered from directories **this module generated** (`scene-bundle.ts`,
written for exactly this purpose) and scored 16.18 and 17.90 dB.

That is a 5–7 dB gap that tracks *which scene directory produced the render*, not which scene
was reconstructed. Until that is explained, **I am not claiming these two reconstructions are
poor**. Candidate differences, none tested: the generated `background.json` carries no
`sourcePatch` (the pre-existing one has authored region meshes), and the ego pose reaches the
renderer by a different route (package `T_rig_worlds` here versus the original importer's
`ego-reference.json` there).

No G1 number from a generated scene directory should be trusted until this is resolved. Both
numbers stay on the record either way.

### Also corrected in this pass

The packages DO publish a full capture timeline — `rig_trajectories[0].cameras_frame_timestamps_us`,
599 frames per camera at ~30 Hz with a measured 30.56 ms exposure. An earlier version of this
importer read timing from the four stored JPEGs and labelled a 20 s drive a four-frame
recording. `cameras[].timing` is now the real timeline; the stored imagery is recorded
separately as `cameras[].referenceFrames`, which is what G1 compares against.


---

## 2026-09-08 — The generated-scene-directory confound: TESTED AND REFUTED

The previous entry withheld judgement on two scenes because their G1 came from scene
directories this module generated, while the 22.89 dB scene came from a pre-existing imported
one. That is a testable confound, so it was tested rather than left as a caveat.

**Method.** Generate a directory with `scene scene-dir` for the SAME scene (007a5809), from the
SAME package, and re-run G1/G2 against it. Only the directory differs.

| Camera | pre-existing directory | generated directory |
|---|---|---|
| cross-left 120° | 24.07 dB | 24.07 dB |
| front-wide 120° | 22.89 dB | 22.89 dB |
| cross-right 120° | 25.32 dB | 25.32 dB |
| front-tele 30° | 19.67 dB | 19.67 dB |

Identical to two decimal places on every camera. **The generated directory is not a confound**,
and `scene-bundle.ts` is validated: a directory derived from the package alone renders exactly
as the one produced by the original import pipeline.

**Therefore the earlier reservation is withdrawn and the numbers stand as scene quality.**
clipgt-000a3a34 at 16.18 dB and clipgt-00064c58 at 17.90 dB are genuinely weaker
reconstructions than 007a5809, whose three 120° cameras reach 22.9–25.3 dB. Three real scenes,
and only one has any camera profile clearing G1.

### A G2 weakness this exposed, recorded not patched

On 007a5809 the on-trajectory baseline is 49.7% "unsupported" — that scene has a large far
field, and sky sits beyond the 1000 m far plane. On both new scenes every probe reported
**exactly 0.000**, including the baseline: those drives are enclosed, nothing is beyond the far
plane, so the far-plane test has nothing to detect and G2 passes trivially at every offset.

Baseline subtraction still makes the *comparison* sound, but a gate that cannot discriminate on
an enclosed scene is not measuring off-trajectory coverage there — it is measuring that the
scene has no sky. Alongside the G4 statistic problem, that is the second gate whose choice of
measure needs re-deriving with evidence. Neither was adjusted to admit anything.


---

## 2026-09-08 — Ego-hood hypothesis TESTED AND REFUTED; the G1 deficit is the upper frame

Renders are produced with `--hood none` because we hold no AlpaSim hood overlay assets, while
the recorded frames come from a real vehicle whose bonnet occupies a fixed bottom band. That is
an obvious candidate for a systematic PSNR penalty, so it was measured per image region rather
than assumed. Diagnostic only — no gate, no verdict, G1 untouched.

PSNR by row band, on-trajectory renders against the matched recorded frame:

| Scene / camera | full | excl. bottom 25% | rows 0–25% | 25–50% | 50–75% | 75–100% |
|---|---|---|---|---|---|---|
| 007a5809 front-wide | 22.89 | 23.83 | 27.32 | 34.49 | 19.91 | 20.89 |
| 007a5809 cross-left | 24.07 | 23.43 | 23.94 | 30.99 | 20.56 | 26.86 |
| 000a3a34 front-wide | 16.18 | **15.38** | 14.52 | 15.13 | 16.79 | **20.17** |
| 000a3a34 cross-left | 16.72 | **15.58** | 17.69 | 13.84 | 16.07 | **26.66** |

**Refuted.** On the weak scene the bottom band is the *best* region (20.17 and 26.66 dB) and
excluding it makes the score *worse* (16.18 → 15.38, 16.72 → 15.58). A missing hood would do the
opposite. The deficit sits in the upper and middle frame — sky and distant structure — which is
where a Gaussian reconstruction is weakest and where this capture evidently is.

So 000a3a34's 16.18 dB is genuine reconstruction quality in the far field, not an artifact of
our render configuration. Third hypothesis raised about a failing G1 number, third one tested,
third one refuted. The number stands.


---

## 2026-09-08 — Six real scenes measured; first scene to clear G1–G4

Three more scenes from the pre-declared candidate list, unchanged gates, all failures kept.

| Scene | cross-left (0) | front-wide (1) | cross-right (2) | front-tele (6) | G4 | four-camera G1 |
|---|---|---|---|---|---|---|
| 007a5809 | 24.07 | 22.89 | 25.32 | **19.67** | 197.3 ms | fail (tele) |
| clipgt-000a3a34 | 16.72 | 16.18 | 16.81 | 21.92 | **202.5 ms** | fail |
| clipgt-00064c58 | 20.86 | 17.90 | 19.00 | 22.11 | 199.9 ms | fail |
| clipgt-000ff49d | 15.38 | 14.47 | 19.76 | 18.02 | **201.8 ms** | fail |
| **clipgt-0009402a** | **26.56** | **16.11** | **27.07** | **23.32** | 199.5 ms | fail (front-wide) |
| clipgt-000e95f7 | 23.50 | 21.76 | 26.22 | **19.98** | **202.5 ms** | fail |

No scene clears G1 on all four cameras. The per-camera spread is large and scene-specific — the
weak camera is the tele on two scenes, the front-wide on two others, and everything on a fifth —
which is consistent with genuine reconstruction quality rather than a systematic in our
measurement (three candidate systematics have now been tested and refuted).

### clipgt-0009402a qualified on profile [0, 2, 6]

Its front-wide camera fails at 16.11 dB, but cross-left, cross-right and front-tele reach
26.56 / 27.07 / 23.32. Re-rendered and re-measured over exactly those three cameras:

| Gate | Measured | Threshold | Verdict |
|---|---|---|---|
| G1 | 23.32 dB (worst of the three) | ≥ 22 dB | **pass** |
| G2 | 0.57% / 1.11% / 1.56% by lateral offset; 9.02% at 5° heading | ≤ 2% | **pass**, largest passing 1.5 m |
| G3 | 0.000 m | ≤ 0.01 m | **pass** |
| G4 | 199.5 ms | ≤ 200 ms | **pass** |
| G5 | not yet run | — | outstanding |

First scene to clear G1–G4. `validity.qualified` is **false** and the envelope is zero-width
until G5 runs.

This is the per-profile qualification the plan calls for, not a relabelling: camera 1 was
rendered, measured, failed at 16.11 dB, and that number stays in the table above. The bundle
records `profileCameraIds: [0, 2, 6]`, and `servesProfile` refuses any rig needing camera 1 —
which means Alpamayo 1 (fixed [0,1,2,6]) cannot use this scene. Alpamayo 1.5's variable camera
set can, and that is a contract-supported rig rather than one invented to fit the result.

The package's own `map.xodr` (276,237 B) is extracted and bound to the bundle, so the lane
context G5 needs comes from the scene rather than from anywhere else.


---

## 2026-09-08 — G5 gains the settle window its own bound was defined with

**A misapplication corrected, not a bar relaxed.** `docs/policy-step.md` — the document G5's
0.35 m / 0.10 m bounds were taken from — states them as *"abs cross-track error (after 1 s
settle) | p50 0.14 m, p95 0.24 m, max 0.29 m | <= 0.35 m"*. G5 applied those numbers without the
window they were measured under. A pure-pursuit controller acquiring a path from its initial
pose has a transient that belongs to the controller's initialisation, not to the scene under
test, which is exactly why the source excludes it.

`stockReplaySettleS: 1` is now part of the threshold set, and `StockReplayMeasurement` carries
`unsettled` so the un-excluded statistics are recorded permanently beside the gated ones. No
verdict already on the record is revised by this: 007a5809's G5 failure was a *systematic*
0.6 m offset across the whole run (p50 0.5975 m), which no settle window touches.

### clipgt-0009402a G5, measured

| Reference | max | p50 | p95 |
|---|---|---|---|
| vehicle pose, whole run | 0.4251 | 0.0421 | 0.1090 |
| rig pose, whole run | 0.6845 | 0.0480 | 0.1175 |
| after 2 s (reported) | 0.111 | 0.041 | 0.080 |

Every violation falls in steps 3–10 and the tail is inside both bounds — an acquisition
transient at 31.4 m/s, not drift. The evaluation owner ruled out the obvious spec explanation
by setting the initial lane reference to the recorded lateral offset (±0.352) and getting
*exactly zero* change, because the engine spawns from the explicit recorded pose.

**Caveat recorded against a future pass:** that executor envelope was measured at **8 m/s** on
an S-curve. This drive is **31.4 m/s**, nearly four times faster. Whether the bound transfers
to that speed is not established by anything we hold, so a pass after the settle window is a
pass against a bound of unproven applicability at this speed, and will be reported that way.

### Infractions still fail — not discounted

off-road 1, wrong-way 1, speeding 1; zero required. The speeding infraction is computed against
speed limits in a `map.xodr` nobody has verified, against a human who drove 113 km/h, and the
lane binding is 1.101 m off nearest-lane (versus 0.50 m on 007a5809) — so these plausibly
measure the map rather than the drive. Plausibly is not evidence. **The condition fails, the
scene is not admitted, and making it pass needs an authoritative map rather than a judgement
call.**

State: six real scenes, one clears G1–G4, none admitted.


### clipgt-0009402a G5 verdict, all variants measured

| variant | n | max | p50 | p95 |
|---|---|---|---|---|
| whole run, vehicle pose | 200 | 0.4251 | 0.0421 | 0.1090 |
| whole run, rig pose | 200 | 0.6845 | 0.0480 | 0.1175 |
| **after 1 s settle, rig pose (gated)** | 190 | **0.3468** | **0.0476** | **0.0973** |
| after 2 s, rig pose | 180 | 0.1240 | 0.0473 | 0.0889 |

Deviation **passes** after the settle window the bound defines — but three things are recorded
against reading that as a clean result:

1. **The max clears by 4 mm** (0.3468 vs 0.3500) and comes entirely from decision 10, the first
   step after the excluded window. At 2 s the same figure is 0.124. That is a boundary effect of
   where the window ends, not a property of the drive: a 0.9 s or 1.1 s window would move the max
   materially while p50/p95 barely change. Passing-but-marginal.
2. **The bound's applicability at this speed is unproven.** It was measured at 8 m/s on an
   S-curve; this drive is 31.4 m/s. The 0.425 m acquisition transient is itself evidence the
   controller behaves differently here, since at 8 m/s it would not need that distance to
   converge. "Passes after the settle window" is true; "passes a bound of established
   applicability" is not.
3. **Infractions fail: off-road 1, wrong-way 1, speeding 1, against zero required.** Not
   discounted. The speeding infraction is computed against unverified `map.xodr` limits with a
   1.101 m lane-binding offset, so it plausibly measures the map rather than the drive — and
   plausibly is not evidence.

**G5 FAILS. clipgt-0009402a is NOT ADMITTED.** Six real scenes; one clears G1–G4; none is
qualified. Admitting this scene needs an authoritative map, not a judgement call.


---

## 2026-09-08 — Map provenance: what AlpaSim's own contract does and does not authorise

Investigated because G5 on clipgt-0009402a failed on three infractions, two of which looked
like artifacts of an unverified lane graph. The question is not whether they *feel* like
artifacts — it is what the scene's own source authorises us to measure.

### What the artifact contains

A NuRec package ships `map.xodr` (276,237 B here) **and** the ClipGT annotation set the map was
derived from: `lane`, `lane_line`, `road_boundary`, `road_island`, `intersection_area`,
`crosswalk`, `wait_line`, `gore_area`, `buffer_zone`, `traffic_light`, `traffic_sign`,
`obstacle`, `egomotion_estimate`, `calibration_estimate`.

### What AlpaSim actually scores

`NVlabs/alpasim` `src/eval/scorers/__init__.py` registers exactly: CollisionScorer,
OffRoadScorer, MinDistanceToObstacleScorer, OpenLoopCollisionScorer, GroundTruthScorer,
MinADEScorer, PlanDeviationScorer, ImageScorer, SafetyScorer. Off-road works from lane geometry
via `trajdata.vec_map`.

**There is no speed-limit scorer and no wrong-way scorer.** The two infractions that failed our
G5 beyond off-road are not part of the metric contract these artifacts were published under,
and the package carries no verified posted speed limits for the first of them.

### How that is encoded — classification, not relaxation

Per the standing instruction that a missing authoritative source makes a metric *unavailable*
rather than passing, `StockReplayMeasurement.unavailableCategories` names each category that
could not be evaluated together with the exact artifact that is missing, and **G5 fails when
any category is unavailable**. Unavailable is not zero: a category nobody could measure must
block the gate, not silently count as clean.

clipgt-0009402a's recorded G5 is therefore:

- deviation after the defined 1 s settle: max 0.3468 / p50 0.0476 / p95 0.0973 — passes, but the
  max clears by 4 mm off the first post-window step, and the bound was measured at 8 m/s against
  this drive's 31.4 m/s;
- off-road: **1** (a category with an authoritative source, and it failed);
- speeding: **unavailable** — no authoritative posted speed limits; only an unverified
  `map.xodr`, and AlpaSim scores no such metric;
- wrong-way: **unavailable** — no authoritative lane directionality; nearest-lane binding is
  1.101 m off, and AlpaSim scores no such metric.

**G5 FAILS. The scene is NOT ADMITTED.** It would still fail on off-road alone, so nothing here
turns on the reclassification — which is exactly why it is safe to make. No map was fabricated,
no `map.xodr` was treated as ground truth, and no infraction was discounted on speculation.

### Standing state

Six real scenes. One (clipgt-0009402a, profile [0,2,6] — a model-specific three-camera profile
for Alpamayo 1.5's variable rig, **not** a four-camera claim) clears G1–G4. None is admitted.
The failed front-wide camera at 16.11 dB and every prior result stay on the record.


## 2026-09-08 — Off-road diagnosis: the third infraction is also a lane-binding artifact

Bounded CPU diagnosis of the one infraction category I had called authoritative. It is not, and
this corrects my own earlier claim a second time.

### The event

From the scored episode's `events.json`, every infraction fires in the first second:

| tick | t | event | data |
|---|---|---|---|
| 1 | 0.2 s | off-road | `lateralOffsetM: -5.454` |
| 1 | 0.2 s | wrong-way | `reverseM: 1.494` |
| 9 | 1.0 s | speeding | 30.89 m/s vs limit 11.11 m/s |

At tick 1 the replayed ego is **0.16 m** from `ego.recordedPath` (deviation only reaches its
0.425 m peak at step 7) — it is, to within 16 cm, exactly where the human drove. Yet the
off-road detector reports it **5.454 m from the centreline of the lane the spec bound to**.

### What that means

The 5.45 m is not the vehicle leaving the road. It is the distance from a lane centreline that
was already mis-bound at the start: `nearestLaneAtStart` recorded lane `67:0:-2` at a lateral
offset of **1.101 m**, and the detector is measuring against a lane the ego is not driving in —
roughly a lane-width away, which also explains a `wrong-way` firing on a straight drive at
0.2 s.

The decisive point: **the recorded human trajectory itself would be flagged off-road by this
detector**, since the replay is within 16 cm of it. A metric that fails the ground-truth drive
is measuring the binding, not the drive.

It also measures a different quantity from AlpaSim's: their `OffRoadScorer` works from lane
**polygons** via `trajdata.vec_map` (drivable-area containment), whereas ours is a
**centreline lateral offset**. Those are not the same test, and only the first is meaningful
against a low-confidence binding.

### Consequence, and what I did NOT do

All three infraction categories on this scene are therefore artifacts of lane binding, not
observations of the drive. I have **not** reclassified off-road as unavailable, **not** added a
polygon-containment metric, and **not** touched a threshold — implementing a new metric policy
here would be exactly the move that admits a scene by changing the rules. G5 stands as FAILED
and clipgt-0009402a stands as NOT ADMITTED.

### Exact external input / explicit policy choice required

1. **Drivable-area geometry with authority.** The artifact already carries `road_boundary`,
   `lane` and `road_island` ClipGT parquet, which is the raw material AlpaSim's polygon-based
   off-road scorer uses, but nothing in our stack ingests them — our lane graph is built from
   the package's `map.xodr` and bound by nearest-centreline. Ingesting ClipGT geometry is real
   work and a decision, not a fix I should slip in under a gate investigation.
2. **A policy choice on what off-road means for us:** centreline lateral offset (current, and
   demonstrably wrong here) or drivable-area polygon containment (AlpaSim's, and the only one
   the evidence supports). That choice belongs to whoever owns the scoring contract.
3. **Speed limits and lane directionality remain unavailable** on this corpus regardless, as
   recorded above.

Until 1 and 2 are settled, full admission is BLOCKED — not by scene sampling, which cannot
help, and not by anything more GPU time would produce.


---

## 2026-09-08 — Off-road v2 implemented; its own control FAILS; v2 is NOT VALIDATED

Implemented per the owner decision (footprint containment in authoritative drivable-area
polygons) and per the plan pre-recorded at `7cc900ff` before any of it existed. The plan's
primary acceptance check was: score the **recorded human drive** and require zero off-road
events. It does not pass, so **v2 must not be used to score anything**, and no scene number is
quoted from it.

### Control result

Scene clipgt-0009402a, recorded human drive, ego footprint 5.393 x 2.109 m from the package's
own rig bbox, 202 samples:

| | events | worst corner outside |
|---|---|---|
| v2, lane-ring membership | 13 | 0.099 m |
| v2, after dissolving lanes into a union | 13 | 0.099 m |

### Cause, measured

Not a transform error — the geometry is plainly in the right frame (lane rails span
x −209.9..869.2, the ego path x 0.0..662.9, and the worst excursion is 9.9 cm rather than
metres). Instead:

- **18 of 18 outside corners lie within 0.30 m of TWO adjacent lane polygons** — they are
  between lanes, not off the road.
- ClipGT lane rails **do not tile contiguously**: 339 non-touching adjacent lane pairs, gaps
  p50 **0.200 m**, p90 0.250 m, max 0.300 m. Each lane's rails sit inset from the lane line, so
  there is a ~20 cm strip at every lane boundary that belongs to no lane polygon.
- A true union cannot close a real gap: dissolving 168 lane polygons yields 38 parts and changes
  the control not at all. (Buffering each lane by 0.05 m collapses it to 6 parts, which confirms
  the diagnosis and is *not* being adopted — see below.)

So the ~20 cm strip is the painted lane marking, which is drivable road, and a vehicle
straddling a lane line legitimately has corners in it.

### What I did NOT do

Buffering lanes by half the measured gap would make the control pass immediately. I did not do
it: the buffer distance would have been chosen from the very gap it was introduced to close,
which is a result-driven tolerance wearing the costume of a fix. Same reason no threshold moved
anywhere else in this workstream.

### Required input / explicit policy choice

1. **Preferred, authoritative:** build the drivable outline from `clipgt/road_boundary.parquet`
   (135 rows on this scene) — the annotated edge of the road, which by construction has no
   inter-lane seams. It needs boundary assembly (left/right edges into closed rings), which is
   real work and a decision, not a tweak.
2. **Or an explicitly approved policy** that the lane-marking strip between adjacent lane rails
   is drivable, with the inclusion rule stated in the metric definition rather than tuned per
   scene.

Until one of those exists, **v2 is implemented, tested on authored geometry (6 containment
tests: inside, outside, hole, straddling, orientation-dependent, sequence scoring — all
passing), and NOT VALIDATED against real data.** v1 verdicts are untouched, G5 stays failed,
clipgt-0009402a stays not admitted, and full admission remains blocked.

New ingestion dependency, declared: `shapely` and `pyarrow`, used only by
`python/clipgt_drivable.py` at ingestion time. The scoring consumer receives plain polygon rings
and needs no geometry library.


---

## 2026-09-08 — Off-road v3: source-authoritative boundaries. Control PASSES. Scene still not admitted.

Owner decision was (1): assemble from `road_boundary` with explicit `road_island` exclusions, no
empirical buffer. Done, and it is a **different instrument** from the lane-union attempt, so it
carries its own version rather than pretending to be the same measurement.

| instrument | source | control: recorded human drive, 202 poses |
|---|---|---|
| `simforge.offroad/v2` | `clipgt-lane-union` | **13 off-road events**, worst 0.099 m — FAILS, retained |
| `simforge.offroad/v3` | `clipgt-road-boundary` | **0 off-road events**, 201 assessed, 1 unavailable — PASSES |

Both run through the shipped code path, both reproducible from the same package. The v2 failure is
not overwritten; `--source lane-union` still produces it.

### What the source actually authorises, and what it does not

`road_boundary` states, per vertex, which side of each edge carries traffic
(`left_driving_direction` FORWARD/BACKWARD against `right_driving_direction` NOT_DRIVABLE). All 135
boundaries on this scene are sided, none unsided, none dropped. That is the source saying where the
road is, so the nearest boundary decides the question and no closure is needed.

**No closure was synthesised, because none is available.** Noding the 135 polylines and
polygonizing yields **zero** faces: they are chains truncated at the clip extent, with 262 `CUT`
termini against 8 physical ends. Capping them into rings would assert road where labelling merely
stops. Instead each terminus keeps its flag, and a query whose nearest feature is a `CUT` terminus
returns **unavailable** — which is what the single unavailable control sample is. Unavailability
also wins over off-road at the footprint level: if any corner lands past the labelled extent the
sample is unknown, because with part of the box unlabelled a kerb strike and the end of annotation
are indistinguishable.

A polyline whose per-vertex side labels disagree along its length is dropped, not averaged.

### Consequence for the recorded verdicts — no verdict was changed

Re-scoring the **replayed** stock-replay trajectory of clipgt-0009402a with v3: 200 samples, 200
assessed, **0 off-road events**. The v1 off-road infraction does not survive the authoritative
instrument, which is the third and last of the three infractions to be explained as a lane-binding
artifact rather than behaviour.

This does **not** admit the scene, and nothing here was done to make it. G5 fails on lateral
deviation — p95 0.0973 m against a 0.1 m bound is fine, but max 0.6845 m and the with-settle
statistic 0.3468 m against 0.35 m is a fail on its own terms, independent of any infraction. Speeding
and wrong-way remain **unavailable** (no speed limit, no travel-direction authority in the source).
The G5 verdict, the six scene results and every superseded number stay exactly as recorded.

**No threshold has been moved at any point in this workstream.** The lane-union buffer that would
have made v2 pass was measured, shown to work, and refused because its value came from the result.

### Dependencies

Ingestion only, in `python/clipgt_drivable.py`: `pyarrow`, and `shapely` for the retained lane-union
dissolve. The boundary path needs neither at scoring time — the consumer receives oriented polylines
and island rings and does its own arithmetic.


---

## 2026-09-08 — Correction: G5 on clipgt-0009402a did NOT fail on deviation. I reported it wrong.

I have written "G5 fails on lateral deviation" several times, including in a handoff. It is false
against my own recorded receipt, and the numbers were in front of me each time.

Under the declared settle rule, **both deviation criteria pass**:

| criterion | measured | threshold | |
|---|---|---|---|
| max lateral (settled) | 0.3468 m | ≤ 0.35 m | PASS |
| p95 lateral (settled) | 0.0973 m | ≤ 0.10 m | PASS |

The unsettled pair (max 0.6845 m, p95 0.1175 m) is retained beside them and is **not** the
statistic the bound is defined for. Quoting it as the failure was reporting a deviation failure
against a different window than the rule declares — the precise error I spent this workstream
refusing to make in the other direction.

### What actually carried the failure

`failureReasons` is now emitted by `gateG5` and lists every failing criterion, so a reader never
has to infer the cause from the single `measured`/`threshold` pair a verdict can carry:

1. `1 infraction(s) recorded`
2. `speeding could not be evaluated: authoritative posted speed limits ...`
3. `wrong-way could not be evaluated: authoritative lane directionality ...`

No deviation entry appears. The verdict remains **failed** and the scene remains **not admitted**;
nothing was relaxed and no value moved. The re-emitted receipt was checked field by field against
the original — `measured`, `threshold`, `direction`, `unit` and `passed` are byte-identical, and
the script refuses to write if any of them differ or if the verdict flips.

Item 1 is the off-road infraction that v3 now scores as **0 events**. Re-scoring the record is the
scoring owner's call, not mine; I am not editing his infraction count. Items 2 and 3 are unaffected
by any of this work and block full G5 on their own.

### Also corrected: unavailability no longer outranks a known excursion

`footprintContainment` previously returned *unavailable* as soon as any corner fell past the
labelled extent, even when another corner was known to be off the road. That is wrong: a corner
that was decided stays decided, and an unknown elsewhere adds no doubt about it. Precedence is now
known-excursion > unknown > clean, so unavailability cannot launder a real excursion into "no
data" — while still refusing to invent one where nothing was decided. Both directions are pinned by
tests (`keeps a KNOWN excursion an excursion even when another corner is unknown`, `reports
unavailable only when nothing was decided against the vehicle`). Neither control moved: v3 still
0 events / 201 assessed / 1 unavailable, v2 still 13 events / 0.099 m.


---

## 2026-09-08 — G5 re-emitted from the scoring owner's v3 record; the surviving infraction is named

The scoring owner re-scored the stock replay under `simforge.offroad/v3` and produced a durable
manifest (`evalexec/proof/g5b/v3/scored/`). G5 on clipgt-0009402a is re-emitted from **his**
numbers, read from `score.json` rather than restated from a message. Deviation is not re-measured:
`measured`, `threshold`, `direction` and `unit` are checked against the prior receipt and the
script refuses to write if any differ or the verdict flips.

| | before (v1-era) | after (v3 record) |
|---|---|---|
| off-road | 1 | **0** |
| infraction count | 1 | 1 |
| the infraction | off-road | **lane-departure** |
| speeding / wrong-way | unavailable | unavailable |
| verdict | failed | failed |

The count did not move, but its identity did, and a bare `1 infraction(s) recorded` could not show
that. `gateG5` now takes `infractionCategories` and names them, so the reason reads
`1 infraction(s) recorded: lane-departure`. On a scene where a single artifact has already appeared
under two different names, an unnamed count is not a usable receipt.

### A caution the owner should weigh, not me

The surviving `lane-departure` event reports `lateralOffsetM -5.454` at t = 0.2 s, on a trajectory
that is 0.16 m from `ego.recordedPath`. That is the same nearest-lane binding — 1.101 m off at the
start — that produced the off-road and wrong-way artifacts. Reporting it under its own name is
right, and the claim is now at least *about* lane position rather than about road containment, but
its magnitude still comes from the mis-bound lane. Whether that is admissible is the scoring
owner's call; it is recorded here so the number is never read as 5.454 m of lane departure by a
vehicle that drove where the human drove.

### Still not admitted, and why exactly

`speeding` and `wrong-way` remain unevaluable for want of an authoritative source. Those two block
full G5 on their own and no geometry work can change them. No threshold moved, no value was
relabelled, and every superseded measurement remains on the record above.


---

## 2026-09-08 — Lane binding source built; its control FAILS to qualify it. `laneCentrelines` stays false.

The scoring owner made `lane-departure` unavailable rather than reporting 5.454 m, and asked for
per-lane rails as the thing that would make it *available* again. Built
(`python/clipgt_lanes.py` → `simforge.lane-context/v1`, `lanes.ts` → `bindLane`), controlled on
the recorded human drive, and **it does not earn the authority flag**.

### The binding is containment-first, on purpose

A vehicle is in the lane whose own annotated rails contain it. Nearest-centreline always returns
a lane, including one the vehicle is nowhere near, which is exactly how the superseded number
arose. Three outcomes, not two: `contained`, `ambiguous` (in the ~0.20 m inter-rail strip or
straddling), `outside`. **No offset is ever reported for an unbound sample.** Binding is per-pose,
so a lane change is a change of binding rather than a permanent departure; the flicker that
implies is surfaced as `ambiguous` for the consumer to handle explicitly, not absorbed by a band.

### Control on the recorded human drive, and what it exposed

| | value |
|---|---|
| samples | 202 |
| contained | 200 |
| ambiguous | 2 |
| outside | 0 |
| worst offset | 1.732 m = **1.004 half-widths** |

Containment looks healthy, and 1.73 m is far better than 5.454 m. It is still wrong, and the
reason is not driving behaviour:

- Over x ∈ [138, 177] the annotated lanes sit at centreline **y = −2.06** and **y = −5.68**
  (3.6 m apart, one lane width). The ego runs **y = −4.0 … −4.5** for that entire stretch, i.e.
  almost exactly midway between two lane centrelines.
- That is not confined to one segment. The ego sits near the line between the same lane pair
  before x = 138 as well (lane-15 at −5.68, lane-17 at −2.06, ego −3.97).
- The rails are straight there (sagitta 0.000–0.015 m over ~38 m spans), so this is not a
  chord-cutting artifact from coarse 3-point rails.

A recorded human does not ride a lane line at 31 m/s for twenty seconds. The parsimonious reading
is a residual **~1.8 m lateral discrepancy between the ego pose frame and the ClipGT lane
annotations** — the same order and the same character as the 1.101 m nearest-lane mis-binding that
started all of this, and quite possibly the same underlying cause.

### Therefore

`metricAuthority.laneCentrelines` is **not** set, `lane-departure` stays **unavailable**, and it is
recorded in the G5 receipt as unavailable with that discrepancy named as the missing artifact. The
binding source ships because it is the right instrument and it is what will qualify the metric once
the discrepancy is resolved — but shipping the instrument is not the same as certifying the input,
and a 1.7 m "departure" by a car driving where the human drove would have been the third repetition
of one mistake.

Resolving it needs the ego-to-annotation alignment established independently — not another metric
built on top of the same unverified correspondence.

### G5 now

`off-road` 0, `lane-departure` unavailable, `speeding` unavailable, `wrong-way` unavailable. The
infraction count is **0** and item (1) has left the reason list. G5 still fails, on three
unevaluable categories and nothing else. The scene is still not admitted, and no threshold moved.


---

## 2026-09-08 — Correction: I inferred a frame defect from plausibility. Withdrawn.

In the entry above I wrote that the parsimonious reading of the lane-binding control is "a
residual ~1.8 m lateral discrepancy between the ego pose frame and the ClipGT lane annotations".
That is an inference from *a human would not ride a lane line at 31 m/s*, which is a plausibility
argument, not evidence. Sustained straddling can happen. Withdrawn as a conclusion.

Worse, evidence already in this session argues against it, and I did not weigh it before writing
the sentence. **The offsets are not uniform.** Per bound segment, worst |offset| on the recorded
drive:

| segment | worst offset | | segment | worst offset |
|---|---|---|---|---|
| lane-14 | 1.73 m | | lane-106 | 0.53 m |
| lane-16 | 1.66 m | | lane-87 | 0.39 m |
| lane-11 | 0.95 m | | lane-71 | 0.26 m |
| lane-19 | 0.85 m | | lane-77 | 0.15 m |
| lane-22 | 0.58 m | | lane-83 | 0.09 m |

A constant frame offset would displace every segment alike. These span 0.09 m to 1.73 m — more
than a factor of eighteen — with the ego centred to within 9 cm in some segments and at the rail
in others. That is not the signature of a rigid transform error, and I should have noticed before
naming one.

### What is observed, stated without a cause

1. The ego's bound lateral offset varies from 0.09 m to 1.73 m across consecutive lane segments of
   one continuous drive.
2. Over x ∈ [138, 177] the annotated centrelines are at y = −2.06 and y = −5.68 and the ego runs
   y = −4.0 … −4.5, sustained between them; the same holds for the preceding segment pair.
3. Rails in the high-offset segments are straight (sagitta 0.000–0.015 m over ~38 m spans).
4. Containment holds throughout: 200 of 202 samples inside exactly one lane, 0 outside, 2 ambiguous.

### Competing explanations, none selected

- **Alignment.** A pose-to-annotation correspondence error. Argued against by (1): a rigid offset
  should not vary eighteenfold between segments. A *non-rigid* or drifting correspondence is not
  excluded by (1).
- **Annotation.** The lane tiling shifting laterally between independently labelled segments —
  each ClipGT lane row is its own autolabel (`minimap:lanes:autolabels:v0`) and nothing forces
  neighbouring segments onto a consistent lateral registration. Consistent with (1) and (2).
- **Behaviour.** The drive genuinely tracks near a lane line over part of the route — a wide lane,
  an off-ramp taper, or a lane change in progress. Consistent with (2) and not excluded by
  anything measured. Sustained straddling is a real thing vehicles do.

Distinguishing these needs independent calibration or correspondence evidence — a known
ground-truth registration between ego poses and the annotation set, or an annotation source with
stated lateral registration. It cannot be settled by another metric computed on the same
unverified correspondence, which is why no further diagnostic is being built here.

### Status

Feature **BLOCKED** on those exact source inputs. `metricAuthority.laneCentrelines` stays false,
`lane-departure` stays unavailable, and its missing-artifact string is now observational rather
than causal. Source, instrument and every measurement are retained. No GPU, no further scene
sampling, no core change.
