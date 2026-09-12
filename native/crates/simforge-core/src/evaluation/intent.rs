//! Deterministic, trace-evidence evaluation of a scenario's authored intent.
//!
//! Complements (does not replace) the generic criticality evaluator: a
//! compliant yield or stationary episode can be a successful scenario even
//! though it has no finite TTC. Criteria are closed and typed; anything
//! outside this vocabulary is reported as `unsupported`, never inferred from
//! prose. A criterion that cannot be checked against the trace (missing
//! actor, empty window, no metric) is `unchecked`, never silently passed.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CoreError, SchemaError, SchemaIssue};
use crate::math::{dist, hypot, quantize, Vec2};
use crate::trace::metrics::{DeclaredOcclusionStatus, MinTtcRecord};
use crate::trace::{ActorTrack, SimEvent, SimTrace};

use super::criticality_metrics_in_window;

const ROUND: i32 = 6;
const MAX_EVIDENCE: usize = 8;
const MAX_TIMES: usize = 16;

/* ------------------------------------------------------------------ rubric */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OccupancyMode {
    Required,
    Forbidden,
}

impl Default for OccupancyMode {
    fn default() -> Self {
        Self::Required
    }
}

impl OccupancyMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::Forbidden => "forbidden",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerOutcome {
    Fired,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClearanceMeasure {
    MetricGap,
    CentreDistance,
}

impl Default for ClearanceMeasure {
    fn default() -> Self {
        Self::MetricGap
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriticalityMetric {
    Ttc,
    PathTtc,
    Pet,
}

impl CriticalityMetric {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ttc => "ttc",
            Self::PathTtc => "path_ttc",
            Self::Pet => "pet",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OcclusionOutcome {
    BlockedThenRevealed,
    BlockedAtConflict,
    NeverBlocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "snake_case", deny_unknown_fields)]
pub enum Zone {
    #[serde(rename_all = "camelCase")]
    Circle { x: f64, y: f64, radius_m: f64 },
    #[serde(rename_all = "camelCase")]
    Box {
        min_x: f64,
        max_x: f64,
        min_y: f64,
        max_y: f64,
    },
}

/// `[start, end]` in clip seconds.
pub type Window = [f64; 2];

fn default_true() -> bool {
    true
}
fn default_0_1() -> f64 {
    0.1
}
fn default_0_5() -> f64 {
    0.5
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum IntentCriterion {
    #[serde(rename_all = "camelCase")]
    EventOrder {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        #[serde(default)]
        mode: OccupancyMode,
        interaction_ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Trigger {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        interaction_id: String,
        outcome: TriggerOutcome,
    },
    #[serde(rename_all = "camelCase")]
    SpeedBand {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        actor_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<Window>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_mps: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_mps: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    StationarySuccess {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        actor_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<Window>,
        #[serde(default = "default_0_1")]
        max_speed_mps: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_present_seconds: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    StopHoldResume {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        actor_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<Window>,
        #[serde(default = "default_0_1")]
        stop_speed_mps: f64,
        min_hold_seconds: f64,
        #[serde(default = "default_true")]
        must_resume: bool,
        #[serde(default = "default_0_5")]
        resume_min_speed_mps: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_by_s: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Clearance {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        pair: [String; 2],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<Window>,
        #[serde(default)]
        measure: ClearanceMeasure,
        min_m: f64,
    },
    #[serde(rename_all = "camelCase")]
    Criticality {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        metric: CriticalityMetric,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pair: Option<[String; 2]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<Window>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_s: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_s: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Occlusion {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        observer: String,
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        occluder_id: Option<String>,
        outcome: OcclusionOutcome,
    },
    #[serde(rename_all = "camelCase")]
    LaneOccupancy {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        actor_id: String,
        lane_rsl: String,
        #[serde(default)]
        mode: OccupancyMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<Window>,
    },
    #[serde(rename_all = "camelCase")]
    ZoneOccupancy {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        actor_id: String,
        #[serde(default)]
        mode: OccupancyMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<Window>,
        zone: Zone,
    },
    #[serde(rename_all = "camelCase")]
    Collision {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pair: Option<[String; 2]>,
        #[serde(default)]
        max_count: u32,
    },
    #[serde(rename_all = "camelCase")]
    ControlIndication {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        signal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<Window>,
        #[serde(default)]
        mode: OccupancyMode,
        indications: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Unsupported {
        id: String,
        #[serde(default = "default_true")]
        required: bool,
        description: String,
        reason: String,
    },
}

impl IntentCriterion {
    pub fn id(&self) -> &str {
        match self {
            Self::EventOrder { id, .. }
            | Self::Trigger { id, .. }
            | Self::SpeedBand { id, .. }
            | Self::StationarySuccess { id, .. }
            | Self::StopHoldResume { id, .. }
            | Self::Clearance { id, .. }
            | Self::Criticality { id, .. }
            | Self::Occlusion { id, .. }
            | Self::LaneOccupancy { id, .. }
            | Self::ZoneOccupancy { id, .. }
            | Self::Collision { id, .. }
            | Self::ControlIndication { id, .. }
            | Self::Unsupported { id, .. } => id,
        }
    }

    pub fn required(&self) -> bool {
        match self {
            Self::EventOrder { required, .. }
            | Self::Trigger { required, .. }
            | Self::SpeedBand { required, .. }
            | Self::StationarySuccess { required, .. }
            | Self::StopHoldResume { required, .. }
            | Self::Clearance { required, .. }
            | Self::Criticality { required, .. }
            | Self::Occlusion { required, .. }
            | Self::LaneOccupancy { required, .. }
            | Self::ZoneOccupancy { required, .. }
            | Self::Collision { required, .. }
            | Self::ControlIndication { required, .. }
            | Self::Unsupported { required, .. } => *required,
        }
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::EventOrder { .. } => "event_order",
            Self::Trigger { .. } => "trigger",
            Self::SpeedBand { .. } => "speed_band",
            Self::StationarySuccess { .. } => "stationary_success",
            Self::StopHoldResume { .. } => "stop_hold_resume",
            Self::Clearance { .. } => "clearance",
            Self::Criticality { .. } => "criticality",
            Self::Occlusion { .. } => "occlusion",
            Self::LaneOccupancy { .. } => "lane_occupancy",
            Self::ZoneOccupancy { .. } => "zone_occupancy",
            Self::Collision { .. } => "collision",
            Self::ControlIndication { .. } => "control_indication",
            Self::Unsupported { .. } => "unsupported",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentRubric {
    pub version: u32,
    pub intent_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_intent: Option<String>,
    pub criteria: Vec<IntentCriterion>,
}

/* -------------------------------------------------------------- validation */

struct Issues(Vec<SchemaIssue>);

impl Issues {
    fn push(&mut self, code: &'static str, path: String, message: impl Into<String>) {
        self.0.push(SchemaIssue {
            code,
            path,
            message: message.into(),
        });
    }

    fn reference(&mut self, path: String, value: &str) {
        if value.is_empty() {
            self.push("too_small", path, "must contain at least 1 character");
        } else if value.len() > 128 {
            self.push("too_big", path, "must contain at most 128 characters");
        }
    }

    fn finite(&mut self, path: String, value: f64) -> bool {
        if !value.is_finite() {
            self.push("not_finite", path, "must be finite");
            return false;
        }
        true
    }

    fn non_negative(&mut self, path: String, value: f64) {
        if self.finite(path.clone(), value) && value < 0.0 {
            self.push("too_small", path, "must be greater than or equal to 0");
        }
    }

    fn positive(&mut self, path: String, value: f64) {
        if self.finite(path.clone(), value) && value <= 0.0 {
            self.push("too_small", path, "must be greater than 0");
        }
    }

    fn opt_non_negative(&mut self, path: String, value: Option<f64>) {
        if let Some(v) = value {
            self.non_negative(path, v);
        }
    }

    fn window(&mut self, path: String, window: Option<Window>) {
        let Some([a, b]) = window else { return };
        self.non_negative(format!("{path}.0"), a);
        self.non_negative(format!("{path}.1"), b);
        if a.is_finite() && b.is_finite() && a > b {
            self.push("custom", path, "window start must be <= end");
        }
    }

    fn pair(&mut self, path: String, pair: &[String; 2]) {
        self.reference(format!("{path}.0"), &pair[0]);
        self.reference(format!("{path}.1"), &pair[1]);
    }

    fn bounded_text(&mut self, path: String, value: &str, max: usize) {
        if value.is_empty() {
            self.push("too_small", path, "must contain at least 1 character");
        } else if value.len() > max {
            self.push(
                "too_big",
                path,
                format!("must contain at most {max} characters"),
            );
        }
    }
}

fn validate_criterion(issues: &mut Issues, index: usize, c: &IntentCriterion) {
    let p = |field: &str| format!("criteria.{index}.{field}");
    issues.reference(p("id"), c.id());
    match c {
        IntentCriterion::EventOrder {
            interaction_ids, ..
        } => {
            if interaction_ids.is_empty() {
                issues.push(
                    "too_small",
                    p("interactionIds"),
                    "must contain at least 1 element(s)",
                );
            } else if interaction_ids.len() > 64 {
                issues.push(
                    "too_big",
                    p("interactionIds"),
                    "must contain at most 64 element(s)",
                );
            }
            for (i, id) in interaction_ids.iter().enumerate() {
                issues.reference(format!("{}.{i}", p("interactionIds")), id);
            }
        }
        IntentCriterion::Trigger { interaction_id, .. } => {
            issues.reference(p("interactionId"), interaction_id)
        }
        IntentCriterion::SpeedBand {
            actor_id,
            window,
            min_mps,
            max_mps,
            ..
        } => {
            issues.reference(p("actorId"), actor_id);
            issues.window(p("window"), *window);
            issues.opt_non_negative(p("minMps"), *min_mps);
            issues.opt_non_negative(p("maxMps"), *max_mps);
        }
        IntentCriterion::StationarySuccess {
            actor_id,
            window,
            max_speed_mps,
            min_present_seconds,
            ..
        } => {
            issues.reference(p("actorId"), actor_id);
            issues.window(p("window"), *window);
            issues.non_negative(p("maxSpeedMps"), *max_speed_mps);
            issues.opt_non_negative(p("minPresentSeconds"), *min_present_seconds);
        }
        IntentCriterion::StopHoldResume {
            actor_id,
            window,
            stop_speed_mps,
            min_hold_seconds,
            resume_min_speed_mps,
            resume_by_s,
            ..
        } => {
            issues.reference(p("actorId"), actor_id);
            issues.window(p("window"), *window);
            issues.non_negative(p("stopSpeedMps"), *stop_speed_mps);
            issues.non_negative(p("minHoldSeconds"), *min_hold_seconds);
            issues.positive(p("resumeMinSpeedMps"), *resume_min_speed_mps);
            issues.opt_non_negative(p("resumeByS"), *resume_by_s);
        }
        IntentCriterion::Clearance {
            pair,
            window,
            min_m,
            ..
        } => {
            issues.pair(p("pair"), pair);
            issues.window(p("window"), *window);
            issues.non_negative(p("minM"), *min_m);
        }
        IntentCriterion::Criticality {
            pair,
            window,
            min_s,
            max_s,
            ..
        } => {
            if let Some(pair) = pair {
                issues.pair(p("pair"), pair);
            }
            issues.window(p("window"), *window);
            issues.opt_non_negative(p("minS"), *min_s);
            issues.opt_non_negative(p("maxS"), *max_s);
        }
        IntentCriterion::Occlusion {
            observer,
            target,
            occluder_id,
            ..
        } => {
            issues.reference(p("observer"), observer);
            issues.reference(p("target"), target);
            if let Some(id) = occluder_id {
                issues.reference(p("occluderId"), id);
            }
        }
        IntentCriterion::LaneOccupancy {
            actor_id,
            lane_rsl,
            window,
            ..
        } => {
            issues.reference(p("actorId"), actor_id);
            issues.reference(p("laneRsl"), lane_rsl);
            issues.window(p("window"), *window);
        }
        IntentCriterion::ZoneOccupancy {
            actor_id,
            window,
            zone,
            ..
        } => {
            issues.reference(p("actorId"), actor_id);
            issues.window(p("window"), *window);
            match zone {
                Zone::Circle { x, y, radius_m } => {
                    issues.finite(p("zone.x"), *x);
                    issues.finite(p("zone.y"), *y);
                    issues.positive(p("zone.radiusM"), *radius_m);
                }
                Zone::Box {
                    min_x,
                    max_x,
                    min_y,
                    max_y,
                } => {
                    let ok = issues.finite(p("zone.minX"), *min_x)
                        & issues.finite(p("zone.maxX"), *max_x)
                        & issues.finite(p("zone.minY"), *min_y)
                        & issues.finite(p("zone.maxY"), *max_y);
                    if ok && (min_x > max_x || min_y > max_y) {
                        issues.push("custom", p("zone"), "invalid box bounds");
                    }
                }
            }
        }
        IntentCriterion::Collision { pair, .. } => {
            if let Some(pair) = pair {
                issues.pair(p("pair"), pair);
            }
        }
        IntentCriterion::ControlIndication {
            signal_id,
            window,
            indications,
            ..
        } => {
            issues.reference(p("signalId"), signal_id);
            issues.window(p("window"), *window);
            if indications.is_empty() {
                issues.push(
                    "too_small",
                    p("indications"),
                    "must contain at least 1 element(s)",
                );
            } else if indications.len() > 32 {
                issues.push(
                    "too_big",
                    p("indications"),
                    "must contain at most 32 element(s)",
                );
            }
            for (i, ind) in indications.iter().enumerate() {
                issues.bounded_text(format!("{}.{i}", p("indications")), ind, 32);
            }
        }
        IntentCriterion::Unsupported {
            description,
            reason,
            ..
        } => {
            issues.bounded_text(p("description"), description, 1_000);
            issues.bounded_text(p("reason"), reason, 1_000);
        }
    }
}

/// Validate a decoded rubric against the closed criterion vocabulary,
/// collecting every issue.
pub fn validate_intent_rubric(rubric: &IntentRubric) -> Result<(), SchemaError> {
    let mut issues = Issues(Vec::new());
    if rubric.version != 1 {
        issues.push("invalid_literal", "version".to_owned(), "must be 1");
    }
    if rubric.intent_id.is_empty() {
        issues.push(
            "too_small",
            "intentId".to_owned(),
            "must contain at least 1 character",
        );
    }
    if rubric.title.is_empty() {
        issues.push(
            "too_small",
            "title".to_owned(),
            "must contain at least 1 character",
        );
    }
    if let Some(text) = &rubric.original_intent {
        issues.bounded_text("originalIntent".to_owned(), text, 8_000);
    }
    if rubric.criteria.is_empty() {
        issues.push(
            "too_small",
            "criteria".to_owned(),
            "must contain at least 1 element(s)",
        );
    } else if rubric.criteria.len() > 256 {
        issues.push(
            "too_big",
            "criteria".to_owned(),
            "must contain at most 256 element(s)",
        );
    }
    let mut seen = BTreeSet::new();
    for (index, c) in rubric.criteria.iter().enumerate() {
        validate_criterion(&mut issues, index, c);
        if !seen.insert(c.id()) {
            issues.push(
                "custom",
                format!("criteria.{index}.id"),
                "criterion id must be unique",
            );
        }
    }
    if issues.0.is_empty() {
        Ok(())
    } else {
        Err(SchemaError { issues: issues.0 })
    }
}

/// Decode and strictly validate a rubric document (defaults materialised,
/// unknown keys and unknown kinds rejected).
pub fn parse_intent_rubric(value: &Value) -> Result<IntentRubric, CoreError> {
    let rubric: IntentRubric = serde_json::from_value(value.clone()).map_err(|e| {
        CoreError::Schema(SchemaError {
            issues: vec![SchemaIssue {
                code: "invalid_type",
                path: String::new(),
                message: e.to_string(),
            }],
        })
    })?;
    validate_intent_rubric(&rubric)?;
    Ok(rubric)
}

/* ------------------------------------------------------------- evaluation */

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriterionStatus {
    Pass,
    Fail,
    Unchecked,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    TraceEvent,
    ActorTrack,
    Metric,
    SignalTrack,
    Rubric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceEvidence {
    pub source: EvidenceSource,
    pub summary: String,
    /// Scalars, nulls, string lists and number lists only.
    pub values: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CriterionVerdict {
    pub id: String,
    pub kind: String,
    pub required: bool,
    pub status: CriterionStatus,
    pub reason: String,
    pub evidence: Vec<TraceEvidence>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorSummaryTrace {
    pub input_hash: String,
    pub map_id: String,
    pub clip_seconds: f64,
    pub dt: f64,
    pub actor_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorActorSummary {
    pub actor_id: String,
    pub present_from_s: Option<f64>,
    pub present_to_s: Option<f64>,
    pub min_speed_mps: Option<f64>,
    pub max_speed_mps: Option<f64>,
    pub final_speed_mps: Option<f64>,
    pub distance_travelled_m: f64,
    pub stationary_intervals: Vec<[f64; 2]>,
    pub lanes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorEventSummary {
    pub t: f64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorOcclusionSummary {
    pub observer: String,
    pub target: String,
    pub status: DeclaredOcclusionStatus,
    pub first_blocked_t: Option<f64>,
    pub los_open_t: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorMetricsSummary {
    pub collisions: usize,
    #[serde(rename = "minTTC")]
    pub min_ttc: Option<f64>,
    #[serde(rename = "minPathTTC")]
    pub min_path_ttc: Option<f64>,
    #[serde(rename = "minPET")]
    pub min_pet: Option<f64>,
    pub trigger_never_fired: Vec<String>,
    pub declared_occlusion: Vec<BehaviorOcclusionSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BehaviorTruncation {
    pub actors: bool,
    pub events: bool,
    pub occlusions: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BehaviorSummary {
    pub version: u32,
    pub trace: BehaviorSummaryTrace,
    pub actors: Vec<BehaviorActorSummary>,
    pub events: Vec<BehaviorEventSummary>,
    pub metrics: BehaviorMetricsSummary,
    pub truncated: BehaviorTruncation,
}

/// Bounds on the behavior summary; each is clamped to at least 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorSummaryLimits {
    pub max_actors: usize,
    pub max_events: usize,
    pub max_occlusions: usize,
}

impl Default for BehaviorSummaryLimits {
    fn default() -> Self {
        Self {
            max_actors: 64,
            max_events: 128,
            max_occlusions: 64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CriterionCounts {
    pub pass: usize,
    pub fail: usize,
    pub unchecked: usize,
    pub unsupported: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentEvaluation {
    pub version: u32,
    pub intent_id: String,
    pub verdict: super::Verdict,
    pub counts: CriterionCounts,
    pub criteria: Vec<CriterionVerdict>,
    pub behavior_summary: BehaviorSummary,
}

/// `IntentEvaluation` without its behavior summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineEvaluation {
    pub version: u32,
    pub intent_id: String,
    pub verdict: super::Verdict,
    pub counts: CriterionCounts,
    pub criteria: Vec<CriterionVerdict>,
}

/// A bounded packet suitable for a context-blind reviewer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewPacket {
    pub version: u32,
    pub intent_id: String,
    pub title: String,
    pub original_intent: Option<String>,
    pub rubric: IntentRubric,
    pub behavior_summary: BehaviorSummary,
    pub machine_evaluation: MachineEvaluation,
}

/* ----------------------------------------------------------------- helpers */

fn round(v: f64) -> f64 {
    quantize(v, ROUND)
}

fn clip_window(trace: &SimTrace, window: Option<Window>) -> Window {
    window.unwrap_or([0.0, trace.header.clip_seconds])
}

fn in_window(t: f64, w: Window) -> bool {
    t >= w[0] && t <= w[1]
}

/// Sample indices where the actor is present inside the window.
fn indices(trace: &SimTrace, track: &ActorTrack, window: Option<Window>) -> Vec<usize> {
    let w = clip_window(trace, window);
    (0..trace.ticks.t.len())
        .filter(|&i| track.is_present(i) && in_window(trace.ticks.t[i], w))
        .collect()
}

fn stationary_intervals(
    trace: &SimTrace,
    track: &ActorTrack,
    threshold: f64,
    window: Option<Window>,
) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    let mut open: Option<(f64, f64)> = None;
    let mut previous: Option<usize> = None;
    for i in indices(trace, track, window) {
        let t = trace.ticks.t[i];
        if let (Some(prev), Some((s, e))) = (previous, open) {
            if i != prev + 1 {
                out.push([round(s), round(e)]);
                open = None;
            }
        }
        if track.speed_mps[i] <= threshold {
            open = Some((open.map_or(t, |(s, _)| s), t));
        } else if let Some((s, e)) = open.take() {
            out.push([round(s), round(e)]);
        }
        previous = Some(i);
    }
    if let Some((s, e)) = open {
        out.push([round(s), round(e)]);
    }
    out
}

fn num(v: f64) -> Value {
    serde_json::to_value(round(v)).unwrap_or(Value::Null)
}
fn opt_num(v: Option<f64>) -> Value {
    v.map_or(Value::Null, num)
}
fn nums(v: &[f64]) -> Value {
    Value::Array(v.iter().map(|x| num(*x)).collect())
}
fn strs(v: &[String]) -> Value {
    Value::Array(v.iter().map(|s| Value::String(s.clone())).collect())
}
fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}
fn opt_text(s: Option<&str>) -> Value {
    s.map_or(Value::Null, text)
}
fn window_value(w: Window) -> Value {
    nums(&w)
}

fn evidence(source: EvidenceSource, summary: &str, values: Vec<(&str, Value)>) -> TraceEvidence {
    TraceEvidence {
        source,
        summary: summary.to_owned(),
        values: values.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
    }
}

fn verdict(
    c: &IntentCriterion,
    status: CriterionStatus,
    reason: impl Into<String>,
    mut entries: Vec<TraceEvidence>,
) -> CriterionVerdict {
    entries.truncate(MAX_EVIDENCE);
    CriterionVerdict {
        id: c.id().to_owned(),
        kind: c.kind().to_owned(),
        required: c.required(),
        status,
        reason: reason.into(),
        evidence: entries,
    }
}

fn pass_fail(pass: bool) -> CriterionStatus {
    if pass {
        CriterionStatus::Pass
    } else {
        CriterionStatus::Fail
    }
}

fn missing_actor(c: &IntentCriterion, actor_id: &str) -> CriterionVerdict {
    verdict(
        c,
        CriterionStatus::Unchecked,
        format!("actor {actor_id} has no trace track"),
        vec![evidence(
            EvidenceSource::ActorTrack,
            "actor track missing",
            vec![("actorId", text(actor_id))],
        )],
    )
}

fn empty_window(
    c: &IntentCriterion,
    trace: &SimTrace,
    actor_id: &str,
    window: Option<Window>,
) -> CriterionVerdict {
    verdict(
        c,
        CriterionStatus::Unchecked,
        "actor has no present samples in the requested window",
        vec![evidence(
            EvidenceSource::ActorTrack,
            "empty actor window",
            vec![
                ("actorId", text(actor_id)),
                ("window", window_value(clip_window(trace, window))),
            ],
        )],
    )
}

fn pair_matches(actual: &[String; 2], expected: &[String; 2]) -> bool {
    (actual[0] == expected[0] && actual[1] == expected[1])
        || (actual[0] == expected[1] && actual[1] == expected[0])
}

fn occupancy_verdict(
    c: &IntentCriterion,
    mode: OccupancyMode,
    what: &str,
    source_summary: &str,
    times: &[f64],
    extra: Vec<(&str, Value)>,
) -> CriterionVerdict {
    let occupied = !times.is_empty();
    let pass = match mode {
        OccupancyMode::Required => occupied,
        OccupancyMode::Forbidden => !occupied,
    };
    let mut values = extra;
    values.push(("sampleCount", Value::from(times.len())));
    values.push(("firstTimeS", opt_num(times.first().copied())));
    values.push(("lastTimeS", opt_num(times.last().copied())));
    verdict(
        c,
        pass_fail(pass),
        format!(
            "{} {what} occupancy {}",
            mode.as_str(),
            if pass { "held" } else { "failed" }
        ),
        vec![evidence(EvidenceSource::ActorTrack, source_summary, values)],
    )
}

fn evaluate_criterion(trace: &SimTrace, c: &IntentCriterion) -> CriterionVerdict {
    match c {
        IntentCriterion::Unsupported {
            description,
            reason,
            ..
        } => verdict(
            c,
            CriterionStatus::Unsupported,
            reason.clone(),
            vec![evidence(
                EvidenceSource::Rubric,
                "criterion is outside the deterministic evaluator vocabulary",
                vec![("description", text(description)), ("reason", text(reason))],
            )],
        ),
        IntentCriterion::EventOrder {
            mode,
            interaction_ids,
            ..
        } => {
            let fired: Vec<(&str, f64)> = trace
                .events
                .iter()
                .filter_map(|e| match e {
                    SimEvent::TriggerFired {
                        t, interaction_id, ..
                    } => Some((interaction_id.as_str(), *t)),
                    _ => None,
                })
                .collect();
            let mut cursor = 0;
            let mut times = Vec::new();
            let mut complete = true;
            for id in interaction_ids {
                match fired[cursor..].iter().position(|(fid, _)| *fid == id) {
                    Some(offset) => {
                        cursor += offset + 1;
                        times.push(fired[cursor - 1].1);
                    }
                    None => {
                        complete = false;
                        break;
                    }
                }
            }
            let pass = match mode {
                OccupancyMode::Required => complete,
                OccupancyMode::Forbidden => !complete,
            };
            verdict(
                c,
                pass_fail(pass),
                format!(
                    "{} event-order condition {}",
                    mode.as_str(),
                    if pass { "held" } else { "did not hold" }
                ),
                vec![evidence(
                    EvidenceSource::TraceEvent,
                    "ordered trigger evidence",
                    vec![
                        ("interactionIds", strs(interaction_ids)),
                        ("matchedTimesS", nums(&times)),
                        ("complete", Value::Bool(complete)),
                    ],
                )],
            )
        }
        IntentCriterion::Trigger {
            interaction_id,
            outcome,
            ..
        } => {
            let times: Vec<f64> = trace
                .events
                .iter()
                .filter_map(|e| match (e, outcome) {
                    (
                        SimEvent::TriggerFired {
                            t,
                            interaction_id: id,
                            ..
                        },
                        TriggerOutcome::Fired,
                    )
                    | (
                        SimEvent::TriggerSkipped {
                            t,
                            interaction_id: id,
                            ..
                        },
                        TriggerOutcome::Skipped,
                    ) if id == interaction_id => Some(*t),
                    _ => None,
                })
                .collect();
            let name = match outcome {
                TriggerOutcome::Fired => "fired",
                TriggerOutcome::Skipped => "skipped",
            };
            let pass = !times.is_empty();
            verdict(
                c,
                pass_fail(pass),
                if pass {
                    format!("trigger {name}")
                } else {
                    format!("trigger did not {name}")
                },
                vec![evidence(
                    EvidenceSource::TraceEvent,
                    "trigger outcome evidence",
                    vec![
                        ("interactionId", text(interaction_id)),
                        ("outcome", text(name)),
                        ("timesS", nums(&times[..times.len().min(MAX_TIMES)])),
                    ],
                )],
            )
        }
        IntentCriterion::SpeedBand {
            actor_id,
            window,
            min_mps,
            max_mps,
            ..
        } => {
            let Some(track) = trace.ticks.actors.get(actor_id) else {
                return missing_actor(c, actor_id);
            };
            let ii = indices(trace, track, *window);
            if ii.is_empty() {
                return empty_window(c, trace, actor_id, *window);
            }
            let (min, max) = ii
                .iter()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &i| {
                    (lo.min(track.speed_mps[i]), hi.max(track.speed_mps[i]))
                });
            let pass = min_mps.is_none_or(|m| min >= m) && max_mps.is_none_or(|m| max <= m);
            verdict(
                c,
                pass_fail(pass),
                if pass {
                    "speed remained inside the authored band"
                } else {
                    "speed left the authored band"
                },
                vec![evidence(
                    EvidenceSource::ActorTrack,
                    "speed extrema in window",
                    vec![
                        ("actorId", text(actor_id)),
                        ("window", window_value(clip_window(trace, *window))),
                        ("minSpeedMps", num(min)),
                        ("maxSpeedMps", num(max)),
                        ("requiredMinMps", opt_num(*min_mps)),
                        ("requiredMaxMps", opt_num(*max_mps)),
                    ],
                )],
            )
        }
        IntentCriterion::StationarySuccess {
            actor_id,
            window,
            max_speed_mps,
            min_present_seconds,
            ..
        } => {
            let Some(track) = trace.ticks.actors.get(actor_id) else {
                return missing_actor(c, actor_id);
            };
            let ii = indices(trace, track, *window);
            if ii.is_empty() {
                return empty_window(c, trace, actor_id, *window);
            }
            let max = ii
                .iter()
                .fold(f64::NEG_INFINITY, |hi, &i| hi.max(track.speed_mps[i]));
            let duration = trace.ticks.t[ii[ii.len() - 1]] - trace.ticks.t[ii[0]];
            let pass = max <= *max_speed_mps && min_present_seconds.is_none_or(|m| duration >= m);
            verdict(
                c,
                pass_fail(pass),
                if pass {
                    "stationary compliance succeeded"
                } else {
                    "stationary compliance was not maintained"
                },
                vec![evidence(
                    EvidenceSource::ActorTrack,
                    "stationary actor evidence",
                    vec![
                        ("actorId", text(actor_id)),
                        ("window", window_value(clip_window(trace, *window))),
                        ("observedMaxSpeedMps", num(max)),
                        ("allowedMaxSpeedMps", Value::from(*max_speed_mps)),
                        ("presentSeconds", num(duration)),
                        ("requiredPresentSeconds", opt_num(*min_present_seconds)),
                    ],
                )],
            )
        }
        IntentCriterion::StopHoldResume {
            actor_id,
            window,
            stop_speed_mps,
            min_hold_seconds,
            must_resume,
            resume_min_speed_mps,
            resume_by_s,
            ..
        } => {
            let Some(track) = trace.ticks.actors.get(actor_id) else {
                return missing_actor(c, actor_id);
            };
            let ii = indices(trace, track, *window);
            if ii.is_empty() {
                return empty_window(c, trace, actor_id, *window);
            }
            let best = stationary_intervals(trace, track, *stop_speed_mps, *window)
                .into_iter()
                .fold(None::<[f64; 2]>, |a, v| match a {
                    Some(a) if v[1] - v[0] <= a[1] - a[0] => Some(a),
                    _ => Some(v),
                });
            let held = best.is_some_and(|b| b[1] - b[0] >= *min_hold_seconds);
            let resumed_at = best.and_then(|b| {
                ii.iter()
                    .map(|&i| (i, trace.ticks.t[i]))
                    .find(|&(i, t)| t > b[1] && track.speed_mps[i] >= *resume_min_speed_mps)
                    .map(|(_, t)| t)
            });
            let resumed =
                !*must_resume || resumed_at.is_some_and(|t| resume_by_s.is_none_or(|by| t <= by));
            let pass = held && resumed;
            verdict(
                c,
                pass_fail(pass),
                if pass {
                    "stop/hold/resume behavior held"
                } else if !held {
                    "minimum stop hold was not observed"
                } else {
                    "required resume was not observed in time"
                },
                vec![evidence(
                    EvidenceSource::ActorTrack,
                    "stop interval and resume evidence",
                    vec![
                        ("actorId", text(actor_id)),
                        (
                            "longestStop",
                            best.map_or(Value::Array(vec![]), |b| nums(&b)),
                        ),
                        ("longestStopSeconds", num(best.map_or(0.0, |b| b[1] - b[0]))),
                        ("requiredHoldSeconds", Value::from(*min_hold_seconds)),
                        ("resumedAtS", opt_num(resumed_at)),
                        ("resumeByS", opt_num(*resume_by_s)),
                    ],
                )],
            )
        }
        IntentCriterion::LaneOccupancy {
            actor_id,
            lane_rsl,
            mode,
            window,
            ..
        } => {
            let Some(track) = trace.ticks.actors.get(actor_id) else {
                return missing_actor(c, actor_id);
            };
            let ii = indices(trace, track, *window);
            if ii.is_empty() {
                return empty_window(c, trace, actor_id, *window);
            }
            let times: Vec<f64> = ii
                .iter()
                .filter(|&&i| track.lane_rsl[i].as_deref() == Some(lane_rsl.as_str()))
                .map(|&i| round(trace.ticks.t[i]))
                .collect();
            occupancy_verdict(
                c,
                *mode,
                "lane",
                "lane occupancy samples",
                &times,
                vec![("actorId", text(actor_id)), ("laneRsl", text(lane_rsl))],
            )
        }
        IntentCriterion::ZoneOccupancy {
            actor_id,
            mode,
            window,
            zone,
            ..
        } => {
            let Some(track) = trace.ticks.actors.get(actor_id) else {
                return missing_actor(c, actor_id);
            };
            let ii = indices(trace, track, *window);
            if ii.is_empty() {
                return empty_window(c, trace, actor_id, *window);
            }
            let inside = |i: usize| match *zone {
                Zone::Circle { x, y, radius_m } => {
                    dist(Vec2::new(track.x[i], track.y[i]), Vec2::new(x, y)) <= radius_m
                }
                Zone::Box {
                    min_x,
                    max_x,
                    min_y,
                    max_y,
                } => {
                    track.x[i] >= min_x
                        && track.x[i] <= max_x
                        && track.y[i] >= min_y
                        && track.y[i] <= max_y
                }
            };
            let times: Vec<f64> = ii
                .iter()
                .filter(|&&i| inside(i))
                .map(|&i| round(trace.ticks.t[i]))
                .collect();
            occupancy_verdict(
                c,
                *mode,
                "zone",
                "zone occupancy samples",
                &times,
                vec![("actorId", text(actor_id))],
            )
        }
        IntentCriterion::Clearance {
            pair,
            window,
            measure,
            min_m,
            ..
        } => {
            let [a, b] = pair;
            let Some(ta) = trace.ticks.actors.get(a) else {
                return missing_actor(c, a);
            };
            let Some(tb) = trace.ticks.actors.get(b) else {
                return missing_actor(c, b);
            };
            let w = clip_window(trace, *window);
            let (min, at) = match measure {
                ClearanceMeasure::MetricGap => {
                    let Some(entry) = trace
                        .metrics
                        .min_distance
                        .iter()
                        .find(|d| pair_matches(&d.pair, pair))
                    else {
                        return verdict(
                            c,
                            CriterionStatus::Unchecked,
                            "no engine clearance metric exists for the requested pair",
                            vec![evidence(
                                EvidenceSource::Metric,
                                "pair clearance missing",
                                vec![("pair", strs(pair))],
                            )],
                        );
                    };
                    if !in_window(entry.t, w) {
                        return verdict(
                            c,
                            CriterionStatus::Unchecked,
                            "episode-wide clearance minimum falls outside the requested window and no clearance series is retained",
                            vec![evidence(
                                EvidenceSource::Metric,
                                "windowed clearance cannot be established",
                                vec![
                                    ("pair", strs(pair)),
                                    ("episodeMinimumM", Value::from(entry.min_distance_m)),
                                    ("episodeMinimumAtS", Value::from(entry.t)),
                                    ("window", window_value(w)),
                                ],
                            )],
                        );
                    }
                    (entry.min_distance_m, entry.t)
                }
                ClearanceMeasure::CentreDistance => {
                    let mut min = f64::INFINITY;
                    let mut at = 0.0;
                    for i in 0..trace.ticks.t.len() {
                        if ta.is_present(i) && tb.is_present(i) && in_window(trace.ticks.t[i], w) {
                            let d = hypot(ta.x[i] - tb.x[i], ta.y[i] - tb.y[i]);
                            if d < min {
                                min = d;
                                at = trace.ticks.t[i];
                            }
                        }
                    }
                    (min, at)
                }
            };
            if !min.is_finite() {
                return verdict(
                    c,
                    CriterionStatus::Unchecked,
                    "pair was never simultaneously present in the requested window",
                    vec![evidence(
                        EvidenceSource::ActorTrack,
                        "no simultaneous samples",
                        vec![("pair", strs(pair)), ("window", window_value(w))],
                    )],
                );
            }
            let pass = min >= *min_m;
            let (source, summary, measure_name) = match measure {
                ClearanceMeasure::MetricGap => (
                    EvidenceSource::Metric,
                    "engine minimum shape clearance",
                    "metric_gap",
                ),
                ClearanceMeasure::CentreDistance => (
                    EvidenceSource::ActorTrack,
                    "minimum centre distance",
                    "centre_distance",
                ),
            };
            verdict(
                c,
                pass_fail(pass),
                if pass {
                    "minimum clearance held"
                } else {
                    "minimum clearance was violated"
                },
                vec![evidence(
                    source,
                    summary,
                    vec![
                        ("pair", strs(pair)),
                        ("measure", text(measure_name)),
                        ("minDistanceM", num(min)),
                        ("atS", num(at)),
                        ("requiredMinM", Value::from(*min_m)),
                        ("window", window_value(w)),
                    ],
                )],
            )
        }
        IntentCriterion::Criticality {
            metric,
            pair,
            window,
            min_s,
            max_s,
            ..
        } => {
            let w = clip_window(trace, *window);
            let selected =
                criticality_metrics_in_window(&trace.metrics, (w[0], w[1]), pair.as_ref());
            let record: Option<MinTtcRecord> = match metric {
                CriticalityMetric::Ttc => selected.min_ttc,
                CriticalityMetric::PathTtc => selected.min_path_ttc.map(|r| MinTtcRecord {
                    value: r.value,
                    t: r.t,
                    pair: r.pair,
                }),
                CriticalityMetric::Pet => selected.min_pet.map(|r| MinTtcRecord {
                    value: r.value,
                    t: r.t,
                    pair: r.pair,
                }),
            };
            let Some(record) = record else {
                return verdict(
                    c,
                    CriterionStatus::Unchecked,
                    format!(
                        "no finite {} evidence exists for the requested pair/window",
                        metric.as_str()
                    ),
                    vec![evidence(
                        EvidenceSource::Metric,
                        "criticality observation missing",
                        vec![
                            ("metric", text(metric.as_str())),
                            (
                                "pair",
                                pair.as_ref().map_or(Value::Array(vec![]), |p| strs(p)),
                            ),
                            ("window", window_value(w)),
                        ],
                    )],
                );
            };
            let pass =
                min_s.is_none_or(|m| record.value >= m) && max_s.is_none_or(|m| record.value <= m);
            verdict(
                c,
                pass_fail(pass),
                format!(
                    "{} {}",
                    metric.as_str(),
                    if pass {
                        "remained inside the authored band"
                    } else {
                        "was outside the authored band"
                    }
                ),
                vec![evidence(
                    EvidenceSource::Metric,
                    "criticality minimum",
                    vec![
                        ("metric", text(metric.as_str())),
                        ("valueS", num(record.value)),
                        ("atS", num(record.t)),
                        ("pair", strs(&record.pair)),
                        ("requiredMinS", opt_num(*min_s)),
                        ("requiredMaxS", opt_num(*max_s)),
                    ],
                )],
            )
        }
        IntentCriterion::Occlusion {
            observer,
            target,
            occluder_id,
            outcome,
            ..
        } => {
            let matches: Vec<_> = trace
                .metrics
                .declared_occlusion
                .iter()
                .filter(|o| {
                    o.observer == *observer
                        && o.target == *target
                        && occluder_id
                            .as_ref()
                            .is_none_or(|id| o.occluder_id.as_ref() == Some(id))
                })
                .collect();
            if matches.is_empty() {
                return verdict(
                    c,
                    CriterionStatus::Unchecked,
                    "no declared occlusion metric matched the requested relation",
                    vec![evidence(
                        EvidenceSource::Metric,
                        "occlusion declaration missing",
                        vec![
                            ("observer", text(observer)),
                            ("target", text(target)),
                            ("occluderId", opt_text(occluder_id.as_deref())),
                        ],
                    )],
                );
            }
            let wanted = match outcome {
                OcclusionOutcome::BlockedThenRevealed => {
                    DeclaredOcclusionStatus::RevealedBeforeConflict
                }
                OcclusionOutcome::BlockedAtConflict => DeclaredOcclusionStatus::BlockedAtConflict,
                OcclusionOutcome::NeverBlocked => {
                    DeclaredOcclusionStatus::NeverBlockedBeforeConflict
                }
            };
            let hit = matches.iter().find(|o| o.status == wanted);
            let status_value =
                |s: DeclaredOcclusionStatus| serde_json::to_value(s).unwrap_or(Value::Null);
            verdict(
                c,
                pass_fail(hit.is_some()),
                if hit.is_some() {
                    "occlusion outcome held"
                } else {
                    "occlusion outcome differed"
                },
                vec![evidence(
                    EvidenceSource::Metric,
                    "declared occlusion result",
                    vec![
                        ("observer", text(observer)),
                        ("target", text(target)),
                        ("expectedStatus", status_value(wanted)),
                        (
                            "observedStatuses",
                            Value::Array(matches.iter().map(|o| status_value(o.status)).collect()),
                        ),
                        (
                            "firstBlockedT",
                            opt_num(hit.and_then(|o| o.first_blocked_t)),
                        ),
                        ("losOpenT", opt_num(hit.and_then(|o| o.los_open_t))),
                    ],
                )],
            )
        }
        IntentCriterion::Collision {
            pair, max_count, ..
        } => {
            let times: Vec<f64> = trace
                .metrics
                .collisions
                .iter()
                .filter(|x| {
                    pair.as_ref().is_none_or(|p| {
                        (x.a == p[0] && x.b == p[1]) || (x.a == p[1] && x.b == p[0])
                    })
                })
                .map(|x| x.t)
                .collect();
            let pass = times.len() <= *max_count as usize;
            verdict(
                c,
                pass_fail(pass),
                if pass {
                    "collision budget held"
                } else {
                    "collision budget exceeded"
                },
                vec![evidence(
                    EvidenceSource::Metric,
                    "collision evidence",
                    vec![
                        (
                            "pair",
                            pair.as_ref().map_or(Value::Array(vec![]), |p| strs(p)),
                        ),
                        ("observedCount", Value::from(times.len())),
                        ("maxCount", Value::from(*max_count)),
                        ("timesS", nums(&times[..times.len().min(MAX_TIMES)])),
                    ],
                )],
            )
        }
        IntentCriterion::ControlIndication {
            signal_id,
            window,
            mode,
            indications,
            ..
        } => {
            let Some(signal) = trace.ticks.signals.get(signal_id) else {
                return verdict(
                    c,
                    CriterionStatus::Unchecked,
                    format!("signal {signal_id} has no trace channel"),
                    vec![evidence(
                        EvidenceSource::SignalTrack,
                        "signal track missing",
                        vec![("signalId", text(signal_id))],
                    )],
                );
            };
            let w = clip_window(trace, *window);
            let observed: Vec<String> = trace
                .ticks
                .t
                .iter()
                .enumerate()
                .filter(|(_, t)| in_window(**t, w))
                .map(|(i, _)| signal.phase[i].as_str().to_owned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let all_present = indications.iter().all(|x| observed.contains(x));
            let any_present = indications.iter().any(|x| observed.contains(x));
            let pass = match mode {
                OccupancyMode::Required => all_present,
                OccupancyMode::Forbidden => !any_present,
            };
            verdict(
                c,
                pass_fail(pass),
                format!(
                    "{} control indication condition {}",
                    mode.as_str(),
                    if pass { "held" } else { "failed" }
                ),
                vec![evidence(
                    EvidenceSource::SignalTrack,
                    "control indications in window",
                    vec![
                        ("signalId", text(signal_id)),
                        ("expected", strs(indications)),
                        ("observed", strs(&observed)),
                        ("window", window_value(w)),
                    ],
                )],
            )
        }
    }
}

fn summarize_event(e: &SimEvent) -> BehaviorEventSummary {
    let actor_id = match e {
        SimEvent::Collision { a, b, .. } => Some(format!("{a}/{b}")),
        _ => e.actor_id().map(str::to_owned),
    };
    let detail = match e {
        SimEvent::StateSet { key, value, .. } => Some(format!(
            "{key}={}",
            match value {
                crate::types::SetValue::Bool(b) => b.to_string(),
                crate::types::SetValue::Number(n) => crate::hash::js_number_to_string(*n),
                crate::types::SetValue::Text(s) => s.clone(),
            }
        )),
        SimEvent::TriggerSkipped { reason, .. }
        | SimEvent::LaneChangeRejected { reason, .. }
        | SimEvent::RouteChangeRejected { reason, .. } => Some(reason.clone()),
        SimEvent::LaneChange {
            from_rsl, to_rsl, ..
        } => Some(format!(
            "{}→{}",
            from_rsl.as_deref().unwrap_or("none"),
            to_rsl.as_deref().unwrap_or("none")
        )),
        _ => None,
    };
    BehaviorEventSummary {
        t: round(e.t()),
        kind: e.kind().to_owned(),
        actor_id,
        interaction_id: e.interaction_id().map(str::to_owned),
        detail,
    }
}

/// Bounded, reviewer-facing description of what the episode did.
pub fn summarize_behavior(trace: &SimTrace, limits: &BehaviorSummaryLimits) -> BehaviorSummary {
    let max_actors = limits.max_actors.max(1);
    let max_events = limits.max_events.max(1);
    let max_occlusions = limits.max_occlusions.max(1);
    let actor_count = trace.ticks.actors.len();
    let actors = trace
        .ticks
        .actors
        .iter()
        .take(max_actors)
        .map(|(actor_id, track)| {
            let ii = indices(trace, track, None);
            let distance: f64 = ii
                .windows(2)
                .map(|w| hypot(track.x[w[1]] - track.x[w[0]], track.y[w[1]] - track.y[w[0]]))
                .sum();
            let speeds: Vec<f64> = ii.iter().map(|&i| track.speed_mps[i]).collect();
            let mut lanes: Vec<String> = ii
                .iter()
                .filter_map(|&i| track.lane_rsl[i].clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            lanes.truncate(32);
            let mut stationary = stationary_intervals(trace, track, 0.1, None);
            stationary.truncate(16);
            BehaviorActorSummary {
                actor_id: actor_id.clone(),
                present_from_s: ii.first().map(|&i| round(trace.ticks.t[i])),
                present_to_s: ii.last().map(|&i| round(trace.ticks.t[i])),
                min_speed_mps: speeds.iter().copied().reduce(f64::min).map(round),
                max_speed_mps: speeds.iter().copied().reduce(f64::max).map(round),
                final_speed_mps: speeds.last().map(|s| round(*s)),
                distance_travelled_m: round(distance),
                stationary_intervals: stationary,
                lanes,
            }
        })
        .collect();
    let mut events: Vec<&SimEvent> = trace.events.iter().collect();
    events.sort_by(|a, b| {
        a.t()
            .partial_cmp(&b.t())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.kind().cmp(b.kind()))
            .then_with(|| {
                a.interaction_id()
                    .unwrap_or("")
                    .cmp(b.interaction_id().unwrap_or(""))
            })
    });
    let events = events
        .into_iter()
        .take(max_events)
        .map(summarize_event)
        .collect();
    let mut occlusions: Vec<_> = trace.metrics.declared_occlusion.iter().collect();
    occlusions.sort_by(|a, b| {
        a.observer
            .cmp(&b.observer)
            .then_with(|| a.target.cmp(&b.target))
            .then_with(|| {
                a.occluder_id
                    .as_deref()
                    .unwrap_or("")
                    .cmp(b.occluder_id.as_deref().unwrap_or(""))
            })
    });
    let declared_occlusion = occlusions
        .iter()
        .take(max_occlusions)
        .map(|o| BehaviorOcclusionSummary {
            observer: o.observer.clone(),
            target: o.target.clone(),
            status: o.status,
            first_blocked_t: o.first_blocked_t,
            los_open_t: o.los_open_t,
        })
        .collect();
    let mut trigger_never_fired = trace.metrics.trigger_never_fired.clone();
    trigger_never_fired.sort();
    trigger_never_fired.truncate(128);
    BehaviorSummary {
        version: 1,
        trace: BehaviorSummaryTrace {
            input_hash: trace.header.input_hash.clone(),
            map_id: trace.header.map_id.clone(),
            clip_seconds: trace.header.clip_seconds,
            dt: trace.header.dt,
            actor_count,
        },
        actors,
        events,
        metrics: BehaviorMetricsSummary {
            collisions: trace.metrics.collisions.len(),
            min_ttc: trace.metrics.min_ttc.as_ref().map(|m| m.value),
            min_path_ttc: trace.metrics.min_path_ttc.as_ref().map(|m| m.value),
            min_pet: trace.metrics.min_pet.as_ref().map(|m| m.value),
            trigger_never_fired,
            declared_occlusion,
        },
        truncated: BehaviorTruncation {
            actors: actor_count > max_actors,
            events: trace.events.len() > max_events,
            occlusions: trace.metrics.declared_occlusion.len() > max_occlusions,
        },
    }
}

/// Evaluate a validated rubric against a trace. The verdict rejects when any
/// required criterion is not a pass (fail, unchecked and unsupported all
/// count against a required criterion).
pub fn evaluate_intent_rubric(trace: &SimTrace, rubric: &IntentRubric) -> IntentEvaluation {
    let criteria: Vec<CriterionVerdict> = rubric
        .criteria
        .iter()
        .map(|c| evaluate_criterion(trace, c))
        .collect();
    let mut counts = CriterionCounts {
        pass: 0,
        fail: 0,
        unchecked: 0,
        unsupported: 0,
    };
    for c in &criteria {
        match c.status {
            CriterionStatus::Pass => counts.pass += 1,
            CriterionStatus::Fail => counts.fail += 1,
            CriterionStatus::Unchecked => counts.unchecked += 1,
            CriterionStatus::Unsupported => counts.unsupported += 1,
        }
    }
    let rejected = criteria
        .iter()
        .any(|c| c.required && c.status != CriterionStatus::Pass);
    IntentEvaluation {
        version: 1,
        intent_id: rubric.intent_id.clone(),
        verdict: if rejected {
            super::Verdict::Reject
        } else {
            super::Verdict::Accept
        },
        counts,
        criteria,
        behavior_summary: summarize_behavior(trace, &BehaviorSummaryLimits::default()),
    }
}

/// A bounded packet suitable for a context-blind reviewer.
pub fn create_blind_review_packet(
    rubric: &IntentRubric,
    evaluation: &IntentEvaluation,
) -> BlindReviewPacket {
    BlindReviewPacket {
        version: 1,
        intent_id: rubric.intent_id.clone(),
        title: rubric.title.clone(),
        original_intent: rubric.original_intent.clone(),
        rubric: rubric.clone(),
        behavior_summary: evaluation.behavior_summary.clone(),
        machine_evaluation: MachineEvaluation {
            version: evaluation.version,
            intent_id: evaluation.intent_id.clone(),
            verdict: evaluation.verdict,
            counts: evaluation.counts.clone(),
            criteria: evaluation.criteria.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use std::collections::BTreeMap;

    use crate::physics::MotionDirection;
    use crate::trace::ledger::{
        LedgerEnvironment, LedgerFrame, LedgerSensors, LedgerSource, MotionAuthority,
        SemanticLedger,
    };
    use crate::trace::metrics::{
        CriticalitySamples, DeclaredOcclusionMetric, DeclaredOcclusionStatus, EpisodeMetrics,
        PairMinDistance,
    };
    use crate::trace::{
        ActorTrack, EgoControllerProfile, EgoProvenance, PhysicsTraceProvenance, RecordedPhysicsMode,
        SignalTrack,
        SimEvent, SimTrace, TraceActorMetadata, TraceFrame, TraceHeader, TraceSolver, TraceTicks,
    };
    use crate::types::{
        ActorKind, ControlIndication, Dims, OperationalConditions,
    };

    fn track(x: &[f64], speed: &[f64], lane: &str) -> ActorTrack {
        let n = x.len();
        ActorTrack {
            x: x.to_vec(),
            y: vec![0.0; n],
            heading_rad: vec![0.0; n],
            speed_mps: speed.to_vec(),
            lateral_offset_m: vec![0.0; n],
            motion_direction: vec![MotionDirection::Forward; n],
            lane_rsl: vec![Some(lane.to_owned()); n],
            s: x.to_vec(),
            present: vec![1; n],
            physics: None,
            down_since_s: None,
        }
    }

    fn fixture(ego_speeds: &[f64]) -> SimTrace {
        let t = vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0];
        let meta = |kind| TraceActorMetadata {
            kind,
            dims: Dims {
                l: 1.0,
                w: 1.0,
                h: 1.0,
            },
            is_static: false,
            tags: vec![],
        };
        let header = TraceHeader {
            trace_version: 4,
            engine_version: "test".into(),
            input_hash: "abc".into(),
            source: None,
            source_xosc_sha256: None,
            materialized_traffic_digest: None,
            seed: crate::rng::Seed::Number(1.0),
            map_id: "fixture".into(),
            engine_graph_digest: "g".into(),
            dt: 1.0,
            clip_seconds: 5.0,
            warmup_seconds: 0.0,
            frame: TraceFrame::XodrLocal,
            actor_ids: vec!["ego".into(), "ped".into()],
            actor_metadata: BTreeMap::from([
                ("ego".to_owned(), meta(ActorKind::Car)),
                ("ped".to_owned(), meta(ActorKind::Pedestrian)),
            ]),
            prop_metadata: BTreeMap::new(),
            ambient_actor_ids: None,
            catalog_slot: None,
            metric_subject: Some("ego".into()),
            ego: EgoProvenance {
                controller_profile: EgoControllerProfile::SensorLimited,
            },
            operational_conditions: OperationalConditions::default(),
            physics: PhysicsTraceProvenance {
                // A trace recorded under the removed choreography backend
                // must still parse and evaluate.
                mode: RecordedPhysicsMode::KinematicV1,
                solver: TraceSolver::UniscenariosSimEngine,
                solver_version: "test".into(),
                substep_s: 1.0,
                vehicle_profile_digest: None,
                resolved_profile_digest: "r".into(),
                actor_backends: BTreeMap::new(),
                crashes: BTreeMap::new(),
            },
        };
        let ledger = SemanticLedger {
            schema: "uniscenarios.semantic-ledger/v1".into(),
            version: 1,
            source: LedgerSource {
                input_hash: "abc".into(),
                producer: "test".into(),
                producer_version: "test".into(),
                map_id: "fixture".into(),
                frame: LedgerFrame::XodrLocal,
                dt: 1.0,
                clip_seconds: 5.0,
                motion_authority: MotionAuthority::KinematicReplay,
                complete: true,
            },
            actors: BTreeMap::new(),
            triggers: vec![],
            actions: vec![],
            events: vec![],
            signals: BTreeMap::new(),
            collisions: vec![],
            discrete_state: vec![],
            environment: LedgerEnvironment {
                operational_conditions: Value::Null,
                surface_patches: vec![],
                perception: Value::Null,
            },
            sensors: LedgerSensors {
                declarations: BTreeMap::new(),
                channels: Value::Null,
                map_divergence: Value::Null,
            },
            invariants: vec![],
        };
        use ControlIndication::{Green, Red};
        SimTrace {
            header,
            ticks: TraceTicks {
                t,
                actors: BTreeMap::from([
                    ("ego".to_owned(), track(&[0.0; 6], ego_speeds, "1:0:-1")),
                    (
                        "ped".to_owned(),
                        track(
                            &[10.0, 8.0, 6.0, 4.0, 3.0, 2.0],
                            &[2.0, 2.0, 2.0, 2.0, 1.0, 0.0],
                            "2:0:-1",
                        ),
                    ),
                ]),
                signals: BTreeMap::from([(
                    "main".to_owned(),
                    SignalTrack {
                        phase: vec![Red, Red, Red, Green, Green, Green],
                    },
                )]),
                sensors: None,
                map_divergence: None,
            },
            events: vec![
                SimEvent::TriggerFired {
                    t: 0.0,
                    interaction_id: "ego-hold".into(),
                    actor_id: "ego".into(),
                    verb: "speed".into(),
                    forced: false,
                },
                SimEvent::TriggerFired {
                    t: 3.0,
                    interaction_id: "ped-clears".into(),
                    actor_id: "ped".into(),
                    verb: "speed".into(),
                    forced: false,
                },
            ],
            metrics: EpisodeMetrics {
                min_ttc: None,
                min_path_ttc: None,
                min_pet: None,
                criticality_samples: CriticalitySamples::default(),
                min_distance: vec![PairMinDistance {
                    pair: ["ego".into(), "ped".into()],
                    min_distance_m: 2.0,
                    t: 5.0,
                }],
                required_decel_max: BTreeMap::from([
                    ("ego".to_owned(), 0.0),
                    ("ped".to_owned(), 1.0),
                ]),
                invariant_residuals: None,
                reveal_to_conflict: None,
                declared_occlusion: vec![DeclaredOcclusionMetric {
                    observer: "ego".into(),
                    target: "ped".into(),
                    pair: ["ego".into(), "ped".into()],
                    occluder_id: Some("van".into()),
                    relevant_occluder_ids: vec!["van".into()],
                    status: DeclaredOcclusionStatus::RevealedBeforeConflict,
                    first_blocked_t: Some(0.0),
                    los_open_t: Some(2.0),
                    conflict_t: Some(4.0),
                    reveal_to_conflict_s: Some(2.0),
                }],
                occluder_ineffective: vec![],
                collisions: vec![],
                trigger_never_fired: vec![],
                clipped_criticality: false,
                ticks_simulated: 6,
                perception: None,
            },
            semantic_ledger: ledger,
        }
    }

    fn rubric(criteria: Value) -> IntentRubric {
        parse_intent_rubric(&json!({
            "version": 1, "intentId": "stationary-yield", "title": "Compliant stationary yield",
            "originalIntent": "Ego must remain stopped while the pedestrian clears.", "criteria": criteria
        }))
        .unwrap()
    }

    #[test]
    fn accepts_a_compliant_stationary_scenario_without_finite_criticality() {
        let r = evaluate_intent_rubric(
            &fixture(&[0.0; 6]),
            &rubric(json!([
                { "id": "hold", "kind": "stationary_success", "actorId": "ego", "window": [0, 5], "maxSpeedMps": 0.1, "minPresentSeconds": 5 },
                { "id": "order", "kind": "event_order", "mode": "required", "interactionIds": ["ego-hold", "ped-clears"] },
                { "id": "clearance", "kind": "clearance", "pair": ["ego", "ped"], "measure": "metric_gap", "minM": 2 },
                { "id": "reveal", "kind": "occlusion", "observer": "ego", "target": "ped", "occluderId": "van", "outcome": "blocked_then_revealed" },
                { "id": "red-seen", "kind": "control_indication", "signalId": "main", "indications": ["red"], "mode": "required" },
                { "id": "no-contact", "kind": "collision", "maxCount": 0 },
            ])),
        );
        assert_eq!(r.verdict, super::super::Verdict::Accept);
        assert_eq!(
            r.counts,
            CriterionCounts {
                pass: 6,
                fail: 0,
                unchecked: 0,
                unsupported: 0
            }
        );
        assert!(r.criteria.iter().all(|c| !c.evidence.is_empty()));
        let ego = r
            .behavior_summary
            .actors
            .iter()
            .find(|a| a.actor_id == "ego")
            .unwrap();
        assert_eq!(ego.max_speed_mps, Some(0.0));
        assert_eq!(ego.distance_travelled_m, 0.0);
    }

    #[test]
    fn rejects_a_flawed_stationary_scenario_with_trace_evidence() {
        let r = evaluate_intent_rubric(
            &fixture(&[0.0, 0.0, 0.4, 0.4, 0.0, 0.0]),
            &rubric(json!([
                { "id": "hold", "kind": "stationary_success", "actorId": "ego", "maxSpeedMps": 0.1 },
                { "id": "forbidden-order", "kind": "event_order", "mode": "forbidden", "interactionIds": ["ego-hold", "ped-clears"] },
            ])),
        );
        assert_eq!(r.verdict, super::super::Verdict::Reject);
        assert_eq!(
            r.criteria.iter().map(|c| c.status).collect::<Vec<_>>(),
            vec![CriterionStatus::Fail, CriterionStatus::Fail]
        );
        assert_eq!(
            r.criteria[0].evidence[0].values["observedMaxSpeedMps"],
            json!(0.4)
        );
    }

    #[test]
    fn required_unchecked_and_unsupported_reject_but_optional_ones_pass() {
        let criteria = |required: bool| {
            json!([
                { "id": "missing", "kind": "speed_band", "required": required, "actorId": "ghost", "maxMps": 1 },
                { "id": "semantic-only", "kind": "unsupported", "required": required, "description": "officer intent is understood", "reason": "mental state is not trace observable" },
            ])
        };
        let required = evaluate_intent_rubric(&fixture(&[0.0; 6]), &rubric(criteria(true)));
        assert_eq!(required.verdict, super::super::Verdict::Reject);
        assert_eq!(
            required
                .criteria
                .iter()
                .map(|c| c.status)
                .collect::<Vec<_>>(),
            vec![CriterionStatus::Unchecked, CriterionStatus::Unsupported]
        );
        let optional = evaluate_intent_rubric(&fixture(&[0.0; 6]), &rubric(criteria(false)));
        assert_eq!(optional.verdict, super::super::Verdict::Accept);
    }

    #[test]
    fn summaries_are_deterministic_bounded_and_packet_omits_trace() {
        let input = rubric(
            json!([{ "id": "hold", "kind": "stationary_success", "actorId": "ego", "maxSpeedMps": 0.1 }]),
        );
        let trace = fixture(&[0.0; 6]);
        let evaluation = evaluate_intent_rubric(&trace, &input);
        let limits = BehaviorSummaryLimits {
            max_actors: 1,
            max_events: 1,
            max_occlusions: 1,
        };
        let a = summarize_behavior(&trace, &limits);
        assert_eq!(a, summarize_behavior(&trace, &limits));
        assert_eq!(a.actors.len(), 1);
        assert!(a.truncated.actors && a.truncated.events);
        let packet = create_blind_review_packet(&input, &evaluation);
        let json = serde_json::to_value(&packet).unwrap();
        assert!(json["machineEvaluation"].get("behaviorSummary").is_none());
        assert!(json.get("trace").is_none());
        assert!(serde_json::to_string(&packet).unwrap().len() < 30_000);
    }

    #[test]
    fn rubric_rejects_duplicate_ids_unknown_kinds_and_bad_windows() {
        let doc = json!({
            "version": 1, "intentId": "i", "title": "t",
            "criteria": [
                { "id": "a", "kind": "trigger", "interactionId": "x", "outcome": "fired" },
                { "id": "a", "kind": "speed_band", "actorId": "ego", "window": [5, 2] },
            ]
        });
        let err = parse_intent_rubric(&doc).unwrap_err();
        let CoreError::Schema(schema) = err else {
            panic!("expected schema error")
        };
        let paths: Vec<&str> = schema.issues.iter().map(|i| i.path.as_str()).collect();
        assert!(paths.contains(&"criteria.1.id"));
        assert!(paths.contains(&"criteria.1.window"));
        let unknown = json!({ "version": 1, "intentId": "i", "title": "t", "criteria": [{ "id": "a", "kind": "vibes" }] });
        assert!(matches!(
            parse_intent_rubric(&unknown),
            Err(CoreError::Schema(_))
        ));
    }

    #[test]
    fn defaults_materialise() {
        let doc = json!({
            "version": 1, "intentId": "i", "title": "t",
            "criteria": [{ "id": "s", "kind": "stop_hold_resume", "actorId": "ego", "minHoldSeconds": 2 }]
        });
        let rubric = parse_intent_rubric(&doc).unwrap();
        match &rubric.criteria[0] {
            IntentCriterion::StopHoldResume {
                required,
                stop_speed_mps,
                must_resume,
                resume_min_speed_mps,
                ..
            } => {
                assert!(*required && *must_resume);
                assert_eq!(*stop_speed_mps, 0.1);
                assert_eq!(*resume_min_speed_mps, 0.5);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
