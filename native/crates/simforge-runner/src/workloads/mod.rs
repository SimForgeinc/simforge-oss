//! Workload adapters: one [`crate::engine::JobEngine`] per engine workload,
//! each linking the native execution crates directly.

pub mod articulated;
pub mod compile;
pub mod episode_batch;
pub mod gpu_batch;
pub mod policy_episodes;
pub mod render_bundle;
pub mod render_bundle_nurec;
pub mod simulate;

use crate::engine::EngineRegistry;
use crate::error::Result;

/// Every workload this binary can execute.
pub fn registry() -> Result<EngineRegistry> {
    let mut engines = EngineRegistry::new();
    engines.register(Box::new(compile::CompileEngine))?;
    engines.register(Box::new(simulate::SimulateEngine))?;
    engines.register(Box::new(episode_batch::EpisodeBatchEngine))?;
    engines.register(Box::new(policy_episodes::PolicyEpisodesEngine))?;
    engines.register(Box::new(articulated::ArticulatedEngine))?;
    engines.register(Box::new(gpu_batch::GpuBatchEngine))?;
    engines.register(Box::new(render_bundle::RenderBundleEngine))?;
    engines.register(Box::new(render_bundle_nurec::NurecRenderBundleEngine))?;
    Ok(engines)
}
