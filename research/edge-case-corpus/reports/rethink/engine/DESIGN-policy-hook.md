# Design note: per-actor policy hook at the controllers.ts slot-ownership seam

Status: FINAL — EmergentLane issued GO (hub, 2026-08-16, per their PREREG F1) on interim
harvest numbers. Design only; no implementation is proposed for this window.
EngineLane (Stream D), RETHINK-PLAN §3D item 4.

## Why (demand, not speculation)

EmergentLane's paired-arm evidence (their run, 2026-08-16, cited with their consent):

- Naturalistic ambient coupling **rewrites authored dynamics reproducibly**: the same template
  flips gate pass sets across ambient densities in both directions; `c1-lead-hard-brake` admits
  5/27 without ambient vs 9/27 with — ambient *rescues* templates.
- At city density, `C5:trigger-never-fired` kills ~40% of authored gate passes: scripted `when`
  triggers assume dynamics the reactive layer no longer produces. Choreography and reactivity
  are fighting over the same actors.
- Determinism holds (36/36 byte-identical re-runs): the reactive layer does real behavioral
  work without breaking replay.

GO evidence (EmergentLane's interim harvest, 390/648 stage-1 world cells, pre-registered
miner): 17,434 raw near-critical events (T1 12,426), spectrum spans 8 categories with **no
rear-end soup** (C6 43%, C3 25%, C10 17%, C2 6%, C1-adj 4%, C1 3%, C9 1.3%, C11 0.4%);
tag-strip promotion admitted 3/36 attempts through the frozen gate ≈ 7.7/1000 world-runs with
promotion budget unexhausted — including an owner-list LEFT-TURN-across-traffic cell at
clearance 2.47 m / TTC 1.86 s on yale-street. Their dominant promotion death, **C4
dissolution** (the reactive ego responds to the promoted counterpart and the conflict demand
evaporates), is *directly* the seam this hook controls: a per-actor policy can hold a
counterpart's behavioral law fixed through promotion instead of EmergentLane's relabeling
workaround.

The conclusion this points at: the *interesting* behavior on this engine comes from reactive
coupling, but the only reactive policy available is the single built-in ambient driver law.
Diversity today is parametric (aggression/headway/reaction scalars sampled per actor,
`engine.ts driverProfile()`), not behavioral. A hesitant left-turner, a wave-through driver, a
cyclist that swerves around door zones — the owner-list negotiation behaviors — need different
*laws*, not different constants.

## The seam (verified in source)

`controllers.ts` states the contract at the top of the file: **one axis, one owner**.

- Each `ActorRuntime` has two command slots: `longCmd`, `latCmd` (`engine.ts:662-663`). A newly
  fired interaction on an axis replaces the owner and emits `preemption` (`engine.ts:1480-1484`);
  release (`engine.ts:1324-1326`) returns the axis to the **default law**.
- The default laws are pure functions with narrow inputs:
  - longitudinal: `longitudinalAccel({actor, t, dt, laneSpeedLimitMps, leader})`
    (`controllers.ts:234`) → cruise convergence when `longCmd === null`;
  - lateral: hold zero offset via `lateralStep`;
  - both are then **capped** by the safety governor `governorCap(actor, leader, stopLineDist,
    conflict)` (`controllers.ts:301`), which owns collision avoidance and stop-line law.
- Per-actor diversity already flows through `ActorRuntime.driver`
  (`desiredSpeedFactor, timeHeadwayS, minimumGapM, accelScale, comfortBrakeScale, reactionTimeS,
  startDelayS` — `engine.ts:683-703`), seeded deterministically per actor id.

## Proposal: policies as a third owner class for the DEFAULT slot state

A **policy** is a deterministic, engine-internal function that owns an actor's axes *when no
interaction does* — i.e. it replaces the default cruise/hold law, never the authored timeline
and never the governor.

```
Policy = (obs: PolicyObservation, mem: PolicyMemory) -> {
  long?: { kind: 'speed', targetMps } | { kind: 'gap', actorId, timeGapS },
  lat?:  { kind: 'laneOffset', offsetM, durationS } | { kind: 'changeLane', dir },
  mem:   PolicyMemory   // serializable, replay-deterministic
}
```

- `PolicyObservation` is assembled from state the engine already computes per tick: own
  kinematics, `findLeader` result, `distanceToStopLine`, nearest conflict from the pair pass,
  signal state, `driver` scalars. No new world queries.
- Precedence (unchanged from today, policy inserted at the bottom):
  `interaction owner > policy > built-in default law`, all under `governorCap`.
  Preemption semantics stay byte-identical: an authored interaction firing on an axis suspends
  the policy on that axis; release hands back to the policy, not to the built-in law.
- Registration: `actor.behavior.policy?: { id: string, params: Record<string, number> }` in
  `SimScenarioInput`, with a registry of named engine policies (`hesitant_yield`,
  `wave_through`, `gap_forcer`, `door_zone_swerver`, …). Template-side: a `role.policy` field
  materialized through unchanged. Ambient integration: `ambient/traffic.ts` samples policy ids
  from a weighted profile the same way it samples driver scalars today.
- Determinism: policies are pure functions of (obs, mem, driver scalars); mem lives on
  `ActorRuntime` and is seeded from the actor's existing RNG stream. Replay identity follows
  from the same argument as the current driver diversity (`engine.ts:682` comment).
- Trace/evidence: policy id + params land in `actorMetadata` tags (`policy:<id>`), decisions
  optionally as `state_set`-style events under `policy.*` keys for provenance. `inputHash`
  covers the policy fields automatically since they live on the input document.

## What this is NOT

- Not an external/LLM tick API: no I/O in the hot loop; the LLM's role stays *authoring* policy
  assignments and parameters (cheap, once per scenario), which is the implementable form of the
  owner's "every agent is a driver" (LEAD-REVIEW: no per-tick control API exists; latency×ticks
  is prohibitive).
- Not a physics change: `governorCap` still owns safety; `MOTION_LIMITS_BY_KIND` still clamps.
- Not a gate change.

## Cost estimate

- Engine: observation struct + registry + slot-precedence branch in the two accel call sites +
  memory field: ~300-400 lines, all in `sim/`; the risky part is keeping the no-policy path
  byte-identical (same guard style as `hasAmbientTraffic` in `driverProfile`).
- Schema/materializer: one optional field each, pass-through.
- Tests: byte-identity of no-policy traces (existing determinism suite), per-policy behavioral
  contracts, preemption round-trip (interaction fires over policy, releases back).
- Estimated 2-4 focused days including tests; no cross-package semantic decisions (unlike the
  `cart` ActorKind, REPORT.md §5c).

## Falsifiers for the eventual implementation

- If policies cannot reproduce EmergentLane's negotiation taxonomy classes better than density/
  aggression sweeps alone, the hook is unnecessary machinery — measure harvest yield per 1000
  cells with policy diversity vs scalar diversity before building more than 2-3 policies.
- If no-policy byte-identity cannot be held, the feature is mispriced and must not land.
