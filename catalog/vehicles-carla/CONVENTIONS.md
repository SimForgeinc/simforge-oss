# SimForge CARLA vehicle models — conventions

38 CC BY 4.0 vehicle GLBs converted from CARLA Simulator content. Machine-readable
metadata lives in `manifest.json`; per-asset licensing in `ATTRIBUTION.json`.

## Where the model bytes live

The GLBs are not in git. This pack is one content-addressed closure
(`simforge.actor-assets-closure/v1`): `closure.json` here lists every member
(`models/*.glb`, `ATTRIBUTION.json`, `catalog-models.json`, `manifest.json`)
by sha256 and size, and `../closures.lock.json` pins the document's own sha256.
The bytes are served by digest from the public asset CDN
(`<origin>/actor-assets/blobs/sha256/<aa>/<sha256>`), and `ATTRIBUTION.json`
travels inside the closure with the models.

- Fetch the pack (verified, cached): `node scripts/actor-assets/closures.mjs dir vehicles-carla`
  prints the materialized directory (`simforge assets pull --closure <sha256>` installs the same closure).
- After regenerating models (the tools write `models/`, which is gitignored) or
  editing a travelling sidecar: `node scripts/actor-assets/seal-packs.mjs seal`,
  then `publish` (needs write access to the public asset bucket), then commit
  `closure.json` and the lock. The merge gate runs `seal-packs.mjs check`.

## Coordinate frame

- **y-up, right-handed, meters.** `+X` = vehicle forward, `-Z` = vehicle left.
  This matches the engine actor frame (`render-core/src/catalog.rs`: length along
  `+X`, yaw about `+Y`).
- **Origin** = the CARLA vehicle pivot projected to the ground plane (`y = 0`).
  This is the same reference point CARLA uses for actor transforms, so CARLA-
  derived trajectories drop in without offset fixes. It sits mid-body, not at
  the rear axle; per-model bounds are in `manifest.json` (`bbox`) if a consumer
  needs to re-reference.
- Ground contact is `y ≈ 0` (tire bottoms).

## Scene graph

Rigid nodes, no skinning, one LOD:

| node | present on | purpose |
|---|---|---|
| `body` | all | main hull, interior, fixed glass, emissive lights |
| `wheel_fl` `wheel_fr` `wheel_rl` `wheel_rr` | 4-wheelers with rigged wheels | node origin = wheel center; spin = local rotation about `Z` (axle) |
| `door_fl` `door_fr` `door_rl` `door_rr` | vehicles with openable doors in CARLA | door shell + door glass; node origin = hinge (door bone bind pose), so door-open = local yaw |
| `wheel_f` `wheel_r`, `handlebar` | two-wheelers | same; handlebar node origin at steering pivot |

Static-source models (`tesla_model3`, `cybertruck`, `volkswagen_t2`,
`european_hgv`) are a single `body` node (their CARLA sources are static or
parked meshes without a wheel rig).

All primitives carry `POSITION`, `NORMAL`, `TANGENT`, `TEXCOORD_0`.

## Material slots

Material **names** are the contract:

- **`body_paint`** — neutral tintable paint. `baseColorFactor` ships as white
  with no base-color texture. Consumers apply the authored catalog color by
  setting `baseColorFactor` (or multiplying it in). Present on every vehicle
  whose `manifest.json` entry has `"tintable": true`.
- **`body_livery`** — authored livery texture (police, taxi, bus, classic van,
  Vespa, Ninja, Tesla, Cybertruck). **Do not tint**; the authored texture is
  the identity of the vehicle. `"tintable": false` in the manifest.
- **`glass`** (and `*_glass` variants) — `alphaMode: BLEND`, double-sided,
  low roughness. No texture.
- All other materials are conventional PBR: `baseColorTexture` +
  `normalTexture` + packed ORM (`occlusionTexture` and
  `metallicRoughnessTexture` point at the same image: occlusion=R,
  roughness=G, metallic=B — the CARLA `_orm` layout, which is glTF's native
  layout).

## Textures

- PNG only (render-core image features: `png`, `hdr`, `ktx2`; no WebP).
- Body/livery diffuse ≤ 2048², detail/normal/ORM ≤ 1024².
- Normal maps converted from UE (DirectX, −Y green) to glTF (OpenGL, +Y green).
- KTX2/UASTC migration is a possible follow-up; PNGs were chosen so the files
  load in both Bevy (`render-core`) and three.js today with zero extensions.

## Scale caveat

The models preserve CARLA's authored proportions, not necessarily its original
triangle topology. A few CARLA models are larger than their real-world
counterparts (e.g. the Fuso Rosa bus and the 2021 Mini). `manifest.json` carries
per-model `dims_lwh_m`. The browser uniformly fits the longest authored actor
axis; the native sidecar sets `scaleToDims: true`. This preserves proportions
and the authored vehicle length, rather than stretching each axis independently.
Width and height can therefore differ from the catalog box.

## Conversion provenance

