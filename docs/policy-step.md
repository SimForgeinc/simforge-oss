# policy_step Protocol (F3)

Session-oriented policy ops — `policy.hello` / `policy.reset` / `policy.act`
/ `policy.close` — layered on the existing env-server wire. Source of truth
for types and codecs: `packages/training-env/src/policy-step.ts`; server
glue: `packages/training-env/src/policy-session.ts`; reference client:
`adapters/gym` (`simforge_oss_gym.tools.policy_runner`).

Protocol version: **1** (`POLICY_STEP_PROTOCOL_VERSION`). Any breaking
change to the shapes below bumps it; `policy.hello` rejects mismatches.

## Transport and envelope

Identical to the env-server: length-prefixed msgpack frames (4-byte LE u32
payload length, then one msgpack document) over a unix socket or stdio.

```
request   {i: u64 id, op: string, ...op fields}
response  {i, ok: 1, r: payload} | {i, ok: 0, e: message}
```

Three op families share one connection and one envelope:

| family     | owner          | examples                          |
|------------|----------------|-----------------------------------|
| unprefixed | env-server core| `hello`, `reset`, `step`, `batch_step`, `subscribe`, `close` |
| `policy.*` | this protocol  | `policy.hello`, `policy.reset`, `policy.act`, `policy.close` |
| `world.*`  | world server   | `world.session.create`, `world.spawn`, `world.tick.advance` |

Extension families register through `EnvServer.registerOp(op, handler)` —
an additive seam consulted after the core dispatch switch. Core ops cannot
be shadowed.

## Determinism and deadlines

The server inherits the env-server invariant: **no wall-clock data anywhere
in the protocol**. Responses are a pure function of the request stream —
same seed, same requests, byte-identical responses.

Deadline enforcement is therefore *declarative*: the client (or a real-time
gateway fronting the server) measures its own inference latency and reports
it per action as `elapsedMs`. A decision **misses** when
`elapsedMs > deadlineMs` (both present; the boundary `elapsedMs ==
deadlineMs` is on time; either side absent means no enforcement). On a miss
the supplied action is discarded and the session's fallback applies:

| fallback       | applied action                                                          |
|----------------|-------------------------------------------------------------------------|
| `repeat-last`  | the last *applied* action of this episode (policy or fallback); before any applied action it degrades to `scripted` |
| `zero-control` | control passthrough `{throttle: 0, brake: 0, steer: 0}` (coast, wheel centred) |
| `scripted`     | no override this decision — the authored choreography drives the ego     |

The fallback policy is fixed at `policy.reset`; `deadlineMs` defaults there
and may be overridden per `policy.act` request. Every step frame reports
the verdict in `dl` (below), so traces always show what actually drove the
ego.

## Ops

### `policy.hello {v}`

`v` must equal the client's `POLICY_STEP_PROTOCOL_VERSION`. Response:

```
{proto, envProto, sessions, decisionHz, engineHz, egos: [id…],
 actions: ['trajectory', 'control'],
 fallbacks: ['repeat-last', 'zero-control', 'scripted'],
 obs: {sv, bev, frameBundle},
 trajExec: 'pure-pursuit' | 'speed-setpoint'}
```

`trajExec` reports how this server executes trajectory actions (see
"Trajectory execution" below); it is a server construction option
(`registerPolicySession(server, {trajectoryExecution})`), default
`'pure-pursuit'`.

### `policy.reset {s?, seed?, deadlineMs?, fallback?}`

Binds (or rebinds) policy state to env session index `s` (default 0) and
rebuilds its episode. `seed` (number | string) replaces the input's
authored seed deterministically; omitted keeps it. Clears the recurrent
state token and the repeat-last memory. Response:

```
{seed: <echo | null>, st: bin (empty), ob: <step frame>}
```

### `policy.act {s?, steps: [{a, elapsedMs?}…], st?: bin, deadlineMs?}`

Applies 1..K actions **sequentially** to session `s`. A terminal step
mid-batch makes the next entry fail the whole request (post-episode
stepping is undefined) — clients stop batching at `term`/`trunc`. `st`
replaces the stored recurrent state token. Response:

```
{st: bin (current token), rs: [<step frame + dl>…]}
```

### `policy.close {s?}`

