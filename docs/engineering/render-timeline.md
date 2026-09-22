# Render timeline and shared sampler (`simforge.render-timeline.v1`)

Status: accepted 2026-09-22. This is the render contract (SimCloud ADR 0005,
amended 2026-09-22). One authoritative simulation produces one canonical
trace. Every consumer replays that trace through this timeline and this
sampler. OpenSCENARIO `.xosc` is a derived interop export and not a render
input.

| Piece | Where |
|---|---|
| Rust types, builder, height source, sampler | `native/crates/simforge-core/src/trace/timeline/` (`mod.rs`, `height.rs`, `sampler.rs`) |
| WASM (editor, Node) | `RenderTimeline` in `@simforge-oss/native-runtime/browser` (`native/crates/simforge-bindings-wasm`) |
| Python (CARLA adapter) | `simforge-oss-timeline` wheel, module `simforge_oss_timeline` (`adapters/timeline`, crate `native/crates/simforge-timeline-python`) |
| Node hosts (timeline job, CLI, Bevy lowering) | `@simforge-oss/render/timeline`: `buildRenderTimeline`, `openRenderTimeline`, `pose`, `compareObserved` (WASM loaded in Node) |
| Scene-state projection (Bevy) | `sampler::scene_yup`; `packages/render/src/native/timeline-lowering.ts` → `load_scene_state` |
| Parity comparator | `native/crates/simforge-core/src/trace/timeline/parity.rs`; Python `compare_observed`, WASM `compareObservedJson`, CLI `simforge render parity` |

## 1. Pipeline position

```
document ─► ResolvedInput ─► SIMULATE (once, authoritative) ─► CanonicalTrace v4 ── traceSha256
                                                                   │
            map .xodr + topology (height source) ──────────────────┤
                                                                   ▼
                                           TIMELINE (CPU, deterministic, keyed)
                                                                   │  timelineSha256
                       ┌────────────────────┬──────────────────────┼───────────────────┐
                    editor (WASM)      Bevy (Rust/Node)     CARLA (Python)     xosc export (derived)
                    pose(tl, id, t)    pose(tl, id, t)      pose(tl, id, t)
```

No renderer owns motion. A renderer never re-simulates, re-derives height,
or interpolates on its own. It asks the sampler for a pose at its exact frame
time and applies that pose.

## 2. Identity and keys

**Canonical trace identity.** `traceSha256 = sha256(canonicalJson(quantized
trace))` (`SimTrace::digest`, `CanonicalTraceIdentity::of`). It is never
computed from the bytes of a gzip or any other encoding. Two traces with the
same `traceSha256` are the same simulation.

**Timeline key.** The key is computable before a build, so a worker can
dedupe and look up results. It is

```
timelineKey = sha256(canonicalJson({
  schema: "simforge.render-timeline-key/v1",
  traceSha256, heightFieldDigest, catalogDigest /* string | null */, samplerVersion
}))
```

- `heightFieldDigest` is `heightSource.digest` (section 4).
- `catalogDigest` is the actor-catalog closure digest the caller pins. It is
  `null` when the caller pins none.
- `samplerVersion` is currently `"simforge.timeline-sampler/1"`. It covers
  both the derivation rules (heights, attitude, lights) and the sampling
  rules. Changing either one bumps it, which changes every key.

**Content digest.** `timelineSha256 = sha256(canonicalJson(timeline))`.
The stored and shipped bytes are exactly `canonicalJson(timeline)`
(`to_canonical_json` / `toCanonicalJson`), so the sha256 of the artifact
bytes equals `timelineSha256`.

**`catalogDigest` in v1.** Pass `null`. The v1 timeline derives everything
from the trace: catalog ids come from `catalog:<id>` tags and class
defaults, and dimensions come from the trace header. Both are already
covered by `traceSha256`. The key reserves this slot for a later sampler
that reads catalog data (wheelbase, track, body gains). That sampler will
take the actor-asset closure digest (`actors.native-closure`), and its
`samplerVersion` bump will change every key anyway.
Render jobs reference `timelineSha256`. Storage layout (owned by WS-D):
`timelines/sha256/<timelineSha256>.json.gz`, indexed by `timelineKey`.

## 3. Frame and units

- **Frame.** The OpenSCENARIO world frame, which equals the trace's
  `xodr-local` frame: right-handed, `x` east, `y` north, `z` up, heading
  counter-clockwise from `+x`. Units are metres, seconds and radians.