The conversion is a manual process with texture caps, not automatic Nanite or
LOD selection. Twelve files carry `asset.generator: glTF-Transform v4.4.2`
following the documented meshoptimizer simplification pass (`tools/README.md`):
`vehicle_suv_nissan_patrol`, `vehicle_sedan_ford_crown`,
`vehicle_hatchback_mini_cooper`, `vehicle_truck_european_hgv`,
`vehicle_van_mercedes_sprinter`, `vehicle_sedan_dodge_charger`,
`vehicle_sedan_lincoln_mkz`, `vehicle_police_dodge_charger`,
`vehicle_ambulance_ford`, `vehicle_bus_mitsubishi_fusorosa`,
`vehicle_truck_carlacola`, and `vehicle_firetruck_actros`.
The other 26 files identify `simforge-carla-vehicle-pipeline` as their generator.

## Canonical model assignments

`packages/asset-catalog/scripts/generate-vehicle-models.ts` owns the editorial
assignments and generates the browser bindings, this pack's `catalog-models.json`,
and the Rust manifest fallback table. Run it with `--check` to reject drift.
The bicycle uses the upright Gazelle silhouette; the shuttle uses the Sprinter
instead of shrinking a Fuso bus to minibus length; the Camry uses the rigged
Impala sedan rather than duplicating the Lincoln used for the generic sedan.
An HGV tractor is not an articulated semi with a trailer, so `vehicle.semi_truck`
deliberately retains its builder.

## Ridden two-wheelers (`*_rider.glb`)

CARLA 0.10 never ships a riderless two-wheeler: every `2Wheeled` blueprint
attaches a G2 walker skeletal mesh and drives it with the anim blueprint
`Animations/Base/AB_Biker` (static `AS_Pedestrian_BikeHands` grip pose, hips on
the bike's `Seat` bone, two-bone IK of the hands to `Handler{Left,Right}Socket`
and the feet to `{Left,Right}PedalGeo`, head look-at). The riderless GLBs above
dropped those components; the seven `*_rider.glb` files restore them.
`tools/riders/` re-evaluates AB_Biker offline on the same walker (our
`catalog/pedestrians-carla` conversion of the mesh the blueprint names) and
bakes the result. The catalog binds `vehicle.bicycle` and `vehicle.motorcycle`
to ridden models only.

| model | CARLA blueprint | rider (walker) | helmet |
|---|---|---|---|
| `vehicle_bicycle_bh_crossbike_rider` | BP_CrossBike | SK_AfroF02_A_G2 (0017) | — |
| `vehicle_bicycle_gazelle_omafiets_rider` | BP_LeisureBike | SK_EuroM02_A_G2 (0047) | — |
| `vehicle_bicycle_diamondback_century_rider` | BP_RoadBike | SK_AsiaM02_A_G2 (0038) | — |
| `vehicle_motorcycle_harley_rider` | BP_Harley | SK_AfroM02_A_G2 (0027) | open |
| `vehicle_motorcycle_kawasaki_ninja_rider` | BP_KawasakiNinja | SK_AsiaF01_G2 (0032) | full |
| `vehicle_motorcycle_yamaha_yzf_rider` | BP_Yamaha | SK_EuroF02_B_G2 (0043) | full |
| `vehicle_scooter_vespa_rider` | BP_Vespa | SK_EuroF01_A_G2 (0039) | open |

Scene graph: the bike nodes as above, plus a `rider` node under the bike root
(static mount; yaw +π/2 because the walker bind pose faces +Z) holding the
walker skeleton, and the skinned `rider_mesh` as a **second scene root** (glTF
ignores a skinned mesh's parents; some loaders would otherwise bake them into
the bind matrix). Helmets are rigid `rider_helmet` meshes parented to
`crl_Head__C`; hair primitives are removed under them. The `rider` node,
`rider_mesh` and `rider_helmet` carry `extras.semanticClass = "rider"`:
segmentation labels them `rider`, distinct from the bicycle/motorcycle.

Animation: exactly one looping clip, `ride`, duration 1 s, LINEAR, 48 keys.
Bicycles: one crank revolution (crank, orbiting pedals, IK'd legs, wheels 2
turns). Motor: one wheel revolution, rider static. The clip time is a function
of distance only: `t = frac(odometerM / metersPerCycle) · 1 s`, odometer from
the render timeline (`wheelSpinRad · 0.35`); `metersPerCycle` is in the
animation extras, `manifest.json` and the catalog binding. Renderers must not
additionally articulate `wheel_*`/`handlebar` on a ridden model, and must fail
rather than draw the bike alone if the rider cannot be posed.

Materials: clothing is renamed to `rider_top`, `rider_bottom`, `rider_shoes`
(`rider_helmet` on helmets). Variant `k = fnv1a32(actorId) % palettes.length`;
`palettes[0]` is `null` (authored CARLA colours), otherwise the palette's
linear-RGB values replace those slots' `baseColorFactor` (untextured slots).
`body_paint` keeps the actor tint contract above.

Pose fidelity: AB_Biker pins the hips to the `Seat` bone and never stretches
the arms, so on long-reach bikes CARLA's hands stop short of the grips. The
offline solve lets the rider slide forward along the saddle (≤ 0.25 m) and pitch
the torso before giving up; `asset.extras.riderPoseReport` records lean, slide
and reach per model. Build fails if a hand misses its grip by ≥ 3 cm or the
rider penetrates the ground.
