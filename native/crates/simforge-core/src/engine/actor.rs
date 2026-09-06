//! Mutable per-actor simulation state.
//!
//! Actors are addressed by [`ActorIndex`] — a dense, stable handle assigned at
//! registration that never moves — so nothing on the per-tick path compares or
//! allocates strings. Ids are resolved to indices once, at binding time.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::map::{LaneId, Route, TimedRoute};
use crate::math::{cos, hypot, sin, Vec2};
use crate::physics::{BodyIndex, MotionDirection};
use crate::types::{
    ActorKind, ActorRules, Condition, Dims, Dynamics, GapMode, SetKey, SetValue, SpeedTarget,
    TurnRelation,
};

/// Stable per-simulation actor handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ActorIndex(pub u32);

impl ActorIndex {
    #[inline]
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

/// The five axes. `set` owns one axis per key so two `set`s of different keys
/// coexist ("one axis, one owner" without over-serialising state).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AxisId {
    Longitudinal,
    Lateral,
    Route,
    Existence,
    /// `state:<key>`; the key is its canonical wire text.
    State(String),
}

impl AxisId {
    /// The trace's `axis` vocabulary.
    pub fn as_trace_str(&self) -> std::borrow::Cow<'static, str> {
        match self {
            AxisId::Longitudinal => "longitudinal".into(),
            AxisId::Lateral => "lateral".into(),
            AxisId::Route => "route".into(),
            AxisId::Existence => "existence".into(),
            AxisId::State(key) => format!("state:{key}").into(),
        }
    }
}

pub fn axis_of(verb: &crate::types::Verb) -> AxisId {
    use crate::types::Verb;
    match verb {
        Verb::Speed { .. } | Verb::Gap { .. } => AxisId::Longitudinal,
        Verb::ChangeLane { .. } | Verb::LaneOffset { .. } => AxisId::Lateral,
        Verb::Route { .. } => AxisId::Route,
        Verb::Exist { .. } => AxisId::Existence,
        Verb::Set { target } => AxisId::State(target.key.to_string()),
    }
}

/// Stable handle to an interaction, in sorted-id order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InteractionIndex(pub u32);

impl InteractionIndex {
    #[inline]
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LongitudinalKind {
    Speed,
    Gap,
}

/// A `gap` command's reference.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GapReference {
    pub actor: ActorIndex,
    pub value: f64,
    pub mode: GapMode,
}

/// A `speed(match)` target resolved to an actor index.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchReference {
    pub actor: Option<ActorIndex>,
    pub offset_mps: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongitudinalCommand {
    pub kind: LongitudinalKind,
    pub interaction: InteractionIndex,
    pub fired_at: f64,
    pub dynamics: Dynamics,
    /// Speed (or gap) at fire time — the profile's start value.
    pub v0: f64,
    /// Profile duration in seconds, frozen at fire time.
    pub duration: f64,
    /// Resolved absolute target. Re-evaluated per tick for `match`/`gap`.
    pub target: f64,
    /// `gap` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<GapReference>,
    /// `speed(match)` only — kept so the target follows the moving reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_ref: Option<MatchReference>,
    /// `speed` only — cruise state to restore when an explicit `until` releases it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_cruise_override_mps: Option<Option<f64>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LateralKind {
    ChangeLane,
    LaneOffset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaneChangeSide {
    Left,
    Right,
}

/// The route to adopt once a lane change completes.
#[derive(Debug, Clone)]
pub struct PendingRetarget {
    pub route: Route,
    pub s: f64,
    pub separation_m: f64,
    pub target_lane: Option<LaneId>,
}

#[derive(Debug, Clone)]
pub struct LateralCommand {
    pub kind: LateralKind,
    pub interaction: InteractionIndex,
    pub fired_at: f64,
    pub dynamics: Dynamics,
    pub from: f64,
    pub to: f64,
    pub duration: f64,
    /// `changeLane` only.
    pub pending: Option<PendingRetarget>,
    pub side: Option<LaneChangeSide>,
    pub done: bool,
}

/// Per-actor memory for a static stop control. Each actor stops once, dwells,
/// then remains released for that control id.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadControlRuntimeState {
    pub stopped_since_s: Option<f64>,
    pub released: bool,
    /// First tick at rest at this control; deterministic FIFO order.
    pub arrived_at_s: Option<f64>,
    /// Release/commit time; retained until the actor clears the junction.
    pub released_at_s: Option<f64>,
    /// A red/stop release includes a small seeded perception/start delay.
    pub proceed_after_s: Option<f64>,
    /// True after this actor has been held by a signal indication.
    pub was_blocked: bool,
}

