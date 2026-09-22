//! The render timeline's single height source: OpenDRIVE `<elevation>`
//! profiles projected onto the immutable lane topology.
//!
//! This is the Rust port of the xosc exporter's resolver
//! (`packages/compiler/src/xodr-elevation.ts`, `buildXodrElevationResolver`)
//! and follows it step for step: the same lane-ribbon acceptance, the same
//! driving-lane preference, the same ambiguity refusal and the same 25 m
//! off-network bound. It is evaluated once, when a timeline is built; no
//! renderer samples height on its own.
//!
//! Kind `xodr-elevation/v1` covers the reference-line elevation profile only.
//! Superelevation and `<laneHeight>` are reserved for `xodr-elevation/v2`
//! (the topology carries no reference-line lateral offsets yet); a new kind
//! changes [`HeightField::digest`] and therefore every timeline key.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::hash::{cmp_locale, content_hash_of, sha256_bytes};
use crate::map::topology::TopologyIndex;
use crate::math::{hypot, pow, Vec2};

/// Height-source kind covered by this module.
pub const XODR_ELEVATION_KIND: &str = "xodr-elevation/v1";
/// A constant-elevation source for maps without profiles and for tests.
pub const FLAT_KIND: &str = "flat/v1";
/// A synthetic inclined plane `z = z0 + gx*x + gy*y` (tests and the binding
/// identity corpus, which must exercise attitude without shipping a map).
pub const PLANE_KIND: &str = "plane/v1";

/// Same bound as `OFF_NETWORK_BOUND_M` in `packages/compiler/src/off-network.ts`.
pub const OFF_NETWORK_BOUND_M: f64 = 25.0;
const LANE_EDGE_TOLERANCE_M: f64 = 0.15;
const AMBIGUOUS_DISTANCE_EPSILON_M: f64 = 0.001;
const DISTINCT_SURFACE_EPSILON_M: f64 = 0.05;
const CONTINUOUS_SURFACE_MAX_GAP_M: f64 = 1.0;
const SPATIAL_CELL_M: f64 = 25.0;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum HeightError {
    #[error("xodr_elevation_invalid:{0}")]
    Invalid(String),
    #[error("xodr_elevation_duplicate_road:{0}")]
    DuplicateRoad(i64),
    #[error("xodr_elevation_no_roads")]
    NoRoads,
    #[error("xodr_elevation_topology_mismatch:{0}")]
    TopologyMismatch(String),
    #[error("xodr_elevation_degenerate_lane:{0}")]
    DegenerateLane(String),
    #[error("xodr_elevation_non_finite_position")]
    NonFinitePosition,
    #[error("xodr_elevation_unresolvable{label}:x={x:.1}:y={y:.1}:bound={bound}m")]
    Unresolvable {
        label: String,
        x: f64,
        y: f64,
        bound: f64,
    },
    #[error("xodr_elevation_ambiguous{label}:{best}:{other}")]
    Ambiguous {
        label: String,
        best: String,
        other: String,
    },
    #[error("xodr_elevation_non_finite_surface:{0}")]
    NonFiniteSurface(String),
    #[error("topology: {0}")]
    Topology(String),
}

/// Identity of a height source; `digest` enters the timeline key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeightSource {
    pub kind: String,
    /// sha256 of the source `.xodr` bytes (equals the trace's
    /// `engineGraphDigest`); absent for `flat/v1`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xodr_sha256: Option<String>,
    /// `source.xodrSha256` recorded by the topology sidecar; absent for flat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topology_digest: Option<String>,
    /// Constant elevation of a `flat/v1` source, or `z0` of a `plane/v1`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flat_z_m: Option<f64>,
    /// `[gx, gy]` slopes of a `plane/v1` source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plane_gradient: Option<[f64; 2]>,
    /// `sha256(canonicalJson({kind, xodrSha256?, topologyDigest?, flatZM?}))`.
    pub digest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeightSourceDigestInput<'a> {
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    xodr_sha256: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    topology_digest: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flat_z_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plane_gradient: Option<[f64; 2]>,
}

