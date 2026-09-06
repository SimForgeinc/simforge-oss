//! Pre-run feasibility guards: runway over the whole clip, required decel
//! within budget, disjoint spawn OBBs, spawn stations within their lane and on
//! the actor's route, connected routes, and timed-route kinematic envelopes.
//! Every finding is a [`SimIssue`] a repair loop can act on.

use std::sync::Arc;

use crate::engine::actor::ActorRuntime;
use crate::engine::controllers::limits_for_kind;
use crate::engine::dynamics::transition_duration;
use crate::error::{SimIssue, SimIssueCode};
use crate::map::{build_route, LaneGraph, Route, ENDPOINT_TOL_M};
use crate::math::{hypot, obb_overlap, Obb};
use crate::types::{ActorKind, ExistState, SimActor, SimScenarioInput, Verb};

use super::nominal::{action_aware_runway_need_m, speed_target_value, NominalActor};

/// Comfort and hard deceleration budgets, m/s².
pub const COMFORT_DECEL_MPS2: f64 = 5.5;
pub const HARD_DECEL_MPS2: f64 = 8.0;

struct Resolved<'a> {
    spec: &'a SimActor,
    route: Route,
    start_s: f64,
}

fn resolve_actor<'a>(
    graph: &Arc<LaneGraph>,
    spec: &'a SimActor,
    issues: &mut Vec<SimIssue>,
) -> Option<Resolved<'a>> {
    let route = match build_route(graph, &spec.behavior.route) {
        Ok(r) => r,
        Err(e) => {
            issues.push(e.into_issue(format!("actors.{}.behavior.route", spec.id)));
            return None;
        }
    };
    let pose_point = spec.initial.pose.position_local();
    let start_s = match &spec.initial.lane_ref {
        Some(lane_ref) => {
            let Some(lane) = graph.lane_id(&lane_ref.rsl) else {
                issues.push(SimIssue::error(
                    SimIssueCode::RouteLaneMissing,
                    format!("actors.{}.initial.laneRef.rsl", spec.id),
                    format!("lane {} not in topology", lane_ref.rsl),
                ));
                return None;
            };
            let length_m = graph.length_of(lane);
            if lane_ref.s > length_m + 1e-6 {
                let mut detail = serde_json::Map::new();
                detail.insert("s".into(), lane_ref.s.into());
                detail.insert("laneLengthM".into(), length_m.into());
                issues.push(
                    SimIssue::error(
                        SimIssueCode::SpawnOffLane,
                        format!("actors.{}.initial.laneRef.s", spec.id),
                        format!(
                            "spawn s={:.2} m exceeds lane {} length {:.2} m",
                            lane_ref.s, lane_ref.rsl, length_m
                        ),
                    )
                    .with_detail(detail),
                );
                return None;
            }
            match route.s_of_lane_storage(lane, lane_ref.s) {
                Some(s) => s,
                None => {
                    let mut detail = serde_json::Map::new();
                    detail.insert("rsl".into(), lane_ref.rsl.clone().into());
                    issues.push(
                        SimIssue::error(
                            SimIssueCode::SpawnLaneNotOnRoute,
                            format!("actors.{}.initial.laneRef.rsl", spec.id),
                            format!("spawn lane {} is not on the actor's route", lane_ref.rsl),
                        )
                        .with_detail(detail),
                    );
                    route.project_point(pose_point).s
                }
            }
        }
        None => route.project_point(pose_point).s,
    };
    Some(Resolved {
        spec,
        route,
        start_s,
    })
}

fn check_connectivity(graph: &LaneGraph, r: &Resolved<'_>, issues: &mut Vec<SimIssue>) {
    let legs = r.route.legs();
    for i in 1..legs.len() {
        let prev = &legs[i - 1];
        let cur = &legs[i];
        let exit = graph.endpoints(prev.directed()).exit;
        let entry = graph.endpoints(cur.directed()).entry;
        let gap = hypot(exit.x - entry.x, exit.y - entry.y);
        if gap > ENDPOINT_TOL_M {
            let mut detail = serde_json::Map::new();
            detail.insert("from".into(), graph.rsl(prev.lane).into());
            detail.insert("to".into(), graph.rsl(cur.lane).into());
            detail.insert("gapM".into(), gap.into());
            issues.push(
                SimIssue::error(
                    SimIssueCode::RouteDisconnected,
                    format!("actors.{}.behavior.route", r.spec.id),
                    format!(
                        "lanes {} → {} are {gap:.2} m apart (limit {ENDPOINT_TOL_M} m)",
                        graph.rsl(prev.lane),
                        graph.rsl(cur.lane)
                    ),
                )
                .with_detail(detail),
            );
        }
    }
}

