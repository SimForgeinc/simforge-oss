# Road detail layer — `simforge.road-detail/v1`

The Road-Painter-equivalent for the native (Bevy) renderer: per-tile
splat-blended asphalt/concrete variants, procedural wheel-track/oil wear,
worn lane markings, and baked decal stamps (cracks, patches, oil, stains) —
all CC0-seeded and **deterministic** (same inputs → same pixels on the same
device). It is the counterpart of CARLA's Road Painter workflow.

Components:

| Piece | Location |
|---|---|
| Master material (Bevy `ExtendedMaterial`) | `renderer/render-core/src/road_detail.rs` |
| Fragment shader | `renderer/render-core/src/shaders/road_detail.wgsl` |
| Engine entry point | `renderer/render-core/src/engine.rs` (`SceneApp::apply_road_detail`); no job/serve wiring today (see Renderer wiring) |

## Sidecar document

One JSON sidecar + textures per tile, produced at map ingest (the generator
is not part of this repository), conventionally at
`<bundle>/browser/3d/tiles/<tile>.road-detail/<tile>.road-detail.json`.
Texture paths resolve **relative to the sidecar's directory**.

```json
{
  "schema": "simforge.road-detail/v1",
  "tileId": "easterbrook-discovery-school/road",
  "seed": 1337,
  "generator": { "tool": "road-detail-gen", "version": "1.0.0", "maxSize": 4096 },
  "bounds": { "minX": -230.9, "minZ": -13.4, "maxX": 267.4, "maxZ": 337.4 },
  "materials": {
    "road": ["Asphalt1"],
    "marking": ["LaneMarking1", "LaneMarkingYellow1"]
  },
  "splat": { "texture": "splat.png" },
  "decalOverlay": { "texture": "decals.png" },
  "decalAtlas": { "texture": "atlas.png" },
  "variants": [
    { "id": "asphalt_02", "role": "a",
      "baseColor": "asphalt_02_diff_1k.png",
      "normal": "asphalt_02_nor_gl_1k.png",
      "orm": "asphalt_02_arm_1k.png",
      "tilingPerMeter": 0.35,
      "source": { "provider": "Poly Haven", "url": "https://polyhaven.com/a/asphalt_02", "license": "CC0" } }
  ],
  "detailNormal": { "texture": "asphalt_02_nor_gl_1k.png", "tilingPerMeter": 1.7, "strength": 0.5 },
  "params": { "wearAlbedoDarken": 0.38, "wearRoughnessDelta": -0.22, "markingWearStrength": 0.85 },
  "decals": [
    { "type": "crack", "stamp": 0, "x": 219.3, "z": 320.1, "rotDeg": 12.5, "sizeM": 3.2, "intensity": 0.8 }
  ],
  "digests": {
    "splatRgbaSha256": "…", "decalOverlayRgbaSha256": "…", "atlasRgbaSha256": "…"
  }
}
```

Field semantics:

- **bounds** — world-XZ rectangle of the mask textures. Shader mapping:
  `uv = (world.xz − boundsMin) / boundsSize`, clamped.
- **materials** — GLB material names (as tagged by the glTF loader's
  `GltfMaterialName`) to rewire. `road` entries get surface mode, `marking`
  entries get marking mode. Everything else in the tile is untouched.
- **splat** channels (linear RGBA):
  - `R` — weight of variant A (aged asphalt), seeded world-space fbm inside
    driving/shoulder lanes + repair-patch rectangles.
  - `G` — weight of variant B (concrete repair), sparser fbm threshold.
  - `B` — wear: twin wheel-track bands (Gaussian around t = 0.55 of the lane
    half-width, per-lane seeded traffic amplitude) plus a center oil band.
    Drives albedo darkening (`wearAlbedoDarken`) and roughness shift
    (`wearRoughnessDelta`, negative = polish).
  - `A` — lane-marking erosion: strongest in a band along lane edges (where
    markings live) plus wheel-crossing bleed. Marking mode uses coherent
    noise to fade chipped regions toward asphalt gray and roughens surviving
    paint. It deliberately stays opaque because some source meshes have no
    road primitive beneath marking strips; fragment discard would expose the
    world clear color.
- **variants** — 1–2 extra surfaces blended over the authored GLB material
  (variant 0). `role` selects the splat channel (`a` → R, `b` → G). ORM uses
  the packed AO/rough/metal (glTF ORM) convention. Sources
  MUST be CC0 or SimForge-authored; the `source` block records provenance.
- **detailNormal** — high-frequency normal layer tiled at
  `tilingPerMeter`, scaled by `strength`; damped under decals.
- **decals** — the authored list of stamp instances (world transforms).
  `decalOverlay` is the pre-composited bake of these instances from
  `decalAtlas` (2×2 grid: crack / patch / oil / stain; R = shade,
  A = shape). Renderers consume only the baked overlay; the instance list
  is retained so a true-decal renderer can re-composite at higher
  fidelity.
- **digests** — sha256 of the **raw RGBA payloads** (not the PNG bytes);
  this is the generator's determinism contract.

## Generation rules

Inputs: the map's lane polygons (WGS84), lane widths from the topology index,
and the map `xodr` `<geoReference>` (tmerc origin). Lon/lat → SimForge XZ uses a local
ellipsoidal ENU approximation (≪ texel error over <1 km maps) with the
frame mapping `sf.x = local_x`, `sf.z = −local_y`.

Everything is seeded: value-noise lattices hash integer coordinates with the
tile seed; per-lane amplitudes hash the lane `road:section:lane` id; decal
placement consumes one deterministic `splitmix32` stream in input order. The
decal atlas is built from a fixed constant seed, so its digest is identical
across tiles and runs.

## Renderer wiring

The engine entry point is `SceneApp::apply_road_detail(sidecar)`
(`renderer/render-core/src/engine.rs`). The former `native-render-job` binary
called it from an optional job-file block
`{ "roadDetail": { "sidecars": ["/abs/path/road.road-detail.json"] } }`; that
binary is gone, and neither the `simforge-render job --job` spec
(`simforge.render-job/v2`) nor the `serve` scene spec has a road-detail field
yet, so no command applies sidecars today.

Without sidecars the output is byte-identical legacy output. With them, after
scene readiness the engine loads the sidecar textures (CPU-decoded, mipless, fixed samplers) and
swaps every mesh whose `GltfMaterialName` is listed in `materials` to
`ExtendedMaterial<StandardMaterial, RoadDetailExtension>`; the authored
material remains the blend base, so tile UV density, alpha modes, and any
ORM repair survive. The instance-ID pass and
legend are unaffected (ID clones use engine-created unlit materials).

## Determinism & tests

- `cargo test -p render-core --lib road_detail` — sidecar schema validation.
- `cargo test -p render-core --test road_detail_pipeline` — WGSL composes
  through naga_oil and specializes to an `Ok` pipeline on a real adapter
  (set `SF_NO_GPU=1` to skip on GPU-less hosts).

## Licensing

Variant textures: CC0 only (Poly Haven / ambientCG), provenance pinned per
variant in the sidecar. The decal atlas is procedurally generated
(SimForge-authored). No RoadRunner Asset Library content is referenced.
