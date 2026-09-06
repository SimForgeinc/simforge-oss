//! The arrival solver.
//!
//! `arrival(of, at, sync_with, ttc | delta_t)` back-solves **where the
//! challenger starts** so that it reaches a conflict point at a declared
//! criticality relative to a reference actor's nominal motion.
//!
//! `ttc: 1.5` — when `of` reaches the point, `sync_with` is 1.5 s away from
//! it. `delta_t: -1.5` — `of` reaches the point 1.5 s before `sync_with`.
//! `ttc == -delta_t`, so the solver works internally in `delta_t`.
//!
//! `t_of(δ)` is strictly decreasing in the spawn-`s` offset δ, so bisection on
//! `[-start_s, route_length - start_s)` converges monotonically. Tolerance is
//! 1 mm of spawn `s`; a fixed 80-iteration cap makes the iteration count
//! itself deterministic. A solve is a nominal 1-D integration, not a full
//! simulation.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{SimIssue, SimIssueCode};
use crate::map::{build_route, LaneGraph, Route};
use crate::math::{atan2, cos, sin, to_scene_xz};
use crate::types::{ArrivalPoint, ArrivalSpec, LaneRef, Pose, SimActor, SimScenarioInput, Trigger};

use super::nominal::{nominal_run, NominalActor, NominalRunOptions};

/// Spawn-`s` tolerance, metres.
pub const ARRIVAL_TOLERANCE_M: f64 = 1e-3;
const MAX_ITERATIONS: usize = 80;
/// A geometry-only point must actually lie on the route (2 m covers
/// centre-of-carriageway conflict points between ordinary lanes).
const MAX_GEOMETRIC_ARRIVAL_PROJECTION_M: f64 = 2.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrivalSolution {
    pub interaction_id: Option<String>,
    /// The actor whose spawn was moved.
    pub actor_id: String,
    pub reference_actor_id: String,
    /// Signed change applied to the actor's spawn arc length, metres.
    pub spawn_delta_s: f64,
    /// Resulting spawn arc length on the actor's route.
    pub spawn_s: f64,
    /// Requested `t_of − t_ref`, seconds.
    pub target_delta_t: f64,
    pub achieved_delta_t: f64,
    /// Achieved criticality in TTC form (`−achieved_delta_t`).
    pub achieved_ttc: f64,
    /// Time `of` reaches the point — the time an `arrival` trigger fires.
    pub fire_time: f64,
    pub iterations: u32,
    pub converged: bool,
}

#[derive(Debug, Clone)]
pub struct ArrivalResolution {
    pub input: SimScenarioInput,
    pub solutions: Vec<ArrivalSolution>,
    pub issues: Vec<SimIssue>,
}

struct Prepared {
    route: Route,
    start_s: f64,
    target_s: f64,
}

fn start_station(route: &Route, graph: &LaneGraph, lane_ref: Option<&LaneRef>, pose: &Pose) -> f64 {
    lane_ref
        .and_then(|lr| {
            graph
                .lane_id(&lr.rsl)
                .and_then(|lane| route.s_of_lane_storage(lane, lr.s))
        })
        .unwrap_or_else(|| route.project_point(pose.position_local()).s)
}

fn prepare(graph: &Arc<LaneGraph>, actor: &SimActor, point: &ArrivalPoint) -> Option<Prepared> {
    let route = build_route(graph, &actor.behavior.route).ok()?;
    let start_s = start_station(
        &route,
        graph,
        actor.initial.lane_ref.as_ref(),
        &actor.initial.pose,
    );
    let target_s = match point {
        ArrivalPoint::LaneS { rsl, s } => graph
            .lane_id(rsl)
            .and_then(|lane| route.s_of_lane_storage(lane, *s)),
        ArrivalPoint::Point {
            at,
            reference_frame,
        } => {
            let mut target = None;
            if let (Some(frame), false) = (reference_frame, route.is_freeform()) {
                for station in &frame.stations {
                    if let Some(s) = graph
                        .lane_id(&station.rsl)
                        .and_then(|lane| route.s_of_lane_storage(lane, station.s))
                    {
                        target = Some(s);
                        break;
                    }
                }
            }
            // A declared reference frame is a lane-domain proof, not a hint;
            // only freeform routes (no lane identity) use the bounded
            // geometric test.
            if target.is_none() && (reference_frame.is_none() || route.is_freeform()) {
                let proj = route.project_point(at.to_local());
                if proj.d <= MAX_GEOMETRIC_ARRIVAL_PROJECTION_M {
                    target = Some(proj.s);
                }
            }
            target
        }
    }?;
    Some(Prepared {
        route,
        start_s,
        target_s,
    })
}

