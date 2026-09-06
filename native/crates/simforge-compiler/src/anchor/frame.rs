//! `AnchorFrame` construction: the coordinate system every pose is expressed in.
//!
//! `s = 0` sits at the origin feature (for a junction anchor: the stop line,
//! i.e. the travel-end of the entry lane). Upstream is negative, downstream
//! positive. The walk prefers the straightest continuation and branches only
//! where two continuations are genuinely ambiguous.

use std::collections::{BTreeMap, BTreeSet};

use simforge_core::math::dist;

use super::{AnchorFrame, FrameOrigin, OriginKind, ReferenceSpan};
use crate::geometry::{angle_diff, heading_at_s};
use crate::map_index::{DerivedLane, DerivedMapIndex, LINK_TOLERANCE_M};
use crate::template::TurnDirection;

/// Two continuations within this angle are *genuinely* ambiguous.
pub const AMBIGUITY_EPS_RAD: f64 = 10.0 * std::f64::consts::PI / 180.0;
/// Hard cap on frames emitted per (junction, approach) candidate.
pub const MAX_FRAMES_PER_CANDIDATE: usize = 4;
/// Default walk distances when the anchor states no runway requirement.
pub const DEFAULT_RUNWAY_UPSTREAM_M: f64 = 150.0;
pub const DEFAULT_RUNWAY_DOWNSTREAM_M: f64 = 80.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkDir {
    Forward,
    Backward,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Chain {
    pub lanes: Vec<String>,
    pub length_m: f64,
    /// False once a link in the chain was not physically contiguous.
    pub contiguous: Vec<bool>,
}

impl Chain {
    pub fn empty() -> Self {
        Self {
            lanes: Vec::new(),
            length_m: 0.0,
            contiguous: Vec::new(),
        }
    }
}

struct OpenChain {
    lanes: Vec<String>,
    length_m: f64,
    last: String,
    visited: BTreeSet<String>,
    contiguous: Vec<bool>,
}

fn straightness(
    index: &DerivedMapIndex,
    lane: &DerivedLane,
    other: &DerivedLane,
    dir: WalkDir,
) -> f64 {
    let _ = index;
    match dir {
        WalkDir::Forward => angle_diff(
            heading_at_s(&other.polyline, 0.0),
            heading_at_s(&lane.polyline, lane.length_m),
        )
        .abs(),
        WalkDir::Backward => angle_diff(
            heading_at_s(&lane.polyline, 0.0),
            heading_at_s(&other.polyline, other.length_m),
        )
        .abs(),
    }
}

fn neighbors_sorted(index: &DerivedMapIndex, lane_rsl: &str, dir: WalkDir) -> Vec<String> {
    let Some(lane) = index.lane(lane_rsl) else {
        return Vec::new();
    };
    let raw = match dir {
        WalkDir::Forward => &lane.successors,
        WalkDir::Backward => &lane.predecessors,
    };
    let mut scored: Vec<(String, f64)> = raw
        .iter()
        .filter_map(|r| {
            let other = index.lane(r)?;
            if other.lane_type != "driving" || other.polyline.len() < 2 {
                return None;
            }
            Some((r.clone(), straightness(index, lane, other, dir)))
        })
        .collect();
    scored.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    scored.into_iter().map(|(r, _)| r).collect()
}

pub fn link_contiguous(index: &DerivedMapIndex, from: &str, to: &str, dir: WalkDir) -> bool {
    let (a, b) = match dir {
        WalkDir::Forward => (index.lane(from), index.lane(to)),
        WalkDir::Backward => (index.lane(to), index.lane(from)),
    };
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    if a.polyline.len() < 2 || b.polyline.len() < 2 {
        return false;
    }
    dist(a.polyline[a.polyline.len() - 1], b.polyline[0]) <= LINK_TOLERANCE_M
}

fn chain_key(lanes: &[String]) -> String {
    lanes.join(">")
}

/// Enumerate lane chains away from `start_rsl`, preferring the straightest
/// continuation and branching only where two continuations are genuinely
/// ambiguous.
pub fn enumerate_chains(
    index: &DerivedMapIndex,
    start_rsl: &str,
    need_m: f64,
    dir: WalkDir,
    cap: usize,
) -> Vec<Chain> {
    let mut open: Vec<OpenChain> = vec![OpenChain {
        lanes: Vec::new(),
        length_m: 0.0,
        last: start_rsl.to_owned(),
        visited: BTreeSet::from([start_rsl.to_owned()]),
        contiguous: Vec::new(),
    }];
    let mut done: Vec<OpenChain> = Vec::new();
    for _step in 0..64 {
        if open.is_empty() {
            break;
        }
        let mut next: Vec<OpenChain> = Vec::new();
        for chain in open.drain(..) {
            if chain.length_m >= need_m {
                done.push(chain);
                continue;
            }
            let candidates: Vec<String> = neighbors_sorted(index, &chain.last, dir)
                .into_iter()
                .filter(|r| !chain.visited.contains(r))
                .collect();
            if candidates.is_empty() {
                done.push(chain);
                continue;
            }
            let lane = index.lane(&chain.last).expect("chain last lane exists");
            let angle_of = |other: &str| -> f64 {
                straightness(
                    index,
                    lane,
                    index.lane(other).expect("candidate lane exists"),
                    dir,
                )
            };
            let best = candidates[0].clone();
            let mut options = vec![best.clone()];
            if let Some(second) = candidates.get(1) {
                if (angle_of(second) - angle_of(&best)).abs() < AMBIGUITY_EPS_RAD {
                    options.push(second.clone());
                }
            }
            for opt in options {
                let opt_lane = index.lane(&opt).expect("option lane exists");
                let contiguous_link = link_contiguous(index, &chain.last, &opt, dir);
                let (lanes, contiguous) = match dir {
                    WalkDir::Forward => {
                        let mut l = chain.lanes.clone();
                        l.push(opt.clone());
                        let mut c = chain.contiguous.clone();
                        c.push(contiguous_link);
                        (l, c)
                    }
                    WalkDir::Backward => {
                        let mut l = vec![opt.clone()];
                        l.extend(chain.lanes.iter().cloned());
                        let mut c = vec![contiguous_link];
                        c.extend(chain.contiguous.iter().copied());
                        (l, c)
                    }
                };
                let mut visited = chain.visited.clone();
                visited.insert(opt.clone());
                next.push(OpenChain {
                    lanes,
                    length_m: chain.length_m + opt_lane.length_m,
                    last: opt,
                    visited,
                    contiguous,
                });
            }
        }
        // Deterministic breadth cap: keep the longest, then lexicographically first.
        next.sort_by(|a, b| {
            b.length_m
                .partial_cmp(&a.length_m)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| chain_key(&a.lanes).cmp(&chain_key(&b.lanes)))
        });
        next.truncate(cap);
        open = next;
        if done.len() >= cap {
            break;
        }
    }
    let mut unique: BTreeMap<String, OpenChain> = BTreeMap::new();
    for chain in done.into_iter().chain(open) {
        let key = chain_key(&chain.lanes);
        match unique.get(&key) {
            Some(existing) if existing.length_m >= chain.length_m => {}
            _ => {
                unique.insert(key, chain);
            }
        }
    }
    let mut all: Vec<OpenChain> = unique.into_values().collect();
    all.sort_by(|a, b| {
        b.length_m
            .partial_cmp(&a.length_m)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| chain_key(&a.lanes).cmp(&chain_key(&b.lanes)))
    });
    all.truncate(cap);
    all.into_iter()
        .map(|c| Chain {
            lanes: c.lanes,
            length_m: c.length_m,
            contiguous: c.contiguous,
        })
        .collect()
}

