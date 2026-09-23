# Map geometry derivatives (LODs, impostors, sensor proxy)

RoadRunner exports put nearly all of a map's triangles into a few instanced
vegetation meshes. On Belmont, one 758k-triangle alpha-masked maple with 313
instances accounts for 237M of 266M triangles, and the native render is
vertex-bound (about 105M vertex invocations per view per pass against about
2M fragments). The map pipeline therefore produces, once per map, a set of
geometry derivatives that the renderers use to draw the same scene with far
fewer triangles:

```
derived/geometry-lod/manifest.json   index, schema simforge.map-geometry-lod.v1
derived/geometry-lod/lod.gltf        LOD chains and impostor meshes (+ lod.bin)
derived/geometry-lod/sensor.gltf     simplified sensor collision meshes (+ sensor.bin)
derived/geometry-lod/images/*.png    impostor atlases (+ .ktx2, KHR_texture_basisu fallback form)
```

## One producer

`@simforge-oss/map-pipeline` `buildGeometryLod` (`packages/map-pipeline/src/geometry-lod/`)
is the only producer. It is used by:

- the map master stage (`simforge maps build|ingest`). The derivative is its
  own cached stage (`<workDir>/geometry-lod/<key>`, keyed by the scene closure
  and the builder fingerprint), hardlinked into the master under
  `derived/geometry-lod/`, and its fingerprint is folded into the master's
  tool fingerprint as `geometryLod=<fingerprint>`. `SIMFORGE_MAP_GEOMETRY_LOD=skip`
  (or `geometryLod: false`) builds a map without it and keeps the historical key;
- `pnpm maps:geometry-lod -- --master DIR | --all [--check]` for installed maps;
- SimCloud's `reconcile-geometry-lod-derivatives.ts` for published map versions.

## Content address

Output bytes are a function of `master.gltf`, its buffers (images are named by
digest inside `master.gltf`, so the master digest covers them),
`GEOMETRY_LOD_REVISION`, meshoptimizer 1.2.0, the KTX-Software encoder and the
resolved options. `buildKey = sha256(canonical {schema, master, buffers,
fingerprint})`. Rebuilding the same input is byte-identical (no RNG; stable
orders; tested). A revision or option change produces a new key, and
`--check` reports `current`, `stale` or `missing`.

## Keying and conventions (the runtime contract)

- Everything is keyed by the master's **mesh index and primitive index**, which
  is exactly Bevy's sub-asset label `master.gltf#Mesh{N}/Primitive{M}` on every
  spawned entity.
- `lod.gltf` mesh `K` of a level replaces the **whole** master mesh: its
  primitive `j` replaces master primitive `j` (same count, order, attribute set
  and accessor encodings, including every `TEXCOORD_n`, `TANGENT`, normalized
  integer types), and has **no material**. The runtime keeps the master
  primitive's material handle, so no new pipeline specialization appears.
  A primitive a level drops entirely is written as one degenerate triangle.
- Impostor meshes carry their own material (alpha `MASK` 0.5, double-sided,
  baked albedo and tangent-space normal atlas, roughness from the source).
- `geometricErrorM` and `bounds` are **mesh-local**; multiply by the instance
  world transform's largest axis scale.
- Selection, per view and instance: the coarsest level (impostor last) with
  `geometricErrorM * instanceScale * fPx / d <= pixelErrorPx`, where `d` is the
  distance from the camera to the instance's world-space bounds centre and
  `fPx = viewportHeightPx / (2 tan(vfov / 2))`. Level 0 is the master mesh.
  `switchDistanceM` is the same rule precomputed for a 1080 px / 60 degree
  reference camera at scale 1 (conservative for 1280x720 at 120/70 degree HFOV).
- Shadows: the same rule with `shadowPixelErrorPx` (default 4), never finer
  than `shadow.minLevel`. `shadowSwitchDistanceM` is precomputed.
- The ID (instance segmentation) pass must use the same level as RGB.

## What the builder does

**Selection.** A mesh gets a LOD chain when it has at least 1,000 triangles,
at least 250k instanced triangles in the map (or 50k on its own), is
vegetation or instanced at least twice, and its world bounding radius is at
most 60 m (terrain and road layers are single huge meshes; one distance to
their centre says nothing about the part next to the camera).

