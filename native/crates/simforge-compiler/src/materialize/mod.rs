//! The materializer: `template × site × draw -> SimScenarioInput`.
//!
//! This is the one place in the stack that joins the authored vocabulary
//! (roles, frame poses, expressions, portable triggers) with the engine's
//! (actors, scene poses, lane chains, solved arrivals). Every layer below it is
//! deliberately incomplete on its own; every layer above it refuses anything
//! less than a fully resolved concrete document.
//!
//! The pipeline:
//! 1. PARAMS   per-cell seed = `sha256(templateId|paramsVersion|siteId|drawIndex)`,
//!             one forked xoshiro128** stream per declaration.
//! 2. FRAME    the site's `AnchorFrame` reference path is rebuilt as an engine
//!             route, which turns frame `s` into a world point.
//! 3. ROLES    each `FeatureBinding` becomes a concrete actor: route from the
//!             binding's lane chain, spawn by projecting the frame point onto
//!             that route, speeds and offsets from expressions in the role's
//!             own lane scope.
//! 4. TIMELINE v2 interactions become engine interactions, verb by verb.
//! 5. ARRIVAL  `arriveAtConflict` roles are solved by the engine's arrival
//!             back-solver against the matcher's conflict point.
//! 6. GUARDS   `check_feasibility` — runway, decel budget, spawn overlap, route
//!             connectivity — reported as structured findings.
//! 7. AMBIENT  generated background traffic, deliberately last so it can never
//!             alter the authored verdict.

mod builder;
pub mod routes;

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};
use simforge_core::error::SimIssue;
use simforge_core::map::{build_follow_route, FollowRouteOptions};
use simforge_core::solve::ArrivalSolution;
use simforge_core::types::{
    ActorKind, Condition as SimCondition, ConditionEffects, OperationalConditions, RoadControl,
    SimScenarioInput, StaticProp, TimeOfDay as SimTimeOfDay, TrafficLevel, VisibilityClass,
    Weather as SimWeather,
};

use crate::ambient::{AmbientSettleProvenance, AmbientTrafficProfile, AmbientTrafficProvenance};
use crate::anchor::{
    AnchorFrame, BindingStatus, DegradationReport, FeatureBinding, FrameOrigin, MatchedSite,
    OriginKind, ReferenceSpan, Verdict, MATCH_SEMANTICS_VERSION,
};
use crate::bundle::MapBundle;
use crate::catalog::ActorCatalog;
use crate::error::{CompileError, CompileResult};
use crate::expr::{ExprScope, NumberOrExpr};
use crate::map_index::Handedness;
use crate::map_signals::SiteSignalPlan;
use crate::params::resolve_params;
use crate::template::{
    ActorClass, Condition, Environment, FeatureKind, MovementControl, RoleKind, ScenarioTemplate,
    TimeOfDay, Verb, Weather,
};

pub const KPH_TO_MPS: f64 = 1.0 / 3.6;
pub const STUDIO_BODY_COLOR_TAG_PREFIX: &str = "studio:body-color:";
/// Fixed integration step of every materialised instance.
pub const INSTANCE_DT_S: f64 = 0.02;

/* -------------------------------------------------------------------- notes */

/// A materialization note. Informational notes describe a semantics-preserving
/// lowering decision; every other note records semantic loss and is a reason
/// to refuse editable playback.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub path: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<NoteImpact>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteImpact {
    Informational,
}

impl Note {
    pub fn loss(path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            reason: reason.into(),
            impact: None,
        }
    }

    pub fn info(path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            reason: reason.into(),
            impact: Some(NoteImpact::Informational),
        }
    }

    pub fn is_semantic_loss(&self) -> bool {
        self.impact.is_none()
    }
}

pub type Notes = Vec<Note>;

/// Notes which mean the authored document could not be represented exactly.
pub fn semantic_losses(notes: &[Note]) -> impl Iterator<Item = &Note> {
    notes.iter().filter(|n| n.is_semantic_loss())
}

/* ------------------------------------------------------------------ options */

/// Operational conditions reserved by a catalog slot, in the catalog's
/// deliberately human-readable vocabulary.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVariantApplication {
    pub id: String,
    pub title: String,
    pub weather: String,
    pub time_of_day: String,
    pub traffic: String,
    pub visibility: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedCatalogVariant {
    #[serde(flatten)]
    pub variant: CatalogVariantApplication,
    pub concrete: OperationalConditions,
}

