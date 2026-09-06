//! `SimScenarioInput` — the engine's stable input contract, as typed Rust.
//!
//! This is a **fully resolved concrete scenario**: no logical anchors, no
//! parameter references, no expressions, no map queries. Every actor already
//! has a pose, a route and numeric behaviour rules; every trigger already has
//! numeric thresholds. Producing one of these from an authoring template is the
//! compiler's job — this seam is what it targets.
//!
//! The vocabulary is the interactions research doc: seven verbs over five axes,
//! one uniform `dynamics` shape, and `at | after | when` triggers plus the
//! pre-solved `arrival` form.
//!
//! ## Load boundary
//!
//! [`parse_scenario_input`] / [`parse_scenario_input_value`] validate a JSON
//! document exactly like the zod contract: every field is range-checked,
//! defaults are materialised, strict objects reject unknown keys, and **all**
//! issues are collected with dotted paths so an unattended repair loop can act
//! on them. The result is a typed document that is parsed once; hot paths never
//! look values up by string.
//!
//! ## Hash stability
//!
//! The typed document serialises (`Serialize`, camelCase) to precisely the
//! shape the validated JavaScript document has: defaulted fields present,
//! absent optionals absent. Therefore [`SimScenarioInput::content_hash`] is the
//! same `inputHash` that existing trace headers carry, provided the document is
//! [`SimScenarioInput::normalized`] first (the engine always normalises before
//! hashing).
//!
//! Coordinates in this module are **scene frame** (`{x, z}`, y-up) exactly as
//! authored; see [`crate::math`] for the one conversion into the engine's
//! xodr-local frame.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::error::{CoreError, SchemaError, SchemaIssue};
use crate::hash::{cmp_utf16, content_hash_of};
use crate::math::{js_round, local_from_scene, SceneXZ, Vec2};
use crate::rng::Seed;

/// Input schema version accepted by this crate.
pub const SCHEMA_VERSION: u32 = 1;

/// An `id` used to reference actors, interactions, signals and occluders.
/// Validated against `^[A-Za-z0-9][A-Za-z0-9._:@/-]*$`, 1..=128 UTF-16 units.
pub type Id = String;
/// `road:section:lane`, e.g. `"27:0:-1"`.
pub type LaneRsl = String;

/* ------------------------------------------------------------ string enums */

/// A string enum: strongly typed in Rust, a bare string on the wire.
pub trait StrEnum: Copy + 'static {
    const NAMES: &'static [&'static str];
    fn as_str(self) -> &'static str;
    fn parse(text: &str) -> Option<Self>;
}

macro_rules! str_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name { $($(#[$vmeta])* $variant),+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub const fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some($name::$variant),)+ _ => None }
            }
        }

        impl StrEnum for $name {
            const NAMES: &'static [&'static str] = &[$($text),+];
            fn as_str(self) -> &'static str { $name::as_str(self) }
            fn parse(text: &str) -> Option<Self> { $name::parse(text) }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.as_str()) }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> { s.serialize_str(self.as_str()) }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let text = <std::borrow::Cow<'de, str>>::deserialize(d)?;
                $name::parse(&text).ok_or_else(|| serde::de::Error::unknown_variant(&text, <$name as StrEnum>::NAMES))
            }
        }
    };
}

str_enum! {
    /// What a signal head or road control shows.
    ControlIndication {
        Green = "green", Yellow = "yellow", Red = "red",
        FlashingYellow = "flashing_yellow", FlashingRed = "flashing_red", Off = "off",
        GreenArrow = "green_arrow", YellowArrow = "yellow_arrow", RedX = "red_x",
        Proceed = "proceed", Stop = "stop",
        /// Permissive left: changes *turn* logic rather than through logic.
        FlashingYellowArrow = "flashing_yellow_arrow",
        /// Stop-then-turn.
        FlashingRedArrow = "flashing_red_arrow",
    }
}

str_enum! {
    DynamicsShape { Step = "step", Linear = "linear", Sinusoidal = "sinusoidal", Cubic = "cubic" }
}

str_enum! {
    /// - `rate`: m/s² for `speed`/`gap`, m/s lateral velocity for `changeLane`/`laneOffset`.
    /// - `time`: seconds to complete the transition.
    /// - `distance`: metres of longitudinal travel over which to complete it.
    DynamicsConstraint { Rate = "rate", Time = "time", Distance = "distance" }
}

str_enum! {
    TurnRelation { Straight = "Straight", Left = "Left", Right = "Right", UTurnLeft = "UTurnLeft", UTurnRight = "UTurnRight" }
}

str_enum! {
    /// Semantic actor identity used by simulation, traces and renderers.
    /// `vehicle` is the generic road-vehicle kind; materialisers prefer the
    /// concrete class whenever it is known.
    ActorKind {
        Vehicle = "vehicle", Car = "car", Truck = "truck", Bus = "bus", Van = "van",
        Motorcycle = "motorcycle", Bicycle = "bicycle", Pedestrian = "pedestrian",
        Scooter = "scooter", SidewalkRobot = "sidewalk_robot", Drone = "drone",
        Animal = "animal", StaticObject = "static_object",
    }
}

str_enum! { GapMode { Time = "time", Distance = "distance" } }
str_enum! { LaneOffsetMode { Meters = "meters", Fraction = "fraction" } }
str_enum! { ExistState { Present = "present", Absent = "absent" } }
str_enum! { DistanceMode { AlongLane = "alongLane", Euclidean = "euclidean" } }

str_enum! {
    /// Scalar comparison direction. Every threshold carries one so a generated
    /// scenario can never be ambiguous about which side fires.
    Comparison { Lt = "lt", Lte = "lte", Gt = "gt", Gte = "gte" }
}

str_enum! { InteractionEvent { Start = "start", End = "end" } }
str_enum! { IfNever { Skip = "skip", Fire = "fire" } }

str_enum! {
    /// Right-of-way rule while a signal head shows no indication. A dark
    /// signal is **not** an uncontrolled junction: the default (applied at
    /// read time by the signal book, never materialised into the document) is
    /// `all_way_stop`.
    DarkFallback { AllWayStop = "all_way_stop", Uncontrolled = "uncontrolled", Yield = "yield" }
}

str_enum! { TimingSource { Map = "map", SyntheticDefault = "synthetic-default", Authored = "authored" } }
str_enum! { ControlBindingSource { Map = "map", Authored = "authored" } }
str_enum! { RoadControlKind { Stop = "stop" } }
str_enum! { PropEssentiality { Required = "required", Preferred = "preferred", Cosmetic = "cosmetic" } }
str_enum! { PassSide { Front = "front", Behind = "behind" } }
str_enum! { Weather { Clear = "clear", Rain = "rain", Overcast = "overcast" } }
str_enum! { TimeOfDay { Day = "day", Dusk = "dusk", Night = "night", Dawn = "dawn" } }
str_enum! { TrafficLevel { Light = "light", Moderate = "moderate", Heavy = "heavy" } }

str_enum! {
    VisibilityClass {
        Unrestricted = "unrestricted", ReducedContrast = "reduced-contrast",
        HeadlightLimited = "headlight-limited", DirectionalGlare = "directional-glare",
        DenseOcclusion = "dense-occlusion",
    }
}

str_enum! {
    /// Motion semantics are named and versioned independently of the engine
    /// build. `kinematic-v1` is the route-following/choreography model;
    /// `dynamic-v1` is the default for new simulation.
    MotionPhysicsMode { KinematicV1 = "kinematic-v1", DynamicV1 = "dynamic-v1" }
}

str_enum! {
    /// What is on the road. Names, not numbers, so a renderer and an exporter
    /// resolve a material rather than reverse a coefficient.
    SurfaceKind {
        Ice = "ice", PackedSnow = "packed_snow", StandingWater = "standing_water",
        WetLeaves = "wet_leaves", LooseGravel = "loose_gravel", Sand = "sand",
        SpilledOil = "spilled_oil", PolishedAsphalt = "polished_asphalt", GritTreated = "grit_treated",
    }
}

str_enum! { SensorType { DashCamera = "dash_camera", Lidar = "lidar", Radar = "radar" } }

str_enum! {
    MapDivergenceKind {
        LaneMarkingsFaded = "lane_markings_faded", LaneMarkingsObscured = "lane_markings_obscured",
        LaneMarkingsRepainted = "lane_markings_repainted", LaneGeometryShifted = "lane_geometry_shifted",
        LaneMissingFromMap = "lane_missing_from_map", LaneAbsentInWorld = "lane_absent_in_world",
        ReflectorsMisaligned = "reflectors_misaligned", SurfaceMisclassified = "surface_misclassified",
    }
}

str_enum! {
    /// The `rules.*` keys the `set` verb can flip at runtime.
    RuleKey {
        ObeySignals = "obeySignals", YieldToVehicles = "yieldToVehicles",
        YieldToPedestrians = "yieldToPedestrians", CollisionAvoidance = "collisionAvoidance",
        Aggression = "aggression", SpeedFactor = "speedFactor",
    }
}

impl ActorKind {
    /// Engine-owned default dimensions by semantic kind.
    pub const fn default_dims(self) -> Dims {
        match self {
            Self::Vehicle | Self::Car => Dims {
                l: 4.8,
                w: 1.9,
                h: 1.5,
            },
            Self::Truck => Dims {
                l: 9.5,
                w: 2.5,
                h: 3.5,
            },
            Self::Bus => Dims {
                l: 12.0,
                w: 2.55,
                h: 3.2,
            },
            Self::Van => Dims {
                l: 5.5,
                w: 2.0,
                h: 2.2,
            },
            Self::Motorcycle => Dims {
                l: 2.2,
                w: 0.8,
                h: 1.5,
            },
            Self::Bicycle => Dims {
                l: 1.8,
                w: 0.6,
                h: 1.7,
            },
            Self::Pedestrian => Dims {
                l: 0.6,
                w: 0.6,
                h: 1.75,
            },
            Self::Scooter => Dims {
                l: 1.2,
                w: 0.6,
                h: 1.7,
            },
            Self::SidewalkRobot => Dims {
                l: 0.85,
                w: 0.6,
                h: 0.85,
            },
            Self::Drone => Dims {
                l: 1.0,
                w: 1.0,
                h: 0.45,
            },
            Self::Animal => Dims {
                l: 1.2,
                w: 0.5,
                h: 1.0,
            },
            Self::StaticObject => Dims {
                l: 1.0,
                w: 1.0,
                h: 1.0,
            },
        }
    }

    /// Motion family: walks/hovers rather than drives.
    pub const fn is_pedestrian_like(self) -> bool {
        matches!(
            self,
            Self::Pedestrian | Self::SidewalkRobot | Self::Drone | Self::Animal
        )
    }

    /// Kinds that can be taken off their feet by a contact. Pedestrian-like
    /// minus the drone: a quadrotor holds altitude and has no stance to lose.
    pub const fn is_knockdown_vulnerable(self) -> bool {
        matches!(self, Self::Pedestrian | Self::Animal | Self::SidewalkRobot)
    }

    pub const fn is_road_actor(self) -> bool {
        !self.is_pedestrian_like() && !matches!(self, Self::StaticObject)
    }
}

impl SurfaceKind {
    /// Grip multiplier against the surrounding surface: conventional
    /// dry-asphalt-relative tyre-road coefficients. `grit_treated` is the one
    /// entry above 1, which is why a surface field resolves by largest
    /// deviation rather than by minimum.
    pub const fn friction_scale(self) -> f64 {
        match self {
            Self::Ice => 0.15,
            Self::PackedSnow => 0.3,
            Self::StandingWater => 0.5,
            Self::WetLeaves => 0.45,
            Self::LooseGravel => 0.6,
            Self::Sand => 0.5,
            Self::SpilledOil => 0.25,
            Self::PolishedAsphalt => 0.75,
            Self::GritTreated => 1.15,
        }
    }
}

impl Comparison {
    /// Evaluate `value <cmp> threshold`.
    #[inline]
    pub fn holds(self, value: f64, threshold: f64) -> bool {
        match self {
            Self::Lt => value < threshold,
            Self::Lte => value <= threshold,
            Self::Gt => value > threshold,
            Self::Gte => value >= threshold,
        }
    }

    /// `true` for the "below" directions (`lt`, `lte`).
    #[inline]
    pub const fn is_upper_bound(self) -> bool {
        matches!(self, Self::Lt | Self::Lte)
    }
}

/* ------------------------------------------------------------------ basics */

/// A ground-plane point in the scene frame.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct ScenePoint {
    pub x: f64,
    pub z: f64,
}

impl ScenePoint {
    #[inline]
    pub fn to_local(self) -> Vec2 {
        local_from_scene(SceneXZ {
            x: self.x,
            z: self.z,
        })
    }
}

/// A lane reference: `rsl` = `road:section:lane`, `s` = arc length along it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneRef {
    pub rsl: LaneRsl,
    pub s: f64,
    /// Lateral offset as a fraction of local lane width; 0 = centreline.
    pub t_frac: f64,
}

/// A scene-frame pose: ground position plus heading (CCW from `+x`, frame-invariant).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pose {
    pub x: f64,
    pub z: f64,
    pub heading_rad: f64,
}

impl Pose {
    #[inline]
    pub fn position_local(&self) -> Vec2 {
        local_from_scene(SceneXZ {
            x: self.x,
            z: self.z,
        })
    }
}

/// Length / width / height, metres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Dims {
    pub l: f64,
    pub w: f64,
    pub h: f64,
}

/// The uniform dynamics descriptor. Mandatory on every shaped verb, never defaulted.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Dynamics {
    pub shape: DynamicsShape,
    pub constraint: DynamicsConstraint,
    pub value: f64,
}

/* ------------------------------------------------------------------ routes */

/// A scene-space position constraint at an exact time.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedPoint {
    pub time_s: f64,
    pub x: f64,
    pub z: f64,
}

/// How an actor's path through the network is specified.
///
/// `Deserialize` is the plain-data form for session commands, logs and
/// checkpoints (defaults match the input contract); the validating input path
/// still goes through the parser.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RouteSpec {
    /// An explicit ordered lane chain. Fully deterministic.
    #[serde(rename_all = "camelCase")]
    LanePath { lanes: Vec<LaneRsl> },
    /// Walk successors from a start lane, taking the listed turns at junctions
    /// (missing entries fall back to `Straight`, then to the lowest-`rsl` gate).
    #[serde(rename_all = "camelCase")]
    Follow {
        start_rsl: LaneRsl,
        #[serde(default)]
        turns: Vec<TurnRelation>,
        #[serde(default = "default_follow_max_length_m")]
        max_length_m: f64,
    },
    /// An explicit ground path in scene coordinates. A single point is a
    /// zero-length route: the actor stays where it is.
    #[serde(rename_all = "camelCase")]
    Polyline { points: Vec<ScenePoint> },
    /// Exact scene-space position constraints. Time owns the actor through
    /// the final authored timestamp; physics takes over and brakes afterward.
    #[serde(rename_all = "camelCase")]
    TimedPolyline { points: Vec<TimedPoint> },
}

/// `follow` / `nextJunction` default walk budget, metres.
pub const DEFAULT_ROUTE_MAX_LENGTH_M: f64 = 2000.0;

fn default_follow_max_length_m() -> f64 {
    DEFAULT_ROUTE_MAX_LENGTH_M
}

/// A route command resolved against the actor's live lane when it fires.
#[derive(Debug, Clone, PartialEq)]
pub enum RouteActionTarget {
    Spec(RouteSpec),
    NextJunction {
        turn: TurnRelation,
        max_length_m: f64,
    },
}

impl Serialize for RouteActionTarget {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Spec(spec) => spec.serialize(s),
            Self::NextJunction { turn, max_length_m } => {
                let mut st = s.serialize_struct("RouteActionTarget", 3)?;
                st.serialize_field("kind", "nextJunction")?;
                st.serialize_field("turn", turn)?;
                st.serialize_field("maxLengthM", max_length_m)?;
                st.end()
            }
        }
    }
}

/* ------------------------------------------------------------------- rules */

/// The discrete behaviour switches. `collision_avoidance: false` disables the
/// safety governor so a challenger actually commits instead of chickening out.
///
/// Right of way is governed per conflicting class: `yield_to_vehicles` and
/// `yield_to_pedestrians` each gate the junction conflict governor for the
/// road users they name. There is no master switch; a fully non-yielding actor
/// clears both.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorRules {
    pub obey_signals: bool,
    /// Yield to conflicting road users other than pedestrians/animals.
    pub yield_to_vehicles: bool,
    /// Yield to pedestrians and animals in crossing conflicts.
    pub yield_to_pedestrians: bool,
    pub collision_avoidance: bool,
    /// 0 = timid, 1 = aggressive. Scales accepted gaps and comfort decel.
    pub aggression: f64,
    /// Multiplier on the lane speed limit for free-flow cruising.
    pub speed_factor: f64,
}

impl Default for ActorRules {
    fn default() -> Self {
        Self {
            obey_signals: true,
            yield_to_vehicles: true,
            yield_to_pedestrians: true,
            collision_avoidance: true,
            aggression: 0.5,
            speed_factor: 1.0,
        }
    }
}

