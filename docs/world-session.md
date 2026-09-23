# World-Session Server v1

Multi-client world sessions over the fixed-step engine: arbitrary runtime
spawn/despawn, atomic batches, single tick ownership, and log-replay
determinism. Lives in `packages/training-env` (`world-session.ts`,
`session-registry.ts`); reachable over the env-server wire as the `world.*`
op family through the extension seam (`EnvServer.registerOp`).

## Model: world state is a pure function of the command log

The engine has no runtime-mutation surface — actors are authored in
`SimScenarioInput`, and mid-clip presence is expressed with
`presentAtStart: false` plus `exist` interactions. A `WorldSession` therefore
treats the canonical input as its only mutable state:

1. A structural command (spawn/despawn/batch) produces a **candidate input**:
   new actor specs plus `exist` interactions anchored `at` the current tick
   boundary time.
2. The candidate is validated through engine entry points only (see below).
3. On acceptance the session swaps the canonical input and **rebuilds** the
   simulation from `t = -warmup`, re-advancing to the current tick. The engine
   is deterministic, so every pre-existing actor reproduces its exact state —
   guarded by the bit-identity test in `world-session.test.ts`.

Nothing in the engine is forked. The entry points used:

| Concern | Engine surface |
|---|---|
| Actor kind catalog + dims | `ACTOR_KINDS`, `DEFAULT_ACTOR_DIMS`, `parseSimScenarioInput` |
| Ground snap | `LaneGraph.nearestLane` → `nominalReversed` → `sampleDirected` (lane tangent heading) |
| Pose validation | `checkFeasibility` (routes, lanes, t=0 guards) + `obbOverlap` against the **current** snapshot (feasibility only covers t = 0 placement) |
| Presence | `exist` interactions; spawn/despawn events land in the trace/event stream as usual |
| Actions | `ActionHook` (zero-order-hold timeline per actor) |

## Roles

| Role | Rights |
|---|---|
| `tick-owner` | everything below, **plus** `advance` — exactly one per world |
| `actor-controller` | queue commands: `spawn`, `despawn`, `batch`, `act` |
| `observer` | read-only: `snapshot`, `log` |

Tick ownership: the world's creator takes it by default; a second `join` as
`tick-owner` is refused; the owner leaving vacates ownership (time halts) and
any remaining member may `claim` it.

## Ordering

No command mutates the world at submission time — **every** command queues,
including the tick-owner's own. The owner's `advance` defines the tick
boundary: the queue is drained and applied in **client id ascending, then
per-client seq ascending** order (client ids are registry-allocated and
zero-padded, so lexicographic = allocation order). Then the engine advances
the requested ticks. Per-command outcomes come back on the advance result in
applied order; rejected commands are recorded too.

## Spawn / despawn / batch

`SpawnRequest` needs only `kind` and a scene-frame `pose`; defaults are
engine-derived: dims from `DEFAULT_ACTOR_DIMS`, lane snap for road kinds
(nearest drivable lane within 25 m — no lane is a rejection), heading from the
snapped lane tangent, a `follow` route from the snapped lane (non-road kinds
hold position on a zero-length `polyline`). Allocated actor ids are `ws:NNNN`,
monotonic per world, committed only when the command commits — so ids are
stable under replay and a rejected batch consumes nothing.

A `batch` is atomic: every op is resolved and validated against the same
candidate (spawns see earlier in-batch spawns for overlap and despawns for
liveness); the first invalid op rejects the whole batch and the world stays
byte-identical (digest included). Rejection reasons: unknown kind, id in use,
no lane in snap reach, OBB overlap with a present actor at the current tick,
despawn of a non-present actor, schema parse failure, or an error-severity
`checkFeasibility` issue attributable to the batch's actors.

Despawn adds an `exist(absent)` interaction at the boundary: the engine flips
`present`, emits a `despawn` event (reason `interaction`), and every frame of
the trace/digest carries the presence truth.

## Determinism, digest, replay

Every live engine tick at `tS >= 0` is hashed: chained SHA-256 (engine
`sha256`/`canonicalJson`) over `[tickIndex, tS, rows]` with actor rows sorted
by id, seeded with the base-input content hash. Catch-up ticks replayed
during a rebuild are **not** re-hashed — the digest covers frames as first
observed, and a replay rebuilds at the same boundaries, so the hashed frame
sequence is identical by construction.

