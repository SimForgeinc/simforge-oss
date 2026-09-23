# Jev in Simforge: integration design and measured prototype

## Verdict and scope

**Use the existing native policy/session interface. No Bevy or other renderer change is required.** The prototype actually ran the Rust Simforge `dynamic-v1` runtime through its Python binding, not a replacement kinematic world. All new code, schemas, scenarios and evidence are under `/home/path/tmp/jevdrive/`; there were **zero writes to `/home/path/simforge-oss`**, no builds, project-wide tests, linters, formatters, commits or branches. This is not a claim that somebody else's shared working tree is clean.

The evidence has three different strengths, deliberately separated below:

1. **Verified mechanisms:** live Jev requests, fixed-step/real-time control, visibility filtering, uncertainty/capability contracts, deterministic replay, curved-path/swept-footprint filtering, safe stopping and bounded creep.
2. **Jev behavioural observations:** principally an uncontested straight-road episode. These are not a validation of driving judgment or sim-to-real transfer.
3. **Defects and limits found:** inconsistent API answers, native brake-through-zero reversal, direction-blind speed, lost compiler diagnostics, and a worst-case unknown-space model that prevents progress in the authored dart-out.

The authored `cpnco-dartout` was materialized and run, with curved geometry and parked-row occluders. **Its default-envelope run produced zero Jev calls: it evaluates the planner and sensing envelope, NOT Jev's judgment.** Adding creep did not make a worst-case 8 m/s intruder safe. One explicitly relaxed 0.1 m/s, 0.3 s sensitivity episode also produced no Jev calls at the scheduled decision barriers; offline admission at states from another trajectory did not survive the changed closed-loop state distribution. That negative result is retained, not relabelled as success.

## 1. Sanctioned hook, with source evidence

All repository citations are relative to `/home/path/simforge-oss`.

| Concern | Evidence and decision |
|---|---|
| Current Python closed-loop entry | `adapters/gym/simforge_oss_gym/policy.py:41-64`: `PolicyRunner(env, deadline_ms, fallback, execution)` wraps native `PolicySession`; `reset`, `act_control`, `act_trajectory` are real supported APIs. Trajectories are contiguous float64 `(K,5)` rows `[x,y,heading_rad,speed_mps,t_s]`. |
| Existing environment | `adapters/gym/simforge_oss_gym/env.py:169-174,185-205`: native `EnvSession`, explicit engine/decision rates, stepping and `ego_pose`. `adapters/gym/README.md:3-14,57-77` describes embedded native execution without Node, Studio or a renderer. |
| Current TS equivalent | `packages/training-env/src/policy-session.ts:53-108`; action union in `packages/training-env/src/policy-step.ts:30-68`. |
| Historical policy-step document | `docs/policy-step.md:109-147,220-240` explains ego-forward/left trajectories, pure pursuit, identical-plan zero-order hold and inference barriers. **Its socket-server launch architecture is stale:** `packages/training-env/src/policy-step.ts:18-20` explicitly says the Node env-server wire is retired. Do not build against an imagined `registerPolicySession` service. `adapters/policy-runner/` has no usable source; the canonical runner is under `adapters/gym`. |
| Sensor-shaped policy input | `native/crates/simforge-session/src/observation.rs`: range/FOV gating and LOS against static/actor OBBs. The legacy privileged mode still appends LOS-false actors; W0's opt-in **Visible** channel removes them and gates the nearest range. Slabs remain `[range_m,bearing_rad,range_rate_mps,los,valid]`; these are not class/box/covariance observations. Native phase/countdown rows are separately exposed as infrastructure state (`docs/policy-step.md`, scene-v2 optional `signals`). |
| Independent full truth | `adapters/gym/simforge_oss_gym/_native.pyi:330-350`: actor IDs, kinds, dimensions, presence and eight-column actor rows. `docs/truth-stream-wire.md:20-32,49-81` defines per-tick scene poses, velocities, dimensions, acceleration and signals, independently of pixels. `packages/training-env/src/truth-stream.ts:53-72`, `world-session.ts:224` expose the stream. |
| Existing real-stack-shaped precedent | `adapters/ros2-bridge/simforge_ros2_bridge/autoware_bridge.py:318-378` already exports native actors as Autoware `PredictedObjects` with boxes and certain existence. No ROS installation is needed for this prototype. |
| Renderer boundary | `docs/renderer-contract.md:16-27,114-128`: Bevy owns native sensor/cinematic artifacts and consumes actor state. `docs/policy-step.md:202-210` makes camera frame bundles optional; pixels do not ride policy messages. The renderer also has structured lidar/radar facilities, so it is not literally only a pixel painter, but none is needed for this text-only policy. |
| Deterministic time | `AGENTS.md:83-89`: native/WASM, 20 ms fixed step, no retired TS simulator. `packages/training-env/src/types.ts:82-89`: environment decision rate must divide 50. Set that rate to 50 and schedule Jev on integer engine ticks instead of trying to configure an invalid native 3 Hz rate. |

The complete independent inventory is `/home/path/tmp/scene-providers-inventory.md`; the perception literature constraints are `/home/path/tmp/perception-sota.md`. Both informed this design. No renderer, camera-to-box network, SHM image endpoint or multimodal model was introduced.

### Runtime identity

The existing wheel `native/target/wheels/simforge_oss_gym-0.1.0rc61-cp310-abi3-linux_x86_64.whl` was installed into `/home/path/tmp/jevdrive/.venv`; it reports native engine `0.6.0`, ABI `2`. The current source package advertises rc65. Thus the run proves this **installed, pinned wheel**, not that the current checkout has been rebuilt or qualified. The official pooled `typesafe_sdk` is version `0.6.0`. Jev is pinned to the accepted API model string `jev-1.13.0`; `jev-preview` is an untested A/B candidate, not silently substituted.