/* ------------------------------------------------------------------ actors */

/// Human comfort targets supplied by the authored actor profile.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrivingProfile {
    pub comfortable_lateral_acceleration_mps2: f64,
    pub comfortable_deceleration_mps2: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorInitial {
    /// Where on the lane graph the actor starts. Without it the engine
    /// projects `pose` onto the route's first lane; with it, `pose` is
    /// advisory and the lane placement wins.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane_ref: Option<LaneRef>,
    pub pose: Pose,
    pub speed_mps: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorBehavior {
    pub rules: ActorRules,
    pub route: RouteSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driving_profile: Option<DrivingProfile>,
    /// Free-flow cruise speed override, m/s. Without it the actor cruises at
    /// `speed_factor × lane speed limit`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cruise_speed_mps: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimActor {
    pub id: Id,
    pub kind: ActorKind,
    /// Explicit or kind-default dimensions; always materialised.
    pub dims: Dims,
    pub initial: ActorInitial,
    pub behavior: ActorBehavior,
    /// `false` = starts absent, waiting for an `exist(present)` interaction.
    pub present_at_start: bool,
    /// Static roadside actors occupy space and occlude sight lines but are
    /// excluded from episode pair metrics. Always `true` for `static_object`.
    #[serde(rename = "static")]
    pub is_static: bool,
    /// Free-form tags carried through to the trace header.
    pub tags: Vec<String>,
    /// Rigidly mounted perception sensors. Absent (not empty) when the
    /// document declares none, so historical documents keep their hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensors: Option<Vec<SimSensor>>,
}

impl SimActor {
    pub fn sensors(&self) -> &[SimSensor] {
        self.sensors.as_deref().unwrap_or(&[])
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

/* ------------------------------------------------------------------- verbs */

/// `speed(target, dyn)` — abs | ±Δ | ×k | match another actor | stop.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum SpeedTarget {
    Absolute {
        value: f64,
    },
    Delta {
        value: f64,
    },
    Factor {
        value: f64,
    },
    #[serde(rename_all = "camelCase")]
    Match {
        actor_id: Id,
        offset_mps: f64,
    },
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum LaneChangeTarget {
    Left {
        count: u8,
    },
    Right {
        count: u8,
    },
    Lane {
        rsl: LaneRsl,
    },
    #[serde(rename_all = "camelCase")]
    ActorLane {
        actor_id: Id,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapTarget {
    pub actor_id: Id,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LaneOffsetTarget {
    pub mode: LaneOffsetMode,
    pub value: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ExistTarget {
    pub state: ExistState,
}

/// The typed `set()` key registry. `rules.*` and `motion.*` feed the
/// controllers; the rest are recorded state (renderer/exporter read them back
/// out of the trace). `motion.gear` selects forward/reverse.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SetKey {
    Rule(RuleKey),
    Motion(String),
    Lights(String),
    Audio(String),
    Doors(String),
    Pose(String),
    Env(String),
    /// `signal:<id>.phase`
    SignalPhase(Id),
    /// `control:<id>.indication`
    ControlIndication(Id),
}

fn is_word(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn is_id_body(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
        })
}

impl SetKey {
    pub fn parse(text: &str) -> Option<Self> {
        if let Some(rest) = text.strip_prefix("rules.") {
            return RuleKey::parse(rest).map(SetKey::Rule);
        }
        for (prefix, ctor) in [
            ("motion.", SetKey::Motion as fn(String) -> SetKey),
            ("lights.", SetKey::Lights),
            ("audio.", SetKey::Audio),
            ("doors.", SetKey::Doors),
            ("pose.", SetKey::Pose),
            ("env.", SetKey::Env),
        ] {
            if let Some(rest) = text.strip_prefix(prefix) {
                return is_word(rest).then(|| ctor(rest.to_owned()));
            }
        }
        if let Some(rest) = text.strip_prefix("signal:") {
            let id = rest.strip_suffix(".phase")?;
            return is_id_body(id).then(|| SetKey::SignalPhase(id.to_owned()));
        }
        if let Some(rest) = text.strip_prefix("control:") {
            let id = rest.strip_suffix(".indication")?;
            return is_id_body(id).then(|| SetKey::ControlIndication(id.to_owned()));
        }
        None
    }
}

impl fmt::Display for SetKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rule(k) => write!(f, "rules.{}", k.as_str()),
            Self::Motion(k) => write!(f, "motion.{k}"),
            Self::Lights(k) => write!(f, "lights.{k}"),
            Self::Audio(k) => write!(f, "audio.{k}"),
            Self::Doors(k) => write!(f, "doors.{k}"),
            Self::Pose(k) => write!(f, "pose.{k}"),
            Self::Env(k) => write!(f, "env.{k}"),
            Self::SignalPhase(id) => write!(f, "signal:{id}.phase"),
            Self::ControlIndication(id) => write!(f, "control:{id}.indication"),
        }
    }
}

impl Serialize for SetKey {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

/// `boolean | finite number | string`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SetValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

impl SetValue {
    /// JavaScript truthiness, which is how `set` consumers coerce the value.
    pub fn truthy(&self) -> bool {
        match self {
            Self::Bool(b) => *b,
            Self::Number(n) => *n != 0.0 && !n.is_nan(),
            Self::Text(t) => !t.is_empty(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SetTarget {
    pub key: SetKey,
    pub value: SetValue,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "verb", rename_all = "camelCase")]
pub enum Verb {
    Speed {
        target: SpeedTarget,
        dynamics: Dynamics,
    },
    Gap {
        target: GapTarget,
        value: f64,
        mode: GapMode,
        dynamics: Dynamics,
    },
    ChangeLane {
        target: LaneChangeTarget,
        dynamics: Dynamics,
    },
    LaneOffset {
        target: LaneOffsetTarget,
        dynamics: Dynamics,
    },
    #[serde(rename_all = "camelCase")]
    Route {
        target: RouteActionTarget,
        /// Connect the actor's live pose to the first authored waypoint when the interaction fires.
        #[serde(skip_serializing_if = "Option::is_none")]
        join_from_current_pose: Option<bool>,
        /// Follow literal world-space points without road, signal, or avoidance governors.
        #[serde(skip_serializing_if = "Option::is_none")]
        best_effort_world_path: Option<bool>,
    },
    Exist {
        target: ExistTarget,
    },
    Set {
        target: SetTarget,
    },
}

/* ---------------------------------------------------------------- triggers */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Region {
    #[serde(rename_all = "camelCase")]
    Circle {
        center: ScenePoint,
        radius_m: f64,
    },
    Polygon {
        points: Vec<ScenePoint>,
    },
    #[serde(rename_all = "camelCase")]
    LaneWindow {
        rsl: LaneRsl,
        s_min: f64,
        s_max: f64,
    },
}

/// A localised patch of road with different grip. A `Region`, not a new
/// spatial vocabulary, so an ice patch and a `reaches` trigger name the same
/// shapes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePatch {
    pub id: Id,
    pub kind: SurfaceKind,
    pub region: Region,
    /// Overrides the coefficient implied by `kind`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub friction_scale: Option<f64>,
    /// Blend distance at the patch boundary, metres. `0` is a hard edge.
    pub edge_taper_m: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl SurfacePatch {
    /// Explicit override or the kind's conventional coefficient.
    #[inline]
    pub fn effective_friction_scale(&self) -> f64 {
        self.friction_scale
            .unwrap_or_else(|| self.kind.friction_scale())
    }
}

/// A leaf trigger condition.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LeafCondition {
    Distance {
        a: Id,
        b: Id,
        mode: DistanceMode,
        cmp: Comparison,
        value: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        hysteresis: Option<f64>,
    },
    Ttc {
        a: Id,
        b: Id,
        cmp: Comparison,
        value: f64,
    },
    Headway {
        a: Id,
        b: Id,
        cmp: Comparison,
        value: f64,
    },
    #[serde(rename_all = "camelCase")]
    Reaches { actor_id: Id, region: Region },
    #[serde(rename_all = "camelCase")]
    Speed {
        actor_id: Id,
        cmp: Comparison,
        value: f64,
    },
    #[serde(rename_all = "camelCase")]
    Standstill { actor_id: Id, duration_s: f64 },
    #[serde(rename_all = "camelCase")]
    Signal {
        signal_id: Id,
        phase: ControlIndication,
    },
    Collision {
        #[serde(skip_serializing_if = "Option::is_none")]
        a: Option<Id>,
        #[serde(skip_serializing_if = "Option::is_none")]
        b: Option<Id>,
    },
    /// Pure plan-view geometry, unaffected by weather.
    Visible { a: Id, to: Id, value: bool },
    /// The perception counterpart of `visible`: asks the observer's declared
    /// sensor suite. Omitting `sensor` takes the suite's best opinion.
    Detected {
        a: Id,
        by: Id,
        #[serde(skip_serializing_if = "Option::is_none")]
        sensor: Option<Id>,
        value: bool,
    },
}

/// Trigger conditions. `and`/`or`/`not` are **shallow** by contract: one
/// level of boolean over leaf conditions.
#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    Leaf(LeafCondition),
    And(Vec<LeafCondition>),
    Or(Vec<LeafCondition>),
    Not(LeafCondition),
}

impl Condition {
    /// Every leaf this condition evaluates.
    pub fn leaves(&self) -> impl Iterator<Item = &LeafCondition> {
        match self {
            Self::Leaf(l) | Self::Not(l) => std::slice::from_ref(l).iter(),
            Self::And(of) | Self::Or(of) => of.iter(),
        }
    }
}

impl Serialize for Condition {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Leaf(leaf) => leaf.serialize(s),
            Self::And(of) | Self::Or(of) => {
                let mut st = s.serialize_struct("Condition", 2)?;
                st.serialize_field(
                    "kind",
                    if matches!(self, Self::And(_)) {
                        "and"
                    } else {
                        "or"
                    },
                )?;
                st.serialize_field("of", of)?;
                st.end()
            }
            Self::Not(of) => {
                let mut st = s.serialize_struct("Condition", 2)?;
                st.serialize_field("kind", "not")?;
                st.serialize_field("of", of)?;
                st.end()
            }
        }
    }
}

/// The same longitudinal cross-section on a concrete lane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaneStation {
    pub rsl: LaneRsl,
    pub s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferenceFrame {
    pub stations: Vec<LaneStation>,
}

/// Where the arrival solver aims the actor.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArrivalPoint {
    #[serde(rename_all = "camelCase")]
    Point {
        at: ScenePoint,
        /// Proof that this point was authored from a reference-frame
        /// cross-section, letting a route containing one of those lanes
        /// resolve the arrival semantically.
        #[serde(skip_serializing_if = "Option::is_none")]
        reference_frame: Option<ReferenceFrame>,
    },
    LaneS {
        rsl: LaneRsl,
        s: f64,
    },
}

/// The arrival spec. Exactly one of `ttc` / `delta_t`; they are the same
/// number with opposite sign (`ttc == -delta_t`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrivalSpec {
    pub of: Id,
    pub at: ArrivalPoint,
    pub sync_with: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_t: Option<f64>,
}

impl ArrivalSpec {
    /// Declared criticality as a TTC: `syncWith` is this many seconds from the
    /// point when `of` reaches it.
    #[inline]
    pub fn ttc_s(&self) -> f64 {
        match (self.ttc, self.delta_t) {
            (Some(ttc), _) => ttc,
            (None, Some(delta_t)) => -delta_t,
            (None, None) => unreachable!("validated arrival has ttc or deltaT"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Trigger {
    At {
        t: f64,
    },
    #[serde(rename_all = "camelCase")]
    After {
        interaction_id: Id,
        #[serde(skip_serializing_if = "Option::is_none")]
        event: Option<InteractionEvent>,
        delay_s: f64,
    },
    /// `by_latest` is mandatory: a condition that never fires is a silent
    /// bug, so the author must say what happens instead.
    #[serde(rename_all = "camelCase")]
    When {
        condition: Condition,
        by_latest: f64,
        if_never: IfNever,
    },
    Arrival {
        arrival: ArrivalSpec,
    },
}

/// Half-open eligibility window `[start_s, end_s)`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionWindow {
    pub start_s: f64,
    pub end_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    pub id: Id,
    pub actor_id: Id,
    pub trigger: Trigger,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<InteractionWindow>,
    /// Releases the axis back to default behaviour when satisfied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<Condition>,
    #[serde(flatten)]
    pub verb: Verb,
}

/* ----------------------------------------------------- signals & controls */

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalPhase {
    pub phase: ControlIndication,
    pub duration_s: f64,
}

/// A stop line, optionally filtered to the junction lanes it applies to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopLine {
    pub rsl: LaneRsl,
    pub s: f64,
    /// A stop line only applies when the actor's route continues through one
    /// of these junction lanes. Empty = applies to every movement.
    pub connecting_lane_rsls: Vec<LaneRsl>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerHeadGroup {
    pub controller_id: String,
    pub head_ids: Vec<String>,
}

/// Stable binding back to the map's physical signal furniture/export ids.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalMapBinding {
    pub junction_id: String,
    pub controller_ids: Vec<String>,
    pub head_ids: Vec<String>,
    /// Authoritative OpenDRIVE controller-sequence membership. Programs
    /// materialised from maps always populate this; authored inputs may omit it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_head_groups: Option<Vec<ControllerHeadGroup>>,
    pub timing_source: TimingSource,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalProgram {
    pub id: Id,
    /// One cycle. Phases play in order from `t = -warmupSeconds + offsetS`
    /// and repeat when `loop`.
    pub phases: Vec<SignalPhase>,
    pub offset_s: f64,
    #[serde(rename = "loop")]
    pub loop_: bool,
    /// Absent means the law: `all_way_stop`. Never materialised, so
    /// historical documents keep their hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dark_fallback: Option<DarkFallback>,
    /// Minimum standstill at the line while this program is dark or flashing red.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dark_dwell_s: Option<f64>,
    pub stop_lines: Vec<StopLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_binding: Option<SignalMapBinding>,
}

impl SignalProgram {
    /// The rule that applies while the head is dark.
    #[inline]
    pub fn effective_dark_fallback(&self) -> DarkFallback {
        self.dark_fallback.unwrap_or(DarkFallback::AllWayStop)
    }

    /// Cycle length in seconds.
    pub fn cycle_s(&self) -> f64 {
        self.phases.iter().map(|p| p.duration_s).sum()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadControlMapBinding {
    pub junction_id: String,
    pub control_ids: Vec<String>,
    pub source: ControlBindingSource,
}

/// A deterministic static right-of-way control. Unlike a traffic signal this
/// has per-actor memory: an actor must stop, dwell, then is released.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadControl {
    pub id: Id,
    pub kind: RoadControlKind,
    /// Minimum continuous standstill before this actor may proceed.
    pub dwell_s: f64,
    pub stop_lines: Vec<StopLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_binding: Option<RoadControlMapBinding>,
}

/* -------------------------------------------------------- props & occluders */

/// Rigid transform in an actor-local frame: +longitudinal forward, +lateral left.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropAttachment {
    pub actor_id: Id,
    pub longitudinal_m: f64,
    pub lateral_m: f64,
    pub height_m: f64,
    pub heading_offset_rad: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OccludesPair {
    pub observer: Id,
    pub target: Id,
}

/// One concrete, fixed catalog prop in the scene frame. `dims` are the
/// unscaled catalog/override dimensions; consumers apply `scale` exactly once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticProp {
    pub id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Id>,
    pub catalog_id: String,
    pub pose: Pose,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<PropAttachment>,
    pub dims: Dims,
    pub scale: f64,
    pub collidable: bool,
    pub essentiality: PropEssentiality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occludes: Option<OccludesPair>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_reveal_to_conflict_s: Option<f64>,
}

/// A static line-of-sight blocker's box, in the scene frame.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccluderObb {
    pub center: ScenePoint,
    pub length_m: f64,
    pub width_m: f64,
    pub heading_rad: f64,
    pub height_m: f64,
}

impl OccluderObb {
    /// The engine-frame box.
    pub fn to_local(&self) -> crate::math::Obb {
        crate::math::Obb {
            center: self.center.to_local(),
            length_m: self.length_m,
            width_m: self.width_m,
            heading_rad: self.heading_rad,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occluder {
    pub id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Id>,
    pub obb: OccluderObb,
}

/// An authored line-of-sight relation the occluder layer is supposed to affect.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcclusionPair {
    pub observer: Id,
    pub target: Id,
    /// Concrete occluder id, group id, or a monitored actor ref (`actor:<id>`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occluder_id: Option<Id>,
}

/// Hash-covered semantic acceptance intent for a materialised near miss.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearMissCriterion {
    pub interaction_id: Id,
    pub pedestrian_id: Id,
    pub target_id: Id,
    pub clearance_m: f64,
    pub tolerance_m: f64,
    pub pass: PassSide,
    /// Eight lowercase hex digits.
    pub plan_hash: String,
    pub predicted_closest_approach_s: f64,
    pub predicted_time_gap_s: f64,
}

/* ------------------------------------------------ operational conditions */

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionEffects {
    /// Maximum actor-to-actor LOS range used by `visible()` and reveal metrics.
    pub visibility_range_m: f64,
    /// Multiplier on physical braking capacity and hard-eligibility ceiling.
    pub friction_scale: f64,
    /// Multiplier on ambient cruise speeds and lane speed limits.
    pub traffic_speed_factor: f64,
}

impl Default for ConditionEffects {
    fn default() -> Self {
        Self {
            visibility_range_m: 10_000.0,
            friction_scale: 1.0,
            traffic_speed_factor: 1.0,
        }
    }
}

/// Hash-covered ambient conditions with explicit executable effects.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationalConditions {
    pub weather: Weather,
    pub time_of_day: TimeOfDay,
    pub traffic: TrafficLevel,
    pub visibility: VisibilityClass,
    pub effects: ConditionEffects,
}

impl Default for OperationalConditions {
    fn default() -> Self {
        Self {
            weather: Weather::Clear,
            time_of_day: TimeOfDay::Day,
            traffic: TrafficLevel::Moderate,
            visibility: VisibilityClass::Unrestricted,
            effects: ConditionEffects::default(),
        }
    }
}

/* ----------------------------------------------------------------- physics */

pub const DEFAULT_MOTION_PHYSICS_MODE: MotionPhysicsMode = MotionPhysicsMode::DynamicV1;

/// Per-actor physical-parameter overrides; omitted values use solver defaults.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehiclePhysicsProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mass_kg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yaw_inertia_kg_m2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheelbase_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cg_to_front_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cg_height_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheel_radius_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cornering_stiffness_front_n_per_rad: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cornering_stiffness_rear_n_per_rad: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drag_coefficient_n_per_mps2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rolling_resistance_coefficient: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_drive_force_n: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_brake_force_n: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_steer_rad: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steer_rate_rad_per_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steer_time_constant_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tire_mu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_longitudinal_accel_mps2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_longitudinal_decel_mps2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_jerk_mps3: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_lateral_acceleration_mps2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_yaw_rate_radps: Option<f64>,
}

/// Field table: `(wire name, positive-only)`. `cgHeightM`, drag and rolling
/// resistance accept zero; everything else must be strictly positive.
const VEHICLE_PROFILE_FIELDS: [(&str, bool); 21] = [
    ("massKg", true),
    ("yawInertiaKgM2", true),
    ("wheelbaseM", true),
    ("cgToFrontM", true),
    ("cgHeightM", false),
    ("wheelRadiusM", true),
    ("corneringStiffnessFrontNPerRad", true),
    ("corneringStiffnessRearNPerRad", true),
    ("dragCoefficientNPerMps2", false),
    ("rollingResistanceCoefficient", false),
    ("maxDriveForceN", true),
    ("maxBrakeForceN", true),
    ("maxSteerRad", true),
    ("steerRateRadPerS", true),
    ("steerTimeConstantS", true),
    ("tireMu", true),
    ("maxLongitudinalAccelMps2", true),
    ("maxLongitudinalDecelMps2", true),
    ("maxJerkMps3", true),
    ("maxLateralAccelerationMps2", true),
    ("maxYawRateRadps", true),
];

impl VehiclePhysicsProfile {
    fn slot_mut(&mut self, index: usize) -> &mut Option<f64> {
        match index {
            0 => &mut self.mass_kg,
            1 => &mut self.yaw_inertia_kg_m2,
            2 => &mut self.wheelbase_m,
            3 => &mut self.cg_to_front_m,
            4 => &mut self.cg_height_m,
            5 => &mut self.wheel_radius_m,
            6 => &mut self.cornering_stiffness_front_n_per_rad,
            7 => &mut self.cornering_stiffness_rear_n_per_rad,
            8 => &mut self.drag_coefficient_n_per_mps2,
            9 => &mut self.rolling_resistance_coefficient,
            10 => &mut self.max_drive_force_n,
            11 => &mut self.max_brake_force_n,
            12 => &mut self.max_steer_rad,
            13 => &mut self.steer_rate_rad_per_s,
            14 => &mut self.steer_time_constant_s,
            15 => &mut self.tire_mu,
            16 => &mut self.max_longitudinal_accel_mps2,
            17 => &mut self.max_longitudinal_decel_mps2,
            18 => &mut self.max_jerk_mps3,
            19 => &mut self.max_lateral_acceleration_mps2,
            20 => &mut self.max_yaw_rate_radps,
            _ => unreachable!("profile field index"),
        }
    }
}

/// Phase-0 physics selection envelope. Optional on the document on purpose:
/// parsing an older document must not materialise a new property and thereby
/// change its input hash.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicsConfig {
    pub mode: MotionPhysicsMode,
    /// Dynamic solver substep. Kinematic-v1 uses the scenario dt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub substep_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vehicle_profiles: Option<BTreeMap<Id, VehiclePhysicsProfile>>,
}

