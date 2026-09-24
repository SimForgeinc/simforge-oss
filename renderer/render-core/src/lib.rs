//! render-core: headless Bevy scene renderer for SimForge.
//!
//! Owns scene ingestion (corpus GLB tiles), actor rendering, cameras,
//! passes (RGB / instance-ID / depth), lighting, atmosphere, the camera
//! look and its [`render_config::RenderConfig`], and the identity-stamped
//! GPU->CPU capture path ([`engine::SceneApp::capture`]).
//!
//! This crate has no binaries: the one executable is `simforge-render`
//! (the `service` crate), whose `dev` subcommand runs the measurement
//! tools in [`dev`].
//!
//! The `gpu-interop` feature adds `gpu_interop`, the exportable
//! Vulkan/CUDA output path; it is off by default and Linux-only. OS edges
//! of the baseline renderer (qualified wgpu backends, asset paths) live in
//! [`platform`].

pub mod actor_lights;
pub mod atmosphere;
pub mod calibration;
pub mod camera_model;
pub mod catalog;
pub mod cloud_noise;
pub mod clouds;
pub mod coordinates;
pub mod facade_windows;
pub mod fixture;
pub mod geometry_lod;
pub mod gpu_diagnostics;
pub mod ktx2_variant;
pub mod road_decals;
pub mod texture_residency;
#[cfg(all(feature = "gpu-interop", not(target_os = "linux")))]
compile_error!(
    "render-core: the `gpu-interop` feature is the Linux NVIDIA Vulkan->CUDA opaque-fd bridge \
     (VK_KHR_external_memory_fd / SCM_RIGHTS); it has no implementation on this target. \
     Build without it: the baseline host-copy path is the portable renderer."
);
pub mod dev;
pub mod engine;
#[cfg(feature = "gpu-interop")]
pub mod gpu_interop;
pub mod lighting;
pub mod night;
pub mod platform;
pub mod products;
pub mod profiles;
pub mod readiness;
pub mod render_config;
pub mod road_detail;
pub mod scene_state;
pub mod shared_shadows;
pub mod sky_pass;
pub mod sky_texture;
pub mod veg;
pub mod vehicle_model;
pub mod weather;
