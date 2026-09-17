# Native renderer tick-latency qualification

## Verdict and scope

**The calibrated native two-camera 1920×1080 workload beats the supplied CARLA Belmont reference.** On `3080-workstation-1`, the complete **1001-tick** native clip took **126.768 s of capture, including encoder finalization: 0.126641 s/tick**, with a sampled **6286 MiB** VRAM peak. CARLA's supplied reference is **0.431 s/tick and 7987 MiB**. Native is **3.403× faster**, has **70.62% lower tick latency**, and uses **21.30% less peak VRAM**. Whole-process native wall time was **176.894 s**; bring-up and manifest work are not hidden in the capture figure.

This is sensor-workload parity, **not a claim of CARLA Epic image-quality parity**. The map, compiled scenario, camera count, resolution, mounted directions, offsets and FOVs are matched. Native still uses its sensor rendering tier, simplified actor cuboids, no TAA, and omits the host cuboid from the capture harness. Shared directional shadows are an explicit quality/performance option. CARLA's renderer/effects and vehicle assets differ.

**Do not use earlier sideways-camera timings as parity measurements.** Final inspection found and fixed a 90-degree camera-basis error and a mismatched chase calibration. The headline above was rerun after those corrections. Historical profiling remains useful to explain the original wait, but the final performance and accuracy tables below use the corrected rig.

The full 18-measurement-sensor rig, plus its presentation chase camera, also improves substantially: **1.465125 → 0.537453 s/tick** on the same corrected 64-tick interval. This faster configuration uses hardware lidar and changed artifact representations; it is not numerically identical to CPU lidar. A CPU-lidar alternative is measured separately below.

## Environment, inputs and timing boundary

- Machine: **ws1 / `3080-workstation-1`**, RTX 3080 **10240 MiB**, 24-thread Xeon E5-2670 v3 as specified in the assignment; measured NVIDIA driver **595.91.07**.
- Release builds: existing Ubuntu-compatible `astra-build-env` container, Rust **1.97.0**, `cargo build --release --offline -p sensors --bin sensor-capture`. No new external crate package was introduced: direct `wgpu 29.0.4` access uses the renderer's existing locked dependency.
- Runtime: `XDG_RUNTIME_DIR=/tmp`, `WGPU_BACKEND=vulkan`, NVIDIA Vulkan ICD, file-descriptor limit 65535.
- Map: `/home/simforge/render-inputs/native-map-cache/.corpus/belmont-research-center/master.gltf`.
- Scenario: `/home/simforge/render-inputs/scene-states/uscn_1ba15a3b8938404aab077732.json`.
- Rig: `/home/simforge/render-inputs/render-qualification-program.v1.json`.
- Final calibrated performance binary: `/home/simforge/astra2-bin/aligned`, SHA-256 `9825ad54d101d179ae15883e4f6ba287ff0dc67e53b94dcb09bd74581fb89116`.
- Logs, commands, binary hashes and VRAM samples: `/home/simforge/astra2-results/<run>/run.log` and `summary.json` on ws1. The later `boundary` binary adds diagnostic-only winning-triangle reporting.

`captureSeconds` starts when the first actual scene tick is armed and ends after all tick artifacts and every video encoder's EOF/trailer flush complete. `encoder_drain` is printed separately **but is already included in captureSeconds; do not add it twice**. Asset/acceleration/pipeline bring-up and subsequent manifest hashing are separate. Wall time includes everything. VRAM is whole-device memory sampled by `nvidia-smi` every 0.2 s, including bring-up; sub-sample transient peaks are not excluded by this method. Clocks were not locked.

A fixed warmup count was not sufficient: early captures initially measured only ~129 ms of GPU work while materials were still becoming drawable; the settled scene was ~588 ms. The harness now uses the existing `GpuReadinessPlugin` (no pending pipelines/material bindings over consecutive samples) before counting warmup. Unarmed warmup frames are drained rather than allowing their queued work to be charged to the first captured tick.

## Corrected before/after measurements

All rows below use the corrected mount convention and chase calibration. Times are measured capture totals divided by actual ticks, not inverse instantaneous FPS.