impl PhysicsConfig {
    pub fn profile(&self, actor_id: &str) -> Option<&VehiclePhysicsProfile> {
        self.vehicle_profiles.as_ref()?.get(actor_id)
    }
}

/* -------------------------------------------------------------- perception */

/// Euler orientation in the actor-local frame, radians. Yaw is the boresight.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorRotation {
    pub yaw_rad: f64,
    pub pitch_rad: f64,
    pub roll_rad: f64,
}

/// Actor-local metres: `+x` forward, `+y` up, `+z` left.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct MountPosition {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SensorMount {
    pub position: MountPosition,
    pub rotation: SensorRotation,
}

/// The hard geometric gate. Outside the aperture is *not observable at all*.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorAperture {
    pub horizontal_fov_deg: f64,
    pub vertical_fov_deg: f64,
    pub near_m: f64,
    pub far_m: f64,
}

impl Default for SensorAperture {
    fn default() -> Self {
        Self {
            horizontal_fov_deg: 90.0,
            vertical_fov_deg: 60.0,
            near_m: 0.05,
            far_m: 1_000.0,
        }
    }
}

/// How the modality responds to each degradation term. `0` means immune.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SensorSensitivity {
    pub atmosphere: f64,
    pub illumination: f64,
    pub glare: f64,
}

impl Default for SensorSensitivity {
    fn default() -> Self {
        Self {
            atmosphere: 1.0,
            illumination: 1.0,
            glare: 1.0,
        }
    }
}

/// The detector's physical thresholds (Koschmieder contrast, angular size,
/// illumination floor) and reporting confidences.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionModel {
    pub contrast_threshold: f64,
    pub min_angular_size_rad: f64,
    pub min_illumination_frac: f64,
    pub detect_confidence: f64,
    pub degraded_confidence: f64,
    pub sensitivity: SensorSensitivity,
    /// Debounce, seconds; counted in whole ticks so it cannot drift.
    pub latch_s: f64,
}

impl Default for DetectionModel {
    /// The field-level defaults used when a `detection` object is present but
    /// sparse — identical for every sensor type.
    fn default() -> Self {
        Self {
            contrast_threshold: 0.02,
            min_angular_size_rad: 0.0045,
            min_illumination_frac: 0.02,
            detect_confidence: 0.5,
            degraded_confidence: 0.2,
            sensitivity: SensorSensitivity::default(),
            latch_s: 0.0,
        }
    }
}

impl DetectionModel {
    /// The whole-object default applied when a sensor omits `detection`
    /// entirely; this is where the modality's physics lives.
    pub fn for_sensor(kind: SensorType) -> Self {
        match kind {
            SensorType::DashCamera => Self::default(),
            SensorType::Lidar => Self {
                min_angular_size_rad: 0.002,
                min_illumination_frac: 0.000001,
                sensitivity: SensorSensitivity {
                    atmosphere: 1.6,
                    illumination: 0.0,
                    glare: 0.15,
                },
                ..Self::default()
            },
            SensorType::Radar => Self {
                min_angular_size_rad: 0.02,
                min_illumination_frac: 0.000001,
                sensitivity: SensorSensitivity {
                    atmosphere: 0.05,
                    illumination: 0.0,
                    glare: 0.0,
                },
                ..Self::default()
            },
        }
    }
}

/// A rigidly mounted sensor. `aspect_ratio` exists only on dash cameras
/// (render-facing; the detector is parameterised by angular size).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimSensor {
    pub id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub enabled: bool,
    pub mount: SensorMount,
    pub aperture: SensorAperture,
    #[serde(rename = "type")]
    pub sensor_type: SensorType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<f64>,
    pub detection: DetectionModel,
}

/// The sun, in the engine's local `(x, y)` plane.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sun {
    /// Compass direction *towards* the sun, CCW from `+x`.
    pub azimuth_rad: f64,
    pub elevation_rad: f64,
    /// Angular radius of the blinding disc, radians.
    pub half_angle_rad: f64,
    /// Confidence lost when the target sits exactly on the source, 0..1.
    pub intensity: f64,
}

/// The air between the sensor and the world. `fog_visibility_m` is the
/// meteorological visibility (contrast falls to 5%).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Atmosphere {
    pub fog_visibility_m: f64,
    pub precipitation_mm_per_h: f64,
    /// Scene illumination as a fraction of full daylight.
    pub illumination_frac: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sun: Option<Sun>,
}

impl Default for Atmosphere {
    fn default() -> Self {
        Self {
            fog_visibility_m: 20_000.0,
            precipitation_mm_per_h: 0.0,
            illumination_frac: 1.0,
            sun: None,
        }
    }
}

/// Glare from an actor's own lamps, armed by a truthy actor state key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmissiveGlare {
    pub state_keys: Vec<String>,
    pub half_angle_rad: f64,
    pub intensity: f64,
    /// Beyond this range the lamp no longer saturates the detector.
    pub range_m: f64,
    /// Height of the beacon above the emitting actor's ground plane, metres.
    pub height_m: f64,
}

impl Default for EmissiveGlare {
    fn default() -> Self {
        Self {
            state_keys: vec!["lights.emergency".to_owned()],
            half_angle_rad: 0.25,
            intensity: 0.85,
            range_m: 80.0,
            height_m: 1.6,
        }
    }
}

/// Where a map/percept disagreement is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MapDivergenceExtent {
    #[serde(rename_all = "camelCase")]
    Lane {
        rsl: LaneRsl,
        #[serde(skip_serializing_if = "Option::is_none")]
        s_min: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        s_max: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Circle { center: ScenePoint, radius_m: f64 },
}

/// The declarative way to say *the HD map disagrees with the world here*.
/// A recorded exposure, not a force.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDivergence {
    pub id: Id,
    pub kind: MapDivergenceKind,
    pub extent: MapDivergenceExtent,
    /// 0 = cosmetic, 1 = the map is unusable here.
    pub severity: f64,
    /// For `lane_geometry_shifted`: how far the map is wrong, metres.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lateral_error_m: Option<f64>,
    /// Actors whose exposure is tracked. Empty means every actor with a sensor.
    pub observers: Vec<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// The whole perception block. Optional on the document for hash stability;
/// a document that declares sensors but omits it simulates in clear air at
/// full daylight ([`PerceptionConfig::default`]).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerceptionConfig {
    pub atmosphere: Atmosphere,
    pub emissive_glare: EmissiveGlare,
    pub map_divergences: Vec<MapDivergence>,
}

/* ------------------------------------------------------------ the document */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimScenarioInput {
    pub schema_version: u32,
    /// Informational: which map the `rsl` references belong to.
    pub map_id: String,
    /// Recorded clip length in seconds; the trace covers `t ∈ [0, clipSeconds]`.
    pub clip_seconds: f64,
    /// Unrecorded prologue `t ∈ [-warmupSeconds, 0)`.
    pub warmup_seconds: f64,
    /// Fixed integration step, seconds.
    pub dt: f64,
    pub seed: Seed,
    /// Omitted means the current simulation default and stays hash-stable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physics: Option<PhysicsConfig>,
    pub operational_conditions: OperationalConditions,
    /// Which actor the criticality metrics are reported against.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_subject: Option<Id>,
    pub actors: Vec<SimActor>,
    pub interactions: Vec<Interaction>,
    pub signal_programs: Vec<SignalProgram>,
    pub road_controls: Vec<RoadControl>,
    pub surface_patches: Vec<SurfacePatch>,
    pub props: Vec<StaticProp>,
    pub occluders: Vec<Occluder>,
    pub occlusion_pairs: Vec<OcclusionPair>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_miss_criteria: Option<Vec<NearMissCriterion>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub perception: Option<PerceptionConfig>,
}

impl SimScenarioInput {
    /// The effective physics mode without mutating hash-covered input. An
    /// explicit selection is honoured exactly; omitted resolves to the default.
    #[inline]
    pub fn physics_mode(&self) -> MotionPhysicsMode {
        self.physics
            .as_ref()
            .map_or(DEFAULT_MOTION_PHYSICS_MODE, |p| p.mode)
    }

    /// Effective physics configuration (owned, since the default is synthesised).
    pub fn resolved_physics(&self) -> PhysicsConfig {
        self.physics.clone().unwrap_or(PhysicsConfig {
            mode: DEFAULT_MOTION_PHYSICS_MODE,
            substep_s: None,
            vehicle_profiles: None,
        })
    }

    /// Recorded ticks: `round(clipSeconds / dt)`.
    #[inline]
    pub fn clip_ticks(&self) -> u64 {
        js_round(self.clip_seconds / self.dt) as u64
    }

    /// Prologue ticks: `round(warmupSeconds / dt)`.
    #[inline]
    pub fn warmup_ticks(&self) -> u64 {
        js_round(self.warmup_seconds / self.dt) as u64
    }

    /// The perception block in effect: declared, or clear-air defaults.
    pub fn effective_perception(&self) -> std::borrow::Cow<'_, PerceptionConfig> {
        match &self.perception {
            Some(p) => std::borrow::Cow::Borrowed(p),
            None => std::borrow::Cow::Owned(PerceptionConfig::default()),
        }
    }

    pub fn actor(&self, id: &str) -> Option<&SimActor> {
        self.actors.iter().find(|a| a.id == id)
    }

    /// Canonical ordering: every keyed collection sorted by id (UTF-16 code
    /// unit order, JavaScript's default). The engine iterates in sorted order
    /// anyway, so normalising does not change behaviour — but it makes the
    /// content hash independent of the order an adapter emitted its actors.
    pub fn normalized(mut self) -> Self {
        self.actors.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        self.interactions.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        self.signal_programs.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        self.road_controls.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        self.props.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        self.occluders.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        self.occlusion_pairs.sort_by(|a, b| {
            cmp_utf16(&a.observer, &b.observer)
                .then_with(|| cmp_utf16(&a.target, &b.target))
                .then_with(|| {
                    cmp_utf16(
                        a.occluder_id.as_deref().unwrap_or(""),
                        b.occluder_id.as_deref().unwrap_or(""),
                    )
                })
        });
        if let Some(criteria) = &mut self.near_miss_criteria {
            criteria.sort_by(|a, b| cmp_utf16(&a.interaction_id, &b.interaction_id));
        }
        self
    }

    /// `sha256(canonicalJson(self))` — the identity recorded as
    /// `trace.header.inputHash`. Normalise first for order independence.
    pub fn content_hash(&self) -> Result<String, CoreError> {
        content_hash_of(self)
    }
}

/* ================================================================ parsing */

/// Parse and validate a JSON document.
pub fn parse_scenario_input(json: &str) -> Result<SimScenarioInput, CoreError> {
    let value: Value = serde_json::from_str(json)?;
    Ok(parse_scenario_input_value(&value)?)
}

/// Parse and validate JSON bytes.
pub fn parse_scenario_input_bytes(json: &[u8]) -> Result<SimScenarioInput, CoreError> {
    let value: Value = serde_json::from_slice(json)?;
    Ok(parse_scenario_input_value(&value)?)
}

/// Parse and validate an already-decoded JSON value, collecting every issue.
pub fn parse_scenario_input_value(value: &Value) -> Result<SimScenarioInput, SchemaError> {
    let mut p = Parser::default();
    let doc = parse_document(&mut p, value);
    match doc {
        Some(doc) if p.issues.is_empty() => Ok(doc),
        _ => Err(SchemaError { issues: p.issues }),
    }
}