Drops the policy state binding for session `s`. Does **not** shut the
server down (the core `close` op does) and does not disturb the underlying
env session.

## Actions

Tagged unions; compact wire forms in parentheses:

- **trajectory** (`{k: 't', p: [[x, y, heading, speed, t]…]}`) — samples in
  the **ego frame at plan issuance**: x forward along the ego heading, y
  left (90° CCW), heading relative to the ego yaw (radians), signed speed
  (m/s, negative = reverse), `t` seconds from issuance. Samples are
  strictly future (`t > 0`): the first point is *not* the current pose.
  This matches the Alpamayo adapter's "ego frame at t0" waypoint
  convention (FLU, z dropped; headings/speeds derived by the bridge from
  consecutive 10 Hz waypoints). Execution depends on the server's
  `trajExec` mode — see "Trajectory execution" below.
- **control** (`{k: 'c', c: [throttle, brake, steer]}`) — low-level
  passthrough into the force-based vehicle backend, applied at every
  `dynamic-v1` substep the way a live driver command is.

## Trajectory execution

Under `trajExec: 'pure-pursuit'` (default) the server really tracks the
polyline; `'speed-setpoint'` keeps the v1 reduction for regression
comparability (target speed from the earliest `t > 0` sample, steering
stays with the authored route logic; step frames carry no `ex`).

Executor pipeline (`@simforge-oss/engine` `sim/trajectory-follower.ts`, wired
in `policy-session.ts`):

1. **Anchoring.** A trajectory action whose points differ from the held
   plan is anchored to the world frame at the ego pose of the observation
   the act responds to (`anchorPlanToWorld`), and its issuance time is
   pinned there — the samples' `t` count from that instant.
2. **Zero-order hold.** Acts whose points are byte-identical to the held
   plan keep the original anchor. A 0.5 Hz replanner over 10 Hz decisions
   therefore resends the same points between replans; only a *different*
   plan re-anchors. `policy.reset` clears the held plan.
3. **Per-decision tracking.** Each act produces one engine action from the
   live pose: a pure-pursuit preview point + heading on the plan polyline
   (lookahead `clamp(2.5 m + 0.55 s · |v|, 2.5 m, 12 m)`), the
   time-indexed speed setpoint (piecewise-linear in plan `t`, clamped at
   the ends) and its slope as feedforward acceleration. Steering itself is
   the dynamic backend's calibrated bicycle controller — the preview
   override goes through the same steer clamp/rate/lag envelope as
   authored driving. Negative plan speeds flip the motion direction with
   the magnitude preserved.
4. **Projection.** Cross-track error is the signed lateral offset to the
   plan polyline (+left of the plan direction); the first and last
   segments project as open-ended rays so a pose behind the
   strictly-future first sample reads as along-track (negative), not
   lateral, error.

Every trajectory-executed step frame carries `ex`:

```
{x, y, h, v,            ego pose + travel speed the command was computed from
 ct, at, age,           signed cross-track (m, +left), along-track (m), plan age (s)
 sp, ax, dir,           applied speed setpoint, feedforward accel, direction
 px, py, ph}            pure-pursuit preview point + heading (world frame)
```

Determinism is inherited: the executor is a pure function of the plan and
pose stream, so the same seed and action sequence yields byte-identical
responses (`trajectory-executor.test.ts` digests two episodes).

### Tracking bounds

Measured on the fixed-step dynamic-v1 sim (50 Hz engine, 10 Hz decisions,
0.5 Hz scripted replans, S-curve amplitude 1.5 m / period 10 s at 8 m/s;
`packages/training-env/src/__tests__/trajectory-executor.test.ts`):

| metric                                   | measured        | documented bound |
|------------------------------------------|-----------------|------------------|
| abs cross-track error (after 1 s settle) | p50 0.14 m, p95 0.24 m, max 0.29 m | ≤ 0.35 m |
| speed-setpoint jump at plan swap         | ≤ 0.02 m/s      | ≤ 0.5 m/s |
| preview-heading jump at plan swap        | ≤ 0.01 rad      | ≤ 0.15 rad |

