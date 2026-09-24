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
closes with render-artifact-manifest/v1. `--control-features` passes the
lease's `controlFeatures` (comma-separated); newer manifest fields, such as
`substitutions` (`render-evidence.substitutions`), are written only when listed.

`renderSpec.clip` may name part of the authored clip, as it does for the native
engine: output frame `k` shows clip time `startSeconds + k / fps`, so a
sub-clip's frames are the corresponding frames of the full-clip render. The
ticks before a later window are a pre-roll, replayed but neither captured nor
graded, so camera exposure, temporal filtering and streamed geometry reach the
window start exactly as in the full render (spawning at the start pose alone
renders visibly different first frames). The window is recorded in the render
manifest (`renderWindow`). A window CARLA cannot render exactly is refused before CARLA
is contacted, never widened to the full clip: `carla_clip_outside_scenario`
(ends after the authored clip), `carla_clip_frame_count_fractional` (the window
is not a whole number of frames), `carla_clip_too_short`, and
`carla_clip_physics_validation_partial` (physics validation integrates and
grades the whole authored clip, so it renders only that).

### No silent fallbacks

Missing, failed or unsupported data never silently degrades a render
(`docs/engineering/no-silent-fallbacks.md`). The render fails with a
`carla_*` code; `run-intent` then prints one
`simforge.carla-render-failure/v1` JSON line (`code`, `message`,
`retryable: false`) and exits 3, and every message starts with
`[carla_<code>] `. Every other deterministic refusal (an intent, input
package or lease that violates its contract) takes the same exit as
`carla_render_contract_violation`, so the worker never retries it. Exit 1 is
left to unexpected crashes, which the worker reports with the scrubbed tail of
stderr. The only substitution CARLA makes is `carla-actor-body`, and
only when the intent's `allowSubstitutions` lists it and the lease can record
it (else `carla_substitutions_unreportable`): each one is written to the
manifest's `substitutions` and announced as a `carla.substitution.*` warning.

Worker settings that used to change the output are refused
(`carla_forbidden_worker_config`): `SIMFORGE_CARLA_ALLOW_GENERATED_XODR`,
`SIMFORGE_CARLA_MAP_BINDING` other than `exact`,
`SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON` and `SIMFORGE_CARLA_SIGNAL_ID_MAP`.

Set `SIMFORGE_CARLA_COOKED_MAPS_JSON` to a JSON map of cooked map names to
their source XODR SHA-256 values; a digest or loaded-world identity mismatch is
fatal, and a map without a cooked world fails `carla_map_not_cooked`.
`SIMFORGE_SENSOR_WRITER_WORKERS` bounds
parallel streaming writers. Set `SIMFORGE_PRESENTATION_VIDEO_ENCODER=nvidia`
to request `h264_nvenc` for the per-camera streaming encoders (default
`software` = libx264). Camera frames stream directly into one H.264 MP4 per
camera and never persist to disk; PLY/CSV frames remain the canonical output
for lidar and radar measurement data.

The CARLA image a render ran on is configuration, never assumed by the adapter
(see "Bring your own CARLA 0.10" below). Sensors attach to the authored host actor after its catalog binding is resolved.
An actor renders its catalog body when the binding is the authored body
(`fidelity` `exact` or `native-blueprint`) and, once the world is loaded, the
runtime is observed to place it. Otherwise (a generated body, a
`semantic-substitute` binding, a body the image does not ship) the render fails
`carla_blueprint_unavailable` unless the intent allows `carla-actor-body`; then
a road user takes the dimensionally nearest placeable body of its own
`actorClass` (never across classes) and the substitution is recorded. Parent
readback verifies the resolved actor identity without imposing a
model-specific host.

## Bring your own CARLA 0.10

The adapter ships no CARLA server and names no CARLA image. You install and run
CARLA yourself; the adapter only connects to it.

1. **Install CARLA 0.10.0** (the Unreal Engine 5.5 build) from the CARLA
   project's release packages, or build it from source, or use a container you
   maintain. Other CARLA versions are not supported: the replay, sensor and
   world-binding behaviour documented here is measured on 0.10.0.
2. **Install the matching Python client** from that same build (its
   `PythonAPI/carla/dist/carla-0.10.0-*.whl`) into the environment that runs
   `simforge-oss-carla-exec`. The client/server pair is part of execution
   provenance, so the package does not depend on a `carla` release from PyPI.
3. **Start the server**, headless for rendering:

   ```sh
   ./CarlaUnreal.sh -RenderOffScreen -carla-rpc-port=2000
   ```

4. **Point the adapter at it** with the global `--host`/`--port` options
   (default `127.0.0.1:2000`), then check it:

   ```sh
   simforge-oss-carla-exec --host 127.0.0.1 --port 2000 probe        # read-only
   simforge-oss-carla-exec --host 127.0.0.1 --port 2000 probe-ticks  # tick barrier
   ```

