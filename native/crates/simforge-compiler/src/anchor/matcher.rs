//! `match_anchor(anchor, index) -> MatchedSite[]`.
//!
//! selectivity-ordered candidate generation → frame construction → clause
//! evaluation → aggregate score → repairs + degradation → diversity dedup →
//! stable sort by `(-score, site_id)`. Pure: no clock, no RNG, sorted fan-out.

use std::collections::{BTreeMap, BTreeSet};

use super::bind::bind_roles;
use super::clauses::{
    aggregate_score, evaluate_anchor, lane_count_transitions, sample_corridor, TransitionKind,
    SAMPLE_STRIDE_M,
};
use super::degrade::{degrade, DegradeInput};
use super::frame::{
    build_corridor_frame, build_junction_frames, CorridorFrameOptions, JunctionFrameOptions,
};
use super::scoring::near_miss_score;
use super::{
    compute_site_id, mirror_anchor, mirror_roles, AnchorFrame, MAnchor, MDiversity, MFeature,
    MFeatureKind, MRole, MatchReport, MatchStats, MatchedSite, OriginKind, Verdict,
    MATCH_SEMANTICS_VERSION,
};
use crate::map_index::{DerivedMapIndex, PointFeatureKind};
use crate::template::JunctionControl;

const DEFAULT_MAX_FRAMES: usize = 4000;

const ALL_CONTROLS: [JunctionControl; 6] = [
    JunctionControl::Signalized,
    JunctionControl::AllWayStop,
    JunctionControl::MinorStop,
    JunctionControl::Yield,
    JunctionControl::Uncontrolled,
    JunctionControl::Roundabout,
];

#[derive(Debug, Clone, Default)]
pub struct MatchOptions {
    pub roles: Vec<MRole>,
    pub max_frames: Option<usize>,
}

/// Recenter a corridor frame on the authored structural zero (a merge, lane
/// drop or work-zone feature; or the requested approach runway when there is
/// no origin feature), so `s = 0` means the mechanism site.
fn recenter_structural_corridor(
    index: &DerivedMapIndex,
    anchor: &MAnchor,
    frame: AnchorFrame,
) -> AnchorFrame {
    if frame.origin.kind != OriginKind::Corridor {
        return frame;
    }
    let origin = anchor.origin_feature();
    let shift = match origin {
        None => {
            let shift = anchor
                .corridor
                .as_ref()
                .and_then(|c| c.runway_upstream_m.as_ref())
                .map_or(0.0, |c| c.value);
            if shift <= frame.s_range.0 || shift >= frame.s_range.1 {
                return frame;
            }
            shift
        }
        Some(o) if matches!(o.kind, MFeatureKind::Merge | MFeatureKind::LaneDrop) => {
            let wanted = if o.kind == MFeatureKind::Merge {
                TransitionKind::Merge
            } else {
                TransitionKind::LaneDrop
            };
            let samples = sample_corridor(
                index,
                &frame,
                frame.s_range.0,
                frame.s_range.1,
                SAMPLE_STRIDE_M,
            );
            let mut transitions: Vec<_> = lane_count_transitions(index, &samples, Some(&frame))
                .into_iter()
                .filter(|t| t.kind == wanted)
                .collect();
            transitions.sort_by(|a, b| a.s.partial_cmp(&b.s).unwrap_or(std::cmp::Ordering::Equal));
            match transitions.first() {
                Some(t) => t.s,
                None => return frame,
            }
        }
        Some(o) if o.kind == MFeatureKind::WorkZoneSuitable => {
            let wanted_at = (o.at_m.value.0 + o.at_m.value.1) / 2.0;
            let mut candidates: Vec<(f64, f64, &str)> = index
                .point_features
                .iter()
                .filter(|f| f.kind == PointFeatureKind::WorkZoneSuitable)
                .filter_map(|f| {
                    let span = frame
                        .reference_path
                        .iter()
                        .find(|c| c.lane_rsl == f.lane_rsl)?;
                    let feature_s = span.s_start + f.s.max(0.0).min(span.length_m);
                    let shift = feature_s - wanted_at;
                    (shift > frame.s_range.0 && shift < frame.s_range.1).then_some((
                        feature_s,
                        shift,
                        f.id.as_str(),
                    ))
                })
                .collect();
            candidates.sort_by(|a, b| {
                a.0.partial_cmp(&b.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.2.cmp(b.2))
            });
            match candidates.first() {
                Some(c) => c.1,
                None => return frame,
            }
        }
        Some(_) => return frame,
    };
    let origin_span = frame
        .reference_path
        .iter()
        .find(|span| shift >= span.s_start && shift <= span.s_end);
    let cross_section = origin_span.and_then(|span| {
        let local_s = (shift - span.s_start).max(0.0).min(span.length_m);
        index.cross_section(&span.lane_rsl, local_s)
    });
    let mut out = frame;
    for span in &mut out.reference_path {
        span.s_start -= shift;
        span.s_end -= shift;
    }
    for s in out.s_of_lane.values_mut() {
        *s -= shift;
    }
    let s_range = out.s_range;
    out.s_range = (s_range.0 - shift, s_range.1 - shift);
    if let Some(cs) = cross_section {
        out.lateral_lanes = cs.same_dir_driving;
        out.opposing_lanes = cs.opposing_driving;
    }
    out.runway_upstream_m = shift - s_range.0;
    out.runway_downstream_m = s_range.1 - shift;
    out
}

