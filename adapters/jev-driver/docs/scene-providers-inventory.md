# Scene-provider inventory

Paths below are relative to `/home/path/simforge-oss`. Read-only source investigation; no execution, builds, tests, linting, edits, or runtime verification were performed. Main will persist this report to `/home/path/tmp/scene-providers-inventory.md`; the scout lacks write capability. JevClosedLoopDesign was already sent the decisive answers and native Python integration details.

## 1. Existing policy / agent step contract

**YES — a closed-loop policy interface already exists. Prefer the current native Python/TS API rather than reconstructing the older documented socket server.** `PolicyRunner` constructs `PolicySession(env.native, deadline_ms, fallback, execution)`; it exposes `reset`, `act_control`, `act_trajectory`, generic `act`, checkpoints, and restore. Trajectory input is contiguous float64 `(K,5)` `[x,y,heading_rad,speed_mps,t_s]`; `Decision` contains observation/reward/termination/info/deadline/executor telemetry. Evidence: `adapters/gym/simforge_oss_gym/policy.py:23-105`.

- TS exact types: `Observation {tS,stateVector,objects,bev}`, `StepInfo`, `StepResult` at `packages/training-env/src/types.ts:114-157`; `PerceivedObject` is imported from native-runtime, with `id,rangeM,bearingRad,rangeRateMps,lineOfSight` at `packages/native-runtime/src/shared.ts:161-178`.
- `EnvSession.reset(seed)` consumes warm-up; `step(EnvAction)` holds action for `50 / decisionHz` ticks; `snapshot`, `egoPose`, `signalBook`, `causalChannel` are side-channel reads. `packages/training-env/src/session.ts:107-174`. `maxObjects` defaults to 64: `session.ts:29-35`.
- `PolicyAction = ActionTrajectory | ActionControl`; trajectory/control types at `packages/training-env/src/policy-step.ts:30-61`. TS `PolicySessionOptions` and `PolicyStepResult` at `policy-session.ts:17-35`; constructor and `reset/act/egoPose` at `policy-session.ts:53-108`.
- Python `SimForgeEnv.step` is a Gymnasium 5-tuple; action modes include setpoint `[speed,accel]` and control `[throttle,brake,steer]`. `adapters/gym/README.md:20-41`; `adapters/gym/simforge_oss_gym/env.py:178-190`. `StepView`, native `EnvSession`, actor truth APIs, and batch APIs are documented exactly in `_native.pyi:265-420`.
- State vector layout is **10 values**: world XODR x,y; cos/sin heading; speed; longitudinal acceleration; lane lateral offset; lateral rate; route arc length; nearest-actor range. Units are m, m/s, m/s² as applicable. `native/crates/simforge-session/src/observation.rs:24-38`. Object slabs are `[range_m,bearing_rad,range_rate_mps,los,valid]`, bounded/zero padded: `native/crates/simforge-session/src/batch.rs:21-32`; `_native.pyi:279-288`.
- Object lists use range/FOV gates and calculate LOS against static occluders and actor OBBs. **Occluded objects are still appended with `line_of_sight=false`; this is not a detected-only list.** Full bodies/classes/covariances are not in this observation. `native/crates/simforge-session/src/observation.rs:258-333`.
- Causal channel separately records LOS transitions, trigger causality, and conflict genesis: `packages/training-env/src/causal.ts:34-79`; exposed by `session.ts:170-173`.
- Original policy wire documentation specifies length-prefixed MessagePack, version 1, `policy.hello/reset/act/close`, compact `sv/objs/bev`, optional shared-memory camera reference, declarative caller-reported latency. `docs/policy-step.md:3-30,34-55,186-210`. **Staleness:** current TS `policy-session.ts` is a native wrapper, not the documented `registerPolicySession` server glue; symbol search found no `registerPolicySession`, `registerWorldOps`, or `EnvServer` in packages/adapters/services, and filename search found no env-server/session-registry implementation. Do not treat the historical wire docs as a runnable launch recipe.
- `adapters/policy-runner/simforge_oss_policy_runner/` had no source files in the tracked/readable inventory; canonical runner is now `adapters/gym/simforge_oss_gym/tools/policy_runner.py:451` and README `adapters/gym/README.md:74-105`.
- Separate qualification client remains: `EvalEnvClient` sends `hello/reset/step/close` over a Unix socket; action only target speed/accel (`ts`,`ta`); decoder additionally reads collision/goal/minima. `qualification/policy-eval-runner/policy_eval_runner/client.py:23-113`. Its corresponding server implementation was not located, so treat it as legacy qualification tooling, not the lowest-risk Jev seam.

