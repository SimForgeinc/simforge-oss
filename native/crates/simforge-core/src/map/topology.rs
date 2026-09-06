//! The subset of `dev-assets/<map>/topology-index.json.gz` the engine consumes.
//!
//! The engine reads the topology index **directly**; it does not depend on any
//! derived catalogue index. Coordinates in the index are xodr-local metres,
//! which is also the engine's working frame, so nothing is transformed on load.
//!
//! Serde field names are the sidecar's camelCase contract. Polyline vertices
//! are accepted in both of the sidecar's encodings (`{x, y}` objects or
//! `[x, y]` pairs) and normalised to [`Vec2`] once, at decode time.

use std::collections::BTreeMap;
use std::io::Read;

use serde::de::{self, Deserializer, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::math::Vec2;
use crate::types::TurnRelation;

/// `road:section:lane`, e.g. `"27:0:-1"`.
pub type LaneRsl = String;

/// Which side of a lane, in the lane's **storage** orientation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaneSide {
    Left,
    Right,
}

impl LaneSide {
    /// The driver's side when the lane is traversed against storage order.
    #[inline]
    pub const fn flipped(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
        }
    }

    /// `side` expressed in storage orientation for a lane traversed `reversed`.
    #[inline]
    pub const fn to_storage(self, reversed: bool) -> Self {
        if reversed {
            self.flipped()
        } else {
            self
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyAdjacentLane {
    pub side: LaneSide,
    #[serde(default)]
    pub lane_rsl: Option<LaneRsl>,
    #[serde(default)]
    pub same_direction: bool,
    #[serde(default)]
    pub permission_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyAdjacentLanes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<TopologyAdjacentLane>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<TopologyAdjacentLane>,
}

impl TopologyAdjacentLanes {
    #[inline]
    pub fn side(&self, side: LaneSide) -> Option<&TopologyAdjacentLane> {
        match side {
            LaneSide::Left => self.left.as_ref(),
            LaneSide::Right => self.right.as_ref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyLaneChangePermission {
    pub id: String,
    pub side: LaneSide,
    pub start_s: f64,
    pub end_s: f64,
    pub allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyWidthSample {
    pub s: f64,
    pub width_m: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyLane {
    pub rsl: LaneRsl,
    pub road_id: i64,
    pub section: i64,
    pub lane_id: i64,
    pub lane_type: String,
    #[serde(default)]
    pub is_junction: bool,
    #[serde(default)]
    pub junction_id: Option<String>,
    #[serde(default)]
    pub predecessors: Vec<LaneRsl>,
    #[serde(default)]
    pub successors: Vec<LaneRsl>,
    #[serde(default)]
    pub speed_limit_kph: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub representative_width_m: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub width_samples: Vec<TopologyWidthSample>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjacent_lanes: Option<TopologyAdjacentLanes>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lane_change_permissions: Vec<TopologyLaneChangePermission>,
    /// Polyline in storage (`+s`) order, xodr-local metres.
    #[serde(default, deserialize_with = "deserialize_polyline")]
    pub polyline: Vec<Vec2>,
}

impl TopologyLane {
    #[inline]
    pub fn adjacent(&self, side: LaneSide) -> Option<&TopologyAdjacentLane> {
        self.adjacent_lanes.as_ref().and_then(|a| a.side(side))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyGate {
    pub id: String,
    pub junction_id: String,
    pub turn_relation: TurnRelation,
    pub heading_change_rad: f64,
    pub connecting_lane_rsl: LaneRsl,
    pub approach_lane_rsl: LaneRsl,
    #[serde(default)]
    pub exit_lane_rsls: Vec<LaneRsl>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyJunction {
    pub junction_id: String,
    #[serde(default)]
    pub gate_ids: Vec<String>,
    #[serde(default)]
    pub internal_lane_rsls: Vec<LaneRsl>,
    #[serde(default)]
    pub approach_lane_rsls: Vec<LaneRsl>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologySource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xodr_sha256: Option<String>,
}

/// A decoded topology sidecar. Lanes are keyed by rsl in sorted order so every
/// derived structure that iterates them is reproducible.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyIndex {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<TopologySource>,
    pub lanes: BTreeMap<LaneRsl, TopologyLane>,
    pub gates: Vec<TopologyGate>,
    pub junctions: BTreeMap<String, TopologyJunction>,
}

impl TopologyIndex {
    /// Decode a plain or gzip-compressed topology JSON sidecar.
    pub fn decode(bytes: &[u8]) -> Result<Self, CoreError> {
        if is_gzipped(bytes) {
            let mut plain = Vec::new();
            flate2::read::MultiGzDecoder::new(bytes)
                .read_to_end(&mut plain)
                .map_err(|e| CoreError::Topology(format!("gzip: {e}")))?;
            Self::from_json_slice(&plain)
        } else {
            Self::from_json_slice(bytes)
        }
    }

    /// Decode uncompressed JSON.
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, CoreError> {
        serde_json::from_slice(bytes).map_err(|e| CoreError::Topology(e.to_string()))
    }

    /// `source.xodrSha256`, or empty when the sidecar carries none.
    pub fn topology_digest(&self) -> &str {
        self.source
            .as_ref()
            .and_then(|s| s.xodr_sha256.as_deref())
            .unwrap_or("")
    }
}

fn is_gzipped(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

/// Accept `{x, y}` objects or `[x, y]` pairs for each vertex.
fn deserialize_polyline<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Vec2>, D::Error> {
    struct PointVisitor;

    impl<'de> Visitor<'de> for PointVisitor {
        type Value = Vec2;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a polyline point as {x, y} or [x, y]")
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec2, A::Error> {
            let x: f64 = seq
                .next_element()?
                .ok_or_else(|| de::Error::invalid_length(0, &self))?;
            let y: f64 = seq
                .next_element()?
                .ok_or_else(|| de::Error::invalid_length(1, &self))?;
            // Tolerate a trailing `z`; the engine is planar.
            while seq.next_element::<de::IgnoredAny>()?.is_some() {}
            Ok(Vec2 { x, y })
        }

        fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Vec2, A::Error> {
            let mut x = None;
            let mut y = None;
            while let Some(key) = map.next_key::<String>()? {
                match key.as_str() {
                    "x" => x = Some(map.next_value::<f64>()?),
                    "y" => y = Some(map.next_value::<f64>()?),
                    _ => {
                        map.next_value::<de::IgnoredAny>()?;
                    }
                }
            }
            Ok(Vec2 {
                x: x.ok_or_else(|| de::Error::missing_field("x"))?,
                y: y.ok_or_else(|| de::Error::missing_field("y"))?,
            })
        }
    }

    struct Point(Vec2);

    impl<'de> Deserialize<'de> for Point {
        fn deserialize<D2: Deserializer<'de>>(d: D2) -> Result<Self, D2::Error> {
            d.deserialize_any(PointVisitor).map(Point)
        }
    }

    let points = Vec::<Point>::deserialize(d)?;
    Ok(points.into_iter().map(|p| p.0).collect())
}