| Workload and run | Ticks / interval | Capture s | s/tick | Peak MiB |
|---|---:|---:|---:|---:|
| Two RGB 1080p, strict draws, x264, per-view shadows (`aligned-reference-2`) | 300 / 350–649 | 50.587 | **0.168623** | **6292** |
| Same, shared shadows (`aligned-optimized-2-300`) | 300 / 350–649 | 39.069 | **0.130230** | **6276** |
| Two RGB 1080p, shared shadows, strict draws, x264 (`aligned-2-video-1001`) | **1001 / 0–1000** | **126.768** | **0.126641** | **6286** |
| Full rig 720p reference: per-view shadows, CPU lidar, legacy aux materials, PNG/f32/ASCII, indirect draws (`aligned-reference-18`) | 64 / 400–463 | 93.768 | **1.465125** | **7112** |
| Full rig 720p: shared shadows, batched exact labels, CPU lidar, strict draws, video/f16/binary (`aligned-cpu-18`) | 64 / 400–463 | 75.841 | **1.185016** | **7620** |
| Full rig 720p: same optimized products with hardware lidar (`aligned-optimized-18`) | 64 / 400–463 | 34.397 | **0.537453** | **8477** |
| Supplied CARLA Belmont Epic reference, two RGB 1080p | supplied measurement | — | **0.431000** | **7987** |

At two views, shared shadows alone reduce the matched 300-tick time by **22.77%**. The full-rig optimized hardware configuration is **2.726× faster / 63.32% lower latency** than its corrected reference. The CPU-lidar alternative is **19.12% faster** while retaining the CPU ray intersection model. It still changes RGB encoding, depth precision and shadow sampling, which are separately documented choices.

The full rig's **0.537453 s/tick is 24.70% slower than CARLA's two-camera 0.431 s/tick**, not faster. It is a much larger and differently composed sensor workload, so this is context, not a matched comparison. Do not confuse the full-rig result with the two-camera win.

The calibrated full-rig run includes eight measurement RGB cameras, eight depth products, eight instance/semantic products, six lidar scans, four radar outputs, and the extra chase RGB view. `--rgb-only` can remove camera depth/ID products while retaining lidar/radar, but such a run is a different product workload and must be labeled that way.

The primary 1001-tick clip contains two finalized H.264 MP4s, each independently checked by `ffprobe` as **1920×1080, 50 fps, exactly 1001 decoded frames**. Combined video size is **242,995,859 bytes**. No per-frame RGB files are produced. Encoder drain was **2.232 s**, included above.

## GPU measurement method and calibrated scaling curve

The RTX 3080 exposes wgpu encoder timestamp queries, with a reported **1 ns timestamp period**. `gpu_profile.rs` writes timestamps at each ordered view's start/end, around early/late directional-shadow scopes, around the root frame, and around texture-to-staging copies. Queries resolve only after rendering/copies are submitted, then are mapped with that frame's readback. No per-pass host fence is inserted. Root-frame timestamps include work outside the camera scopes; a measured optimized frame differed from the summed view scopes by only ~0.04 ms.

The following corrected-pose camera-only sweeps use **1280×720**, ticks 400–415, strict draws and the reference per-view shadow arrangement. Device columns are medians of the last eight captured frames. `s/tick` is the entire 16-tick profiled capture, including artifacts and short-run pipeline ends, and is not a long-clip throughput estimate.

| Render views | Selected camera workload | GPU render ms | Directional-shadow scope ms | GPU transfer ms | Profiled s/tick |
|---:|---|---:|---:|---:|---:|
| 1 | `pronto-cam3`, RGB only | **18.4845** | **10.6630** | **0.2925** | 0.066563 |
| 2 | `parity-front`, RGB only | **61.3710** | **38.5490** | **0.5790** | 0.168375 |
| 4 | cams 1, 2, 3 + chase, RGB only | **200.3195** | **135.4705** | **1.1545** | 0.406000 |
| 9 | all RGB cameras, including chase | **513.5935** | **365.6985** | **2.5940** | 0.937313 |
| 17 | 9 RGB + 8 aux ID/class views | **600.7705** | **367.0135** | **7.1595** | 1.055250 |
| 17, no directional shadows | same products; diagnostic quality ablation | **225.1995** | **0.0715** | **7.1245** | 0.483813 |

The curve is intentionally not a linear fit: these are actual differently aimed/FOV cameras, not duplicated identical views. Their caster/geometry populations differ substantially. Disabling directional shadows removes **375.57 ms** of total GPU work. The measured shadow scopes account for **367.01 ms**, or **61.09%** of the reference 17-view render; the ablation also changes shadow sampling/preprocessing and is subject to normal clock variation.

