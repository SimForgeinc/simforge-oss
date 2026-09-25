# OpenSCENARIO conformance

**Target standard.** **ASAM OpenSCENARIO XML 1.4.0** (spec dated 2026-05-08, published 19 May 2026), the latest 1.x release.

**Scope.** SimForge **exports** OpenSCENARIO. It does not import it: import was removed, because a placement-only importer could not honour the format.

**The question this answers.** The standard is loose, and there is no reference implementation, so how do we know SimForge's OpenSCENARIO behaviour is correct?

**The answer.** Correctness is judged against a *spec-derived oracle*, one case at a time, with the ASAM clause cited:
- The oracle's expected values are computed by hand from the clause text: speed and lateral profiles from the `DynamicsShape` definitions, and the discrete tick at which each condition becomes true.
- No other implementation's opinion enters those values.
- esmini is recorded per case as **agrees**, **disagrees** or **unsupported**. That is evidence, not a reference.
- Where the text is ambiguous, the choice we made is written down in the [decisions table](#semantics-decisions).

Conformance means conformance to the published [SimForge OSC profile](#the-simforge-osc-profile). Anything outside the profile is refused loudly.

## Where OpenSCENARIO lives in the SDK

| Surface | Code | Status |
|---|---|---|
| Our execution semantics | The engine's `SimScenarioInput` interactions, executed by `native/crates/simforge-core/src/engine/{triggers,interactions,controllers,motion,dynamics}.rs`. Authored documents reach them through `simforge-compiler` (`materialize/builder.rs`). | Live. **This is what conformance measures.** |
| XML 1.4 export, `trajectory-replay` profile | `native/crates/simforge-authoring/src/export/xml.rs`, `simforge export <instance> --format xosc-1.4`. | Live. It is the only shipped XML profile. It bakes our trace into timed `Polyline` trajectories. Round trip checked (below). |
| XML "1.3 esmini" export | Same module: a structural lowering of the 1.4 output. | `simforge export --format xosc-1.3-esmini`. |
| DSL 2.2 export | `export/dsl.rs`, checked by `dsl_syntax.rs` | `simforge export --format osc-2.2`. `at`/`after` triggers only. |
| Import | – | **Removed.** See F-01. |
| CARLA | `adapters/carla-exec/simforge_oss_carla_exec/runtime/compiler.py` compiles only our own 1.4 trajectory-replay files into a 50 Hz plan. With a render timeline present, the timeline wins. `fixtures/openscenario-conformance/` is its runtime corpus. | Live. No storyboard semantics. No ScenarioRunner anywhere. |

The export commands are locked by the CLI's parity goldens
(`native/crates/simforge-cli/tests/authoring_parity.rs`, the `export-*` cases).

## Conformance evidence

The oracle suite behind the decisions and findings below is not part of this
repository. It checks, per case:

1. **Ours vs spec (primary).** **Engine cases** (36) are authored in `SimScenarioInput`, the vocabulary our semantics live in. The engine runs at dt = 0.02 s. Each actor's pose and speed series, and each interaction's start and end, are compared to the oracle.
2. **esmini vs spec (evidence).** For engine cases, esmini runs an `actions`-profile export of the case. **Probes** (11) are hand-written files for OSC constructs SimForge does not express: priority skip/parallel/override, maximumExecutionCount, falling edges, condition delay, parameters, LanePosition, catalogs, a 1.0 file, and a linear lane change. For these, esmini is the only execution and is recorded against the oracle. A disagreement on an engine case is either an export bug or an esmini deviation.
3. **Round trip (exporter check).** esmini replays our **trajectory-replay** export (the shipped profile) and must reproduce our own trace to within 1 cm and 0.1°. It runs in esmini's `segment` polyline mode: esmini 3.6.0 predates the 1.4 `Interpolation` element, and its default ("corner") averages vertex headings.

Tolerances default to 0.25 m, 0.25 m/s, 1° and 0.021 s (one tick); a case may override them.

| Result (engine 0.10.0, esmini 3.6.0) | Count |
|---|---|
| Engine cases conforming to the oracle | **34 / 36** |
| Engine cases deviating by documented decision | 2 (`default-controller-*`, D-14) |
| Round trip of the shipped trajectory export | 36 / 36 within 1 cm / 0.1° |
| esmini agrees with the oracle | 39 / 45 cases (all 6 disagreements are esmini's own readings, F-19) |

Every later engine change that moves a trace bumps `ENGINE_SEM_VER` and is
locked by the golden-trace corpus (docs/engineering/engine-semver.md).

## The SimForge OSC profile

**Target.** ASAM OpenSCENARIO XML **1.4.0**, export only. Every file we write declares `revMajor="1" revMinor="4"` and validates against the pinned 1.4.0 XSD.

**Shipped: `trajectory-replay`.**
- Each actor gets an Init `TeleportAction` plus an absolute-timed `FollowTrajectoryAction` (Polyline of `WorldPosition` vertices with `Motion`, `followingMode="position"`), taken from our trace.
- Appearance, signal and delete events fire at their `SimulationTime`.
- Round trip: 1 cm / 0.1°.

**Semantic: `actions`.** These are exactly the constructs the engine executes, as the oracle suite pins them. The mapping is the semantic reference; the SDK's exporter ships only `trajectory-replay` for XML.

| Construct | Profile rule |
|---|---|
| Storyboard | One Act starting at SimulationTime 0. One ManeuverGroup and one Maneuver per actor. Events use `maximumExecutionCount=1`, `priority="parallel"`. Same-domain actions override each other (§7.5.1), which is our per-axis preemption (D-12). |
| Triggers | `SimulationTimeCondition ≥ t`, fired at the first tick at or after t (D-10). `StoryboardElementStateCondition` is `startTransition` for `after start` and `completeState` for `after end`, with a delay (D-11). `when` becomes level conditions (`conditionEdge="none"`) in OR-of-AND groups (D-05). A `byLatest` deadline becomes an ORed SimulationTime group. Conditions are gated to clip time ≥ 0 (D-13). |
| Conditions | RelativeDistance (freespace; euclidean or longitudinal/road), TimeToCollision (freespace), TimeHeadway (freespace), Speed, StandStill, Collision, TrafficSignalController. |
| Actions | SpeedAction (absolute, delta, factor, match; all shapes and dimensions), LaneChangeAction (relative lanes; authored shape and dimension), LaneOffsetAction (absolute, step), Add/DeleteEntity, Light/Animation appearance, AssignRouteAction (world waypoints). |
| Positions | WorldPosition. The reference point is the footprint centre, declared by `BoundingBox.Center=(0,0,h/2)` with the axles either side of it (D-06). |
| Controller | OSC default controller: keep lane and speed, no reactions. A SimForge actor exports cleanly when its cruise target is its initial speed and its reactive rules are off. Reactive rules export with a `reactive_controller_not_portable` warning. A missing or different cruise target is refused (D-14). |

**Refused** (`AsamExportError`):
- NOT conditions
- `gap`
- lane-offset transitions other than step (OSC `LaneOffsetActionDynamics` has no duration)
- next-junction routes
- road controls, props and environment in the actions profile
- missing or different cruise targets

## Semantics decisions

These are the places where ASAM 1.4.0 is silent, ambiguous or self-contradictory, the choice we made, and what esmini 3.6.0 does.

| ID | Topic | Our choice | Why / evidence | esmini 3.6.0 |
|---|---|---|---|---|
| D-01 | Sampling and action effect within a tick | The sample at t_k is the state before actions triggered at t_k apply. Those actions act over [t_k, t_k+1]. This applies to all actions, including `exist` and step changes. | The spec defines discrete condition evaluation (§7.6.2) but not intra-step order (§8.3). | Same |
| D-02 | `dynamicsDimension="distance"` | The shape is a function of travelled distance: τ = s/D. The engine integrates ds/dt = v(s) exactly. | The literal reading of `DynamicsShape` ("change … over time or distance"). "Distance" for a speed change is otherwise undefined. | Disagrees: time shape spanning D metres (T = 2D/(v₀+v₁)) |
| D-03 | `rate` for cubic and sinusoidal | Peak rate: T = k·|Δ|/rate, with k = 1.5 (cubic) and π/2 (sinusoidal); for lateral actions, the peak lateral velocity. | The spec says only "a predefined constant rate". | Same |
| D-04 | `step` | Instantaneous ("does not consume simulation time"). The action completes on the tick it fires. | `DynamicsShape.step` | Same |
| D-05 | SimForge `when` ↔ condition edge | Level trigger, `conditionEdge="none"`, one execution. It fires on the first tick the condition holds, including the first check (t=0). | With rising edges, a condition true at its first check never fires (§7.6.4), and an AND of rising edges fires only if all members rise on the same tick. | Evaluates as specified |
| D-06 | Vehicle reference point | Footprint centre on the ground. Declared in every exported file (`BoundingBox.Center=(0,0,h/2)`, front/rear axles at ±0.29·l). | §6.3.4 puts the vehicle origin at the rear axle; the file declares ours. | Uses the declared geometry |
| D-07 | TTC | Freespace (footprint gap) divided by closing speed, at constant velocity. Negative or zero closing speed means false. | `TimeToCollisionCondition` text | Correct timing, but spurious true on the first check (F-19) |
| D-08 | StandStill | "Stands still" means speed < 0.05 m/s, counted from the tick the state is first reached, and inclusive (≥ duration). | The spec gives no threshold. The threshold absorbs physics creep at rest. | Uses exactly 0: an exact cubic stop is below 0.05 m/s 0.12 s earlier |
| D-09 | DeleteEntityAction | Instantaneous; absent from t_k+1 (D-01). | – | Same |
| D-10 | Discrete SimulationTime | Evaluated on the 20 ms grid; `greaterOrEqual t` fires at the first tick ≥ t. | – | Same |
| D-11 | `after` | `start` = the parent's startTransition. `end` = the parent's completeState, reached by completion (speed reached, lateral done) or by being overridden (stopTransition). Delay is applied as C(t−Δ). | §7.6.3, `StoryboardElementStateCondition` | Same |
| D-12 | Priority and per-axis preemption | Events are `parallel`. The domain conflict rule (§7.5.1) makes a newer action override an older one on the same entity and domain; the overridden one ends (`interaction_aborted: preempted`). | `override` stops every running event in the Maneuver (§8.4.2.2), even across domains. `overwrite` is deprecated since 1.2. | Implements §7.5.1 |
| D-13 | Time origin | SimulationTime 0 is the start of the warm-up. Clip t = SimulationTime − warmupSeconds. Triggers are not evaluated before clip 0. | – | – |
| D-14 | Default controller | OSC: keep lane, keep current speed, no avoidance (§7.4.1.1). SimForge's product default is reactive: it avoids collisions, yields, obeys signals, and cruises at the lane limit when no cruise target is set. The OSC default is expressible (rules off, cruise = initial speed), conforms (`collision-condition-no-avoidance-rules`), and is what the actions export requires. | Product behaviour; two engine cases deviate by design. | Keeps lane and speed |
| D-15 | maximumExecutionCount > 1 with a level trigger | The event re-runs on subsequent checks until the count is used up. | §8.4.2.1; re-arm timing is unspecified. | 3 executions, as specified |
| D-16 | Priority `skip` | Follows §8.4.2.2: a skipped trigger consumes an execution, so with count 1 the event never runs. | Self-contradictory in 1.4.0: §8.4.2.2 vs the §7.3.2 "does not leave standbyState" text vs the `Priority` class ("not run while another is running"). | Keeps it in standby and runs it later |
| D-17 | Speed vs lateral motion | Speed is the length of the velocity vector, so a lateral motion reduces longitudinal progress. | §7.4.1.1 ("length of the vehicle's speed vector") | Same |
| D-18 | Lateral shapes | Lateral offset follows the authored shape: linear in time (heading steps at both ends), cubic, sinusoidal, or step. | `DynamicsShape` | Same (`probe-lane-change-linear`) |
| D-19 | Rotation order (h, p, r) | Intrinsic z-y′-x″ (ISO 8855 / OpenDRIVE). Our exports carry p = r = 0 except in trajectory replay with a render timeline. | §6.3 says "extrinsic Z, Y, X"; `Orientation` omits it. | – |
| D-20 | Version | Export declares 1.4.0 only. The 1.3 lowering refuses any other header. Readers of our files (execution plan, CARLA compiler) accept exactly 1.4. | – | Reads 1.0–1.3; aborts on 1.4 `<Interpolation/>` |
| D-21 | Authority of authored transitions | A fixed-target speed interaction, a lane change and a lane offset own the actor's kinematic state along their exact shape and duration, including non-physical steps, until they complete. The engine then hands the body back to physics with the profile's own acceleration and freely rolling wheels. If a safety cap (collision governor, stop line, cornering envelope, route end) binds, the speed command drops to physical tracking for the rest of its life. Human-driven and reversing bodies are never prescribed. Each authored transition emits `prescribed_motion`, and the plausibility audit explains motion findings inside it. | OSC actions prescribe the motion (a SpeedAction "describes the transition of an entity's speed"). The class envelope (e.g. lateral limits) is reported (`lateral_duration_clamped`: "executed as authored"), never silently applied. | – |
| D-22 | `gap` completion | A `gap` interaction publishes `interaction_completed` once its profile is over and the gap and relative speed have settled (0.5 m or 5 %, 0.5 m/s). It keeps following afterwards (a continuous LongitudinalDistanceAction). | – | – |
| D-23 | `speed(match)` | Continuous: follows the moving reference by physical tracking and never completes. | `RelativeTargetSpeed continuous=true` | – |

## Known deviations and findings

"Status" is one of: **fixed**, **decision** (see the decisions table), or **documented** (accepted, or out of scope).

| ID | Severity | Finding | Evidence (case) | Status |
|---|---|---|---|---|
| F-01 | High | The removed importer mirrored every actor north↔south: it set scene `z = +y_osc`, while the scene frame is `z = −y_osc`. Documents it created were repaired. | – | fixed (import removed) |
| F-02 | High | Speed and gap interactions never completed, so `after end` chains on them never fired. Longitudinal preemption did not end the preempted interaction. | `trigger-after-end` | fixed (0.10.0) |
| F-03 | High | `when … ifNever: 'fire'` never fired in compiled documents: the compiler turned `byLatest` into a clip window end whose gate skipped first. | `trigger-ifnever-fire` | fixed (0.10.0) |
| F-04 | Medium | Distance measures. The actions export labelled the engine's body-gap measures reference-point distances (`freespace="false"`), 4.8 m / about 1 s off. Euclidean triggers used circumscribed circles. Both are now true footprint separation (OSC freespace). | `trigger-distance-*`, `trigger-ttc`, `trigger-headway`, `condition-*` | fixed |
| F-05 | Medium | Speed tracking overshot: a linear 20→10 m/s ramp at 4 m/s² dipped to 8.1 m/s, and `stop` ignored its shape. Prescribed profiles are now exact (D-21), including completion. The cornering envelope no longer converges a stop to rest on its own. | `speed-*`, `same-axis-supersede`, `trigger-standstill` | fixed (0.10.0) |
| F-06 | Medium | `step` dynamics ran as physical ramps (10.9 m off); now instantaneous. | `speed-step`, `lane-offset-step` | fixed (0.10.0) |
| F-07 | Medium | Distance-dimension transitions lasted D/v₀; now per D-02. | `speed-linear-distance` | fixed (0.10.0) |
| F-08 | Medium | The lane-change shape was ignored (always a minimum-jerk quintic) and the duration silently stretched to class limits; the export always wrote a cubic. Both now carry the authored shape and duration. | `lane-change-*`, `probe-lane-change-linear` | fixed (0.10.0) |
| F-09 | High (semantic claim) | The SimForge default controller is reactive (D-14). The actions export's portability check was inverted: it rejected the OSC-default rules and accepted reactive ones. It now accepts OSC-default rules, warns on reactive rules, and refuses a missing or different cruise target. | `default-controller-*`, `collision-condition-no-avoidance-rules` | decision (engine); fixed (export) |
| F-10 | High (export) | Actions-profile storyboard mapping bugs, all fixed: (a) rising edges for level `when`; (b) one Maneuver with `overwrite` stopped cross-axis events; (c) `after start` exported as `completeState`; (d) conditions not gated during the warm-up; (e) deprecated `overwrite`. | export tests, `trigger-edge-true-at-start`, `condition-group-and`, `parallel-axes-speed-and-light`, `trigger-after-start` | fixed |
| F-15 | Low | `exist` showed in the trigger-tick sample, and the trajectory export scheduled the delete at the first absent tick. Both now follow D-01. | `delete-entity` (round trip) | fixed (0.10.0) |
| F-16 | Low | Exported vehicle geometry put the front axle beyond the bumper. Axles now sit at ±0.29·l around the footprint-centre reference point. | export tests, ASAM checkers | fixed |
| F-17 | Medium (process) | Nothing verified OSC semantics before the oracle suite, and the product claimed more than export. The claim now reads "Exports ASAM OpenSCENARIO XML 1.4.0 (trajectory replay)". | – | fixed |
| F-18 | Low | Version handling was lenient (a `revMajor≠1` import was translated; the 1.3 lowering was a blind regex). Import is gone; the 1.3 lowering refuses anything but one 1.4 header; the OSC-shaped schema pins `revMajor` 1. | – | fixed |
| F-19 | Info (esmini) | esmini 3.6.0 defects the suite found: TTC is true on its first check; a RelativeTargetSpeed that references the acting entity runs away; `skip` defers rather than consumes the execution (D-16); it reads speed over distance differently (D-02) and standstill as exactly 0 (D-08); it aborts on the 1.4 `<Interpolation/>`. | `trigger-ttc`, `speed-relative-*`, `probe-priority-skip`, `speed-linear-distance`, `trigger-standstill` | documented |
| F-20 | Info | Same-tick order is interaction-id order: the engine sorts interactions by id. It also changes the input hash relative to the authored input, so the trajectory exporter must be given the engine's executed input. `simforge export` simulates the instance and exports what the engine executed. | round-trip harness | documented |

The import findings F-11 to F-14 (placement-only import, dropped catalogs, dropped Lane/Road positions, parameter errors) were closed by removing import.

## Static validation (ASAM tooling)

**ASAM Quality Checker Framework** (v1.1.0) plus the **OpenSCENARIO XML bundle** (`asam-qc-openscenarioxml` 1.0.0, 17 rules):
- The bundle ships no 1.4 schema. On our 1.4 files, 13 of 17 rules are skipped unless the 1.4 XSD is registered.
- With the XSD registered, our exports pass.

**RA-Consulting OpenSCENARIO API checker** (v1.4.1):
- It implements the standard up to 1.3. On 1.4 files it reports the new `Motion` and `Interpolation` elements as unknown.
- Otherwise our exports pass.

Until either tool supports 1.4, validate exports with `xmllint` against the 1.4.0 XSD, the RA checker with Motion/Interpolation allowlisted, or the QC bundle with the 1.4 XSD registered.

## Interaction lifecycle

The engine's interaction lifecycle guarantees (established with seeded random storyboards plus targeted cases):
- at most one start per interaction, never both fired and skipped (maximumExecutionCount 1);
- at most one terminal end, never an end before the start;
- nothing evaluated during the warm-up;
- `after start` fires on the first tick at or after parent + delay, and inherits a skip;
- `after end` fires once a speed interaction completes;
- a deadline fires at `byLatest`, or is skipped when an explicit window closes first;
- same-axis preemption ends the overridden interaction, and there is no cross-axis preemption;
- `when` is level-triggered with no prior sample needed, and fires once even if its condition rises again;
- `at` snaps to the next tick;
- a step speed change is instantaneous and hands back without overshoot;
- `exist(absent)` shows from the tick after its trigger.
