# CARLA renderer adapter and conformance plan

Status: public concrete backend and deterministic worker runtime implemented,
with dependency-free fake-CARLA conformance coverage, verified 2026-08-08.
This document uses upstream project documentation and repositories as primary
sources. Fake-backend conformance is not presented as a real GPU/CARLA
qualification run; the latter remains an explicit acceptance gate.

## Verified compatibility facts

- ASAM lists OpenSCENARIO XML **1.4.0**, released **2026-05-19**, as the
  current XML standard. The official deliverable and schema are linked from
  [ASAM's standard page](https://www.asam.net/standards/detail/openscenario-xml/)
  and the [1.4.0 publication](https://publications.pages.asam.net/standards/ASAM_OpenSCENARIO/ASAM_OpenSCENARIO_XML/v1.4.0/index.html).
- CARLA **0.10.0** is the Unreal Engine **5.5** line according to the
  [official release announcement](https://carla.org/2024/12/19/release-0.10.0/).
  CARLA also published **0.9.16** for the UE4.26 line, and GitHub currently
  marks it latest in the [official release listing](https://github.com/carla-simulator/carla/releases).
- The current ScenarioRunner release is **0.9.16**, paired with CARLA 0.9.16
  in its [official repository compatibility table](https://github.com/carla-simulator/scenario_runner).
  Its documented XML implementation is OpenSCENARIO **1.0**, with only a
  subset of actions, conditions, stories, and Storyboard implemented; the
  project explicitly directs users to its parser for the exact subset in
  [OpenSCENARIO support](https://github.com/carla-simulator/scenario_runner/blob/master/Docs/openscenario_support.md).
- The upstream ScenarioRunner pull request list shows
  [PR 1163](https://github.com/carla-simulator/scenario_runner/pull/1163),
  opened 2026-05-28 for CARLA 0.10.0/UE5 compatibility. An open compatibility
  PR is evidence of active work, not released support.

Therefore stock ScenarioRunner must not receive native SimForge XML 1.4 or
be treated as the authoritative runtime. A CARLA/UE plugin is also not the
starting point. The public Python API is sufficient to test the thin bridge;
consider a plugin only if exact custom-map signal or required asset bindings
cannot be exposed through that API.

## Architecture

> **Current code vs. this design (corrected 2026-09-22).** Steps 2 and 5 below
> describe the intended trace-authority bridge. What
> `adapters/carla-exec/simforge_oss_carla_exec/runtime` does today:
>
> - It does not run the SimForge evaluator. It compiles the execution package's
>   OpenSCENARIO 1.4 `trajectory-replay` document (`runtime/compiler.py`) into a
>   50 Hz plan (`STEP_SECONDS = 0.02`), with frames starting at t=0.
> - The execution mode defaults to `native-physics`. The local CLI hard-codes
>   it (`local.py`), and so does the backend default (`backend.py`). In that
>   mode the plan is authoritative only for walkers and props. Vehicles chase
>   it under CARLA physics (see "Motion, collisions, and determinism").
> - A cooked custom map is loaded **by name** (`identityMode:
>   "cooked-map-name"`). The runtime OpenDRIVE digest is recorded as
>   `xodrByteExact` in the map evidence, but a mismatch does not reject the
>   job. `generate_opendrive_world` is used only for uncooked maps, and only
>   with `SIMFORGE_CARLA_ALLOW_GENERATED_XODR=1`.
>
> The kinematic trace-replay design (physics off for every replayed actor,
> exact map digest) is being implemented as a separate workstream. Until it
> lands, read steps 2 and 5 as the target, not the behaviour.

The authoritative pipeline, as designed, is:

1. Validate the authored scenario and exact OpenDRIVE/controller/head bindings.
2. Compile once with the SimForge evaluator into an immutable 50 Hz trace
   plus actor lifecycle, event, signal, weather, light/siren, collision
   expectation, and provenance streams.
3. Hash the trace, complete XODR, catalogs/assets, bridge protocol, CARLA build,
   sensor configuration, and comparison thresholds.
4. Give those immutable inputs to the optional local CARLA CLI, or to a cloud
   adapter that imports the exact same public wheel. The browser never imports
   or controls CARLA.
5. The service loads the identical OpenDRIVE/custom-map package, configures one
   synchronous tick owner and a fixed 0.02 s delta, freezes native traffic-light
   cycling, resolves every actor/head exactly, and applies one authoritative
   frame per CARLA tick.
6. CARLA records actor state, lane/road projection, collisions, signals, RGB and
   requested sensors. The existing trace comparator consumes that external
   result using the same stable actor identities.
7. Independently, a ScenarioRunner 1.0 down-converter may run only when its
   feature gate says every required semantic is exact. Approximate or unknown
   mappings block native execution. Its result is compared to the same
   authoritative trace and never replaces it.

[CARLA's foundations documentation](https://carla.readthedocs.io/en/latest/foundations/)
requires synchronous mode plus `fixed_delta_seconds`; it also warns that only
one client should tick the server and that Traffic Manager must be synchronous.
The bridge owns that responsibility.

## Capability matrix

`Exact` means exact at the control-stream boundary. It does not claim CARLA
physics produced the motion. `Approximate` is always visible in evidence and is
blocking for the native ScenarioRunner gate.

| SimForge semantic | ScenarioRunner 1.0 | Trace-authority bridge | Notes / gate |
| --- | --- | --- | --- |
| Initial/final actor lifecycle | Approximate | Exact | Spawn/destroy on frame edge; catalog/blueprint binding must be unique. |
| World trajectory and heading | Approximate | Exact (walkers, props; vehicles only in `diagnostic-replay`) | Default `native-physics`: vehicles track the plan with CARLA throttle/brake/steer, so their pose is approximate; `diagnostic-replay` sets pose/velocity every fixed step. |
| Speed actions | Exact subset | Exact | Native only for parser-supported absolute-speed shape/dynamics. |
| Routes | Approximate | Exact result | Bridge replays compiled result; route identity remains provenance. |
| Lane changes / pull-over | Approximate | Exact result | Native dynamics cannot inherit trace-parity status. |
| Traffic head states | Unsupported for required fidelity | Exact | Freeze and address by OpenDRIVE ID; position is a cross-check, never ownership. |
| Controller programs / preemption | Unsupported | Exact result | SimForge evaluator owns stage/conflict semantics. |
| Flashing signal phases | Unsupported | Approximate | Schedule `Yellow/Red` and `Off` edges; CARLA has no flashing enum. |
| Vehicle indicators/headlights | Approximate | Exact where blueprint supports bits | Probe blueprint, record applied/read-back state. |
| Siren | Unsupported | Approximate | Require an allowlisted blueprint/component; never infer from emergency category. |
| Pedestrian trajectories | Approximate | Exact pose; approximate gait | Public walker control exists, but animation parity is not motion parity. |
| Static objects/custom props | Approximate | Exact only with catalog asset | Procedural/unbound props fail closed. |
| Weather | Approximate | Exact mapped fields | Reject unknown/unmapped weather fields. |
| Collision observation | Approximate | Exact observed edges | Collision sensors report frame/time/pair; unexpected/missing pairs fail comparison. |
| Stop-line behavior | Approximate | Exact result + observation | Authoritative trajectory and exact head state; verify lane/stop waypoint occupancy. |
| RGB/depth/segmentation/lidar/radar | Unsupported | Exact sensor invocation | Calibration and sensor tick are immutable inputs. |
| OpenDRIVE standalone geometry | Approximate | Exact XODR input | Runtime generation is possible; production visuals may require a packaged map. |
| Full custom visual map/assets | Unsupported | Exact if prepackaged | Package for the target CARLA build; XODR digest still must match. |
| Occlusion and rubric metrics | Unsupported | SimForge exact | CARLA sensors are supporting evidence, not a replacement evaluator. |

CARLA exposes manual signal state, global freezing, signal groups, stop/affected
lane waypoints, pole index, and `get_opendrive_id()` in its
[Python API](https://carla.readthedocs.io/en/latest/python_api/). These APIs make
exact-ID signal binding plausible, but every target CARLA/map build must pass a
binding inventory test before scenario execution. The exposed states are red,
yellow, green, off, and unknown; flashing is not native.

CARLA can generate a world from XODR through
[`generate_opendrive_world`](https://carla.readthedocs.io/en/latest/tuto_G_openstreetmap/).
That mode is useful for geometry conformance. A visually complete production
world needs the custom map's geometry/assets packaged for the selected engine;
the 0.9.15 custom-map documentation requires FBX plus XODR. UE5 ingestion must
be qualified on the actual 0.10 build rather than assumed from UE4 instructions.

CARLA documents RGB, depth, segmentation, lidar, radar and collision sensors in
its [sensor reference](https://carla.readthedocs.io/en/latest/ref_sensors/).
Collision events include frame, timestamp, actor, other actor, and impulse.
Vehicle/walker/light state and camera output can therefore be evidence outputs.

## Binding and control details

### Actors and assets

The manifest maps every canonical actor ID to exactly one allowlisted CARLA
blueprint plus dimensions and optional visual attributes. Before ticking, the
service verifies the blueprint exists and records its actual bounding box.
Dimension mismatch outside a declared tolerance blocks fidelity acceptance.
Pedestrians use stable IDs and record gait/animation as appearance metadata.
Props without a shipped asset binding fail before world mutation.

Vehicle light bits are applied and read back. A siren requires a specific,
tested asset contract because CARLA's generic vehicle light state is not a
portable emergency-audio interface. Unsupported sirens remain an explicit
rendering discrepancy even when the vehicle trajectory is exact.

### Signals and stop lines

Inventory all `TrafficLight` actors after map load. Bind `get_opendrive_id()` to
the exact authored physical-head ID and require one result. Group/pole index,
light boxes, positions, affected lanes, and stop waypoints are consistency
checks only. Duplicate, absent, stale-control-digest, or ambiguous bindings
reject the job. Freeze native cycling before applying the first frame. Record
requested and read-back state on every edge.

Flashing yellow/red is represented as scheduled state/off edges at a declared
frequency, marked approximate because CARLA has no flashing state and public
traffic behavior may interpret `Off` differently. Four-way-stop arbitration is
unsupported until explicitly implemented in SimForge; flashing red retains
the fail-safe label.

### Motion, collisions, and determinism

CARLA is a renderer of the scenario. The default execution mode is
`trace-replay`: kinematic replay of the canonical trace through the shared
render-timeline sampler (`docs/engineering/render-timeline.md`).

- Every replayed actor (vehicle, walker or prop) spawns at its sampled pose
  with physics off before the first tick. There is no settle phase, no nudging
  and no cooked-mesh raycast placement.
- Each tick, one batched `apply_batch_sync` sets every actor's transform
  (position, heading, pitch, roll) from `pose(timeline, actorId, t)`. The same
  batch feeds walker speed to the locomotion blend and target velocities.
  Lights and signal states come from the timeline, and only changes are
  written.
- After the tick, the observed transforms of every live body (one world
  snapshot) are compared with the sampler. The tolerances are 1 cm and 0.1°,
  with exact lifecycle and signal closure. The gate is **blocking**: a
  violation fails the job, `run-intent` exits non-zero, and the control plane
  refuses any trace-replay evidence whose recorded maxima exceed the limits
  (SimCloud migration `20260922150100`).
- Contacts are the trace's events. Replay attaches no collision sensors, and
  CARLA physics can never rewrite a pose.
- Time: plan `t = 0` is the clip start after the warm-up, and the warm-up is
  never rendered. Captures show exactly `k / fps`. Rates that divide 50 land on
  ticks. Other rates render on the nearest tick with the timeline sampled at
  the exact frame time (manifest `capture.policy`, per-frame `contentTimeS`).
- Map: the world is bound by the package XODR digest, never by name. See
  "Signals and stop lines" for signal identity.

`native-physics` survives only as the opt-in **physics validation** mode,
selected by an intent that asks for `actor.native_controls`. It drives
vehicles with throttle, brake and steer toward the trace. Walkers and props
stay kinematic (CARLA 0.10 props ignore post-spawn transforms, and
`WalkerControl` reaches about 5% of the commanded speed). Pose gates apply.
Its readback after the tick for frame `i` is compared with frame `i + 1`,
which is the state that tick produces. Its outputs carry `purpose:
physics-validation` and are never presented as the scenario's render.

Replay approximations (listed in every manifest under `approximations`):

- no suspension dynamics; body attitude is the timeline's road and
  acceleration pitch/roll;
- kinematic wheels do not spin or steer;
- walker gait is CARLA's speed-driven locomotion blend;
- CARLA radar velocity comes from physical velocity, so each radar CSV also
  carries the timeline Doppler (`timeline_velocity_mps`);
- no physical contact impulses;
- motion blur off;
- a moving prop is respawned per pose change.

Deterministic reruns require identical CARLA server/client builds, map/assets,
fixed delta, seeds, quality settings, sensor attributes, GPU/driver, and one tick
owner. Camera pixels may still vary across GPU/driver builds; numerical actor,
event and signal gates remain primary.

## ScenarioRunner compatibility exporter

The down-converter targets real OpenSCENARIO 1.0 and emits a per-feature report.
Before writing XML, derive required semantic identifiers and run the versioned
gate in `adapters/carla-exec/simforge_oss_carla_exec/capabilities.py`.
Unknown, unsupported, or approximate identifiers block execution. The initial
exact allowlist is intentionally tiny (for example, supported absolute speed).
Expand it only with an upstream parser mapping, an XSD-valid fixture, a real
ScenarioRunner execution, and comparator evidence.

No 1.4 document may be relabeled 1.0. No unsupported 1.4 construct may be
dropped. Trajectory baking is a different export profile with a different
verdict.

## Acceptance and evidence

> **Current code (corrected 2026-09-22).** The parity accumulator
> (`runtime/parity.py`) records two threshold sets:
>
> - the reference thresholds of the gate below (0.25 m / 2° / 0.25 m/s);
>   violations are reported as `expected-carla-physics` divergences;
> - acceptance thresholds of **2.0 m / 5° / 1.0 m/s**.
>
> Only a `native-physics` run is acceptance-eligible. The verdict
> (`accepted-native-physics`, `failed-native-physics` or `diagnostic-only`) is
> written to the manifest and the job result, and the parity report carries the
> verdict of each check. A failed verdict does not
> fail the render, and SimCloud treats parity as diagnostic only. What does
> fail a render is the pose gates (`SIMFORGE_CARLA_POSE_GATES=enforce`):
> displaced, floating or buried actors; kinematic actors that do not read
> back their pose; and vehicles that stall or go airborne.

For every required fixture, run at least three fresh reruns and retain immutable
receipts. The trace-replay gate (blocking, evaluated every tick against the
render-timeline sampler) is:

- position error, ground-contact z included, <= **1 cm** for every present body;
- heading, pitch and roll error <= **0.1 degrees**;
- presence exactly as the timeline says (spawn, despawn, dropped bodies fail);
- signal state exactly as the timeline says;
- identical actor/signal identity closure and an exact map binding (or an
  explicitly labelled approximate map);
- no missing sensor frame, and every capture labelled with the clip time it
  shows;
- byte-identical numerical report hashes across deterministic reruns (sensor
  media digests are separately scoped to a qualified hardware image).

The physics-validation mode keeps its own looser profile (2 m / 45° / 2 m/s
ceilings with a 0.25 m / 2° / 0.25 m/s reference band). It certifies nothing
about the scenario render.

Every result states CARLA/server/client versions, engine branch (UE4/UE5), map
and asset digests, GPU/driver, fixed step, seed, sensor configuration, bridge
revision, source trace digest, runtime duration, dropped sensor frames, and all
approximations. Missing output is failure, not zero error.

The ScenarioRunner 1.0 path additionally requires its feature gate to be all
exact and compares against the same thresholds. A green native run is
compatibility evidence only; SimForge remains the semantic authority.

## Deployment and hardware

Package the bridge as a separate Python service/container next to a pinned
CARLA server image. Mount immutable job inputs read-only; place outputs in a
bounded result volume. Do not accept browser-supplied paths, URLs, Python,
blueprint names outside the allowlist, or CARLA console commands. Enforce wall
time, output size, camera resolution/count, actor count, and sensor count.

The 0.10/UE5 path requires a modern supported OS and substantially more GPU
memory than headless numerical testing; exact hardware sizing depends on map,
resolution, Lumen/ray-tracing settings, sensor count, and target realtime
factor. Qualify representative workloads on the deployment hardware and report
median/p95 tick and sensor latency, GPU memory high-water mark, dropped frames,
and achieved simulation-to-wall-time ratio. Use CARLA no-rendering mode only for
control/conformance tests; camera acceptance necessarily enables rendering.

### Trace-replay qualification (CARLA 0.10.0 / UE5.5, RTX 5080, 2026-09-22)

The runs used the same server and image for both the rc.71 physics path and
trace replay.

| | rc.71 physics (before) | trace replay (after) |
|---|---|---|
| d9d7 Richmond, `run-intent`, 2 × 1280×720 @ 30 fps | vehicles up to 102 m / 105° from the sampler (p95 32 m); knocked-down pedestrian dropped; prop 13.7 cm below its timeline z; published although the verdict failed | 13,013 samples (vehicles, walker, prop) at a maximum of 4.7e-5 m / 1.0e-4°; map bound by approved cooked digest; `capture.policy` `sub-tick-sampled` |
| synthetic Belmont (`pose-smoke`) | pose gates pass; the moving car covers 30.61 m of a planned 30.00 m | 2,107 samples at a maximum of 2.3e-5 m / 3.4e-6°; the walker covers 8.40 m of 8.40 m with its gait animating |

Probes: batched teleport readback is within 4 µm. OSC pitch/roll map to CARLA
as −pitch and +roll. Physics-off bodies report zero velocity, so CARLA radar
Doppler reads 0 (hence the timeline Doppler column). Wheel-steer and
target-velocity commands are ignored with physics off. Prop teleports are
ignored with physics off. The cooked Belmont world re-serializes its XODR as
`a345d71d…`, which is now an approved digest.

## Implementation and qualification status

Implemented in the public wheel:

1. The concrete CARLA Python backend and synchronous fixed-step executor.
2. Exact actor, blueprint, signal, OpenDRIVE, and asset-catalog binding gates.
3. OpenSCENARIO 1.4 compilation and official-schema validation.
4. Lifecycle, pose/control, collision, signal, stop-line, appearance, camera,
   sensor-manifest, ambient-traffic, cancellation, and parity evidence.
5. Bounded downloads/uploads, redirect and SSRF controls, deadlines, retries,
   cleanup, and output-volume limits.
6. A local CLI and a versioned wheel that SimCloud consumes unchanged.

Still hardware- and asset-specific acceptance work, not shared source work:

1. Qualify the pinned UE5 CARLA build on representative GPU hardware and
   retain three immutable rerun receipts per required fixture.
2. Certify each packaged custom map and asset catalog against exact actor and
   OpenDRIVE signal inventories.
3. Expand an optional ScenarioRunner 1.0 down-converter only when every mapping
   is exact and independently evidenced. It never replaces the 1.4 compiler.
4. Consider a CARLA/UE plugin only if public API inventory proves an exact
   required map, signal, or custom-asset binding impossible.
