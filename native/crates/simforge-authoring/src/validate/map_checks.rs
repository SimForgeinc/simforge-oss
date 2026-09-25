//! Tier-1 checks that need a map, asked through a [`SiteContext`].
//!
//! The cheap geometric truths: actors spawned on top of each other or on a
//! sidewalk, lane changes into lanes that do not exist, triggers bound to
//! signals the map does not have, and `runway_insufficient` over the whole
//! clip (a quality warning: reaching the end of a route is a supported
//! terminal condition). Every check degrades to silence when the context
//! cannot answer.

use std::collections::HashMap;

use serde_json::{json, Value};
use simforge_compiler::anchor::adapt::template_static_scope;
use simforge_compiler::expr::{try_evaluate, EvalOutcome, ExprScope, NumberOrExpr};
use simforge_compiler::map_signals::SiteSignalRef;
use simforge_compiler::template::{
    FeatureKind, LaneTarget, OnMissing, PointRef, RoleBinding, RoleKind, RouteTarget,
    ScenarioTemplate, SignalRef, Trigger, Verb,
};
use simforge_core::hash::cmp_utf16;

use super::issue::{Issue, Severity};
use super::map_context::{LaneFacts, SiteContext};
use crate::jsfmt::{fixed_number, js, round, to_fixed};

/// Lane surfaces a road vehicle may legally start on.
const VEHICLE_LANES: [&str; 4] = ["driving", "parking", "shoulder", "restricted"];
/// Lane surfaces a VRU may legally start on.
const VRU_LANES: [&str; 6] = [
    "sidewalk",
    "biking",
    "crosswalk",
    "shoulder",
    "median",
    "parking",
];
/// Speeds above `limit * this` are flagged.
const SPEED_TOLERANCE: f64 = 1.15;

struct Placed<'a> {
    role: &'a RoleBinding,
    index: usize,
    k: i32,
    s: f64,
}

fn scope_for(
    lane: Option<&LaneFacts>,
    base: &ExprScope,
    junction_size_m: Option<f64>,
) -> ExprScope {
    base.clone()
        .with_lane(
            lane.and_then(|l| l.speed_limit_kph),
            lane.map(|l| l.width_m),
        )
        .with_junction(junction_size_m)
}

fn num(value: Option<&NumberOrExpr>, scope: &ExprScope) -> Option<f64> {
    match try_evaluate(value?, scope) {
        EvalOutcome::Value(v) => Some(v),
        _ => None,
    }
}

fn first_junction_size(template: &ScenarioTemplate, map: &SiteContext<'_>) -> Option<f64> {
    template
        .anchor
        .features
        .iter()
        .filter(|f| matches!(f.kind, FeatureKind::Junction { .. }))
        .find_map(|f| map.feature(f.id()).and_then(|facts| facts.size_m))
}