## 2. Truth stream

**YES — full ground-truth object-state export exists independently of any renderer.** `TruthFrame` and `TruthActor` are public types at `packages/training-env/src/truth-stream.ts:53-72`; `WorldSession.subscribeTruth()` at `world-session.ts:224`; native publisher at `native/crates/simforge-session/src/world.rs:409-475`. A simpler synchronous provider can consume native `EnvSession.actors()/present()/actor_ids/actor_kinds/actor_dims` at `adapters/gym/simforge_oss_gym/_native.pyi:330-352`.

Wire contract:
- Four-byte little-endian payload length followed by MessagePack `TruthFrame`; one frame per committed engine tick, not a wall-clock timer. `docs/truth-stream-wire.md:7-16`.
- Top level: `tick,timeSec,scene,signals,actors`; `scene={tick,t,actors}`. Each scene actor has `id,kind(spawn/update/despawn),position[x,groundY,z],rotation[x,y,z,w],yawRad,velocity[vx,vy,vz],acceleration[ax,ay,az]`. `docs/truth-stream-wire.md:20-32,49-64`.
- Metadata actors: `id,class(car/truck/bus/motorcycle/bicycle/pedestrian/prop),dims{l,w,h},accel{ax,ay}`. Dimensions are authored/catalog metres, not mesh-derived. `docs/truth-stream-wire.md:25-30,69`.
- **Current implementation also has optional `telemetry`**, absent from the frozen-wire doc: speedMps, rpm, gear, throttle/brake/steer/steerRad, four wheel speeds rad/s, front/rear tyre utilization, longitudinal/lateral g, offRoad, collisionImpulseNs. `packages/training-env/src/truth-stream.ts:27-59`; native `world.rs:269-274,451-457`.
- Scene frame maps local `(x,y)` to scene `(x,0,-y)`. Local metadata acceleration remains `(ax,ay)`, scene acceleration `[ax,0,-ay]`. Numeric scene/acceleration values and simulation time are quantized to six decimals. Spawn acceleration zero; despawn clears velocity history. `docs/truth-stream-wire.md:67-77`.
- Every present actor appears every tick; presence transition produces terminal despawn record; stable actor-id ordering. Subscription starts at next tick without history. `docs/truth-stream-wire.md:67,83-85`.
- Signals include physical head/controller/junction identity, phase/timing source/boundaries/remaining ticks/next phase/cycle/failure state: `docs/truth-stream-wire.md:44`; publisher takes signal snapshots at the exact tick time: `native/crates/simforge-session/src/world.rs:460-465`.
- Publish rate is **50 frames per simulated second** for standard 20 ms stepping, not necessarily 50 Hz wall clock: `AGENTS.md:85-86`, `docs/truth-stream-wire.md:7`, `native/crates/simforge-session/src/world.rs:775-807`.
- Default 256-frame bounded queue, drop oldest and expose cumulative dropped counter; no consumer callback or transport wait on engine tick. `docs/truth-stream-wire.md:87-102`; native implementation `world.rs:466-475`; TS `TruthSubscription.pull/frames/stats/close` at `packages/training-env/src/world-session.ts:163-189`.
- **Internal implementation differs from doc wording:** native publisher shares `Arc<TruthFrame>` objects through queues, rather than encoding once before enqueue (`world.rs:303-304,460-475`). Bindings expose framed bytes; do not depend on undocumented queue internals.

## 3. Sensor / perception / object / bbox surfaces