fn check_runway(
    graph: &LaneGraph,
    input: &SimScenarioInput,
    r: &Resolved<'_>,
    issues: &mut Vec<SimIssue>,
) {
    // Pedestrians and freeform paths legitimately end mid-clip; the whole-clip
    // runway rule applies to vehicles on lane routes only.
    if r.spec.is_static || !r.spec.kind.is_road_actor() || r.route.is_freeform() {
        return;
    }
    let despawned = input.interactions.iter().any(|it| {
        it.actor_id == r.spec.id
            && matches!(&it.verb, Verb::Exist { target } if target.state == ExistState::Absent)
    });
    if despawned {
        return;
    }
    let nominal = NominalActor {
        kind: r.spec.kind,
        route: &r.route,
        start_s: r.start_s,
        initial_speed_mps: r.spec.initial.speed_mps,
        speed_factor: r.spec.behavior.rules.speed_factor,
        cruise_override_mps: r.spec.behavior.cruise_speed_mps,
    };
    let need = action_aware_runway_need_m(
        graph,
        &nominal,
        &r.spec.id,
        &input.interactions,
        input.dt,
        input.warmup_seconds,
        input.clip_seconds,
    );
    let available = r.route.length_m() - r.start_s;
    if available < need {
        let mut detail = serde_json::Map::new();
        detail.insert("availableM".into(), available.into());
        detail.insert("neededM".into(), need.into());
        detail.insert("clipSeconds".into(), input.clip_seconds.into());
        issues.push(
            SimIssue::warning(
                SimIssueCode::RunwayInsufficient,
                format!("actors.{}.behavior.route", r.spec.id),
                format!("route provides {available:.1} m ahead of the spawn but the actor covers {need:.1} m in {} s", input.clip_seconds),
            )
            .with_detail(detail),
        );
    }
}

fn check_decel_budget(input: &SimScenarioInput, issues: &mut Vec<SimIssue>) {
    for it in &input.interactions {
        let Verb::Speed { target, dynamics } = &it.verb else {
            continue;
        };
        let Some(actor) = input.actors.iter().find(|a| a.id == it.actor_id) else {
            continue;
        };
        let v0 = actor.initial.speed_mps;
        // `match` depends on a runtime speed; the run reports it.
        let Some(v_target) = speed_target_value(target, v0) else {
            continue;
        };
        let dv = v_target - v0;
        if dv >= 0.0 {
            continue;
        }
        let duration = transition_duration(dynamics, dv, v0.max(0.1));
        let implied = dv.abs() / duration.max(1e-6);
        let budget = if implied > HARD_DECEL_MPS2 {
            Some((HARD_DECEL_MPS2, "hard"))
        } else if implied > COMFORT_DECEL_MPS2 {
            Some((COMFORT_DECEL_MPS2, "comfort"))
        } else {
            None
        };
        if let Some((budget, label)) = budget {
            let mut detail = serde_json::Map::new();
            detail.insert("impliedDecel".into(), implied.into());
            detail.insert("budget".into(), budget.into());
            issues.push(
                SimIssue::warning(
                    SimIssueCode::DecelBudgetExceeded,
                    format!("interactions.{}.dynamics", it.id),
                    format!("implies {implied:.2} m/s² of braking, above the {budget} m/s² {label} limit"),
                )
                .with_detail(detail),
            );
        }
    }
}

fn spawn_obb(r: &Resolved<'_>) -> Obb {
    let pose = r.route.pose_at(r.start_s);
    let lateral = match &r.spec.initial.lane_ref {
        Some(lr) => lr.t_frac * r.route.width_at(r.start_s),
        None => r
            .route
            .lateral_offset_at(r.start_s, r.spec.initial.pose.position_local()),
    };
    Obb {
        center: r.route.point_with_offset(r.start_s, lateral),
        length_m: r.spec.dims.l,
        width_m: r.spec.dims.w,
        heading_rad: pose.heading_rad,
    }
}

