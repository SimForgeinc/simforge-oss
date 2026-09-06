//! Discrete simulation events, serialised exactly as the current trace format
//! writes them: a flat object with `t`, `kind` and the variant's camelCase
//! fields.

use serde::{Deserialize, Serialize};

use crate::types::SetValue;

/// Why a longitudinal/lateral command released its axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleasedReason {
    Until,
    Complete,
    Window,
}

impl ReleasedReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            ReleasedReason::Until => "until",
            ReleasedReason::Complete => "complete",
            ReleasedReason::Window => "window",
        }
    }
}

/// Why an interaction was aborted before completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AbortReason {
    Collision,
    Preempted,
    Until,
    Rejected,
    TrackingError,
    ClipEnd,
}

impl AbortReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            AbortReason::Collision => "collision",
            AbortReason::Preempted => "preempted",
            AbortReason::Until => "until",
            AbortReason::Rejected => "rejected",
            AbortReason::TrackingError => "tracking_error",
            AbortReason::ClipEnd => "clip_end",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DespawnReason {
    RouteEnd,
    Interaction,
    ClipEnd,
}

/// The single reason a moving body is crash-disabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CrashReason {
    #[serde(rename = "material-collision")]
    MaterialCollision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SimEvent {
    #[serde(rename_all = "camelCase")]
    TriggerFired {
        t: f64,
        interaction_id: String,
        actor_id: String,
        verb: String,
        forced: bool,
    },
    #[serde(rename_all = "camelCase")]
    TriggerSkipped {
        t: f64,
        interaction_id: String,
        actor_id: String,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    Preemption {
        t: f64,
        actor_id: String,
        axis: String,
        by_interaction_id: String,
        preempted_interaction_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Released {
        t: f64,
        actor_id: String,
        axis: String,
        interaction_id: String,
        reason: ReleasedReason,
    },
    #[serde(rename_all = "camelCase")]
    InteractionCompleted {
        t: f64,
        actor_id: String,
        interaction_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_lateral_offset_m: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    InteractionAborted {
        t: f64,
        actor_id: String,
        interaction_id: String,
        reason: AbortReason,
    },
    #[serde(rename_all = "camelCase")]
    LateralManeuverPlanned {
        t: f64,
        actor_id: String,
        interaction_id: String,
        requested_duration_s: f64,
        effective_duration_s: f64,
        displacement_m: f64,
    },
    #[serde(rename_all = "camelCase")]
    LaneChange {
        t: f64,
        actor_id: String,
        from_rsl: Option<String>,
        to_rsl: Option<String>,
        legal: bool,
    },
    #[serde(rename_all = "camelCase")]
    LaneChangeRejected {
        t: f64,
        actor_id: String,
        interaction_id: String,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    RouteChangeRejected {
        t: f64,
        actor_id: String,
        interaction_id: String,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        requested_turn: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Collision {
        t: f64,
        a: String,
        b: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        collider_a: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        collider_b: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RoadDeparturePrevented {
        t: f64,
        actor_id: String,
        lane_rsl: Option<String>,
        lateral_error_m: f64,
        allowed_center_offset_m: f64,
    },
    #[serde(rename_all = "camelCase")]
    CrashDisabled {
        t: f64,
        actor_id: String,
        other_id: String,
        reason: CrashReason,
    },
    /// A vulnerable body was taken off its feet. `normal_impulse_ns` is the
    /// solver's own contact impulse — telemetry, never an injury claim.
    #[serde(rename_all = "camelCase")]
    KnockedDown {
        t: f64,
        actor_id: String,
        other_id: String,
        normal_impulse_ns: f64,
    },
    #[serde(rename_all = "camelCase")]
    Spawn { t: f64, actor_id: String },
    #[serde(rename_all = "camelCase")]
    Despawn {
        t: f64,
        actor_id: String,
        reason: DespawnReason,
    },
    #[serde(rename_all = "camelCase")]
    StateSet {
        t: f64,
        actor_id: String,
        key: String,
        value: SetValue,
    },
}

impl SimEvent {
    pub fn t(&self) -> f64 {
        match self {
            SimEvent::TriggerFired { t, .. }
            | SimEvent::TriggerSkipped { t, .. }
            | SimEvent::Preemption { t, .. }
            | SimEvent::Released { t, .. }
            | SimEvent::InteractionCompleted { t, .. }
            | SimEvent::InteractionAborted { t, .. }
            | SimEvent::LateralManeuverPlanned { t, .. }
            | SimEvent::LaneChange { t, .. }
            | SimEvent::LaneChangeRejected { t, .. }
            | SimEvent::RouteChangeRejected { t, .. }
            | SimEvent::Collision { t, .. }
            | SimEvent::RoadDeparturePrevented { t, .. }
            | SimEvent::CrashDisabled { t, .. }
            | SimEvent::KnockedDown { t, .. }
            | SimEvent::Spawn { t, .. }
            | SimEvent::Despawn { t, .. }
            | SimEvent::StateSet { t, .. } => *t,
        }
    }

    pub(crate) fn t_mut(&mut self) -> &mut f64 {
        match self {
            SimEvent::TriggerFired { t, .. }
            | SimEvent::TriggerSkipped { t, .. }
            | SimEvent::Preemption { t, .. }
            | SimEvent::Released { t, .. }
            | SimEvent::InteractionCompleted { t, .. }
            | SimEvent::InteractionAborted { t, .. }
            | SimEvent::LateralManeuverPlanned { t, .. }
            | SimEvent::LaneChange { t, .. }
            | SimEvent::LaneChangeRejected { t, .. }
            | SimEvent::RouteChangeRejected { t, .. }
            | SimEvent::Collision { t, .. }
            | SimEvent::RoadDeparturePrevented { t, .. }
            | SimEvent::CrashDisabled { t, .. }
            | SimEvent::KnockedDown { t, .. }
            | SimEvent::Spawn { t, .. }
            | SimEvent::Despawn { t, .. }
            | SimEvent::StateSet { t, .. } => t,
        }
    }

    /// The `kind` discriminator exactly as serialised.
    pub const fn kind(&self) -> &'static str {
        match self {
            SimEvent::TriggerFired { .. } => "trigger_fired",
            SimEvent::TriggerSkipped { .. } => "trigger_skipped",
            SimEvent::Preemption { .. } => "preemption",
            SimEvent::Released { .. } => "released",
            SimEvent::InteractionCompleted { .. } => "interaction_completed",
            SimEvent::InteractionAborted { .. } => "interaction_aborted",
            SimEvent::LateralManeuverPlanned { .. } => "lateral_maneuver_planned",
            SimEvent::LaneChange { .. } => "lane_change",
            SimEvent::LaneChangeRejected { .. } => "lane_change_rejected",
            SimEvent::RouteChangeRejected { .. } => "route_change_rejected",
            SimEvent::Collision { .. } => "collision",
            SimEvent::RoadDeparturePrevented { .. } => "road_departure_prevented",
            SimEvent::CrashDisabled { .. } => "crash_disabled",
            SimEvent::KnockedDown { .. } => "knocked_down",
            SimEvent::Spawn { .. } => "spawn",
            SimEvent::Despawn { .. } => "despawn",
            SimEvent::StateSet { .. } => "state_set",
        }
    }

    /// The `actorId` field, when the variant carries one (collisions do not).
    pub fn actor_id(&self) -> Option<&str> {
        match self {
            SimEvent::TriggerFired { actor_id, .. }
            | SimEvent::TriggerSkipped { actor_id, .. }
            | SimEvent::Preemption { actor_id, .. }
            | SimEvent::Released { actor_id, .. }
            | SimEvent::InteractionCompleted { actor_id, .. }
            | SimEvent::InteractionAborted { actor_id, .. }
            | SimEvent::LateralManeuverPlanned { actor_id, .. }
            | SimEvent::LaneChange { actor_id, .. }
            | SimEvent::LaneChangeRejected { actor_id, .. }
            | SimEvent::RouteChangeRejected { actor_id, .. }
            | SimEvent::RoadDeparturePrevented { actor_id, .. }
            | SimEvent::CrashDisabled { actor_id, .. }
            | SimEvent::KnockedDown { actor_id, .. }
            | SimEvent::Spawn { actor_id, .. }
            | SimEvent::Despawn { actor_id, .. }
            | SimEvent::StateSet { actor_id, .. } => Some(actor_id),
            SimEvent::Collision { .. } => None,
        }
    }

    /// The `interactionId` field, when the variant carries one. A preemption
    /// names the interaction it preempted *by* separately and has none here.
    pub fn interaction_id(&self) -> Option<&str> {
        match self {
            SimEvent::TriggerFired { interaction_id, .. }
            | SimEvent::TriggerSkipped { interaction_id, .. }
            | SimEvent::Released { interaction_id, .. }
            | SimEvent::InteractionCompleted { interaction_id, .. }
            | SimEvent::InteractionAborted { interaction_id, .. }
            | SimEvent::LateralManeuverPlanned { interaction_id, .. }
            | SimEvent::LaneChangeRejected { interaction_id, .. }
            | SimEvent::RouteChangeRejected { interaction_id, .. } => Some(interaction_id),
            _ => None,
        }
    }
}