The session log is the artifact (`WorldSessionLog`, version 1):
`baseInputHash` (content hash of the normalized base input), `horizonSeconds`,
the ordered entries (commands with client id, seq and recorded outcome —
including rejections — interleaved with `advance` entries), and the digest.
`replayWorldSessionLog(log, {input, graph})` re-executes the log against the
same base input and returns the digest plus outcome-match verdict; the
determinism contract is `replayed.digest === log.digest`.

## Wire ops (`world.*`)

Registered via `registerWorldOps(server, episodes)` on the env-server
extension seam. Compact keys per wire convention (`w` world, `c` client,
`n` ticks):

| Op | Request | Reply |
|---|---|---|
| `world.create` | `e?` episode, `horizonS?`, `role?` | `{worldId, clientId, role}` |
| `world.join` | `w`, `role?` (default observer) | `{clientId, role}` |
| `world.leave` | `w`, `c` | `{left: true}` |
| `world.claim` | `w`, `c` | `{tickOwner: true}` |
| `world.cmd` | `w`, `c`, `cmd` (WorldCommand) | `{seq}` |
| `world.advance` | `w`, `c`, `n?` (default 1) | `{tS, tick, done, events, actors, results}` |
| `world.snapshot` | `w`, `c` | `WorldSnapshot` |
| `world.log` | `w`, `c` | `WorldSessionLog` |

Handler throws surface as the standard `{ok: 0, e}` reply; payloads are
zod-validated at the boundary.

## Known v1 limits

- Structural commands rebuild + replay the engine (O(elapsed ticks) each).
  Fine for training-scale sessions; a checkpoint/restore engine seam would
  remove the replay cost if it ever dominates.
- A spawned-then-not-yet-advanced actor is not yet `present`, so it cannot be
  despawned at the same boundary by a *later separate command* (in-batch
  spawn+despawn works).
- The world horizon (`horizonSeconds`, default 120 s) fixes the engine clip
  at construction; `done` worlds accept commands but time no longer advances.

## Renderer adapter snapshot

The training environment also exposes a read-only `EnvSession.snapshot()`
after `reset()`. It returns the current simulation time, completion flag, and
actor snapshots without advancing the world or mutating policy-visible state.
Renderer and closed-loop driver adapters may use it to synchronize a frame
bundle with the just-completed policy step. The policy still receives only the
configured observation channels; actor snapshots remain an adapter/ground-truth
surface.

## Kernel `Episode` (rc70)

`simforge_session::Episode` is the closed-loop tick owner over `EnvSession`,
`PolicyExecutor` and the existing `reward.rs` authority. It is available as
`simforge_oss_gym.native.Episode` (also exported from `simforge_oss_gym`) and
`native().Episode` from `@simforge-oss/native-runtime`. The new APIs are additive:
the existing EnvSession, PolicySession and SessionBatch surfaces remain available.
Gym `0.1.0rc70` and native-runtime `0.1.0-rc.70` add this capability without
changing binding ABI 3. Do not replace an installed rc61 trainer wheel in place.
The drive and campaign runners use this Episode for world advancement and
evidence; the renderer is a sensor provider, never a second policy/tick owner.

Rust construction takes `EpisodeSpec { scenario, topology: RunOptions, options:
EpisodeOptions }`; topology includes the resolved graph and static colliders.
Both host bindings accept `Episode(spec_json, graph)`, where `graph` is their
existing `LaneGraph` handle and the spec JSON is:

```jsonc
{
  "scenario": { /* SimScenarioInput, including clipSeconds and mapId */ },
  "seed": 42,
  "decisionHz": 10,
  "mode": { "kind": "offline-simtime" },
  "warmupDecisions": 0,
  "maxDecisions": 300,
  "observation": { "channels": [{ "kind": "state" }] }
}
```

`decisionHz` must divide 50. `maxDecisions` is optional and counts **policy**
decisions only. The scenario's `clipSeconds` is the total world-time horizon,
including explicit warm-up decisions; provide enough clip time for both. The
authored negative-time prologue is consumed by EnvSession as before. Rust `seed`
is an unsigned 64-bit identity; dynamics retain numeric-seed low-32-bit semantics
without an intermediate lossy float. Host bindings additionally normalize string
and negative numeric seeds through the existing engine UTF-16/absolute-value RNG
rules; campaign summaries retain the user's raw seed.

