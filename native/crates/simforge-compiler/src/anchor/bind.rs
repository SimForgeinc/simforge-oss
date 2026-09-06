//! Role binding: the **structural** pass. The seven role kinds resolve to a
//! [`FeatureBinding`] per site: which lane, which gate, which conflict point,
//! which route. The longitudinal solve (bisection on spawn `s` to hit an
//! arrival invariant) is the engine's job; this pass hands it the conflict
//! point and the route lane chains.

use std::collections::{BTreeMap, BTreeSet};

use super::frame::{enumerate_chains, Chain, WalkDir};
use super::{
    flip_relation, AnchorFrame, BindingStatus, ConflictBinding, FeatureBinding, FeatureMatch,
    MRole, MRoleKind, SitePose,
};
use crate::geometry::{angle_diff, heading_at_s, point_at_s, project_point, to_deg};
use crate::map_index::{DerivedMapIndex, LaneSideName, PointFeatureKind};
use crate::template::{ApproachRelation, HeadingRelationKind, OnMissing};

/// How far upstream a conflicting actor's route is walked for run-up.
pub const CONFLICT_RUNUP_M: f64 = 150.0;

/// Fallback template crossing angles per relation, when the role declares none.
pub fn default_template_angle_deg(relation: ApproachRelation) -> f64 {
    match relation {
        ApproachRelation::Opposing => 135.0,
        ApproachRelation::FromLeft | ApproachRelation::FromRight => 90.0,
        ApproachRelation::Merge | ApproachRelation::Same => 20.0,
    }
}

fn pose_at(k: i32, s: f64, t_frac: f64, heading_offset_rad: f64) -> SitePose {
    SitePose {
        k,
        s,
        t_frac,
        heading_offset_rad,
    }
}

struct ResolvedLane {
    status: BindingStatus,
    k: i32,
    lane_rsl: Option<String>,
}

/// Nearest existing lane index to `k` on the same side, for `clamp`.
fn clamp_k(frame: &AnchorFrame, k: i32) -> Option<i32> {
    let available: Vec<i32> = frame.lateral_lanes.keys().copied().collect();
    if available.is_empty() {
        return None;
    }
    let same_side: Vec<i32> = available
        .iter()
        .copied()
        .filter(|a| if k >= 0 { *a >= 0 } else { *a <= 0 })
        .collect();
    let pool = if same_side.is_empty() {
        &available
    } else {
        &same_side
    };
    let mut best = pool[0];
    for candidate in pool {
        if (candidate - k).abs() < (best - k).abs() {
            best = *candidate;
        }
    }
    Some(best)
}

/// Resolve one signed lane request against a site, honouring `on_missing`.
/// A request that cannot be met either fails, drops, or clamps because the
/// author said `clamp`; never because a code path defaulted to the nearest lane.
fn resolve_lane_offset(
    frame: &AnchorFrame,
    k: i32,
    on_missing: OnMissing,
    notes: &mut Vec<String>,
) -> ResolvedLane {
    if let Some(direct) = frame.lateral_rsl(k) {
        return ResolvedLane {
            status: BindingStatus::Bound,
            k,
            lane_rsl: Some(direct.to_owned()),
        };
    }
    match on_missing {
        OnMissing::Fail => {
            notes.push(format!(
                "lane k={k} does not exist at this site (onMissing: fail)"
            ));
            ResolvedLane {
                status: BindingStatus::Failed,
                k,
                lane_rsl: None,
            }
        }
        OnMissing::Drop => {
            notes.push(format!(
                "lane k={k} does not exist at this site (onMissing: drop)"
            ));
            ResolvedLane {
                status: BindingStatus::Dropped,
                k,
                lane_rsl: None,
            }
        }
        OnMissing::Clamp => match clamp_k(frame, k) {
            None => {
                notes.push("no same-direction lanes to clamp to".to_owned());
                ResolvedLane {
                    status: BindingStatus::Failed,
                    k,
                    lane_rsl: None,
                }
            }
            Some(clamped) => {
                notes.push(format!("lane k={k} clamped to k={clamped}"));
                ResolvedLane {
                    status: BindingStatus::Clamped,
                    k: clamped,
                    lane_rsl: frame.lateral_rsl(clamped).map(str::to_owned),
                }
            }
        },
    }
}