## 2. Runnable entry and files

Single entry command (choose a fresh output directory; overwriting evidence is refused):

```sh
bash /home/path/tmp/jevdrive/run.sh --out /home/path/tmp/jevdrive/my-new-run
```

Defaults: native inline-topology straight-road episode, schema `scene-observation/v2`, question revision `v3`, lockstep, Jev 3 Hz, 50 Hz tracker, 45 scheduled decision opportunities. `run.sh` sources `~/.config/typesafe/env` with shell tracing disabled; credentials are never copied into artifacts. The already prepared `.venv` supplies the SDK, native wheel, NumPy and Gymnasium.

Other explicit modes, using fresh output paths:

```sh
bash /home/path/tmp/jevdrive/run.sh --mode realtime --decisions 15 --inject-delay-at 5 --out /home/path/tmp/jevdrive/my-realtime-run
bash /home/path/tmp/jevdrive/run.sh --decision-hz 6 --out /home/path/tmp/jevdrive/my-6hz-run
bash /home/path/tmp/jevdrive/run.sh --spec /home/path/tmp/jevdrive/cpnco-dartout.episodes.json --decisions 48 --out /home/path/tmp/jevdrive/my-dartout-run
# Deliberately RELAXED assumption; not the shipping envelope:
bash /home/path/tmp/jevdrive/run.sh --spec /home/path/tmp/jevdrive/cpnco-dartout.episodes.json --shadow-max-speed-mps 0.1 --shadow-reaction-s 0.3 --decisions 48 --out /home/path/tmp/jevdrive/my-relaxed-run
```

`--question-version v1|v2|v3` preserves the question experiment; `--schema-version scene-observation/v1` exists for exact historical replay, not as the recommended direction-aware interface. `--policy baseline` runs the deterministic preference rule without calling Jev.

| File | Responsibility |
|---|---|
| `policy_constants.py` | **Single review surface for every question, rubric, threshold, maneuver parameter, rate, timeout, uncertainty bound and sweep grid.** |
| `scene.py` | `SceneProvider` protocol; native visible-object `GroundTruthProvider`; native map/route context; visibility shadows; CARLA adapter sketch. |
| `safety.py`, `geometry.py` | Deterministic candidate generation, Frenet sampling, kinematic/footprint/uncertainty/shadow checks, conservative preference rule, monitor and minimum-risk stop. |
| `run.py`, `run.sh` | Pooled live SDK, batched questions, validation, latched control, lockstep/realtime timing and complete logs. |
| `scene-observation.v1.schema.json`, `scene-observation.v2.schema.json` | Explicit schema versions. v2 adds signed velocity, nullable initial radial velocity and oriented occupied boxes. Candidate IDs remain the caller's finite alphabet, not model-generated values. |
| `compare.py` | Historical paired straight-road action replay versus the baseline. |
| `evaluate_authored.py` | Oracle-only geometric scoring and state-hash replay of authored episodes. |
| `sweep.py` | Two-arm, fixed-observation sensitivity analysis with/without creep. **Not live driving validation.** |

`scenario.json` is an explicitly labelled derivative of the repository's self-contained synthetic trajectory fixture. `cpnco-dartout.episodes.json` uses the **actual repository template** and installed Belmont map through native Form-B compilation. Its materialized input and compiler manifest are in `cpnco-dartout.compiled.json`.

## 3. Portable `SceneObservation` contract

The interface is `SceneProvider.observe(seq: int) -> SceneObservation`; providers are per-episode instances. Jev receives that JSON plus compact feasible candidate summaries. It never receives full truth or trajectories. Code generates and retains the `(K,5)` trajectories.

### Frame, time, nulls and capability rules

* Planar ego FLU: x forward, y left; origin is the ego actor/vehicle reference pose at `state_time_s`. Positions are metres, angles radians, velocities m/s, acceleration m/s². Native XODR `(x,y)` is not renderer y-up; scene truth converts `(x,z)` to `(x,-z)` before rotation. CARLA's y-right/yaw-degrees convention is converted separately.
* Relative Cartesian velocity means ground velocity minus ego velocity, expressed in the ego axes **at the observation instant**, not a rotating-coordinate derivative. A radial return alone does not determine both components; those components are null in the native slab provider.
* `seq` is monotonic within an episode. `state_time_s` is estimate validity; `last_observed_time_s` is actual measurement time. Per-track measurement age and lifecycle are independent of model-response age. Native simulation time is not UTC. API UTC timestamps are diagnostic only and excluded from deterministic state hashes.
* Unknown/unsupported is null, never a made-up zero or a claim of empty/free space. A detector ranking score, class distribution, Bernoulli existence probability and Jev confidence are **different quantities**.
* `capabilities` lists supplied and unsupported fields. Startup `validate_capabilities` checks declared question dependencies against the provider profile. An unsupported required `objects.class` dependency was rejected in the proof. This is a declared dependency check: humans must keep the question text and dependency declaration consistent; it is not automatic semantic analysis of prose.

### Fields and why each exists

