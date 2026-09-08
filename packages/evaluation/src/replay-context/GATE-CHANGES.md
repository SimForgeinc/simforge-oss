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
