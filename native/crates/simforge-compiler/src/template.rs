//! `ScenarioTemplate` v2 — the authored, portable, map-free document, typed.
//!
//! Serde wire names are the current camelCase authoring contract. Objects are
//! strict (`deny_unknown_fields`) so a typo is a load error rather than silent
//! data loss; the only untyped bags are the `extensions` fields. Discriminated
//! unions that share a base (`roles`, `interactions`, anchor `features`,
//! `invariants`) are decoded by splitting the object into its base keys and
//! its kind-specific keys so both halves stay strict.
//!
//! Every numeric field an author may parameterise is a [`NumberOrExpr`].

use std::collections::{BTreeMap, BTreeSet};

use serde::de::{self, DeserializeOwned, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{CompileError, CompileResult};
use crate::expr::{ExprField, NumberOrExpr};

pub const SCENARIO_TEMPLATE_VERSION: u32 = 2;
/// The one reserved actor reference: the world itself, for `env.*` / signal sets.
pub const WORLD_ROLE_REF: &str = "@world";

pub type Extensions = Map<String, Value>;

/* ------------------------------------------------------------------ ids */

fn is_v2_id(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    s.len() <= 64 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_entity_id(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    s.len() <= 64 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_control_id(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    !s.is_empty()
        && s.len() <= 128
        && chars
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '@' | '/' | '-'))
}

/* --------------------------------------------------------------- ranges */

/// An inclusive `[min, max]` with open ends allowed. Never `[null, null]`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Range(pub Option<f64>, pub Option<f64>);

impl Range {
    pub fn contains(&self, value: f64) -> bool {
        if let Some(min) = self.0 {
            if value < min {
                return false;
            }
        }
        if let Some(max) = self.1 {
            if value > max {
                return false;
            }
        }
        true
    }

    pub fn closed(min: f64, max: f64) -> Self {
        Self(Some(min), Some(max))
    }
}

impl<'de> Deserialize<'de> for Range {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (min, max): (Option<f64>, Option<f64>) = Deserialize::deserialize(deserializer)?;
        if let (Some(lo), Some(hi)) = (min, max) {
            if lo > hi {
                return Err(de::Error::custom(format!(
                    "range [{lo}, {hi}] is empty: min exceeds max"
                )));
            }
        }
        if min.is_none() && max.is_none() {
            return Err(de::Error::custom(
                "range [null, null] constrains nothing; drop the clause instead",
            ));
        }
        Ok(Self(min, max))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Essentiality {
    Required,
    Preferred,
    Cosmetic,
}

impl Essentiality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::Preferred => "preferred",
            Self::Cosmetic => "cosmetic",
        }
    }
}

fn default_required() -> Essentiality {
    Essentiality::Required
}

fn default_preferred() -> Essentiality {
    Essentiality::Preferred
}

/// `{value, essentiality, weight?}` — the universal clause envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Clause<T> {
    pub value: T,
    #[serde(default = "default_required")]
    pub essentiality: Essentiality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

/* ------------------------------------------------------------- meta / map */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateMeta {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub created_at: String,
    pub modified_at: String,
    pub app_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archetype: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default)]
    pub negative_control: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapRef {
    pub map_id: String,
    pub map_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xodr_sha256: Option<String>,
}

/* -------------------------------------------------------------- expressions */

/// `tFrac` may be a literal in `[-1, 1]` or an expression.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum TFrac {
    Number(f64),
    Expr(ExprField),
}

impl Default for TFrac {
    fn default() -> Self {
        Self::Number(0.0)
    }
}

impl TFrac {
    pub fn to_number_or_expr(&self) -> NumberOrExpr {
        match self {
            Self::Number(v) => NumberOrExpr::Number(*v),
            Self::Expr(e) => NumberOrExpr::Expr(e.0.clone()),
        }
    }
}

impl<'de> Deserialize<'de> for TFrac {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        match crate::expr::number_or_expr_from_value(&value).map_err(de::Error::custom)? {
            NumberOrExpr::Number(v) => {
                if !(-1.0..=1.0).contains(&v) {
                    return Err(de::Error::custom("tFrac must be within [-1, 1]"));
                }
                Ok(Self::Number(v))
            }
            NumberOrExpr::Expr(e) => Ok(Self::Expr(ExprField(e))),
        }
    }
}

/* ---------------------------------------------------------------- params */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Distribution {
    #[default]
    Uniform,
    Halton,
    Lhs,
    Normal,
}