An optional `warmupActions` array supplies exactly `warmupDecisions` compact
reference actions, with `warmupPolicy` as their trace label. Omitted schedules
use authored choreography; all advancement and rendering still happen inside
`reset()`. `execution` is `"pure-pursuit"` (default) or the existing
`"speed-setpoint"` trajectory reduction. New default options are omitted from
serialization so pre-camera state-only v2 identities remain unchanged.
The final explicit warm-up action remains the hold-last fallback and retains a
trajectory's issuance anchor. Authored warm-up has no explicit last action, so
a miss before the first policy command still falls back to scripted driving.

| Operation | Contract |
|---|---|
| `reset(onFrame?)` | Rebuild the same seeded world, clear trace/follower/fallback state, execute the kernel-owned warm-up schedule, return the selected observation. Warm-up rows carry `phase:"warmup"`, `pol:"warmup:<warmupPolicy>"` (`scripted` by default). If warm-up terminates, `ended` is true and `finish()` is partial. |
| `step(action_json)` | Apply one decision, returning JSON `{obs,reward,rewardTerms,terminated,truncated,termReason,events,dl,ex,appliedControl,envelope}`. Rust accepts `EpisodeAction` and returns a borrowed `EpisodeStep`. |
| `snapshot()` | JSON adapter/ground-truth `{tS,done,egoId,actors:[{id,kind,dims,state}]}`; never implicitly supplied to policies. |
| `trace_json()` / `traceJson()` | Current JSONL evidence, including reset and warm-up. A final summary is added only by `finish()`. |
| `trace_digest()` / `traceDigest()` | Chained deterministic evidence digest. State-only runs match across bindings; camera runs retain their actual frame hashes, including measured renderer nondeterminism. |
| `finish()` | Idempotently seal evidence, refuse later stepping, return `simforge.episode-result-core/v1`. Finishing before a world/budget boundary is explicitly `partial`, `truncation: "caller_finished"`. |
| `frame(id)` | Native `FrameRef` lease over the current camera ring payload. Python `.buffer()` returns a read-only zero-copy NumPy byte view; Node `.buffer()` returns a zero-copy Buffer. Call `.release()` before advancing/resetting. |
| `scene_state_json()` / `sceneStateJson()` | Last exact kernel-authored `simforge.scene-state.v1` document; absent without cameras. This is adapter evidence, not policy input. |
| `close()` | Release camera leases and close the renderer transport. Call `finish()` separately to seal evidence. |

Bindings return JSON strings so both languages use exactly the same Rust codec.
`ego` and `ended` are read-only properties. Result core carries status,
truncation/reason, timing mode, wall/simulation durations, policy and warm-up
decision counts, deadline misses and the episode digest. `modelHealth` is
explicitly null: the TS manifest writer still owns artifact inventory, scoring,
model-health evidence and atomic `simforge.eval-result-manifest/v1` publication.
A result core alone is not a promotion receipt.

`appliedControl` is null without a physical actor; otherwise it contains
`{throttle,brake,steer,handbrake}` from the **final physics substep**, after
setpoint tracking and the physical jerk envelope. Steering is the actuator
input, not the lagged wheel angle. This evidence is also in every v2 decision
row and supplies real teacher-control labels; it is not an observation feature.

### Barrier, actions and channels

Offline mode has no deadline: world time cannot advance while inference is
pending, `dl.el`/`dl.lim` are null, and `dl.miss` is zero. Realtime is
`{kind:"realtime",deadlineMs:100,fallback:"zero-control"|"hold-last"|"scripted"}`.
The kernel measures monotonic elapsed wall time from observation delivery to
the next `step`, plus the camera-render duration that produced that observation;
binding serialization is excluded. Render time never affects offline `dl`.
Strictly `elapsed >
deadline` misses; equality is on time. It applies one fallback decision, not
unbounded catch-up ticks. `dl` uses the policy-step fields `lim`, `el`, `miss`,
`ap`; hold-last reports `ap:"repeat-last"` and degrades to scripted before any
applied action. Zero control coasts with centered steering, not braking;
`scripted` applies authored choreography for the missed decision.

The action wire is `{k:"c",c:[throttle,brake,steer]}`,
`{k:"t",p:[[x,y,heading,speed,t],...]}` from [policy-step](policy-step.md), or
`{k:"s",speedMps?,accelerationMps2?,previewPoint?:{x,y},previewHeadingRad?,motionDirection?}`
for native route-following setpoints. Preview coordinates are world-frame metres;
optional motion direction is `"forward"` or `"reverse"`.
Trajectory samples are finite, strictly future and strictly time-ordered
(at least two); byte-identical held plans retain their issuance anchor and
are re-tracked from each live pose by the existing pure-pursuit follower.
Negative trajectory/setpoint speed selects reverse. Empty setpoints and
out-of-range controls are rejected.