To run the adapter in a container on top of your CARLA image, build this
package's `Dockerfile` with the required `CARLA_BASE_IMAGE` build argument
(there is no default base; the file lists what the base must contain).

### Runtime image identity: user-provided, pinned, managed

Every render records the image it ran on in `runtimeEvidence.runtimeImage`,
and `probe` reports it as `runtimeImage`. The identity comes only from the
environment, read once when the process starts:

| Variable | Value |
|---|---|
| `SIMFORGE_CARLA_RUNTIME_IMAGE` | `<repository>@sha256:<64 hex>`: the pinned image and its linux/amd64 manifest digest |
| `SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST` | optional `sha256:<64 hex>`: the OCI index digest of that image |
| `SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256` | optional `<64 hex>`: the manifest the running image attests it is (baked into the image) |
| `SIMFORGE_MANAGED_EXECUTION` | `1` for hosted (managed) execution |

- **User-provided (nothing set).** This is the normal bring-your-own case. The
  record says so: `repository`, `indexSha256` and `linuxAmd64ManifestSha256`
  are `null`, `exact` is `false` and `provenance` is `"user-provided"`. Renders
  run normally; the evidence simply does not claim an image nobody named.
- **Pinned.** The record carries the configured repository and digests.
  `exact` is `true` only when `SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256` equals the
  pinned manifest digest.
- **Managed (`SIMFORGE_MANAGED_EXECUTION=1`).** The pin is mandatory. Without
  it every command refuses to start, before CARLA is contacted, with
  `carla_runtime_image_unconfigured` (the `simforge.carla-render-failure/v1`
  line, exit 3). A render whose attested manifest is not the pin fails.

Half a pin (an index digest or an attested manifest without
`SIMFORGE_CARLA_RUNTIME_IMAGE`) also fails `carla_runtime_image_unconfigured`,
and a malformed value fails `carla_runtime_image_malformed`: a misconfigured
deployment is never reported as a user-provided server.

### Worlds and maps on your CARLA

A render is bound to a CARLA world by the XODR digest of its package, never by
name (see "Height and map binding"). On your own server:

