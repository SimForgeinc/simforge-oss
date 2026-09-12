//! Solver-neutral motion contract between scenario choreography and a
//! physical backend. Everything here is plain numeric data so FFI batches and
//! the semantic engine can share it without depending on routes or actors.

use serde::{Deserialize, Serialize};

use crate::math::{hypot, sin_cos, Vec2};
use crate::types::{ActorKind, Dims, VehiclePhysicsProfile};

/// Errors raised by a motion backend. These are programming/contract errors
/// on the engine side (unregistered body, invalid step), not scenario issues.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PhysicsError {
    #[error("dynamic-v1 substepS must be positive, got {0}")]
    InvalidSubstep(f64),
    #[error("dynamic-v1 step dtS must be positive, got {0}")]
    InvalidTimestep(f64),
    #[error("fixed static actors cannot be registered with dynamic-v1: {actor_id}")]
    StaticActor { actor_id: String },
    #[error("dynamic-v1 cgToFrontM must be less than wheelbaseM (cgToFrontM={cg_to_front_m}, wheelbaseM={wheelbase_m})")]
    InvalidAxleGeometry {
        cg_to_front_m: f64,
        wheelbase_m: f64,
    },
    #[error("dynamic-v1 vehicle profile field {field} must be {requirement}, got {value}")]
    InvalidProfileValue {
        field: &'static str,
        requirement: &'static str,
        value: f64,
    },
    #[error("dynamic-v1 actor is not registered: {0}")]
    UnknownActor(String),
    #[error("dynamic-v1 body index out of range: {0}")]
    UnknownBody(u32),
}

/// Stable handle to a registered body. Indices are assigned at first
/// registration and never move; re-registering the same actor id (gear
/// re-engagement) reuses its index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BodyIndex(pub u32);

impl BodyIndex {
    #[inline]
    pub fn index(self) -> usize {
        self.0 as usize
    }
}

/// Body longitudinal travel direction. Serialised as `1` / `-1` to match the
/// scenario contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(into = "i8", try_from = "i8")]
pub enum MotionDirection {
    #[default]
    Forward,
    Reverse,
}

impl MotionDirection {
    /// `+1.0` forward, `-1.0` reverse.
    #[inline]
    pub fn sign(self) -> f64 {
        match self {
            MotionDirection::Forward => 1.0,
            MotionDirection::Reverse => -1.0,
        }
    }

    #[inline]
    pub fn is_reverse(self) -> bool {
        matches!(self, MotionDirection::Reverse)
    }
}

impl From<MotionDirection> for i8 {
    fn from(value: MotionDirection) -> i8 {
        match value {
            MotionDirection::Forward => 1,
            MotionDirection::Reverse => -1,
        }
    }
}

impl TryFrom<i8> for MotionDirection {
    type Error = String;
    fn try_from(value: i8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(MotionDirection::Forward),
            -1 => Ok(MotionDirection::Reverse),
            other => Err(format!("motionDirection must be 1 or -1, got {other}")),
        }
    }
}

/// Normalised actuator requests: throttle/brake in `[0, 1]`, steer in
/// `[-1, 1]` as a fraction of the profile's steering lock. This is also the
/// driver-command contract a live client sends through
/// `WorldSession::set_driver_command`.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleControl {
    pub throttle: f64,
    pub brake: f64,
    pub steer: f64,
    /// Rear-axle parking brake. Independent of the brake pedal: it bypasses
    /// the jerk-limited pedal path, so it locks the rear wheels immediately
    /// the way a yanked handbrake does.
    #[serde(default)]
    pub handbrake: bool,
}

impl VehicleControl {
    pub const ZERO: VehicleControl = VehicleControl {
        throttle: 0.0,
        brake: 0.0,
        steer: 0.0,
        handbrake: false,
    };
}