#[derive(Debug, Clone, Default)]
pub struct JunctionFrameOptions {
    pub ego_turn: Option<TurnDirection>,
    pub runway_upstream_m: Option<f64>,
    pub runway_downstream_m: Option<f64>,
    /// Anchor feature id that the origin corresponds to.
    pub anchor_feature_id: String,
    pub mirrored: bool,
}

struct Spans {
    spans: Vec<ReferenceSpan>,
    s_of_lane: BTreeMap<String, f64>,
    s_range: (f64, f64),
}

fn build_spans(
    index: &DerivedMapIndex,
    upstream: &Chain,
    entry_rsl: &str,
    downstream: &Chain,
) -> Spans {
    let mut ordered: Vec<(&str, bool)> =
        Vec::with_capacity(upstream.lanes.len() + 1 + downstream.lanes.len());
    for (i, rsl) in upstream.lanes.iter().enumerate() {
        ordered.push((rsl, upstream.contiguous.get(i).copied().unwrap_or(true)));
    }
    ordered.push((entry_rsl, true));
    for (i, rsl) in downstream.lanes.iter().enumerate() {
        ordered.push((rsl, downstream.contiguous.get(i).copied().unwrap_or(true)));
    }
    let entry_len = index.lane(entry_rsl).map_or(0.0, |l| l.length_m);
    let upstream_len: f64 = upstream
        .lanes
        .iter()
        .map(|r| index.lane(r).map_or(0.0, |l| l.length_m))
        .sum();
    let mut cursor = -(upstream_len + entry_len);
    let mut spans = Vec::with_capacity(ordered.len());
    let mut s_of_lane = BTreeMap::new();
    for (rsl, contiguous) in ordered {
        let Some(lane) = index.lane(rsl) else {
            continue;
        };
        let s_start = cursor;
        let s_end = cursor + lane.length_m;
        spans.push(ReferenceSpan {
            lane_rsl: rsl.to_owned(),
            s_start,
            s_end,
            length_m: lane.length_m,
            is_junction: lane.is_junction,
            contiguous,
        });
        s_of_lane.insert(rsl.to_owned(), s_start);
        cursor = s_end;
    }
    let s_range = (
        spans.first().map_or(0.0, |s| s.s_start),
        spans.last().map_or(0.0, |s| s.s_end),
    );
    Spans {
        spans,
        s_of_lane,
        s_range,
    }
}