**Levels.** Ratios step by mesh size (>=100k: 10 %, 3 %, 1 %; >=20k: 25 %, 8 %,
2.5 %; else 35 %, 12 %, 4 %), dropped when they save less than 25 % over the
previous level. Each primitive is classified:

- *Card-like* (foliage): alpha-masked, at least 16 connected components
  (position-welded), median component at most 256 triangles, and cards at
  least 30 % of the primitive. Structural pieces (a component above
  max(2000, 5 %) triangles: trunks, main branches) are simplified. The cards
  are first simplified toward `sqrt(ratio)` (clusters lose inner detail), then
  **thinned by whole card** along a Morton walk of card centroids (spatially
  uniform, deterministic), and every kept card is scaled about its centroid so
  that the **total leaf area is preserved** (scale capped at 2, at least 25 %
  of cards kept). Plain simplification collapses leaf cards one by one and
  canopies go bald; area-preserving thinning keeps coverage.
- Everything else: meshoptimizer `simplifyWithAttributes` (normals weighted,
  attribute seams kept), with an error cap per level of 1.5 %, 4 % and 10 % of
  the bounding radius. A level may stop above its ratio rather than collapse a
  branch into metre-scale error.

The level error is the larger of meshoptimizer's error and a card-thinning
term `0.125 * medianCardDiagonal * (1/sqrt(kept) - 1 + (scale - 1))`, whose gain
was calibrated against the image gate below.

**Impostors.** Vegetation meshes (card-like primitives are at least 30 % of
the triangles) get a cross-card impostor: three vertical cards through the
tree axis (0/60/120 degrees) and one horizontal card at the canopy's
area-weighted height, 8 triangles. Each card is an orthographic bake of the
full-detail tree along its normal by a deterministic CPU rasterizer (2x2
supersampling, per-triangle mip selection, alpha test at the material cutoff,
double-sided normals facing the viewer, alpha-dilated). Its error is
`0.25 * depth extent`, so it is chosen only where the flattened depth is
sub-pixel. Cross-cards seen edge-on show streaks at close range, which is why
this threshold is conservative. An octahedral impostor would need a runtime
shader; cross-cards use the stock PBR material.

**Sensor proxy.** Per master primitive, POSITION only:

- Surfaces: meshoptimizer under an absolute bound of 2 cm (10 cm for trunks
  and branches of vegetation), converted to mesh units at the mesh's largest
  instance scale, pruning pieces smaller than the bound.
- Foliage cards: aggregated per 0.5 m cell (at the median instance scale).
  All cards in a cell become one square card of the same one-sided area at
  their area-weighted centroid, oriented along their dominant normal (principal
  axis of the area-weighted normal tensor). The exact sensor scene raycasts
  cards as solid quads, so leaf area per volume (what stops a ray inside a
  canopy) is preserved; individual returns move by up to a cell diagonal.

The proxy is **opt-in and must be requested explicitly** (it changes lidar
output). See "Lidar" below for why exact instanced geometry is recommended
instead.

## Measurements

### Survey (source GLBs, 2026-09-22)

| map | instanced tris | unique tris | alpha-masked (instanced) | top offender (tris x instances) | images (MB, >=4k) |
|---|---:|---:|---:|---|---|
| Belmont Office Park | 266.1M | 2.22M | 265.5M | SM_NorwayMaple_Field_02_PP 758k x 313 = 237M | 2319 (2213 MB, 105) |
| Di Rosa SF | 24.2M | 3.47M | 20.1M | SM_Aporosa 90k x 48 = 4.3M | 3844 (2405 MB, 49) |
| El Camino Rd | 21.6M | 0.99M | 20.8M | SM_Oak_L_v2 35k x 127 = 4.4M | 1118 (1034 MB, 20) |
| Garching Phase 1-2 | 443.9M | 4.20M | 426.1M | SM_Bush_L_v1 10k x 10,198 = 104M; SM_Cypress_Bush 4.4k x 20,816 = 92M | 14041 (2083 MB, 316) |
| Richmond Field Station | 11.5M | 1.61M | 6.8M | Eucalyptus_camaldulensis_4LD 478k x 7 = 3.4M | 1957 (1504 MB, 128 + two 16k) |
| San Ramon 25 P2 | 12.6M | 11.83M | 6.4M | P_11_10 17k x 14 = 0.23M (no instancing) | 5120 (2855 MB, 23) |
| San Ramon Phase 1 P1 | 281.6M | 8.55M | 277.6M | SM_Maple_M 45k x 1,377 = 62M | 5831 (3140 MB, 13) |
| San Ramon Phase 2 | 1027.9M | 6.54M | 548.2M | SM_MT_PM_V60_Alnus_cremastogyne_01_04 864k x 592 = 512M | 9788 (2116 MB, 154 + four 8k) |
| Saratoga School Area | 11.7M | 0.92M | 11.1M | SM_Maple_M 45k x 56 = 2.5M | 1021 (1027 MB, 65) |
| Yale St | 27.1M | 2.09M | 25.8M | SM_Oak_L_v2 35k x 179 = 6.2M | 2524 (2902 MB, 112) |

