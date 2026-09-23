# Native sensor suite — class taxonomy, legend, and conventions

WSB3 reference for the semantic-class pass, instance-ID pass, lidar
intensity proxy, and frame conventions. Code: `renderer/sensors/src/taxonomy.rs`.

## Semantic classes (closed set)

Carried in the BLUE channel of the shared aux (instance-ID) render — one
unlit RGBA8 pass per camera (`Tonemapping::None`, black clear, neutral
EV100 exposure); instance id low bytes in R/G. Bevy's opaque materials
force alpha to 1.0 and default camera exposure (~1/39321) crushes small
unlit values, hence blue + neutral exposure. The emitted
`00000000.semantic.png` re-encodes the class id into its red channel.
Background/sky = 0.

| ID | Class      | Source                                                        |
|----|------------|---------------------------------------------------------------|
| 0  | unlabeled  | background / sky                                              |
| 1  | road       | static mesh names matching road/asphalt/sidewalk/curb/ground/pavement/crosswalk/marking |
| 2  | building   | static mesh names containing "building"                       |
| 3  | vegetation | mesh names containing tree/veg/bush/shrub/plant/foliage/grass/hedge |
| 4  | car        | scenario-model actor class `car`                              |
| 5  | truck      | actor class `truck`; scenario `kind: bus` folds into truck    |
| 6  | pedestrian | actor class `pedestrian`                                      |
| 7  | cyclist    | actor class `cyclist`                                         |
| 8  | prop       | any other prop-catalog static                                 |

Matching order for statics: vegetation before building before road keywords,
fallback `prop`.

## Instance IDs

Per-scene, deterministic, independent of process/ECS entity ids:

1. every rendered mesh entity (static tiles + actor cuboids) gets a name:
   its GLB node name, or `actor:<actorId>` for scene-state actors;
2. entities are sorted by `(name, world-space triangle-centroid bits)`;
3. ids are assigned 1-based in that order; 0 = background.

Duplicate mesh names (instanced geometry) are disambiguated by position, so
the assignment is byte-stable across processes. The mapping is written to
`legend.json` per capture (`schema: uniscenarios.sensor-legend/v1`, sorted by
id), alongside per-instance semantic classes.

## Lidar intensity proxy

`intensity = albedo(class) × (0.25 + 0.75 × |cos incidence|)`, clamped to
[0, 1] — a deterministic stand-in for reflectivity, not a calibrated model.
Class albedos: road 0.25, building 0.45, vegetation 0.55, car 0.70,
truck/bus 0.65, pedestrian/cyclist 0.60, prop 0.50, unlabeled 0.

## Beam / fan conventions

- Sensor-local frame: **+X forward, +Y up, +Z lateral (camera-right at
  identity heading)**. Source dimensions are length/width/height; Bevy XYZ
  extents are length/height/width. The shared typed conversion is
  `render_core::coordinates::source_to_bevy`. Bevy camera optical forward is
  -Z, and only the camera basis adds that conversion.
- Mounts still use the qualified `prontoRig` lowering (pod datum 0.85 m
  forward / plate 1.78 m up). No mount signs or imported glTF geometry are
  remirrored to match prose. Earlier versions of this document called +Z
  “left”; that contradicted the actual camera basis.
- Lidar XYZ is **local to the sensor**, not a world-oriented offset:
  `sensor_from_world * (hit_world - sensor_origin)`. Both CPU and GPU outputs
  now apply the inverse sensor rotation. Earlier artifacts omitted that
  inverse: their ranges could agree while their XYZ orientation was wrong.
- Lidar azimuth 0 = sensor forward, positive toward +Z; elevation
  positive up; channels span [-vfov/2, +vfov/2]; one scan = one revolution at
  azimuth step 0; steps/rev = points_per_second / (channels × rotation_hz).
- Radar azimuth positive toward +Z, altitude positive-up; velocity is the relative
  radial component along the beam (target − host).
- World frame = tile GLB frame: x = map x, z = −map y, y up. GNSS inverts the
  map's OpenDRIVE `+proj=tmerc geoReference` (local origin at lat_0/lon_0).
- Actor identity is resolved from the first document frame before sampling.
  The full bounded source interval, not only rendered timestamps, defines the
  actor registry and dense IMU/GNSS history. Late actors retain their declared
  class; changing row order never moves the rig to another actor.
- Old outputs involving non-host vehicles or rotated lidar must be regenerated:
  actor proxy length/width axes were swapped, and lidar XYZ was world-oriented.
  A post-hoc point rotation cannot repair incorrect proxy geometry or classes.

## Ray–triangle contract (lidar and radar)

Both backends (CPU `bvh::InstancedScene::cast`, RT-core `gpu_rays`) return
the same bytes; the contract they share:

- First hit = smallest `t` of f32 Möller–Trumbore on the world-space
  triangle (`Mat4::transform_point3` of the local vertices), `EPS = 1e-9`.
- **Grazing cut:** a hit is rejected when the beam is within about **2.9°**
  of the surface plane (`|cos(incidence)| < MIN_INCIDENCE_COS = 0.05`,
  tested as `det² < 0.05² · |e1×e2|² · |dir|²`). Near grazing, f32
  cancellation accepted beams that miss the triangle by centimetres to
  metres ("ghost" returns); a physical lidar returns essentially nothing
  there and the intensity proxy is already at its floor. Adopted as the
  reference in rc.75 (goldens re-recorded once).
- Ties on exact `t`: smallest `(instance_id, triangle index, instance
  insertion order)`; an actor hit replaces a static one only when strictly
  nearer. Static instances are inserted by `(instance_id, mesh asset label)`.
- Parity gate: `sensors/tests/gpu_rays_parity.rs` (bit-identical on RTX
  5080 and 3080) and `lidarBackend: "verify"` per scan in production.

## Output formats (CARLA-path parity)

- lidar → ASCII PLY (`x,y,z,intensity` float properties + one extra declared
  `uint instance_id`); parses with carla-bridge `sensor_video._read_lidar_points`.
- radar → CSV header `depth_m,azimuth_rad,altitude_rad,velocity_mps`, rows
  `%.9g`-style — byte-compatible with `_write_radar_csv`.
- IMU/GNSS → JSONL (`imu.jsonl`, `gnss.jsonl`).

## Interim notes

- Actor meshes are cuboids sized per actor class until WSB2's prop-catalog
  actor pipeline lands in render-core; sensor math/determinism unaffected.
- RGB uses AgX tonemapping with fixed sun+ambient (sensor profile baseline);
  WSB4's lighting stack supersedes this when wired.
