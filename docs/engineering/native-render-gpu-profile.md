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

## Look: the dash-cam camera model, haze and shadows

### Why the shadows were dark

The sky fill is physical. On a 0.5-albedo plane under a box (the `sky_fill_probe` test), the rendered shadow/lit ratio is 0.132, 0.166 and 0.24 at sun elevations of 45°, 30° and 15°. The atmosphere model's E_diffuse/E_total at the same elevations is 0.126, 0.176 and 0.32. The camera made the shadows black: an incident-light meter exposed 18% grey for sunlight on dark asphalt, and AgX then crushed the toe.

### The camera model (`render-core/src/camera_model.rs`, `camera.*` and `grading.toneMap: dashcamWdr`)

1. The camera meters every frame from its own HDR image and nothing else, so a capture never depends on earlier frames. The meter is a 128-bin log-luminance histogram built with integer atomics, so it is deterministic. The metering mask weights the bottom of the frame over the sky (`dashcam`); `average` and `centerWeighted` are the other modes. The meter takes a trimmed mean and aims it at an 18% key, plus `compensationEv`.
2. The metered EV100 is split into shutter (1/32000 to 1/30 s at f/1.8) and then gain (up to ISO 6400). Each frame records EV100, shutter, ISO and gain in the result `exposure` field and in the platform `exposure` diagnostics.
3. A global WDR log curve maps the image: white at `whiteStops` above the key, the key at `midGrey`, highlights desaturating to white.

There is no temporal adaptation. Bevy's `AutoExposure` depends on the previous frame, which would break history-free captures. `camera_model_exposure_does_not_depend_on_the_previous_frame` is the test for this.

| Option | GPU ms/camera (3080, 720p) | Visible effect | Verdict |
|---|---|---|---|
| AgX + incident meter (before) | 0.02 (tonemapping) | shadowed road luma 0–8 of 255; 95–100% of shadow pixels below luma 40 | replaced |
| Fixed EV + WDR curve (`camera.exposure.mode: fixed`) | 0.055 | 1−FLIP 0.20 vs the metered reference: about 2 EV off | knob only |
| **Instant metering + WDR curve (default)** | **0.055** (0.12–0.13 at 1080p) | shadow luma 46–85, lit road 100–177; 0–5% of shadow pixels below luma 40 | **default** |
| Temporal adaptation (Bevy `AutoExposure`) | ≈ the same | output depends on the previous frame | rejected |
| Local tone mapping | about 0.2–0.4 (not built) | the global curve already leaves ≤ 5% of shadow pixels crushed; halo risk | not needed |

The camera model costs about 0.44 ms per tick for the 8-camera rig, 0.9% of the training frame's 49 ms.

Road luminance on the Belmont clear scene (sun 36°, 8×720p rig, tick 381), before → after. Pixels are split into shadow and lit road by the HDR capture and the semantic pass. S/L is the displayed shadow/lit luminance ratio; the scene's own HDR ratio is 0.08–0.17.

| Camera | Shadow luma / lit luma, before | Showcase | Training |
|---|---|---|---|
| chase | 0 / 89 | 59 / 178 (S/L 0.18) | 62 / 177 (0.19) |
| front | 0 / 64 | 53 / 138 (0.16) | 55 / 138 (0.19) |
| left side | 4 / 96 | 85 / 160 (0.23) | 84 / 158 (0.23) |
| rear left | 0 / 94 | 60 / 171 (0.16) | 63 / 169 (0.16) |

### Haze

Clear air is 25 km (TS weather presets and the engine weather table; it was 80 km), and cloudy is 20 km. `atmosphere.hazeDensity` (default 1) scales the boundary-layer term that closes Koschmieder's relation. At 25 km the term is weak: about 1.6% veil at 100 m. Toward a low sun, forward scattering (g ≈ 0.78) makes it visible. Its value is calibrated against real dash-cam footage (dash-cam calibration notes).

### Tree shadows through geometry LOD (fixed)

Directional shadow cascades selected LOD levels on the GPU from the wrong position. Vendored `bevy_render` resolved a cascade's camera by looking up a main-world id in a render-world query, which always missed, so the GPU fell back to Bevy's shadow LOD origin. CPU visibility used the camera. A tree's LOD chain member reached the shadow map only where both selections agreed. In the training preset (8 px) almost no Belmont street tree cast a shadow. Showcase (2 px) lost fewer, and the loss depended on camera distance and on the order in which looks were applied. Cars under trees looked sunlit because nothing shaded them: shadow receivers were never the problem (`a_car_in_shadow_is_darker_than_in_sun`: 0.35/0.34 of sun luminance). The cascade camera is now mapped by main entity, and misses are counted (`directional_shadow_cascades_resolve_lods_from_their_camera`, which fails with the upstream lookup).

### Wet roads and SSR (fixed)

SSR reads the deferred G-buffer, but every material drew forward, so SSR contributed nothing. Belmont rain at wetness 0.85 rendered identical bytes with SSR on and off. With SSR in the look, wet road materials now draw deferred. Dry roads and every other material stay forward, so dry frames are unchanged (`a_wet_road_reflects_in_screen_space`).