### Per-view breakdown, calibrated 17-view reference

| Camera | RGB total ms | RGB directional shadows ms | Aux total ms |
|---|---:|---:|---:|
| pronto-cam0 | 64.430 | 48.546 | 11.749 |
| pronto-cam1 | 79.070 | 57.872 | 15.638 |
| pronto-cam2 | 62.938 | 40.134 | 16.251 |
| pronto-cam3 | 19.203 | 10.901 | 1.540 |
| pronto-cam4 | 75.514 | 53.443 | 13.797 |
| pronto-cam5 | 66.463 | 52.903 | 9.021 |
| pronto-cam6 | 68.994 | 51.814 | 11.430 |
| pronto-cam7 | 36.308 | 23.065 | 5.002 |
| chase | 43.302 | 28.129 | — |

Aux shadow scopes are ~0.004 ms: those views do not render directional shadow geometry. Thus the original hypothesis of four cascades × seventeen views was not exact: it is **four cascades × nine RGB views = 36 directional passes**, plus eight aux views without those shadows.

With shared shadows and batched labels, the corrected full-rig verification frame measured **255.945 ms rendering**, **58.715 ms directional shadows**, and **7.134 ms transfer**. This single-frame result is diagnostic, not a substitute for the multi-tick throughput rows.

GPU transfer is distinct from the host wait and host copy: the full products copy **25 staging buffers / 92,160,000 bytes** per tick. ~7.13 ms corresponds to ~12.9 GB/s transfer. Mapping waits include outstanding rendering, not just PCIe copies. Host materialization of mapped buffers was typically tens of milliseconds (often ~17 ms in these runs). Changing the on-disk depth to f16 does **not** halve GPU readback bytes in this implementation.

Limitations: GPU scopes contain their scheduled preprocessing/postprocessing; shadow scopes are not hardware-counter attribution to individual shader instructions. Timestamp systems/command encoders add CPU overhead, so profiled cadence and CPU-submit timings are diagnostic. The final long-clip timings are unprofiled. Clock state is not pinned, and these results cover Belmont only.

## Changes that paid

1. **Shared directional atlas, explicitly opt-in.** Each cascade is constructed over the union of the selected camera frustum slices, including rear-facing views. Every view receives the same cascade transforms/atlas, but only the first RGB view preprocesses/renders its directional cascades. It is not a forward-camera atlas incorrectly reused behind the vehicle. This replaces 36 directional passes with four. Historical controlled same-pose ablations showed ~356 → 59 ms of shadow work, and the corrected scopes agree on the size of that floor. The price is a larger footprint per texel and changed shadow imagery; it is a quality option, not byte-compatible shadow output.
2. **Remove duplicate unarmed render ticks.** The old two-flight guard ran before `PostUpdate` collection released a slot, producing armed frame sequences such as 30,31,33,34: two captures per three rendered frames. Collection now runs before posing (`PreUpdate`), retaining the two-flight limit but avoiding the systematic duplicate frame.
3. **Ordered readback and frame fences.** Copies are explicitly after `RenderGraphSystems::Submit`, not an unordered root-graph system submitting independently. The copy submission index is retained and waited on, rather than waiting on all subsequently submitted device work. This is also a same-tick correctness fix. The large GPU wait was real rendering; no unsupported claim is made that changing the fence alone removes hundreds of milliseconds.
4. **Batchable exact-label material.** A shared aux material reads packed ID/class from `MeshTag`, rather than creating one StandardMaterial per scene instance. No duplicated mesh asset is needed. The aux pass remains separate: this is not an MRT implementation. Controlled ablations reduced total 17-view GPU time further, roughly 297 → 258 ms after shared shadows, on the historical camera poses.
5. **Hardware ray-query lidar.** The immutable static scene is built into 1031 hardware BLASes and 11,886 instances in a TLAS. Stored vertices are 104,591,136 bytes (2,178,982 unique triangles), while the logical instanced scene contains 266,117,181 triangles. Dynamic actors retain the CPU intersection/nearest-hit merge. The corrected 780,288-ray batch measured **0.732 ms of device trace time**. Upload/direction construction and host decode/actor merge still take tens of milliseconds; the GPU trace is not the complete lidar-stage time.
6. **Final-video path.** The harness-side encoder implementation was integrated and hardened: ordered frames, tight RGBA rows, no intermediate RGB images, final encoder joins before `AppExit`, per-camera frame-count assertions, and lossless label/depth/point products kept separate. Main owns the original encoder/subset/representation work; this work owns GPU profiling, shadow sharing, cadence/readback fixes, hardware rays, calibration/label fixes and the integration corrections below.
7. **Instanced CPU acceleration prerequisite.** The existing instanced accelerator was integrated, not re-derived. Logical triangle count must not be confused with stored triangle count. It enables practical repeated real-map experiments and retains the CPU reference path.