### Existing ground-truth boxes, not just pixels
- **Explicit ground-truth bounding-box export already exists:** ROS2 Autoware bridge reads native actor rows/presence/dimensions, filters ego/absent actors, sets existence and class probability to 1, builds constant-velocity predicted paths, and publishes `Shape.BOUNDING_BOX` dimensions `(length,width,height)`. `adapters/ros2-bridge/simforge_ros2_bridge/autoware_bridge.py:318-378`. Topic is `/perception/object_recognition/objects` with `autoware_perception_msgs/PredictedObjects`: `adapters/ros2-bridge/README.md:126-140`. This is a reusable provider precedent; ROS itself is unnecessary for Jev.
- Native `ActorSnapshot` / `TickObservation`, synchronous `peek/peek_into`, and `advance_observed` supply per-tick state below the session layer: `native/crates/simforge-core/src/engine/world.rs:189,240,1200,1223,1403`. Bare Python `Simulation` offers explicit action batches, `trace_json`, and actor arrays: `_native.pyi:518-559`.
- CARLA artifact exporter writes versioned `simforge.annotation-frame/v1` NDJSON with index/scheduledTimeS/simulationFrameIndex/t/actor readbacks/signals: `adapters/carla-exec/simforge_oss_carla_exec/runtime/executor.py:361-378`; selectable `--annotations`: `adapters/carla-exec/simforge_oss_carla_exec/local.py:1073-1074`. This proves structured actor export, **not** a verified image-space 2D box exporter; exact readback field schema was not traced fully.

### Deterministic abstract perception
- `SimSensor`/mount/aperture/detection model schemas: `packages/engine/src/perception/schema.ts:1-23,48-76,107-133`. This layer intentionally has no image, point cloud, or noise process; it models whether declared sensors report actors using closed-form physical gates.
- Native implementation `PerceptionPass`, `PerceivedTarget`, `SensorPose`: `native/crates/simforge-core/src/engine/perception.rs:1-18,49-85`. Hard gates and atmospheric/angular-size/illumination/glare terms; `detected` trigger conditions feed scenario control, while map/percept divergence is exposure-only.
- Exported trace `SensorTargetTrack` stores status/reason/confidence/rangeM/lineOfSight per target, aligned with ticks; `SensorTrack` identifies observer/sensor/type. Confidence precision 4 decimals and range 3 decimals. `packages/engine/src/trace/sensor-track.ts:17-70`. `SensorPerceptionMetric` adds first LOS/detection, lag, durations and gaps; `PerceptionMetrics` at `sensor-track.ts:92-140`. These confidence values are modelled detection quality, not automatically calibrated real-sensor existence probabilities.
- Policy object-list builder is a separate simpler range/FOV/LOS surface, not the full above sensor degradation channel: `native/crates/simforge-session/src/observation.rs:258-333`.

