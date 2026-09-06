//! Articulated vehicle doors: collidable ground-plane panels driven by the
//! `doors.<name>` state keys.

use serde::{Deserialize, Serialize};

use crate::trace::pairs::DoorName as PairDoorName;
use crate::types::SetValue;

use super::actor::ActorIndex;

pub const DOOR_OPEN_DURATION_S: f64 = 1.0;
pub const DOOR_MAX_OPEN_ANGLE_RAD: f64 = std::f64::consts::PI * 0.39;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DoorName {
    Left,
    Right,
    Rear,
}

impl DoorName {
    pub const ALL: [DoorName; 3] = [DoorName::Left, DoorName::Right, DoorName::Rear];

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "left" => Some(DoorName::Left),
            "right" => Some(DoorName::Right),
            "rear" => Some(DoorName::Rear),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            DoorName::Left => "left",
            DoorName::Right => "right",
            DoorName::Rear => "rear",
        }
    }

    /// The `door:<name>` collider label.
    pub const fn collider_label(self) -> &'static str {
        match self {
            DoorName::Left => "door:left",
            DoorName::Right => "door:right",
            DoorName::Rear => "door:rear",
        }
    }

    /// The pair-readout door identity used by `articulated_door_obb`.
    pub const fn to_pair_name(self) -> PairDoorName {
        match self {
            DoorName::Left => PairDoorName::Left,
            DoorName::Right => PairDoorName::Right,
            DoorName::Rear => PairDoorName::Rear,
        }
    }

    /// The `doors.<name>` state key.
    pub const fn state_key(self) -> &'static str {
        match self {
            DoorName::Left => "doors.left",
            DoorName::Right => "doors.right",
            DoorName::Rear => "doors.rear",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorRuntime {
    pub actor: ActorIndex,
    pub name: DoorName,
    pub from: f64,
    pub target: f64,
    pub started_t: f64,
    pub duration_s: f64,
    pub transitioning: bool,
}

impl DoorRuntime {
    pub fn openness(&self, t: f64) -> f64 {
        if !self.transitioning || self.duration_s <= 0.0 {
            return self.target;
        }
        let u = ((t - self.started_t) / self.duration_s).clamp(0.0, 1.0);
        self.from + (self.target - self.from) * u
    }
}

/// Interpret a `doors.*` set value as `(target openness, transitioning)`.
pub fn door_target(value: &SetValue) -> (f64, bool) {
    match value {
        SetValue::Text(s) if s == "opening" => (1.0, true),
        SetValue::Text(s) if s == "closing" => (0.0, true),
        SetValue::Text(s) if s == "open" => (1.0, false),
        SetValue::Bool(true) => (1.0, false),
        SetValue::Number(n) => (n.clamp(0.0, 1.0), false),
        _ => (0.0, false),
    }
}

/// Ground-plane OBB of one door panel on an actor at `openness ∈ [0, 1]`.
#[inline]
pub fn articulated_door_obb_for(
    a: &super::actor::ActorRuntime,
    name: DoorName,
    openness: f64,
) -> crate::math::Obb {
    crate::trace::pairs::articulated_door_obb(
        a.position,
        a.heading_rad,
        a.kind,
        a.dims,
        name.to_pair_name(),
        openness,
    )
}