## Correctness findings that change interpretation

### Camera basis, mount axes and chase calibration

The compiled ego quaternion rotates **+X** into the motion direction. Bevy cameras look down **-Z**. The previous harness applied ego × mount directly to a camera, so a declared forward camera looked sideways. At Belmont tick 400, velocity was `[-8.6102,0,0.082993]`; transformed +X aligned with it, transformed -Z did not.

The CARLA adapter actually lowers mount `(x,y,z)` to CARLA `(x,z,y)` and passes source yaw through. The corrected common mount rotation is **Y(-sourceYaw) × Z(pitch) × X(roll)**; camera orientation additionally applies **Y(-90°)** for the optical basis. This also corrects the mirrored nonzero yaw mounts of four lidars and two radars. Source-sign angles remain stored in the rig definition and are documented as such.

The previous native chase was **-8 m / 3 m / -6° / HFOV 58°**. CARLA parity uses **-9 m / 3.4 m / -11.3° / HFOV 70°**. `rig.rs` now uses the latter. Direction tests assert the constructed chase forward against the ego heading and its ground aim ~8 m ahead, plus pitch/roll/yaw behavior, not a particular quaternion representation.

Both corrected tick-400 1080p images were visually inspected. The forward camera now sees the road, readable STOP marking, gate and horizon; the chase sees the same road from behind/above. The bike-lane arrow points away and STOP is not mirrored. The harness omits the ego cuboid, so its absence is not evidence about camera direction.

### Label corruption from debanding

StandardMaterial's unlit output still goes through `main_pass_post_lighting_processing`. `Tonemapping::None` did not disable `DEBAND_DITHER`, so integer ID/class channels were perturbed by ±1. On a strict three-tick Belmont comparison, legacy versus the exact-label shader differed in **2,250,438 / 22,118,400 instance pixels (10.17%)** and **787,472 semantic pixels (3.56%)**. These were wrong labels, not benign image noise.

Aux cameras now explicitly disable debanding as well as tonemapping. After that correction, **102/102 shared artifacts** in the legacy-versus-batched comparison were byte-identical. A permanent rendered regression fixture uses class 8: the old binary emits invalid class 9 and fails; both corrected label paths pass. It tests actual PNG values, not component wiring.

### Encoder lifetime, padding and determinism

Bevy 0.19 `App::run()` replaces the caller's app with `App::empty()`. Looking up an encoder resource after `run()` silently skipped finalization in the initial harness-side implementation. Finalization now occurs inside the capture completion branch, before `AppExit` and before the capture summary. Every spawned encoder must receive exactly `planned_ticks`; all stdins close before any wait. The manifest is written only after containers are complete.

wgpu row padding is not video data. Non-aligned widths now write tight rows directly, without an extra full-frame allocation. An actual ffmpeg regression sends padded 66-pixel-wide frames out of order and verifies exactly two decoded frames in red-then-green order.

x264 uses fixed `threads=4:sliced-threads=0:sync-lookahead=0:deterministic=1`, GOP 50, CRF 18, yuv420p and bitexact output flags. These control encoder nondeterminism; they cannot repair differing input pixels. Reproducibility is only claimed for the tested build/driver/codec environment, not across versions.

## Lidar fidelity: fast, but not a CPU drop-in

The final corrected-mount exhaustive comparison, at tick 400, checked **all 780,288 beams**, not a sample:

- **2 hit/miss disagreements**.
- **676,066 matched hits**; **6685 instance-owner disagreements** (about 0.99%).
- **0 semantic-class disagreements among matched hits**.
- Range RMS difference **0.08209183 m**, maximum **67.20684052 m**.
- **33** matched hits differ by >1 mm; **18** by >1 cm; **13** by >10 cm; **6** by >1 m.
- Maximum intensity-proxy difference **0.23270363**.

