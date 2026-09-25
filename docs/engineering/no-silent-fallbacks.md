# No silent fallbacks in render output

Missing, failed, or unsupported data never silently degrades a render. Every
case does exactly one of these:

1. **Fail the job** with a machine code that names the missing thing
   (`native_*` for the Bevy path, `carla_*` for CARLA, `render_*` for
   engine-neutral checks) and a message that names the actor, sensor, file or
   field involved. These errors are never retryable: a different worker would
   fail the same way.
2. **Substitute explicitly**, only where the substitution is genuine product
   behaviour. The job input must request it (the render intent's
   `allowSubstitutions`), and the engine must record every substitution it
   makes in its manifest (`substitutions`, negotiated by the
   `render-evidence.substitutions` control feature). The job result then
   carries it. Absent the request, the job fails.

Interactive preview paths may degrade, but only when the degradation is
visibly labelled.

## Mechanics

- The native service (`renderer/service`) prefixes policy errors with
  `[native_<code>] `. A host maps that prefix to its own coded error (the
  hosted render worker reports `render.<code>`, non-retryable).
- CARLA (`adapters/carla-exec`) raises its contract error with a `carla_*` code.
- The `simforge` CLI reports the same codes in its JSON result and exits
  non-zero.
- New manifest fields follow the control-feature rule: a named feature
  constant (for example `CONTROL_FEATURE_RENDER_SUBSTITUTIONS =
  "render-evidence.substitutions"` in
  `adapters/carla-exec/simforge_oss_carla_exec/runtime/policy.py`), written
  only when the job's control features list it.

## Review convention

A deliberate fallback construct (`unwrap_or*`, `.ok()`, `let _ =`,
`Err(_) =>` in Rust; `except ...: pass`, `.get(key, default)`,
`or <literal>` in Python) carries a `fallback-ok: <reason>` comment on its line
or the line above, so a reviewer reads the reason in the diff. The CARLA cases
are pinned by `adapters/carla-exec/tests/test_no_silent_fallbacks.py`.

## Findings

The tables below are maintained with the code: a row is added or updated
whenever a fallback is removed or made explicit.

"Fail" means the job fails with the given code. "Explicit" means the
substitution happens only when requested, and is then recorded. "Benign" is
explained in the row. Unless a path says otherwise, Rust paths are under
`renderer/` and CARLA paths are under `adapters/carla-exec/simforge_oss_carla_exec/`.

### Ray sensors and actor geometry (native service)

| Location | Before | Now | Test |
|---|---|---|---|
| `render-core/src/engine.rs` `actor_sensor_meshes`, `service/src/server.rs` `snapshot_actor_sensor_instances` / `build_actor_sensor_scene` | Lidar/radar actor tree built from the hidden `actor:<id>` cuboid (12 tris). GLB meshes had no InstanceId, so every car was a box | Every visible drawn mesh node: rigid nodes at their world pose, skins CPU-posed like `skinning.wgsl`. Two-level tree: a `Blas` per mesh asset cached per job; the TLAS is built per tick | `bvh::shared_blas_tests::*`, `engine::sensor_mesh_tests::*`, GPU `actor_sensor_meshes_are_the_drawn_catalog_meshes` |
| `engine.rs` `attach_actor_asset` ID clones | Instance/semantic pass drew the cuboid clone | Layer-1 clones of the GLB meshes (skinned clones keep the skin); the cuboid clone is hidden | GPU test above (ID silhouette is not a filled box) |
| `engine.rs` `finalize_scene` | `next_instance_id` started at 0, so actor ids collided with static legend ids 1..N (ID/semantic pass, lidar classes, radar velocity) | Actors start above the legend max; spawning before the legend is frozen fails | GPU test above (`actor ids never reuse static legend ids`) |
| `engine.rs` `static_sensor_triangles` / `mesh_local_triangles` | Meshes without data, with non-f32x3 positions or with non-triangle topologies were skipped or misread | Fail, naming the mesh | `unreadable_meshes_fail_instead_of_disappearing_from_lidar` |
| `server.rs` `CombinedSensorScene` | Both layers cast to full range | Actor layer cast only up to the static hit (same result) | `combined_scene_prunes_actors_behind_static_hits_without_changing_results` |
| `server.rs` `run_sensor_work` | Unknown hit id became class Prop, velocity 0 | Fail `native_sensor_instance_unknown` | covered by `scans_on_the_sensor_thread_match…` fixture |

