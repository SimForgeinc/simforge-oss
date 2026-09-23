//! Opt-in per-pass GPU timing for profiling the resident engine.
//!
//! Set `SIMFORGE_RENDER_DIAGNOSTICS=1` before building a [`crate::engine::SceneApp`]
//! and Bevy's `RenderDiagnosticsPlugin` records a timestamp pair (and, where
//! the adapter supports it, pipeline statistics) around every instrumented
//! render pass. [`drain`] sums everything synced into the `DiagnosticsStore`
//! since the previous call, per diagnostic path, and clears the history so
//! consecutive calls never double count.
//!
//! Every view records its own span under the same path, so a total is the
//! sum over views and frames; `count` is the number of spans summed.
use bevy::diagnostic::DiagnosticsStore;
use bevy::prelude::World;

/// Environment switch read once at app construction.
pub const ENV: &str = "SIMFORGE_RENDER_DIAGNOSTICS";

/// Whether the diagnostics plugin should be installed.
pub fn enabled() -> bool {
    std::env::var_os(ENV).is_some_and(|value| !value.is_empty() && value != "0")
}

/// Sum of one diagnostic path since the last drain.
#[derive(Clone, Debug, serde::Serialize)]
pub struct PassTotal {
    pub path: String,
    pub total: f64,
    pub count: usize,
}

/// Sum and clear every `render/...` diagnostic in the store.
pub fn drain(world: &mut World) -> Vec<PassTotal> {
    let Some(mut store) = world.get_resource_mut::<DiagnosticsStore>() else {
        return Vec::new();
    };
    let mut totals = Vec::new();
    for diagnostic in store.iter_mut() {
        let path = diagnostic.path().as_str().to_string();
        if !path.starts_with("render/") {
            continue;
        }
        let (total, count) = diagnostic
            .values()
            .fold((0.0f64, 0usize), |(sum, n), value| (sum + value, n + 1));
        if count > 0 {
            totals.push(PassTotal { path, total, count });
        }
        diagnostic.clear_history();
    }
    totals.sort_by(|a, b| a.path.cmp(&b.path));
    totals
}