/// A diagnostic predicate lowered in the same map/parameter scope as the
/// actors. It never becomes an interaction and cannot change the input.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub id: String,
    pub condition: Condition,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoweredObservation {
    pub id: String,
    pub condition: SimCondition,
}

#[derive(Debug, Clone, Default)]
pub struct MaterializeOptions {
    pub observations: Vec<Observation>,
    /// `-1` outside a batch.
    pub draw_index: i64,
    /// Overrides the derived per-cell seed.
    pub seed: Option<String>,
    /// Applied to the concrete engine input, not an evidence-only stamp.
    pub variant: Option<CatalogVariantApplication>,
    /// Generated background road users. Absent or `off` adds nothing to the
    /// input or the manifest. Ambient actors are appended AFTER the authored
    /// feasibility verdict and BEFORE `input_hash` is taken.
    pub ambient: Option<AmbientTrafficProfile>,
    /// Seconds of ambient-only integration before `t = 0`; `0` disables.
    pub ambient_settle_seconds: f64,
    /// Built-in catalog plus validated user imports.
    pub catalog: ActorCatalog,
}

impl MaterializeOptions {
    pub fn new() -> Self {
        Self {
            draw_index: -1,
            ..Default::default()
        }
    }
}

/* ----------------------------------------------------------------- manifest */

