//! Readiness states, and the GPU evidence behind them.
//!
//! The protocol's readiness states are promises to the editor, so each one
//! needs a producer that can actually be false:
//!
//! | state | producer |
//! |---|---|
//! | `starting` | process launched, nothing proven |
//! | `manifest-ready` | `.map-release.json` parsed and its digests verified |
//! | `coarse-ready` | every node in the coarse plan is resident |
//! | `interactive` | coarse resident **and** the render world has no pipeline compiling and no material unbound for [`GPU_IDLE_FRAMES`] consecutive frames |
//! | `complete` | the streaming scheduler has nothing left to admit within budget, and the GPU is idle again |
//! | `device-lost` | wgpu device-lost callback, or injected fault |
//! | `error` | any rejection above, or a load failure |
//!
//! The pipeline/material counters are the concept proven in
//! `render-core/src/readiness.rs` for the headless capture harness: asset
//! load state says bytes are in RAM, which says nothing about whether the
//! render world can draw them. Bevy skips a draw whose pipeline is still
//! `Queued`/`Creating` and a mesh whose material has no bind group yet, so
//! "assets loaded" and "the user can interact with what they see" are
//! different facts. Sampled in the render world, published to the main world.

use bevy::pbr::{RenderMaterialBindings, RenderMaterialInstances};
use bevy::prelude::*;
use bevy::render::render_resource::{CachedPipelineState, PipelineCache};
use bevy::render::{Render, RenderApp, RenderSystems};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Consecutive idle render frames required before a state is announced: a
/// freshly bound material can queue a new pipeline permutation on the next
/// frame, so one idle sample proves nothing.
pub const GPU_IDLE_FRAMES: u32 = 3;

/// The readiness states of the native viewport contract, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Readiness {
    Starting,
    ManifestReady,
    CoarseReady,
    Interactive,
    Complete,
    DeviceLost,
    Error,
}

impl Readiness {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::ManifestReady => "manifest-ready",
            Self::CoarseReady => "coarse-ready",
            Self::Interactive => "interactive",
            Self::Complete => "complete",
            Self::DeviceLost => "device-lost",
            Self::Error => "error",
        }
    }

    /// Load progress is monotonic; failure states are always reachable.
    pub fn may_advance_to(self, next: Self) -> bool {
        match next {
            Self::DeviceLost | Self::Error => true,
            _ => next > self && self < Self::Complete,
        }
    }
}

impl Default for Readiness {
    fn default() -> Self {
        Self::Starting
    }
}

/// Shared between the main and render worlds; written by the render world.
#[derive(Resource, Clone, Default)]
pub struct GpuPending {
    pipelines: Arc<AtomicUsize>,
    materials: Arc<AtomicUsize>,
    samples: Arc<AtomicUsize>,
}

impl GpuPending {
    /// Pipelines whose GPU object has not finished compiling.
    pub fn pipelines(&self) -> usize {
        self.pipelines.load(Ordering::Acquire)
    }

    /// Distinct materials referenced by a mesh entity with no prepared bind
    /// group yet (textures still uploading, bind group not allocated).
    pub fn materials(&self) -> usize {
        self.materials.load(Ordering::Acquire)
    }

    /// Render frames sampled; zero means the render world has not run.
    pub fn samples(&self) -> usize {
        self.samples.load(Ordering::Acquire)
    }

    pub fn is_idle(&self) -> bool {
        self.samples() > 0 && self.pipelines() == 0 && self.materials() == 0
    }
}

/// Counts consecutive idle GPU frames, resetting on any pending work.
#[derive(Resource, Default)]
pub struct GpuSettle {
    idle_frames: u32,
    last_sample: usize,
}

