# Closed-loop training on the SimForge kernel

Status: plan (2026-09-21). This is the contract the training workstreams are
built against. Numbers marked *proposed* are budgets and gates, not measured
capability. Evidence for the claims about the current codebase is in
`docs/eval-campaigns.md`, `docs/policy-step.md`, `docs/world-session.md`,
`adapters/gym/README.md`, `TICK-LATENCY-REPORT.md`, and the second-opinion
review at `~/tmp/second-opinion-training-plan.md` (22 verified arXiv refs).

Implementation evidence (2026-09-22): a bounded render-free teacher prototype
now lives in `adapters/gym/simforge_oss_gym/train/`. Reproduction and explicit
deviations are in `adapters/gym/README.md`; measured CPU scaling is in
[benchmarks/env-throughput.md](benchmarks/env-throughput.md). The live run is
`~/simforge-assets/runs/drive/training/ppo-visible-20260922/`, with per-update
metrics, a regenerated dashboard, hashed checkpoints and queued Bevy
evaluations. Its 5.39M DeepSets actor is longitudinal setpoints with native
route steering, not the camera/control student in this plan. This evidence
does **not** satisfy W0 parity/ground-truth admission, the complete day-7 gate,
held-out geography, student/DAgger, or promotion. The contract below remains
the target rather than being silently weakened to match the prototype.

## Objectives, in priority order

1. **One episode, one truth.** Training and evaluation execute the same kernel
   episode (reset, step, inference barrier, deadline/fallback, trace, result
   manifest). A training rollout is an episode sampled from a learning policy;
   a bench run is an episode with a frozen one. No second loop, reward, or
   termination implementation exists in TS or Python.
2. **Every policy is a policy server.** Teacher, student, Alpamayo, Qwen-Drive,
   AutoE2E, Jev all speak the msgpack `hello/act` wire. The learner gets an
   in-process fast path (PyO3) whose traces are byte-identical to the socket
   path; the parity test is permanent.
3. **Scenario supply is a compiler product.** Train/val/test splits are
   declared as template × map × site × seed ranges and materialized by the
   native compiler with provenance. Curricula mutate parameters, never
   authored files.
4. **Throughput is a published number.** State-only env-steps/s and rendered
   ticks/s are CI benchmarks with floors.
5. **Scored and reported the same way.** A checkpoint's value is the campaign
   scorer's held-out result, produced by the same bench/heat tooling used to
   judge the public models. Learning curves are secondary.
6. **No invalid result survives.** Contact/termination semantics are
   contract-tested in the kernel; a checkpoint promotes only with a passing
   rerun-determinism proof and a clean model-health receipt.

## Recipe (proof of concept)

Render-free PPO teacher in the Rust world → ~12M pixels-to-controls student →
on-policy DAgger from the frozen teacher (Roach 2108.08265, OPTED 2609.20756,
LEAD 2512.20563). Deferred: self-play at scale (Gigaflow 2502.03349), VLA GRPO
(Poutine 2506.11234), world-model-as-simulator (AD-R1 2511.20325, ZYT-World
2609.21712). Appearance transfer (REGEN 2508.17061, Cosmos-Transfer) is an
ablation stream, never a reward or evaluation authority.

- **Teacher:** ~6M DeepSets PPO, *visible-only* observation (lane/route tokens,
  ego motion, LOS-gated actor history). Privileged critic may use full truth;
  labels handed to the student may not (LEAD). Three seeds, ≤30M decisions
  each, selected on validation only.
- **Student:** ResNet18 + 256-GRU, ImageNet init, one 640×360 front camera at
  10 Hz with recurrent history, speed/yaw-rate, eight ego-frame navigation
  points. Outputs longitudinal effort `u∈[-1,1]` and normalized steering;
  `throttle=max(u,0)`, `brake=max(-u,0)`, control passthrough at 50 Hz physics.
  No object truth, map identity, absolute position, or future actors. Bench
  camera profiles stay multi-camera so the same architecture can be re-run
  with `alpamayo-4cam` as an ablation.
- **Distillation:** behavior cloning from 100k teacher frames, then two DAgger
  rounds (≤100k student-visited frames pooled over three student seeds),
  teacher labels without rendering, balanced nominal/hazard replay, mild →
  hard reveal difficulty; unavoidable collisions are not solvable targets.