### Rendered and geometric sensor outputs
- Rust sensor crate exports deterministic CPU BVH, lidar, radar, IMU/GNSS, formats: `renderer/sensors/src/lib.rs:7-22`. Offline capture is `simforge-render job --job job.json` (schema `simforge.render-job/v2`, `renderer/service/src/cli/job.rs`): RGB/depth/instance-ID/semantic cameras, lidar, radar (the Pronto rig via `rig.pronto`); it has no IMU/GNSS output.
- LiDAR points carry xyz, intensity, instance ID; declared sensor-frame metres: `renderer/sensors/src/lidar.rs:40-48`. ASCII PLY includes instance ID: `renderer/sensors/src/formats.rs:4-8,22-47`. Radar carries depth/azimuth/altitude/velocity: `renderer/sensors/src/radar.rs:51-58`, CSV encoder `formats.rs:52-69`.
- Capture uses world-space triangle soup for CPU lidar/radar, plus ID/semantic GPU passes, through the render service's request path. Not merely pixel rendering.
- Browser equivalent supports structured lidar/radar artifacts: `packages/render/src/web/capture.ts:204-205,242-244`; radar samples depth/ID cube with trace-derived velocity: `packages/render/src/web/sensors/radar-pass.ts:58-71,103-114`. Native render-side rasterizers consume PLY/CSV structure: `packages/render/src/native/sensor-video.ts:2-6`.
- Python camera abstraction `FrameSource.capture` and `ObservationAssembler` create endpoint image windows plus ego history, not Jev-ready object records: `adapters/gym/simforge_oss_gym/frames.py:71-74,335-338`.
- `BevySensorRig.render` loads latest provider scene-state and returns GPU frame leases or host frames: `adapters/gym/simforge_oss_gym/bevy_sensors.py:53-56,94-99`. `SensorRig` NuRec path feeds committed world ticks and produces tensor-frame leases: `adapters/gym/simforge_oss_gym/sensors.py:29-32,64-67`.
- Articulated physics adapter exposes 27-float MuJoCo observations: world chassis position/quaternion/linear and angular velocity, body IMU and wheel channels; per-wheel torque actions. `adapters/physics/README.md:94-102`; authoritative `OBSERVATION_LAYOUT` at `adapters/physics/simforge_oss_physics/workload.py:188-199`; `StepResult`/`BatchStepResult` at `types.py:63-99`. `SceneStateRecorder` additionally exports body truth with proper frame/quaternion conversion: `scene_state.py:1-13,29-35,71`.
- GPU roadway adapter is state-based Warp/CUDA, not perception rendering. Supports state vector/object list; rejects sensors, perception, signals and BEV; routes restricted to lanePath. `adapters/gpu/README.md:3-8,25-33`. Therefore not the preferable initial Jev provider.

No verified general camera-projected 2D bbox API was found in the searched rendering surfaces. Ground-truth oriented body pose plus dimensions and ROS bounding-box export are positively present; no renderer modification is needed to obtain them.

## 4. World/session lifecycle and stepping

- Python SDK embeds native Rust PyO3; no Node/Studio/subprocess required for roadway-native. `adapters/gym/README.md:3-14`. Scenario specs accept inline/path raw inputs or instance envelopes, topology documents/paths, installed map IDs, or template×map×site×seed expansion: README `:48-55`; native `ScenarioInput.parse` and `LaneGraph.from_topology` at `_native.pyi:47-52,108-115`.
- TS construction uses `engine.scenario(input)` plus graph and episode JSON for native `EnvSession`/`PolicySession`: `packages/training-env/src/session.ts:87-90`; `policy-session.ts:57-68`. World constructor accepts clip/live mode and horizon, default clip: `world-session.ts:144-154,201-206`.
- Fixed engine 50 Hz / 20 ms; decisionHz must divide 50 evenly: `packages/training-env/src/types.ts:82-89`; `AGENTS.md:85-86`. **3 Hz is not a valid exact decision frequency**. Use e.g. 10 Hz environment with every third decision as advisory replanning (~3.33 Hz), or another exact integer tick schedule; this is a derived integration recommendation, not an existing configurable 3 Hz mode.
- Explicit `WorldSession.advance(ticks)` validates positive integer ticks and advances only on demand: `packages/training-env/src/world-session.ts:278-282`; native `world.rs:775-807`. No wall-clock coupling is required. Canonical runner offline-simtime pauses at every inference barrier and does not enforce latency deadlines: `adapters/gym/simforge_oss_gym/tools/policy_runner.py:24-27,195-210`.
- Clip mode finite horizon defaults 120s; live mode unbounded and does not retain trace history: `packages/training-env/src/world-session.ts:147-154`. Reset and checkpoint/restore exist independently of renderer: `session.ts:111-114,150-157`.
- `docs/world-session.md:35-54,96-111` describes multi-client registry roles, tick ownership, queue ordering, and world.* socket ops. **Current native WorldSession differs:** `apply_command` immediately executes at the current boundary, and sorting/ordering across clients is explicitly caller-owned: `native/crates/simforge-session/src/world.rs:754-772`. The docs' blanket claim that commands only queue must not be copied onto this API.
- Likewise the old doc describes rebuild/replay on structural mutation (`docs/world-session.md:11-23,118-120`); current native comments explicitly describe structural edits not rebuilding engine input (`native/crates/simforge-session/src/world.rs:492-493`). Treat native runtime as authority; this investigation did not exhaustively trace every structural mutation case.
- CPU state/truth control is headless and does not require renderer/GPU/assets beyond scenario topology and the compiled native extension; evidence is the embedded-native default profile and synthetic fixtures (`adapters/gym/README.md:3-14,48-55`, `adapters/gym/tests/fixtures/synthetic-episode-trajectory.json:1-14`). Render-quality assets and GPU are separate requirements only if optional camera/sensor rendering is requested.