Bounds are for plans within the calibrated envelope (lateral accel well
under the profile's limit; the fixture curve peaks at ~0.6 m/s²). Sharper
plans track with proportionally larger corner-cutting error — pure pursuit
cuts inside a curve by roughly `Ld²/2R`.


## Step frames

`policy.reset`'s `ob` and every `policy.act` result are the env-server's
existing compact step frame

```
{t, rw, term, trunc, sv, objs, bev, cw, terms}
```

extended with:

- `dl` (`policy.act` only): `{lim: deadlineMs|null, el: elapsedMs|null,
  miss: 0|1, ap: 'policy'|'repeat-last'|'zero-control'|'scripted'}`.
- `ex` (`policy.act` only, `trajExec: 'pure-pursuit'` trajectory steps
  only): executor telemetry — pose, cross-track/along-track, applied
  setpoints and preview point (see "Trajectory execution").
- `fb`: `null`, or a shared-memory frame-bundle reference (ShmBridge
  contract): `{shm, tick, cams: [[id, digest, off, len, w, h, fmt]…]}`
  where `digest` is CRC32 (IEEE) of the payload bytes as 8-char lowercase
  hex, `off` is the physical payload offset in the shm file (128-byte
  record header at `off - 128`), `len` is the row-padded payload length
  (`rowStride = len / height`, wgpu 256-byte row alignment), and `fmt` is
  `'rgba8' | 'depth32f' | 'carla-depth-bgra'`. Pixels never ride the wire.
  Production is wired through the `frameBundleProvider` seam of
  `registerPolicySession`.

## Recurrent state token

Opaque bytes owned entirely by the policy (e.g. packed RNN hidden state).
The server stores the most recent token per session and echoes it in every
`policy.act` response, so stateless rollout workers can hand an episode
across processes without a side channel. `policy.reset` clears it to zero
bytes. The server never inspects it and it never affects stepping.

## Reference runner

`adapters/gym` (`python -m simforge_oss_gym.tools.policy_runner`, console
script `simforge-oss-policy-runner`) dispatches reference policies and the real
`simforge.policy-endpoint/v2` MessagePack endpoint through native **Episode**.
It no longer implements the world loop, latency verdict or replay envelope.
The endpoint wire remains unchanged; its camera observations now come from
the kernel Cameras channel, not a host-side scene renderer or prerecorded
directory.

Each run retains `trace.episode-v2.jsonl`: the sealed kernel trace and result
core, including warm-up and camera evidence. `trace.jsonl` is the verified
legacy-scorer conversion, with policy `reasoning`/replan telemetry added as
adapter evidence. That conversion has its own digest and explicitly links
`source_schema` and `source_episode_digest`; neither chain is relabelled as the
other. See [the v2 trace contract](world-session.md#trace-v2-and-legacy-conversion).

In `offline-simtime`, Episode owns the inference barrier and no deadline
exists. In `realtime`, Episode measures from observation delivery to the next
step, including rendering, and applies its configured fallback. The runner's
`--force-miss-at` delays the real barrier beyond the deadline rather than
reporting a fabricated latency. The reset record identifies the mode and
deadline so offline evidence can never be mistaken for a real-time result.

## Native observation channels (W0, 2026-09-22)

These are additive native-session/Episode fields, not a redefinition of the
historical compact `sv`/`objs` layout or the v1 socket handshake. Native
`EpisodeSpec.observation.channels` uses tagged objects: `{kind:"state"}`,
`{kind:"objects"}`, `{kind:"visible"}`, `{kind:"signals"}`, or
`{kind:"bev",h:200,w:160,resolutionM:0.25}`. `visible` includes LOS-gated
state/objects and infrastructure signals; it is not mixed with privileged
state/objects/BEV in an Episode. The legacy `EnvSession` equivalents are
`observation.visible` and `observation.signals` (both default **false**).

### Visible versus privileged

`visible` removes every `los=false` object row, absent actors, and actors
outside the configured range/sensor aperture. `sv[9]` is the range to the
nearest remaining object, or **1,000,000 metres** when none is observed.
Range-rate memory resets across an unobserved interval: first reacquisition
has rate zero rather than a finite difference through hidden truth.
When a native EnvSession additionally enables BEV, its actor-occupancy
channel follows the same visibility gate. Lane/map raster channels are not
camera measurements. Ground-truth actor snapshots, causal frames, pair
minima and reward diagnostics remain separate adapter/critic surfaces;
policies must not join those into a visible observation.

The existing privileged mode deliberately still includes LOS-false rows and
its original all-actor nearest range. With both new switches false, the
serialized observation is unchanged (the new signal field is **omitted**).
Visible/signal checkpoints record their observation configuration and reject
cross-channel restore, including restoring a privileged checkpoint into a
visible session.

### Signal schema

With signals enabled, `Observation.signals` is an array in canonical
signal-id/lane/stop-position order, one row per authored or repaired controlled
approach:

```json
{
  "signalId": "junction",
  "laneRsl": "1:0:-1",
  "stopLineS": 90.0,
  "connectingLaneRsls": [],
  "phase": "red",
  "source": "program",
  "timingSource": "authored",
  "timeToChangeS": 1.0
}
```

`stopLineS` is metres in the lane's **storage** direction, not ego-relative
distance. Empty `connectingLaneRsls` means all movements from that approach;
otherwise it names the controlled connecting lanes. `phase` is the engine's
`ControlIndication`: `green`, `yellow`, `red`, `flashing_yellow`,
`flashing_red`, `off`, `green_arrow`, `yellow_arrow`, `red_x`, `proceed`,
`stop`, `flashing_yellow_arrow`, or `flashing_red_arrow`.
`source` is `program` or `override`; `timingSource` preserves the native
program's timing provenance. `timeToChangeS` is seconds until the next
scheduled phase boundary, computed from the same 50 Hz signal authority
as simulation. It is **null**, not zero, for overrides and indefinite/clamped
phases (including a non-looping program's held final phase).

This is explicitly infrastructure/SPaT-style state, **not** a claim that an
occluded traffic-light head was perceived. No future actor truth is exposed.
An enabled channel with no controls returns `[]`; a disabled channel is
omitted. PyO3 `StepView.signals_json()` / `BatchView.signals_json(world)` return
the array JSON or `None`; Gym exposes decoded rows in `info["signals"]`
(also when `info_channel=False`). N-API returns optional `signalsJson`;
the TypeScript session decodes it as `observation.signals`.

The drive adapter passes these rows through `nativeObservation.signals`.
Jev receives them as optional `scene-observation/v2.signals` in its existing
decision state. AutoE2E receives the phase/timing rows and lane-graph-sampled
approach markers/stop lines: the latter populate its checkpoint's existing
**binary static** signal/stop-line raster channels. No untrained numeric phase
encoding is invented; full phase/timing metadata is retained as `signalState`.
These additions do not claim red-light reward/enforcement or qualify a model.

### Contact and ego contracts

Actual ego contacts with pedestrians, bicycles and collidable static props
terminate as `collision`, not truncation. Native `info.collision` contains
`{partnerId, partnerKind}` from the contact event and semantic actor catalog,
not the nearest perceived object. Props/map colliders have `partnerKind:
"static_object"` and their namespaced `prop:`/`map:` identity. The current
pre-W0 kernel already passed all three real-contact cases; tests preserve the
contract implicated in the historical invalid PPO run rather than claiming
a new collision-physics fix.

Ego resolution is `metricSubject`, then the canonical lowest-id `role:ego`
actor, then the canonical lowest-id road-vehicle kind (car, van, truck, bus,
motorcycle, bicycle, scooter or generic vehicle). This intentionally fixes
concrete compiled kinds; old inputs that explicitly name their metric subject
keep their actor identity.

### Reproduction evidence

`cargo test -p simforge-session --test observation_contract -- --nocapture`
uses the existing `adapters/gym/tests/fixtures/synthetic-episode-trajectory.json`,
seed 42, default 10 Hz, reset plus 40 scripted decisions. SHA-256 over the
serialized StepResult array, **before and after** the changes:
`2243af51a91457ca8e2d57745773f3bfd757aafba562d32e2a6a769bbe9c0492`.

The new **visible-v1** contract fixture adds the documented test occluder,
enables visible/signals and 1 m BEV cells, and repeats the same seed/actions:
`1bfc56014c1eb6af25e63de72d50bc503d9ec15e50c10b8bf4409591f356f075`.
That digest is a new channel identity, not expected to equal privileged.
These are observation/step-byte regression receipts, not a claim of legacy
CLI/gym trace-chain parity. Collision partner metadata is additive on contact
steps; new APIs ship in a versioned wheel rather than replacing a live rc61
installation.