- **Orientation.** Follows OpenSCENARIO `Orientation`:
  - `headingRad`: counter-clockwise about `+z`.
  - `pitchRad`: positive is **nose down**.
  - `rollRad`: positive is **right side down**.
  - Composition is intrinsic heading → pitch → roll.
- **Position.** `(x, y)` is the footprint centre. `z` is the
  **ground-contact** elevation, meaning the bottom of the body, not its
  centre.

Each renderer converts at its own boundary:

- **Bevy / scene-state.v1 (y-up).** `position = [x, z, −y]`, with yaw
  numerically identical. The quaternion is
  `q = q_yaw(+Y, h) · q_pitch(+Z, −p) · q_roll(+X, r)`, implemented once in
  `sampler::scene_yup`.
- **CARLA / UE (left-handed).** Negate `y` and yaw, and flip the pitch sign
  as the CARLA transform convention requires.

## 4. Height source: one source, evaluated once

`heightSource = {kind, xodrSha256?, topologyDigest?, flatZM?, planeGradient?, digest}`,
where `digest = sha256(canonicalJson(the other fields))`.

- **`xodr-elevation/v1`.** Evaluates the OpenDRIVE `<elevation>` reference-line
  profile, projected onto the topology's lane ribbons.
  - It is a step-for-step Rust port of the resolver the xosc exporter used
    (`packages/compiler/src/xodr-elevation.ts`): same ribbon acceptance, same
    driving-lane preference, same ambiguity refusal, and the same 25 m
    off-network bound, beyond which the build fails.
  - One difference from the exporter: overlapping decks are disambiguated by
    the road of the actor's per-tick `laneRsl`. The exporter used the actor's
    authored route roads.
  - The build fails with `MapMismatch` when `xodrSha256` differs from the
    trace's `engineGraphDigest`.
- **Reserved: `xodr-elevation/v2`.** Superelevation and `<laneHeight>`. It
  needs reference-line lateral offsets that the topology does not carry yet.
- **`flat/v1`, `plane/v1`.** Constant and inclined synthetic surfaces, for
  maps without elevation and for tests. Their digests never alias an XODR
  source.

Renderers never raycast and never sample their own terrain for bodies. A
CARLA cooked-mesh raycast may run only as a diagnostic that reports the
mesh-vs-XODR delta.

## 5. Time origin

| field | meaning |
|---|---|
| `time.timeOriginS` | always `0`. Timeline `t = 0` is the first rendered instant (clip start). |
| `time.warmupS` | Length of the simulated warm-up prologue before `t = 0`. It is **never rendered** and never sampled. |
| `time.clipEndS` | `t` of the last tick. The sampling domain is `[0, clipEndS]`. |
| `time.xoscTimeOffsetS` | Equals `warmupS`. OpenSCENARIO `SimulationTime = t + xoscTimeOffsetS`. A derived xosc holds the `t = 0` pose through the warm-up pre-roll. |
| `dtS` | Fixed at `0.02`. Building from a trace at any other dt is rejected (`UnsupportedDt`). |
| `t[]` | Clip-relative tick times, quantised to 6 decimals, length `tickCount`. |

A renderer samples at its exact frame times: `t = frame / fps` from
integer-microsecond schedules. It never assumes its own dt. A fixed-step
renderer (CARLA, 0.02 s) chooses one capture policy per job and records it in
its manifest as `capture.policy`:

- **`tick-aligned`**: frame rates that divide 50 Hz (10, 25, 50). Every
  frame falls on a tick, and the renderer samples at the tick time.
- **`sub-tick-sampled`**: any other rate, such as 20, 24 or 30 fps. The
  renderer steps every 50 Hz tick. On the tick nearest each frame (within
  half a tick) it poses every actor with `pose(tl, id, k / fps)`, the exact
  frame time, and captures that tick. The drawn poses are therefore exact
  at the frame time. Only the world clock the renderer runs on is
  quantised.

## 6. Document

