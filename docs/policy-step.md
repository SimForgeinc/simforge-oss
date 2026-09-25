# Policy step semantics

How a policy drives the ego: trajectory or control actions, declarative
deadlines with explicit fallbacks, and the pure-pursuit trajectory executor.

Source of truth: `native/crates/simforge-session/src/policy.rs`
(`PolicyExecutor`, `PolicyAction`, `FallbackPolicy`, `TrajectoryExecution`)
and `trajectory.rs` (`TrajectoryFollower`). Python surface:
`simforge_oss_gym.policy.PolicyRunner` over a native `EnvSession`
(`adapters/gym`). Reference client: `simforge_oss_gym.tools.policy_runner`.
A host that serves these semantics over a network wire (the hosted app does)
carries the same actions, verdicts and telemetry.

## Determinism and deadlines

**No wall-clock data enters stepping.** Results are a pure function of the
seed and the action stream: same seed, same actions, bit-identical results.

Deadline enforcement is therefore *declarative*: the client (or a real-time
gateway in front of the host) measures its own inference latency and reports
it per action as `elapsed_ms`. A decision **misses** when
`elapsed_ms > deadline_ms` (both present; the boundary `elapsed_ms ==
deadline_ms` is on time; either side absent means no enforcement). On a miss
the supplied action is discarded and the session's fallback applies:

| fallback       | applied action                                                          |
|----------------|-------------------------------------------------------------------------|
| `repeat-last`  | the last *applied* action of this episode (policy or fallback); before any applied action it degrades to `scripted` |
| `zero-control` | control passthrough `{throttle: 0, brake: 0, steer: 0}` (coast, wheel centred) |
| `scripted`     | no override this decision; the authored choreography drives the ego     |

The fallback and the default deadline are fixed for the episode
(`PolicyRunner(env, deadline_ms=..., fallback=...)`). Every decision reports
its verdict (`applied`, `deadline_miss`, `deadline_limit_ms`,
`deadline_elapsed_ms`), so traces always show what actually drove the ego.

## Actions

- **trajectory** (`act_trajectory(points)`, `points` a `(K, 5)` array of
  `[x, y, heading_rad, speed_mps, t_s]`): samples in the **ego frame at plan
  issuance**: x forward along the ego heading, y left (90° CCW), heading
  relative to the ego yaw (radians), signed speed (m/s, negative = reverse),
  `t` seconds from issuance. Samples are strictly future (`t > 0`): the first
  point is *not* the current pose. This matches the Alpamayo adapter's "ego
  frame at t0" waypoint convention (FLU, z dropped; headings/speeds derived by
  the bridge from consecutive 10 Hz waypoints). Execution depends on the
  session's trajectory execution mode, below.
- **control** (`act_control(throttle, brake, steer)`): low-level passthrough
  into the force-based vehicle backend, applied at every `dynamic-v1` substep
  the way a live driver command is.

## Trajectory execution

Under `execution="pure-pursuit"` (default) the executor really tracks the
polyline; `"speed-setpoint"` takes the target speed from the earliest
`t > 0` sample, leaves steering with the authored route logic and reports no
executor telemetry.

Executor pipeline:

1. **Anchoring.** A trajectory action whose points differ from the held plan
   is anchored to the world frame at the ego pose of the observation the act
   responds to (`anchor_plan_to_world`), and its issuance time is pinned
   there: the samples' `t` count from that instant.
2. **Zero-order hold.** Acts whose points are byte-identical to the held plan
   keep the original anchor. A 0.5 Hz replanner over 10 Hz decisions
   therefore resends the same points between replans; only a *different*
   plan re-anchors. A reset clears the held plan.
3. **Per-decision tracking.** Each act produces one engine action from the
   live pose: a pure-pursuit preview point + heading on the plan polyline
   (lookahead `clamp(2.5 m + 0.55 s · |v|, 2.5 m, 12 m)`), the time-indexed
   speed setpoint (piecewise-linear in plan `t`, clamped at the ends) and its
   slope as feedforward acceleration. Steering itself is the dynamic
   backend's calibrated bicycle controller: the preview override goes through
   the same steer clamp/rate/lag envelope as authored driving. Negative plan
   speeds flip the motion direction with the magnitude preserved.
4. **Projection.** Cross-track error is the signed lateral offset to the plan
   polyline (+left of the plan direction); the first and last segments
   project as open-ended rays, so a pose behind the strictly-future first
   sample reads as along-track (negative), not lateral, error.

Every pure-pursuit decision carries executor telemetry (`ExecutorFrame`;
`Decision.executor` in Python): the ego pose and speed the command was
computed from, the signed cross-track error (m, +left), along-track position
(m), plan age (s), the applied speed setpoint, feedforward acceleration and
direction, and the pure-pursuit preview point + heading (world frame).

The executor is a pure function of the plan and pose stream, so the same
seed and action sequence yields bit-identical results.

### Tracking bounds

On the fixed-step dynamic-v1 sim (50 Hz engine, 10 Hz decisions, 0.5 Hz
scripted replans, S-curve amplitude 1.5 m / period 10 s at 8 m/s):

| metric                                   | measured        | documented bound |
|------------------------------------------|-----------------|------------------|
| abs cross-track error (after 1 s settle) | p50 0.14 m, p95 0.24 m, max 0.29 m | ≤ 0.35 m |
| speed-setpoint jump at plan swap         | ≤ 0.02 m/s      | ≤ 0.5 m/s |
| preview-heading jump at plan swap        | ≤ 0.01 rad      | ≤ 0.15 rad |

Bounds are for plans within the calibrated envelope (lateral accel well
under the profile's limit; the fixture curve peaks at ~0.6 m/s²). Sharper
plans track with proportionally larger corner-cutting error: pure pursuit
cuts inside a curve by roughly `Ld²/2R`.

## Recurrent state token

Opaque bytes owned entirely by the policy (e.g. packed RNN hidden state).
The executor stores the most recent token per episode and echoes it on every
act, so stateless rollout workers can hand an episode across processes
without a side channel; it is part of the episode checkpoint
(`PolicyRunner.checkpoint()` / `restore()`). A reset clears it to zero bytes.
The executor never inspects it and it never affects stepping.

## Reference runner

`adapters/gym` (`python -m simforge_oss_gym.tools.policy_runner`, console
script `simforge-oss-policy-runner`) is the canonical client: it drives seeded
episodes with the scripted control, scripted-trajectory and torch-mlp
reference policies or a real model endpoint (`--policy endpoint`, the
`simforge.policy-endpoint/v2` MessagePack socket), records per-step inference
timing and deadline verdicts, and writes an episode trace as JSONL. Each record
carries the deterministic step fields (including the action, the policy's
per-act `reasoning` text and the executor telemetry) plus a `digest`: a
SHA-256 chained over the canonical JSON of every deterministic record so far
(wall-clock timing is excluded). The final line holds the chained episode
digest; two runs with the same seed and policy must match digests exactly.

A run declares one timing mode. In `offline-simtime` the runner passes no
`elapsed_ms`, so no deadline is enforced anywhere and the loop itself is the
inference barrier; in `realtime` it reports the measured latency against an
explicit `--deadline-ms` and the fallback applies on a miss. The trace's
`reset` record carries `mode` and `deadline_ms` so a reader can never mistake
one for the other.