| Fields | Meaning, cost and portability justification |
|---|---|
| `schema_version`, `provider.{name,version,kind}` | Small strings pin interpretation and distinguish ground truth, abstract sensor and estimated observations in downstream evals. No dependence on Simforge road/actor internals. |
| `seq`, `state_time_s`, `last_observed_time_s`, `frame` | Cheap scalars make ordering, synchronization and stale-result rejection reconstructible. Real providers use a synchronized monotonic vehicle clock. |
| `capabilities.{profile,supplied,unsupported}` | Explicitly prevents silent assumptions that every detector supplies boxes, classes, Cartesian velocity, occupancy or confidence. Metadata overhead is bounded and reviewable. |
| `ego.speed_mps`, `accel_mps2`, `length_m`, `width_m` | Magnitude, dynamics and known vehicle footprint support finite trajectory construction. These come from vehicle state/calibration, not object detection. |
| **`ego.longitudinal_velocity_mps`, `longitudinal_velocity_source`** | Signed direction, null until observed. Native speed is direction-blind; the provider compensates with route-arc-delta sign. Reverse motion is refused by this forward planner. A real vehicle should use signed odometry, and CARLA projects its velocity vector. The native route-sign compensation is valid only in the admitted route-aligned domain. |
| `route.centerline_m`, `width_m`, `speed_limit_mps`, `required_stop_m`, `source`, `complete` | Small ego-relative polyline plus sourced legal context. A detector alone cannot supply route or right-of-way. Native lane geometry supplies it today; navigation/map/perception fusion must supply it later. Unknown traffic-control legality is refused, not treated as green. |
| `objects[].track_id`, `track_status`, `track_age_s` | References, lifecycle and continuity; IDs are provider/episode scoped, not universal physical identity. Native visible IDs are currently preserved; opaque-ID sensitivity remains untested. |
| `x_m`, `y_m`, `range_m`, `bearing_rad`, `range_rate_mps` | Compact, readable planar location and directly available radial motion. Range rate is negative when closing. Native reset's zero finite difference is **null in v2**, not a measured stationary target. |
| nullable `rel_vx_mps`, `rel_vy_mps`, `heading_rad`, `length_m`, `width_m`, `class` | Appropriate trackers/3D detectors can supply these; a radial slab cannot. Native policy observations leave them null rather than joining privileged actor boxes. The safety layer uses explicit bounded ODD priors when absent. |
| `existence_probability` | Nullable Bernoulli semantics; exact visible simulation objects report 1. Low confidence does not cause objects to disappear from collision checking. |
| `detection_score`, `class_probabilities` | Separate nullable detector ranking and conditional-on-existence class distribution. Neither is fabricated from existence or Jev confidence. |
| `position_cov_m2`, `velocity_cov_m2ps2`, `uncertainty_source` | Nullable packed planar covariance; known truth position covariance is zero, unsupported velocity covariance is null. Never `1-score`. Method/provenance is explicit. |
| `uncertainty_layout` | Declares frame, upper-triangle packing, `[xx,xy,yy]` / `[vxvx,vxvy,vyvy]`, units and conditioning on existence. Cross position–velocity covariance is explicitly omitted; the filter uses conservative sums of marginal standard-deviation bounds, not a fake zero cross-correlation claim. |
| object `state_time_s`, `last_observed_time_s`, `measurement_age_s`, `source` | Tracks can coast, arrive late or be fused asynchronously; provenance and age must survive serialization. |
| `calibration` | Status `calibrated|uncalibrated|unknown`, method, model version, calibration dataset/domain and calibration version. Exact simulated measurement semantics report calibrated without claiming statistical real-sensor calibration. |
| `coverage` | Radius, completeness, omitted count, measurement age, frame, time, geometry/provenance and vertical support. Bounded `unknown_regions_m`, `untracked_occupied_regions_m`, nullable `observed_free_regions_m`; v2 optionally carries `occupied_obbs_m_rad`. Rectangles use `[center_x,center_y,length,width]`; OBBs append heading in radians. Null vertical support denotes the planar roadway approximation, not certified 3D clearance. |
| `candidates` | Only survivors: ID, horizon, end speed, modeled minimum clearance and either constant acceleration or an advance-then-stop profile with distance/duration. Full samples stay in code. Jev selects a declared ID; it cannot produce numbers, free text or trajectories. |
| optional request `safety_assumptions` | Names the intruder-speed, reaction and horizon assumptions behind feasibility. Sensitivity values also appear in the manifest and summary, never as silent default changes. |

Position/dimension/speed quantization is normally 0.1 m / 0.1 m/s, angles 0.01 rad, time 0.02 s; covariance/probability resolution is declared in constants. Creep distance summaries use centimetre resolution. There are at most 24 objects, bounded region lists and six maneuver IDs. Overflow or unsupported coverage fails closed rather than silently dropping hazards. Observed straight-road requests used roughly 1,917–1,957 input tokens before the final creep/signed-state additions; this is a measured small-scene cost, **not** a demonstrated optimal serialization or a worst-case 24-object budget.

### Providers and the oracle boundary

`GroundTruthProvider(include_occluded=False)` consumes **native policy slabs**, keeps only valid LOS-true detections, and does not join hidden actor rows. Class, extents and Cartesian velocity remain unsupported/null. A separate `OracleScorer` reads full native truth **after action selection** and only writes evaluation records. It cannot feed candidate generation or the API request. Both visible/occluded counts and oracle-only hidden-actor coverage are logged outside Jev state.

Visibility shadows are derived from visible blocker bounds and sourced static map OBBs, never from the hidden actor list. Unknown space can contain a stationary actor even when the assumed intruder speed is zero. This is not a camera renderer or learned detector.

The CARLA sketch uses installed `WorldSnapshot.find`, `ActorSnapshot.get_transform/get_velocity/get_acceleration`, actor bounding-box metadata, explicit visibility and coverage callbacks, and the same route context. Offline CARLA transform math and snapshot methods were exercised. **No CARLA server episode was run**; visibility/route/coverage callbacks and controller integration remain external work, not mocks presented as a run.