fn default_tier() -> u8 {
    2
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParamBase {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default = "default_tier")]
    pub tier: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum ParamKind {
    #[serde(rename_all = "camelCase")]
    Continuous {
        range: Range,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<f64>,
        #[serde(default)]
        distribution: Distribution,
    },
    #[serde(rename_all = "camelCase")]
    Discrete {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        values: Option<Vec<f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        range: Option<Range>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Categorical {
        values: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
    Derived {
        expr: ExprField,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParamDecl {
    #[serde(flatten)]
    pub base: ParamBase,
    #[serde(flatten)]
    pub kind: ParamKind,
}

const PARAM_BASE_KEYS: &[&str] = &["id", "description", "unit", "tier"];

impl<'de> Deserialize<'de> for ParamDecl {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (base, kind): (ParamBase, ParamKind) =
            split_object(Value::deserialize(deserializer)?, PARAM_BASE_KEYS)
                .map_err(de::Error::custom)?;
        validate_param(&base, &kind).map_err(de::Error::custom)?;
        Ok(Self { base, kind })
    }
}

fn validate_param(base: &ParamBase, kind: &ParamKind) -> Result<(), String> {
    if !is_v2_id(&base.id) {
        return Err(format!(
            "param id \"{}\" must start with a letter and use only [A-Za-z0-9_-], max 64 chars",
            base.id
        ));
    }
    if !(1..=3).contains(&base.tier) {
        return Err("tier must be 1, 2 or 3".to_owned());
    }
    match kind {
        ParamKind::Continuous { range, .. } => {
            if range.0.is_none() || range.1.is_none() {
                return Err("a continuous parameter needs both ends of its range; sampling an open range is undefined".to_owned());
            }
        }
        ParamKind::Discrete {
            values,
            range,
            step,
            ..
        } => {
            let has_values = values.is_some();
            let has_walk = range.is_some() || step.is_some();
            if has_values == has_walk {
                return Err(
                    "a discrete parameter needs exactly one of `values` or (`range` + `step`)"
                        .to_owned(),
                );
            }
            if let Some(v) = values {
                if v.is_empty() {
                    return Err("discrete `values` must not be empty".to_owned());
                }
            }
            if has_walk && (range.is_none() || step.is_none()) {
                return Err("`range` and `step` must be given together".to_owned());
            }
            if let Some(r) = range {
                if r.0.is_none() || r.1.is_none() {
                    return Err("a walked discrete range must be closed at both ends".to_owned());
                }
            }
            if let Some(s) = step {
                if *s <= 0.0 {
                    return Err("step must be positive".to_owned());
                }
            }
        }
        ParamKind::Categorical { values, default } => {
            if values.is_empty() {
                return Err("categorical values must not be empty".to_owned());
            }
            if let Some(d) = default {
                if !values.contains(d) {
                    return Err(format!("default \"{d}\" is not one of the declared values"));
                }
            }
            let unique: BTreeSet<&String> = values.iter().collect();
            if unique.len() != values.len() {
                return Err("categorical values must be unique".to_owned());
            }
        }
        ParamKind::Derived { .. } => {}
    }
    Ok(())
}

impl ParamDecl {
    pub fn id(&self) -> &str {
        &self.base.id
    }

    pub fn is_derived(&self) -> bool {
        matches!(self.kind, ParamKind::Derived { .. })
    }

    /// The value a parameter takes when nothing has sampled it yet.
    pub fn default_value(&self) -> Option<f64> {
        match &self.kind {
            ParamKind::Continuous { range, default, .. } => {
                default.or_else(|| match (range.0, range.1) {
                    (Some(lo), Some(hi)) => Some((lo + hi) / 2.0),
                    _ => None,
                })
            }
            ParamKind::Discrete {
                values,
                range,
                default,
                ..
            } => default
                .or_else(|| values.as_ref().and_then(|v| v.first().copied()))
                .or_else(|| range.and_then(|r| r.0)),
            ParamKind::Categorical { .. } | ParamKind::Derived { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RelationOp {
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "<=")]
    Lte,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = ">=")]
    Gte,
    #[serde(rename = "==")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
}

impl RelationOp {
    pub fn compare(self, left: f64, right: f64) -> bool {
        match self {
            Self::Lt => left < right,
            Self::Lte => left <= right,
            Self::Gt => left > right,
            Self::Gte => left >= right,
            Self::Eq => left == right,
            Self::Ne => left != right,
        }
    }

    pub fn symbol(self) -> &'static str {
        match self {
            Self::Lt => "<",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::Eq => "==",
            Self::Ne => "!=",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParamConstraint {
    pub left: NumberOrExpr,
    pub op: RelationOp,
    pub right: NumberOrExpr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParamsBlock {
    #[serde(default)]
    pub declarations: Vec<ParamDecl>,
    #[serde(default)]
    pub constraints: Vec<ParamConstraint>,
}

/* ----------------------------------------------------------- environment */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Weather {
    Clear,
    #[default]
    Cloudy,
    Overcast,
    LightRain,
    HeavyRain,
    WetRoad,
    FogLight,
    FogDense,
    Snow,
    Sleet,
}

impl Weather {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clear => "clear",
            Self::Cloudy => "cloudy",
            Self::Overcast => "overcast",
            Self::LightRain => "light_rain",
            Self::HeavyRain => "heavy_rain",
            Self::WetRoad => "wet_road",
            Self::FogLight => "fog_light",
            Self::FogDense => "fog_dense",
            Self::Snow => "snow",
            Self::Sleet => "sleet",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TimeOfDay {
    Dawn,
    Morning,
    Noon,
    Afternoon,
    #[default]
    Dusk,
    Night,
    NightLit,
}

impl TimeOfDay {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dawn => "dawn",
            Self::Morning => "morning",
            Self::Noon => "noon",
            Self::Afternoon => "afternoon",
            Self::Dusk => "dusk",
            Self::Night => "night",
            Self::NightLit => "night_lit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfacePatchKind {
    Ice,
    PackedSnow,
    StandingWater,
    WetLeaves,
    LooseGravel,
    Sand,
    SpilledOil,
    PolishedAsphalt,
    GritTreated,
}

impl SurfacePatchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ice => "ice",
            Self::PackedSnow => "packed_snow",
            Self::StandingWater => "standing_water",
            Self::WetLeaves => "wet_leaves",
            Self::LooseGravel => "loose_gravel",
            Self::Sand => "sand",
            Self::SpilledOil => "spilled_oil",
            Self::PolishedAsphalt => "polished_asphalt",
            Self::GritTreated => "grit_treated",
        }
    }
}

fn default_zero_expr() -> NumberOrExpr {
    NumberOrExpr::Number(0.0)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfacePatch {
    pub id: String,
    pub kind: SurfacePatchKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub at_m: NumberOrExpr,
    pub length_m: NumberOrExpr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
    #[serde(default)]
    pub lane_offsets: Vec<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friction_scale: Option<NumberOrExpr>,
    #[serde(default = "default_zero_expr")]
    pub edge_taper_m: NumberOrExpr,
    #[serde(default = "default_required")]
    pub essentiality: Essentiality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Extensions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    #[serde(default)]
    pub weather: Weather,
    #[serde(default)]
    pub time_of_day: TimeOfDay,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friction_scale: Option<NumberOrExpr>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sun_azimuth_deg: Option<NumberOrExpr>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sun_elevation_deg: Option<NumberOrExpr>,
    #[serde(default)]
    pub surface_patches: Vec<SurfacePatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Extensions>,
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            weather: Weather::Cloudy,
            time_of_day: TimeOfDay::Dusk,
            friction_scale: None,
            sun_azimuth_deg: None,
            sun_elevation_deg: None,
            surface_patches: Vec::new(),
            extensions: None,
        }
    }
}

/* ---------------------------------------------------------------- anchor */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdjacentKind {
    Parking,
    Bike,
    Sidewalk,
    Shoulder,
    Median,
    Bus,
    Rail,
    None,
}

impl AdjacentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parking => "parking",
            Self::Bike => "bike",
            Self::Sidewalk => "sidewalk",
            Self::Shoulder => "shoulder",
            Self::Median => "median",
            Self::Bus => "bus",
            Self::Rail => "rail",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
    Either,
    Both,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Either => "either",
            Self::Both => "both",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnDirection {
    Left,
    Right,
    Straight,
    Uturn,
}

impl TurnDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Straight => "straight",
            Self::Uturn => "uturn",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "left" | "Left" => Some(Self::Left),
            "right" | "Right" => Some(Self::Right),
            "straight" | "Straight" => Some(Self::Straight),
            "uturn" | "UTurnLeft" | "UTurnRight" => Some(Self::Uturn),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApproachRelation {
    Opposing,
    FromLeft,
    FromRight,
    Same,
    Merge,
}

impl ApproachRelation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Opposing => "opposing",
            Self::FromLeft => "from_left",
            Self::FromRight => "from_right",
            Self::Same => "same",
            Self::Merge => "merge",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JunctionControl {
    Signalized,
    AllWayStop,
    MinorStop,
    Yield,
    Uncontrolled,
    Roundabout,
}

impl JunctionControl {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Signalized => "signalized",
            Self::AllWayStop => "all_way_stop",
            Self::MinorStop => "minor_stop",
            Self::Yield => "yield",
            Self::Uncontrolled => "uncontrolled",
            Self::Roundabout => "roundabout",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "signalized" => Some(Self::Signalized),
            "all_way_stop" => Some(Self::AllWayStop),
            "minor_stop" => Some(Self::MinorStop),
            "yield" => Some(Self::Yield),
            "uncontrolled" => Some(Self::Uncontrolled),
            "roundabout" => Some(Self::Roundabout),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaneChangeLegal {
    pub side: Side,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s_range: Option<Range>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Corridor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub through_lanes_same_dir: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub through_lanes_opposing: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_width_m: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_limit_kph: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runway_upstream_m: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runway_downstream_m: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curvature_deg_per10m: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grade_pct: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_adjacent: Option<Clause<Vec<AdjacentKind>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forbids_adjacent: Option<Clause<Vec<AdjacentKind>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_change_legal: Option<Clause<LaneChangeLegal>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConflictingApproach {
    pub from: ApproachRelation,
    pub turn: TurnDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crossing_angle_deg: Option<Range>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrossingPlacement {
    JunctionLeg,
    Midblock,
    Either,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParkingOrientation {
    Parallel,
    Angled,
    Perpendicular,
}

impl ParkingOrientation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parallel => "parallel",
            Self::Angled => "angled",
            Self::Perpendicular => "perpendicular",
        }
    }
}

/// Kinds with no predicates of their own beyond position and side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimpleFeatureKind {
    Merge,
    Diverge,
    LaneDrop,
    Driveway,
    BusStop,
    SchoolZone,
    WorkZoneSuitable,
    OcclusionZone,
    Crest,
    Curve,
    RailCrossing,
}

impl SimpleFeatureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Diverge => "diverge",
            Self::LaneDrop => "lane_drop",
            Self::Driveway => "driveway",
            Self::BusStop => "bus_stop",
            Self::SchoolZone => "school_zone",
            Self::WorkZoneSuitable => "work_zone_suitable",
            Self::OcclusionZone => "occlusion_zone",
            Self::Crest => "crest",
            Self::Curve => "curve",
            Self::RailCrossing => "rail_crossing",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureBase {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_m: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lateral_distance_m: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_road: Option<Clause<bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<Clause<Side>>,
    #[serde(default = "default_required")]
    pub essentiality: Essentiality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FeatureKind {
    #[serde(rename_all = "camelCase")]
    Junction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arms: Option<Clause<Range>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        control: Option<Clause<Vec<JunctionControl>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ego_turn: Option<Clause<Vec<TurnDirection>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conflicting_approach: Option<Clause<ConflictingApproach>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size_m: Option<Clause<Range>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        has_crossing_on_leg: Option<Clause<bool>>,
    },
    #[serde(rename_all = "camelCase")]
    Crossing {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marked: Option<Clause<bool>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        controlled: Option<Clause<bool>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        length_m: Option<Clause<Range>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placement: Option<Clause<CrossingPlacement>>,
    },
    #[serde(rename_all = "camelCase")]
    ParkingZone {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        orientation: Option<Clause<ParkingOrientation>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capacity: Option<Clause<Range>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        occupancy: Option<Clause<Range>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        length_m: Option<Clause<Range>>,
    },
    #[serde(other)]
    Simple,
}

/// Any anchor feature. Simple kinds keep their concrete kind in `simple_kind`.
#[derive(Debug, Clone, PartialEq)]
pub struct AnchorFeature {
    pub base: FeatureBase,
    pub kind: FeatureKind,
    /// Set exactly when `kind` is [`FeatureKind::Simple`].
    pub simple_kind: Option<SimpleFeatureKind>,
    /// `lengthM` clause of a simple feature.
    pub length_m: Option<Clause<Range>>,
    /// `supportsScenario` clause of a simple feature.
    pub supports_scenario: Option<Clause<Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SimpleFeatureFields {
    kind: SimpleFeatureKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    length_m: Option<Clause<Range>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supports_scenario: Option<Clause<Vec<String>>>,
}

const FEATURE_BASE_KEYS: &[&str] = &[
    "id",
    "atM",
    "lateralDistanceM",
    "sameRoad",
    "side",
    "essentiality",
    "weight",
    "label",
];

impl AnchorFeature {
    pub fn id(&self) -> &str {
        &self.base.id
    }

    /// The kind name as authored (`junction`, `crossing`, `parking_zone`, or a simple kind).
    pub fn kind_name(&self) -> &'static str {
        match (&self.kind, self.simple_kind) {
            (FeatureKind::Junction { .. }, _) => "junction",
            (FeatureKind::Crossing { .. }, _) => "crossing",
            (FeatureKind::ParkingZone { .. }, _) => "parking_zone",
            (FeatureKind::Simple, Some(k)) => k.as_str(),
            (FeatureKind::Simple, None) => "unknown",
        }
    }
}

impl Serialize for AnchorFeature {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = match serde_json::to_value(&self.base) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        let kind_value = match (&self.kind, self.simple_kind) {
            (FeatureKind::Simple, Some(k)) => serde_json::to_value(SimpleFeatureFields {
                kind: k,
                length_m: self.length_m.clone(),
                supports_scenario: self.supports_scenario.clone(),
            }),
            _ => serde_json::to_value(&self.kind),
        };
        if let Ok(Value::Object(m)) = kind_value {
            out.extend(m);
        }
        Value::Object(out).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for AnchorFeature {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let kind_name = value
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| de::Error::custom("feature needs a kind"))?
            .to_owned();
        let (base, rest): (FeatureBase, Value) =
            split_object_raw(value, FEATURE_BASE_KEYS).map_err(de::Error::custom)?;
        if !is_v2_id(&base.id) {
            return Err(de::Error::custom(format!("feature id \"{}\" must start with a letter and use only [A-Za-z0-9_-], max 64 chars", base.id)));
        }
        match kind_name.as_str() {
            "junction" | "crossing" | "parking_zone" => {
                let kind: FeatureKind = serde_json::from_value(rest).map_err(de::Error::custom)?;
                Ok(Self {
                    base,
                    kind,
                    simple_kind: None,
                    length_m: None,
                    supports_scenario: None,
                })
            }
            _ => {
                let simple: SimpleFeatureFields =
                    serde_json::from_value(rest).map_err(de::Error::custom)?;
                Ok(Self {
                    base,
                    kind: FeatureKind::Simple,
                    simple_kind: Some(simple.kind),
                    length_m: simple.length_m,
                    supports_scenario: simple.supports_scenario,
                })
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Diversity {
    #[default]
    Strict,
    Moderate,
    Off,
}

fn default_max_sites() -> u32 {
    10
}

fn default_min_score() -> f64 {
    0.5
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorPolicy {
    #[serde(default)]
    pub allow_mirror: bool,
    #[serde(default = "default_max_sites")]
    pub max_sites_per_map: u32,
    #[serde(default)]
    pub diversity: Diversity,
    #[serde(default = "default_min_score")]
    pub min_score: f64,
}

impl Default for AnchorPolicy {
    fn default() -> Self {
        Self {
            allow_mirror: false,
            max_sites_per_map: 10,
            diversity: Diversity::Strict,
            min_score: 0.5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorPin {
    pub map_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topology_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicalAnchor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corridor: Option<Corridor>,
    #[serde(default)]
    pub features: Vec<AnchorFeature>,
    #[serde(default)]
    pub policy: AnchorPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<AnchorPin>,
}

impl LogicalAnchor {
    pub fn feature(&self, id: &str) -> Option<&AnchorFeature> {
        self.features.iter().find(|f| f.base.id == id)
    }
}

/* ----------------------------------------------------------------- roles */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorClass {
    Car,
    Truck,
    Bus,
    Van,
    Motorcycle,
    Bicycle,
    Pedestrian,
    Scooter,
    SidewalkRobot,
    Drone,
    Animal,
    StaticObject,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClassDims {
    pub length: f64,
    pub width: f64,
    pub height: f64,
}

impl ActorClass {
    pub const ALL: [ActorClass; 12] = [
        Self::Car,
        Self::Truck,
        Self::Bus,
        Self::Van,
        Self::Motorcycle,
        Self::Bicycle,
        Self::Pedestrian,
        Self::Scooter,
        Self::SidewalkRobot,
        Self::Drone,
        Self::Animal,
        Self::StaticObject,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Car => "car",
            Self::Truck => "truck",
            Self::Bus => "bus",
            Self::Van => "van",
            Self::Motorcycle => "motorcycle",
            Self::Bicycle => "bicycle",
            Self::Pedestrian => "pedestrian",
            Self::Scooter => "scooter",
            Self::SidewalkRobot => "sidewalk_robot",
            Self::Drone => "drone",
            Self::Animal => "animal",
            Self::StaticObject => "static_object",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|c| c.as_str() == s)
    }

    /// Nominal footprints, metres: deliberately generous rather than average.
    pub fn default_dims(self) -> ClassDims {
        let (length, width, height) = match self {
            Self::Car => (4.8, 1.9, 1.5),
            Self::Truck => (9.5, 2.5, 3.5),
            Self::Bus => (12.0, 2.55, 3.2),
            Self::Van => (5.5, 2.0, 2.2),
            Self::Motorcycle => (2.2, 0.8, 1.5),
            Self::Bicycle => (1.8, 0.6, 1.7),
            Self::Pedestrian => (0.6, 0.6, 1.75),
            Self::Scooter => (1.2, 0.6, 1.7),
            Self::SidewalkRobot => (0.85, 0.6, 0.85),
            Self::Drone => (1.0, 1.0, 0.45),
            Self::Animal => (1.2, 0.5, 1.0),
            Self::StaticObject => (1.0, 1.0, 1.0),
        };
        ClassDims {
            length,
            width,
            height,
        }
    }

    /// Classes legal on a pedestrian-only surface.
    pub fn is_vru(self) -> bool {
        matches!(
            self,
            Self::Pedestrian
                | Self::Bicycle
                | Self::Scooter
                | Self::SidewalkRobot
                | Self::Drone
                | Self::Animal
        )
    }

    pub fn is_pedestrian_like(self) -> bool {
        matches!(
            self,
            Self::Pedestrian | Self::SidewalkRobot | Self::Drone | Self::Animal
        )
    }

    pub fn supports_driver_profile(self) -> bool {
        !matches!(
            self,
            Self::Pedestrian
                | Self::SidewalkRobot
                | Self::Drone
                | Self::Animal
                | Self::StaticObject
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dimensions {
    pub length: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DriverProfile {
    #[default]
    Lawful,
    Cautious,
    Assertive,
    Violator,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DriverProfileRules {
    pub obey_signals: bool,
    pub yield_to_vehicles: bool,
    pub yield_to_pedestrians: bool,
    pub collision_avoidance: bool,
    pub aggression: f64,
    pub speed_factor: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DriverProfileDefinition {
    pub id: DriverProfile,
    pub comfortable_lateral_acceleration_mps2: f64,
    pub comfortable_deceleration_mps2: f64,
    pub rules: DriverProfileRules,
}

impl DriverProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lawful => "lawful",
            Self::Cautious => "cautious",
            Self::Assertive => "assertive",
            Self::Violator => "violator",
        }
    }

    pub fn definition(self) -> DriverProfileDefinition {
        let lawful_rules = DriverProfileRules {
            obey_signals: true,
            yield_to_vehicles: true,
            yield_to_pedestrians: true,
            collision_avoidance: true,
            aggression: 0.5,
            speed_factor: 1.0,
        };
        match self {
            Self::Lawful => DriverProfileDefinition {
                id: self,
                comfortable_lateral_acceleration_mps2: 2.2,
                comfortable_deceleration_mps2: 2.5,
                rules: lawful_rules,
            },
            Self::Cautious => DriverProfileDefinition {
                id: self,
                comfortable_lateral_acceleration_mps2: 1.4,
                comfortable_deceleration_mps2: 1.8,
                rules: DriverProfileRules {
                    aggression: 0.2,
                    speed_factor: 0.9,
                    ..lawful_rules
                },
            },
            Self::Assertive => DriverProfileDefinition {
                id: self,
                comfortable_lateral_acceleration_mps2: 3.2,
                comfortable_deceleration_mps2: 3.2,
                rules: DriverProfileRules {
                    aggression: 0.8,
                    speed_factor: 1.05,
                    ..lawful_rules
                },
            },
            Self::Violator => DriverProfileDefinition {
                id: self,
                comfortable_lateral_acceleration_mps2: 2.2,
                comfortable_deceleration_mps2: 2.5,
                rules: DriverProfileRules {
                    obey_signals: false,
                    yield_to_vehicles: false,
                    yield_to_pedestrians: false,
                    collision_avoidance: true,
                    aggression: 0.85,
                    speed_factor: 1.1,
                },
            },
        }
    }
}

/* --------------------------------------------------------------- sensors */

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SensorRotation {
    #[serde(default)]
    pub yaw_rad: f64,
    #[serde(default)]
    pub pitch_rad: f64,
    #[serde(default)]
    pub roll_rad: f64,
}

/// Rigid mount in actor-local metres: +X forward, +Y up and +Z left.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SensorMount {
    pub position: Vec3,
    #[serde(default)]
    pub rotation: SensorRotation,
}

fn default_hfov_cam() -> f64 {
    90.0
}
fn default_vfov_cam() -> f64 {
    60.0
}
fn default_near_cam() -> f64 {
    0.05
}
fn default_far_cam() -> f64 {
    1000.0
}
fn default_aspect() -> f64 {
    1.777778
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashCameraIntrinsics {
    #[serde(default = "default_hfov_cam")]
    pub horizontal_fov_deg: f64,
    #[serde(default = "default_vfov_cam")]
    pub vertical_fov_deg: f64,
    #[serde(default = "default_near_cam")]
    pub near_m: f64,
    #[serde(default = "default_far_cam")]
    pub far_m: f64,
    #[serde(default = "default_aspect")]
    pub aspect_ratio: f64,
}

impl Default for DashCameraIntrinsics {
    fn default() -> Self {
        Self {
            horizontal_fov_deg: 90.0,
            vertical_fov_deg: 60.0,
            near_m: 0.05,
            far_m: 1000.0,
            aspect_ratio: 1.777778,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SensorSensitivity {
    #[serde(default = "one")]
    pub atmosphere: f64,
    #[serde(default = "one")]
    pub illumination: f64,
    #[serde(default = "one")]
    pub glare: f64,
}

fn one() -> f64 {
    1.0
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

fn default_contrast() -> f64 {
    0.02
}
fn default_angular() -> f64 {
    0.0045
}
fn default_illum() -> f64 {
    0.02
}
fn default_detect_conf() -> f64 {
    0.5
}
fn default_degraded_conf() -> f64 {
    0.2
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetectionModel {
    #[serde(default = "default_contrast")]
    pub contrast_threshold: f64,
    #[serde(default = "default_angular")]
    pub min_angular_size_rad: f64,
    #[serde(default = "default_illum")]
    pub min_illumination_frac: f64,
    #[serde(default = "default_detect_conf")]
    pub detect_confidence: f64,
    #[serde(default = "default_degraded_conf")]
    pub degraded_confidence: f64,
    #[serde(default)]
    pub sensitivity: SensorSensitivity,
    #[serde(default)]
    pub latch_s: f64,
}

impl Default for DetectionModel {
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
    pub fn lidar_default() -> Self {
        Self {
            min_angular_size_rad: 0.002,
            min_illumination_frac: 0.000001,
            sensitivity: SensorSensitivity {
                atmosphere: 1.6,
                illumination: 0.0,
                glare: 0.15,
            },
            ..Self::default()
        }
    }

    pub fn radar_default() -> Self {
        Self {
            min_angular_size_rad: 0.02,
            min_illumination_frac: 0.000001,
            sensitivity: SensorSensitivity {
                atmosphere: 0.05,
                illumination: 0.0,
                glare: 0.0,
            },
            ..Self::default()
        }
    }
}

fn default_hfov_active() -> f64 {
    120.0
}
fn default_vfov_active() -> f64 {
    40.0
}
fn default_near_active() -> f64 {
    0.5
}
fn default_far_active() -> f64 {
    200.0
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveSensorField {
    #[serde(default = "default_hfov_active")]
    pub horizontal_fov_deg: f64,
    #[serde(default = "default_vfov_active")]
    pub vertical_fov_deg: f64,
    #[serde(default = "default_near_active")]
    pub near_m: f64,
    #[serde(default = "default_far_active")]
    pub far_m: f64,
}

impl Default for ActiveSensorField {
    fn default() -> Self {
        Self {
            horizontal_fov_deg: 120.0,
            vertical_fov_deg: 40.0,
            near_m: 0.5,
            far_m: 200.0,
        }
    }
}

impl ActiveSensorField {
    pub fn radar_default() -> Self {
        Self {
            horizontal_fov_deg: 40.0,
            vertical_fov_deg: 20.0,
            ..Self::default()
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensorType {
    DashCamera,
    Lidar,
    Radar,
}

impl SensorType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DashCamera => "dash_camera",
            Self::Lidar => "lidar",
            Self::Radar => "radar",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SensorWire {
    id: String,
    #[serde(rename = "type")]
    sensor_type: SensorType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(default = "default_true")]
    enabled: bool,
    mount: SensorMount,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    camera: Option<DashCameraIntrinsics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    field: Option<ActiveSensorField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detection: Option<DetectionModel>,
}

/// A sensor rigidly mounted to an actor.
#[derive(Debug, Clone, PartialEq)]
pub struct ActorSensor {
    pub id: String,
    pub sensor_type: SensorType,
    pub label: Option<String>,
    pub enabled: bool,
    pub mount: SensorMount,
    /// Present exactly for `dash_camera`.
    pub camera: Option<DashCameraIntrinsics>,
    /// Present exactly for `lidar` / `radar`.
    pub field: Option<ActiveSensorField>,
    pub detection: DetectionModel,
}

impl ActorSensor {
    /// The angular/range envelope, whatever the modality names the block.
    pub fn aperture(&self) -> ActiveSensorField {
        match (self.camera, self.field) {
            (Some(c), _) => ActiveSensorField {
                horizontal_fov_deg: c.horizontal_fov_deg,
                vertical_fov_deg: c.vertical_fov_deg,
                near_m: c.near_m,
                far_m: c.far_m,
            },
            (None, Some(f)) => f,
            (None, None) => ActiveSensorField::default(),
        }
    }
}

impl Serialize for ActorSensor {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        SensorWire {
            id: self.id.clone(),
            sensor_type: self.sensor_type,
            label: self.label.clone(),
            enabled: self.enabled,
            mount: self.mount,
            camera: self.camera,
            field: self.field,
            detection: Some(self.detection),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ActorSensor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = SensorWire::deserialize(deserializer)?;
        if !is_entity_id(&wire.id) {
            return Err(de::Error::custom(format!(
                "sensor id \"{}\" must be a URL-safe id of 1-64 chars",
                wire.id
            )));
        }
        let (camera, field, detection) = match wire.sensor_type {
            SensorType::DashCamera => {
                if wire.field.is_some() {
                    return Err(de::Error::custom(
                        "dash_camera sensors declare `camera`, not `field`",
                    ));
                }
                (
                    Some(wire.camera.unwrap_or_default()),
                    None,
                    wire.detection.unwrap_or_default(),
                )
            }
            SensorType::Lidar => {
                if wire.camera.is_some() {
                    return Err(de::Error::custom(
                        "lidar sensors declare `field`, not `camera`",
                    ));
                }
                (
                    None,
                    Some(wire.field.unwrap_or_default()),
                    wire.detection.unwrap_or_else(DetectionModel::lidar_default),
                )
            }
            SensorType::Radar => {
                if wire.camera.is_some() {
                    return Err(de::Error::custom(
                        "radar sensors declare `field`, not `camera`",
                    ));
                }
                (
                    None,
                    Some(wire.field.unwrap_or_else(ActiveSensorField::radar_default)),
                    wire.detection.unwrap_or_else(DetectionModel::radar_default),
                )
            }
        };
        if let Some(c) = camera {
            if c.far_m <= c.near_m {
                return Err(de::Error::custom("farM must be greater than nearM"));
            }
        }
        if let Some(f) = field {
            if f.far_m <= f.near_m {
                return Err(de::Error::custom("farM must be greater than nearM"));
            }
        }
        if detection.degraded_confidence >= detection.detect_confidence {
            return Err(de::Error::custom(
                "degradedConfidence must be below detectConfidence",
            ));
        }
        Ok(Self {
            id: wire.id,
            sensor_type: wire.sensor_type,
            label: wire.label,
            enabled: wire.enabled,
            mount: wire.mount,
            camera,
            field,
            detection,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActorSpec {
    pub class: ActorClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dims: Option<Dimensions>,
    #[serde(default)]
    pub r#static: bool,
    #[serde(default)]
    pub sensors: Vec<ActorSensor>,
}

/// A pose in the AnchorFrame: `(laneOffset k, s, tFrac, headingOffsetRad)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FramePose {
    #[serde(default)]
    pub lane_offset: i32,
    pub s: NumberOrExpr,
    #[serde(default)]
    pub t_frac: TFrac,
    #[serde(default)]
    pub heading_offset_rad: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenePointXZ {
    pub x: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneTimedPoint {
    pub time_s: f64,
    pub x: f64,
    pub z: f64,
}

/// Exact map-bound route a participant owns from the start of the clip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum SceneAbsoluteInitialRoute {
    LanePath { lanes: Vec<String> },
    CustomRoute { points: Vec<ScenePointXZ> },
    CustomTimedRoute { points: Vec<SceneTimedPoint> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenePose {
    pub position: Vec3,
    pub heading_rad: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V1LaneRef {
    pub road_id: String,
    pub section: u32,
    pub lane_id: i64,
    pub s: f64,
    #[serde(default)]
    pub t: f64,
    #[serde(default)]
    pub heading_offset_rad: f64,
}

impl V1LaneRef {
    /// The `road:section:lane` key the lane graph speaks.
    pub fn rsl(&self) -> String {
        format!("{}:{}:{}", self.road_id, self.section, self.lane_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OnMissing {
    Clamp,
    Drop,
    #[default]
    Fail,
}

impl OnMissing {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clamp => "clamp",
            Self::Drop => "drop",
            Self::Fail => "fail",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MovementControl {
    Stop,
    Uncontrolled,
}

impl MovementControl {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Uncontrolled => "uncontrolled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HeadingRelationKind {
    Parallel,
    Antiparallel,
}

impl HeadingRelationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parallel => "parallel",
            Self::Antiparallel => "antiparallel",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeadingRelation {
    pub role: String,
    pub relation: HeadingRelationKind,
    pub max_error_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArriveAtConflict {
    pub relative_to: String,
    pub delta_t: NumberOrExpr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CrossingDirection {
    #[default]
    NearToFar,
    FarToNear,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParkingSlot {
    Index(u32),
    Named(ParkingSlotName),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParkingSlotName {
    First,
    Last,
    Any,
}

impl Default for ParkingSlot {
    fn default() -> Self {
        Self::Named(ParkingSlotName::Any)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ParkingFacing {
    #[default]
    WithTraffic,
    AgainstTraffic,
    Perpendicular,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneDropLane {
    Terminating,
    ContinuingSibling,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleBase {
    pub id: String,
    pub actor: ActorSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_speed_kph: Option<NumberOrExpr>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_profile: Option<DriverProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_movement_control: Option<MovementControl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_same_segment_as: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_same_road_section_as: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_heading_relation: Option<HeadingRelation>,
    #[serde(default = "default_required")]
    pub essentiality: Essentiality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Extensions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoleKind {
    OnReference {
        pose: FramePose,
    },
    #[serde(rename_all = "camelCase")]
    LaneOffset {
        k: i32,
        #[serde(default)]
        on_missing: OnMissing,
        pose: FramePose,
    },
    AtLaneDrop {
        feature: String,
        lane: LaneDropLane,
        pose: FramePose,
    },
    Opposing {
        #[serde(default)]
        k: i32,
        pose: FramePose,
    },
    #[serde(rename_all = "camelCase")]
    ConflictingGate {
        feature: String,
        from: ApproachRelation,
        turn: TurnDirection,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arrive_at_conflict: Option<ArriveAtConflict>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        required_upstream_runway_m: Option<NumberOrExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback_pose: Option<FramePose>,
    },
    #[serde(rename_all = "camelCase")]
    OnCrossing {
        feature: String,
        #[serde(default)]
        start_frac: f64,
        #[serde(default)]
        direction: CrossingDirection,
        #[serde(default)]
        lateral_frac: f64,
    },
    #[serde(rename_all = "camelCase")]
    InParkingZone {
        feature: String,
        #[serde(default)]
        slot: ParkingSlot,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset_m: Option<NumberOrExpr>,
        #[serde(default)]
        facing: ParkingFacing,
    },
    #[serde(rename_all = "camelCase")]
    RelativeTo {
        r#ref: String,
        #[serde(default)]
        d_lane: i32,
        ds_m: NumberOrExpr,
        #[serde(default)]
        t_frac: f64,
        #[serde(default)]
        heading_offset_rad: f64,
    },
    #[serde(rename_all = "camelCase")]
    SceneAbsolute {
        pose: ScenePose,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lane_ref: Option<V1LaneRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_route: Option<SceneAbsoluteInitialRoute>,
    },
}

impl RoleKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::OnReference { .. } => "on_reference",
            Self::LaneOffset { .. } => "lane_offset",
            Self::AtLaneDrop { .. } => "at_lane_drop",
            Self::Opposing { .. } => "opposing",
            Self::ConflictingGate { .. } => "conflicting_gate",
            Self::OnCrossing { .. } => "on_crossing",
            Self::InParkingZone { .. } => "in_parking_zone",
            Self::RelativeTo { .. } => "relative_to",
            Self::SceneAbsolute { .. } => "scene_absolute",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RoleBinding {
    pub base: RoleBase,
    pub kind: RoleKind,
}

const ROLE_BASE_KEYS: &[&str] = &[
    "id",
    "actor",
    "label",
    "initialSpeedKph",
    "driverProfile",
    "requiredMovementControl",
    "requiredSameSegmentAs",
    "requiredSameRoadSectionAs",
    "requiredHeadingRelation",
    "essentiality",
    "extensions",
];

impl RoleBinding {
    pub fn id(&self) -> &str {
        &self.base.id
    }

    pub fn is_portable(&self) -> bool {
        !matches!(self.kind, RoleKind::SceneAbsolute { .. })
    }

    /// The pose a role declares, when its kind has one. `lane_offset` folds
    /// its `k` into `laneOffset`.
    pub fn pose(&self) -> Option<FramePose> {
        match &self.kind {
            RoleKind::OnReference { pose }
            | RoleKind::Opposing { pose, .. }
            | RoleKind::AtLaneDrop { pose, .. } => Some(pose.clone()),
            RoleKind::LaneOffset { k, pose, .. } => Some(FramePose {
                lane_offset: *k,
                ..pose.clone()
            }),
            RoleKind::ConflictingGate { fallback_pose, .. } => fallback_pose.clone(),
            RoleKind::OnCrossing { .. }
            | RoleKind::InParkingZone { .. }
            | RoleKind::RelativeTo { .. }
            | RoleKind::SceneAbsolute { .. } => None,
        }
    }

    /// Footprint used by geometric checks: explicit dims, else the class default.
    pub fn dims(&self) -> ClassDims {
        match self.base.actor.dims {
            Some(d) => ClassDims {
                length: d.length,
                width: d.width,
                height: d.height,
            },
            None => self.base.actor.class.default_dims(),
        }
    }
}

impl Serialize for RoleBinding {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        merge_for_serialize(&self.base, &self.kind).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for RoleBinding {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (base, kind): (RoleBase, RoleKind) =
            split_object(Value::deserialize(deserializer)?, ROLE_BASE_KEYS)
                .map_err(de::Error::custom)?;
        if !is_v2_id(&base.id) {
            return Err(de::Error::custom(format!(
                "role id \"{}\" must start with a letter and use only [A-Za-z0-9_-], max 64 chars",
                base.id
            )));
        }
        let mut seen = BTreeSet::new();
        for sensor in &base.actor.sensors {
            if !seen.insert(sensor.id.as_str()) {
                return Err(de::Error::custom(format!(
                    "duplicate sensor id \"{}\"",
                    sensor.id
                )));
            }
        }
        Ok(Self { base, kind })
    }
}

/* ----------------------------------------------------------------- props */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OcclusionPair {
    pub observer: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropRepeat {
    pub count: u32,
    pub spacing_m: NumberOrExpr,
    #[serde(default)]
    pub t_frac_step: TFrac,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropAttachment {
    pub role: String,
    #[serde(default)]
    pub longitudinal_m: f64,
    #[serde(default)]
    pub lateral_m: f64,
    #[serde(default)]
    pub height_m: f64,
    #[serde(default)]
    pub heading_offset_rad: f64,
}

fn default_scale() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropPlacement {
    pub id: String,
    pub catalog_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub pose: FramePose,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<PropAttachment>,
    #[serde(default)]
    pub heading_offset_rad: f64,
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occludes: Option<OcclusionPair>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_reveal_to_conflict_s: Option<NumberOrExpr>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<PropRepeat>,
    #[serde(default = "default_preferred")]
    pub essentiality: Essentiality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Extensions>,
}

/* ---------------------------------------------------------- interactions */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompareOp {
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "<=")]
    Lte,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = ">=")]
    Gte,
}

impl CompareOp {
    pub fn engine_cmp(self) -> &'static str {
        match self {
            Self::Lt => "lt",
            Self::Lte => "lte",
            Self::Gt => "gt",
            Self::Gte => "gte",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalPhase {
    Green,
    Yellow,
    Red,
    FlashingYellow,
    FlashingRed,
    Off,
    GreenArrow,
    YellowArrow,
    RedX,
    Proceed,
    Stop,
}

impl SignalPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Green => "green",
            Self::Yellow => "yellow",
            Self::Red => "red",
            Self::FlashingYellow => "flashing_yellow",
            Self::FlashingRed => "flashing_red",
            Self::Off => "off",
            Self::GreenArrow => "green_arrow",
            Self::YellowArrow => "yellow_arrow",
            Self::RedX => "red_x",
            Self::Proceed => "proceed",
            Self::Stop => "stop",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalApproach {
    Subject,
    Opposing,
    Left,
    Right,
}

impl SignalApproach {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Subject => "subject",
            Self::Opposing => "opposing",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

impl<'de> Deserialize<'de> for SignalApproach {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            // Already-persisted documents used `ego`; accept it only at the read boundary.
            "subject" | "ego" => Ok(Self::Subject),
            "opposing" => Ok(Self::Opposing),
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            other => Err(de::Error::custom(format!(
                "unknown signal approach \"{other}\""
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SignalRef {
    #[serde(rename_all = "camelCase")]
    Handle {
        #[serde(deserialize_with = "deny_extra_handle")]
        handle: String,
    },
    Feature {
        feature: String,
        approach: SignalApproach,
    },
    Control {
        control: String,
    },
}

fn deny_extra_handle<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    String::deserialize(d)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FeatureAt {
    #[default]
    Entry,
    Center,
    Exit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PointRef {
    Role {
        role: String,
    },
    Feature {
        feature: String,
        #[serde(default)]
        at: FeatureAt,
    },
    Pose {
        pose: FramePose,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DistanceMeasure {
    #[default]
    AlongLane,
    Euclidean,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CollisionWith {
    Any(CollisionAny),
    Role(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollisionAny {
    Any,
}

impl Default for CollisionWith {
    fn default() -> Self {
        Self::Any(CollisionAny::Any)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum LeafCondition {
    #[serde(rename_all = "camelCase")]
    Distance {
        from: String,
        to: PointRef,
        #[serde(default)]
        measure: DistanceMeasure,
        op: CompareOp,
        value_m: NumberOrExpr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hysteresis_m: Option<NumberOrExpr>,
    },
    #[serde(rename_all = "camelCase")]
    Ttc {
        of: String,
        to: String,
        op: CompareOp,
        value_s: NumberOrExpr,
    },
    #[serde(rename_all = "camelCase")]
    Headway {
        of: String,
        to: String,
        op: CompareOp,
        value_s: NumberOrExpr,
    },
    #[serde(rename_all = "camelCase")]
    Reaches {
        of: String,
        region: PointRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tolerance_m: Option<NumberOrExpr>,
    },
    #[serde(rename_all = "camelCase")]
    Speed {
        of: String,
        op: CompareOp,
        value_kph: NumberOrExpr,
    },
    #[serde(rename_all = "camelCase")]
    Signal {
        signal: SignalRef,
        phase: SignalPhase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_duration_s: Option<NumberOrExpr>,
    },
    #[serde(rename_all = "camelCase")]
    Visible {
        of: String,
        to: String,
        #[serde(default = "default_true")]
        visible: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_fraction: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Detected {
        of: String,
        by: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sensor: Option<String>,
        #[serde(default = "default_true")]
        detected: bool,
    },
    #[serde(rename_all = "camelCase")]
    Standstill { of: String, for_s: NumberOrExpr },
    #[serde(rename_all = "camelCase")]
    Collision {
        of: String,
        #[serde(default)]
        with: CollisionWith,
    },
}

impl LeafCondition {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Distance { .. } => "distance",
            Self::Ttc { .. } => "ttc",
            Self::Headway { .. } => "headway",
            Self::Reaches { .. } => "reaches",
            Self::Speed { .. } => "speed",
            Self::Signal { .. } => "signal",
            Self::Visible { .. } => "visible",
            Self::Detected { .. } => "detected",
            Self::Standstill { .. } => "standstill",
            Self::Collision { .. } => "collision",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum LogicalCondition {
    And { operands: Vec<LeafCondition> },
    Or { operands: Vec<LeafCondition> },
    Not { operand: LeafCondition },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Condition {
    Leaf(LeafCondition),
    Logical(LogicalCondition),
}

impl Condition {
    /// Leaf conditions, flattened (shallow by construction).
    pub fn leaves(&self) -> Vec<&LeafCondition> {
        match self {
            Self::Leaf(l) => vec![l],
            Self::Logical(LogicalCondition::And { operands })
            | Self::Logical(LogicalCondition::Or { operands }) => operands.iter().collect(),
            Self::Logical(LogicalCondition::Not { operand }) => vec![operand],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AfterEvent {
    #[default]
    Start,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IfNever {
    #[default]
    Skip,
    Fire,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Trigger {
    At {
        t: NumberOrExpr,
    },
    #[serde(rename_all = "camelCase")]
    After {
        of: String,
        #[serde(default)]
        event: AfterEvent,
        #[serde(default = "default_zero_expr")]
        delay_s: NumberOrExpr,
    },
    #[serde(rename_all = "camelCase")]
    When {
        condition: Condition,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by_latest: Option<NumberOrExpr>,
        #[serde(default)]
        if_never: IfNever,
    },
    #[serde(rename_all = "camelCase")]
    Arrival {
        of: String,
        at: PointRef,
        sync_with: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttc: Option<NumberOrExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delta_t: Option<NumberOrExpr>,
    },
}

impl Trigger {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::At { .. } => "at",
            Self::After { .. } => "after",
            Self::When { .. } => "when",
            Self::Arrival { .. } => "arrival",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DynamicsShape {
    Step,
    Linear,
    Sinusoidal,
    Cubic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DynamicsConstraint {
    Rate,
    Time,
    Distance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dynamics {
    pub shape: DynamicsShape,
    pub constraint: DynamicsConstraint,
    pub value: NumberOrExpr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManeuverStyle {
    Cautious,
    Normal,
    Assertive,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum SpeedTarget {
    #[serde(rename_all = "camelCase")]
    Absolute {
        value_kph: NumberOrExpr,
    },
    #[serde(rename_all = "camelCase")]
    Delta {
        delta_kph: NumberOrExpr,
    },
    Factor {
        factor: NumberOrExpr,
    },
    #[serde(rename_all = "camelCase")]
    Match {
        role: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset_kph: Option<NumberOrExpr>,
    },
    Stop,
    Resume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GapUnit {
    Time,
    Distance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GapTarget {
    pub role: String,
    pub value: NumberOrExpr,
    pub unit: GapUnit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum LaneTarget {
    Relative { dk: i32 },
    Absolute { k: i32 },
    ToRole { role: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LaneOffsetReference {
    #[default]
    LaneCenter,
    LaneEdgeLeft,
    LaneEdgeRight,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaneOffsetTarget {
    pub t_frac: NumberOrExpr,
    #[serde(default)]
    pub reference: LaneOffsetReference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NextJunctionTurn {
    Straight,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NearMissPass {
    Front,
    Behind,
    #[default]
    Auto,
}

fn default_clearance() -> NumberOrExpr {
    NumberOrExpr::Number(0.5)
}
fn default_min_speed_kph() -> NumberOrExpr {
    NumberOrExpr::Number(1.8)
}
fn default_max_speed_kph() -> NumberOrExpr {
    NumberOrExpr::Number(10.8)
}
fn default_to_frac() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum RouteTarget {
    Turn {
        feature: String,
        turn: TurnDirection,
    },
    NextJunction {
        turn: NextJunctionTurn,
    },
    ToFeature {
        feature: String,
    },
    #[serde(rename_all = "camelCase")]
    Crossing {
        feature: String,
        #[serde(default)]
        from_frac: f64,
        #[serde(default = "default_to_frac")]
        to_frac: f64,
    },
    Polyline {
        points: Vec<FramePose>,
    },
    LanePath {
        lanes: Vec<String>,
    },
    CustomRoute {
        points: Vec<ScenePointXZ>,
    },
    CustomTimedRoute {
        points: Vec<SceneTimedPoint>,
    },
    Acquire {
        pose: FramePose,
    },
    #[serde(rename_all = "camelCase")]
    NearMiss {
        target: String,
        #[serde(default = "default_clearance")]
        clearance_m: NumberOrExpr,
        #[serde(default)]
        pass: NearMissPass,
        #[serde(default = "default_min_speed_kph")]
        min_speed_kph: NumberOrExpr,
        #[serde(default = "default_max_speed_kph")]
        max_speed_kph: NumberOrExpr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deadline_s: Option<NumberOrExpr>,
    },
}

impl RouteTarget {
    pub fn mode_name(&self) -> &'static str {
        match self {
            Self::Turn { .. } => "turn",
            Self::NextJunction { .. } => "nextJunction",
            Self::ToFeature { .. } => "toFeature",
            Self::Crossing { .. } => "crossing",
            Self::Polyline { .. } => "polyline",
            Self::LanePath { .. } => "lanePath",
            Self::CustomRoute { .. } => "customRoute",
            Self::CustomTimedRoute { .. } => "customTimedRoute",
            Self::Acquire { .. } => "acquire",
            Self::NearMiss { .. } => "nearMiss",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExistState {
    Present,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExistTarget {
    pub state: ExistState,
}

/// The value shapes `set` accepts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SetValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

impl SetValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Bool(b) => Value::Bool(*b),
            Self::Number(n) => serde_json::json!(*n),
            Self::Text(s) => Value::String(s.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetTarget {
    pub key: String,
    pub value: SetValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionBase {
    pub id: String,
    pub actor: String,
    pub trigger: Trigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Trigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "verb", rename_all = "camelCase", deny_unknown_fields)]
pub enum Verb {
    Speed {
        target: SpeedTarget,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dynamics: Option<Dynamics>,
    },
    Gap {
        target: GapTarget,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dynamics: Option<Dynamics>,
    },
    #[serde(rename_all = "camelCase")]
    ChangeLane {
        target: LaneTarget,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dynamics: Option<Dynamics>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maneuver_duration_s: Option<NumberOrExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maneuver_style: Option<ManeuverStyle>,
    },
    #[serde(rename_all = "camelCase")]
    LaneOffset {
        target: LaneOffsetTarget,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dynamics: Option<Dynamics>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maneuver_duration_s: Option<NumberOrExpr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maneuver_style: Option<ManeuverStyle>,
    },
    Route {
        target: RouteTarget,
    },
    Exist {
        target: ExistTarget,
    },
    Set {
        target: SetTarget,
    },
}

impl Verb {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Speed { .. } => "speed",
            Self::Gap { .. } => "gap",
            Self::ChangeLane { .. } => "changeLane",
            Self::LaneOffset { .. } => "laneOffset",
            Self::Route { .. } => "route",
            Self::Exist { .. } => "exist",
            Self::Set { .. } => "set",
        }
    }

    pub fn dynamics(&self) -> Option<&Dynamics> {
        match self {
            Self::Speed { dynamics, .. }
            | Self::Gap { dynamics, .. }
            | Self::ChangeLane { dynamics, .. }
            | Self::LaneOffset { dynamics, .. } => dynamics.as_ref(),
            _ => None,
        }
    }

    /// The five control axes; `state:<key>` is one axis per settable key.
    pub fn axis(&self) -> String {
        match self {
            Self::Speed { .. } | Self::Gap { .. } => "longitudinal".to_owned(),
            Self::ChangeLane { .. } | Self::LaneOffset { .. } => "lateral".to_owned(),
            Self::Route { .. } => "topology".to_owned(),
            Self::Exist { .. } => "existence".to_owned(),
            Self::Set { target } => format!("state:{}", target.key),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Interaction {
    pub base: InteractionBase,
    pub verb: Verb,
}

const INTERACTION_BASE_KEYS: &[&str] = &["id", "actor", "trigger", "until", "label"];

impl Interaction {
    pub fn id(&self) -> &str {
        &self.base.id
    }

    pub fn actor(&self) -> &str {
        &self.base.actor
    }
}

impl Serialize for Interaction {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        merge_for_serialize(&self.base, &self.verb).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Interaction {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (base, verb): (InteractionBase, Verb) =
            split_object(Value::deserialize(deserializer)?, INTERACTION_BASE_KEYS)
                .map_err(de::Error::custom)?;
        if !is_v2_id(&base.id) {
            return Err(de::Error::custom(format!("interaction id \"{}\" must start with a letter and use only [A-Za-z0-9_-], max 64 chars", base.id)));
        }
        if base.actor != WORLD_ROLE_REF && !is_v2_id(&base.actor) {
            return Err(de::Error::custom(format!(
                "actor \"{}\" is neither a role id nor {WORLD_ROLE_REF}",
                base.actor
            )));
        }
        for trigger in std::iter::once(&base.trigger).chain(base.until.iter()) {
            if let Trigger::Arrival { ttc, delta_t, .. } = trigger {
                if ttc.is_none() == delta_t.is_none() {
                    return Err(de::Error::custom(
                        "arrival needs exactly one of `ttc` or `deltaT`",
                    ));
                }
            }
        }
        Ok(Self { base, verb })
    }
}

fn default_clip_seconds() -> f64 {
    20.0
}
fn default_warmup_seconds() -> f64 {
    5.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choreography {
    #[serde(default = "default_clip_seconds")]
    pub clip_seconds: f64,
    #[serde(default = "default_warmup_seconds")]
    pub warmup_seconds: f64,
    #[serde(default)]
    pub interactions: Vec<Interaction>,
}

impl Default for Choreography {
    fn default() -> Self {
        Self {
            clip_seconds: 20.0,
            warmup_seconds: 5.0,
            interactions: Vec::new(),
        }
    }
}

/* ------------------------------------------------------- traffic controls */

pub use simforge_core::types::{ControlIndication, DarkFallback};

/// A normal road signal cannot display lane-control or human-director states.
pub fn is_map_signal_indication(indication: ControlIndication) -> bool {
    use ControlIndication as I;
    matches!(
        indication,
        I::Green | I::Yellow | I::Red | I::FlashingYellow | I::FlashingRed | I::Off
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrafficControlKind {
    TemporarySignal,
    LaneControl,
    NormalSignal,
    HumanDirector,
}

impl TrafficControlKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TemporarySignal => "temporary_signal",
            Self::LaneControl => "lane_control",
            Self::NormalSignal => "normal_signal",
            Self::HumanDirector => "human_director",
        }
    }

    pub fn allows(self, indication: ControlIndication) -> bool {
        use ControlIndication as I;
        match self {
            Self::TemporarySignal => matches!(
                indication,
                I::Green | I::Yellow | I::Red | I::FlashingYellow | I::FlashingRed | I::Off
            ),
            Self::NormalSignal => matches!(
                indication,
                I::Green
                    | I::Yellow
                    | I::Red
                    | I::FlashingYellow
                    | I::FlashingRed
                    | I::Off
                    | I::GreenArrow
                    | I::YellowArrow
                    | I::FlashingYellowArrow
                    | I::FlashingRedArrow
            ),
            Self::LaneControl => matches!(
                indication,
                I::GreenArrow
                    | I::YellowArrow
                    | I::RedX
                    | I::Off
                    | I::FlashingYellowArrow
                    | I::FlashingRedArrow
            ),
            Self::HumanDirector => matches!(indication, I::Proceed | I::Stop),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrafficControlPhase {
    pub indication: ControlIndication,
    pub duration_s: NumberOrExpr,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableStopLine {
    pub pose: FramePose,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
}

fn default_one_expr() -> NumberOrExpr {
    NumberOrExpr::Number(1.0)
}

fn default_dark_fallback() -> DarkFallback {
    simforge_core::engine::signals::DEFAULT_DARK_FALLBACK
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrafficControl {
    pub id: String,
    pub kind: TrafficControlKind,
    pub pose: FramePose,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
    pub stop_lines: Vec<PortableStopLine>,
    pub phases: Vec<TrafficControlPhase>,
    #[serde(default = "default_zero_expr")]
    pub offset_s: NumberOrExpr,
    #[serde(default)]
    pub r#loop: bool,
    #[serde(default = "default_dark_fallback")]
    pub dark_fallback: DarkFallback,
    #[serde(default = "default_one_expr")]
    pub dark_dwell_s: NumberOrExpr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapSignalHeadRef {
    pub controller_id: String,
    pub head_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapSignalPlanClip {
    pub id: String,
    pub start_s: f64,
    pub end_s: f64,
    pub reference: MapSignalHeadRef,
    pub indication: ControlIndication,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapSignalPlanBinding {
    pub map_id: String,
    pub junction_id: String,
    pub control_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapSignalPlan {
    pub id: String,
    pub version: u32,
    pub binding: MapSignalPlanBinding,
    #[serde(default)]
    pub clips: Vec<MapSignalPlanClip>,
}

/* ------------------------------------------------------------ perception */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapDivergenceKind {
    LaneMarkingsFaded,
    LaneMarkingsObscured,
    LaneMarkingsRepainted,
    LaneGeometryShifted,
    LaneMissingFromMap,
    LaneAbsentInWorld,
    ReflectorsMisaligned,
    SurfaceMisclassified,
}

impl MapDivergenceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LaneMarkingsFaded => "lane_markings_faded",
            Self::LaneMarkingsObscured => "lane_markings_obscured",
            Self::LaneMarkingsRepainted => "lane_markings_repainted",
            Self::LaneGeometryShifted => "lane_geometry_shifted",
            Self::LaneMissingFromMap => "lane_missing_from_map",
            Self::LaneAbsentInWorld => "lane_absent_in_world",
            Self::ReflectorsMisaligned => "reflectors_misaligned",
            Self::SurfaceMisclassified => "surface_misclassified",
        }
    }
}

fn default_radius_25() -> f64 {
    25.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum MapDivergenceExtent {
    #[serde(rename_all = "camelCase")]
    Corridor {
        #[serde(default)]
        from_frac: f64,
        #[serde(default = "default_to_frac")]
        to_frac: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lane: Option<i32>,
    },
    #[serde(rename_all = "camelCase")]
    AroundRole {
        role: String,
        #[serde(default = "default_radius_25")]
        radius_m: f64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapDivergence {
    pub id: String,
    pub kind: MapDivergenceKind,
    pub extent: MapDivergenceExtent,
    #[serde(default = "one")]
    pub severity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lateral_error_m: Option<f64>,
    #[serde(default)]
    pub observers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplatePerception {
    #[serde(default)]
    pub map_divergences: Vec<MapDivergence>,
}

/* ------------------------------------------------------------ invariants */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvariantBase {
    pub id: String,
    #[serde(default = "default_required")]
    pub essentiality: Essentiality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<(NumberOrExpr, NumberOrExpr)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TtcMode {
    #[default]
    Min,
    Always,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GapMetric {
    #[default]
    Longest,
    Total,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionGapReason {
    Occluded,
    AtmosphericAttenuation,
    BelowAngularResolution,
    LowLight,
    Glare,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InvariantKind {
    Headway {
        of: String,
        to: String,
        range: Range,
    },
    Gap {
        of: String,
        to: String,
        unit: GapUnit,
        range: Range,
    },
    Ttc {
        of: String,
        to: String,
        range: Range,
        #[serde(default)]
        mode: TtcMode,
    },
    PathTtc {
        of: String,
        to: String,
        range: Range,
    },
    Pet {
        of: String,
        to: String,
        range: Range,
    },
    #[serde(rename_all = "camelCase")]
    NearMiss {
        pedestrian: String,
        target: String,
        clearance_range_m: Range,
    },
    #[serde(rename_all = "camelCase")]
    Arrival {
        of: String,
        at: PointRef,
        sync_with: String,
        delta_t_range: Range,
    },
    #[serde(rename_all = "camelCase")]
    ClosingSpeed {
        of: String,
        to: String,
        range_kph: Range,
    },
    #[serde(rename_all = "camelCase")]
    SpeedRelLimit { of: String, range_frac: Range },
    #[serde(rename_all = "camelCase")]
    EventOrder {
        events: Vec<String>,
        #[serde(default = "default_true")]
        strict: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_separation_s: Option<NumberOrExpr>,
    },
    #[serde(rename_all = "camelCase")]
    DecelBudget { of: String, max_mps2: NumberOrExpr },
    #[serde(rename_all = "camelCase")]
    DetectionGap {
        of: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sensor: Option<String>,
        range: Range,
        #[serde(default)]
        metric: GapMetric,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<DetectionGapReason>,
    },
    TimeToFirstDetection {
        of: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sensor: Option<String>,
        range: Range,
    },
    PerceptionLag {
        of: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sensor: Option<String>,
        range: Range,
    },
    MapDivergence {
        of: String,
        divergence: String,
        range: Range,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Invariant {
    pub base: InvariantBase,
    pub kind: InvariantKind,
}

const INVARIANT_BASE_KEYS: &[&str] = &["id", "essentiality", "window", "label"];

impl Serialize for Invariant {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        merge_for_serialize(&self.base, &self.kind).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Invariant {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (base, kind): (InvariantBase, InvariantKind) =
            split_object(Value::deserialize(deserializer)?, INVARIANT_BASE_KEYS)
                .map_err(de::Error::custom)?;
        if let InvariantKind::EventOrder { events, .. } = &kind {
            let mut seen = BTreeSet::new();
            for id in events {
                if !seen.insert(id.as_str()) {
                    return Err(de::Error::custom(format!(
                        "event \"{id}\" appears twice in the order"
                    )));
                }
            }
        }
        Ok(Self { base, kind })
    }
}

/* -------------------------------------------------------------- variants */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OverrideOp {
    #[default]
    Set,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Override {
    pub path: String,
    #[serde(default)]
    pub op: OverrideOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Variant {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub when: Vec<ParamConstraint>,
    pub overrides: Vec<Override>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReasoningTraceSegment {
    pub id: String,
    pub actor: String,
    pub start_s: f64,
    pub end_s: f64,
    #[serde(default)]
    pub observation: String,
    #[serde(default)]
    pub action: String,
}

/* -------------------------------------------------------------- document */

/// A validated v2 template (all defaults materialised, expressions parsed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioTemplate {
    pub scenario_version: u32,
    pub meta: TemplateMeta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_map: Option<MapRef>,
    #[serde(default)]
    pub params: ParamsBlock,
    #[serde(default)]
    pub environment: Environment,
    pub anchor: LogicalAnchor,
    #[serde(default)]
    pub roles: Vec<RoleBinding>,
    #[serde(default)]
    pub props: Vec<PropPlacement>,
    #[serde(default)]
    pub traffic_controls: Vec<TrafficControl>,
    #[serde(default)]
    pub map_signal_plans: Vec<MapSignalPlan>,
    #[serde(default)]
    pub choreography: Choreography,
    #[serde(default)]
    pub perception: TemplatePerception,
    #[serde(default)]
    pub invariants: Vec<Invariant>,
    #[serde(default)]
    pub variants: Vec<Variant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_subject: Option<String>,
    #[serde(default)]
    pub reasoning_trace: Vec<ReasoningTraceSegment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Extensions>,
}

impl ScenarioTemplate {
    pub fn role(&self, id: &str) -> Option<&RoleBinding> {
        self.roles.iter().find(|r| r.base.id == id)
    }

    pub fn role_index(&self, id: &str) -> Option<usize> {
        self.roles.iter().position(|r| r.base.id == id)
    }

    pub fn interaction(&self, id: &str) -> Option<&Interaction> {
        self.choreography
            .interactions
            .iter()
            .find(|i| i.base.id == id)
    }

    /// The stable identity of a template, used in the replay key.
    pub fn template_id(&self) -> &str {
        self.anchor.id.as_deref().unwrap_or(&self.meta.name)
    }

    /// True when every role can be re-placed on another map.
    pub fn is_portable(&self) -> bool {
        self.roles.iter().all(RoleBinding::is_portable)
    }

    /// Serialise back to the authored JSON shape.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Structural issue found by [`parse_template`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateIssue {
    pub path: String,
    pub message: String,
}

/// Parse an authored v2 template from JSON, applying defaults, parsing
/// expressions and running the cheap universal cross-field checks (unique ids,
/// clip bounds, `modifiedAt >= createdAt`).
pub fn parse_template(value: &Value) -> CompileResult<ScenarioTemplate> {
    let version = value.get("scenarioVersion").and_then(Value::as_u64);
    if version != Some(u64::from(SCENARIO_TEMPLATE_VERSION)) {
        return Err(CompileError::at(
            "template_invalid",
            "scenarioVersion",
            format!("expected scenarioVersion {SCENARIO_TEMPLATE_VERSION}"),
        )
        .as_findings());
    }
    let template: ScenarioTemplate = serde_json::from_value(value.clone()).map_err(|e| {
        CompileError::new("template_invalid", "the template failed the v2 contract")
            .detail_entry("reason", Value::String(e.to_string()))
            .as_findings()
    })?;
    let issues = structural_issues(&template);
    if !issues.is_empty() {
        let detail = serde_json::to_value(&issues).unwrap_or(Value::Null);
        return Err(
            CompileError::new("template_invalid", "the template failed the v2 contract")
                .detail_entry("issues", detail)
                .as_findings(),
        );
    }
    Ok(template)
}

/// Universal cross-field checks, mirroring the document schema's `.check`.
pub fn structural_issues(doc: &ScenarioTemplate) -> Vec<TemplateIssue> {
    let mut issues = Vec::new();
    fn dupes<'a>(
        items: impl Iterator<Item = &'a str>,
        path: &str,
        issues: &mut Vec<TemplateIssue>,
    ) {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for (index, id) in items.enumerate() {
            if !seen.insert(id) {
                issues.push(TemplateIssue {
                    path: format!("{path}.{index}.id"),
                    message: format!("duplicate {path} id \"{id}\""),
                });
            }
        }
    }
    dupes(
        doc.roles.iter().map(|r| r.base.id.as_str()),
        "roles",
        &mut issues,
    );
    dupes(
        doc.props.iter().map(|p| p.id.as_str()),
        "props",
        &mut issues,
    );
    dupes(
        doc.traffic_controls.iter().map(|c| c.id.as_str()),
        "trafficControls",
        &mut issues,
    );
    dupes(
        doc.map_signal_plans.iter().map(|p| p.id.as_str()),
        "mapSignalPlans",
        &mut issues,
    );
    let mut junction_owners: BTreeSet<(String, String)> = BTreeSet::new();
    for (index, plan) in doc.map_signal_plans.iter().enumerate() {
        if plan.version != 1 {
            issues.push(TemplateIssue {
                path: format!("mapSignalPlans.{index}.version"),
                message: "map signal plan version must be 1".to_owned(),
            });
        }
        if !junction_owners.insert((
            plan.binding.map_id.clone(),
            plan.binding.junction_id.clone(),
        )) {
            issues.push(TemplateIssue {
                path: format!("mapSignalPlans.{index}.binding.junctionId"),
                message: format!(
                    "only one map signal plan may own junction \"{}\" on map \"{}\"",
                    plan.binding.junction_id, plan.binding.map_id
                ),
            });
        }
        let mut clip_ids: BTreeSet<&str> = BTreeSet::new();
        for (ci, clip) in plan.clips.iter().enumerate() {
            if !is_control_id(&clip.id) {
                issues.push(TemplateIssue {
                    path: format!("mapSignalPlans.{index}.clips.{ci}.id"),
                    message: "invalid clip id".to_owned(),
                });
            }
            if !clip_ids.insert(&clip.id) {
                issues.push(TemplateIssue {
                    path: format!("mapSignalPlans.{index}.clips.{ci}.id"),
                    message: format!("duplicate map signal clip id \"{}\"", clip.id),
                });
            }
            if clip.start_s < 0.0 || clip.end_s <= 0.0 || clip.end_s <= clip.start_s {
                issues.push(TemplateIssue {
                    path: format!("mapSignalPlans.{index}.clips.{ci}.endS"),
                    message:
                        "map signal clip endS must be greater than startS (clips are half-open)"
                            .to_owned(),
                });
            }
            if !is_map_signal_indication(clip.indication) {
                issues.push(TemplateIssue {
                    path: format!("mapSignalPlans.{index}.clips.{ci}.indication"),
                    message: "map signal clips require a normal-signal indication".to_owned(),
                });
            }
            if clip.end_s > doc.choreography.clip_seconds {
                issues.push(TemplateIssue {
                    path: format!("mapSignalPlans.{index}.clips.{ci}.endS"),
                    message: format!(
                        "map signal clip ends after choreography.clipSeconds ({})",
                        doc.choreography.clip_seconds
                    ),
                });
            }
        }
        let mut ordered: Vec<(usize, &MapSignalPlanClip)> = plan.clips.iter().enumerate().collect();
        ordered.sort_by(|a, b| {
            a.1.start_s
                .partial_cmp(&b.1.start_s)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(
                    a.1.end_s
                        .partial_cmp(&b.1.end_s)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
                .then(a.1.id.cmp(&b.1.id))
        });
        for w in ordered.windows(2) {
            if w[1].1.start_s < w[0].1.end_s {
                issues.push(TemplateIssue {
                    path: format!("mapSignalPlans.{index}.clips.{}.startS", w[1].0),
                    message: format!("map signal clip overlaps \"{}\"; clip intervals are half-open [startS, endS)", w[0].1.id),
                });
            }
        }
    }
    for (index, control) in doc.traffic_controls.iter().enumerate() {
        if !is_control_id(&control.id) {
            issues.push(TemplateIssue {
                path: format!("trafficControls.{index}.id"),
                message: "invalid traffic control id".to_owned(),
            });
        }
        if control.stop_lines.is_empty() || control.stop_lines.len() > 8 {
            issues.push(TemplateIssue {
                path: format!("trafficControls.{index}.stopLines"),
                message: "a traffic control needs 1-8 stop lines".to_owned(),
            });
        }
        if control.phases.is_empty() || control.phases.len() > 32 {
            issues.push(TemplateIssue {
                path: format!("trafficControls.{index}.phases"),
                message: "a traffic control needs 1-32 phases".to_owned(),
            });
        }
        for (pi, phase) in control.phases.iter().enumerate() {
            if !control.kind.allows(phase.indication) {
                issues.push(TemplateIssue {
                    path: format!("trafficControls.{index}.phases.{pi}.indication"),
                    message: format!(
                        "{} is not valid for {}",
                        phase.indication.as_str(),
                        control.kind.as_str()
                    ),
                });
            }
        }
    }
    dupes(
        doc.invariants.iter().map(|i| i.base.id.as_str()),
        "invariants",
        &mut issues,
    );
    dupes(
        doc.variants.iter().map(|v| v.id.as_str()),
        "variants",
        &mut issues,
    );
    dupes(
        doc.reasoning_trace.iter().map(|s| s.id.as_str()),
        "reasoningTrace",
        &mut issues,
    );
    for (index, segment) in doc.reasoning_trace.iter().enumerate() {
        if segment.end_s <= segment.start_s {
            issues.push(TemplateIssue {
                path: format!("reasoningTrace.{index}.endS"),
                message: "reasoning trace endS must be after startS".to_owned(),
            });
        }
        if segment.end_s > doc.choreography.clip_seconds {
            issues.push(TemplateIssue {
                path: format!("reasoningTrace.{index}.endS"),
                message: format!(
                    "reasoning trace ends after choreography.clipSeconds ({})",
                    doc.choreography.clip_seconds
                ),
            });
        }
    }
    dupes(
        doc.params.declarations.iter().map(|d| d.base.id.as_str()),
        "params",
        &mut issues,
    );
    dupes(
        doc.anchor.features.iter().map(|f| f.base.id.as_str()),
        "features",
        &mut issues,
    );
    let mut seen_interactions: BTreeSet<&str> = BTreeSet::new();
    for (index, interaction) in doc.choreography.interactions.iter().enumerate() {
        if !seen_interactions.insert(&interaction.base.id) {
            issues.push(TemplateIssue {
                path: format!("choreography.interactions.{index}.id"),
                message: format!("duplicate interaction id \"{}\"", interaction.base.id),
            });
        }
    }
    if !(3.0..=120.0).contains(&doc.choreography.clip_seconds) {
        issues.push(TemplateIssue {
            path: "choreography.clipSeconds".to_owned(),
            message: "clipSeconds must be within [3, 120]".to_owned(),
        });
    }
    if !(0.0..=30.0).contains(&doc.choreography.warmup_seconds) {
        issues.push(TemplateIssue {
            path: "choreography.warmupSeconds".to_owned(),
            message: "warmupSeconds must be within [0, 30]".to_owned(),
        });
    }
    if let (Some(created), Some(modified)) = (
        parse_timestamp(&doc.meta.created_at),
        parse_timestamp(&doc.meta.modified_at),
    ) {
        if modified < created {
            issues.push(TemplateIssue {
                path: "meta.modifiedAt".to_owned(),
                message: "meta.modifiedAt precedes meta.createdAt".to_owned(),
            });
        }
    }
    for (index, role) in doc.roles.iter().enumerate() {
        if let RoleKind::LaneOffset { k, .. } = role.kind {
            if !(-8..=8).contains(&k) {
                issues.push(TemplateIssue {
                    path: format!("roles.{index}.k"),
                    message: "k must be within [-8, 8]".to_owned(),
                });
            }
        }
        if let Some(pose) = role.pose() {
            if !(-8..=8).contains(&pose.lane_offset) {
                issues.push(TemplateIssue {
                    path: format!("roles.{index}.pose.laneOffset"),
                    message: "laneOffset must be within [-8, 8]".to_owned(),
                });
            }
        }
    }
    if let Some(subject) = &doc.metric_subject {
        if doc.role(subject).is_none() {
            issues.push(TemplateIssue {
                path: "metricSubject".to_owned(),
                message: format!("metricSubject names unknown role \"{subject}\""),
            });
        }
    }
    issues
}

/// ISO-8601 timestamps compare correctly as strings once normalised to UTC
/// `YYYY-MM-DDTHH:MM:SS[.fff]`; offsets are folded into a comparable key.
fn parse_timestamp(s: &str) -> Option<i128> {
    let s = s.trim();
    if s.len() < 19 {
        return None;
    }
    let bytes = s.as_bytes();
    let num = |a: usize, b: usize| -> Option<i128> { s.get(a..b)?.parse::<i128>().ok() };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    if bytes[10] != b'T' && bytes[10] != b't' && bytes[10] != b' ' {
        return None;
    }
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    let mut idx = 19;
    let mut millis: i128 = 0;
    if idx < bytes.len() && bytes[idx] == b'.' {
        idx += 1;
        let start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        let frac = &s[start..idx];
        let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
        millis = padded.parse().ok()?;
    }
    let mut offset_min: i128 = 0;
    if idx < bytes.len() {
        match bytes[idx] {
            b'Z' | b'z' => {}
            b'+' | b'-' => {
                let sign = if bytes[idx] == b'+' { 1 } else { -1 };
                let oh = num(idx + 1, idx + 3)?;
                let om = if idx + 6 <= bytes.len() {
                    num(idx + 4, idx + 6)?
                } else {
                    0
                };
                offset_min = sign * (oh * 60 + om);
            }
            _ => return None,
        }
    }
    // Days from civil (proleptic Gregorian), Howard Hinnant's algorithm.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((((days * 24 + hour) * 60 + minute - offset_min) * 60 + second) * 1000 + millis)
}

/* --------------------------------------------------------------- helpers */

/// Split an object into `(base, rest)`: keys in `base_keys` go to the base
/// struct, every other key to the kind-specific struct. Both halves are
/// deserialised strictly so a typo anywhere is still an error.
fn split_object<B: DeserializeOwned, K: DeserializeOwned>(
    value: Value,
    base_keys: &[&str],
) -> Result<(B, K), String> {
    let (base, rest): (B, Value) = split_object_raw(value, base_keys)?;
    let kind: K = serde_json::from_value(rest).map_err(|e| e.to_string())?;
    Ok((base, kind))
}

fn split_object_raw<B: DeserializeOwned>(
    value: Value,
    base_keys: &[&str],
) -> Result<(B, Value), String> {
    let Value::Object(map) = value else {
        return Err("expected an object".to_owned());
    };
    let mut base = Map::new();
    let mut rest = Map::new();
    for (key, val) in map {
        if base_keys.contains(&key.as_str()) {
            base.insert(key, val);
        } else {
            rest.insert(key, val);
        }
    }
    let base: B = serde_json::from_value(Value::Object(base)).map_err(|e| e.to_string())?;
    Ok((base, Value::Object(rest)))
}

fn merge_for_serialize<A: Serialize, B: Serialize>(a: &A, b: &B) -> Value {
    let mut out = match serde_json::to_value(a) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    };
    if let Ok(Value::Object(m)) = serde_json::to_value(b) {
        out.extend(m);
    }
    Value::Object(out)
}

/// Sorted, deduplicated role ids referenced anywhere in a template.
pub fn referenced_roles(template: &ScenarioTemplate) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for interaction in &template.choreography.interactions {
        if interaction.base.actor != WORLD_ROLE_REF {
            out.insert(interaction.base.actor.clone());
        }
    }
    out
}

/// Parameter ids referenced by expressions, keyed by dotted path.
pub fn param_refs_by_path(template: &ScenarioTemplate) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    for (i, role) in template.roles.iter().enumerate() {
        if let Some(speed) = &role.base.initial_speed_kph {
            let refs = speed.param_refs();
            if !refs.is_empty() {
                out.insert(format!("roles.{i}.initialSpeedKph"), refs);
            }
        }
    }
    out
}
