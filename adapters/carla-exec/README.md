# SimForge CARLA bridge

`simforge-oss-carla-exec` is the public CARLA renderer and sensor adapter
owned by SimForge. It consumes the stored render-intent/v1 wire format plus a
hash-closed local input package; the managed worker retains only leases,
fencing, authorization, and transfer. The package owns OpenSCENARIO 1.4
compilation, deterministic native execution, RGB/depth/semantic/instance/
normals cameras, LiDAR, semantic LiDAR, radar, materialized traffic, parity
evidence, bounded artifact transport, and the official schema validator.

CARLA is optional. The browser editor, local deterministic simulation,
OpenDRIVE tooling, OpenSCENARIO export, and playback do not import CARLA or
require a CARLA server.

## Install

From this repository:

```sh
python3 -m pip install ./adapters/carla-exec
```

Install the Python client distributed with the exact CARLA server build you
intend to use. The bridge deliberately does not declare `carla` as a package
dependency because the client/server build pair is part of execution
provenance, not a floating package resolution.

The validator also requires `xmllint` on `PATH`. The pinned official ASAM
OpenSCENARIO XML 1.4 schema is bundled in the wheel and its SHA-256 is checked
before every validation.

## Use locally

Start CARLA, then verify the client/server connection without mutating its
world:

```sh
simforge-oss-carla-exec --host 127.0.0.1 --port 2000 probe
```

The unified Node CLI dispatches `--engine carla` to this installed process
adapter:

```sh
simforge-oss-carla-exec --host 127.0.0.1 --port 2000 run-intent \
  --intent render-intent.json \
  --package input-package.json \
  --output output/carla \
  --progress output/carla-progress.jsonl \
  --manifest output/render-artifact-manifest.json
```

`run-intent` accepts strict render-spec/v3 sources, verifies `intentSha256` and
every local input before CARLA starts, writes render-progress/v1 JSONL, and
closes with render-artifact-manifest/v1.

Set `SIMFORGE_CARLA_COOKED_MAPS_JSON` to a JSON map of cooked map names to
their source XODR SHA-256 values; a digest or loaded-world identity mismatch is
fatal. `SIMFORGE_CARLA_SIGNAL_ID_MAP` supplies an explicit one-to-one authored
to cooked OpenDRIVE signal-id map. `SIMFORGE_SENSOR_WRITER_WORKERS` bounds
parallel streaming writers. Set `SIMFORGE_PRESENTATION_VIDEO_ENCODER=nvidia`
to request `h264_nvenc` for the per-camera streaming encoders (default
`software` = libx264). Camera frames stream directly into one H.264 MP4 per
camera and never persist to disk; PLY/CSV frames remain the canonical output
for lidar and radar measurement data.

Managed execution currently derives from
`ghcr.io/simforgeinc/carla-rfs-munich-belmont@sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64`
(OCI index `sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5`).
Sensors attach to the authored host actor after its catalog binding is resolved.
Any native CARLA vehicle blueprint is valid. A non-native vehicle binding uses
the nearest deterministic same-class native fallback and records the
substitution in `carlaVehicleFallbacks`; execution fails closed only when the
claimed catalog has no native blueprint for that actor class. Parent readback
verifies the resolved actor identity without imposing a model-specific host.

## Execution modes

CARLA is a renderer of the scenario. It never owns motion.

- **`trace-replay` (default).** Every replayed actor (vehicles, walkers and
  props) is kinematic: physics is off from spawn, before the first tick. There
  is no settle phase and no nudging. On every 50 Hz tick one batched
  `apply_batch_sync` poses every actor from the render-timeline sampler
  (`pose(timeline, actorId, t)`, `docs/engineering/render-timeline.md`).
  Lights and signal states come from the timeline too. When the package ships a
  baked render timeline, the `simforge_oss_timeline` binding supplies the
  poses. Otherwise they come from the plan compiled from the trajectory-replay
  `.xosc`, which follows the same sampling rules.
- **`native-physics`** is the *physics validation* mode. CARLA vehicles are
  driven by throttle, brake and steer toward the trace, and walkers and props
  are replayed kinematically. Its output measures how CARLA physics diverges
  from the trace. It is labelled `purpose: physics-validation` everywhere and
  is never the scenario's render. A render intent opts in by asking for the
  `actor.native_controls` capability. `diagnostic-replay` is the historical
  name of `trace-replay`.

### Blocking replay parity

After every tick the worker reads back every live body from one world
snapshot and compares it with the sampler: position within **1 cm**
(ground-contact z included) and heading, pitch and roll within **0.1°**.
Presence must match the timeline exactly, and so must the signal states. Any
violation fails the render: `run-intent` exits non-zero and nothing is
published. The report is `runtimeEvidence.replay` plus the parity evidence
`trajectory` (`acceptanceGate: replay-sampler-parity`). The control plane
re-checks the recorded maxima before it accepts a completion.

### Time, capture and labels

- Plan time is clip time. `t = 0` is the clip start after the simulation
  warm-up, and the warm-up is never rendered. The exporter's
  `trajectoryReplay.warmupSeconds`/`clipSeconds` header fixes the origin.
  Triggers and vertices are converted from xosc time; knockdown times are
  already clip time.