struct Selector {
    path: &'static str,
    ids: Vec<String>,
}

/// Junction candidates from the fact index, driven by the rarest usable
/// clause. Near-miss classes are admitted even for a `required` clause; the
/// degradation pass rejects them, and the report can then say why.
fn junction_candidates(index: &DerivedMapIndex, feature: &MFeature) -> (Vec<String>, Vec<String>) {
    let mut selectors: Vec<Selector> = Vec::new();
    if let Some(jp) = &feature.junction {
        if let Some(control) = &jp.control {
            let mut wanted: BTreeSet<&str> = control.value.iter().map(|c| c.as_str()).collect();
            for candidate in ALL_CONTROLS {
                if control
                    .value
                    .iter()
                    .any(|w| near_miss_score(candidate, *w) > 0.0)
                {
                    wanted.insert(candidate.as_str());
                }
            }
            let mut ids: BTreeSet<String> = BTreeSet::new();
            for c in wanted {
                if let Some(list) = index.fact_index.junctions_by_control.get(c) {
                    ids.extend(list.iter().cloned());
                }
            }
            selectors.push(Selector {
                path: "junction.control",
                ids: ids.into_iter().collect(),
            });
        }
        if let Some(arms) = &jp.arms {
            let (lo, hi) = arms.value;
            let slack = 1.0;
            let mut ids: BTreeSet<String> = BTreeSet::new();
            for (key, list) in &index.fact_index.junctions_by_arms {
                let Ok(n) = key.parse::<f64>() else { continue };
                if n >= lo - slack && n <= hi + slack {
                    ids.extend(list.iter().cloned());
                }
            }
            selectors.push(Selector {
                path: "junction.arms",
                ids: ids.into_iter().collect(),
            });
        }
        if let Some(turn) = &jp.ego_turn {
            let mut ids: Vec<String> = index
                .fact_index
                .junctions_by_turn_option
                .get(turn.value.as_str())
                .cloned()
                .unwrap_or_default();
            ids.sort();
            selectors.push(Selector {
                path: "junction.egoTurn",
                ids,
            });
        }
    }
    if selectors.is_empty() {
        return (
            index.junction_descriptors.keys().cloned().collect(),
            Vec::new(),
        );
    }
    selectors.sort_by(|a, b| {
        a.ids
            .len()
            .cmp(&b.ids.len())
            .then_with(|| a.path.cmp(b.path))
    });
    let mut ids = selectors[0].ids.clone();
    for selector in &selectors[1..] {
        let set: BTreeSet<&str> = selector.ids.iter().map(String::as_str).collect();
        ids.retain(|id| set.contains(id.as_str()));
    }
    (
        ids,
        selectors
            .iter()
            .map(|s| format!("{}({})", s.path, s.ids.len()))
            .collect(),
    )
}