Channels are explicit tagged objects:

- `{kind:"state"}`: unchanged privileged 10-element native state vector.
- `{kind:"objects"}`: native perceived object rows (actor handles).
- `{kind:"signals"}`: native observed signal approaches, phase and countdown.
- `{kind:"visible"}`: LOS-gated state/objects plus signals; may not be mixed
  with privileged state, objects or BEV channels.
- `{kind:"bev",h:200,w:160,resolutionM:0.25}`: native three-channel BEV,
  square cells, 80% of rows forward/20% backward. Resolution defaults to 0.25 m.
- `{kind:"cameras",rig:{cameras:[CameraSpec,...]},passes:["rgb"],backend:...}`:
  synchronous resident camera frames from the kernel's post-step actor state.
  `CameraSpec` is the drive profile registry shape: `sensorId`, `cameraId`,
  `fwd/left/up`, `yawDeg`, optional `pitchDeg`, horizontal `hfov`, `width/height`.
  Passes are `"rgb"`, `"depth"` (raw reverse-Z float32), or `"seg"` (semantic RGBA).
  Backend is `{kind:"service",socket:"/path/to/dedicated.sock"}` or
  `{kind:"embedded",scene:SceneSpec,library?:"/path/libsimforge_render.so",shmSizeBytes?:268435456}`.
  Embedded dynamically loads the existing renderer FFI on its own resident
  thread; service uses the existing protocol-5 MessagePack socket and shm ring.
  Browser/wasm32 builds reject resident cameras explicitly. The service backend
  currently requires Unix sockets; Windows named-pipe transport is not enabled.

Unrequested channels are absent, not synthetic or ground-truth substitutes.
`observation.objectListRangeM` defaults to 60 m. Camera observations contain
`{sensorId,pass,width,height,frame:{id,tick,format,rowStride,digest,sha256,shm,offset,len}}`.
The frame offset points to the payload, **not** its 128-byte ring header.
Both CRC32 `digest` and SHA-256 `sha256` cover the complete row-padded payload.
Views are borrowed, not copies: never read or write one after `release()`.
Claimed live leases refuse the next step/reset **before world advancement**.
The renderer ring must hold two complete bundles; the service socket must have
one dedicated Episode owner (a startup readiness client must disconnect first).
Unclaimed frames expire at the next advance. `close()` invalidates all leases;
exported arrays/Buffers keep the mapping allocation alive, not the pixels.

`reset(onFrame)` optionally calls a synchronous host callback for the initial
observation and every real warm-up decision. Arguments are
`payloadJson: {phase,observation,snapshot}` and `FrameRef[]`, ordered like
`observation.cameras`. Consume/release these handles directly; do not re-enter
the mutably borrowed Episode from the callback. The final reset observation has
renewed handles over the same last pixels, without rendering again. Callbacks
also work without cameras (`FrameRef[]` is empty). Image histories and durable
PNG output must explicitly copy if retained after lease release.

`bevy_sensors.BevySensorRig(episode).frames(observation)` only constructs NumPy
views; it has no renderer, scene provider or independent render loop. MuJoCo
uses the separate renderer-only `simforge_native.embedded_sensors.ExternalSensorRig`
because its full-body physics truth belongs to that external solver.

An optional resolved `replayContext` has `sceneId`, input `digest`, `qualified`,
optional `stockReplayPassed`, `lateralM`, `longitudinalS`, `headingRad`, and
`recordedPath: [[tS,x,y,headingRad],...]`. Asset loading must verify the bundle
digest before supplying it. Kernel admission refuses unqualified/failed
stock replay; every decision projects to the recorded polyline and checks
lateral, longitudinal, heading and time support. A breach is
`termReason: "envelope_exceeded"`, truncated and partial, never a valid success.
`replayContext.measureOnly:true` is the explicit G5 stock-replay qualification
mode: it admits unqualified contexts and records every envelope measurement,
but does not enforce a breach. It is not a qualified-policy evaluation or an
implicit weakening of ordinary replay-context admission.

### Trace v2 and legacy conversion

The old bench used SHA-256 of previous hex digest plus insertion-ordered
JavaScript JSON (including latency); the Python runner used cumulative SHA-256
over sorted Python JSON without timing. They were already different formats.
Episode therefore declares **`simforge.episode-trace/v2`** in `reset.schema`:

