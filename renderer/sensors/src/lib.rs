//! sensors: the ray sensors and label taxonomy behind `simforge-render`.
//!
//! Modules:
//! - [`taxonomy`]: semantic class taxonomy and legend types.
//! - [`bvh`]: deterministic CPU raycast scene (instanced BVH), the lidar
//!   and radar reference.
//! - [`gpu_rays`]: RT-core ray casting, bit-identical to [`bvh`].
//! - [`lidar`]: beam-pattern raycast lidar model.
//! - [`radar`]: ray-fan radar with exact radial velocities.
//! - [`formats`]: carla-bridge-format artifact writers (PLY/CSV).

pub mod bvh;
pub mod gpu_rays;
pub mod formats;
pub mod lidar;
pub mod radar;
pub mod taxonomy;

/// Worker pool for ray work, kept separate from Bevy's shared pools.
///
/// Lidar and radar saturate every core for over a second per tick. Running
/// that on `ComputeTaskPool` starves the renderer's own mesh/material
/// preparation jobs, and running it on `IoTaskPool` starves the PNG writes —
/// both were observed as a stalled capture with an idle GPU. This pool leaves
/// four logical CPUs for the renderer and the frame loop.
pub static RAY_POOL: std::sync::LazyLock<bevy::tasks::TaskPool> =
    std::sync::LazyLock::new(|| {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4); // fallback-ok: thread-pool size only; results do not depend on it
        let threads = cores.saturating_sub(4).clamp(1, 16);
        bevy::tasks::TaskPoolBuilder::new()
            .num_threads(threads)
            .thread_name("sensor-ray".to_string())
            .build()
    });
