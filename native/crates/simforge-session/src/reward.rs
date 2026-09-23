//! Kernel reward: authored-route progress, safe queue waiting, comfort and safety.

use serde::{Deserialize, Serialize};
use simforge_core::engine::{ActorIndex, ActorSnapshot, Simulation};
use simforge_core::map::Route;
use simforge_core::math::{exp, hypot, Vec2};
use simforge_core::trace::events::SimEvent;
use simforge_core::types::ControlIndication;

use crate::episode::{GoalSpec, RewardConfig};

pub const REWARD_TERM_NAMES: [&str; 11] = [
    "progress", "proximity", "comfort", "jerk", "lateral_accel", "time", "stuck",
    "collision", "offroad", "red_crossing", "goal",
];
pub const REWARD_TERM_COUNT: usize = REWARD_TERM_NAMES.len();

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RewardTerms {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collision: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offroad: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub red_crossing: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<f64>,
    pub progress: f64,
    pub proximity: f64,
    /// Longitudinal acceleration cost (not an aggregate of the other terms).
    pub comfort: f64,
    pub jerk: f64,
    pub lateral_accel: f64,
    pub time: f64,
    pub stuck: f64,
    /// Diagnostic, not an additional reward term.
    pub queue_wait: bool,
}

impl RewardTerms {
    pub fn values(&self) -> [f64; REWARD_TERM_COUNT] {
        [self.progress, self.proximity, self.comfort, self.jerk, self.lateral_accel,
            self.time, self.stuck, self.collision.unwrap_or(0.0), self.offroad.unwrap_or(0.0),
            self.red_crossing.unwrap_or(0.0), self.goal.unwrap_or(0.0)]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardState {
    pub route_s: f64,
    pub accel_mps2: f64,
    pub queue_stop_s: f64,
}

pub struct RewardOutcome {
    pub total: f64,
    pub terms: RewardTerms,
    pub terminated: bool,
    pub state: RewardState,
}

pub struct RewardContext<'a> {
    pub config: &'a RewardConfig,
    pub ego: ActorIndex,
    pub ego_id: &'a str,
    pub actors: &'a [ActorSnapshot],
    pub slots: &'a [usize],
    pub events: &'a [SimEvent],
    pub goal: Option<&'a GoalSpec>,
    pub dt_s: f64,
    pub t_s: f64,
    pub previous: RewardState,
    pub sim: &'a Simulation,
    pub route: &'a Route,
    pub route_ref: u32,
    pub queue_target: Option<ActorIndex>,
}

// A boundary testable independently of geometry: a moving, behind, overlapping,
// or too-distant lead cannot excuse arbitrary parking.
fn queue_blocks(gap: f64, lead_speed: f64, cfg: &RewardConfig) -> bool {
    // Route projection refines numerically (rather than an exact polyline
    // projection); 0.1 mm absorbs its station error at an inclusive gap edge.
    gap >= -1e-4 && gap <= cfg.queue_gap_m + 1e-4 && lead_speed <= cfg.stopped_speed_mps
}

fn terminal_terms(collision: bool, offroad: bool, red: bool, goal: bool, cfg: &RewardConfig) -> RewardTerms {
    // All safety facts remain visible; no unsafe goal bonus, even if reached on
    // the same decision. term_reason uses collision > offroad > red > goal.
    RewardTerms {
        collision: collision.then_some(cfg.collision_penalty),
        offroad: offroad.then_some(cfg.offroad_penalty),
        red_crossing: red.then_some(cfg.red_crossing_penalty),
        goal: (goal && !(collision || offroad || red)).then_some(cfg.goal_bonus),
        ..Default::default()
    }
}

pub fn assemble_reward(ctx: &RewardContext<'_>) -> RewardOutcome {
    let cfg = ctx.config;
    let ego = &ctx.actors[ctx.slots[ctx.ego.index()]];
    let point = Vec2 { x: ego.x, y: ego.y };
    let unchanged = ctx.sim.actor_route(ctx.ego).1 == ctx.route_ref;
    let route_s = if unchanged { ego.s } else { ctx.route.project_point(point).s };
    let lateral = if unchanged { ego.lateral_offset_m } else { ctx.route.lateral_offset_at(route_s, point) };
    let collision = ctx.events.iter().any(|e| matches!(e,
        SimEvent::Collision { a, b, .. } if a == ctx.ego_id || b == ctx.ego_id));
    // This is an authored-route corridor instrument, not road-surface authority.
    let offroad = lateral.abs() > ctx.route.width_at(route_s) * 0.5 + cfg.corridor_margin_m;
    let ego_dims = ctx.sim.actor_dims(ctx.ego);
    let mut queue_wait = false;
    let mut at_queue_goal = false;
    let mut proximity = 0.0;
    for actor in ctx.actors {
        if actor.index == ctx.ego || !actor.present { continue; }
        let distance = hypot(actor.x - ego.x, actor.y - ego.y);
        if cfg.proximity_weight != 0.0 && distance < cfg.proximity_range_m {
            proximity -= cfg.proximity_weight * exp(-distance / 5.0);
        }
        if !ctx.sim.actor_kind(actor.index).is_road_actor() || actor.speed_mps > cfg.stopped_speed_mps { continue; }
        let dims = ctx.sim.actor_dims(actor.index);
        let half_lengths = (ego_dims.l + dims.l) * 0.5;
        if distance > cfg.queue_gap_m + half_lengths + ego_dims.w + dims.w { continue; }
        let p = Vec2 { x: actor.x, y: actor.y };
        let station = ctx.route.project_point(p).s;
        let offset = ctx.route.lateral_offset_at(station, p);
        // Adjacent-lane vehicles must not excuse a stopped ego. Test footprint
        // overlap in the authored route frame, not equal route-s on two routes.
        if (offset - lateral).abs() >= (ego_dims.w + dims.w) * 0.5 { continue; }
        let gap = station - route_s - half_lengths;
        if !queue_blocks(gap, actor.speed_mps, cfg) { continue; }
        queue_wait = true;
        at_queue_goal |= Some(actor.index) == ctx.queue_target
            && gap >= cfg.queue_goal_min_gap_m && gap <= cfg.queue_goal_max_gap_m;
    }
    let stopped = ego.speed_mps <= cfg.stopped_speed_mps;
    let queue_stop_s = if stopped && at_queue_goal { ctx.previous.queue_stop_s + ctx.dt_s } else { 0.0 };
    let mut red_crossing = false;
    for line in ctx.sim.signal_book().stop_lines() {
        let Some(signal) = line.signal else { continue; };
        if !line.connecting_lanes.is_empty() && !line.connecting_lanes.iter().any(|l| ctx.route.includes_lane(*l)) { continue; }
        let Some(s) = ctx.route.s_of_lane_storage(line.lane, line.s) else { continue; };
        let before = ctx.previous.route_s + ego_dims.l * 0.5;
        let after = route_s + ego_dims.l * 0.5;
        if before <= s && after > s {
            let crossing_t = ctx.t_s - ctx.dt_s + ctx.dt_s * ((s - before) / (after - before));
            red_crossing |= matches!(ctx.sim.signal_book().phase_at_index(signal, crossing_t),
                ControlIndication::Red | ControlIndication::RedX | ControlIndication::Stop);
        }
    }
    let goal = ctx.goal.is_some_and(|goal| {
        let trigger = goal.interaction_id.as_ref().is_none_or(|wanted| ctx.events.iter().any(|e|
            matches!(e, SimEvent::TriggerFired { interaction_id, .. } if interaction_id == wanted)));
        let route_goal = goal.route_end && route_s >= ctx.route.length_m() - 0.05;
        let queue_goal = goal.queue_stop && queue_stop_s + 1e-9 >= cfg.queue_goal_hold_s && at_queue_goal;
        trigger && (route_goal || queue_goal || (!goal.route_end && !goal.queue_stop))
    });
    let mut terms = terminal_terms(collision, offroad, red_crossing, goal, cfg);
    terms.progress = cfg.progress_weight * (route_s - ctx.previous.route_s);
    terms.proximity = proximity;
    terms.comfort = -cfg.comfort_accel_weight * ego.accel_mps2.abs() * ctx.dt_s;
    let jerk = (ego.accel_mps2 - ctx.previous.accel_mps2).abs() / ctx.dt_s;
    // Linear contract cost plus a hinge above the comfort cap. High jerk is
    // never made free by clipping away the excess.
    terms.jerk = -cfg.comfort_jerk_weight * (jerk + (jerk - cfg.jerk_cap_mps3).max(0.0)) * ctx.dt_s;
    let lateral_accel = ego.telemetry.as_ref().map_or(0.0, |t| t.lateral_g.abs() * 9.80665);
    terms.lateral_accel = -cfg.comfort_lateral_weight * (lateral_accel - cfg.lateral_accel_cap_mps2).max(0.0) * ctx.dt_s;
    terms.time = -cfg.time_weight * ctx.dt_s;
    terms.stuck = if stopped && !queue_wait { -cfg.stuck_weight * ctx.dt_s } else { 0.0 };
    terms.queue_wait = stopped && queue_wait;
    RewardOutcome {
        total: terms.values().iter().sum(),
        terminated: collision || offroad || red_crossing || terms.goal.is_some(),
        terms,
        state: RewardState { route_s, accel_mps2: ego.accel_mps2, queue_stop_s },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_gap_boundaries_do_not_reward_arbitrary_parking() {
        let cfg = RewardConfig::default();
        assert!(queue_blocks(0.0, 0.0, &cfg));
        assert!(queue_blocks(cfg.queue_gap_m, cfg.stopped_speed_mps, &cfg));
        assert!(!queue_blocks(-0.001, 0.0, &cfg));
        assert!(!queue_blocks(cfg.queue_gap_m + 0.001, 0.0, &cfg));
        assert!(!queue_blocks(5.0, cfg.stopped_speed_mps + 0.001, &cfg));
    }

    #[test]
    fn unsafe_goal_has_no_bonus_and_all_safety_terms_survive() {
        let cfg = RewardConfig::default();
        let terms = terminal_terms(true, true, true, true, &cfg);
        assert_eq!(terms.goal, None);
        assert_eq!(terms.collision, Some(-20.0));
        assert_eq!(terms.offroad, Some(-10.0));
        assert_eq!(terms.red_crossing, Some(-5.0));
        assert_eq!(terms.values().iter().sum::<f64>(), -35.0);
        assert_eq!(terminal_terms(false, false, false, true, &cfg).goal, Some(5.0));
    }
}
