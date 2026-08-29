# M2 engine label-trust fixes

## Defect locations

The omniscient reaction lived in `packages/engine/src/sim/engine.ts`: `planActor()` passed the nearest ground-truth leader and crossing-conflict candidate directly to `governorCap()`. The governor's braking dynamics were sound, but there was no perception boundary between world truth and ego control. The existing LOS implementation (`sim/visibility.ts`) was used for metrics and declared sensors, not for the ego governor.

The child actor catalog identity already existed on the landed branch, but only as geometry/model metadata. It lacked the requested child physical/motion profile and had no targeted compiler proof that the canonical `pedestrian.child` id propagated its stature and footprint into simulation input.

## Changes

### Sensor-limited ego controller

- `RunOptions.egoControllerProfile` is a closed profile: `sensor-limited` (default) or explicit `omniscient-legacy`.
- Ego resolution is deterministic: sorted `role:ego`, then literal actor id `ego`, then `metricSubject` as a fallback.
- The sensor-limited governor accepts a hazard only inside an 80 m forward sensor range and 120-degree full cone, additionally capped by `operationalConditions.effects.visibilityRangeM`.
- LOS is tested against the complete coarse physical visibility set: authored occluders, collidable props, low-complexity static map colliders, attached blockers, and every other live dynamic/static actor OBB. Observer and target bounds are excluded from self-occlusion.
- All collections used in decisions are actor-id/shape-id sorted. The implementation uses only fixed-step state; it has no clock, randomness, or unordered decision input.
- Braking, gap, signal, crossing-yield, steering/lateral, friction, and motion-backend dynamics are unchanged. Only hazard admission to the existing governor differs.
- Every native trace now emits `header.ego.controllerProfile`. The trace type keeps `ego` optional solely so historical readable traces remain representable.

### Child pedestrian

- `pedestrian.child` remains the canonical request id, with dimensions `0.24 × 0.35 × 1.20 m`; the 1.20 m stature is within the required 1.15–1.35 m band.
- Catalog motion metadata now declares 32 kg mass, 1.0 m/s walk, 3.0 m/s run, and direction-change impulsiveness 0.75.
- Dynamic-v1 recognizes `catalog:pedestrian.child` and applies a child-scaled 32 kg/inertia/drive/brake profile while preserving an explicit per-actor physics override.
- The compiler already validates class/catalog agreement and resolves catalog dimensions. A targeted test now pins the canonical id, dimensions, stature band, catalog tag, and motion metadata.
- The deterministic 2D renderer consumes compiled `instance.input.actors[].dims`; a corpus child trace rendered successfully at the compiled child footprint. `/tmp/m2-child-render/manifest.json` records the child/ego incident pair, deterministic rendering, exact actor closure, and the generated stills.

## Targeted verification

Passed:

- `pnpm --filter @simforge-oss/engine exec vitest run src/__tests__/ego-controller.test.ts` — 2/2. Proves a fully occluded leader does not affect sensor-limited ego until visible, the legacy ego reacts through the screen, and both trace profile stamps are exact.
- `pnpm --filter @simforge-oss/compiler exec vitest run src/prop-dims.test.ts src/__tests__/prop-dims-catalog-sync.test.ts` — 17/17. Proves canonical child resolution/profile and catalog/compiler dimension sync.
- `pnpm --filter @simforge-oss/asset-catalog exec vitest run src/__tests__/catalog.test.ts` — 13/13.
- Scoped builds: `@simforge-oss/asset-catalog`, `@simforge-oss/compiler`, `@simforge-oss/engine` (including the engine's scenario dependency), and `@simforge-oss/trace-render`.
- 2D smoke: `trace-render` successfully rendered `gold-corpus-v3/c12-ball-then-child/...draw-005` to `/tmp/m2-child-render` using the instance dimensions.

The map-backed compiler agreement test is intentionally map-asset-gated and was skipped on this worktree because the current Richmond compatibility asset lacks the required topology/derived files. The non-map catalog/compiler tests above cover the new child contract directly.

## Determinism proof

Each gold instance was parsed and simulated twice with the default sensor-limited controller against the recorded map topology. Hashes are SHA-256 `traceDigest` values over canonical quantized trace JSON.

| Gold instance | Run 1 | Run 2 | Equal |
|---|---|---|---|
| `c6-dooring/yale-street__67f8fd8fe01ea4d2__draw-007` | `0dd30062b196722ea3db84c3965f762515c1a21e5d117d0ebb2d479dd38f8e0a` | `0dd30062b196722ea3db84c3965f762515c1a21e5d117d0ebb2d479dd38f8e0a` | yes |
| `c6-dooring/yale-street__8730c4da0eb86b1a__draw-003` | `1bb2c0b3dca53bebe963e93999bc0006ebf72c759f0e8935a2a59dc6d7b70be5` | `1bb2c0b3dca53bebe963e93999bc0006ebf72c759f0e8935a2a59dc6d7b70be5` | yes |
| `c6-dooring/el-camino-road__7b01f74ce7914327__draw-008` | `52d644b27cf9a8acf0e98439b5b10d0f82146473d1aedb73dd83684f5d087e75` | `52d644b27cf9a8acf0e98439b5b10d0f82146473d1aedb73dd83684f5d087e75` | yes |

Machine-readable proof: `/tmp/m2-engine-proof/proof.json`.

## Controller divergence evidence

An exact two-profile replay of the requested Yale c6-dooring gold instance produced different canonical hashes because the profile provenance differs:

- sensor-limited: `0dd30062b196722ea3db84c3965f762515c1a21e5d117d0ebb2d479dd38f8e0a`
- omniscient legacy: `3215dac25d1ca914e98ce3f330bf61993042a69300140b9066ce38a77fdbdea1`

It did **not** produce a behavioral difference. This is an important property of the frozen artifact, not something to conceal: every gold c6-dooring input has `ego.behavior.rules.collisionAvoidance=false` and `occluders=[]`, so no ego safety governor is active and no occlusion exists. The exact outputs are `/tmp/m2-engine-proof/c6-dooring.{sensor-limited,omniscient-legacy}.trace.json.gz`.

To isolate the requested occlusion-sensitive behavior on a real gold c6 state/map, I ran a declared counterfactual based on the feasible El Camino c6-dooring instance: enabled its explicitly disabled ego governor, inserted one opaque screen between the original ego and cyclist, and set warmup to zero so onset is recorded. All other gold actor/map/choreography state remained. Results:

- sensor-limited: `d42bc3ce71580f7f4bd6e166f2b8452b9ec2151c82d9bf49890fdf995bddfadf`
- omniscient legacy: `dd9f5690e620c13e127e05bd5b9114bb6c5e2b3582184afed0f431bc777973c9`
- first ego behavioral divergence: `t=0.02 s`; sensor-limited `11.6666657463 m/s`, legacy `11.6639895505 m/s`.

Counterfactual details and outputs are `/tmp/m2-engine-proof/c6-counterfactual.json` and `/tmp/m2-engine-proof/c6-counterfactual.{sensor-limited,omniscient-legacy}.trace.json.gz`. The focused automated occlusion test is the permanent regression proof; this counterfactual is supplementary corpus evidence.