/// Segment candidates for a corridor-only anchor.
fn segment_candidates(index: &DerivedMapIndex, anchor: &MAnchor) -> (Vec<String>, Vec<String>) {
    let Some(clause) = anchor
        .corridor
        .as_ref()
        .and_then(|c| c.through_lanes_same_dir.as_ref())
    else {
        return (
            index.segments.iter().map(|s| s.id.clone()).collect(),
            Vec::new(),
        );
    };
    let (lo, hi) = clause.value;
    let slack = if clause.essentiality == crate::template::Essentiality::Required {
        0.0
    } else {
        1.0
    };
    let mut ids: BTreeSet<String> = BTreeSet::new();
    for (key, list) in &index.fact_index.segments_by_lane_count {
        let Ok(n) = key.parse::<f64>() else { continue };
        if n >= lo - slack && n <= hi + slack {
            ids.extend(list.iter().cloned());
        }
    }
    let sorted: Vec<String> = ids.into_iter().collect();
    let order = vec![format!("corridor.throughLanesSameDir({})", sorted.len())];
    (sorted, order)
}

/// Approach lanes of a junction, from its gates (sorted, driving only).
fn approach_lanes_of(index: &DerivedMapIndex, junction_id: &str) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    for gate in &index.gates {
        if gate.junction_id != junction_id {
            continue;
        }
        if index
            .lane(&gate.approach_lane_rsl)
            .is_some_and(|l| l.lane_type == "driving")
        {
            set.insert(gate.approach_lane_rsl.clone());
        }
    }
    set.into_iter().collect()
}

fn evaluate_frame(
    index: &DerivedMapIndex,
    anchor: &MAnchor,
    roles: &[MRole],
    frame: AnchorFrame,
) -> MatchedSite {
    let frame = recenter_structural_corridor(index, anchor, frame);
    let evaluation = evaluate_anchor(index, &frame, anchor);
    let bindings = bind_roles(index, &frame, roles, &evaluation.feature_matches);
    let (soft_score, failed_required) = aggregate_score(&evaluation.clauses);
    let (report, score) = degrade(&DegradeInput {
        roles,
        clauses: &evaluation.clauses,
        bindings: &bindings,
        soft_score,
        failed_required_clauses: &failed_required,
    });
    let origin_s = if frame.origin.kind == OriginKind::Corridor {
        0.0
    } else {
        index
            .lane(&frame.entry_lane_rsl)
            .map_or(0.0, |l| l.length_m)
    };
    let site_id = compute_site_id(
        &anchor.id,
        &index.map_id,
        &index.topology_digest,
        &frame.origin.map_feature_id,
        &frame.entry_lane_rsl,
        origin_s,
    );
    let mut matched_reasons = evaluation.reasons;
    for binding in &bindings {
        for note in &binding.notes {
            matched_reasons.push(format!("{}: {note}", binding.role));
        }
    }
    if frame.mirrored {
        matched_reasons.push("matched in mirror (policy.allowMirror)".to_owned());
    }
    if frame.reference_path.iter().any(|s| !s.contiguous) {
        matched_reasons
            .push("warning: the reference path contains a non-contiguous lane link".to_owned());
    }
    MatchedSite {
        site_id,
        map_id: index.map_id.clone(),
        topology_digest: index.topology_digest.clone(),
        match_semantics_version: MATCH_SEMANTICS_VERSION.to_owned(),
        anchor_id: anchor.id.clone(),
        score,
        frame,
        clauses: evaluation.clauses,
        bindings,
        feature_matches: evaluation.feature_matches,
        degradation: report,
        matched_reasons,
        alternate_frames: 0,
    }
}