/// The full replay key: everything an instance needs to be re-derived exactly.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayKey {
    pub template_id: String,
    pub template_version: u32,
    /// Content hash of the whole authored template.
    pub template_digest: String,
    pub map_id: String,
    /// Matcher/map-intel digest used to derive the site id.
    pub matcher_index_digest: String,
    /// Engine lane-graph digest written into traces.
    pub engine_graph_digest: String,
    pub site_id: String,
    pub matcher_version: String,
    pub solver_version: String,
    pub param_seed: String,
    pub draw_index: i64,
    /// Hash of the resolved ambient profile (plus settle length), or `none`:
    /// two cells with the same seed and different populations are different
    /// worlds.
    pub ambient_profile_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSite {
    pub site_id: String,
    pub score: f64,
    pub verdict: Verdict,
    pub origin_feature_id: String,
    pub entry_lane_rsl: String,
    pub ego_turn: Option<crate::template::TurnDirection>,
    pub degradation_summary: String,
    pub matched_reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestParams {
    pub values: BTreeMap<String, f64>,
    pub categorical: BTreeMap<String, String>,
    pub rejected_constraints: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestActor {
    pub id: String,
    pub actor_kind: ActorKind,
    pub role_kind: String,
    pub lane_rsl: Option<String>,
    pub spawn_s: f64,
    pub initial_speed_mps: f64,
    pub binding_status: String,
}

/// A command already accepted into the concrete `t = 0` world rather than
/// left for the runtime trigger evaluator.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialInteractionOutcome {
    pub interaction_id: String,
    pub actor_id: String,
    pub verb: &'static str,
    pub time_s: f64,
    pub outcome: &'static str,
    pub basis: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceManifest {
    pub kind: &'static str,
    pub manifest_version: u32,
    pub replay_key: ReplayKey,
    pub instance_id: String,
    pub archetype: Option<String>,
    pub negative_control: bool,
    pub metric_subject: Option<String>,
    pub operational_variant: Option<AppliedCatalogVariant>,
    pub site: ManifestSite,
    pub params: ManifestParams,
    pub actors: Vec<ManifestActor>,
    pub props: Vec<StaticProp>,
    pub arrival: Vec<ArrivalSolution>,
    pub input_hash: String,
    pub feasible: bool,
    pub issues: Vec<SimIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambient: Option<AmbientTrafficProvenance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambient_settle: Option<AmbientSettleProvenance>,
    pub initial_interaction_outcomes: Vec<InitialInteractionOutcome>,
    pub notes: Notes,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MaterializeResult {
    pub input: SimScenarioInput,
    pub manifest: InstanceManifest,
    pub observations: Vec<LoweredObservation>,
}

/* ------------------------------------------------------------- environment */

fn visibility_range_m(visibility: VisibilityClass, reduced_contrast_m: f64) -> f64 {
    match visibility {
        VisibilityClass::Unrestricted => 1_000.0,
        VisibilityClass::ReducedContrast => reduced_contrast_m,
        VisibilityClass::HeadlightLimited => 75.0,
        VisibilityClass::DirectionalGlare => 105.0,
        VisibilityClass::DenseOcclusion => 90.0,
    }
}

/// Resolve the canonical v2 environment for ordinary materialization. A
/// catalog slot still wins when supplied, but an ad-hoc authored scenario must
/// never silently simulate as dry noon merely because it is not in a catalog.
pub fn apply_template_environment(
    environment: &Environment,
    mut evaluate: impl FnMut(&NumberOrExpr, &str) -> CompileResult<f64>,
) -> CompileResult<OperationalConditions> {
    let weather = match environment.weather {
        Weather::LightRain | Weather::HeavyRain | Weather::WetRoad | Weather::Sleet => {
            SimWeather::Rain
        }
        Weather::Cloudy
        | Weather::Overcast
        | Weather::FogLight
        | Weather::FogDense
        | Weather::Snow => SimWeather::Overcast,
        Weather::Clear => SimWeather::Clear,
    };
    let time_of_day = match environment.time_of_day {
        TimeOfDay::Dawn => SimTimeOfDay::Dawn,
        TimeOfDay::Dusk => SimTimeOfDay::Dusk,
        TimeOfDay::Night | TimeOfDay::NightLit => SimTimeOfDay::Night,
        TimeOfDay::Morning | TimeOfDay::Noon | TimeOfDay::Afternoon => SimTimeOfDay::Day,
    };
    let extension_visibility = environment
        .extensions
        .as_ref()
        .and_then(|e| e.get("visibility"))
        .and_then(Value::as_str);
    let sun_elevation = match &environment.sun_elevation_deg {
        Some(v) => Some(evaluate(v, "environment.sunElevationDeg")?),
        None => None,
    };
    let visibility = if extension_visibility == Some("directional-glare")
        || sun_elevation.is_some_and(|e| e <= 10.0)
    {
        VisibilityClass::DirectionalGlare
    } else {
        match extension_visibility {
            Some("headlight-limited") => VisibilityClass::HeadlightLimited,
            Some("dense-occlusion") => VisibilityClass::DenseOcclusion,
            _ => match environment.weather {
                Weather::FogDense => VisibilityClass::DenseOcclusion,
                Weather::FogLight | Weather::HeavyRain => VisibilityClass::ReducedContrast,
                _ => VisibilityClass::Unrestricted,
            },
        }
    };
    let preset_friction = match environment.weather {
        Weather::LightRain => 0.78,
        Weather::HeavyRain => 0.58,
        Weather::WetRoad => 0.72,
        Weather::Snow => 0.35,
        Weather::Sleet => 0.42,
        _ => 1.0,
    };
    let friction_scale = match &environment.friction_scale {
        Some(v) => evaluate(v, "environment.frictionScale")?,
        None => preset_friction,
    };
    Ok(OperationalConditions {
        weather,
        time_of_day,
        traffic: TrafficLevel::Moderate,
        visibility,
        effects: ConditionEffects {
            visibility_range_m: visibility_range_m(visibility, 120.0),
            friction_scale,
            traffic_speed_factor: 1.0,
        },
    })
}

/// Translate the catalog's human-readable labels into the finite engine
/// vocabulary and its executable physical effects.
pub fn apply_catalog_variant(
    variant: &CatalogVariantApplication,
) -> CompileResult<OperationalConditions> {
    let weather = SimWeather::parse(&variant.weather);
    let time_of_day = SimTimeOfDay::parse(&variant.time_of_day);
    let traffic = TrafficLevel::parse(&variant.traffic);
    let visibility = match variant.visibility.as_str() {
        "unrestricted except authored occluders" => Some(VisibilityClass::Unrestricted),
        "reduced contrast and traffic occlusion" => Some(VisibilityClass::ReducedContrast),
        "headlight-limited with wet-road reflections" => Some(VisibilityClass::HeadlightLimited),
        "directional glare with otherwise clear air" => Some(VisibilityClass::DirectionalGlare),
        "dense actor and parked-vehicle occlusion" => Some(VisibilityClass::DenseOcclusion),
        _ => None,
    };
    let (Some(weather), Some(time_of_day), Some(traffic), Some(visibility)) =
        (weather, time_of_day, traffic, visibility)
    else {
        return Err(CompileError::at(
            "variant_unsupported",
            "variant",
            format!(
                "catalog variant \"{}\" contains unsupported operational conditions",
                variant.id
            ),
        )
        .with_detail(crate::error::detail(&[
            ("weather", Value::String(variant.weather.clone())),
            ("timeOfDay", Value::String(variant.time_of_day.clone())),
            ("traffic", Value::String(variant.traffic.clone())),
            ("visibility", Value::String(variant.visibility.clone())),
        ])));
    };
    Ok(OperationalConditions {
        weather,
        time_of_day,
        traffic,
        visibility,
        effects: ConditionEffects {
            visibility_range_m: visibility_range_m(visibility, 140.0),
            friction_scale: if weather == SimWeather::Rain {
                0.72
            } else {
                1.0
            },
            traffic_speed_factor: match traffic {
                TrafficLevel::Light => 1.05,
                TrafficLevel::Heavy => 0.85,
                TrafficLevel::Moderate => 1.0,
            },
        },
    })
}

/* ------------------------------------------------------- studio presentation */

/// Normalise the editor's presentation colour into the playback tag format.
/// Invalid presentation metadata is ignored by materialization.
pub fn normalize_studio_body_color(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim().to_ascii_lowercase();
    if text.is_empty() {
        return None;
    }
    if let Some(hex) = text.strip_prefix('#') {
        let expanded: String = if hex.len() == 3 {
            hex.chars().flat_map(|c| [c, c]).collect()
        } else {
            hex.to_owned()
        };
        return (expanded.len() == 6 && expanded.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| format!("#{expanded}"));
    }
    let inner = match text
        .strip_prefix("rgb(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        Some(inner) => inner,
        None => text.as_str(),
    };
    let channels: Vec<&str> = inner.split(',').collect();
    if channels.len() != 3 {
        return None;
    }
    let mut out = String::from("#");
    for channel in channels {
        let byte: u8 = channel.trim().parse().ok()?;
        out.push_str(&format!("{byte:02x}"));
    }
    Some(out)
}

pub fn studio_body_color_tag(value: Option<&Value>) -> Option<String> {
    normalize_studio_body_color(value).map(|c| format!("{STUDIO_BODY_COLOR_TAG_PREFIX}{c}"))
}

/// Reconcile authored Studio paint onto an already-materialised input.
pub fn with_studio_body_color_tags(
    mut input: SimScenarioInput,
    template: &ScenarioTemplate,
) -> SimScenarioInput {
    let colors: BTreeMap<&str, String> = template
        .roles
        .iter()
        .filter_map(|role| {
            normalize_studio_body_color(
                role.base
                    .extensions
                    .as_ref()
                    .and_then(|e| e.get("studio.presentation.bodyColor")),
            )
            .map(|c| (role.base.id.as_str(), c))
        })
        .collect();
    for actor in &mut input.actors {
        let color = actor
            .tags
            .iter()
            .find_map(|t| t.strip_prefix("role:"))
            .and_then(|r| colors.get(r));
        actor
            .tags
            .retain(|t| !t.starts_with(STUDIO_BODY_COLOR_TAG_PREFIX));
        if let Some(color) = color {
            actor
                .tags
                .push(format!("{STUDIO_BODY_COLOR_TAG_PREFIX}{color}"));
        }
    }
    input
}

/* ------------------------------------------------------------- assertions */

/// Refuse map-control claims the engine cannot execute faithfully.
pub fn assert_materializable_map_controls(
    template: &ScenarioTemplate,
    bundle: &MapBundle,
    site: &MatchedSite,
    plan: &SiteSignalPlan,
    road_controls: &[RoadControl],
) -> CompileResult<()> {
    for feature in &template.anchor.features {
        let FeatureKind::Junction { control, .. } = &feature.kind else {
            continue;
        };
        if control.as_ref().map(|c| c.essentiality) != Some(crate::template::Essentiality::Required)
        {
            continue;
        }
        let junction_id = site.feature_junction_id(feature.id());
        let actual = junction_id
            .and_then(|id| bundle.index().junction_descriptors.get(id))
            .and_then(|d| d.control);
        let path = format!("anchor.features.{}.control", feature.id());
        let detail = || {
            crate::error::detail(&[
                (
                    "junctionId",
                    junction_id.map_or(Value::Null, |j| Value::String(j.to_owned())),
                ),
                (
                    "actual",
                    actual.map_or(Value::Null, |a| Value::String(a.as_str().to_owned())),
                ),
            ])
        };
        if matches!(
            actual,
            Some(
                crate::template::JunctionControl::AllWayStop
                    | crate::template::JunctionControl::MinorStop
            )
        ) && road_controls.is_empty()
        {
            return Err(CompileError::at(
                "map_control_missing",
                path,
                format!(
                    "required {} control has no deterministic stop-sign-to-movement binding",
                    actual.unwrap().as_str()
                ),
            )
            .with_detail(detail()));
        }
        let complete_signal_binding = !plan.programs.is_empty()
            && plan.programs.iter().all(|program| {
                !program.stop_lines.is_empty()
                    && program
                        .stop_lines
                        .iter()
                        .all(|l| !l.connecting_lane_rsls.is_empty())
                    && program.map_binding.as_ref().is_some_and(|b| {
                        Some(b.junction_id.as_str()) == junction_id
                            && b.controller_head_groups
                                .as_ref()
                                .is_some_and(|g| !g.is_empty())
                    })
            });
        if actual == Some(crate::template::JunctionControl::Signalized) && !complete_signal_binding
        {
            return Err(CompileError::at("map_control_missing", path, "required signalized control has no complete OpenDRIVE controller/head/movement binding").with_detail(detail()));
        }
    }
    Ok(())
}

/// Enforce authored control semantics on the exact movement gate.
/// Junction-level labels such as `minor_stop` do not say which arm is stopped,
/// and accepting them can invert violator and priority traffic.
pub fn assert_materializable_movement_controls(
    template: &ScenarioTemplate,
    bundle: &MapBundle,
    site: &MatchedSite,
    road_controls: &[RoadControl],
) -> CompileResult<()> {
    let is_stop_controlled = |gate_id: &str| -> bool {
        let Some(gate) = bundle.topology().gates.iter().find(|g| g.id == gate_id) else {
            return false;
        };
        road_controls.iter().any(|c| {
            c.kind == simforge_core::types::RoadControlKind::Stop
                && c.stop_lines.iter().any(|l| {
                    l.rsl == gate.approach_lane_rsl
                        && l.connecting_lane_rsls
                            .iter()
                            .any(|r| *r == gate.connecting_lane_rsl)
                })
        })
    };
    for role in &template.roles {
        let Some(required) = role.base.required_movement_control else {
            continue;
        };
        let path = format!("roles.{}.requiredMovementControl", role.base.id);
        let gate_id = match &role.kind {
            RoleKind::ConflictingGate { .. } => site
                .binding(&role.base.id)
                .and_then(|b| b.conflict.as_ref())
                .map(|c| c.gate_id.clone()),
            RoleKind::OnReference { .. } => site.frame.ego_gate_id.clone(),
            _ => None,
        };
        let Some(gate_id) = gate_id else {
            return Err(CompileError::at(
                "movement_control_unresolved",
                path,
                format!(
                    "required {} movement control cannot be resolved to an exact junction gate",
                    required.as_str()
                ),
            )
            .with_detail(crate::error::detail(&[
                ("roleId", Value::String(role.base.id.clone())),
                ("siteId", Value::String(site.site_id.clone())),
            ])));
        };
        let stopped = is_stop_controlled(&gate_id);
        let detail = crate::error::detail(&[
            ("roleId", Value::String(role.base.id.clone())),
            ("gateId", Value::String(gate_id.clone())),
            ("siteId", Value::String(site.site_id.clone())),
        ]);
        match required {
            MovementControl::Stop if !stopped => return Err(CompileError::at("movement_stop_missing", path, format!("bound movement gate {gate_id} has no physical stop control")).with_detail(detail)),
            MovementControl::Uncontrolled if stopped => {
                return Err(CompileError::at("movement_priority_missing", path, format!("bound movement gate {gate_id} is physically stop-controlled but requires priority/uncontrolled movement")).with_detail(detail))
            }
            _ => {}
        }
    }
    Ok(())
}

/// The engine's `set` keys are a subset of the authored registry. Mapping is
/// explicit so a key with no counterpart is *reported*, never ignored.
pub fn map_set_key(key: &str) -> Option<String> {
    simforge_core::types::SetKey::parse(key).map(|_| key.to_owned())
}

/// Reject a stale or externally supplied site before it can produce an
/// engine document whose interactions reference an actor the matcher did not
/// bind. Normal matching already excludes these sites.
pub fn assert_required_role_bindings(
    template: &ScenarioTemplate,
    bindings: &[FeatureBinding],
) -> CompileResult<()> {
    for role in &template.roles {
        if role.base.essentiality != crate::template::Essentiality::Required {
            continue;
        }
        let binding = bindings.iter().find(|b| b.role == role.base.id);
        if binding.map_or(true, |b| {
            matches!(b.status, BindingStatus::Failed | BindingStatus::Dropped)
        }) {
            let (status, notes) = match binding {
                Some(b) => (b.status.as_str().to_owned(), b.notes.clone()),
                None => (
                    "missing".to_owned(),
                    vec!["no matcher binding for this role".to_owned()],
                ),
            };
            return Err(CompileError::at(
                "role_unbound",
                format!("roles.{}", role.base.id),
                format!(
                    "required role \"{}\" did not bind at this site",
                    role.base.id
                ),
            )
            .with_detail(crate::error::detail(&[
                ("status", Value::String(status)),
                (
                    "notes",
                    Value::Array(notes.into_iter().map(Value::String).collect()),
                ),
            ]))
            .as_findings());
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------ helpers */

pub(crate) fn supports_driver_profile(class: ActorClass) -> bool {
    !matches!(
        class,
        ActorClass::Pedestrian
            | ActorClass::SidewalkRobot
            | ActorClass::Drone
            | ActorClass::Animal
            | ActorClass::StaticObject
    )
}

/// The simulation contract carries the authoring class directly.
pub fn actor_kind_for_class(class: ActorClass) -> ActorKind {
    match class {
        ActorClass::Car => ActorKind::Car,
        ActorClass::Truck => ActorKind::Truck,
        ActorClass::Bus => ActorKind::Bus,
        ActorClass::Van => ActorKind::Van,
        ActorClass::Motorcycle => ActorKind::Motorcycle,
        ActorClass::Bicycle => ActorKind::Bicycle,
        ActorClass::Pedestrian => ActorKind::Pedestrian,
        ActorClass::Scooter => ActorKind::Scooter,
        ActorClass::SidewalkRobot => ActorKind::SidewalkRobot,
        ActorClass::Drone => ActorKind::Drone,
        ActorClass::Animal => ActorKind::Animal,
        ActorClass::StaticObject => ActorKind::StaticObject,
    }
}

pub(crate) fn lane_scope(bundle: &MapBundle, lane_rsl: Option<&str>) -> (Option<f64>, Option<f64>) {
    let lane = lane_rsl.and_then(|r| bundle.index().lanes.get(r));
    (
        lane.map(|l| l.speed_limit_kph),
        lane.map(|l| l.representative_width_m),
    )
}

pub(crate) fn junction_scope(bundle: &MapBundle, site: &MatchedSite) -> Option<f64> {
    site.origin_junction_id()
        .and_then(|id| bundle.index().junction_descriptors.get(id))
        .map(|d| d.size_m)
}

/// Evaluate an authored number in a scope. `fallback` covers an absent
/// value or an unresolvable expression; without it both are errors.
pub(crate) fn eval_num(
    value: Option<&NumberOrExpr>,
    scope: &ExprScope,
    path: &str,
    fallback: Option<f64>,
) -> CompileResult<f64> {
    let Some(value) = value else {
        return fallback.ok_or_else(|| {
            CompileError::at("missing_value", path, "a required numeric value is absent")
        });
    };
    match value.evaluate(scope) {
        Ok(v) => Ok(v),
        Err(e) => fallback.ok_or_else(|| {
            CompileError::at("expression_unresolvable", path, e.to_string()).with_detail(
                crate::error::detail(&[(
                    "expression",
                    Value::String(if value.is_expr() {
                        "expr".to_owned()
                    } else {
                        format!("{}", value.as_number().unwrap_or(f64::NAN))
                    }),
                )]),
            )
        }),
    }
}

pub(crate) fn eval_tfrac(
    value: Option<&NumberOrExpr>,
    scope: &ExprScope,
    path: &str,
    fallback: f64,
) -> CompileResult<f64> {
    let t = eval_num(value, scope, path, Some(fallback))?;
    Ok(if t.is_finite() {
        t.clamp(-1.0, 1.0)
    } else {
        fallback
    })
}

pub(crate) fn json_number(map: Option<&Map<String, Value>>, key: &str) -> Option<f64> {
    map?.get(key)?.as_f64()
}

pub(crate) fn json_str<'a>(map: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    map?.get(key)?.as_str()
}

pub(crate) fn speed_verb_ceiling(
    template: &ScenarioTemplate,
    role_id: &str,
    scope: &ExprScope,
    base_speed_mps: f64,
) -> CompileResult<f64> {
    let mut ceiling = base_speed_mps;
    for it in &template.choreography.interactions {
        if it.base.actor != role_id {
            continue;
        }
        let Verb::Speed { target, .. } = &it.verb else {
            continue;
        };
        let path = format!("choreography.{}.target", it.base.id);
        use crate::template::SpeedTarget as T;
        let candidate = match target {
            T::Absolute { value_kph } => {
                eval_num(Some(value_kph), scope, &format!("{path}.valueKph"), None)? * KPH_TO_MPS
            }
            T::Delta { delta_kph } => {
                base_speed_mps
                    + eval_num(Some(delta_kph), scope, &format!("{path}.deltaKph"), None)?
                        * KPH_TO_MPS
            }
            T::Factor { factor } => {
                base_speed_mps * eval_num(Some(factor), scope, &format!("{path}.factor"), None)?
            }
            T::Match { .. } | T::Stop | T::Resume => continue,
        };
        ceiling = ceiling.max(candidate);
    }
    Ok(ceiling)
}

/* -------------------------------------------------------------- entry points */

/// Materialize one concrete instance at a matched site.
pub fn materialize(
    template: &ScenarioTemplate,
    bundle: &MapBundle,
    site: &MatchedSite,
    options: &MaterializeOptions,
) -> CompileResult<MaterializeResult> {
    assert_required_role_bindings(template, &site.bindings)?;
    let draw = resolve_params(
        template,
        &site.site_id,
        options.draw_index,
        options.seed.as_deref(),
    )?;
    builder::Materializer::new(template, bundle, site, draw, options).run()
}

/// First-class materialization for Studio's map-bound document: an exact
/// synthetic site around the authored lane/pose, then the same pipeline as
/// portable scenarios.
pub fn materialize_map_bound(
    template: &ScenarioTemplate,
    bundle: &MapBundle,
    options: &MaterializeOptions,
) -> CompileResult<MaterializeResult> {
    let pinned = template.anchor.pin.as_ref().map(|p| p.map_id.as_str());
    if pinned != Some(bundle.map_id()) {
        return Err(CompileError::at(
            "map_pin_mismatch",
            "anchor.pin.mapId",
            format!(
                "scenario is pinned to {}, not {}",
                pinned.unwrap_or("no map"),
                bundle.map_id()
            ),
        ));
    }
    if template.roles.iter().any(|r| r.is_portable()) {
        return Err(CompileError::at(
            "map_bound_roles_required",
            "roles",
            "map-bound materialization cannot mix portable roles",
        ));
    }
    let site = synthetic_studio_site(template, bundle)?;
    materialize(template, bundle, &site, options)
}

fn synthetic_studio_site(
    template: &ScenarioTemplate,
    bundle: &MapBundle,
) -> CompileResult<MatchedSite> {
    let graph = bundle.graph();
    let base_frame = |entry_lane_rsl: String| AnchorFrame {
        origin: FrameOrigin {
            anchor_feature_id: "studio-map-bound".to_owned(),
            kind: OriginKind::Corridor,
            map_feature_id: format!("map:{}", bundle.map_id()),
        },
        entry_lane_rsl,
        reference_path: Vec::new(),
        s_of_lane: BTreeMap::new(),
        s_range: (0.0, 0.0),
        lateral_lanes: BTreeMap::new(),
        opposing_lanes: Vec::new(),
        handedness: Handedness::Right,
        mirrored: false,
        ego_gate_id: None,
        ego_turn: None,
        runway_upstream_m: 0.0,
        runway_downstream_m: 0.0,
    };
    let site = |frame: AnchorFrame,
                bindings: Vec<FeatureBinding>,
                summary: &str,
                reasons: Vec<&str>| MatchedSite {
        site_id: format!("studio:{}", bundle.map_id()),
        map_id: bundle.map_id().to_owned(),
        topology_digest: bundle.index().topology_digest.clone(),
        match_semantics_version: MATCH_SEMANTICS_VERSION.to_owned(),
        anchor_id: template.template_id().to_owned(),
        score: 1.0,
        frame,
        clauses: Vec::new(),
        bindings,
        feature_matches: BTreeMap::new(),
        degradation: DegradationReport {
            verdict: Verdict::Exact,
            score: 1.0,
            repairs: Vec::new(),
            failed_required_clauses: Vec::new(),
            summary: summary.to_owned(),
            intent_preserved: true,
        },
        matched_reasons: reasons.into_iter().map(str::to_owned).collect(),
        alternate_frames: 0,
    };
    let Some(first) = template.roles.first() else {
        return Ok(site(
            base_frame("studio:empty".to_owned()),
            Vec::new(),
            "empty map-bound Studio scene",
            vec!["anchor.pin.mapId", "empty-scene"],
        ));
    };
    let follow = |role: &crate::template::RoleBinding| -> CompileResult<Option<(String, simforge_core::map::Route)>> {
        let RoleKind::SceneAbsolute { lane_ref: Some(lane_ref), .. } = &role.kind else { return Ok(None) };
        let rsl = lane_ref.rsl();
        let Some(lane) = graph.lane_id(&rsl) else {
            return Err(CompileError::at("route_lane_missing", format!("roles.{}.laneRef", role.base.id), format!("lane {rsl} is not in the lane graph")));
        };
        let route = build_follow_route(graph, &FollowRouteOptions::new(lane, &[], 2_000.0)).map_err(|e| CompileError::from_route_error(e, format!("roles.{}.laneRef", role.base.id)))?;
        Ok(Some((rsl, route)))
    };
    let first_route = follow(first)?;
    let mut frame = base_frame(
        first_route
            .as_ref()
            .map_or_else(|| "studio:freeform".to_owned(), |(rsl, _)| rsl.clone()),
    );
    let first_s = match &first.kind {
        RoleKind::SceneAbsolute {
            lane_ref: Some(lr), ..
        } => lr.s,
        _ => 0.0,
    };
    if let Some((rsl, route)) = &first_route {
        frame.reference_path = route
            .legs()
            .iter()
            .map(|leg| {
                let lane_rsl = graph.rsl(leg.lane).to_owned();
                ReferenceSpan {
                    lane_rsl,
                    s_start: leg.s_start,
                    s_end: leg.s_end(),
                    length_m: leg.length_m,
                    is_junction: graph.lane(leg.lane).is_junction,
                    contiguous: true,
                }
            })
            .collect();
        frame.s_of_lane = frame
            .reference_path
            .iter()
            .map(|span| (span.lane_rsl.clone(), span.s_start))
            .collect();
        frame.s_range = (0.0, route.length_m());
        frame.lateral_lanes.insert(0, rsl.clone());
        frame.runway_upstream_m = first_s;
        frame.runway_downstream_m = (route.length_m() - first_s).max(0.0);
    } else {
        frame.s_range = (0.0, 2_000.0);
        frame.runway_downstream_m = 2_000.0;
    }
    let mut bindings = Vec::with_capacity(template.roles.len());
    for role in &template.roles {
        let mut binding = FeatureBinding::new(&role.base.id, "on_reference");
        binding.status = BindingStatus::Bound;
        if let Some((rsl, route)) = follow(role)? {
            binding.route_lane_chain = Some(routes::rsls_of(graph, &route));
            binding.lane_rsl = Some(rsl);
        }
        bindings.push(binding);
    }
    Ok(site(
        frame,
        bindings,
        "exact map-bound Studio placement",
        vec!["anchor.pin.mapId", "scene_absolute"],
    ))
}

/// Which site a document should be instantiated at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteSelection<'a> {
    /// The top-ranked matched site.
    Auto,
    Id(&'a str),
}

/// Parse, select a site and materialize in one call. Map-bound (pinned,
/// `scene_absolute`) documents skip matching.
pub fn instantiate(
    document: &Value,
    bundle: &MapBundle,
    site: SiteSelection<'_>,
    options: &MaterializeOptions,
) -> CompileResult<MaterializeResult> {
    let template = crate::template::parse_template(document)?;
    if !template.is_portable() {
        return materialize_map_bound(&template, bundle, options);
    }
    let matched = crate::sites::find_site(&template, bundle, site)?;
    materialize(&template, bundle, &matched, options)
}
