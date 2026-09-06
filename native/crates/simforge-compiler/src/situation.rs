//! Source-bound situations: an immutable source (authored, NuRec, twin), a
//! template over it, participants with authority intervals, observable
//! events/constraints, bounded knobs and provenance for generated geometry.
//!
//! Three verbs, every one grounded in the engine rather than a second model:
//!
//! - [`compile_situation`] lowers through the ordinary map-bound / portable
//!   materializer and then proves the authority declarations against the
//!   concrete input (tick grid, recorded coverage, handover feasibility).
//! - [`rehearse_situation`] runs the exact bound input and samples every
//!   declared event predicate with the engine's own geometry/perception at
//!   each trace timestamp, returning witnesses, not summaries.
//! - [`solve_situation`] / [`compare_situation`] are bounded coordinate
//!   search and controlled intervention comparison on top of rehearsal; a
//!   failed budget is evidence of nothing beyond the budget.
//!
//! Atomic changes go through [`apply_situation_transaction`]: template
//! operations are staged on a private JSON copy, the result is re-parsed
//! through the canonical template contract, and only a fully valid revision
//! is published.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use simforge_core::engine::{
    ActionOverride, ActorAction, ActorSnapshot, RunOptions, SimResult, Simulation,
};
use simforge_core::error::CoreError;
use simforge_core::hash::{canonical_json_of, content_hash_of};
use simforge_core::trace::SimEvent;
use simforge_core::types::{self as sim, MotionPhysicsMode, RouteSpec, SimScenarioInput};

use crate::anchor::MatchedSite;
use crate::bundle::MapBundle;
use crate::catalog::{CatalogDims, ExternalCatalogEntry};
use crate::error::{detail, CompileError, CompileResult};
use crate::expr::NumberOrExpr;
use crate::materialize::{
    materialize, materialize_map_bound, MaterializeOptions, MaterializeResult, Observation,
};
use crate::template::{
    self as t, parse_template, Condition, LeafCondition, PointRef, RoleKind, ScenarioTemplate,
    SignalRef, Trigger,
};

pub const SITUATION_VERSION: u32 = 1;
/// JavaScript's `Number.MAX_SAFE_INTEGER`: the revision counter is shared with
/// TypeScript authoring clients and must stay exactly representable there.
pub const MAX_REVISION: u64 = (1 << 53) - 1;
const KPH_TO_MPS: f64 = 1.0 / 3.6;
const STATIC_GEOMETRY_SCHEMA: &str = "simforge.generated-static-geometry/v1";
const STATIC_GEOMETRY_EFFECT_SCHEMA: &str = "simforge.static-geometry-effect/v1";

/* ------------------------------------------------------------------ program */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Authored,
    Nurec,
    Twin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactKind {
    Mesh,
    RigidTrack,
    Baked,
    Observation,
    Map,
    PointCloud,
    Image,
    Video,
}

