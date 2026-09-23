# Closed-Loop Evaluation Campaigns (P4)

Scenario × seed × policy episode grids run **sequentially** through the native
kernel `Episode`, dispatched by `simforge_oss_gym.tools.policy_runner`
(`adapters/gym`), scored with SimForge-native metrics, persisted as immutable
artifact directories with an append-only ledger, and deterministically rerunnable.
The Python runner owns policy construction and artifact delivery, not a second
world clock, deadline executor, envelope monitor or trace implementation.

Model-independent: reference policies (`scripted`, `trajectory`) and a
real model endpoint (`endpoint`) plug into the same runner, the same
`docs/policy-step.md` action wire and the same artifacts. The `endpoint` policy
talks `simforge.policy-endpoint/v2` MessagePack to a live engine socket with
real rendered camera frames; frames never cross HTTP.

Real PPO teacher and camera-student checkpoints run through the bench's
`hello/act` endpoint with `simforge drive run --policy torch:<run>/<update>`.
The W4 `simforge eval promote` command uses that same bench and kernel Episode
for its held-out panel, including scripted and frontier comparisons. It does
not connect a bench state/setpoint server to the older rig-centric Python
campaign endpoint and claim protocol parity. The `simforge-eval-campaign`
configuration below remains the Python campaign runner's contract.

- Scoring: `packages/evaluation/src/scoring.ts`
- Campaigns: `packages/evaluation/src/campaign.ts`, CLI
  `simforge-eval-campaign` (`campaign-cli.ts`)
- Process boundary shared with the cloud worker:
  `packages/evaluation/src/episode-runner.ts`
- Example config: `packages/evaluation/fixtures/mini-w3.campaign.json`

## CLI

```sh
simforge-eval-campaign run    --config campaign.json   # run / resume
simforge-eval-campaign rerun  --config campaign.json --episode <id>
simforge-eval-campaign report --config campaign.json   # report.json + report.md
```

During development: `pnpm --filter @simforge-oss/evaluation exec tsx src/campaign-cli.ts …`.

## Campaign config

```jsonc
{
  "campaignId": "mini-w3",
  "runsRoot": "~/simforge-assets/runs",
  "decisionHz": 10,
  "suite": [{
    "scenarioId": "synthetic-leadcar",       // [a-z0-9-]
    "spec": "synthetic-leadcar.episodes.json", // env-server form-A episode spec, relative to this file
    "session": 0,                             // instance index inside the spec
    "steps": 120,                             // decision budget
    "expectedRouteM": null,                   // null → ego cruiseSpeed × clipSeconds
    "speedLimitMps": null,                    // null → authored lane speedLimitKph (topology), engine default 13.4
    "replayContext": null,                    // simforge.replay-context/v1 bundle dir → envelope enforcement
    "frameSource": null                       // "bevy:<rig.json>", required by `endpoint`
  }],
  "seeds": [101, 202, 303],
  "policies": [{
    "policyId": "scripted", "runnerPolicy": "scripted",  // or "trajectory" | "endpoint"
    "policySeed": 0,
    "mode": "offline-simtime",                // or "realtime" with an explicit deadlineMs
    "deadlineMs": null,                       // required in realtime, forbidden offline
    "fallback": "zero-control", "forceMissAt": []
  }, {
    "policyId": "alpamayo-1-5-nf4", "runnerPolicy": "endpoint",
    "endpointSocket": "/tmp/simforge-alpamayo.sock",
    "cameraProfile": "alpamayo-4cam",
    "replanHz": 0.5,                          // ZOH between replans
    "numTrajSamples": 1,
    "model": { "family": "alpamayo-1.5", "revision": "7aba8293…", "quant": "nf4" },
    "warmupPolicy": "scripted", "warmupSteps": 16,
    "mode": "offline-simtime"
  }]
}
```

### Timing modes

A policy declares exactly one, and the trace, `score.json` and `result.json`
all carry it. The UI must never label an offline run "real-time".

| mode | contract |
|---|---|
| `offline-simtime` (default) | The engine pauses at every inference barrier: nothing advances until the decision returns. No deadline exists, `dl.miss` is 0 by construction, and slow hardware costs wall time — not scientific validity. The only mode for remote jobs and reconstructed scenes. |
| `realtime` | The kernel measures observation delivery through the next decision, including rendering, against an explicit `deadlineMs`; a miss applies `fallback`, and `score.json` reports the miss rate. `forceMissAt` inserts an actual over-deadline wait, not an invented elapsed-time value. |