### NaN foliage quads and the frame-integrity gate (fixed)

The camera model's metering pass counts every non-finite pixel of the HDR
frame: a pixel with NaN or infinity in any channel, tested on the exponent
bits. Before this count, such pixels printed as black and nobody noticed.
The count is read back with each camera's exposure and reported in three
places:

- job results: `nonFinitePixels`;
- run diagnostics: `frameIntegrity`, gated by
  `native-evidence.frame-integrity`;
- a `non_finite_pixels` warning.

The golden gate fails (exit 9) on any frame that has one.

On the San Ramon CEO-comparison and fit frames, 5 of 31 frames had 4-20 NaN
pixels, in 2x2 quads on pine and bush foliage. They appeared only with SSAO
on, because SSAO enables the normal prepass. With `LOAD_PREPASS_NORMALS`, the
main pass lit each fragment with the 10-bit normal the prepass stored for its
pixel.

The main pass now computes its own normal; SSAO still uses the prepass. This
removes every NaN on all 5 frames. Ruled out as causes: a non-finite prepass
normal, the default clearcoat normal, and a cause limited to masked materials.

Measured effect of the fix:

- **Pixels changed:** Easterbrook 1.1-1.3% of pixels (99.9th percentile 1
  level); San Ramon 8.7% (99.9th percentile 2 levels).
- **GPU time:** Belmont 8×720p on the RTX 5080, beside CARLA, A/B interleaved.
  Showcase 98.2/98.0 → 98.3/97.7 ms; training 61.8/62.4 → 60.9/63.8 ms. The
  differences are within run-to-run noise.
- **Dash-cam calibration:** re-checked against the internal reference
  footage (results not published); unchanged.

### Cars under trees: canopy sky occlusion (`lighting.canopySkyOcclusion`, on in both presets)

On the Easterbrook chase (tick 100), a white car under dappled canopy read as sunlit. It does receive the tree shadows, but two things hid them:
- The environment probe is an open sky. Glossy paint seen at a grazing angle reflected it at full strength under the canopy, so in HDR the body kept a median 0.71 of its unshadowed luminance.
- The road-weighted meter lifted the shaded frame by 1.1 EV.

Canopy sky occlusion is a vendored `bevy_pbr` patch. For a shaded fragment it looks up the sun's shadow map at eight fixed taps in two rings (1.5 m axis-aligned, 3 m diagonal), 2 m above the fragment. Occluders that also cover the point 25 m up are discounted, so tall trees still count and only very tall structures are cut. Cover is the covered fraction, scaled by 1.8 (sky view under layered foliage is roughly the gap fraction squared) and weighted by sun elevation. It removes up to 95% of the environment specular for upward reflections and up to 75% of the environment diffuse for upward normals. It is deterministic: fixed taps, no noise.
- Cost on the Easterbrook 1080p chase (5080): +0.1–0.25 ms per camera. Sunlit fragments skip the lookup.
- `a_glossy_car_in_canopy_shade_darkens_like_the_road`, a car at a chase-camera angle, lavapipe, showcase:

  | Car | Occlusion off → on |
  |---|---|
  | Under a canopy slab | 0.233 → 0.130 of the sunlit car |
  | In a 12 m building's shadow | 0.223 → 0.129 |
  | Sunlit | changes by 3.6% (training: 4.1%) |
- On the Easterbrook chase (tick 100), car shaded/lit falls from 0.27 to 0.20, and the road beside it from 0.15 to 0.12.
- **Known limit:** the cover is read from the sun's shadow map, so a building's shadow counts as overhead cover. A car beside a building still sees most of the sky, so its sky reflection comes out about 10% too dark: the building car ends as dark as the canopy car. Telling the two apart needs a sky-visibility estimate that doesn't come from the sun's shadow map.
- **Dash-cam calibration still holds.** Re-checked against the internal reference footage (results not published).

### Dash-cam calibration defaults (both presets)

These values are the `automotive` camera profile, the default. `camera.profile: consumer-dashcam` swaps in a consumer dash-cam calibration (camera-profiles.md).

These are calibrated against real automotive front-camera footage (internal dataset; results not published):
- metering `average`, `compensationEv` −1.1, `trim` 0.15
- `whiteStops` 5.5, `midGrey` 0.12
- `grading.contrast` 1.0, `postSaturation` 0.6
- `lens.vignette` 0.3
- `atmosphere.hazeDensity` 0.5


### Presets vs the reference (clear Belmont, dash-cam look, tree-shadow fix)

| Config | 1−FLIP | SSIM | GPU ms/frame (8 cameras) |
|---|---|---|---|
| showcase, 720p | 0.928 | 0.937 | 77 |
| training, 720p | 0.830 | 0.761 | 49 |
| showcase, 512×384 | 0.919 | 0.930 | 68 |
| training, 512×384 | 0.807 | 0.745 | 41 |

The earlier sweep tables above were scored under the AgX look, with the tree-shadow bug present. The two looks' scores are not comparable: the dash-cam look lifts shadows, and that exposes the detail differences inside them.

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