### Native service scene, models and sensors

| Location | Before | Now | Test |
|---|---|---|---|
| `server.rs` `resolve_actor_model` | No catalog id, no catalog dir, or unresolved id kept a grey cuboid | Fail `native_actor_catalog_missing` / `_catalog_unavailable` / `native_actor_model_unresolved`; `allowPrimitiveActors` is an explicit, logged harness opt-in the engine never sets | service suite |
| `server.rs` `apply_actor_model` | Missing GLB or failed load: `eprintln`, cuboid kept | Fail `native_actor_model_missing` / `_model_load_failed` | — |
| same | Missing walk/idle clip: bind-pose model; `let _ = set_actor_animation_time`; clip fixed at first attach | Fail `native_actor_animation_missing` / `_animation_failed`; an idle↔walk change rebinds the GLB (`detach_actor_asset`) | GPU test (skin follows the clip, rebind) |
| same | `scaleToDims` without a model length: scale 1.0 | Fail `native_actor_model_scale_unknown` | — |
| same | Class palette colour tinted `body_paint` when no colour was authored | Only an authored colour tints | — |
| `server.rs` `apply_scene_tick`, `scene.rs` | Class defaulted to `prop`, dims to a class table, rotation to identity, `tickHz` to 0. Stale actors stayed frozen; identity changes ignored | Class, dims, rotation and `tickHz` required, finite unit pose. Fail `native_actor_identity_changed`, `native_scene_actor_unaccounted`, `_duplicated`, `native_scene_map_mismatch`. A new stream is a new world | `authored_actor_height_precedes_mesh_ground`, scene tests |
| `engine.rs` `GroundField::sample` / `server.rs` `actor_base_y` | Off-map height became the scene median, or 0 | Fail `native_ground_height_unavailable` | `base_y_precedence` test |
| `sensors/src/lidar.rs`, `server.rs` `upsert_*_rig`, `proto.rs` | Lidar steps clamped to 64..4096, `channels.max(1)`, all fields defaulted | Wire fields required; fail `native_lidar_config_invalid` / `native_radar_config_invalid` / `native_camera_config_invalid` (FOVs, range, depth encoding) | service suite |
| `sensors/src/radar.rs` `from_points_per_second` | Floor of 64 rays; `tick_hz` fell back to 20 | Budget below 64 per frame fails; `tick_hz` from the frame, required | — |
| `sensors/src/taxonomy.rs`, `service/src/carla.rs` | van/suv/pickup/motorcycle → Prop (lidar) or unlabeled (CARLA semantic); unknown → Prop/0 | Vehicles map to Car/VEHICLE; unknown class fails `native_actor_class_unmapped`; unknown ID-pass instance fails `native_semantic_instance_unknown` | carla tests |
| `service/src/carla.rs` `depth_to_carla` | Finite-far projection on Bevy's infinite reverse-Z: every CARLA depth wrong, background read as near | `z = near/d`; background saturates at 1000 m | `carla_depth_round_trip`, `depth_background_is_far` |
| `server.rs` `auto_meter` | Error printed; view kept another heading's exposure | Fail `native_auto_meter_failed` | — |
| `server.rs` `encode_jpeg_op` | JPEG of id/depth bytes | Fail `native_jpeg_pass_unsupported` | — |
| `server.rs` ResetEpisode | Camera size/profile/semantic/depth silently rewritten | Fail `native_episode_camera_conflict` | — |
| `render-core/src/vehicle_model.rs` | Entries without `glbPath` skipped; `tintable` defaulted true/false inconsistently; `manifest.json` catalog path and unreadable manifest ignored; `model.clips` ignored (frozen pedestrians) | Strict: bad entries fail; `tintable`/`scaleToDims` required; `animated` entries must bind clips; `model.clips` bound as idle/walk; sidecar only | `generated_sidecar_resolves…` |

### Renderer lighting, vegetation, device, harnesses

