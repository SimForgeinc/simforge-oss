//! The builder: one `Materializer` per `(template, bundle, site, draw)`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::Value;
use simforge_core::engine::visibility::{blocking_occluder, build_occluders};
use simforge_core::hash::content_hash_of;
use simforge_core::map::{build_follow_route, FollowRouteOptions, LaneGraph, Route};
use simforge_core::math::{cos, hypot, sin, to_scene_xz, Vec2};
use simforge_core::solve::{
    apply_arrival_solution, check_feasibility, nominal_run, resolve_arrival_triggers,
    solve_arrival, solve_pedestrian_near_miss, ArrivalSolution, NearMissPass, NominalActor,
    NominalRunOptions, PedestrianNearMissRequest, TimedTrajectoryPoint,
};
use simforge_core::types as sim;
use simforge_core::types::{Id, SimActor, SimScenarioInput};
use simforge_core::ENGINE_VERSION;

use super::routes::{
    self, build_lanes, build_route_from_points, close_arrival_conflict, cover_constrained_target,
    cover_target, extend_chain_backward, extend_chain_forward, polyline_distance,
    polyline_points_of, route_from_chain, route_intersection_near, rsls_of, SemanticRequirements,
    ENDPOINT_CLAMP_M, LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M,
};
use super::{
    actor_kind_for_class, apply_catalog_variant, apply_template_environment,
    assert_materializable_map_controls, assert_materializable_movement_controls, eval_num,
    eval_tfrac, json_number, json_str, junction_scope, lane_scope, map_set_key, speed_verb_ceiling,
    studio_body_color_tag, supports_driver_profile, AppliedCatalogVariant,
    InitialInteractionOutcome, InstanceManifest, LoweredObservation, ManifestActor, ManifestParams,
    ManifestSite, MaterializeOptions, MaterializeResult, Note, Notes, ReplayKey, INSTANCE_DT_S,
    KPH_TO_MPS,
};
use crate::ambient::{
    apply_ambient_traffic, prune_dangling_after_interactions, resolve_ambient_traffic_profile,
    settle_ambient_traffic, AmbientPreset, AmbientSettleOptions, AmbientTrafficOptions,
};
use crate::anchor::{BindingStatus, FeatureBinding, MatchedSite};
use crate::bundle::MapBundle;
use crate::catalog::{prop_behavior, prop_dims, PartialDims};
use crate::error::{detail, CompileError, CompileResult};
use crate::expr::{ExprScope, NumberOrExpr};
use crate::geometry::to_rad;
use crate::map_signals::{
    build_map_control_plan, build_site_road_controls, build_site_signal_plan,
    resolve_site_signal_program, SiteSignalPlan, SiteSignalRef,
};
use crate::params::ParamDraw;
use crate::perception::{
    atmosphere_from_environment, lower_map_divergence, lower_sensor, DivergenceWindow,
};
use crate::signal_plan::{compile_map_signal_plans, CompileMapSignalPlansOptions};
use crate::template::{self as t, RoleBinding, RoleKind, ScenarioTemplate};

/// Cohort geometry for the ambient warm-up: a settled car travels
/// `cruise × settleSeconds`, so the cars standing near the ego at `t = 0` are
/// the ones that spawned that far upstream.
const AMBIENT_SETTLE_COHORT_MPS: f64 = 15.0;
const AMBIENT_SETTLE_COHORT_MULTIPLIER: f64 = 4.0;
/// Ticks per second of the near-miss target trajectory sampler.
const NEAR_MISS_SAMPLE_HZ: f64 = 20.0;

fn is_lane_offset_error(code: &str) -> bool {
    matches!(code, "lane_offset_unavailable" | "lane_offset_unroutable")
}

fn v1_rsl(role: &RoleBinding) -> Option<String> {
    match &role.kind {
        RoleKind::SceneAbsolute {
            lane_ref: Some(lr), ..
        } => Some(lr.rsl()),
        _ => None,
    }
}

fn scene_point(v: Vec2) -> sim::ScenePoint {
    let s = to_scene_xz(v);
    sim::ScenePoint { x: s.x, z: s.z }
}

fn compare(op: t::CompareOp) -> sim::Comparison {
    match op {
        t::CompareOp::Lt => sim::Comparison::Lt,
        t::CompareOp::Lte => sim::Comparison::Lte,
        t::CompareOp::Gt => sim::Comparison::Gt,
        t::CompareOp::Gte => sim::Comparison::Gte,
    }
}

fn indication(phase: t::SignalPhase) -> sim::ControlIndication {
    sim::ControlIndication::parse(phase.as_str())
        .expect("template signal phases are a subset of the engine indications")
}

fn dynamics_shape(shape: t::DynamicsShape) -> sim::DynamicsShape {
    match shape {
        t::DynamicsShape::Step => sim::DynamicsShape::Step,
        t::DynamicsShape::Linear => sim::DynamicsShape::Linear,
        t::DynamicsShape::Sinusoidal => sim::DynamicsShape::Sinusoidal,
        t::DynamicsShape::Cubic => sim::DynamicsShape::Cubic,
    }
}

fn dynamics_constraint(c: t::DynamicsConstraint) -> sim::DynamicsConstraint {
    match c {
        t::DynamicsConstraint::Rate => sim::DynamicsConstraint::Rate,
        t::DynamicsConstraint::Time => sim::DynamicsConstraint::Time,
        t::DynamicsConstraint::Distance => sim::DynamicsConstraint::Distance,
    }
}

fn set_value(v: &t::SetValue) -> sim::SetValue {
    match v {
        t::SetValue::Bool(b) => sim::SetValue::Bool(*b),
        t::SetValue::Number(n) => sim::SetValue::Number(*n),
        t::SetValue::Text(s) => sim::SetValue::Text(s.clone()),
    }
}

fn apply_rule(rules: &mut sim::ActorRules, key: sim::RuleKey, value: &sim::SetValue) {
    let number = match value {
        sim::SetValue::Number(n) => Some(*n),
        _ => None,
    };
    let flag = value.truthy();
    match key {
        sim::RuleKey::ObeySignals => rules.obey_signals = flag,
        sim::RuleKey::YieldToVehicles => rules.yield_to_vehicles = flag,
        sim::RuleKey::YieldToPedestrians => rules.yield_to_pedestrians = flag,
        sim::RuleKey::CollisionAvoidance => rules.collision_avoidance = flag,
        sim::RuleKey::Aggression => {
            if let Some(n) = number {
                rules.aggression = n;
            }
        }
        sim::RuleKey::SpeedFactor => {
            if let Some(n) = number {
                rules.speed_factor = n;
            }
        }
    }
}

fn profile_rules(profile: t::DriverProfile) -> sim::ActorRules {
    let r = profile.definition().rules;
    sim::ActorRules {
        obey_signals: r.obey_signals,
        yield_to_vehicles: r.yield_to_vehicles,
        yield_to_pedestrians: r.yield_to_pedestrians,
        collision_avoidance: r.collision_avoidance,
        aggression: r.aggression,
        speed_factor: r.speed_factor,
    }
}

/// Signal keys addressed semantically: `signal:feature:<id>:<approach>.phase`
/// (`ego` remains readable only for already-persisted keys).
fn semantic_signal_key(key: &str) -> Option<(&str, t::SignalApproach)> {
    let rest = key.strip_prefix("signal:feature:")?;
    let (feature, tail) = rest.split_once(':')?;
    let approach = tail
        .strip_suffix(".phase")
        .or_else(|| tail.strip_suffix(".program"))?;
    if feature.is_empty()
        || feature.len() > 64
        || !feature
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic())
        || !feature
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    let approach = match approach {
        "subject" | "ego" => t::SignalApproach::Subject,
        "opposing" => t::SignalApproach::Opposing,
        "left" => t::SignalApproach::Left,
        "right" => t::SignalApproach::Right,
        _ => return None,
    };
    Some((feature, approach))
}

fn direct_signal_key(key: &str) -> Option<&str> {
    key.strip_prefix("signal:")?
        .strip_suffix(".phase")
        .filter(|h| !h.is_empty())
}

fn control_key(key: &str) -> Option<&str> {
    key.strip_prefix("control:")?
        .strip_suffix(".indication")
        .filter(|h| !h.is_empty())
}

struct WorldPose {
    point: Vec2,
    heading_rad: f64,
}

pub(super) struct Materializer<'a> {
    template: &'a ScenarioTemplate,
    bundle: &'a MapBundle,
    site: &'a MatchedSite,
    draw: ParamDraw,
    options: &'a MaterializeOptions,
    notes: Notes,
    actors: Vec<SimActor>,
    interactions: Vec<sim::Interaction>,
    props: Vec<sim::StaticProp>,
    occluders: Vec<sim::Occluder>,
    occlusion_pairs: Vec<sim::OcclusionPair>,
    near_miss_criteria: Vec<sim::NearMissCriterion>,
    binding_by_role: BTreeMap<&'a str, &'a FeatureBinding>,
    role_by_id: BTreeMap<&'a str, &'a RoleBinding>,
    route_by_role: BTreeMap<String, Route>,
    lane_by_role: BTreeMap<String, Option<String>>,
    spawn_s_by_role: BTreeMap<String, f64>,
    scope_by_role: BTreeMap<String, ExprScope>,
    initial_rules: BTreeMap<String, Vec<(sim::RuleKey, sim::SetValue)>>,
    folded_interactions: BTreeSet<String>,
    folded_trigger_start: BTreeMap<String, f64>,
    initial_interaction_outcomes: Vec<InitialInteractionOutcome>,
    signal_plan: Option<SiteSignalPlan>,
    compiled_map_signal_programs: Option<Vec<sim::SignalProgram>>,
    road_controls: Vec<sim::RoadControl>,
    authored_control_programs: Vec<sim::SignalProgram>,
    ref_route: Option<Route>,
}

impl<'a> Materializer<'a> {
    pub(super) fn new(
        template: &'a ScenarioTemplate,
        bundle: &'a MapBundle,
        site: &'a MatchedSite,
        draw: ParamDraw,
        options: &'a MaterializeOptions,
    ) -> Self {
        Self {
            template,
            bundle,
            site,
            draw,
            options,
            notes: Vec::new(),
            actors: Vec::new(),
            interactions: Vec::new(),
            props: Vec::new(),
            occluders: Vec::new(),
            occlusion_pairs: Vec::new(),
            near_miss_criteria: Vec::new(),
            binding_by_role: site.bindings.iter().map(|b| (b.role.as_str(), b)).collect(),
            role_by_id: template
                .roles
                .iter()
                .map(|r| (r.base.id.as_str(), r))
                .collect(),
            route_by_role: BTreeMap::new(),
            lane_by_role: BTreeMap::new(),
            spawn_s_by_role: BTreeMap::new(),
            scope_by_role: BTreeMap::new(),
            initial_rules: BTreeMap::new(),
            folded_interactions: BTreeSet::new(),
            folded_trigger_start: BTreeMap::new(),
            initial_interaction_outcomes: Vec::new(),
            signal_plan: None,
            compiled_map_signal_programs: None,
            road_controls: Vec::new(),
            authored_control_programs: Vec::new(),
            ref_route: None,
        }
    }

