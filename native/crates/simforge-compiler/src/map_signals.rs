//! Physical map traffic-signal binding.
//!
//! RoadRunner's OpenDRIVE files provide physical head ids, controller
//! membership, junction/controller sequence order and concrete gate geometry,
//! but not authoritative phase durations. The real ids and movement bindings
//! are preserved while the deterministic timing plan is marked
//! `synthetic-default`. An unsignalized map yields an empty catalog and the
//! materializer does not invent signal programs for it.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::Value;
use simforge_core::map::{LaneGraph, TopologyGate, TopologyIndex};
use simforge_core::types::{
    ControlBindingSource, ControlIndication, ControllerHeadGroup, RoadControl, RoadControlKind,
    RoadControlMapBinding, SignalMapBinding, SignalPhase, SignalProgram, StopLine, TimingSource,
};

use crate::anchor::{flip_relation, MatchedSite};
use crate::map_index::DerivedMapIndex;
use crate::template::{ApproachRelation, SignalApproach};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSignalHead {
    pub id: String,
    pub road_id: String,
    pub s: f64,
    pub dynamic: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapRoadControlHead {
    pub id: String,
    pub road_id: String,
    pub s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSpeedLimitHead {
    pub id: String,
    pub road_id: String,
    pub s: f64,
    pub speed_limit_kph: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicabilitySource {
    Signal,
    SignalReference,
}

/// OpenDRIVE lane applicability for a physical signal head.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSignalApplicability {
    pub head_id: String,
    pub road_id: String,
    pub from_lane: Option<i64>,
    pub to_lane: Option<i64>,
    pub source: ApplicabilitySource,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSignalController {
    pub id: String,
    pub sequence: f64,
    pub signal_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSignalJunction {
    pub junction_id: String,
    pub controller_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSignalCatalog {
    pub heads: Vec<MapSignalHead>,
    pub road_controls: Vec<MapRoadControlHead>,
    pub speed_limits: Vec<MapSpeedLimitHead>,
    pub applicability: Vec<MapSignalApplicability>,
    pub controllers: Vec<MapSignalController>,
    pub junctions: Vec<MapSignalJunction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanTimingSource {
    SyntheticDefault,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanStateSource {
    SyntheticCycle,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSignalPlan {
    pub junction_id: Option<String>,
    pub programs: Vec<SignalProgram>,
    /// Physical map head id → concrete engine program id.
    pub program_by_head_id: BTreeMap<String, String>,
    /// Junction connecting lane → concrete engine program ids.
    pub programs_by_connecting_lane: BTreeMap<String, Vec<String>>,
    pub timing_source: PlanTimingSource,
    pub state_source: PlanStateSource,
}

impl SiteSignalPlan {
    fn none(junction_id: Option<String>) -> Self {
        Self {
            junction_id,
            programs: Vec::new(),
            program_by_head_id: BTreeMap::new(),
            programs_by_connecting_lane: BTreeMap::new(),
            timing_source: PlanTimingSource::None,
            state_source: PlanStateSource::None,
        }
    }

    pub fn program(&self, id: &str) -> Option<&SignalProgram> {
        self.programs.iter().find(|p| p.id == id)
    }
}

/// Map-wide physical controls used by the scenario-independent ambient world.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapControlPlan {
    pub signal_programs: Vec<SignalProgram>,
    pub road_controls: Vec<RoadControl>,
}

/// Common junction-cycle offset: keeps every head synchronised.
pub const SYNTHETIC_SIGNAL_OFFSET_S: f64 = 23.0;

/* ----------------------------------------------------------- xodr scanning */

/// Parse `name="value"` attribute pairs from an element's attribute text.
fn attrs(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_alphabetic() || c == b'_' || c == b':' {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric()
                    || matches!(bytes[i], b'_' | b'.' | b':' | b'-'))
            {
                i += 1;
            }
            let name = &text[start..i];
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'=' {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'"' {
                    let vstart = j + 1;
                    if let Some(rel) = text[vstart..].find('"') {
                        out.insert(name.to_owned(), text[vstart..vstart + rel].to_owned());
                        i = vstart + rel + 1;
                        continue;
                    }
                }
            }
            continue;
        }
        i += 1;
    }
    out
}

/// Byte offset just past the matching `>` of the tag starting at `open`.
fn tag_end(text: &str, open: usize) -> Option<usize> {
    text[open..].find('>').map(|rel| open + rel + 1)
}

/// Byte range of the first whole `</name>` (optional whitespace before `>`)
/// at or after `from`. A prefix-only match such as `</roadMark>` for `road`
/// would truncate the element body before its later children.
fn close_tag_range(text: &str, from: usize, close_tag: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut cursor = from;
    while let Some(rel) = text[cursor..].find(close_tag) {
        let start = cursor + rel;
        let mut end = start + close_tag.len();
        while end < bytes.len() && bytes[end].is_ascii_whitespace() {
            end += 1;
        }
        if bytes.get(end) == Some(&b'>') {
            return Some((start, end + 1));
        }
        cursor = start + close_tag.len();
    }
    None
}

/// `<name ...>body</name>` and `<name .../>` elements, non-nested scan.
/// Yields `(attrs, body)`; a self-closing element has `body == None`.
fn elements<'a>(text: &'a str, name: &str) -> Vec<(&'a str, Option<&'a str>)> {
    let open_tag = format!("<{name}");
    let close_tag = format!("</{name}");
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(rel) = text[cursor..].find(&open_tag) {
        let open = cursor + rel;
        let after = open + open_tag.len();
        // Must be a whole tag name: next char is whitespace, `>` or `/`.
        let boundary = text.as_bytes().get(after).copied();
        if !matches!(
            boundary,
            Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'>') | Some(b'/')
        ) {
            cursor = after;
            continue;
        }
        let Some(head_end) = tag_end(text, open) else {
            break;
        };
        let head = &text[after..head_end - 1];
        if head.trim_end().ends_with('/') {
            let attr_text = head.trim_end().trim_end_matches('/');
            out.push((attr_text, None));
            cursor = head_end;
            continue;
        }
        let Some((close, close_end)) = close_tag_range(text, head_end, &close_tag) else {
            break;
        };
        out.push((head, Some(&text[head_end..close])));
        cursor = close_end;
    }
    out
}

/// Self-closing or paired elements; `body` is empty for self-closing ones.
fn paired_elements<'a>(text: &'a str, name: &str) -> Vec<(&'a str, &'a str)> {
    elements(text, name)
        .into_iter()
        .map(|(a, body)| (a, body.unwrap_or("")))
        .collect()
}

/// Self-closing or paired `<name .../>` elements; only attributes matter.
fn any_elements<'a>(text: &'a str, name: &str) -> Vec<&'a str> {
    elements(text, name).into_iter().map(|(a, _)| a).collect()
}