enum Seg {
    Key(&'static str),
    Owned(String),
    Index(usize),
}

impl Seg {
    fn clone_seg(&self) -> Seg {
        match self {
            Seg::Key(k) => Seg::Key(k),
            Seg::Owned(k) => Seg::Owned(k.clone()),
            Seg::Index(i) => Seg::Index(*i),
        }
    }
}

#[derive(Default)]
struct Parser {
    path: Vec<Seg>,
    issues: Vec<SchemaIssue>,
    /// Set by aborting issues (unknown keys on strict objects). Range and
    /// format violations are merely *dirty*: cross-reference refinements still
    /// run over them, exactly as the zod contract does.
    aborted: bool,
}

/// Numeric constraint spec, mirroring `z.number().finite().min().max().gt().int()`.
#[derive(Clone, Copy)]
struct Num {
    min: Option<f64>,
    max: Option<f64>,
    gt: Option<f64>,
    int: bool,
}

impl Num {
    const FINITE: Num = Num {
        min: None,
        max: None,
        gt: None,
        int: false,
    };
    const NON_NEG: Num = Num {
        min: Some(0.0),
        ..Num::FINITE
    };
    const POSITIVE: Num = Num {
        gt: Some(0.0),
        ..Num::FINITE
    };
    const UNIT: Num = Num {
        min: Some(0.0),
        max: Some(1.0),
        ..Num::FINITE
    };
    const fn min(self, v: f64) -> Num {
        Num {
            min: Some(v),
            ..self
        }
    }
    const fn max(self, v: f64) -> Num {
        Num {
            max: Some(v),
            ..self
        }
    }
    const fn gt(self, v: f64) -> Num {
        Num {
            gt: Some(v),
            ..self
        }
    }
    const fn int(self) -> Num {
        Num { int: true, ..self }
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn utf16_len(s: &str) -> usize {
    if s.is_ascii() {
        s.len()
    } else {
        s.encode_utf16().count()
    }
}

fn is_valid_id(s: &str) -> bool {
    let len = utf16_len(s);
    len > 0 && len <= 128 && s.as_bytes()[0].is_ascii_alphanumeric() && is_id_body(s)
}

fn join_quoted(items: &[&str], sep: &str) -> String {
    items
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(sep)
}

impl Parser {
    fn path_string(&self) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        for (i, seg) in self.path.iter().enumerate() {
            if i > 0 {
                out.push('.');
            }
            match seg {
                Seg::Key(k) => out.push_str(k),
                Seg::Owned(k) => out.push_str(k),
                Seg::Index(i) => {
                    let _ = write!(out, "{i}");
                }
            }
        }
        out
    }

    fn issue(&mut self, code: &'static str, message: impl Into<String>) {
        self.issues.push(SchemaIssue {
            code,
            path: self.path_string(),
            message: message.into(),
        });
    }

    /// Issue at a path relative to the current one (refine-style checks).
    fn issue_at(&mut self, rel: &[Seg], code: &'static str, message: impl Into<String>) {
        let depth = self.path.len();
        self.path.extend(rel.iter().map(Seg::clone_seg));
        self.issue(code, message);
        self.path.truncate(depth);
    }

    fn at<R>(&mut self, seg: Seg, f: impl FnOnce(&mut Self) -> R) -> R {
        self.path.push(seg);
        let r = f(self);
        self.path.pop();
        r
    }

    /* --- value shapes --- */

    fn object<'a>(&mut self, v: &'a Value) -> Option<&'a Map<String, Value>> {
        match v {
            Value::Object(m) => Some(m),
            other => {
                self.issue(
                    "invalid_type",
                    format!("Expected object, received {}", type_name(other)),
                );
                None
            }
        }
    }

    /// `z.strictObject`: every key must be in `allowed`.
    fn strict(&mut self, m: &Map<String, Value>, allowed: &[&str]) {
        let unknown: Vec<&str> = m
            .keys()
            .map(String::as_str)
            .filter(|k| !allowed.contains(k))
            .collect();
        if !unknown.is_empty() {
            self.issue(
                "unrecognized_keys",
                format!(
                    "Unrecognized key(s) in object: {}",
                    join_quoted(&unknown, ", ")
                ),
            );
            self.aborted = true;
        }
    }

    /// Range/shape violations are *dirty*, not aborted: the value is recorded
    /// and returned so sibling and cross-reference checks still run (zod
    /// semantics). Only a wrong JSON type or a non-finite number aborts.
    fn number(&mut self, v: &Value, spec: Num) -> Option<f64> {
        let n = match v {
            Value::Number(n) => n.as_f64()?,
            other => {
                self.issue(
                    "invalid_type",
                    format!("Expected number, received {}", type_name(other)),
                );
                return None;
            }
        };
        if !n.is_finite() {
            self.issue("not_finite", "Number must be finite");
            return None;
        }
        if spec.int && n.fract() != 0.0 {
            self.issue("invalid_type", "Expected integer, received float");
        }
        if let Some(min) = spec.min {
            if n < min {
                self.issue(
                    "too_small",
                    format!("Number must be greater than or equal to {min}"),
                );
            }
        }
        if let Some(gt) = spec.gt {
            if n <= gt {
                self.issue("too_small", format!("Number must be greater than {gt}"));
            }
        }
        if let Some(max) = spec.max {
            if n > max {
                self.issue(
                    "too_big",
                    format!("Number must be less than or equal to {max}"),
                );
            }
        }
        Some(n)
    }

    fn string(&mut self, v: &Value, min: usize, max: usize) -> Option<String> {
        let s = match v {
            Value::String(s) => s,
            other => {
                self.issue(
                    "invalid_type",
                    format!("Expected string, received {}", type_name(other)),
                );
                return None;
            }
        };
        let len = utf16_len(s);
        if len < min {
            self.issue(
                "too_small",
                format!("String must contain at least {min} character(s)"),
            );
        } else if len > max {
            self.issue(
                "too_big",
                format!("String must contain at most {max} character(s)"),
            );
        }
        Some(s.clone())
    }

    fn boolean(&mut self, v: &Value) -> Option<bool> {
        match v {
            Value::Bool(b) => Some(*b),
            other => {
                self.issue(
                    "invalid_type",
                    format!("Expected boolean, received {}", type_name(other)),
                );
                None
            }
        }
    }

    fn array<'a>(&mut self, v: &'a Value, min: usize, max: usize) -> Option<&'a [Value]> {
        let items = match v {
            Value::Array(items) => items,
            other => {
                self.issue(
                    "invalid_type",
                    format!("Expected array, received {}", type_name(other)),
                );
                return None;
            }
        };
        if items.len() < min {
            self.issue(
                "too_small",
                format!("Array must contain at least {min} element(s)"),
            );
        } else if items.len() > max {
            self.issue(
                "too_big",
                format!("Array must contain at most {max} element(s)"),
            );
        }
        Some(items)
    }

    fn enum_value<T: StrEnum>(&mut self, v: &Value) -> Option<T> {
        let s = match v {
            Value::String(s) => s,
            other => {
                self.issue(
                    "invalid_type",
                    format!("Expected string, received {}", type_name(other)),
                );
                return None;
            }
        };
        match T::parse(s) {
            Some(t) => Some(t),
            None => {
                self.issue(
                    "invalid_enum_value",
                    format!(
                        "Invalid enum value. Expected {}, received '{s}'",
                        join_quoted(T::NAMES, " | ")
                    ),
                );
                None
            }
        }
    }

    fn id(&mut self, v: &Value) -> Option<Id> {
        let s = self.string(v, 1, 128)?;
        if !is_valid_id(&s) {
            self.issue("invalid_format", "id must be a printable reference token");
        }
        Some(s)
    }

    /// A non-empty plain string (lane rsl, catalog id, ...).
    fn text(&mut self, v: &Value) -> Option<String> {
        self.string(v, 1, usize::MAX)
    }

    /// Read a discriminator field.
    fn discriminator<'a>(
        &mut self,
        m: &'a Map<String, Value>,
        key: &'static str,
        options: &[&str],
    ) -> Option<&'a str> {
        self.at(Seg::Key(key), |p| match m.get(key) {
            Some(Value::String(s)) if options.contains(&s.as_str()) => Some(s.as_str()),
            Some(Value::String(s)) => {
                p.issue(
                    "invalid_union_discriminator",
                    format!(
                        "Invalid discriminator value. Expected {}, received '{s}'",
                        join_quoted(options, " | ")
                    ),
                );
                None
            }
            Some(other) => {
                p.issue(
                    "invalid_type",
                    format!("Expected string, received {}", type_name(other)),
                );
                None
            }
            None => {
                p.issue(
                    "invalid_union_discriminator",
                    format!(
                        "Invalid discriminator value. Expected {}",
                        join_quoted(options, " | ")
                    ),
                );
                None
            }
        })
    }

    /* --- fields --- */

    fn field<T>(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        f: impl FnOnce(&mut Self, &Value) -> Option<T>,
    ) -> Option<T> {
        self.at(Seg::Key(key), |p| match m.get(key) {
            Some(v) => f(p, v),
            None => {
                p.issue("invalid_type", "Required");
                None
            }
        })
    }

    /// `.optional()`: `Some(None)` when absent, `None` when present but invalid.
    fn opt<T>(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        f: impl FnOnce(&mut Self, &Value) -> Option<T>,
    ) -> Option<Option<T>> {
        match m.get(key) {
            None => Some(None),
            Some(v) => self.at(Seg::Key(key), |p| f(p, v).map(Some)),
        }
    }

    /// `.default(d)`.
    fn or<T>(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        default: impl FnOnce() -> T,
        f: impl FnOnce(&mut Self, &Value) -> Option<T>,
    ) -> Option<T> {
        match m.get(key) {
            None => Some(default()),
            Some(v) => self.at(Seg::Key(key), |p| f(p, v)),
        }
    }

    fn num_field(&mut self, m: &Map<String, Value>, key: &'static str, spec: Num) -> Option<f64> {
        self.field(m, key, |p, v| p.number(v, spec))
    }

    fn num_opt(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        spec: Num,
    ) -> Option<Option<f64>> {
        self.opt(m, key, |p, v| p.number(v, spec))
    }

    fn num_or(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        spec: Num,
        default: f64,
    ) -> Option<f64> {
        self.or(m, key, || default, |p, v| p.number(v, spec))
    }

    fn bool_or(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        default: bool,
    ) -> Option<bool> {
        self.or(m, key, || default, |p, v| p.boolean(v))
    }

    fn id_field(&mut self, m: &Map<String, Value>, key: &'static str) -> Option<Id> {
        self.field(m, key, |p, v| p.id(v))
    }

    fn id_opt(&mut self, m: &Map<String, Value>, key: &'static str) -> Option<Option<Id>> {
        self.opt(m, key, |p, v| p.id(v))
    }

    fn text_field(&mut self, m: &Map<String, Value>, key: &'static str) -> Option<String> {
        self.field(m, key, |p, v| p.text(v))
    }

    fn enum_field<T: StrEnum>(&mut self, m: &Map<String, Value>, key: &'static str) -> Option<T> {
        self.field(m, key, |p, v| p.enum_value::<T>(v))
    }

    fn enum_or<T: StrEnum>(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        default: T,
    ) -> Option<T> {
        self.or(m, key, || default, |p, v| p.enum_value::<T>(v))
    }

    /// Parse every element of an array; `None` if any element failed.
    fn list<T>(
        &mut self,
        v: &Value,
        min: usize,
        max: usize,
        mut f: impl FnMut(&mut Self, &Value) -> Option<T>,
    ) -> Option<Vec<T>> {
        let items = self.array(v, min, max)?;
        let mut out = Vec::with_capacity(items.len());
        let mut ok = true;
        for (i, item) in items.iter().enumerate() {
            match self.at(Seg::Index(i), |p| f(p, item)) {
                Some(t) => out.push(t),
                None => ok = false,
            }
        }
        ok.then_some(out)
    }

    fn list_field<T>(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        min: usize,
        max: usize,
        f: impl FnMut(&mut Self, &Value) -> Option<T>,
    ) -> Option<Vec<T>> {
        self.field(m, key, |p, v| p.list(v, min, max, f))
    }

    fn list_or_empty<T>(
        &mut self,
        m: &Map<String, Value>,
        key: &'static str,
        max: usize,
        f: impl FnMut(&mut Self, &Value) -> Option<T>,
    ) -> Option<Vec<T>> {
        self.or(m, key, Vec::new, |p, v| p.list(v, 0, max, f))
    }

    fn text_list(&mut self, v: &Value, min: usize) -> Option<Vec<String>> {
        self.list(v, min, usize::MAX, |p, v| p.text(v))
    }
}

/* ----------------------------------------------------------- basic parsers */

fn parse_scene_point(p: &mut Parser, v: &Value) -> Option<ScenePoint> {
    let m = p.object(v)?;
    let x = p.num_field(m, "x", Num::FINITE);
    let z = p.num_field(m, "z", Num::FINITE);
    Some(ScenePoint { x: x?, z: z? })
}

fn parse_scene_point_strict(p: &mut Parser, v: &Value) -> Option<ScenePoint> {
    let m = p.object(v)?;
    p.strict(m, &["x", "z"]);
    parse_scene_point(p, v)
}

fn parse_lane_ref(p: &mut Parser, v: &Value) -> Option<LaneRef> {
    let m = p.object(v)?;
    let rsl = p.text_field(m, "rsl");
    let s = p.num_field(m, "s", Num::NON_NEG);
    let t_frac = p.num_or(m, "tFrac", Num::FINITE.min(-2.0).max(2.0), 0.0);
    Some(LaneRef {
        rsl: rsl?,
        s: s?,
        t_frac: t_frac?,
    })
}

fn parse_pose(p: &mut Parser, v: &Value) -> Option<Pose> {
    let m = p.object(v)?;
    let x = p.num_field(m, "x", Num::FINITE);
    let z = p.num_field(m, "z", Num::FINITE);
    let heading_rad = p.num_field(m, "headingRad", Num::FINITE);
    Some(Pose {
        x: x?,
        z: z?,
        heading_rad: heading_rad?,
    })
}

fn parse_dims(p: &mut Parser, v: &Value) -> Option<Dims> {
    let m = p.object(v)?;
    let l = p.num_field(m, "l", Num::POSITIVE);
    let w = p.num_field(m, "w", Num::POSITIVE);
    let h = p.num_field(m, "h", Num::POSITIVE);
    Some(Dims {
        l: l?,
        w: w?,
        h: h?,
    })
}

fn parse_dynamics(p: &mut Parser, v: &Value) -> Option<Dynamics> {
    let m = p.object(v)?;
    let shape = p.enum_field::<DynamicsShape>(m, "shape");
    let constraint = p.enum_field::<DynamicsConstraint>(m, "constraint");
    let value = p.num_field(m, "value", Num::POSITIVE);
    Some(Dynamics {
        shape: shape?,
        constraint: constraint?,
        value: value?,
    })
}

/* ------------------------------------------------------------------ routes */

const ROUTE_KINDS: [&str; 4] = ["lanePath", "follow", "polyline", "timedPolyline"];

fn parse_route_spec_from(p: &mut Parser, m: &Map<String, Value>, kind: &str) -> Option<RouteSpec> {
    match kind {
        "lanePath" => {
            let lanes = p.field(m, "lanes", |p, v| p.text_list(v, 1));
            Some(RouteSpec::LanePath { lanes: lanes? })
        }
        "follow" => {
            let start_rsl = p.text_field(m, "startRsl");
            let turns = p.list_or_empty(m, "turns", usize::MAX, |p, v| {
                p.enum_value::<TurnRelation>(v)
            });
            let max_length_m = p.num_or(m, "maxLengthM", Num::POSITIVE, DEFAULT_ROUTE_MAX_LENGTH_M);
            Some(RouteSpec::Follow {
                start_rsl: start_rsl?,
                turns: turns?,
                max_length_m: max_length_m?,
            })
        }
        "polyline" => {
            let points = p.list_field(m, "points", 1, usize::MAX, parse_scene_point);
            Some(RouteSpec::Polyline { points: points? })
        }
        "timedPolyline" => {
            let points = p.list_field(m, "points", 1, usize::MAX, |p, v| {
                let m = p.object(v)?;
                let time_s = p.num_field(m, "timeS", Num::NON_NEG);
                let x = p.num_field(m, "x", Num::FINITE);
                let z = p.num_field(m, "z", Num::FINITE);
                Some(TimedPoint {
                    time_s: time_s?,
                    x: x?,
                    z: z?,
                })
            });
            Some(RouteSpec::TimedPolyline { points: points? })
        }
        _ => unreachable!("discriminator validated"),
    }
}

fn parse_route_spec(p: &mut Parser, v: &Value) -> Option<RouteSpec> {
    let m = p.object(v)?;
    let kind = p.discriminator(m, "kind", &ROUTE_KINDS)?;
    parse_route_spec_from(p, m, kind)
}

fn parse_route_action_target(p: &mut Parser, v: &Value) -> Option<RouteActionTarget> {
    let m = p.object(v)?;
    let kind = p.discriminator(
        m,
        "kind",
        &[
            "lanePath",
            "follow",
            "polyline",
            "timedPolyline",
            "nextJunction",
        ],
    )?;
    if kind == "nextJunction" {
        let turn = p.enum_field::<TurnRelation>(m, "turn");
        let max_length_m = p.num_or(m, "maxLengthM", Num::POSITIVE, DEFAULT_ROUTE_MAX_LENGTH_M);
        return Some(RouteActionTarget::NextJunction {
            turn: turn?,
            max_length_m: max_length_m?,
        });
    }
    parse_route_spec_from(p, m, kind).map(RouteActionTarget::Spec)
}

/* ------------------------------------------------------------------ actors */