    fn graph(&self) -> &'a Arc<LaneGraph> {
        self.bundle.graph()
    }

    fn base_scope(&self, lane_rsl: Option<&str>) -> ExprScope {
        let (speed, width) = lane_scope(
            self.bundle,
            Some(lane_rsl.unwrap_or(&self.site.frame.entry_lane_rsl)),
        );
        ExprScope {
            params: self.draw.values.clone(),
            ..Default::default()
        }
        .with_clip(Some(self.template.choreography.clip_seconds))
        .with_lane(speed, width)
        .with_junction(junction_scope(self.bundle, self.site))
    }

    fn scope_for(&self, role_id: &str) -> ExprScope {
        self.scope_by_role
            .get(role_id)
            .cloned()
            .unwrap_or_else(|| self.base_scope(None))
    }

    fn actor(&self, id: &str) -> Option<&SimActor> {
        self.actors.iter().find(|a| a.id == id)
    }

    fn role_ext(&self, role_id: &str) -> Option<&'a serde_json::Map<String, Value>> {
        self.role_by_id
            .get(role_id)
            .and_then(|r| r.base.extensions.as_ref())
    }

    /// Optional role-local frame origin supplied through the v2 extension seam.
    fn placement_feature_offset(&mut self, role_id: &str, path: &str) -> f64 {
        let Some(raw) = self
            .role_ext(role_id)
            .and_then(|e| e.get("placementFeature"))
        else {
            return 0.0;
        };
        let Some(feature) = raw.as_str() else {
            self.notes.push(Note::loss(
                path,
                "placementFeature must be a feature id string; using frame origin",
            ));
            return 0.0;
        };
        match self.site.feature_matches.get(feature) {
            Some(m) => m.s,
            None => {
                self.notes.push(Note::loss(path, format!("placementFeature \"{feature}\" is not bound at this site; using frame origin")));
                0.0
            }
        }
    }

    /// Evaluate a role's authored frame station for this concrete draw.
    /// Matcher bindings carry the default/static station; relative-role
    /// parameter draws must be re-applied here, including chained queues.
    fn sampled_frame_s(
        &mut self,
        role: &'a RoleBinding,
        binding: &FeatureBinding,
        seen: &mut Vec<String>,
    ) -> CompileResult<f64> {
        if seen.iter().any(|s| *s == role.base.id) {
            return Err(CompileError::at(
                "role_reference_cycle",
                format!("roles.{}.ref", role.base.id),
                format!("relative role cycle reaches \"{}\"", role.base.id),
            )
            .as_findings());
        }
        seen.push(role.base.id.clone());
        let scope = self
            .scope_by_role
            .get(&role.base.id)
            .cloned()
            .unwrap_or_else(|| self.base_scope(binding.lane_rsl.as_deref()));
        let out = if let RoleKind::RelativeTo { r#ref, ds_m, .. } = &role.kind {
            let (Some(ref_role), Some(ref_binding)) = (
                self.role_by_id.get(r#ref.as_str()).copied(),
                self.binding_by_role.get(r#ref.as_str()).copied(),
            ) else {
                seen.pop();
                return Ok(binding.pose.as_ref().map_or(0.0, |p| p.s));
            };
            // Feature-bound roles store lane-local s in their binding; once the
            // reference actor exists, its concrete world pose is the
            // authoritative bridge back into the anchor frame.
            let ref_frame_s = match (self.actor(r#ref), &self.ref_route) {
                (Some(actor), Some(route)) => {
                    self.site.frame.s_range.0
                        + route.project_point(actor.initial.pose.position_local()).s
                }
                _ => self.sampled_frame_s(ref_role, ref_binding, seen)?,
            };
            ref_frame_s
                + eval_num(
                    Some(ds_m),
                    &scope,
                    &format!("roles.{}.dsM", role.base.id),
                    Some(0.0),
                )?
        } else {
            match role.pose() {
                Some(pose) => {
                    self.placement_feature_offset(
                        &role.base.id,
                        &format!("roles.{}.extensions.placementFeature", role.base.id),
                    ) + eval_num(
                        Some(&pose.s),
                        &scope,
                        &format!("roles.{}.pose.s", role.base.id),
                        Some(0.0),
                    )?
                }
                None => binding.pose.as_ref().map_or(0.0, |p| p.s),
            }
        };
        seen.pop();
        Ok(out)
    }

    fn ref_route(&self, path: &str) -> CompileResult<&Route> {
        self.ref_route.as_ref().ok_or_else(|| {
            CompileError::at(
                "reference_route_unbuildable",
                path,
                "the site has no drivable reference path",
            )
        })
    }

    /// Frame arc length → world point on the reference path.
    fn frame_point(&self, s: f64) -> CompileResult<WorldPose> {
        let route = self.ref_route(&format!("site.{}", self.site.site_id))?;
        let pose = route.pose_at(s - self.site.frame.s_range.0);
        Ok(WorldPose {
            point: pose.point,
            heading_rad: pose.heading_rad,
        })
    }

    /// Resolve a full frame pose, including laneOffset and tFrac, into
    /// xodr-local metres.
    fn frame_pose_point(
        &self,
        pose: &t::FramePose,
        scope: &ExprScope,
        path: &str,
        frame_s_offset: f64,
    ) -> CompileResult<WorldPose> {
        let frame_s =
            frame_s_offset + eval_num(Some(&pose.s), scope, &format!("{path}.s"), Some(0.0))?;
        let center = self.frame_point(frame_s)?;
        let ref_route = self.ref_route(path)?;
        let mut owned: Option<Route> = None;
        let mut route: &Route = ref_route;
        let mut route_s = frame_s - self.site.frame.s_range.0;
        if pose.lane_offset != 0 {
            let semantic = self
                .route_by_role
                .iter()
                .filter(|(role_id, candidate)| {
                    !candidate.is_freeform()
                        && self
                            .role_by_id
                            .get(role_id.as_str())
                            .and_then(|r| r.pose())
                            .is_some_and(|p| p.lane_offset == pose.lane_offset)
                })
                .map(|(_, candidate)| candidate)
                .min_by(|a, b| {
                    a.project_point(center.point)
                        .d
                        .total_cmp(&b.project_point(center.point).d)
                });
            let rsl = self.site.frame.lateral_rsl(pose.lane_offset);
            match (semantic, rsl) {
                (Some(semantic), _) => {
                    route = semantic;
                    route_s = semantic.project_point(center.point).s;
                }
                (None, None) => {
                    // Falling back to the reference lane here is the silent
                    // relocation defect in its purest form: a lane the site
                    // does not have is a site that cannot render this scenario.
                    return Err(CompileError::at("lane_offset_unavailable", format!("{path}.laneOffset"), format!("no lane at lane offset {} at this site", pose.lane_offset))
                        .with_detail(detail(&[
                            ("siteId", Value::String(self.site.site_id.clone())),
                            ("requestedK", Value::from(pose.lane_offset)),
                            ("availableK", Value::Array(self.site.frame.lateral_lanes.keys().map(|k| Value::from(*k)).collect())),
                            ("hint", Value::String("require corridor.throughLanesSameDir so only sites wide enough to hold this pose are matched".to_owned())),
                        ]))
                        .as_findings());
                }
                (None, Some(rsl)) => {
                    let mut scratch = Vec::new();
                    let built = route_from_chain(
                        self.graph(),
                        &[rsl.to_owned()],
                        Some(rsl),
                        &mut scratch,
                        &format!("{path}.laneOffset"),
                    );
                    let Some(built) = built else {
                        return Err(CompileError::at(
                            "lane_offset_unroutable",
                            format!("{path}.laneOffset"),
                            format!("lane offset {} resolves to {rsl}, which has no drivable route at this site", pose.lane_offset),
                        )
                        .with_detail(detail(&[("siteId", Value::String(self.site.site_id.clone())), ("requestedK", Value::from(pose.lane_offset)), ("laneRsl", Value::String(rsl.to_owned()))]))
                        .as_findings());
                    };
                    route_s = built.project_point(center.point).s;
                    owned = Some(built);
                    route = owned.as_ref().unwrap();
                }
            }
        }
        let lane_width = route.width_at(route_s);
        let at = route.pose_at(route_s);
        let t_frac = eval_tfrac(
            Some(&pose.t_frac.to_number_or_expr()),
            scope,
            &format!("{path}.tFrac"),
            0.0,
        )?;
        let lateral = t_frac * lane_width;
        Ok(WorldPose {
            point: Vec2 {
                x: at.point.x - sin(at.heading_rad) * lateral,
                y: at.point.y + cos(at.heading_rad) * lateral,
            },
            heading_rad: at.heading_rad + pose.heading_offset_rad,
        })
    }

    fn build_reference_route(&mut self) -> CompileResult<()> {
        if self.template.roles.is_empty() {
            return Ok(());
        }
        if self.template.roles.iter().all(|r| !r.is_portable()) {
            let first = &self.template.roles[0];
            let RoleKind::SceneAbsolute { pose, .. } = &first.kind else {
                unreachable!("scene_absolute checked above")
            };
            self.ref_route = Some(match v1_rsl(first) {
                Some(rsl) => {
                    let path = format!("roles.{}.laneRef", first.base.id);
                    let lane = self.graph().lane_id(&rsl).ok_or_else(|| {
                        CompileError::at(
                            "route_lane_missing",
                            &path,
                            format!("lane {rsl} is not in the lane graph"),
                        )
                    })?;
                    build_follow_route(self.graph(), &FollowRouteOptions::new(lane, &[], 2_000.0))
                        .map_err(|e| CompileError::from_route_error(e, path))?
                }
                None => {
                    let p = Vec2 {
                        x: pose.position.x,
                        y: -pose.position.z,
                    };
                    let h = pose.heading_rad;
                    Route::from_polyline([
                        p,
                        Vec2 {
                            x: p.x + cos(h) * 2_000.0,
                            y: p.y + sin(h) * 2_000.0,
                        },
                    ])
                }
            });
            return Ok(());
        }
        let lanes: Vec<String> = self
            .site
            .frame
            .reference_path
            .iter()
            .map(|s| s.lane_rsl.clone())
            .collect();
        let entry = self.site.frame.entry_lane_rsl.clone();
        let mut notes = std::mem::take(&mut self.notes);
        let route = route_from_chain(
            self.graph(),
            &lanes,
            Some(&entry),
            &mut notes,
            "site.frame.referencePath",
        );
        self.notes = notes;
        self.ref_route = Some(route.ok_or_else(|| {
            CompileError::at(
                "reference_route_unbuildable",
                "site.frame.referencePath",
                "the site reference path is not drivable",
            )
            .with_detail(detail(&[(
                "lanes",
                Value::Array(lanes.iter().cloned().map(Value::String).collect()),
            )]))
        })?);
        Ok(())
    }

    /* --------------------------------------------------------------- actors */

    fn build_actors(&mut self) -> CompileResult<()> {
        for role in &self.template.roles {
            let path = format!("roles.{}", role.base.id);
            let required = role.base.essentiality == t::Essentiality::Required;
            let Some(binding) = self.binding_by_role.get(role.base.id.as_str()).copied() else {
                if required {
                    return Err(CompileError::at(
                        "role_binding_missing",
                        path,
                        format!("required role \"{}\" has no matcher binding", role.base.id),
                    )
                    .with_detail(detail(&[(
                        "siteId",
                        Value::String(self.site.site_id.clone()),
                    )]))
                    .as_findings());
                }
                self.notes
                    .push(Note::loss(path, "no matcher binding for this role"));
                continue;
            };
            let notes_value =
                || Value::Array(binding.notes.iter().cloned().map(Value::String).collect());
            match binding.status {
                BindingStatus::Dropped => {
                    if required {
                        return Err(CompileError::at(
                            "role_binding_dropped",
                            path,
                            format!(
                                "required role \"{}\" was dropped by the matcher",
                                role.base.id
                            ),
                        )
                        .with_detail(detail(&[
                            ("notes", notes_value()),
                            ("siteId", Value::String(self.site.site_id.clone())),
                        ]))
                        .as_findings());
                    }
                    self.notes.push(Note::loss(
                        path,
                        format!("role dropped by the matcher: {}", binding.notes.join("; ")),
                    ));
                    continue;
                }
                BindingStatus::Failed => {
                    if required {
                        return Err(CompileError::at(
                            "role_unbound",
                            path,
                            format!(
                                "required role \"{}\" did not bind at this site",
                                role.base.id
                            ),
                        )
                        .with_detail(detail(&[("notes", notes_value())]))
                        .as_findings());
                    }
                    self.notes.push(Note::loss(
                        path,
                        format!(
                            "role unbound and dropped ({}): {}",
                            role.base.essentiality.as_str(),
                            binding.notes.join("; ")
                        ),
                    ));
                    continue;
                }
                BindingStatus::Bound | BindingStatus::Clamped => {}
            }
            if let Some(actor) = self.build_actor(role, binding)? {
                self.actors.push(actor);
            }
        }
        if !self.template.roles.is_empty() && self.actors.is_empty() {
            return Err(CompileError::at(
                "no_actors",
                "roles",
                "no role produced an actor at this site",
            )
            .as_findings());
        }
        Ok(())
    }

    fn actor_dims(&self, role: &RoleBinding, path: &str) -> CompileResult<sim::Dims> {
        let spec = &role.base.actor;
        if let Some(catalog_id) = &spec.catalog_id {
            if let Some(mismatch) = self.options.catalog.actor_mismatch(spec.class, catalog_id) {
                return Err(CompileError::at(
                    "actor_catalog_class_mismatch",
                    format!("{path}.actor.catalogId"),
                    format!("role \"{}\": {mismatch}", role.base.id),
                )
                .with_detail(detail(&[
                    ("roleId", Value::String(role.base.id.clone())),
                    ("actorClass", Value::String(spec.class.as_str().to_owned())),
                    ("catalogId", Value::String(catalog_id.clone())),
                ]))
                .as_findings());
            }
        }
        // The catalog model's own footprint when the template did not override it.
        Ok(match spec.dims {
            Some(d) => sim::Dims {
                l: d.length,
                w: d.width,
                h: d.height,
            },
            None => match spec
                .catalog_id
                .as_deref()
                .and_then(|id| self.options.catalog.actor_dims(id))
            {
                Some(d) => sim::Dims {
                    l: d.l,
                    w: d.w,
                    h: d.h,
                },
                None => {
                    let d = spec.class.default_dims();
                    sim::Dims {
                        l: d.length,
                        w: d.width,
                        h: d.height,
                    }
                }
            },
        })
    }

    fn base_tags(&self, role: &RoleBinding, binding_tag: &str) -> Vec<String> {
        let mut tags = vec![
            format!("role:{}", role.base.id),
            format!("class:{}", role.base.actor.class.as_str()),
        ];
        if supports_driver_profile(role.base.actor.class) {
            tags.push(format!(
                "driver-profile:{}",
                role.base.driver_profile.unwrap_or_default().as_str()
            ));
        }
        tags.push(format!("binding:{binding_tag}"));
        tags
    }

    fn build_actor(
        &mut self,
        role: &'a RoleBinding,
        binding: &'a FeatureBinding,
    ) -> CompileResult<Option<SimActor>> {
        let path = format!("roles.{}", role.base.id);
        let scope = self.base_scope(binding.lane_rsl.as_deref());
        self.scope_by_role
            .insert(role.base.id.clone(), scope.clone());
        let dims = self.actor_dims(role, &path)?;
        let kind = actor_kind_for_class(role.base.actor.class);
        let clip_total =
            self.template.choreography.clip_seconds + self.template.choreography.warmup_seconds;
        let is_static =
            role.base.actor.r#static || role.base.actor.class == t::ActorClass::StaticObject;
        let initial_speed = |scope: &ExprScope| -> CompileResult<f64> {
            Ok(eval_num(
                role.base.initial_speed_kph.as_ref(),
                scope,
                &format!("{path}.initialSpeedKph"),
                Some(0.0),
            )?
            .max(0.0)
                * KPH_TO_MPS)
        };

        if let RoleKind::SceneAbsolute {
            pose,
            lane_ref,
            initial_route,
        } = &role.kind
        {
            let speed_mps = initial_speed(&scope)?;
            let ceiling = speed_verb_ceiling(self.template, &role.base.id, &scope, speed_mps)?;
            let rsl = v1_rsl(role);
            let distance = (ceiling * clip_total * 1.6).max(100.0);
            let (route, route_spec, sim_lane_ref): (Route, sim::RouteSpec, Option<sim::LaneRef>) =
                match (initial_route, &rsl) {
                    (Some(t::SceneAbsoluteInitialRoute::CustomTimedRoute { points }), _) => (
                        Route::from_polyline(points.iter().map(|p| Vec2 { x: p.x, y: -p.z })),
                        sim::RouteSpec::TimedPolyline {
                            points: points
                                .iter()
                                .map(|p| sim::TimedPoint {
                                    time_s: p.time_s,
                                    x: p.x,
                                    z: p.z,
                                })
                                .collect(),
                        },
                        None,
                    ),
                    (Some(t::SceneAbsoluteInitialRoute::CustomRoute { points }), _) => (
                        Route::from_polyline(points.iter().map(|p| Vec2 { x: p.x, y: -p.z })),
                        sim::RouteSpec::Polyline {
                            points: points
                                .iter()
                                .map(|p| sim::ScenePoint { x: p.x, z: p.z })
                                .collect(),
                        },
                        None,
                    ),
                    (_, Some(rsl)) => {
                        let lr = lane_ref
                            .as_ref()
                            .expect("laneRef present when rsl resolves");
                        let authored = match initial_route {
                            Some(t::SceneAbsoluteInitialRoute::LanePath { lanes }) => {
                                Some(lanes.clone())
                            }
                            _ => self.spawn_route_lane_path_for(&role.base.id)?,
                        };
                        if let Some(first) = authored.as_ref().and_then(|l| l.first()) {
                            if first != rsl {
                                return Err(CompileError::at("route_disconnected", format!("{path}.laneRef"), format!("authored lane path for \"{}\" does not start on its placed lane", role.base.id))
                                .with_detail(detail(&[("placedLane", Value::String(rsl.clone())), ("routeStart", Value::String(first.clone()))])));
                            }
                        }
                        let route = match &authored {
                            Some(lanes) => build_lanes(self.graph(), lanes),
                            None => {
                                let lane = self.graph().lane_id(rsl).ok_or_else(|| {
                                    CompileError::at(
                                        "route_lane_missing",
                                        format!("{path}.laneRef"),
                                        format!("lane {rsl} is not in the lane graph"),
                                    )
                                })?;
                                build_follow_route(
                                    self.graph(),
                                    &FollowRouteOptions::new(lane, &[], distance),
                                )
                            }
                        }
                        .map_err(|e| {
                            CompileError::from_route_error(e, format!("{path}.laneRef"))
                        })?;
                        let width = self
                            .graph()
                            .lane_id(rsl)
                            .map_or(3.5, |l| self.graph().geometry(l).width_m);
                        let spec = sim::RouteSpec::LanePath {
                            lanes: rsls_of(self.graph(), &route),
                        };
                        (
                            route,
                            spec,
                            Some(sim::LaneRef {
                                rsl: rsl.clone(),
                                s: lr.s,
                                t_frac: (lr.t / width).clamp(-1.0, 1.0),
                            }),
                        )
                    }
                    (_, None) => {
                        let (p, h) = (&pose.position, pose.heading_rad);
                        let points = vec![
                            sim::ScenePoint { x: p.x, z: p.z },
                            sim::ScenePoint {
                                x: p.x + cos(h) * distance,
                                z: p.z - sin(h) * distance,
                            },
                        ];
                        (
                            Route::from_polyline(points.iter().map(|q| Vec2 { x: q.x, y: -q.z })),
                            sim::RouteSpec::Polyline { points },
                            None,
                        )
                    }
                };
            let projected = route.project_point(Vec2 {
                x: pose.position.x,
                y: -pose.position.z,
            });
            self.route_by_role.insert(role.base.id.clone(), route);
            self.lane_by_role.insert(role.base.id.clone(), rsl);
            self.spawn_s_by_role
                .insert(role.base.id.clone(), projected.s);
            let mut tags = self.base_tags(role, "scene_absolute");
            if let Some(c) = &role.base.actor.catalog_id {
                tags.push(format!("catalog:{c}"));
            }
            return Ok(Some(SimActor {
                id: role.base.id.clone(),
                kind,
                dims,
                initial: sim::ActorInitial {
                    lane_ref: sim_lane_ref,
                    pose: sim::Pose {
                        x: pose.position.x,
                        z: pose.position.z,
                        heading_rad: pose.heading_rad,
                    },
                    speed_mps,
                },
                behavior: sim::ActorBehavior {
                    rules: self.rules_for(&role.base.id),
                    route: route_spec,
                    driving_profile: self.driving_profile_for(&role.base.id),
                    cruise_speed_mps: Some(speed_mps),
                },
                present_at_start: true,
                is_static,
                tags,
                sensors: None,
            }));
        }

        let mut route: Route;
        let mut spawn_s = 0.0;
        let mut t_frac = 0.0;
        let mut heading_offset = 0.0;
        let bounded_straight = json_str(role.base.extensions.as_ref(), "movementSemantics")
            == Some("same-approach-straight-kerb-edge");

        let relative_parallel = self.relative_parallel_route_for(role, &scope, &path)?;
        let spawn_polyline = match relative_parallel {
            Some(r) => Some(r),
            None => self.spawn_route_polyline_for(&role.base.id)?,
        };
        if let Some(polyline) = spawn_polyline {
            route = polyline;
        } else if let RoleKind::OnCrossing {
            direction,
            start_frac,
            feature,
            ..
        } = &role.kind
        {
            let Some((built, start_s)) =
                self.crossing_route(role, binding, feature, *direction, *start_frac, &path)?
            else {
                return Ok(None);
            };
            route = built;
            spawn_s = start_s;
        } else {
            // An actor on the reference lane drives the reference path, the one
            // chain guaranteed to span the whole frame. The matcher's chain for
            // such a role starts at the *statically* evaluated `s`.
            let on_reference_path = binding.lane_rsl.as_ref().is_some_and(|rsl| {
                self.site
                    .frame
                    .reference_path
                    .iter()
                    .any(|span| span.lane_rsl == *rsl)
            });
            let straight_along_approach = match (bounded_straight, &binding.lane_rsl) {
                // A mechanism-local straight continuation must not roam a
                // connected city graph; 80 m preserves the site's downstream
                // aftermath while bounding the movement to the approach.
                (true, Some(rsl)) => {
                    let lane = self.graph().lane_id(rsl).ok_or_else(|| {
                        CompileError::at(
                            "route_lane_missing",
                            format!("{path}.extensions.movementSemantics"),
                            format!("lane {rsl} is not in the lane graph"),
                        )
                    })?;
                    Some(
                        build_follow_route(
                            self.graph(),
                            &FollowRouteOptions::new(lane, &[sim::TurnRelation::Straight], 80.0),
                        )
                        .map_err(|e| {
                            CompileError::from_route_error(
                                e,
                                format!("{path}.extensions.movementSemantics"),
                            )
                        })?,
                    )
                }
                _ => None,
            };
            let mut seed: Vec<String> = match straight_along_approach {
                Some(r) => rsls_of(self.graph(), &r),
                None if on_reference_path => self
                    .site
                    .frame
                    .reference_path
                    .iter()
                    .map(|s| s.lane_rsl.clone())
                    .collect(),
                None => binding
                    .route_lane_chain
                    .clone()
                    .unwrap_or_else(|| binding.lane_rsl.iter().cloned().collect()),
            };
            if let (RoleKind::ConflictingGate { .. }, Some(conflict)) =
                (&role.kind, &binding.conflict)
            {
                let nominal_speed = initial_speed(&scope)?.max(1.0);
                let extended = extend_chain_backward(
                    self.graph(),
                    &seed,
                    conflict.point,
                    nominal_speed * clip_total,
                );
                if extended.len() > seed.len() {
                    self.notes.push(Note::info(format!("{path}.route"), format!("lane chain extended upstream by {} lane(s) to give the arrival solver temporal runway", extended.len() - seed.len())));
                    seed = extended;
                }
            }
            let mut notes = std::mem::take(&mut self.notes);
            let built = route_from_chain(
                self.graph(),
                &seed,
                binding.lane_rsl.as_deref(),
                &mut notes,
                &format!("{path}.route"),
            );
            self.notes = notes;
            let Some(built) = built else {
                if role.base.essentiality == t::Essentiality::Required {
                    return Err(CompileError::at(
                        "route_unbuildable",
                        path,
                        format!("required role \"{}\" has no drivable route", role.base.id),
                    )
                    .as_findings());
                }
                return Ok(None);
            };
            route = built;
            if matches!(role.kind, RoleKind::ConflictingGate { .. }) {
                // The arrival solver owns this actor's longitudinal placement.
                spawn_s = 0.0;
            } else {
                let pose = role.pose();
                let frame_s = self.sampled_frame_s(role, binding, &mut Vec::new())?;
                let frame_at = self.frame_point(frame_s)?;
                let has_local_constraint = role.base.required_same_segment_as.is_some()
                    || role.base.required_same_road_section_as.is_some()
                    || role.base.required_heading_relation.is_some();
                let constrained = if has_local_constraint {
                    let req = SemanticRequirements {
                        preserve_segment: role.base.required_same_segment_as.is_some(),
                        preserve_road_section: role.base.required_same_road_section_as.is_some(),
                        allow_local_sibling_selection: matches!(
                            role.kind,
                            RoleKind::Opposing { .. }
                        ),
                        expected_heading_rad: role.base.required_heading_relation.as_ref().map(
                            |h| {
                                frame_at.heading_rad
                                    + if h.relation == t::HeadingRelationKind::Antiparallel {
                                        std::f64::consts::PI
                                    } else {
                                        0.0
                                    }
                            },
                        ),
                        max_heading_error_rad: role
                            .base
                            .required_heading_relation
                            .as_ref()
                            .map(|h| to_rad(h.max_error_deg)),
                    };
                    cover_constrained_target(
                        self.bundle,
                        &rsls_of(self.graph(), &route),
                        frame_at.point,
                        &req,
                    )
                } else {
                    None
                };
                if has_local_constraint && constrained.is_none() {
                    return Err(CompileError::at(
                        "role_semantic_projection_failed",
                        format!("{path}.pose.s"),
                        format!("constrained role \"{}\" cannot reach its matcher-selected local lane within {LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M:.2} m", role.base.id),
                    )
                    .with_detail(detail(&[
                        ("bindingLaneRsl", binding.lane_rsl.clone().map_or(Value::Null, Value::String)),
                        ("routeLaneChain", Value::Array(binding.route_lane_chain.iter().flatten().cloned().map(Value::String).collect())),
                        ("frameS", Value::from(frame_s)),
                        ("maxDistanceM", Value::from(LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M)),
                    ]))
                    .as_findings());
                }
                if let Some(coverage) = constrained {
                    // The matcher-bound local lane already owns this station; a
                    // later perpendicular crossing can look closer and prepend an
                    // unrelated road before the actor's truthful route start.
                    if coverage.lanes.len() > route.legs().len() {
                        self.notes.push(Note::info(format!("{path}.route"), format!("constrained lane chain extended upstream by {} lane(s) to preserve the matcher-selected local lane", coverage.lanes.len() - route.legs().len())));
                        route = coverage.route;
                    }
                    spawn_s = coverage
                        .constrained_projection
                        .expect("constrained coverage carries a projection")
                        .route_s;
                } else {
                    if let Some(covered) =
                        cover_target(self.bundle, &rsls_of(self.graph(), &route), frame_at.point)
                    {
                        if covered.lanes.len() > route.legs().len() {
                            self.notes.push(Note::info(format!("{path}.route"), format!("lane chain extended upstream by {} lane(s) to reach the site-evaluated spawn at frame s={frame_s:.1} m", covered.lanes.len() - route.legs().len())));
                            route = covered.route;
                        }
                    }
                    spawn_s = route.project_point(frame_at.point).s;
                }
                if !has_local_constraint && spawn_s <= ENDPOINT_CLAMP_M {
                    self.notes.push(Note::loss(format!("{path}.pose.s"), format!("frame s={frame_s:.1} m is upstream of every drivable lane at this site; the spawn was clamped to the start of the route")));
                }
                t_frac = match &pose {
                    Some(p) => eval_tfrac(
                        Some(&p.t_frac.to_number_or_expr()),
                        &scope,
                        &format!("{path}.pose.tFrac"),
                        0.0,
                    )?,
                    None => binding.pose.as_ref().map_or(0.0, |p| p.t_frac),
                };
                heading_offset = pose
                    .as_ref()
                    .map(|p| p.heading_offset_rad)
                    .or_else(|| binding.pose.as_ref().map(|p| p.heading_offset_rad))
                    .unwrap_or(0.0);
            }
        }

        let speed_mps = initial_speed(&scope)?;
        // Route construction must cover authored motion after the spawn, not
        // only the initial velocity: a dwelling bus starts at zero but its later
        // absolute speed action still consumes downstream runway.
        let speed_for_runway =
            speed_verb_ceiling(self.template, &role.base.id, &scope, speed_mps)?.max(1.0);
        if !route.is_freeform() && !bounded_straight {
            // 1.6×: the clip, the unrecorded warm-up, and cruise overshoot.
            let need_m = speed_for_runway * clip_total * 1.6;
            let extended = extend_chain_forward(self.graph(), &route, spawn_s, need_m);
            if extended.len() > route.legs().len() {
                if let Ok(rebuilt) = build_lanes(self.graph(), &extended) {
                    route = rebuilt;
                }
            }
        }

        let route_pose = route.pose_at(spawn_s);
        let lateral_m = t_frac * route.width_at(spawn_s);
        let scene = to_scene_xz(route.point_with_offset(spawn_s, lateral_m));
        let has_authored_departure = self.template.choreography.interactions.iter().any(|it| it.base.actor == role.base.id && matches!(&it.verb, t::Verb::Speed { target, .. } if !matches!(target, t::SpeedTarget::Stop)));
        let holds_at_zero = speed_mps == 0.0
            && (json_str(role.base.extensions.as_ref(), "serviceState") == Some("dwelling")
                || has_authored_departure);
        let lane_rsl = route_pose.lane.map(|l| self.graph().rsl(l).to_owned());
        let lane_ref = lane_rsl.as_ref().map(|rsl| sim::LaneRef {
            rsl: rsl.clone(),
            s: route_pose.storage_s,
            t_frac,
        });
        let route_spec = if route.is_freeform() {
            sim::RouteSpec::Polyline {
                points: polyline_points_of(&route),
            }
        } else {
            sim::RouteSpec::LanePath {
                lanes: rsls_of(self.graph(), &route),
            }
        };
        self.route_by_role.insert(role.base.id.clone(), route);
        self.lane_by_role.insert(
            role.base.id.clone(),
            lane_rsl.or_else(|| binding.lane_rsl.clone()),
        );
        self.spawn_s_by_role.insert(role.base.id.clone(), spawn_s);

        let mut tags = self.base_tags(role, role.kind.name());
        if json_str(role.base.extensions.as_ref(), "motionSemantics") == Some("reverse") {
            tags.push("motion:reverse".to_owned());
        }
        if let Some(tag) = studio_body_color_tag(
            role.base
                .extensions
                .as_ref()
                .and_then(|e| e.get("studio.presentation.bodyColor")),
        ) {
            tags.push(tag);
        }
        if let Some(c) = &role.base.actor.catalog_id {
            tags.push(format!("catalog:{c}"));
        }
        Ok(Some(SimActor {
            id: role.base.id.clone(),
            kind,
            dims,
            initial: sim::ActorInitial {
                lane_ref,
                pose: sim::Pose {
                    x: scene.x,
                    z: scene.z,
                    heading_rad: route_pose.heading_rad + heading_offset,
                },
                speed_mps,
            },
            behavior: sim::ActorBehavior {
                rules: self.rules_for(&role.base.id),
                route: route_spec,
                driving_profile: self.driving_profile_for(&role.base.id),
                // Omitting cruise means "use the lane limit", not "hold the
                // authored zero"; a real dwell is preserved through warm-up.
                cruise_speed_mps: (speed_mps > 0.0 || holds_at_zero).then_some(speed_mps),
            },
            present_at_start: true,
            is_static,
            tags,
            sensors: None,
        }))
    }

    /// A lane-drop `changeLane` is not licensed merely because both actors
    /// found some nearby route: the disappearing lane must be the lane named
    /// by the matched taper and must have a directed, legal continuation onto
    /// the target actor's route.
    fn assert_terminating_lane_merge_closure(&self) -> CompileResult<()> {
        for role in &self.template.roles {
            let Some(feature) = json_str(role.base.extensions.as_ref(), "terminatingLaneFeature")
            else {
                continue;
            };
            let merge_target = self
                .template
                .choreography
                .interactions
                .iter()
                .find_map(|it| match &it.verb {
                    t::Verb::ChangeLane {
                        target: t::LaneTarget::ToRole { role: target },
                        ..
                    } if it.base.actor == role.base.id => Some(target.as_str()),
                    _ => None,
                });
            let Some(target_role_id) = merge_target else {
                continue;
            };
            let terminating_rsl = self
                .site
                .feature_matches
                .get(feature)
                .and_then(|m| m.map_feature_id.strip_prefix("lane_drop:"))
                .and_then(|rest| rest.split_once('@').map(|(rsl, _)| rsl.to_owned()));
            let source_lanes: BTreeSet<String> = self
                .route_by_role
                .get(&role.base.id)
                .map(|r| rsls_of(self.graph(), r).into_iter().collect())
                .unwrap_or_default();
            let target_lanes: BTreeSet<String> = self
                .route_by_role
                .get(target_role_id)
                .map(|r| rsls_of(self.graph(), r).into_iter().collect())
                .unwrap_or_default();
            let target_role = self.role_by_id.get(target_role_id).copied();
            let structurally_bound = matches!(&role.kind, RoleKind::AtLaneDrop { lane: t::LaneDropLane::Terminating, feature: f, .. } if f == feature)
                && target_role.is_some_and(|tr| matches!(&tr.kind, RoleKind::AtLaneDrop { lane: t::LaneDropLane::ContinuingSibling, feature: f, .. } if f == feature));
            let closes = terminating_rsl.as_ref().is_some_and(|rsl| {
                source_lanes.contains(rsl)
                    && (structurally_bound
                        || self.graph().lane_id(rsl).is_some_and(|lane| {
                            let reversed = self.graph().nominal_reversed(lane).unwrap_or(false);
                            self.graph()
                                .successors(simforge_core::map::DirectedLane::new(lane, reversed))
                                .iter()
                                .any(|n| target_lanes.contains(self.graph().rsl(n.lane)))
                        }))
            });
            if !closes {
                return Err(CompileError::at(
                    "terminating_lane_merge_unclosed",
                    format!("roles.{}.extensions.terminatingLaneFeature", role.base.id),
                    format!("terminating role \"{}\" does not reach the target route at mapped {feature}", role.base.id),
                )
                .with_detail(detail(&[
                    ("siteId", Value::String(self.site.site_id.clone())),
                    ("terminatingRsl", terminating_rsl.map_or(Value::Null, Value::String)),
                    ("sourceLanes", Value::Array(source_lanes.into_iter().map(Value::String).collect())),
                    ("targetRole", Value::String(target_role_id.to_owned())),
                    ("targetLanes", Value::Array(target_lanes.into_iter().map(Value::String).collect())),
                ]))
                .as_findings());
            }
        }
        Ok(())
    }

    /// A role-local path parallel to a concrete reference actor. Parking
    /// lanes are often not members of the corridor's integer lateral frame,
    /// so a `relative_to` bicycle beside a parked car derives its path from
    /// that actor's selected slot, pose and heading rather than a guessed
    /// `dLane`.
    fn relative_parallel_route_for(
        &mut self,
        role: &RoleBinding,
        scope: &ExprScope,
        path: &str,
    ) -> CompileResult<Option<Route>> {
        let RoleKind::RelativeTo { r#ref, ds_m, .. } = &role.kind else {
            return Ok(None);
        };
        if json_str(role.base.extensions.as_ref(), "pathSemantics")
            != Some("parallel_to_reference_actor")
        {
            return Ok(None);
        }
        let Some(reference) = self.actor(r#ref).cloned() else {
            return Err(CompileError::at(
                "role_reference_unmaterialized",
                format!("{path}.ref"),
                format!("relative path reference \"{}\" is not materialized", r#ref),
            )
            .with_detail(detail(&[
                ("role", Value::String(role.base.id.clone())),
                ("ref", Value::String(r#ref.clone())),
            ]))
            .as_findings());
        };
        let lateral_m = json_number(role.base.extensions.as_ref(), "lateralOffsetM").unwrap_or(0.0);
        let path_length_m = json_number(role.base.extensions.as_ref(), "pathLengthM")
            .unwrap_or(120.0)
            .max(20.0);
        let longitudinal_m = eval_num(Some(ds_m), scope, &format!("{path}.dsM"), Some(0.0))?;
        let reference_point = reference.initial.pose.position_local();
        let points: Vec<Vec2> = match (
            self.route_by_role.get(r#ref),
            self.spawn_s_by_role.get(r#ref),
        ) {
            (Some(route), Some(&spawn)) => {
                // Preserve the actual curvature of the selected reference route;
                // a tangent-only approximation can put a roadside barrier dozens
                // of metres from a vehicle following a bend.
                let spawn_pose = route.pose_at(spawn);
                let spawn_left = Vec2 {
                    x: -sin(spawn_pose.heading_rad),
                    y: cos(spawn_pose.heading_rad),
                };
                // A feature-bound actor can sit off its bound lane centre (a
                // parked car at tFrac=-1): preserve that slot offset first.
                let reference_lateral = (reference_point.x - spawn_pose.point.x) * spawn_left.x
                    + (reference_point.y - spawn_pose.point.y) * spawn_left.y;
                let total_lateral = reference_lateral + lateral_m;
                let count = ((path_length_m / 5.0).ceil() as usize + 1).max(2);
                (0..count)
                    .map(|index| {
                        let station =
                            spawn + longitudinal_m + (index as f64 * 5.0).min(path_length_m);
                        // Parking-zone fragments are commonly much shorter than
                        // the authored approach: extrapolate from endpoint
                        // tangents instead of clamping every sample.
                        let pose = if (0.0..=route.length_m()).contains(&station) {
                            route.pose_at(station)
                        } else {
                            let endpoint_s = if station < 0.0 { 0.0 } else { route.length_m() };
                            let endpoint = route.pose_at(endpoint_s);
                            let delta = station - endpoint_s;
                            simforge_core::map::RoutePose {
                                point: Vec2 {
                                    x: endpoint.point.x + cos(endpoint.heading_rad) * delta,
                                    y: endpoint.point.y + sin(endpoint.heading_rad) * delta,
                                },
                                ..endpoint
                            }
                        };
                        Vec2 {
                            x: pose.point.x - sin(pose.heading_rad) * total_lateral,
                            y: pose.point.y + cos(pose.heading_rad) * total_lateral,
                        }
                    })
                    .collect()
            }
            _ => {
                let h = reference.initial.pose.heading_rad;
                let forward = Vec2 {
                    x: cos(h),
                    y: sin(h),
                };
                let left = Vec2 {
                    x: -forward.y,
                    y: forward.x,
                };
                let start = Vec2 {
                    x: reference_point.x + forward.x * longitudinal_m + left.x * lateral_m,
                    y: reference_point.y + forward.y * longitudinal_m + left.y * lateral_m,
                };
                vec![
                    start,
                    Vec2 {
                        x: start.x + forward.x * path_length_m,
                        y: start.y + forward.y * path_length_m,
                    },
                ]
            }
        };
        let route = build_route_from_points(&points).ok_or_else(|| {
            CompileError::at(
                "route_unbuildable",
                path,
                format!(
                    "relative parallel path for \"{}\" is degenerate",
                    role.base.id
                ),
            )
        })?;
        self.notes.push(Note::info(format!("{path}.extensions.pathSemantics"), format!("parallel path resolved in {}'s selected local frame ({longitudinal_m:.1} m longitudinal, {lateral_m:.2} m left)", r#ref)));
        Ok(Some(route))
    }

    /// A pedestrian crossing is a freeform path *across* the carriageway,
    /// built from the crossing's matched station, perpendicular to the
    /// reference heading, spanning the real cross-section plus a kerb
    /// allowance at each end.
    fn crossing_route(
        &mut self,
        role: &RoleBinding,
        binding: &FeatureBinding,
        feature: &str,
        direction: t::CrossingDirection,
        start_frac: f64,
        path: &str,
    ) -> CompileResult<Option<(Route, f64)>> {
        // The feature match owns the crossing's station: keep route construction
        // and every feature PointRef on the same matched station.
        let frame_s = self
            .site
            .feature_matches
            .get(feature)
            .map(|m| m.s)
            .or_else(|| binding.pose.as_ref().map(|p| p.s))
            .unwrap_or(0.0);
        let at = self.frame_point(frame_s)?;
        let lane_rsl = binding
            .lane_rsl
            .clone()
            .unwrap_or_else(|| self.site.frame.entry_lane_rsl.clone());
        let width = self
            .bundle
            .index()
            .lanes
            .get(&lane_rsl)
            .map_or(3.5, |l| l.representative_width_m);
        let scope = self.base_scope(Some(&lane_rsl));
        let mut nx = -sin(at.heading_rad);
        let mut ny = cos(at.heading_rad);
        // Resolve the real lane centres at this station instead of estimating
        // the span from a lane count: parallel lanes can have independent
        // curvature, and a count-based span can stop short of the ego lane.
        let mut cross_section: Vec<Vec2> = Vec::new();
        for k in self
            .site
            .frame
            .lateral_lanes
            .keys()
            .copied()
            .collect::<Vec<_>>()
        {
            let pose = t::FramePose {
                lane_offset: k,
                s: NumberOrExpr::Number(frame_s),
                t_frac: t::TFrac::Number(0.0),
                heading_offset_rad: 0.0,
            };
            cross_section.push(
                self.frame_pose_point(&pose, &scope, &format!("{path}.crossSection.{k}"), 0.0)?
                    .point,
            );
        }
        for route in self.route_by_role.values().filter(|r| !r.is_freeform()) {
            let projected = route.project_point(at.point);
            if projected.d > 30.0 {
                continue;
            }
            cross_section.push(route.pose_at(projected.s).point);
        }
        let outer = cross_section
            .iter()
            .map(|p| (p, hypot(p.x - at.point.x, p.y - at.point.y)))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((point, distance)) = outer {
            if distance > 1.0 {
                nx = (point.x - at.point.x) / distance;
                ny = (point.y - at.point.y) / distance;
            }
        }
        let offsets: Vec<f64> = std::iter::once(0.0)
            .chain(
                cross_section
                    .iter()
                    .map(|p| (p.x - at.point.x) * nx + (p.y - at.point.y) * ny),
            )
            .collect();
        let opposing_allowance = self.site.frame.opposing_lanes.len() as f64 * width;
        let kerb_allowance_m = width / 2.0 + 3.0;
        let low = offsets.iter().copied().fold(-opposing_allowance, f64::min) - kerb_allowance_m;
        let high = offsets.iter().copied().fold(f64::NEG_INFINITY, f64::max) + kerb_allowance_m;
        let (from_offset, to_offset) = match direction {
            t::CrossingDirection::NearToFar => (low, high),
            t::CrossingDirection::FarToNear => (high, low),
        };
        let from = Vec2 {
            x: at.point.x + nx * from_offset,
            y: at.point.y + ny * from_offset,
        };
        let to = Vec2 {
            x: at.point.x + nx * to_offset,
            y: at.point.y + ny * to_offset,
        };
        let Some(built) = build_route_from_points(&[from, to]) else {
            self.notes
                .push(Note::loss(path, "could not build a crossing path"));
            return Ok(None);
        };
        let start_s = start_frac * built.length_m();
        let _ = role;
        Ok(Some((built, start_s)))
    }

    /// The polyline an actor's `route` interaction lays down at `t ≤ 0`, folded
    /// into the spawn route so the arrival solver can place the actor along
    /// it. Only the *first* such interaction is folded; a second one is a
    /// genuine mid-clip re-route and stays on the timeline.
    fn spawn_route_polyline_for(&mut self, role_id: &str) -> CompileResult<Option<Route>> {
        for it in &self.template.choreography.interactions {
            let (
                t::Verb::Route {
                    target: t::RouteTarget::Polyline { points },
                },
                t::Trigger::At { t: at },
            ) = (&it.verb, &it.base.trigger)
            else {
                continue;
            };
            if it.base.actor != role_id {
                continue;
            }
            let scope = self.base_scope(None);
            let t = eval_num(
                Some(at),
                &scope,
                &format!("choreography.{}.trigger.t", it.base.id),
                Some(0.0),
            )?;
            if t > 0.0 {
                continue;
            }
            let frame_s_offset = self.placement_feature_offset(
                role_id,
                &format!("roles.{role_id}.extensions.placementFeature"),
            );
            let mut world: Vec<Vec2> = Vec::with_capacity(points.len());
            for (idx, p) in points.iter().enumerate() {
                world.push(
                    self.frame_pose_point(
                        p,
                        &scope,
                        &format!("choreography.{}.target.points.{idx}", it.base.id),
                        frame_s_offset,
                    )?
                    .point,
                );
            }
            let Some(route) = build_route_from_points(&world) else {
                continue;
            };
            self.fold_initial(it, t);
            self.notes.push(Note::info(format!("choreography.interactions.{}", it.base.id), format!("route(polyline) at t={t} folded into {role_id}'s spawn route ({:.1} m), so the arrival solver can place the actor along it", route.length_m())));
            return Ok(Some(route));
        }
        Ok(None)
    }

    /// Exact Studio-authored map-bound route at `t = 0`, folded into the spawn.
    fn spawn_route_lane_path_for(&mut self, role_id: &str) -> CompileResult<Option<Vec<String>>> {
        for it in &self.template.choreography.interactions {
            let (
                t::Verb::Route {
                    target: t::RouteTarget::LanePath { lanes },
                },
                t::Trigger::At { t: at },
            ) = (&it.verb, &it.base.trigger)
            else {
                continue;
            };
            if it.base.actor != role_id {
                continue;
            }
            let t = eval_num(
                Some(at),
                &self.base_scope(None),
                &format!("choreography.{}.trigger.t", it.base.id),
                Some(0.0),
            )?;
            if t > 0.0 {
                continue;
            }
            self.fold_initial(it, t);
            self.notes.push(Note::info(format!("choreography.interactions.{}", it.base.id), format!("route(lanePath) at t={t} folded into {role_id}'s spawn route ({} connected lanes)", lanes.len())));
            return Ok(Some(lanes.clone()));
        }
        Ok(None)
    }

    fn fold_initial(&mut self, it: &t::Interaction, t: f64) {
        self.folded_interactions.insert(it.base.id.clone());
        self.folded_trigger_start.insert(it.base.id.clone(), t);
        if self
            .initial_interaction_outcomes
            .iter()
            .any(|o| o.interaction_id == it.base.id)
        {
            return;
        }
        self.initial_interaction_outcomes
            .push(InitialInteractionOutcome {
                interaction_id: it.base.id.clone(),
                actor_id: it.base.actor.clone(),
                verb: it.verb.name(),
                time_s: t,
                outcome: "executed",
                basis: "folded_initial_state",
            });
    }

    /// Initial `rules`, after folding `set rules.*` interactions at `t ≤ 0`.
    fn rules_for(&self, role_id: &str) -> sim::ActorRules {
        let role = self.role_by_id.get(role_id).copied();
        let mut rules = match role {
            Some(r) if supports_driver_profile(r.base.actor.class) => {
                profile_rules(r.base.driver_profile.unwrap_or_default())
            }
            _ => sim::ActorRules::default(),
        };
        if let Some(folded) = self.initial_rules.get(role_id) {
            for (key, value) in folded {
                apply_rule(&mut rules, *key, value);
            }
        }
        rules
    }

    fn driving_profile_for(&self, role_id: &str) -> Option<sim::DrivingProfile> {
        let role = self.role_by_id.get(role_id).copied()?;
        if !supports_driver_profile(role.base.actor.class) {
            return None;
        }
        let def = role.base.driver_profile.unwrap_or_default().definition();
        Some(sim::DrivingProfile {
            comfortable_lateral_acceleration_mps2: def.comfortable_lateral_acceleration_mps2,
            comfortable_deceleration_mps2: def.comfortable_deceleration_mps2,
        })
    }

    fn fold_initial_rules(&mut self) -> CompileResult<()> {
        for it in &self.template.choreography.interactions {
            let (t::Verb::Set { target }, t::Trigger::At { t: at }) = (&it.verb, &it.base.trigger)
            else {
                continue;
            };
            let scope = self.scope_for(&it.base.actor);
            let t = eval_num(
                Some(at),
                &scope,
                &format!("choreography.{}.trigger.t", it.base.id),
                Some(0.0),
            )?;
            if t > 0.0 {
                continue;
            }
            let Some(sim::SetKey::Rule(key)) = sim::SetKey::parse(&target.key) else {
                continue;
            };
            let value = set_value(&target.value);
            if matches!(value, sim::SetValue::Text(_)) {
                continue;
            }
            self.initial_rules
                .entry(it.base.actor.clone())
                .or_default()
                .push((key, value));
            self.fold_initial(it, t);
        }
        Ok(())
    }

    /* ---------------------------------------------------------- the timeline */

    fn build_interactions(&mut self) -> CompileResult<()> {
        for it in &self.template.choreography.interactions {
            if self.folded_interactions.contains(&it.base.id) {
                continue;
            }
            if let t::Verb::Route {
                target: target @ t::RouteTarget::NearMiss { .. },
            } = &it.verb
            {
                let built = self.build_near_miss_interactions(it, target)?;
                self.interactions.extend(built);
                continue;
            }
            if let Some(built) = self.build_interaction(it)? {
                self.interactions.push(built);
            }
        }
        let (kept, removed) =
            prune_dangling_after_interactions(std::mem::take(&mut self.interactions));
        self.interactions = kept;
        for removal in removed {
            self.notes.push(Note::loss(
                format!("choreography.interactions.{}", removal.interaction_id),
                format!("command removed during concrete normalization because after({}) no longer has a materialized source interaction", removal.missing_interaction_id),
            ));
        }
        Ok(())
    }

    fn spawn_time(&self, actor: &SimActor) -> CompileResult<f64> {
        if actor.present_at_start {
            return Ok(0.0);
        }
        for it in &self.template.choreography.interactions {
            let (t::Verb::Exist { target }, t::Trigger::At { t: at }) =
                (&it.verb, &it.base.trigger)
            else {
                continue;
            };
            if it.base.actor == actor.id && target.state == t::ExistState::Present {
                return Ok(eval_num(
                    Some(at),
                    &self.scope_for(&actor.id),
                    &format!("choreography.{}.trigger.t", it.base.id),
                    None,
                )?
                .max(0.0));
            }
        }
        Ok(f64::INFINITY)
    }

    /// Resolve semantic near-miss intent against the target's concrete route.
    fn build_near_miss_interactions(
        &mut self,
        it: &t::Interaction,
        goal: &t::RouteTarget,
    ) -> CompileResult<Vec<sim::Interaction>> {
        let t::RouteTarget::NearMiss {
            target: target_id,
            clearance_m,
            pass,
            min_speed_kph,
            max_speed_kph,
            deadline_s,
        } = goal
        else {
            return Ok(Vec::new());
        };
        let path = format!("choreography.interactions.{}", it.base.id);
        let unavailable = |reason: &str, at: &str| {
            CompileError::at(
                "near_miss_actor_unavailable",
                format!("{path}.{at}"),
                reason,
            )
            .as_findings()
        };
        let (Some(pedestrian), Some(target), Some(target_route)) = (
            self.actor(&it.base.actor).cloned(),
            self.actor(target_id).cloned(),
            self.route_by_role.get(target_id),
        ) else {
            return Err(unavailable(
                "near-miss pedestrian or target has no concrete actor/route at this site",
                "target",
            ));
        };
        if pedestrian.kind != sim::ActorKind::Pedestrian {
            return Err(unavailable(
                "near-miss pedestrian or target has no concrete actor/route at this site",
                "target",
            ));
        }
        let scope = self.scope_for(&it.base.actor);
        let clip_seconds = self.template.choreography.clip_seconds;
        let target_spawn_s = self.spawn_time(&target)?;
        let pedestrian_spawn_s = self.spawn_time(&pedestrian)?;
        if !target_spawn_s.is_finite() || !pedestrian_spawn_s.is_finite() {
            return Err(unavailable(
                "near-miss actors must have a deterministic initial or at(t) spawn",
                "target",
            ));
        }
        let target_start = target_route
            .project_point(target.initial.pose.position_local())
            .s;
        let target_scope = self.scope_for(&target.id);
        let mut speed_events: Vec<(f64, &t::SpeedTarget)> = Vec::new();
        for candidate in &self.template.choreography.interactions {
            let (t::Verb::Speed { target: st, .. }, t::Trigger::At { t: at }) =
                (&candidate.verb, &candidate.base.trigger)
            else {
                continue;
            };
            if candidate.base.actor != target.id {
                continue;
            }
            speed_events.push((
                eval_num(
                    Some(at),
                    &target_scope,
                    &format!("choreography.{}.trigger.t", candidate.base.id),
                    None,
                )?,
                st,
            ));
        }
        speed_events.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut speed = target.initial.speed_mps;
        let mut route_s = target_start;
        let mut event_index = 0;
        let mut trajectory: Vec<TimedTrajectoryPoint> = Vec::new();
        let first_tick = (target_spawn_s * NEAR_MISS_SAMPLE_HZ).ceil() as i64;
        let last_tick = (clip_seconds * NEAR_MISS_SAMPLE_HZ).ceil() as i64;
        let speed_path = format!("{path}.targetTrajectory.speed");
        for tick in first_tick..=last_tick {
            let t = (tick as f64 / NEAR_MISS_SAMPLE_HZ).min(clip_seconds);
            while event_index < speed_events.len() && speed_events[event_index].0 <= t + 1e-9 {
                speed = match speed_events[event_index].1 {
                    t::SpeedTarget::Stop => 0.0,
                    t::SpeedTarget::Absolute { value_kph } => {
                        (eval_num(Some(value_kph), &scope, &speed_path, None)? * KPH_TO_MPS)
                            .max(0.0)
                    }
                    t::SpeedTarget::Delta { delta_kph } => (speed
                        + eval_num(Some(delta_kph), &scope, &speed_path, None)? * KPH_TO_MPS)
                        .max(0.0),
                    t::SpeedTarget::Factor { factor } => {
                        (speed * eval_num(Some(factor), &scope, &speed_path, None)?).max(0.0)
                    }
                    t::SpeedTarget::Match { .. } | t::SpeedTarget::Resume => speed,
                };
                event_index += 1;
            }
            let pose = target_route.pose_at(route_s);
            let scene = to_scene_xz(pose.point);
            trajectory.push(TimedTrajectoryPoint {
                t,
                x: scene.x,
                z: scene.z,
                heading_rad: Some(-pose.heading_rad),
            });
            route_s = (route_s + speed / NEAR_MISS_SAMPLE_HZ).min(target_route.length_m());
        }
        let ped_start = pedestrian.initial.pose;
        let radii = hypot(pedestrian.dims.l, pedestrian.dims.w) / 2.0
            + hypot(target.dims.l, target.dims.w) / 2.0;
        let trigger_time: Option<f64> =
            match &it.base.trigger {
                t::Trigger::At { t: at } => Some(pedestrian_spawn_s.max(target_spawn_s).max(
                    eval_num(Some(at), &scope, &format!("{path}.trigger.t"), None)?,
                )),
                t::Trigger::When {
                    condition:
                        t::Condition::Leaf(t::LeafCondition::Distance {
                            from,
                            to: t::PointRef::Role { role },
                            op,
                            value_m,
                            hysteresis_m,
                            ..
                        }),
                    ..
                } => {
                    let pair_matches = (from == &target.id && role == &pedestrian.id)
                        || (from == &pedestrian.id && role == &target.id);
                    if !pair_matches {
                        None
                    } else {
                        let value = eval_num(
                            Some(value_m),
                            &scope,
                            &format!("{path}.trigger.condition.valueM"),
                            None,
                        )?
                        .max(0.0);
                        let band = match hysteresis_m {
                            Some(h) => eval_num(
                                Some(h),
                                &scope,
                                &format!("{path}.trigger.condition.hysteresisM"),
                                None,
                            )?
                            .max(0.0),
                            None => 0.0,
                        };
                        let threshold = if matches!(op, t::CompareOp::Lt | t::CompareOp::Lte) {
                            (value - band).max(0.0)
                        } else {
                            value + band
                        };
                        trajectory
                            .iter()
                            .find(|s| {
                                if s.t < pedestrian_spawn_s {
                                    return false;
                                }
                                let gap =
                                    (hypot(s.x - ped_start.x, s.z - ped_start.z) - radii).max(0.0);
                                match op {
                                    t::CompareOp::Lt => gap < threshold,
                                    t::CompareOp::Lte => gap <= threshold,
                                    t::CompareOp::Gt => gap > threshold,
                                    t::CompareOp::Gte => gap >= threshold,
                                }
                            })
                            .map(|s| s.t)
                    }
                }
                t::Trigger::When {
                    condition:
                        t::Condition::Leaf(t::LeafCondition::Ttc {
                            of,
                            to,
                            op,
                            value_s,
                        }),
                    ..
                } if (of == &target.id && to == &pedestrian.id)
                    || (of == &pedestrian.id && to == &target.id) =>
                {
                    let threshold = eval_num(
                        Some(value_s),
                        &scope,
                        &format!("{path}.trigger.condition.valueS"),
                        None,
                    )?
                    .max(0.0);
                    let mut found = None;
                    for pair in trajectory.windows(2) {
                        let (sample, next) = (pair[0], pair[1]);
                        if sample.t < pedestrian_spawn_s {
                            continue;
                        }
                        let vx = (next.x - sample.x) * NEAR_MISS_SAMPLE_HZ;
                        let vz = (next.z - sample.z) * NEAR_MISS_SAMPLE_HZ;
                        let dx = ped_start.x - sample.x;
                        let dz = ped_start.z - sample.z;
                        let speed2 = vx * vx + vz * vz;
                        if speed2 <= 1e-9 {
                            continue;
                        }
                        let approaching = (dx * vx + dz * vz) / speed2;
                        let (cx, cz) = (dx - vx * approaching, dz - vz * approaching);
                        let closest2 = cx * cx + cz * cz;
                        if approaching < 0.0 || closest2 > radii * radii {
                            continue;
                        }
                        let ttc = (approaching
                            - ((radii * radii - closest2).max(0.0) / speed2).sqrt())
                        .max(0.0);
                        let matched = match op {
                            t::CompareOp::Lt => ttc < threshold,
                            t::CompareOp::Lte => ttc <= threshold,
                            t::CompareOp::Gt => ttc > threshold,
                            t::CompareOp::Gte => ttc >= threshold,
                        };
                        if matched {
                            found = Some(sample.t);
                            break;
                        }
                    }
                    found
                }
                _ => None,
            };
        let Some(trigger_time) = trigger_time else {
            return Err(CompileError::at(
                "near_miss_trigger_unresolved",
                format!("{path}.trigger"),
                "near-miss trigger cannot be resolved against the canonical target trajectory",
            )
            .as_findings());
        };
        let deadline = match (deadline_s, &it.base.trigger) {
            (Some(d), _) => eval_num(Some(d), &scope, &format!("{path}.target.deadlineS"), None)?,
            (
                None,
                t::Trigger::When {
                    by_latest: Some(b), ..
                },
            ) => eval_num(Some(b), &scope, &format!("{path}.trigger.byLatest"), None)?,
            _ => clip_seconds,
        };
        let request = PedestrianNearMissRequest {
            pedestrian_id: &pedestrian.id,
            target_id: &target.id,
            pedestrian_start: sim::ScenePoint {
                x: ped_start.x,
                z: ped_start.z,
            },
            pedestrian_dims: pedestrian.dims,
            target_trajectory: &trajectory,
            target_dims: target.dims,
            trigger_time_s: trigger_time,
            deadline_s: deadline,
            clearance_m: Some(
                eval_num(
                    Some(clearance_m),
                    &scope,
                    &format!("{path}.target.clearanceM"),
                    None,
                )?
                .max(0.01),
            ),
            pass: match pass {
                t::NearMissPass::Front => NearMissPass::Front,
                t::NearMissPass::Behind => NearMissPass::Behind,
                t::NearMissPass::Auto => NearMissPass::Auto,
            },
            min_speed_mps: Some(
                (eval_num(
                    Some(min_speed_kph),
                    &scope,
                    &format!("{path}.target.minSpeedKph"),
                    None,
                )? * KPH_TO_MPS)
                    .max(0.1),
            ),
            max_speed_mps: Some(
                (eval_num(
                    Some(max_speed_kph),
                    &scope,
                    &format!("{path}.target.maxSpeedKph"),
                    None,
                )? * KPH_TO_MPS)
                    .max(0.1),
            ),
            tolerance_m: None,
        };
        let solution = solve_pedestrian_near_miss(&request).map_err(|d| {
            let mut e = CompileError::at(
                serde_json::to_value(d.code)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "near_miss_unsolvable".to_owned()),
                format!("{path}.target"),
                d.message,
            )
            .as_findings();
            e.detail = d.detail;
            e
        })?;
        let trigger = self
            .build_trigger(&it.base.trigger, &scope, &format!("{path}.trigger"), 0.0)?
            .ok_or_else(|| {
                CompileError::at(
                    "near_miss_trigger_unresolved",
                    format!("{path}.trigger"),
                    "near-miss trigger did not materialize",
                )
                .as_findings()
            })?;
        let route = sim::Interaction {
            id: it.base.id.clone(),
            actor_id: pedestrian.id.clone(),
            trigger: trigger.clone(),
            window: None,
            until: None,
            verb: sim::Verb::Route {
                target: sim::RouteActionTarget::Spec(sim::RouteSpec::Polyline {
                    points: solution.points.to_vec(),
                }),
                join_from_current_pose: None,
                best_effort_world_path: None,
            },
        };
        let walking = sim::Interaction {
            id: format!("{}__speed", it.base.id),
            actor_id: pedestrian.id.clone(),
            trigger,
            window: None,
            until: None,
            verb: sim::Verb::Speed {
                target: sim::SpeedTarget::Absolute {
                    value: solution.speed_mps,
                },
                dynamics: sim::Dynamics {
                    shape: sim::DynamicsShape::Linear,
                    constraint: sim::DynamicsConstraint::Time,
                    value: 0.1,
                },
            },
        };
        self.notes.push(Note::info(
            format!("{path}.target"),
            format!(
                "near miss re-solved: {}, {:.3} m clearance, {:.3} m/s, plan {}",
                solution.pass.as_str(),
                solution.predicted_clearance_m,
                solution.speed_mps,
                solution.plan_hash
            ),
        ));
        self.near_miss_criteria.push(sim::NearMissCriterion {
            interaction_id: it.base.id.clone(),
            pedestrian_id: pedestrian.id.clone(),
            target_id: target.id.clone(),
            clearance_m: solution.requested_clearance_m,
            tolerance_m: 0.15,
            pass: solution.pass,
            plan_hash: solution.plan_hash.clone(),
            predicted_closest_approach_s: solution.closest_approach_time_s,
            predicted_time_gap_s: solution.predicted_time_gap_s,
        });
        Ok(vec![route, walking])
    }

    /// Bind portable control stop lines onto concrete lateral lanes.
    fn build_traffic_controls(&mut self) -> CompileResult<()> {
        let scope = self.base_scope(None);
        for control in &self.template.traffic_controls {
            let base = format!("trafficControls.{}", control.id);
            let mut stop_lines = Vec::with_capacity(control.stop_lines.len());
            for (index, line) in control.stop_lines.iter().enumerate() {
                let feature_offset = match &line.feature {
                    Some(feature) => self
                        .site
                        .feature_matches
                        .get(feature)
                        .map(|m| m.s)
                        .ok_or_else(|| {
                            CompileError::at(
                                "control_feature_unbound",
                                format!("{base}.stopLines.{index}.feature"),
                                format!(
                                    "traffic control \"{}\" references an unbound feature",
                                    control.id
                                ),
                            )
                            .as_findings()
                        })?,
                    None => 0.0,
                };
                let frame_s = feature_offset
                    + eval_num(
                        Some(&line.pose.s),
                        &scope,
                        &format!("{base}.stopLines.{index}.pose.s"),
                        None,
                    )?;
                let Some(lane_rsl) = self.site.frame.lateral_rsl(line.pose.lane_offset) else {
                    return Err(CompileError::at(
                        "control_lane_unbound",
                        format!("{base}.stopLines.{index}.pose.laneOffset"),
                        format!(
                            "traffic control \"{}\" has no lane at offset {}",
                            control.id, line.pose.lane_offset
                        ),
                    )
                    .as_findings());
                };
                let point = self.frame_point(frame_s)?.point;
                let Some(lane) = self.graph().lane_id(lane_rsl) else {
                    return Err(CompileError::at(
                        "control_stop_line_unprojectable",
                        format!("{base}.stopLines.{index}"),
                        format!(
                            "traffic control \"{}\" stop line cannot project onto {lane_rsl}",
                            control.id
                        ),
                    )
                    .as_findings());
                };
                let projected = self.graph().project_onto(lane, point);
                stop_lines.push(sim::StopLine {
                    rsl: lane_rsl.to_owned(),
                    s: projected.s,
                    connecting_lane_rsls: Vec::new(),
                });
            }
            let mut phases = Vec::with_capacity(control.phases.len());
            for (index, phase) in control.phases.iter().enumerate() {
                phases.push(sim::SignalPhase {
                    phase: phase.indication,
                    duration_s: eval_num(
                        Some(&phase.duration_s),
                        &scope,
                        &format!("{base}.phases.{index}.durationS"),
                        None,
                    )?,
                });
            }
            let dark_dwell_s = eval_num(
                Some(&control.dark_dwell_s),
                &scope,
                &format!("{base}.darkDwellS"),
                Some(1.0),
            )?;
            self.authored_control_programs.push(sim::SignalProgram {
                id: format!("control:{}", control.id),
                phases,
                offset_s: eval_num(
                    Some(&control.offset_s),
                    &scope,
                    &format!("{base}.offsetS"),
                    Some(0.0),
                )?,
                loop_: control.r#loop,
                dark_fallback: (control.dark_fallback != sim::DarkFallback::AllWayStop)
                    .then_some(control.dark_fallback),
                dark_dwell_s: (dark_dwell_s != 1.0).then_some(dark_dwell_s),
                stop_lines,
                map_binding: None,
            });
        }
        Ok(())
    }

    /// Engine signal ids owned by `@world set(signal:*.phase)` interactions.
    fn world_signal_set_ids(&self, programs: &[sim::SignalProgram]) -> Vec<String> {
        let mut ids = BTreeSet::new();
        let view = self.bundle.signal_view();
        for it in &self.template.choreography.interactions {
            let t::Verb::Set { target } = &it.verb else {
                continue;
            };
            if it.base.actor != t::WORLD_ROLE_REF {
                continue;
            }
            if let Some((feature, approach)) = semantic_signal_key(&target.key) {
                if let Some(plan) = &self.signal_plan {
                    if let Some(id) = resolve_site_signal_program(
                        &view,
                        self.site,
                        plan,
                        &SiteSignalRef::Feature {
                            feature_id: feature,
                            approach,
                        },
                    ) {
                        ids.insert(id);
                    }
                }
                continue;
            }
            let Some(handle) = direct_signal_key(&target.key) else {
                continue;
            };
            if let Some(program) = programs.iter().find(|p| {
                p.id == handle
                    || p.map_binding
                        .as_ref()
                        .is_some_and(|b| b.head_ids.iter().any(|h| h == handle))
            }) {
                ids.insert(program.id.clone());
            }
        }
        ids.into_iter().collect()
    }

    fn compile_authored_map_signals(&mut self) -> CompileResult<()> {
        if self.template.map_signal_plans.is_empty() {
            return Ok(());
        }
        let controls = build_map_control_plan(&self.bundle.signal_view());
        let world_ids = self.world_signal_set_ids(&controls.signal_programs);
        let compiled = compile_map_signal_plans(
            &controls.signal_programs,
            &self.template.map_signal_plans,
            &CompileMapSignalPlansOptions {
                map_id: self.bundle.map_id(),
                clip_seconds: self.template.choreography.clip_seconds,
                warmup_seconds: self.template.choreography.warmup_seconds,
                signal_catalog: self.bundle.signal_catalog(),
                world_signal_set_ids: &world_ids,
            },
        )
        .map_err(CompileError::as_findings)?;
        self.compiled_map_signal_programs = Some(compiled);
        self.notes.push(Note::info("mapSignalPlans", format!("{} physical junction signal plan(s) compiled into complete warm-up and clip-bounded programs", self.template.map_signal_plans.len())));
        Ok(())
    }

    fn dynamics(
        &self,
        it: &t::Interaction,
        dynamics: Option<&t::Dynamics>,
        scope: &ExprScope,
        path: &str,
    ) -> CompileResult<sim::Dynamics> {
        let Some(d) = dynamics else {
            return Err(CompileError::at(
                "dynamics_required",
                format!("{path}.dynamics"),
                format!("{} requires dynamics", it.verb.name()),
            )
            .as_findings());
        };
        Ok(sim::Dynamics {
            shape: dynamics_shape(d.shape),
            constraint: dynamics_constraint(d.constraint),
            value: eval_num(
                Some(&d.value),
                scope,
                &format!("{path}.dynamics.value"),
                None,
            )?,
        })
    }

    fn lateral_dynamics(
        &self,
        it: &t::Interaction,
        dynamics: Option<&t::Dynamics>,
        duration: Option<&NumberOrExpr>,
        style: Option<t::ManeuverStyle>,
        scope: &ExprScope,
        path: &str,
    ) -> CompileResult<sim::Dynamics> {
        let plain = self.dynamics(it, dynamics, scope, path)?;
        let Some(duration) = duration else {
            return Ok(plain);
        };
        // Every style remains subject to the engine's physical envelopes:
        // cautious eases in/out most, assertive tracks a more direct profile.
        let shape = match style.unwrap_or(t::ManeuverStyle::Normal) {
            t::ManeuverStyle::Cautious => sim::DynamicsShape::Sinusoidal,
            t::ManeuverStyle::Assertive => sim::DynamicsShape::Linear,
            t::ManeuverStyle::Normal => sim::DynamicsShape::Cubic,
        };
        Ok(sim::Dynamics {
            shape,
            constraint: sim::DynamicsConstraint::Time,
            value: eval_num(
                Some(duration),
                scope,
                &format!("{path}.maneuverDurationS"),
                None,
            )?,
        })
    }

    fn build_interaction(
        &mut self,
        it: &t::Interaction,
    ) -> CompileResult<Option<sim::Interaction>> {
        let path = format!("choreography.interactions.{}", it.base.id);
        let is_world = it.base.actor == t::WORLD_ROLE_REF;
        if !is_world && self.actor(&it.base.actor).is_none() {
            self.notes.push(Note::loss(
                &path,
                format!(
                    "actor \"{}\" is not present at this site; interaction dropped",
                    it.base.actor
                ),
            ));
            return Ok(None);
        }
        let scope = self.scope_for(&it.base.actor);
        let frame_s_offset = self.placement_feature_offset(
            &it.base.actor,
            &format!("roles.{}.extensions.placementFeature", it.base.actor),
        );
        let Some(trigger) = self.build_trigger(
            &it.base.trigger,
            &scope,
            &format!("{path}.trigger"),
            frame_s_offset,
        )?
        else {
            return Ok(None);
        };
        let until = match &it.base.until {
            Some(t::Trigger::When { condition, .. }) => {
                self.build_condition(condition, &scope, &format!("{path}.until.condition"))?
            }
            _ => None,
        };
        // Studio clip bounds form a half-open eligibility window; a continuous
        // command that fires inside it completes according to its own dynamics.
        let window_start_s = match &it.base.trigger {
            t::Trigger::At { t: at } => {
                eval_num(Some(at), &scope, &format!("{path}.trigger.t"), None)?
            }
            _ => 0.0,
        };
        let window_end_s = match (&it.base.until, &it.base.trigger) {
            (Some(t::Trigger::At { t: at }), _) => Some(eval_num(
                Some(at),
                &scope,
                &format!("{path}.until.t"),
                None,
            )?),
            (
                _,
                t::Trigger::When {
                    by_latest: Some(b), ..
                },
            ) => Some(eval_num(
                Some(b),
                &scope,
                &format!("{path}.trigger.byLatest"),
                None,
            )?),
            _ => None,
        };
        let window = window_end_s.map(|end_s| sim::InteractionWindow {
            start_s: window_start_s,
            end_s,
        });
        // Engine interactions remain actor-addressed; world state uses the
        // first concrete actor as an event carrier while the key is global.
        let actor_id: Id = if is_world {
            self.actors[0].id.clone()
        } else {
            it.base.actor.clone()
        };
        let make = |verb: sim::Verb| sim::Interaction {
            id: it.base.id.clone(),
            actor_id: actor_id.clone(),
            trigger: trigger.clone(),
            window,
            until: until.clone(),
            verb,
        };

        let verb = match &it.verb {
            t::Verb::Speed { target, dynamics } => {
                let tp = format!("{path}.target");
                let target = match target {
                    t::SpeedTarget::Absolute { value_kph } => sim::SpeedTarget::Absolute {
                        value: (eval_num(
                            Some(value_kph),
                            &scope,
                            &format!("{tp}.valueKph"),
                            None,
                        )? * KPH_TO_MPS)
                            .max(0.0),
                    },
                    t::SpeedTarget::Delta { delta_kph } => sim::SpeedTarget::Delta {
                        value: eval_num(Some(delta_kph), &scope, &format!("{tp}.deltaKph"), None)?
                            * KPH_TO_MPS,
                    },
                    t::SpeedTarget::Factor { factor } => sim::SpeedTarget::Factor {
                        value: eval_num(Some(factor), &scope, &format!("{tp}.factor"), None)?
                            .max(0.0),
                    },
                    t::SpeedTarget::Match { role, offset_kph } => sim::SpeedTarget::Match {
                        actor_id: role.clone(),
                        offset_mps: eval_num(
                            offset_kph.as_ref(),
                            &scope,
                            &format!("{tp}.offsetKph"),
                            Some(0.0),
                        )? * KPH_TO_MPS,
                    },
                    t::SpeedTarget::Stop => sim::SpeedTarget::Stop,
                    t::SpeedTarget::Resume => {
                        // The longitudinal controller is command-owned, so a
                        // resume must actively replace the previous stop:
                        // resolve to the role's authored cruise speed, or the
                        // bound lane limit when the actor starts at rest.
                        let fallback = scope.lane_speed_limit_kph.unwrap_or(30.0);
                        let kph = eval_num(
                            self.role_by_id
                                .get(it.base.actor.as_str())
                                .and_then(|r| r.base.initial_speed_kph.as_ref()),
                            &scope,
                            &format!("{tp}.resumeSpeedKph"),
                            Some(fallback),
                        )?;
                        self.notes.push(Note::info(
                            &path,
                            "speed(resume) materialized to the actor route-cruise speed",
                        ));
                        sim::SpeedTarget::Absolute {
                            value: (kph * KPH_TO_MPS).max(0.0),
                        }
                    }
                };
                sim::Verb::Speed {
                    target,
                    dynamics: self.dynamics(it, dynamics.as_ref(), &scope, &path)?,
                }
            }
            t::Verb::Gap { target, dynamics } => sim::Verb::Gap {
                target: sim::GapTarget {
                    actor_id: target.role.clone(),
                },
                value: eval_num(
                    Some(&target.value),
                    &scope,
                    &format!("{path}.target.value"),
                    None,
                )?
                .max(0.01),
                mode: match target.unit {
                    t::GapUnit::Time => sim::GapMode::Time,
                    t::GapUnit::Distance => sim::GapMode::Distance,
                },
                dynamics: self.dynamics(it, dynamics.as_ref(), &scope, &path)?,
            },
            t::Verb::ChangeLane {
                target,
                dynamics,
                maneuver_duration_s,
                maneuver_style,
            } => {
                let target = match target {
                    t::LaneTarget::Relative { dk } => {
                        if *dk == 0 {
                            self.notes.push(Note::info(
                                &path,
                                "changeLane with dk = 0 is a no-op; interaction dropped",
                            ));
                            return Ok(None);
                        }
                        let count = dk.unsigned_abs().min(u8::MAX as u32) as u8;
                        if *dk > 0 {
                            sim::LaneChangeTarget::Left { count }
                        } else {
                            sim::LaneChangeTarget::Right { count }
                        }
                    }
                    t::LaneTarget::Absolute { k } => match self.site.frame.lateral_rsl(*k) {
                        Some(rsl) => sim::LaneChangeTarget::Lane {
                            rsl: rsl.to_owned(),
                        },
                        None => {
                            self.notes.push(Note::loss(
                                &path,
                                format!("no lane at k = {k} at this site; interaction dropped"),
                            ));
                            return Ok(None);
                        }
                    },
                    t::LaneTarget::ToRole { role } => sim::LaneChangeTarget::ActorLane {
                        actor_id: role.clone(),
                    },
                };
                sim::Verb::ChangeLane {
                    target,
                    dynamics: self.lateral_dynamics(
                        it,
                        dynamics.as_ref(),
                        maneuver_duration_s.as_ref(),
                        *maneuver_style,
                        &scope,
                        &path,
                    )?,
                }
            }
            t::Verb::LaneOffset {
                target,
                dynamics,
                maneuver_duration_s,
                maneuver_style,
            } => sim::Verb::LaneOffset {
                target: sim::LaneOffsetTarget {
                    mode: sim::LaneOffsetMode::Fraction,
                    value: eval_num(
                        Some(&target.t_frac),
                        &scope,
                        &format!("{path}.target.tFrac"),
                        None,
                    )?,
                },
                dynamics: self.lateral_dynamics(
                    it,
                    dynamics.as_ref(),
                    maneuver_duration_s.as_ref(),
                    *maneuver_style,
                    &scope,
                    &path,
                )?,
            },
            t::Verb::Route { target } => match self.build_route_verb(it, target, &scope, &path)? {
                Some(v) => v,
                None => return Ok(None),
            },
            t::Verb::Exist { target } => sim::Verb::Exist {
                target: sim::ExistTarget {
                    state: match target.state {
                        t::ExistState::Present => sim::ExistState::Present,
                        t::ExistState::Absent => sim::ExistState::Absent,
                    },
                },
            },
            t::Verb::Set { target } => {
                let key = if let Some(id) = control_key(&target.key) {
                    if !self.template.traffic_controls.iter().any(|c| c.id == id) {
                        return Err(CompileError::at(
                            "control_unbound",
                            format!("{path}.target.key"),
                            format!("set() references unknown traffic control \"{id}\""),
                        )
                        .as_findings());
                    }
                    format!("signal:control:{id}.phase")
                } else if let Some((feature, approach)) = semantic_signal_key(&target.key) {
                    let program = self.resolve_signal_program(
                        &t::SignalRef::Feature {
                            feature: feature.to_owned(),
                            approach,
                        },
                        &format!("{path}.target"),
                    )?;
                    format!("signal:{program}.phase")
                } else if let Some(handle) = direct_signal_key(&target.key) {
                    let program = self.resolve_signal_program(
                        &t::SignalRef::Handle {
                            handle: handle.to_owned(),
                        },
                        &format!("{path}.target"),
                    )?;
                    format!("signal:{program}.phase")
                } else {
                    match map_set_key(&target.key) {
                        Some(k) => k,
                        None => {
                            self.notes.push(Note::loss(
                                format!("{path}.target.key"),
                                format!(
                                    "set key \"{}\" has no engine counterpart; interaction dropped",
                                    target.key
                                ),
                            ));
                            return Ok(None);
                        }
                    }
                };
                let Some(key) = sim::SetKey::parse(&key) else {
                    self.notes.push(Note::loss(
                        format!("{path}.target.key"),
                        format!("set key \"{key}\" has no engine counterpart; interaction dropped"),
                    ));
                    return Ok(None);
                };
                sim::Verb::Set {
                    target: sim::SetTarget {
                        key,
                        value: set_value(&target.value),
                    },
                }
            }
        };
        Ok(Some(make(verb)))
    }

    fn build_route_verb(
        &mut self,
        it: &t::Interaction,
        target: &t::RouteTarget,
        scope: &ExprScope,
        path: &str,
    ) -> CompileResult<Option<sim::Verb>> {
        let spec = |spec: sim::RouteSpec| sim::Verb::Route {
            target: sim::RouteActionTarget::Spec(spec),
            join_from_current_pose: None,
            best_effort_world_path: None,
        };
        Ok(Some(match target {
            t::RouteTarget::NextJunction { turn } => {
                let actor = self.actor(&it.base.actor).ok_or_else(|| {
                    CompileError::at(
                        "route_turn_unbindable",
                        format!("{path}.target"),
                        format!(
                            "next-junction route for \"{}\" needs a lane-bound actor",
                            it.base.actor
                        ),
                    )
                })?;
                if actor.initial.lane_ref.is_none() {
                    return Err(CompileError::at(
                        "route_turn_unbindable",
                        format!("{path}.target"),
                        format!(
                            "next-junction route for \"{}\" needs a lane-bound actor",
                            it.base.actor
                        ),
                    ));
                }
                let distance = (actor.initial.speed_mps
                    * (self.template.choreography.clip_seconds
                        + self.template.choreography.warmup_seconds)
                    * 1.6)
                    .max(100.0);
                sim::Verb::Route {
                    target: sim::RouteActionTarget::NextJunction {
                        turn: match turn {
                            t::NextJunctionTurn::Straight => sim::TurnRelation::Straight,
                            t::NextJunctionTurn::Left => sim::TurnRelation::Left,
                            t::NextJunctionTurn::Right => sim::TurnRelation::Right,
                        },
                        max_length_m: distance,
                    },
                    join_from_current_pose: None,
                    best_effort_world_path: None,
                }
            }
            t::RouteTarget::LanePath { lanes } => spec(sim::RouteSpec::LanePath {
                lanes: lanes.clone(),
            }),
            t::RouteTarget::Polyline { points } => {
                let mut out = Vec::with_capacity(points.len());
                for (idx, p) in points.iter().enumerate() {
                    out.push(scene_point(
                        self.frame_pose_point(
                            p,
                            scope,
                            &format!("{path}.target.points.{idx}"),
                            0.0,
                        )?
                        .point,
                    ));
                }
                spec(sim::RouteSpec::Polyline { points: out })
            }
            t::RouteTarget::CustomRoute { points } => sim::Verb::Route {
                target: sim::RouteActionTarget::Spec(sim::RouteSpec::Polyline {
                    points: points
                        .iter()
                        .map(|p| sim::ScenePoint { x: p.x, z: p.z })
                        .collect(),
                }),
                join_from_current_pose: Some(true),
                best_effort_world_path: Some(true),
            },
            t::RouteTarget::CustomTimedRoute { points } => sim::Verb::Route {
                target: sim::RouteActionTarget::Spec(sim::RouteSpec::TimedPolyline {
                    points: points
                        .iter()
                        .map(|p| sim::TimedPoint {
                            time_s: p.time_s,
                            x: p.x,
                            z: p.z,
                        })
                        .collect(),
                }),
                join_from_current_pose: None,
                best_effort_world_path: Some(true),
            },
            t::RouteTarget::Turn { feature, turn } => {
                let matched = self.site.feature_matches.get(feature);
                let actor = self.actor(&it.base.actor);
                let (Some(matched), Some(actor)) = (matched, actor) else {
                    return Err(CompileError::at(
                        "route_turn_unbindable",
                        format!("{path}.target"),
                        format!(
                            "turn route for \"{}\" is not backed by a concrete lane path",
                            it.base.actor
                        ),
                    )
                    .with_detail(detail(&[
                        ("feature", Value::String(feature.clone())),
                        ("turn", Value::String(turn.as_str().to_owned())),
                    ])));
                };
                let sim::RouteSpec::LanePath { .. } = &actor.behavior.route else {
                    return Err(CompileError::at(
                        "route_turn_unbindable",
                        format!("{path}.target"),
                        format!(
                            "turn route for \"{}\" is not backed by a concrete lane path",
                            it.base.actor
                        ),
                    )
                    .with_detail(detail(&[
                        ("feature", Value::String(feature.clone())),
                        ("turn", Value::String(turn.as_str().to_owned())),
                    ])));
                };
                if self.template.metric_subject.as_deref() == Some(it.base.actor.as_str())
                    && self.site.frame.ego_turn != Some(*turn)
                {
                    return Err(CompileError::at(
                        "route_turn_mismatch",
                        format!("{path}.target.turn"),
                        format!(
                            "catalog site binds {} ego turn, not {}",
                            self.site.frame.ego_turn.map_or("no", |t| t.as_str()),
                            turn.as_str()
                        ),
                    )
                    .with_detail(detail(&[
                        ("featureId", Value::String(matched.map_feature_id.clone())),
                        ("siteId", Value::String(self.site.site_id.clone())),
                    ])));
                }
                // The matcher already chose the exact movement and the actor's
                // lane path contains it: keep the authored trigger as a route
                // action that re-projects onto that bound movement.
                spec(actor.behavior.route.clone())
            }
            t::RouteTarget::ToFeature { .. }
            | t::RouteTarget::Crossing { .. }
            | t::RouteTarget::Acquire { .. } => {
                self.notes.push(Note::info(path, format!("route({}) is fixed by the role binding's lane chain at instantiation time; the timeline entry is redundant and was dropped", target.mode_name())));
                return Ok(None);
            }
            t::RouteTarget::NearMiss { .. } => {
                unreachable!("near-miss routes are lowered by build_near_miss_interactions")
            }
        }))
    }

    fn build_trigger(
        &mut self,
        trigger: &t::Trigger,
        scope: &ExprScope,
        path: &str,
        frame_s_offset: f64,
    ) -> CompileResult<Option<sim::Trigger>> {
        Ok(Some(match trigger {
            t::Trigger::At { t: at } => sim::Trigger::At {
                t: eval_num(Some(at), scope, &format!("{path}.t"), None)?,
            },
            t::Trigger::After { of, event, delay_s } => {
                let delay_s =
                    eval_num(Some(delay_s), scope, &format!("{path}.delayS"), Some(0.0))?.max(0.0);
                if let Some(&folded_at) = self.folded_trigger_start.get(of) {
                    self.notes.push(Note::info(path, format!("after({of}) references an interaction folded into initial state; materialized as at({:.3})", folded_at + delay_s)));
                    return Ok(Some(sim::Trigger::At {
                        t: folded_at + delay_s,
                    }));
                }
                sim::Trigger::After {
                    interaction_id: of.clone(),
                    event: Some(match event {
                        t::AfterEvent::Start => sim::InteractionEvent::Start,
                        t::AfterEvent::End => sim::InteractionEvent::End,
                    }),
                    delay_s,
                }
            }
            t::Trigger::When {
                condition,
                by_latest,
                if_never,
            } => {
                let Some(condition) =
                    self.build_condition(condition, scope, &format!("{path}.condition"))?
                else {
                    return Ok(None);
                };
                let Some(by_latest) = by_latest else {
                    return Err(CompileError::at(
                        "bylatest_required",
                        format!("{path}.byLatest"),
                        "when() requires byLatest",
                    )
                    .as_findings());
                };
                sim::Trigger::When {
                    condition,
                    by_latest: eval_num(Some(by_latest), scope, &format!("{path}.byLatest"), None)?,
                    if_never: match if_never {
                        t::IfNever::Skip => sim::IfNever::Skip,
                        t::IfNever::Fire => sim::IfNever::Fire,
                    },
                }
            }
            t::Trigger::Arrival {
                of,
                at,
                sync_with,
                ttc,
                delta_t,
            } => {
                let Some(mut point) =
                    self.arrival_point(at, scope, &format!("{path}.at"), frame_s_offset)?
                else {
                    return Ok(None);
                };
                if let (t::PointRef::Feature { .. }, Some(of_route), Some(sync_route)) = (
                    at,
                    self.route_by_role.get(of),
                    self.route_by_role.get(sync_with),
                ) {
                    if of_route.is_freeform() || sync_route.is_freeform() {
                        if let sim::ArrivalPoint::Point { at: authored, .. } = &point {
                            let authored_local = authored.to_local();
                            if let Some(conflict) =
                                route_intersection_near(of_route, sync_route, authored_local)
                            {
                                if hypot(
                                    conflict.x - authored_local.x,
                                    conflict.y - authored_local.y,
                                ) <= 20.0
                                {
                                    point = sim::ArrivalPoint::Point {
                                        at: scene_point(conflict),
                                        reference_frame: None,
                                    };
                                    self.notes.push(Note::info(format!("{path}.at"), format!("mapped feature point resolved to the exact {of}/{sync_with} route intersection")));
                                }
                            }
                        }
                    }
                }
                let ttc = match ttc {
                    Some(v) => Some(eval_num(Some(v), scope, &format!("{path}.ttc"), None)?),
                    None => None,
                };
                let delta_t = match delta_t {
                    Some(v) => Some(eval_num(Some(v), scope, &format!("{path}.deltaT"), None)?),
                    None => None,
                };
                sim::Trigger::Arrival {
                    arrival: sim::ArrivalSpec {
                        of: of.clone(),
                        at: point,
                        sync_with: sync_with.clone(),
                        ttc,
                        delta_t,
                    },
                }
            }
        }))
    }

    fn arrival_point(
        &mut self,
        r#ref: &t::PointRef,
        scope: &ExprScope,
        path: &str,
        frame_s_offset: f64,
    ) -> CompileResult<Option<sim::ArrivalPoint>> {
        let Some(world) = self.point_of(r#ref, scope, path, frame_s_offset)? else {
            return Ok(None);
        };
        let at = scene_point(world);
        let mut reference_frame = None;
        if let (t::PointRef::Pose { pose }, Some(ref_route)) = (r#ref, &self.ref_route) {
            let frame_s = frame_s_offset
                + eval_num(Some(&pose.s), scope, &format!("{path}.pose.s"), Some(0.0))?;
            let frame_center = self.frame_point(frame_s)?.point;
            // Every route here already belongs to a role bound into this frame:
            // projecting the frame centre onto them records the equivalent
            // cross-section per lane, so the engine can solve by lane identity.
            let mut stations: BTreeMap<String, f64> = BTreeMap::new();
            for route in std::iter::once(ref_route).chain(self.route_by_role.values()) {
                if route.is_freeform() {
                    continue;
                }
                let pose = route.pose_at(route.project_point(frame_center).s);
                if let Some(lane) = pose.lane {
                    stations
                        .entry(self.graph().rsl(lane).to_owned())
                        .or_insert(pose.storage_s);
                }
            }
            if !stations.is_empty() {
                let mut ordered: Vec<(String, f64)> = stations.into_iter().collect();
                ordered.sort_by(|a, b| simforge_core::hash::cmp_utf16(&a.0, &b.0));
                reference_frame = Some(sim::ReferenceFrame {
                    stations: ordered
                        .into_iter()
                        .map(|(rsl, s)| sim::LaneStation { rsl, s })
                        .collect(),
                });
            }
        }
        Ok(Some(sim::ArrivalPoint::Point {
            at,
            reference_frame,
        }))
    }

    /// Resolve a `PointRef` into an xodr-local point, where that is possible.
    fn point_of(
        &mut self,
        r#ref: &t::PointRef,
        scope: &ExprScope,
        path: &str,
        frame_s_offset: f64,
    ) -> CompileResult<Option<Vec2>> {
        match r#ref {
            t::PointRef::Pose { pose } => Ok(Some(
                self.frame_pose_point(pose, scope, &format!("{path}.pose"), frame_s_offset)?
                    .point,
            )),
            t::PointRef::Feature { feature, .. } => {
                let Some(matched) = self.site.feature_matches.get(feature) else {
                    self.notes.push(Note::loss(
                        path,
                        format!("feature \"{feature}\" is not bound at this site"),
                    ));
                    return Ok(None);
                };
                if matched.map_feature_id.starts_with("junction:") {
                    // The conflict point of whichever conflicting role uses this
                    // feature is a far better aim point than the junction centroid.
                    for binding in &self.site.bindings {
                        let Some(conflict) = &binding.conflict else {
                            continue;
                        };
                        if let Some(RoleKind::ConflictingGate { feature: f, .. }) =
                            self.role_by_id.get(binding.role.as_str()).map(|r| &r.kind)
                        {
                            if f == feature {
                                return Ok(Some(conflict.point));
                            }
                        }
                    }
                }
                Ok(Some(self.frame_point(matched.s)?.point))
            }
            t::PointRef::Role { .. } => {
                self.notes.push(Note::loss(path, "a point measured against a moving role is not expressible as a fixed arrival point"));
                Ok(None)
            }
        }
    }

    fn build_leaf(
        &mut self,
        leaf: &t::LeafCondition,
        scope: &ExprScope,
        path: &str,
    ) -> CompileResult<Option<sim::LeafCondition>> {
        use t::LeafCondition as L;
        Ok(Some(match leaf {
            L::Ttc {
                of,
                to,
                op,
                value_s,
            } => sim::LeafCondition::Ttc {
                a: of.clone(),
                b: to.clone(),
                cmp: compare(*op),
                value: eval_num(Some(value_s), scope, &format!("{path}.valueS"), None)?.max(0.0),
            },
            L::Headway {
                of,
                to,
                op,
                value_s,
            } => sim::LeafCondition::Headway {
                a: of.clone(),
                b: to.clone(),
                cmp: compare(*op),
                value: eval_num(Some(value_s), scope, &format!("{path}.valueS"), None)?.max(0.0),
            },
            L::Distance {
                from,
                to,
                measure,
                op,
                value_m,
                hysteresis_m,
            } => match to {
                t::PointRef::Role { role } => sim::LeafCondition::Distance {
                    a: from.clone(),
                    b: role.clone(),
                    mode: match measure {
                        t::DistanceMeasure::AlongLane => sim::DistanceMode::AlongLane,
                        t::DistanceMeasure::Euclidean => sim::DistanceMode::Euclidean,
                    },
                    cmp: compare(*op),
                    value: eval_num(Some(value_m), scope, &format!("{path}.valueM"), None)?
                        .max(0.0),
                    hysteresis: match hysteresis_m {
                        Some(h) => Some(
                            eval_num(Some(h), scope, &format!("{path}.hysteresisM"), None)?
                                .max(0.0),
                        ),
                        None => None,
                    },
                },
                // Distance to a fixed place is `reaches` with an explicit radius.
                _ => {
                    let Some(point) = self.point_of(to, scope, &format!("{path}.to"), 0.0)? else {
                        return Ok(None);
                    };
                    sim::LeafCondition::Reaches {
                        actor_id: from.clone(),
                        region: sim::Region::Circle {
                            center: scene_point(point),
                            radius_m: eval_num(
                                Some(value_m),
                                scope,
                                &format!("{path}.valueM"),
                                None,
                            )?
                            .max(0.5),
                        },
                    }
                }
            },
            L::Reaches {
                of,
                region,
                tolerance_m,
            } => {
                let Some(point) = self.point_of(region, scope, &format!("{path}.region"), 0.0)?
                else {
                    return Ok(None);
                };
                sim::LeafCondition::Reaches {
                    actor_id: of.clone(),
                    region: sim::Region::Circle {
                        center: scene_point(point),
                        radius_m: eval_num(
                            tolerance_m.as_ref(),
                            scope,
                            &format!("{path}.toleranceM"),
                            Some(3.0),
                        )?
                        .max(0.5),
                    },
                }
            }
            L::Speed { of, op, value_kph } => sim::LeafCondition::Speed {
                actor_id: of.clone(),
                cmp: compare(*op),
                value: (eval_num(Some(value_kph), scope, &format!("{path}.valueKph"), None)?
                    * KPH_TO_MPS)
                    .max(0.0),
            },
            L::Standstill { of, for_s } => sim::LeafCondition::Standstill {
                actor_id: of.clone(),
                duration_s: eval_num(Some(for_s), scope, &format!("{path}.forS"), None)?.max(0.0),
            },
            L::Visible {
                of, to, visible, ..
            } => sim::LeafCondition::Visible {
                a: of.clone(),
                to: to.clone(),
                value: *visible,
            },
            // `visible` is geometry; `detected` asks the observer's sensor suite.
            L::Detected {
                of,
                by,
                sensor,
                detected,
            } => sim::LeafCondition::Detected {
                a: of.clone(),
                by: by.clone(),
                sensor: sensor.clone(),
                value: *detected,
            },
            L::Collision { of, with } => sim::LeafCondition::Collision {
                a: Some(of.clone()),
                b: match with {
                    t::CollisionWith::Any(_) => None,
                    t::CollisionWith::Role(r) => Some(r.clone()),
                },
            },
            L::Signal { signal, phase, .. } => sim::LeafCondition::Signal {
                signal_id: self.resolve_signal_program(signal, path)?,
                phase: indication(*phase),
            },
        }))
    }

    fn build_condition(
        &mut self,
        condition: &t::Condition,
        scope: &ExprScope,
        path: &str,
    ) -> CompileResult<Option<sim::Condition>> {
        match condition {
            t::Condition::Leaf(leaf) => Ok(self
                .build_leaf(leaf, scope, path)?
                .map(sim::Condition::Leaf)),
            t::Condition::Logical(t::LogicalCondition::Not { operand }) => Ok(self
                .build_leaf(operand, scope, &format!("{path}.operand"))?
                .map(sim::Condition::Not)),
            t::Condition::Logical(logical) => {
                let (operands, is_and) = match logical {
                    t::LogicalCondition::And { operands } => (operands, true),
                    t::LogicalCondition::Or { operands } => (operands, false),
                    t::LogicalCondition::Not { .. } => unreachable!(),
                };
                let mut lowered = Vec::with_capacity(operands.len());
                for (i, operand) in operands.iter().enumerate() {
                    if let Some(leaf) =
                        self.build_leaf(operand, scope, &format!("{path}.operands.{i}"))?
                    {
                        lowered.push(leaf);
                    }
                }
                Ok(match lowered.len() {
                    0 => None,
                    1 => Some(sim::Condition::Leaf(lowered.pop().unwrap())),
                    _ if is_and => Some(sim::Condition::And(lowered)),
                    _ => Some(sim::Condition::Or(lowered)),
                })
            }
        }
    }

    /// Diagnostic evidence must reject legacy lowering approximations rather
    /// than claim a different predicate passed.
    fn assert_observation_condition(
        &self,
        condition: &t::Condition,
        path: &str,
    ) -> CompileResult<()> {
        let check_leaf = |leaf: &t::LeafCondition, path: &str| -> CompileResult<()> {
            let reason = match leaf {
                t::LeafCondition::Distance {
                    to,
                    op,
                    measure,
                    value_m,
                    ..
                } if !matches!(to, t::PointRef::Role { .. }) => {
                    if *op != t::CompareOp::Lte || *measure != t::DistanceMeasure::Euclidean {
                        Some("fixed-point distance observations require an inclusive Euclidean upper bound")
                    } else if value_m.as_number().is_some_and(|v| v < 0.5) {
                        Some("fixed-point observation radius below the runtime 0.5 m minimum")
                    } else {
                        None
                    }
                }
                t::LeafCondition::Reaches {
                    tolerance_m: Some(tol),
                    ..
                } if tol.as_number().is_some_and(|v| v < 0.5) => {
                    Some("observation region radius below the runtime 0.5 m minimum")
                }
                _ => None,
            };
            match reason {
                Some(reason) => {
                    Err(CompileError::at("observation_unsupported", path, reason).as_findings())
                }
                None => Ok(()),
            }
        };
        match condition {
            t::Condition::Leaf(leaf) => check_leaf(leaf, path),
            t::Condition::Logical(t::LogicalCondition::Not { operand }) => {
                check_leaf(operand, &format!("{path}.operand"))
            }
            t::Condition::Logical(
                t::LogicalCondition::And { operands } | t::LogicalCondition::Or { operands },
            ) => {
                for (i, operand) in operands.iter().enumerate() {
                    check_leaf(operand, &format!("{path}.operands.{i}"))?;
                }
                Ok(())
            }
        }
    }

    fn resolve_signal_program(
        &mut self,
        r#ref: &t::SignalRef,
        path: &str,
    ) -> CompileResult<String> {
        if let t::SignalRef::Control { control } = r#ref {
            if !self
                .template
                .traffic_controls
                .iter()
                .any(|c| c.id == *control)
            {
                return Err(CompileError::at(
                    "control_unbound",
                    path,
                    format!("condition references unknown traffic control \"{control}\""),
                )
                .as_findings());
            }
            return Ok(format!("control:{control}"));
        }
        let view = self.bundle.signal_view();
        if self.signal_plan.is_none() {
            self.signal_plan = Some(build_site_signal_plan(&view, self.site));
        }
        let plan = self.signal_plan.as_ref().unwrap();
        let site_ref = match r#ref {
            t::SignalRef::Handle { handle } => SiteSignalRef::Handle(handle),
            t::SignalRef::Feature { feature, approach } => SiteSignalRef::Feature {
                feature_id: feature,
                approach: *approach,
            },
            t::SignalRef::Control { .. } => unreachable!(),
        };
        if let Some(id) = resolve_site_signal_program(&view, self.site, plan, &site_ref) {
            return Ok(id);
        }
        let junction = plan
            .junction_id
            .clone()
            .unwrap_or_else(|| "<none>".to_owned());
        let (description, sub_path) = match r#ref {
            t::SignalRef::Handle { handle } => (format!("map signal handle \"{handle}\" is not controlled at site junction {junction}"), format!("{path}.signal.handle")),
            t::SignalRef::Feature { feature, approach } => (format!("no physical signal head binds the {} movement for feature \"{feature}\" at site junction {junction}", approach.as_str()), format!("{path}.signal.approach")),
            t::SignalRef::Control { .. } => unreachable!(),
        };
        Err(
            CompileError::at("signal_unbindable", sub_path, description).with_detail(detail(&[
                (
                    "junctionId",
                    plan.junction_id.clone().map_or(Value::Null, Value::String),
                ),
                (
                    "timingSource",
                    serde_json::to_value(plan.timing_source).unwrap_or(Value::Null),
                ),
                (
                    "stateSource",
                    serde_json::to_value(plan.state_source).unwrap_or(Value::Null),
                ),
            ])),
        )
    }

    fn declare_occlusion_pair(
        &mut self,
        observer: &str,
        target: &str,
        occluder_id: Option<String>,
    ) {
        if self.actor(observer).is_none() || self.actor(target).is_none() {
            self.notes.push(Note::loss("occlusionPairs", format!("occlusion pair {observer}/{target} references a role that was not materialized")));
            return;
        }
        if let Some(actor_id) = occluder_id
            .as_deref()
            .and_then(|id| id.strip_prefix("actor:"))
        {
            if self.actor(actor_id).is_none() {
                self.notes.push(Note::loss("occlusionPairs", format!("occlusion pair {observer}/{target} references occluder role {actor_id} that was not materialized")));
                return;
            }
        }
        if !self
            .occlusion_pairs
            .iter()
            .any(|p| p.observer == observer && p.target == target && p.occluder_id == occluder_id)
        {
            self.occlusion_pairs.push(sim::OcclusionPair {
                observer: observer.to_owned(),
                target: target.to_owned(),
                occluder_id,
            });
        }
    }

    /* ------------------------------------------------------------ perception */

    /// The sensor passthrough. Runs after the actors are built so the lowering
    /// stays one reviewable block and cannot perturb placement; a sensor that
    /// vanishes is the exact failure this layer exists to make impossible.
    fn apply_role_sensors(&mut self) -> CompileResult<()> {
        for role in &self.template.roles {
            if role.base.actor.sensors.is_empty() {
                continue;
            }
            let Some(actor) = self.actors.iter_mut().find(|a| a.id == role.base.id) else {
                return Err(CompileError::at(
                    "sensor_actor_unavailable",
                    format!("roles.{}.sensors", role.base.id),
                    format!(
                        "role \"{}\" declares {} sensor(s) but has no concrete actor at this site",
                        role.base.id,
                        role.base.actor.sensors.len()
                    ),
                )
                .as_findings());
            };
            actor.sensors = Some(role.base.actor.sensors.iter().map(lower_sensor).collect());
        }
        Ok(())
    }

    /// Atmosphere from `environment` plus any declared map/percept
    /// divergence. `None` when the scenario says nothing about perception and
    /// nothing carries a sensor, so the input hash of such a document is
    /// unchanged.
    fn build_perception(&mut self) -> CompileResult<Option<sim::PerceptionConfig>> {
        let has_sensor = self.actors.iter().any(|a| !a.sensors().is_empty());
        let declared = &self.template.perception.map_divergences;
        if !has_sensor && declared.is_empty() {
            return Ok(None);
        }
        let scope = self.base_scope(None);
        // The null guard keeps the sun bearing well defined rather than
        // silently rotating glare to due east.
        let reference_heading_rad = self
            .ref_route
            .as_ref()
            .map_or(0.0, |r| r.pose_at(0.0).heading_rad);
        let mut divergences = Vec::new();
        for divergence in declared {
            let mut windows_result: CompileResult<Vec<DivergenceWindow>> = Ok(Vec::new());
            let mut extra_notes: Notes = Vec::new();
            let lowered = lower_map_divergence(
                divergence,
                |from, to, lane| {
                    let mut notes = Vec::new();
                    let r = self.divergence_windows(&divergence.id, from, to, lane, &mut notes);
                    extra_notes = notes;
                    match r {
                        Ok(w) => w,
                        Err(e) => {
                            windows_result = Err(e);
                            Vec::new()
                        }
                    }
                },
                |role| {
                    self.actors
                        .iter()
                        .find(|a| a.id == role)
                        .map(|a| sim::ScenePoint {
                            x: a.initial.pose.x,
                            z: a.initial.pose.z,
                        })
                },
            );
            windows_result?;
            self.notes.extend(extra_notes);
            if matches!(divergence.extent, t::MapDivergenceExtent::Corridor { .. })
                && lowered.is_empty()
            {
                self.notes.push(Note::loss(
                    format!("perception.mapDivergences.{}", divergence.id),
                    "divergence covers no drivable lane at this site; omitted",
                ));
            }
            divergences.extend(lowered);
        }
        let env = &self.template.environment;
        let sun_elevation = match &env.sun_elevation_deg {
            Some(v) => Some(eval_num(
                Some(v),
                &scope,
                "environment.sunElevationDeg",
                Some(0.0),
            )?),
            None => None,
        };
        let sun_azimuth = match &env.sun_azimuth_deg {
            Some(v) => Some(eval_num(
                Some(v),
                &scope,
                "environment.sunAzimuthDeg",
                Some(0.0),
            )?),
            None => None,
        };
        Ok(Some(sim::PerceptionConfig {
            atmosphere: atmosphere_from_environment(
                env,
                reference_heading_rad,
                sun_elevation,
                sun_azimuth,
            ),
            emissive_glare: sim::EmissiveGlare::default(),
            map_divergences: divergences,
        }))
    }

    /// Lane windows covered by a corridor-relative interval of a lane chain.
    fn lane_windows(graph: &LaneGraph, route: &Route, lo: f64, hi: f64) -> Vec<DivergenceWindow> {
        let mut windows = Vec::new();
        for leg in route.legs() {
            let leg_lo = lo.max(leg.s_start);
            let leg_hi = hi.min(leg.s_end());
            if leg_hi - leg_lo <= 1e-6 {
                continue;
            }
            // Route `s` runs along the leg's travel direction; a reversed leg
            // stores its arc length the other way round.
            let a = if leg.reversed {
                leg.length_m - (leg_hi - leg.s_start)
            } else {
                leg_lo - leg.s_start
            };
            let b = if leg.reversed {
                leg.length_m - (leg_lo - leg.s_start)
            } else {
                leg_hi - leg.s_start
            };
            windows.push(DivergenceWindow {
                rsl: graph.rsl(leg.lane).to_owned(),
                s_min: a.min(b).max(0.0),
                s_max: a.max(b).max(0.0),
            });
        }
        windows
    }

    fn divergence_windows(
        &self,
        id: &str,
        from_frac: f64,
        to_frac: f64,
        lane: Option<i32>,
        notes: &mut Notes,
    ) -> CompileResult<Vec<DivergenceWindow>> {
        let path = format!("perception.mapDivergences.{id}");
        let owned: Option<Route>;
        let route: &Route = match lane {
            Some(k) if k != 0 => {
                let Some(rsl) = self.site.frame.lateral_rsl(k) else {
                    notes.push(Note::loss(
                        format!("{path}.extent.lane"),
                        format!("no lane at k = {k} at this site; divergence omitted"),
                    ));
                    return Ok(Vec::new());
                };
                owned = route_from_chain(self.graph(), &[rsl.to_owned()], Some(rsl), notes, &path);
                match &owned {
                    Some(r) => r,
                    None => return Ok(Vec::new()),
                }
            }
            _ => match &self.ref_route {
                Some(r) => r,
                None => return Ok(Vec::new()),
            },
        };
        let lo = from_frac.min(to_frac).clamp(0.0, 1.0) * route.length_m();
        let hi = from_frac.max(to_frac).clamp(0.0, 1.0) * route.length_m();
        Ok(Self::lane_windows(self.graph(), route, lo, hi))
    }

    fn build_role_occlusion_pairs(&mut self) {
        for role in &self.template.roles {
            let Some(raw) = role
                .base
                .extensions
                .as_ref()
                .and_then(|e| e.get("occludes"))
            else {
                continue;
            };
            let pair = raw.as_object().and_then(|o| {
                Some((
                    o.get("observer")?.as_str()?.to_owned(),
                    o.get("target")?.as_str()?.to_owned(),
                ))
            });
            let Some((observer, target)) = pair else {
                self.notes.push(Note::loss(
                    format!("roles.{}.extensions.occludes", role.base.id),
                    "occlusion declaration is not {observer,target}",
                ));
                continue;
            };
            self.declare_occlusion_pair(
                &observer,
                &target,
                Some(format!("actor:{}", role.base.id)),
            );
        }
    }

    /* -------------------------------------------------------------- surfaces */

    /// Lower `environment.surfacePatches` onto the site: one lane window per
    /// crossed lane, because grip is answered per actor per tick from the
    /// actor's own lane position. Empty `laneOffsets` means every
    /// same-direction lane the site knows about.
    fn build_surface_patches(&mut self) -> CompileResult<Vec<sim::SurfacePatch>> {
        let mut patches = Vec::new();
        let scope = self.base_scope(None);
        for patch in &self.template.environment.surface_patches {
            let path = format!("environment.surfacePatches.{}", patch.id);
            let required = patch.essentiality == t::Essentiality::Required;
            let feature_offset = match &patch.feature {
                Some(feature) => {
                    match self.site.feature_matches.get(feature) {
                        Some(m) => m.s,
                        None => {
                            if required {
                                return Err(CompileError::at("surface_patch_feature_unbound", format!("{path}.feature"), format!("required surface patch \"{}\" is anchored to feature \"{feature}\", which is not bound at this site", patch.id))
                                .with_detail(detail(&[("feature", Value::String(feature.clone())), ("siteId", Value::String(self.site.site_id.clone()))]))
                                .as_findings());
                            }
                            self.notes.push(Note::loss(format!("{path}.feature"), format!("feature \"{feature}\" is not bound at this site; patch omitted")));
                            continue;
                        }
                    }
                }
                None => 0.0,
            };
            let start_frame_s = feature_offset
                + eval_num(Some(&patch.at_m), &scope, &format!("{path}.atM"), Some(0.0))?;
            let length_m = eval_num(
                Some(&patch.length_m),
                &scope,
                &format!("{path}.lengthM"),
                Some(0.0),
            )?;
            if !(length_m > 0.0) {
                self.notes.push(Note::loss(
                    format!("{path}.lengthM"),
                    format!("patch length resolved to {length_m} m; patch omitted"),
                ));
                continue;
            }
            let friction_scale = match &patch.friction_scale {
                Some(v) => Some(eval_num(
                    Some(v),
                    &scope,
                    &format!("{path}.frictionScale"),
                    None,
                )?),
                None => None,
            };
            let edge_taper_m = eval_num(
                Some(&patch.edge_taper_m),
                &scope,
                &format!("{path}.edgeTaperM"),
                Some(0.0),
            )?
            .max(0.0);
            let offsets: BTreeSet<i32> = if patch.lane_offsets.is_empty() {
                std::iter::once(0)
                    .chain(self.site.frame.lateral_lanes.keys().copied())
                    .collect()
            } else {
                patch.lane_offsets.iter().copied().collect()
            };
            let mut windows: Vec<DivergenceWindow> = Vec::new();
            for k in offsets {
                let owned: Option<Route>;
                let route: &Route = if k == 0 {
                    match &self.ref_route {
                        Some(r) => r,
                        None => continue,
                    }
                } else {
                    let Some(rsl) = self.site.frame.lateral_rsl(k) else {
                        self.notes.push(Note::loss(
                            format!("{path}.laneOffsets"),
                            format!("no lane at k = {k}; that offset is not covered"),
                        ));
                        continue;
                    };
                    let mut notes = std::mem::take(&mut self.notes);
                    owned = route_from_chain(
                        self.graph(),
                        &[rsl.to_owned()],
                        Some(rsl),
                        &mut notes,
                        &format!("{path}.laneOffsets"),
                    );
                    self.notes = notes;
                    match &owned {
                        Some(r) => r,
                        None => continue,
                    }
                };
                // Project the two frame endpoints onto whichever chain this
                // offset resolved to: `s` restarts on every lane of a chain.
                let from = route
                    .project_point(self.frame_point(start_frame_s)?.point)
                    .s;
                let to = route
                    .project_point(self.frame_point(start_frame_s + length_m)?.point)
                    .s;
                windows.extend(Self::lane_windows(
                    self.graph(),
                    route,
                    from.min(to),
                    from.max(to),
                ));
            }
            if windows.is_empty() {
                if required {
                    return Err(CompileError::at(
                        "surface_patch_unplaceable",
                        &path,
                        format!(
                            "required surface patch \"{}\" covers no drivable lane at this site",
                            patch.id
                        ),
                    )
                    .with_detail(detail(&[
                        ("atM", Value::from(start_frame_s)),
                        ("lengthM", Value::from(length_m)),
                        ("siteId", Value::String(self.site.site_id.clone())),
                    ]))
                    .as_findings());
                }
                self.notes.push(Note::loss(
                    &path,
                    "patch covers no drivable lane at this site; omitted",
                ));
                continue;
            }
            let single = windows.len() == 1;
            let mut seen: BTreeSet<String> = BTreeSet::new();
            let kind = sim::SurfaceKind::parse(patch.kind.as_str())
                .expect("template surface kinds mirror the engine's");
            for window in windows {
                if !seen.insert(format!(
                    "{}{:.3}{:.3}",
                    window.rsl, window.s_min, window.s_max
                )) {
                    continue;
                }
                patches.push(sim::SurfacePatch {
                    id: if single {
                        patch.id.clone()
                    } else {
                        format!("{}:{}", patch.id, seen.len() - 1)
                    },
                    kind,
                    region: sim::Region::LaneWindow {
                        rsl: window.rsl,
                        s_min: window.s_min,
                        s_max: window.s_max,
                    },
                    friction_scale,
                    edge_taper_m,
                    label: patch.label.clone(),
                });
            }
        }
        Ok(patches)
    }

    /* ------------------------------------------------------------------ props */

    fn build_props_and_occluders(&mut self) -> CompileResult<()> {
        let scope = self.base_scope(None);
        for prop in &self.template.props {
            let base = format!("props.{}", prop.id);
            let count = prop.repeat.as_ref().map_or(1, |r| r.count);
            let spacing = match &prop.repeat {
                Some(r) => eval_num(
                    Some(&r.spacing_m),
                    &scope,
                    &format!("{base}.repeat.spacingM"),
                    Some(6.0),
                )?,
                None => 0.0,
            };
            let base_s = eval_num(
                Some(&prop.pose.s),
                &scope,
                &format!("{base}.pose.s"),
                Some(0.0),
            )?;
            let feature_offset = prop
                .feature
                .as_ref()
                .and_then(|f| self.site.feature_matches.get(f))
                .map_or(0.0, |m| m.s);
            let dims_override: Option<PartialDims> = prop
                .extensions
                .as_ref()
                .and_then(|e| e.get("dims"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let dims = prop_dims(&prop.catalog_id, dims_override);
            let dims = sim::Dims {
                l: dims.l,
                w: dims.w,
                h: dims.h,
            };
            let target_reveal = match &prop.target_reveal_to_conflict_s {
                Some(v) => Some(eval_num(
                    Some(v),
                    &scope,
                    &format!("{base}.targetRevealToConflictS"),
                    None,
                )?),
                None => None,
            };
            let behavior = prop_behavior(&prop.catalog_id);
            let collidable = prop
                .extensions
                .as_ref()
                .and_then(|e| e.get("collidable"))
                .and_then(Value::as_bool)
                .unwrap_or(behavior.collidable);
            let base_t_frac = eval_tfrac(
                Some(&prop.pose.t_frac.to_number_or_expr()),
                &scope,
                &format!("{base}.pose.tFrac"),
                0.0,
            )?;
            let t_frac_step = match &prop.repeat {
                Some(r) => eval_tfrac(
                    Some(&r.t_frac_step.to_number_or_expr()),
                    &scope,
                    &format!("{base}.repeat.tFracStep"),
                    0.0,
                )?,
                None => 0.0,
            };
            let essentiality = sim::PropEssentiality::parse(prop.essentiality.as_str())
                .expect("prop essentiality mirrors the engine's");
            for i in 0..count {
                let s = feature_offset + base_s + i as f64 * spacing;
                let pose = t::FramePose {
                    lane_offset: prop.pose.lane_offset,
                    s: NumberOrExpr::Number(s),
                    t_frac: t::TFrac::Number(
                        (base_t_frac + i as f64 * t_frac_step).clamp(-1.0, 1.0),
                    ),
                    heading_offset_rad: prop.pose.heading_offset_rad,
                };
                let at = match self.frame_pose_point(&pose, &scope, &format!("{base}.pose"), 0.0) {
                    Ok(at) => at,
                    // A repeat that runs off the frame is expected and skipped; an
                    // unsatisfiable lane offset is a lane this site does not have.
                    Err(e) if is_lane_offset_error(&e.code) => return Err(e),
                    Err(_) => continue,
                };
                let scene = to_scene_xz(at.point);
                let id = if count > 1 {
                    format!("{}-{i}", prop.id)
                } else {
                    prop.id.clone()
                };
                let heading_rad = at.heading_rad + prop.heading_offset_rad;
                let group_id = (count > 1).then(|| prop.id.clone());
                self.props.push(sim::StaticProp {
                    id: id.clone(),
                    group_id: group_id.clone(),
                    catalog_id: prop.catalog_id.clone(),
                    pose: sim::Pose {
                        x: scene.x,
                        z: scene.z,
                        heading_rad,
                    },
                    attachment: prop.attachment.as_ref().map(|a| sim::PropAttachment {
                        actor_id: a.role.clone(),
                        longitudinal_m: a.longitudinal_m,
                        lateral_m: a.lateral_m,
                        height_m: a.height_m,
                        heading_offset_rad: a.heading_offset_rad,
                    }),
                    dims,
                    scale: prop.scale,
                    collidable,
                    essentiality,
                    occludes: prop.occludes.as_ref().map(|o| sim::OccludesPair {
                        observer: o.observer.clone(),
                        target: o.target.clone(),
                    }),
                    target_reveal_to_conflict_s: target_reveal,
                });
                if behavior.occluder {
                    self.occluders.push(sim::Occluder {
                        id,
                        group_id,
                        obb: sim::OccluderObb {
                            center: sim::ScenePoint {
                                x: scene.x,
                                z: scene.z,
                            },
                            length_m: dims.l * prop.scale,
                            width_m: dims.w * prop.scale,
                            heading_rad,
                            height_m: dims.h * prop.scale,
                        },
                    });
                }
            }
            if let (Some(occludes), true) = (&prop.occludes, count > 0) {
                self.declare_occlusion_pair(
                    &occludes.observer,
                    &occludes.target,
                    Some(prop.id.clone()),
                );
                self.notes.push(Note::info(&base, format!("occlusion declared between {} and {}; reveal-to-conflict is reported by the engine, not solved for", occludes.observer, occludes.target)));
            }
        }
        Ok(())
    }

    /* --------------------------------------------------------------- assemble */

    /// Mechanism-specific hard eligibility for the authored double-park
    /// reveal: a pre-simulation geometry proof, because catalog generation
    /// invokes materialization before reserving a slot.
    fn assert_delivery_geometry_eligibility(
        &self,
        input: &SimScenarioInput,
        arrivals: &[ArrivalSolution],
    ) -> CompileResult<()> {
        if self.template.meta.archetype.as_deref() != Some("parking.delivery-double-park") {
            return Ok(());
        }
        let ego = input.actor("ego");
        let van = input.actor("delivery-vehicle");
        let worker = input.actor("delivery-worker");
        let pass = input
            .interactions
            .iter()
            .find(|i| i.id == "ego-passes-left");
        let pair = input.occlusion_pairs.iter().any(|p| {
            p.observer == "ego"
                && p.target == "delivery-worker"
                && p.occluder_id.as_deref() == Some("actor:delivery-vehicle")
        });
        let pass_lane_rsl = self.site.frame.lateral_rsl(2);
        let pass_lane = pass_lane_rsl.and_then(|rsl| self.graph().lane_id(rsl));
        let worker_arrival = arrivals.iter().find(|a| a.actor_id == "delivery-worker");

        let mut reasons: Vec<&str> = Vec::new();
        if ego.is_none() || !van.is_some_and(|v| v.kind == sim::ActorKind::Van && v.is_static) {
            reasons.push("semantic static delivery van is absent");
        }
        let worker_points: Option<&Vec<sim::ScenePoint>> =
            worker.and_then(|w| match &w.behavior.route {
                sim::RouteSpec::Polyline { points }
                    if w.kind == sim::ActorKind::Pedestrian && !w.is_static =>
                {
                    Some(points)
                }
                _ => None,
            });
        if worker_points.is_none() {
            reasons.push("moving pedestrian worker polyline is absent");
        }
        if !pass.is_some_and(|p| {
            matches!(
                p.verb,
                sim::Verb::ChangeLane {
                    target: sim::LaneChangeTarget::Left { count: 1 },
                    ..
                }
            )
        }) {
            reasons.push("ego does not execute one adjacent-left pass");
        }
        if !pair {
            reasons.push("delivery van is not the declared ego/worker occluder");
        }
        if pass_lane.is_none() {
            reasons.push("adjacent executable pass lane is absent at the conflict cross-section");
        }
        if !worker_arrival.is_some_and(|a| a.converged) {
            reasons.push("worker arrival does not converge");
        }

        let mut initial_blocker: Option<String> = None;
        let mut later_clear = false;
        let mut pass_path_distance_m = f64::INFINITY;
        let mut pass_path_tolerance_m = 0.0;
        if let (Some(ego), Some(van), Some(worker), Some(points)) =
            (ego, van, worker, worker_points)
        {
            let van_occluder = sim::Occluder {
                id: format!("actor:{}", van.id),
                group_id: None,
                obb: sim::OccluderObb {
                    center: sim::ScenePoint {
                        x: van.initial.pose.x,
                        z: van.initial.pose.z,
                    },
                    length_m: van.dims.l,
                    width_m: van.dims.w,
                    heading_rad: van.initial.pose.heading_rad,
                    height_m: van.dims.h,
                },
            };
            let shapes = build_occluders(std::iter::once(&van_occluder));
            let position_at_clip_start = |actor: &SimActor| -> Vec2 {
                let Some(route) = self.route_by_role.get(&actor.id) else {
                    return actor.initial.pose.position_local();
                };
                let start_s = route.project_point(actor.initial.pose.position_local()).s;
                let probe = nominal_run(
                    self.graph(),
                    &NominalActor {
                        kind: actor.kind,
                        route,
                        start_s,
                        initial_speed_mps: actor.initial.speed_mps,
                        speed_factor: actor.behavior.rules.speed_factor,
                        cruise_override_mps: actor.behavior.cruise_speed_mps,
                    },
                    None,
                    &NominalRunOptions {
                        dt: input.dt,
                        warmup_seconds: input.warmup_seconds,
                        horizon_seconds: 0.0,
                        bound_by_route: true,
                    },
                );
                route.pose_at(start_s + probe.distance_m).point
            };
            let observer = position_at_clip_start(ego);
            initial_blocker = blocking_occluder(
                observer,
                position_at_clip_start(worker),
                shapes.iter().map(|s| s.shape()),
            )
            .map(str::to_owned);
            later_clear = points.iter().any(|p| {
                blocking_occluder(observer, p.to_local(), shapes.iter().map(|s| s.shape()))
                    .is_none()
            });
            if let Some(lane) = pass_lane {
                let worker_path: Vec<Vec2> = points.iter().map(|p| p.to_local()).collect();
                let geom = self.graph().geometry(lane);
                pass_path_distance_m = polyline_distance(&worker_path, geom.path.points());
                pass_path_tolerance_m = (geom.width_m + worker.dims.w) / 2.0 + 0.05;
            }
        }
        if initial_blocker.as_deref() != Some("actor:delivery-vehicle") {
            reasons.push("worker is not initially hidden by the delivery van OBB");
        }
        if !later_clear {
            reasons.push("worker path never clears the delivery van OBB");
        }
        if pass_path_distance_m > pass_path_tolerance_m {
            reasons.push("worker path does not close on the adjacent pass lane");
        }
        if reasons.is_empty() {
            return Ok(());
        }
        Err(CompileError::at(
            "delivery_geometry_unclosed",
            "roles.delivery-worker",
            "double-parked delivery site failed executable van/worker/pass-path hard eligibility",
        )
        .with_detail(detail(&[
            ("siteId", Value::String(self.site.site_id.clone())),
            (
                "reasons",
                Value::Array(
                    reasons
                        .into_iter()
                        .map(|r| Value::String(r.to_owned()))
                        .collect(),
                ),
            ),
            (
                "passLaneRsl",
                pass_lane_rsl.map_or(Value::Null, |r| Value::String(r.to_owned())),
            ),
            (
                "initialBlocker",
                initial_blocker.map_or(Value::Null, Value::String),
            ),
            ("laterClear", Value::Bool(later_clear)),
            (
                "passPathDistanceM",
                if pass_path_distance_m.is_finite() {
                    Value::from(pass_path_distance_m)
                } else {
                    Value::Null
                },
            ),
            ("passPathToleranceM", Value::from(pass_path_tolerance_m)),
            (
                "workerArrivalConverged",
                Value::Bool(worker_arrival.is_some_and(|a| a.converged)),
            ),
        ]))
        .as_findings())
    }

    fn solve_role_arrivals(
        &mut self,
        mut input: SimScenarioInput,
    ) -> CompileResult<(SimScenarioInput, Vec<ArrivalSolution>)> {
        let mut solutions = Vec::new();
        for role in &self.template.roles {
            let RoleKind::ConflictingGate {
                arrive_at_conflict: Some(arrive),
                ..
            } = &role.kind
            else {
                continue;
            };
            let Some(conflict) = self
                .binding_by_role
                .get(role.base.id.as_str())
                .and_then(|b| b.conflict.as_ref())
            else {
                continue;
            };
            if input.actor(&role.base.id).is_none() {
                continue;
            }
            let path = format!("roles.{}.arriveAtConflict", role.base.id);
            let scope = self.scope_for(&role.base.id);
            let delta_t = eval_num(
                Some(&arrive.delta_t),
                &scope,
                &format!("{path}.deltaT"),
                None,
            )?;
            let reference_id = &arrive.relative_to;
            let (conflict_route, reference_route, conflict_actor, reference_actor) = (
                self.route_by_role.get(&role.base.id),
                self.route_by_role.get(reference_id),
                input.actor(&role.base.id),
                input.actor(reference_id),
            );
            let (
                Some(conflict_route),
                Some(reference_route),
                Some(conflict_actor),
                Some(reference_actor),
            ) = (
                conflict_route,
                reference_route,
                conflict_actor,
                reference_actor,
            )
            else {
                return Err(CompileError::at("arrival_conflict_unclosed", &path, format!("required arrival pair \"{}\"/\"{reference_id}\" has no final executable route", role.base.id))
                    .with_detail(detail(&[("siteId", Value::String(self.site.site_id.clone())), ("conflictGateId", Value::String(conflict.gate_id.clone()))]))
                    .as_findings());
            };
            let closure = close_arrival_conflict(
                conflict.point,
                conflict_route,
                reference_route,
                conflict_actor.dims.w,
                reference_actor.dims.w,
            );
            if !closure.closed {
                return Err(CompileError::at("arrival_conflict_unclosed", &path, format!("matcher conflict does not close on the final {}/{reference_id} executable paths", role.base.id))
                    .with_detail(detail(&[
                        ("siteId", Value::String(self.site.site_id.clone())),
                        ("conflictGateId", Value::String(conflict.gate_id.clone())),
                        ("declaredPoint", serde_json::to_value(conflict.point).unwrap_or(Value::Null)),
                        ("aDistanceM", Value::from(closure.a_distance_m)),
                        ("bDistanceM", Value::from(closure.b_distance_m)),
                        ("pathSeparationM", Value::from(closure.path_separation_m)),
                        ("footprintToleranceM", Value::from(closure.tolerance_m)),
                        ("conflictRoute", Value::Array(rsls_of(self.graph(), conflict_route).into_iter().map(Value::String).collect())),
                        ("referenceRoute", Value::Array(rsls_of(self.graph(), reference_route).into_iter().map(Value::String).collect())),
                    ]))
                    .as_findings());
            }
            // Projected from the closure point, not the matcher-only point, so
            // the nominal solver times the same executable paths proved above.
            let mut stations: BTreeMap<String, f64> = BTreeMap::new();
            for actor_id in [role.base.id.as_str(), reference_id.as_str()] {
                let Some(route) = self.route_by_role.get(actor_id) else {
                    continue;
                };
                if route.is_freeform() {
                    continue;
                }
                let pose = route.pose_at(route.project_point(closure.point).s);
                if let Some(lane) = pose.lane {
                    stations.insert(self.graph().rsl(lane).to_owned(), pose.storage_s);
                }
            }
            let reference_frame = (!stations.is_empty()).then(|| sim::ReferenceFrame {
                stations: stations
                    .into_iter()
                    .map(|(rsl, s)| sim::LaneStation { rsl, s })
                    .collect(),
            });
            let spec = sim::ArrivalSpec {
                of: role.base.id.clone(),
                at: sim::ArrivalPoint::Point {
                    at: scene_point(closure.point),
                    reference_frame,
                },
                sync_with: reference_id.clone(),
                ttc: None,
                delta_t: Some(delta_t),
            };
            let solved = match solve_arrival(
                &input,
                &spec,
                self.graph(),
                Some(&format!("role:{}", role.base.id)),
            ) {
                Ok(s) => s,
                Err(issue) => {
                    self.notes.push(Note::loss(
                        &path,
                        format!("{}: {}", issue.code.as_str(), issue.reason),
                    ));
                    continue;
                }
            };
            if !solved.converged && role.base.essentiality == t::Essentiality::Required {
                return Err(CompileError::at(
                    "arrival_unconverged",
                    &path,
                    format!(
                        "required arrival for \"{}\" cannot be achieved on the bound approach",
                        role.base.id
                    ),
                )
                .with_detail(detail(&[
                    ("targetDeltaT", Value::from(solved.target_delta_t)),
                    ("achievedDeltaT", Value::from(solved.achieved_delta_t)),
                    ("spawnS", Value::from(solved.spawn_s)),
                    ("siteId", Value::String(self.site.site_id.clone())),
                    ("conflictGateId", Value::String(conflict.gate_id.clone())),
                ]))
                .as_findings());
            }
            input = apply_arrival_solution(input, &solved, self.graph());
            solutions.push(solved);
        }
        Ok((input, solutions))
    }

    pub(super) fn run(mut self) -> CompileResult<MaterializeResult> {
        let operational_conditions = match &self.options.variant {
            None => {
                let scope = self.base_scope(None);
                apply_template_environment(&self.template.environment, |value, path| {
                    eval_num(Some(value), &scope, path, None)
                })?
            }
            Some(variant) => apply_catalog_variant(variant)?,
        };
        let view = self.bundle.signal_view();
        let plan = build_site_signal_plan(&view, self.site);
        self.road_controls = build_site_road_controls(&view, self.site);
        assert_materializable_map_controls(
            self.template,
            self.bundle,
            self.site,
            &plan,
            &self.road_controls,
        )?;
        assert_materializable_movement_controls(
            self.template,
            self.bundle,
            self.site,
            &self.road_controls,
        )?;
        self.signal_plan = Some(plan);
        self.build_reference_route()?;
        self.build_traffic_controls()?;
        self.compile_authored_map_signals()?;
        self.build_actors()?;
        self.assert_terminating_lane_merge_closure()?;
        self.fold_initial_rules()?;
        // Rules folded after the actors were built: rebuild the ones that changed.
        if !self.initial_rules.is_empty() {
            for i in 0..self.actors.len() {
                let id = self.actors[i].id.clone();
                if self.initial_rules.contains_key(&id) {
                    self.actors[i].behavior.rules = self.rules_for(&id);
                }
            }
        }
        let plan = self.signal_plan.as_ref().unwrap();
        if !plan.programs.is_empty() && self.compiled_map_signal_programs.is_none() {
            let heads: BTreeSet<&str> = plan
                .programs
                .iter()
                .flat_map(|p| {
                    p.map_binding
                        .iter()
                        .flat_map(|b| b.head_ids.iter().map(String::as_str))
                })
                .collect();
            self.notes.push(Note::loss(
                "signalPrograms",
                format!(
                    "{} physical map signal head(s) bound as {} logical program(s) to junction {} with authoritative OpenDRIVE controller-stage provenance; phase durations and t=0 state use the explicit synthetic-default cycle because authoritative timing/state data is absent",
                    heads.len(),
                    plan.programs.len(),
                    plan.junction_id.as_deref().unwrap_or("<none>")
                ),
            ));
        }
        if !self.road_controls.is_empty() {
            self.notes.push(Note::info(
                "roadControls",
                format!(
                    "{} physical map stop control(s) bound to actor-local dwell-and-release state",
                    self.road_controls.len()
                ),
            ));
        }
        // Sensors first: an interaction may name one.
        self.apply_role_sensors()?;
        self.build_interactions()?;
        self.build_role_occlusion_pairs();
        self.build_props_and_occluders()?;
        let perception = self.build_perception()?;
        let surface_patches = self.build_surface_patches()?;

        let metric_subject = self
            .template
            .metric_subject
            .clone()
            .filter(|m| self.actors.iter().any(|a| a.id == *m));
        let mut signal_programs = self
            .compiled_map_signal_programs
            .clone()
            .unwrap_or_else(|| self.signal_plan.as_ref().unwrap().programs.clone());
        signal_programs.extend(self.authored_control_programs.iter().cloned());
        let input = SimScenarioInput {
            schema_version: sim::SCHEMA_VERSION,
            map_id: self.bundle.map_id().to_owned(),
            clip_seconds: self.template.choreography.clip_seconds,
            warmup_seconds: self.template.choreography.warmup_seconds,
            dt: INSTANCE_DT_S,
            seed: simforge_core::rng::Seed::Text(
                self.draw.param_seed[..16.min(self.draw.param_seed.len())].to_owned(),
            ),
            // New concrete products pin the current authoring default so a
            // future engine default cannot silently reinterpret their motion.
            physics: Some(sim::PhysicsConfig {
                mode: sim::MotionPhysicsMode::DynamicV1,
                substep_s: None,
                vehicle_profiles: None,
            }),
            operational_conditions,
            metric_subject,
            actors: std::mem::take(&mut self.actors),
            interactions: std::mem::take(&mut self.interactions),
            signal_programs,
            road_controls: self.road_controls.clone(),
            surface_patches,
            props: std::mem::take(&mut self.props),
            occluders: std::mem::take(&mut self.occluders),
            occlusion_pairs: std::mem::take(&mut self.occlusion_pairs),
            near_miss_criteria: Some(std::mem::take(&mut self.near_miss_criteria)),
            perception,
        }
        .normalized();
        // The typed document is re-validated through the input contract so a
        // builder defect surfaces as structured findings, never as a runtime
        // engine rejection three layers later.
        let input =
            simforge_core::types::parse_scenario_input_value(&serde_json::to_value(&input)?)
                .map_err(|e| CompileError::from(simforge_core::error::CoreError::from(e)))?;

        // --- arrival: the criticality that makes the scenario a scenario ----
        let (input, mut solutions) = self.solve_role_arrivals(input)?;

        // Timeline-level `arrival` triggers are baked here rather than left for
        // the engine so the instance file is a fully resolved document.
        let resolved = resolve_arrival_triggers(&input, self.graph());
        let mut input = resolved.input.normalized();
        solutions.extend(resolved.solutions);
        for issue in resolved.issues {
            let interaction_id = issue.path.split('.').nth(1).unwrap_or("");
            let authored = self.template.interaction(interaction_id);
            let role = authored.and_then(|a| self.role_by_id.get(a.base.actor.as_str()));
            if let (Some(authored), Some(role)) = (authored, role) {
                if matches!(authored.base.trigger, t::Trigger::Arrival { .. })
                    && role.base.essentiality == t::Essentiality::Required
                {
                    let code =
                        if issue.code == simforge_core::error::SimIssueCode::ArrivalUnsolvable {
                            "arrival_unconverged".to_owned()
                        } else {
                            issue.code.as_str().to_owned()
                        };
                    return Err(CompileError::at(
                        code,
                        issue.path,
                        format!(
                            "required arrival interaction \"{}\" cannot be resolved",
                            authored.base.id
                        ),
                    )
                    .with_detail(detail(&[
                        ("reason", Value::String(issue.reason)),
                        ("siteId", Value::String(self.site.site_id.clone())),
                    ]))
                    .as_findings());
                }
            }
            self.notes.push(Note::loss(
                issue.path,
                format!("{}: {}", issue.code.as_str(), issue.reason),
            ));
        }

        self.assert_delivery_geometry_eligibility(&input, &solutions)?;

        let issues = check_feasibility(&input, self.graph());
        let feasible = !issues
            .iter()
            .any(|i| i.severity == simforge_core::error::SimIssueSeverity::Error);

        // --- ambient traffic: deliberately last ---------------------------
        // The authored scenario is fully solved and its verdict fixed, so
        // background traffic cannot alter the authored answer.
        let mut ambient_provenance = None;
        let mut ambient_settle_provenance = None;
        let settle_seconds = self.options.ambient_settle_seconds;
        if let Some(profile) = &self.options.ambient {
            let resolved_ambient = resolve_ambient_traffic_profile(profile)?;
            if resolved_ambient.preset != AmbientPreset::Off {
                // With a settle the placed population is a COHORT, re-selected
                // against the positions it holds at t=0.
                let options = if settle_seconds > 0.0 {
                    AmbientTrafficOptions {
                        target_multiplier: AMBIENT_SETTLE_COHORT_MULTIPLIER,
                        cohort_radius_bonus_m: settle_seconds * AMBIENT_SETTLE_COHORT_MPS,
                        ..Default::default()
                    }
                } else {
                    AmbientTrafficOptions::default()
                };
                let applied =
                    apply_ambient_traffic(&input, self.graph(), &resolved_ambient, &options)?;
                input = applied.input;
                let mut provenance = applied.provenance;
                if settle_seconds > 0.0 {
                    let cohort_ids: Vec<String> =
                        provenance.actors.iter().map(|a| a.id.clone()).collect();
                    let settled = settle_ambient_traffic(
                        &input,
                        self.graph(),
                        &AmbientSettleOptions {
                            settle_seconds,
                            ambient_actor_ids: Some(cohort_ids),
                            dt: None,
                            keep: Some(provenance.placement_target),
                            exclusion_radius_m: resolved_ambient.exclusion_radius_m,
                        },
                    )?;
                    input = settled.input;
                    if settled.provenance.is_some() {
                        // The manifest must describe the population the clip
                        // records, not the cohort that was settled to produce it.
                        let kept: BTreeSet<&str> =
                            input.actors.iter().map(|a| a.id.as_str()).collect();
                        provenance.actors.retain(|a| kept.contains(a.id.as_str()));
                    }
                    ambient_settle_provenance = settled.provenance;
                }
                ambient_provenance = Some(provenance);
            }
        }

        let ambient_profile_hash = match &ambient_provenance {
            None => "none".to_owned(),
            Some(p) if settle_seconds > 0.0 => format!("{}+settle{settle_seconds}", p.profile_hash),
            Some(p) => p.profile_hash.clone(),
        };
        let key = ReplayKey {
            template_id: self.template.template_id().to_owned(),
            template_version: self.template.scenario_version,
            template_digest: content_hash_of(self.template)?[..16].to_owned(),
            map_id: self.bundle.map_id().to_owned(),
            matcher_index_digest: self.site.topology_digest.clone(),
            engine_graph_digest: self.graph().topology_digest().to_owned(),
            site_id: self.site.site_id.clone(),
            matcher_version: crate::anchor::MATCH_SEMANTICS_VERSION.to_owned(),
            solver_version: ENGINE_VERSION.to_owned(),
            param_seed: self.draw.param_seed.clone(),
            draw_index: self.options.draw_index,
            ambient_profile_hash,
        };

        let mut observations = Vec::with_capacity(self.options.observations.len());
        for observation in &self.options.observations {
            let path = format!("observations.{}", observation.id);
            self.assert_observation_condition(&observation.condition, &path)?;
            let notes_before = self.notes.len();
            let scope = self.base_scope(None);
            let lowered = self.build_condition(&observation.condition, &scope, &path)?;
            match lowered {
                Some(condition) if self.notes.len() == notes_before => {
                    observations.push(LoweredObservation {
                        id: observation.id.clone(),
                        condition,
                    })
                }
                _ => {
                    let notes: Vec<Value> = self.notes[notes_before..]
                        .iter()
                        .map(|n| serde_json::to_value(n).unwrap_or(Value::Null))
                        .collect();
                    return Err(CompileError::at(
                        "observation_unresolved",
                        path,
                        "diagnostic condition could not be lowered without semantic loss",
                    )
                    .with_detail(detail(&[("notes", Value::Array(notes))]))
                    .as_findings());
                }
            }
        }

        let manifest = InstanceManifest {
            kind: "scenario-instance-manifest",
            manifest_version: 1,
            instance_id: format!("{}#{}", key.site_id, key.draw_index),
            replay_key: key,
            archetype: self.template.meta.archetype.clone(),
            negative_control: self.template.meta.negative_control,
            metric_subject: input.metric_subject.clone(),
            operational_variant: self
                .options
                .variant
                .as_ref()
                .map(|v| AppliedCatalogVariant {
                    variant: v.clone(),
                    concrete: input.operational_conditions,
                }),
            site: ManifestSite {
                site_id: self.site.site_id.clone(),
                score: self.site.score,
                verdict: self.site.degradation.verdict,
                origin_feature_id: self.site.frame.origin.map_feature_id.clone(),
                entry_lane_rsl: self.site.frame.entry_lane_rsl.clone(),
                ego_turn: self.site.frame.ego_turn,
                degradation_summary: self.site.degradation.summary.clone(),
                matched_reasons: self.site.matched_reasons.clone(),
            },
            params: ManifestParams {
                values: self.draw.values.clone(),
                categorical: self.draw.categorical.clone(),
                rejected_constraints: self.draw.rejected_constraints.clone(),
            },
            actors: input
                .actors
                .iter()
                .map(|a| {
                    let ambient = a.has_tag("ambient");
                    ManifestActor {
                        id: a.id.clone(),
                        actor_kind: a.kind,
                        role_kind: self.role_by_id.get(a.id.as_str()).map_or_else(
                            || if ambient { "ambient" } else { "unknown" }.to_owned(),
                            |r| r.kind.name().to_owned(),
                        ),
                        lane_rsl: a.initial.lane_ref.as_ref().map(|l| l.rsl.clone()),
                        spawn_s: self.spawn_s_by_role.get(&a.id).copied().unwrap_or(0.0),
                        initial_speed_mps: a.initial.speed_mps,
                        binding_status: self.binding_by_role.get(a.id.as_str()).map_or_else(
                            || if ambient { "generated" } else { "unknown" }.to_owned(),
                            |b| b.status.as_str().to_owned(),
                        ),
                    }
                })
                .collect(),
            props: input.props.clone(),
            arrival: solutions,
            input_hash: content_hash_of(&input)?,
            feasible,
            issues,
            ambient: ambient_provenance,
            ambient_settle: ambient_settle_provenance,
            initial_interaction_outcomes: self.initial_interaction_outcomes.clone(),
            notes: self.notes.clone(),
        };
        Ok(MaterializeResult {
            input,
            manifest,
            observations,
        })
    }
}
