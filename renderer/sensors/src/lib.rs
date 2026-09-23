//! sensors: CARLA-surface sensor suite on top of render-core (WSB3).
//!
//! Modules:
//! - [`rig`]: Pronto port-E rig + chase camera parsing.
//! - [`taxonomy`]: semantic class taxonomy and legend types.
//! - [`scene_state`]: scene-state.v1 consumer.
//! - [`bvh`]: deterministic CPU raycast scene (triangle soup + BVH).
//! - [`lidar`]: beam-pattern raycast lidar model.
//! - [`radar`]: ray-fan radar with exact radial velocities.
//! - [`imu_gnss`]: ego-track IMU/GNSS derivation + inverse tmerc geodetic.
//! - [`formats`]: carla-bridge-format artifact writers (PLY/CSV/JSONL).
//! - [`capture`]: the multi-camera multi-pass capture harness (bin
//!   `sensor-capture` drives it).

pub mod bvh;
pub mod gpu_rays;
pub mod capture;
pub mod formats;
pub mod imu_gnss;
pub mod lidar;
pub mod occupancy;
pub mod radar;
pub mod rig;
pub mod scene_state;
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

/// sha256 of a byte slice, hex-encoded.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

/// sha256 of a file's contents, hex-encoded.
pub fn sha256_file(path: &std::path::Path) -> anyhow::Result<String> {
    Ok(sha256_hex(&std::fs::read(path)?))
}