fn parse_rules(p: &mut Parser, v: &Value) -> Option<ActorRules> {
    let m = p.object(v)?;
    p.strict(
        m,
        &[
            "obeySignals",
            "yieldToVehicles",
            "yieldToPedestrians",
            "collisionAvoidance",
            "aggression",
            "speedFactor",
        ],
    );
    let obey_signals = p.bool_or(m, "obeySignals", true);
    let yield_to_vehicles = p.bool_or(m, "yieldToVehicles", true);
    let yield_to_pedestrians = p.bool_or(m, "yieldToPedestrians", true);
    let collision_avoidance = p.bool_or(m, "collisionAvoidance", true);
    let aggression = p.num_or(m, "aggression", Num::UNIT, 0.5);
    let speed_factor = p.num_or(m, "speedFactor", Num::FINITE.min(0.0).max(3.0), 1.0);
    Some(ActorRules {
        obey_signals: obey_signals?,
        yield_to_vehicles: yield_to_vehicles?,
        yield_to_pedestrians: yield_to_pedestrians?,
        collision_avoidance: collision_avoidance?,
        aggression: aggression?,
        speed_factor: speed_factor?,
    })
}

fn parse_driving_profile(p: &mut Parser, v: &Value) -> Option<DrivingProfile> {
    let m = p.object(v)?;
    p.strict(
        m,
        &[
            "comfortableLateralAccelerationMps2",
            "comfortableDecelerationMps2",
        ],
    );
    let lat = p.num_field(m, "comfortableLateralAccelerationMps2", Num::POSITIVE);
    let dec = p.num_field(m, "comfortableDecelerationMps2", Num::POSITIVE);
    Some(DrivingProfile {
        comfortable_lateral_acceleration_mps2: lat?,
        comfortable_deceleration_mps2: dec?,
    })
}

fn parse_actor(p: &mut Parser, v: &Value) -> Option<SimActor> {
    let m = p.object(v)?;
    let id = p.id_field(m, "id");
    let kind = p.enum_field::<ActorKind>(m, "kind");
    let dims = p.opt(m, "dims", parse_dims);
    let initial = p.field(m, "initial", |p, v| {
        let m = p.object(v)?;
        let lane_ref = p.opt(m, "laneRef", parse_lane_ref);
        let pose = p.field(m, "pose", parse_pose);
        let speed_mps = p.num_field(m, "speedMps", Num::NON_NEG);
        Some(ActorInitial {
            lane_ref: lane_ref?,
            pose: pose?,
            speed_mps: speed_mps?,
        })
    });
    let behavior = p.field(m, "behavior", |p, v| {
        let m = p.object(v)?;
        let rules = p.or(m, "rules", ActorRules::default, parse_rules);
        let route = p.field(m, "route", parse_route_spec);
        let driving_profile = p.opt(m, "drivingProfile", parse_driving_profile);
        let cruise_speed_mps = p.num_opt(m, "cruiseSpeedMps", Num::NON_NEG);
        Some(ActorBehavior {
            rules: rules?,
            route: route?,
            driving_profile: driving_profile?,
            cruise_speed_mps: cruise_speed_mps?,
        })
    });
    let present_at_start = p.bool_or(m, "presentAtStart", true);
    let is_static = p.opt(m, "static", |p, v| p.boolean(v));
    let tags = p.list_or_empty(m, "tags", usize::MAX, |p, v| p.string(v, 0, usize::MAX));
    let sensors = p.opt(m, "sensors", |p, v| p.list(v, 0, 32, parse_sensor));
    let kind = kind?;
    Some(SimActor {
        id: id?,
        kind,
        dims: dims?.unwrap_or_else(|| kind.default_dims()),
        initial: initial?,
        behavior: behavior?,
        present_at_start: present_at_start?,
        is_static: kind == ActorKind::StaticObject || is_static?.unwrap_or(false),
        tags: tags?,
        sensors: sensors?,
    })
}

/* -------------------------------------------------------------- perception */

fn parse_rotation(p: &mut Parser, v: &Value) -> Option<SensorRotation> {
    let m = p.object(v)?;
    p.strict(m, &["yawRad", "pitchRad", "rollRad"]);
    let pi = std::f64::consts::PI;
    let yaw = p.num_or(m, "yawRad", Num::FINITE.min(-pi).max(pi), 0.0);
    let pitch = p.num_or(m, "pitchRad", Num::FINITE.min(-pi / 2.0).max(pi / 2.0), 0.0);
    let roll = p.num_or(m, "rollRad", Num::FINITE.min(-pi).max(pi), 0.0);
    Some(SensorRotation {
        yaw_rad: yaw?,
        pitch_rad: pitch?,
        roll_rad: roll?,
    })
}

fn parse_mount(p: &mut Parser, v: &Value) -> Option<SensorMount> {
    let m = p.object(v)?;
    p.strict(m, &["position", "rotation"]);
    let position = p.field(m, "position", |p, v| {
        let m = p.object(v)?;
        p.strict(m, &["x", "y", "z"]);
        let x = p.num_field(m, "x", Num::FINITE);
        let y = p.num_field(m, "y", Num::FINITE);
        let z = p.num_field(m, "z", Num::FINITE);
        Some(MountPosition {
            x: x?,
            y: y?,
            z: z?,
        })
    });
    let rotation = p.or(m, "rotation", SensorRotation::default, parse_rotation);
    Some(SensorMount {
        position: position?,
        rotation: rotation?,
    })
}

fn parse_aperture(p: &mut Parser, v: &Value) -> Option<SensorAperture> {
    let m = p.object(v)?;
    p.strict(m, &["horizontalFovDeg", "verticalFovDeg", "nearM", "farM"]);
    let h = p.num_or(m, "horizontalFovDeg", Num::FINITE.gt(0.0).max(360.0), 90.0);
    let vfov = p.num_or(m, "verticalFovDeg", Num::FINITE.gt(0.0).max(180.0), 60.0);
    let near = p.num_or(m, "nearM", Num::POSITIVE.max(10.0), 0.05);
    let far = p.num_or(m, "farM", Num::POSITIVE.max(100_000.0), 1_000.0);
    let a = SensorAperture {
        horizontal_fov_deg: h?,
        vertical_fov_deg: vfov?,
        near_m: near?,
        far_m: far?,
    };
    if a.far_m <= a.near_m {
        p.issue_at(
            &[Seg::Key("farM")],
            "custom",
            "farM must be greater than nearM",
        );
        return None;
    }
    Some(a)
}

fn parse_detection(p: &mut Parser, v: &Value) -> Option<DetectionModel> {
    let m = p.object(v)?;
    p.strict(
        m,
        &[
            "contrastThreshold",
            "minAngularSizeRad",
            "minIlluminationFrac",
            "detectConfidence",
            "degradedConfidence",
            "sensitivity",
            "latchS",
        ],
    );
    let d = DetectionModel::default();
    let contrast = p.num_or(
        m,
        "contrastThreshold",
        Num::FINITE.gt(0.0).max(1.0),
        d.contrast_threshold,
    );
    let angular = p.num_or(
        m,
        "minAngularSizeRad",
        Num::FINITE.gt(0.0).max(1.0),
        d.min_angular_size_rad,
    );
    let illum = p.num_or(
        m,
        "minIlluminationFrac",
        Num::FINITE.gt(0.0).max(1.0),
        d.min_illumination_frac,
    );
    let detect = p.num_or(m, "detectConfidence", Num::UNIT, d.detect_confidence);
    let degraded = p.num_or(m, "degradedConfidence", Num::UNIT, d.degraded_confidence);
    let sensitivity = p.or(m, "sensitivity", SensorSensitivity::default, |p, v| {
        let m = p.object(v)?;
        p.strict(m, &["atmosphere", "illumination", "glare"]);
        let atmosphere = p.num_or(m, "atmosphere", Num::NON_NEG.max(8.0), 1.0);
        let illumination = p.num_or(m, "illumination", Num::NON_NEG.max(8.0), 1.0);
        let glare = p.num_or(m, "glare", Num::NON_NEG.max(8.0), 1.0);
        Some(SensorSensitivity {
            atmosphere: atmosphere?,
            illumination: illumination?,
            glare: glare?,
        })
    });
    let latch = p.num_or(m, "latchS", Num::NON_NEG.max(10.0), 0.0);
    let model = DetectionModel {
        contrast_threshold: contrast?,
        min_angular_size_rad: angular?,
        min_illumination_frac: illum?,
        detect_confidence: detect?,
        degraded_confidence: degraded?,
        sensitivity: sensitivity?,
        latch_s: latch?,
    };
    if model.degraded_confidence >= model.detect_confidence {
        p.issue_at(
            &[Seg::Key("degradedConfidence")],
            "custom",
            "degradedConfidence must be below detectConfidence",
        );
        return None;
    }
    Some(model)
}

fn parse_sensor(p: &mut Parser, v: &Value) -> Option<SimSensor> {
    let m = p.object(v)?;
    let sensor_type = p
        .discriminator(m, "type", SensorType::NAMES)
        .and_then(SensorType::parse)?;
    match sensor_type {
        SensorType::DashCamera => p.strict(
            m,
            &[
                "id",
                "label",
                "enabled",
                "mount",
                "aperture",
                "type",
                "detection",
                "aspectRatio",
            ],
        ),
        _ => p.strict(
            m,
            &[
                "id",
                "label",
                "enabled",
                "mount",
                "aperture",
                "type",
                "detection",
            ],
        ),
    }
    let id = p.id_field(m, "id");
    let label = p.opt(m, "label", |p, v| p.string(v, 1, 200));
    let enabled = p.bool_or(m, "enabled", true);
    let mount = p.field(m, "mount", parse_mount);
    let aperture = p.or(m, "aperture", SensorAperture::default, parse_aperture);
    let aspect_ratio = match sensor_type {
        SensorType::DashCamera => p
            .num_or(m, "aspectRatio", Num::POSITIVE.max(10.0), 1.777778)
            .map(Some),
        _ => Some(None),
    };
    let detection = p.or(
        m,
        "detection",
        || DetectionModel::for_sensor(sensor_type),
        parse_detection,
    );
    Some(SimSensor {
        id: id?,
        label: label?,
        enabled: enabled?,
        mount: mount?,
        aperture: aperture?,
        sensor_type,
        aspect_ratio: aspect_ratio?,
        detection: detection?,
    })
}

fn parse_atmosphere(p: &mut Parser, v: &Value) -> Option<Atmosphere> {
    let m = p.object(v)?;
    p.strict(
        m,
        &[
            "fogVisibilityM",
            "precipitationMmPerH",
            "illuminationFrac",
            "sun",
        ],
    );
    let fog = p.num_or(m, "fogVisibilityM", Num::POSITIVE.max(100_000.0), 20_000.0);
    let precip = p.num_or(m, "precipitationMmPerH", Num::NON_NEG.max(400.0), 0.0);
    let illum = p.num_or(m, "illuminationFrac", Num::UNIT, 1.0);
    let sun = p.opt(m, "sun", |p, v| {
        let m = p.object(v)?;
        p.strict(
            m,
            &["azimuthRad", "elevationRad", "halfAngleRad", "intensity"],
        );
        let half_pi = std::f64::consts::FRAC_PI_2;
        let azimuth = p.num_field(m, "azimuthRad", Num::FINITE);
        let elevation = p.num_field(m, "elevationRad", Num::FINITE.min(-half_pi).max(half_pi));
        let half_angle = p.num_or(m, "halfAngleRad", Num::POSITIVE.max(1.5), 0.35);
        let intensity = p.num_or(m, "intensity", Num::UNIT, 0.9);
        Some(Sun {
            azimuth_rad: azimuth?,
            elevation_rad: elevation?,
            half_angle_rad: half_angle?,
            intensity: intensity?,
        })
    });
    Some(Atmosphere {
        fog_visibility_m: fog?,
        precipitation_mm_per_h: precip?,
        illumination_frac: illum?,
        sun: sun?,
    })
}

fn parse_emissive_glare(p: &mut Parser, v: &Value) -> Option<EmissiveGlare> {
    let m = p.object(v)?;
    p.strict(
        m,
        &[
            "stateKeys",
            "halfAngleRad",
            "intensity",
            "rangeM",
            "heightM",
        ],
    );
    let state_keys = p.or(
        m,
        "stateKeys",
        || vec!["lights.emergency".to_owned()],
        |p, v| p.list(v, 0, 8, |p, v| p.string(v, 1, 64)),
    );
    let half_angle = p.num_or(m, "halfAngleRad", Num::POSITIVE.max(1.5), 0.25);
    let intensity = p.num_or(m, "intensity", Num::UNIT, 0.85);
    let range = p.num_or(m, "rangeM", Num::POSITIVE.max(2_000.0), 80.0);
    let height = p.num_or(m, "heightM", Num::NON_NEG.max(10.0), 1.6);
    Some(EmissiveGlare {
        state_keys: state_keys?,
        half_angle_rad: half_angle?,
        intensity: intensity?,
        range_m: range?,
        height_m: height?,
    })
}

fn parse_map_divergence(p: &mut Parser, v: &Value) -> Option<MapDivergence> {
    let m = p.object(v)?;
    p.strict(
        m,
        &[
            "id",
            "kind",
            "extent",
            "severity",
            "lateralErrorM",
            "observers",
            "label",
        ],
    );
    let id = p.id_field(m, "id");
    let kind = p.enum_field::<MapDivergenceKind>(m, "kind");
    let extent = p.field(m, "extent", |p, v| {
        let m = p.object(v)?;
        match p.discriminator(m, "kind", &["lane", "circle"])? {
            "lane" => {
                p.strict(m, &["kind", "rsl", "sMin", "sMax"]);
                let rsl = p.text_field(m, "rsl");
                let s_min = p.num_opt(m, "sMin", Num::NON_NEG);
                let s_max = p.num_opt(m, "sMax", Num::NON_NEG);
                Some(MapDivergenceExtent::Lane {
                    rsl: rsl?,
                    s_min: s_min?,
                    s_max: s_max?,
                })
            }
            _ => {
                p.strict(m, &["kind", "center", "radiusM"]);
                let center = p.field(m, "center", parse_scene_point_strict);
                let radius_m = p.num_field(m, "radiusM", Num::POSITIVE);
                Some(MapDivergenceExtent::Circle {
                    center: center?,
                    radius_m: radius_m?,
                })
            }
        }
    });
    let severity = p.num_or(m, "severity", Num::UNIT, 1.0);
    let lateral_error_m = p.num_opt(m, "lateralErrorM", Num::NON_NEG.max(20.0));
    let observers = p.list_or_empty(m, "observers", 64, |p, v| p.id(v));
    let label = p.opt(m, "label", |p, v| p.string(v, 0, 200));
    let d = MapDivergence {
        id: id?,
        kind: kind?,
        extent: extent?,
        severity: severity?,
        lateral_error_m: lateral_error_m?,
        observers: observers?,
        label: label?,
    };
    let mut ok = true;
    if d.kind == MapDivergenceKind::LaneGeometryShifted && d.lateral_error_m.is_none() {
        p.issue_at(
            &[Seg::Key("lateralErrorM")],
            "custom",
            "lane_geometry_shifted must state how far the map is wrong",
        );
        ok = false;
    }
    if let MapDivergenceExtent::Lane {
        s_min: Some(s_min),
        s_max: Some(s_max),
        ..
    } = &d.extent
    {
        if s_max <= s_min {
            p.issue_at(
                &[Seg::Key("extent"), Seg::Key("sMax")],
                "custom",
                "sMax must exceed sMin",
            );
            ok = false;
        }
    }
    ok.then_some(d)
}

fn parse_perception(p: &mut Parser, v: &Value) -> Option<PerceptionConfig> {
    let m = p.object(v)?;
    p.strict(m, &["atmosphere", "emissiveGlare", "mapDivergences"]);
    let atmosphere = p.or(m, "atmosphere", Atmosphere::default, parse_atmosphere);
    let emissive_glare = p.or(
        m,
        "emissiveGlare",
        EmissiveGlare::default,
        parse_emissive_glare,
    );
    let map_divergences = p.list_or_empty(m, "mapDivergences", 64, parse_map_divergence);
    Some(PerceptionConfig {
        atmosphere: atmosphere?,
        emissive_glare: emissive_glare?,
        map_divergences: map_divergences?,
    })
}

/* ------------------------------------------------------------------- verbs */

fn parse_speed_target(p: &mut Parser, v: &Value) -> Option<SpeedTarget> {
    let m = p.object(v)?;
    match p.discriminator(m, "mode", &["absolute", "delta", "factor", "match", "stop"])? {
        "absolute" => Some(SpeedTarget::Absolute {
            value: p.num_field(m, "value", Num::NON_NEG)?,
        }),
        "delta" => Some(SpeedTarget::Delta {
            value: p.num_field(m, "value", Num::FINITE)?,
        }),
        "factor" => Some(SpeedTarget::Factor {
            value: p.num_field(m, "value", Num::NON_NEG)?,
        }),
        "match" => {
            let actor_id = p.id_field(m, "actorId");
            let offset_mps = p.num_or(m, "offsetMps", Num::FINITE, 0.0);
            Some(SpeedTarget::Match {
                actor_id: actor_id?,
                offset_mps: offset_mps?,
            })
        }
        _ => Some(SpeedTarget::Stop),
    }
}