1. Start with the empty previous digest.
2. For every reset/decision row, remove top-level `digest` and `timing`, and
   set `dl.el` to null when `dl` exists.
3. Hash `previous_hex_digest + canonical_json(row)` as UTF-8. Canonical JSON
   is the engine's existing ECMAScript-number / UTF-16-key-order serializer.
4. Store the resulting lowercase digest in the row. The terminal
   `{episode_digest,summary}` is a completion record, not an additional hash
   input. Wall-clock latency remains in `dl.el` and `timing.infer_ms`.

The combined final2 build uses `ryu-js` for ECMAScript's exact decimal
midpoint rule. Rust `LowerExp` was not equivalent: the PPO output
`-1.79193878173828125` printed as `-1.7919387817382813`, whereas JavaScript
requires `-1.7919387817382812`. The discrepancy correctly made the bench
refuse the otherwise native-valid trace. The formatter regression and a
200-decision teacher rerun now pass; no trace was rewritten to hide the error.
See [final2 evidence](engineering/benchmarks/state-throughput-2026-09-22-final2.verification.json).

Trace rows retain state, actions, reward terms, events, term reason, deadline
verdict, executor telemetry and optional envelope/signal evidence. BEV payloads
are digest-referenced rather than copied into every trace row. Selected policy
observations, not hidden channels, determine the observation evidence.
Camera rows additionally carry `cameras:{sceneStateDigest,frames:[...]}` (under
`reset.observation.cameras` for reset). Scene digests use canonical scene JSON;
frame rows retain actual CRC32/SHA-256, shape, format and simulation tick.
Transport paths, ring offsets and lease ids are excluded from trace identity.
No pixel nondeterminism is hidden: GPU renderers are not promised bit-identical
across fresh views/processes/devices. The camera parity test records the exact
scene mismatch count, frame mismatch count/rate and both unchanged v2 digests.

Measured on RTX 5080 (2026-09-22), the 10 s `alpamayo-2cam` PyO3/N-API
service parity run produced **101/101 identical scene-state documents**.
All **202 frames per binding** matched their own recorded payload hashes.
Cross-run RGB SHA-256 mismatches were **202/202 (100%)** after camera reset on
the resident renderer; pixel bit-determinism is therefore **not** established.
Receipt: `/tmp/simforge-episode-final/camera-parity/camera-parity.json`,
with both traces, scene histories and readable per-binding PNGs alongside it.
On the same final N-API artifact, the existing rendered benchmark measured
**13.01 / 8.78 / 5.30 ticks/s** for the 2/3/6-camera profiles (512×384 each),
including kernel stepping, trace, render RPC, GPU readback and FrameRef access.
See the [full rendered throughput receipt](engineering/benchmarks/rendered-throughput-2026-09-22-final.md)
for the three-window method, hashes and passing 2-camera floor.

For an existing campaign scorer, convert explicitly:

```sh
python -m simforge_oss_gym.tools.episode_trace episode-v2.jsonl --out legacy.jsonl
```

The converter verifies the entire v2 chain first, excludes scripted warm-up
from model scoring, rebases reset to policy start, emits legacy object tuples,
and computes a new **legacy Python-runner** chain. Its summary preserves
`source_episode_digest`/`source_schema`. Raw signal approaches are not invented
into the legacy scorer's signed stop-line-distance annotation. Converted
evidence must not be relabelled as the original v2 identity.

Proof: `cargo test -p simforge-session` exercises state equivalence, offline
barriers, warm-up accounting, deadline equality/fallback, held trajectory
anchors, replay breaches and channel refusals. The permanent
`adapters/gym/tests/test_episode_parity.py` drives 300 recorded decisions
(30 simulated seconds, control + setpoint + held trajectory) through both
bindings and an existing EnvSession/PolicySession reference, writes each
trace and prints all three identical digests. Point
`SIMFORGE_NATIVE_RUNTIME_ADDON` at the built addon and optionally set
`SIMFORGE_EPISODE_PARITY_OUT` to retain its evidence.
The camera variant is `test_ten_second_camera_episode_parity`; set
`SIMFORGE_EPISODE_CAMERA_INPUT` to a JSON document containing
`{spec,topology,actions}` with a real camera backend. It checks the raw payload
hashes against every v2 trace row, exports readable PNGs from each binding,
requires exact scene-state equality and reports the unmodified RGB mismatch
rate. Local reproduction launch arguments are recorded in
`/tmp/simforge-episode-cameras/reproduce.json`.
