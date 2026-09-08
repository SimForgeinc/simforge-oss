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