/// Small deterministic variation, not a second simulation model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverBehaviorProfile {
    pub naturalistic: bool,
    pub desired_speed_factor: f64,
    pub time_headway_s: f64,
    pub minimum_gap_m: f64,
    pub accel_scale: f64,
    pub comfort_brake_scale: f64,
    pub reaction_time_s: f64,
    pub start_delay_s: f64,
    pub comfortable_lateral_acceleration_mps2: f64,
    pub comfortable_deceleration_mps2: f64,
}

/// An `until` condition attached to an axis.
#[derive(Debug, Clone, PartialEq)]
pub struct UntilEntry {
    pub axis: AxisId,
    pub interaction: InteractionIndex,
    pub condition: Condition,
}

/// Why propulsion was latched off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashLatch {
    pub at_s: f64,
    /// The other body in the material contact (`actor id`, `prop:<id>` or `map:<id>`).
    pub other_id: String,
}

#[derive(Debug, Clone)]
pub struct ActorRuntime {
    pub index: ActorIndex,
    pub id: String,
    pub kind: ActorKind,
    pub dims: Dims,
    pub tags: Vec<String>,
    /// Excluded from pair metrics; still collides and occludes.
    pub is_static: bool,
    pub is_ambient: bool,
    pub rules: ActorRules,
    pub driver: DriverBehaviorProfile,
    /// Free-flow cruise speed, m/s (recomputed when `speedFactor` changes).
    pub cruise_speed_mps: f64,
    pub cruise_override_mps: Option<f64>,

    pub route: Route,
    pub route_s: f64,
    /// Exact absolute-time world keyframes; cleared permanently on collision.
    pub timed_route: Option<TimedRoute>,
    /// Literal editor-authored polyline: bypass traffic governors, not contact.
    pub best_effort_world_path: bool,
    /// Remaining turn preferences, consumed when a route is rebuilt.
    pub remaining_turns: Vec<TurnRelation>,

    pub speed_mps: f64,
    pub accel_mps2: f64,
    /// Measured body offset from the active route.
    pub lateral_offset_m: f64,
    /// Authored minimum-jerk reference, independent of the measured body pose.
    pub lateral_reference_offset_m: f64,
    pub lateral_reference_rate_mps: f64,
    pub lateral_reference_accel_mps2: f64,
    /// Stable lane-relative offset retained after a completed laneOffset action.
    pub lateral_rest_offset_m: f64,
    pub lateral_rate_mps: f64,
    pub lateral_accel_mps2: f64,

    pub position: Vec2,
    pub heading_rad: f64,

    pub present: bool,
    /// `true` once route motion finished; the body may remain visibly present.
    pub retired: bool,

    pub long_cmd: Option<LongitudinalCommand>,
    pub lat_cmd: Option<LateralCommand>,
    /// `until` conditions keyed by axis, released when satisfied. Kept sorted
    /// by axis so evaluation order is deterministic.
    pub until_by_axis: Vec<UntilEntry>,

    /// `set()` registry — the authoritative store for `lights.*`, `doors.*`, …
    pub state_keys: BTreeMap<String, SetValue>,

    /// Static stop-sign progress keyed by control slot (see `SignalBook`).
    pub road_control_states: BTreeMap<u32, RoadControlRuntimeState>,