fn route_from(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    lane_rsl: Option<&str>,
    k: i32,
) -> Vec<String> {
    let Some(lane_rsl) = lane_rsl else {
        return Vec::new();
    };
    if k == 0 {
        if let Some(idx) = frame
            .reference_path
            .iter()
            .position(|sp| sp.lane_rsl == lane_rsl)
        {
            return frame.reference_path[idx..]
                .iter()
                .map(|sp| sp.lane_rsl.clone())
                .collect();
        }
    }
    let mut out = vec![lane_rsl.to_owned()];
    if let Some(forward) = enumerate_chains(index, lane_rsl, CONFLICT_RUNUP_M, WalkDir::Forward, 1)
        .into_iter()
        .next()
    {
        out.extend(forward.lanes);
    }
    out
}

fn route_through(index: &DerivedMapIndex, lane_rsl: &str) -> Vec<String> {
    let upstream = enumerate_chains(index, lane_rsl, CONFLICT_RUNUP_M, WalkDir::Backward, 1)
        .into_iter()
        .next()
        .unwrap_or_else(Chain::empty);
    let downstream = enumerate_chains(index, lane_rsl, CONFLICT_RUNUP_M, WalkDir::Forward, 1)
        .into_iter()
        .next()
        .unwrap_or_else(Chain::empty);
    let mut out = upstream.lanes;
    out.push(lane_rsl.to_owned());
    out.extend(downstream.lanes);
    out
}

struct LaneDropPair {
    terminating_rsl: String,
    terminating_k: i32,
    continuing_rsl: String,
    continuing_k: i32,
    side: LaneSideName,
}