fn parse_lane_change_target(p: &mut Parser, v: &Value) -> Option<LaneChangeTarget> {
    let m = p.object(v)?;
    let count_spec = Num::FINITE.int().min(1.0).max(4.0);
    match p.discriminator(m, "mode", &["left", "right", "lane", "actorLane"])? {
        "left" => Some(LaneChangeTarget::Left {
            count: p.num_or(m, "count", count_spec, 1.0)? as u8,
        }),
        "right" => Some(LaneChangeTarget::Right {
            count: p.num_or(m, "count", count_spec, 1.0)? as u8,
        }),
        "lane" => Some(LaneChangeTarget::Lane {
            rsl: p.text_field(m, "rsl")?,
        }),
        _ => Some(LaneChangeTarget::ActorLane {
            actor_id: p.id_field(m, "actorId")?,
        }),
    }
}

fn parse_set_target(p: &mut Parser, v: &Value) -> Option<SetTarget> {
    let m = p.object(v)?;
    let key = p.field(m, "key", |p, v| {
        let s = p.string(v, 0, usize::MAX)?;
        match SetKey::parse(&s) {
            Some(k) => Some(k),
            None => {
                p.issue(
                    "invalid_format",
                    "unknown set() key — see the typed key registry",
                );
                None
            }
        }
    });
    let value = p.field(m, "value", |p, v| match v {
        Value::Bool(b) => Some(SetValue::Bool(*b)),
        Value::Number(_) => p.number(v, Num::FINITE).map(SetValue::Number),
        Value::String(s) => Some(SetValue::Text(s.clone())),
        other => {
            p.issue(
                "invalid_union",
                format!(
                    "Expected boolean, number or string, received {}",
                    type_name(other)
                ),
            );
            None
        }
    });
    Some(SetTarget {
        key: key?,
        value: value?,
    })
}

fn parse_verb(p: &mut Parser, m: &Map<String, Value>) -> Option<Verb> {
    match p.discriminator(
        m,
        "verb",
        &[
            "speed",
            "gap",
            "changeLane",
            "laneOffset",
            "route",
            "exist",
            "set",
        ],
    )? {
        "speed" => {
            let target = p.field(m, "target", parse_speed_target);
            let dynamics = p.field(m, "dynamics", parse_dynamics);
            Some(Verb::Speed {
                target: target?,
                dynamics: dynamics?,
            })
        }
        "gap" => {
            let target = p.field(m, "target", |p, v| {
                let m = p.object(v)?;
                Some(GapTarget {
                    actor_id: p.id_field(m, "actorId")?,
                })
            });
            let value = p.num_field(m, "value", Num::POSITIVE);
            let mode = p.enum_field::<GapMode>(m, "mode");
            let dynamics = p.field(m, "dynamics", parse_dynamics);
            Some(Verb::Gap {
                target: target?,
                value: value?,
                mode: mode?,
                dynamics: dynamics?,
            })
        }
        "changeLane" => {
            let target = p.field(m, "target", parse_lane_change_target);
            let dynamics = p.field(m, "dynamics", parse_dynamics);
            Some(Verb::ChangeLane {
                target: target?,
                dynamics: dynamics?,
            })
        }
        "laneOffset" => {
            let target = p.field(m, "target", |p, v| {
                let m = p.object(v)?;
                let mode = p.enum_field::<LaneOffsetMode>(m, "mode");
                let value = p.num_field(m, "value", Num::FINITE);
                Some(LaneOffsetTarget {
                    mode: mode?,
                    value: value?,
                })
            });
            let dynamics = p.field(m, "dynamics", parse_dynamics);
            Some(Verb::LaneOffset {
                target: target?,
                dynamics: dynamics?,
            })
        }
        "route" => {
            let target = p.field(m, "target", parse_route_action_target);
            let join = p.opt(m, "joinFromCurrentPose", |p, v| p.boolean(v));
            let best_effort = p.opt(m, "bestEffortWorldPath", |p, v| p.boolean(v));
            Some(Verb::Route {
                target: target?,
                join_from_current_pose: join?,
                best_effort_world_path: best_effort?,
            })
        }
        "exist" => {
            let target = p.field(m, "target", |p, v| {
                let m = p.object(v)?;
                Some(ExistTarget {
                    state: p.enum_field::<ExistState>(m, "state")?,
                })
            });
            Some(Verb::Exist { target: target? })
        }
        _ => Some(Verb::Set {
            target: p.field(m, "target", parse_set_target)?,
        }),
    }
}

/* ---------------------------------------------------------------- triggers */

fn parse_region(p: &mut Parser, v: &Value) -> Option<Region> {
    let m = p.object(v)?;
    match p.discriminator(m, "kind", &["circle", "polygon", "laneWindow"])? {
        "circle" => {
            let center = p.field(m, "center", parse_scene_point);
            let radius_m = p.num_field(m, "radiusM", Num::POSITIVE);
            Some(Region::Circle {
                center: center?,
                radius_m: radius_m?,
            })
        }
        "polygon" => Some(Region::Polygon {
            points: p.list_field(m, "points", 3, usize::MAX, parse_scene_point)?,
        }),
        _ => {
            let rsl = p.text_field(m, "rsl");
            let s_min = p.num_field(m, "sMin", Num::NON_NEG);
            let s_max = p.num_field(m, "sMax", Num::NON_NEG);
            Some(Region::LaneWindow {
                rsl: rsl?,
                s_min: s_min?,
                s_max: s_max?,
            })
        }
    }
}

fn parse_surface_patch(p: &mut Parser, v: &Value) -> Option<SurfacePatch> {
    let m = p.object(v)?;
    let id = p.id_field(m, "id");
    let kind = p.enum_field::<SurfaceKind>(m, "kind");
    let region = p.field(m, "region", parse_region);
    let friction_scale = p.num_opt(m, "frictionScale", Num::POSITIVE.min(0.05).max(1.5));
    let edge_taper_m = p.num_or(m, "edgeTaperM", Num::NON_NEG, 0.0);
    let label = p.opt(m, "label", |p, v| p.string(v, 0, 200));
    Some(SurfacePatch {
        id: id?,
        kind: kind?,
        region: region?,
        friction_scale: friction_scale?,
        edge_taper_m: edge_taper_m?,
        label: label?,
    })
}

const LEAF_KINDS: [&str; 10] = [
    "distance",
    "ttc",
    "headway",
    "reaches",
    "speed",
    "standstill",
    "signal",
    "collision",
    "visible",
    "detected",
];

fn parse_leaf_condition_from(
    p: &mut Parser,
    m: &Map<String, Value>,
    kind: &str,
) -> Option<LeafCondition> {
    match kind {
        "distance" => {
            let a = p.id_field(m, "a");
            let b = p.id_field(m, "b");
            let mode = p.enum_field::<DistanceMode>(m, "mode");
            let cmp = p.enum_field::<Comparison>(m, "cmp");
            let value = p.num_field(m, "value", Num::NON_NEG);
            let hysteresis = p.num_opt(m, "hysteresis", Num::NON_NEG);
            Some(LeafCondition::Distance {
                a: a?,
                b: b?,
                mode: mode?,
                cmp: cmp?,
                value: value?,
                hysteresis: hysteresis?,
            })
        }
        "ttc" | "headway" => {
            let a = p.id_field(m, "a");
            let b = p.id_field(m, "b");
            let cmp = p.enum_field::<Comparison>(m, "cmp");
            let value = p.num_field(m, "value", Num::NON_NEG);
            Some(if kind == "ttc" {
                LeafCondition::Ttc {
                    a: a?,
                    b: b?,
                    cmp: cmp?,
                    value: value?,
                }
            } else {
                LeafCondition::Headway {
                    a: a?,
                    b: b?,
                    cmp: cmp?,
                    value: value?,
                }
            })
        }
        "reaches" => {
            let actor_id = p.id_field(m, "actorId");
            let region = p.field(m, "region", parse_region);
            Some(LeafCondition::Reaches {
                actor_id: actor_id?,
                region: region?,
            })
        }
        "speed" => {
            let actor_id = p.id_field(m, "actorId");
            let cmp = p.enum_field::<Comparison>(m, "cmp");
            let value = p.num_field(m, "value", Num::NON_NEG);
            Some(LeafCondition::Speed {
                actor_id: actor_id?,
                cmp: cmp?,
                value: value?,
            })
        }
        "standstill" => {
            let actor_id = p.id_field(m, "actorId");
            let duration_s = p.num_field(m, "durationS", Num::NON_NEG);
            Some(LeafCondition::Standstill {
                actor_id: actor_id?,
                duration_s: duration_s?,
            })
        }
        "signal" => {
            let signal_id = p.id_field(m, "signalId");
            let phase = p.enum_field::<ControlIndication>(m, "phase");
            Some(LeafCondition::Signal {
                signal_id: signal_id?,
                phase: phase?,
            })
        }
        "collision" => {
            let a = p.id_opt(m, "a");
            let b = p.id_opt(m, "b");
            Some(LeafCondition::Collision { a: a?, b: b? })
        }
        "visible" => {
            let a = p.id_field(m, "a");
            let to = p.id_field(m, "to");
            let value = p.field(m, "value", |p, v| p.boolean(v));
            Some(LeafCondition::Visible {
                a: a?,
                to: to?,
                value: value?,
            })
        }
        "detected" => {
            let a = p.id_field(m, "a");
            let by = p.id_field(m, "by");
            let sensor = p.id_opt(m, "sensor");
            let value = p.field(m, "value", |p, v| p.boolean(v));
            Some(LeafCondition::Detected {
                a: a?,
                by: by?,
                sensor: sensor?,
                value: value?,
            })
        }
        _ => unreachable!("discriminator validated"),
    }
}

fn parse_leaf_condition(p: &mut Parser, v: &Value) -> Option<LeafCondition> {
    let m = p.object(v)?;
    let kind = p.discriminator(m, "kind", &LEAF_KINDS)?;
    parse_leaf_condition_from(p, m, kind)
}

fn parse_condition(p: &mut Parser, v: &Value) -> Option<Condition> {
    let m = p.object(v)?;
    const ALL: [&str; 13] = [
        "distance",
        "ttc",
        "headway",
        "reaches",
        "speed",
        "standstill",
        "signal",
        "collision",
        "visible",
        "detected",
        "and",
        "or",
        "not",
    ];
    match p.discriminator(m, "kind", &ALL)? {
        "and" => Some(Condition::And(p.list_field(
            m,
            "of",
            1,
            8,
            parse_leaf_condition,
        )?)),
        "or" => Some(Condition::Or(p.list_field(
            m,
            "of",
            1,
            8,
            parse_leaf_condition,
        )?)),
        "not" => Some(Condition::Not(p.field(m, "of", parse_leaf_condition)?)),
        kind => parse_leaf_condition_from(p, m, kind).map(Condition::Leaf),
    }
}

fn parse_arrival(p: &mut Parser, v: &Value) -> Option<ArrivalSpec> {
    let m = p.object(v)?;
    let of = p.id_field(m, "of");
    let at = p.field(m, "at", |p, v| {
        let m = p.object(v)?;
        match p.discriminator(m, "kind", &["point", "laneS"])? {
            "point" => {
                let at = p.field(m, "at", parse_scene_point);
                let reference_frame = p.opt(m, "referenceFrame", |p, v| {
                    let m = p.object(v)?;
                    let stations = p.list_field(m, "stations", 1, usize::MAX, |p, v| {
                        let m = p.object(v)?;
                        let rsl = p.text_field(m, "rsl");
                        let s = p.num_field(m, "s", Num::NON_NEG);
                        Some(LaneStation { rsl: rsl?, s: s? })
                    });
                    Some(ReferenceFrame {
                        stations: stations?,
                    })
                });
                Some(ArrivalPoint::Point {
                    at: at?,
                    reference_frame: reference_frame?,
                })
            }
            _ => {
                let rsl = p.text_field(m, "rsl");
                let s = p.num_field(m, "s", Num::NON_NEG);
                Some(ArrivalPoint::LaneS { rsl: rsl?, s: s? })
            }
        }
    });
    let sync_with = p.id_field(m, "syncWith");
    let ttc = p.num_opt(m, "ttc", Num::FINITE);
    let delta_t = p.num_opt(m, "deltaT", Num::FINITE);
    let spec = ArrivalSpec {
        of: of?,
        at: at?,
        sync_with: sync_with?,
        ttc: ttc?,
        delta_t: delta_t?,
    };
    if spec.ttc.is_none() == spec.delta_t.is_none() {
        p.issue("custom", "arrival requires exactly one of ttc | deltaT");
        return None;
    }
    Some(spec)
}

fn parse_trigger(p: &mut Parser, v: &Value) -> Option<Trigger> {
    let m = p.object(v)?;
    match p.discriminator(m, "kind", &["at", "after", "when", "arrival"])? {
        "at" => Some(Trigger::At {
            t: p.num_field(m, "t", Num::FINITE)?,
        }),
        "after" => {
            let interaction_id = p.id_field(m, "interactionId");
            let event = p.opt(m, "event", |p, v| p.enum_value::<InteractionEvent>(v));
            let delay_s = p.num_or(m, "delayS", Num::NON_NEG, 0.0);
            Some(Trigger::After {
                interaction_id: interaction_id?,
                event: event?,
                delay_s: delay_s?,
            })
        }
        "when" => {
            let condition = p.field(m, "condition", parse_condition);
            let by_latest = p.num_field(m, "byLatest", Num::FINITE);
            let if_never = p.enum_field::<IfNever>(m, "ifNever");
            Some(Trigger::When {
                condition: condition?,
                by_latest: by_latest?,
                if_never: if_never?,
            })
        }
        _ => Some(Trigger::Arrival {
            arrival: p.field(m, "arrival", parse_arrival)?,
        }),
    }
}

fn parse_interaction(p: &mut Parser, v: &Value) -> Option<Interaction> {
    let m = p.object(v)?;
    let id = p.id_field(m, "id");
    let actor_id = p.id_field(m, "actorId");
    let trigger = p.field(m, "trigger", parse_trigger);
    let window = p.opt(m, "window", |p, v| {
        let m = p.object(v)?;
        let start_s = p.num_field(m, "startS", Num::FINITE);
        let end_s = p.num_field(m, "endS", Num::FINITE);
        let w = InteractionWindow {
            start_s: start_s?,
            end_s: end_s?,
        };
        if w.start_s > w.end_s {
            p.issue("custom", "interaction window startS must be <= endS");
            return None;
        }
        Some(w)
    });
    let until = p.opt(m, "until", parse_condition);
    let verb = parse_verb(p, m);
    Some(Interaction {
        id: id?,
        actor_id: actor_id?,
        trigger: trigger?,
        window: window?,
        until: until?,
        verb: verb?,
    })
}

/* ----------------------------------------------------- signals & controls */

fn parse_stop_line(p: &mut Parser, v: &Value) -> Option<StopLine> {
    let m = p.object(v)?;
    let rsl = p.text_field(m, "rsl");
    let s = p.num_field(m, "s", Num::NON_NEG);
    let connecting = p.list_or_empty(m, "connectingLaneRsls", usize::MAX, |p, v| p.text(v));
    Some(StopLine {
        rsl: rsl?,
        s: s?,
        connecting_lane_rsls: connecting?,
    })
}

fn sorted_unique_utf16<'a>(items: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = items.collect();
    out.sort_by(|a, b| cmp_utf16(a, b));
    out.dedup();
    out
}