```jsonc
{
  "version": "simforge.render-timeline.v1",
  "identity": { "traceSha256", "heightFieldDigest", "catalogDigest", "samplerVersion", "timelineKey" },
  "trace": { "traceSha256", "traceVersion", "engineVersion", "inputHash", "mapId", "engineGraphDigest" },
  "heightSource": { "kind", "xodrSha256", "topologyDigest", "digest" },
  "mapId": "yale-street",
  "frame": "xodr-local",
  "dtS": 0.02, "tickCount": 1001, "t": [0, 0.02, ...],
  "time": { "timeOriginS": 0, "warmupS": 1, "clipEndS": 20, "xoscTimeOffsetS": 1 },
  "environment": { "weather": {...scene-state.v1...}, "timeOfDay": 12, "profile": "sensor", "lowBeams": false },
  "actors": [ /* sorted by id */ {
    "id", "kind", "catalogId", "catalogAuthored", "actorClass", "dims": {"l","w","h"}, "color"?, "static",
    "origin": "authored" | "native-ambient" | "sumo",
    "lifecycle": [ { "spawnTick": 0, "despawnTick": 907 | null } ],
    "track": {                          // index-aligned with t[]; zeros at absent ticks
      "present", "x", "y", "z", "headingRad", "speedMps",
      "roadPitchRad", "roadRollRad", "bodyPitchRad", "bodyRollRad",
      "pitchRad", "rollRad",            // = road + body; what renderers apply
      "wheelSteerRad"?, "wheelSpinRad"? // vehicles only
    },
    "lights": [ { "tick", "light", "mode": "on" | "off" | "flashing" } ],
    "downedSinceTick"?: 201             // knocked off its feet from this tick on
  } ],
  "props": [ { "id", "catalogId", "x", "y", "z", "headingRad", "dims", "scale" } ],
  "signals": { "<signalId>": [ { "tick", "indication" } ] }
}
```

`catalogId`, `actorClass`, `dims` and `color` are bound exactly as
scene-state.v1 `ActorDesc` binds them. `emit_scene_state` and the timeline
share `catalog_id_for` / `actor_class_of`.

### Channel derivations (samplerVersion `simforge.timeline-sampler/1`)

The first four channels are copied from trace v4:

- **x, y** (4 decimals) and **headingRad** (6 decimals).
- **speedMps**: signed longitudinal speed, negative while `motionDirection = -1`.

The remaining channels are derived:

- **z**: `heightSource` at `(x, y)`, 4 decimals.
- **roadPitchRad / roadRollRad** (6 decimals). The surface is probed at
  footprint points, with wheelbase `= max(0.6·l, 0.5)` and track `= 0.85·w`:
  - Four-wheeled vehicles: `pitch = atan((z_rear − z_front) / wheelbase)` and
    `roll = atan((z_left − z_right) / track)`.
  - Two-wheelers: pitch only.
  - Pedestrians and props: `0`.
  - A probe that cannot be resolved contributes `0`.
- **bodyPitchRad / bodyRollRad**, four-wheeled vehicles only. Each is a
  first-order low-pass (τ = 0.15 s at 0.02 s, α = dt/(τ+dt), reset to 0 on
  spawn) applied to:
  - pitch: `clamp(−0.006 · a_long, ±0.05)`, so braking pitches the nose down;
  - roll: `clamp(0.008 · v · yawRate, ±0.05)`, so a left turn puts the right
    side down.

  `a_long` and `yawRate` are backward differences over one tick.
- **pitchRad / rollRad** = road + body.
- **wheelSteerRad** (vehicles): the physics `steerRad` channel when recorded,
  otherwise `atan(wheelbase · yawRate / (sign(v)·max(|v|, 0.5)))`, clamped to
  ±0.7.
- **wheelSpinRad**: `Σ v·dt / 0.35 m` since spawn, unwrapped.

### Lifecycle

`present` is the per-tick truth. `lifecycle` lists the presence intervals
explicitly: `spawnTick` is inclusive and `despawnTick` is the first absent
tick. Validation rejects a lifecycle that disagrees with `present`. A body
is **absent strictly before its spawn tick and at or after its despawn
tick**. Consumers never infer presence from gaps or from missing poses.

### Posture

`downedSinceTick` is optional. It is the first tick at which the body is
knocked off its feet: the trace's `downSinceS`, rounded up to the tick grid.
The state is monotonic, so the body stays down. The sampler reports it as
`downed`, which is true once `i >= downedSinceTick`. A renderer lays the body
prone. The same instant appears in a derived xosc as
`uniscenarios.trajectoryReplay.knockedDownAtS.<actor>`, whose value is the clip-relative `downSinceS` (not shifted by the warm-up).