/// Resolve the concrete disappearing lane and the only legal adjacent survivor.
fn lane_drop_pair(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    feature_matches: &BTreeMap<String, FeatureMatch>,
    feature: &str,
    notes: &mut Vec<String>,
) -> Option<LaneDropPair> {
    let m = feature_matches.get(feature);
    let terminating_rsl = m
        .and_then(|m| m.map_feature_id.strip_prefix("lane_drop:"))
        .and_then(|rest| rest.split('@').next())
        .filter(|r| !r.is_empty());
    let (Some(m), Some(terminating_rsl)) = (m, terminating_rsl) else {
        notes.push(format!(
            "feature \"{feature}\" has no exact lane_drop:<terminating-rsl> identity"
        ));
        return None;
    };
    let Some(term_lane) = index.lane(terminating_rsl) else {
        notes.push(format!(
            "feature \"{feature}\" has no exact lane_drop:<terminating-rsl> identity"
        ));
        return None;
    };
    let mut back_m = 0.5;
    while back_m <= 30.0 {
        let station_s = m.s - back_m;
        back_m += 0.5;
        let Some((span, s_in_lane)) = frame.lane_at_s(station_s) else {
            continue;
        };
        let Some(cs) = index.cross_section(&span.lane_rsl, s_in_lane) else {
            continue;
        };
        let Some((&terminating_k, _)) = cs
            .same_dir_driving
            .iter()
            .find(|(_, rsl)| rsl.as_str() == terminating_rsl)
        else {
            continue;
        };
        let reference_lane = index.lane(&span.lane_rsl).expect("span lane exists");
        let point = point_at_s(&reference_lane.polyline, s_in_lane);
        let local_s = project_point(&term_lane.polyline, point).s;
        let downstream: BTreeSet<String> = frame
            .lane_at_s(frame.s_range.1.min(m.s + 10.0))
            .and_then(|(sp, sil)| index.cross_section(&sp.lane_rsl, sil))
            .map(|cs| cs.same_dir_driving.values().cloned().collect())
            .unwrap_or_default();
        let mut candidates: Vec<LaneDropPair> = Vec::new();
        for (&continuing_k, continuing_rsl) in &cs.same_dir_driving {
            if (continuing_k - terminating_k).abs() != 1 || continuing_rsl == terminating_rsl {
                continue;
            }
            let side = if continuing_k > terminating_k {
                LaneSideName::Left
            } else {
                LaneSideName::Right
            };
            let continuing_lane = index.lane(continuing_rsl);
            let term_point = point_at_s(&term_lane.polyline, local_s);
            let continuing_at = continuing_lane.map(|l| project_point(&l.polyline, term_point));
            let lateral_separation_m = continuing_at.map_or(0.0, |p| p.distance);
            let mut continuation_m = match (continuing_lane, continuing_at) {
                (Some(l), Some(at)) => (l.length_m - at.s).max(0.0),
                _ => 0.0,
            };
            let mut cursor = continuing_lane;
            let mut visited: BTreeSet<String> = continuing_lane
                .map(|l| BTreeSet::from([l.rsl.clone()]))
                .unwrap_or_default();
            for _hop in 0..4 {
                let Some(c) = cursor else { break };
                if continuation_m >= 20.0 {
                    break;
                }
                let mut succ: Vec<&String> = c.successors.iter().collect();
                succ.sort();
                let Some(next) = succ.first().and_then(|r| index.lane(r)) else {
                    break;
                };
                if next.is_junction || !visited.insert(next.rsl.clone()) {
                    break;
                }
                continuation_m += next.length_m;
                cursor = Some(next);
            }
            let permitted = term_lane.lane_change_permissions.iter().any(|p| {
                p.side == side
                    && p.allowed
                    && local_s >= p.start_s - 1e-6
                    && local_s <= p.end_s + 1e-6
            });
            let continues = continuation_m >= 20.0
                && (downstream.contains(continuing_rsl)
                    || term_lane.successors.contains(continuing_rsl)
                    || continuing_lane
                        .is_some_and(|l| l.successors.iter().any(|r| downstream.contains(r)))
                    || downstream.is_empty());
            if permitted && continues && lateral_separation_m >= 1.5 {
                candidates.push(LaneDropPair {
                    terminating_rsl: terminating_rsl.to_owned(),
                    terminating_k,
                    continuing_rsl: continuing_rsl.clone(),
                    continuing_k,
                    side,
                });
            }
        }
        candidates.sort_by(|a, b| a.continuing_rsl.cmp(&b.continuing_rsl));
        if let Some(chosen) = candidates.into_iter().next() {
            return Some(chosen);
        }
        notes.push(format!("{terminating_rsl} has no immediately adjacent continuing sibling with an explicit allowed lane change at s={station_s:.1} m"));
        return None;
    }
    notes.push(format!("terminating lane {terminating_rsl} is not present immediately upstream of the matched taper"));
    None
}

/// The gate the reference path takes through a given junction, if any.
pub fn ego_gate_for_junction<'a>(
    index: &'a DerivedMapIndex,
    frame: &AnchorFrame,
    junction_id: &str,
) -> Option<&'a str> {
    if let Some(ego) = &frame.ego_gate_id {
        if let Some(gate) = index.gate(ego) {
            if gate.junction_id == junction_id {
                return Some(gate.id.as_str());
            }
        }
    }
    for i in 1..frame.reference_path.len() {
        let span = &frame.reference_path[i];
        let Some(lane) = index.lane(&span.lane_rsl) else {
            continue;
        };
        if lane.junction_id.as_deref() != Some(junction_id) {
            continue;
        }
        let approach = &frame.reference_path[i - 1];
        if let Some(gate) = index.gates.iter().find(|g| {
            g.junction_id == junction_id
                && g.approach_lane_rsl == approach.lane_rsl
                && g.connecting_lane_rsl == span.lane_rsl
        }) {
            return Some(gate.id.as_str());
        }
    }
    None
}

struct LocalRoleGeometry {
    segment_id: Option<String>,
    road_id: i64,
    section: i64,
    heading_rad: f64,
}