impl GpuSettle {
    /// Advance at most once per sampled render frame; returns true when the
    /// GPU has been idle for [`GPU_IDLE_FRAMES`] consecutive frames.
    pub fn poll(&mut self, pending: &GpuPending) -> bool {
        let sample = pending.samples();
        if sample != self.last_sample {
            self.last_sample = sample;
            self.idle_frames = if pending.is_idle() { self.idle_frames + 1 } else { 0 };
        }
        self.idle_frames >= GPU_IDLE_FRAMES
    }

    /// Forget the accumulated evidence; used when new work is admitted or the
    /// device is recreated.
    pub fn reset(&mut self) {
        self.idle_frames = 0;
    }
}

pub struct GpuReadinessPlugin;

impl Plugin for GpuReadinessPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GpuPending>();
        app.init_resource::<GpuSettle>();
    }

    fn finish(&self, app: &mut App) {
        let pending = app.world().resource::<GpuPending>().clone();
        let Some(render_app) = app.get_sub_app_mut(RenderApp) else {
            // A build with no render app has nothing to compile and nothing
            // to bind, so it is idle by construction. Publishing one sample
            // says exactly that, instead of stalling readiness on evidence
            // that can never arrive.
            pending.samples.store(1, Ordering::Release);
            return;
        };
        render_app
            .insert_resource(pending)
            .add_systems(Render, sample_pending.after(RenderSystems::Render));
    }
}

fn sample_pending(
    pending: Res<GpuPending>,
    pipeline_cache: Res<PipelineCache>,
    instances: Res<RenderMaterialInstances>,
    bindings: Res<RenderMaterialBindings>,
) {
    let pipelines = pipeline_cache
        .pipelines()
        .filter(|pipeline| {
            matches!(
                pipeline.state,
                CachedPipelineState::Queued | CachedPipelineState::Creating(_)
            )
        })
        .count();
    let mut unbound = HashSet::new();
    for instance in instances.instances.values() {
        if !bindings.contains_key(&instance.asset_id) {
            unbound.insert(instance.asset_id);
        }
    }
    pending.pipelines.store(pipelines, Ordering::Release);
    pending.materials.store(unbound.len(), Ordering::Release);
    pending.samples.fetch_add(1, Ordering::AcqRel);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_advances_forward_and_always_admits_failure() {
        assert!(Readiness::Starting.may_advance_to(Readiness::ManifestReady));
        assert!(Readiness::CoarseReady.may_advance_to(Readiness::Interactive));
        assert!(Readiness::Interactive.may_advance_to(Readiness::Complete));
        // No regressions, no repeats.
        assert!(!Readiness::Interactive.may_advance_to(Readiness::CoarseReady));
        assert!(!Readiness::Interactive.may_advance_to(Readiness::Interactive));
        // Failure interrupts any state, including the terminal one.
        assert!(Readiness::Complete.may_advance_to(Readiness::DeviceLost));
        assert!(Readiness::Complete.may_advance_to(Readiness::Error));
        assert!(!Readiness::Complete.may_advance_to(Readiness::Interactive));
    }

    #[test]
    fn settle_requires_consecutive_idle_frames_from_distinct_samples() {
        let pending = GpuPending::default();
        let mut settle = GpuSettle::default();
        // No render frame sampled yet: not idle, however often we poll.
        for _ in 0..10 {
            assert!(!settle.poll(&pending));
        }
        // Three distinct idle samples settle it; a repeat of the same sample
        // must not count twice.
        for expected in [false, false, true] {
            pending.samples.fetch_add(1, Ordering::AcqRel);
            assert_eq!(settle.poll(&pending), expected);
            assert_eq!(settle.poll(&pending), expected);
        }
        // A frame with a compiling pipeline throws the evidence away.
        pending.pipelines.store(1, Ordering::Release);
        pending.samples.fetch_add(1, Ordering::AcqRel);
        assert!(!settle.poll(&pending));
        pending.pipelines.store(0, Ordering::Release);
        for expected in [false, false, true] {
            pending.samples.fetch_add(1, Ordering::AcqRel);
            assert_eq!(settle.poll(&pending), expected);
        }
    }
}