impl ArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mesh => "mesh",
            Self::RigidTrack => "rigid-track",
            Self::Baked => "baked",
            Self::Observation => "observation",
            Self::Map => "map",
            Self::PointCloud => "point-cloud",
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceArtifact {
    pub id: String,
    pub uri: String,
    pub sha256: String,
    pub kind: ArtifactKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceAxes {
    /// SimForge: (localX, up, -localY).
    SimforgeYUp,
    /// Blender: (localX, localY, up).
    BlenderZUp,
    /// XODR: (localX, localY).
    XodrXy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceFrame {
    pub id: String,
    pub axes: SourceAxes,
    pub units: MetreUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MetreUnit {
    #[serde(rename = "m")]
    Metre,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SecondUnit {
    #[serde(rename = "s")]
    Second,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceTime {
    pub origin: f64,
    pub unit: SecondUnit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SituationSource {
    pub id: String,
    pub kind: SourceKind,
    pub map_id: String,
    pub artifacts: Vec<SourceArtifact>,
    pub frame: SourceFrame,
    pub time: SourceTime,
    pub assumptions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SituationQuestion {
    pub brief: String,
    pub hypothesis: String,
    pub falsifier: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorityKind {
    Recorded,
    Controller,
    Policy,
}

impl AuthorityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recorded => "recorded",
            Self::Controller => "controller",
            Self::Policy => "policy",
        }
    }
}

/// Half-open `[start_s, end_s)`: handoffs may share a boundary, never an interval.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityInterval {
    pub start_s: f64,
    pub end_s: f64,
    pub kind: AuthorityKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppearanceKind {
    Mesh,
    RigidTrack,
    Baked,
}

impl AppearanceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mesh => "mesh",
            Self::RigidTrack => "rigid-track",
            Self::Baked => "baked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Appearance {
    pub kind: AppearanceKind,
    pub source_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InformationSource {
    Truth,
    Visibility,
    Detection,
    Observation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Information {
    pub subject_role_id: String,
    pub source: InformationSource,
    pub reaction_delay_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SituationParticipant {
    pub role_id: String,
    pub intention: String,
    pub authority: Vec<AuthorityInterval>,
    pub appearance: Appearance,
    pub information: Vec<Information>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SituationEvent {
    pub id: String,
    pub condition: Condition,
    pub window_s: (f64, f64),
    pub tolerance_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SituationConstraint {
    #[serde(rename_all = "camelCase")]
    EventOffset {
        id: String,
        before: String,
        after: String,
        min_s: f64,
        max_s: f64,
    },
    #[serde(rename_all = "camelCase")]
    EventOccurs { id: String, event_id: String },
}

impl SituationConstraint {
    pub fn id(&self) -> &str {
        match self {
            Self::EventOffset { id, .. } | Self::EventOccurs { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PositionAxis {
    X,
    Z,
    S,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SituationKnob {
    #[serde(rename_all = "camelCase")]
    RoleSpeed {
        id: String,
        role_id: String,
        min: f64,
        max: f64,
    },
    #[serde(rename_all = "camelCase")]
    RolePosition {
        id: String,
        role_id: String,
        axis: PositionAxis,
        min: f64,
        max: f64,
    },
    #[serde(rename_all = "camelCase")]
    InteractionTime {
        id: String,
        interaction_id: String,
        min: f64,
        max: f64,
    },
}

impl SituationKnob {
    pub fn id(&self) -> &str {
        match self {
            Self::RoleSpeed { id, .. }
            | Self::RolePosition { id, .. }
            | Self::InteractionTime { id, .. } => id,
        }
    }

    pub fn bounds(&self) -> (f64, f64) {
        match self {
            Self::RoleSpeed { min, max, .. }
            | Self::RolePosition { min, max, .. }
            | Self::InteractionTime { min, max, .. } => (*min, *max),
        }
    }

    fn target_key(&self) -> String {
        match self {
            Self::InteractionTime { interaction_id, .. } => {
                format!("interaction-time:{interaction_id}")
            }
            Self::RoleSpeed { role_id, .. } => format!("role-speed:{role_id}:"),
            Self::RolePosition { role_id, axis, .. } => {
                format!("role-position:{role_id}:{}", axis_name(*axis))
            }
        }
    }
}

fn axis_name(axis: PositionAxis) -> &'static str {
    match axis {
        PositionAxis::X => "x",
        PositionAxis::Z => "z",
        PositionAxis::S => "s",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GeometryEffect {
    Bounds,
    Ground,
    Collision,
    Occlusion,
    Driveability,
}

impl GeometryEffect {
    fn as_str(self) -> &'static str {
        match self {
            Self::Bounds => "bounds",
            Self::Ground => "ground",
            Self::Collision => "collision",
            Self::Occlusion => "occlusion",
            Self::Driveability => "driveability",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchAssetKind {
    Mesh,
    Bounds,
    Ground,
    Collision,
    Occlusion,
    Driveability,
}

impl PatchAssetKind {
    fn matches_effect(self, effect: GeometryEffect) -> bool {
        matches!(
            (self, effect),
            (Self::Bounds, GeometryEffect::Bounds)
                | (Self::Ground, GeometryEffect::Ground)
                | (Self::Collision, GeometryEffect::Collision)
                | (Self::Occlusion, GeometryEffect::Occlusion)
                | (Self::Driveability, GeometryEffect::Driveability)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PatchStatus {
    VisualOnly,
    Executable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchSourcePin {
    pub source_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchAsset {
    pub id: String,
    pub uri: String,
    pub sha256: String,
    pub kind: PatchAssetKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchAffected {
    pub source_ids: Vec<String>,
    pub object_ids: Vec<String>,
    pub role_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SatisfiedEffect {
    pub effect: GeometryEffect,
    pub asset_id: String,
}

/// Artifact claims are provenance, not a second geometry engine. Consumers
/// verify bytes before lowering.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeometryPatchManifest {
    pub id: String,
    pub status: PatchStatus,
    pub source_artifacts: Vec<PatchSourcePin>,
    pub assets: Vec<PatchAsset>,
    pub affected: PatchAffected,
    pub required_effects: Vec<GeometryEffect>,
    pub satisfied_effects: Vec<SatisfiedEffect>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SituationProgram {
    pub situation_version: u32,
    pub revision: u64,
    pub source: SituationSource,
    pub template: ScenarioTemplate,
    pub question: SituationQuestion,
    pub participants: Vec<SituationParticipant>,
    pub events: Vec<SituationEvent>,
    pub constraints: Vec<SituationConstraint>,
    pub knobs: Vec<SituationKnob>,
    pub geometry_patches: Vec<GeometryPatchManifest>,
}

/// The mutable half of a program a transaction may replace wholesale.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SituationChanges {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<SituationQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participants: Option<Vec<SituationParticipant>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<SituationEvent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<Vec<SituationConstraint>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knobs: Option<Vec<SituationKnob>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry_patches: Option<Vec<GeometryPatchManifest>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SituationIssue {
    pub path: String,
    pub code: &'static str,
    pub message: String,
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200
}

fn invalid(issues: Vec<SituationIssue>) -> CompileError {
    let detail = serde_json::to_value(&issues).unwrap_or(Value::Null);
    CompileError::new("situation_invalid", "invalid situation program")
        .detail_entry("issues", detail)
        .as_findings()
}

fn condition_leaves(condition: &Condition) -> Vec<&LeafCondition> {
    match condition {
        Condition::Leaf(l) => vec![l],
        Condition::Logical(
            t::LogicalCondition::And { operands } | t::LogicalCondition::Or { operands },
        ) => operands.iter().collect(),
        Condition::Logical(t::LogicalCondition::Not { operand }) => vec![operand],
    }
}

fn leaf_expressions(leaf: &LeafCondition) -> Vec<&NumberOrExpr> {
    match leaf {
        LeafCondition::Distance {
            value_m,
            hysteresis_m,
            to,
            ..
        } => {
            let mut out = vec![value_m];
            out.extend(hysteresis_m.iter());
            if let PointRef::Pose { pose } = to {
                out.push(&pose.s);
            }
            out
        }
        LeafCondition::Ttc { value_s, .. } | LeafCondition::Headway { value_s, .. } => {
            vec![value_s]
        }
        LeafCondition::Reaches {
            region,
            tolerance_m,
            ..
        } => {
            let mut out: Vec<&NumberOrExpr> = tolerance_m.iter().collect();
            if let PointRef::Pose { pose } = region {
                out.push(&pose.s);
            }
            out
        }
        LeafCondition::Speed { value_kph, .. } => vec![value_kph],
        LeafCondition::Signal { min_duration_s, .. } => min_duration_s.iter().collect(),
        LeafCondition::Standstill { for_s, .. } => vec![for_s],
        LeafCondition::Visible { .. }
        | LeafCondition::Detected { .. }
        | LeafCondition::Collision { .. } => Vec::new(),
    }
}

/// Situation-level cross-reference checks. Template-internal references are
/// already enforced by [`parse_template`]; this covers the seam between the
/// program's own collections and the template/source they point into.
pub fn inspect_program(doc: &SituationProgram) -> Vec<SituationIssue> {
    let mut issues: Vec<SituationIssue> = Vec::new();
    fn issue(issues: &mut Vec<SituationIssue>, path: String, code: &'static str, message: String) {
        issues.push(SituationIssue {
            path,
            code,
            message,
        });
    }

    if doc.situation_version != SITUATION_VERSION {
        issue(
            &mut issues,
            "situationVersion".to_owned(),
            "invalid_type",
            format!("expected situationVersion {SITUATION_VERSION}"),
        );
    }
    if doc.revision > MAX_REVISION {
        issue(
            &mut issues,
            "revision".to_owned(),
            "too_big",
            "revision exceeds the safe integer range".to_owned(),
        );
    }
    let unique = |values: &[&str], path: &str, issues: &mut Vec<SituationIssue>| {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for (index, value) in values.iter().enumerate() {
            if !seen.insert(value) {
                issues.push(SituationIssue {
                    path: format!("{path}.{index}"),
                    code: "duplicate_id",
                    message: format!("duplicate identifier \"{value}\""),
                });
            }
        }
    };
    let need =
        |values: &BTreeSet<&str>, value: &str, path: String, issues: &mut Vec<SituationIssue>| {
            if !values.contains(value) {
                issues.push(SituationIssue {
                    path,
                    code: "reference_unknown",
                    message: format!("unknown reference \"{value}\""),
                });
            }
        };

    let roles: BTreeSet<&str> = doc
        .template
        .roles
        .iter()
        .map(|r| r.base.id.as_str())
        .collect();
    let features: BTreeSet<&str> = doc
        .template
        .anchor
        .features
        .iter()
        .map(|f| f.id())
        .collect();
    let controls: BTreeSet<&str> = doc
        .template
        .traffic_controls
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    let interactions: BTreeSet<&str> = doc
        .template
        .choreography
        .interactions
        .iter()
        .map(|i| i.base.id.as_str())
        .collect();
    let events: BTreeSet<&str> = doc.events.iter().map(|e| e.id.as_str()).collect();
    let artifacts: BTreeMap<&str, &SourceArtifact> = doc
        .source
        .artifacts
        .iter()
        .map(|a| (a.id.as_str(), a))
        .collect();
    let sources: BTreeSet<&str> = artifacts.keys().copied().collect();

    // (kind, uri, sha256) identity of every appearance-capable asset.
    let mut appearances: BTreeMap<&str, (&str, &str, &str)> = artifacts
        .iter()
        .map(|(id, a)| (*id, (a.kind.as_str(), a.uri.as_str(), a.sha256.as_str())))
        .collect();
    let mut mesh_owners: BTreeMap<&str, &GeometryPatchManifest> = BTreeMap::new();
    let mut asset_identities = appearances.clone();
    for (patch_index, patch) in doc.geometry_patches.iter().enumerate() {
        for (asset_index, asset) in patch.assets.iter().enumerate() {
            let kind = match asset.kind {
                PatchAssetKind::Mesh => "mesh",
                PatchAssetKind::Bounds => "bounds",
                PatchAssetKind::Ground => "ground",
                PatchAssetKind::Collision => "collision",
                PatchAssetKind::Occlusion => "occlusion",
                PatchAssetKind::Driveability => "driveability",
            };
            let identity = (kind, asset.uri.as_str(), asset.sha256.as_str());
            if let Some(previous) = asset_identities.get(asset.id.as_str()) {
                if *previous != identity {
                    issue(
                        &mut issues,
                        format!("geometryPatches.{patch_index}.assets.{asset_index}"),
                        "asset_identity_conflict",
                        "asset identifier has conflicting kind, URI or digest".to_owned(),
                    );
                }
            }
            asset_identities.insert(&asset.id, identity);
            if asset.kind == PatchAssetKind::Mesh {
                if artifacts.contains_key(asset.id.as_str())
                    || mesh_owners.contains_key(asset.id.as_str())
                {
                    issue(&mut issues, format!("geometryPatches.{patch_index}.assets.{asset_index}.id"), "asset_identity_conflict", "generated mesh must have one manifest owner and cannot shadow an immutable source".to_owned());
                }
                appearances.insert(&asset.id, identity);
                mesh_owners.insert(&asset.id, patch);
            }
        }
    }
    let appearance_ids: BTreeSet<&str> = appearances.keys().copied().collect();

    for (index, artifact) in doc.source.artifacts.iter().enumerate() {
        if !is_id(&artifact.id) || artifact.uri.is_empty() || !is_sha256_hex(&artifact.sha256) {
            issue(
                &mut issues,
                format!("source.artifacts.{index}"),
                "invalid_data",
                "artifact needs an id, a URI and a lowercase SHA-256".to_owned(),
            );
        }
    }
    if doc.source.assumptions.iter().any(String::is_empty) {
        issue(
            &mut issues,
            "source.assumptions".to_owned(),
            "too_small",
            "assumptions must be non-empty strings".to_owned(),
        );
    }
    if doc.question.brief.is_empty() {
        issue(
            &mut issues,
            "question.brief".to_owned(),
            "too_small",
            "brief must not be empty".to_owned(),
        );
    }
    unique(
        &doc.source
            .artifacts
            .iter()
            .map(|a| a.id.as_str())
            .collect::<Vec<_>>(),
        "source.artifacts",
        &mut issues,
    );
    unique(
        &doc.participants
            .iter()
            .map(|p| p.role_id.as_str())
            .collect::<Vec<_>>(),
        "participants",
        &mut issues,
    );
    unique(
        &doc.events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        "events",
        &mut issues,
    );
    unique(
        &doc.constraints
            .iter()
            .map(SituationConstraint::id)
            .collect::<Vec<_>>(),
        "constraints",
        &mut issues,
    );
    unique(
        &doc.knobs.iter().map(SituationKnob::id).collect::<Vec<_>>(),
        "knobs",
        &mut issues,
    );
    unique(
        &doc.geometry_patches
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        "geometryPatches",
        &mut issues,
    );

    if let Some(source_map) = &doc.template.source_map {
        if source_map.map_id != doc.source.map_id {
            issue(
                &mut issues,
                "template.sourceMap.mapId".to_owned(),
                "source_mismatch",
                "template source map must match the immutable situation source".to_owned(),
            );
        }
    }

    for (index, participant) in doc.participants.iter().enumerate() {
        let path = format!("participants.{index}");
        need(
            &roles,
            &participant.role_id,
            format!("{path}.roleId"),
            &mut issues,
        );
        if participant.intention.is_empty() {
            issue(
                &mut issues,
                format!("{path}.intention"),
                "too_small",
                "intention must not be empty".to_owned(),
            );
        }
        need(
            &appearance_ids,
            &participant.appearance.source_id,
            format!("{path}.appearance.sourceId"),
            &mut issues,
        );
        if let Some((kind, _, _)) = appearances.get(participant.appearance.source_id.as_str()) {
            if *kind != participant.appearance.kind.as_str() {
                issue(
                    &mut issues,
                    format!("{path}.appearance.kind"),
                    "appearance_mismatch",
                    "appearance kind must match its source artifact".to_owned(),
                );
            }
        }
        if let Some(owner) = mesh_owners.get(participant.appearance.source_id.as_str()) {
            if !owner
                .affected
                .role_ids
                .iter()
                .any(|r| *r == participant.role_id)
            {
                issue(
                    &mut issues,
                    format!("{path}.appearance.sourceId"),
                    "appearance_mismatch",
                    "generated appearance must be owned by a manifest affecting this role"
                        .to_owned(),
                );
            }
        }
        if participant.authority.is_empty() {
            issue(
                &mut issues,
                format!("{path}.authority"),
                "too_small",
                "at least one authority interval is required".to_owned(),
            );
        }
        let mut ordered: Vec<(usize, &AuthorityInterval)> =
            participant.authority.iter().enumerate().collect();
        ordered.sort_by(|a, b| a.1.start_s.total_cmp(&b.1.start_s));
        for (i, (original, interval)) in ordered.iter().enumerate() {
            if !(interval.start_s >= 0.0
                && interval.end_s >= 0.0
                && interval.start_s.is_finite()
                && interval.end_s.is_finite())
            {
                issue(
                    &mut issues,
                    format!("{path}.authority.{original}"),
                    "not_finite",
                    "authority bounds must be finite and non-negative".to_owned(),
                );
            }
            if interval.start_s >= interval.end_s {
                issue(
                    &mut issues,
                    format!("{path}.authority.{original}"),
                    "authority_interval",
                    "authority interval must have positive duration".to_owned(),
                );
            }
            if i > 0 && interval.start_s < ordered[i - 1].1.end_s {
                issue(
                    &mut issues,
                    format!("{path}.authority.{original}"),
                    "authority_conflict",
                    "authority intervals must not overlap".to_owned(),
                );
            }
        }
        for (i, information) in participant.information.iter().enumerate() {
            need(
                &roles,
                &information.subject_role_id,
                format!("{path}.information.{i}.subjectRoleId"),
                &mut issues,
            );
            if !(information.reaction_delay_s >= 0.0) {
                issue(
                    &mut issues,
                    format!("{path}.information.{i}.reactionDelayS"),
                    "too_small",
                    "reaction delay must be non-negative".to_owned(),
                );
            }
        }
    }

    let point = |value: &PointRef, path: &str, issues: &mut Vec<SituationIssue>| match value {
        PointRef::Role { role } => need(&roles, role, format!("{path}.role"), issues),
        PointRef::Feature { feature, .. } => {
            need(&features, feature, format!("{path}.feature"), issues)
        }
        PointRef::Pose { .. } => {}
    };
    let leaf = |value: &LeafCondition, path: &str, issues: &mut Vec<SituationIssue>| match value {
        LeafCondition::Distance { from, to, .. } => {
            need(&roles, from, format!("{path}.from"), issues);
            point(to, &format!("{path}.to"), issues);
        }
        LeafCondition::Reaches { of, region, .. } => {
            need(&roles, of, format!("{path}.of"), issues);
            point(region, &format!("{path}.region"), issues);
        }
        LeafCondition::Signal { signal, .. } => match signal {
            SignalRef::Feature { feature, .. } => {
                need(&features, feature, format!("{path}.signal.feature"), issues)
            }
            SignalRef::Control { control } => {
                need(&controls, control, format!("{path}.signal.control"), issues)
            }
            SignalRef::Handle { .. } => {}
        },
        LeafCondition::Ttc { of, to, .. } | LeafCondition::Headway { of, to, .. } => {
            need(&roles, of, format!("{path}.of"), issues);
            need(&roles, to, format!("{path}.to"), issues);
        }
        LeafCondition::Visible { of, to, .. } => {
            need(&roles, of, format!("{path}.of"), issues);
            need(&roles, to, format!("{path}.to"), issues);
        }
        LeafCondition::Detected { of, by, sensor, .. } => {
            need(&roles, of, format!("{path}.of"), issues);
            need(&roles, by, format!("{path}.by"), issues);
            if let Some(sensor) = sensor {
                if let Some(observer) = doc.template.role(by) {
                    if !observer.base.actor.sensors.iter().any(|s| s.id == *sensor) {
                        issues.push(SituationIssue {
                            path: format!("{path}.sensor"),
                            code: "reference_unknown",
                            message: format!("unknown sensor \"{sensor}\" on role \"{by}\""),
                        });
                    }
                }
            }
        }
        LeafCondition::Speed { of, .. } | LeafCondition::Standstill { of, .. } => {
            need(&roles, of, format!("{path}.of"), issues)
        }
        LeafCondition::Collision { of, with } => {
            need(&roles, of, format!("{path}.of"), issues);
            if let t::CollisionWith::Role(role) = with {
                need(&roles, role, format!("{path}.with"), issues);
            }
        }
    };
    let condition = |value: &Condition, path: &str, issues: &mut Vec<SituationIssue>| match value {
        Condition::Leaf(l) => leaf(l, path, issues),
        Condition::Logical(
            t::LogicalCondition::And { operands } | t::LogicalCondition::Or { operands },
        ) => {
            for (i, operand) in operands.iter().enumerate() {
                leaf(operand, &format!("{path}.operands.{i}"), issues);
            }
        }
        Condition::Logical(t::LogicalCondition::Not { operand }) => {
            leaf(operand, &format!("{path}.operand"), issues)
        }
    };
    let params: BTreeSet<&str> = doc
        .template
        .params
        .declarations
        .iter()
        .map(|p| p.id())
        .collect();
    for (index, event) in doc.events.iter().enumerate() {
        let path = format!("events.{index}");
        if !is_id(&event.id) {
            issue(
                &mut issues,
                format!("{path}.id"),
                "invalid_data",
                "event id must be 1-200 characters".to_owned(),
            );
        }
        if !(event.window_s.0 >= 0.0 && event.window_s.1 >= 0.0 && event.tolerance_s >= 0.0) {
            issue(
                &mut issues,
                format!("{path}.windowS"),
                "too_small",
                "event window and tolerance must be non-negative".to_owned(),
            );
        }
        if event.window_s.0 > event.window_s.1 {
            issue(
                &mut issues,
                format!("{path}.windowS"),
                "invalid_bounds",
                "window start must not exceed end".to_owned(),
            );
        }
        condition(&event.condition, &format!("{path}.condition"), &mut issues);
        for l in condition_leaves(&event.condition) {
            for expression in leaf_expressions(l) {
                for r#ref in expression.param_refs() {
                    need(&params, &r#ref, format!("{path}.condition"), &mut issues);
                }
            }
        }
    }
    for (index, constraint) in doc.constraints.iter().enumerate() {
        let path = format!("constraints.{index}");
        match constraint {
            SituationConstraint::EventOccurs { event_id, .. } => {
                need(&events, event_id, format!("{path}.eventId"), &mut issues)
            }
            SituationConstraint::EventOffset {
                before,
                after,
                min_s,
                max_s,
                ..
            } => {
                need(&events, before, format!("{path}.before"), &mut issues);
                need(&events, after, format!("{path}.after"), &mut issues);
                if !(min_s.is_finite() && max_s.is_finite()) {
                    issue(
                        &mut issues,
                        path.clone(),
                        "not_finite",
                        "offset bounds must be finite".to_owned(),
                    );
                }
                if min_s > max_s {
                    issue(
                        &mut issues,
                        path.clone(),
                        "invalid_bounds",
                        "minS must not exceed maxS".to_owned(),
                    );
                }
                if before == after && (*min_s > 0.0 || *max_s < 0.0) {
                    issue(
                        &mut issues,
                        path.clone(),
                        "constraint_conflict",
                        "an event has zero offset from itself".to_owned(),
                    );
                }
            }
        }
    }
    let mut knob_targets: BTreeSet<String> = BTreeSet::new();
    for (index, knob) in doc.knobs.iter().enumerate() {
        let path = format!("knobs.{index}");
        if !knob_targets.insert(knob.target_key()) {
            issue(
                &mut issues,
                path.clone(),
                "knob_conflict",
                "only one knob may bound a target".to_owned(),
            );
        }
        let (min, max) = knob.bounds();
        if !(min.is_finite() && max.is_finite()) {
            issue(
                &mut issues,
                path.clone(),
                "not_finite",
                "knob bounds must be finite".to_owned(),
            );
        }
        if min > max {
            issue(
                &mut issues,
                path.clone(),
                "invalid_bounds",
                "min must not exceed max".to_owned(),
            );
        }
        match knob {
            SituationKnob::InteractionTime { interaction_id, .. } => {
                if min < 0.0 {
                    issue(
                        &mut issues,
                        path.clone(),
                        "too_small",
                        "interaction time bounds must be non-negative".to_owned(),
                    );
                }
                need(
                    &interactions,
                    interaction_id,
                    format!("{path}.interactionId"),
                    &mut issues,
                );
            }
            SituationKnob::RoleSpeed { role_id, .. } => {
                if min < 0.0 {
                    issue(
                        &mut issues,
                        path.clone(),
                        "too_small",
                        "speed bounds must be non-negative".to_owned(),
                    );
                }
                need(&roles, role_id, format!("{path}.roleId"), &mut issues);
            }
            SituationKnob::RolePosition { role_id, .. } => {
                need(&roles, role_id, format!("{path}.roleId"), &mut issues)
            }
        }
    }
    for (index, patch) in doc.geometry_patches.iter().enumerate() {
        let path = format!("geometryPatches.{index}");
        if patch.source_artifacts.is_empty()
            || patch.assets.is_empty()
            || patch.affected.source_ids.is_empty()
        {
            issue(
                &mut issues,
                path.clone(),
                "too_small",
                "a patch needs at least one pinned source, one asset and one affected source"
                    .to_owned(),
            );
        }
        unique(
            &patch
                .source_artifacts
                .iter()
                .map(|v| v.source_id.as_str())
                .collect::<Vec<_>>(),
            &format!("{path}.sourceArtifacts"),
            &mut issues,
        );
        unique(
            &patch
                .assets
                .iter()
                .map(|v| v.id.as_str())
                .collect::<Vec<_>>(),
            &format!("{path}.assets"),
            &mut issues,
        );
        unique(
            &patch
                .affected
                .role_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            &format!("{path}.affected.roleIds"),
            &mut issues,
        );
        unique(
            &patch
                .affected
                .source_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            &format!("{path}.affected.sourceIds"),
            &mut issues,
        );
        unique(
            &patch
                .affected
                .object_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            &format!("{path}.affected.objectIds"),
            &mut issues,
        );
        unique(
            &patch
                .satisfied_effects
                .iter()
                .map(|v| v.effect.as_str())
                .collect::<Vec<_>>(),
            &format!("{path}.satisfiedEffects"),
            &mut issues,
        );
        unique(
            &patch
                .required_effects
                .iter()
                .map(|v| v.as_str())
                .collect::<Vec<_>>(),
            &format!("{path}.requiredEffects"),
            &mut issues,
        );
        let pinned: BTreeSet<&str> = patch
            .source_artifacts
            .iter()
            .map(|v| v.source_id.as_str())
            .collect();
        for (i, pin) in patch.source_artifacts.iter().enumerate() {
            need(
                &sources,
                &pin.source_id,
                format!("{path}.sourceArtifacts.{i}.sourceId"),
                &mut issues,
            );
            if artifacts
                .get(pin.source_id.as_str())
                .map(|a| a.sha256.as_str())
                != Some(pin.sha256.as_str())
            {
                issue(
                    &mut issues,
                    format!("{path}.sourceArtifacts.{i}.sha256"),
                    "source_digest_mismatch",
                    "source digest must match the immutable source artifact".to_owned(),
                );
            }
        }
        for (i, r#ref) in patch.affected.source_ids.iter().enumerate() {
            need(
                &pinned,
                r#ref,
                format!("{path}.affected.sourceIds.{i}"),
                &mut issues,
            );
        }
        for (i, r#ref) in patch.affected.role_ids.iter().enumerate() {
            need(
                &roles,
                r#ref,
                format!("{path}.affected.roleIds.{i}"),
                &mut issues,
            );
        }
        for (i, asset) in patch.assets.iter().enumerate() {
            if !is_id(&asset.id) || asset.uri.is_empty() || !is_sha256_hex(&asset.sha256) {
                issue(
                    &mut issues,
                    format!("{path}.assets.{i}"),
                    "invalid_data",
                    "asset needs an id, a URI and a lowercase SHA-256".to_owned(),
                );
            }
        }
        let assets: BTreeMap<&str, &PatchAsset> =
            patch.assets.iter().map(|a| (a.id.as_str(), a)).collect();
        let satisfied: BTreeSet<GeometryEffect> =
            patch.satisfied_effects.iter().map(|v| v.effect).collect();
        for (i, claim) in patch.satisfied_effects.iter().enumerate() {
            match assets.get(claim.asset_id.as_str()) {
                None => issue(
                    &mut issues,
                    format!("{path}.satisfiedEffects.{i}.assetId"),
                    "reference_unknown",
                    "effect evidence must name a patch asset".to_owned(),
                ),
                Some(asset) if !asset.kind.matches_effect(claim.effect) => issue(
                    &mut issues,
                    format!("{path}.satisfiedEffects.{i}"),
                    "geometry_effect_conflict",
                    "effect evidence asset kind must match the claimed effect".to_owned(),
                ),
                Some(_) => {}
            }
            if !patch.required_effects.contains(&claim.effect) {
                issue(
                    &mut issues,
                    format!("{path}.satisfiedEffects.{i}.effect"),
                    "geometry_effect_conflict",
                    "satisfied effect must be declared required".to_owned(),
                );
            }
        }
        match patch.status {
            PatchStatus::Executable => {
                if patch.required_effects.is_empty() {
                    issue(
                        &mut issues,
                        format!("{path}.requiredEffects"),
                        "geometry_effect_missing",
                        "executable patch must declare its effects".to_owned(),
                    );
                }
                for required in &patch.required_effects {
                    if !satisfied.contains(required) {
                        issue(
                            &mut issues,
                            format!("{path}.requiredEffects"),
                            "geometry_effect_missing",
                            format!("executable patch lacks {} evidence", required.as_str()),
                        );
                    }
                }
            }
            PatchStatus::VisualOnly => {
                if patch
                    .required_effects
                    .iter()
                    .any(|v| *v != GeometryEffect::Bounds)
                    || patch
                        .satisfied_effects
                        .iter()
                        .any(|v| v.effect != GeometryEffect::Bounds)
                {
                    issue(
                        &mut issues,
                        path.clone(),
                        "geometry_effect_conflict",
                        "visual-only patches cannot claim executable geometry effects".to_owned(),
                    );
                }
            }
        }
    }
    issues
}

/// Parse and validate a situation program document.
pub fn parse_situation(value: &Value) -> CompileResult<SituationProgram> {
    let Some(template_value) = value.get("template") else {
        return Err(invalid(vec![SituationIssue {
            path: "template".to_owned(),
            code: "invalid_type",
            message: "template is required".to_owned(),
        }]));
    };
    // The template goes through its own contract first so its findings keep
    // their own paths and codes, then the outer document.
    let template = parse_template(template_value).map_err(|mut e| {
        e.path = Some(match e.path.take() {
            Some(p) => format!("template.{p}"),
            None => "template".to_owned(),
        });
        e
    })?;
    let mut outer = value.clone();
    if let Value::Object(map) = &mut outer {
        map.insert("template".to_owned(), serde_json::to_value(&template)?);
    }
    let program: SituationProgram = serde_json::from_value(outer).map_err(|e| {
        invalid(vec![SituationIssue {
            path: String::new(),
            code: "invalid_data",
            message: e.to_string(),
        }])
    })?;
    validate_program(program)
}

fn validate_program(program: SituationProgram) -> CompileResult<SituationProgram> {
    // Canonical extensions permit JSON data; reject non-finite values there too.
    if let Err(e) = canonical_json_of(&program) {
        return Err(invalid(vec![SituationIssue {
            path: String::new(),
            code: "invalid_data",
            message: e.to_string(),
        }]));
    }
    let issues = inspect_program(&program);
    if !issues.is_empty() {
        return Err(invalid(issues));
    }
    Ok(program)
}

/// A fresh revision-0 program over an immutable source.
pub fn create_situation_program(
    source: SituationSource,
    template: ScenarioTemplate,
    question: SituationQuestion,
    changes: SituationChanges,
) -> CompileResult<SituationProgram> {
    validate_program(SituationProgram {
        situation_version: SITUATION_VERSION,
        revision: 0,
        source,
        template,
        question: changes.question.unwrap_or(question),
        participants: changes.participants.unwrap_or_default(),
        events: changes.events.unwrap_or_default(),
        constraints: changes.constraints.unwrap_or_default(),
        knobs: changes.knobs.unwrap_or_default(),
        geometry_patches: changes.geometry_patches.unwrap_or_default(),
    })
}

/// Same key sorting, float normalisation and SHA-256 as every canonical
/// scenario artifact.
pub fn situation_digest(program: &SituationProgram) -> CompileResult<String> {
    // Authored artifacts quantise fractional numbers to six decimal places;
    // execution input hashes deliberately retain their full precision.
    fn round_numbers(value: &mut Value) -> Result<(), CoreError> {
        match value {
            Value::Number(number) => {
                if let Some(value) = number.as_f64() {
                    if value.fract() != 0.0 && value.abs() < 1e15 {
                        *number = serde_json::from_str(&crate::invariants::to_fixed(value, 6))
                            .map_err(CoreError::Json)?;
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    round_numbers(value)?;
                }
            }
            Value::Object(values) => {
                for value in values.values_mut() {
                    round_numbers(value)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    let mut value = serde_json::to_value(program).map_err(CoreError::Json)?;
    round_numbers(&mut value)?;
    Ok(simforge_core::hash::content_hash(&value)?)
}

/* ------------------------------------------------------- template operations */

/// Metadata fields an editor may change. Timestamps remain document-managed.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateMetaPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archetype: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub negative_control: Option<bool>,
}

/// Serializable template edits. Payloads are the canonical JSON shapes of the
/// template contract; the edited document is re-parsed through
/// [`parse_template`] after every transaction, so this enum is a routing
/// table, never a second schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TemplateOp {
    SetTemplateMeta {
        patch: TemplateMetaPatch,
    },
    #[serde(rename_all = "camelCase")]
    SetSourceMap {
        source_map: Option<Value>,
    },
    SetEnvironment {
        environment: Value,
    },
    AddParam {
        param: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    ReplaceParam {
        id: String,
        param: Value,
    },
    RemoveParam {
        id: String,
    },
    AddRole {
        role: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    ReplaceRole {
        id: String,
        role: Value,
    },
    RemoveRole {
        id: String,
    },
    #[serde(rename_all = "camelCase")]
    MoveRole {
        id: String,
        to_index: usize,
    },
    AddInteraction {
        interaction: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    ReplaceInteraction {
        id: String,
        interaction: Value,
    },
    RemoveInteraction {
        id: String,
    },
    AddReasoningTraceSegment {
        segment: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    ReplaceReasoningTraceSegment {
        id: String,
        segment: Value,
    },
    RemoveReasoningTraceSegment {
        id: String,
    },
    AddMapSignalPlan {
        plan: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    ReplaceMapSignalPlan {
        id: String,
        plan: Value,
    },
    RemoveMapSignalPlan {
        id: String,
    },
    AddProp {
        prop: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    ReplaceProp {
        id: String,
        prop: Value,
    },
    RemoveProp {
        id: String,
    },
    AddInvariant {
        invariant: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    ReplaceInvariant {
        id: String,
        invariant: Value,
    },
    RemoveInvariant {
        id: String,
    },
    AddVariant {
        variant: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    ReplaceVariant {
        id: String,
        variant: Value,
    },
    RemoveVariant {
        id: String,
    },
    #[serde(rename_all = "camelCase")]
    SetMetricSubject {
        role_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    SetClip {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clip_seconds: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        warmup_seconds: Option<f64>,
    },
    SetTemplateExtension {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
    },
}

impl TemplateOp {
    pub fn describe(&self) -> &'static str {
        match self {
            Self::SetTemplateMeta { .. } => "Edit scenario info",
            Self::SetSourceMap { .. } => "Change source map",
            Self::SetEnvironment { .. } => "Edit environment",
            Self::AddParam { .. } => "Add parameter",
            Self::ReplaceParam { .. } => "Edit parameter",
            Self::RemoveParam { .. } => "Delete parameter",
            Self::AddRole { .. } => "Add actor",
            Self::ReplaceRole { .. } => "Edit actor",
            Self::RemoveRole { .. } => "Delete actor",
            Self::MoveRole { .. } => "Reorder actor",
            Self::AddInteraction { .. } => "Add interaction",
            Self::ReplaceInteraction { .. } => "Edit interaction",
            Self::RemoveInteraction { .. } => "Delete interaction",
            Self::AddReasoningTraceSegment { .. } => "Add reasoning trace",
            Self::ReplaceReasoningTraceSegment { .. } => "Edit reasoning trace",
            Self::RemoveReasoningTraceSegment { .. } => "Delete reasoning trace",
            Self::AddMapSignalPlan { .. } => "Add traffic signal plan",
            Self::ReplaceMapSignalPlan { .. } => "Edit traffic signal plan",
            Self::RemoveMapSignalPlan { .. } => "Delete traffic signal plan",
            Self::AddProp { .. } => "Add prop",
            Self::ReplaceProp { .. } => "Edit prop",
            Self::RemoveProp { .. } => "Delete prop",
            Self::AddInvariant { .. } => "Add rule",
            Self::ReplaceInvariant { .. } => "Edit rule",
            Self::RemoveInvariant { .. } => "Delete rule",
            Self::AddVariant { .. } => "Add variant",
            Self::ReplaceVariant { .. } => "Edit variant",
            Self::RemoveVariant { .. } => "Delete variant",
            Self::SetMetricSubject { .. } => "Set metric subject",
            Self::SetClip { .. } => "Edit scenario duration",
            Self::SetTemplateExtension { .. } => "Edit extension",
        }
    }
}

fn object_mut<'a>(value: &'a mut Value, what: &str) -> Result<&'a mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| format!("{what} is not an object"))
}

fn array_at<'a>(
    root: &'a mut Map<String, Value>,
    path: &[&str],
) -> Result<&'a mut Vec<Value>, String> {
    let mut cursor = root;
    let (last, parents) = path.split_last().expect("non-empty path");
    for key in parents {
        let next = cursor
            .entry((*key).to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        cursor = object_mut(next, key)?;
    }
    let slot = cursor
        .entry((*last).to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    slot.as_array_mut()
        .ok_or_else(|| format!("{last} is not an array"))
}

fn id_of(item: &Value) -> Option<&str> {
    item.get("id").and_then(Value::as_str)
}

fn index_of(items: &[Value], id: &str, kind: &str) -> Result<usize, String> {
    items
        .iter()
        .position(|item| id_of(item) == Some(id))
        .ok_or_else(|| format!("no {kind} with id \"{id}\""))
}

fn insertion_index(index: Option<usize>, len: usize) -> Result<usize, String> {
    let at = index.unwrap_or(len);
    if at > len {
        return Err(format!("index {at} is out of range"));
    }
    Ok(at)
}

fn add_item(
    items: &mut Vec<Value>,
    item: Value,
    index: Option<usize>,
    kind: &str,
) -> Result<(), String> {
    let Some(id) = id_of(&item) else {
        return Err(format!("{kind} needs a string id"));
    };
    if items.iter().any(|existing| id_of(existing) == Some(id)) {
        return Err(format!("{kind} id \"{id}\" already exists"));
    }
    let at = insertion_index(index, items.len())?;
    items.insert(at, item);
    Ok(())
}

fn replace_item(items: &mut [Value], id: &str, item: Value, kind: &str) -> Result<(), String> {
    let at = index_of(items, id, kind)?;
    let Some(new_id) = id_of(&item) else {
        return Err(format!("{kind} needs a string id"));
    };
    if new_id != id && items.iter().any(|existing| id_of(existing) == Some(new_id)) {
        return Err(format!("{kind} id \"{new_id}\" already exists"));
    }
    items[at] = item;
    Ok(())
}

fn remove_item(items: &mut Vec<Value>, id: &str, kind: &str) -> Result<(), String> {
    let at = index_of(items, id, kind)?;
    items.remove(at);
    Ok(())
}

/// Apply one operation to a template JSON document. Contract validation
/// happens after the whole batch, by re-parsing.
pub fn apply_template_op(doc: &mut Value, op: &TemplateOp) -> Result<(), String> {
    let root = object_mut(doc, "template")?;
    match op {
        TemplateOp::SetTemplateMeta { patch } => {
            let meta = object_mut(
                root.entry("meta".to_owned())
                    .or_insert_with(|| Value::Object(Map::new())),
                "meta",
            )?;
            if let Some(v) = &patch.name {
                meta.insert("name".to_owned(), Value::String(v.clone()));
            }
            if let Some(v) = &patch.description {
                meta.insert("description".to_owned(), Value::String(v.clone()));
            }
            if let Some(v) = &patch.app_version {
                meta.insert("appVersion".to_owned(), Value::String(v.clone()));
            }
            if let Some(v) = &patch.archetype {
                match v {
                    Some(v) => meta.insert("archetype".to_owned(), Value::String(v.clone())),
                    None => meta.remove("archetype"),
                };
            }
            if let Some(v) = &patch.tags {
                meta.insert(
                    "tags".to_owned(),
                    Value::Array(v.iter().cloned().map(Value::String).collect()),
                );
            }
            if let Some(v) = &patch.author {
                match v {
                    Some(v) => meta.insert("author".to_owned(), Value::String(v.clone())),
                    None => meta.remove("author"),
                };
            }
            if let Some(v) = patch.negative_control {
                meta.insert("negativeControl".to_owned(), Value::Bool(v));
            }
        }
        TemplateOp::SetSourceMap { source_map } => match source_map {
            Some(v) => {
                root.insert("sourceMap".to_owned(), v.clone());
            }
            None => {
                root.remove("sourceMap");
            }
        },
        TemplateOp::SetEnvironment { environment } => {
            root.insert("environment".to_owned(), environment.clone());
        }
        TemplateOp::AddParam { param, index } => add_item(
            array_at(root, &["params", "declarations"])?,
            param.clone(),
            *index,
            "parameter",
        )?,
        TemplateOp::ReplaceParam { id, param } => replace_item(
            array_at(root, &["params", "declarations"])?,
            id,
            param.clone(),
            "parameter",
        )?,
        TemplateOp::RemoveParam { id } => remove_item(
            array_at(root, &["params", "declarations"])?,
            id,
            "parameter",
        )?,
        TemplateOp::AddRole { role, index } => {
            add_item(array_at(root, &["roles"])?, role.clone(), *index, "role")?
        }
        TemplateOp::ReplaceRole { id, role } => {
            replace_item(array_at(root, &["roles"])?, id, role.clone(), "role")?
        }
        TemplateOp::RemoveRole { id } => remove_item(array_at(root, &["roles"])?, id, "role")?,
        TemplateOp::MoveRole { id, to_index } => {
            let roles = array_at(root, &["roles"])?;
            let from = index_of(roles, id, "role")?;
            if *to_index >= roles.len() {
                return Err(format!("index {to_index} is out of range"));
            }
            let role = roles.remove(from);
            roles.insert(*to_index, role);
        }
        TemplateOp::AddInteraction { interaction, index } => add_item(
            array_at(root, &["choreography", "interactions"])?,
            interaction.clone(),
            *index,
            "interaction",
        )?,
        TemplateOp::ReplaceInteraction { id, interaction } => replace_item(
            array_at(root, &["choreography", "interactions"])?,
            id,
            interaction.clone(),
            "interaction",
        )?,
        TemplateOp::RemoveInteraction { id } => remove_item(
            array_at(root, &["choreography", "interactions"])?,
            id,
            "interaction",
        )?,
        TemplateOp::AddReasoningTraceSegment { segment, index } => add_item(
            array_at(root, &["reasoningTrace"])?,
            segment.clone(),
            *index,
            "reasoning trace",
        )?,
        TemplateOp::ReplaceReasoningTraceSegment { id, segment } => replace_item(
            array_at(root, &["reasoningTrace"])?,
            id,
            segment.clone(),
            "reasoning trace",
        )?,
        TemplateOp::RemoveReasoningTraceSegment { id } => {
            remove_item(array_at(root, &["reasoningTrace"])?, id, "reasoning trace")?
        }
        TemplateOp::AddMapSignalPlan { plan, index } => add_item(
            array_at(root, &["mapSignalPlans"])?,
            plan.clone(),
            *index,
            "map signal plan",
        )?,
        TemplateOp::ReplaceMapSignalPlan { id, plan } => replace_item(
            array_at(root, &["mapSignalPlans"])?,
            id,
            plan.clone(),
            "map signal plan",
        )?,
        TemplateOp::RemoveMapSignalPlan { id } => {
            remove_item(array_at(root, &["mapSignalPlans"])?, id, "map signal plan")?
        }
        TemplateOp::AddProp { prop, index } => {
            add_item(array_at(root, &["props"])?, prop.clone(), *index, "prop")?
        }
        TemplateOp::ReplaceProp { id, prop } => {
            replace_item(array_at(root, &["props"])?, id, prop.clone(), "prop")?
        }
        TemplateOp::RemoveProp { id } => remove_item(array_at(root, &["props"])?, id, "prop")?,
        TemplateOp::AddInvariant { invariant, index } => add_item(
            array_at(root, &["invariants"])?,
            invariant.clone(),
            *index,
            "invariant",
        )?,
        TemplateOp::ReplaceInvariant { id, invariant } => replace_item(
            array_at(root, &["invariants"])?,
            id,
            invariant.clone(),
            "invariant",
        )?,
        TemplateOp::RemoveInvariant { id } => {
            remove_item(array_at(root, &["invariants"])?, id, "invariant")?
        }
        TemplateOp::AddVariant { variant, index } => add_item(
            array_at(root, &["variants"])?,
            variant.clone(),
            *index,
            "variant",
        )?,
        TemplateOp::ReplaceVariant { id, variant } => replace_item(
            array_at(root, &["variants"])?,
            id,
            variant.clone(),
            "variant",
        )?,
        TemplateOp::RemoveVariant { id } => {
            remove_item(array_at(root, &["variants"])?, id, "variant")?
        }
        TemplateOp::SetMetricSubject { role_id } => match role_id {
            Some(id) => {
                root.insert("metricSubject".to_owned(), Value::String(id.clone()));
            }
            None => {
                root.remove("metricSubject");
            }
        },
        TemplateOp::SetClip {
            clip_seconds,
            warmup_seconds,
        } => {
            let choreography = object_mut(
                root.entry("choreography".to_owned())
                    .or_insert_with(|| Value::Object(Map::new())),
                "choreography",
            )?;
            if let Some(v) = clip_seconds {
                choreography.insert("clipSeconds".to_owned(), Value::from(*v));
            }
            if let Some(v) = warmup_seconds {
                choreography.insert("warmupSeconds".to_owned(), Value::from(*v));
            }
        }
        TemplateOp::SetTemplateExtension { key, value } => match value {
            Some(v) => {
                let ext = object_mut(
                    root.entry("extensions".to_owned())
                        .or_insert_with(|| Value::Object(Map::new())),
                    "extensions",
                )?;
                ext.insert(key.clone(), v.clone());
            }
            None => {
                let empty = match root.get_mut("extensions").and_then(Value::as_object_mut) {
                    Some(ext) => {
                        ext.remove(key);
                        ext.is_empty()
                    }
                    None => false,
                };
                if empty {
                    root.remove("extensions");
                }
            }
        },
    }
    Ok(())
}

/* ------------------------------------------------------------ transactions */

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SituationPreserve {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactions: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SituationTransaction {
    pub base_revision: u64,
    pub base_digest: String,
    pub label: String,
    #[serde(default)]
    pub template_ops: Vec<TemplateOp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<SituationChanges>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preserve: Option<SituationPreserve>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SituationTransactionResult {
    pub program: SituationProgram,
    pub changed_paths: Vec<String>,
    pub digest: String,
}

fn tx_fail(path: &str, code: &str, message: impl Into<String>) -> CompileError {
    CompileError::at(code, path, message).as_findings()
}

fn same<T: Serialize + ?Sized>(a: &T, b: &T) -> CompileResult<bool> {
    Ok(canonical_json_of(a)? == canonical_json_of(b)?)
}

/// Stage every operation on a private copy; validate once; publish a new
/// revision only when the whole result is valid.
pub fn apply_situation_transaction(
    program: &SituationProgram,
    transaction: &SituationTransaction,
) -> CompileResult<SituationTransactionResult> {
    if transaction.label.is_empty() {
        return Err(tx_fail(
            "label",
            "too_small",
            "transaction label must not be empty",
        ));
    }
    if !is_sha256_hex(&transaction.base_digest) {
        return Err(tx_fail(
            "baseDigest",
            "invalid_data",
            "expected lowercase SHA-256",
        ));
    }
    if transaction.base_revision != program.revision {
        return Err(tx_fail(
            "baseRevision",
            "stale_revision",
            "transaction revision does not match base",
        ));
    }
    if transaction.base_digest != situation_digest(program)? {
        return Err(tx_fail(
            "baseDigest",
            "stale_digest",
            "transaction digest does not match base",
        ));
    }
    if program.revision >= MAX_REVISION {
        return Err(tx_fail(
            "baseRevision",
            "revision_overflow",
            "revision cannot be incremented safely",
        ));
    }
    let mut template_doc = serde_json::to_value(&program.template)?;
    for (index, op) in transaction.template_ops.iter().enumerate() {
        apply_template_op(&mut template_doc, op).map_err(|e| {
            tx_fail(
                &format!("templateOps.{index}"),
                "template_operation_failed",
                e,
            )
        })?;
    }
    let template = parse_template(&template_doc).map_err(|mut e| {
        e.path = Some(match e.path.take() {
            Some(p) => format!("template.{p}"),
            None => "template".to_owned(),
        });
        e
    })?;
    let changes = transaction.changes.clone().unwrap_or_default();
    let next = validate_program(SituationProgram {
        situation_version: program.situation_version,
        revision: program.revision + 1,
        source: program.source.clone(),
        template,
        question: changes.question.unwrap_or_else(|| program.question.clone()),
        participants: changes
            .participants
            .unwrap_or_else(|| program.participants.clone()),
        events: changes.events.unwrap_or_else(|| program.events.clone()),
        constraints: changes
            .constraints
            .unwrap_or_else(|| program.constraints.clone()),
        knobs: changes.knobs.unwrap_or_else(|| program.knobs.clone()),
        geometry_patches: changes
            .geometry_patches
            .unwrap_or_else(|| program.geometry_patches.clone()),
    })?;

    if let Some(preserve) = &transaction.preserve {
        for role_id in preserve.roles.iter().flatten() {
            let Some(old_role) = program.template.role(role_id) else {
                return Err(tx_fail(
                    "preserve.roles",
                    "reference_unknown",
                    format!("unknown preserved role \"{role_id}\""),
                ));
            };
            let old_participant = program.participants.iter().find(|p| p.role_id == *role_id);
            let new_participant = next.participants.iter().find(|p| p.role_id == *role_id);
            if !same(&Some(old_role), &next.template.role(role_id))?
                || !same(&old_participant, &new_participant)?
            {
                return Err(tx_fail(
                    "preserve.roles",
                    "preserved_entity_changed",
                    format!("preserved role \"{role_id}\" changed"),
                ));
            }
        }
        for interaction_id in preserve.interactions.iter().flatten() {
            let Some(old) = program.template.interaction(interaction_id) else {
                return Err(tx_fail(
                    "preserve.interactions",
                    "reference_unknown",
                    format!("unknown preserved interaction \"{interaction_id}\""),
                ));
            };
            if !same(&Some(old), &next.template.interaction(interaction_id))? {
                return Err(tx_fail(
                    "preserve.interactions",
                    "preserved_entity_changed",
                    format!("preserved interaction \"{interaction_id}\" changed"),
                ));
            }
        }
    }

    let mut changed_paths = vec!["revision".to_owned()];
    let before = serde_json::to_value(&program.template)?;
    let after = serde_json::to_value(&next.template)?;
    let (Value::Object(before), Value::Object(after)) = (before, after) else {
        unreachable!("templates serialise as objects")
    };
    let keys: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    for key in keys {
        if before.get(key) != after.get(key) {
            changed_paths.push(format!("template.{key}"));
        }
    }
    if !same(&program.question, &next.question)? {
        changed_paths.push("question".to_owned());
    }
    if !same(&program.participants, &next.participants)? {
        changed_paths.push("participants".to_owned());
    }
    if !same(&program.events, &next.events)? {
        changed_paths.push("events".to_owned());
    }
    if !same(&program.constraints, &next.constraints)? {
        changed_paths.push("constraints".to_owned());
    }
    if !same(&program.knobs, &next.knobs)? {
        changed_paths.push("knobs".to_owned());
    }
    if !same(&program.geometry_patches, &next.geometry_patches)? {
        changed_paths.push("geometryPatches".to_owned());
    }
    changed_paths.sort();
    let digest = situation_digest(&next)?;
    Ok(SituationTransactionResult {
        program: next,
        changed_paths,
        digest,
    })
}

/* -------------------------------------------------------- generated geometry */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeometryAssetRef {
    pub id: String,
    pub uri: String,
    pub sha256: String,
    pub kind: String,
    pub format: String,
    pub frame: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeometryPlacement {
    pub position: [f64; 3],
    pub heading_rad: f64,
    pub ground_offset_m: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeometrySupport {
    pub motion: String,
    pub collision: String,
    pub occlusion: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedStaticGeometryDescriptor {
    pub schema: String,
    pub job_id: String,
    pub map_id: String,
    pub source_artifacts: Vec<SourceArtifactRef>,
    pub object_ids: Vec<String>,
    pub asset: GeometryAssetRef,
    pub placement: GeometryPlacement,
    pub dimensions: CatalogDims,
    pub support: GeometrySupport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceArtifactRef {
    pub id: String,
    pub uri: String,
    pub sha256: String,
}

/// The renderer-facing model reference of a generated catalog entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedModelRef {
    pub kind: String,
    pub url: String,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_assets: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yaw_rad: Option<f64>,
}

/// The asset-catalog entry a generated static proxy is registered under.
/// Like `ExternalCatalogEntry`, this consumes execution fields from the full
/// public catalog document without retaining display labels, tags or defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCatalogEntry {
    pub id: String,
    pub class: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_class: Option<String>,
    #[serde(default)]
    pub compatible_actor_classes: Vec<String>,
    #[serde(default)]
    pub description: String,
    pub dims: CatalogDims,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<GeneratedModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<Value>,
}

/// Trust boundary: the loader verifies all artifact bytes before supplying
/// this value. The compiler checks that precisely these effects are consumed
/// by canonical static actors; it performs no I/O and no triangle physics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifiedStaticGeometryBinding {
    pub patch_id: String,
    pub patch_sha256: String,
    pub role_id: String,
    pub descriptor: GeneratedStaticGeometryDescriptor,
    pub catalog_entry: GeneratedCatalogEntry,
}

fn geometry_unbound(message: impl Into<String>) -> CompileError {
    CompileError::new("geometry_patch_unbound", message)
}

fn static_geometry_entries(
    program: &SituationProgram,
    bindings: &[VerifiedStaticGeometryBinding],
) -> CompileResult<Vec<ExternalCatalogEntry>> {
    let mut by_patch: BTreeMap<&str, &VerifiedStaticGeometryBinding> = BTreeMap::new();
    let mut roles: BTreeSet<&str> = BTreeSet::new();
    for binding in bindings {
        if by_patch.contains_key(binding.patch_id.as_str()) || !roles.insert(&binding.role_id) {
            return Err(geometry_unbound(
                "Duplicate generated geometry patch or role binding",
            ));
        }
        by_patch.insert(&binding.patch_id, binding);
    }
    let mut entries = Vec::new();
    for patch in &program.geometry_patches {
        let binding = by_patch.get(patch.id.as_str()).copied();
        if patch.status != PatchStatus::Executable {
            if binding.is_some() {
                return Err(geometry_unbound(format!(
                    "Visual-only patch {} cannot supply executable geometry",
                    patch.id
                )));
            }
            continue;
        }
        let Some(verified) =
            binding.filter(|b| b.patch_sha256 == content_hash_of(patch).unwrap_or_default())
        else {
            return Err(geometry_unbound(format!(
                "Executable patch {} requires its verified matching binding",
                patch.id
            )));
        };
        by_patch.remove(patch.id.as_str());
        let d = &verified.descriptor;
        let entry = &verified.catalog_entry;
        let expected_support = GeometrySupport {
            motion: "static".to_owned(),
            collision: "planar-opaque-obb".to_owned(),
            occlusion: "planar-opaque-obb".to_owned(),
        };
        if d.schema != STATIC_GEOMETRY_SCHEMA
            || d.map_id != program.source.map_id
            || d.job_id.is_empty()
            || d.asset.kind != "mesh"
            || d.asset.format != "glb"
            || d.asset.frame != "simforge-y-up"
            || d.support != expected_support
            || d.placement.heading_rad != 0.0
            || !d.placement.ground_offset_m.is_finite()
            || d.placement.ground_offset_m.abs() > 0.05
            || !d.placement.position.iter().all(|v| v.is_finite())
            || ![d.dimensions.l, d.dimensions.w, d.dimensions.h]
                .iter()
                .all(|v| v.is_finite() && *v > 0.0)
        {
            return Err(geometry_unbound(format!(
                "Unsupported generated geometry descriptor for {}",
                patch.id
            )));
        }
        let mut canonical_sources: Vec<(&str, &str)> = Vec::with_capacity(d.source_artifacts.len());
        for source in &d.source_artifacts {
            let original = program
                .source
                .artifacts
                .iter()
                .find(|row| row.id == source.id)
                .or_else(|| {
                    program
                        .source
                        .artifacts
                        .iter()
                        .find(|row| row.uri == source.uri && row.sha256 == source.sha256)
                });
            let Some(original) =
                original.filter(|o| o.uri == source.uri && o.sha256 == source.sha256)
            else {
                return Err(geometry_unbound(format!(
                    "Source identity mismatch for {}: {}",
                    patch.id, source.id
                )));
            };
            if !canonical_sources.iter().any(|(id, _)| *id == original.id) {
                canonical_sources.push((&original.id, &original.sha256));
            }
        }
        if patch.affected.role_ids.len() != 1
            || patch.affected.role_ids[0] != verified.role_id
            || patch.affected.object_ids != d.object_ids
            || !patch.affected.source_ids.iter().map(String::as_str)
                .eq(canonical_sources.iter().map(|(id, _)| *id))
            || !patch.source_artifacts.iter().map(|pin| (pin.source_id.as_str(), pin.sha256.as_str()))
                .eq(canonical_sources.iter().copied())
            || canonical_sources.is_empty()
        {
            return Err(geometry_unbound(format!(
                "Source identity mismatch for {}",
                patch.id
            )));
        }
        let effects = [
            GeometryEffect::Bounds,
            GeometryEffect::Collision,
            GeometryEffect::Occlusion,
        ];
        let mut required: Vec<GeometryEffect> = patch.required_effects.clone();
        required.sort();
        if required != effects || patch.assets.len() != 4 || patch.satisfied_effects.len() != 3 {
            return Err(geometry_unbound(format!(
                "Unconsumed geometry effects in {}",
                patch.id
            )));
        }
        let mesh = patch.assets.iter().find(|a| a.kind == PatchAssetKind::Mesh);
        if !mesh.is_some_and(|m| {
            m.id == d.asset.id && m.uri == d.asset.uri && m.sha256 == d.asset.sha256
        }) {
            return Err(geometry_unbound(format!(
                "Mesh identity mismatch for {}",
                patch.id
            )));
        }
        for effect in effects {
            let claim = patch
                .satisfied_effects
                .iter()
                .find(|row| row.effect == effect);
            let asset = claim.and_then(|c| {
                patch
                    .assets
                    .iter()
                    .find(|row| row.id == c.asset_id && row.kind.matches_effect(effect))
            });
            let payload = serde_json::json!({
                "schema": STATIC_GEOMETRY_EFFECT_SCHEMA,
                "effect": effect,
                "meshSha256": d.asset.sha256,
                "roleId": verified.role_id,
                "placement": d.placement,
                "dimensions": d.dimensions,
                "support": d.support,
            });
            if !asset.is_some_and(|a| a.sha256 == content_hash_of(&payload).unwrap_or_default()) {
                return Err(geometry_unbound(format!(
                    "Unverified {} proxy for {}",
                    effect.as_str(),
                    patch.id
                )));
            }
        }
        let role = program.template.role(&verified.role_id);
        let participant = program
            .participants
            .iter()
            .find(|p| p.role_id == verified.role_id);
        let role_ok = role.is_some_and(|role| {
            let RoleKind::SceneAbsolute {
                pose,
                lane_ref,
                initial_route,
            } = &role.kind
            else {
                return false;
            };
            role.base.actor.class == t::ActorClass::StaticObject
                && role.base.actor.r#static
                && role.base.actor.catalog_id.as_deref() == Some(entry.id.as_str())
                && matches!(role.base.initial_speed_kph, Some(NumberOrExpr::Number(v)) if v == 0.0)
                && initial_route.is_none()
                && lane_ref.is_none()
                && role.base.actor.dims.as_ref().is_some_and(|dims| {
                    dims.length == d.dimensions.l
                        && dims.width == d.dimensions.w
                        && dims.height == d.dimensions.h
                })
                && pose.position.x == d.placement.position[0]
                && pose.position.y == d.placement.position[1]
                && pose.position.z == d.placement.position[2]
                && pose.heading_rad == d.placement.heading_rad
                && role.base.essentiality == t::Essentiality::Required
        });
        let clip = program.template.choreography.clip_seconds;
        let participant_ok = participant.is_some_and(|p| {
            p.appearance.kind == AppearanceKind::Mesh
                && p.appearance.source_id == d.asset.id
                && p.authority.len() == 1
                && p.authority[0]
                    == AuthorityInterval {
                        kind: AuthorityKind::Controller,
                        start_s: 0.0,
                        end_s: clip,
                    }
        });
        let untouched = !program.template.choreography.interactions.iter().any(|i| i.base.actor == verified.role_id && !matches!(i.verb, t::Verb::Exist { .. }))
            && !program.knobs.iter().any(|k| matches!(k, SituationKnob::RoleSpeed { role_id, .. } | SituationKnob::RolePosition { role_id, .. } if *role_id == verified.role_id));
        if !role_ok || !participant_ok || !untouched {
            return Err(geometry_unbound(format!(
                "Generated static role {} changed outside its verified binding",
                verified.role_id
            )));
        }
        let model_ok = entry.model.as_ref().is_some_and(|m| {
            m.kind == "glb"
                && m.url == d.asset.uri
                && m.content_hash == d.asset.sha256
                && m.animated != Some(true)
                && m.clip_assets.is_none()
                && m.scale.unwrap_or(1.0) == 1.0
                && m.yaw_rad.unwrap_or(0.0) == 0.0
        });
        if entry.id != format!("gallery.generated.{}", d.asset.sha256)
            || entry.class != "occluder"
            || entry.actor_class.as_deref() != Some("static_object")
            || entry.dims != d.dimensions
            || !model_ok
            || entry.animation.is_some()
        {
            return Err(geometry_unbound(format!(
                "Generated catalog identity mismatch for {}",
                patch.id
            )));
        }
        entries.push(ExternalCatalogEntry {
            id: entry.id.clone(),
            class: entry.class.clone(),
            actor_class: entry.actor_class.clone(),
            compatible_actor_classes: entry.compatible_actor_classes.clone(),
            description: entry.description.clone(),
            dims: entry.dims,
        });
    }
    if !by_patch.is_empty() {
        return Err(geometry_unbound(
            "Generated geometry binding has no executable manifest",
        ));
    }
    Ok(entries)
}

/* ----------------------------------------------------------------- compile */

#[derive(Debug, Clone, Default)]
pub struct SituationCompileOptions {
    /// `seed` is required; `observations` are replaced by the program's events.
    pub materialize: MaterializeOptions,
    /// Grounded matched site; required unless every role is `scene_absolute`.
    pub site: Option<MatchedSite>,
    pub geometry_bindings: Vec<VerifiedStaticGeometryBinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityRow {
    pub role_id: String,
    pub kind: AuthorityKind,
    pub start_s: f64,
    pub end_s: f64,
    pub interval_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handover_interaction_id: Option<String>,
    pub route_kind: &'static str,
    pub action_hook_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundSituation {
    pub program_digest: String,
    pub execution: MaterializeResult,
    pub authority: Vec<AuthorityRow>,
    pub visual_only_patches: Vec<String>,
}

fn route_kind_name(route: &RouteSpec) -> &'static str {
    match route {
        RouteSpec::LanePath { .. } => "lanePath",
        RouteSpec::Follow { .. } => "follow",
        RouteSpec::Polyline { .. } => "polyline",
        RouteSpec::TimedPolyline { .. } => "timedPolyline",
    }
}

fn engine_err(e: simforge_core::error::SimEngineError) -> CompileError {
    CompileError::from(CoreError::Engine(e))
}

fn revalidate(input: &SimScenarioInput) -> CompileResult<SimScenarioInput> {
    Ok(
        simforge_core::types::parse_scenario_input_value(&serde_json::to_value(input)?)
            .map_err(|e| CompileError::from(CoreError::from(e)))?,
    )
}

/// Lower through the existing map-bound/portable compiler, never a second
/// physics model, then prove the authority declarations against the concrete
/// input.
pub fn compile_situation(
    program: &SituationProgram,
    bundle: &MapBundle,
    options: &SituationCompileOptions,
) -> CompileResult<BoundSituation> {
    if !options
        .materialize
        .seed
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return Err(CompileError::new(
            "seed_required",
            "situation execution requires an explicit seed",
        ));
    }
    if program.source.map_id != bundle.map_id() {
        return Err(CompileError::new(
            "source_map_mismatch",
            "source and execution map differ",
        ));
    }
    let generated = static_geometry_entries(program, &options.geometry_bindings)?;
    let mut materialize_options = options.materialize.clone();
    materialize_options
        .catalog
        .extend(&generated)
        .map_err(|e| CompileError::new("geometry_patch_unbound", e))?;
    materialize_options.observations = program
        .events
        .iter()
        .map(|e| Observation {
            id: e.id.clone(),
            condition: e.condition.clone(),
        })
        .collect();
    let template = &program.template;
    let absolute = template
        .roles
        .iter()
        .all(|r| matches!(r.kind, RoleKind::SceneAbsolute { .. }));
    let mut execution = if absolute {
        materialize_map_bound(template, bundle, &materialize_options)?
    } else {
        let Some(site) = &options.site else {
            return Err(CompileError::new(
                "site_required",
                "portable situation requires a grounded matched site",
            ));
        };
        materialize(template, bundle, site, &materialize_options)?
    };

    for binding in &options.geometry_bindings {
        let d = &binding.descriptor;
        let actor = execution.input.actor(&binding.role_id);
        let consumed =
            actor.is_some_and(|actor| {
                actor.is_static
                    && actor.present_at_start
                    && actor.initial.speed_mps == 0.0
                    && actor.dims
                        == sim::Dims {
                            l: d.dimensions.l,
                            w: d.dimensions.w,
                            h: d.dimensions.h,
                        }
                    && actor.initial.pose
                        == sim::Pose {
                            x: d.placement.position[0],
                            z: d.placement.position[2],
                            heading_rad: 0.0,
                        }
                    && actor.has_tag(&format!("catalog:{}", binding.catalog_entry.id))
            }) && !execution.input.interactions.iter().any(|i| {
                i.actor_id == binding.role_id && !matches!(i.verb, sim::Verb::Exist { .. })
            });
        if !consumed {
            return Err(CompileError::new(
                "geometry_patch_unbound",
                format!(
                    "Generated geometry {} was not consumed as its declared static proxy",
                    binding.patch_id
                ),
            ));
        }
    }

    let by_role: BTreeMap<&str, &SituationParticipant> = program
        .participants
        .iter()
        .map(|p| (p.role_id.as_str(), p))
        .collect();
    let dt = execution.input.dt;
    let clip = execution.input.clip_seconds;
    let dynamic = execution.input.physics_mode() == MotionPhysicsMode::DynamicV1;
    let mut authority: Vec<AuthorityRow> = Vec::new();
    let mut handovers: Vec<sim::Interaction> = Vec::new();
    let on_grid = |boundary: f64| (boundary / dt - (boundary / dt).round()).abs() <= 1e-8;
    for actor in &execution.input.actors {
        if actor.has_tag("ambient") {
            continue;
        }
        let Some(participant) = by_role.get(actor.id.as_str()) else {
            return Err(CompileError::new(
                "authority_missing",
                format!("role {} has no participant authority declaration", actor.id),
            ));
        };
        let mut intervals: Vec<AuthorityInterval> = participant.authority.clone();
        intervals.sort_by(|a, b| a.start_s.total_cmp(&b.start_s));
        let timed = matches!(actor.behavior.route, RouteSpec::TimedPolyline { .. });
        let mut covered_until = 0.0;
        for (interval_index, interval) in intervals.iter().enumerate() {
            if !interval.start_s.is_finite()
                || !interval.end_s.is_finite()
                || interval.end_s <= interval.start_s
            {
                return Err(CompileError::new(
                    "authority_interval_invalid",
                    format!("role {} has an invalid authority interval", actor.id),
                ));
            }
            if interval.start_s != covered_until {
                return Err(CompileError::new(
                    "authority_gap",
                    format!("role {} has a gap or overlap at {covered_until}s", actor.id),
                ));
            }
            for boundary in [interval.start_s, interval.end_s] {
                if !on_grid(boundary) {
                    return Err(CompileError::new(
                        "authority_boundary_off_tick",
                        format!(
                            "role {}: {boundary}s is not on the {dt}s runtime grid",
                            actor.id
                        ),
                    ));
                }
            }
            covered_until = interval.end_s;
            let kind = interval.kind;
            let previous = interval_index.checked_sub(1).map(|i| intervals[i]);
            if interval_index == 0 && ((kind == AuthorityKind::Recorded) != timed) {
                return Err(CompileError::new(
                    "authority_route_mismatch",
                    format!(
                        "role {}: initial {} authority disagrees with {}",
                        actor.id,
                        kind.as_str(),
                        route_kind_name(&actor.behavior.route)
                    ),
                ));
            }
            if previous.is_some_and(|p| p.kind != AuthorityKind::Recorded)
                && kind == AuthorityKind::Recorded
            {
                return Err(CompileError::new(
                    "authority_return_unsupported",
                    format!("role {}: return to recorded motion at {}s requires a position/heading/speed continuity proof; snapping to source timing is unsupported", actor.id, interval.start_s),
                ));
            }
            if let (AuthorityKind::Recorded, RouteSpec::TimedPolyline { points }) =
                (kind, &actor.behavior.route)
            {
                if points.len() > 1
                    && (points[0].time_s > interval.start_s
                        || points[points.len() - 1].time_s < interval.end_s)
                {
                    return Err(CompileError::new(
                        "authority_recording_coverage",
                        format!(
                            "role {}: source timing does not cover [{}, {})",
                            actor.id, interval.start_s, interval.end_s
                        ),
                    ));
                }
            }
            let action_hook_available =
                dynamic && kind != AuthorityKind::Recorded && !actor.is_static;
            if kind == AuthorityKind::Policy && !action_hook_available {
                return Err(CompileError::new(
                    "authority_unavailable",
                    format!(
                        "role {} cannot be driven by the policy action hook",
                        actor.id
                    ),
                ));
            }
            let mut handover_interaction_id = None;
            if previous.is_some_and(|p| p.kind == AuthorityKind::Recorded)
                && kind != AuthorityKind::Recorded
            {
                let RouteSpec::TimedPolyline { points } = &actor.behavior.route else {
                    return Err(CompileError::new(
                        "authority_handover_unsupported",
                        format!(
                            "role {}: recorded release requires a non-static dynamic-v1 actor",
                            actor.id
                        ),
                    ));
                };
                if !action_hook_available {
                    return Err(CompileError::new(
                        "authority_handover_unsupported",
                        format!(
                            "role {}: recorded release requires a non-static dynamic-v1 actor",
                            actor.id
                        ),
                    ));
                }
                let id = format!("situation-authority-{}-{interval_index}", actor.id);
                if execution.input.interactions.iter().any(|i| i.id == id) {
                    return Err(CompileError::new(
                        "authority_interaction_conflict",
                        format!("reserved handover id {id} is already authored"),
                    ));
                }
                // The canonical route interaction clears the timed route without
                // changing the live pose or speed: the preceding recorded tick
                // already synchronised the dynamic backend, so keeping the
                // source's spatial path only removes its timing constraint.
                handovers.push(sim::Interaction {
                    id: id.clone(),
                    actor_id: actor.id.clone(),
                    trigger: sim::Trigger::At {
                        t: interval.start_s,
                    },
                    window: None,
                    until: None,
                    verb: sim::Verb::Route {
                        target: sim::RouteActionTarget::Spec(RouteSpec::Polyline {
                            points: points
                                .iter()
                                .map(|p| sim::ScenePoint { x: p.x, z: p.z })
                                .collect(),
                        }),
                        join_from_current_pose: None,
                        best_effort_world_path: None,
                    },
                });
                handover_interaction_id = Some(id);
            }
            authority.push(AuthorityRow {
                role_id: actor.id.clone(),
                kind,
                start_s: interval.start_s,
                end_s: interval.end_s,
                interval_index,
                handover_interaction_id,
                route_kind: if timed && kind != AuthorityKind::Recorded {
                    "polyline"
                } else {
                    route_kind_name(&actor.behavior.route)
                },
                action_hook_available,
            });
        }
        if covered_until != clip {
            return Err(CompileError::new(
                "authority_gap",
                format!("role {} authority must cover exactly [0, {clip})", actor.id),
            ));
        }
        let has_route_interaction = |only_timed: bool| {
            execution.input.interactions.iter().any(|i| {
                i.actor_id == actor.id
                    && match &i.verb {
                        sim::Verb::Route { target, .. } => {
                            !only_timed
                                || matches!(
                                    target,
                                    sim::RouteActionTarget::Spec(RouteSpec::TimedPolyline { .. })
                                )
                        }
                        _ => false,
                    }
            })
        };
        if intervals.iter().any(|i| i.kind == AuthorityKind::Recorded)
            && has_route_interaction(false)
        {
            return Err(CompileError::new(
                "authority_interaction_conflict",
                format!(
                    "role {}: authored route changes can override recorded authority",
                    actor.id
                ),
            ));
        }
        if has_route_interaction(true) {
            return Err(CompileError::new("authority_interaction_conflict", format!("role {}: timed route interactions require a separately continuity-checked recorded authority transfer", actor.id)));
        }
    }
    if !handovers.is_empty() {
        execution.input.interactions.extend(handovers);
        execution.input = revalidate(&execution.input.clone().normalized())?;
        execution.manifest.input_hash = content_hash_of(&execution.input)?;
    }
    Ok(BoundSituation {
        program_digest: situation_digest(program)?,
        execution,
        authority,
        visual_only_patches: program
            .geometry_patches
            .iter()
            .filter(|p| p.status == PatchStatus::VisualOnly)
            .map(|p| p.id.clone())
            .collect(),
    })
}

/* ---------------------------------------------------------------- rehearse */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTransition {
    pub time_s: f64,
    pub value: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SituationEventWitness {
    pub id: String,
    pub first_true_s: Option<f64>,
    pub last_true_s: Option<f64>,
    pub true_ticks: u32,
    pub sampled_ticks: u32,
    pub window_s: (f64, f64),
    pub transitions: Vec<EventTransition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintReason {
    Satisfied,
    EventMissing,
    OffsetOutsideBounds,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SituationConstraintWitness {
    pub id: String,
    pub satisfied: bool,
    pub residual_s: Option<f64>,
    pub reason: ConstraintReason,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityIntervalWitness {
    pub role_id: String,
    pub interval_index: usize,
    pub start_s: f64,
    pub end_s: f64,
    pub hook_calls: u32,
    pub action_calls: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionState {
    pub x: f64,
    pub y: f64,
    pub heading_rad: f64,
    pub speed_mps: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityTransition {
    pub role_id: String,
    pub time_s: f64,
    pub from: AuthorityKind,
    pub to: AuthorityKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handover_interaction_id: Option<String>,
    pub state: TransitionState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SituationRehearsal {
    pub bound: BoundSituation,
    pub simulation: SimResult,
    pub events: Vec<SituationEventWitness>,
    pub constraints: Vec<SituationConstraintWitness>,
    pub satisfied: bool,
    pub action_calls: BTreeMap<String, u32>,
    pub authority_intervals: Vec<AuthorityIntervalWitness>,
    pub authority_transitions: Vec<AuthorityTransition>,
}

/// What a policy sees when asked for an action: the actor's engine-frame
/// state at the tick boundary the action will be integrated from.
pub struct PolicyContext<'a> {
    pub t_s: f64,
    pub dt_s: f64,
    pub actor_id: &'a str,
    pub actor: &'a ActorSnapshot,
}

/// A declared policy must supply actual actions; `None` at a policy tick is a
/// rehearsal failure, never a silent fallback to the controller.
pub type PolicyHook<'a> = dyn FnMut(&PolicyContext<'_>) -> Option<ActionOverride> + 'a;

pub struct SituationRehearsalOptions<'a> {
    pub compile: SituationCompileOptions,
    /// Engine options; `graph` and `static_colliders` are taken from the
    /// bundle when absent.
    pub runtime: Option<RunOptions>,
    pub policy: Option<&'a mut PolicyHook<'a>>,
}

fn action_is_empty(action: &ActionOverride) -> bool {
    action.control.is_none()
        && action.motion_direction.is_none()
        && action.target_speed_mps.is_none()
        && action.target_acceleration_mps2.is_none()
        && action.preview_point.is_none()
        && action.preview_heading_rad.is_none()
}

fn run_options(bundle: &MapBundle, runtime: Option<&RunOptions>) -> RunOptions {
    match runtime {
        Some(r) => r.clone(),
        None => {
            let mut options = RunOptions::new(bundle.graph().clone());
            options.static_colliders = bundle.static_colliders().to_vec();
            options
        }
    }
}

/// Predicate samples use the engine's own geometry/perception at the exact
/// trace timestamp.
pub fn rehearse_situation(
    program: &SituationProgram,
    bundle: &MapBundle,
    options: &mut SituationRehearsalOptions<'_>,
) -> CompileResult<SituationRehearsal> {
    let bound = compile_situation(program, bundle, &options.compile)?;
    let policy_roles: BTreeSet<&str> = bound
        .authority
        .iter()
        .filter(|r| r.kind == AuthorityKind::Policy)
        .map(|r| r.role_id.as_str())
        .collect();
    if !policy_roles.is_empty() && options.policy.is_none() {
        return Err(CompileError::new(
            "policy_missing",
            "a declared policy must supply actual actions",
        ));
    }
    let input = bound.execution.input.clone();
    let dt = input.dt;
    let mut sim = Simulation::new(input, run_options(bundle, options.runtime.as_ref()))
        .map_err(engine_err)?;
    let warmup_ticks = sim.warmup_ticks() as f64;
    let conditions: Vec<sim::Condition> = bound
        .execution
        .observations
        .iter()
        .map(|o| o.condition.clone())
        .collect();
    let resolved = sim.resolve_conditions(&conditions);

    let mut action_calls: BTreeMap<String, u32> = BTreeMap::new();
    let mut authority_intervals: Vec<AuthorityIntervalWitness> = bound
        .authority
        .iter()
        .map(|r| AuthorityIntervalWitness {
            role_id: r.role_id.clone(),
            interval_index: r.interval_index,
            start_s: r.start_s,
            end_s: r.end_s,
            hook_calls: 0,
            action_calls: 0,
        })
        .collect();
    let mut authority_transitions: Vec<AuthorityTransition> = Vec::new();
    struct Row {
        first_true_s: Option<f64>,
        last_true_s: Option<f64>,
        true_ticks: u32,
        sampled_ticks: u32,
        transitions: Vec<EventTransition>,
        previous: Option<bool>,
    }
    let mut rows: Vec<Row> = program
        .events
        .iter()
        .map(|_| Row {
            first_true_s: None,
            last_true_s: None,
            true_ticks: 0,
            sampled_ticks: 0,
            transitions: Vec::new(),
            previous: None,
        })
        .collect();
    let policy_rows: Vec<(usize, simforge_core::engine::ActorIndex, i64, i64)> = bound
        .authority
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == AuthorityKind::Policy)
        .map(|(i, r)| {
            let index = sim.actor_index(&r.role_id).ok_or_else(|| {
                CompileError::new(
                    "authority_missing",
                    format!("policy role {} is not in the simulation", r.role_id),
                )
            })?;
            Ok((
                i,
                index,
                (r.start_s / dt).round() as i64,
                (r.end_s / dt).round() as i64,
            ))
        })
        .collect::<CompileResult<_>>()?;
    let mut values: Vec<bool> = Vec::with_capacity(resolved.len());
    let mut actions: Vec<ActorAction> = Vec::new();

    loop {
        // State at this boundary is exactly what the trace records at `t`;
        // integration for the tick happens inside `advance`.
        let t = (sim.tick_index() as f64 - warmup_ticks) * dt;
        let tick = (t / dt).round() as i64;
        if t >= 0.0 {
            for row in &bound.authority {
                if row.interval_index == 0 || (t - row.start_s).abs() > 1e-9 {
                    continue;
                }
                let previous = bound
                    .authority
                    .iter()
                    .find(|p| {
                        p.role_id == row.role_id && p.interval_index == row.interval_index - 1
                    })
                    .expect("intervals are contiguous");
                let index = sim
                    .actor_index(&row.role_id)
                    .expect("authority rows name simulated actors");
                let actor = sim.actor_snapshot(index);
                authority_transitions.push(AuthorityTransition {
                    role_id: row.role_id.clone(),
                    time_s: t,
                    from: previous.kind,
                    to: row.kind,
                    handover_interaction_id: row.handover_interaction_id.clone(),
                    state: TransitionState {
                        x: actor.x,
                        y: actor.y,
                        heading_rad: actor.heading_rad,
                        speed_mps: actor.speed_mps,
                    },
                });
            }
            sim.evaluate_resolved_conditions(&resolved, &mut values);
            for (index, row) in rows.iter_mut().enumerate() {
                let event = &program.events[index];
                if t < event.window_s.0 - event.tolerance_s
                    || t > event.window_s.1 + event.tolerance_s
                {
                    continue;
                }
                let value = values[index];
                row.sampled_ticks += 1;
                if row.previous != Some(value) {
                    row.transitions.push(EventTransition { time_s: t, value });
                }
                row.previous = Some(value);
                if value {
                    row.true_ticks += 1;
                    row.first_true_s.get_or_insert(t);
                    row.last_true_s = Some(t);
                }
            }
        }
        if sim.done() {
            break;
        }
        actions.clear();
        if let Some(policy) = options.policy.as_deref_mut() {
            for &(row_index, actor_index, start_tick, end_tick) in &policy_rows {
                if tick < start_tick || tick >= end_tick {
                    continue;
                }
                authority_intervals[row_index].hook_calls += 1;
                let actor = sim.actor_snapshot(actor_index);
                let role_id = bound.authority[row_index].role_id.as_str();
                let action = policy(&PolicyContext {
                    t_s: t,
                    dt_s: dt,
                    actor_id: role_id,
                    actor: &actor,
                });
                let Some(action) = action.filter(|a| !action_is_empty(a)) else {
                    return Err(CompileError::new(
                        "policy_action_missing",
                        format!("policy for {role_id} supplied no action at {t}s"),
                    ));
                };
                authority_intervals[row_index].action_calls += 1;
                *action_calls.entry(role_id.to_owned()).or_insert(0) += 1;
                actions.push(ActorAction {
                    actor: actor_index,
                    action,
                });
            }
        }
        sim.advance(1, &actions).map_err(engine_err)?;
    }

    for (index, row) in bound.authority.iter().enumerate() {
        if row.kind == AuthorityKind::Policy && authority_intervals[index].action_calls == 0 {
            return Err(CompileError::new("policy_not_exercised", format!("no policy actions reached {} in [{}, {}); do not repair its speed to compensate", row.role_id, row.start_s, row.end_s)));
        }
    }
    let result = sim.into_result().map_err(engine_err)?;
    if result.trace.header.input_hash != bound.execution.manifest.input_hash {
        return Err(CompileError::new(
            "authority_input_identity_changed",
            "runtime execution does not match the exact bound input",
        ));
    }
    for row in &bound.authority {
        let Some(handover) = &row.handover_interaction_id else {
            continue;
        };
        let executed = result.trace.events.iter().any(|e| matches!(e, SimEvent::TriggerFired { t, interaction_id, .. } if interaction_id == handover && (t - row.start_s).abs() <= 1e-9));
        if !executed {
            return Err(CompileError::new(
                "authority_handover_not_executed",
                format!(
                    "role {}: recorded release did not execute at {}s",
                    row.role_id, row.start_s
                ),
            ));
        }
    }
    let events: Vec<SituationEventWitness> = rows
        .into_iter()
        .zip(&program.events)
        .map(|(row, event)| SituationEventWitness {
            id: event.id.clone(),
            first_true_s: row.first_true_s,
            last_true_s: row.last_true_s,
            true_ticks: row.true_ticks,
            sampled_ticks: row.sampled_ticks,
            window_s: event.window_s,
            transitions: row.transitions,
        })
        .collect();
    let first_true = |id: &str| {
        events
            .iter()
            .find(|e| e.id == id)
            .and_then(|e| e.first_true_s)
    };
    let constraints: Vec<SituationConstraintWitness> = program
        .constraints
        .iter()
        .map(|constraint| match constraint {
            SituationConstraint::EventOccurs { id, event_id } => {
                let present = first_true(event_id).is_some();
                SituationConstraintWitness {
                    id: id.clone(),
                    satisfied: present,
                    residual_s: present.then_some(0.0),
                    reason: if present {
                        ConstraintReason::Satisfied
                    } else {
                        ConstraintReason::EventMissing
                    },
                }
            }
            SituationConstraint::EventOffset {
                id,
                before,
                after,
                min_s,
                max_s,
            } => match (first_true(before), first_true(after)) {
                (Some(before), Some(after)) => {
                    let offset = after - before;
                    let residual = if offset < *min_s {
                        offset - min_s
                    } else if offset > *max_s {
                        offset - max_s
                    } else {
                        0.0
                    };
                    SituationConstraintWitness {
                        id: id.clone(),
                        satisfied: residual == 0.0,
                        residual_s: Some(residual),
                        reason: if residual == 0.0 {
                            ConstraintReason::Satisfied
                        } else {
                            ConstraintReason::OffsetOutsideBounds
                        },
                    }
                }
                _ => SituationConstraintWitness {
                    id: id.clone(),
                    satisfied: false,
                    residual_s: None,
                    reason: ConstraintReason::EventMissing,
                },
            },
        })
        .collect();
    let satisfied = !constraints.is_empty() && constraints.iter().all(|c| c.satisfied);
    Ok(SituationRehearsal {
        bound,
        simulation: result,
        events,
        constraints,
        satisfied,
        action_calls,
        authority_intervals,
        authority_transitions,
    })
}

/* ------------------------------------------------------------------- solve */

fn knob_unresolved(knob_id: &str) -> CompileError {
    CompileError::new(
        "knob_unresolved",
        format!("knob {knob_id} needs a concrete numeric value in its declared coordinate frame"),
    )
}

fn knob_value(program: &SituationProgram, knob: &SituationKnob) -> CompileResult<f64> {
    match knob {
        SituationKnob::InteractionTime {
            id, interaction_id, ..
        } => {
            let interaction = program
                .template
                .interaction(interaction_id)
                .ok_or_else(|| knob_unresolved(id))?;
            match &interaction.base.trigger {
                Trigger::At {
                    t: NumberOrExpr::Number(t),
                } => Ok(*t),
                _ => Err(knob_unresolved(id)),
            }
        }
        SituationKnob::RoleSpeed { id, role_id, .. } => {
            let role = program
                .template
                .role(role_id)
                .ok_or_else(|| knob_unresolved(id))?;
            match role.base.initial_speed_kph {
                Some(NumberOrExpr::Number(kph)) => Ok(kph * KPH_TO_MPS),
                _ => Err(knob_unresolved(id)),
            }
        }
        SituationKnob::RolePosition {
            id, role_id, axis, ..
        } => {
            let role = program
                .template
                .role(role_id)
                .ok_or_else(|| knob_unresolved(id))?;
            match (&role.kind, axis) {
                (RoleKind::SceneAbsolute { pose, .. }, PositionAxis::X) => Ok(pose.position.x),
                (RoleKind::SceneAbsolute { pose, .. }, PositionAxis::Z) => Ok(pose.position.z),
                (_, PositionAxis::S) => match role.pose().map(|p| p.s) {
                    Some(NumberOrExpr::Number(s)) => Ok(s),
                    _ => Err(knob_unresolved(id)),
                },
                _ => Err(knob_unresolved(id)),
            }
        }
    }
}

fn knob_operations(program: &SituationProgram, values: &[f64]) -> CompileResult<Vec<TemplateOp>> {
    let mut roles: BTreeMap<String, Value> = BTreeMap::new();
    let mut interactions: BTreeMap<String, Value> = BTreeMap::new();
    for (knob, &value) in program.knobs.iter().zip(values) {
        let (min, max) = knob.bounds();
        if !value.is_finite() || value < min || value > max {
            return Err(CompileError::new(
                "knob_out_of_bounds",
                format!("knob {} exceeded its declared bounds", knob.id()),
            ));
        }
        match knob {
            SituationKnob::InteractionTime { interaction_id, .. } => {
                let original = program
                    .template
                    .interaction(interaction_id)
                    .ok_or_else(|| knob_unresolved(knob.id()))?;
                if !matches!(original.base.trigger, Trigger::At { .. }) {
                    return Err(CompileError::new(
                        "knob_unresolved",
                        format!(
                            "interaction {} is not an absolute time knob",
                            original.base.id
                        ),
                    ));
                }
                let mut doc = serde_json::to_value(original)?;
                doc["trigger"]["t"] = Value::from(value);
                interactions.insert(interaction_id.clone(), doc);
            }
            SituationKnob::RoleSpeed { role_id, .. } => {
                let doc = match roles.remove(role_id) {
                    Some(doc) => doc,
                    None => serde_json::to_value(
                        program
                            .template
                            .role(role_id)
                            .ok_or_else(|| knob_unresolved(knob.id()))?,
                    )?,
                };
                let mut doc = doc;
                doc["initialSpeedKph"] = Value::from(value / KPH_TO_MPS);
                roles.insert(role_id.clone(), doc);
            }
            SituationKnob::RolePosition { role_id, axis, .. } => {
                let role = program
                    .template
                    .role(role_id)
                    .ok_or_else(|| knob_unresolved(knob.id()))?;
                let mut doc = match roles.remove(role_id) {
                    Some(doc) => doc,
                    None => serde_json::to_value(role)?,
                };
                match (&role.kind, axis) {
                    (RoleKind::SceneAbsolute { .. }, PositionAxis::X | PositionAxis::Z) => {
                        doc["pose"]["position"][axis_name(*axis)] = Value::from(value);
                    }
                    (_, PositionAxis::S) if role.pose().is_some() => {
                        doc["pose"]["s"] = Value::from(value);
                    }
                    _ => {
                        return Err(CompileError::new(
                            "knob_unresolved",
                            format!("role {} does not expose frame station s", role.base.id),
                        ))
                    }
                }
                roles.insert(role_id.clone(), doc);
            }
        }
    }
    let mut ops: Vec<TemplateOp> = roles
        .into_iter()
        .map(|(id, role)| TemplateOp::ReplaceRole { id, role })
        .collect();
    ops.extend(
        interactions
            .into_iter()
            .map(|(id, interaction)| TemplateOp::ReplaceInteraction { id, interaction }),
    );
    Ok(ops)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SolveStatus {
    Satisfied,
    BudgetExhausted,
    ResolutionReached,
    NoKnobs,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveAttempt {
    pub values: Vec<f64>,
    pub input_hash: Option<String>,
    pub score: Option<f64>,
    pub error: Option<String>,
}

pub struct SituationSolveOptions<'a> {
    pub rehearsal: SituationRehearsalOptions<'a>,
    /// Integer in `[1, 256]`.
    pub max_evaluations: usize,
    /// Fraction of each knob's range at which the coordinate search stops; `(0, 1]`.
    pub relative_resolution: Option<f64>,
    /// Persist exact successful executions without retaining every trace in
    /// memory. Callback failures abort solving rather than becoming scenario
    /// failures.
    pub on_evaluation:
        Option<&'a mut dyn FnMut(&SituationProgram, &SituationRehearsal) -> CompileResult<()>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SituationSolveResult {
    pub status: SolveStatus,
    pub program: SituationProgram,
    pub transaction: Option<SituationTransaction>,
    pub rehearsal: SituationRehearsal,
    pub attempts: Vec<SolveAttempt>,
}

/// Bounded deterministic coordinate search. Every candidate is actually
/// simulated; a failed budget is not a proof that the requested situation is
/// impossible.
pub fn solve_situation(
    program: &SituationProgram,
    bundle: &MapBundle,
    options: &mut SituationSolveOptions<'_>,
) -> CompileResult<SituationSolveResult> {
    if options.max_evaluations < 1 || options.max_evaluations > 256 {
        return Err(CompileError::new(
            "solver_budget_invalid",
            "maxEvaluations must be an integer in [1,256]",
        ));
    }
    if program.constraints.is_empty() {
        return Err(CompileError::new(
            "constraints_required",
            "declare observable constraints before solving",
        ));
    }
    let resolution = options.relative_resolution.unwrap_or(1.0 / 128.0);
    if !(resolution > 0.0 && resolution <= 1.0) {
        return Err(CompileError::new(
            "solver_resolution_invalid",
            "relativeResolution must be in (0,1]",
        ));
    }
    let clip = program.template.choreography.clip_seconds;
    let loss = |rehearsal: &SituationRehearsal| {
        rehearsal
            .constraints
            .iter()
            .map(|c| c.residual_s.map_or(clip + 1.0, f64::abs))
            .sum::<f64>()
    };

    let mut best = rehearse_situation(program, bundle, &mut options.rehearsal)?;
    if let Some(cb) = options.on_evaluation.as_deref_mut() {
        cb(program, &best)?;
    }
    let mut best_program = program.clone();
    let mut transaction: Option<SituationTransaction> = None;
    let mut values: Vec<f64> = program
        .knobs
        .iter()
        .map(|k| knob_value(program, k))
        .collect::<CompileResult<_>>()?;
    let mut score = loss(&best);
    let mut attempts = vec![SolveAttempt {
        values: values.clone(),
        input_hash: Some(best.simulation.trace.header.input_hash.clone()),
        score: Some(score),
        error: None,
    }];
    let mut seen: BTreeSet<String> = BTreeSet::new();
    seen.insert(canonical_json_of(&values)?);
    let base_digest = situation_digest(program)?;

    let mut fraction = 0.5;
    'search: while fraction >= resolution
        && !best.satisfied
        && attempts.len() < options.max_evaluations
    {
        for index in 0..program.knobs.len() {
            if best.satisfied {
                break 'search;
            }
            let (min, max) = program.knobs[index].bounds();
            let origin = values[index];
            for next in [
                origin - (max - min) * fraction,
                origin + (max - min) * fraction,
                min,
                max,
            ] {
                if attempts.len() >= options.max_evaluations || best.satisfied {
                    break 'search;
                }
                let mut candidate = values.clone();
                candidate[index] = next.clamp(min, max);
                let key = canonical_json_of(&candidate)?;
                if !seen.insert(key) {
                    continue;
                }
                let tx = SituationTransaction {
                    base_revision: program.revision,
                    base_digest: base_digest.clone(),
                    label: "Solve declared event constraints".to_owned(),
                    template_ops: match knob_operations(program, &candidate) {
                        Ok(ops) => ops,
                        Err(e) => {
                            attempts.push(SolveAttempt {
                                values: candidate,
                                input_hash: None,
                                score: None,
                                error: Some(e.to_string()),
                            });
                            continue;
                        }
                    },
                    changes: None,
                    preserve: None,
                };
                let evaluation = apply_situation_transaction(program, &tx).and_then(|applied| {
                    let rehearsal =
                        rehearse_situation(&applied.program, bundle, &mut options.rehearsal)?;
                    Ok((applied.program, rehearsal))
                });
                match evaluation {
                    Ok((changed, rehearsal)) => {
                        let candidate_score = loss(&rehearsal);
                        attempts.push(SolveAttempt {
                            values: candidate.clone(),
                            input_hash: Some(rehearsal.simulation.trace.header.input_hash.clone()),
                            score: Some(candidate_score),
                            error: None,
                        });
                        if let Some(cb) = options.on_evaluation.as_deref_mut() {
                            cb(&changed, &rehearsal)?;
                        }
                        if candidate_score < score || rehearsal.satisfied {
                            best = rehearsal;
                            best_program = changed;
                            transaction = Some(tx);
                            values = candidate;
                            score = candidate_score;
                        }
                    }
                    Err(e) => attempts.push(SolveAttempt {
                        values: candidate,
                        input_hash: None,
                        score: None,
                        error: Some(e.to_string()),
                    }),
                }
            }
        }
        fraction /= 2.0;
    }
    let status = if best.satisfied {
        SolveStatus::Satisfied
    } else if program.knobs.is_empty() {
        SolveStatus::NoKnobs
    } else if attempts.len() >= options.max_evaluations {
        SolveStatus::BudgetExhausted
    } else {
        SolveStatus::ResolutionReached
    };
    Ok(SituationSolveResult {
        status,
        program: best_program,
        transaction,
        rehearsal: best,
        attempts,
    })
}

/* ----------------------------------------------------------------- compare */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDelta {
    pub id: String,
    pub delta_s: Option<f64>,
    pub base_occurs: bool,
    pub intervention_occurs: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SituationComparison {
    pub base: SituationRehearsal,
    pub intervention: SituationRehearsal,
    pub changed_roles: Vec<String>,
    pub changed_tracks: Vec<String>,
    pub invariant_failures: Vec<String>,
    pub event_deltas: Vec<EventDelta>,
}

/// Compare a declared intervention under identical seed, sensor recipe and
/// timing. Reactive consequences must be named: unchanged actor inputs alone
/// are not proof that their resulting trajectories stayed fixed.
pub fn compare_situation(
    program: &SituationProgram,
    transaction: &SituationTransaction,
    bundle: &MapBundle,
    options: &mut SituationRehearsalOptions<'_>,
    reactive_role_ids: &[String],
) -> CompileResult<SituationComparison> {
    let changed = apply_situation_transaction(program, transaction)?.program;
    let base = rehearse_situation(program, bundle, options)?;
    let intervention = rehearse_situation(&changed, bundle, options)?;
    let before = &base.simulation.input;
    let after = &intervention.simulation.input;
    let mut invariant_failures: Vec<String> = Vec::new();
    if before.map_id != after.map_id {
        invariant_failures.push("input.mapId".to_owned());
    }
    if before.seed != after.seed {
        invariant_failures.push("input.seed".to_owned());
    }
    if before.dt != after.dt {
        invariant_failures.push("input.dt".to_owned());
    }
    if before.warmup_seconds != after.warmup_seconds {
        invariant_failures.push("input.warmupSeconds".to_owned());
    }
    if before.clip_seconds != after.clip_seconds {
        invariant_failures.push("input.clipSeconds".to_owned());
    }
    if before.physics != after.physics {
        invariant_failures.push("input.physics".to_owned());
    }
    if before.perception != after.perception {
        invariant_failures.push("input.perception".to_owned());
    }
    let old_actors: BTreeMap<&str, &sim::SimActor> =
        before.actors.iter().map(|a| (a.id.as_str(), a)).collect();
    let new_actors: BTreeMap<&str, &sim::SimActor> =
        after.actors.iter().map(|a| (a.id.as_str(), a)).collect();
    fn commands_by_actor(
        interactions: &[sim::Interaction],
    ) -> BTreeMap<&str, Vec<&sim::Interaction>> {
        let mut out: BTreeMap<&str, Vec<&sim::Interaction>> = BTreeMap::new();
        for interaction in interactions {
            out.entry(interaction.actor_id.as_str())
                .or_default()
                .push(interaction);
        }
        out
    }
    let old_commands = commands_by_actor(&before.interactions);
    let new_commands = commands_by_actor(&after.interactions);
    let role_ids: BTreeSet<&str> = old_actors
        .keys()
        .chain(new_actors.keys())
        .copied()
        .collect();
    let changed_roles: Vec<String> = role_ids
        .iter()
        .filter(|id| {
            old_actors.get(*id) != new_actors.get(*id)
                || old_commands.get(*id) != new_commands.get(*id)
        })
        .map(|id| (*id).to_owned())
        .collect();
    for id in reactive_role_ids {
        if !role_ids.contains(id.as_str()) {
            return Err(CompileError::new(
                "reactive_role_unknown",
                format!("unknown reactive role {id}"),
            ));
        }
    }
    let changed_tracks: Vec<String> = role_ids
        .iter()
        .filter(|id| {
            base.simulation.trace.ticks.actors.get(**id)
                != intervention.simulation.trace.ticks.actors.get(**id)
        })
        .map(|id| (*id).to_owned())
        .collect();
    let allowed: BTreeSet<&str> = changed_roles
        .iter()
        .map(String::as_str)
        .chain(reactive_role_ids.iter().map(String::as_str))
        .collect();
    for id in &changed_tracks {
        if !allowed.contains(id.as_str()) {
            invariant_failures.push(format!("trajectory.{id}"));
        }
    }
    let mut event_deltas = Vec::with_capacity(base.events.len());
    for event in &base.events {
        let other = intervention.events.iter().find(|e| e.id == event.id);
        let declared_same = program.events.iter().find(|e| e.id == event.id)
            == changed.events.iter().find(|e| e.id == event.id);
        if other.is_none() || !declared_same {
            invariant_failures.push(format!("event.{}", event.id));
        }
        let next = other.and_then(|o| o.first_true_s);
        event_deltas.push(EventDelta {
            id: event.id.clone(),
            delta_s: match (event.first_true_s, next) {
                (Some(a), Some(b)) => Some(b - a),
                _ => None,
            },
            base_occurs: event.first_true_s.is_some(),
            intervention_occurs: next.is_some(),
        });
    }
    Ok(SituationComparison {
        base,
        intervention,
        changed_roles,
        changed_tracks,
        invariant_failures,
        event_deltas,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_bound_geometry_transactions_keep_authored_identity() {
        let source: Value = serde_json::from_str(include_str!(
            "../../../../qualification/native-migration/fixtures/generated-geometry/program.json"
        ))
        .unwrap();
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../../../../qualification/native-migration/fixtures/generated-geometry/fixture.json"
        ))
        .unwrap();
        let program = parse_situation(&source).unwrap();
        let transaction: SituationTransaction =
            serde_json::from_value(fixture["transactions"][0]["apply"].take()).unwrap();
        let changed = apply_situation_transaction(&program, &transaction).unwrap();
        assert_eq!(
            changed.digest,
            fixture["comparison"]["transaction"]["baseDigest"].as_str().unwrap()
        );
        let mut binding_value: Value = serde_json::from_str(include_str!(
            "../../../../qualification/native-migration/fixtures/generated-geometry/geometry-binding.json"
        ))
        .unwrap();
        binding_value.as_object_mut().unwrap().remove("descriptorReference");
        let mut binding: VerifiedStaticGeometryBinding = serde_json::from_value(binding_value).unwrap();
        static_geometry_entries(&changed.program, std::slice::from_ref(&binding)).unwrap();
        binding.descriptor.source_artifacts[0].sha256 = "0".repeat(64);
        assert_eq!(
            static_geometry_entries(&changed.program, std::slice::from_ref(&binding))
                .unwrap_err().code,
            "geometry_patch_unbound"
        );
        let intervention: SituationTransaction =
            serde_json::from_value(fixture["comparison"]["transaction"].take()).unwrap();
        apply_situation_transaction(&changed.program, &intervention).unwrap();
    }
}
