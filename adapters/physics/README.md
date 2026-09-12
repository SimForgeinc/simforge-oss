# simforge-oss-physics

The `articulated-mujoco-v1` physical profile: MuJoCo-backed execution of one
concrete articulated workload — a four-wheel skid-steer delivery robot that
climbs a curb-cut ramp onto a sidewalk and drops off the curb — with typed
actions/observations, finite-step episodes, complete snapshot/restore and
canonical `simforge.scene-state.v1` export.

This is a new, separately versioned physical model. It does not touch the
planar `dynamic-v1` roadway profile, and it does not claim
real-world validity beyond the analytic and identity gates in
`simforge_oss_physics.qualification`.

## Backends

| Backend | Class | Execution | Precision | Snapshot | Determinism claim |
|---|---|---|---|---|---|
| `mujoco-cpu` | `MuJoCoCpuSession` | `mujoco.mj_step`, one world | float64 | `mjSTATE_INTEGRATION` (time, qpos, qvel, act, ctrl, applied forces, warm-start) | bit-identical replay and restore on the same build (gated) |
| `mujoco-warp` | `simforge_oss_physics.warp.MuJoCoWarpBatch` | `mujoco_warp.step`, `nworld` worlds, CUDA graph capture on GPU | float32 | `mjSTATE_FULLPHYSICS \| mjSTATE_CTRL` (no warm-start on device) | batch invariance gated; CPU/Warp divergence **measured, not presumed** |

The Warp backend refuses model features MuJoCo Warp documents as unsupported
(implicitfast integrator, PGS solver, noslip, plugins, flex) and raises
`ContactCapacityError` when a batch reaches its declared contact/constraint
capacity — contacts are never dropped silently. Observations, rewards and
termination are computed on the host from a per-decision device-to-host copy
of `sensordata`; this is declared in `warp_capabilities()`. Device-resident
reward/termination and masked-reset kernels belong to the BATCH workstream.

### Warp determinism