- **Reward (native default, 10 Hz):** signed authored-route progress, clean
  route/queue goal, terminal contact/corridor/signal penalties, comfort and
  queue-aware stuck costs. The exact constants and instruments are in the
  [reward table](#native-teacher-reward-2026-09-22) below. No Python reward
  implementation exists; density-sensitive proximity is disabled. Route
  denominators are geometric, not speed × clip.
- **Frozen grid (proposed):** `cpnco-parked-row`,
  `mechanisms/corridor/{queue-tail,cut-in-brake}` × Yale/El Camino × two
  admitted sites × seeds 0–99 = 1,200 train; same families/maps, disjoint
  sites, seeds 100–119 = 120 val; Belmont/Easterbrook × three families × one
  site × seeds 200–219 = 120 test + 120 hazard-removed controls. Hold out
  geography and sites, not only RNG. Admission must prove geometry, occlusion
  and solvability; never relax prerequisites to fill cells. San Ramon versions
  are one geography.
- **Budget (proposed):** 240 A100 GPU-hours on simforge1 (72 teacher, 72
  student, 64 baselines/eval, 32 contingency), 80 RTX 5080 hours for sensors,
  8,000 Jev requests. Independent seeds on separate A100s only after CPU
  scaling is measured.
- **Kill criteria:** day 7 — stop if grid/ground-truth gates fail or the
  kernel cannot sustain ≥5,000 state decisions/s and ≥10 rendered student
  decisions/s. Day 28 — reject the recipe unless DAgger reduces held-out
  collision episodes ≥20% vs matched BC with a positive paired-bootstrap 95%
  bound, loses ≤2 points of task completion, and stays in budget. A
  zero-collision BC ceiling is insufficient evidence, not permission to change
  the frozen test.

### Native teacher reward (2026-09-22)

`simforge-session::{env,reward}` is the kernel environment/reward owner over
`simforge-core` motion and route geometry. `Episode`, `EpisodeBatch`, Gym and
the drive bench share it. The table freezes previously unspecified queue,
stuck and comfort-cap constants; the proposed base weights are unchanged.
`dt = 0.1 s` at 10 Hz. All costs are per decision, not a second Python loop.

| Term / setting | Exact native default | Instrument / boundary |
|---|---|---|
| `progress` | `+0.05 × (s_now − s_previous)` | Signed metres projected onto the original authored route; initialized at reset, including the first decision. Changing/reversing the active route cannot mint progress. |
| `goal` | `+5` once | Geometric route end (remaining distance ≤0.05 m), **or** safe queue stop below. Never awarded on a safety-violating decision. |
| `collision` | `−20` once; terminal | Any native ego contact event, including VRUs and static colliders; independent of visibility. |
| `offroad` | `−10` once; terminal | **Route-corridor exit**, centre offset strictly greater than authored lane half-width +0.5 m (3.5 m lane width for freeform routes). This is not road-boundary offroad/v3 or an authoritative road-surface score. |
| `red_crossing` | `−5` once; terminal | Front bumper (`route_s + length/2`) crosses a bound stop line forward under red/red-X/stop indication; phase sampled at interpolated crossing time. |
| `time` | `−0.01 × dt` | Every decision, including necessary queue waiting. |
| `comfort` | `−0.005 × abs(longitudinal_accel) × dt` | Acceleration contribution only, not an aggregate. |
| `jerk` | `−0.001 × (abs(jerk) + max(abs(jerk)−8, 0)) × dt` | Decision-boundary acceleration difference / dt; 8 m/s³ comfort cap adds a hinge at the same weight, rather than clipping away excessive jerk. Previous acceleration is reset/checkpoint state. |
| `lateral_accel` | `−0.005 × max(abs(lateral_accel)−3, 0) × dt` | Native body telemetry, 3 m/s² comfort cap; `g × 9.80665` converts to SI. |
| `stuck` | `−0.5 × dt` | Ego speed ≤0.3 m/s without a stopped blocking road vehicle in the queue gap. No grace period. |
| Queue exemption | stopped lead speed ≤0.3 m/s; bumper gap 0–10 m | Lead is ahead with lateral footprint overlap in the authored route frame. Adjacent-lane, behind, moving and distant actors do not excuse parking. Route projection edge tolerance is 0.0001 m. |
| Queue goal | authored `role:queue-tail`, bumper gap 4.5–6.5 m; ego speed ≤0.3 m/s continuously for 1 s | 4.5 m is the frozen queue template's authored minimum clearance; 6.5 m upper gap and 1 s dwell are explicit PoC choices. Arbitrary stopped traffic never grants a goal. |
| `proximity` | weight `0` (disabled) | Optional legacy kernel configuration retains a 15 m range and 5 m exponential decay; no density cost in the default teacher. |

Simultaneous safety terms add; terminal reason precedence is contact →
corridor exit → red crossing → clean goal → horizon. Safety suppresses the
goal bonus, not measured progress/comfort/time. Queue dwell, original route,
previous acceleration and reward configuration are checkpointed. Admission-only
whole-clip scripted witnesses can set top-level `goal: null` explicitly.

Binding ABI **4** exposes eleven contributions in this order:
`progress, proximity, comfort, jerk, lateral_accel, time, stuck, collision,
offroad, red_crossing, goal`. `infos["reward_terms"]` is `(N, 11)`,
`infos["reward_term_names"]` names its columns; reset-only rows are zero.
The named native JSON/trace terms additionally expose `queueWait`.
PPO records every column as `reward_<name>_mean` in `metrics.jsonl`, excludes
reset rows and plots progress/stuck/jerk on its dashboard. Validation checkpoint
receipts retain the same per-decision means. The scorer consumes explicit
native terminal facts, not a negative-reward collision guess.

#### Measured reward proof

The CPU-only run
`~/simforge-assets/runs/drive/training/reward-poc-v1-20260922/` completed
**1,997,546 actual decisions in 79 updates** (560.55 s learner wall time),
using all **400 frozen poc-v1 train episodes**, 8 native workers, 8 Torch
threads and the 5,393,797-parameter teacher. It stopped before exceeding the
2M budget with another full rollout. `proof-recipe.yaml`, resolved configs,
split digests, checkpoints, `metrics.jsonl`, `dashboard.png`, `evidence.json`
and a retained isolated ABI-4 runtime are in that directory.

Decision-weighted first-five → last-five update means:

| Measured term per decision | First five | Last five |
|---|---:|---:|
| Signed progress reward | +0.034786 | +0.060216 |
| Stuck penalty | 0 | 0 |
| Jerk penalty | −0.006064 | −0.001702 |
| Total reward | +0.025805 | +0.051632 |

The flat stuck curve is measured, not a fabricated improvement from a
nonexistent baseline curve. All eleven logged means sum to total reward
within 5.56e-17. The old overnight teacher is not a controlled same-budget
reward ablation.

Last checkpoint: `torch:reward-poc-v1-20260922/update-000079`, SHA-256
`5c84d946e0abc7d6aa63a41b93d67f09fc335ebc3c69a9e825335c920fae5eaf`.
`simforge drive run` on the **first frozen val entry, seed 100**, produced
`rollouts/final/poc-v1-val__torch__seed100/drive.mp4`: 100 policy decisions /
10.0 simulated seconds, 10.1 s H.264 video including the reset frame.
It advances **123.565 authored-route metres**, with observed decision speeds
**8.451–14.671 m/s** (final 10.746 m/s), zero stuck reward and no observed
contact. The actual Bevy footage was inspected; `drive verify` passes all
**202 PNG hashes**, the trace chain, model health and manifest.

**This checkpoint does not park on that clip; it is not safety-qualified.**
Native validation still has **20/60 contact episodes: all 20 queue-tail
episodes, versus 0/40 cut-in-brake episodes**. This poc-v1 training supply is
cut-in only; the new poc-v2 grid is a separate next run. No day-7 gate,
held-out-test or promotion claim is made. The unchanged fixed state suite
passes **38,436.54 / 41,994.03 decisions/s at 64 worlds** for corridor/VRU:
see the [dated reward benchmark](benchmarks/state-throughput-2026-09-22-reward.md).
Scoped proof: 46 native contracts (including eight reward regressions),
21 Gym contracts plus one optional camera-parity skip, and 46 scorer tests.

## Workstreams

### W0 — Kernel episode (architecture batch, made load-bearing)
- Rust `Episode` API: reset/step, observation channels (state, objects, BEV,
  resident-Bevy cameras), reward terms, termination, trace + chained digest,
  `simforge.eval-result-manifest/v1`. PyO3 + N-API bindings.
- `packages/cli/.../drive` and gym `policy_runner.py` dispatch kernel Episode
  barriers; the obsolete renderer-owned Python driving loop has been deleted.
- **Privilege boundary contract:** a `visible` observation channel in which
  `sv[9]` and object rows honour occlusion (`los=false` rows removed), distinct
  from the privileged channel. Tested.
- Pedestrian/cyclist contact termination and signal state exposure, contract-tested
  (the defect that invalidated the 2026-08 PPO run).
- Benchmarks published in `docs/`: state-only env-steps/s (CPU vector),
  rendered ticks/s per camera profile.
- Acceptance: one scenario+seed yields identical trace digests from CLI, gym,
  and campaign runner.

### W1 — Vectorized training env on the kernel
- Implemented `EpisodeBatch`: N kernel `Episode`s stepped by one PyO3 call on
  a bounded Rayon pool. No second reward, termination, trace or host autoreset
  implementation. GPU-batched Episode dynamics remains a tracked follow-on:
  the current GPU backend rejects ambient tags, lane changes, signals and
  perception features and is not used here.
- Gymnasium `VectorEnv` uses native NEXT_STEP autoreset, unsigned scalar
  `seed+i` expansion (or explicit seed lists), and atomic whole-batch
  checkpoint/restore including held-plan anchors, pending resets and trace
  digests. It accepts `state`, `state+bev`, `visible`, `visible+signals`;
  camera channels are refused in a batch and remain individual-Episode only.
- PPO rollout collection and validation now dispatch EpisodeBatch, consume
  kernel collision/goal facts, and exclude native reset-only rows from learning
  and decision accounting. The old Python SessionBatch stepping/reset path is
  deleted.
- N=8 parallel-versus-sequential Episode trace parity and mixed termination /
  trajectory-checkpoint continuation are permanent Rust/Python contracts.
  [The current combined batch row](benchmarks/state-throughput-2026-09-22-final2.md)
  uses the existing fixed 1/8/32/64 method; the CI floor remains 5,000 at 64
  worlds for **each** workload, not a relaxed replacement baseline.
- Named follow-ups: GPU-batched dynamics, and the separate single-env
  `SimForgeEnv`/`PolicyRunner` clean cutover from low-level EnvSession
  (declarative latency) to Episode (kernel-measured deadlines). The low-level
  single-env API is intentionally retained; training uses VectorEnv at N=1 too.

### W2 — Scenario supply
- `simforge.scenario-split/v1` manifests declare template × map × native site ×
  inclusive seed ranges (or explicit seed lists). `simforge scenarios materialize
  --split <manifest>` freezes native compiler products, source templates,
  per-cell admission receipts, and `instances`-form `episodes.json` with provenance.
  Repeating the command on a frozen manifest verifies it; it never overwrites
  the original evidence. To change a grid, author a new split id.
- `simforge scenarios verify-splits <a> <b>...` verifies the canonical manifest
  digests, exact episode/template/receipt/trace SHA-256s, installed topology
  identity, admission coverage and every seed/draw. It rejects overlap by
  **seed and map-intel site origin**, including two template-specific site IDs
  that bind the same origin. Test geography must be absent from train/val;
  all San Ramon releases count as one geography.
- A cell is admitted only if **every seed** passes. The first failing seed
  excludes the entire cell; prior successful seeds from it are not emitted.
  Failed candidates remain in the manifest with `status: "excluded"` and a
  digest-linked reason/receipt. Missing map features are failures, not
  inferred passes. Matching uses each unchanged template's native policy,
  with no required-clause repairs or silent semantic losses.
- Geometry is the installed map-intel match plus native compiler/initial
  feasibility. Every declared occlusion must have a resolved occluder,
  actual blocking, then LOS opening strictly before conflict with positive
  reveal-to-conflict time. Templates without a declared occlusion record
  `required: false`; cut-in lane geometry is still checked by the matcher.
  An authored reveal *target* is not invented as a pass tolerance.
- Solvability's witness is **native-authored scripted choreography**, not a
  learned policy or the bench's cruising setpoint driver. Native whole-clip
  rehearsal must reach the horizon with zero contacts; a kernel `Episode`
  executes the same whole-clip scripted schedule and must end at the horizon,
  never at collision. Both trace identities are retained. This admission-only
  Episode uses scripted warm-up, so its untouched result core intentionally
  says `partial / warmup_terminated`, with zero learned-policy decisions.
  That is not a scored/promotable drive result or a universal solvability proof.
- `drawIndex` is always nonnegative: by default it equals the seed; an explicit
  cell `drawIndex` is the first index and increments per seed. Distinct parameter
  hashes and concretes with the seed field removed must be distinct within
  every admitted independent cell. Paired controls may collapse after hazard
  removal, but their source test draws must remain distinct. Compiler version, native
  binary SHA-256, full template SHA-256, matcher/topology/graph identity,
  site id, seed, draw index and native replay key accompany the products.
- Hazard-removed controls are **paired test interventions**, not independent
  train/val data. Their `pairedWith` pins the test manifest digest. They retain
  ego/map/route/initial conditions and remove non-ego actors, authored
  interactions, props/occluders, occlusion pairs and near-miss criteria.
  Verification permits test/control overlap only for an exact one-to-one,
  digest-checked intervention. Independent splits still require both seed
  and site disjointness; claiming controls themselves are independent would
  be false.
- Later: learnability-gated parameter search (AlignADV 2606.14032,
  E² 2604.07378) as a compiler option with a curriculum ledger.

#### W2 original poc-v1 evidence — 2026-09-22

The native compiler/engine is **0.7.0**, with isolated N-API SHA-256
`4a9d1b71b8d640147fedc3e7124bcbe612c529d12076f9a57cd7a16ceb5aa1c0`.
No installed wheel was replaced and no renderer or GPU was used.

| Grid / split | Proposed episodes | Admitted episodes | Admitted cells | Excluded attempted cells |
|---|---:|---:|---:|---:|
| PoC train | 1,200 | 400 | 4 | 9 |
| PoC val | 120 | 60 | 3 | 3 |
| PoC test | 120 | 60 | 3 | 4 |
| PoC control | 120 | 60 | 3 | 4 |
| Overnight replacement train | 240 | 120 | 2 | 16 |
| Overnight replacement val | 80 | 80 | 4 | 5 |

The manifests, frozen templates, materialized episodes, every attempted-cell
receipt and representative native rehearsal + Episode traces live under
[`qualification/training-splits/poc-v1/`](../../qualification/training-splits/poc-v1/).
The [admission report](../../qualification/training-splits/poc-v1/admission-report.json)
lists all exclusions and a scripted solvability receipt for every admitted
family × map × site, including all seed outcomes. A failed candidate is retained
before another ranked site is considered, so attempted-cell counts exceed the
proposed site quotas. The [verification receipt](../../qualification/training-splits/poc-v1/verification.json)
passes integrity, admission coverage, independent split disjointness and exact
test/control pairing. **That pass does not mean the proposed grid passed:
the PoC scenario-supply/day-7 grid gate fails.**

- `cpnco-parked-row` is excluded on Yale, El Camino, Belmont and Easterbrook:
  every native map-intel index lacks its required `occlusion_zone` layer.
  The feature was not deleted, substituted or treated as available.
- Yale `queue-tail` has no feasible required role/runway binding. El Camino
  training queue candidates fail on a seed-52 ego/queue contact, blocking
  through conflict, or a seed-0 contact. Its validation cell passes all 20
  draws. Both Belmont queue candidates remain blocked at conflict and fail.
- Admitted PoC training is therefore **cut-in-brake only**: two sites each on
  Yale/El Camino, 100 unique concrete draws per site. Validation contains both
  cut-in maps plus El Camino queue. Test contains cut-in on Belmont/Easterbrook
  plus Easterbrook queue; all 60 test draws have paired hazard-removed controls.
  This is not the proposed three-family training distribution.

The separate
[`overnight-v2`](../../qualification/training-splits/overnight-v2/admission-report.json)
replaces the prototype's four-default-cell repetition without altering
`training/ppo-visible-20260922/` or its completed run. Its di-Rosa/San-Ramon
CPNCO-dartout train cells have **120 distinct concrete worlds even with seed
identity removed**, and validation has 80. The 16 attempted queue training
cells fail scripted collision admission; five San Ramon queue validation
candidates fail before the sixth passes. These are a separate experiment's
splits, not an independently seeded union with the PoC grid.

```sh
simforge scenarios materialize --split qualification/training-splits/poc-v1/train.split.json
simforge scenarios verify-splits \
  qualification/training-splits/poc-v1/train.split.json \
  qualification/training-splits/poc-v1/val.split.json \
  qualification/training-splits/poc-v1/test.split.json \
  qualification/training-splits/poc-v1/control.split.json
simforge scenarios verify-splits \
  qualification/training-splits/overnight-v2/train.split.json \
  qualification/training-splits/overnight-v2/val.split.json
```

For a new grid, start a manifest with `schema`, `splitId`, `purpose` and
`cells: [{template, map, site, seeds: {from, to}}]`; paths are relative to that
manifest. Materialization writes `admission`, `materialization` and `digest`
last. The full-fidelity `instances[].input` records load through the existing
gym episode loader; all **780** frozen instances were loaded successfully.
Five focused schema/leakage regressions, a scoped TypeScript check and real
CLI materialize/verify runs passed. Negative smoke checks rejected altered
artifact bytes, rehashed repeated default parameters, and concretes differing
only in seed. Source execution uses `pnpm exec tsx --tsconfig tsconfig.base.json
packages/cli/src/main.ts` with `NODE_OPTIONS=--conditions=development`; select
the isolated addon above when reproducing the recorded native receipt.

#### W2 supply repair and frozen poc-v2 — 2026-09-22

The original three-check admission froze the proposed three-family counts in
[`poc-v2`](../../qualification/training-splits/poc-v2/) without modifying
`poc-v1`. **Poc-v2 is retained as a defective bench reference, not a
bench-qualified grid.** Its native scripted witness suppressed goals and its
rendered smoke used a zero-prologue teacher; neither checked the fixed
63-decision/6.3-second comparison-policy prologue. A later state-only audit
found **356/1,200 train, 38/120 val and 34/120 test** episodes terminating
inside that prologue with zero policy decisions. They reached the new native
**queue safe-stop goal**, not route end. The raw artifacts remain immutable.

| Split | Admitted episodes | Admitted cells | Excluded attempted cells |
|---|---:|---:|---:|
| Train | **1,200** | 12 | 12 |
| Validation | **120** | 6 | 4 |
| Held-out test | **120** | 6 | 5 |
| Paired hazard-removed controls | **120** | 6 | 5 |

- `cut-in-brake`, `cpnco-parked-row` and `queue-tail` all admit on **Yale
  Street, El Camino Road, Belmont Research Center and Easterbrook Discovery
  School**. Train has two sites per family on Yale/El Camino, seeds 0–99;
  validation has disjoint sites, seeds 100–119. Test has one site per family
  on held-out Belmont/Easterbrook, seeds 200–219. Every seed passes; no
  successful prefix of a failed cell was kept.
- Source-dimensioned parking footprints now produce **22/18/18/2** genuine
  parked-row occlusion-potential zones on those maps respectively. Native
  rehearsal still proves actual occupied occluders and reveal-before-conflict
  separately. `school-dartout` and `bus-stop-emergence` remain excluded on
  **all four maps**: the source bundles lack their required `school_zone` and
  `bus_stop` layers. Names and proximity were not substituted for annotations.
- Queue's in-lane, noncollidable truck screen was an authoring defect, not an
  admission-threshold problem. The repaired family has a physical preceding
  van pull into a legal adjacent lane, revealing the stopped queue. Placement
  follows continuous native routes rather than requiring identical OpenDRIVE
  road-section labels. V2's 120 m envelope covered occupied bodies but omitted
  the bench's temporal approach requirement; that reduction was wrong for
  the bench contract. Selected draws stopped at **5.952–6.197 m bumper gaps**,
  often succeeding before a visual policy received its first action. Failed
  geometric candidates remained excluded, but the missing temporal admission
  condition made the original geometry/occlusion/solvability pass insufficient.
- Final frozen admission uses engine **0.7.0 / ABI 4**, isolated addon SHA-256
  `c6cf397691647301545adcfb0eb882b83ea5287bbe1d7d88b6136e700ad14015`.
  Admission-only Episodes explicitly use `goal: null` so the scripted
  witness reaches the full horizon rather than stopping at the newly defined
  queue-success goal. All final draws were rematerialized on this addon;
  the earlier selection survey's separate addon identity is recorded in the
  [admission report](../../qualification/training-splits/poc-v2/admission-report.json).
- Bench bundles now include digest-bound source OpenDRIVE road outlines.
  `simforge.offroad/v3` is available without relabelling the old
  `simforge.offroad/native-lane-polygons-v1` fallback. The installed-loader
  probe classifies all **595/595** sampled non-junction driving-lane centres
  as road (207/188/161/39 by map). This is source-road authority, not surveyed
  or rendered-mesh ground-truth certification. See the
  [derivation note](map-intel-bench-derivations.md) for parking sight lines,
  shoulder/sidewalk treatment, island exclusions, open map cuts, and local
  installation/parent-release digests.

`simforge scenarios verify-splits poc-v2` passes and prints the counts above;
[`verification.json`](../../qualification/training-splits/poc-v2/verification.json)
retains the receipt. `verify-splits poc-v1` also still passes, at its original
400/60/60/60 counts. Independent seeds **and map-intel origins**, held-out
geography, native compiler products, receipt/trace bytes and exact paired
controls are checked.

Two actual Bevy runs using the existing CPU
`torch:teacher/update-000098` policy rendered the new families:

| Family / map | Policy decisions | Verified RGB frame hashes | Result metric |
|---|---:|---:|---|
| CPNCO / Belmont | 140 (14 s) | 282 | `simforge.offroad/v3` |
| Queue-tail / Easterbrook | 130 (13 s) | 262 | `simforge.offroad/v3` |

Both `drive verify` receipts pass, with clean model health and
`alpasim-style-score.unavailable: []`; this is **not an AlpaSim result** and
not a promotion or driving-quality claim. Their exact inputs match seed-200
frozen test episodes. Runs live at
`~/simforge-assets/runs/drive/supply-poc-v2/`; the
[bench receipt](../../qualification/training-splits/poc-v2/bench-verification.json)
pins result hashes, metric IDs, frame/trace verification and the actual visual
inspection. The source road is visibly dark in the CPNCO view and actor
geometry is basic; no perception-quality qualification is implied.

```sh
export NODE_OPTIONS=--conditions=development
export SIMFORGE_NATIVE_RUNTIME_ADDON="$HOME/simforge-assets/runs/drive/training/reward-poc-v1-20260922/runtime/node/simforge-native-runtime.linux-x64-gnu.node"
pnpm exec tsx --tsconfig tsconfig.base.json packages/cli/src/main.ts \
  scenarios verify-splits poc-v2 --pretty
pnpm exec tsx --tsconfig tsconfig.base.json packages/cli/src/main.ts \
  drive verify ~/simforge-assets/runs/drive/supply-poc-v2/poc-v2-cpnco__torch__seed200
pnpm exec tsx --tsconfig tsconfig.base.json packages/cli/src/main.ts \
  drive verify ~/simforge-assets/runs/drive/supply-poc-v2/poc-v2-queue-tail__torch__seed200
```

#### W2 bench-compatible frozen poc-v3 — 2026-09-22

[`poc-v3`](../../qualification/training-splits/poc-v3/) replaces the full grid,
including training; it is not a patch to frozen v2 evaluation cells. The
original v2 manifests and episode bytes remain unchanged and are retained as
the defective reference. New training and the `devpanel32-v3` freeze consume
the following immutable manifests:

| Split | Admitted episodes | Admitted cells | Excluded attempted cells | Canonical manifest digest |
|---|---:|---:|---:|---|
| Train | **1,200** | 12 | 10 | `2f5fc30c2b749040259f475650396fb09c535650a3455952831444fe070b368f` |
| Validation | **120** | 6 | 3 | `885d1a20f883c0b5f8d601994cf7de4ac49e711a1d318580d746c4fe06a652c8` |
| Held-out test | **120** | 6 | 5 | `202c0e3bbe59f68cca5e811bade6ed6cdf02fdbc636aed50ab0ea2589d3dbb98` |
| Paired controls | **120** | 6 | 5 | `d37ef356a841eb50612971b6d620fe352f0f6aa3a1035400a3cca6588b7a94d2` |

All three core families admit on all four maps. The train/validation/test seed,
site-origin and held-out-geography contracts are unchanged. Optional school
and bus-stop families still lack source layers on these maps and are not
silently substituted into the grid.

The queue now has a real 9.4-second driven approach: the queue distance includes
`9.4 * authored_speed_mps`, ego starts at station 50 m, and the required runway
is **241 m**, covering the full approach and occupied queue envelope. The
physical left cut-out is not mirrored. Cut-in starts at **11 s**, with the
initial vehicle gap compensating for the added approach. CPNCO's conflict and
parked row move ten seconds of ego travel farther downstream; its approach
speed is not reduced to manufacture time.

Every one of the **1,560** admitted episode/control rows now carries a fourth
`bench-window` check in `simforge.scenario-admission/v2`:

1. Native measured reveal and non-ego lane-change onset must be **≥9.3 s**,
   the 6.3 s / 63-decision prologue plus a 3 s reaction margin. A requested
   lane change that the native engine rejects is a failure, not a timed onset.
2. A separate native authored Episode has **default route/queue goals enabled**
   and must not terminate before 9.3 s. The old `goal: null` whole-horizon
   safety witness remains separate and cannot conceal an early success.
3. A state-only Episode executes the actual bench prologue followed by **30
   actions from the real 10 Hz scripted bench policy**. It must survive through
   9.3 s. Both additional native trace identities are retained in the
   per-cell evidence, alongside the original full-horizon rehearsal.

Measured onset ranges across admitted hazard rows are **9.4–11.26 s** for
queue (cut-out plus reveal), **11 s** for cut-in, and **10.88–15.72 s** for
CPNCO. The minimum default-goal completion/survival time is **14.4 s**;
all 1,560 benchmark-window witnesses survive through **9.3 s**. Horizon
results are right-censored survival bounds, not invented observed goal times.
These named scripted checks are not a guarantee for arbitrary policy actions.

Actual `simforge scenarios verify-splits poc-v3` passes. The
[verification receipt](../../qualification/training-splits/poc-v3/verification.json)
and [admission report](../../qualification/training-splits/poc-v3/admission-report.json)
retain counts, every family/map/site, per-seed timing proofs, exclusions and
the original v2 input hashes. Rehashed test copies with an early default-goal
time or missing timing proof were rejected by the new verifier; five focused
split-schema regressions passed. All **153 retained native Episode proof
chains** also verify in
[`trace-verification.json`](../../qualification/training-splits/poc-v3/trace-verification.json).
No native runtime changed: admission still
uses ABI 4 addon `c6cf397691647301545adcfb0eb882b83ea5287bbe1d7d88b6136e700ad14015`.
No map bundle or `.corpus` contents changed for this temporal repair.

```sh
NODE_OPTIONS=--conditions=development \
SIMFORGE_NATIVE_RUNTIME_ADDON="$HOME/simforge-assets/runs/drive/training/reward-poc-v1-20260922/runtime/node/simforge-native-runtime.linux-x64-gnu.node" \
pnpm exec tsx --tsconfig tsconfig.base.json packages/cli/src/main.ts \
  scenarios verify-splits poc-v3 --pretty
```

### W3 — Trainer and policy servers

Implemented entrypoint: `simforge train` dispatches
`python -m simforge_oss_gym.train`. Install the gym `train` extra and the
first-party `adapters/policy-endpoint` package in an isolated runtime; select
that interpreter with `SIMFORGE_TRAIN_PYTHON` / `SIMFORGE_TORCH_PYTHON`.
Do not replace an installed wheel used by another run.

```sh
simforge train --recipe ppo-teacher \
  --config adapters/gym/simforge_oss_gym/train/configs/poc-admitted.yaml \
  --max-decisions 200000 --out ~/simforge-assets/runs/drive/training/teacher-run
# The frozen PoC train manifest and its sibling val manifest:
simforge train --recipe ppo-teacher --split train \
  --max-decisions 2048 --out ~/simforge-assets/runs/drive/training/split-smoke
simforge drive run --policy torch:teacher-run/update-000001 \
  --scenario scripts/bench/closed-loop/fixtures/corridor.episodes.json \
  --seed 42 --duration 20 --out ~/simforge-assets/runs/drive/teacher
simforge train --recipe distill-student --config student.yaml
```

Config schema `simforge.train/v1` has `recipe`, `out`, `options`, teacher
`train`/`val` episode paths, optional `splitManifests`, or student
`dataset: {teacher, runs, sensor}`. The packaged configs are runnable examples;
point the student's teacher ref/run paths at the checkpoint actually evaluated.
`poc.yaml` intentionally reproduces the older recorded overnight episodes;
`poc-admitted.yaml` uses W2's admitted subset, **not** the rejected complete grid.
Teacher budgets stop before a partial PPO rollout rather than exceeding
`--max-decisions`. A resolved config, its digest, and provenance are frozen in
the run directory. Linked split manifests must match the materialized episode
SHA-256; legacy episodes record their own digest without an admission claim.

Every checkpoint is copied atomically into
`${SIMFORGE_ASSETS_ROOT:-~/simforge-assets}/models/simforge-policy/<run>/<update>/`
with `entry.json` and `checkpoint.pt`. Entries carry family/revision, SHA-256,
observation preset, action head, recipe/config digest, split digests, kernel
version and git SHA. Reusing a revision with different bytes is refused.
`models list` and `modelStoreView().policies` list this local trained family
separately from downloadable offers. `torch:<run>/<update>` (also
`torch:simforge-policy/<run>/<update>`) re-hashes the stored checkpoint before
serving. Explicit teacher checkpoint paths still work; camera students use
typed store refs so their camera/control contract is known before rendering.
The obsolete `scripts/rl/train_ppo.py` and drawIndex=-1 materializer are removed.
The frozen `qualification/policy-eval-runner` remains an archival evaluator
for its external old sv+BEV trainer/checkpoints; it does not load this family.

**Student recipe:** real ImageNet-initialized ResNet18 + 256-GRU behavior
cloning, with 640×360 RGB, speed/yaw-rate and eight ego-frame navigation points.
Only these tensors enter the model; object truth, absolute pose and map identity
are not features. The adapter retains timestamped anchors for coordinate
conversion, not learned inputs. RGB resizing is explicit bilinear preprocessing.
Recurrent state is per socket connection and resets on `hello`/`reset`.
The bounded control head emits effort/steering and splits effort into pedals.
Data comes from completed bench run dirs: PNG digests, the pre-action native
state/route channel, exact teacher replay, and kernel `appliedControl` labels
must agree. These labels are the actual **final physics-substep** actuator
inputs, after the follower/jerk envelope—not guessed controls from setpoints.
Older runs lacking those fields are refused with a re-render instruction.
`train/relabel.py` now accepts completed student-driven camera runs for DAgger:
it replays the exact visible state through the native `EpisodeBatch`, snapshots
and restores the counterfactual before executing the frozen teacher action, and
requires matching native state, actuator, trace and RGB digests. Teacher labels
remain render-free and are never inferred from setpoints. The paired BC/DAgger
campaign is still a PoC until its preregistered budgets, validation selection,
held-out promotion, statistics and release evidence are complete.

**Wire v3:** `hello.protocol = simforge.policy-endpoint/v3` advertises
`calibrationRequirements`, `historyRequirements`, and
`planContract:{horizonS,hz,frame}`. Only negotiated v3 calls receive camera
intrinsics, instantaneous native exposure timestamps, actual wire resize
transforms, and ego/route anchors with age/validity. Current native rigs are
pinhole; no f-theta coefficients are invented. Responses carry
`plan:{id,anchorTs,horizonS,adoptionTick}` and
`health:{fallback:none|prologue|closedLoop,reason}`. Adoption is the integer
50 Hz simulation barrier tick, never response wall time. Wrong anchors/ticks
or missing health are refused. Held plans keep their original identity; hold
is not a new plan or a fallback. Torch, Alpamayo, Qwen-Drive, AutoE2E and the
bench's Jev all speak this MessagePack wire. Jev additionally retains its
explicit loopback HTTP transport; its decision implementation is shared.
Unadvertised/v2 servers receive their unchanged v2 requests.

**Qualification:** `python tools/policy-qualify/qualify.py --config CONFIG.json
--out RECEIPT.json` consumes `simforge.policy-qualification-config/v1`: an
immutable local Docker image id, a Python `command` array (`{socket}` is
substituted), a real MessagePack `{hello,act}` fixture, complete
`dependencies:{distribution:exactVersion}`, `env`, `scratchMiB`,
`maxLatencyMs`, `maxRssMiB`, and optional readiness/request/total timeouts.
It checks the actual installed runtime in a no-network, read-only-root
container with bounded scratch; no model/dependency downloads occur.
The image supplies the namespace shell and the host runtime is mounted
read-only: this is a trusted-server operational qualification, not an
untrusted-code security sandbox or a portable self-contained model image.
Literal `READY ` plus a bound socket, two concurrent sessions, restart,
output identity, latency and peak RSS are measured. A failure exits nonzero
and emits a non-qualified receipt; timeout cleanup removes the owned container.
Set `SIMFORGE_POLICY_QUALIFICATION=/path/receipt.json` for a bench run. The bench
checks model/checkpoint identity and freezes the receipt into `run.json.model`
at startup. Qualification is separate from driving score and promotion.

**Bounded evidence (2026-09-22):** [W3 receipt](../../qualification/trainer-w3/verification.json).
The 200k-budget legacy-grid teacher run completed 198,976 real decisions,
98 updates, and a registered checkpoint; a separate admitted-manifest smoke
recorded both W2 split digests. Its 20 s Bevy rollout verified 402 PNG hashes.
The student trained end-to-end on 200 real frames (11,782,210 parameters,
loss 0.002171545) and executed a 10-decision control rollout. Torch and
AutoE2E CPU server qualifications passed. A composed heat contains a real
checkpoint on the frozen PoC v2 compatibility server and AutoE2E v3, 20
decisions each; their different prologue requirements make it a **wire proof,
not a matched policy-quality comparison**. No full PoC training, DAgger,
held-out student result or promotion is claimed.

### W4 — Evaluation as promotion gate
- `simforge eval promote <ckpt>`: held-out campaign, rerun determinism,
  comparison table against cached frontier results on the same split at
  matched 2 Hz replan / offline-simtime, `heat.mp4` for the top checkpoint.
- **Model-health receipt** (prerequisite, separate from score): expected vs
  completed sessions, genuine plan count, prologue vs closed-loop fallbacks,
  invalid plans, timeouts, plan/drive/queue p50/p95, max plan age. Zero
  closed-loop fallbacks and zero invalid plans are required before a score is
  read.
- **Frozen panels:** canary (8) → devpanel (32) manifests with explicit RNG
  seeds (never arrival order), paired controls, mean ± SE, per-failure
  breakdown. Gate convention `mean ≥ reference − 1 SE` recorded, not implied.
- **Named optional metric** `alpasim-style-score`: hard failure
  (front/lateral at-fault collision, offroad, lateral corridor exit ≥4 m) → 0,
  else `min(progress/0.8, 1)`. Reported next to `drivingScore`, never in place
  of it, and never labelled an AlpaSim result.
- Baselines: teacher, BC-only student, nav-only ablation (visual shortcut
  detector), Alpamayo 1.5, Qwen-Drive planner-sft and planner-rl, AutoE2E.
  Jev is reported separately as privileged text input.
- Release bundle `training-poc-v1`: frozen configs/hashes, checkpoints,
  learning curves, per-seed traces, `score.json`, provenance, manifests; six
  predetermined uncut comparison videos incl. the worst failure, one exact
  replay, one held-out-map run.

#### W4 implementation and promotion semantics

```sh
simforge eval promote torch:teacher/update-000098 --split test --panel canary8
# Optional explicitly registered BC checkpoint; never rename scripted as BC:
simforge eval promote torch:student/update-000001 --panel devpanel32 \
  --bc-baseline torch:bc-run/update-000001 --comparisons auto-e2e
pnpm exec tsx tools/release-bundle/build.mts PROMOTION_DIR --id v1 \
  --training-run TRAINING_RUN_DIR
```

`--split` defaults to `test`; train/validation are refused. `canary` and
`devpanel` are command-line spellings for `canary8` and `devpanel32`. The default
comparison runs scripted and AutoE2E, sequentially, rather than claiming the
old corridor/lead-brake caches are this panel. `--comparisons` accepts an
explicit comma-separated frontier list; absent models are reported, not
silently replaced by scripted driving. Jev remains privileged text input.

The frozen [panels](../../qualification/panels/) are pre-outcome,
manifest-order round-robin samples of **admitted** PoC test cells and their
exact hazard-removed controls: canary8 is four hazard/control pairs,
devpanel32 is sixteen. RNG seeds are the materialized seeds (200 onward),
not arrival labels; canary is the prefix of devpanel. Source bytes, canonical
panel/input hashes, admission receipts and the installed lane-graph identity
are checked. This is still the admitted subset of the failed proposed W2
supply grid, not a repair of that gate.

All policies use 2 Hz model replanning, 10 Hz Episode barriers and
`offline-simtime`, with the same **64 real history frames / 63 authored
warm-up decisions (6.3 s)** before the evaluated duration. Held world plans
keep their issuance pose while their follower preview advances; held teacher
setpoints/student controls are not fresh plans. The authored clip duration
is evaluated after this prologue, so early hazards may already have unfolded.
This is a matched starting-state comparison, **not** proof that every authored
hazard was encountered under policy control. Geometry-based route completion
uses the authored route remaining at policy start, not speed × clip time.

The promotion evaluator first obtains every expected/completed-session
model-health receipt for one policy. A missing/partial session, closed-loop
fallback, invalid plan, timeout, missing genuine model plan, wrong input/hash,
wrong timing, or appearance-ablation cache fails that prerequisite. **No
`score.json` for that policy is opened until all its health receipts pass.**
Artifact SHA-256/size checks then precede score aggregation. Fresh-plan
latency and all-barrier latency have separate denominators; unmeasured queue
latency remains null, not zero.

Every candidate panel entry is rerun through the same bench. Both native
chains are verified. Matching world/actions/scene identity with differing
camera hashes is explicitly `rendererNondeterminism`, never RGB bit identity.
`promotion.json` records `qualified`, `exploratory`, or
`insufficient-evidence`, all reasons, the per-policy comparison, both metric
instruments, per-seed results and rerun evidence. The registered checkpoint's
`promoted` flag agrees with the verdict; `entry.json.promotion.receipt`
references an immutable `promotions/<sha256>.json` receipt, not an inline
report. Python and TypeScript readers verify the same identity and digest.

`alpasim-style-score` is opt-in (`drive run --alpasim-style-score`, enabled
by promotion). Its result object includes the explicit label **“not an
AlpaSim result”**, value, hard failures and missing-authority reasons.
Collision attribution uses the normalized OBB face facing the partner
centre at the detector's swept time of impact: front/lateral/rear, with
corner ties lateral. This is a geometric heuristic, not legal fault.
It is recorded as `collision.side` in v2 and retained in campaign conversion;
collision-event traces therefore gain a new identity, while non-contact
traces retain theirs. `drivingScore` keeps its separate infraction penalties.

Installed bench `lane-polygons.geojson.gz` supplies a separately named
`simforge.offroad/native-lane-polygons-v1` footprint instrument, projected
with the existing OpenDRIVE coordinate-frame authority. It is **not**
the ClipGT road-boundary `offroad/v3` instrument. Until full reference-control
admission establishes that these lane unions are authoritative road surfaces,
their confidence is low and the named hard-safety metric reports offroad
authority unavailable. Missing authority never becomes a clean zero count:
a proven front/lateral collision or ≥4 m corridor exit still forces zero;
otherwise the named value is null. Legacy traces with no contact side are
likewise unavailable for fault attribution, not assumed rear-only.

Day-28 statistics use the panel's fixed RNG seed and 10,000 paired bootstrap
replicates, with a percentile 95% CI for **BC collision rate minus candidate
collision rate**. Only matched hazard test episodes enter this calculation;
controls are interventions, not independent samples. The ≥20% relative
reduction, strictly positive CI lower bound, and ≤2 percentage-point
completion-loss criteria are reported together. Missing matched BC data
or a zero-collision BC ceiling yields **insufficient evidence** without
changing the frozen test. Canary-only evidence cannot qualify a checkpoint.
Neither an infrastructure pass nor these statistics alone prove DAgger
efficacy, full-grid admission, budget compliance, or real-world safety.

The release tool creates
`~/simforge-assets/runs/drive/training/release/training-poc-<id>/`
with frozen inputs, source manifests, checkpoint refs, optional supplied
learning curves, per-seed traces/scores/result manifests, provenance and a
digest inventory. Six slots are fixed by rule before selection: first hazard
vs frontier, its paired control, worst observed hard failure (lowest driving
score, id tie-break), first passing exact-world replay, first hazard on the
second held-out map, and first hazard vs the explicitly named BC baseline.
Available slots contain uncut recorded comparisons; absent evidence produces
a plainly labelled **MISSING** video card plus a receipt. No missing failure,
BC model or training curve is fabricated. Original result manifests retain
their source artifact references; omitted PNG sets are explicitly external,
not falsely claimed to be included.

Frontier model weights remain subject to their upstream licences and are
referenced, not redistributed by this tool. REGEN is non-commercial,
research-use-only; an appearance ablation or release video is not a product
licence grant, and raw promotion never silently consumes enhanced input.


#### W4 measured canary — 2026-09-22

[W4 verification receipt](../../qualification/panels/w4-verification.json).
The requested teacher command ran end to end, then resumed from all 24
comparison runs and generated a fresh eight-episode rerun proof. The verdict
is **`insufficient-evidence`**, and the store leaves `promoted: false`.

| Policy | Episodes | drivingScore mean ± SE | Collision episodes | Named hard-failure zeros / unavailable |
|---|---:|---:|---:|---:|
| `torch:teacher/update-000098` | 8 | 0.141955 ± 0.049767 | 0 | 0 / 8 |
| `scripted` | 8 | 0.334768 ± 0.087283 | 1 | 1 / 7 |
| `auto-e2e` | 8 | 0.112092 ± 0.020184 | 1 | 5 / 3 |

All three comparison groups have complete sessions and zero closed-loop
fallbacks, invalid plans and timeouts. AutoE2E has four ≥4 m corridor exits
and one front/lateral collision. Each named-metric aggregate remains
unavailable because it includes clean-but-unassessed offroad cases; unknown
values were not dropped to manufacture a mean. These are **not AlpaSim
results**.

The teacher passes the recorded reference-minus-one-SE convention
(threshold 0.091908), but its hazard-only driving mean is **0.010760** versus
**0.273149** on controls: it often stops with almost no hazard-route progress.
Zero observed collisions is not evidence of useful driving or BC/DAgger
improvement. Missing matched BC results, missing authoritative road-surface
assessment, and canary-only coverage prevent qualification.

All eight latest teacher reruns match world, policy and scene identity;
all eight retain differing camera hashes as renderer nondeterminism.
The latest selected **32** run directories (24 comparisons + 8 reruns)
passed the full drive verifier: **15,540 PNG digests**, **2,787 policy
decisions**, sealed trace chains and exact final-scorer parity. The earlier
eight rerun directories are retained separately, not mixed into statistics.
The native contact/visibility contract passes 11 tests and retains the
privileged `2243af51…` digest; 58 targeted evaluation tests pass. A real
four-decision collision verifies native→Python-campaign contact-side
projection. TypeScript and Python both load the store's same receipt and
reject altered receipt bytes.

Artifacts:

- Promotion and verification:
  `~/simforge-assets/runs/drive/training/promotions/torch_teacher_update-000098__canary8/`.
- Release:
  `~/simforge-assets/runs/drive/training/release/training-poc-v1/` —
  **227 digest-verified files**, 33,183,258 bytes, checkpoint refs and supplied
  teacher learning curves. Four uncut comparison slots are present
  (14.4, 14.4, 14.4 and 19.4 s); the no-observed-candidate-hard-failure and
  absent-BC slots are explicit three-second MISSING cards. All six are H.264,
  1024×384, 10 FPS; exact-replay, held-out-map and missing-card frames were
  visually inspected.
- Combined isolated N-API:
  `/tmp/simforge-appearance-native/node/`, SHA-256
  `cca27c2d7b07b4ec762f0a2d392696f9f7b8833a11699bb077ade884c8215af6`.
  The CPU teacher uses `/tmp/simforge-promotion/python`; no installed wheel
  was replaced.

A separate one-second Jev smoke verifies two fresh decisions (steps 0 and 5),
with its existing held-plan follower still running at every 10 Hz barrier.
It recorded **10 model-owned deadline fallback decisions and zero genuine
plans**, so it is exploratory and excluded from the canary comparison; its
148 PNG hashes and trace were verified. This does not qualify Jev or relabel
model-owned timeouts as a kernel offline deadline.

### W5 — Appearance streams (isolated, optional)
- `--enhance regen:<onnx>` frame filter in the kernel sensor path producing a
  second observation stream; offline Cosmos-Transfer pass over recorded
  rollouts producing paired datasets. A SimForge-domain REGEN requires an
  EPE/diffusion target pass over ~10–20k Bevy frames first.
- Evaluated raw vs enhanced in W4; never a silent default; licences cleared
  before product use.

Implementation/evidence: [Appearance streams](appearance-streams.md). The live
REGEN raw/enhanced path and independent AutoE2E ablation sessions are verified;
the two 20-second scripted runs reproduce all 200 world/action/observation/
control records, not RGB hashes. Cosmos has 200 prepared native RGB/depth/seg
control triples and **zero generated pairs**: the pinned runtime/image and
complete authorized weights were unavailable. That external blocker is
recorded explicitly, not replaced by REGEN output or a fabricated offline pass.

## Explicitly not copied from AlpaSim
Implicit seed labels; wall-clock-dependent plan adoption; silent
constant-velocity survival; camera/history padding; route-chord fabrication
across the 40 m start trim; rear-contact-is-not-at-fault as legal truth;
missing geometry counted as a pass (ours is `unavailable`); pickle debug
parsing; destructive run-directory replacement; the gRPC microservice topology
(the resident native runtime with a single tick owner and shared-memory frames
is the stronger design).

## Claims we may make, and may not
Defensible: "SimForge trains and evaluates this bounded camera policy, with a
quantified on-policy correction benefit and reproducible world state, judged
next to three public models on held-out scenarios and an unseen map."
Not defensible: real-world safety or transfer, universal photorealism,
leaderboard equivalence with AlpaSim/NAVSIM, blanket RGB bit-determinism,
faster-than-CARLA at equal visual quality.

## Sequencing
Bench batch → four-model heat verified → cleanup pass → W0 → W1 ∥ W2 →
PoC teacher (day-7 gate) → W3 → student distillation → W4 (day-28 gate,
release bundle) → W5 ablations.

## Day-7 result — 2026-09-22

**Result: insufficient evidence; the teacher is not promoted.** The original
`poc-v2` attempt **failed the grid kill criterion**. Its queue goal completed
inside the common 6.3 s bench prologue in **356/1,200 train, 38/120 val and
34/120 test episodes**. The first rendered v2 scripted entry, Belmont
`test-cell1-seed200`, sealed a valid native trace at **6.0 s**, with
`decisions: 0`, `status: partial`, `termReason: goal` and
`truncation: warmup_terminated`; drive finalization rejected the zero-decision
run. Neither its timing nor its goal was overridden. Frozen v2 bytes and the
failed attempt are retained; no v2 checkpoint was selected or gated.

The authorized replacement is the fully rematerialized **poc-v3** grid above,
with three freshly initialized seeds and the pre-selection frozen
`devpanel32-v3` panel. This is a new experiment after a discovered supply
defect, not a retroactive pass for v2. V2 seed 42 completed as an explicitly
defective reference; seed 43 stopped gracefully when v3 froze; seed 44 had
already completed. V2 consumed **89,187,274 decisions / 5.122856 learner
GPU-hours**, all counted rather than discarded.

### Training, selection and native validation

Training ran on **simforge1**, one A100 per fresh seed (GPUs 1/2/3), all
1,200 frozen train worlds, eight native workers, two Torch threads,
64-decision rollouts, 1,024-sample minibatches, four PPO epochs and validation
every 20 updates plus first/final checkpoints. Each seed had the unchanged
**30M-decision / six-hour cap** and stopped before another full rollout would
exceed its decision budget. No reward constants or thresholds were tuned.

| Seed | Actual decisions | Updates | Learner wall seconds |
|---|---:|---:|---:|
| 42 | 29,949,974 | 392 | 5,883.627 |
| 43 | 29,977,953 | 393 | 5,962.443 |
| 44 | 29,948,047 | 392 | 5,775.921 |
| Total | **89,875,974** | | **4.894997 learner GPU-hours** |

Concurrent orchestrator wall was **5,980.522 s**. Including the defective v2
attempt, learner use was **10.017854 A100-hours**, below the proposed
72-hour teacher allocation. Seed 44 initially shared GPU 3 with a separately
coordinated Qwen server until its migration; these are not exclusive-device
throughput measurements. All eleven native reward means are recorded; the
maximum per-update term-sum residual across v3 seeds is **6.94e-17**.
Resolved recipes, provenance, model-store entries, per-family validation
history, live dashboards and three measured-dashboard timelapses are retained.

The preregistered selector maximized deterministic **poc-v3 validation
episode return**, with collision rate, completion, seed and update as tie
breaks. Test outcomes never entered selection. It chose
**`torch:teacher-poc-v3-20260922-seed44/update-000140`**, at **10,698,114**
training decisions, SHA-256
`4ccf7807ec625dedbc20e9b78feb3c8019cc30cf5393bfb9b78633c9dc7566af`.
Later checkpoints did not replace it on the basis of test results.

| Native validation family | Contact episodes | Mean progress, m | Mean geometric completion | Goal episodes | Unnecessary-stuck decisions |
|---|---:|---:|---:|---:|---:|
| CPNCO parked row | 2/40 | 165.568 | 72.417% | 18/40 | 16 |
| Cut-in/brake | 0/40 | 169.586 | 64.021% | 0/40 | 0 |
| Queue tail | 1/40 | 150.379 | 34.261% | 39/40 | 0 |
| All | **3/120 (2.5%)** | **161.844** | **56.900%** | **57/120** | **16/22,689** |

The 16 native unnecessary-stuck decisions total **1.6 s**, one decision in
each of 16 CPNCO episodes; queue-exempt waiting is not counted as stuck.
There were 60 horizon, 57 goal and three contact terminations. **Gate criteria
are not fully specified** for validation collision rate, progress and
no-stuck: this table is measured evidence, not an invented numerical pass.

After selection, the entire frozen **120-episode v3 test** also ran state-only:
**0 contact episodes, 40 route-corridor exits, 37 goals, 43 horizons,
36.464% mean completion and zero native unnecessary-stuck decisions**.
Per-family completion was CPNCO **20.462%**, cut-in **35.435%**, queue
**53.495%**. Zero contacts does not erase the corridor failures or establish
safe/useful driving. This 10 Hz, no-prologue native diagnostic is separate
from the matched 2 Hz promotion instrument below.

### Frozen rendered promotion

The actual source CLI ran `eval promote <selected-ref> --split test` on both
`devpanel32-v3` and the unchanged v1 `devpanel32`, with
`--comparisons scripted,torch:reward-poc-v1-20260922/update-000079`.
Both comparators were registered before candidate selection; the old 2M
teacher is **not** a BC student. Every row below has 32 episodes, including
16 paired controls; controls are not independent hazard samples.

| Panel | Policy | drivingScore mean ± SE | Contacts | Mean completion | Named metric mean ± SE |
|---|---|---:|---:|---:|---:|
| v3 | Selected teacher | **0.560850 ± 0.067546** | **0/32** | **61.628%** | unavailable |
| v3 | Scripted | 0.454150 ± 0.054217 | 6/32 | 56.587% | unavailable |
| v3 | Old 2M teacher | 0.434404 ± 0.060104 | 6/32 | 54.590% | unavailable |
| v1 | Selected teacher | **0.379281 ± 0.043614** | **0/32** | **45.668%** | **0.440127 ± 0.071071** |
| v1 | Scripted | 0.319928 ± 0.039131 | 5/32 | 38.418% | 0.338805 ± 0.056485 |
| v1 | Old 2M teacher | 0.490937 ± 0.041035 | 5/32 | 51.859% | 0.514815 ± 0.066338 |

The named metric is **“not an AlpaSim result.”** V3 candidate results include
**nine offroad hard-failure zeros, 18 positive values and five unavailable
values** at unassessed road support; unknowns were not dropped to manufacture
an aggregate. The v1 candidate has five offroad hard failures. The selected
teacher passes the preregistered scripted-minus-one-SE convention on both
panels (thresholds **0.399933 / 0.280798**), but its v1 mean is lower than the
old 2M teacher's. No statistical-significance or BC/DAgger benefit is claimed.

Both promotion verdicts are **`insufficient-evidence`**, and the model store
keeps **`promoted: false`**. Both lack a matched BC baseline; v3 additionally
has unavailable authoritative-offroad cases. All three policies have complete,
clean 32-session health receipts on both final panels, with zero closed-loop
fallbacks, invalid plans and timeouts. The v3 candidate produced **812 genuine
plans**. All **64/64 candidate reruns** match world, actions and scene identity;
**0/64 are RGB-bit-identical**, explicitly retained as renderer nondeterminism.
Across the two final panels and three family rollouts, **259 complete runs,
87,546 PNG digests and 27,386 policy decisions** passed drive verification.

Two orchestration failures remain visible in the evidence. The first v1
attempt had one camera `EAGAIN` and correctly withheld candidate scores; its
partial run and exploratory receipt were preserved before the exact unchanged
CLI resumed and completed the missing run plus all reruns. The first v3 CLI
completed its promotion receipt but heat composition failed after premature
local frame pruning; exact archived frames were restored and real
`drive compose` completed. Neither failure changed the selected checkpoint,
scenarios, timing, reward, gate or reported final scores.

### Kill-criteria checklist and scope

| Exact contract condition | Recorded outcome |
|---|---|
| Day 7: stop if grid/ground-truth gates fail | **Triggered for v2**; disqualified, no selection/gate. Fresh v3 passes all 1,560 geometry/occlusion/solvability/bench-window admissions and remote split verification. Simulated source-road authority is not surveyed/rendered-mesh certification; this run does not newly prove every W0 CLI/Gym/campaign parity prerequisite. |
| Day 7: kernel sustains ≥5,000 state decisions/s | **Pass:** fixed suite, 64 worlds / eight workers on simforge1: **29,368.263 corridor / 11,596.457 VRU decisions/s**. All three windows and unchanged fixtures retained. |
| Day 7: kernel sustains ≥10 rendered student decisions/s | **Pass for the kernel camera workload:** actual `student-front`, 640×360, RTX 5080, **20.996918/s** median; windows **20.873811 / 20.996918 / 21.999989**. Includes Episode/trace/RGB/readback; excludes model inference, startup and PNG/video encoding. Not an end-to-end trained-student benchmark. |
| Day 28: DAgger reduces held-out contact episodes ≥20% vs matched BC | **Not evaluated / insufficient evidence:** no matched BC or DAgger stage. Scripted and old teacher are not substituted for BC. |
| Day 28: positive paired-bootstrap 95% bound | **Not evaluated:** no matched BC pairs; no invented bound. |
| Day 28: task-completion loss ≤2 points | **Not evaluated:** no matched BC comparison. |
| Day 28: stays within budget | Teacher learner allocation remains within budget; complete student/DAgger/evaluation budget has not been exercised or qualified. |
| Zero-collision BC ceiling | No BC result exists; never used as permission to alter frozen tests. |

The **5,393,797-parameter** teacher still uses visible objects and ego motion
with native route steering; actor history/route tokens and learned steering
remain prototype deviations. No camera-student, DAgger, complete W0 admission,
perception quality or real-world safety claim follows from this teacher stage.

### Artifacts and rendered rollouts

Local evidence root:
`~/simforge-assets/runs/drive/training/teacher-poc-v3-20260922/`.
The originally requested v2 root remains alongside it with
`day7-defective-split.json`, `reference-summary.json`, its complete learning
history and original failure. Each root's `remote.json` points to bulk evidence
on **simforge1**, under `/home/ubuntu/simforge-assets/runs/drive/training/`.
The isolated, remotely source-built ABI-4 runtime is retained in the v2 root:
PyO3 SHA-256 `3b2d8cdd8089833d06eff198128a97bef22f95becff48706517f5dd1d2a60f31`,
N-API `14b637cc64565ca53335b985ff257c08157933ceaf5924370544413aecdb8085`.
No shared wheel was replaced. Map replication checked **54,275 files**
with no rsync checksum differences and **120 key SHA-256 identities**.

The v3 root contains `metrics.jsonl`, per-seed metrics/checkpoint refs,
`val-by-family.jsonl`, `val-by-family.json`, `training-summary.json`,
`selected-{val,test}-detailed.json`, `promotion-summary.json`,
`verification.json`, `training-timelapse.mp4`, and:

- `promotions/devpanel32-v3/promotion.json` and
  `promotions/devpanel32/promotion.json`, both metric instruments, all health
  and replay evidence, and composed `heat/heat.mp4`.
- `rollouts/<family>/teacher-poc-v3-<family>__torch__seed200/drive.mp4`.
  Inputs were the first frozen test member per family, fixed before selection.
  All requested **20 s** through `drive run`: cut-in completes **20.0 s /
  200 decisions / 402 PNG hashes**; CPNCO terminates on corridor exit at
  **9.3 s / 93 / 188**; queue terminates at its clean goal at
  **16.5 s / 165 / 332**. Videos are **20.1 / 9.4 / 16.6 s**, respectively,
  including reset frames. They were visually inspected, not padded or continued
  past native termination to manufacture three full-length clips.
- `remote-artifacts.json` per rendered run: full PNG sets were verified,
  copied and checksum-checked remotely before local non-inventory frames were
  removed. Local copies retain every result-manifest artifact; use the remote
  full run for another complete `drive verify`.

The dashboard timelapses show actual chronological saved plots (H.264,
1400×1000, 10 FPS), not fabricated rollout imagery. Local evaluation used a
pinned pre-showcase source/renderer so later CARLA-catalog appearance changes
did not silently alter candidate/baseline comparability.

## Day-28 result — 2026-09-23

**Result: insufficient evidence; the recipe is not validated and no student is
promoted.** The preregistered primary gate on the frozen `devpanel32-v3` panel
returns `insufficient-evidence` for the stated reason
`zero-collision BC ceiling: insufficient evidence, frozen test unchanged`:
the matched BC-100k baseline has **0/16 collision episodes** on the hazard test
entries, so no ≥20% collision reduction can be measured. Per the
preregistration this is not permission to alter the frozen test, and the
ceiling is not a safety claim — it comes with **24.78% mean task completion**,
i.e. a student that mostly fails to drive the route rather than one that drives
it safely. All four promotion verdicts are `exploratory`.

### Training, validation and selection

Three seeds × three arms produced **21 fixed-architecture training stages** of
the **11,782,210-parameter** ResNet18+GRU student, **2,400,000 physical
optimizer presentations** (600k shared initial presentations fork into all
three arms; per-arm attribution is 1,200,000 each and must not be summed as
compute), and **3.764676 learner A100-hours**. Unique labels were 100,000
teacher demonstrations, 100,000 student-visited DAgger labels over two rounds
and 100,000 additional teacher demonstrations for the secondary arm;
acquisition executed **300,806 policy decisions** and **305,986 rendered
frames** over **20.29 hours** of shared, non-exclusive renderer wall.

All nine final checkpoints ran the complete frozen **120-episode poc-v3
validation** split deterministically, 1,080 episodes in total. Selection used
only the preregistered criterion — maximum mean native episode return, with
collision, completion and seed tie breaks — and never consulted test.

| Arm | Seed | Mean native return | Collision episodes | Mean completion |
|---|---:|---:|---:|---:|
| BC-100k | **42** | **−6.42951** | 0/120 | 23.009% |
| BC-100k | 43 | −7.52984 | 0/120 | 16.174% |
| BC-100k | 44 | −6.95248 | 0/120 | 22.042% |
| DAgger | **42** | **−4.50103** | 5/120 | 28.810% |
| DAgger | 43 | −6.53670 | 1/120 | 23.511% |
| DAgger | 44 | −5.41121 | 30/120 | 31.733% |
| BC-200k | 42 | −7.01701 | 2/120 | 19.342% |
| BC-200k | 43 | −7.69347 | 0/120 | 17.068% |
| BC-200k | 44 | **−6.88452** | 4/120 | 19.664% |

Selected: BC-100k `torch:student-poc-v3-20260922-bc100k-round2-seed42/update-000004`
(SHA-256 `7fbb0cc21a250ca95f6a470966a9d4d6e45f64568cb7521ac600e9efdd996667`),
DAgger `…dagger-round2-seed42/update-000004`
(`f60394c67c2406d0ba2bc4d86c1c70e9ab4f5efa889e8fdf603542613221e8bc`),
BC-200k `…bc200k-round2-seed44/update-000004`
(`4a269f1ad04c49e4fdb9e81569be198a440786d9439244e6ff1940033323b2e0`).
Every BC-100k seed has zero validation collisions and the lowest completion of
any arm; DAgger buys completion and pays in contacts. That trade is the whole
result of this stage.

### Frozen rendered promotions

`simforge eval promote <ref> --split test` ran on both frozen panels, BC-100k
first as the primary comparator and DAgger with `--bc-baseline <BC-100k>` and
`--comparisons scripted,<teacher>,<BC-200k>`. Every row is 32 panel episodes,
16 hazard test plus 16 paired controls; controls are never independent samples.

| Panel | Policy | drivingScore mean | Mean completion | Collision episodes |
|---|---|---:|---:|---:|
| v3 | Frozen teacher | 0.560850 | 61.628% | 0/32 |
| v3 | Scripted | 0.454150 | 56.587% | 6/32 |
| v3 | BC-100k | 0.205343 | 26.025% | 0/32 |
| v3 | DAgger | 0.132829 | 16.480% | 0/32 |
| v3 | BC-200k | 0.112148 | 13.264% | 0/32 |
| v1 | Frozen teacher | 0.379281 | 45.668% | 0/32 |
| v1 | Scripted | 0.319928 | 38.418% | 5/32 |
| v1 | BC-100k | 0.097644 | 15.911% | 0/32 |
| v1 | DAgger | 0.104056 | 16.965% | 3/32 |
| v1 | BC-200k | 0.084618 | 11.689% | 6/32 |

All five policies have complete, clean 32-session health receipts on both
panels: zero closed-loop fallbacks, invalid plans and timeouts. Every student
fails the preregistered scripted-minus-one-SE reference gate (thresholds
0.399933 on v3, 0.280798 on v1). `drive verify` passed **448 run directories,
156,152 PNG digests and 30,583 policy decisions** across both panels including
all reruns.

### Day-28 statistics

`tools/training/day28-statistics.mts` recomputed the 10,000-replicate
fixed-seed paired bootstrap over the 16 matched hazard entries and checked it
against the promotion implementation.

| Panel | Comparison | BC coll. | DAgger coll. | Collision-reduction 95% CI | ΔdrivingScore (95% CI) | Δcompletion (95% CI) | Gate |
|---|---|---:|---:|---|---|---|---|
| v3 | **primary** BC-100k | 0/16 | 0/16 | [0, 0] | −0.054728 ([−0.100054, −0.016108]) | −0.077 ([−0.133582, −0.029642]) | insufficient-evidence |
| v3 | secondary BC-200k | 0/16 | 0/16 | [0, 0] | +0.024795 ([−0.002811, +0.050819]) | +0.035 ([−0.009307, +0.081690]) | insufficient-evidence |
| v1 | primary BC-100k | 0/16 | 3/16 | [−0.375, 0] | +0.029312 ([+0.004801, +0.052704]) | +0.050 ([+0.037128, +0.062674]) | insufficient-evidence |
| v1 | secondary BC-200k | 6/16 | 3/16 | [−0.1875, +0.5625] | +0.057902 ([+0.039795, +0.076700]) | +0.066 ([+0.053669, +0.079188]) | failed |

Per family on the primary v3 comparison, collision counts are zero in every
cell: CPNCO 0/5 both arms (BC drivingScore 0.094213 vs DAgger 0.109900),
cut-in/brake 0/5 (0.221000 vs 0.136671), queue-tail 0/6 (0.256840 vs 0.168099).
On v1 the only collisions are DAgger's **3/5 queue-tail** and BC-200k's
**6/11 cut-in/brake**; the one comparison where DAgger halves collisions
(secondary, v1: 6 → 3, 50% relative reduction) still **fails** because its
paired 95% lower bound is −0.1875, not positive. No primary claim is built
from a secondary label-matched arm.

### Camera-student rerun determinism is a world/action finding

**0 of 128 camera-student reruns (32 per promotion × 4 promotions) matched
world, actions and scene identity; 0 were RGB-identical; there were zero
verification errors.** This is a different failure mode from the teacher stage,
where the state-only policy was 64/64 world/action identical with 0/64
RGB-identical on the same instrument. Inspecting `test-cell0-seed200`, the
reset row and every row of the 64-frame authored prologue differ **only** in
the camera RGB frame digests; the first differing applied action is the first
policy decision after warmup, and from there the episodes diverge outright —
64 versus 52 decisions with different native episode digests. For a
pixels-to-controls policy, renderer RGB nondeterminism is therefore not a
separately reportable RGB-only caveat: it propagates through the policy into
world state. The rerun proof cannot be used as an exactness claim for this
student, and release slot 02 is consequently the labelled recorded-action
replay (`world/action chain identical, pixels not identical, not a model
re-inference, not promotable`), produced by `tools/training/recorded-replay.mts`.

### Kill-criteria checklist

| Exact contract condition | Recorded outcome |
|---|---|
| Day 28: DAgger reduces held-out collision episodes ≥20% vs matched BC | **Not met.** Primary v3: BC 0/16 and DAgger 0/16, no reduction measurable — zero-collision BC ceiling, explicitly insufficient evidence. Primary v1: BC 0/16, DAgger 3/16, i.e. worse. The frozen test was not changed. |
| Day 28: positive paired-bootstrap 95% lower bound | **Not met.** Primary bounds are [0, 0] (v3) and [−0.375, 0] (v1). The only ≥20% reduction anywhere (secondary v1, 6→3) has lower bound −0.1875. |
| Day 28: task-completion loss ≤2 points | **Not met on the primary panel.** DAgger loses **7.80 completion points** to BC-100k on v3 (95% CI [−13.36, −2.96]); it gains 4.98 points on v1. |
| Day 28: stays within budget | **Pass.** 3.764676 student learner A100-hours against the 72-hour allocation, plus shared non-exclusive rendering; no installed wheel, split, panel, reward or threshold was changed. |
| Zero-collision BC ceiling | **Triggered, and reported as insufficient evidence.** It was not used to justify altering the frozen test, and it is not a safety result: the same BC checkpoint completes only 24.78% of the route. |
| Promotion prerequisites | All four promotions are `exploratory`: reference gate failed, full-panel rerun determinism failed, primary day-28 statistics insufficient. The model store keeps `promoted: false`. |

### Contention caveat

Every A100 on simforge1 was shared for this entire stage with foreign
`distill/v2` jobs holding roughly 34 GiB and ~89% utilization per device;
`gpu-contention.json` records the window, the per-device snapshots and the
owned OOM probe. Those processes were never touched, and the response was to
extend wall time rather than shrink any preregistered budget. No throughput
number in this section is an exclusive-device measurement, and the acquisition
rate (≈1.8 decisions/s per DAgger shard) reflects that contention. One
orchestration defect is visible in the evidence: `verify-promotions.mts`
compared episode counts against the optional `expectedEpisodes` field, which
the frozen panels do not declare, so the wrapper aborted after both panels had
already completed. The tool now uses the same `expectedEpisodes ?? entries.length`
rule as `loadPanel`, and the remaining stages were resumed without re-running,
re-scoring or altering any promotion.

### Artifacts

Local evidence root
`~/simforge-assets/runs/drive/training/student-poc-v3-20260922/` with
`evidence.json` listing every artifact, its SHA-256 and its remote pointer.
It contains `preregistration.json`, `selected-students.json` (all nine
validation receipts and the selection), `day28-statistics.json`,
`promotion-verification.json`, `promotions/{bc100k,dagger}/{devpanel32-v3,devpanel32}/promotion.json`,
`family-videos.json`, `recorded-action-replay/`, `training-summary.json`,
`metrics.jsonl`, `training-timelapse.mp4` and the regenerated release bundle
`release/training-poc-v1` (**1,218 inventoried files, 127,647,166 bytes,
all six video slots present**, verified by `tools/release-bundle/verify.mts`
with `--require-complete`).

Six family videos were rendered from the same frozen test members and seed 200
as the teacher's family rollouts, requested at 20 s and retained at their
actual native termination rather than padded:

| Arm | Family | Policy seconds | Video seconds | Termination |
|---|---|---:|---:|---|
| BC-100k | cut-in/brake | 1.2 | 1.4 | corridor exit |
| BC-100k | CPNCO parked row | 6.4 | 6.6 | corridor exit |
| BC-100k | queue tail | 9.7 | 9.9 | corridor exit |
| DAgger | cut-in/brake | 4.4 | 4.6 | corridor exit |
| DAgger | CPNCO parked row | 1.5 | 1.7 | corridor exit |
| DAgger | queue tail | 6.6 | 6.8 | collision |

Every one passed `simforge drive verify` with healthy model receipts. The
student-stage timelapse is the chronological actual saved dashboard PNG
sequence, not rollout imagery. Bulk PNG sequences, checkpoints, learner
directories and label JSONL remain on simforge1; all 470 produced mp4s are
mirrored to `seablue:~/Desktop/simforge-drive-videos/training/student-poc-v3-20260922/`
with the run-directory tree preserved.

No camera-student promotion, perception-quality, label-efficiency or
real-world-safety claim follows from this stage.