/// Resolve the lane actually nearest the actor's frame station.
fn local_role_geometry(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    binding: &FeatureBinding,
) -> Option<LocalRoleGeometry> {
    let pose = binding.pose?;
    let (span, s_in_lane) = frame.lane_at_s(pose.s)?;
    let reference_lane = index.lane(&span.lane_rsl)?;
    let world_point = point_at_s(&reference_lane.polyline, s_in_lane);
    let candidates: Vec<&String> = match (&binding.route_lane_chain, &binding.lane_rsl) {
        (Some(chain), _) if !chain.is_empty() => chain.iter().collect(),
        (_, Some(rsl)) => vec![rsl],
        _ => Vec::new(),
    };
    let mut best: Option<(&String, f64, f64)> = None;
    for lane_rsl in candidates {
        let Some(lane) = index.lane(lane_rsl) else {
            continue;
        };
        if lane.polyline.is_empty() {
            continue;
        }
        let projected = project_point(&lane.polyline, world_point);
        if best.is_none_or(|b| projected.distance < b.2) {
            best = Some((lane_rsl, projected.s, projected.distance));
        }
    }
    let (lane_rsl, s, _) = best?;
    let lane = index.lane(lane_rsl)?;
    Some(LocalRoleGeometry {
        segment_id: index.fact_index.segment_ids_by_lane.get(lane_rsl).cloned(),
        road_id: lane.road_id,
        section: lane.section,
        heading_rad: heading_at_s(&lane.polyline, s),
    })
}

fn enforce_local_role_semantics(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    roles: &[MRole],
    bindings: &mut [FeatureBinding],
) {
    let role_ids: BTreeSet<&str> = roles.iter().map(|r| r.role.as_str()).collect();
    let mut geometry_cache: BTreeMap<String, Option<LocalRoleGeometry>> = BTreeMap::new();
    for role in roles {
        let Some(pos) = bindings.iter().position(|b| b.role == role.role) else {
            continue;
        };
        if matches!(
            bindings[pos].status,
            BindingStatus::Failed | BindingStatus::Dropped
        ) {
            continue;
        }
        let mut geometry =
            |role_id: &str, bindings: &[FeatureBinding]| -> Option<LocalRoleGeometry> {
                if let Some(g) = geometry_cache.get(role_id) {
                    return g.as_ref().map(|g| LocalRoleGeometry {
                        segment_id: g.segment_id.clone(),
                        road_id: g.road_id,
                        section: g.section,
                        heading_rad: g.heading_rad,
                    });
                }
                let value = bindings
                    .iter()
                    .find(|b| b.role == role_id)
                    .and_then(|b| local_role_geometry(index, frame, b));
                let copy = value.as_ref().map(|g| LocalRoleGeometry {
                    segment_id: g.segment_id.clone(),
                    road_id: g.road_id,
                    section: g.section,
                    heading_rad: g.heading_rad,
                });
                geometry_cache.insert(role_id.to_owned(), value);
                copy
            };
        if let Some(other) = &role.required_same_segment_as {
            let own = geometry(&role.role, bindings);
            let reference = geometry(other, bindings);
            let ok = role_ids.contains(other.as_str())
                && match (&own, &reference) {
                    (Some(o), Some(r)) => o.segment_id.is_some() && o.segment_id == r.segment_id,
                    _ => false,
                };
            if !ok {
                bindings[pos].status = BindingStatus::Failed;
                bindings[pos].notes.push(format!(
                    "requires same local segment as {other}; resolved {} vs {}",
                    own.and_then(|g| g.segment_id)
                        .unwrap_or_else(|| "none".to_owned()),
                    reference
                        .and_then(|g| g.segment_id)
                        .unwrap_or_else(|| "none".to_owned())
                ));
            }
        }
        if let Some(other) = &role.required_same_road_section_as {
            if bindings[pos].status != BindingStatus::Failed {
                let own = geometry(&role.role, bindings);
                let reference = geometry(other, bindings);
                let ok = role_ids.contains(other.as_str())
                    && match (&own, &reference) {
                        (Some(o), Some(r)) => o.road_id == r.road_id && o.section == r.section,
                        _ => false,
                    };
                if !ok {
                    let fmt = |g: Option<LocalRoleGeometry>| {
                        g.map_or("none".to_owned(), |g| {
                            format!("{}:{}", g.road_id, g.section)
                        })
                    };
                    bindings[pos].status = BindingStatus::Failed;
                    bindings[pos].notes.push(format!(
                        "requires same road section as {other}; resolved {} vs {}",
                        fmt(own),
                        fmt(reference)
                    ));
                }
            }
        }
        if let Some(rel) = &role.required_heading_relation {
            if bindings[pos].status != BindingStatus::Failed {
                let own = geometry(&role.role, bindings);
                let reference = geometry(&rel.role, bindings);
                let (Some(own), Some(reference)) = (own, reference) else {
                    bindings[pos].status = BindingStatus::Failed;
                    bindings[pos].notes.push(format!(
                        "cannot resolve local heading relative to {}",
                        rel.role
                    ));
                    continue;
                };
                if !role_ids.contains(rel.role.as_str()) {
                    bindings[pos].status = BindingStatus::Failed;
                    bindings[pos].notes.push(format!(
                        "cannot resolve local heading relative to {}",
                        rel.role
                    ));
                    continue;
                }
                let separation = angle_diff(own.heading_rad, reference.heading_rad).abs();
                let error_rad = match rel.relation {
                    HeadingRelationKind::Parallel => separation,
                    HeadingRelationKind::Antiparallel => (std::f64::consts::PI - separation).abs(),
                };
                let error_deg = to_deg(error_rad);
                if error_deg > rel.max_error_deg + 1e-9 {
                    bindings[pos].status = BindingStatus::Failed;
                    bindings[pos].notes.push(format!(
                        "{} heading error {error_deg:.2}° exceeds {:.2}° relative to {}",
                        rel.relation.as_str(),
                        rel.max_error_deg,
                        rel.role
                    ));
                }
            }
        }
    }
}

