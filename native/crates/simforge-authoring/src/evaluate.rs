//! The reject filters as the authoring commands apply them: the filter mode
//! (`critical | negative-control | all`), the headline criticality band and
//! the verdict an intent rubric may combine with.

use simforge_core::evaluation::{EvaluateFilters, RejectCode, RejectFinding, Verdict};

/// `--filter`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FilterMode {
    #[default]
    Critical,
    NegativeControl,
    All,
}

impl FilterMode {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "critical" => Some(Self::Critical),
            "negative-control" => Some(Self::NegativeControl),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Critical => "critical",
            Self::NegativeControl => "negative-control",
            Self::All => "all",
        }
    }
}

/// `filtersFor(mode, {trivialTtcS, rejectCollisions})`. `negative-control`
/// is the same filter set with `trivially_safe` demoted to a tag.
pub fn filters_for(mode: FilterMode, trivial_ttc_s: Option<f64>, reject_collisions: bool) -> EvaluateFilters {
    EvaluateFilters {
        negative_control: mode == FilterMode::NegativeControl,
        trivial_ttc_s,
        reject_collisions,
        ..EvaluateFilters::default()
    }
}

pub fn verdict_str(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Accept => "accept",
        Verdict::Reject => "reject",
    }
}

pub fn code_str(code: RejectCode) -> String {
    match serde_json::to_value(code) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

/// `criticalityBand(verdict, findings)`: the batch's headline bucket.
pub fn criticality_band(verdict: Verdict, findings: &[RejectFinding]) -> &'static str {
    if verdict == Verdict::Accept {
        return "critical";
    }
    let has = |code: RejectCode| findings.iter().any(|f| f.code == code);
    // Physically impossible motion is wrong before it is anything else.
    if has(RejectCode::ImplausibleMotion) {
        "implausible-motion"
    } else if has(RejectCode::NoInteraction) {
        "no-interaction"
    } else if has(RejectCode::TriviallySafe) {
        "trivially-safe"
    } else if has(RejectCode::PhysicallyUnavoidable) {
        "unavoidable"
    } else if has(RejectCode::NeverFired) {
        "never-fired"
    } else if has(RejectCode::OutOfWindow) {
        "out-of-window"
    } else {
        "trivially-safe"
    }
}

/// `combinedEvaluationVerdict`: intent evidence may explain a deliberately
/// uneventful episode, never a hard safety or execution failure.
pub fn combined_verdict(verdict: Verdict, findings: &[RejectFinding], intent_verdict: Option<&str>) -> &'static str {
    match intent_verdict {
        None => verdict_str(verdict),
        Some("reject") => "reject",
        Some(_) => {
            let explained = [RejectCode::NoInteraction, RejectCode::TriviallySafe, RejectCode::OutOfWindow];
            if findings.iter().any(|f| !explained.contains(&f.code)) {
                "reject"
            } else {
                "accept"
            }
        }
    }
}