Configuring a deadline offline, or `forceMissAt` without a deadline, is a
config error — the schema rejects it rather than silently ignoring the field.

### Model endpoints and replay-context scenes

An `endpoint` policy needs a real camera source: `frameSource: "bevy:<rig.json>"`
selects the kernel **Cameras** channel. The rig document contains
`cameras: [{sensorId,cameraId,fwd,left,up,yawDeg,hfov,width,height}]`,
`passes: ["rgb"]`, and either `backend: {kind:"service",socket}` for an already
loaded resident renderer or `backend: {kind:"embedded",scene}` for the embedded
renderer. An embedded `scene` may be an inline document or a JSON path resolved
relative to the rig (or `SIMFORGE_SCENE_ROOT`). The kernel creates every scene-state
document from its own post-step snapshot. Python only packs borrowed native
frames for the unchanged `simforge.policy-endpoint/v2` MessagePack wire and
releases their leases before the next barrier.

`dir:` has been removed from closed-loop evaluation: prerecorded images cannot
reflect policy-diverged state. Recorded image bundles still belong to the
separate open-loop evaluation path. Missing render assets or cameras refuse the
episode; there is no synthetic camera fallback.

Before the evaluated policy acts, the kernel consumes `warmupSteps` reference
actions generated by `warmupPolicy` (`scripted` or `trajectory`). Its reset
callback delivers each real warm-up observation/frame for the endpoint's
16-pose and 4-frame histories. Warm-up is labelled in `trace.episode-v2.jsonl`
and excluded from the converted scorer trace and `model_decisions`; its reset
is rebased to policy start. The campaign's existing `steps` budget includes
warm-up, unlike the kernel's policy-only `maxDecisions`. `--allow-cold-start`
still explicitly stamps frame-history replication in provenance.

With `replayContext` set, kernel admission refuses unqualified bundles or a
failed G5 stock-replay gate, and the kernel checks the recorded envelope at
every barrier. A breach stops the episode with `term_reason: envelope_exceeded`
and a partial result, never a successful model run. The `recorded-path` G5
qualification policy uses explicit measurement-only mode: it must measure an
unqualified, initially zero-width envelope before that envelope can be admitted.
This bypass is recorded in the native spec and never used for endpoint episodes.

## Artifact layout

Under `<runsRoot>/<campaignId>/`:

| file | content |
|---|---|
| `campaign.json` | frozen resolved spec; fixture sha256s pin immutability — resuming with changed inputs is refused |
| `ledger.jsonl` | append-only, one line per completed episode; readers take the last line per `episodeId` |
| `report.json` / `report.md` | aggregation (per-scenario table, aggregate driving score, infraction histogram) |
| `<episodeId>/` | `episodeId = <scenarioId>__<policyId>__seed<seed>` |

