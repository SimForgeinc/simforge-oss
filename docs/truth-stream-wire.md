# World-session truth stream wire

Status: **frozen**. Downstream V2X consumers may depend on the field names, coordinate frames, framing, and ordering below. This is the SimForge world-session truth side-channel; it is not the V2X product WebSocket protocol.

## Transport framing

Each committed engine tick is one frame:

```text
+----------------------+----------------------------------+
| payloadBytes: u32 LE | msgpack(TruthFrame)              |
+----------------------+----------------------------------+
        4 bytes                    payloadBytes
```

`payloadBytes` counts only the MessagePack payload (named fields, `rmp_serde::to_vec_named`). The engine owns the bytes: `TruthSubscriber::drain_framed` in `native/crates/simforge-bindings-common/src/runtime/world.rs` (Python: `TruthSubscription.drain_frames()`) returns complete framed messages, and hosts forward them without re-encoding. A transport may split or coalesce these bytes arbitrarily; a client reassembles frames from the length prefix. There is no JSON envelope, operation discriminator, sequence wrapper, or server-side pixel payload.

## Frozen `TruthFrame` schema

Rust source: `TruthFrame` in `native/crates/simforge-session/src/world.rs`. Shape (camelCase on the wire):

```ts
interface TruthFrame {
  tick: number;
  timeSec: number;
  scene: SceneFrame; // frozen scene-state.v1 frame
  signals: SignalSnapshot[];
  actors: Array<{
    id: string;
    class: 'car' | 'truck' | 'bus' | 'motorcycle' | 'bicycle' | 'pedestrian' | 'prop';
    dims: { l: number; w: number; h: number };
    accel: { ax: number; ay: number };
    telemetry?: VehicleTelemetry;
    contact?: { z: number; pitchRad: number; rollRad: number; wheelDropM: [number, number, number, number] };
  }>;
}
```

No field is optional except the two additive per-actor records: `telemetry` (absent for bodies the motion backend does not own) and `contact`.

`actors[].contact` is the engine's ground contact for the body on this tick (engine 0.11, [ground-height.md](engineering/ground-height.md)): `z` is the contact elevation at the footprint centre, the bottom of the body, in metres (XODR-local z, i.e. scene y), `pitchRad`/`rollRad` the road attitude under it and `wheelDropM` the per-wheel drop `[FL, FR, RL, RR]`. It is present exactly when the world simulates on a ground surface (a map version published with its ground derivative) and the actor is present, and absent otherwise; it is never defaulted. Because the scene frame's `groundY` is always 0, it is the only height a client may draw a body at.

### Top-level fields

| Field | Meaning |
| --- | --- |
| `tick` | Authoritative engine tick index. It includes engine warm-up in the same way as the engine's tick observation index; a subscription does not renumber it. |
| `timeSec` | Authoritative simulation time in seconds for `tick`, quantized to six decimal places. No wall-clock value is emitted. |
| `scene` | One unmodified `simforge.scene-state.v1` `SceneFrame`: `{tick, t, actors}`. `scene.tick === tick` and `scene.t === timeSec`. |
| `signals` | Full signal-snapshot projection at `t` for every signal program, ordered by `signalId`. It includes physical head/controller/junction identity, phase, timing source, phase boundaries, remaining ticks, next phase, cycle length, and any failure state. |
| `actors` | Per-record static identity/dimensions plus acceleration. Entries have the same actor-id order and membership as `scene.actors`. |

### Scene frame

`scene` uses the frozen scene-state.v1 y-up frame:

```ts
interface SceneFrame {
  tick: number;
  t: number;
  actors: Array<{
    id: string;
    kind: 'spawn' | 'update' | 'despawn';
    position: [x, groundY, z];
    rotation: [x, y, z, w];
    yawRad: number;
    velocity: [vx, vy, vz];
    acceleration: [ax, ay, az];
  }>;
}
```

Positions and vectors convert the engine's XODR-local ground plane as scene `x = local x`, scene `z = -local y`, with `groundY = 0`. Every present actor appears on every tick. The first present observation is `spawn`, continued presence is `update`, and the present-to-absent transition is `despawn` with its terminal transform. Actors absent both before and after the tick do not appear. Actor records are ordered by stable actor id.

`actors[].class` is the scene-state render class derived from the authored actor kind. `actors[].dims` is the actor's static `{l,w,h}` catalog/spawn dimension record in metres; it is not inferred from a mesh.

Acceleration is a backward velocity difference, not a wall-clock estimate and not a renderer estimate. For actor $i$ on tick $n$ in the XODR-local ground plane,

$$
(a_x,a_y)_{i,n} = \frac{(v_x,v_y)_{i,n} - (v_x,v_y)_{i,n-1}}{\Delta t}.
$$

A spawn has zero acceleration because it has no continuous prior sample. History is discarded on despawn. `actors[].accel` carries the XODR-local `(ax, ay)` pair. `scene.actors[].acceleration` carries the same value converted to scene y-up coordinates as `[ax, 0, -ay]`. Numeric scene and acceleration values are quantized to six decimal places before encoding.

## Ordering and atomicity

A world command batch commits at a tick boundary before advancement. For every subsequent engine tick, the world session obtains one immutable engine observation, composes scene actors, signal snapshots, actor metadata, and acceleration from that same observation/time, encodes the complete `TruthFrame` once, and only then enqueues the same framed bytes to all subscribers. A consumer can therefore never observe tick-$n$ actor state with tick-$n\pm1$ signals. Truth publication is observational and does not change engine order, session logs, or digests.

Frames within a subscription are in increasing committed-tick order except for explicitly accounted drops. Two subscribers active for the same ticks receive byte-identical frames. Identical scenario input and command/advance history produce byte-identical framed streams.

A subscription starts with the next committed tick; it does not replay history. That tick contains every currently present actor and therefore a complete authoritative pose/velocity set. Unsubscribing discards that subscriber's pending queue and has no world-side effect.

## Backpressure

`WorldSession::subscribe_truth(capacity)` (Python: `SimForgeWorld.subscribe(capacity)`) returns a pull-based `TruthSubscription`. The default capacity is 256 complete frames. Capacity is a positive integer and is fixed for the subscription.

The engine tick path never calls consumer code and never waits for transport I/O. It only enqueues the already built immutable frame (shared, never copied per subscriber). When a queue is full, enqueue discards the **oldest** pending frame and increments that subscription's cumulative drop counter. `subscription.stats()` returns exactly `{ queued, dropped }` (`TruthSubscriptionStats`).

`dropped` never decreases during the subscription. `read()` removes the oldest complete frame or returns `None`; draining removes all queued frames in tick order. The drop counter is subscription-local and deliberately is not added to `TruthFrame`, preserving byte identity across concurrent subscribers. A transport adapter must expose or monitor this counter as its explicit loss accounting; it must not stall world advancement to recover a dropped frame.