An earlier 8045-beam sample reported a 0.31 mm maximum and missed the large outliers. An initial full check then disproved it; that check also preceded the mount-yaw correction. **Only the corrected exhaustive numbers above are current.** Neither a small RMS nor a successful sample is a safe bound on the worst first-hit error.

### Root cause of all six metre-scale discrepancies

The diagnostic build exports the winning hardware primitive and the CPU winning triangle and recomputes intersections in f64 against CPU world-rounded vertices. In all six >1 m cases, the nearer candidate is only **0.23–2.01 micrometres from a triangle edge**, comparable to or below a few world-coordinate f32 ULPs (about 0.95–7.63 µm in these examples).

| Ray | Nearer winner | Signed distance to nearest triangle edge (µm) |
|---:|---|---:|
| 45333 | CPU | +0.372 |
| 60332 | GPU | -2.013 |
| 322887 | GPU | +1.004 |
| 568400 | CPU | +1.790 |
| 668553 | CPU | +1.073 |
| 681725 | GPU | -0.233 |

For the 67.2 m discrepancy, CPU hits a leaf edge at **38.730972 m**, only 0.372 µm inside that edge; hardware misses that candidate and hits at **105.93781 m**. Two hardware nearer hits lie microscopically outside the CPU's world-rounded triangle when checked in f64. Conversely, CPU f32 misses a thin triangle that is valid in the f64 check. The implementations perform transformation/intersection rounding differently (local-space hardware instancing versus world-rounded CPU triangles, with CPU Möller–Trumbore arithmetic). A microscopic coverage difference produces a discontinuous change of first-hit surface. This is not a missing tick, bad TLAS index or a bounded millimetre-range error.

**Hardware lidar remains an explicit experimental fidelity option; CPU is the default.** The measured difference is relative to the CPU reference, not proof the CPU is physical ground truth. Exact compatibility would require a shared robust intersection/transform/tie definition, or GPU execution of the CPU-compatible intersection path. A permissive RMS tolerance or selectively ignoring these rays would hide the failure, not fix it.

Depth-image sampling was not chosen instead: nearest-texel sampling of a 1024² 90° cube face has roughly 0.001 rad half-pixel uncertainty near its center (~0.2 m laterally at 200 m), and visibility discontinuities can turn a tiny angular error into an arbitrarily larger range change. Six origins would also require up to 36 cube-face renders. Hardware queries avoid that angular quantization and use the actual beam directions, but the measured floating-point edge cases above still need an explicit contract.

## Determinism evidence and remaining exception

- Strict draws (`NoIndirectDrawing` plus CPU light clustering) are the default; `--fast-gpu` is explicit opt-out. No TAA was introduced.
- Before calibration correction, a three-tick full-rig strict repeat matched **132/132 artifact hashes**, including GPU point clouds. That is evidence for that short range, not proof for every pose or driver.
- The fast indirect mode changed **18,799 / 22,118,400 instance pixels (0.085%)** across five PNGs in the corresponding repeat; semantic classes were unchanged. This is why fast mode is not the default.
- Corrected-pose 40-tick video containers have exactly the right counts/order, but the ws1 pair has small SHA/decoded-frame differences. Independent corrected-pose raw PNG checking on ws2 found the front camera **31/40 byte-identical**, with the other nine frames differing by about **one or two boundary pixels**; chase was 40/40 identical. This is not an encoder reorder or a whole-image shading drift. It is a remaining raster boundary/order precision issue exposed by the forward road view.

Therefore **strict draw mode is not advertised here as a blanket guarantee of bit-identical camera output**. The corrected-view residual is explicitly retained as an exception; hashing must continue to detect it. Encoder-only settings and lossy compression must not be used to conceal it. The CPU/GPU lidar numerical discrepancy is a separate issue from repeat-run determinism.

## What did not pay, limits and remaining floor