MuJoCo Warp documents GPU execution as non-deterministic
([mujoco_warp#562](https://github.com/google-deepmind/mujoco_warp/issues/562)):
contacts and constraint rows are allocated through atomic counters and the
inertia, mass-matrix, contact-force, Hessian and cost reductions accumulate
through float32 atomics, so identically seeded worlds drift apart.
`MuJoCoWarpBatch` therefore runs MuJoCo Warp under Warp's deterministic
execution mode (`warp.DeterministicMode.RUN_TO_RUN`, applied per Warp module):
accumulation atomics are reduced in (destination, thread) order and
slot-allocating atomics are replayed with thread-ordered prefix sums, which
gives every world the same contact/row layout and the same summation order.
`warp.DETERMINISM` (also in `warp_capabilities()["determinism"]` and in the
`warp_batch_identity` report) states the scope:

- `mujoco_warp._src.sensor` stays non-deterministic: its tactile kernel mixes
  `atomic_max`/`atomic_add` on one array, which warp 1.17 rejects for the whole
  module. The only atomic this model executes there is the touch-sensor sum,
  which is order-invariant for ≤2 contacts per wheel (plane: 2, box: 1) and can
  differ by one float32 ulp of `wheel_normal_force` only while a wheel touches
  the ground plane and a course box at once (ramp entry). State is unaffected.
- Graph capture cannot report deterministic record overflows, so construction
  runs one uncaptured warm-up decision (record bounds: `mjMAXCONPAIR` for
  per-launch kernels, `nv` for `smooth`, `ceil(naconmax / JTCJ block)` for
  `solver`), and `naconmax` must not exceed the convex narrowphase launch width
  (device-dependent).
- The claim is same-GPU-architecture repeatability; cross-architecture
  reproducibility is not claimed.

Setting the mode is process-wide for Warp (`warp.config.deterministic`); it is
applied when the first batch is constructed.

## Workload: `delivery-robot-curb-ramp`

Everything is a named field of `WorkloadSpec` (`RobotSpec`, `CourseSpec`,
`SimulationSpec`, `EpisodeRules`). Defaults:

- Chassis box 0.70 × 0.50 × 0.30 m, 30 kg; four cylinder wheels r = 0.10 m,
  width 0.05 m, 1.5 kg each; wheelbase 0.45 m, track 0.56 m; total 36 kg.
- Wheel hinges: damping 0.005 N·m·s/rad, armature 0.01 kg·m²; motors ±3 N·m
  per wheel. Contacts: sliding friction 0.9, condim 3, elliptic cone.
- Course along +x: 2.0 m flat approach → 1:12 ramp (0.10 m rise over 1.2 m)
  → 2.0 m sidewalk → 0.10 m vertical curb drop → 1.8 m run-out to the goal.
- 2 ms physics step, 10 substeps per decision (50 Hz), 1500-decision horizon.

`Workload.mjcf` is generated from the spec; `Workload.digest` is
`sha256(profile, spec JSON, MJCF)` and is stamped on every snapshot and
report. Modelled/not-modelled scope is listed in `cpu_capabilities()`.

### Episode API

```python
from simforge_oss_physics import MuJoCoCpuSession, ResetOptions, OBS, Workload
import numpy as np

s = MuJoCoCpuSession(Workload())
res = s.reset(seed=7, options=ResetOptions(start="approach"))   # StepResult
while not res.done:
    res = s.step(np.array([1.0, 1.0, 1.0, 1.0]))               # N*m, order fl fr rl rr
    x = res.observation[OBS["chassis_pos"]][0]
snap = s.snapshot()                    # Snapshot; .to_dict()/.from_dict() are JSON-safe
s.restore(snap)                        # SnapshotIncompatibleError on any identity mismatch
doc = s.export_scene_state()           # scene-state.v1 document
```

- **Actions**: `(4,)` float64 per-wheel torque, clipped to `motor_torque_max_nm`.
- **Observation** (`OBSERVATION_LAYOUT`, 27 floats, all MuJoCo sensors so both
  backends read one `sensordata` array): `chassis_pos` [m, world],
  `chassis_quat` [wxyz], `chassis_linvel` [m/s, world], `chassis_angvel`
  [rad/s, world], `imu_accel` [m/s², body, includes gravity], `imu_gyro`
  [rad/s, body], `wheel_angvel` [rad/s ×4], `wheel_normal_force` [N ×4, summed
  contact normal force per wheel]. Observations describe the post-integration
  state (`mj_forward` after the substeps) and are copies, never solver views.
- **Reward**: forward progress per decision (m) − 1e-3 · Σ torque². **Terminated**:
  goal reached (x ≥ goal), tipped (chassis up-vector z < 0.5), left the
  corridor (|y| > 0.9 m), or fell below ground. **Truncated**: horizon.
  `info` carries `progress_m`, `effort_nm2`, `goal_distance_m`, `up_z`,
  `wheels_in_contact`, `reached_goal`, `tipped`, `off_corridor`.
- **Reset**: `seed` drives only the start-pose jitter (`numpy.random.default_rng`
  PCG64; ±0.05 m lateral, ±2° yaw by default); the sampled offsets are stored
  on the snapshot. `start` ∈ {`approach`, `ramp`, `plateau`}.
- **Batched** (`MuJoCoWarpBatch(workload, nworld=N)`): `reset(seeds)`,
  `reset_worlds(mask, seeds)`, `step(actions (N,4)) -> BatchStepResult`,
  `snapshot(world)`, `restore(world, snapshot)`, `export_scene_state(world)`.
  Finished worlds must be reset before the batch steps again.

### scene-state export

`export_scene_state(from_tick=0)` emits `simforge.scene-state.v1` frames per decision
for actors `chassis` (`robot.delivery-4w`) and `wheel_{fl,fr,rl,rr}`
(`robot.wheel`), class `prop`. MuJoCo's z-up world frame is the engine's
xodr-local frame, so positions map `(x, z, -y)` and quaternions map
`(w,x,y,z) -> [x, z, -y, w]`; headings are invariant. The chassis velocity is
the solver's `framelinvel`; wheel origin velocities are exact rigid-body
kinematics; accelerations are backward differences and omitted on a segment's
first frame. Positions carry solver height (the actor origin is the chassis
body origin, not a ground-plane point) and `groundY` is `null`.
`scene_state_digest(doc)` is the sha256 of the canonical JSON.

### Course render resource (headless sensor rendering)

`mapId` of the export is `physics:delivery-robot-curb-ramp:<digest16>`; it
is not a corpus map. `simforge_oss_physics.course_asset` derives the
matching static render resource from the same course geometry the MJCF is
generated from (`ramp_slab_pose`): a self-contained glTF 2.0 binary with
nodes `ground` (finite 60 m slab standing in for MuJoCo's plane),
`ramp_road` and `sidewalk`, y-up metres in the scene frame, names chosen so
the renderer's semantic taxonomy classes them as drivable surface.

```sh
simforge-oss-physics course --out-dir DIR      # writes DIR/course/<sha256>.glb + DIR/course/manifest.json,
                                               # prints the absolute-path renderer SceneSpec
```

`write_course_resources(workload, dir)` persists the GLB content-addressed
with a manifest (`simforge.physics-course-resource/v1`: mapId, workload
digest, files[{path, kind, sha256, bytes}], geometry). `render_scene_spec
(manifest, dir)` returns the native render service prewarm `SceneSpec`
(`renderer/service/src/server.rs`: `glbs` absolute, `profile`, `nearM`,
`farM`, `warmupFrames`). `to_service_states(doc)` converts the playback
document into the service's per-tick `LoadSceneState` form
(`transform{position, rotation}` per actor, descriptors joined in). The
service applies position (incl. y) and the full quaternion verbatim for the
body-centred `robot.delivery-4w` / `robot.wheel` catalog entries and builds
their primitives from `dims`; no `actorModelRefs` are emitted for them.

`job` writes all of this into the output directory: `course/<sha256>.glb`,
`course/manifest.json`, `render/scene-spec.json` (`sceneSpec.glbs` relative
to the output directory; resolve before prewarm) and
`render/scene-state.<seed>.native.json`; all are listed in the `done`
artifacts. Headless path: prewarm the service with the resolved SceneSpec,
`LoadSceneState` with the native stream, then render any camera rig against
the shared resident sensor interface. Nothing here renders; it is the
resource closure the existing renderer consumes.

### Runner workload `simforge.articulated-mujoco/v1`

```sh
simforge-oss-physics job --params params.json --out-dir DIR [--resume DIR/checkpoint/checkpoint-*.json]
```

`params.json` keys, all required, none other accepted: `backend`
(`mujoco-cpu`|`mujoco-warp`), `seeds` (unique ints), `start`, `decisions`,
`torqueNm`, `checkpointEveryDecisions` (0 = never). Outputs `episodes.json`
(list of per-seed summaries, same shape as `rollout`), `scene-state.<seed>.json`
and `checkpoint/checkpoint-<decision>-<n>.json` (`params`, `episodeIndex`,
`snapshots`, `recordings`, `rewards`, `completed`). stdout is JSON lines:
`progress {seed, decision, timeS}`, `checkpoint {path}`, then `done
{artifacts: [{relativePath, sha256, sizeBytes}]}` (exit 0) or, after SIGTERM,
a final checkpoint and `canceled` (exit 130). stderr `error {code, message}`
with exit 1 (`bad-params`) or 2 (`contact-capacity`, `backend-capability`,
`physics-adapter`). Resuming a checkpoint reproduces the uninterrupted
episode summaries and scene-state files byte for byte on the CPU backend
(`tests/test_job.py`). The Warp backend runs all seeds as one batch.

### Catalog bindings required from the asset owner

The export references catalog ids that do not exist yet:

- `robot.delivery-4w`: chassis box l×w×h = 0.70 × 0.50 × 0.30 m (`dims`
  carried on the actor). **Origin is the chassis body centre**, 0.27 m above
  the contact surface at rest, not a ground-plane point; +X forward, +Y up
  (scene frame). No wheels in this mesh.
- `robot.wheel`: cylinder radius 0.10 m, width 0.05 m, origin at the wheel
  centre, axle along scene −Z (MuJoCo +Y) in the identity pose; the exported
  rotation carries the spin, so the mesh must be axis-symmetric about the axle.

## Qualification

```sh
uv run --extra dev simforge-oss-physics qualify --out qualification.json          # CPU gates
uv run --extra warp --extra dev simforge-oss-physics qualify --warp --out q.json  # + Warp gates (GPU)
uv run simforge-oss-physics capabilities --warp
uv run simforge-oss-physics rollout --seed 1 --torque 1.0 --decisions 400 --scene-state rollout.scene-state.json
uv run --extra dev pytest tests
```

Gates (each with explicit tolerance; `not-run` is never a pass):

| Gate | Reference | Tolerance |
|---|---|---|
| `free_fall_analytic` | z = z₀ − gt²/2, v = −gt (semi-implicit Euler bound) | 1e-4 m beyond g·t·dt/2; 1e-6 m/s |
| `static_rest_force_balance` | Σ wheel normal force = m g, 4 wheels, still | 2 %; 1e-3 m/s; ≤1 cm penetration |
| `flat_rolling_no_slip` | v(t) = τr/c·(1 − e^{−4ct/(M_eff r²)}), v = ω̄ r | 3 %; slip 3 %; yaw 1° |
| `ramp_torque_threshold` | 0.5×/1.5× m g r sin α from rest at mid-ramp: sign and d = a t²/2 with a = (τ/r − m g sin α)/M_eff | 15 % |
| `curb_drop_recovery` | upright, 4 wheels, rest height after the drop | up_z > 0.95; 1 cm; 0.05 m/s |
| `ramp_climb_timestep_convergence` | 2 ms vs 1 ms physics step, same decisions | 2 cm; 1°; 5 cm/s |
| `determinism_replay` | two sessions, same seed/actions | bit-identical; equal digests |
| `snapshot_restore_identity` | JSON round-tripped snapshot in a fresh session | bit-identical tail; equal segment digests |
| `warp_batch_identity` | identical worlds agree (float32) | 1e-6 |
| `warp_capacity_rejection` | `nconmax=1` batch raises `ContactCapacityError` | — |
| `cpu_warp_divergence` | same episode on both backends | measured only |

Passing establishes the solver integration, contact balance, no-slip rolling
dynamics, ramp threshold behaviour, curb-drop stability, convergence and
identity invariants **for this workload and these declared values**. It does
not validate tyre deformation, suspension, rolling resistance, real landing
loads, vehicle-scale terrain profiles, or CPU/GPU parity.

## Dependencies

`mujoco>=3.11`, `numpy>=1.26`; optional `warp` extra: `mujoco-warp>=3.12`,
`warp-lang>=1.15` (NVIDIA GPU + CUDA driver for device execution).