### Builder (simforge1 CPU, per map)

| map | LOD meshes | LOD'd instanced tris | coarsest levels | impostor floor | sensor tris (instanced) | lod.bin | sensor.bin | build |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Belmont | 17 | 264.6M | 7.29M | 0.82M | 2.73M | 24.5 MB | 9.3 MB | 60 s |
| Richmond | 5 | 10.0M | 0.75M | 0.03M | 4.76M | 19.6 MB | 19.6 MB | 26 s |

(All maps: see the report attached to feat/map-lod-derivatives.)

### Image gate

`pnpm maps:geometry-lod -- substitute` bakes the selection rule for a clip's
host positions (minimum distance over the clip minus a 12 m rig margin, fPx
914 for every camera) into a copy of `master.gltf`, rendered through the
unmodified renderer by `render-bench` against the full master, same ticks and
cameras. TAA and auto-exposure are turned off for the gate (FXAA, fixed EV)
because they make two runs of the *same* master differ (repeat-run floor with
TAA: 42 dB mean PSNR). With FXAA the floor is 52.7 dB mean / 44.9 dB min.

Belmont, gpu-deep fixture, 8 cameras x 4 ticks: LOD'd instances 264.6M to
31.8M triangles; PSNR 48.1 dB mean / 44.0 dB min, SSIM 0.9966 / 0.9942. At
`pixelErrorPx` 2 PSNR drops to 40.8 dB; at 4 and above impostors reach
mid-range trees and edge-on cards streak (35.7 dB).

### Lidar

Production spinning lidar (64 channels, +-20 degrees, 1875 azimuth steps) from
the host trajectory, 2.4M rays on Belmont, the production `bvh.rs`:

| static scene | tris | serialized | build | cast | range vs exact |
|---|---:|---:|---:|---:|---|
| flat exact soup | 266.1M | 15.48 GB | 56.7 s + 7.6 s snapshot (128 threads) | 0.227 s | reference |
| instanced exact (`InstancedScene`) | 2.18M unique | ~0.1 GB | 0.84 s | 0.237 s | bit-identical distances; 0.55 % instance ids differ, all exact ties |
| sensor proxy (this derivative) | 2.73M | 184.6 MB | 0.51 s | 0.122 s | surfaces p50 0.7 mm, p90 7 cm, p95 25 cm; vegetation p50 0.3 m, p90 6 m |

The instanced exact BVH gets the size and build time of the proxy without
changing a single range. Its only difference is the tie-break between
coincident duplicates, which can be made identical. The proxy is kept for
consumers without instancing and is never selected implicitly.

## Published map versions

A native asset set is immutable and unique per registry release, so the
SimCloud backfill cannot add members to it. It uploads the derivative files
content-addressed, registers them as verified native blobs, and binds them in
`map_versions.descriptor.geometryLod`:

```
{ state: "ready", schema, buildKey, revision, fingerprint, masterSha256,
  manifestSha256, members: [{ relativePath, sha256, byteLength }], totals, builtAt }
```

(`failed` with a reason, or a `lastFailure` beside a ready binding, otherwise.)
`studio/app/lib/scenario/map-geometry-lod.ts` reads the binding; native render
intents declare its members as ordinary `map.resource.<sha256(path)>` map
inputs, the lease resolves those the intent declared, and the worker prewarm
lists and signs them with the set, the way `descriptor.ambientTurnVerdicts`
rides along. Maps built by the new pipeline carry the members in the closure
itself; closure members win over descriptor members of the same path.