## 5. Ego vehicle control surfaces

- Preferred high-level Python: `PolicyRunner.act_control(throttle,brake,steer)` and `act_trajectory(K×5 float64)`; no wall-clock deadline if `elapsed_ms=None`. `adapters/gym/simforge_oss_gym/policy.py:44-85`.
- Preferred TS: `PolicyAction` tagged union; native dispatch `actControl`/`actTrajectory`. `packages/training-env/src/policy-step.ts:48-68`, `policy-session.ts:95-99`.
- Trajectory points are in ego frame at issuance: forward x, left y, relative yaw radians, signed speed m/s, strictly future seconds. Pure pursuit is default; speed-setpoint is alternative. Docs `docs/policy-step.md:109-120,122-165`; exact types `policy-step.ts:30-68`. Re-sending identical held plans preserves issuance anchor per documented semantics; a new plan reanchors.
- Low-level world `DriverCommand` supports throttle/brake `[0,1]`, normalized steer `[-1,1]`, optional rear handbrake. `packages/training-env/src/world-session.ts:54-75`. `setDriverCommand` holds until replaced; null releases authored controller: `world-session.ts:258-275`. `WorldCommand.act` accepts `EnvAction|null` for generic setpoint/preview/control overrides: `world-session.ts:68-75`.
- Bare `EnvSession.step` supports authored behavior on unset fields/empty action: `packages/training-env/src/session.ts:117-123`; Python `step(None)` similarly holds choreography: `adapters/gym/simforge_oss_gym/env.py:185-188`.
- Deadline fallback options repeat-last / zero-control / scripted are already implemented in native policy wrappers: `policy.py:1-8`, `policy-session.ts:1-6`. **Zero-control means coasting, not emergency braking**: `docs/policy-step.md:49-53`. Safety logic must not mislabel this as a safe-stop policy.
- ROS bridge also maps Autoware control to simulator actuation in SI, but is extra machinery for this task: `adapters/ros2-bridge/README.md:138-140`.

## 6. Map / lane graph / route / speed limits

- Most useful Python API is `LaneGraph`: lane ids/count, nearest_lane(x,y,max_dist_m), lane_width_at, sample_lane(rsl,s,reversed), project_onto_lane, successors, nominal_reversed, lane_json, default_placement_route, follow_route, route, turn_relation_of. `adapters/gym/simforge_oss_gym/_native.pyi:47-92`. `Route` provides `length_m,lane_rsls,pose_at(s),snapshot_json`: `_native.pyi:95-107`.
- `MapBundle` loads compiled maps or builds from topology/in-memory sources; exposes merged topology with speed limits and signal/control catalogs: `_native.pyi:138-167`. TS equivalent native graph declarations: `packages/engine/src/native-module.ts:22-26`.
- Topology lane records have predecessor/successor links, `speedLimitKph`, widths, adjacency, and sampled centerline polylines; `packages/maps/src/topology/types.ts:132-152`; mirrored engine topology `packages/engine/src/map/topology.ts:44-48`. Native lane geometry converts positive kph to m/s by `/3.6`, otherwise uses a runtime default: `native/crates/simforge-core/src/map/lane_graph.rs:442-454`.
- Existing route walking/sampling can therefore generate candidate paths without render geometry. The candidate safety/legal filter remains new integration logic, not something proved by existence of `follow_route` alone.
- Map registry is distribution/versioning, not the planner: `resolveVersion`, `pullVersion`, installation schemas/layouts at `packages/map-registry/src/registry.ts:549,637-699,746`; roadway sidecars include XODR/topology/lanes/signals.
- Public map and immutable-cache conventions: `AGENTS.md:15-21`. Current top-level `fixtures/*.xodr` match was `fixtures/yale-header.xodr`; this is a short parser fixture with metre PROJ units and a road speed `40 mph`, not a substitute for an installed complete map bundle: `fixtures/yale-header.xodr:3-15`.
- Self-contained starter fixture: `adapters/gym/tests/fixtures/synthetic-episode-trajectory.json` contains native dynamic-v1 dt=.02, 14s clip, one-second warmup, ego and other vehicle: `:1-14,26-79`. A second reference fixture is `adapters/gym/tests/fixtures/synthetic-episode.json` (used by documented runner command at `adapters/gym/README.md:84-85`).

