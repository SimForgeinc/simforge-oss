# Native render: GPU/hardware profile (Belmont job, RTX 3080)

The workload is job `usrj_118093d74fcc4a6896698eae`:
- Belmont: 266M logical triangles, 5.5 GB UASTC textures.
- 480 ticks.
- 8 cinematic RGB cameras at 1280×720: seven at 120° HFOV plus a 70° chase camera.
- One 64-channel lidar at 1.2 Mpts/s.

rc.73 took 3.35 s of service time per tick.

All numbers below were measured on box 3: an RTX 3080 10 GB and a Xeon E5-2670 v3 in an HP Z840, driver 595.91. The measurements used `render-bench` (now `simforge-render job`), which runs the service's `render_bundle` path in-process, at ticks 200–211 with 11 measured ticks per configuration.

## Tools

`simforge-render job --scene native-service-scene.json --trace trace/native-trace.json --intent <intent>` (`renderer/service/src/cli/job.rs`) replays a job's own workspace files through `render_service::server::dispatch`.

| Option | What it does |
|---|---|
| `--ablate` | Removes one feature: `noshadows`, `nossao`, `nossr`, `notaa`, `nobloom`, `noatmo,nosky`, `occlusion`, `hide:<mesh>` |
| `--scene-set k=json` | Overrides a scene-spec field |
| `--set key=value` | Overrides a RenderConfig key (`--preset training\|showcase` picks the base) |
| `--dump-dir` | Writes PNGs for image gates |

The output reports the service's per-stage timings. With `SIMFORGE_RENDER_DIAGNOSTICS=1` it also reports:
- whole-frame GPU time: `render_core::gpu_diagnostics`, one timestamp pair around the render graph;
- Bevy per-pass spans and pipeline statistics (vertex/fragment invocations).

The `trace-chrome` cargo feature writes a CPU trace of every Bevy system.

## Render configuration: one surface, two presets

Every look knob is one typed `RenderConfig` (`renderer/render-core/src/render_config.rs`).
A request is a preset plus dotted overrides, and the same request shape works everywhere:
- the CLI: `simforge-render serve|job --preset training --set shadows.mapSize=2048`;
- the scene spec's `render: {preset, set}`;
- the render intent's `render: {preset, set, geometryLod}` (`packages/scenario/src/render-intent.ts`);
- sweep files.

Unknown keys and invalid values are errors. `simforge-render serve --scene S --print-render-config` lists every key.
The service reports the resolved config in its ready record and `hello`, and platform runs record it in the native manifest (`render`, behind `native-evidence.render-config`).

- `showcase` (default for platform renders) and `training` differ only in quality levels. Both keep every effect: shadows, SSAO, SSR, atmosphere, sky and clouds, bloom, grading and vegetation.
- `training` renders at the consumer's own resolution.
- No preset renders at the maximum. `RenderConfig::reference()` is the measurement reference, and `--set` reaches any value.
- Output encoding (`output.*`) is a consumer knob, not part of a preset's identity.
- `geometryLod: auto` (default) draws the map's `derived/geometry-lod` derivative when the closure carries one. `off` renders full detail. Lidar and radar always trace full detail.

### Preset values: the perceptual sweep

Each candidate below renders the same three ticks (Belmont chase shot, ticks 201–203) in one process (`simforge-render job --sweep`). It is scored against `RenderConfig::reference()`: TAA×8, a 4096 per-view atlas with 4 cascades out to 400 m, SSAO ultra, 32 contact-shadow steps, SSR 32/8, and full geometry. The similarity scores are mean 1−FLIP and SSIM over all dumped frames.

Timings come from the same session, so they include PNG dumps and are only indicative. They cover two measured ticks on the RTX 3080. The ms/tick column is the 8-camera rig's service time.

The 8×1280×720 rig (the showcase scale):

| Config | 1−FLIP | SSIM | GPU ms/frame | ms/tick |
|---|---|---|---|---|
| reference | 1.000 | 1.000 | 164 | 1971 |
| S4: TAA×4, SSR 16/6 | 0.991 | 0.996 | 98 | 965 |
| S2: TAA×2, SSAO high | 0.985 | 0.986 | 96 | 574 |
| rc.74 showcase (SMAA ultra, 4096×4 shared, SSAO ultra, LOD 1 px) | 0.974 | 0.962 | 92 | 384 |
| **showcase** (S5: rc.74 showcase + SSAO high, LOD 2 px) | 0.968 | 0.943 | 76 | 304 |
| rc.74 training (SMAA high, 2048×3 250 m, SSAO medium, SSR 6/3, LOD 2 px) | 0.958 | 0.935 | 72 | 304 |
| **training** (T3: FXAA, 1024×2 150 m, SSAO low, contact 4, SSR 4/2, LOD 8 px) | 0.924 | 0.836 | 49 | 279 |