A future `RealSensorProvider` normalizes detector/tracker/fusion output into this schema, rotates covariance with the state Jacobian, carries uncertain ego localization/time alignment, and reports unsupported channels honestly. It must not invent never-observed actors, crossing intent, brake lights, friction, right-of-way or globally perfect track identity.

## 4. Two-rate controller and safety ownership

### Scheduling and latency

Native stepping is exactly 50 Hz. Jev 3 Hz uses integer decision ticks `0,17,34,50,67,84,...` (17/17/16 holds), avoiding float cadence drift. The CLI is rate-parameterized; 6–8 Hz is possible, but full-scene tails and cold connections must be measured before treating that as a reliable real-time rate.

* **`lockstep` (default):** the world freezes at inference barriers. An explicitly measured 333 ms application deadline still gates answers, and induced late responses exercise a counterfactual fallback. Physical staleness is zero. This is not a real-time safety test.
* **`realtime`:** a single background SDK request never blocks stepping. The tracker executes the last latched plan while every 20 ms tick reobserves and revalidates. Missed schedule opportunities while a request is outstanding are skipped, not queued. Response age above 0.34 s or travel above 3.5 m is rejected; the 333 ms deadline is checked too. Arrival revalidation regenerates the selected maneuver against the current scene rather than shifting an old ego-relative trajectory blindly.

Use one pooled `TypeSafeClient`, no retries, bounded HTTP timeout, pinned model. Every question is sent in one call; branch questions cannot see other answers. Only the applicable branch's semantic result is consumed. All answers are retained. Choice distribution/label consistency is validated even on unused branches; malformed, late, stale, inconsistent or sufficiently flat results take the deterministic fallback.

A native `PolicyRunner` deadline is set, but Jev timing is handled **before** handing the already-vetted controller action to native execution. Native acts use `elapsed_ms=0` for that local resolved action; a discarded model answer is never smuggled through native `repeat-last` or `zero-control`. `zero-control` is coasting, not an emergency brake.

Fixed scheduling does not make fresh cloud answers deterministic. Lockstep removes physical jitter/staleness, but deadline verdicts and model outputs can still change a fresh run. Exact replay requires the recorded response/action/timing stream. That replay was checked, not assumed.

### Candidates, tracker and monitor

Constant-acceleration candidates are `progress` (+1 m/s²), `hold`, `yield` (-1.5 m/s²), and `stop` (-4 m/s²). Curved candidates follow a Frenet arc on the native route polyline. Checks include speed/acceleration/lateral-acceleration limits, corridor footprint containment, swept dynamic-object tubes, uncertainty, stopping reserve, stationary occupied regions, and expanding unknown-space regions.

The static parked-row check uses a convex hull of endpoint OBBs with a rotational-sweep bound, plus the declared safety/tracking/quantization margins; it does not just test the ego centre. Curvature did not relax the original straight-road feasible sets.

The creep family adds 0.25 m and 0.5 m bounded advances from standstill, with quintic zero-end-velocity profiles over 2 s and a stopped tail through the full 3 s horizon. Continuations are transformed from the held plan into the current ego frame and rechecked. All original safety semantics remain. A single feasible action is forced by code rather than buying a meaningless one-option model judgment.

Identical relative trajectories normally retain their old native anchor. Repeating the same bounded creep as a **new** intent therefore creates fresh `PolicyRunner` executor state over the **same live EnvSession, without reset**. `executor_reanchored` is logged and replayed; ordinary holds preserve their anchor. This is backend-specific actuator glue, not a perception dependency.

**No feasible candidate means minimum-risk stop, not a claim of a collision-proof action.** The final fallback is a held trajectory terminating at zero speed. The raw full-brake passthrough was removed after the native defect below was reproduced. Already-unavoidable situations, wrong uncertainty bounds, or adversarial actors hitting a stopped vehicle cannot be made safe by an LLM choice.

The current checker retains the strict full-horizon unknown-space test. A receding-horizon alternative would require a verified fail-safe stop at each update and a reactive/probabilistic occupancy model instead of treating every unknown point as a non-reactive adversary over the whole horizon. That can recover motion, but it was **not** silently substituted here.

## 5. Results class A — verified mechanisms

| Mechanism | Concrete evidence |
|---|---|
| Native headless operation | Real reset and trajectory steps; no GPU/render assets needed for the inline topology. Native 20 ms stepping throughout all runs. |
| Hidden-object exclusion | `occlusion-proof-output.txt`: native rows `lead` LOS=1 and `hidden` LOS=0; policy IDs contain only `lead`. The oracle confirms the hidden centre lies in a geometry-derived shadow. |
| Shadow filter and override | Same proof: without shadow, `hold` is feasible; with shadow, `hold` is rejected as `occlusion_reachability`; monitor changes hold→yield and the native world advances to 0.02 s. |
| Capability assertion | The proof attempts a required `objects.class` dependency and gets a startup rejection. |
| Curved geometry admission | `contested-planner-admission-output.txt` preserves the **before** refusal: cpnco's route bends 3.6 m laterally over about 35 m, so the old straight-only gate correctly refused. No curvature was flattened to manufacture success. |
| Swept footprint | `frenet-proof-output.txt`: a kinematically feasible curved hold is rejected only after adding a rotated parked OBB, as `swept_footprint_static_obb`; stop survives. |
| Geometry regression | Same proof: 2,000 historical straight ticks retain identical state hashes, feasible sets, rejection reasons and timestamps after the Frenet generalization. Legacy schema replay is explicit. |
| Native action replay | `replay-proof-output.txt` and `paired-outcomes.json`: recorded straight actions reproduce all checked states. `authored-outcomes.json`: both 800-tick authored recorded streams reproduce their state hashes. |
| Signed direction | `signed-velocity-proof-output.txt`: native magnitude 3.7 and 7.2 m/s during reverse becomes signed -3.7 and -7.2; reverse candidates are refused. First direction and first radial rate stay null. |
| Bounded creep | `creep-proof-output.txt`: two 0.5 m creeps advance 0.5071168 m and then 1.0261147 m cumulative, both ending at zero speed on the same live episode. |
| API defence | `client-guard-proof-output.txt`: both captured choice/argmax contradictions are rejected and take the baseline, rather than silently trusting either conflicting field. |
| Final schema/serialization check | `final-verification-output.txt`: 5,750 recorded scene frames plus all associated live request states validate against their declared v1/v2 schemas. A five-option creep-capable request serializes through the SDK's JSON encoder (`msgspec.json`); all four current questions are in one request. |

