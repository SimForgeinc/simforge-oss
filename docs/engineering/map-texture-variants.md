# Map texture variants: the full-resolution GPU-block tier

Every native render job starts by loading the map's textures. The master
closure stores them as UASTC KTX2 (`images/<sha>.ktx2`), which the service
transcodes to BC7 (colour), BC5 (normals) or BC4 (single channel) at load:
about 125 s of CPU per job start on Belmont (2,305 textures). That work depends
only on the map, so it is done once at ingest.

```
derived/textures-full-bc7/manifest.json          envelope, schema simforge.map-texture-variant.v1
derived/textures-full-bc7/index.json             images["../<master image uri>"] -> objects/<sha>.ktx2
derived/textures-full-bc7/objects/<sha256>.ktx2  zstd-supercompressed BC7/BC5/BC4 KTX2, all mips
```

## Generator

`ktx2-gpu-variant` (renderer/render-core, perf/native-render-throughput) runs
Bevy's own loader function (`ktx2_buffer_to_image` with the BC formats) and
verifies, for every texture, that the variant loads to exactly the source's
blocks, format, size and mips in both colour spaces before writing it. A
render from the variant is therefore byte-identical to one that transcodes at
load. Non-Basis sources pass through and are left out of the index.

The builder (`@simforge-oss/map-pipeline` `buildTexturesFullBc7`,
`packages/map-pipeline/src/texture-variant.ts`) runs the pinned binary
(`SIMFORGE_KTX2_GPU_VARIANT_BIN`), checks that the file hashes to the
`binarySha256` its `--fingerprint` reports, batches inputs, verifies every
output digest, and writes the envelope and index. `buildKey =
sha256(canonical {schema, id, master sha, 3d/manifest.json sha, every source
KTX2 by digest, builder fingerprint (revision + tool fingerprint)})`.
Rebuilds are byte-identical.

## Where it is built

- The map pipeline's native closure stage builds it for every map (cached by
  its key under `<workDir>/textures-full-bc7/`) and folds the tool fingerprint
  into the stage key. The generator is required: a build without it fails and
  says how to get it; `SIMFORGE_MAP_TEXTURES_FULL_BC7=skip` (or
  `texturesFullBc7: false`) builds without the tier.
- `pnpm maps:textures-full-bc7 -- --map-dir DIR [--check]` for an installed map.
- SimCloud `reconcile-map-derivatives.ts --derivative textures-full-bc7` for
  published map versions, bound by `descriptor.texturesFullBc7` exactly like
  `descriptor.geometryLod` (docs/engineering/map-geometry-lod.md, "Published
  map versions"; `studio/app/lib/scenario/map-derivatives.ts`).

## How it is used

`planNativeTextureMembers` (uastc-full) reads
`derived/textures-full-bc7/manifest.json` when the closure (or the bound
descriptor) has it, else `3d/variants/manifest.json`; the envelope, the entry
and the index must all bind the closure's `3d/manifest.json`. It then plans
the BC files instead of the UASTC ones. Anything missing or mismatched renders
by transcoding at load and is reported (`texture_tier_miss`), never silently.

## Cost

| map | textures | UASTC | BC variant | build (24 threads) |
|---|---:|---:|---:|---:|
| Easterbrook | 1,015 | 0.64 GB | 0.86 GB | 16 s |
| Belmont | 2,305 | 1.49 GB | 1.94 GB | 22 s |

About 1.3-1.4x the UASTC bytes, fetched once per worker cache by background
prewarm (never on a job's critical path), against ~125 s of CPU saved on every
job start. The per-map table for all published maps is in the dev
reconciliation report.