/// Lateral lanes at the origin cross-section. Mirroring is applied once, to
/// the anchor and role list, so frames stay in *map* space.
fn lateral_at_origin(
    index: &DerivedMapIndex,
    entry: &DerivedLane,
) -> (BTreeMap<i32, String>, Vec<String>) {
    match index.cross_section(&entry.rsl, (entry.length_m - 0.5).max(0.0)) {
        Some(cs) => (cs.same_dir_driving.clone(), cs.opposing_driving.clone()),
        None => (BTreeMap::new(), Vec::new()),
    }
}

/// Build the frames for one (junction, entry lane) candidate. Genuine
/// ambiguity yields several frames; they collapse to one `MatchedSite` later.
pub fn build_junction_frames(
    index: &DerivedMapIndex,
    junction_id: &str,
    entry_lane_rsl: &str,
    options: &JunctionFrameOptions,
) -> Vec<AnchorFrame> {
    let Some(entry_lane) = index.lane(entry_lane_rsl) else {
        return Vec::new();
    };
    if entry_lane.lane_type != "driving" {
        return Vec::new();
    }
    let mut gates: Vec<&crate::map_index::DerivedGate> = index
        .gates
        .iter()
        .filter(|g| g.junction_id == junction_id && g.approach_lane_rsl == entry_lane_rsl)
        .collect();
    gates.sort_by(|a, b| a.id.cmp(&b.id));
    if gates.is_empty() {
        return Vec::new();
    }
    let chosen: Vec<&crate::map_index::DerivedGate> = match options.ego_turn {
        Some(turn) => gates
            .iter()
            .copied()
            .filter(|g| g.turn_relation == turn)
            .collect(),
        None => {
            let mut straight: Vec<(&crate::map_index::DerivedGate, f64)> = gates
                .iter()
                .map(|g| (*g, g.heading_change_rad.abs()))
                .collect();
            straight.sort_by(|a, b| {
                a.1.partial_cmp(&b.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.0.id.cmp(&b.0.id))
            });
            let best = straight.first().map_or(0.0, |e| e.1);
            straight
                .into_iter()
                .filter(|e| (e.1 - best).abs() < AMBIGUITY_EPS_RAD)
                .map(|e| e.0)
                .collect()
        }
    };
    if chosen.is_empty() {
        return Vec::new();
    }
    let up_need = options
        .runway_upstream_m
        .unwrap_or(DEFAULT_RUNWAY_UPSTREAM_M);
    let down_need = options
        .runway_downstream_m
        .unwrap_or(DEFAULT_RUNWAY_DOWNSTREAM_M);
    let upstream = enumerate_chains(
        index,
        entry_lane_rsl,
        up_need,
        WalkDir::Backward,
        MAX_FRAMES_PER_CANDIDATE,
    )
    .into_iter()
    .next()
    .unwrap_or_else(Chain::empty);
    let (lateral_lanes, opposing_lanes) = lateral_at_origin(index, entry_lane);

    let mut frames = Vec::new();
    for gate in chosen.into_iter().take(MAX_FRAMES_PER_CANDIDATE) {
        let Some(connecting) = index.lane(&gate.connecting_lane_rsl) else {
            continue;
        };
        let exits = enumerate_chains(
            index,
            &gate.connecting_lane_rsl,
            (down_need - connecting.length_m).max(0.0),
            WalkDir::Forward,
            2,
        );
        let exits = if exits.is_empty() {
            vec![Chain::empty()]
        } else {
            exits
        };
        for exit in exits.into_iter().take(2) {
            let mut lanes = vec![gate.connecting_lane_rsl.clone()];
            lanes.extend(exit.lanes.iter().cloned());
            let mut contiguous = vec![link_contiguous(
                index,
                entry_lane_rsl,
                &gate.connecting_lane_rsl,
                WalkDir::Forward,
            )];
            contiguous.extend(exit.contiguous.iter().copied());
            let downstream = Chain {
                lanes,
                length_m: connecting.length_m + exit.length_m,
                contiguous,
            };
            let spans = build_spans(index, &upstream, entry_lane_rsl, &downstream);
            frames.push(AnchorFrame {
                origin: FrameOrigin {
                    anchor_feature_id: options.anchor_feature_id.clone(),
                    kind: OriginKind::Junction,
                    map_feature_id: format!("junction:{junction_id}"),
                },
                entry_lane_rsl: entry_lane_rsl.to_owned(),
                reference_path: spans.spans,
                s_of_lane: spans.s_of_lane,
                s_range: spans.s_range,
                lateral_lanes: lateral_lanes.clone(),
                opposing_lanes: opposing_lanes.clone(),
                handedness: index.handedness,
                mirrored: options.mirrored,
                ego_gate_id: Some(gate.id.clone()),
                ego_turn: Some(gate.turn_relation),
                runway_upstream_m: upstream.length_m + entry_lane.length_m,
                runway_downstream_m: downstream.length_m,
            });
            if frames.len() >= MAX_FRAMES_PER_CANDIDATE {
                return frames;
            }
        }
    }
    frames
}