### Real terminal excerpt: live Jev, schema v2, question v2

From `evidence-final-lockstep` (not simulated responses):

```text
world=Simforge-native engine=0.6.0 mode=lockstep engine_hz=50 jev_hz=3.0 deadline_ms=333.0
decision=01 tick=0017 t=0.34s feasible=progress,hold,yield,stop Jev=hold baseline=hold conf=0.26 applied=hold fallback=None latency=227.2ms stale=0.00m
decision=02 tick=0034 t=0.68s feasible=progress,hold,yield,stop Jev=hold baseline=hold conf=0.29 applied=hold fallback=None latency=248.9ms stale=0.00m
decision=05 tick=0084 t=1.68s feasible=progress,hold,yield,stop Jev=hold baseline=hold conf=0.19 applied=hold fallback=deadline_miss latency=524.6ms stale=0.00m
decision=09 tick=0150 t=3.00s feasible=hold,yield,stop Jev=yield baseline=hold conf=0.49 applied=yield fallback=None latency=144.1ms stale=0.00m
decision=14 tick=0234 t=4.68s feasible=hold,yield,stop Jev=yield baseline=hold conf=0.44 applied=yield fallback=None latency=248.9ms stale=0.00m
```

That run advanced **250 ticks / 5 s**, made **14 live requests**, and had median decision latency **162.606 ms**. Initial unknown signed motion causes a brief deterministic stop/observation transition, hence the first model request is opportunity 1 rather than 0.

From `evidence-final-realtime`, with the same schema and question version:

```text
decision=04 tick=0084 t=1.68s feasible=progress,hold,yield,stop Jev=hold baseline=hold conf=0.3 applied=hold fallback=None latency=324.2ms stale=3.40m
decision=05 tick=0107 t=2.14s feasible=progress,hold,yield,stop Jev=hold baseline=hold conf=0.24 applied=hold fallback=deadline_miss latency=453.7ms stale=4.60m
decision=10 tick=0181 t=3.62s feasible=hold,yield,stop Jev=yield baseline=hold conf=0.5 applied=yield fallback=None latency=264.0ms stale=2.71m
```

This advanced **250 ticks / 5 s**, made **13 live requests**, and recorded median staleness **1.6380 m**, maximum **4.5995 m**, maximum applied-answer staleness **3.3993 m**, and maximum wall-schedule lag **0.0004 s**. Median decision latency was **165.004 ms**. The induced delay is explicitly separate from API latency. These two modes demonstrate different hazards: **524.6 ms / 0 m lockstep** versus **453.7 ms / 4.60 m real time**. Earlier realtime v3-predecessor evidence also captured 6.87 m staleness; it was rejected, not applied.

Primary decision logs:

* `/home/path/tmp/jevdrive/evidence-final-lockstep/decisions.jsonl`
* `/home/path/tmp/jevdrive/evidence-final-realtime/decisions.jsonl`

Each corresponding `ticks.jsonl` carries the current scene/hash, last decision-state hash, feasible/rejected set, all raw answers/probabilities/confidence, chosen maneuver, actuation, executor telemetry, overrides, sequence/time, path distance, visibility counts and evaluation-only oracle fields. Current logs also carry actuator provenance and reanchor epochs.

## 6. Results class B — Jev behavioural evidence, with limits

### Baseline definition and what was actually compared

The rule is: **hold when modeled bumper gap exceeds 6 m + 2.5 s × ego speed and hold is feasible; otherwise take the first feasible of yield, stop, hold, progress, then the shortest available creep; if none exists, use the minimum-risk stop.**

On the **Jev-visited states** in the original straight runs, that rule returned hold at every model decision. Thus raw disagreement there is against a **constant-hold counterfactual**, not a strong driving baseline or a quality score. In its **separate closed-loop rollout**, the same rule chose hold 38 times and yield 7 times over 45 opportunities. These are different state distributions; the one-row confusion matrix does not mean the separate baseline rollout never yielded.

### Question revisions

* **v1:** intent Choice plus speculative progress/yield Choices; gate at minimum active/intent confidence 0.35 and selected probability 0.45. This discarded many usable preferences, often because the intent distribution was diffuse even when its branch answer was concentrated.
* **v2:** one concrete acceleration-command Choice, mutually more explicit effects, and two conditional Nouls. Preference ranking uses a near-flat guard (confidence <0.05 or selected probability <0.26 with four options), not a correctness-permission interpretation.
* **v3 (current):** adds bounded-creep options and an independent conditional creep Noul. Its near-flat probability floor is `1 / feasible_option_count + 0.01`; confidence floor remains 0.05. All four questions are batched; irrelevant branch judgments do not control the actuator. v1/v2 remain available for the recorded comparison.

Both wording/decomposition and gates changed between v1 and v2, so this is **not** an isolated causal ablation of confidence thresholds. The useful methodological observation is that concentration confidence can be low while a ranking is usable; these numerical thresholds are not universal calibrated safety thresholds.

