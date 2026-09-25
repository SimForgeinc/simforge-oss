# World session

Command-driven worlds over the fixed-step engine: runtime spawn/despawn,
atomic batches, per-actor action and driver overrides, a replayable command
log with a deterministic digest, checkpoints, and bounded truth
subscriptions. Source of truth: `native/crates/simforge-session/src/world.rs`
(`WorldSession`, `WorldCommand`, `WorldSessionLog`,
`replay_world_session_log`). Python surface: `simforge_oss_gym.world`
(`SimForgeWorld`, `TruthStream`) in `adapters/gym`.

## Modes

- **clip** (default): the authored finite-trace behaviour. The world has a
  horizon (`horizon_seconds`, default 120 s); a structural command rebuilds
  the simulation from the new canonical input and re-advances to the current
  tick. `done` worlds accept commands but time no longer advances.
- **live**: structural commands use the engine's incremental actor mutation
  surface. Incumbent runtime state is untouched, the clip never ends, and
  per-tick trace history is not retained.

In either mode the canonical input and the ordered command log are the
deterministic replay artifact.

## Model: world state is a function of the input and the command log

Actors are authored in `SimScenarioInput`; mid-clip presence is expressed
with `presentAtStart: false` plus `exist` interactions. A structural command
(spawn/despawn/batch) produces a **candidate input**: new actor specs plus
`exist` interactions anchored at the current tick boundary. The candidate is
validated through engine entry points only, then committed atomically.

Nothing in the engine is forked. The entry points used:

| Concern | Engine surface |
|---|---|
| Actor kind + dims | `ActorKind::default_dims` |
| Ground snap | `LaneGraph::nearest_lane` → `nominal_reversed` → `sample_directed` (lane tangent heading) |
| Pose validation | `check_feasibility` (routes, lanes, t=0 guards) + `obb_overlap` against the **current** snapshot (feasibility only covers t = 0 placement) |
| Presence | `exist` interactions; spawn/despawn events land in the trace/event stream as usual |
| Actions | zero-order-hold action timeline per actor |

## Commands

`WorldCommand` (`{"kind": ...}`):

| kind | effect |
|---|---|
| `spawn` | add an actor (`SpawnRequest`) |
| `despawn` | remove a present actor |
| `batch` | atomic list of spawn/despawn ops |
| `act` | zero-order-hold `ActionOverride` for one actor; `null` releases it |
| `driverCommand` | a live driver's pedals and wheel for one actor, held until replaced; `null` hands the actor back to its scenario controller |

`SpawnRequest` needs only `kind` and a scene-frame `pose`; defaults are
engine-derived: dims from the kind, lane snap for road kinds (nearest
drivable lane within 25 m; no lane is a rejection), heading from the snapped
lane tangent, a `follow` route from the snapped lane (non-road kinds hold
position on a zero-length `polyline`). Allocated actor ids are `ws:NNNN`,
monotonic per world, committed only when the command commits, so ids are
stable under replay and a rejected batch consumes nothing.

A `batch` is atomic: every op is resolved and validated against the same
candidate (spawns see earlier in-batch spawns for overlap and despawns for
liveness); the first invalid op rejects the whole batch and the world stays
byte-identical (digest included). Rejection reasons: unknown kind, id in use,
no lane in snap reach, OBB overlap with a present actor at the current tick,
despawn of a non-present actor, schema parse failure, or an error-severity
`check_feasibility` issue attributable to the batch's actors.

Despawn adds an `exist(absent)` interaction at the boundary: the engine flips
`present`, emits a `despawn` event (reason `interaction`), and every frame of
the trace/digest carries the presence truth.

## Multiple clients

`apply_command(client_id, seq, command)` applies one command at the current
tick boundary and records it; `advance(ticks)` moves time. Ordering across
clients is the host's contract: a multi-client host queues commands and, at
each tick boundary, applies them in **client id ascending, then per-client
seq ascending** order, with exactly one client owning `advance`. Per-command
outcomes (including rejections) are recorded in the log in applied order. A
host that exposes worlds over a network wire (the hosted app does) enforces
the roles and ordering on top of this API.

## Determinism, digest, replay

Every engine tick at `t >= 0` is hashed: chained SHA-256 over canonical,
id-sorted actor rows, seeded with the base-input content hash. Catch-up ticks
replayed during a clip-mode rebuild are **not** re-hashed: the digest covers
frames as first observed, and a replay rebuilds at the same boundaries, so
the hashed frame sequence is identical by construction.

The session log is the artifact (`WorldSessionLog`, version 2):
`baseInputHash` (content hash of the normalized base input), `mode`,
`horizonSeconds`, the ordered entries (commands with client id, seq and
recorded outcome, including rejections, interleaved with `advance` entries),
and the digest. `replay_world_session_log(log, input, run_options)`
(`SimForgeWorld.replay()` in Python) re-executes the log against the same
base input and returns the digest plus an outcome-match verdict and the
first divergent entry; the determinism contract is
`replayed.digest == log.digest` with every outcome reproduced.

`checkpoint()` / `restore()` capture and resume the complete continuation
state of a world, including live structural edits.

## Truth subscriptions

`subscribe_truth(capacity)` (`SimForgeWorld.subscribe()`) returns a bounded,
drop-oldest subscriber (default capacity 256 frames) that receives every
committed tick as a scene-state frame. Readers pull (`drain()`); `dropped`
counts frames lost to a slow reader. Subscribers never affect stepping or the
digest.