At 512×384, training's own resolution, each knob was also varied on its own from the reference:

| Config | 1−FLIP | SSIM |
|---|---|---|
| AA: TAA×2 / FXAA / SMAA high | 0.984 / 0.970 / 0.969 | 0.982 / 0.960 / 0.949 |
| Shadows shared 4096 / 2048 / 1024 (4 cascades) | 0.998 / 0.997 / 0.995 | 1.000 / 0.999 / 0.996 |
| Cascades 2 / 1 | 0.990 / 0.977 | 0.997 / 0.941 |
| SSAO medium / low | 0.984 / 0.983 | 0.996 / 0.995 |
| SSR 6/3 / 4/2 | 0.999 / 0.999 | 1.000 / 1.000 |
| LOD 2 / 4 / 8 px | 0.953 / 0.927 / 0.944 | 0.870 / 0.789 / 0.846 |
| **training** (T3) | 0.927 | 0.829 |
| showcase | 0.970 | 0.953 |

Findings:
- Geometry LOD costs the most quality at low resolution. The non-monotonic 4 px point is foliage-card swaps landing on this shot's trees.
- On this dry scene SSR is nearly free in quality.
- The rest of the showcase-to-reference gap is anti-aliasing.

Showcase is the cheapest candidate in the 0.90–0.95 SSIM band. Training keeps every effect at its cheapest level and lands at about 0.83 SSIM against its own-resolution reference, the nearest measured point to the 0.80 target.

A dump-free timing pass on the render-video agent's rig replaces these GPU numbers when it runs.

Knob notes, from both the sweep and the render-video agent's one-knob pass on a single 1080p chase camera:
- `shadows.shared` affects only rig cameras. A presentation camera (a trailing chase that shows its host) always fits its own cascades.
- Foliage has no density knob. Its cost scales only with `lod.pixelErrorPx` (coarser levels and impostors).
- SSR is visible only on glossy surfaces: roughness between 0.12 and 0.55, such as car paint and wet road. On a dry scene every SSR setting measures FLIP 0.0000 against the reference, at no measurable cost. Both presets keep it on because it carries wet-road reflections (`lighting.wetness`).
- The SMAA levels differ by FLIP ≤ 0.002 at the same cost. The config still exposes all four because they are part of the wire form.
- On one camera the frame is geometry- and shadow-bound. What moves cost is cascades, shadows, LOD, resolution and TAA; every screen-space effect lands within 0.6 ms.

## Where a frame went (rc.73)

- **It was geometry-bound, not pixel-bound.** Each view ran about 105 M vertex invocations per pass (depth prepass and main pass) against about 2 M fragment invocations.
- **One mesh dominates.** 89% of the logical triangles are one asset: `SM_NorwayMaple_Field_02_PP`, 758 k alpha-masked triangles, 313 instances.
- **Shadows repeat that geometry many times.** Every camera re-drew the trees into its own 4 cascades: 32 directional shadow passes per render.

| 3080, 8 cams, GPU per render | ms |
|---|---:|
| rc.73 (per-view cascades, full-detail vegetation) | 624 |
| cinematic post (SSAO, SSR, TAA, bloom, atmosphere/sky), each removed | within ±1% |
| no directional shadows (diagnostic) | about 240 |
| maple hidden (diagnostic upper bound for LOD) | 70 (with shared cascades) |

rc.73 also rendered the rig about 4 times per tick, three of them readiness settles; perf/native-render-throughput removed those. So a tick cost about 2.5 s of GPU time.

## What changed and what it bought (GPU per 8-camera render, 3080)

| Change | GPU ms | vs rc.73 | Image vs rc.73 look |
|---|---:|---:|---|
| rc.73 | 624 | — | — |
| Shared rig cascades (`render_core::shared_shadows`, now default) | 325 | -48% | PSNR 55.2 mean / 52.0 min dB (24 frames) |
| Runtime geometry LOD (map derivative `derived/geometry-lod`, `SceneSpec.geometryLod`) | 132 | -79% | 43.7 / 39.1 dB |
| Shared cascades + LOD | **89–93** | **-85%** | 43.3 / 38.9 dB; diffs are sub-pixel foliage cards |
| + Bevy GPU occlusion culling | 86 | -3% more | not enabled (marginal) |

Notes on these changes:
- **Shared cascades.** Each of the 4 cascades is fitted to the union of the rig's frusta and rendered once. The union is 1.25× coarser per cascade than a per-view fit (unit test), so the atlas grows from 2048. It was configured as 2560, but Bevy rounds a non-power-of-two directional atlas up, so every shared measurement here rendered a 4096 atlas; the config now accepts only powers of two and the presets say 4096. The chase camera keeps its own tight fit. Duplicate passes are suppressed only when no unmarked view overwrites the atlas in between.
- **LOD.** Per view, each heavy mesh draws at the coarsest level whose geometric error stays under 1 px for the rig's most demanding camera. The distance is measured to the manifest's bounds centre. Ranges are abrupt `VisibilityRange`s with no dither, so a frame is a pure function of the pose. The ID pass clones every level with the same ranges. Lidar and radar keep full detail.