| Recorded run | Live responses / valid choices | Raw divergence from request-state baseline | Executed divergence from arrival-state baseline | Low-confidence fallbacks | Accepted model choices |
|---|---:|---:|---:|---:|---:|
| v1 straight lockstep, 15 s | 45 / 44 | 30/44 = 68.18% | 10/45 = 22.22% | 29/45 | 10/45 |
| v1 straight realtime, 10 s | 28 / 28 | 20/28 = 71.43% | 8/28 = 28.57% | 18/28 | 8/28 |
| v2 straight lockstep, 15 s | 45 / 44 | 9/44 = 20.45% | 9/45 = 20.00% | 0/45 | 42/45 |
| v2 + final schema v2 lockstep, 5 s | 14 / 14 | 3/14 = 21.43% | 3/14 = 21.43% | 0/14 | 13/14 |
| v2 + final schema v2 realtime, 5 s | 13 / 13 | 2/13 = 15.38% | 2/13 = 15.38% | 0/13 | 12/13 |
| v3 current-question smoke, 1 s | 2 / 2 | 0/2 | 0/2 | 0/2 | 1/2; one natural deadline miss |

Executed divergence, not merely raw preference divergence, is the primary descriptive number. The one invalid choice in each 45-response comparison is an API consistency failure, excluded from the valid-choice denominator but retained in the execution denominator.

Confusion structure over valid original decisions:

| Baseline at request | v1 lockstep Jev progress | hold | yield | stop |
|---|---:|---:|---:|---:|
| hold | 12 | 14 | 18 | 0 |

| Baseline at request | v2 lockstep Jev progress | hold | yield | stop |
|---|---:|---:|---:|---:|
| hold | 0 | 35 | 9 | 0 |

### Paired outcomes: sanity check, not driving-quality validation

`paired-outcomes.json` replays model-driven actions and runs the baseline independently with the same seed and duration. Native truth is used only for scoring.

| 15 s straight arm | Progress m | Min bumper gap m | Min closing TTC s | Peak longitudinal jerk m/s³ | Collisions | Monitor vetoes |
|---|---:|---:|---:|---:|---:|---:|
| v1 Jev | 97.7362 | 71.7158 | 20.0001 | 21.1498 | 0 | 0 |
| v2 Jev | 118.7924 | 52.6276 | 17.3318 | 21.1666 | 0 | 0 |
| Independent rule baseline | 122.3323 | 49.0877 | 15.0215 | 25.4603 | 0 | 7 |

Every one of those seven vetoes was **`latched_maneuver_no_longer_feasible:occlusion_reachability`**, not a measured near-collision or a comfort limit. This confirms end-to-end shadow enforcement in the main run. It does not establish that seven crashes were prevented. The roughly 2.9% progress / larger-gap / lower-jerk difference of v2 is a one-episode observation only: **all gaps and TTCs are large, so this is an uncontested plumbing sanity check, not an evaluation of Jev driving quality**. The native authored driver/rule interactions have not been separately ablated.

### Did confidence predict divergence?

Descriptively, higher active-choice confidence was associated with choosing yield rather than the constant-hold counterfactual. It is not a correctness label or validated predictor.

| Confidence bucket | v1 lockstep raw disagreements / samples | v2 lockstep raw disagreements / samples |
|---|---:|---:|
| <0.40 | 11/22 | 1/22 |
| 0.40–<0.70 | 1/4 | 8/22 |
| ≥0.70 | 18/18 | 0/0 (no data) |

v1 median active-choice confidence was 0.395; v2 was 0.39. Point-biserial correlations with raw divergence were 0.565 and 0.426, respectively. **44 temporally correlated choices from one seed are far too few for a general predictive conclusion.** v1 realtime median confidence 0.91 differs because asynchronous arrival/fallbacks traverse another scene distribution, not because timing modes are an apples-to-apples confidence experiment. The v2 gate accepted 42/45 despite roughly unchanged median concentration, but neither acceptance nor disagreement measures accuracy.

## 7. Authored dart-out and quantified conservatism

### Loading and admission were not faked

`school-dartout.template.json` failed native site matching on all ten complete installed map bundles. A second attempt printing exception attributes returned only `{'kind':'runtime','issues_json':None}`. Main proposed missing required school-zone annotations/runway as the cause; **that remains unconfirmed**, because compiler `failureSummary` is not surfaced by this wheel. Evidence: `school-dartout-all-maps-output.txt`, `contested-template-load-output.txt`.

`cpnco-dartout.template.json` **did** match Belmont; `ltap-opposing.template.json` matched El Camino. The former was actually run; the latter was not. Before the geometry extension, the correct straight-only admission refusal is preserved. After Frenet/swept-OBB support, the actual cpnco runs used its native curved route and four parked-row OBBs.

### Default envelope: planner/sensing evidence, not Jev evidence

At the shipping **8 m/s intruder bound, 0.3 s reaction and strict 3 s horizon**, both the repaired dart-out run and its paired minimum-risk baseline ran 800 ticks / 16 s, advanced 4.96767 m, ended at effectively zero speed, and recorded no actor overlap. Minimum actor OBB gap was 26.25570 m, minimum static OBB gap 2.90404 m, and minimum radial closing TTC 6.32711 s. All 800 frames had no admitted candidate. The model arm enters the minimum-risk state once; the baseline starts there directly, so their override-event counts differ without different physical outcomes.

The creep-enabled default rerun still made **zero Jev calls**. Its log is `evidence-cpnco-creep/ticks.jsonl`; its empty `decisions.jsonl` is intentional evidence, not a missing result. Pure worst-case expansion at the default permits a non-reactive intruder to travel `8 × (3 + 0.3) = 26.4 m`, including toward the ego's stopped position. Creep cannot defeat an adversary model that also invalidates standing still.