impl HeightSource {
    fn new(
        kind: &str,
        xodr_sha256: Option<String>,
        topology_digest: Option<String>,
        flat_z_m: Option<f64>,
        plane_gradient: Option<[f64; 2]>,
    ) -> Self {
        let digest = content_hash_of(&HeightSourceDigestInput {
            kind,
            xodr_sha256: xodr_sha256.as_deref(),
            topology_digest: topology_digest.as_deref(),
            flat_z_m,
            plane_gradient,
        })
        .expect("height source digest input is always finite JSON");
        Self {
            kind: kind.to_owned(),
            xodr_sha256,
            topology_digest,
            flat_z_m,
            plane_gradient,
            digest,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Poly3 {
    s: f64,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
}

#[derive(Debug, Clone)]
struct RoadProfile {
    length: f64,
    section_starts: Vec<f64>,
    elevations: Vec<Poly3>,
}

#[derive(Debug, Clone)]
struct LaneRecord {
    rsl: String,
    points: Vec<Vec2>,
    cum: Vec<f64>,
    road_id: i64,
    section_start: f64,
    section_end: f64,
    driving: bool,
    widths: Vec<(f64, f64)>,
    fallback_width_m: f64,
}

/// XODR elevation projected onto lane topology.
#[derive(Debug, Clone)]
pub struct XodrHeightField {
    profiles: BTreeMap<i64, RoadProfile>,
    lanes: Vec<LaneRecord>,
    cells: BTreeMap<(i64, i64), Vec<usize>>,
    road_neighbors: BTreeMap<i64, BTreeSet<i64>>,
}

/// The one height source a timeline is baked from.
#[derive(Debug, Clone)]
pub enum HeightField {
    Xodr {
        field: Box<XodrHeightField>,
        source: HeightSource,
    },
    Flat {
        z_m: f64,
        source: HeightSource,
    },
    Plane {
        z0_m: f64,
        gradient: [f64; 2],
        source: HeightSource,
    },
}

/// Query options for one elevation lookup.
#[derive(Debug, Clone, Copy, Default)]
pub struct HeightQuery<'a> {
    /// Roads the body is known to be on (e.g. its `laneRsl` road this tick);
    /// they win over overlapping decks exactly like the exporter's
    /// `preferredRoadsByActor`.
    pub preferred_road: Option<i64>,
    /// Label for errors (actor id).
    pub label: Option<&'a str>,
}

impl HeightField {
    /// Build from the map's `.xodr` bytes and its topology sidecar
    /// (plain or gzipped JSON).
    pub fn from_xodr(xodr: &[u8], topology: &[u8]) -> Result<Self, HeightError> {
        let topology =
            TopologyIndex::decode(topology).map_err(|e| HeightError::Topology(e.to_string()))?;
        Self::from_xodr_topology(xodr, &topology)
    }

    pub fn from_xodr_topology(xodr: &[u8], topology: &TopologyIndex) -> Result<Self, HeightError> {
        let text = std::str::from_utf8(xodr)
            .map_err(|_| HeightError::Invalid("xodr is not UTF-8".to_owned()))?;
        let field = XodrHeightField::build(text, topology)?;
        let digest = topology.topology_digest();
        let source = HeightSource::new(
            XODR_ELEVATION_KIND,
            Some(sha256_bytes(xodr)),
            (!digest.is_empty()).then(|| digest.to_owned()),
            None,
            None,
        );
        Ok(HeightField::Xodr {
            field: Box::new(field),
            source,
        })
    }

    /// A constant surface. Only for maps with no elevation data and tests;
    /// its digest differs from any XODR source, so it never aliases one.
    pub fn flat(z_m: f64) -> Self {
        let z_m = if z_m.is_finite() { z_m } else { 0.0 };
        HeightField::Flat {
            z_m,
            source: HeightSource::new(FLAT_KIND, None, None, Some(z_m), None),
        }
    }

    /// A synthetic plane `z = z0 + gx*x + gy*y` (tests, identity corpus).
    pub fn plane(z0_m: f64, gx: f64, gy: f64) -> Self {
        HeightField::Plane {
            z0_m,
            gradient: [gx, gy],
            source: HeightSource::new(PLANE_KIND, None, None, Some(z0_m), Some([gx, gy])),
        }
    }

    pub fn source(&self) -> &HeightSource {
        match self {
            HeightField::Xodr { source, .. }
            | HeightField::Flat { source, .. }
            | HeightField::Plane { source, .. } => source,
        }
    }

    /// Road-surface elevation (xodr-local z, metres) at `(x, y)`.
    pub fn elevation(&self, x: f64, y: f64, query: HeightQuery<'_>) -> Result<f64, HeightError> {
        match self {
            HeightField::Flat { z_m, .. } => {
                if !x.is_finite() || !y.is_finite() {
                    return Err(HeightError::NonFinitePosition);
                }
                Ok(*z_m)
            }
            HeightField::Plane { z0_m, gradient, .. } => {
                if !x.is_finite() || !y.is_finite() {
                    return Err(HeightError::NonFinitePosition);
                }
                Ok(z0_m + gradient[0] * x + gradient[1] * y)
            }
            HeightField::Xodr { field, .. } => field.elevation(x, y, query),
        }
    }
}

/* ------------------------------------------------------------------ parse */

/// Attributes of one start tag body (`name="v" ...`), in source order.
fn attrs(tag: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let bytes = tag.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // name: [A-Za-z_][\w.-]*
        if !(bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b'.' | b'-'))
        {
            i += 1;
        }
        let name = &tag[start..i];
        let mut j = i;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b'=' {
            continue;
        }
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() || !(bytes[j] == b'"' || bytes[j] == b'\'') {
            i = j;
            continue;
        }
        let quote = bytes[j];
        let value_start = j + 1;
        let Some(len) = tag[value_start..].bytes().position(|b| b == quote) else {
            break;
        };
        out.insert(
            name.to_owned(),
            tag[value_start..value_start + len].to_owned(),
        );
        i = value_start + len + 1;
    }
    out
}