fn nominal<'a>(actor: &SimActor, route: &'a Route, start_s: f64) -> NominalActor<'a> {
    NominalActor {
        kind: actor.kind,
        route,
        start_s,
        initial_speed_mps: actor.initial.speed_mps,
        speed_factor: actor.behavior.rules.speed_factor,
        cruise_override_mps: actor.behavior.cruise_speed_mps,
    }
}

fn unsolvable(path: &str, reason: String) -> SimIssue {
    SimIssue::error(SimIssueCode::ArrivalUnsolvable, path.to_owned(), reason)
}

/// Standalone solve. Returns the solution without mutating the input; use
/// [`apply_arrival_solution`] (or [`resolve_arrival_triggers`]) to write it
/// back.
pub fn solve_arrival(
    input: &SimScenarioInput,
    spec: &ArrivalSpec,
    graph: &Arc<LaneGraph>,
    interaction_id: Option<&str>,
) -> Result<ArrivalSolution, SimIssue> {
    let path = format!(
        "interactions.{}.trigger.arrival",
        interaction_id.unwrap_or("<standalone>")
    );
    let of_actor = input.actors.iter().find(|a| a.id == spec.of);
    let ref_actor = input.actors.iter().find(|a| a.id == spec.sync_with);
    let (Some(of_actor), Some(ref_actor)) = (of_actor, ref_actor) else {
        let mut detail = serde_json::Map::new();
        detail.insert("of".into(), spec.of.clone().into());
        detail.insert("syncWith".into(), spec.sync_with.clone().into());
        return Err(SimIssue::error(
            SimIssueCode::ActorUnknown,
            path,
            "arrival references an unknown actor",
        )
        .with_detail(detail));
    };
    let of_prep = prepare(graph, of_actor, &spec.at);
    let ref_prep = prepare(graph, ref_actor, &spec.at);
    let missing = if of_prep.is_none() {
        &spec.of
    } else {
        &spec.sync_with
    };
    let (Some(of_prep), Some(ref_prep)) = (of_prep, ref_prep) else {
        return Err(unsolvable(
            &path,
            format!("the arrival point is not on {missing}'s route"),
        ));
    };
    let run_opts = NominalRunOptions {
        dt: input.dt,
        warmup_seconds: input.warmup_seconds,
        horizon_seconds: input.clip_seconds,
        bound_by_route: true,
    };
    let ref_probe = nominal_run(
        graph,
        &nominal(ref_actor, &ref_prep.route, ref_prep.start_s),
        Some(ref_prep.target_s),
        &run_opts,
    );
    let Some(t_ref) = ref_probe.t_at_target else {
        return Err(unsolvable(
            &path,
            format!(
                "{} never reaches the arrival point within the clip",
                spec.sync_with
            ),
        ));
    };
    let target_delta_t = match spec.delta_t {
        Some(d) => d,
        None => -spec.ttc.expect("validated arrival has ttc or deltaT"),
    };
    let want_t = t_ref + target_delta_t;
    let start_s = of_prep.start_s;
    let target_s = of_prep.target_s;
    let probe_at = |delta: f64| -> Option<f64> {
        let s = start_s + delta;
        if s < 0.0 || s >= target_s {
            return None;
        }
        nominal_run(
            graph,
            &nominal(of_actor, &of_prep.route, s),
            Some(target_s),
            &run_opts,
        )
        .t_at_target
    };
    let mut lo = -start_s;
    let mut hi = target_s - start_s - 0.05;
    if hi <= lo {
        let mut detail = serde_json::Map::new();
        detail.insert("startS".into(), start_s.into());
        detail.insert("targetS".into(), target_s.into());
        return Err(unsolvable(
            &path,
            format!("{} has no room to move on its route", spec.of),
        )
        .with_detail(detail));
    }
    let t_lo = probe_at(lo);
    let t_hi = probe_at(hi);
    let mut converged = true;
    if t_lo.map_or(false, |t| want_t > t) || t_hi.map_or(false, |t| want_t < t) {
        converged = false;
    }
    let mut iterations = 0u32;
    while hi - lo > ARRIVAL_TOLERANCE_M && (iterations as usize) < MAX_ITERATIONS {
        iterations += 1;
        let mid = (lo + hi) / 2.0;
        match probe_at(mid) {
            Some(t_mid) if t_mid <= want_t => hi = mid,
            _ => lo = mid,
        }
    }
    let delta = (lo + hi) / 2.0;
    let Some(achieved_t) = probe_at(delta) else {
        return Err(unsolvable(
            &path,
            format!("{} never reaches the arrival point", spec.of),
        ));
    };
    let achieved_delta_t = achieved_t - t_ref;
    if (achieved_delta_t - target_delta_t).abs() > 0.05 {
        converged = false;
    }
    Ok(ArrivalSolution {
        interaction_id: interaction_id.map(str::to_owned),
        actor_id: spec.of.clone(),
        reference_actor_id: spec.sync_with.clone(),
        spawn_delta_s: delta,
        spawn_s: start_s + delta,
        target_delta_t,
        achieved_delta_t,
        achieved_ttc: -achieved_delta_t,
        fire_time: achieved_t,
        iterations,
        converged,
    })
}