fn corridor_frame_downstream_need(anchor: &MAnchor) -> Option<f64> {
    let corridor = anchor.corridor.as_ref()?;
    let downstream = corridor.runway_downstream_m.as_ref()?.value;
    Some(downstream + corridor.runway_upstream_m.as_ref().map_or(0.0, |c| c.value))
}

/// Resolve one persisted corridor origin without enumerating unrelated
/// segments, for deterministic replay of a previously audited site.
pub fn resolve_exact_corridor_site(
    anchor: &MAnchor,
    index: &DerivedMapIndex,
    segment_id: &str,
    roles: &[MRole],
) -> Option<MatchedSite> {
    let origin = anchor.origin_feature();
    if origin.is_some_and(|o| o.kind == MFeatureKind::Junction) {
        return None;
    }
    let frame = build_corridor_frame(
        index,
        segment_id,
        &CorridorFrameOptions {
            anchor_feature_id: origin.map_or("corridor".to_owned(), |o| o.id.clone()),
            runway_downstream_m: corridor_frame_downstream_need(anchor),
            mirrored: false,
        },
    )?;
    Some(evaluate_frame(index, anchor, roles, frame))
}

fn diversity_key(site: &MatchedSite, index: &DerivedMapIndex, diversity: MDiversity) -> String {
    match diversity {
        MDiversity::None => site.site_id.clone(),
        MDiversity::Junction => site.frame.origin.map_feature_id.clone(),
        MDiversity::RoadDirection => match index.lane(&site.frame.entry_lane_rsl) {
            Some(lane) => format!(
                "{}:{}",
                lane.road_id,
                if lane.lane_id >= 0 { "pos" } else { "neg" }
            ),
            None => site.frame.entry_lane_rsl.clone(),
        },
    }
}

fn cmp_sites(a: &MatchedSite, b: &MatchedSite) -> std::cmp::Ordering {
    b.score
        .partial_cmp(&a.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| a.site_id.cmp(&b.site_id))
}