fn bind_conflicting_gate(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    feature_matches: &BTreeMap<String, FeatureMatch>,
    role: &MRole,
) -> FeatureBinding {
    let MRoleKind::ConflictingGate {
        feature,
        from,
        turn,
        template_crossing_angle_deg,
        arrive_at_conflict,
        min_upstream_runway_m,
    } = &role.kind
    else {
        unreachable!("bind_conflicting_gate called for another kind")
    };
    let mut binding = FeatureBinding::new(&role.role, "conflicting_gate");
    let Some(junction_id) = feature_matches
        .get(feature)
        .and_then(|m| m.map_feature_id.strip_prefix("junction:"))
    else {
        binding.notes.push(format!(
            "role references feature \"{feature}\", which did not bind to a junction"
        ));
        return binding;
    };
    let descriptor = index.junction_descriptors.get(junction_id);
    let ego_gate_id = ego_gate_for_junction(index, frame, junction_id);
    let (Some(descriptor), Some(ego_gate_id)) = (descriptor, ego_gate_id) else {
        binding
            .notes
            .push(format!("no ego gate through junction {junction_id}"));
        return binding;
    };
    let template_angle =
        template_crossing_angle_deg.unwrap_or_else(|| default_template_angle_deg(*from));
    struct Candidate<'a> {
        pair: &'a crate::map_index::ConflictPair,
        other_gate_id: &'a str,
        relation: ApproachRelation,
        angle_error_deg: f64,
    }
    let mut candidates: Vec<Candidate<'_>> = Vec::new();
    for pair in &descriptor.conflict_pairs {
        if pair.gate_a != ego_gate_id && pair.gate_b != ego_gate_id {
            continue;
        }
        let other_gate_id = if pair.gate_a == ego_gate_id {
            &pair.gate_b
        } else {
            &pair.gate_a
        };
        let Some(other) = index.gate(other_gate_id) else {
            continue;
        };
        let relation = if pair.gate_a == ego_gate_id {
            pair.relation
        } else {
            flip_relation(pair.relation)
        };
        if relation != *from || other.turn_relation != *turn {
            continue;
        }
        candidates.push(Candidate {
            pair,
            other_gate_id,
            relation,
            angle_error_deg: (pair.crossing_angle_deg - template_angle).abs(),
        });
    }
    candidates.sort_by(|a, b| {
        a.angle_error_deg
            .partial_cmp(&b.angle_error_deg)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.other_gate_id.cmp(b.other_gate_id))
    });
    let Some(chosen) = candidates.into_iter().next() else {
        binding.notes.push(format!(
            "junction {junction_id} has no {} {} movement conflicting with the ego path",
            from.as_str(),
            turn.as_str()
        ));
        return binding;
    };
    let other_gate = index
        .gate(chosen.other_gate_id)
        .expect("candidate gate exists");
    let ego_gate = index.gate(ego_gate_id).expect("ego gate exists");
    let approach_len = index
        .lane(&other_gate.approach_lane_rsl)
        .map_or(0.0, |l| l.length_m);
    let upstream = enumerate_chains(
        index,
        &other_gate.approach_lane_rsl,
        CONFLICT_RUNUP_M,
        WalkDir::Backward,
        1,
    )
    .into_iter()
    .next()
    .unwrap_or_else(Chain::empty);
    let exit_chain = enumerate_chains(
        index,
        &other_gate.connecting_lane_rsl,
        CONFLICT_RUNUP_M,
        WalkDir::Forward,
        1,
    )
    .into_iter()
    .next()
    .unwrap_or_else(Chain::empty);
    let mut route_lane_chain = upstream.lanes.clone();
    route_lane_chain.push(other_gate.approach_lane_rsl.clone());
    route_lane_chain.push(other_gate.connecting_lane_rsl.clone());
    route_lane_chain.extend(exit_chain.lanes.iter().cloned());
    let (s_on_a, s_on_b) = if chosen.pair.gate_a == ego_gate_id {
        (chosen.pair.s_on_a, chosen.pair.s_on_b)
    } else {
        (chosen.pair.s_on_b, chosen.pair.s_on_a)
    };
    let s_on_actor = upstream.length_m + approach_len + s_on_b;
    let s_on_ego = frame
        .s_of_lane
        .get(&ego_gate.connecting_lane_rsl)
        .copied()
        .unwrap_or(0.0)
        + s_on_a;
    let available_upstream_m = upstream.length_m + approach_len;
    if let Some(min) = min_upstream_runway_m {
        if available_upstream_m + 1e-6 < *min {
            binding.notes.push(format!("conflicting gate has only {available_upstream_m:.2} m connected upstream runway; {min:.2} m required"));
            return binding;
        }
    }
    let spawn_s = -(upstream.length_m + approach_len);
    binding.status = BindingStatus::Bound;
    binding.lane_rsl = Some(
        upstream
            .lanes
            .first()
            .cloned()
            .unwrap_or_else(|| other_gate.approach_lane_rsl.clone()),
    );
    binding.route_lane_chain = Some(route_lane_chain);
    binding.pose = Some(pose_at(0, spawn_s, 0.0, 0.0));
    binding.conflict = Some(ConflictBinding {
        gate_id: other_gate.id.clone(),
        ego_gate_id: ego_gate_id.to_owned(),
        point: chosen.pair.point,
        s_on_ego,
        s_on_actor,
        crossing_angle_deg: chosen.pair.crossing_angle_deg,
        relation: chosen.relation,
        angle_error_deg: chosen.angle_error_deg,
    });
    binding.arrival = arrive_at_conflict.clone();
    binding.notes.push(format!(
        "bound to gate {} ({} {}), crossing at {}° (template {template_angle}°)",
        other_gate.id,
        chosen.relation.as_str(),
        other_gate.turn_relation.as_str(),
        simforge_core::math::js_round(chosen.pair.crossing_angle_deg * 10.0) / 10.0
    ));
    if index.lane(&other_gate.connecting_lane_rsl).is_none() {
        binding
            .notes
            .push("connecting lane missing from the index".to_owned());
    }
    binding
}