fn check_spawn_overlap(resolved: &[Resolved<'_>], issues: &mut Vec<SimIssue>) {
    let present: Vec<&Resolved<'_>> = resolved
        .iter()
        .filter(|r| r.spec.present_at_start)
        .collect();
    let boxes: Vec<Obb> = present.iter().map(|r| spawn_obb(r)).collect();
    for i in 0..present.len() {
        for j in (i + 1)..present.len() {
            if !obb_overlap(&boxes[i], &boxes[j]) {
                continue;
            }
            let a = &present[i].spec.id;
            let b = &present[j].spec.id;
            let mut detail = serde_json::Map::new();
            detail.insert("a".into(), a.clone().into());
            detail.insert("b".into(), b.clone().into());
            issues.push(
                SimIssue::error(
                    SimIssueCode::SpawnOverlap,
                    format!("actors.{a}.initial"),
                    format!("spawn footprint overlaps {b}"),
                )
                .with_detail(detail),
            );
        }
    }
}

/// Run every guard. Issues are sorted by `(path, code)` so the list itself is
/// deterministic. Infeasibility is reported, never thrown: the caller's
/// [`crate::engine::GuardMode`] decides.
pub fn check_feasibility(input: &SimScenarioInput, graph: &Arc<LaneGraph>) -> Vec<SimIssue> {
    let mut issues = Vec::new();
    let mut specs: Vec<&SimActor> = input.actors.iter().collect();
    specs.sort_by(|a, b| a.id.cmp(&b.id));
    let mut resolved = Vec::with_capacity(specs.len());
    for spec in specs {
        if let Some(r) = resolve_actor(graph, spec, &mut issues) {
            resolved.push(r);
        }
    }
    for r in &resolved {
        check_connectivity(graph, r, &mut issues);
        check_runway(graph, input, r, &mut issues);
    }
    check_decel_budget(input, &mut issues);
    check_spawn_overlap(&resolved, &mut issues);
    issues.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then_with(|| a.code.as_str().cmp(b.code.as_str()))
    });
    issues
}

/// Peak speed envelope per class for exact-time authored trajectories, m/s.
pub const fn timed_route_speed_envelope_mps(kind: ActorKind) -> f64 {
    match kind {
        ActorKind::Vehicle | ActorKind::Car => 55.0,
        ActorKind::Truck => 36.0,
        ActorKind::Bus => 32.0,
        ActorKind::Van => 45.0,
        ActorKind::Motorcycle => 60.0,
        ActorKind::Bicycle => 16.0,
        ActorKind::Pedestrian => 4.5,
        ActorKind::Scooter => 12.0,
        ActorKind::SidewalkRobot => 4.0,
        ActorKind::Drone => 30.0,
        ActorKind::Animal => 15.0,
        ActorKind::StaticObject => 0.0,
    }
}

/// Warn when a timed route demands more speed / acceleration than the
/// actor's class envelope can deliver. Appends to `issues`.
pub fn timed_route_feasibility_issues(
    actor: &ActorRuntime,
    path: &str,
    issues: &mut Vec<SimIssue>,
) {
    let Some(timed) = &actor.timed_route else {
        return;
    };
    if actor.kind == ActorKind::StaticObject {
        return;
    }
    let Some(extrema) = timed.kinematic_extrema() else {
        return;
    };
    let limits = limits_for_kind(actor.kind);
    let speed_envelope = timed_route_speed_envelope_mps(actor.kind);
    let lateral_envelope = limits
        .lateral_accel_max
        .max(actor.driver.comfortable_lateral_acceleration_mps2 * 1.5);
    let longitudinal_envelope = limits.accel_max.max(limits.brake_hard);
    let kind = actor.kind.as_str();
    let detail = |segment: usize, required: f64, envelope: f64, unit: &str| {
        let mut d = serde_json::Map::new();
        d.insert("actorId".into(), actor.id.clone().into());
        d.insert("segmentIndex".into(), (segment as u64).into());
        d.insert(format!("required{unit}"), required.into());
        d.insert(format!("envelope{unit}"), envelope.into());
        d
    };
    let peak = extrema.max_speed_mps;
    if peak.value > speed_envelope + 1e-6 {
        issues.push(
            SimIssue::warning(
                SimIssueCode::TimedRouteSpeedUnreachable,
                path,
                format!("timed waypoint {} requires up to {:.1} m/s, above the {:.1} m/s {kind} envelope; add more time or move the point closer", peak.segment + 1, peak.value, speed_envelope),
            )
            .with_detail(detail(peak.segment, peak.value, speed_envelope, "Mps")),
        );
    }
    let peak = extrema.max_longitudinal_accel_mps2;
    if peak.value > longitudinal_envelope + 1e-6 {
        issues.push(
            SimIssue::warning(
                SimIssueCode::TimedRouteAccelerationUnreachable,
                path,
                format!("timed waypoint {} requires {:.1} m/s² longitudinal acceleration, above the {:.1} m/s² {kind} envelope; add more time between points", peak.segment + 1, peak.value, longitudinal_envelope),
            )
            .with_detail(detail(peak.segment, peak.value, longitudinal_envelope, "Mps2")),
        );
    }
    let peak = extrema.max_lateral_accel_mps2;
    if peak.value > lateral_envelope + 1e-6 {
        issues.push(
            SimIssue::warning(
                SimIssueCode::TimedRouteTurnUnreachable,
                path,
                format!("timed waypoint {} requires {:.1} m/s² lateral acceleration, above the {:.1} m/s² {kind} turning envelope; widen the turn or add more time", peak.segment + 1, peak.value, lateral_envelope),
            )
            .with_detail(detail(peak.segment, peak.value, lateral_envelope, "Mps2")),
        );
    }
}