fn finite(value: Option<&String>, label: &str) -> Result<f64, HeightError> {
    value
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .ok_or_else(|| HeightError::Invalid(label.to_owned()))
}

/// Every `<tag ...>` start-tag attribute body inside `text`, in order.
fn start_tags<'a>(text: &'a str, tag: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let open = format!("<{tag}");
    let mut rest = text;
    std::iter::from_fn(move || loop {
        let at = rest.find(&open)?;
        let after = &rest[at + open.len()..];
        // `\b` in the reference regex: the next byte must not continue the name.
        let boundary = after
            .bytes()
            .next()
            .is_none_or(|b| !(b.is_ascii_alphanumeric() || b == b'_'));
        let end = after.find('>')?;
        rest = &after[end + 1..];
        if boundary {
            return Some(&after[..end]);
        }
    })
}

fn parse_profiles(xodr: &str) -> Result<BTreeMap<i64, RoadProfile>, HeightError> {
    let mut result = BTreeMap::new();
    let mut rest = xodr;
    while let Some(at) = rest.find("<road") {
        let after = &rest[at + "<road".len()..];
        let boundary = after
            .bytes()
            .next()
            .is_some_and(|b| !(b.is_ascii_alphanumeric() || b == b'_'));
        if !boundary {
            rest = after;
            continue;
        }
        let Some(head_end) = after.find('>') else {
            break;
        };
        let head = &after[..head_end];
        let Some(close) = after[head_end + 1..].find("</road>") else {
            break;
        };
        let body = &after[head_end + 1..head_end + 1 + close];
        rest = &after[head_end + 1 + close + "</road>".len()..];

        let road = attrs(head);
        let id_f = finite(road.get("id"), "road.id")?;
        let id = id_f as i64;
        let length = finite(road.get("length"), &format!("road.{id}.length"))?;
        let mut section_starts = start_tags(body, "laneSection")
            .map(|t| finite(attrs(t).get("s"), &format!("road.{id}.laneSection.s")))
            .collect::<Result<Vec<_>, _>>()?;
        section_starts.sort_by(f64::total_cmp);
        let mut elevations = start_tags(body, "elevation")
            .map(|t| {
                let v = attrs(t);
                Ok(Poly3 {
                    s: finite(v.get("s"), &format!("road.{id}.elevation.s"))?,
                    a: finite(v.get("a"), &format!("road.{id}.elevation.a"))?,
                    b: finite(v.get("b"), &format!("road.{id}.elevation.b"))?,
                    c: finite(v.get("c"), &format!("road.{id}.elevation.c"))?,
                    d: finite(v.get("d"), &format!("road.{id}.elevation.d"))?,
                })
            })
            .collect::<Result<Vec<_>, HeightError>>()?;
        // Stable, like Array.prototype.sort.
        elevations.sort_by(|a, b| a.s.total_cmp(&b.s));
        if result.contains_key(&id) {
            return Err(HeightError::DuplicateRoad(id));
        }
        result.insert(
            id,
            RoadProfile {
                length,
                section_starts,
                elevations,
            },
        );
    }
    if result.is_empty() {
        return Err(HeightError::NoRoads);
    }
    Ok(result)
}