### Sweep, including the zero-speed misconception

`shadow-sensitivity-creep.json` compares with/without creep on 15 recorded default-run observations (one per second). **This is a fixed-observation sensitivity sweep, not a set of new driving episodes.**

* Without creep, the constant-acceleration `progress` candidate is rejected in every sampled setting, including intruder speed zero.
* With creep, bounded movement is admitted on 14/15 observations through tested intruder speeds 0.15 m/s at reaction 0.3 s. At 0.20 m/s and reaction 0.3 s, no creep is admitted; at 0.20 m/s with reaction zero, creep is still admitted on 14/15.
* Creep does **not** raise the boundary for existence of any feasible action: both arms still have stationary choices on 14/15 observations at 0.25 m/s with reaction ≤0.3 s, none at 0.25 m/s with reaction 0.5 s, and none at ≥0.5 m/s for any tested reaction.
* Thus the family fixes a finite-lattice limitation under very weak intruder assumptions, but the default bound remains adversary-dominated. No parameter was silently relaxed.

Main proposed a long-stopping-distance/frozen-robot explanation during review. **The per-frame data refutes that explanation for this case:** at intruder speed zero, `progress` is rejected as `occlusion_reachability` on 15/15 frames, not terminal stopping reserve; the current-speed braking-plus-reaction distance is zero on 14/15 frames (1.26667 m at the one moving frame). `observed_free_regions_m` is null, so a certified observed-free distance cannot honestly be reported.

The measured mechanism is persistent unknown occupancy plus the finite maneuver lattice. At the recorded 3 s observation, the relevant shadow starts about 5.2 m ahead. The stationary hidden-actor radius plus margins is 2.0 m, and projected ego half-length is about 2.35 m, leaving roughly **0.85 m of modeled centre-travel budget**:

```text
advance + intruder_speed × (3 s + reaction) < about 0.85 m
```

This is a modeled tube clearance, **not certified free space**. The original +1 m/s² progress plan travels 0.845 m after 1.3 s (passes) and 0.98 m after 1.4 s (fails), reaching 4.5 m over the full horizon. A zero intruder speed removes only dynamic expansion; it does not remove the unknown region or a possible stationary occupant. At 0.25 m/s and 0.3 s reaction, expansion is 0.825 m, barely leaving room to stand still; at 0.25 m/s and 0.5 s reaction it is 0.875 m, explaining refusal. Full per-frame reasons are in `zero-intruder-progress-analysis.json`.

### Explicit relaxed-assumption closed loop

**With assumed intruder speed 0.1 m/s and reaction 0.3 s**, one full cpnco sensitivity episode was run at 3 Hz (`evidence-cpnco-sensitivity-v0_1-tau0_3`). **With assumed intruder speed 0.1 m/s and reaction 0.3 s**, it made zero Jev calls: 757/800 frames had no candidate, 40/800 had one forced candidate, and 3/800 briefly had two candidates between model decision barriers. **With assumed intruder speed 0.1 m/s and reaction 0.3 s**, the changed stopping trajectory reached a state where even stationary/creep choices were rejected; the offline sweep's more favourable stopped states were not the states this closed loop visited.

This run is **not the default configuration**, not proof of safe deployment of the weakened bound, and not Jev behavioural evidence. In particular, an actual walking pedestrian can exceed a 0.1 m/s assumed bound. No occlusion resolution or information-gain benefit from a Jev-selected creep was demonstrated. The bounded-creep execution proof is separate and real; the closed-loop utility claim remains unverified.

## 8. Results class C — engine and API defects

### Held raw brake reverses the native vehicle

`native-brake-repro.txt` reproduces `act_control(0,1,0)` braking through zero and accelerating backward. On the straight scenario, route position falls from 40.975 m at 2 s to 39.088 m at 3 s and 33.633 m at 4 s while reported speed magnitudes rise 0.246→3.667→7.241 m/s. The initial authored attempt consequently drove backward; those pre-fix artifacts are retained as **failure evidence**, not as safe runs or final-schema conformance.

The integration now uses a tracked stop trajectory and never holds raw full brake as its fallback. A held stop remained stopped through 5 s; repaired authored replay ends at approximately `3.6e-12 m/s`. This is an integration mitigation, **not an upstream engine fix**.

### Direction-blind observation

The unsigned speed channel cannot distinguish forward from reverse, even while longitudinal acceleration remains negative. Schema v2 therefore adds signed velocity, with explicit native route-arc-delta compensation and null before history exists. Signed reverse is refused. A real provider should use signed odometry; the simulation-specific compensation must not become a supposed universal sensor convention.

### Lost compiler detail

The current Rust site-matching source constructs structured `no_site` detail (`native/crates/simforge-compiler/src/sites.rs:165-187`), but the exercised rc61 Python exception exposes only `kind='runtime'` and `issues_json=None`; `_native.pyi:35-40` documents that limited surface. The precise school-site rejection cannot be diagnosed from this binding. Source/wheel version drift is another reason not to assert the missing-school-feature hypothesis as fact.

### Choice contradicts its own probability argmax

