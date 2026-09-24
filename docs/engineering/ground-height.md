# Ground height: one surface for every body

Status: accepted 2026-09-22. This replaces the `xodr-elevation/v1` height
source of the render timeline (docs/engineering/render-timeline.md §4).

## The rule

Every consumer grounds bodies on one surface: the **rendered road and ground
mesh** of the map, baked at map ingest into the `derived/ground` derivative.
That covers the simulation, the render timeline, Bevy, CARLA, the editor and
drive mode. OpenDRIVE elevation is never a body height. At most it hints
which of several stacked decks a body spawns on.

A query that finds no surface is an error. Nothing answers `0`, a map datum,
a median or "the lowest thing there".

## Why the mesh and not OpenDRIVE

The cameras see the mesh, so a body that follows anything else floats or
sinks visibly. The two sources disagree on every map we ship. The figures
below come from lane centres every 0.5 m of road s on driving lanes only,
comparing the full OpenDRIVE surface with the rendered mesh:

| map | p95 \|dz\| | max | driving-lane samples over 5 cm |
|---|---|---|---|
| belmont-research-center | 48 cm | 93 cm | 34 % |
| easterbrook-discovery-school | 22 cm | 59 cm | 14 % |
| yale-street | 19 cm | 97 cm | 19 % |
| el-camino-road | 16 cm | 63 cm | 18 % |
| san-ramon-phase-2 | 13 cm | 101 cm | 14 % |
| richmond-field-station | 7 cm | 27 cm | 8 % |
| garching-phase-1-2 | 6 cm | 83 cm | 6 % |

The full OpenDRIVE surface includes elevation, superelevation, lateral
shape, laneOffset and laneHeight.

The retired evaluator (`xodr-elevation/v1`) reproduces the full OpenDRIVE
surface on driving lanes to within 2 mm. The disagreement is in the map
data: the XODR and the GLB of one RoadRunner export describe different
surfaces. Most of it sits in junction connecting roads. On Belmont it
covers whole roads (road 116: the XODR climbs from 2.78 m to 2.99 m while
the rendered asphalt is flat at 2.09 m).

`pnpm maps:ground` prints the per-road list for each map, and
`ground-report.json` records it.

## The derivative (`derived/ground/`)

| member | content |
|---|---|
| `ground-mesh.bin` | Surface triangles in xodr-local (x east, y north, z up) as integer millimetres, with a surface class per triangle. The byte layout is in `native/crates/simforge-core/src/map/ground.rs`. |
| `ground-manifest.json` | `simforge.map-ground.v1`: buildKey, builder fingerprint, source digests (master, buffers, xodr), `status`, `warnings`, and the mesh digest. |
| `ground-report.json` | OpenDRIVE validation: coverage, \|dz\| quantiles, flagged roads with their worst sample, holes. |

**Producer.** There is one producer,
`@simforge-oss/map-pipeline` `buildGroundDerivative`. The master stage runs
it by default (`SIMFORGE_MAP_GROUND=skip` opts out), and `pnpm maps:ground`
runs it for installed maps. `GROUND_FINGERPRINT` is folded into the master
stage key.

**Surface.** The surface is the upward-facing triangles of the asset-layer
meshes `Roads_{Road,Bridge,Gutter,Sidewalk,Uncategorized,Curb,Marking}`,
`Terrain_{Ground,Road,Marking}` and `Prop_Marking*`. Facing is taken from
the authored normals, or from the winding when a mesh has no normals.
- Kerb risers and the undersides of bridge structures are dropped.
- Marking decals that lie on another surface are dropped.
- Markings that cover a hole in the asphalt are kept.

**Gates.**
- The build **fails** when less than 97 % of driving-lane samples have a
  surface under them.
- OpenDRIVE disagreement does **not** fail the build, because the mesh is
  authoritative. Any road whose p95 \|dz\| exceeds 5 cm sets
  `status: "xodr-disagrees"`, and the map descriptor carries the warning.
  OpenDRIVE-derived grades are unreliable on such a map.

## Query semantics (`GroundSurface`)

- `surfaces_at(x, y)`: every distinct surface, highest first. A point within
  5 cm, horizontally, of a triangle is on it. This covers exporter seams,
  since layers are not welded.
- `contact(x, y, zRef, stepUp = 0.35 m)`: the highest surface no more than
  `stepUp` above the previous contact. It acts like a downward ray from just
  above the body, so a kerb is climbed and a deck overhead is never snapped
  onto.
- `nearest_surface(x, y, zHint)`: used at spawn only. `zHint` is the
  OpenDRIVE lane elevation, which is wrong by up to a metre but never by a
  storey.

All three are deterministic `f64` arithmetic over integer-millimetre
vertices. The TypeScript mirror in `packages/map-pipeline/src/ground/query.ts`
exists only for the ingest report.

## Consumers

