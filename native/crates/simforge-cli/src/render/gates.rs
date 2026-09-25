//! The two gates a render must pass besides pixels: every wheel stands on
//! the rendered ground (contact), and the renderer drew every actor where
//! the shared sampler says it is (parity). Both are the simforge-core
//! functions the platform worker and the golden harness run.

use std::path::Path;

use serde_json::{json, Value};
use simforge_core::map::ground::GroundSurface;
use simforge_core::trace::timeline::contact_gate::{check_contact, ContactGateReport};
use simforge_core::trace::timeline::parity::{compare_observed_jsonl, ParityProfile, ParityReport};
use simforge_core::trace::timeline::RenderTimeline;

use crate::contract::CliError;

/// Wheel contact tolerance of the platform gate (docs/engineering/ground-height.md).
pub const CONTACT_TOLERANCE_M: f64 = 0.03;

/// Check wheel contact against the map's ground derivative. `None` when the
/// map has none; the caller records that as a warning, never as a pass.
pub fn contact(
    timeline: &RenderTimeline,
    ground_mesh: Option<&Path>,
) -> Result<Option<ContactGateReport>, CliError> {
    let Some(path) = ground_mesh else {
        return Ok(None);
    };
    let bytes = std::fs::read(path).map_err(|e| {
        CliError::new(
            "missing_file",
            format!("cannot read {}: {e}", path.display()),
        )
    })?;
    let ground = GroundSurface::decode(&bytes).map_err(|e| {
        CliError::findings("map_invalid", format!("ground mesh: {e}"))
            .with_path(path.display().to_string())
    })?;
    Ok(Some(check_contact(timeline, &ground, CONTACT_TOLERANCE_M)))
}

/// Grade `<out>/observed-frames.jsonl` against the timeline (Bevy profile).
pub fn parity(timeline: &RenderTimeline, observed: &Path) -> Result<ParityReport, CliError> {
    let text = std::fs::read_to_string(observed).map_err(|e| {
        CliError::new(
            "render_failed",
            format!(
                "the renderer wrote no observed frames ({}): {e}",
                observed.display()
            ),
        )
    })?;
    compare_observed_jsonl(timeline, &text, &ParityProfile::bevy()).map_err(|e| {
        CliError::findings("parity_rejected", e.to_string())
            .with_path(observed.display().to_string())
    })
}

/// A compact summary of a contact report for the CLI result.
pub fn contact_summary(report: &ContactGateReport) -> Value {
    json!({
        "pass": report.pass,
        "checked": report.checked,
        "maxAbsGapM": report.max_abs_gap_m,
        "unsupported": report.unsupported,
        "failureCount": report.failure_count,
        "toleranceM": report.tolerance_m,
        "groundSha256": report.ground_sha256,
        "worst": report.failures.first(),
    })
}