### Lights

Each actor has a list of changes `{tick, light, mode}` sorted by
`(tick, light)`. A mode is held until the next change. Every light is `off`
before its first change and while the actor is absent.

- `light` ∈ `lowBeam | brake | reverse | indicatorLeft | indicatorRight | emergency`.
- `lowBeam`: the environment default. It is on for vehicles unless
  `timeOfDay` is `day` (`environment.lowBeams`).
- `reverse`: `motionDirection = -1`.
- `brake`: derived. It turns on at ≥ 1.0 m/s² deceleration, holds while
  deceleration ≥ 0.3 m/s² or the body is stopped (< 0.05 m/s), and is
  otherwise off. An authored `lights.brake` cue latches an override until the
  next cue.
- `indicatorLeft/Right`: from `lights.indicator` (`left`, `right`, `hazard`
  = both, `off`) and from `lights.hazard` (bool).
- `emergency`: `flashing` for `lights.emergency` `flashing` or
  `flashing_siren`.
- **Flash phase**: `flashing` is lit while `(t mod 1 s) < 0.5 s`, measured on
  the timeline clock (on at `t = 0`). Every renderer blinks in phase.

### Signals

Per signal id, a list of changes `{tick, indication}` taken from the trace's
`ticks.signals` phases. They are held from the tick floor. The SimForge
signal book is the only signal authority: SUMO signal states are never
merged in.

## 7. The shared sampler: `pose(timeline, actorId, t)`

A single Rust function (`sampler::pose`). Its rules:

1. **Domain.** `t` is clip-relative seconds on `[0, clipEndS]`. Values within
   ±1e-9 of the edges are clamped. Anything else is an error: `OutOfRange` in
   Rust and WASM, `ValueError` in Python. `t` is never wrapped or extrapolated.
2. **Tick.** `i` is the last tick with `t[i] ≤ t`, and
   `f = (t − t[i]) / (t[i+1] − t[i])`.
3. **Presence.** `present[i]` alone decides whether the body exists.
4. **Interpolation.** When the body is present at both `i` and `i+1`, every
   channel is linear.
   - Heading follows the shortest arc: `h[i] + wrap(h[i+1] − h[i]) · f` with
     `wrap` onto `[−π, π)`. The result is not re-wrapped.
   - Pitch and roll are linear.
   - The sampler is **exact at tick times**: `f = 0` returns the stored
     values bit for bit.
5. **Hold before despawn.** When the body is present at `i` and absent at
   `i+1`, the sampler holds tick `i`. It never interpolates toward a
   despawned sample.
6. **Kinematics.**
   - `velocity = speedMps · (cos h, sin h, 0)` at the sampled heading.
   - `acceleration` is the per-tick backward difference of velocity (zero on
     a spawn tick), interpolated linearly.
   - Trig uses the core's portable V8 port (`crate::math`). Every other
     operation is IEEE-exact, so native, WASM and Python produce identical
     bits.

The sampler returns a `TimelinePose` with these fields:
`{present, tick, x, y, z, headingRad, pitchRad, rollRad, speedMps, velocity[3], acceleration[3], roadPitchRad, roadRollRad, bodyPitchRad, bodyRollRad, wheelSteerRad?, wheelSpinRad?, downed}`.
Bindings also expose a flat, lossless encoding of 20 f64 values:
`[present, x, y, z, h, p, r, speed, vx, vy, vz, ax, ay, az, roadP, roadR, bodyP, bodyR, steer|NaN, spin|NaN]`.

The companions follow the same domain rules:

- `poses(tl, t)` returns every actor, sorted by id.
- `signals_at(tl, t)` returns `{id: indication}`.
- `lights_at(tl, id, t)` returns resolved booleans.
- `light_modes_at(tl, id, t)` returns raw modes.

### Binding API

