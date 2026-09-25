# Per-job texture residency

A full-resolution native render used to upload every mip level of every map
texture. San Ramon Phase 1 has 5,831 textures, 9.3 GiB as BC7. That did not
fit next to CARLA on a 16 GB RTX 5080, so its showcase renders fell back to
512 px textures.

Every level a camera cannot sample is wasted. A render job knows every
camera position before the service starts, so it can work out, for each
texture, the finest level any rendered pixel can sample. The service then
uploads only the levels from there down. The pixels are the same, and the
texture memory drops to a fraction.

It has two parts:

1. **Ingest, per map:** the texture density derivative.
2. **Job, per render:** the plan and the trimmed load.

## The derivative (`derived/texture-density`)

Map ingest writes `derived/texture-density/manifest.json` (schema
`simforge.map-texture-density.v1`). For every KTX2 image the master's
materials sample, it records:

- the image's mip-0 size;
- its uses. Each use is a horizontal world box `[minX, minZ, maxX, maxZ]` (glTF
  frame, metres) and the lowest texel density any triangle of the use maps the
  image at (mip-0 texels per metre).

A triangle's density is a lower bound on what the GPU's isotropic LOD
selection sees along any screen axis. J is the Jacobian of texel coordinates
(after `KHR_texture_transform`) with respect to the triangle's plane, and the
bound is its Frobenius norm over sqrt 2. That never exceeds the larger of the
two axis derivatives the hardware uses.

- A triangle whose UVs are all equal has density 0, so its image keeps every
  level.
- An instance's density is the mesh's density divided by the instance's
  largest axis scale.
- Uses of one image are merged per 64 m cell (box union, lowest density).

The derivative is a pure function of the master, so the master and the map
version do not change: new maps get it when the master is built, and
published versions get it backfilled as a derivative set (descriptor key
`textureDensity`). The ingest pipeline that builds it is not part of this
repository; maps arrive with it through `simforge maps pull`.

## The plan (`native/crates/simforge-cli/src/render/residency.rs`)

For a `uastc-full` job on a map with the derivative, `simforge render` reads
the density manifest from the map closure (`render/derivatives.rs` lists
every derivative a native render reads). A derivative the closure lists but
the run cannot read fails `native_derivative_not_delivered`: it would
otherwise upload every mip level without saying so. The plan is computed from
the camera schedule (the hosted render worker computes the identical plan and
digest):

```
texels per pixel >= density * max(near plane, closest horizontal approach) / focalCorner
finest level      = floor(log2(texels per pixel) - 1)
```

- `focalCorner` is the camera's focal length in pixels divided by cos² of its
  corner ray angle. That is the smallest angle any pixel subtends.
- The `- 1` is TAA's `MipBias(-1)`, the most negative bias any view samples
  with.
- The distance is horizontal, so the plan does not depend on where the service
  grounds the host.

The level is then clamped to the staged file's chain and to a whole 4×4-block
base size, because wgpu refuses a block-compressed texture whose base is not
whole blocks. Every factor errs in the conservative direction.

The command then:

- writes the plan (`simforge.texture-residency-plan.v1`: `{uri, dropLevels}`
  per trimmed texture, staged URIs) to the job workspace and names it in the
  scene spec (`textureResidency`);
- runs the admission check on the bytes the job will upload, against
  `--vram-budget` (without a budget the capacity is unmeasured, and the
  skipped check is reported).

## The load (`render-core` `texture_residency`)

The service's default asset source is `ResidencyReader`, the file reader plus
the plan. For a listed KTX2 it returns the file without its `dropLevels`
finest levels:

- the header gets the smaller base size and level count;
- the remaining level payloads, their supercompression, the DFD and the
  key/value data are unchanged.

Bevy's loader then sees an ordinary smaller texture. Sampling a kept level
reads the same texels as before, because the base shrinks by a power of two
and the LOD shifts by exactly the dropped levels.

It fails loudly and never trims silently:

- A listed file that cannot be trimmed fails its load
  (`native_texture_residency_invalid`). That covers BasisLZ, ASTC, non-block
  sizes and too few levels.
- A listed file the scene never loads fails readiness
  (`native_texture_residency_unserved`).
- The service logs the uploaded and full bytes, and a histogram of levels
  dropped.

## Evidence

The manifest's `textureResidency` field (gated by
`native-evidence.texture-residency`) records:

- the derivative's digest and build key;
- the plan digest;
- planned textures by levels dropped;
- the full and uploaded bytes;
- the admission estimate.

It is `null` when no residency applied:

- the tier is `bc7-512`;
- the map has no derivative;
- `SIMFORGE_NATIVE_TEXTURE_RESIDENCY=off` was set, which is also a
  `texture_residency_disabled` warning.

## Measurements

Single-frame comparison stills, 1920×1080, showcase. The Easterbrook
rig has four cameras (95°, 105°, 115° and 125°) and San Ramon has one (105°).
The freeway drive is one 105° camera:

| Map | Textures | Full BC7 | Uploaded |
|---|---|---|---|
| Easterbrook (5 locations) | 1,015 | 2.61 GiB | 0.51-1.10 GiB |
| San Ramon P1 (4 locations) | 5,831 | 9.28 GiB | 1.24-1.96 GiB |
| San Ramon P1, 963-point freeway drive | 5,831 | 9.28 GiB | 2.56 GiB |

**Identity.** The five Easterbrook locations were rendered at four FOVs each
(95°, 105°, 115° and 125°), with and without the plan, on an RTX 5080. All 20
frames were byte-identical.

**Control.** A plan that drops two levels more than allowed changes 55-61% of
the pixels of the same frames, so the identity result is not vacuous.

**San Ramon at full resolution.** Next to CARLA (6.5 GB) on the same 16 GB
card, the four locations render at full resolution in 15-17 s, with a peak of
3.7-4.8 GB of device memory. Without the plan, its 9.3 GiB of textures alone
exceed the roughly 8.8 GB that CARLA leaves free.
