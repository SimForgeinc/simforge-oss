//! Structured errors.
//!
//! Two error families exist because two different consumers act on them:
//!
//! - [`SchemaIssue`] / [`SchemaError`]: the *input contract* rejected a
//!   document. Issues are flattened for an unattended repair loop (LLM
//!   authoring → validate → repair): every issue carries a machine code and a
//!   dotted path into the document, and a parse collects **all** issues rather
//!   than stopping at the first, exactly like the zod contract it replaces.
//! - [`SimIssue`] / [`SimEngineError`]: the *engine* rejected a validated
//!   document during binding, placement, routing or feasibility checks.
//!
//! [`CoreError`] is the single `Result` error for crate entry points that can
//! fail in more than one way (JSON syntax, schema, topology).

use std::fmt;

use serde::{Deserialize, Serialize};

/// A schema violation, flattened for an unattended repair loop.
///
/// `code` follows the zod issue vocabulary so tooling written against the
/// TypeScript contract keeps working: `invalid_type`, `too_small`, `too_big`,
/// `not_finite`, `invalid_format`, `invalid_enum_value`, `invalid_literal`,
/// `invalid_union_discriminator`, `unrecognized_keys`, `custom`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SchemaIssue {
    pub code: &'static str,
    /// Dotted path into the document, e.g. `actors.1.behavior.route.lanes`.
    pub path: String,
    pub message: String,
}

impl fmt::Display for SchemaIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            write!(f, "[{}] {}", self.code, self.message)
        } else {
            write!(f, "[{}] {}: {}", self.code, self.path, self.message)
        }
    }
}

/// One or more schema violations. Never empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SchemaError {
    pub issues: Vec<SchemaIssue>,
}

impl fmt::Display for SchemaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "scenario input failed validation with {} issue(s)",
            self.issues.len()
        )?;
        for issue in &self.issues {
            write!(f, "\n  {issue}")?;
        }
        Ok(())
    }
}

impl std::error::Error for SchemaError {}

/// Engine issue codes. Everything the engine rejects after schema validation
/// is one of these, so a repair loop can act on it without parsing prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimIssueCode {
    // route / topology
    RouteLaneMissing,
    RouteDisconnected,
    RouteEmpty,
    RouteOrientationAmbiguous,
    RouteTurnUnavailable,
    // feasibility guards
    RunwayInsufficient,
    DecelBudgetExceeded,
    TimedRouteSpeedUnreachable,
    TimedRouteAccelerationUnreachable,
    TimedRouteTurnUnreachable,
    SpawnOverlap,
    SpawnOffLane,
    SpawnLaneNotOnRoute,
    SpawnLanePoseMismatch,
    TrafficControlRouteUnbound,
    TrafficControlBindingRepaired,
    // gear
    ReverseSpawnHeadingAdjusted,
    // binding
    ActorUnknown,
    InteractionUnknown,
    SignalUnknown,
    ArrivalUnsolvable,
    LaneChangeIllegal,
    LateralDurationClamped,
    LateralTrackingFailed,
}

impl SimIssueCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RouteLaneMissing => "route_lane_missing",
            Self::RouteDisconnected => "route_disconnected",
            Self::RouteEmpty => "route_empty",
            Self::RouteOrientationAmbiguous => "route_orientation_ambiguous",
            Self::RouteTurnUnavailable => "route_turn_unavailable",
            Self::RunwayInsufficient => "runway_insufficient",
            Self::DecelBudgetExceeded => "decel_budget_exceeded",
            Self::TimedRouteSpeedUnreachable => "timed_route_speed_unreachable",
            Self::TimedRouteAccelerationUnreachable => "timed_route_acceleration_unreachable",
            Self::TimedRouteTurnUnreachable => "timed_route_turn_unreachable",
            Self::SpawnOverlap => "spawn_overlap",
            Self::SpawnOffLane => "spawn_off_lane",
            Self::SpawnLaneNotOnRoute => "spawn_lane_not_on_route",
            Self::SpawnLanePoseMismatch => "spawn_lane_pose_mismatch",
            Self::TrafficControlRouteUnbound => "traffic_control_route_unbound",
            Self::TrafficControlBindingRepaired => "traffic_control_binding_repaired",
            Self::ReverseSpawnHeadingAdjusted => "reverse_spawn_heading_adjusted",
            Self::ActorUnknown => "actor_unknown",
            Self::InteractionUnknown => "interaction_unknown",
            Self::SignalUnknown => "signal_unknown",
            Self::ArrivalUnsolvable => "arrival_unsolvable",
            Self::LaneChangeIllegal => "lane_change_illegal",
            Self::LateralDurationClamped => "lateral_duration_clamped",
            Self::LateralTrackingFailed => "lateral_tracking_failed",
        }
    }
}

impl fmt::Display for SimIssueCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimIssueSeverity {
    Error,
    Warning,
}

/// An engine issue: `{code, severity, path, reason, detail?}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimIssue {
    pub code: SimIssueCode,
    pub severity: SimIssueSeverity,
    /// Dotted path into the input document, e.g. `actors[2].behavior.route`.
    pub path: String,
    pub reason: String,
    /// Free-form structured detail. JSON only at this reporting boundary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Map<String, serde_json::Value>>,
}

impl SimIssue {
    pub fn error(code: SimIssueCode, path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            code,
            severity: SimIssueSeverity::Error,
            path: path.into(),
            reason: reason.into(),
            detail: None,
        }
    }

    pub fn warning(code: SimIssueCode, path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            code,
            severity: SimIssueSeverity::Warning,
            path: path.into(),
            reason: reason.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: serde_json::Map<String, serde_json::Value>) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn is_error(&self) -> bool {
        self.severity == SimIssueSeverity::Error
    }
}

impl fmt::Display for SimIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}: {}", self.code, self.path, self.reason)
    }
}

/// The engine refused to build or run a document.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SimEngineError {
    pub message: String,
    pub issues: Vec<SimIssue>,
}

impl SimEngineError {
    pub fn new(message: impl Into<String>, issues: Vec<SimIssue>) -> Self {
        Self {
            message: message.into(),
            issues,
        }
    }
}

impl fmt::Display for SimEngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)?;
        for issue in &self.issues {
            write!(f, "\n  {issue}")?;
        }
        Ok(())
    }
}

impl std::error::Error for SimEngineError {}

/// Crate-level error for entry points that cross more than one failure domain.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// The bytes were not JSON at all.
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// JSON, but not a valid `SimScenarioInput`.
    #[error(transparent)]
    Schema(#[from] SchemaError),
    /// JSON, but not a valid topology index.
    #[error("invalid topology index: {0}")]
    Topology(String),
    /// A value could not be canonicalised (non-finite number).
    #[error("canonical JSON: {0}")]
    Canonical(String),
    /// The engine rejected a validated document.
    #[error(transparent)]
    Engine(#[from] SimEngineError),
}