/// Full matcher output, including the sites that were rejected and why.
pub fn match_anchor_report(
    anchor: &MAnchor,
    index: &DerivedMapIndex,
    options: &MatchOptions,
) -> MatchReport {
    let policy = &anchor.policy;
    let roles = &options.roles;
    let max_frames = options.max_frames.unwrap_or(DEFAULT_MAX_FRAMES);
    let mut warnings: Vec<String> = Vec::new();
    let origin = anchor.origin_feature();
    let mut stats = MatchStats {
        candidates_considered: 0,
        frames_built: 0,
        sites_scored: 0,
        sites_infeasible: 0,
        sites_below_min_score: 0,
        sites_dropped_by_diversity: 0,
        selectivity_order: Vec::new(),
    };

    let mirrored_anchor = policy.allow_mirror.then(|| mirror_anchor(anchor));
    let mirrored_roles = if policy.allow_mirror {
        mirror_roles(roles)
    } else {
        roles.clone()
    };
    let mut frames: Vec<AnchorFrame> = Vec::new();
    let mut mirrored_frames: Vec<AnchorFrame> = Vec::new();

    match origin {
        Some(origin) if origin.kind == MFeatureKind::Junction => {
            let (ids, order) = junction_candidates(index, origin);
            stats.selectivity_order = order;
            stats.candidates_considered = ids.len();
            let upstream_need = anchor
                .corridor
                .as_ref()
                .and_then(|c| c.runway_upstream_m.as_ref())
                .map(|c| c.value);
            let downstream_need = anchor
                .corridor
                .as_ref()
                .and_then(|c| c.runway_downstream_m.as_ref())
                .map(|c| c.value);
            let mirrored_origin = mirrored_anchor.as_ref().and_then(MAnchor::origin_feature);
            'outer: for junction_id in &ids {
                for lane_rsl in approach_lanes_of(index, junction_id) {
                    if frames.len() >= max_frames {
                        break 'outer;
                    }
                    let build = |feature: &MFeature, mirrored: bool| {
                        build_junction_frames(
                            index,
                            junction_id,
                            &lane_rsl,
                            &JunctionFrameOptions {
                                ego_turn: feature
                                    .junction
                                    .as_ref()
                                    .and_then(|j| j.ego_turn.as_ref())
                                    .map(|t| t.value),
                                runway_upstream_m: upstream_need,
                                runway_downstream_m: downstream_need,
                                anchor_feature_id: origin.id.clone(),
                                mirrored,
                            },
                        )
                    };
                    frames.extend(build(origin, false));
                    if let Some(m) = mirrored_origin {
                        mirrored_frames.extend(build(m, true));
                    }
                }
            }
        }
        _ => {
            let (ids, order) = segment_candidates(index, anchor);
            stats.selectivity_order = order;
            stats.candidates_considered = ids.len();
            let anchor_feature_id = origin.map_or("corridor".to_owned(), |o| o.id.clone());
            let downstream = corridor_frame_downstream_need(anchor);
            for segment_id in &ids {
                if frames.len() >= max_frames {
                    break;
                }
                if let Some(frame) = build_corridor_frame(
                    index,
                    segment_id,
                    &CorridorFrameOptions {
                        anchor_feature_id: anchor_feature_id.clone(),
                        runway_downstream_m: downstream,
                        mirrored: false,
                    },
                ) {
                    frames.push(frame);
                }
                if mirrored_anchor.is_some() {
                    if let Some(frame) = build_corridor_frame(
                        index,
                        segment_id,
                        &CorridorFrameOptions {
                            anchor_feature_id: anchor_feature_id.clone(),
                            runway_downstream_m: downstream,
                            mirrored: true,
                        },
                    ) {
                        mirrored_frames.push(frame);
                    }
                }
            }
        }
    }
    stats.frames_built = frames.len() + mirrored_frames.len();

    let mut scored: Vec<(MatchedSite, bool)> = Vec::with_capacity(stats.frames_built);
    for frame in frames {
        scored.push((evaluate_frame(index, anchor, roles, frame), false));
    }
    if let Some(m) = &mirrored_anchor {
        for frame in mirrored_frames {
            scored.push((evaluate_frame(index, m, &mirrored_roles, frame), true));
        }
    }
    stats.sites_scored = scored.len();

    scored.sort_by(|a, b| a.0.site_id.cmp(&b.0.site_id));
    let mut by_site: BTreeMap<String, (MatchedSite, bool, usize)> = BTreeMap::new();
    for (site, mirrored) in scored {
        match by_site.get_mut(&site.site_id) {
            None => {
                by_site.insert(site.site_id.clone(), (site, mirrored, 0));
            }
            Some(existing) => {
                existing.2 += 1;
                let better = site.score > existing.0.score
                    || (site.score == existing.0.score && !mirrored && existing.1);
                if better {
                    existing.0 = site;
                    existing.1 = mirrored;
                }
            }
        }
    }
    let collapsed: Vec<MatchedSite> = by_site
        .into_values()
        .map(|(mut site, _, alternates)| {
            site.alternate_frames = alternates;
            site
        })
        .collect();

    let mut rejected: Vec<MatchedSite> = Vec::new();
    let mut feasible: Vec<MatchedSite> = Vec::new();
    for site in collapsed.iter().cloned() {
        if site.degradation.verdict == Verdict::Infeasible {
            stats.sites_infeasible += 1;
            rejected.push(site);
        } else if site.score < policy.min_score {
            stats.sites_below_min_score += 1;
            rejected.push(site);
        } else {
            feasible.push(site);
        }
    }
    feasible.sort_by(cmp_sites);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut diverse: Vec<MatchedSite> = Vec::new();
    for site in feasible {
        let key = diversity_key(&site, index, policy.diversity);
        if !seen.insert(key) {
            stats.sites_dropped_by_diversity += 1;
            rejected.push(site);
            continue;
        }
        diverse.push(site);
    }
    let mut sites: Vec<MatchedSite> = diverse
        .iter()
        .take(policy.max_sites_per_map)
        .cloned()
        .collect();

    if let Some(pin) = &anchor.pin {
        if pin.map_id != index.map_id {
            sites.clear();
            warnings.push(format!(
                "anchor is pinned to map \"{}\" but was matched against \"{}\"",
                pin.map_id, index.map_id
            ));
        } else {
            let pinned: Vec<MatchedSite> = diverse
                .iter()
                .chain(rejected.iter())
                .filter(|s| s.site_id == pin.site_id)
                .cloned()
                .collect();
            if pinned.is_empty() {
                warnings.push(format!(
                    "pinned site \"{}\" was not produced on this map",
                    pin.site_id
                ));
            }
            sites = pinned
                .into_iter()
                .filter(|s| s.degradation.verdict != Verdict::Infeasible)
                .collect();
        }
    }

    if !index.capabilities.junction_control {
        warnings.push(
            "map index carries no junction control: control clauses cannot be answered".to_owned(),
        );
    }
    if !index.capabilities.crossings {
        warnings.push("map index carries no crossing layer: crossing features and on_crossing roles cannot bind".to_owned());
    }
    if !index.capabilities.work_zones
        && anchor
            .features
            .iter()
            .any(|f| f.kind == MFeatureKind::WorkZoneSuitable)
    {
        warnings.push("map index carries no work-zone suitability layer: rebuild locations with work-zone densification".to_owned());
    }
    if !index.capabilities.occlusion_zones
        && anchor
            .features
            .iter()
            .any(|f| f.kind == MFeatureKind::OcclusionZone)
    {
        warnings.push("map index carries no occlusion-zone layer: provide catalog sight-line/occluder evidence".to_owned());
    }
    rejected.sort_by(cmp_sites);
    let failure_summary = if sites.is_empty() {
        summarize_failure(&collapsed, &stats, policy.min_score)
    } else {
        String::new()
    };
    MatchReport {
        sites,
        rejected,
        stats,
        failure_summary,
        warnings,
    }
}