| | Rust | WASM (`RenderTimeline`) | Python (`simforge_oss_timeline`) |
|---|---|---|---|
| load | `RenderTimeline::from_json_slice` (gzip ok) | `RenderTimeline.fromBytes(u8)` | `Timeline.from_json(bytes\|str)`, `Timeline.load(path)` |
| build | `build_render_timeline(&trace, &height, catalog)` | `build(trace, xodr, topology, catalog?)`, `buildFlat`, `buildPlane` | `build_timeline(trace, xodr=, topology=, catalog_digest=, flat_z=, plane=)` → JSON |
| pose | `sampler::pose` | `poseArray`, `poseJson`, `posesArray` | `pose(tl, id, t)`, `tl.pose`, `tl.pose_array`, `tl.poses` |
| lights/signals | `sampler::{lights_at, signals_at}` | `lightsAtJson`, `signalsAtJson` | `tl.lights_at`, `tl.light_modes_at`, `tl.signals_at` |
| identity | `timeline_key`, `RenderTimeline::sha256` | `key`, `sha256`, `traceSha256` | `timeline_key`, `trace_sha256`, `tl.key`, `tl.sha256` |

## 8. Renderer obligations and parity

| Level | Guarantee | Gate |
|---|---|---|
| Sampler across bindings | bit-identical | binding identity corpus (Rust vs WASM vs Python) |
| Bevy observed transforms vs sampler | ≤ 1e-3 m, ≤ 0.05° | `simforge render parity` on `observed-frames.jsonl` |
| CARLA observed transforms vs sampler (trace replay) | ≤ 1 cm, ≤ 0.1° | same comparator, CARLA tolerance profile |
| Pixels | never an identity | per-GPU goldens only |

- **Bevy.** Loads the timeline and samples it at the exact µs frame times.
  - It sends `load_scene_state` frames built from `scene_yup(pose)`, with the
    baked `z` as scene `y` and `groundY: 0`, so the baked height is
    authoritative even at `z = 0`.
  - The native service currently applies yaw only; applying road/body
    pitch/roll is a follow-up.
  - xosc lowering remains only as a clearly marked fallback for execution
    packages that carry no timeline.
- **CARLA** (trace replay):
  - Spawn at the sampled pose with physics off before the first tick.
  - Call `set_transform` per tick from the sampler, and set lights and
    signals from the timeline.
  - Use the timeline time origin.
  - Physics runs only in the labelled "physics validation" mode, which is
    never shown as the scenario's render.
- **Editor.** Samples the same timeline through WASM. A local preview trace
  and the worker trace are compared by `traceSha256`.

### Parity report (`simforge.render-parity/v1`)

`compare_observed_jsonl(timeline, observedJsonl, profile)` reads one JSON
record per rendered frame:
`{"t" | "time", "actors": [{"id", "position": [3], "rotation"?: [x,y,z,w], "headingRad"?, "pitchRad"?, "rollRad"?, "visible"?}]}`.
It samples the timeline at each record's own `t`. For every drawn body it
reports:

- position error: horizontal, vertical and 3D;
- heading error, plus pitch and roll errors when the profile compares
  attitude;
- presence mismatches: bodies drawn but absent from the timeline, and bodies
  present in the timeline but not drawn.

The report also carries p95s, the ten worst observations, per-actor maxima,
and `pass`.

Profiles:

- `bevy`: scene-yup quaternions, ground-contact roots, 1e-3 m / 0.05°.
- `carla`: `xodr-local` with OSC `h/p/r`, 1 cm / 0.1°.
- A JSON profile can override the tolerance, the frame, the height reference
  (`ground` | `body-centre`) and `compareAttitude`.

A failing report fails the render. `simforge render parity` exits 2 on
failure.

### Tooling

```sh
simforge render timeline trace.json.gz --map <mapId> --out scenario.timeline.json   # prints the key and digests
simforge render sample scenario.timeline.json --t 3.04 [--actor <id>]
simforge render parity scenario.timeline.json observed-frames.jsonl --profile bevy
```

The native render engine uses the timeline when a job carries the
`render.timeline` input. That input holds the canonical bytes, and their
sha256 must equal `timelineSha256`. The engine records
`sceneSource: "render-timeline"` and `timelineSha256` in its manifest and
diagnostics. Without that input it falls back to re-lowering the xosc,
records `sceneSource: "openscenario-legacy"`, and adds the warning
`scene_source_openscenario_legacy`.

## 9. Compatibility and versioning

- The document version is `simforge.render-timeline.v1`. Unknown versions and
  unknown `samplerVersion`s are rejected. There is no silent fallback.
- **Additive, optional fields.** Consumers must tolerate unknown fields. A
  new optional channel does not bump the version. A change in how a channel
  is **derived or sampled** bumps `samplerVersion`.
- scene-state.v1 stays frozen. It is a projection of the timeline
  (`sampler::scene_yup` plus the lifecycle), not a second source.
