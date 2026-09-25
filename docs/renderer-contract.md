# Renderer contract v1 (`simforge.renderer-contract/v1`)

The renderer-neutral boundary between SimForge scene/session state and any
concrete renderer. It freezes the *shapes* that cross the boundary (camera
commands, actor frame batches, light state, picks, schedules, map
publications, semantic legends, artifact provenance) without prescribing any
renderer's internals.

The frozen reference is the parity fixture
`fixtures/renderer-contract/basic-intersection.v1.json`
(`simforge.renderer-parity-fixture/v1`) together with this document. The
native renderer's conformance lives in `renderer/render-core/src/fixture.rs`
and `actor_lights.rs`, checked by `renderer/render-core/tests/parity_fixture.rs`
(`cargo test -p render-core --test parity_fixture`, CPU only) and by
`simforge-render dev parity-check --fixture <fixture>`. The viewport
protocol's picks use the same layers (`renderer/viewport/PROTOCOL.md`).
Browser viewers (the hosted app's) conform to the same fixture through their
own adapters.

### Native playback readiness

`simforge-render job --job` (a `simforge.render-job/v2` job with a
`sceneState`) loads the complete native `master.gltf` from a `simforge maps pull`,
including its external textures. Playback waits for recursive asset
dependencies and for the shared GPU-readiness barrier (material bindings
and compiled pipelines) before counting warmup frames or capturing tick 0.
Missing or failed map dependencies are fatal; partial maps are not successful
captures. Large masters may require a higher process file-descriptor limit
(for example, `ulimit -n 65535`) while loading their texture closure.

`simforge-render serve` becomes ready as soon as the map is prewarmed. The
CPU raycast scenes that lidar, radar and episode road checks need (a BVH
over every map triangle, plus a road-only BVH) are built on the first
request that needs them, never at startup, and in parallel. An RGB-only render never pays for them. On belmont (266 M map
triangles) building them at startup delayed readiness from ~25 s to ~220 s,
past a 300 s readiness budget on slower hosts.

The standalone binary embeds its motion-vector shader, so deployment does
not require the source checkout at the original build path.

Playback places ground-contact actors and the chase camera using the native
scene engine's terrain-height field. A scene's `groundY` explicitly
overrides that with a constant elevation for flat fixtures. Each captured RGB frame has a
corresponding `observed-frames.jsonl` record containing the rendered actor
and camera world transforms; these are observations, not echoed input poses.

## Frozen wire identifiers

`simforge.scene-state.v1` and `uniscenario.static-semantics/v1` are referenced
byte-identically by every renderer (`docs/engineering/scene-state-v1.md`).
Identifiers introduced by this contract likewise use the `simforge.` prefix:

- `simforge.renderer-contract/v1` — the contract version.
- `simforge.renderer-parity-fixture/v1` — the fixture document version.

## Contract surface

All coordinates are the y-up scene frame of scene-state.v1; metres, radians,
seconds. Matrices are 16 numbers, **column-major** (Three `Matrix4.elements`
order); row-major consumers own the transpose.

### Camera / view commands — `CameraCommand`, `CameraStateReport`

- `set-pose` — eye/target (+optional up).
- `set-intrinsics` — vertical FoV (deg), aspect, near, far. Pixel-focal
  consumers derive `fy = h / (2·tan(fovY/2))`, `fx = fy`, centred principal
  point.
- `frame` — explicit bounding sphere; the resulting pose is **normative**
  (`frameCameraPose`: fit the sphere in the smaller frustum axis, 15% pad,
  default azimuth π/4, elevation π/5) so framing is matrix-identical across
  renderers.
- `follow` — attachment (`actor` / `traffic-signal` / `map-feature`) +
  `chase`/`dash` mode; actor poses are normative (`followCameraPose`).
- `set-constraints-enabled` — sensor rigs temporarily own the exact eye below
  editor navigation limits.

`CameraStateReport` returns pose, intrinsics, view matrix (world→camera) and
projection matrix (GL depth convention, [-1, 1]).

### Actor frame batches — `ActorFrameBatch`, `ActorRenderState`

`ActorRenderState`: id, catalogId, ground-contact x/y/z, `headingRad` (CCW
from +X about +Y), dims, plus articulation/cue channels (doors, reversing,
emergency, indicator, headlights, bodyColor, animationTimeS, speedMps,
downProgress).

Batch semantics are **idempotent replace-all per layer** (`editor`,
`sumo-traffic`, renderer-local ids): the renderer draws exactly the batch. Spawn/despawn is carried explicitly by
scene-state.v1 tick records; `actorRenderStateFromSceneState` is the
normative mapping from a scene-state actor tick (+ playback cues) to a
render state (`speedMps = |velocity|`, `animationTimeS = frame.t`).

### Light state — `LightStateReport`, `deriveVehicleLightStates`

Deterministic, renderer-portable rules (pinned by the fixture's
`expectedLights`; `actor_lights::derive_vehicle_light_states` in the native
renderer):

- Low beams: explicit per-actor `headlights` wins; otherwise the
  environment-driven global default (authored darkness). Emissive lenses are
  unbounded.
- Projected beams: at most `PROJECTED_HEADLIGHT_LIMIT = 8` real lights,
  chosen by ascending actor id.
- Street luminaires: bounded nearest-camera pool,
  `STREET_LUMINAIRE_ACTIVE_LIMIT = 12`.
- Emergency (`flashing`/`flashing_siren`), indicators
  (`left`/`right`/`hazard`), reverse panel: direct functions of the actor
  state.

### Picking — `PickRequest` → `PickResult`

Requests are NDC (+y up) against declared layers (`actors`, `ground`,
`map-static`). Hits are **id-based**: stable actor id or semantic instance
id, distance in metres, world-space point, optional semantic classification.
No renderer scene-graph object ever crosses the boundary.
Light/cue volumes (low-beam lenses, emergency strobes, reverse panels) are
not selection targets.

### Fixed-step render schedule — `RenderSchedule`

`tickHz`, `startTick`, `frameCount`, exact backing-buffer size, pixel ratio
pinned to 1. `scheduleTimestampsMicros` yields the exact integer-microsecond
timestamps (WebCodecs/WebM timebase). A conforming renderer presents exactly
`frameCount` frames at these timestamps; a browser recorder's capture
manifest and a native render job share this schedule.

### Map publication — `MapPublicationDescriptor`

Manifest URL + `cacheVersion` (first 16 hex of sha256(manifest bytes) — the
existing asset-cache identity), schema version, optional full digest, static
semantics sidecar reference (`uniscenario.static-semantics/v1`), optional
asset variant. Browser renderers stream it; native renderers receive the same
publication resolved to absolute payloads. Identity is the digest, never a
mutable URL.

### Semantic legend — `SemanticLegend`

Static classes (the ten `uniscenario.static-semantics/v1` classes) and
scene-state actor classes are restated and pinned by test. Static instance
ids come from the published sidecar; actor instance ids are assigned
`1 + index` in ascending actor-id order (`actorInstanceLegend`) so ID passes
agree across renderers.

### Artifact provenance — `ArtifactProvenance`

Renderer identity (`three-webgl` / `three-webgpu` / `bevy-native`, version,
backend, device) plus input digests (scene-state, XODR, map cache version,
schedule) and a **determinism class**: `schedule-and-structure` (exact
schedule, container layout, ids, digests) or `byte-identical-pixels`.
Cross-GPU browser artifacts must claim `schedule-and-structure`; matching
input digests never imply pixel parity.

## Parity fixtures

`fixtures/renderer-contract/*.json`
(`simforge.renderer-parity-fixture/v1`). Given the embedded scene-state.v1
document at tick `T` (+ playback cues + darkness default), a conforming
renderer must reproduce:

| Expectation | Tolerance |
|---|---|
| Camera view/projection matrices per camera case | abs ≤ `1e-6` per element |
| Actor body world transforms (position + yaw + dims/template scale, incl. gait offsets at `animationTimeS`) | abs ≤ `1e-6` per element |
| Vehicle light-on states + street-light pool config | exact |
| Semantic legend (classes, actor instance ids) | exact |
| Pick results (actor id per NDC ray; hit distance) | id exact; distance abs ≤ `1e-4` m |
| Schedule timestamps (µs) | exact integers |

Tolerances are f64-math tolerances, not pixel tolerances: the fixture pins
scene semantics, never GPU output. An *intentional* behaviour change updates
the fixture and every conforming renderer in step.