## 7. Coordinate frames and units; inconsistencies

- Engine/XODR is local east/north/up metres; scene is y-up `(local.x,local.z,-local.y)`, a proper rotation (no mirroring), default no translation. Manifest scene.origin is tile-grid origin, not a placement offset. `packages/maps/src/coordinate-frame.ts:7-24,35-43`.
- Env actor rows/state vector are XODR `(x,y)` and heading CCW from +x; world snapshots expose scene `(x,z)`. `_native.pyi:343-345`; `packages/training-env/src/world-session.ts:113-126,235-243`. Never infer that `y` means height just because rendering uses y-up.
- Policy trajectory plane is forward/left; renderer/abstract-sensor actor mounts are forward/up/left (`x,y,z`). `docs/policy-step.md:109-116`; `packages/engine/src/perception/schema.ts:19-23,55-59`. A domain-portable FLU provider must explicitly reorder axes.
- Scene truth rotations are xyzw; MuJoCo starts wxyz, and physics exporter maps to `[x,z,-y,w]`. `docs/truth-stream-wire.md:58-62`; `adapters/physics/simforge_oss_physics/scene_state.py:3-7,29-35`.
- Speeds: simulation m/s, topology kph, source XODR can mph; observed conversion to m/s in native lane graph. `observation.rs:24-37`; `lane_graph.rs:442-444`; `fixtures/yale-header.xodr:15`. No centimetre-based Simforge runtime surface was established.
- Truth metadata accel is local xy whereas scene accel is y-up x/0/-y; both m/s². `packages/training-env/src/truth-stream.ts:57`; `docs/truth-stream-wire.md:77`. Vehicle telemetry g values are explicitly **g**, unlike acceleration fields: `truth-stream.ts:42-45`.
- **BEV documentation mismatch:** TS says channels occupancy/lane/ego (`packages/training-env/src/types.ts:57`), native authoritative comment says drivable lane/current ego lane/other-actor OBB occupancy (`native/crates/simforge-session/src/observation.rs:60-62`). Do not use TS comment as channel semantics.
- **LiDAR frame mismatch:** `renderer/sensors/src/lidar.rs:40-41` claims sensor-frame coordinates, but scan implementation subtracts sensor origin without inverse-rotating world hit positions (`:78-85`). For rotated sensors these are world-oriented offsets, not the declared local axes. Must resolve before using lidar as portable perception input; does not affect native truth provider.
- **Radar convention warning:** Rust radar field comment says positive-left (`renderer/sensors/src/radar.rs:53-54`); browser renderer describes positive velocity as approaching (`packages/render/src/web/sensors/radar-pass.ts:58-59`). Keep radar Doppler sign distinct from policy range-rate negative-closing (`native/crates/simforge-session/src/observation.rs:52-56`).
- **Documentation drift:** old server/registry types are absent from current training-env tree; native world immediate command semantics and shared typed truth queues differ from wire document implementation wording. Sources are detailed in §§1,2,4. Optional truth telemetry also contradicts interpreting the old “No field is optional” prose as an exhaustive current actor shape (`docs/truth-stream-wire.md:35` versus `truth-stream.ts:59`).
- Provenance/uncertainty: ROS exporter supplies certain existence/class probabilities (`autoware_bridge.py:352-356`); raw native truth and `PerceivedObject` lack a complete portable covariance/provenance schema (`truth-stream.ts:53-72`, `shared.ts:161-166`). A new versioned SceneObservation adapter remains necessary, but not a new underlying export.