fn parse_signal_map_binding(p: &mut Parser, v: &Value) -> Option<SignalMapBinding> {
    let m = p.object(v)?;
    let junction_id = p.text_field(m, "junctionId");
    let controller_ids = p.list_or_empty(m, "controllerIds", usize::MAX, |p, v| p.text(v));
    let head_ids = p.field(m, "headIds", |p, v| p.text_list(v, 1));
    let groups = p.opt(m, "controllerHeadGroups", |p, v| {
        p.list(v, 0, usize::MAX, |p, v| {
            let m = p.object(v)?;
            let controller_id = p.text_field(m, "controllerId");
            let head_ids = p.field(m, "headIds", |p, v| p.text_list(v, 1));
            Some(ControllerHeadGroup {
                controller_id: controller_id?,
                head_ids: head_ids?,
            })
        })
    });
    let timing_source = p.enum_field::<TimingSource>(m, "timingSource");
    let binding = SignalMapBinding {
        junction_id: junction_id?,
        controller_ids: controller_ids?,
        head_ids: head_ids?,
        controller_head_groups: groups?,
        timing_source: timing_source?,
    };
    let Some(groups) = &binding.controller_head_groups else {
        return Some(binding);
    };
    let mut ok = true;
    let mut seen_controllers: HashSet<&str> = HashSet::with_capacity(groups.len());
    if groups
        .iter()
        .any(|g| !seen_controllers.insert(&g.controller_id))
    {
        p.issue_at(
            &[Seg::Key("controllerHeadGroups")],
            "custom",
            "duplicate controllerHeadGroups controllerId",
        );
        ok = false;
    }
    for (i, g) in groups.iter().enumerate() {
        let mut seen: HashSet<&str> = HashSet::with_capacity(g.head_ids.len());
        if g.head_ids.iter().any(|h| !seen.insert(h)) {
            p.issue_at(
                &[
                    Seg::Key("controllerHeadGroups"),
                    Seg::Index(i),
                    Seg::Key("headIds"),
                ],
                "custom",
                "duplicate controller head id",
            );
            ok = false;
        }
    }
    // The TS refine compares the *sorted* (not deduplicated) declared lists
    // against the sorted unique flattened lists, so a duplicated declared id
    // is a mismatch. Sort declared lists without dedup to keep that.
    let mut declared_controllers: Vec<&str> =
        binding.controller_ids.iter().map(String::as_str).collect();
    declared_controllers.sort_by(|a, b| cmp_utf16(a, b));
    let mut declared_heads: Vec<&str> = binding.head_ids.iter().map(String::as_str).collect();
    declared_heads.sort_by(|a, b| cmp_utf16(a, b));
    if declared_controllers != sorted_unique_utf16(groups.iter().map(|g| g.controller_id.as_str()))
    {
        p.issue_at(
            &[Seg::Key("controllerIds")],
            "custom",
            "controllerIds must equal controllerHeadGroups controller ids",
        );
        ok = false;
    }
    if declared_heads
        != sorted_unique_utf16(
            groups
                .iter()
                .flat_map(|g| g.head_ids.iter().map(String::as_str)),
        )
    {
        p.issue_at(
            &[Seg::Key("headIds")],
            "custom",
            "headIds must equal controllerHeadGroups head ids",
        );
        ok = false;
    }
    ok.then_some(binding)
}

fn parse_signal_program(p: &mut Parser, v: &Value) -> Option<SignalProgram> {
    let m = p.object(v)?;
    let id = p.id_field(m, "id");
    let phases = p.list_field(m, "phases", 1, usize::MAX, |p, v| {
        let m = p.object(v)?;
        let phase = p.enum_field::<ControlIndication>(m, "phase");
        let duration_s = p.num_field(m, "durationS", Num::POSITIVE);
        Some(SignalPhase {
            phase: phase?,
            duration_s: duration_s?,
        })
    });
    let offset_s = p.num_or(m, "offsetS", Num::FINITE, 0.0);
    let loop_ = p.bool_or(m, "loop", true);
    let dark_fallback = p.opt(m, "darkFallback", |p, v| p.enum_value::<DarkFallback>(v));
    let dark_dwell_s = p.num_opt(m, "darkDwellS", Num::POSITIVE);
    let stop_lines = p.list_or_empty(m, "stopLines", usize::MAX, parse_stop_line);
    let map_binding = p.opt(m, "mapBinding", parse_signal_map_binding);
    Some(SignalProgram {
        id: id?,
        phases: phases?,
        offset_s: offset_s?,
        loop_: loop_?,
        dark_fallback: dark_fallback?,
        dark_dwell_s: dark_dwell_s?,
        stop_lines: stop_lines?,
        map_binding: map_binding?,
    })
}

fn parse_road_control(p: &mut Parser, v: &Value) -> Option<RoadControl> {
    let m = p.object(v)?;
    let id = p.id_field(m, "id");
    let kind = p.field(m, "kind", |p, v| match v {
        Value::String(s) if s == "stop" => Some(RoadControlKind::Stop),
        other => {
            p.issue(
                "invalid_literal",
                format!(
                    "Invalid literal value, expected \"stop\", received {}",
                    type_name(other)
                ),
            );
            None
        }
    });
    let dwell_s = p.num_or(m, "dwellS", Num::POSITIVE, 1.0);
    let stop_lines = p.list_field(m, "stopLines", 1, usize::MAX, parse_stop_line);
    let map_binding = p.opt(m, "mapBinding", |p, v| {
        let m = p.object(v)?;
        let junction_id = p.text_field(m, "junctionId");
        let control_ids = p.field(m, "controlIds", |p, v| p.text_list(v, 1));
        let source = p.enum_field::<ControlBindingSource>(m, "source");
        Some(RoadControlMapBinding {
            junction_id: junction_id?,
            control_ids: control_ids?,
            source: source?,
        })
    });
    Some(RoadControl {
        id: id?,
        kind: kind?,
        dwell_s: dwell_s?,
        stop_lines: stop_lines?,
        map_binding: map_binding?,
    })
}

/* -------------------------------------------------------- props & occluders */

fn parse_prop(p: &mut Parser, v: &Value) -> Option<StaticProp> {
    let m = p.object(v)?;
    let id = p.id_field(m, "id");
    let group_id = p.id_opt(m, "groupId");
    let catalog_id = p.field(m, "catalogId", |p, v| p.string(v, 1, 200));
    let pose = p.field(m, "pose", parse_pose);
    let attachment = p.opt(m, "attachment", |p, v| {
        let m = p.object(v)?;
        let actor_id = p.id_field(m, "actorId");
        let longitudinal_m = p.num_or(m, "longitudinalM", Num::FINITE, 0.0);
        let lateral_m = p.num_or(m, "lateralM", Num::FINITE, 0.0);
        let height_m = p.num_or(m, "heightM", Num::NON_NEG, 0.0);
        let heading_offset_rad = p.num_or(m, "headingOffsetRad", Num::FINITE, 0.0);
        Some(PropAttachment {
            actor_id: actor_id?,
            longitudinal_m: longitudinal_m?,
            lateral_m: lateral_m?,
            height_m: height_m?,
            heading_offset_rad: heading_offset_rad?,
        })
    });
    let dims = p.field(m, "dims", parse_dims);
    let scale = p.num_or(m, "scale", Num::POSITIVE.max(10.0), 1.0);
    let collidable = p.bool_or(m, "collidable", false);
    let essentiality = p.enum_or(m, "essentiality", PropEssentiality::Preferred);
    let occludes = p.opt(m, "occludes", |p, v| {
        let m = p.object(v)?;
        let observer = p.id_field(m, "observer");
        let target = p.id_field(m, "target");
        Some(OccludesPair {
            observer: observer?,
            target: target?,
        })
    });
    let target_reveal = p.num_opt(m, "targetRevealToConflictS", Num::NON_NEG);
    let prop = StaticProp {
        id: id?,
        group_id: group_id?,
        catalog_id: catalog_id?,
        pose: pose?,
        attachment: attachment?,
        dims: dims?,
        scale: scale?,
        collidable: collidable?,
        essentiality: essentiality?,
        occludes: occludes?,
        target_reveal_to_conflict_s: target_reveal?,
    };
    if prop.target_reveal_to_conflict_s.is_some() && prop.occludes.is_none() {
        p.issue_at(
            &[Seg::Key("targetRevealToConflictS")],
            "custom",
            "targetRevealToConflictS requires occludes",
        );
        return None;
    }
    Some(prop)
}

fn parse_occluder(p: &mut Parser, v: &Value) -> Option<Occluder> {
    let m = p.object(v)?;
    let id = p.id_field(m, "id");
    let group_id = p.id_opt(m, "groupId");
    let obb = p.field(m, "obb", |p, v| {
        let m = p.object(v)?;
        let center = p.field(m, "center", parse_scene_point);
        let length_m = p.num_field(m, "lengthM", Num::POSITIVE);
        let width_m = p.num_field(m, "widthM", Num::POSITIVE);
        let heading_rad = p.num_field(m, "headingRad", Num::FINITE);
        let height_m = p.num_or(m, "heightM", Num::POSITIVE, 2.0);
        Some(OccluderObb {
            center: center?,
            length_m: length_m?,
            width_m: width_m?,
            heading_rad: heading_rad?,
            height_m: height_m?,
        })
    });
    Some(Occluder {
        id: id?,
        group_id: group_id?,
        obb: obb?,
    })
}

fn parse_occlusion_pair(p: &mut Parser, v: &Value) -> Option<OcclusionPair> {
    let m = p.object(v)?;
    let observer = p.id_field(m, "observer");
    let target = p.id_field(m, "target");
    let occluder_id = p.id_opt(m, "occluderId");
    Some(OcclusionPair {
        observer: observer?,
        target: target?,
        occluder_id: occluder_id?,
    })
}

fn parse_near_miss_criterion(p: &mut Parser, v: &Value) -> Option<NearMissCriterion> {
    let m = p.object(v)?;
    let interaction_id = p.id_field(m, "interactionId");
    let pedestrian_id = p.id_field(m, "pedestrianId");
    let target_id = p.id_field(m, "targetId");
    let clearance_m = p.num_field(m, "clearanceM", Num::POSITIVE);
    let tolerance_m = p.num_or(m, "toleranceM", Num::POSITIVE, 0.15);
    let pass = p.enum_field::<PassSide>(m, "pass");
    let plan_hash = p.field(m, "planHash", |p, v| {
        let s = p.string(v, 0, usize::MAX)?;
        if s.len() == 8
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            Some(s)
        } else {
            p.issue("invalid_format", "planHash must be 8 lowercase hex digits");
            None
        }
    });
    let closest = p.num_field(m, "predictedClosestApproachS", Num::NON_NEG);
    let gap = p.num_field(m, "predictedTimeGapS", Num::FINITE);
    Some(NearMissCriterion {
        interaction_id: interaction_id?,
        pedestrian_id: pedestrian_id?,
        target_id: target_id?,
        clearance_m: clearance_m?,
        tolerance_m: tolerance_m?,
        pass: pass?,
        plan_hash: plan_hash?,
        predicted_closest_approach_s: closest?,
        predicted_time_gap_s: gap?,
    })
}

/* ------------------------------------------------- conditions and physics */

fn parse_operational_conditions(p: &mut Parser, v: &Value) -> Option<OperationalConditions> {
    let m = p.object(v)?;
    let weather = p.enum_or(m, "weather", Weather::Clear);
    let time_of_day = p.enum_or(m, "timeOfDay", TimeOfDay::Day);
    let traffic = p.enum_or(m, "traffic", TrafficLevel::Moderate);
    let visibility = p.enum_or(m, "visibility", VisibilityClass::Unrestricted);
    let effects = p.or(m, "effects", ConditionEffects::default, |p, v| {
        let m = p.object(v)?;
        let visibility_range_m =
            p.num_or(m, "visibilityRangeM", Num::POSITIVE.max(10_000.0), 10_000.0);
        let friction_scale = p.num_or(m, "frictionScale", Num::POSITIVE.min(0.1).max(1.2), 1.0);
        let traffic_speed_factor = p.num_or(
            m,
            "trafficSpeedFactor",
            Num::POSITIVE.min(0.1).max(1.5),
            1.0,
        );
        Some(ConditionEffects {
            visibility_range_m: visibility_range_m?,
            friction_scale: friction_scale?,
            traffic_speed_factor: traffic_speed_factor?,
        })
    });
    Some(OperationalConditions {
        weather: weather?,
        time_of_day: time_of_day?,
        traffic: traffic?,
        visibility: visibility?,
        effects: effects?,
    })
}

fn parse_vehicle_profile(p: &mut Parser, v: &Value) -> Option<VehiclePhysicsProfile> {
    let m = p.object(v)?;
    let mut profile = VehiclePhysicsProfile::default();
    let mut ok = true;
    for (index, (key, positive)) in VEHICLE_PROFILE_FIELDS.iter().enumerate() {
        let spec = if *positive {
            Num::POSITIVE
        } else {
            Num::NON_NEG
        };
        match p.num_opt(m, key, spec) {
            Some(value) => *profile.slot_mut(index) = value,
            None => ok = false,
        }
    }
    ok.then_some(profile)
}

fn parse_physics(p: &mut Parser, v: &Value) -> Option<PhysicsConfig> {
    let m = p.object(v)?;
    let mode = p.enum_field::<MotionPhysicsMode>(m, "mode");
    let substep_s = p.num_opt(m, "substepS", Num::POSITIVE.max(0.2));
    let vehicle_profiles = p.opt(m, "vehicleProfiles", |p, v| {
        let m = p.object(v)?;
        let mut out = BTreeMap::new();
        let mut ok = true;
        for (key, value) in m {
            let parsed = p.at(Seg::Owned(key.clone()), |p| {
                if !is_valid_id(key) {
                    p.issue("invalid_format", "id must be a printable reference token");
                    return None;
                }
                parse_vehicle_profile(p, value)
            });
            match parsed {
                Some(profile) => {
                    out.insert(key.clone(), profile);
                }
                None => ok = false,
            }
        }
        ok.then_some(out)
    });
    Some(PhysicsConfig {
        mode: mode?,
        substep_s: substep_s?,
        vehicle_profiles: vehicle_profiles?,
    })
}

/* ------------------------------------------------------------ the document */

fn parse_seed(p: &mut Parser, v: &Value) -> Option<Seed> {
    match v {
        Value::Number(_) => p.number(v, Num::FINITE.int()).map(Seed::Number),
        Value::String(s) => Some(Seed::Text(s.clone())),
        other => {
            p.issue(
                "invalid_union",
                format!("Expected integer or string, received {}", type_name(other)),
            );
            None
        }
    }
}

fn parse_document(p: &mut Parser, v: &Value) -> Option<SimScenarioInput> {
    let m = p.object(v)?;
    let schema_version = p.or(
        m,
        "schemaVersion",
        || SCHEMA_VERSION,
        |p, v| match v {
            Value::Number(n) if n.as_f64() == Some(1.0) => Some(SCHEMA_VERSION),
            other => {
                p.issue(
                    "invalid_literal",
                    format!(
                        "Invalid literal value, expected 1, received {}",
                        type_name(other)
                    ),
                );
                None
            }
        },
    );
    let map_id = p.or(m, "mapId", || "unknown".to_owned(), |p, v| p.text(v));
    let clip_seconds = p.num_or(m, "clipSeconds", Num::POSITIVE, 20.0);
    let warmup_seconds = p.num_or(m, "warmupSeconds", Num::NON_NEG, 5.0);
    let dt = p.num_or(m, "dt", Num::POSITIVE.max(0.2), 0.02);
    let seed = p.or(m, "seed", || Seed::Number(0.0), parse_seed);
    let physics = p.opt(m, "physics", parse_physics);
    let operational_conditions = p.or(
        m,
        "operationalConditions",
        OperationalConditions::default,
        parse_operational_conditions,
    );
    let metric_subject = p.id_opt(m, "metricSubject");
    let actors = p.list_field(m, "actors", 0, usize::MAX, parse_actor);
    let interactions = p.list_or_empty(m, "interactions", usize::MAX, parse_interaction);
    let signal_programs = p.list_or_empty(m, "signalPrograms", usize::MAX, parse_signal_program);
    let road_controls = p.list_or_empty(m, "roadControls", usize::MAX, parse_road_control);
    let surface_patches = p.list_or_empty(m, "surfacePatches", usize::MAX, parse_surface_patch);
    let props = p.list_or_empty(m, "props", usize::MAX, parse_prop);
    let occluders = p.list_or_empty(m, "occluders", usize::MAX, parse_occluder);
    let occlusion_pairs = p.list_or_empty(m, "occlusionPairs", usize::MAX, parse_occlusion_pair);
    let near_miss_criteria = p.opt(m, "nearMissCriteria", |p, v| {
        p.list(v, 0, usize::MAX, parse_near_miss_criterion)
    });
    let perception = p.opt(m, "perception", parse_perception);

    let doc = SimScenarioInput {
        schema_version: schema_version?,
        map_id: map_id?,
        clip_seconds: clip_seconds?,
        warmup_seconds: warmup_seconds?,
        dt: dt?,
        seed: seed?,
        physics: physics?,
        operational_conditions: operational_conditions?,
        metric_subject: metric_subject?,
        actors: actors?,
        interactions: interactions?,
        signal_programs: signal_programs?,
        road_controls: road_controls?,
        surface_patches: surface_patches?,
        props: props?,
        occluders: occluders?,
        occlusion_pairs: occlusion_pairs?,
        near_miss_criteria: near_miss_criteria?,
        perception: perception?,
    };
    if !p.aborted {
        refine_document(p, &doc);
    }
    Some(doc)
}