/// Command produced by scenario choreography for one body over one tick.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionIntent {
    /// Body longitudinal direction: forward or reverse.
    #[serde(default)]
    pub motion_direction: MotionDirection,
    pub target_speed_mps: f64,
    pub target_acceleration_mps2: f64,
    pub preview_point: Vec2,
    pub preview_heading_rad: f64,
    /// The body is off its feet. A walker agent must stop steering toward
    /// `preview_point` and let the contact impulse carry it, or the knock it
    /// just received is erased on the next substep.
    #[serde(default)]
    pub downed: bool,
    /// Direct actuator request. When present the backend skips its setpoint
    /// controller and applies this control, clamped to the unit range. Steer
    /// still passes through the profile's clamp, rate limit and first-order
    /// lag, and the implied longitudinal acceleration stays inside the
    /// profile's jerk limit, so a passthrough caller inherits the same physical
    /// envelope as a setpoint caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<VehicleControl>,
}

/// Continuous body state in XODR-local coordinates with body-frame velocities.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleMotionState {
    pub x: f64,
    pub y: f64,
    pub yaw_rad: f64,
    /// Body-frame longitudinal velocity (signed; negative when reversing).
    pub longitudinal_velocity_mps: f64,
    /// Body-frame lateral velocity, positive left.
    pub lateral_velocity_mps: f64,
    pub yaw_rate_radps: f64,
    pub steer_rad: f64,
    pub wheel_angular_speed_radps: f64,
    pub longitudinal_acceleration_mps2: f64,
}

impl VehicleMotionState {
    #[inline]
    pub fn position(&self) -> Vec2 {
        Vec2 {
            x: self.x,
            y: self.y,
        }
    }

    /// World-frame velocity derived from the body-frame components.
    #[inline]
    pub fn world_velocity(&self) -> Vec2 {
        let (s, c) = sin_cos(self.yaw_rad);
        Vec2 {
            x: self.longitudinal_velocity_mps * c - self.lateral_velocity_mps * s,
            y: self.longitudinal_velocity_mps * s + self.lateral_velocity_mps * c,
        }
    }

    /// Planar speed magnitude. This is the speed of a downed body, which
    /// slides whichever way it was thrown; an upright body reports
    /// `|longitudinal_velocity_mps|`.
    #[inline]
    pub fn planar_speed_mps(&self) -> f64 {
        hypot(self.longitudinal_velocity_mps, self.lateral_velocity_mps)
    }
}

/// Diagnostic sample of the last integration step for one body. Also the
/// source of the per-frame driving telemetry published on truth frames.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicsTelemetrySample {
    pub control: VehicleControl,
    pub longitudinal_force_n: f64,
    pub front_lateral_force_n: f64,
    pub rear_lateral_force_n: f64,
    pub front_normal_force_n: f64,
    pub rear_normal_force_n: f64,
    /// Peak of the two axles, retained as the single-number summary the trace
    /// channel and the engine's existing consumers read.
    pub tire_utilization: f64,
    pub front_tire_utilization: f64,
    pub rear_tire_utilization: f64,
    /// Engine speed implied by the driveline in the engaged gear; the idle
    /// speed while stopped, and zero for classes with no driveline.
    pub engine_rpm: f64,
    /// `0` neutral, `1..=n` forward, `-1` reverse.
    pub gear: i32,
    /// Wheel angular speeds in rad/s, `[fl, fr, rl, rr]`.
    pub wheel_speeds_radps: [f64; 4],
    /// Body-frame lateral acceleration of the last substep.
    pub lateral_acceleration_mps2: f64,
    pub substeps: u32,
    pub substep_s: f64,
    /// Sum of normal contact impulses applied during the last world step.
    pub collision_impulse_ns: f64,
    /// Number of distinct contact pairs that applied an impulse.
    pub collision_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionStepResult {
    pub state: VehicleMotionState,
    pub telemetry: PhysicsTelemetrySample,
}

/// Front/rear split of the friction-circle utilisation.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxleUtilization {
    pub front: f64,
    pub rear: f64,
}

