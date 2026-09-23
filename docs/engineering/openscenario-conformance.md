# OpenSCENARIO conformance

**Status.** September 2026. Target standard: **ASAM OpenSCENARIO XML 1.4.0** (spec dated 2026-05-08, published 19 May 2026), the latest 1.x release.

**The question this answers.** The standard is loose, and there is no reference implementation, so how do we know SimForge's OpenSCENARIO behaviour is correct?

**The answer.** Correctness is measured against a *spec-derived oracle*, one case at a time, with the ASAM clause cited:
- The oracle's expected values are computed by hand from the clause text: speed and lateral profiles from the `DynamicsShape` definitions, and the discrete tick at which each condition becomes true.
- No other implementation's opinion enters those values.
- esmini, and CARLA ScenarioRunner if it ever runs here, are recorded per case as **agrees**, **disagrees** or **unsupported**. That is evidence, not a reference.
- Where the text is ambiguous, the choice we made is written down in the [decisions table](#semantics-decisions).

Conformance means conformance to the published [SimForge OSC profile](#the-simforge-osc-profile). Anything outside the profile must be rejected loudly.

## Where OpenSCENARIO lives in SimForge

| Surface | Code | Status |
|---|---|---|
| Our execution semantics | The engine's `SimScenarioInput` interactions (`packages/engine/src/schema/input.ts`), executed by `native/crates/simforge-core/src/engine/{triggers,interactions,controllers}.rs`. Studio documents reach them through `simforge-compiler` (`materialize/builder.rs`). | Live. **This is what the conformance suite tests.** |
| XML 1.4 export, `trajectory-replay` profile | `packages/openscenario/src/export/xml-1.4.ts`. Called by `compileExecutionPackage` (`packages/compiler/src/execution-package.ts`), the Studio browser worker and `simforge export`. | Live. It is the only shipped profile. It bakes our trace into timed `Polyline` trajectories. Round trip checked (below). |
| XML 1.4 export, `actions` profile | Same file, `executionMode: 'actions'`. | Tests only. No product path uses it. It is the semantic mapping this suite measures. |
| XML "1.3 esmini" export | `export/xml-1.3-esmini.ts`: a textual lowering of the 1.4 output. | CLI `--format xosc-1.3-esmini` only. |
| DSL 2.2 export | `export/dsl-2.2.ts` | CLI `--format osc-2.2` only. `at`/`after` triggers only. |
| Import | `packages/openscenario/src/import.ts` (`analyzeOpenScenarioImport`, `translateOpenScenarioImport`). Used by Studio `POST /api/simforge/imports/openscenario` ("Open OpenSCENARIO as reference") and `simforge import`. | Live. Imports entities, Init poses and initial speeds only. Everything else is reported as a diagnostic (F-11). |
| Studio `studio-shared/xosc*`, `xosc-import/*` | `importXoscToDraft`, `parseXoscToActors`, scenario checks. | Dead. It inverts an `apps/web` writer that no longer exists. Not a third-party importer. |
| CARLA | `adapters/carla-exec/.../runtime/compiler.py` compiles only our own 1.4 trajectory-replay files into a 50 Hz plan. With a render timeline present, the timeline wins. | Live. No storyboard semantics. No ScenarioRunner anywhere (repo, adapter image or SimCloud). |
| Native renderer | `packages/render/src/native/lowering.ts` | Legacy fallback when no render timeline is present. |
| esmini lane | `packages/openscenario/src/esmini/*` (runner, CSV ingest), `trace-diff/*`. SimCloud `openscenario_validate` job. | Package code is tests and e2e only. The SimCloud lane is served only by the scenario-compiler worker, which is scaled to 0 in dev and staging (F-17). |

## The conformance suite

### Layout

```
fixtures/osc-conformance/
  cases/<id>.case.json        one feature per case: scenario, spec oracle, recorded verdicts
  xosc/<id>.xosc              our XML 1.4 actions export of each engine case (golden; kept current)
  probes/<id>.xosc            hand-written files for constructs SimForge cannot express
  probes/catalogs/            catalog used by probe-catalog-vehicle
  */osc-conformance-straight.xodr   generated 600 m straight road (lanes 1, -1, -2, -3; 3.5 m)
packages/cli/src/tools/osc-conformance/   oracle, runner, esmini driver and log/CSV readers, report
packages/cli/scripts/osc-conformance.ts   CLI entry point
packages/cli/src/__tests__/osc-conformance.test.ts   unit tests + the primary suite in vitest
packages/engine/src/__tests__/storyboard-protocol.test.ts   protocol/property tests (below)
```

### What each case checks

1. **Ours vs spec (primary).**
   - **Engine cases** (`kind: engine`, 36) are authored in `SimScenarioInput`, the vocabulary our semantics live in. The engine runs at dt = 0.02 s. Each actor's pose and speed series, and each interaction's start and end, are compared to the oracle.
   - **Probes** (`kind: xosc`, 12) cover what we cannot express: priority skip/parallel/override, maximumExecutionCount, falling edges, condition delay, parameters, LanePosition, catalogs, 1.0 files, a linear lane change, and the WorldPosition frame. They check the live importer's disposition: translated actors, required diagnostics, error code, and scene poses. That is how we prove the loss is loud.
   - This check needs no simulator. It runs in vitest on every CI run.
2. **esmini vs spec (evidence).**
   - For engine cases, esmini runs our actions export of the case. For probes, it runs the probe.
   - The result is recorded as agrees, disagrees or unsupported. An engine case's esmini verdict measures *our export as executed by esmini*, so a disagreement is either an export bug or an esmini deviation. The case's `esminiNote` says which.
3. **Round trip (exporter check).**
   - esmini replays our **trajectory-replay** export (the shipped profile) and must reproduce our own trace to within 1 cm and 0.1°.
   - This catches frame, time-origin, heading and reference-point bugs in the file we ship.

A case fails CI when any observed verdict differs from the recorded one. Fixing a deviation therefore also fails the suite, which forces the recorded expectation (and this document) to be updated with it.

Tolerances default to 0.25 m, 0.25 m/s, 1° and 0.021 s (one tick). A case may override them, and `compareUntilS` limits motion comparison (for example, up to a collision).

### Running it

```
# primary suite only (no esmini needed): part of the CLI package tests
pnpm --filter @simforge-oss/cli exec vitest run src/__tests__/osc-conformance.test.ts

# full run incl. esmini cross-check and round trip (skips esmini parts if absent)
node packages/openscenario/scripts-esmini/fetch-pinned-esmini.mjs   # installs pinned esmini 3.6.0 under .tools/
pnpm osc-conformance:verify -- --markdown report.md --json report.json
SIMFORGE_ESMINI_BIN=/path/to/esmini pnpm osc-conformance:verify -- --case trigger-ttc --keep

# after an intentional exporter change
pnpm osc-conformance:update-xosc
```

The whole suite takes about 5 s (48 cases, 84 esmini runs).

### Adding a case

1. Pick one feature.
2. Write the OSC-level scenario on the straight road.
3. Derive the expected numbers by hand from the clause text, and put the derivation in `oracle.derivation` so a reviewer can redo it:
   - speeds and lateral offsets use the `DynamicsShape` functions in `oracle.ts`;
   - events start at the first 20 ms tick where the condition is true.
4. Cite the clauses.
5. Reference a decision ID wherever the spec is silent.
6. Record `expect.ours` / `expect.esmini` from the first run *after* you have explained every difference.

Trigger cases use smooth (cubic) actions and do not assert action ends, so they isolate trigger semantics. The speed and lateral cases test motion.

## The SimForge OSC profile

**Target.** ASAM OpenSCENARIO XML **1.4.0**, and we export 1.4.0.

**Import.**
- We accept `revMajor=1` with `revMinor` 0–4, including the deprecated forms a 1.4 reader must still read: `overwrite`, `alongRoute`, `cartesianDistance`, ReachPositionCondition, `integer`.
- Other majors and newer minors are only diagnosed today (F-18).

**Supported semantics.** These are exactly what the engine executes. The actions profile exports them, and the suite pins them.

| Construct | Profile rule |
|---|---|
| Storyboard | One Act starting at SimulationTime 0. One ManeuverGroup and one Maneuver per actor. Events use `maximumExecutionCount=1`, `priority="parallel"`. Same-domain actions override (§7.5.1), which is our per-axis preemption (D-12). |
| Triggers | `SimulationTimeCondition ≥ t`, fired at the first tick at or after t (D-10). `StoryboardElementStateCondition` is `startTransition` for `after start` and `completeState` for `after end`, with a delay (D-11). `when` becomes level conditions (`conditionEdge="none"`) in OR-of-AND groups (D-05). A `byLatest` deadline becomes an ORed SimulationTime group. Conditions are gated to clip time ≥ 0 (D-13). |
| Conditions | RelativeDistance (freespace, euclidean or longitudinal/road), TimeToCollision (freespace), TimeHeadway (freespace), Speed, StandStill, Collision, TrafficSignalController. |
| Actions | SpeedAction (absolute, delta, factor, match; all shapes and dimensions), LaneChangeAction (relative lanes), LaneOffsetAction (absolute, step), Add/DeleteEntity, Light/Animation appearance, AssignRouteAction (world waypoints). |
| Positions | WorldPosition only. The reference point is the bounding-box centre (D-06). |
| Default controller | **Not** OSC's (F-09). |

**Rejected loudly** (export `AsamExportError`, import diagnostics):
- NOT conditions
- `gap`
- lane-offset transitions other than step
- next-junction routes
- road controls, props and environment in the actions profile
- non-default controller rules

**Not supported, and dropped with a diagnostic on import:**
- storyboard events, triggers and actions (the import is Init-only)
- Lane, Road and Relative positions
- trajectories
- signal programs
- parameters: currently a hard `invalid_number` error (F-14)

## Semantics decisions

These are the places where ASAM 1.4.0 is silent, ambiguous or self-contradictory, the choice we made, and what esmini 3.6.0 does.

| ID | Topic | Our choice | Why / evidence | esmini 3.6.0 |
|---|---|---|---|---|
| D-01 | Sampling and action effect within a tick | The sample at t_k is the state before actions triggered at t_k apply. Those actions act over [t_k, t_k+1]. | The spec defines discrete condition evaluation (§7.6.2) but not intra-step order (§8.3). This convention makes continuous and instantaneous actions consistent. It matches how the engine samples profiles and how esmini logs. | Same (step, delete and lane-offset step first visible at t_k+1) |
| D-02 | `dynamicsDimension="distance"` for SpeedAction | The shape is a function of travelled distance: τ = s/D. | The literal reading of `DynamicsShape` ("change … over time or distance"). "Distance" for a speed change is otherwise undefined. | Disagrees: time shape spanning D metres (T = 2D/(v₀+v₁)) |
| D-03 | `rate` for cubic and sinusoidal | Peak rate: T = k·|Δ|/rate, with k = 1.5 (cubic) and π/2 (sinusoidal). | The spec says only "a predefined constant rate". Both esmini and our engine use the peak reading. | Same |
| D-04 | `step` | Instantaneous ("does not consume simulation time"); completes at the trigger tick. | `DynamicsShape.step`. | Same |
| D-05 | SimForge `when` ↔ condition edge | Level trigger, `conditionEdge="none"`, one execution. It fires on the first tick the condition holds, including at the first check (t=0). | With rising edges, a condition true at its first check never fires (§7.6.4), and an AND of rising edges fires only if all members rise on the same tick. | Evaluates as specified |
| D-06 | Vehicle reference point | Bounding-box centre on the ground. Exported as `BoundingBox.Center=(0,0,h/2)` and `RearAxle.positionX=0`, so every file is self-consistent. | §6.3.4 says the vehicle origin is the rear-axle centre. Ours differs, but it is declared in the file. See F-16 for the axle geometry and for import of rear-axle-referenced files. | Uses the declared geometry |
| D-07 | TTC | Freespace (body gap) divided by closing speed, at constant velocity. Negative or zero closing speed means false. | `TimeToCollisionCondition` text; "cannot be predicted" means false. | Correct timing, but spurious true on the first check (see F-19) |
| D-08 | StandStill | "Stands still for duration" is inclusive (≥). The engine uses a threshold of 0.05 m/s. | The spec gives no threshold. | Agrees on timing |
| D-09 | DeleteEntityAction | Instantaneous. The entity is absent from t_k+1 (D-01). | – | Same |
| D-10 | Discrete SimulationTime | Evaluated on the 20 ms grid; `greaterOrEqual t` fires at the first tick ≥ t. | – | Same |
| D-11 | `after` | `start` = the parent's startTransition; `end` = the parent's completeState, reached by either endTransition or stopTransition. Delay is applied as C(t−Δ). | §7.6.3, `StoryboardElementStateCondition`. | Same |
| D-12 | Priority and per-axis preemption | Events are `parallel`. The domain conflict rule (§7.5.1) makes a newer action override an older one on the same entity and domain. | `override` stops every running event in the Maneuver (§8.4.2.2), even across domains. `overwrite` is deprecated since 1.2. | Implements §7.5.1 |
| D-13 | Time origin | SimulationTime 0 is the start of the warm-up. Clip t = SimulationTime − warmupSeconds. Triggers are not evaluated before clip 0. | – | – |
| D-14 | Default control strategies | OSC: keep lane, keep current speed, no avoidance (§7.4.1.1). SimForge's defaults are reactive (F-09). | – | Keeps lane and speed |
| D-15 | maximumExecutionCount > 1 with a level trigger | The event re-runs on subsequent checks until the count is used up. | §8.4.2.1; re-arm timing is unspecified. | 3 executions, as specified |
| D-16 | Priority `skip` | Follows §8.4.2.2: a skipped trigger consumes an execution, so with count 1 the event never runs. | Self-contradictory in 1.4.0: §8.4.2.2 vs the §7.3.2 "does not leave standbyState" text vs the `Priority` class ("not run while another is running"). | Keeps it in standby and runs it later |
| D-17 | Speed vs lateral motion | Speed is the length of the velocity vector, so a lane change reduces longitudinal progress. | §7.4.1.1 ("length of the vehicle's speed vector"). | Same |
| D-18 | Linear lane-change shape | Lateral offset is linear in time (heading steps at both ends). | `DynamicsShape.linear` | Same (`probe-lane-change-linear`) |
| D-19 | Rotation order (h, p, r) | Intrinsic z-y′-x″ (ISO 8855 / OpenDRIVE). Our exports carry p = r = 0 except in trajectory replay with a render timeline. | §6.3 says "extrinsic Z, Y, X"; `Orientation` omits it. | – |
| D-20 | Version intake | Read 1.0–1.4, including every deprecated construct listed in §5 / the XSD. Validate against the file's own version (checker rule `xml.valid_schema`). | §5 Backward compatibility. | Reads 1.0–1.3; aborts on 1.4 `<Interpolation/>` |

## Known deviations and findings

"Status" is one of: **fixed** (on `audit/openscenario-conformance`), **proposal** (behaviour-changing, awaiting a decision), or **documented** (accepted, or out of scope).

| ID | Severity | Finding | Evidence (case) | Status |
|---|---|---|---|---|
| F-01 | High | The live importer mirrored every actor north↔south. It set scene `z = +y_osc`; the scene frame is `z = −y_osc`, and the compiler reads map `y = −z`. The test fixture had pinned the bug. Documents already imported are repaired once, on the author's confirmation in the editor or by `studio/scripts/fix-mirrored-openscenario-imports.ts` (`fixMirroredOpenScenarioImport`, `@simforge-oss/scenario`). | `probe-world-position-frame` | fixed |
| F-02 | High | Speed (and gap) interactions never complete. There is no `interaction_completed` when the target speed is reached, so `after end` chains on them never fire. OSC completes a SpeedAction when the speed is reached (§7.5.2.1). | `trigger-after-end` (B never starts; spec 4.00 s); every speed case's end; pinned by `storyboard-protocol.test.ts` (`it.fails`) | proposal |
| F-03 | High | `when … ifNever: 'fire'` never fires for template-compiled documents. The compiler adds a window ending at `byLatest`, and the window gate skips before the deadline can fire. Raw engine input works. | `storyboard-protocol.test.ts` (`it.fails`) | proposal |
| F-04 | Medium | Distance measures. The actions export labelled the engine's body-gap measures `freespace="false"`, 4.8 m / about 1 s off the exported file (now fixed: `freespace="true"`). Euclidean distance still uses circumscribed circles, which is no OSC measure; it is exported as freespace with a `distance_metric_approximated` warning and lands within one tick here. | `trigger-distance-*`, `trigger-ttc`, `trigger-headway`, `condition-*` | fixed (export); proposal (engine euclidean → box distance) |
| F-05 | Medium | Speed tracking. Profiles with a discontinuous or large acceleration demand are followed by a controller that *overshoots*. Linear 20→10 m/s at 4 m/s² undershoots to 8.1 m/s (2.2 m/s below target); a 2 s cubic undershoots by 3.2 m/s. Gentle and 3 s cubic/sinusoidal profiles track within 0.01 m/s. The `stop` target ignores the prescribed shape. | `speed-linear-*`, `same-axis-supersede`, `trigger-standstill` | proposal |
| F-06 | Medium | `step` dynamics (speed, lane offset) are silently executed as fast physical transitions: a 10 m/s step becomes a 10.9 m position error. No warning. | `speed-step`, `lane-offset-step` | proposal (warn or reject) |
| F-07 | Medium | Distance-dimension transitions last D/v₀. That matches neither reading (D-02 or esmini's): the transition finishes after about 0.75·D metres. | `speed-linear-distance` | proposal |
| F-08 | Medium | The lane-change `shape` is ignored: execution is always a minimum-jerk quintic, 0.3–0.66 m off the spec. The duration is silently stretched to class lateral limits (the linear case completes at 5 s instead of 4 s), with only a trace event. The actions export silently rewrites every lane change to `cubic` with the engine's effective duration, so the authored shape is lost from the file too. | `lane-change-*`, `probe-lane-change-linear` | proposal |
| F-09 | High (semantic claim) | The default controller is reactive: collision avoidance, yielding, obeying signals, and cruising at the lane limit when `cruiseSpeedMps` is omitted (10 m/s becomes 36 m/s, 90.8 m off). OSC keeps lane and speed. The actions exporter's portability check is **inverted**: it accepts the reactive defaults and rejects `collisionAvoidance=false`, which is the OSC behaviour. | `default-controller-*`, `collision-condition-no-avoidance-rules` | proposal |
| F-10 | High (export) | Actions-profile storyboard mapping bugs, all fixed: (a) `conditionEdge="rising"` for level `when` (never fires if already true; AND of rising edges effectively never fires); (b) one Maneuver with `overwrite` stopped cross-axis events (speed frozen at 22.5 m/s when a light switched on); (c) `after start` exported as `completeState` (2 s late); (d) conditions not gated during the warm-up; (e) deprecated `overwrite` in both profiles. | `trigger-edge-true-at-start`, `condition-group-and`, `parallel-axes-speed-and-light`, `trigger-after-start`, export tests | fixed |
| F-11 | High (claim) | The live import keeps only Init entities, poses and speeds. All storyboard semantics are dropped under one generic `storyboard_semantics_not_translated` diagnostic. It is a *placement* import, not scenario import. | all `probe-*` with events | documented; see recommendation |
| F-12 | Medium | Catalog-referenced entities were dropped as `entity_type_unsupported`; every ASAM and esmini example uses catalogs. They are now kept, with the class inferred from the catalog name and a `catalog_reference_unresolved` diagnostic. Catalogs are still not resolved. | `probe-catalog-vehicle` | fixed |
| F-13 | Medium | Actors placed with Lane, Road or Relative positions are dropped (with `actor_position_unsupported`). Most third-party files use LanePosition. | `probe-lane-position-init` | documented |
| F-14 | Medium | Any `$param` or `${expr}` in an Init number fails the whole import with `invalid_number`, a misleading message. | `probe-parameters` | proposal |
| F-15 | Low | `exist absent` shows in the trigger-tick sample, one tick earlier than every other action. The trajectory export then schedules the delete at that tick, so esmini removes the entity one tick after our trace. | `delete-entity` (round trip) | proposal |
| F-16 | Low | Exported vehicle geometry: `FrontAxle.positionX = 0.58·l` lies beyond the front bumper. Import ignores `BoundingBox.Center`, so a third-party file using the §6.3.4 rear-axle reference imports about 1.4 m back. | review, ASAM checkers | proposal |
| F-17 | Medium (process) | Nothing verified OSC semantics before this suite. `ESMINI_OBSERVABLE_EVENT_KINDS = []`, so no trigger timing was ever compared. The e2e interop test accepts either verdict. The SimCloud esmini lane is not served in hosted envs. The certification page claims "ASAM OpenSCENARIO XML: Available today". | code review | documented |
| F-18 | Low | Version intake: a file with `revMajor≠1` is still translated, with only a diagnostic. The 1.3 esmini "lowering" is a regex over the 1.4 text. | review | proposal |
| F-19 | Info (esmini) | esmini 3.6.0 defects the suite found: TTC is true on its first check; RelativeTargetSpeed that references the acting entity runs away; `skip` defers rather than consumes the execution (D-16); it aborts on the 1.4 `<Interpolation/>`; its speed-over-distance reading differs (D-02). | `trigger-ttc`, `speed-relative-*`, `probe-priority-skip`, `speed-linear-distance` | documented |
| F-20 | Info | Same-tick order is interaction-id order: the engine sorts interactions by id. It also changes the input hash relative to a TS-parsed input, so the trajectory exporter must be given the engine's executed input. The production compiler does this. | round-trip harness | documented |

## Static validation (ASAM tooling)

**ASAM Quality Checker Framework** (v1.1.0) plus the **OpenSCENARIO XML bundle** (`asam-qc-openscenarioxml` 1.0.0, 17 rules):
- The bundle ships no 1.4 schema. On our 1.4 files, 13 of 17 rules are skipped unless the 1.4 XSD is registered.
- With the XSD registered, all our exports pass. Only the pre-fix `overwrite` warnings appeared.

**RA-Consulting OpenSCENARIO API checker** (v1.4.1):
- It implements the standard up to 1.3. On 1.4 files it reports the new `Motion` and `Interpolation` elements as unknown.
- Otherwise our exports pass. It correctly flagged the deprecated `overwrite`.

**How to run them.** Both are headless and take under 0.1 s per file. The invocation and the CI snippet are in the audit report. Until either tool supports 1.4, gate CI on:
1. `xmllint` against the pinned 1.4.0 XSD (already done for execution packages);
2. the RA checker with Motion/Interpolation allowlisted;
3. the QC bundle with the 1.4 XSD registered.

## Protocol tests

`packages/engine/src/__tests__/storyboard-protocol.test.ts` covers the interaction lifecycle. It uses 40 seeded random storyboards plus targeted cases, and checks:
- at most one start per interaction, never both fired and skipped (maximumExecutionCount 1);
- at most one terminal end, never an end before the start;
- nothing evaluated during the warm-up;
- `after start` fires on the first tick at or after parent + delay, and inherits a skip;
- same-axis preemption, and no cross-axis preemption;
- `when` is level-triggered with no prior sample needed, and fires once even if its condition rises again;
- `at` snaps to the next tick;
- F-02 and F-03 are pinned with `it.fails`.

**On a TLA+/PlusCal model.** The engine's lifecycle is Pending → Fired | Skipped, with per-axis ownership. That is small enough for the property tests above. A model would pay off only if we implement the full storyboard, because the spec itself is inconsistent there: multi-execution events, skip/override, ManeuverGroup re-arm and stop-trigger inheritance. At that point, model the chosen reading of §8.4 (D-15, D-16) in PlusCal, before writing the executor.