- Output frame `k` is scheduled at exactly `k / fps` and rendered on the
  nearest tick. When fps divides 50 (1, 2, 5, 10, 25, 50) that tick *is*
  `k / fps`. For the product's 20/24/30 fps, trace replay samples the timeline
  at exactly `k / fps` on that tick, so the frame shows its scheduled instant.
  Every sensor record carries `contentTimeS` (manifest `capture.policy`:
  `tick-aligned` or `sub-tick-sampled`). Physics validation cannot sample off
  tick. Its frames are labelled with the post-step time they actually show.
- Physics substepping is set (10 ms, at most 10 substeps) and recorded in
  `runtimeEvidence.physicsSettings`. A server that ticks itself in
  synchronous mode fails the render (see `probe-ticks`).

### Height and map binding

The timeline z is authoritative: it is the ground-contact elevation, baked
once from the XODR elevation. The cooked-mesh raycast only runs as a
diagnostic (`runtimeEvidence.replay.groundDiagnostic`: cooked surface minus
timeline z, per class, with the suggested per-map calibration). A calibrated
per-map offset (`MAP_Z_CALIBRATION_M`, or `SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON`
keyed by XODR sha256) is applied and recorded when the cooked world floats or
sinks bodies.

The world is bound by XODR digest, never by name. The package XODR selects the
cooked world. The runtime's `to_opendrive()` must then be byte-identical to
the package XODR or an approved cooked re-serialization of it
(`APPROVED_COOKED_XODR_DIGESTS`, `SIMFORGE_CARLA_APPROVED_COOKED_XODR_JSON`).
Anything else fails. The exception is `SIMFORGE_CARLA_MAP_BINDING=allow-approximate`,
which renders the job labelled `approximate map` in the manifest and the
evidence.

### What replay approximates

The manifest lists these under `approximations`:

- **Suspension.** There are no suspension dynamics. Body attitude is the
  timeline's road and acceleration pitch/roll, and packages without a timeline
  carry none (level bodies).
- **Wheels.** Kinematic vehicles' wheels neither spin nor steer.
- **Walker gait.** Speed is fed to CARLA's locomotion blend
  (`ApplyWalkerControl` plus the target velocity), so gait animates while the
  body is posed exactly. It is CARLA's gait, not a replayed skeleton.
- **Radar Doppler.** CARLA's `velocity_mps` comes from the physical velocity of
  the detected body. Under replay every radar CSV also carries
  `timeline_velocity_mps`/`timeline_actor_id`, the same relative radial
  velocity computed from the timeline.
- **Collisions.** Contacts are the trace's events. CARLA reports no impulses in
  replay.
- **Motion blur.** It is off for every camera (`motion_blur_intensity 0`).
- **Moving props.** CARLA 0.10 ignores teleports of `static.prop.*` bodies, even
  with physics off, so a moving prop is respawned at each new pose
  (`propRespawns`).
- **Kerbs.** XODR elevation (height source `xodr-elevation/v1`) has no lane
  height, so bodies on kerb-raised sidewalks sit about one kerb height into
  the cooked sidewalk. The ground diagnostic reports it; `xodr-elevation/v2`
  (lane height) removes it.
- **Knockdowns.** A knocked-down pedestrian is laid on its right side
  (roll 90°) at its trace position. It is not laid face down, because pitch
  90° is UE's Euler singularity. It is a posture, not a ragdoll.

Measured on CARLA 0.10.0 (RTX 5080, 2026-09-22). A batched `ApplyTransform`
reads back within 4 µm. Radar Doppler of a kinematic body reads 0.
`set_target_velocity` and `set_wheel_steer_direction` have no effect with
physics off. On d9d7 (Richmond) the replay gate measured 13,013 samples at a
maximum of 4.7e-5 m / 1.0e-4°. Richmond's cooked mesh differs from the timeline
z by a median of 0 for vehicles (p95 0.39 m at kerbs and ramps), so no
per-map calibration is applied.

### Qualify a runtime

```sh
simforge-oss-carla-exec --host 127.0.0.1 --port 2000 pose-smoke --map Belmont_Office_Park_Belmont_CA
```

This runs a sensor-free scenario (a moving and a parked vehicle, a walking and
a standing pedestrian, three props) through trace replay, with the replay gate
and an attitude-convention probe. It exits 1 on any parity, ground or motion
failure. `--mode native-physics` runs the physics-validation path with its
pose gates (`SIMFORGE_CARLA_POSE_GATES`, `enforce` by default).

## Develop and verify

```sh
python3 -m pip install -e './adapters/carla-exec[dev]'
python3 -m pytest adapters/carla-exec/tests -q
```

The test corpus uses fake CARLA APIs, so it exercises the compiler, runtime,
failure handling, security boundaries, and deterministic evidence without a
GPU server. A real CARLA qualification remains a separate hardware acceptance
gate.

See `docs/carla-renderer-adapter.md` for the ownership boundary, capability
matrix, and real-runtime acceptance criteria.