## Lidar on RT cores (`sensors::gpu_rays`, `SceneSpec.lidarBackend`)

- **Static sensor layer.** It is now an `InstancedScene`: 11,886 instances over 2.18 M unique triangles, built in 0.1 s. rc.73 used a flat 266 M-triangle soup that took 154 s and about 15 GB. The disk BVH cache is gone.
- **Hardware rays are a candidate generator only.**
  - Triangles are inflated in-plane by an error bound. Slivers become padded boxes, traced in an unpruned pass.
  - The shader re-evaluates every candidate with the CPU reference's exact f32 operation order. It uses an anti-FMA barrier and a correctly rounded reciprocal (Dekker residual), plus the same `(t, instance_id, triangle, order)` tie-break.
  - Actors are merged on the CPU, in parallel, by the `CombinedSensorScene` rule.
- **Result: bit-identical to the CPU reference.**
  - `sensors/tests/gpu_rays_parity.rs`: 3.8 M adversarial rays (edges, vertices, slivers, coplanar ties, grazing, 2.5 km coordinates) match on both the RTX 5080 and the RTX 3080.
  - A service test checks GPU payloads byte-for-byte against the CPU scan.
  - Belmont per-frame digests are identical.
  - `lidarBackend: "verify"` re-checks every scan in production.
- **The reference changed once.** `ray_tri_distance` now rejects hits within about 2.9° of grazing (`MIN_INCIDENCE_COS = 0.05`). f32 Möller–Trumbore produced ghost returns there: barycentrics hundreds of units outside the triangle, about 0.1% of adversarial rays. No GPU can reproduce those, and a physical lidar does not return them. Lidar goldens need one re-record.

| Lidar per tick (3080 box) | ms |
|---|---:|
| CPU, instanced reference | 2013 |
| RT cores (first cut) | 354 |
| RT cores + parallel actor merge + parallel ASCII PLY (byte-identical) | **169** |

On the RT path, the device trace itself takes about 15 ms. The rest is host work on a slow Xeon: beams, actors, PLY text.

## Whole tick now (3080, serial harness, all fixes, rgb + lidar)

| Stage | ms |
|---|---:|
| Bevy CPU (main + render app, single-threaded pass encoding for 8 views × ~40 passes) | ~355 |
| GPU render (readback wait) | 93–118 |
| Camera publish (strip padding, CRC, shm copy of 29 MB) | 48 |
| Rig/pose | 19 |
| Lidar (overlapped with render; residual wait) | 56 |
| **Tick** | **~620** (rc.73: 3350) |

The GPU is now idle most of the tick. The next limit is Bevy's CPU side.
- The render graph's `camera_driver` encodes views sequentially; wgpu-core pass recording is about 6 ms per view per frame on this CPU.
- Bevy exposes no knob for this. The fix is to record each camera's `Core3d` schedule into its own command encoder on a worker thread. That is a vendored change to `bevy_core_pipeline`'s camera driver.
- wgpu's indirect-draw validation (`WGPU_VALIDATION_INDIRECT_CALL`) was A/B'd on the 3080: no measurable difference.

## Theoretical floor

For 8 × 1280×720 views on a 3080 with the cinematic stack:
- **GPU:** shaded pixels (7.4 Mpx), LOD'd geometry (about 2–3 M triangles per view after culling), one shared cascade set and the screen-space passes. Games at this quality run about 3.7 Mpx per 16 ms on this class of GPU, so this rig should cost about 2–3 ms per view, **about 20–25 ms of GPU per tick**.
- **Everything else is under 10 ms:**
  - readback of 29 MB over PCIe 3.0 x16: about 2.5 ms;
  - NVENC for eight 720p frames: about 6 ms, asynchronous;
  - lidar ray trace on RT cores: under 1 ms per 120 k rays.
- **The 480-tick job's floor** is therefore about 12–15 s of GPU time. Reaching it needs the CPU side (Bevy encoding, host sensor work) parallelised or overlapped.

## Ranked next steps

1. **Parallel per-camera command encoding.** Record each camera's passes in its own encoder on a worker thread (vendored camera driver). CPU is about 355 ms on the Xeon; expected about ÷4 on the 24-thread box.
2. **Parallel camera publish.** Strip, CRC and copy per camera on the pool: about 48 → 10 ms.
3. **Shadow LOD policy.** Draw casters with the manifest's `shadowPixelErrorPx = 4` levels on a light-only layer.
4. **Ship the geometry-LOD derivative through prewarm**, so jobs pass `geometryLod`. It is off until the map carries it.
5. **Binary PLY for the lidar video path.** The TS consumer parses it; this removes the ASCII formatting.