/// Per-frame driving telemetry for one body: the published contract the live
/// truth stream carries and HUD/audio clients render. Derived entirely from
/// the body's integrated state plus the tick's collision result — it adds no
/// state of its own, so two identical runs publish identical telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleTelemetry {
    /// Forward speed magnitude, m/s.
    pub speed_mps: f64,
    pub rpm: f64,
    /// `0` neutral, `1..=n` forward, `-1` reverse.
    pub gear: i32,
    pub throttle: f64,
    pub brake: f64,
    /// Steering as a fraction of the class's steering lock, `[-1, 1]`.
    pub steer: f64,
    /// Road-wheel angle in radians; `steer` scaled by the class lock.
    pub steer_rad: f64,
    /// Wheel angular speeds, rad/s, `[fl, fr, rl, rr]`.
    pub wheel_speeds: [f64; 4],
    pub tyre_utilization: AxleUtilization,
    /// Longitudinal acceleration in g (positive forward).
    pub longitudinal_g: f64,
    /// Lateral acceleration in g (positive left).
    pub lateral_g: f64,
    /// The body is not on a drivable lane.
    pub off_road: bool,
    /// Summed normal collision impulse applied on this tick, N·s.
    pub collision_impulse_ns: f64,
}

/// Initial pose/speed for registration. Pose and longitudinal speed are
/// required; the remaining continuous quantities default to rest (wheel speed
/// defaults to free rolling at the registered speed).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionInitialState {
    pub x: f64,
    pub y: f64,
    pub yaw_rad: f64,
    pub longitudinal_velocity_mps: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lateral_velocity_mps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yaw_rate_radps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steer_rad: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel_angular_speed_radps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub longitudinal_acceleration_mps2: Option<f64>,
}

impl MotionInitialState {
    pub fn at_rest(x: f64, y: f64, yaw_rad: f64, longitudinal_velocity_mps: f64) -> Self {
        Self {
            x,
            y,
            yaw_rad,
            longitudinal_velocity_mps,
            lateral_velocity_mps: None,
            yaw_rate_radps: None,
            steer_rad: None,
            wheel_angular_speed_radps: None,
            longitudinal_acceleration_mps2: None,
        }
    }
}

fn default_actor_kind() -> ActorKind {
    ActorKind::Car
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionActorInitialization {
    pub actor_id: String,
    /// Class profile selector. Defaults to a generic passenger car.
    #[serde(default = "default_actor_kind")]
    pub kind: ActorKind,
    /// Collision footprint (`l`/`w` are used; `h` is carried for the shared
    /// type). Defaults to a 4.8 m × 1.9 m car footprint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<Dims>,
    #[serde(default)]
    pub motion_direction: MotionDirection,
    pub state: MotionInitialState,
    /// Hash-covered per-actor overrides on top of the class profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<VehiclePhysicsProfile>,
}

/// Motion integration seam. Implementations own their continuous state; the
/// engine continues to own triggers, collision *detection* events, routes and
/// metrics. Bodies are addressed by [`BodyIndex`]; [`MotionBackend::body`]
/// maps canonical actor ids to indices once, at binding time.
pub trait MotionBackend {
    fn id(&self) -> &'static str;
    fn version(&self) -> u32;
    fn substep_s(&self) -> f64;
    /// Register (or re-register) a body. Returns its stable index.
    fn register(&mut self, input: &MotionActorInitialization) -> Result<BodyIndex, PhysicsError>;
    fn body(&self, actor_id: &str) -> Option<BodyIndex>;
    fn actor_id(&self, body: BodyIndex) -> Option<&str>;
    /// Replace body state when an authored exact-time trajectory owns motion.
    /// The replaced pose also becomes the swept-contact origin, so a recorded
    /// placement never sweeps from the body's previous physical pose.
    fn set_state(&mut self, body: BodyIndex, state: VehicleMotionState)
        -> Result<(), PhysicsError>;
    fn step(
        &mut self,
        body: BodyIndex,
        intent: &MotionIntent,
        dt_s: f64,
        friction_scale: f64,
    ) -> Result<MotionStepResult, PhysicsError>;
    fn state(&self, body: BodyIndex) -> Option<VehicleMotionState>;
    fn telemetry(&self, body: BodyIndex) -> Option<PhysicsTelemetrySample>;
}