fn evaluate(records: &[Poly3], s: f64) -> f64 {
    let Some(first) = records.first() else {
        return 0.0;
    };
    let mut record = *first;
    for candidate in records {
        if candidate.s > s {
            break;
        }
        record = *candidate;
    }
    let ds = s - record.s;
    record.a + record.b * ds + record.c * pow(ds, 2.0) + record.d * pow(ds, 3.0)
}

fn width_at(widths: &[(f64, f64)], s: f64, fallback_m: f64) -> f64 {
    if widths.is_empty() {
        return fallback_m;
    }
    let mut before = widths[0];
    let mut after = widths[widths.len() - 1];
    for sample in widths {
        if sample.0 <= s {
            before = *sample;
        }
        if sample.0 >= s {
            after = *sample;
            break;
        }
    }
    if after.0 == before.0 {
        return before.1;
    }
    let t = (s - before.0) / (after.0 - before.0);
    before.1 + (after.1 - before.1) * t
}

struct Projection {
    arc_s: f64,
    sample_fraction: f64,
    d: f64,
}

fn project_sampled_lane(points: &[Vec2], cum: &[f64], x: f64, y: f64) -> Option<Projection> {
    if points.len() < 2 || cum.len() != points.len() {
        return None;
    }
    let mut best: Option<(f64, f64, f64)> = None;
    for index in 1..points.len() {
        let a = points[index - 1];
        let b = points[index];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let length2 = dx * dx + dy * dy;
        let t = if length2 > 0.0 {
            (((x - a.x) * dx + (y - a.y) * dy) / length2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let px = a.x + t * dx;
        let py = a.y + t * dy;
        let d2 = pow(x - px, 2.0) + pow(y - py, 2.0);
        if best.is_none_or(|(_, _, bd2)| d2 < bd2) {
            best = Some((
                cum[index - 1] + t * (cum[index] - cum[index - 1]),
                ((index - 1) as f64 + t) / (points.len() - 1) as f64,
                d2,
            ));
        }
    }
    best.map(|(arc_s, sample_fraction, d2)| Projection {
        arc_s,
        sample_fraction,
        d: d2.sqrt(),
    })
}

fn cell_of(v: f64) -> i64 {
    (v / SPATIAL_CELL_M).floor() as i64
}

impl XodrHeightField {
    fn build(xodr: &str, topology: &TopologyIndex) -> Result<Self, HeightError> {
        let profiles = parse_profiles(xodr)?;
        let mut lanes: Vec<LaneRecord> = Vec::new();
        let mut cells: BTreeMap<(i64, i64), Vec<usize>> = BTreeMap::new();
        let mut road_neighbors: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
        // BTreeMap keys iterate in byte order == JS default sort for ASCII rsl.
        for (rsl, lane) in &topology.lanes {
            let points: Vec<Vec2> = lane.polyline.clone();
            if points.len() < 2 {
                continue;
            }
            let mut cum = vec![0.0];
            for i in 1..points.len() {
                cum.push(
                    cum[i - 1]
                        + hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
                );
            }
            let length_m = *cum.last().expect("non-empty");
            let road = profiles.get(&lane.road_id);
            let section_start = road.and_then(|r| {
                usize::try_from(lane.section)
                    .ok()
                    .and_then(|i| r.section_starts.get(i).copied())
            });
            let (Some(road), Some(section_start)) = (road, section_start) else {
                return Err(HeightError::TopologyMismatch(rsl.to_string()));
            };
            let section_end = usize::try_from(lane.section + 1)
                .ok()
                .and_then(|i| road.section_starts.get(i).copied())
                .unwrap_or(road.length);
            if !(section_end > section_start) || !(length_m > 0.0) {
                return Err(HeightError::DegenerateLane(rsl.to_string()));
            }
            let section_length = section_end - section_start;
            let widths: Vec<(f64, f64)> = lane
                .width_samples
                .iter()
                .filter(|w| w.s <= section_length + LANE_EDGE_TOLERANCE_M)
                .map(|w| (w.s, w.width_m))
                .collect();
            let fallback_width_m = if widths.is_empty() {
                lane.representative_width_m.unwrap_or(3.5)
            } else {
                widths[0].1
            };
            for linked in lane.predecessors.iter().chain(lane.successors.iter()) {
                let linked = linked.to_string();
                if let Some(Ok(linked_road)) = linked.split(':').next().map(str::parse::<f64>) {
                    if linked_road.is_finite() {
                        let linked_road = linked_road as i64;
                        if linked_road != lane.road_id {
                            road_neighbors
                                .entry(lane.road_id)
                                .or_default()
                                .insert(linked_road);
                            road_neighbors
                                .entry(linked_road)
                                .or_default()
                                .insert(lane.road_id);
                        }
                    }
                }
            }
            let max_width = widths.iter().map(|w| w.1).fold(fallback_width_m, f64::max);
            let half_width = max_width / 2.0 + LANE_EDGE_TOLERANCE_M;
            let index = lanes.len();
            for i in 1..points.len() {
                let from = points[i - 1];
                let to = points[i];
                let min_x = cell_of(from.x.min(to.x) - half_width);
                let max_x = cell_of(from.x.max(to.x) + half_width);
                let min_y = cell_of(from.y.min(to.y) - half_width);
                let max_y = cell_of(from.y.max(to.y) + half_width);
                for cx in min_x..=max_x {
                    for cy in min_y..=max_y {
                        let members = cells.entry((cx, cy)).or_default();
                        if members.last() != Some(&index) {
                            members.push(index);
                        }
                    }
                }
            }
            lanes.push(LaneRecord {
                rsl: rsl.to_string(),
                points,
                cum,
                road_id: lane.road_id,
                section_start,
                section_end,
                driving: lane.lane_type == "driving",
                widths,
                fallback_width_m,
            });
        }
        // A lane pushed into a cell twice (non-consecutive segments) must
        // appear once, like the reference Set.
        for members in cells.values_mut() {
            let mut seen = BTreeSet::new();
            members.retain(|m| seen.insert(*m));
        }
        Ok(Self {
            profiles,
            lanes,
            cells,
            road_neighbors,
        })
    }

    fn roads_continuous(&self, a: i64, b: i64) -> bool {
        if a == b {
            return true;
        }
        let (Some(an), Some(bn)) = (self.road_neighbors.get(&a), self.road_neighbors.get(&b))
        else {
            return false;
        };
        if an.contains(&b) || bn.contains(&a) {
            return true;
        }
        an.iter().any(|r| bn.contains(r))
    }

    fn lane_elevation(&self, lane: &LaneRecord, sample_fraction: f64) -> f64 {
        let road = &self.profiles[&lane.road_id];
        let road_s = lane.section_start + sample_fraction * (lane.section_end - lane.section_start);
        evaluate(&road.elevations, road_s)
    }

    pub fn elevation(&self, x: f64, y: f64, query: HeightQuery<'_>) -> Result<f64, HeightError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(HeightError::NonFinitePosition);
        }
        struct Candidate<'l> {
            rsl: &'l str,
            d: f64,
            elevation: f64,
            driving: bool,
            road_id: i64,
        }
        let mut candidates: Vec<Candidate<'_>> = Vec::new();
        if let Some(nearby) = self.cells.get(&(cell_of(x), cell_of(y))) {
            for &index in nearby {
                let lane = &self.lanes[index];
                let Some(p) = project_sampled_lane(&lane.points, &lane.cum, x, y) else {
                    continue;
                };
                if p.d
                    > width_at(&lane.widths, p.arc_s, lane.fallback_width_m) / 2.0
                        + LANE_EDGE_TOLERANCE_M
                {
                    continue;
                }
                candidates.push(Candidate {
                    rsl: &lane.rsl,
                    d: p.d,
                    elevation: self.lane_elevation(lane, p.sample_fraction),
                    driving: lane.driving,
                    road_id: lane.road_id,
                });
            }
        }
        let mut tier: Vec<&Candidate<'_>> = candidates.iter().filter(|c| c.driving).collect();
        if tier.is_empty() {
            tier = candidates.iter().collect();
        }
        if let Some(road) = query.preferred_road {
            let on_route: Vec<&Candidate<'_>> =
                tier.iter().copied().filter(|c| c.road_id == road).collect();
            if !on_route.is_empty() {
                tier = on_route;
            }
        }
        tier.sort_by(|a, b| {
            a.d.partial_cmp(&b.d)
                .unwrap_or(Ordering::Equal)
                .then_with(|| cmp_locale(a.rsl, b.rsl))
        });
        let label = query.label.map(|l| format!(":{l}")).unwrap_or_default();
        let Some(best) = tier.first() else {
            let (cx, cy) = (cell_of(x), cell_of(y));
            let mut nearest: Option<(f64, &str, f64)> = None;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    let Some(members) = self.cells.get(&(cx + dx, cy + dy)) else {
                        continue;
                    };
                    for &index in members {
                        let lane = &self.lanes[index];
                        let Some(p) = project_sampled_lane(&lane.points, &lane.cum, x, y) else {
                            continue;
                        };
                        let elevation = self.lane_elevation(lane, p.sample_fraction);
                        let better = match nearest {
                            None => true,
                            Some((d, rsl, _)) => {
                                p.d < d || (p.d == d && cmp_locale(&lane.rsl, rsl).is_lt())
                            }
                        };
                        if better {
                            nearest = Some((p.d, &lane.rsl, elevation));
                        }
                    }
                }
            }
            return match nearest {
                Some((d, _, elevation)) if d <= OFF_NETWORK_BOUND_M => Ok(elevation),
                _ => Err(HeightError::Unresolvable {
                    label,
                    x,
                    y,
                    bound: OFF_NETWORK_BOUND_M,
                }),
            };
        };
        if let Some(conflicting) = tier.iter().find(|c| {
            !std::ptr::eq(**c, *best)
                && (c.d - best.d).abs() <= AMBIGUOUS_DISTANCE_EPSILON_M
                && (c.elevation - best.elevation).abs() > DISTINCT_SURFACE_EPSILON_M
                && !((c.elevation - best.elevation).abs() <= CONTINUOUS_SURFACE_MAX_GAP_M
                    && self.roads_continuous(best.road_id, c.road_id))
        }) {
            return Err(HeightError::Ambiguous {
                label,
                best: best.rsl.to_owned(),
                other: conflicting.rsl.to_owned(),
            });
        }
        if !best.elevation.is_finite() {
            return Err(HeightError::NonFiniteSurface(best.rsl.to_owned()));
        }
        Ok(best.elevation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XODR: &str = r#"<OpenDRIVE>
      <road name="r" length="100.0" id="1" junction="-1">
        <elevationProfile>
          <elevation s="0" a="10" b="0.1" c="0" d="0"/>
          <elevation s="50" a="15" b="0" c="0.001" d="0"/>
        </elevationProfile>
        <lanes><laneSection s="0"><center/></laneSection></lanes>
      </road>
    </OpenDRIVE>"#;

    fn topology() -> TopologyIndex {
        TopologyIndex::from_json_slice(
            br#"{"lanes":{"1:0:-1":{"rsl":"1:0:-1","roadId":1,"section":0,"laneId":-1,
            "laneType":"driving","widthSamples":[{"s":0,"widthM":3.5}],
            "polyline":[[0,0],[50,0],[100,0]]}},"gates":[],"junctions":{},
            "source":{"xodrSha256":"abc"}}"#,
        )
        .unwrap()
    }

    #[test]
    fn evaluates_the_profile_along_the_lane() {
        let field = HeightField::from_xodr_topology(XODR.as_bytes(), &topology()).unwrap();
        let q = HeightQuery::default();
        assert!((field.elevation(0.0, 0.0, q).unwrap() - 10.0).abs() < 1e-12);
        assert!((field.elevation(25.0, 1.0, q).unwrap() - 12.5).abs() < 1e-12);
        assert!((field.elevation(60.0, -1.0, q).unwrap() - 15.1).abs() < 1e-12);
        // Off the ribbon but within 25 m: nearest lane surface.
        assert!((field.elevation(25.0, 10.0, q).unwrap() - 12.5).abs() < 1e-12);
        assert!(matches!(
            field.elevation(25.0, 60.0, q),
            Err(HeightError::Unresolvable { .. })
        ));
        let source = field.source();
        assert_eq!(source.kind, XODR_ELEVATION_KIND);
        assert_eq!(source.topology_digest.as_deref(), Some("abc"));
        assert_eq!(
            source.xodr_sha256.as_deref(),
            Some(sha256_bytes(XODR.as_bytes()).as_str())
        );
    }

    #[test]
    fn flat_and_xodr_sources_never_share_a_digest() {
        let flat = HeightField::flat(0.0);
        let xodr = HeightField::from_xodr_topology(XODR.as_bytes(), &topology()).unwrap();
        assert_ne!(flat.source().digest, xodr.source().digest);
        assert_ne!(flat.source().digest, HeightField::flat(1.0).source().digest);
    }

    #[test]
    fn attribute_scanner_matches_quoted_values() {
        let a = attrs(r#" s="1.5e+01" a='2' b = "3"  data-x="y""#);
        assert_eq!(a["s"], "1.5e+01");
        assert_eq!(a["a"], "2");
        assert_eq!(a["b"], "3");
        assert_eq!(a["data-x"], "y");
    }
}
