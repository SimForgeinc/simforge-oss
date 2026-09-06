# Splat render service - external components and licence notes (O6)

Nothing from NVIDIA's closed renderer (NRE / `nvcr.io/nvidia/nre/nre-ga:26.04`, pycena) is
vendored, linked, or imported by this lane. NRE was used only as the Phase-0 reference
(`renderer/splat/BENCHMARK.md`) through its gRPC service inside its own container.

| Component | How it is used | Where | Licence | Vendored? |
|---|---|---|---|---|
| 3DGRUT (`nv-tlabs/3dgrut`, threedgut/threedgrt tracers, `ncore` camera models, NuRec USD importer) | Loads the package's `checkpoint.ckpt` / `volume.nurec` Gaussians, rasterises them under the package f-theta model (3DGUT), provides `FThetaCameraModel` for actor projection | `THREEDGRUT_ROOT` (default `nurec-backend/3dgrut`, a git clone at `a37ef72`), imported at run time by `simforge_splat/render/gaussians.py` | Apache-2.0 (`LICENSE`, `ATTRIBUTIONS.md` in the clone) | No - external checkout + its own venv; not copied into this repository |
| kaolin (`kaolin.render.mesh.rasterize`) | Rasterises catalog meshes / truth cuboids under the f-theta lens for the actor layer, shadows and id pass | 3DGRUT venv | Apache-2.0 | No |
| PyTorch, numpy, scipy, trimesh, msgpack | runtime | 3DGRUT venv | BSD-3 / BSD / MIT | No |
| PhysicalAI-Autonomous-Vehicles-NuRec 26.04 sample set (`*.usdz`: `checkpoint.ckpt`, `volume.nurec`, `map.xodr`, `clipgt/*`, `frames/`, calibration) | Scene source: imported by `simforge import nurec-scene`; Gaussians read at run time from the USDZ referenced by `background.json` | `/mnt/nas/a100-data/datasets/PhysicalAI-Autonomous-Vehicles-NuRec/` | NVIDIA PhysicalAI-AV dataset licence (`LICENSE.pdf` next to the data): internal development permitted; **publication of derivatives (rendered frames, trained weights, benchmark images) needs a licence review before release** | No - read in place; imported scene bundles carry `import-provenance.json` with `source.usdzSha256` and member digests |
| Ego hood mask `ego-hoods/hyperion_8_1/camera_front_wide_120fov.png` | Composited over the front-wide image so the policy sees the same hood as in AlpaSim/NRE | `DEFAULT_HOOD_DIR` = the AlpaSim repository checkout (`alpasim-a15cur/data/nre-artifacts/ego-hoods`, git-tracked in that Apache-2.0 repository) | Apache-2.0 (AlpaSim repository `LICENSE`) | No - read at run time; `--no-hood` disables it |
| Actor catalog `catalog/vehicles-carla`, `catalog/pedestrians-carla` | Injected-actor meshes | this repository | CC-BY-4.0 (CARLA content; see `catalog/*/ATTRIBUTION.json`) | Already in the repository (pre-existing) |
| Alpamayo-1.5-10B (`nvidia/Alpamayo-1.5-10B`) | Policy under test only; never touched by the renderer | `adapters/alpamayo` | NVIDIA Open Model Licence (see the HF model card) | No |

Code in `renderer/splat/python/simforge_splat/` is SimForge's own (Apache-2.0 like the rest of the
repository). The only files derived from 3DGRUT are the phase-0 loader's re-implementation of the
NuRec state-dict layout (`nurec_scene.py`, written against `threedgrut/export/importers/nurec_usd.py`
as a *reference*, no code copied) and the calls into its public Python API.

Publication checklist before any derivative leaves the internal environment: (1) PhysicalAI-AV
licence review for rendered/benchmark imagery, (2) 3DGRUT / kaolin NOTICE propagation if a build
bundles them, (3) CARLA CC-BY attribution in any released asset pack.