The API documentation states that `choice` is the highest-probability option: [TypeSafe API, Choice answer](https://docs.typesafe.ai/api.md). Two logged responses contradicted that contract. The first audit found **2/136** live responses (1.47%); the final audit found **2/165** (1.21%), with no further contradiction in the added successful calls. This is evidence of repeated inconsistency, not an i.i.d. production-rate estimate.

One complete response, exactly preserving the logged JSON values:

```json
{
  "answers": {
    "if_progress": {"noul": 0.39, "type": "noul"},
    "if_slow": {"noul": 0.23, "type": "noul"},
    "maneuver": {
      "choice": "progress",
      "confidence": 0.33,
      "probabilities": {"hold": 0.5, "progress": 0.49, "stop": 0.0, "yield": 0.01},
      "type": "choice"
    }
  },
  "model": "jev-1.13.0",
  "usage": {"input_tokens": 1918, "output_tokens": 82}
}
```

The other reports `choice='hold'` with hold 0.49 and progress 0.50. **Both fell back safely; the client now explicitly rejects every inconsistent Choice, including unused branches.** It does not silently choose either the label or argmax after a contradiction.

`typesafe-choice-contract-violations.json` is a support-ready package containing both full request payloads, model strings, responses, simulation timestamps and capture provenance. Original request UTC was not recorded; that limitation is explicit rather than invented from file times. Current calls record UTC and verbatim response text. No credentials are present. **No vendor ticket was actually filed:** this session has no verified vendor-support submission channel; forwarding this package remains external work.

## 9. Sim-to-real assessment

**Type/interface portability is implemented; distributional transfer and real-vehicle safety are not established.** Provider-agnostic parts are the JSON contract, candidate ID selection, batching, response validation, timing/staleness accounting, bounded-uncertainty checks, shadow geometry inputs and the rule that deterministic code owns actuation. A real sensor stack replaces the provider and supplies its own capabilities, calibration, timing, visibility/unknown-space geometry, tracked state and signed odometry. Its controller replaces the native actuator adapter.

Sim assumptions that cannot be carried over silently include exact visible positions/existence, native LOS geometry, no false-positive/false-negative detector model, authored map/rules and actor IDs, route-arc-derived direction, planar geometry/constant-width corridor approximations, fixed dimension/velocity bounds, a 1 m hidden-actor radius, and unqualified braking/tracking/friction margins. Curved native lane support is not a general traffic-rule planner: signals, arbitrary controls, lane changes, multi-level geometry, unknown friction and out-of-profile sensors are not qualified.

The literature review gives concrete reasons not to equate JSON compatibility with transfer:

* [CTS, arXiv:2406.18129](https://arxiv.org/abs/2406.18129), CARLA3D→KITTI, PointRCNN car AP3D@0.7 moderate: **4.06 source-only**, **27.22 ST3D++**, **45.28 CTS**, **71.70 target-supervised oracle**. These are detection AP points, not closed-loop road success rates.
* [EMPERROR, arXiv:2411.07719](https://arxiv.org/abs/2411.07719): a BEVFormer-based **open-loop** planner's collision rate changes from **3.20% on detector outputs to 6.20% under an adversarial perception error model**. This is not a real-road Jev transfer experiment.
* The review found **no evidence that Jev/RLCD calibration survives changing the perception evidence distribution**. Jev confidence is distribution concentration, not the correctness probability of the composed perception/planning system. Detector scores, covariances and Jev confidence must be evaluated separately on held-out domain data.

See [TypeSafe speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md) and [API contract](https://docs.typesafe.ai/api.md) for the batching/finite-answer-space design. No learned visual tokens, privileged crossing intent or image inputs are used.

## 10. Complete verification limits and remaining external work

* No public-road actuation was built or attempted; no real sensors/vehicle were tested.
* CARLA import, transforms and snapshot API existence were checked; no server, provider callbacks, synchronous CARLA control or cross-simulator replay was exercised.
* No broad multi-map/multi-seed Jev benchmark, held-out confidence calibration, causal question-vs-threshold ablation, score/Noul alternative policy, or `jev-preview` A/B run was performed.
* The only nontrivial Jev choice data is the uncontested straight-road family. The default and relaxed authored dart-out runs do **not** establish Jev judgment in contested traffic.
* Creep movement/stop/reanchor works, but Jev-selected creep resolving occlusion or improving outcomes was not observed. The relaxed closed loop shows why fixed-state sensitivity does not predict endogenous trajectories.
* Worst-case intruder speed/radius, dimension and velocity priors, three-sigma interpretations, covariance calibration and uncertainty correlation handling need real-data validation. Statistical covariance is not a hard error bound.
* No formal safety certificate, comprehensive continuous-collision proof across arbitrary maps, full 3D free-space model, friction/tyre-envelope qualification, traffic-signal/right-of-way adapter or lane-change planner is claimed.
* Unknown-space rectangles are conservative supersets. Observed free space is unsupported/null, not a measured clearance certificate. A non-reactive worst-case intruder can make even standing still inadmissible; minimum-risk stopping remains necessary.
* Native authoring/driver collision-avoidance interactions were not independently ablated. Native raw braking remains defective upstream; the integration mitigation uses the tracker. Direction compensation is route-aligned and is not a substitute for proper signed native velocity.
* The rc61 wheel was not rebuilt against rc65 source; source/wheel and cross-host numerical conformance are unverified. Exact action replay was verified on this installed runtime only.
* Fresh Jev service responses and measured deadlines are not guaranteed deterministic; recorded replay is. Realtime is a paced simulator, not hardware-in-the-loop, and tested wall-clock loads are limited.
* Original API-contract violations lack UTC/wire-whitespace capture, but full logged JSON values and simulation timestamps are retained; future captures have UTC/raw text. No upstream TypeSafe or native-engine ticket was actually submitted.
* `school-dartout` no-site cause remains unconfirmed because Python loses compiler detail. LTAP materialization succeeded but no LTAP driving run was made.
* Schema-v1 and intermediate pre-fix artifacts are retained for provenance. They are not the recommended signed v2 interface or evidence that the unsafe raw-brake fallback is acceptable.
* No project-wide validation or renderer/UI visual verification was performed. Renderer changes were neither necessary nor made.