/// Run the map-dependent tier-1 checks against a bound site.
pub fn map_issues(template: &ScenarioTemplate, map: &SiteContext<'_>) -> Vec<Issue> {
    let mut out = Vec::new();
    let base = template_static_scope(template);
    let junction_size = first_junction_size(template, map);
    let clip_seconds = template.choreography.clip_seconds;
    let warmup_seconds = template.choreography.warmup_seconds;

    // --- role placement ------------------------------------------------------
    let mut placed: Vec<Placed<'_>> = Vec::new();
    for (index, role) in template.roles.iter().enumerate() {
        // scene_absolute is not in frame coordinates; at_lane_drop's lane is
        // owned by the feature-aware matcher; solver-placed kinds have no pose.
        if matches!(
            role.kind,
            RoleKind::SceneAbsolute { .. } | RoleKind::AtLaneDrop { .. }
        ) {
            continue;
        }
        let Some(pose) = role.pose() else { continue };
        let k = match &role.kind {
            RoleKind::LaneOffset { k, .. } => *k,
            _ => pose.lane_offset,
        };
        let Some(s) = num(Some(&pose.s), &scope_for(None, &base, junction_size)) else {
            continue; // depends on a site fact we cannot resolve here
        };
        let lane = map.lane_at(k, s);
        placed.push(Placed { role, index, k, s });

        let path = format!("roles.{index}");
        let id = role.id();
        let Some(lane) = lane else {
            let handled = match &role.kind {
                RoleKind::LaneOffset { on_missing, .. } if *on_missing != OnMissing::Fail => {
                    Some(*on_missing)
                }
                _ => None,
            };
            let severity = match handled {
                Some(OnMissing::Clamp) => Severity::Warning,
                Some(_) => Severity::Info,
                None => Severity::Error,
            };
            let suffix = handled
                .map(|h| format!("; onMissing=\"{}\" will handle it", h.as_str()))
                .unwrap_or_default();
            out.push(
                Issue::new(
                    severity,
                    "role_unbound",
                    format!("{path}.pose"),
                    format!(
                        "no lane at frame position (k={k}, s={} m) on {}{suffix}",
                        js(s),
                        map.map_id()
                    ),
                )
                .detail(Some(json!(format!("lane at k={k}"))), Some(Value::Null)),
            );
            continue;
        };

        let is_vru = role.base.actor.class.is_vru();
        let legal: &[&str] = if is_vru { &VRU_LANES } else { &VEHICLE_LANES };
        if !legal.contains(&lane.lane_type) {
            let mut required: Vec<&str> = legal.to_vec();
            required.sort_by(|a, b| cmp_utf16(a, b));
            out.push(
                Issue::new(
                    Severity::Error,
                    "wrong_lane_type",
                    format!("{path}.pose"),
                    format!(
                        "role \"{id}\" is a {} but frame position (k={k}, s={} m) is a \"{}\" lane",
                        role.base.actor.class.as_str(),
                        js(s),
                        lane.lane_type
                    ),
                )
                .detail(Some(json!(required)), Some(json!(lane.lane_type))),
            );
        }

        let scope = scope_for(Some(&lane), &base, junction_size);
        let initial = role.base.initial_speed_kph.as_ref();
        let evaluated = num(initial, &scope);
        let speed_kph = evaluated.or(lane.speed_limit_kph);
        if let (Some(_), Some(limit)) = (initial, lane.speed_limit_kph) {
            if evaluated.unwrap_or(0.0) > limit * SPEED_TOLERANCE {
                let shown = evaluated.map_or("undefined".to_owned(), js);
                out.push(
                    Issue::new(
                        Severity::Warning,
                        "speed_over_limit",
                        format!("{path}.initialSpeedKph"),
                        format!(
                            "role \"{id}\" starts at {shown} kph where the limit is {} kph",
                            js(limit)
                        ),
                    )
                    .detail(Some(json!(limit)), evaluated.map(|v| json!(v))),
                );
            }
        }

        if let Some(speed) = speed_kph.filter(|v| *v > 0.0) {
            let need_m = speed / 3.6 * clip_seconds;
            let have_m = map.forward_runway_m(k, s);
            if have_m < need_m {
                out.push(
                    Issue::new(
                        Severity::Warning,
                        "runway_insufficient",
                        path.clone(),
                        format!(
                            "role \"{id}\" needs {} m of road ahead to travel the whole {}s clip at {} kph, but only {} m is drivable",
                            to_fixed(need_m, 0),
                            js(clip_seconds),
                            to_fixed(speed, 0),
                            to_fixed(have_m, 0)
                        ),
                    )
                    .detail(Some(json!(round(need_m))), Some(json!(round(have_m)))),
                );
            }
            let warmup_m = speed / 3.6 * warmup_seconds;
            let upstream_m = map.upstream_runway_m(k, s);
            if upstream_m < warmup_m {
                out.push(
                    Issue::new(
                        Severity::Warning,
                        "runway_insufficient",
                        path.clone(),
                        format!(
                            "role \"{id}\" has {} m of run-up but needs {} m to reach {} kph during the warm-up; it will appear already at speed",
                            to_fixed(upstream_m, 0),
                            to_fixed(warmup_m, 0),
                            to_fixed(speed, 0)
                        ),
                    )
                    .detail(Some(json!(round(warmup_m))), Some(json!(round(upstream_m)))),
                );
            }
        }
    }

    // --- spawn overlap -------------------------------------------------------
    for i in 0..placed.len() {
        for b in &placed[i + 1..] {
            let a = &placed[i];
            if a.k != b.k {
                continue;
            }
            let clearance = (a.role.dims().length + b.role.dims().length) / 2.0;
            let gap = (a.s - b.s).abs();
            if gap < clearance {
                out.push(
                    Issue::new(
                        Severity::Error,
                        "spawn_overlap",
                        format!("roles.{}.pose", a.index),
                        format!(
                            "roles \"{}\" and \"{}\" start {} m apart in lane k={}, but their footprints need {} m",
                            a.role.id(),
                            b.role.id(),
                            to_fixed(gap, 1),
                            a.k,
                            to_fixed(clearance, 1)
                        ),
                    )
                    .detail(Some(json!(fixed_number(clearance, 1))), Some(json!(fixed_number(gap, 1)))),
                );
            }
        }
    }

    // The last placement of an id wins, as in a JavaScript `Map`.
    let placed_by_id: HashMap<&str, &Placed<'_>> =
        placed.iter().map(|p| (p.role.id(), p)).collect();

    // --- interactions --------------------------------------------------------
    for (index, interaction) in template.choreography.interactions.iter().enumerate() {
        let path = format!("choreography.interactions.{index}");
        let actor = placed_by_id.get(interaction.actor()).copied();

        if let (Verb::ChangeLane { target, .. }, Some(actor)) = (&interaction.verb, actor) {
            let target_k = match target {
                LaneTarget::Relative { dk } => Some(actor.k + dk),
                LaneTarget::Absolute { k } => Some(*k),
                LaneTarget::ToRole { role } => placed_by_id.get(role.as_str()).map(|p| p.k),
            };
            if let Some(target_k) = target_k {
                if map.lane_at(target_k, actor.s).is_none() {
                    out.push(
                        Issue::new(
                            Severity::Error,
                            "illegal_lane_change",
                            format!("{path}.target"),
                            format!(
                                "\"{}\" changes into lane k={target_k}, which does not exist at s={} m",
                                interaction.actor(),
                                js(actor.s)
                            ),
                        )
                        .detail(Some(json!(format!("lane k={target_k}"))), Some(Value::Null)),
                    );
                } else if target_k != actor.k {
                    let permissions = map.lane_change_permissions(actor.k, actor.s);
                    let left = target_k > actor.k;
                    let allowed = if left {
                        permissions.left
                    } else {
                        permissions.right
                    };
                    if !allowed {
                        let side = if left { "left" } else { "right" };
                        out.push(
                            Issue::new(
                                Severity::Warning,
                                "illegal_lane_change",
                                format!("{path}.target"),
                                format!(
                                    "lane markings at s={} m forbid a {side} lane change; tier 2 confirms against the actual crossing point",
                                    js(actor.s)
                                ),
                            )
                            .detail(Some(json!(format!("{side} change allowed"))), Some(json!(false))),
                        );
                    }
                }
            }
        }

        if let Verb::Route {
            target: RouteTarget::Turn { feature, turn },
        } = &interaction.verb
        {
            if !map.gate(feature, "same", *turn) {
                out.push(
                    Issue::new(
                        Severity::Error,
                        "route_disconnected",
                        format!("{path}.target"),
                        format!(
                            "no {} movement out of feature \"{feature}\" from the reference approach",
                            turn.as_str()
                        ),
                    )
                    .detail(Some(json!(turn.as_str())), Some(Value::Null)),
                );
            }
        }

        for trigger in
            std::iter::once(&interaction.base.trigger).chain(interaction.base.until.as_ref())
        {
            if let Trigger::When { condition, .. } = trigger {
                for leaf in condition.leaves() {
                    let simforge_compiler::template::LeafCondition::Signal {
                        signal, phase, ..
                    } = leaf
                    else {
                        continue;
                    };
                    let r#ref = match signal {
                        SignalRef::Control { .. } => continue,
                        SignalRef::Handle { handle } => SiteSignalRef::Handle(handle),
                        SignalRef::Feature { feature, approach } => SiteSignalRef::Feature {
                            feature_id: feature,
                            approach: *approach,
                        },
                    };
                    match map.signal(r#ref) {
                        None => out.push(
                            Issue::new(
                                Severity::Error,
                                "trigger_unbindable",
                                format!("{path}.trigger.condition"),
                                "the signal this condition waits on does not exist at the bound site",
                            )
                            .detail(None, Some(serde_json::to_value(signal).unwrap_or(Value::Null))),
                        ),
                        Some(facts) if !facts.phases.iter().any(|p| p == phase.as_str()) => out.push(
                            Issue::new(
                                Severity::Error,
                                "trigger_unbindable",
                                format!("{path}.trigger.condition.phase"),
                                format!("signal \"{}\" never shows \"{}\"", facts.handle, phase.as_str()),
                            )
                            .detail(Some(json!(facts.phases)), Some(json!(phase.as_str()))),
                        ),
                        Some(_) => {}
                    }
                }
            }
            if let Trigger::Arrival {
                at: PointRef::Feature { feature, .. },
                ..
            } = trigger
            {
                if map.feature(feature).is_none() {
                    out.push(Issue::new(
                        Severity::Error,
                        "trigger_unbindable",
                        format!("{path}.trigger.at"),
                        format!("feature \"{feature}\" is not bound at this site, so the arrival point is unknown"),
                    ));
                }
            }
        }
    }

    // --- roles that name junction movements ----------------------------------
    for (index, role) in template.roles.iter().enumerate() {
        let RoleKind::ConflictingGate {
            feature,
            from,
            turn,
            ..
        } = &role.kind
        else {
            continue;
        };
        if !map.gate(feature, from.as_str(), *turn) {
            out.push(
                Issue::new(
                    Severity::Error,
                    "role_unbound",
                    format!("roles.{index}"),
                    format!(
                        "no {} movement from the {} approach of feature \"{feature}\" at this site",
                        turn.as_str(),
                        from.as_str()
                    ),
                )
                .detail(
                    Some(json!(format!("{}/{}", from.as_str(), turn.as_str()))),
                    Some(Value::Null),
                ),
            );
        }
    }

    out
}