Per episode: `trace.episode-v2.jsonl` (sealed kernel
`simforge.episode-trace/v2`, including warm-up, frame digests and result core),
`trace.jsonl` (verified conversion to legacy scorer rows with policy reasoning
and replan telemetry), `events.json`, `score.json`, `provenance.json`, and
`runner-summary.json`. Conversion gives the scorer trace its own digest chain;
`source_schema`/`source_episode_digest` retain the native identity. Provenance
stamps `traceVersion` (also in `result.json`'s `provenance.runtime`) so pre-v2 and
v2-derived scores are not compared blindly. The native trace is included in the
manifest's evidence inventory. `runner-stderr.log` exists when needed, followed
by a `COMPLETE` marker and **`result.json`** —
`simforge.eval-result-manifest/v1`, written LAST and atomically.

**Object-row correction in trace v2:** the old Python runner emitted perceived
object IDs without their numeric rows. The legacy scorer expects
`[id,range,bearing,rangeRate,los]`; the v2 converter supplies these actual kernel
observations. Pre-v2 traces could therefore mis-type vehicle collisions as
`collision-static` and omit TTC. On `mini-w3`'s `synthetic-leadcar`, scripted
seed 101, the identical world-state stream scores **0.11661843180773608** before
and **0.10764778320714098** after: the collision penalty is now correctly 0.60
(vehicle), rather than 0.65 (static). This is an observation-evidence correction,
not changed dynamics or scoring mathematics; retain the trace-version label
when comparing historical results.

`result.json` is the one document both hosts and the cloud control plane read:
`status` (`succeeded` | `partial` | `failed` | `cancelled`), `scored`,
`promotable`, `mode`, `truncation`, `metrics`, digest-listed `artifacts[]`,
provenance and timing. `scored` is independent of `status`: a truncated episode
is scored up to the breach yet is `partial` and not promotable.

## Kill / resume

Resume is idempotent by construction: episodes with a `COMPLETE` marker are
skipped untouched. An episode directory without one is moved aside as
`<episodeId>.evidence-<timestamp>/` and rerun — a failed or cancelled attempt's
trace is retained as evidence rather than deleted, and is never presented as a
result. Killing the runner at any instant loses at most the in-flight episode.
The ledger is append-only across resumes and records every episode's
`status`/`runnerStatus`/`scored`/`truncation`.

## Determinism

`rerun` re-executes a completed episode into `<campaign>/.rerun/<episodeId>`
and compares the legacy `episode_digest`, a **deep-canonical** trace hash
(including nested summary/model identity, excluding measured timing/device
telemetry), and the linked native `source_episode_digest`. The retained v2
traces are independently chain-verified. Deterministic reference policies
(scripted and trajectory) must match; an unexplained mismatch exits non-zero.

A seed is **not** a cross-device reproducibility claim: model provenance
records `determinismScope: "same-host-same-device"`, because GPU kernels are
not guaranteed bit-identical across devices, drivers or quantization backends.
A model episode whose rerun digest differs on the same host is recorded, not
hidden.

The migration proof runs the unchanged `mini-w3.campaign.json` scenario/seed/
policy grid with only its output root isolated: all 18 episodes completed.
For the 300-decision scripted seed-101 rerun, the converted digest is
`d61463bc416bb00267c9e222f3b0ed62dd42c557da54ef8f1de729f3c6ef383c` in both runs.
Pre/post comparisons hash the exact state-vector stream separately from trace
metadata: the trace schema intentionally changed, the simulated state did not.

Camera-trace identity additionally includes the actual frame digests. The
current SceneApp renderer is **not RGB-bit-deterministic even on the same host**:
the phase-B 10-second two-camera proof reproduced all 101 scene-state documents,
but all 202 cross-run RGB hashes differed. Those hashes remain in the trace;
they are never normalized away to manufacture parity. State-only rerun
determinism and deterministic scene documents do not claim pixel determinism.
When a rerun's legacy policy chain and every deterministic non-pixel native
field match (including scene-state digests), only differing camera hashes are
reported as `rendererNondeterminism: {reason: "renderer nondeterminism", ...}`.
`match: true` then means policy/world parity, **not** RGB identity; both unequal
source digests and the common non-pixel state digest remain in the verdict.
A changed scene, action, deterministic summary or absent native proof is not
excused as renderer nondeterminism.

## Promotion panels (W4)

```sh
simforge eval promote torch:teacher/update-000098 --panel canary8 --split test
simforge eval promote torch:student/update-000001 --panel devpanel32 \
  --bc-baseline torch:bc-run/update-000001
pnpm exec tsx tools/release-bundle/build.mts PROMOTION_DIR --id v1 --training-run TRAINING_RUN
```

This command freezes the `qualification/panels/` scenario × explicit-RNG-seed
grid and invokes the real bench at matched 2 Hz replanning / 10 Hz Episode
barriers / offline-simtime, with the same 64-frame authored prologue for every
policy. Canary8 has **four test/control pairs**, not eight independent hazard
trials; devpanel32 has sixteen pairs. Original admitted test/control manifest,
episode and receipt digests are verified, along with concrete input and
installed graph identity. These v1 panels do not repair the rejected full PoC-v1 grid.

Panel ids are discovered from the `<id>.panel.json` files present in
`qualification/panels/`, not from a CLI allowlist. The document's id must match
its registry filename. New panels can declare `expectedEpisodes`; the frozen
entry digest continues to protect older documents without that field.
The `canary`/`devpanel` aliases still select the unchanged v1 panels.
Panels below 32 entries remain screening-only regardless of their filename.
Promotion scope names the actual panel and source split digests rather than
assuming every panel belongs to PoC-v1.

The separate [`devpanel32-v2`](../qualification/panels/devpanel32-v2.panel.json)
was frozen **before checkpoint selection** from the PoC-v2 test/control
manifests. It contains sixteen hazard/control pairs: manifest-order
round-robin over all six admitted family × map cells, seeds 200 and 201 for
all six and seed 202 for the first four. Controls are selected by their
parent input digest. This gives nine pairs on Belmont and seven on
Easterbrook, covering queue-tail, CPNCO and cut-in-brake. Its canonical digest
is `0079014157eb63d59426d1b929c329a7476255f1a18f83c6f770e9e46c364069`.
Select it with `--panel devpanel32-v2`; no policy result is implied by panel
registration, and the original canary8/devpanel32 bytes were not changed.

PoC-v2 is retained as **defective evidence**, not a selection/evaluation gate:
queue goals could terminate inside the common 6.3-second bench prologue.
The immutable successor
[`devpanel32-v3`](../qualification/panels/devpanel32-v3.panel.json) uses corrected
PoC-v3 test/control sources and the same sixteen-pair round-robin rule.
Its canonical digest is
`31446b2d59c5c018dfddc200b8da35a1343d75a1f1c250a36de6ee33d590e86c`.
The source admission adds per-seed `bench-window` evidence for hazard onset
and default-goal survival through at least 9.3 seconds; this is source
admission, not a learned-policy performance result. Select with
`--panel devpanel32-v3`. The original v1/v2 panel bytes remain unchanged.

Model health is a separate, prior gate: complete sessions, zero closed-loop
fallbacks, zero invalid plans, zero timeouts and real model plans are required.
The evaluator reads all health receipts for a policy **before opening any of
its score files**, then verifies the evidence inventory. A healthy manifest
is not a driving-safety qualification. An enhanced-input/appearance cache may
not stand in for a raw panel run.

The candidate reruns every panel entry; native digest chains and deterministic
non-pixel evidence are compared, and RGB-only discrepancies remain labelled
renderer nondeterminism. `promotion.json` includes the verdict, reasons,
per-policy mean ± SE, both score instruments, failures, every seed and the
rerun proof. Cached frontier runs must match this exact panel and execution;
the old benign-corridor/lead-brake caches do not. The default command runs
AutoE2E when this panel has no cache. `heat/heat.mp4` compares the first frozen
hazard across the available healthy policies.

The named optional `alpasim-style-score` is **not an AlpaSim result**:
front/lateral geometric contact, authoritative offroad, or lateral authored
route error ≥4 m forces zero; otherwise `min(progress / 0.8, 1)`. Missing
authority is null, not a clean zero. Native contact sides are sampled at the
detector's swept time of impact, with normalized OBB-corner ties assigned to
lateral; this is not legal responsibility. Explicit forward overshoot of a
route endpoint is not misclassified as lateral exit. Existing `drivingScore`
remains beside it. For ordinary campaign configs, opt in with
`suite[].alpasimStyle.authoredRoute: [[x,y], ...]` in world metres; old traces
without contact-side facts remain explicitly unavailable on collisions.

Bench runs with only lane-surface footprint geometry name
`simforge.offroad/native-lane-polygons-v1`, **not** road-boundary offroad/v3.
Their source and OpenDRIVE projection are concrete, but lane unions have not
earned road-surface authority from a full reference-control gate. The named
hard-safety score therefore leaves that component unavailable rather than
turning legacy lane offset or low-confidence lane polygons into a pass.

The PoC-v2 bench maps additionally ship digest-bound source OpenDRIVE
`road-boundary.json.gz` outlines. Those dissolve complete paved cross-sections,
including shoulders/parking/bicycle surfaces, preserve island exclusions and
open map cuts, and are measured as `simforge.offroad/v3`. Their authority is
the simulated source road, **not** the old lane-union fallback and **not** a
surveyed/rendered-mesh ground-truth qualification. See
[bench-map derivations](engineering/map-intel-bench-derivations.md).

Day-28 paired bootstrap uses 10,000 draws and the panel's fixed seed, excludes
paired controls from independent-trial counts, and reports the relative
collision reduction, 95% CI of the paired collision-rate difference and task
completion loss. Missing BC data or a zero-collision BC ceiling is
`insufficient-evidence`, never permission to alter the test. Canary-only
evidence cannot qualify. The checkpoint store persists the verdict through a
SHA-256-linked receipt; Python and TypeScript readers verify it.
See [W4 semantics and release slots](engineering/closed-loop-training.md#w4-implementation-and-promotion-semantics)
for the full gate and the six predetermined comparison/missing-card slots.


## Scoring

`drivingScore = routeCompletion × Π penaltyFactor^eventCount`, in [0, 1].

| infraction | default factor | trigger (exact boundaries unit-tested) |
|---|---|---|
| collision-vehicle / -pedestrian / -static | 0.60 / 0.50 / 0.65 | terminal collision (shared rule with eval-server `col`); partner = nearest perceived object, typed by authored actor kind |
| off-road | 0.75 | **v2**: the vehicle FOOTPRINT leaves the authoritative drivable-area polygons. **v1**: \|lateral offset\| > 3.0 m (strict), hysteresis clears at 2.5 m |
| lane-departure | 0.75 | **v2 only**: \|lateral offset\| > 3.0 m (strict), hysteresis clears at 2.5 m — v1's off-road rule, under the name of what it measures |
| wrong-way | 0.70 | ≥ 1.0 m cumulative reverse route-arc while speed > 0.5 m/s |
| red-light | 0.70 | stop-line crossing while red (`sig` trace annotations; inert without signals) |
| stuck | 0.80 | speed < 0.3 m/s for ≥ 8 s continuously |
| speeding | 0.90 | speed > limit × 1.1 sustained ≥ 1 s |

Route completion = clamp(Δ route-arc / expectedRouteM, 0, 1); an explicit
goal termination forces 1. Reported without score impact: TTC minima over
closing perceived objects (`ttc-critical` warnings below 1.5 s), comfort
accel/jerk bound violations (3.5 m/s², 8 m/s³), and deadline misses.
All thresholds and factors are per-scenario overridable (`suite[].scoring`).

### Metric versions, and why off-road split in two

The manifest stamps `provenance.metricVersion`. Results keep the version that
scored them and are never re-scored under another: a v1 number is a v1 claim.

- `v1` — off-road is lane-relative lateral offset.
- `simforge.offroad/v2` — footprint containment against the ClipGT LANE-UNION
  ingestion. Retained for reproducibility and NOT trustworthy: its
  ground-truth control fails, because inset lane rails leave a ~20 cm seam at
  every lane boundary and a car straddling a lane line has corners in it.
- `simforge.offroad/v3` — footprint containment against the authoritative
  road-boundary outline with island exclusions. The ClipGT road-boundary
  ground-truth control passes; source OpenDRIVE bench outlines have their own
  explicit provenance and do not inherit that corpus's qualification.

The instrument names itself from the geometry it was handed, so a score record
says which ingestion produced it and the two can never be conflated. The
geometry, the point classifier and the containment rule live in
`packages/evaluation/src/replay-context/drivable.ts` and are owned there: this
scorer calls them rather than carrying a second implementation.

v1's rule measured distance from a lane CENTRELINE, which is not the same
question as "did the vehicle leave the road". On a reconstructed clip the
recorded ground-truth drive — 0.16 m of tracking error against its own path —
was reported as a 5.45 m lane error and therefore off-road, while never leaving
the drivable surface. A metric that flags the ground truth is measuring the
wrong thing, so v2 asks the containment question directly and keeps the
centreline question as its own, separately named infraction. Both can fire; they
are different claims.

Containment evaluates the four corners of the actor's box at its pose (dims from
the spec, yaw from the trace), not its centre, and reports the worst corner's
outside-distance so a marginal exit is legible rather than binary. One corner
out is off-road: two wheels over a kerb has left the road, and requiring all
four would only report what needs no metric to notice.

**Unavailability wins over off-road.** A corner past the labelled extent makes
the whole sample unknown, because a kerb strike and the end of annotation are
indistinguishable there. Per-sample, so a single unlabelled decision does not
discard an otherwise assessed episode.

Corner sampling has one documented gap: an island NARROWER than the vehicle,
straddled without a corner inside it, is not detected. It is conservative — it
can only miss an excursion, never invent one — the mitigation is denser island
rings in the ingestion rather than edge sampling here, and a regression pins it
so it cannot change silently.

### Lane-departure: binding, and what a lane change is

`lane-departure` is a claim about lane POSITION, so it requires an authoritative
binding: the bundle declares `metricAuthority.laneCentrelines`, and without it
the metric is unavailable rather than a number.

The requirement was earned. A derived lane graph mis-bound by 1.10 m reported
-5.454 m of departure for a trajectory 0.16 m from the recorded human path — the
artifact that made off-road v1 flag ground truth, surviving under a new name
because renaming a metric does not give it a better lane. The binding that
replaced it is rail containment, per pose: a vehicle is in the lane whose own
rails contain it, and a sample contained by two lanes (or by none, within half a
lane of one) is `ambiguous` with its candidates named. No offset is ever
reported for an unbound sample, because an offset from a lane the vehicle is not
in is exactly the quantity that must never be reported.

On the reference drive that binding is sound: 200 of 202 samples contained, 2
ambiguous, 0 outside. Its large offsets are confined to a lane change — worst
0.600 m before the traverse, 1.732 m during it, 0.555 m after the vehicle
settles, with 106 of 128 steady-state samples inside a third of a half-width.
A constant frame misalignment does not switch off when the car stops
manoeuvring, so the manoeuvre is the explanation and the geometry is not
suspect. (Two earlier readings of this data — a rigid ~1.8 m ego-to-annotation
discrepancy, and a per-segment autolabel registration error — were both
withdrawn against these numbers, as was a supposed 0.36 m disagreement between
the boundary and lane layers: the road carries three ~3.45 m lanes plus a ~1.0 m
shoulder, and dividing the shoulder into the lanes is what made the layers look
inconsistent.)

**A lane-boundary crossing is a lane TRANSITION, and transitions are
diagnostic.** Rail binding tells you where the vehicle was, not whether it was
allowed to be there: which crossings are illegitimate depends on the route the
vehicle was meant to take, the markings it crossed and the rules in force, none
of which a reconstructed scene establishes. So a rail binding emits
`lane-transition` INFORMATION — `{fromLaneId, toLaneId, crossingSeconds,
withinCrossingBound}`, or an `undecided_run_exceeded` note when a vehicle rides
the strip for longer than `laneChangeMaxS` — and never an infraction, and
`lane-departure` remains unavailable under a rail binding alone. Penalising a
crossing would fail a stock replay for driving the way the human drove.

Geometry availability is therefore scoped to validated support and its hash. It
is not a certification of legality, and nothing in this scorer converts one into
the other.

The binding surfaces ambiguity rather than absorbing it for the same reason: a
consumer that later has route and rule authority can decide which lane an
undecided sample belonged to, with the candidates in front of it, instead of
inheriting a band that silently picked one.

**Absent geometry is `unavailable`, never a pass.** With no drivable-area block,
empty polygons, or a decision outside the polygons' time support, v2 reports
off-road as unavailable and the factor does not apply — the episode is not
scored as clean. A drivable-area frame that disagrees with the ego frame is a
refusal (`drivable_area_frame_mismatch`), not a silent transform.

SimForge driving scores are **our** metric definition, not an NVIDIA benchmark
score: a number may only be called an AlpaSim (or any upstream) score if that
exact benchmark implementation and dataset produced it.

## One episode without a campaign

The cloud worker and the desktop `policy_episode` job run a single episode
through the same runner and scorer, via the shared cores in
`packages/evaluation/src/{episode-run,openloop-run}.ts`:

```sh
# closed-loop episode (job.json = simforge.compute-job/v1)
simforge-eval-worker episode  --job job.json --out out/
# open-loop batch over simforge.eval-observations/v1 bundles
simforge-eval-worker openloop --job job.json --out out/
```

`out/result.json` is the completion marker and is written even for a failure or
a cancellation (`status: failed|cancelled` with a typed `error.code` and
`retryable`). SIGTERM stops at the next barrier, flushes the partial trace and
exits 130; a hard kill leaves no `result.json` at all, which is the control
plane's failed-attempt path. Nothing in the worker reaches the network: the
control plane resolves artifacts to local paths first, and every declared
input digest is verified before use.