- The world must be **cooked into your CARLA build** (for example a RoadRunner
  export imported and packaged with CARLA's map tools), with its OpenDRIVE at
  `CarlaUnreal/Content/Carla/Maps/OpenDrive/<World>.xodr`. There is no world
  generated from a bare OpenDRIVE file.
- Tell the adapter which cooked world serves which source XODR with
  `SIMFORGE_CARLA_COOKED_MAPS_JSON` (`{"<World>": "<sha256 of the source XODR>"}`).
  The loaded world's `to_opendrive()` must be byte-identical to that XODR, or be
  an approved re-serialization listed in `SIMFORGE_CARLA_APPROVED_COOKED_XODR_JSON`.
  A map without a cooked world fails `carla_map_not_cooked`.
- The checked-in world manifest (below) binds the worlds cooked for the hosted
  platform. Those worlds are not distributed with this package; on a server
  that does not ship them the render fails instead of loading another world.
- The bundled sensor rigs (`run-local`, `preflight-intent`) mount on
  `vehicle.kia.carnival`, which a stock CARLA 0.10.0 build does not ship. On
  such a server the preflight fails and a render fails
  `carla_blueprint_unavailable` unless the intent allows the recorded
  `carla-actor-body` substitution.

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
  is never the scenario's render. A render intent opts in by *requiring* the
  `actor.native_controls` capability (preferring it fails
  `carla_capability_preference_unsupported`). An actor physics validation
  cannot place at its authored pose, or cannot execute (knockdowns, cues,
  reversing non-vehicles, moving statics), fails the job; nothing is nudged or
  dropped. `diagnostic-replay` is the historical name of `trace-replay`.

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
per-map offset (`MAP_Z_CALIBRATION_M`, keyed by XODR sha256) is applied and
recorded when the cooked world floats or sinks bodies.

The world is bound by XODR digest, never by name. The package XODR selects the
cooked world. The runtime's `to_opendrive()` must then be byte-identical to
the package XODR or an approved cooked re-serialization of it
(`APPROVED_COOKED_XODR_DIGESTS`, `SIMFORGE_CARLA_APPROVED_COOKED_XODR_JSON`).
Anything else fails `carla_map_digest_mismatch`. There is no approximate
binding and no world generated from the bare OpenDRIVE.

### Environment

A cooked RoadRunner world reports `is_weather_enabled()` false: its sun, sky
and weather are baked at cook time and `set_weather` cannot change them. Such
a world renders a request only if it equals the world's registered baked
environment (`COOKED_MAP_BAKED_ENVIRONMENTS`, measured per cooked level);
anything else fails `carla_environment_unsupported_on_cooked_map`. A world
with weather applies the request and reads it back. The authored environment
must state `weather` and `timeOfDay`; `night_lit` and an authored
(corridor-relative) `sunAzimuthDeg` fail.

### Actors and sensors

- An actor CARLA refuses to spawn fails `carla_actor_spawn_refused`; every
  plan actor is expected by the replay gate.
- A walking walker (timeline speed above 0.3 m/s) must move its legs:
  `get_bones()` is sampled every 5 ticks until a leg bone rotates 2°, and a
  frozen or T-posed gait fails `carla_walker_animation_inactive`
  (`runtimeEvidence.walkerAnimation`).
- Each lidar capture holds one full revolution, assembled from the tick
  sectors ending at the capture tick (`sweep` metadata); a revolution must
  span whole ticks (`carla_lidar_schedule_unsupported`). Drop-off and noise
  are set to zero and every sensor attribute is read back and recorded.
- Every camera must ask for the render fps (`carla_camera_fps_mismatch`), the
  video size is the primary camera's (`carla_video_size_mismatch`), and
  `lossless` fails `carla_video_quality_unsupported`.
- Materialized ambient traffic actors fail `carla_ambient_traffic_unsupported`
  (the format carries no elevation, attitude or body).

### The CARLA world manifest

Which source map renders in which cooked world is not typed by hand. It lives in
`simforge_oss_carla_exec/assets/carla-world-manifest.json`, GENERATED from three
read-only inputs: the RoadRunner source exports (one GLB + XODR folder per map),
the cooked engine image, and the SimForge map registry per environment (exported
by the hosted platform). The manifest records the cooked engine by content (image
id, engine binary digest and CARLA/UE revisions), not by registry reference.

```bash
python -m simforge_oss_carla_exec.world_manifest_tools collect-nas --ssh <exports-host> --sudo \
  --root <exports>/GLB_Map_Export --inputs build/wm
python -m simforge_oss_carla_exec.world_manifest_tools collect-cooked --ssh <gpu-host> \
  --container <running-cook-container> --image <your-cooked-carla-image> --inputs build/wm
# the map registry export from the hosted platform -> build/wm/simforge-<env>.json
python -m simforge_oss_carla_exec.world_manifest_tools generate --inputs build/wm   # --check in CI
python -m simforge_oss_carla_exec.world_manifest_tools derive --format summary|env|json
```

Each source is matched to the cooked world with the same geoReference and header
extent, then the road networks are compared road by road (paired by sampled
reference line, not by id; 1 cm / 0.1° tolerance, the replay parity gate), with
lanes, elevation, topology, signals and controllers. The status is derived:
`exact`, `approved-equivalent` (same roads; renumbered ids get a recorded signal
id map, other differences are listed), `needs-decision` (e.g. the export dropped
the signal controllers the world was cooked with), `needs-recook`, `no-world`.
Only the first two bind. `COOKED_MAP_NAMES_BY_XODR_SHA256`,
`APPROVED_COOKED_XODR_DIGESTS` and `COOKED_SIGNAL_ID_MAPS` are derived from the
manifest, and a source the manifest marks unbound is refused with the manifest's
reason before CARLA is touched, whatever the env or binding policy says. Human
rulings go in `world_manifest_tools/decisions.json` (who, when, which exact
`decisionRequired` items were accepted). Bindings approved before the manifest
existed are kept verbatim under `legacySources`.

A derived export tree (`collect-nas --derived --root .../GLB_Map_Export_corrected`)
adds `derived/<folder>` entries. An elevation-only refit (its report names the
original by sha256, and the XODR without elevationProfile, lateralProfile and lane
`<height>` is byte-identical to the original's) inherits the original's world,
runtime digest and signal maps once `decisions.json` accepts its exact decision
item, which states the measured elevation change. Anything else is a new network.

`assets/carla-actor-bindings.json` (`world_manifest_tools actor-bindings`) is the
renderer's catalog-id -> CARLA blueprint table, generated from the hosted
platform's carla-object-catalog.json and the renderer-parity carla-substitutions.json. A
catalog entry without its own CARLA binding resolves through it; an entry with no
binding fails by name (carla_blueprint_unavailable) unless the intent allows the
recorded carla-actor-body substitution. Its sha256 is in every manifest.

### What replay approximates

The manifest lists these under `approximations`:

- **Suspension.** There are no suspension dynamics. Body attitude is the
  timeline's road and acceleration pitch/roll, and packages without a timeline
  carry none (level bodies).
- **Wheels.** Kinematic vehicles' wheels neither spin nor steer.
- **Walker gait.** Speed is fed to CARLA's locomotion blend
  (`ApplyWalkerControl` plus the target velocity) while the body is posed
  exactly. It is CARLA's gait, not a replayed skeleton, and a walking walker
  whose legs do not move fails the render.
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