/// Rewrite an actor's spawn pose / lane ref to the solved arc length.
pub fn apply_arrival_solution(
    mut input: SimScenarioInput,
    solution: &ArrivalSolution,
    graph: &Arc<LaneGraph>,
) -> SimScenarioInput {
    let Some(a) = input.actors.iter_mut().find(|a| a.id == solution.actor_id) else {
        return input;
    };
    let Ok(route) = build_route(graph, &a.behavior.route) else {
        return input;
    };
    let old_point = a.initial.pose.position_local();
    let old_route_s = start_station(&route, graph, a.initial.lane_ref.as_ref(), &a.initial.pose);
    let old_pose = route.pose_at(old_route_s);
    let d = a.initial.pose.heading_rad - old_pose.heading_rad;
    let heading_offset = atan2(sin(d), cos(d));
    let lateral_m = match &a.initial.lane_ref {
        Some(lr) => lr.t_frac * route.width_at(solution.spawn_s),
        None => route.lateral_offset_at(old_route_s, old_point),
    };
    let pose = route.pose_at(solution.spawn_s);
    let scene = to_scene_xz(route.point_with_offset(solution.spawn_s, lateral_m));
    let t_frac = a.initial.lane_ref.as_ref().map_or(0.0, |lr| lr.t_frac);
    a.initial.pose = Pose {
        x: scene.x,
        z: scene.z,
        heading_rad: pose.heading_rad + heading_offset,
    };
    if let Some(lane) = pose.lane {
        a.initial.lane_ref = Some(LaneRef {
            rsl: graph.rsl(lane).to_owned(),
            s: pose.storage_s,
            t_frac,
        });
    }
    input
}

/// Pre-sim resolution pass: solve every `arrival` trigger, move the
/// challengers' spawns, and rewrite the triggers into fixed `at(t)` times.
/// Solves are applied in sorted interaction-id order and each one sees the
/// document produced by the previous, so chained arrivals are reproducible.
pub fn resolve_arrival_triggers(
    input: &SimScenarioInput,
    graph: &Arc<LaneGraph>,
) -> ArrivalResolution {
    let mut arrivals: Vec<(String, ArrivalSpec)> = input
        .interactions
        .iter()
        .filter_map(|it| match &it.trigger {
            Trigger::Arrival { arrival } => Some((it.id.clone(), arrival.clone())),
            _ => None,
        })
        .collect();
    if arrivals.is_empty() {
        return ArrivalResolution {
            input: input.clone(),
            solutions: Vec::new(),
            issues: Vec::new(),
        };
    }
    arrivals.sort_by(|a, b| a.0.cmp(&b.0));
    let mut current = input.clone();
    let mut solutions = Vec::new();
    let mut issues = Vec::new();
    let mut fire_times: Vec<(String, f64)> = Vec::new();
    for (id, spec) in &arrivals {
        match solve_arrival(&current, spec, graph, Some(id)) {
            Err(issue) => issues.push(issue),
            Ok(solution) => {
                if !solution.converged {
                    let mut detail = serde_json::Map::new();
                    detail.insert("achievedDeltaT".into(), solution.achieved_delta_t.into());
                    detail.insert("targetDeltaT".into(), solution.target_delta_t.into());
                    issues.push(
                        SimIssue::warning(
                            SimIssueCode::ArrivalUnsolvable,
                            format!("interactions.{id}.trigger.arrival"),
                            format!(
                                "clamped: achieved Δt {:.3} s vs requested {:.3} s",
                                solution.achieved_delta_t, solution.target_delta_t
                            ),
                        )
                        .with_detail(detail),
                    );
                }
                current = apply_arrival_solution(current, &solution, graph);
                fire_times.push((id.clone(), solution.fire_time));
                solutions.push(solution);
            }
        }
    }
    for it in &mut current.interactions {
        if !matches!(it.trigger, Trigger::Arrival { .. }) {
            continue;
        }
        if let Some((_, t)) = fire_times.iter().find(|(id, _)| id == &it.id) {
            it.trigger = Trigger::At { t: t.max(0.0) };
        }
    }
    ArrivalResolution {
        input: current,
        solutions,
        issues,
    }
}