#[derive(Debug, Clone, Default)]
pub struct CorridorFrameOptions {
    pub anchor_feature_id: String,
    pub runway_downstream_m: Option<f64>,
    pub mirrored: bool,
}

/// Frame for a corridor-only anchor (no junction feature): the origin is the
/// head of a segment, which keeps `s` meaningful and the site id stable.
pub fn build_corridor_frame(
    index: &DerivedMapIndex,
    segment_id: &str,
    options: &CorridorFrameOptions,
) -> Option<AnchorFrame> {
    let segment = index.segments.iter().find(|s| s.id == segment_id)?;
    let entry_rsl = segment.lane_rsls.first()?;
    let entry_lane = index.lane(entry_rsl)?;
    let down_need = (options
        .runway_downstream_m
        .unwrap_or(DEFAULT_RUNWAY_DOWNSTREAM_M)
        - segment.length_m)
        .max(0.0);
    let tail = segment.lane_rsls.last()?;
    let forward = enumerate_chains(index, tail, down_need, WalkDir::Forward, 1)
        .into_iter()
        .next()
        .unwrap_or_else(Chain::empty);
    let rest = &segment.lane_rsls[1..];
    let mut lanes: Vec<String> = rest.to_vec();
    lanes.extend(forward.lanes.iter().cloned());
    let mut contiguous: Vec<bool> = vec![true; rest.len()];
    contiguous.extend(forward.contiguous.iter().copied());
    let downstream = Chain {
        lanes,
        length_m: segment.length_m - entry_lane.length_m + forward.length_m,
        contiguous,
    };
    let spans = build_spans(index, &Chain::empty(), entry_rsl, &downstream);
    let shift = entry_lane.length_m;
    let shifted: Vec<ReferenceSpan> = spans
        .spans
        .into_iter()
        .map(|s| ReferenceSpan {
            s_start: s.s_start + shift,
            s_end: s.s_end + shift,
            ..s
        })
        .collect();
    let s_of_lane: BTreeMap<String, f64> = spans
        .s_of_lane
        .into_iter()
        .map(|(k, v)| (k, v + shift))
        .collect();
    let (lateral_lanes, opposing_lanes) = lateral_at_origin(index, entry_lane);
    Some(AnchorFrame {
        origin: FrameOrigin {
            anchor_feature_id: options.anchor_feature_id.clone(),
            kind: OriginKind::Corridor,
            map_feature_id: segment.id.clone(),
        },
        entry_lane_rsl: entry_rsl.clone(),
        reference_path: shifted,
        s_of_lane,
        s_range: (spans.s_range.0 + shift, spans.s_range.1 + shift),
        lateral_lanes,
        opposing_lanes,
        handedness: index.handedness,
        mirrored: options.mirrored,
        ego_gate_id: None,
        ego_turn: None,
        runway_upstream_m: 0.0,
        runway_downstream_m: downstream.length_m + entry_lane.length_m,
    })
}
