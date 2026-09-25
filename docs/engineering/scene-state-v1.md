# simforge.scene-state.v1 — scene description contract

Status: v1 frozen; version tag `simforge.scene-state.v1` (the bare `scene-state.v1` tag is no longer emitted or accepted). One schema for both ingestion modes:
**trace playback** (`trace.json.gz` → per-tick transforms, dataset
generation) and **live** (per-tick frames from a world session, closed
loop). Wire formats: JSON (files, hashing) and msgpack (streams, e.g. the
[truth stream](../truth-stream-wire.md)); the field names are identical in
both.

- Schema and emitters: `native/crates/simforge-core/src/trace/scene_state.rs`
  (`emit_scene_state` for a finished trace, `SceneStateStream` per tick for
  live mode)
- Renderer consumer types: `renderer/render-core/src/scene_state.rs`

## Document

| field | type | notes |
|---|---|---|
| `version` | `"simforge.scene-state.v1"` | literal |
| `mapId` | string | e.g. `yale-street` |
| `frame` | `"scene-yup"` | y-up scene frame |
| `dt` / `tickHz` / `tickCount` | number | playback cadence |
| `weather` | `{preset: clear\|fog\|rain\|night, fogDensity, rainIntensity, wetness}` | drives the renderer's weather ladder |
| `timeOfDay` | number | hours [0, 24) |
| `profile` | `sensor \| cinematic` | render profile intent (default `sensor`) |
| `groundY` | number \| null | road-surface elevation hint when known |
| `actors` | `ActorDesc[]` | static identity/geometry bindings |
| `frames` | `Frame[]` | per-tick records |

## ActorDesc

`{id, catalogId, actorClass, dims?, color?}` — `catalogId` is a prop-catalog
entry (`vehicle.sedan`, `pedestrian.adult`, …). Traces tag actors with
`catalog:<id>`; untagged actors get deterministic class defaults
(`catalog_id_for`) so every renderer binds identical geometry.

## Frame / actor tick record

```
{tick: u32, t: f64, actors: [{
  id, kind: spawn|update|despawn,
  position: [x, groundY?, z],        // f32 metres
  rotation: [qx, qy, qz, qw],        // yaw about +Y expanded to quaternion
  yawRad,                            // redundant exact heading
  velocity: [vx, vy, vz],            // m/s world frame = speed × heading
  acceleration?: [ax, ay, az],       // m/s² world frame (see below)
}]}
```

### Acceleration

`acceleration` is an **additive optional** field; the schema remains
`simforge.scene-state.v1`. Both emitters (trace playback and the live
`SceneStateStream`) compute it as the backward finite difference of the
velocity channel over one `dt`, so it carries the centripetal term when a
body turns. First samples and fresh spawns report `[0, 0, 0]` (zero, not
unknown), and a re-entering body never inherits velocity history.

Consumers MUST tolerate its absence on older documents; emitters that can
compute it include it on every record.

### Frame conventions

Frame conventions (`to_scene_xz` in `native/crates/simforge-core/src/math.rs`):
`scene = (x_local, height, −y_local)`; headings are numerically identical.
Velocity is the engine's integrated forward-speed × heading vector, **not** a
finite difference, so motion-vector ground truth matches solver state.

### Spawn/despawn semantics

Derived from the trace `present` channel transitions (0/1 or bool):

- first tick present after absent/never-present → `spawn`
- last tick present before absent → `despawn` (carries the final pose;
  consumers remove the instance after applying it)
- otherwise → `update`

An actor that never despawns emits exactly one leading `spawn`.

## Determinism notes

Emitted floats are quantised to 6 decimals; actor ids are sorted; the same
trace bytes always produce the same document bytes (JSON key order follows the
schema declaration order).
