//! Free-flow ("nominal") longitudinal motion — the reference the arrival
//! solver and the runway guard reason about.
//!
//! A nominal run is the actor alone on its route: it converges on its cruise
//! speed with the same first-order law the engine's default controller uses,
//! and ignores every interaction, leader, signal and conflict. Arrival time is
//! then a **monotone** function of spawn `s`, which lets bisection be both
//! deterministic and cheap. Integration starts at `t = -warmup_seconds`.

use std::collections::BTreeMap;

use crate::engine::controllers::{limits_for_kind, CRUISE_GAIN};
use crate::engine::dynamics::{transition_duration, transition_value};
use crate::map::{LaneGraph, Route};
use crate::math::clamp;
use crate::types::{ActorKind, IfNever, Interaction, SpeedTarget, Trigger, Verb};

#[derive(Debug, Clone)]
pub struct NominalActor<'a> {
    pub kind: ActorKind,
    pub route: &'a Route,
    pub start_s: f64,
    pub initial_speed_mps: f64,
    pub speed_factor: f64,
    pub cruise_override_mps: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NominalRunOptions {
    pub dt: f64,
    pub warmup_seconds: f64,
    pub horizon_seconds: f64,
    pub bound_by_route: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NominalProbe {
    /// Simulation time the actor reaches `target_s`, or `None` if it never does.
    pub t_at_target: Option<f64>,
    /// Distance covered by the end of the horizon.
    pub distance_m: f64,
    pub final_speed_mps: f64,
}

fn cruise_at(graph: &LaneGraph, a: &NominalActor<'_>, s: f64) -> f64 {
    if let Some(v) = a.cruise_override_mps {
        return v;
    }
    match a.route.pose_at(s).lane {
        None => {
            (if a.kind.is_pedestrian_like() {
                1.4
            } else {
                13.4
            }) * a.speed_factor
        }
        Some(lane) => graph.geometry(lane).speed_limit_mps * a.speed_factor,
    }
}

/// Integrate free-flow motion from `-warmup_seconds` and report when the
/// actor passes `target_s` (linear interpolation inside the crossing tick).
pub fn nominal_run(
    graph: &LaneGraph,
    a: &NominalActor<'_>,
    target_s: Option<f64>,
    opts: &NominalRunOptions,
) -> NominalProbe {
    let lim = limits_for_kind(a.kind);
    let mut v = a.initial_speed_mps;
    let mut s = a.start_s;
    let mut t = -opts.warmup_seconds;
    if let Some(target) = target_s {
        if s >= target {
            return NominalProbe {
                t_at_target: Some(t),
                distance_m: 0.0,
                final_speed_mps: v,
            };
        }
    }
    let steps = ((opts.horizon_seconds + opts.warmup_seconds) / opts.dt).ceil() as u64;
    for _ in 0..steps {
        let target = cruise_at(graph, a, s);
        let accel = clamp(
            (target - v) * CRUISE_GAIN,
            -lim.brake_comfort,
            lim.accel_max,
        );
        let v_next = (v + accel * opts.dt).max(0.0);
        let s_next = s + v_next * opts.dt;
        if let Some(target_s) = target_s {
            if s_next >= target_s {
                let span = s_next - s;
                let frac = if span > 1e-9 {
                    (target_s - s) / span
                } else {
                    0.0
                };
                return NominalProbe {
                    t_at_target: Some(t + frac * opts.dt),
                    distance_m: target_s - a.start_s,
                    final_speed_mps: v_next,
                };
            }
        }
        if opts.bound_by_route && s_next >= a.route.length_m() {
            return NominalProbe {
                t_at_target: None,
                distance_m: a.route.length_m() - a.start_s,
                final_speed_mps: v_next,
            };
        }
        v = v_next;
        s = s_next;
        t += opts.dt;
    }
    NominalProbe {
        t_at_target: None,
        distance_m: s - a.start_s,
        final_speed_mps: v,
    }
}

/// Distance a nominal actor covers within the clip — the runway guard's need.
pub fn nominal_runway_need_m(
    graph: &LaneGraph,
    a: &NominalActor<'_>,
    dt: f64,
    warmup_seconds: f64,
    clip_seconds: f64,
) -> f64 {
    nominal_run(
        graph,
        a,
        None,
        &NominalRunOptions {
            dt,
            warmup_seconds,
            horizon_seconds: clip_seconds,
            bound_by_route: false,
        },
    )
    .distance_m
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct TriggerBounds {
    earliest: f64,
    latest: f64,
}

/// Earliest/latest time an interaction may fire in the recorded clip.
fn trigger_bounds(
    interaction: &Interaction,
    by_id: &BTreeMap<&str, &Interaction>,
    visiting: &mut Vec<String>,
) -> TriggerBounds {
    if visiting.iter().any(|v| v == &interaction.id) {
        return TriggerBounds {
            earliest: 0.0,
            latest: f64::INFINITY,
        };
    }
    match &interaction.trigger {
        Trigger::At { t } => TriggerBounds {
            earliest: t.max(0.0),
            latest: t.max(0.0),
        },
        Trigger::Arrival { .. } => TriggerBounds {
            earliest: 0.0,
            latest: f64::INFINITY,
        },
        Trigger::When {
            by_latest,
            if_never,
            ..
        } => TriggerBounds {
            earliest: 0.0,
            latest: if *if_never == IfNever::Fire {
                by_latest.max(0.0)
            } else {
                f64::INFINITY
            },
        },
        Trigger::After {
            interaction_id,
            delay_s,
            ..
        } => {
            let Some(parent) = by_id.get(interaction_id.as_str()) else {
                return TriggerBounds {
                    earliest: 0.0,
                    latest: f64::INFINITY,
                };
            };
            visiting.push(interaction.id.clone());
            let bounds = trigger_bounds(parent, by_id, visiting);
            visiting.pop();
            TriggerBounds {
                earliest: bounds.earliest + delay_s,
                latest: if bounds.latest.is_finite() {
                    bounds.latest + delay_s
                } else {
                    f64::INFINITY
                },
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Up,
    Down,
    Unknown,
}

fn target_direction(target: &SpeedTarget, reference_speed_mps: f64) -> Direction {
    match target {
        SpeedTarget::Absolute { value } => {
            if *value >= reference_speed_mps {
                Direction::Up
            } else {
                Direction::Down
            }
        }
        SpeedTarget::Match { .. } => Direction::Unknown,
        SpeedTarget::Delta { value } => {
            if *value >= 0.0 {
                Direction::Up
            } else {
                Direction::Down
            }
        }
        SpeedTarget::Factor { value } => {
            if *value >= 1.0 {
                Direction::Up
            } else {
                Direction::Down
            }
        }
        SpeedTarget::Stop => Direction::Down,
    }
}

/// Resolved absolute target, `None` for `match` (runtime-dependent).
pub fn speed_target_value(target: &SpeedTarget, speed_mps: f64) -> Option<f64> {
    match target {
        SpeedTarget::Absolute { value } => Some(*value),
        SpeedTarget::Delta { value } => Some((speed_mps + value).max(0.0)),
        SpeedTarget::Factor { value } => Some((speed_mps * value).max(0.0)),
        SpeedTarget::Stop => Some(0.0),
        SpeedTarget::Match { .. } => None,
    }
}

/// Conservative whole-clip distance envelope with authored speed actions.
/// Speed increases fire at their earliest possible time; guaranteed speed
/// decreases fire at their latest possible time. Uncertain decreases and
/// `match` commands are ignored rather than used to weaken the guard.
pub fn action_aware_runway_need_m(
    graph: &LaneGraph,
    a: &NominalActor<'_>,
    actor_id: &str,
    interactions: &[Interaction],
    dt: f64,
    warmup_seconds: f64,
    clip_seconds: f64,
) -> f64 {
    if !interactions.iter().any(|it| it.actor_id == actor_id) {
        return nominal_runway_need_m(graph, a, dt, warmup_seconds, clip_seconds);
    }
    let by_id: BTreeMap<&str, &Interaction> =
        interactions.iter().map(|it| (it.id.as_str(), it)).collect();
    let reference_speed = a.initial_speed_mps.max(cruise_at(graph, a, a.start_s));
    let mut scheduled: Vec<(f64, &Interaction, &SpeedTarget, &crate::types::Dynamics)> = Vec::new();
    let mut visiting = Vec::new();
    for it in interactions.iter().filter(|it| it.actor_id == actor_id) {
        let Verb::Speed { target, dynamics } = &it.verb else {
            continue;
        };
        let bounds = trigger_bounds(it, &by_id, &mut visiting);
        let fire_t = match target_direction(target, reference_speed) {
            Direction::Unknown => continue,
            Direction::Up => bounds.earliest,
            Direction::Down => bounds.latest,
        };
        if !fire_t.is_finite() || fire_t > clip_seconds {
            continue;
        }
        scheduled.push((fire_t, it, target, dynamics));
    }
    scheduled.sort_by(|x, y| {
        x.0.partial_cmp(&y.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| crate::hash::cmp_locale(&x.1.id, &y.1.id))
    });

    let lim = limits_for_kind(a.kind);
    let mut v = a.initial_speed_mps;
    let mut s = a.start_s;
    struct Active<'d> {
        dynamics: &'d crate::types::Dynamics,
        from: f64,
        target: f64,
        started_t: f64,
        duration_s: f64,
    }
    let mut active: Option<Active<'_>> = None;
    let mut event_index = 0usize;
    let total_steps = ((warmup_seconds + clip_seconds) / dt).ceil() as u64;
    for step in 0..total_steps {
        let t = -warmup_seconds + step as f64 * dt;
        if t >= 0.0 {
            while event_index < scheduled.len() && scheduled[event_index].0 <= t + 1e-9 {
                let (fire_t, _, target, dynamics) = scheduled[event_index];
                event_index += 1;
                if let Some(target) = speed_target_value(target, v) {
                    active = Some(Active {
                        dynamics,
                        from: v,
                        target,
                        started_t: fire_t,
                        duration_s: transition_duration(dynamics, target - v, v.max(0.1)),
                    });
                }
            }
        }
        let target = match &active {
            Some(act) => transition_value(
                act.dynamics,
                act.from,
                act.target,
                t + dt - act.started_t,
                act.duration_s,
            ),
            None => cruise_at(graph, a, s),
        };
        let accel = clamp((target - v) / dt, -lim.brake_hard, lim.accel_max);
        v = (v + accel * dt).max(0.0);
        s += v * dt;
    }
    s - a.start_s
}