| Location | Before | Now | Test |
|---|---|---|---|
| `engine.rs` `Lighting`, `night.rs` | Unknown/camelCase keys dropped; rung 4 silently became 3; fixture budget capped at 12/2; lumens, range, CCT and night lux clamped; fixture cone ignored | `deny_unknown_fields`; `validate_for_scene_app` fails `native_lighting_unsupported`; the authored cone is rendered | engine suite |
| `service/src/server.rs` `SceneSpec.lighting` | Absent lighting meant the calibration dawn | Required | — |
| `render-core/src/job.rs` (native-render-job; removed) | The job's lighting was never applied | `apply_lighting` | — |
| `engine.rs` `update_physical_windows` | Occupancy keyed on entity bits (changed from run to run); missing material skipped | Stable order; missing material fails | — |
| `render-core/src/veg.rs` | Bad sidecar, missing scene or prototype dropped vegetation with a log line | Readiness fails, naming it | — |
| `engine.rs` `new_with_profile_config` | Software (CPU/virtual) adapters accepted silently | Fail `native_gpu_adapter_software` unless `SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER=1`; adapter logged | — |
| `render-core/src/playback.rs` (scen-play; removed, scene-state playback is now `simforge-render job --job`) | Missing models → primitives; generic pedestrians hash-substituted; missing GLB → primitive | `--allow-primitive-actors` / `--allow-pedestrian-substitution` required (logged); missing GLB fails. Golden scenes pass the catalogs explicitly | golden harness |
| `sensors/src/capture.rs` (sensor-capture; removed with the binary) | Proxy actors everywhere, fixed lighting | Benign for the product: a qualification harness whose help text states it uses proxy actors. Listed in the guard baseline as a harness | — |

### CARLA

| Location | Before | Now |
|---|---|---|
| `runtime/backend.py`, `local.py` | Generated-XODR world labelled exact (an env switch) | Fail `carla_map_not_cooked`; switch removed and refused |
| `runtime/backend.py` | Cooked maps ignored requested sun and time of day | Fail `carla_environment_unsupported_on_cooked_map` unless the request equals the registered baked environment (registry empty: see open decisions) |
| `runtime/backend.py`, `runtime/executor.py` | Unspawnable actors dropped; props ungraded | Fail `carla_actor_spawn_refused`; the gate expects all actors |
| `runtime/executor.py`, `runtime/backend.py` | Nearest-body substitution, MKZ→Impala alias, alphabetical pick without dims | Fail `carla_blueprint_unavailable` unless `allowSubstitutions: ['carla-actor-body']`; recorded |
| `runtime/policy.py`, `runtime/backend.py` | Walker animation never checked (frozen / T-pose) | Fail `carla_walker_animation_inactive` (leg bones must move) |
| `runtime/backend.py` lidar | 20 ms partial sweeps; CARLA drop-off/noise defaults | Full revolutions; explicit attributes read back; fail `carla_lidar_schedule_unsupported` |
| `runtime/materialized_traffic.py` | z=0, obstacle → sedan | Fail `carla_ambient_traffic_unsupported` |
| `runtime/timeline.py`, `runtime/compiler.py`, `local.py`, `runtime/sensor_video.py`, `runtime/replay.py` | Doors reported but not rendered; kind/pose defaults; fps/size/quality ignored; preferred capability enabled physics; env z offsets; truncated videos | See the `carla-exec` commit: each fails with a `carla_*` code or is recorded |

### Open decisions (not silently resolved)

- **CARLA cooked-map lighting.** The baked-environment registry is empty, so every cooked-map CARLA render fails until either each map's baked sun is measured, or a `carla-cooked-map-lighting` substitution kind is added (explicit and recorded).
- **Walker animation in CARLA.** Moving walkers probably fail `carla_walker_animation_inactive` until trace replay drives the animation. Confirm with `pose-smoke` on a CARLA box.
- **CARLA bodies.** 37 generated-body ids and 17 unavailable road-user ids, plus 9 semantic-substitute props, now need `allowSubstitutions: ['carla-actor-body']`. Nothing sets it yet (no UI).
- **Moving animals.** They fail `native_actor_animation_missing` until the closure has animal clips.
- **Rust kind→catalog default table** (`native/crates/simforge-core/src/trace/scene_state.rs`). Van, scooter, robot, drone and animal default to a sedan, so those unauthored actors fail `native_actor_default_mismatch`. Fixing it moves timelines and needs an ENGINE_SEM_VER bump.
- **Service features.** Lidar upper/lower FOV and per-camera clip planes are not implemented in the service, so requests that need them are refused with a coded error.