fn finite(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|v| v.is_finite()).unwrap_or(fallback),
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .unwrap_or(fallback),
        _ => fallback,
    }
}

fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// Parse the controller seam from the OpenDRIVE text and the signals GeoJSON.
pub fn parse_map_signal_catalog(xodr: &str, geojson: &Value) -> MapSignalCatalog {
    let features: Vec<&Value> = geojson
        .get("features")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let props = |f: &&Value| f.get("properties").cloned().unwrap_or(Value::Null);

    let mut heads: Vec<MapSignalHead> = features
        .iter()
        .filter_map(|f| {
            let p = props(f);
            if p.get("signal_category").and_then(Value::as_str) != Some("traffic_light") {
                return None;
            }
            let dynamic = matches!(p.get("dynamic"), Some(Value::String(s)) if s == "yes")
                || p.get("dynamic").and_then(Value::as_bool) == Some(true);
            if !dynamic {
                return None;
            }
            let id = text_of(p.get("id"));
            let road_id = text_of(p.get("road_id"));
            if id.is_empty() || road_id.is_empty() {
                return None;
            }
            Some(MapSignalHead {
                id,
                road_id,
                s: finite(p.get("s"), 0.0),
                dynamic: true,
            })
        })
        .collect();
    heads.sort_by(|a, b| a.id.cmp(&b.id));

    let mut road_controls: Vec<MapRoadControlHead> = features
        .iter()
        .filter_map(|f| {
            let p = props(f);
            if p.get("signal_category").and_then(Value::as_str) != Some("stop_sign") {
                return None;
            }
            let id = text_of(p.get("id"));
            let road_id = text_of(p.get("road_id"));
            if id.is_empty() || road_id.is_empty() {
                return None;
            }
            Some(MapRoadControlHead {
                id,
                road_id,
                s: finite(p.get("s"), 0.0),
            })
        })
        .collect();
    road_controls.sort_by(|a, b| a.id.cmp(&b.id));

    let mut speed_limits: Vec<MapSpeedLimitHead> = features
        .iter()
        .filter_map(|f| {
            let p = props(f);
            if p.get("signal_category").and_then(Value::as_str) != Some("speed_limit_sign") {
                return None;
            }
            let id = text_of(p.get("id"));
            let road_id = text_of(p.get("road_id"));
            let mph = finite(p.get("speed_limit_mph"), f64::NAN);
            let kph = finite(p.get("speed_limit_kph"), f64::NAN);
            let speed_limit_kph = if kph.is_finite() && kph > 0.0 {
                kph
            } else {
                mph * 1.609344
            };
            if id.is_empty()
                || road_id.is_empty()
                || !speed_limit_kph.is_finite()
                || speed_limit_kph <= 0.0
            {
                return None;
            }
            Some(MapSpeedLimitHead {
                id,
                road_id,
                s: finite(p.get("s"), 0.0),
                speed_limit_kph,
            })
        })
        .collect();
    speed_limits.sort_by(|a, b| {
        a.road_id
            .cmp(&b.road_id)
            .then(a.s.partial_cmp(&b.s).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.id.cmp(&b.id))
    });

    let dynamic_head_ids: BTreeSet<&str> = heads.iter().map(|h| h.id.as_str()).collect();
    let mut applicability: Vec<MapSignalApplicability> = Vec::new();
    for (road_attrs, road_body) in paired_elements(xodr, "road") {
        let Some(road_id) = attrs(road_attrs).get("id").cloned() else {
            continue;
        };
        for (kind, element_name) in [
            (ApplicabilitySource::Signal, "signal"),
            (ApplicabilitySource::SignalReference, "signalReference"),
        ] {
            for (sig_attrs, sig_body) in paired_elements(road_body, element_name) {
                let Some(head_id) = attrs(sig_attrs).get("id").cloned() else {
                    continue;
                };
                if !dynamic_head_ids.contains(head_id.as_str()) {
                    continue;
                }
                let validities: Vec<(i64, i64)> = any_elements(sig_body, "validity")
                    .into_iter()
                    .map(attrs)
                    .filter_map(|a| {
                        Some((
                            a.get("fromLane")?.trim().parse::<i64>().ok()?,
                            a.get("toLane")?.trim().parse::<i64>().ok()?,
                        ))
                    })
                    .collect();
                if validities.is_empty() {
                    applicability.push(MapSignalApplicability {
                        head_id,
                        road_id: road_id.clone(),
                        from_lane: None,
                        to_lane: None,
                        source: kind,
                    });
                } else {
                    for (from_lane, to_lane) in validities {
                        applicability.push(MapSignalApplicability {
                            head_id: head_id.clone(),
                            road_id: road_id.clone(),
                            from_lane: Some(from_lane),
                            to_lane: Some(to_lane),
                            source: kind,
                        });
                    }
                }
            }
        }
    }
    applicability.sort_by(|a, b| {
        a.head_id
            .cmp(&b.head_id)
            .then(a.road_id.cmp(&b.road_id))
            .then(
                a.from_lane
                    .unwrap_or(i64::MIN)
                    .cmp(&b.from_lane.unwrap_or(i64::MIN)),
            )
            .then(
                a.to_lane
                    .unwrap_or(i64::MAX)
                    .cmp(&b.to_lane.unwrap_or(i64::MAX)),
            )
            .then(a.source.cmp(&b.source))
    });
    applicability.dedup();

    // Controller definitions are paired `<controller>…</controller>` elements
    // carrying `<control>` children; the self-closing `<controller .../>`
    // inside `<junction>` are references and must not become empty duplicates.
    let mut controllers: Vec<MapSignalController> = elements(xodr, "controller")
        .into_iter()
        .filter_map(|(a, body)| {
            let body = body?;
            let a = attrs(a);
            let id = a.get("id")?.clone();
            let mut signal_ids: BTreeSet<String> = BTreeSet::new();
            for control in any_elements(body, "control") {
                if let Some(s) = attrs(control).get("signalId") {
                    signal_ids.insert(s.clone());
                }
            }
            let sequence = a
                .get("sequence")
                .and_then(|s| s.trim().parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .unwrap_or(0.0);
            Some(MapSignalController {
                id,
                sequence,
                signal_ids: signal_ids.into_iter().collect(),
            })
        })
        .collect();
    controllers.sort_by(|a, b| {
        a.sequence
            .partial_cmp(&b.sequence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.id.cmp(&b.id))
    });

    let mut junctions: Vec<MapSignalJunction> = paired_elements(xodr, "junction")
        .into_iter()
        .filter_map(|(a, body)| {
            let id = attrs(a).get("id")?.clone();
            let mut controller_ids: Vec<String> = Vec::new();
            for c in any_elements(body, "controller") {
                if let Some(cid) = attrs(c).get("id") {
                    if !controller_ids.contains(cid) {
                        controller_ids.push(cid.clone());
                    }
                }
            }
            (!controller_ids.is_empty()).then_some(MapSignalJunction {
                junction_id: id,
                controller_ids,
            })
        })
        .collect();
    junctions.sort_by(|a, b| a.junction_id.cmp(&b.junction_id));

    MapSignalCatalog {
        heads,
        road_controls,
        speed_limits,
        applicability,
        controllers,
        junctions,
    }
}

/// Apply physical speed-limit signs before the lane graph is built: one posted
/// value per OpenDRIVE road, the lowest sign wins.
pub fn topology_with_map_speed_limits(
    topology: &mut TopologyIndex,
    catalog: &MapSignalCatalog,
) -> bool {
    let mut by_road: BTreeMap<String, f64> = BTreeMap::new();
    for sign in &catalog.speed_limits {
        let entry = by_road
            .entry(sign.road_id.clone())
            .or_insert(sign.speed_limit_kph);
        if sign.speed_limit_kph < *entry {
            *entry = sign.speed_limit_kph;
        }
    }
    if by_road.is_empty() {
        return false;
    }
    let mut changed = false;
    for lane in topology.lanes.values_mut() {
        let Some(limit) = by_road.get(&lane.road_id.to_string()) else {
            continue;
        };
        if (lane.speed_limit_kph.unwrap_or(0.0) - limit).abs() < 1e-9 {
            continue;
        }
        lane.speed_limit_kph = Some(*limit);
        changed = true;
    }
    changed
}

fn coalesce(phases: Vec<SignalPhase>) -> Vec<SignalPhase> {
    let mut out: Vec<SignalPhase> = Vec::new();
    for phase in phases {
        match out.last_mut() {
            Some(prev) if prev.phase == phase.phase => prev.duration_s += phase.duration_s,
            _ => out.push(phase),
        }
    }
    out
}

/// Deterministic fallback cycle derived from controller sequence membership.
pub fn default_phases_for_head(
    head_id: &str,
    controllers: &[MapSignalController],
) -> Vec<SignalPhase> {
    if controllers.len() <= 1 {
        return vec![
            SignalPhase {
                phase: ControlIndication::Green,
                duration_s: 27.0,
            },
            SignalPhase {
                phase: ControlIndication::Yellow,
                duration_s: 3.0,
            },
            SignalPhase {
                phase: ControlIndication::Red,
                duration_s: 30.0,
            },
        ];
    }
    let mut raw = Vec::new();
    for index in 0..controllers.len() {
        let active = controllers[index].signal_ids.iter().any(|s| s == head_id);
        let next_active = controllers[(index + 1) % controllers.len()]
            .signal_ids
            .iter()
            .any(|s| s == head_id);
        if !active {
            raw.push(SignalPhase {
                phase: ControlIndication::Red,
                duration_s: 15.0,
            });
        } else if next_active {
            raw.push(SignalPhase {
                phase: ControlIndication::Green,
                duration_s: 15.0,
            });
        } else {
            raw.push(SignalPhase {
                phase: ControlIndication::Green,
                duration_s: 12.0,
            });
            raw.push(SignalPhase {
                phase: ControlIndication::Yellow,
                duration_s: 3.0,
            });
        }
    }
    coalesce(raw)
}

/// Browser-safe structural subset needed to bind map controls.
pub struct SignalMapView<'a> {
    pub index: &'a DerivedMapIndex,
    pub graph: &'a LaneGraph,
    pub topology: &'a TopologyIndex,
    pub signal_catalog: &'a MapSignalCatalog,
}