- Canonical re-creation of static RGB draw entities was tested independently by Main on ws2 and rejected. It improved front-camera agreement from 31/40 to 37/40 frames, but made chase regress from 40/40 to 39/40, remained nondeterministic, and cost approximately 8% tick time. It shuffled boundary ownership rather than eliminating it; that experiment is not in this patch.
- The hardware encoder was not automatically faster. In the pre-calibration encoding experiment, NVENC took **0.116713 s/tick / 7248 MiB**, versus strict x264 **0.113557 s/tick / 6550 MiB**. It added a CPU-to-GPU upload/context path after GPU-to-CPU capture. This is historical encoding evidence, not a corrected-pose parity number. x264 remains default; NVENC remains optional and is not certified here for byte-hash reproducibility.
- The same pre-calibration fast-draw versus strict-draw video comparison improved only about **1.6%**. That was not worth making the nondeterministic path default.
- Two concurrent complete capture processes on this GPU were attempted with a 9800 MiB guard. The pair reached **9837 MiB** after **37.4 s** and was terminated before a qualified overlapping capture interval. No aggregate-throughput improvement is claimed inside the 10 GiB budget. This experiment used the same map assets before the optical correction; its result is a memory-capacity rejection, not a corrected-pose throughput number.
- MRT was not implemented. The remaining separate aux views still consume roughly 85–90 ms in the calibrated reference. Replacing them requires plumbing an integer label target through opaque/transparent/material pipelines and deciding how their coverage relates to the existing opaque aux-label contract. It is not merely deleting a camera.
- Current steady rendering still has a significant GPU raster floor, plus CPU command preparation/submission, staging-to-host copies and encoder/artifact work. Fully asynchronous ring-buffer readback/render preparation or cached/static render work could overlap more of that CPU cost; the present frame fence is not a claim of deep cross-tick pipelining.
- Hardware ray tracing itself is now below 1 ms; CPU beam construction/readback conversion remains tens of milliseconds but is largely overlapped. Reducing that in isolation is not the same as reducing whole-tick latency.
- The optimized full rig costs VRAM headroom: **8477 MiB** in the final performance run, versus **7112 MiB** reference. A diagnostic/verification run reached **9040 MiB**. On 10 GiB cards, do not grow this 720p full-product rig or switch maps without re-measuring. No all-map or arbitrary-camera-count guarantee is made.

## Reproduction

Common environment and inputs are listed above. Use the built binary with these key flags (plus `--rig-program`, `--glbs`, `--scene-state`, `--xodr`, and a fresh `--out` directory):

```text
# Correct, strict two-camera full-clip comparison:
--sensors parity-front --rgb-only --width 1920 --height 1080
--tick-count 1001 --settle-ticks 0 --warmup 30
--shared-shadows --video

# Full products, all 18 measurement sensors plus chase, hardware-ray option:
--width 1280 --height 720 --tick 400 --tick-count 64
--settle-ticks 0 --warmup 30 --shared-shadows --batch-ids
--lidar-backend gpu --video --point-format binary --depth-format f16

# Preserve the CPU ray reference instead:
# Same command, omit --lidar-backend gpu.

# Diagnostic: exhaustive beam comparison; not a throughput run:
--verify-gpu-lidar --profile-gpu --lidar-backend gpu
```

Scoped proof performed: release builds on ws1, real-map runs above, the failing-old/passing-new rendered-label regression, video padding/order regression, mount-direction tests, decoded container frame counts, repeat hashes, and numerical winning-triangle diagnostics. Formatters, linters and project-wide suites were not run by this assignment; integration-wide validation belongs to Main.

The exact final delivery source also passed `cargo check --offline -p sensors --bin sensor-capture --test sensors_test`, was rebuilt in release mode on ws1, and completed a fresh full-rig tick-400 smoke run with exhaustive hardware-ray checking. Binary SHA-256: `684773b2bfaa883dfa162374436ac07a8d2939e1199e15793a992ad79c61f774`. Evidence: `/home/simforge/astra2-results/final-delivery-proof/{summary.json,run.log,capture}`; exit status **0**. This reproduced the same six greater-than-one-metre boundary disagreements. Its verifier-inclusive time is not a throughput measurement.

Primary API/source references: [wgpu timestamp recording](https://docs.rs/wgpu/29.0.4/wgpu/struct.CommandEncoder.html#method.write_timestamp), [wgpu acceleration structures](https://docs.rs/wgpu/29.0.4/wgpu/struct.Device.html#method.create_blas), [Bevy App lifecycle](https://docs.rs/bevy_app/0.19.1/src/bevy_app/app.rs.html), and [Bevy cascade representation](https://docs.rs/bevy_light/0.19.1/bevy_light/cascade/struct.Cascade.html). Local CARLA calibration authority is `adapters/carla-exec/simforge_oss_carla_exec/{run_local.py,local.py}`; local PBR debanding is `renderer/vendor/bevy_pbr/src/render/pbr_functions.wgsl`.
