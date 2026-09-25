//! `simforge render` and `env serve`: the pieces between a workspace and the
//! renderer's own job/episode path.
//!
//! Pure ports of the TypeScript native engine (packages/render/src/native)
//! produce the render service's wire JSON (scene-state frames, rig, lighting,
//! the actor closure a render binds) and the videos made from a job's
//! artifacts; `job_runner` runs the renderer in process and `gates` checks
//! its output.

pub mod actor_assets;
pub mod canonical;
pub mod derivatives;
pub mod error;
pub mod gates;
pub mod geometry_lod;
pub mod job_runner;
pub mod jsjson;
pub mod ktx2;
pub mod lighting;
pub mod lowering;
pub mod luminaires;
pub mod map_closure;
pub mod residency;
pub mod rig;
pub mod road_decals;
pub mod schedule;
pub mod sensor_video;
pub mod signal_heads;
#[cfg(test)]
pub(crate) mod testing;
pub mod textures;
pub mod video;
