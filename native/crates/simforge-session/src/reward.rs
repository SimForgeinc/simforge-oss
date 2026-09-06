//! Reward and termination assembly.
//!
//! Dense shaping derives from quantities the engine exposes per tick (route
//! progress, longitudinal acceleration, inter-actor clearance); terminal terms
//! come from the engine's own event stream.

use serde::{Deserialize, Serialize};
use simforge_core::engine::{ActorIndex, ActorSnapshot};
use simforge_core::math::{exp, hypot};
use simforge_core::trace::events::{DespawnReason, SimEvent};

use crate::episode::{GoalSpec, RewardConfig};

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardTerms {
    /// Terminal collision penalty (present only when a collision occurred).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collision: Option<f64>,
    /// Terminal goal bonus (present only when the goal was met).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<f64>,
    /// Route progress term.
    pub progress: f64,
    /// Proximity penalty across nearby actors (non-positive).
    pub proximity: f64,
    /// Acceleration comfort penalty (non-positive).
    pub comfort: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardOutcome {
    pub total: f64,
    pub terms: RewardTerms,
    pub collision: bool,
    pub goal: bool,
}

pub struct RewardContext<'a> {
    pub config: &'a RewardConfig,
    pub ego: ActorIndex,
    pub ego_id: &'a str,
    pub actors: &'a [ActorSnapshot],
    /// Actor handles in canonical id order.
    pub sorted: &'a [ActorIndex],
    /// Snapshot row per `ActorIndex::index()`.
    pub slots: &'a [usize],
    pub events: &'a [SimEvent],
    pub goal: Option<&'a GoalSpec>,
    pub dt_s: f64,
    /// Ego route arc length at the previous decision; `None` on the first step.
    pub prev_ego_s: Option<f64>,
}

fn collision_involving_ego(events: &[SimEvent], ego_id: &str) -> bool {
    events
        .iter()
        .any(|e| matches!(e, SimEvent::Collision { a, b, .. } if a == ego_id || b == ego_id))
}

fn goal_met(events: &[SimEvent], ego_id: &str, goal: Option<&GoalSpec>) -> bool {
    let Some(goal) = goal else { return false };
    if let Some(wanted) = &goal.interaction_id {
        let fired = events.iter().any(|e| matches!(e, SimEvent::TriggerFired { interaction_id, .. } if interaction_id == wanted));
        if !fired {
            return false;
        }
    }
    if goal.route_end {
        return events.iter().any(|e| {
            matches!(e, SimEvent::Despawn { actor_id, reason: DespawnReason::RouteEnd, .. } if actor_id == ego_id)
        });
    }
    true
}

pub fn assemble_reward(ctx: &RewardContext<'_>) -> RewardOutcome {
    let cfg = ctx.config;
    let ego = &ctx.actors[ctx.slots[ctx.ego.index()]];

    let collision = collision_involving_ego(ctx.events, ctx.ego_id);
    let goal = goal_met(ctx.events, ctx.ego_id, ctx.goal);

    let progress = ctx
        .prev_ego_s
        .map_or(0.0, |prev| cfg.progress_weight * (ego.s - prev));

    let mut proximity = 0.0;
    for &idx in ctx.sorted {
        if idx == ctx.ego {
            continue;
        }
        let a = &ctx.actors[ctx.slots[idx.index()]];
        let d = hypot(a.x - ego.x, a.y - ego.y);
        if d >= cfg.proximity_range_m {
            continue;
        }
        // Exponential falloff with a 5 m decay length: cheap, smooth, monotone.
        proximity += exp(-d / 5.0);
    }
    proximity *= cfg.proximity_weight;

    let comfort = cfg.comfort_accel_weight * ego.accel_mps2.abs() * ctx.dt_s;

    let terms = RewardTerms {
        progress,
        proximity: -proximity,
        comfort: -comfort,
        collision: collision.then_some(cfg.collision_penalty),
        goal: goal.then_some(cfg.goal_bonus),
    };
    let total = terms.collision.unwrap_or(0.0)
        + terms.goal.unwrap_or(0.0)
        + terms.progress
        + terms.proximity
        + terms.comfort;
    RewardOutcome {
        total,
        terms,
        collision,
        goal,
    }
}