/// Cross-reference checks over the structurally valid document. Every
/// reference fails loudly: a declaration nothing consumes is worse than none.
fn refine_document(p: &mut Parser, doc: &SimScenarioInput) {
    let mut actor_ids: HashSet<&str> = HashSet::with_capacity(doc.actors.len());
    for a in &doc.actors {
        if !actor_ids.insert(&a.id) {
            p.issue_at(
                &[Seg::Key("actors")],
                "custom",
                format!("duplicate actor id {}", a.id),
            );
        }
    }
    let mut interaction_ids: HashSet<&str> = HashSet::with_capacity(doc.interactions.len());
    for (i, it) in doc.interactions.iter().enumerate() {
        if !interaction_ids.insert(&it.id) {
            p.issue_at(
                &[Seg::Key("interactions"), Seg::Index(i), Seg::Key("id")],
                "custom",
                format!("duplicate interaction id {}", it.id),
            );
        }
        if !actor_ids.contains(it.actor_id.as_str()) {
            p.issue_at(
                &[Seg::Key("interactions"), Seg::Index(i), Seg::Key("actorId")],
                "custom",
                format!("unknown actor {}", it.actor_id),
            );
        }
    }
    for (i, it) in doc.interactions.iter().enumerate() {
        if let Trigger::After { interaction_id, .. } = &it.trigger {
            if !interaction_ids.contains(interaction_id.as_str()) {
                p.issue_at(
                    &[
                        Seg::Key("interactions"),
                        Seg::Index(i),
                        Seg::Key("trigger"),
                        Seg::Key("interactionId"),
                    ],
                    "custom",
                    format!("after() references unknown interaction {interaction_id}"),
                );
            }
        }
    }
    if let Some(subject) = &doc.metric_subject {
        if !actor_ids.contains(subject.as_str()) {
            p.issue_at(&[Seg::Key("metricSubject")], "custom", "unknown actor");
        }
    }
    for (i, c) in doc
        .near_miss_criteria
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .enumerate()
    {
        if !actor_ids.contains(c.pedestrian_id.as_str())
            || !actor_ids.contains(c.target_id.as_str())
        {
            p.issue_at(
                &[Seg::Key("nearMissCriteria"), Seg::Index(i)],
                "custom",
                "near-miss criterion references an unknown actor",
            );
        }
    }
    let mut prop_ids: HashSet<&str> = HashSet::with_capacity(doc.props.len());
    for (i, prop) in doc.props.iter().enumerate() {
        if !prop_ids.insert(&prop.id) {
            p.issue_at(
                &[Seg::Key("props"), Seg::Index(i), Seg::Key("id")],
                "custom",
                format!("duplicate prop id {}", prop.id),
            );
        }
        if actor_ids.contains(prop.id.as_str()) {
            p.issue_at(
                &[Seg::Key("props"), Seg::Index(i), Seg::Key("id")],
                "custom",
                format!("prop id {} collides with an actor id", prop.id),
            );
        }
        if let Some(occludes) = &prop.occludes {
            if !actor_ids.contains(occludes.observer.as_str()) {
                p.issue_at(
                    &[
                        Seg::Key("props"),
                        Seg::Index(i),
                        Seg::Key("occludes"),
                        Seg::Key("observer"),
                    ],
                    "custom",
                    format!("unknown actor {}", occludes.observer),
                );
            }
            if !actor_ids.contains(occludes.target.as_str()) {
                p.issue_at(
                    &[
                        Seg::Key("props"),
                        Seg::Index(i),
                        Seg::Key("occludes"),
                        Seg::Key("target"),
                    ],
                    "custom",
                    format!("unknown actor {}", occludes.target),
                );
            }
        }
        if let Some(attachment) = &prop.attachment {
            if !actor_ids.contains(attachment.actor_id.as_str()) {
                p.issue_at(
                    &[
                        Seg::Key("props"),
                        Seg::Index(i),
                        Seg::Key("attachment"),
                        Seg::Key("actorId"),
                    ],
                    "custom",
                    format!("unknown carrier actor {}", attachment.actor_id),
                );
            }
        }
    }
    for (i, prop) in doc.props.iter().enumerate() {
        if let Some(group_id) = &prop.group_id {
            if prop_ids.contains(group_id.as_str()) {
                p.issue_at(
                    &[Seg::Key("props"), Seg::Index(i), Seg::Key("groupId")],
                    "custom",
                    format!("prop group {group_id} collides with a concrete prop id"),
                );
            }
        }
    }
    let mut occluder_ids: HashSet<&str> = HashSet::with_capacity(doc.occluders.len());
    let mut occluder_group_ids: HashSet<&str> = HashSet::new();
    for (i, o) in doc.occluders.iter().enumerate() {
        if !occluder_ids.insert(&o.id) {
            p.issue_at(
                &[Seg::Key("occluders"), Seg::Index(i), Seg::Key("id")],
                "custom",
                format!("duplicate occluder id {}", o.id),
            );
        }
        if let Some(g) = &o.group_id {
            occluder_group_ids.insert(g);
        }
    }
    for (i, o) in doc.occluders.iter().enumerate() {
        if let Some(group_id) = &o.group_id {
            if occluder_ids.contains(group_id.as_str()) {
                p.issue_at(
                    &[Seg::Key("occluders"), Seg::Index(i), Seg::Key("groupId")],
                    "custom",
                    format!("occluder group {group_id} collides with a concrete occluder id"),
                );
            }
        }
    }
    // Actor occluders are explicit declarations (`actor:<id>`); undeclared
    // traffic is never silently promoted to an occluder.
    for (i, pair) in doc.occlusion_pairs.iter().enumerate() {
        if !actor_ids.contains(pair.observer.as_str()) {
            p.issue_at(
                &[
                    Seg::Key("occlusionPairs"),
                    Seg::Index(i),
                    Seg::Key("observer"),
                ],
                "custom",
                format!("unknown actor {}", pair.observer),
            );
        }
        if !actor_ids.contains(pair.target.as_str()) {
            p.issue_at(
                &[
                    Seg::Key("occlusionPairs"),
                    Seg::Index(i),
                    Seg::Key("target"),
                ],
                "custom",
                format!("unknown actor {}", pair.target),
            );
        }
        if let Some(occluder_id) = &pair.occluder_id {
            let is_actor_ref = occluder_id
                .strip_prefix("actor:")
                .is_some_and(|id| actor_ids.contains(id));
            if !occluder_ids.contains(occluder_id.as_str())
                && !occluder_group_ids.contains(occluder_id.as_str())
                && !is_actor_ref
            {
                p.issue_at(
                    &[
                        Seg::Key("occlusionPairs"),
                        Seg::Index(i),
                        Seg::Key("occluderId"),
                    ],
                    "custom",
                    format!("unknown occluder or occluder group {occluder_id}"),
                );
            }
        }
    }
    // Perception references.
    let mut sensor_ids_by_actor: HashMap<&str, HashSet<&str>> =
        HashMap::with_capacity(doc.actors.len());
    for (i, actor) in doc.actors.iter().enumerate() {
        let mut ids: HashSet<&str> = HashSet::new();
        for (s, sensor) in actor.sensors().iter().enumerate() {
            if !ids.insert(&sensor.id) {
                p.issue_at(
                    &[
                        Seg::Key("actors"),
                        Seg::Index(i),
                        Seg::Key("sensors"),
                        Seg::Index(s),
                        Seg::Key("id"),
                    ],
                    "custom",
                    format!("duplicate sensor id {} on actor {}", sensor.id, actor.id),
                );
            }
        }
        sensor_ids_by_actor.insert(&actor.id, ids);
    }
    for (i, it) in doc.interactions.iter().enumerate() {
        let trigger_path = [
            Seg::Key("interactions"),
            Seg::Index(i),
            Seg::Key("trigger"),
            Seg::Key("condition"),
        ];
        let until_path = [Seg::Key("interactions"), Seg::Index(i), Seg::Key("until")];
        let mut entries: Vec<(&Condition, &[Seg])> = Vec::with_capacity(2);
        if let Trigger::When { condition, .. } = &it.trigger {
            entries.push((condition, &trigger_path));
        }
        if let Some(until) = &it.until {
            entries.push((until, &until_path));
        }
        for (condition, path) in entries {
            for leaf in condition.leaves() {
                let LeafCondition::Detected { a, by, sensor, .. } = leaf else {
                    continue;
                };
                if !actor_ids.contains(a.as_str()) {
                    p.issue_at(
                        path,
                        "custom",
                        format!("detected() references unknown actor {a}"),
                    );
                }
                match sensor_ids_by_actor.get(by.as_str()) {
                    None => p.issue_at(
                        path,
                        "custom",
                        format!("detected() references unknown observer {by}"),
                    ),
                    Some(declared) if declared.is_empty() => {
                        p.issue_at(path, "custom", format!("detected() observer {by} declares no sensors, so it can never detect anything"));
                    }
                    Some(declared) => {
                        if let Some(sensor) = sensor {
                            if !declared.contains(sensor.as_str()) {
                                p.issue_at(path, "custom", format!("detected() references unknown sensor {sensor} on actor {by}"));
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(perception) = &doc.perception {
        let mut divergence_ids: HashSet<&str> =
            HashSet::with_capacity(perception.map_divergences.len());
        for (i, d) in perception.map_divergences.iter().enumerate() {
            if !divergence_ids.insert(&d.id) {
                p.issue_at(
                    &[
                        Seg::Key("perception"),
                        Seg::Key("mapDivergences"),
                        Seg::Index(i),
                        Seg::Key("id"),
                    ],
                    "custom",
                    format!("duplicate map divergence id {}", d.id),
                );
            }
            for (o, observer) in d.observers.iter().enumerate() {
                if !actor_ids.contains(observer.as_str()) {
                    p.issue_at(
                        &[
                            Seg::Key("perception"),
                            Seg::Key("mapDivergences"),
                            Seg::Index(i),
                            Seg::Key("observers"),
                            Seg::Index(o),
                        ],
                        "custom",
                        format!("unknown actor {observer}"),
                    );
                }
            }
        }
    }
    let mut signal_ids: HashSet<&str> = HashSet::with_capacity(doc.signal_programs.len());
    for (i, program) in doc.signal_programs.iter().enumerate() {
        if !signal_ids.insert(&program.id) {
            p.issue_at(
                &[Seg::Key("signalPrograms"), Seg::Index(i), Seg::Key("id")],
                "custom",
                format!("duplicate signal program {}", program.id),
            );
        }
    }
    let mut control_ids: HashSet<&str> = HashSet::with_capacity(doc.road_controls.len());
    for (i, control) in doc.road_controls.iter().enumerate() {
        if !control_ids.insert(&control.id) {
            p.issue_at(
                &[Seg::Key("roadControls"), Seg::Index(i), Seg::Key("id")],
                "custom",
                format!("duplicate road control {}", control.id),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal() -> Value {
        json!({
            "actors": [{
                "id": "ego",
                "kind": "car",
                "initial": { "pose": { "x": 0, "z": 0, "headingRad": 0 }, "speedMps": 10 },
                "behavior": { "route": { "kind": "lanePath", "lanes": ["1:0:-1"] } }
            }]
        })
    }

    #[test]
    fn defaults_materialise_like_zod() {
        let doc = parse_scenario_input_value(&minimal()).unwrap();
        assert_eq!(doc.clip_seconds, 20.0);
        assert_eq!(doc.dt, 0.02);
        assert_eq!(doc.seed, Seed::Number(0.0));
        assert_eq!(doc.actors[0].dims, ActorKind::Car.default_dims());
        assert!(!doc.actors[0].is_static);
        assert_eq!(doc.actors[0].behavior.rules, ActorRules::default());
        assert!(doc.physics.is_none());
        assert_eq!(doc.operational_conditions, OperationalConditions::default());
        let v = serde_json::to_value(&doc).unwrap();
        assert!(v["actors"][0].get("sensors").is_none());
        assert!(v.get("physics").is_none());
        assert_eq!(v["actors"][0]["tags"], json!([]));
        assert_eq!(v["actors"][0]["static"], json!(false));
        assert_eq!(
            v["operationalConditions"]["effects"]["visibilityRangeM"],
            json!(10000.0)
        );
        assert_eq!(v["seed"], json!(0));
    }

    #[test]
    fn collects_every_issue_with_paths() {
        let mut v = minimal();
        v["actors"][0]["initial"]["speedMps"] = json!(-1);
        v["interactions"] = json!([{
            "id": "i1", "actorId": "ghost",
            "trigger": { "kind": "after", "interactionId": "nope" },
            "verb": "exist", "target": { "state": "present" }
        }]);
        let err = parse_scenario_input_value(&v).unwrap_err();
        let paths: Vec<&str> = err.issues.iter().map(|i| i.path.as_str()).collect();
        assert!(paths.contains(&"actors.0.initial.speedMps"), "{paths:?}");
        assert!(paths.contains(&"interactions.0.actorId"), "{paths:?}");
        assert!(
            paths.contains(&"interactions.0.trigger.interactionId"),
            "{paths:?}"
        );
    }

    #[test]
    fn strict_sensor_rejects_unknown_keys_and_applies_modality_defaults() {
        let mut v = minimal();
        v["actors"][0]["sensors"] = json!([
            { "id": "cam", "type": "dash_camera", "mount": { "position": { "x": 1, "y": 1.2, "z": 0 } } },
            { "id": "lidar", "type": "lidar", "mount": { "position": { "x": 0, "y": 2, "z": 0 } }, "detection": {} }
        ]);
        let doc = parse_scenario_input_value(&v).unwrap();
        let sensors = doc.actors[0].sensors();
        assert_eq!(sensors[0].aspect_ratio, Some(1.777778));
        assert_eq!(
            sensors[0].detection,
            DetectionModel::for_sensor(SensorType::DashCamera)
        );
        // A present-but-sparse detection block takes field defaults, not the modality block.
        assert_eq!(sensors[1].detection, DetectionModel::default());
        assert_eq!(sensors[1].aspect_ratio, None);
        v["actors"][0]["sensors"][1]["aspectRatio"] = json!(1.5);
        let err = parse_scenario_input_value(&v).unwrap_err();
        assert_eq!(err.issues[0].code, "unrecognized_keys");
        assert_eq!(err.issues[0].path, "actors.0.sensors.1");
    }

    #[test]
    fn rules_are_strict_and_reject_the_retired_master_yield() {
        let mut v = minimal();
        v["actors"][0]["behavior"]["rules"] = json!({ "yieldToVehicles": false });
        let doc = parse_scenario_input_value(&v).unwrap();
        let rules = doc.actors[0].behavior.rules;
        assert!(!rules.yield_to_vehicles && rules.yield_to_pedestrians);
        v["actors"][0]["behavior"]["rules"] = json!({ "yield": false });
        let err = parse_scenario_input_value(&v).unwrap_err();
        assert_eq!(err.issues[0].code, "unrecognized_keys");
        assert_eq!(err.issues[0].path, "actors.0.behavior.rules");
    }

    #[test]
    fn detected_condition_requires_declared_sensors() {
        let mut v = minimal();
        v["interactions"] = json!([{
            "id": "i1", "actorId": "ego",
            "trigger": { "kind": "when", "byLatest": 5, "ifNever": "skip",
                "condition": { "kind": "not", "of": { "kind": "detected", "a": "ego", "by": "ego", "value": true } } },
            "verb": "speed", "target": { "mode": "stop" },
            "dynamics": { "shape": "linear", "constraint": "rate", "value": 3 }
        }]);
        let err = parse_scenario_input_value(&v).unwrap_err();
        assert!(err
            .issues
            .iter()
            .any(|i| i.path == "interactions.0.trigger.condition"
                && i.message.contains("declares no sensors")));
    }

    #[test]
    fn interaction_round_trips_verb_flattened() {
        let mut v = minimal();
        v["interactions"] = json!([{
            "id": "i1", "actorId": "ego",
            "trigger": { "kind": "at", "t": 1 },
            "verb": "set", "target": { "key": "signal:j1.phase", "value": "red" }
        }]);
        let doc = parse_scenario_input_value(&v).unwrap();
        let Verb::Set { target } = &doc.interactions[0].verb else {
            panic!()
        };
        assert_eq!(target.key, SetKey::SignalPhase("j1".into()));
        let out = serde_json::to_value(&doc.interactions[0]).unwrap();
        assert_eq!(out["verb"], json!("set"));
        assert_eq!(out["target"]["key"], json!("signal:j1.phase"));
        assert!(out.get("window").is_none());
    }

    #[test]
    fn normalized_hash_is_order_independent() {
        let mut v = minimal();
        v["actors"].as_array_mut().unwrap().push(json!({
            "id": "alpha", "kind": "pedestrian",
            "initial": { "pose": { "x": 1, "z": 2, "headingRad": 0.5 }, "speedMps": 1.2 },
            "behavior": { "route": { "kind": "polyline", "points": [{ "x": 1, "z": 2 }] } }
        }));
        let a = parse_scenario_input_value(&v).unwrap().normalized();
        v["actors"].as_array_mut().unwrap().reverse();
        let b = parse_scenario_input_value(&v).unwrap().normalized();
        assert_eq!(a.actors[0].id, "alpha");
        assert_eq!(a.content_hash().unwrap(), b.content_hash().unwrap());
    }

    #[test]
    fn set_key_registry() {
        assert_eq!(
            SetKey::parse("rules.aggression"),
            Some(SetKey::Rule(RuleKey::Aggression))
        );
        assert_eq!(
            SetKey::parse("motion.gear")
                .map(|k| k.to_string())
                .as_deref(),
            Some("motion.gear")
        );
        assert_eq!(
            SetKey::parse("control:x/1.indication"),
            Some(SetKey::ControlIndication("x/1".into()))
        );
        assert_eq!(SetKey::parse("rules.nope"), None);
        assert_eq!(SetKey::parse("rules.yield"), None);
        assert_eq!(SetKey::parse("motion."), None);
        assert_eq!(SetKey::parse("signal:.phase"), None);
    }
}