fn summarize_failure(collapsed: &[MatchedSite], stats: &MatchStats, min_score: f64) -> String {
    if stats.candidates_considered == 0 {
        return "No candidate structure on this map satisfied the anchor's indexed clauses (junction class / lane count), so no site was even considered.".to_owned();
    }
    if collapsed.is_empty() {
        return format!("Considered {} candidate(s) but no anchor frame could be constructed — typically no approach offers the requested ego movement.", stats.candidates_considered);
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for site in collapsed {
        for path in &site.degradation.failed_required_clauses {
            *counts.entry(path.as_str()).or_insert(0) += 1;
        }
    }
    if counts.is_empty() {
        let best = collapsed.iter().map(|s| s.score).fold(0.0_f64, f64::max);
        return format!(
            "{} site(s) were feasible but scored below minScore {min_score}; best {best:.2}.",
            collapsed.len()
        );
    }
    let mut ranked: Vec<(&str, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let worst: Vec<String> = ranked
        .iter()
        .take(3)
        .map(|(path, count)| format!("{path} (failed at {count}/{} sites)", collapsed.len()))
        .collect();
    let example = collapsed
        .iter()
        .find(|s| !s.degradation.failed_required_clauses.is_empty())
        .map(|s| s.degradation.summary.clone())
        .unwrap_or_default();
    format!(
        "No feasible site. Required clauses that failed most often: {}. Example: {example}",
        worst.join(", ")
    )
}

/// Ranked, feasible sites for this anchor on this map.
pub fn match_anchor(
    anchor: &MAnchor,
    index: &DerivedMapIndex,
    options: &MatchOptions,
) -> Vec<MatchedSite> {
    match_anchor_report(anchor, index, options).sites
}
