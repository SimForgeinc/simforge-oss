//! render-core: headless Bevy scene renderer for SimForge.
//!
//! Owns scene ingestion (corpus GLB tiles), actor rendering, cameras,
//! passes (RGB / instance-ID / depth / motion vectors), lighting,
//! atmosphere, post and render profiles, and the identity-stamped
//! GPU->CPU capture path ([`engine::SceneApp::capture`]).
//!
//! Binaries:
//! - `native-render-job`: batch job renderer over [`job`].
//! - `scen-play`: scene-state.v1 trace playback with actors + motion vectors.
//! - `sky-bench`, `parity-check`: measurement tools.
//!
//! The `gpu-interop` feature adds `gpu_interop`, the exportable
//! Vulkan/CUDA output path; it is off by default and Linux-only. OS edges
//! of the baseline renderer (qualified wgpu backends, asset paths) live in
//! [`platform`].

pub mod actor_lights;
pub mod atmosphere;
pub mod calibration;
pub mod catalog;
pub mod cloud_noise;
pub mod clouds;
pub mod facade_windows;
pub mod fixture;
#[cfg(all(feature = "gpu-interop", not(target_os = "linux")))]
compile_error!(
    "render-core: the `gpu-interop` feature is the Linux NVIDIA Vulkan->CUDA opaque-fd bridge \
     (VK_KHR_external_memory_fd / SCM_RIGHTS); it has no implementation on this target. \
     Build without it: the baseline host-copy path is the portable renderer."
);
#[cfg(feature = "gpu-interop")]
pub mod gpu_interop;
pub mod motion_vector;
pub mod playback;
pub mod readback;
pub mod readiness;
pub mod scene_state;
pub mod engine;
pub mod job;
pub mod lighting;
pub mod night;
pub mod sky_pass;
pub mod road_detail;
pub mod platform;
pub mod post_grain;
pub mod profiles;
pub mod sky_texture;
pub mod veg;
pub mod vehicle_model;
pub mod weather;