/// Bind every role against one frame. Order is the author's; refs look backwards.
pub fn bind_roles(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    roles: &[MRole],
    feature_matches: &BTreeMap<String, FeatureMatch>,
) -> Vec<FeatureBinding> {
    let mut out: Vec<FeatureBinding> = Vec::with_capacity(roles.len());
    for role in roles {
        let mut binding = match &role.kind {
            MRoleKind::OnReference { ds_m, t_frac } => {
                let mut b = FeatureBinding::new(&role.role, "on_reference");
                b.pose = Some(pose_at(0, *ds_m, *t_frac, 0.0));
                match frame.lane_at_s(*ds_m) {
                    Some((span, _)) => {
                        b.status = BindingStatus::Bound;
                        b.lane_rsl = Some(span.lane_rsl.clone());
                        b.route_lane_chain =
                            Some(route_from(index, frame, Some(&span.lane_rsl), 0));
                    }
                    None => b
                        .notes
                        .push(format!("s={ds_m} m is outside the reference path")),
                }
                b
            }
            MRoleKind::LaneOffset {
                k,
                on_missing,
                ds_m,
                t_frac,
            } => {
                let mut b = FeatureBinding::new(&role.role, "lane_offset");
                let resolved = resolve_lane_offset(frame, *k, *on_missing, &mut b.notes);
                b.status = resolved.status;
                b.on_missing = Some(*on_missing);
                b.requested_k = Some(*k);
                if resolved.status.is_placed() {
                    b.pose = Some(pose_at(resolved.k, *ds_m, *t_frac, 0.0));
                    b.route_lane_chain = Some(route_from(
                        index,
                        frame,
                        resolved.lane_rsl.as_deref(),
                        resolved.k,
                    ));
                    b.lane_rsl = resolved.lane_rsl;
                }
                b
            }
            MRoleKind::AtLaneDrop {
                feature,
                lane,
                ds_m,
                t_frac,
            } => {
                let mut b = FeatureBinding::new(&role.role, "at_lane_drop");
                let pair = lane_drop_pair(index, frame, feature_matches, feature, &mut b.notes);
                if let Some(pair) = pair {
                    let (selected_rsl, selected_k) = match lane {
                        super::MLaneDropLane::Terminating => {
                            (pair.terminating_rsl.clone(), pair.terminating_k)
                        }
                        super::MLaneDropLane::ContinuingSibling => {
                            (pair.continuing_rsl.clone(), pair.continuing_k)
                        }
                    };
                    b.status = BindingStatus::Bound;
                    b.pose = Some(pose_at(selected_k, *ds_m, *t_frac, 0.0));
                    b.route_lane_chain = Some(route_through(index, &selected_rsl));
                    b.notes.push(format!(
                        "{} lane {selected_rsl} bound at {feature}; legal {} merge to {}",
                        match lane {
                            super::MLaneDropLane::Terminating => "terminating",
                            super::MLaneDropLane::ContinuingSibling => "continuing_sibling",
                        },
                        match pair.side {
                            LaneSideName::Left => "left",
                            LaneSideName::Right => "right",
                        },
                        pair.continuing_rsl
                    ));
                    b.lane_rsl = Some(selected_rsl);
                }
                b
            }
            MRoleKind::Opposing {
                index: opp_index,
                ds_m,
                t_frac,
            } => {
                let mut b = FeatureBinding::new(&role.role, "opposing");
                match frame.opposing_lanes.get(*opp_index) {
                    Some(lane_rsl) => {
                        b.status = BindingStatus::Bound;
                        b.pose = Some(pose_at(0, *ds_m, *t_frac, std::f64::consts::PI));
                        b.route_lane_chain = Some(route_from(index, frame, Some(lane_rsl), 1));
                        b.lane_rsl = Some(lane_rsl.clone());
                    }
                    None => b
                        .notes
                        .push(format!("no opposing lane #{opp_index} at this site")),
                }
                b
            }
            MRoleKind::ConflictingGate { .. } => {
                bind_conflicting_gate(index, frame, feature_matches, role)
            }
            MRoleKind::OnCrossing {
                feature,
                start_frac,
                direction,
            } => {
                let mut b = FeatureBinding::new(&role.role, "on_crossing");
                let crossing = feature_matches.get(feature).and_then(|m| {
                    index
                        .point_features
                        .iter()
                        .find(|p| p.id == m.map_feature_id && p.kind == PointFeatureKind::Crossing)
                });
                match crossing {
                    Some(crossing) => {
                        let s = frame.s_of_lane.get(&crossing.lane_rsl).copied().unwrap_or(0.0) + crossing.s;
                        b.status = BindingStatus::Bound;
                        b.pose = Some(pose_at(0, s, start_frac * 2.0 - 1.0, std::f64::consts::FRAC_PI_2));
                        b.lane_rsl = Some(crossing.lane_rsl.clone());
                        let dir = match direction {
                            super::MCrossingDirection::LeftToRight => "left_to_right",
                            super::MCrossingDirection::RightToLeft => "right_to_left",
                        };
                        b.notes.push(format!("walks the crossing {} {dir}", crossing.id));
                    }
                    None => b.notes.push(if index.capabilities.crossings {
                        format!("feature \"{feature}\" did not bind to a crossing")
                    } else {
                        "this map index carries no crossing layer, so a pedestrian cannot be placed on a crossing".to_owned()
                    }),
                }
                b
            }
            MRoleKind::InParkingZone {
                feature,
                side,
                slot_index,
            } => {
                let mut b = FeatureBinding::new(&role.role, "in_parking_zone");
                let zone = feature_matches.get(feature).and_then(|m| {
                    index.point_features.iter().find(|p| {
                        p.id == m.map_feature_id && p.kind == PointFeatureKind::ParkingZone
                    })
                });
                match zone {
                    Some(zone) => {
                        let s =
                            frame.s_of_lane.get(&zone.lane_rsl).copied().unwrap_or(0.0) + zone.s;
                        b.status = BindingStatus::Bound;
                        b.pose = Some(pose_at(
                            0,
                            s,
                            if *side == super::MParkingSide::Left {
                                1.0
                            } else {
                                -1.0
                            },
                            0.0,
                        ));
                        b.lane_rsl = Some(zone.lane_rsl.clone());
                        b.notes
                            .push(format!("parked in {}, slot {slot_index}", zone.id));
                    }
                    None => b.notes.push(if index.capabilities.parking_zones {
                        format!("feature \"{feature}\" did not bind to a parking zone")
                    } else {
                        "this map index carries no parking-zone layer".to_owned()
                    }),
                }
                b
            }
            MRoleKind::RelativeTo {
                r#ref,
                d_lane,
                on_missing,
                ds_m,
                t_frac,
            } => {
                let mut b = FeatureBinding::new(&role.role, "relative_to");
                let reference = out
                    .iter()
                    .find(|x| x.role == *r#ref)
                    .and_then(|x| x.pose.map(|p| (p, x.status)));
                match reference {
                    None => b
                        .notes
                        .push(format!("reference role \"{ref}\" is not bound", ref = r#ref)),
                    Some((ref_pose, _)) => {
                        let wanted_k = ref_pose.k + d_lane;
                        let resolved =
                            resolve_lane_offset(frame, wanted_k, *on_missing, &mut b.notes);
                        b.on_missing = Some(*on_missing);
                        b.requested_k = Some(wanted_k);
                        b.status = resolved.status;
                        if resolved.status.is_placed() {
                            b.pose = Some(pose_at(
                                resolved.k,
                                ref_pose.s + ds_m,
                                t_frac.unwrap_or(ref_pose.t_frac),
                                0.0,
                            ));
                            b.route_lane_chain = Some(route_from(
                                index,
                                frame,
                                resolved.lane_rsl.as_deref(),
                                resolved.k,
                            ));
                            b.lane_rsl = resolved.lane_rsl;
                        }
                    }
                }
                b
            }
        };
        // A lane that exists in the frame but not at the actor's `s` is still
        // worth flagging: the solver would otherwise spawn into thin air.
        if binding.status.is_placed() {
            if let Some(pose) = binding.pose {
                if frame.lane_at_s(pose.s).is_none() && binding.kind != "conflicting_gate" {
                    binding
                        .notes
                        .push(format!("pose s={} m is outside the reference path", pose.s));
                }
                if let Some(rsl) = &binding.lane_rsl {
                    if index.cross_section(rsl, 0.0).is_none() {
                        binding
                            .notes
                            .push("lane has no usable cross-section".to_owned());
                    }
                }
            }
        }
        out.push(binding);
    }
    enforce_local_role_semantics(index, frame, roles, &mut out);
    out
}