## 8. Actual headless commands and requirements

### Recommended CPU / no renderer

Documented source-development build:
```sh
cd /home/path/simforge-oss/adapters/gym
maturin develop
```
Rust toolchain and an appropriate Python build environment are required; native extension is built from `native/crates/simforge-bindings-python`. Evidence: `adapters/gym/README.md:3-5,120-126`.

Documented native headless policy run:
```sh
cd /home/path/simforge-oss/adapters/gym
python -m simforge_oss_gym.tools.policy_runner \
  --spec tests/fixtures/synthetic-episode.json \
  --policy trajectory --seed 42 --steps 40 --out /home/path/tmp/scene-policy-trace.jsonl
```
Module and console script are equivalent, default offline-simtime; command flags are actual parser options. `adapters/gym/README.md:74-85`; `adapters/gym/simforge_oss_gym/tools/policy_runner.py:451-467`. This is a documented runnable recipe, **not a claim that this scout ran it or that the extension is currently installed**.

General authoring/native simulation setup:
```sh
pnpm install
node packages/cli/bin/simforge.js --help
node packages/cli/bin/simforge.js simulate i.instance.json --trace i.trace.json.gz
```
`AGENTS.md:10-12,47-49`. Map-bound work needs immutable map bundle/cache, `simforge maps pull <map>@<version>`: `AGENTS.md:15-21`. Synthetic inline topology avoids external map/render assets: `adapters/gym/README.md:48-55`.

Node native build, if choosing TS:
```sh
pnpm --filter @simforge-oss/native-runtime run build:node
pnpm --filter @simforge-oss/native-runtime run build:ts
```
Scripts are N-API cargo build and tsup respectively: `packages/native-runtime/package.json:69-74`. Building WASM/browser renderer is unnecessary for Python Jev control.

### Optional rendering lanes

- Root scripts: `render:run`, `render:worker`, `render:batch`, `trace:render`, `render:export`; actual dispatch commands at `package.json:15-20`. These render artifacts; they are not needed for object-state policy control.
- Native resident service build: `cd renderer && cargo build --release -p simforge-render` (`simforge-render serve` for the resident service, `simforge-render job` offline). Requires native renderer graphics runtime and resolved scene assets, unlike CPU policy execution.
- `simforge-render` is displayless in `serve` and `job`. A job needs `scene.glbs` (absolute GLB paths), a rig, `passes` and `outDir`; scene state, ticks and size are optional. A GPU/wgpu render device remains necessary for its camera path; this scout did not verify backend availability or whether software GPU fallback is supported.
- Browser export uses Chrome headless flag and ignore-gpu-blocklist: `scripts/export-render.mjs:103-104,994-997`. Batch rendering is headless unless `--headed`: `scripts/render-scenario-batch.mjs:125-126,171-172`. Browser/asset/server setup is extra overhead, not a requirement for Jev.
- CI contains a native golden renderer build under `native`: `.github/workflows/native-golden.yml:68-69`. That differs from the current `renderer/` service build recipe; treat it as historical CI evidence rather than assuming its package/workspace still resolves.

### Explicit gaps / scope of proof

Source inspection established the surfaces above, not runtime readiness, successful installation, frame conformance, safety legality, or present map/GPU availability. No current server launch was established for legacy `policy.*`/`world.*` socket docs. No complete camera-projected 2D bbox API or final CARLA annotation actor readback field schema was verified. Native EnvSession actor state + dimensions, existing ROS bbox export, and PolicyRunner are fully identified and sufficient to proceed without any renderer changes. All commands above remain unexecuted in this read-only assignment.