fn stop_line_for(view: &SignalMapView<'_>, gate: &TopologyGate) -> Option<StopLine> {
    let lane = view.graph.lane_id(&gate.approach_lane_rsl)?;
    let length_m = view.graph.length_of(lane);
    let reversed = view.graph.nominal_reversed(lane).unwrap_or(false);
    Some(StopLine {
        rsl: gate.approach_lane_rsl.clone(),
        // One metre before the downstream endpoint, expressed in storage s.
        s: if reversed {
            length_m.min(1.0)
        } else {
            (length_m - 1.0).max(0.0)
        },
        connecting_lane_rsls: vec![gate.connecting_lane_rsl.clone()],
    })
}

fn application_includes_lane(
    application: &MapSignalApplicability,
    lane: Option<&simforge_core::map::TopologyLane>,
) -> bool {
    let Some(lane) = lane else { return false };
    if lane.road_id.to_string() != application.road_id {
        return false;
    }
    let (Some(from), Some(to)) = (application.from_lane, application.to_lane) else {
        return true;
    };
    let (low, high) = (from.min(to), from.max(to));
    lane.lane_id >= low && lane.lane_id <= high
}

fn gates_for_head<'g>(
    view: &SignalMapView<'_>,
    gates: &[&'g TopologyGate],
    head_id: &str,
) -> Vec<&'g TopologyGate> {
    let applications: Vec<&MapSignalApplicability> = view
        .signal_catalog
        .applicability
        .iter()
        .filter(|a| a.head_id == head_id)
        .collect();
    let mut out: Vec<&TopologyGate> = gates
        .iter()
        .copied()
        .filter(|gate| {
            let connecting = view.topology.lanes.get(&gate.connecting_lane_rsl);
            let approach = view.topology.lanes.get(&gate.approach_lane_rsl);
            applications.iter().any(|a| {
                application_includes_lane(a, connecting) || application_includes_lane(a, approach)
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn dedup_stop_lines(mut lines: Vec<StopLine>) -> Vec<StopLine> {
    lines.sort_by(|a, b| {
        a.rsl
            .cmp(&b.rsl)
            .then(a.connecting_lane_rsls[0].cmp(&b.connecting_lane_rsls[0]))
    });
    lines.dedup_by(|a, b| a.rsl == b.rsl && a.connecting_lane_rsls[0] == b.connecting_lane_rsls[0]);
    lines
}

/// Bind the site's real map heads/controllers to engine programs and movements.
pub fn build_signal_plan_for_junction(
    view: &SignalMapView<'_>,
    junction_id: Option<&str>,
) -> SiteSignalPlan {
    let Some(junction_id) = junction_id else {
        return SiteSignalPlan::none(None);
    };
    let none = || SiteSignalPlan::none(Some(junction_id.to_owned()));
    let Some(junction) = view
        .signal_catalog
        .junctions
        .iter()
        .find(|j| j.junction_id == junction_id)
    else {
        return none();
    };
    let mut controllers: Vec<&MapSignalController> = junction
        .controller_ids
        .iter()
        .filter_map(|id| view.signal_catalog.controllers.iter().find(|c| &c.id == id))
        .collect();
    controllers.sort_by(|a, b| {
        a.sequence
            .partial_cmp(&b.sequence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.id.cmp(&b.id))
    });
    if controllers.is_empty() {
        return none();
    }
    let owned: Vec<MapSignalController> = controllers.iter().map(|c| (*c).clone()).collect();
    let selected: BTreeSet<&str> = controllers
        .iter()
        .flat_map(|c| c.signal_ids.iter().map(String::as_str))
        .collect();
    let heads: Vec<&MapSignalHead> = view
        .signal_catalog
        .heads
        .iter()
        .filter(|h| selected.contains(h.id.as_str()))
        .collect();
    if heads.is_empty() {
        return none();
    }
    let gates: Vec<&TopologyGate> = view
        .topology
        .gates
        .iter()
        .filter(|g| g.junction_id == junction_id)
        .collect();

    let mut by_signature: BTreeMap<String, Vec<&MapSignalHead>> = BTreeMap::new();
    for head in &heads {
        let signature: Vec<&str> = controllers
            .iter()
            .filter(|c| c.signal_ids.iter().any(|s| s == &head.id))
            .map(|c| c.id.as_str())
            .collect();
        if signature.is_empty() {
            continue;
        }
        by_signature
            .entry(signature.join("\u{0}"))
            .or_default()
            .push(head);
    }
    let mut groups: Vec<Vec<&MapSignalHead>> = by_signature.into_values().collect();
    for g in &mut groups {
        g.sort_by(|a, b| a.id.cmp(&b.id));
    }
    groups.sort_by(|a, b| a[0].id.cmp(&b[0].id));

    let mut program_by_head_id = BTreeMap::new();
    let mut programs_by_connecting_lane: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut programs: Vec<SignalProgram> = Vec::new();
    for group in groups {
        let head_ids: Vec<String> = group.iter().map(|h| h.id.clone()).collect();
        let mut matching: BTreeMap<&str, &TopologyGate> = BTreeMap::new();
        for head in &group {
            for gate in gates_for_head(view, &gates, &head.id) {
                matching.insert(gate.id.as_str(), gate);
            }
        }
        let matching_gates: Vec<&TopologyGate> = matching.into_values().collect();
        let stop_lines = dedup_stop_lines(
            matching_gates
                .iter()
                .filter_map(|g| stop_line_for(view, g))
                .collect(),
        );
        let id = format!("signal:{}", head_ids[0]);
        let owning: Vec<&MapSignalController> = controllers
            .iter()
            .copied()
            .filter(|c| c.signal_ids.iter().any(|s| s == &head_ids[0]))
            .collect();
        programs.push(SignalProgram {
            id: id.clone(),
            phases: default_phases_for_head(&head_ids[0], &owned),
            offset_s: SYNTHETIC_SIGNAL_OFFSET_S,
            loop_: true,
            dark_fallback: None,
            dark_dwell_s: None,
            stop_lines,
            map_binding: Some(SignalMapBinding {
                junction_id: junction_id.to_owned(),
                controller_ids: owning.iter().map(|c| c.id.clone()).collect(),
                head_ids: head_ids.clone(),
                controller_head_groups: Some(
                    owning
                        .iter()
                        .map(|c| ControllerHeadGroup {
                            controller_id: c.id.clone(),
                            head_ids: head_ids.clone(),
                        })
                        .collect(),
                ),
                timing_source: TimingSource::SyntheticDefault,
            }),
        });
        for head_id in &head_ids {
            program_by_head_id.insert(head_id.clone(), id.clone());
        }
        for gate in matching_gates {
            programs_by_connecting_lane
                .entry(gate.connecting_lane_rsl.clone())
                .or_default()
                .push(id.clone());
        }
    }
    for ids in programs_by_connecting_lane.values_mut() {
        ids.sort();
    }
    programs.sort_by(|a, b| a.id.cmp(&b.id));
    SiteSignalPlan {
        junction_id: Some(junction_id.to_owned()),
        programs,
        program_by_head_id,
        programs_by_connecting_lane,
        timing_source: PlanTimingSource::SyntheticDefault,
        state_source: PlanStateSource::SyntheticCycle,
    }
}

pub fn build_site_signal_plan(view: &SignalMapView<'_>, site: &MatchedSite) -> SiteSignalPlan {
    build_signal_plan_for_junction(view, site.origin_junction_id())
}

/// Bind static OpenDRIVE stop-sign furniture to the junction movements whose
/// connecting road carries that sign.
pub fn build_road_controls_for_junction(
    view: &SignalMapView<'_>,
    junction_id: Option<&str>,
) -> Vec<RoadControl> {
    let Some(junction_id) = junction_id else {
        return Vec::new();
    };
    let mut gates: Vec<&TopologyGate> = view
        .topology
        .gates
        .iter()
        .filter(|g| g.junction_id == junction_id)
        .collect();
    gates.sort_by(|a, b| a.id.cmp(&b.id));
    let descriptor = view.index.junction_descriptors.get(junction_id);
    let mut controls: Vec<RoadControl> = Vec::new();
    for head in &view.signal_catalog.road_controls {
        let seed_gates: Vec<&TopologyGate> = gates
            .iter()
            .copied()
            .filter(|gate| {
                let connecting_road = view
                    .topology
                    .lanes
                    .get(&gate.connecting_lane_rsl)
                    .map(|l| l.road_id.to_string())
                    .unwrap_or_default();
                let approach_road = view
                    .topology
                    .lanes
                    .get(&gate.approach_lane_rsl)
                    .map(|l| l.road_id.to_string())
                    .unwrap_or_default();
                connecting_road == head.road_id || approach_road == head.road_id
            })
            .collect();
        let mut controlled: BTreeSet<&str> = seed_gates.iter().map(|g| g.id.as_str()).collect();
        for seed in &seed_gates {
            if let Some(approach) = descriptor.and_then(|d| {
                d.approaches
                    .iter()
                    .find(|a| a.gate_ids.iter().any(|g| g == &seed.id))
            }) {
                controlled.extend(approach.gate_ids.iter().map(String::as_str));
            }
        }
        let matching: Vec<&TopologyGate> = gates
            .iter()
            .copied()
            .filter(|g| controlled.contains(g.id.as_str()))
            .collect();
        let stop_lines = dedup_stop_lines(
            matching
                .iter()
                .filter_map(|g| stop_line_for(view, g))
                .collect(),
        );
        if stop_lines.is_empty() {
            continue;
        }
        controls.push(RoadControl {
            id: format!("road-control:{}", head.id),
            kind: RoadControlKind::Stop,
            dwell_s: 1.0,
            stop_lines,
            map_binding: Some(RoadControlMapBinding {
                junction_id: junction_id.to_owned(),
                control_ids: vec![head.id.clone()],
                source: ControlBindingSource::Map,
            }),
        });
    }
    // Coalesce exact movement sets; every source control id is kept as provenance.
    let mut grouped: BTreeMap<String, Vec<RoadControl>> = BTreeMap::new();
    for control in controls {
        let key = serde_json::to_string(&control.stop_lines).unwrap_or_default();
        grouped.entry(key).or_default().push(control);
    }
    let mut out: Vec<RoadControl> = grouped
        .into_values()
        .map(|mut group| {
            group.sort_by(|a, b| a.id.cmp(&b.id));
            let mut control_ids: BTreeSet<String> = BTreeSet::new();
            for entry in &group {
                if let Some(b) = &entry.map_binding {
                    control_ids.extend(b.control_ids.iter().cloned());
                }
            }
            let control_ids: Vec<String> = control_ids.into_iter().collect();
            let mut first = group.swap_remove(0);
            first.id = format!(
                "road-control:{}",
                control_ids
                    .first()
                    .cloned()
                    .unwrap_or_else(|| first.id.clone())
            );
            if let Some(b) = &mut first.map_binding {
                b.control_ids = control_ids;
            }
            first
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn build_site_road_controls(view: &SignalMapView<'_>, site: &MatchedSite) -> Vec<RoadControl> {
    build_road_controls_for_junction(view, site.origin_junction_id())
}

/// Bind every physical signalized junction and stop control on a loaded map.
pub fn build_map_control_plan(view: &SignalMapView<'_>) -> MapControlPlan {
    let mut junction_ids: BTreeSet<&str> = view
        .signal_catalog
        .junctions
        .iter()
        .map(|j| j.junction_id.as_str())
        .collect();
    junction_ids.extend(view.topology.gates.iter().map(|g| g.junction_id.as_str()));
    let mut signal_programs: Vec<SignalProgram> = Vec::new();
    let mut road_controls: Vec<RoadControl> = Vec::new();
    for id in &junction_ids {
        signal_programs.extend(build_signal_plan_for_junction(view, Some(id)).programs);
    }
    for id in &junction_ids {
        road_controls.extend(build_road_controls_for_junction(view, Some(id)));
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    signal_programs.retain(|p| seen.insert(p.id.clone()));
    let mut seen: BTreeSet<String> = BTreeSet::new();
    road_controls.retain(|c| seen.insert(c.id.clone()));
    MapControlPlan {
        signal_programs,
        road_controls,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SiteSignalRef<'a> {
    Handle(&'a str),
    Feature {
        feature_id: &'a str,
        approach: SignalApproach,
    },
}

/// Resolve an authored signal reference against the concrete map movement.
pub fn resolve_site_signal_program(
    view: &SignalMapView<'_>,
    site: &MatchedSite,
    plan: &SiteSignalPlan,
    r#ref: &SiteSignalRef<'_>,
) -> Option<String> {
    let (feature_id, approach) = match r#ref {
        SiteSignalRef::Handle(handle) => {
            return plan
                .programs
                .iter()
                .find(|p| p.id == *handle)
                .map(|p| p.id.clone())
                .or_else(|| plan.program_by_head_id.get(*handle).cloned());
        }
        SiteSignalRef::Feature {
            feature_id,
            approach,
        } => (*feature_id, *approach),
    };
    let expected = site.feature_junction_id(feature_id)?;
    if plan.junction_id.as_deref() != Some(expected) {
        return None;
    }
    let mut gate_id: Option<String> = None;
    if approach == SignalApproach::Subject {
        gate_id = site.frame.ego_gate_id.clone();
    } else {
        let relation = match approach {
            SignalApproach::Opposing => ApproachRelation::Opposing,
            SignalApproach::Left => ApproachRelation::FromLeft,
            SignalApproach::Right => ApproachRelation::FromRight,
            SignalApproach::Subject => unreachable!(),
        };
        gate_id = site.bindings.iter().find_map(|b| {
            b.conflict
                .as_ref()
                .filter(|c| c.relation == relation)
                .map(|c| c.gate_id.clone())
        });
        if gate_id.is_none() {
            if let Some(ego) = &site.frame.ego_gate_id {
                if let Some(descriptor) = view.index.junction_descriptors.get(expected) {
                    for pair in &descriptor.conflict_pairs {
                        if &pair.gate_a != ego && &pair.gate_b != ego {
                            continue;
                        }
                        let pair_relation = if &pair.gate_a == ego {
                            pair.relation
                        } else {
                            flip_relation(pair.relation)
                        };
                        if pair_relation == relation {
                            gate_id = Some(if &pair.gate_a == ego {
                                pair.gate_b.clone()
                            } else {
                                pair.gate_a.clone()
                            });
                            break;
                        }
                    }
                }
            }
        }
    }
    let connecting = gate_id
        .as_deref()
        .and_then(|g| view.index.gate(g))
        .map(|g| g.connecting_lane_rsl.clone());
    let mut candidates: Vec<String> = connecting
        .and_then(|lane| plan.programs_by_connecting_lane.get(&lane).cloned())
        .unwrap_or_default();
    if candidates.is_empty() {
        if let Some(gid) = &gate_id {
            // An unprotected movement follows another head on the same physical approach.
            let descriptor = view.index.junction_descriptors.get(expected);
            let approach_gates = descriptor
                .and_then(|d| {
                    d.approaches
                        .iter()
                        .find(|a| a.gate_ids.iter().any(|g| g == gid))
                })
                .map(|a| a.gate_ids.clone())
                .unwrap_or_default();
            let mut set: BTreeSet<String> = BTreeSet::new();
            for cg in approach_gates {
                if let Some(lane) = view.index.gate(&cg).map(|g| g.connecting_lane_rsl.clone()) {
                    if let Some(ids) = plan.programs_by_connecting_lane.get(&lane) {
                        set.extend(ids.iter().cloned());
                    }
                }
            }
            candidates = set.into_iter().collect();
        }
    }
    candidates.sort();
    candidates.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_scans_past_paired_road_marks_and_junction_controller_references() {
        let xodr = r#"<OpenDRIVE>
  <road name="Road 1" length="10" id="1" junction="9">
    <lanes><laneSection s="0"><right><lane id="-1" type="driving">
      <roadMark sOffset="0" type="solid"><type name="solid"><line length="1"/></type></roadMark>
    </lane></right></laneSection></lanes>
    <signals>
      <signalReference id="h1" s="10" t="0" orientation="+">
        <validity fromLane="-1" toLane="-1"/>
      </signalReference>
      <signal name="Signal" id="h1" s="1" t="0"><validity fromLane="0" toLane="0"/></signal>
    </signals>
  </road>
  <controller name="c" id="c1" sequence="0"><control signalId="h1" type="0"/></controller>
  <junction id="9" name="j"><controller id="c1" type="0" sequence="0"/></junction>
</OpenDRIVE>"#;
        let geojson = serde_json::json!({ "features": [
            { "properties": { "id": "h1", "road_id": "1", "s": 1, "signal_category": "traffic_light", "dynamic": "yes" } },
        ] });
        let catalog = parse_map_signal_catalog(xodr, &geojson);
        assert_eq!(
            catalog.applicability,
            vec![
                MapSignalApplicability {
                    head_id: "h1".into(),
                    road_id: "1".into(),
                    from_lane: Some(-1),
                    to_lane: Some(-1),
                    source: ApplicabilitySource::SignalReference
                },
                MapSignalApplicability {
                    head_id: "h1".into(),
                    road_id: "1".into(),
                    from_lane: Some(0),
                    to_lane: Some(0),
                    source: ApplicabilitySource::Signal
                },
            ]
        );
        assert_eq!(
            catalog.controllers,
            vec![MapSignalController {
                id: "c1".into(),
                sequence: 0.0,
                signal_ids: vec!["h1".into()]
            }]
        );
        assert_eq!(
            catalog.junctions,
            vec![MapSignalJunction {
                junction_id: "9".into(),
                controller_ids: vec!["c1".into()]
            }]
        );
    }
}
