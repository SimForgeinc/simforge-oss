//! Versioned selection boundary for expensive episode metrics. Collision
//! detection remains global.
//!
//! Generated background road users are excluded from episode criticality
//! pairs: every criticality metric answers "how close did the *authored*
//! conflict come", and an ambient car passing nearer to the metric subject
//! than the authored challenger would silently take that pair over. Not
//! excluded: collision detection, physics/control, and an explicitly declared
//! occlusion/monitor pair (authored intent wins).

use std::collections::BTreeSet;

pub const MONITORED_PAIR_POLICY_VERSION: &str = "episode-metric-pairs.v1";
pub const AMBIENT_METRIC_EXCLUSION_VERSION: &str = "ambient-metric-exclusion.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionReason {
    MetricSubject,
    AllPairs,
    ExplicitMonitor,
    ArticulatedStatic,
    AmbientExcluded,
    NotSelected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetricPairSelection {
    pub monitored: bool,
    pub scored: bool,
    pub reason: SelectionReason,
}

/// Decide whether the unordered pair `(a, b)` is monitored (explicit LOS
/// declaration) and/or scored (enters criticality minima).
pub fn select_metric_pair(
    metric_subject: Option<&str>,
    is_explicit_pair: bool,
    ambient_actor_ids: &BTreeSet<String>,
    a: &str,
    b: &str,
    has_articulated_static_shape: bool,
) -> MetricPairSelection {
    let subject_scored = metric_subject.is_none_or(|s| a == s || b == s);
    if is_explicit_pair {
        return MetricPairSelection {
            monitored: true,
            scored: subject_scored,
            reason: SelectionReason::ExplicitMonitor,
        };
    }
    // Ambient exclusion sits below an explicit monitor and above every other
    // rule, including the articulated-static escape hatch.
    if !ambient_actor_ids.is_empty()
        && (ambient_actor_ids.contains(a) || ambient_actor_ids.contains(b))
    {
        return MetricPairSelection {
            monitored: false,
            scored: false,
            reason: SelectionReason::AmbientExcluded,
        };
    }
    if has_articulated_static_shape {
        return MetricPairSelection {
            monitored: false,
            scored: true,
            reason: SelectionReason::ArticulatedStatic,
        };
    }
    if metric_subject.is_none() {
        return MetricPairSelection {
            monitored: false,
            scored: true,
            reason: SelectionReason::AllPairs,
        };
    }
    if subject_scored {
        return MetricPairSelection {
            monitored: false,
            scored: true,
            reason: SelectionReason::MetricSubject,
        };
    }
    MetricPairSelection {
        monitored: false,
        scored: false,
        reason: SelectionReason::NotSelected,
    }
}