    pub motion_direction: MotionDirection,
    /// Whether this body has ever actually driven (see `engage_pending_gear`).
    pub has_moved: bool,
    /// A gear selection requested but not yet engaged.
    pub pending_motion_direction: Option<MotionDirection>,

    pub standstill_since_s: Option<f64>,
    /// Running max of the decel that would have been required to stay safe.
    pub required_decel_max: f64,
    /// Latched after the first material contact; propulsion never resumes.
    pub crash: Option<CrashLatch>,
    /// When a vulnerable body was knocked off its feet.
    pub downed_at_s: Option<f64>,
    pub downed_by_actor_id: Option<String>,

    /// Physics body handle when this actor runs the force backend.
    pub body: Option<BodyIndex>,
    /// Last resolved lane for a freeform route, with the position it was
    /// resolved at (`None` = never resolved).
    pub freeform_lane_binding: Option<(Vec2, Option<LaneId>)>,
    /// Index into the world's route-ref table of the route currently owned.
    pub route_ref: u32,
}

impl ActorRuntime {
    #[inline]
    pub fn is_reverse(&self) -> bool {
        self.motion_direction.is_reverse()
    }

    #[inline]
    pub fn is_live(&self) -> bool {
        self.present && !self.retired
    }

    #[inline]
    pub fn direction_sign(&self) -> f64 {
        self.motion_direction.sign()
    }

    #[inline]
    pub fn obb(&self) -> crate::math::Obb {
        crate::math::Obb {
            center: self.position,
            length_m: self.dims.l,
            width_m: self.dims.w,
            heading_rad: self.heading_rad,
        }
    }

    /// World-frame velocity implied by speed magnitude, heading and gear.
    #[inline]
    pub fn velocity(&self) -> Vec2 {
        let d = self.direction_sign();
        Vec2 {
            x: cos(self.heading_rad) * self.speed_mps * d,
            y: sin(self.heading_rad) * self.speed_mps * d,
        }
    }

    /// Circumscribed radius used by the coarse pair metrics.
    #[inline]
    pub fn radius(&self) -> f64 {
        hypot(self.dims.l, self.dims.w) / 2.0
    }

    pub fn until_for(&self, axis: &AxisId) -> Option<&UntilEntry> {
        self.until_by_axis.iter().find(|e| &e.axis == axis)
    }

    pub fn set_until(&mut self, axis: AxisId, interaction: InteractionIndex, condition: Condition) {
        match self.until_by_axis.binary_search_by(|e| e.axis.cmp(&axis)) {
            Ok(i) => {
                self.until_by_axis[i].interaction = interaction;
                self.until_by_axis[i].condition = condition;
            }
            Err(i) => self.until_by_axis.insert(
                i,
                UntilEntry {
                    axis,
                    interaction,
                    condition,
                },
            ),
        }
    }

    pub fn clear_until(&mut self, axis: &AxisId) -> Option<UntilEntry> {
        match self.until_by_axis.binary_search_by(|e| e.axis.cmp(axis)) {
            Ok(i) => Some(self.until_by_axis.remove(i)),
            Err(_) => None,
        }
    }

    pub fn state_key(&self, key: &str) -> Option<&SetValue> {
        self.state_keys.get(key)
    }

    pub fn set_state_key(&mut self, key: &SetKey, value: SetValue) {
        let text = key.to_string();
        self.state_keys.insert(text, value);
    }

    pub fn set_state_key_str(&mut self, key: &str, value: SetValue) {
        match self.state_keys.get_mut(key) {
            Some(slot) => *slot = value,
            None => {
                self.state_keys.insert(key.to_owned(), value);
            }
        }
    }

    /// Resolve the current `match` speed target against the referenced actor.
    pub fn speed_target_mode_is_match(target: &SpeedTarget) -> bool {
        matches!(target, SpeedTarget::Match { .. })
    }
}
