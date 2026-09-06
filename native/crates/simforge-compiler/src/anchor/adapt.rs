//! The authored v2 template → matcher vocabulary adapter.
//!
//! | authored (v2) | matcher | how |
//! |---|---|---|
//! | `Range = [n\|null, n\|null]` | `(f64, f64)` | open ends become ±`OPEN_END_M` |
//! | `runway*M: Range` | `f64` | the range's lower bound is the requirement |
//! | `egoTurn: Turn[]` | `Turn` | first entry; a note when more were offered |
//! | `from: 'same'` | (absent) | mapped to `merge` with a note |
//! | `adjacent: bike\|bus\|rail\|none` | `biking\|…` | `bike`→`biking`; `bus`/`rail`/`none` dropped |
//! | `pose.s: number \| Expr` | `ds_m: f64` | evaluated at param defaults (structural only) |

use serde::Serialize;

use super::{
    MAdjacentKind, MAnchor, MArrival, MClause, MConflictingApproach, MCorridor, MCrossingDirection,
    MCrossingPredicate, MDiversity, MFeature, MFeatureKind, MHeadingRelation, MJunctionPredicate,
    MLaneChangeLegal, MLaneDropLane, MParkingPredicate, MParkingSide, MPin, MPolicy, MRange, MRole,
    MRoleKind, OPEN_END_M,
};
use crate::expr::{ExprScope, NumberOrExpr};
use crate::template::{
    AdjacentKind, ApproachRelation, Clause, CrossingDirection, Diversity, Essentiality,
    FeatureKind, LaneDropLane, ParkingSlot, Range, RoleKind, ScenarioTemplate, Side,
    SimpleFeatureKind,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AdaptSeverity {
    Note,
    Error,
}

/// The one code every "the matcher cannot express this" failure carries.
pub const CLAUSE_UNMATCHABLE: &str = "clause_unmatchable";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AdaptNote {
    pub path: String,
    pub reason: String,
    pub severity: AdaptSeverity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

impl AdaptNote {
    fn note(path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            reason: reason.into(),
            severity: AdaptSeverity::Note,
            code: None,
        }
    }
}

/// Record a discarded requirement: loud unless the author marked it cosmetic.
fn dropped(notes: &mut Vec<AdaptNote>, path: &str, essentiality: Essentiality, reason: &str) {
    if essentiality == Essentiality::Cosmetic {
        notes.push(AdaptNote::note(path, reason));
    } else {
        notes.push(AdaptNote {
            path: path.to_owned(),
            reason: format!(
                "{reason} — this {} clause is unmatchable, so no site can be checked against it",
                essentiality.as_str()
            ),
            severity: AdaptSeverity::Error,
            code: Some(CLAUSE_UNMATCHABLE),
        });
    }
}

/// The discarded-requirement subset of an adaptation's notes.
pub fn unmatchable_notes(notes: &[AdaptNote]) -> Vec<&AdaptNote> {
    notes
        .iter()
        .filter(|n| n.severity == AdaptSeverity::Error)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AdaptedAnchor {
    pub anchor: MAnchor,
    pub roles: Vec<MRole>,
    pub notes: Vec<AdaptNote>,
}

/// Scope used to turn authored expressions into the numbers the matcher wants.
pub fn template_static_scope(template: &ScenarioTemplate) -> ExprScope {
    let mut scope = ExprScope::default().with_clip(Some(template.choreography.clip_seconds));
    for decl in &template.params.declarations {
        if let Some(v) = decl.default_value() {
            scope.params.insert(decl.id().to_owned(), v);
        }
    }
    scope
}

/// Best-effort numeric value of an authored `number | Expr`; site-dependent
/// expressions fall back to `fallback` for the structural pass only.
pub fn numberish(value: Option<&NumberOrExpr>, scope: &ExprScope, fallback: f64) -> f64 {
    value
        .and_then(|v| v.evaluate(scope).ok())
        .unwrap_or(fallback)
}

pub fn close_range(range: &Range) -> MRange {
    (
        range.0.unwrap_or(-OPEN_END_M),
        range.1.unwrap_or(OPEN_END_M),
    )
}

fn clause_of<A, B>(clause: Option<&Clause<A>>, map: impl FnOnce(&A) -> B) -> Option<MClause<B>> {
    clause.map(|c| MClause::new(map(&c.value), c.essentiality, c.weight))
}

fn adjacent_kind(kind: AdjacentKind) -> Option<MAdjacentKind> {
    match kind {
        AdjacentKind::Parking => Some(MAdjacentKind::Parking),
        AdjacentKind::Bike => Some(MAdjacentKind::Biking),
        AdjacentKind::Sidewalk => Some(MAdjacentKind::Sidewalk),
        AdjacentKind::Shoulder => Some(MAdjacentKind::Shoulder),
        AdjacentKind::Median => Some(MAdjacentKind::Median),
        AdjacentKind::Bus | AdjacentKind::Rail | AdjacentKind::None => None,
    }
}

fn approach_relation(
    from: ApproachRelation,
    path: &str,
    notes: &mut Vec<AdaptNote>,
) -> ApproachRelation {
    if from == ApproachRelation::Same {
        notes.push(AdaptNote::note(
            path,
            "approach relation 'same' has no matcher equivalent; matched as 'merge'",
        ));
        return ApproachRelation::Merge;
    }
    from
}

fn adapt_corridor(template: &ScenarioTemplate, notes: &mut Vec<AdaptNote>) -> Option<MCorridor> {
    let c = template.anchor.corridor.as_ref()?;
    let adjacent = |clause: Option<&Clause<Vec<AdjacentKind>>>,
                    path: &str,
                    notes: &mut Vec<AdaptNote>|
     -> Option<MClause<Vec<MAdjacentKind>>> {
        let clause = clause?;
        let mut kept: Vec<MAdjacentKind> = Vec::new();
        for kind in &clause.value {
            match adjacent_kind(*kind) {
                Some(m) => kept.push(m),
                None => dropped(
                    notes,
                    path,
                    clause.essentiality,
                    &format!(
                        "adjacent kind \"{}\" is not evaluable by the matcher",
                        kind.as_str()
                    ),
                ),
            }
        }
        if kept.is_empty() {
            return None;
        }
        kept.sort();
        Some(MClause::new(kept, clause.essentiality, clause.weight))
    };
    let runway = |clause: Option<&Clause<Range>>,
                  path: &str,
                  notes: &mut Vec<AdaptNote>|
     -> Option<MClause<f64>> {
        let clause = clause?;
        match clause.value.0 {
            Some(lo) => Some(MClause::new(lo, clause.essentiality, clause.weight)),
            None => {
                dropped(notes, path, clause.essentiality, "an open-ended runway range states no minimum, and a minimum is the only thing the matcher can check");
                None
            }
        }
    };
    let lane_change_legal = c.lane_change_legal.as_ref().map(|lc| {
        if lc.value.s_range.is_none() {
            notes.push(AdaptNote::note(
                "anchor.corridor.laneChangeLegal",
                "no sRange given; checked over the whole approach",
            ));
        }
        MClause::new(
            MLaneChangeLegal {
                side: lc.value.side,
                s_range: lc
                    .value
                    .s_range
                    .as_ref()
                    .map_or((-OPEN_END_M, 0.0), close_range),
            },
            lc.essentiality,
            lc.weight,
        )
    });
    Some(MCorridor {
        through_lanes_same_dir: clause_of(c.through_lanes_same_dir.as_ref(), close_range),
        through_lanes_opposing: clause_of(c.through_lanes_opposing.as_ref(), close_range),
        lane_width_m: clause_of(c.lane_width_m.as_ref(), close_range),
        speed_limit_kph: clause_of(c.speed_limit_kph.as_ref(), close_range),
        runway_upstream_m: runway(
            c.runway_upstream_m.as_ref(),
            "anchor.corridor.runwayUpstreamM",
            notes,
        ),
        runway_downstream_m: runway(
            c.runway_downstream_m.as_ref(),
            "anchor.corridor.runwayDownstreamM",
            notes,
        ),
        curvature_deg_per10m: clause_of(c.curvature_deg_per10m.as_ref(), close_range),
        grade_pct: clause_of(c.grade_pct.as_ref(), close_range),
        requires_adjacent: adjacent(
            c.requires_adjacent.as_ref(),
            "anchor.corridor.requiresAdjacent",
            notes,
        ),
        forbids_adjacent: adjacent(
            c.forbids_adjacent.as_ref(),
            "anchor.corridor.forbidsAdjacent",
            notes,
        ),
        lane_change_legal,
    })
}

/// The crossing angle a `conflicting_gate` role should be ranked against.
pub fn template_crossing_angle(template: &ScenarioTemplate, feature_id: &str) -> Option<f64> {
    let feature = template.anchor.feature(feature_id)?;
    let FeatureKind::Junction {
        conflicting_approach,
        ..
    } = &feature.kind
    else {
        return None;
    };
    let range = conflicting_approach
        .as_ref()?
        .value
        .crossing_angle_deg
        .as_ref()?;
    match (range.0, range.1) {
        (None, None) => None,
        (None, Some(hi)) => Some(hi),
        (Some(lo), None) => Some(lo),
        (Some(lo), Some(hi)) => Some((lo + hi) / 2.0),
    }
}

fn feature_kind(feature: &crate::template::AnchorFeature) -> Option<MFeatureKind> {
    Some(match (&feature.kind, feature.simple_kind) {
        (FeatureKind::Junction { .. }, _) => MFeatureKind::Junction,
        (FeatureKind::Crossing { .. }, _) => MFeatureKind::Crossing,
        (FeatureKind::ParkingZone { .. }, _) => MFeatureKind::ParkingZone,
        (FeatureKind::Simple, Some(k)) => match k {
            SimpleFeatureKind::Merge => MFeatureKind::Merge,
            SimpleFeatureKind::LaneDrop => MFeatureKind::LaneDrop,
            SimpleFeatureKind::Driveway => MFeatureKind::Driveway,
            SimpleFeatureKind::BusStop => MFeatureKind::BusStop,
            SimpleFeatureKind::SchoolZone => MFeatureKind::SchoolZone,
            SimpleFeatureKind::WorkZoneSuitable => MFeatureKind::WorkZoneSuitable,
            SimpleFeatureKind::OcclusionZone => MFeatureKind::OcclusionZone,
            SimpleFeatureKind::Crest => MFeatureKind::Crest,
            SimpleFeatureKind::Diverge
            | SimpleFeatureKind::Curve
            | SimpleFeatureKind::RailCrossing => return None,
        },
        (FeatureKind::Simple, None) => return None,
    })
}

fn adapt_feature(
    feature: &crate::template::AnchorFeature,
    is_origin: bool,
    notes: &mut Vec<AdaptNote>,
) -> Option<MFeature> {
    let path = format!("anchor.features.{}", feature.id());
    let Some(kind) = feature_kind(feature) else {
        dropped(
            notes,
            &path,
            feature.base.essentiality,
            &format!(
                "feature kind \"{}\" is not matchable; the whole feature is dropped",
                feature.kind_name()
            ),
        );
        return None;
    };
    let at_m = match &feature.base.at_m {
        Some(c) => MClause::new(close_range(&c.value), c.essentiality, c.weight),
        None => MClause::new(
            if is_origin {
                (0.0, 0.0)
            } else {
                (-OPEN_END_M, OPEN_END_M)
            },
            if is_origin {
                Essentiality::Required
            } else {
                Essentiality::Cosmetic
            },
            None,
        ),
    };
    let mut out = MFeature {
        id: feature.id().to_owned(),
        kind,
        at_m,
        lateral_distance_m: clause_of(feature.base.lateral_distance_m.as_ref(), close_range),
        same_road: clause_of(feature.base.same_road.as_ref(), |v| *v),
        side: clause_of(feature.base.side.as_ref(), |v| *v),
        supports_scenario: clause_of(feature.supports_scenario.as_ref(), Clone::clone),
        junction: None,
        crossing: None,
        parking: None,
    };
    match &feature.kind {
        FeatureKind::Junction {
            arms,
            control,
            ego_turn,
            conflicting_approach,
            size_m,
            has_crossing_on_leg,
        } => {
            let mut jp = MJunctionPredicate {
                arms: clause_of(arms.as_ref(), close_range),
                control: clause_of(control.as_ref(), Clone::clone),
                ..Default::default()
            };
            if let Some(t) = ego_turn {
                if t.value.len() > 1 {
                    let rest: Vec<&str> = t.value[1..].iter().map(|x| x.as_str()).collect();
                    notes.push(AdaptNote::note(
                        format!("{path}.egoTurn"),
                        format!(
                            "the matcher evaluates one ego turn; kept \"{}\" and dropped {}",
                            t.value[0].as_str(),
                            rest.join(", ")
                        ),
                    ));
                }
                if let Some(first) = t.value.first() {
                    jp.ego_turn = Some(MClause::new(*first, t.essentiality, t.weight));
                }
            }
            if let Some(ca) = conflicting_approach {
                jp.conflicting_approach = Some(MClause::new(
                    MConflictingApproach {
                        from: approach_relation(
                            ca.value.from,
                            &format!("{path}.conflictingApproach.from"),
                            notes,
                        ),
                        turn: ca.value.turn,
                        crossing_angle_deg: ca.value.crossing_angle_deg.as_ref().map(close_range),
                    },
                    ca.essentiality,
                    ca.weight,
                ));
            }
            jp.size_m = clause_of(size_m.as_ref(), close_range);
            jp.has_crossing_on_leg = clause_of(has_crossing_on_leg.as_ref(), |v| *v);
            if !jp.is_empty() {
                out.junction = Some(jp);
            }
        }
        FeatureKind::Crossing {
            marked,
            controlled,
            length_m,
            placement,
        } => {
            let cp = MCrossingPredicate {
                marked: clause_of(marked.as_ref(), |v| *v),
                controlled: clause_of(controlled.as_ref(), |v| *v),
                length_m: clause_of(length_m.as_ref(), close_range),
                placement: clause_of(placement.as_ref(), |v| *v),
            };
            if cp != MCrossingPredicate::default() {
                out.crossing = Some(cp);
            }
        }
        FeatureKind::ParkingZone {
            orientation,
            capacity,
            occupancy,
            length_m,
        } => {
            let pp = MParkingPredicate {
                orientation: clause_of(orientation.as_ref(), |v| *v),
                capacity: clause_of(capacity.as_ref(), close_range),
                occupancy: clause_of(occupancy.as_ref(), close_range),
                length_m: clause_of(length_m.as_ref(), close_range),
            };
            if pp != MParkingPredicate::default() {
                out.parking = Some(pp);
            }
        }
        FeatureKind::Simple => {}
    }
    Some(out)
}

/// The lane index an authored role actually names, or 0.
fn authored_lane_offset(role: &crate::template::RoleBinding) -> i32 {
    match &role.kind {
        RoleKind::LaneOffset { k, .. } => *k,
        RoleKind::SceneAbsolute { .. } => 0,
        RoleKind::ConflictingGate { fallback_pose, .. } => {
            fallback_pose.as_ref().map_or(0, |p| p.lane_offset)
        }
        RoleKind::OnReference { pose }
        | RoleKind::Opposing { pose, .. }
        | RoleKind::AtLaneDrop { pose, .. } => pose.lane_offset,
        RoleKind::OnCrossing { .. }
        | RoleKind::InParkingZone { .. }
        | RoleKind::RelativeTo { .. } => 0,
    }
}

fn adapt_role(
    role: &crate::template::RoleBinding,
    template: &ScenarioTemplate,
    scope: &ExprScope,
    notes: &mut Vec<AdaptNote>,
) -> Option<MRole> {
    let path = format!("roles.{}", role.id());
    let base = |kind: MRoleKind| MRole {
        role: role.id().to_owned(),
        essentiality: role.base.essentiality,
        required_same_segment_as: role.base.required_same_segment_as.clone(),
        required_same_road_section_as: role.base.required_same_road_section_as.clone(),
        required_heading_relation: role.base.required_heading_relation.as_ref().map(|h| {
            MHeadingRelation {
                role: h.role.clone(),
                relation: h.relation,
                max_error_deg: h.max_error_deg,
            }
        }),
        kind,
    };
    let authored_k = authored_lane_offset(role);
    if authored_k != 0
        && !matches!(
            role.kind,
            RoleKind::OnReference { .. } | RoleKind::LaneOffset { .. }
        )
    {
        notes.push(AdaptNote::note(
            format!("{path}.pose.laneOffset"),
            format!(
                "laneOffset {authored_k} is not applied: a \"{}\" role's lane is resolved structurally by the matcher; use kind \"lane_offset\" to name a lane index",
                role.kind.name()
            ),
        ));
    }
    let pose_nums = |pose: &crate::template::FramePose| {
        (
            numberish(Some(&pose.s), scope, 0.0),
            numberish(Some(&pose.t_frac.to_number_or_expr()), scope, 0.0),
        )
    };
    Some(match &role.kind {
        RoleKind::OnReference { pose } => {
            let (ds_m, t_frac) = pose_nums(pose);
            if authored_k != 0 {
                notes.push(AdaptNote::note(
                    format!("{path}.pose.laneOffset"),
                    format!("on_reference carries laneOffset {authored_k}, which names a lane rather than the reference lane; bound as lane_offset k={authored_k} with onMissing: \"fail\""),
                ));
                base(MRoleKind::LaneOffset {
                    k: authored_k,
                    on_missing: crate::template::OnMissing::Fail,
                    ds_m,
                    t_frac,
                })
            } else {
                base(MRoleKind::OnReference { ds_m, t_frac })
            }
        }
        RoleKind::LaneOffset {
            k,
            on_missing,
            pose,
        } => {
            let (ds_m, t_frac) = pose_nums(pose);
            base(MRoleKind::LaneOffset {
                k: *k,
                on_missing: *on_missing,
                ds_m,
                t_frac,
            })
        }
        RoleKind::AtLaneDrop {
            feature,
            lane,
            pose,
        } => {
            let (ds_m, t_frac) = pose_nums(pose);
            base(MRoleKind::AtLaneDrop {
                feature: feature.clone(),
                lane: match lane {
                    LaneDropLane::Terminating => MLaneDropLane::Terminating,
                    LaneDropLane::ContinuingSibling => MLaneDropLane::ContinuingSibling,
                },
                ds_m,
                t_frac,
            })
        }
        RoleKind::Opposing { k, pose } => {
            let (ds_m, t_frac) = pose_nums(pose);
            base(MRoleKind::Opposing {
                index: (*k).max(0) as usize,
                ds_m,
                t_frac,
            })
        }
        RoleKind::ConflictingGate {
            feature,
            from,
            turn,
            arrive_at_conflict,
            required_upstream_runway_m,
            ..
        } => base(MRoleKind::ConflictingGate {
            feature: feature.clone(),
            from: approach_relation(*from, &format!("{path}.from"), notes),
            turn: *turn,
            template_crossing_angle_deg: template_crossing_angle(template, feature),
            arrive_at_conflict: arrive_at_conflict.as_ref().map(|a| MArrival {
                relative_to: a.relative_to.clone(),
                delta_t: numberish(Some(&a.delta_t), scope, 0.0),
            }),
            min_upstream_runway_m: required_upstream_runway_m
                .as_ref()
                .map(|v| numberish(Some(v), scope, 0.0)),
        }),
        RoleKind::OnCrossing {
            feature,
            start_frac,
            direction,
            ..
        } => base(MRoleKind::OnCrossing {
            feature: feature.clone(),
            start_frac: *start_frac,
            direction: match direction {
                CrossingDirection::NearToFar => MCrossingDirection::LeftToRight,
                CrossingDirection::FarToNear => MCrossingDirection::RightToLeft,
            },
        }),
        RoleKind::InParkingZone { feature, slot, .. } => {
            let slot_index = match slot {
                ParkingSlot::Index(i) => *i,
                ParkingSlot::Named(crate::template::ParkingSlotName::Last) => {
                    notes.push(AdaptNote::note(format!("{path}.slot"), "the matcher binds a parking zone as a point, so \"last\" resolves to the zone itself"));
                    0
                }
                ParkingSlot::Named(_) => 0,
            };
            let side = match template
                .anchor
                .feature(feature)
                .and_then(|f| f.base.side.as_ref())
                .map(|s| s.value)
            {
                Some(Side::Left) => MParkingSide::Left,
                _ => MParkingSide::Right,
            };
            base(MRoleKind::InParkingZone {
                feature: feature.clone(),
                side,
                slot_index,
            })
        }
        RoleKind::RelativeTo {
            r#ref,
            d_lane,
            ds_m,
            t_frac,
            ..
        } => base(MRoleKind::RelativeTo {
            r#ref: r#ref.clone(),
            d_lane: *d_lane,
            on_missing: if role.base.essentiality == Essentiality::Required {
                crate::template::OnMissing::Fail
            } else {
                crate::template::OnMissing::Drop
            },
            ds_m: numberish(Some(ds_m), scope, 0.0),
            t_frac: Some(*t_frac),
        }),
        RoleKind::SceneAbsolute { .. } => {
            notes.push(AdaptNote::note(
                path,
                "scene_absolute roles are not portable and cannot be matched; role dropped",
            ));
            return None;
        }
    })
}

/// Adapt a parsed v2 template onto the matcher's anchor + role vocabulary.
pub fn adapt_template(template: &ScenarioTemplate) -> AdaptedAnchor {
    let mut notes = Vec::new();
    let scope = template_static_scope(template);
    let origin_id = template.anchor.features.first().map(|f| f.id().to_owned());
    let mut features = Vec::new();
    for feature in &template.anchor.features {
        if let Some(adapted) = adapt_feature(
            feature,
            origin_id.as_deref() == Some(feature.id()),
            &mut notes,
        ) {
            features.push(adapted);
        }
    }
    let policy = MPolicy {
        allow_mirror: template.anchor.policy.allow_mirror,
        max_sites_per_map: template.anchor.policy.max_sites_per_map as usize,
        diversity: match template.anchor.policy.diversity {
            Diversity::Strict => MDiversity::Junction,
            Diversity::Moderate => MDiversity::RoadDirection,
            Diversity::Off => MDiversity::None,
        },
        min_score: template.anchor.policy.min_score,
    };
    let mut pin = None;
    if let Some(p) = &template.anchor.pin {
        match &p.site_id {
            Some(site_id) => pin = Some(MPin { map_id: p.map_id.clone(), site_id: site_id.clone() }),
            None => notes.push(AdaptNote::note("anchor.pin", "pin carries a map but no siteId (pin_site_unresolved); matching against the clauses instead")),
        }
    }
    let corridor = adapt_corridor(template, &mut notes).filter(|c| !c.is_empty());
    let anchor = MAnchor {
        id: template
            .anchor
            .id
            .clone()
            .unwrap_or_else(|| "anchor".to_owned()),
        corridor,
        features,
        policy,
        pin,
    };
    let mut roles = Vec::new();
    for role in &template.roles {
        if let Some(adapted) = adapt_role(role, template, &scope, &mut notes) {
            roles.push(adapted);
        }
    }
    AdaptedAnchor {
        anchor,
        roles,
        notes,
    }
}