| consumer | z / pitch / roll | notes |
|---|---|---|
| engine (native, WASM, Python) | `engine::contact` on `GroundSurface` every tick | `RunOptions.ground`; `MapAsset.attach_ground` / `MapBundle.attachGround(bytes)`; trace v5 `contact` + `header.groundDigest`; the map closure digest includes the ground |
| render timeline | copied from the trace, or derived with the same solver for older traces | `ground-contact/v1`, `contactOrigin`; `buildRenderTimeline({ground})`, WASM `RenderTimeline.buildOnGround`, Python `build_timeline(ground_mesh=)` |
| Bevy | the timeline pose; body attitude on the `body` node, `wheelDropM` on `wheel_*`. An actor with no authored height (xosc-lowered or editor frames) is placed on `GroundSurface` itself (scene X = x, Y = z, Z = -y): off the surface is `native_ground_height_unavailable`, two stacked decks `native_ground_height_ambiguous` | scene spec `groundMesh`; `hello.ground` reports `ground-mesh` + sha256 (the render engine and hifi preview refuse a mismatch) or `legacy-mesh-field`, which is recorded as the `native_ground_legacy_field` warning; the atmosphere anchors on `GroundSurface::median_z` |
| editor, drive mode | the engine's contact (session snapshots carry `contact`; the drive's truth frames carry `actors[].contact`) | map descriptor `ground` (member + ingest status); a body with no known height is held back and listed (`placingActorIds`), never drawn at 0 |
| CARLA | the timeline pose | unchanged path |

Map versions published before the ground derivative keep simulating without
contact (their pins and simulation keys are unchanged); their timelines are
labelled `legacy-xodr-elevation`.

## Map colliders have heights

Engine 0.12.0. The static-collider artifact (`simforge.static-map-colliders/v2`,
`3d/variants/static-colliders-v2.json`) publishes each collider's vertical
extent, and a grounded body meets a map collider only where their vertical
spans overlap. Before it, a collider was a 2D footprint standing at full
height, so on San Ramon P1 a sedan crossing junction 5249 under a signal
head hanging from a mast arm (`Signal_3Light_Post01`, node 999) was
crash-disabled by it.

- **Ingest** (`@simforge-oss/maps` `buildStaticColliderArtifact`, given the
  map's ground surface): every collider carries `vertical: {minY, maxY}` in
  the scene frame (y up), the ground mesh's datum. A fixture is dropped as
  overhead (`statistics.rejectedOverhead`) when, at every sample of its
  footprint (1 m grid), each ground surface there lies either above its top (a
  deck over its own girders) or at least `OVERHEAD_CLEARANCE_M` = 4.6 m below
  its bottom. US legal vehicle height tops out at 4.27 m and MUTCD puts
  overhead signal heads at 4.6 m or higher. A footprint with no surface under
  it is not classified. On San Ramon P1 this drops 417 fixtures (luminaire
  heads and arms, mast-arm signal heads, signal mast arms); pole-mounted heads
  3.7-4.5 m up stay. Without a ground surface (uploaded maps, editor
  derivatives) nothing is classified and `overheadClearanceM` is `null`.
- **Engine**: a body's span runs from its ground contact `z` to `z + dims.h`,
  widened by `L/2·sin|pitch| + W/2·sin|roll|`. Collision detection, the contact
  solver (dynamic body against map collider) and ego line of sight (a collider
  outside the band both bodies span cannot block it) all test it.
  Body/body contact stays planar. Detection runs before the tick's contact
  update, so it reads the previous tick's contact; a body on its first tick
  gets the contact about to be computed.
- **Without ground** the extents cannot be used: every collider stands at full
  height and the run reports `static_collider_heights_unused` (a warning).
- **v1 artifacts** (no extents) load unchanged with full-height semantics, and
  their closure digest is unchanged (an absent extent is not serialized).
- The SUMO handoff world is planar (its bodies carry no contact); it relies on
  the ingest classification.

A map version whose collider artifact moves to v2 is a new map version: the
artifact is a simulation member (`SIMULATION_MAP_MEMBERS`).

## Rollout

1. Derivative, Rust surface, ingest gates, the Richmond fixture: done.
2. Engine contact, trace v5, ENGINE_SEM_VER 0.11.0, goldens: done.
3. Timeline sampler/2 with the body-node split, two-wheeler lean and
   `wheelSpinRad`: done.
4. Bindings, TS closure loading, `SIMULATION_MAP_MEMBERS`, Bevy
   articulation: done. Editor and drive-mode presentation of engine contact
   and removal of the viewer's `?? 0` height paths: next.
5. New map versions carrying `derived/ground` (with the refitted XODRs) on
   dev; a render contact gate: done in code (`render_contact_gate_failed`),
   the Bevy service places on the same surface (`groundMesh`). Map versions
   are next.
