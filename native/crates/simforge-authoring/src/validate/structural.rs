//! Structural validation: everything checkable from the document alone.
//!
//! These are not "this file is malformed" (the strict parser owns that) but
//! "this scenario does not hold together", and the output is a list of
//! repairable findings `{code, path, message}` for an agent's repair loop:
//! reference resolution, `dynamics_required`, `bylatest_required`, one axis
//! one owner, the `set` key registry, derived-parameter and placement cycles,
//! non-portable roles. Codes, paths, messages and severities are the
//! scenario schema's tier-1 validator's, check for check.
//!
//! One axis, one owner: later preempts earlier, so a sequence of differing
//! start times is legal by construction. Flagged are two statically equal
//! exact starts on one `(actor, axis)` (`axis_conflict`), an exact `until`
//! that a later exact start truncates (`axis_conflict`), and two overlapping
//! windowed starts (`axis_conflict_possible`, a warning). Exact-vs-window is
//! the normal "cruise, then brake when close" shape and is not flagged.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{json, Value};
use simforge_compiler::anchor::adapt::template_static_scope;
use simforge_compiler::expr::{
    collect_param_refs, try_evaluate, EvalOutcome, Expr, ExprScope, NumberOrExpr,
};
use simforge_compiler::template::{
    CollisionWith, Condition, Essentiality, InvariantKind, LaneTarget, LeafCondition,
    LogicalCondition, MapDivergenceExtent, ParamKind, PointRef, RoleKind, RouteTarget,
    ScenarioTemplate, SceneAbsoluteInitialRoute, SignalRef, SpeedTarget, Trigger, Verb,
    WORLD_ROLE_REF,
};
use simforge_core::hash::cmp_utf16;

use super::issue::{Issue, Severity};
use super::manual_drive::manual_drive_verdict;
use super::set_keys::{check_set_value, lookup_set_key, set_key_namespace, AppliesTo};
use super::timing::{axis_timeline, resolve_trigger_time, TimeBound, TimingContext};
use crate::jsfmt::js;

/// Continuous verbs: a target with no rate is not reproducible.
const CONTINUOUS_VERBS: [&str; 4] = ["speed", "gap", "changeLane", "laneOffset"];

fn sorted(ids: impl IntoIterator<Item = String>) -> Value {
    let mut ids: Vec<String> = ids.into_iter().collect();
    ids.sort_by(|a, b| cmp_utf16(a, b));
    ids.dedup();
    json!(ids)
}

/// Every expression in the document with the dotted path it sits at: every
/// object whose `kind` is an expression node kind, found by walking the
/// template in its authored JSON shape.
pub fn collect_expressions(value: &Value) -> Vec<(String, Expr)> {
    fn walk(value: &Value, path: &mut Vec<String>, out: &mut Vec<(String, Expr)>) {
        match value {
            Value::Object(map) => {
                let is_expr = map
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|k| matches!(k, "num" | "ref" | "neg" | "bin" | "call"));
                if is_expr {
                    if let Ok(expr) = serde_json::from_value::<Expr>(value.clone()) {
                        out.push((path.join("."), expr));
                    }
                    return;
                }
                for (key, item) in map {
                    path.push(key.clone());
                    walk(item, path, out);
                    path.pop();
                }
            }
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    path.push(index.to_string());
                    walk(item, path, out);
                    path.pop();
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut Vec::new(), &mut out);
    out
}

/// Depth-first cycle search; the cycle includes the repeated node.
fn find_cycle(start: &str, edges: &BTreeMap<String, Vec<String>>) -> Option<Vec<String>> {
    fn walk(
        node: &str,
        edges: &BTreeMap<String, Vec<String>>,
        path: &mut Vec<String>,
        seen: &mut BTreeSet<String>,
    ) -> Option<Vec<String>> {
        if let Some(at) = path.iter().position(|p| p == node) {
            let mut cycle = path[at..].to_vec();
            cycle.push(node.to_owned());
            return Some(cycle);
        }
        if !seen.insert(node.to_owned()) {
            return None;
        }
        path.push(node.to_owned());
        for next in edges.get(node).map(Vec::as_slice).unwrap_or_default() {
            if let Some(found) = walk(next, edges, path, seen) {
                return Some(found);
            }
        }
        path.pop();
        None
    }
    walk(start, edges, &mut Vec::new(), &mut BTreeSet::new())
}

/// Ids sorted by JavaScript's default sort (the `[...map.keys()].sort()` order).
fn sorted_keys(edges: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    let mut ids: Vec<String> = edges.keys().cloned().collect();
    ids.sort_by(|a, b| cmp_utf16(a, b));
    ids
}

fn timed_route(times: impl IntoIterator<Item = f64>, path: &str, out: &mut Vec<Issue>) {
    let times: Vec<f64> = times.into_iter().collect();
    for (index, &t) in times.iter().enumerate() {
        if !t.is_finite() || t < 0.0 || (index > 0 && t <= times[index - 1]) {
            out.push(Issue::new(
                Severity::Error,
                "route_disconnected",
                format!("{path}.points.{index}.timeS"),
                "custom timed route times must be finite, nonnegative, and strictly increasing",
            ));
        }
    }
}

struct Refs<'a> {
    roles: HashMap<&'a str, &'a simforge_compiler::template::RoleBinding>,
    role_ids: Vec<String>,
    features: HashMap<&'a str, &'a simforge_compiler::template::AnchorFeature>,
    feature_ids: Vec<String>,
    interaction_ids: Vec<String>,
    traffic_controls: BTreeSet<&'a str>,
    out: Vec<Issue>,
}

impl<'a> Refs<'a> {
    fn new(template: &'a ScenarioTemplate) -> Self {
        Self {
            roles: template.roles.iter().map(|r| (r.id(), r)).collect(),
            role_ids: template.roles.iter().map(|r| r.id().to_owned()).collect(),
            features: template
                .anchor
                .features
                .iter()
                .map(|f| (f.id(), f))
                .collect(),
            feature_ids: template
                .anchor
                .features
                .iter()
                .map(|f| f.id().to_owned())
                .collect(),
            interaction_ids: template
                .choreography
                .interactions
                .iter()
                .map(|i| i.id().to_owned())
                .collect(),
            traffic_controls: template
                .traffic_controls
                .iter()
                .map(|c| c.id.as_str())
                .collect(),
            out: Vec::new(),
        }
    }

    fn push(
        &mut self,
        severity: Severity,
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.out.push(Issue::new(severity, code, path, message));
    }

    fn error(&mut self, code: &'static str, path: impl Into<String>, message: impl Into<String>) {
        self.push(Severity::Error, code, path, message);
    }

    fn need_role(&mut self, r: &str, path: String, allow_world: bool) -> bool {
        if allow_world && r == WORLD_ROLE_REF {
            return true;
        }
        if self.roles.contains_key(r) {
            return true;
        }
        let required = sorted(self.role_ids.clone());
        self.out.push(
            Issue::new(
                Severity::Error,
                "role_ref_unknown",
                path,
                format!("no role with id \"{r}\""),
            )
            .detail(Some(required), Some(json!(r))),
        );
        false
    }

    fn role(&mut self, r: &str, path: String) -> bool {
        self.need_role(r, path, false)
    }

    fn need_feature(&mut self, r: &str, path: String, kind: Option<&str>) {
        let Some(feature) = self.features.get(r) else {
            let required = sorted(self.feature_ids.clone());
            self.out.push(
                Issue::new(
                    Severity::Error,
                    "feature_ref_unknown",
                    path,
                    format!("no anchor feature with id \"{r}\""),
                )
                .detail(Some(required), Some(json!(r))),
            );
            return;
        };
        let actual = feature.kind_name();
        if let Some(kind) = kind {
            if actual != kind {
                self.out.push(
                    Issue::new(
                        Severity::Error,
                        "feature_kind_mismatch",
                        path,
                        format!("feature \"{r}\" is a {actual}; this reference needs a {kind}"),
                    )
                    .detail(Some(json!(kind)), Some(json!(actual))),
                );
            }
        }
    }

    fn need_interaction(&mut self, r: &str, path: String) {
        if !self.interaction_ids.iter().any(|i| i == r) {
            let required = sorted(self.interaction_ids.clone());
            self.out.push(
                Issue::new(
                    Severity::Error,
                    "interaction_ref_unknown",
                    path,
                    format!("no interaction with id \"{r}\""),
                )
                .detail(Some(required), Some(json!(r))),
            );
        }
    }

    fn point_ref(&mut self, point: &PointRef, path: &str) {
        match point {
            PointRef::Role { role } => {
                self.role(role, format!("{path}.role"));
            }
            PointRef::Feature { feature, .. } => {
                self.need_feature(feature, format!("{path}.feature"), None)
            }
            PointRef::Pose { .. } => {}
        }
    }

    fn trigger(&mut self, trigger: &Trigger, path: &str) {
        match trigger {
            Trigger::After { of, .. } => self.need_interaction(of, format!("{path}.of")),
            Trigger::When {
                condition,
                by_latest,
                ..
            } => {
                if by_latest.is_none() {
                    self.error(
                        "bylatest_required",
                        format!("{path}.byLatest"),
                        "every `when` trigger needs `byLatest`: a condition that never becomes true is otherwise a silent no-op",
                    );
                }
                self.condition(condition, &format!("{path}.condition"));
            }
            Trigger::Arrival {
                of, at, sync_with, ..
            } => {
                self.role(of, format!("{path}.of"));
                self.role(sync_with, format!("{path}.syncWith"));
                if of == sync_with {
                    self.error(
                        "self_reference",
                        format!("{path}.syncWith"),
                        "an arrival cannot be synchronised with itself",
                    );
                }
                self.point_ref(at, &format!("{path}.at"));
            }
            Trigger::At { .. } => {}
        }
    }

    fn condition(&mut self, condition: &Condition, path: &str) {
        for (i, leaf) in condition.leaves().into_iter().enumerate() {
            let leaf_path = match condition {
                Condition::Leaf(_) => path.to_owned(),
                Condition::Logical(LogicalCondition::Not { .. }) => format!("{path}.operand"),
                Condition::Logical(_) => format!("{path}.operands.{i}"),
            };
            self.leaf(leaf, &leaf_path);
        }
    }

    fn leaf(&mut self, leaf: &LeafCondition, lp: &str) {
        match leaf {
            LeafCondition::Distance { from, to, .. } => {
                self.role(from, format!("{lp}.from"));
                self.point_ref(to, &format!("{lp}.to"));
            }
            LeafCondition::Ttc { of, to, .. } | LeafCondition::Headway { of, to, .. } => {
                self.role(of, format!("{lp}.of"));
                self.role(to, format!("{lp}.to"));
                if of == to {
                    self.error(
                        "self_reference",
                        lp,
                        format!(
                            "{} between a role and itself is meaningless",
                            leaf.kind_name()
                        ),
                    );
                }
            }
            LeafCondition::Reaches { of, region, .. } => {
                self.role(of, format!("{lp}.of"));
                self.point_ref(region, &format!("{lp}.region"));
            }
            LeafCondition::Speed { of, .. } | LeafCondition::Standstill { of, .. } => {
                self.role(of, format!("{lp}.of"));
            }
            LeafCondition::Visible { of, to, .. } => {
                self.role(of, format!("{lp}.of"));
                self.role(to, format!("{lp}.to"));
            }
            LeafCondition::Detected { of, by, sensor, .. } => {
                self.role(of, format!("{lp}.of"));
                self.role(by, format!("{lp}.by"));
                // A sensor that nothing consumes is worse than no sensor at all.
                if let Some(observer) = self.roles.get(by.as_str()).copied() {
                    let sensors = &observer.base.actor.sensors;
                    if sensors.is_empty() {
                        self.error(
                            "sensor_ref_unknown",
                            format!("{lp}.by"),
                            format!("role \"{by}\" declares no sensors, so it can never detect anything"),
                        );
                    } else if let Some(sensor) = sensor {
                        if !sensors.iter().any(|s| &s.id == sensor) {
                            self.error(
                                "sensor_ref_unknown",
                                format!("{lp}.sensor"),
                                format!("role \"{by}\" has no sensor with id \"{sensor}\""),
                            );
                        }
                    }
                }
            }
            LeafCondition::Collision { of, with } => {
                self.role(of, format!("{lp}.of"));
                if let CollisionWith::Role(with) = with {
                    self.role(with, format!("{lp}.with"));
                }
            }
            LeafCondition::Signal { signal, .. } => match signal {
                SignalRef::Feature { feature, .. } => {
                    self.need_feature(feature, format!("{lp}.signal.feature"), Some("junction"));
                }
                SignalRef::Control { control }
                    if !self.traffic_controls.contains(control.as_str()) =>
                {
                    self.error(
                        "control_ref_unknown",
                        format!("{lp}.signal.control"),
                        format!("no traffic control with id \"{control}\""),
                    );
                }
                _ => {}
            },
        }
    }
}

/// Run every document-only check (unsorted; the report sorts).
pub fn structural_issues(template: &ScenarioTemplate) -> Vec<Issue> {
    let mut r = Refs::new(template);
    let scope = template_static_scope(template);
    let params: BTreeSet<&str> = template
        .params
        .declarations
        .iter()
        .map(|p| p.id())
        .collect();

    // --- expressions ---------------------------------------------------------
    for (path, expr) in collect_expressions(&template.to_value()) {
        for id in collect_param_refs(&expr) {
            if !params.contains(id.as_str()) {
                let required = sorted(params.iter().map(|p| (*p).to_owned()));
                r.out.push(
                    Issue::new(
                        Severity::Error,
                        "param_ref_unknown",
                        path.clone(),
                        format!("expression reads undeclared parameter \"{id}\""),
                    )
                    .detail(Some(required), Some(json!(id))),
                );
            }
        }
        if let EvalOutcome::Error(reason) = try_evaluate(&NumberOrExpr::Expr(expr), &scope) {
            r.error(
                "expr_error",
                path,
                format!("expression cannot be evaluated: {reason}"),
            );
        }
    }

    // Derived parameters must not depend on themselves.
    let mut derived: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for decl in &template.params.declarations {
        if let ParamKind::Derived { expr } = &decl.kind {
            derived.insert(decl.id().to_owned(), collect_param_refs(&expr.0));
        }
    }
    for id in sorted_keys(&derived) {
        if let Some(cycle) = find_cycle(&id, &derived) {
            r.out.push(
                Issue::new(
                    Severity::Error,
                    "derived_param_cycle",
                    "params.declarations",
                    format!(
                        "derived parameter \"{id}\" depends on itself: {}",
                        cycle.join(" -> ")
                    ),
                )
                .detail(None, Some(json!(cycle))),
            );
        }
    }

    // --- roles ---------------------------------------------------------------
    let mut rel: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (index, role) in template.roles.iter().enumerate() {
        let base = format!("roles.{index}");
        let id = role.id();
        if role.base.actor.r#static {
            let speed = match &role.base.initial_speed_kph {
                None => EvalOutcome::Value(0.0),
                Some(v) => try_evaluate(v, &scope),
            };
            if let EvalOutcome::Value(v) = speed {
                if v > 0.0 {
                    r.out.push(
                        Issue::new(
                            Severity::Error,
                            "static_actor_motion",
                            format!("{base}.initialSpeedKph"),
                            format!("static role \"{id}\" must have zero initial speed"),
                        )
                        .detail(Some(json!(0)), Some(json!(v))),
                    );
                }
            }
            if let RoleKind::SceneAbsolute {
                initial_route: Some(SceneAbsoluteInitialRoute::LanePath { .. }),
                ..
            } = &role.kind
            {
                r.error(
                    "static_actor_motion",
                    format!("{base}.initialRoute"),
                    format!("static role \"{id}\" cannot follow an initial route"),
                );
            }
        }
        match &role.kind {
            RoleKind::ConflictingGate {
                feature,
                arrive_at_conflict,
                ..
            } => {
                r.need_feature(feature, format!("{base}.feature"), Some("junction"));
                match arrive_at_conflict {
                    Some(arrive) if arrive.relative_to == id => r.error(
                        "self_reference",
                        format!("{base}.arriveAtConflict.relativeTo"),
                        "a role cannot synchronise its arrival with itself",
                    ),
                    Some(arrive) => {
                        r.role(&arrive.relative_to, format!("{base}.arriveAtConflict.relativeTo"));
                    }
                    None => r.push(
                        Severity::Warning,
                        "trigger_unbindable",
                        format!("{base}.arriveAtConflict"),
                        format!("role \"{id}\" occupies a conflicting gate with no arrival relation, so its timing is unconstrained; most such scenarios are trivially non-critical"),
                    ),
                }
            }
            RoleKind::OnCrossing { feature, .. } => {
                r.need_feature(feature, format!("{base}.feature"), Some("crossing"));
            }
            RoleKind::AtLaneDrop { feature, .. } => {
                r.need_feature(feature, format!("{base}.feature"), Some("lane_drop"));
            }
            RoleKind::InParkingZone { feature, .. } => {
                r.need_feature(feature, format!("{base}.feature"), Some("parking_zone"));
            }
            RoleKind::RelativeTo { r#ref, .. } => {
                if r#ref == id {
                    r.error(
                        "self_reference",
                        format!("{base}.ref"),
                        "a role cannot be placed relative to itself",
                    );
                } else if r.role(r#ref, format!("{base}.ref")) {
                    rel.insert(id.to_owned(), vec![r#ref.clone()]);
                }
            }
            RoleKind::SceneAbsolute {
                lane_ref,
                initial_route,
                ..
            } => {
                r.push(
                    Severity::Warning,
                    "non_portable_role",
                    base.clone(),
                    format!("role \"{id}\" is placed in absolute scene coordinates and cannot be retargeted to another map; rebind it to the anchor frame to make the template portable"),
                );
                if template.anchor.pin.is_none() {
                    r.error(
                        "pin_required",
                        "anchor.pin",
                        format!("role \"{id}\" uses absolute scene coordinates, which are only meaningful on one map; set anchor.pin"),
                    );
                }
                match initial_route {
                    Some(SceneAbsoluteInitialRoute::CustomTimedRoute { points }) => {
                        timed_route(
                            points.iter().map(|p| p.time_s),
                            &format!("{base}.initialRoute"),
                            &mut r.out,
                        );
                    }
                    Some(SceneAbsoluteInitialRoute::LanePath { lanes }) => {
                        let placed = lane_ref.as_ref().map(|l| l.rsl());
                        if placed.is_none() || lanes.first() != placed.as_ref() {
                            let message = match &placed {
                                Some(placed) => format!(
                                    "initial lanePath starts on \"{}\", not the actor's placed lane \"{placed}\"",
                                    lanes.first().map_or("undefined", String::as_str)
                                ),
                                None => "an initial lanePath requires a laneRef on its scene_absolute actor".to_owned(),
                            };
                            r.error(
                                "route_disconnected",
                                format!("{base}.initialRoute"),
                                message,
                            );
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    for id in sorted_keys(&rel) {
        if let Some(cycle) = find_cycle(&id, &rel) {
            r.out.push(
                Issue::new(
                    Severity::Error,
                    "relative_to_cycle",
                    "roles",
                    format!(
                        "roles are placed relative to each other in a cycle: {}",
                        cycle.join(" -> ")
                    ),
                )
                .detail(None, Some(json!(cycle))),
            );
        }
    }

    // --- props ---------------------------------------------------------------
    for (index, prop) in template.props.iter().enumerate() {
        let base = format!("props.{index}");
        if let Some(feature) = &prop.feature {
            r.need_feature(feature, format!("{base}.feature"), None);
        }
        if let Some(attachment) = &prop.attachment {
            r.role(&attachment.role, format!("{base}.attachment.role"));
            if prop.repeat.is_some() {
                r.error(
                    "attached_prop_repeat_unsupported",
                    format!("{base}.repeat"),
                    "an attached prop is one rigid object; author separate attached props instead of repeat",
                );
            }
        }
        if let Some(occludes) = &prop.occludes {
            r.role(&occludes.observer, format!("{base}.occludes.observer"));
            r.role(&occludes.target, format!("{base}.occludes.target"));
            if occludes.observer == occludes.target {
                r.error(
                    "self_reference",
                    format!("{base}.occludes"),
                    "an occluder cannot hide a role from itself",
                );
            }
        }
        if prop.target_reveal_to_conflict_s.is_some() && prop.occludes.is_none() {
            r.error(
                "occluder_pair_missing",
                format!("{base}.targetRevealToConflictS"),
                "reveal-to-conflict time is a relation between an observer and a target; set `occludes` to say who is hidden from whom",
            );
        }
        if prop.occludes.is_some() && prop.essentiality == Essentiality::Cosmetic {
            r.push(
                Severity::Warning,
                "occluder_dropped",
                format!("{base}.essentiality"),
                "a cosmetic occluder may be dropped by degradation, which deletes the point of an occlusion scenario",
            );
        }
    }

    // --- interactions --------------------------------------------------------
    for (index, interaction) in template.choreography.interactions.iter().enumerate() {
        let base = format!("choreography.interactions.{index}");
        let actor = interaction.actor();
        let verb = interaction.verb.name();
        let set_key = match &interaction.verb {
            Verb::Set { target } => Some(target.key.as_str()),
            _ => None,
        };
        let world_key =
            set_key.is_some_and(|k| matches!(set_key_namespace(k), "env" | "signal" | "control"));
        r.need_role(actor, format!("{base}.actor"), world_key);
        let actor_role = r.roles.get(actor).copied();
        if actor_role.is_some_and(|role| role.base.actor.r#static)
            && matches!(
                verb,
                "speed" | "gap" | "changeLane" | "laneOffset" | "route"
            )
        {
            r.error(
                "static_actor_motion",
                base.clone(),
                format!("static role \"{actor}\" cannot perform {verb} motion"),
            );
        }
        if let Some(control) = set_key
            .and_then(|k| k.strip_prefix("control:"))
            .and_then(|k| k.strip_suffix(".indication"))
            .filter(|c| !c.is_empty())
        {
            if !r.traffic_controls.contains(control) {
                r.error(
                    "control_ref_unknown",
                    format!("{base}.target.key"),
                    format!("no traffic control with id \"{control}\""),
                );
            }
        }
        if actor == WORLD_ROLE_REF && !world_key {
            r.error(
                "set_actor_mismatch",
                format!("{base}.actor"),
                format!("\"{WORLD_ROLE_REF}\" is only the actor for env.*, signal:*, and control:* sets; everything else is performed by a role"),
            );
        }

        r.trigger(&interaction.base.trigger, &format!("{base}.trigger"));
        if let Some(until) = &interaction.base.until {
            r.trigger(until, &format!("{base}.until"));
        }

        if CONTINUOUS_VERBS.contains(&verb) && interaction.verb.dynamics().is_none() {
            r.error(
                "dynamics_required",
                format!("{base}.dynamics"),
                format!("\"{verb}\" is a continuous change and needs dynamics {{shape, constraint, value}}; a target with no rate is not reproducible"),
            );
        }

        let pinned = template.anchor.pin.is_some();
        let pinned_scene_actor =
            actor_role.is_some_and(|a| matches!(a.kind, RoleKind::SceneAbsolute { .. }) && pinned);
        match &interaction.verb {
            Verb::Gap { target, .. } => {
                if target.role == actor {
                    r.error(
                        "self_reference",
                        format!("{base}.target.role"),
                        "an actor cannot keep a gap to itself",
                    );
                } else {
                    r.role(&target.role, format!("{base}.target.role"));
                }
            }
            Verb::Speed {
                target: SpeedTarget::Match { role, .. },
                ..
            } => {
                if role == actor {
                    r.error(
                        "self_reference",
                        format!("{base}.target.role"),
                        "an actor cannot match its own speed",
                    );
                } else {
                    r.role(role, format!("{base}.target.role"));
                }
            }
            Verb::ChangeLane {
                target: LaneTarget::ToRole { role },
                ..
            } => {
                r.role(role, format!("{base}.target.role"));
            }
            Verb::Route { target } => match target {
                RouteTarget::Turn { feature, .. } => {
                    r.need_feature(feature, format!("{base}.target.feature"), Some("junction"));
                }
                RouteTarget::Crossing {
                    feature,
                    from_frac,
                    to_frac,
                } => {
                    r.need_feature(feature, format!("{base}.target.feature"), Some("crossing"));
                    if from_frac == to_frac {
                        r.push(
                            Severity::Warning,
                            "route_disconnected",
                            format!("{base}.target"),
                            "crossing route starts and ends at the same point, so the actor never crosses",
                        );
                    }
                }
                RouteTarget::ToFeature { feature } => {
                    r.need_feature(feature, format!("{base}.target.feature"), None);
                }
                RouteTarget::LanePath { .. } => {
                    if !pinned_scene_actor {
                        r.error(
                            "route_disconnected",
                            format!("{base}.target"),
                            "an exact lanePath is map-bound and may only drive a pinned scene_absolute actor",
                        );
                    }
                }
                RouteTarget::CustomRoute { .. } | RouteTarget::CustomTimedRoute { .. } => {
                    if !pinned_scene_actor {
                        r.error(
                            "route_disconnected",
                            format!("{base}.target"),
                            "a custom route is map-bound and may only drive a pinned scene_absolute actor",
                        );
                    }
                    if let RouteTarget::CustomTimedRoute { points } = target {
                        timed_route(
                            points.iter().map(|p| p.time_s),
                            &format!("{base}.target"),
                            &mut r.out,
                        );
                    }
                }
                RouteTarget::TimedPolyline { points, .. } => {
                    timed_route(
                        points.iter().map(|p| p.time_s),
                        &format!("{base}.target"),
                        &mut r.out,
                    );
                }
                RouteTarget::ActorPolyline { points, .. } => {
                    // A route is either time-driven or it is not.
                    let timed: Vec<f64> = points.iter().filter_map(|p| p.time_s).collect();
                    if !timed.is_empty() && timed.len() != points.len() {
                        r.error(
                            "route_disconnected",
                            format!("{base}.target.points"),
                            "an actor-anchored route must be either fully timed or fully untimed",
                        );
                    } else if timed.len() == points.len() {
                        timed_route(timed, &format!("{base}.target"), &mut r.out);
                    }
                }
                RouteTarget::ManualDrive { recording } => {
                    if !pinned_scene_actor {
                        r.error(
                            "route_disconnected",
                            format!("{base}.target"),
                            "a manual drive take is map-bound and may only drive a pinned scene_absolute actor",
                        );
                    }
                    if let Some(role) = actor_role {
                        if role.base.actor.r#static
                            || role.base.actor.class
                                == simforge_compiler::template::ActorClass::StaticObject
                        {
                            r.error(
                                "static_actor_motion",
                                format!("{base}.actor"),
                                format!("static role \"{}\" cannot be driven; a manual drive needs a movable actor", role.id()),
                            );
                        }
                    }
                    if let Err((path, message)) =
                        manual_drive_verdict(recording, template.choreography.clip_seconds)
                    {
                        r.error(
                            "route_disconnected",
                            format!("{base}.target.recording.{path}"),
                            message,
                        );
                    }
                }
                RouteTarget::NearMiss { target: near, .. } => {
                    r.role(near, format!("{base}.target.target"));
                    if near == actor {
                        r.error(
                            "self_reference",
                            format!("{base}.target.target"),
                            "a near miss requires a distinct target actor",
                        );
                    }
                    if let Some(role) = actor_role {
                        if role.base.actor.class
                            != simforge_compiler::template::ActorClass::Pedestrian
                        {
                            r.error(
                                "actor_class_mismatch",
                                format!("{base}.actor"),
                                "nearMiss routes are only supported for pedestrians",
                            );
                        }
                    }
                }
                _ => {}
            },
            Verb::Set { target } => {
                let key = target.key.as_str();
                if let Err((code, message)) = check_set_value(key, &target.value) {
                    r.error(code, format!("{base}.target"), message);
                    continue;
                }
                if let (Some(declared), Some(role)) = (lookup_set_key(key), actor_role) {
                    let is_vru = role.base.actor.class.is_vru();
                    let mismatch = (declared.applies_to == AppliesTo::Vehicle && is_vru)
                        || (declared.applies_to == AppliesTo::Vru && !is_vru)
                        || declared.applies_to == AppliesTo::World;
                    if mismatch {
                        let class = role.base.actor.class.as_str();
                        r.out.push(
                            Issue::new(
                                Severity::Error,
                                "set_actor_mismatch",
                                format!("{base}.target.key"),
                                format!(
                                    "\"{key}\" applies to {}, but role \"{}\" is a {class}",
                                    declared.applies_to.as_str(),
                                    role.id()
                                ),
                            )
                            .detail(
                                Some(json!(declared.applies_to.as_str())),
                                Some(json!(class)),
                            ),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    // --- invariants ----------------------------------------------------------
    for (index, invariant) in template.invariants.iter().enumerate() {
        let base = format!("invariants.{index}");
        match &invariant.kind {
            InvariantKind::EventOrder { events, .. } => {
                for (i, id) in events.iter().enumerate() {
                    r.need_interaction(id, format!("{base}.events.{i}"));
                }
            }
            InvariantKind::NearMiss {
                pedestrian, target, ..
            } => {
                r.role(pedestrian, format!("{base}.pedestrian"));
                r.role(target, format!("{base}.target"));
                if pedestrian == target {
                    r.error(
                        "self_reference",
                        base.clone(),
                        "a near miss requires two distinct roles",
                    );
                }
            }
            kind => {
                let (of, to, sync_with, at) = invariant_refs(kind);
                r.role(of, format!("{base}.of"));
                if let Some(to) = to {
                    r.role(to, format!("{base}.to"));
                    if to == of {
                        r.error(
                            "self_reference",
                            base.clone(),
                            "an invariant cannot relate a role to itself",
                        );
                    }
                }
                if let Some(sync_with) = sync_with {
                    r.role(sync_with, format!("{base}.syncWith"));
                }
                if let Some(at) = at {
                    r.point_ref(at, &format!("{base}.at"));
                }
            }
        }
        // Perception invariants carry references the generic role check cannot see.
        let perception = match &invariant.kind {
            InvariantKind::DetectionGap { of, sensor, .. }
            | InvariantKind::TimeToFirstDetection { of, sensor, .. }
            | InvariantKind::PerceptionLag { of, sensor, .. } => Some((of, sensor)),
            _ => None,
        };
        if let Some((of, sensor)) = perception {
            if let Some(observer) = r.roles.get(of.as_str()).copied() {
                let sensors = &observer.base.actor.sensors;
                if sensors.is_empty() {
                    r.error(
                        "sensor_ref_unknown",
                        format!("{base}.of"),
                        format!(
                            "role \"{of}\" declares no sensors, so there is no detection to grade"
                        ),
                    );
                } else if let Some(sensor) = sensor {
                    if !sensors.iter().any(|s| &s.id == sensor) {
                        r.error(
                            "sensor_ref_unknown",
                            format!("{base}.sensor"),
                            format!("role \"{of}\" has no sensor with id \"{sensor}\""),
                        );
                    }
                }
            }
        }
        if let InvariantKind::MapDivergence { divergence, .. } = &invariant.kind {
            if !template
                .perception
                .map_divergences
                .iter()
                .any(|d| &d.id == divergence)
            {
                r.error(
                    "divergence_ref_unknown",
                    format!("{base}.divergence"),
                    format!("no perception.mapDivergences entry with id \"{divergence}\""),
                );
            }
        }
    }

    // --- declared map/percept divergence --------------------------------------
    for (index, divergence) in template.perception.map_divergences.iter().enumerate() {
        let base = format!("perception.mapDivergences.{index}");
        for (i, role) in divergence.observers.iter().enumerate() {
            r.role(role, format!("{base}.observers.{i}"));
        }
        if let MapDivergenceExtent::AroundRole { role, .. } = &divergence.extent {
            r.role(role, format!("{base}.extent.role"));
        }
    }

    // --- metric subject ------------------------------------------------------
    match &template.metric_subject {
        None => {
            if !template.roles.is_empty() {
                r.push(
                    Severity::Warning,
                    "metric_subject_missing",
                    "metricSubject",
                    "no metricSubject: the criticality filters need one role whose episode metrics decide whether an instance is interesting",
                );
            }
        }
        Some(subject) if !r.roles.contains_key(subject.as_str()) => {
            let required = sorted(r.role_ids.clone());
            r.out.push(
                Issue::new(
                    Severity::Error,
                    "metric_subject_unknown",
                    "metricSubject",
                    format!("no role with id \"{subject}\""),
                )
                .detail(Some(required), Some(json!(subject))),
            );
        }
        Some(_) => {}
    }

    // --- anchor --------------------------------------------------------------
    let corridor_clauses =
        template
            .anchor
            .corridor
            .as_ref()
            .map_or(0, |c| match serde_json::to_value(c) {
                Ok(Value::Object(map)) => map.values().filter(|v| !v.is_null()).count(),
                _ => 0,
            });
    if corridor_clauses == 0 && template.anchor.features.is_empty() && template.anchor.pin.is_none()
    {
        r.push(
            Severity::Warning,
            "anchor_unconstrained",
            "anchor",
            "this anchor constrains nothing, so it matches every corridor on every map; add a corridor clause, a feature, or a pin",
        );
    }
    if let Some(pin) = &template.anchor.pin {
        if pin.site_id.is_none() {
            r.push(
                Severity::Warning,
                "pin_site_unresolved",
                "anchor.pin",
                format!(
                    "pinned to map \"{}\" but to no site; the matcher cannot bind a frame until a siteId is chosen",
                    pin.map_id
                ),
            );
        }
    }

    // --- variants ------------------------------------------------------------
    for (vi, variant) in template.variants.iter().enumerate() {
        for (oi, over) in variant.overrides.iter().enumerate() {
            let path = format!("variants.{vi}.overrides.{oi}.path");
            let Some(segments) = parse_override_path(&over.path) else {
                r.error(
                    "variant_path_invalid",
                    path,
                    format!("\"{}\" is not a valid override path", over.path),
                );
                continue;
            };
            if let (Some(Segment::Key(root)), Some(Segment::Id(id))) =
                (segments.first(), segments.get(1))
            {
                let pool: Option<Vec<String>> = match root.as_str() {
                    "roles" => Some(r.role_ids.clone()),
                    "props" => Some(template.props.iter().map(|p| p.id.clone()).collect()),
                    "invariants" => Some(
                        template
                            .invariants
                            .iter()
                            .map(|i| i.base.id.clone())
                            .collect(),
                    ),
                    _ => None,
                };
                if let Some(pool) = pool {
                    if !pool.iter().any(|p| p == id) {
                        r.out.push(
                            Issue::new(
                                Severity::Error,
                                "variant_target_unknown",
                                path,
                                format!("no {root} entry with id \"{id}\""),
                            )
                            .detail(Some(sorted(pool)), Some(json!(id))),
                        );
                    }
                }
            }
        }
    }

    // --- timeline ------------------------------------------------------------
    let mut out = r.out;
    out.extend(timeline_issues(template, &scope));
    out
}

/// `(of, to?, syncWith?, at?)` of the generic role-relating invariants.
fn invariant_refs(kind: &InvariantKind) -> (&str, Option<&str>, Option<&str>, Option<&PointRef>) {
    match kind {
        InvariantKind::Headway { of, to, .. }
        | InvariantKind::Gap { of, to, .. }
        | InvariantKind::Ttc { of, to, .. }
        | InvariantKind::PathTtc { of, to, .. }
        | InvariantKind::Pet { of, to, .. }
        | InvariantKind::ClosingSpeed { of, to, .. }
        | InvariantKind::DetectionGap { of, to, .. }
        | InvariantKind::TimeToFirstDetection { of, to, .. }
        | InvariantKind::PerceptionLag { of, to, .. } => (of, Some(to), None, None),
        InvariantKind::Arrival {
            of, at, sync_with, ..
        } => (of, None, Some(sync_with), Some(at)),
        InvariantKind::SpeedRelLimit { of, .. }
        | InvariantKind::DecelBudget { of, .. }
        | InvariantKind::MapDivergence { of, .. } => (of, None, None, None),
        InvariantKind::EventOrder { .. } | InvariantKind::NearMiss { .. } => ("", None, None, None),
    }
}

/// One parsed override path segment.
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    Key(String),
    Index(usize),
    Id(String),
}

const OVERRIDE_ROOTS: [&str; 7] = [
    "roles",
    "props",
    "choreography",
    "invariants",
    "environment",
    "params",
    "metricSubject",
];

fn is_ident(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b[0].is_ascii_alphabetic()
        && b[1..]
            .iter()
            .all(|&c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// Split an override path (`roles#challenger.initialSpeedKph`) into segments;
/// `None` when malformed.
pub fn parse_override_path(path: &str) -> Option<Vec<Segment>> {
    let mut raw = path.split('.');
    let head = raw.next()?;
    let (root, id) = match head.split_once('#') {
        Some((root, id)) => (root, Some(id)),
        None => (head, None),
    };
    if !OVERRIDE_ROOTS.contains(&root) || id.is_some_and(|id| !is_ident(id)) {
        return None;
    }
    let mut out = vec![Segment::Key(root.to_owned())];
    if let Some(id) = id {
        out.push(Segment::Id(id.to_owned()));
    }
    for segment in raw {
        if !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit()) {
            out.push(Segment::Index(segment.parse().ok()?));
        } else if is_ident(segment) {
            out.push(Segment::Key(segment.to_owned()));
        } else {
            return None;
        }
    }
    Some(out)
}

fn timeline_issues(template: &ScenarioTemplate, scope: &ExprScope) -> Vec<Issue> {
    let mut out = Vec::new();
    let interactions = &template.choreography.interactions;
    let ctx = TimingContext {
        clip_start: -template.choreography.warmup_seconds,
        clip_end: template.choreography.clip_seconds,
        scope,
        by_id: interactions.iter().map(|i| (i.id(), i)).collect(),
    };
    let index_of: HashMap<&str, usize> = interactions
        .iter()
        .enumerate()
        .map(|(i, x)| (x.id(), i))
        .collect();
    let (clip_start, clip_end) = (ctx.clip_start, ctx.clip_end);

    // `after` cycles: one cycle, one issue (keyed on the member set).
    let mut after: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for interaction in interactions {
        if let Trigger::After { of, .. } = &interaction.base.trigger {
            if ctx.by_id.contains_key(of.as_str()) {
                after.insert(interaction.id().to_owned(), vec![of.clone()]);
            }
        }
    }
    let mut reported: BTreeSet<String> = BTreeSet::new();
    for id in sorted_keys(&after) {
        if let Some(cycle) = find_cycle(&id, &after) {
            let mut members: Vec<&String> =
                cycle.iter().collect::<BTreeSet<_>>().into_iter().collect();
            members.sort_by(|a, b| cmp_utf16(a, b));
            let key = members
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("|");
            if !reported.insert(key) {
                continue;
            }
            out.push(
                Issue::new(
                    Severity::Error,
                    "trigger_cycle",
                    format!(
                        "choreography.interactions.{}.trigger",
                        index_of.get(id.as_str()).copied().unwrap_or(0)
                    ),
                    format!("`after` triggers form a cycle: {}", cycle.join(" -> ")),
                )
                .detail(None, Some(json!(cycle))),
            );
        }
    }

    // Triggers outside the clip, and `until` before its own trigger.
    for (index, interaction) in interactions.iter().enumerate() {
        let base = format!("choreography.interactions.{index}");
        let start = resolve_trigger_time(&interaction.base.trigger, &ctx);
        if let TimeBound::Exact(t) = start {
            if t < clip_start || t > clip_end {
                out.push(
                    Issue::new(
                        Severity::Error,
                        "trigger_out_of_clip",
                        format!("{base}.trigger"),
                        format!(
                            "fires at t={}s, outside the clip [{}, {}]s",
                            js(t),
                            js(clip_start),
                            js(clip_end)
                        ),
                    )
                    .detail(Some(json!([clip_start, clip_end])), Some(json!(t))),
                );
            }
        }
        if let Trigger::When {
            by_latest: Some(_), ..
        } = &interaction.base.trigger
        {
            let deadline = start.latest();
            if deadline > clip_end {
                out.push(
                    Issue::new(
                        Severity::Warning,
                        "trigger_out_of_clip",
                        format!("{base}.trigger.byLatest"),
                        format!(
                            "deadline t={}s is after the clip ends at {}s, so the deadline can never be reached",
                            js(deadline),
                            js(clip_end)
                        ),
                    )
                    .detail(Some(json!(clip_end)), Some(json!(deadline))),
                );
            }
        }
        if let Some(until) = &interaction.base.until {
            let end = resolve_trigger_time(until, &ctx);
            if let (TimeBound::Exact(s), TimeBound::Exact(e)) = (start, end) {
                if e <= s {
                    out.push(
                        Issue::new(
                            Severity::Error,
                            "until_before_trigger",
                            format!("{base}.until"),
                            format!(
                                "ends at t={}s, at or before its own start at t={}s",
                                js(e),
                                js(s)
                            ),
                        )
                        .detail(Some(json!(format!("> {}", js(s)))), Some(json!(e))),
                    );
                }
            }
        }
    }

    // A manual drive take owns its actor's motion for the whole clip.
    for (index, interaction) in interactions.iter().enumerate() {
        let Verb::Route {
            target: RouteTarget::ManualDrive { .. },
        } = &interaction.verb
        else {
            continue;
        };
        let base = format!("choreography.interactions.{index}");
        let (id, actor) = (interaction.id(), interaction.actor());
        let start = resolve_trigger_time(&interaction.base.trigger, &ctx);
        if start != TimeBound::Exact(0.0) {
            out.push(
                Issue::new(
                    Severity::Error,
                    "axis_conflict",
                    format!("{base}.trigger"),
                    format!("manual drive \"{id}\" owns \"{actor}\" from the start of the clip; its trigger must be at(0)"),
                )
                .detail(
                    Some(json!({"kind": "at", "t": 0})),
                    Some(serde_json::to_value(&interaction.base.trigger).unwrap_or(Value::Null)),
                ),
            );
        }
        let end = interaction
            .base
            .until
            .as_ref()
            .map(|u| resolve_trigger_time(u, &ctx));
        if end != Some(TimeBound::Exact(clip_end)) {
            out.push(
                Issue::new(
                    Severity::Error,
                    "axis_conflict",
                    format!("{base}.until"),
                    format!(
                        "manual drive \"{id}\" owns \"{actor}\" until the clip ends; its until must be at({})",
                        js(clip_end)
                    ),
                )
                .detail(
                    Some(json!({"kind": "at", "t": clip_end})),
                    Some(
                        interaction
                            .base
                            .until
                            .as_ref()
                            .and_then(|u| serde_json::to_value(u).ok())
                            .unwrap_or(Value::Null),
                    ),
                ),
            );
        }
        for (other_index, other) in interactions.iter().enumerate() {
            if other_index == index || other.actor() != actor {
                continue;
            }
            let axis = other.verb.axis();
            if !matches!(axis.as_str(), "longitudinal" | "lateral" | "topology") {
                continue;
            }
            out.push(
                Issue::new(
                    Severity::Error,
                    "axis_conflict",
                    format!("choreography.interactions.{other_index}"),
                    format!(
                        "\"{}\" moves \"{actor}\" on the {axis} axis, but manual drive \"{id}\" already owns its motion for the whole clip; remove one of them",
                        other.id()
                    ),
                )
                .detail(Some(json!("no other motion interaction")), Some(json!([id, other.id()]))),
            );
        }
    }

    // One axis, one owner.
    for timeline in axis_timeline(interactions, &ctx) {
        let slots = &timeline.slots;
        for i in 0..slots.len() {
            let a = &slots[i];
            for b in &slots[i + 1..] {
                let path_a = format!("choreography.interactions.{}", a.index);
                let (a_id, b_id) = (a.interaction.id(), b.interaction.id());
                match (a.start, b.start) {
                    (TimeBound::Exact(ta), TimeBound::Exact(tb)) => {
                        if ta == tb {
                            out.push(
                                Issue::new(
                                    Severity::Error,
                                    "axis_conflict",
                                    path_a,
                                    format!(
                                        "\"{a_id}\" and \"{b_id}\" both take the {} axis of \"{}\" at t={}s; one axis has one owner",
                                        timeline.axis,
                                        timeline.actor,
                                        js(ta)
                                    ),
                                )
                                .detail(Some(json!("distinct trigger times")), Some(json!([a_id, b_id]))),
                            );
                        } else if let Some(TimeBound::Exact(end)) = a.declared_end {
                            if tb < end {
                                out.push(
                                    Issue::new(
                                        Severity::Error,
                                        "axis_conflict",
                                        format!("{path_a}.until"),
                                        format!(
                                            "\"{a_id}\" declares it holds the {} axis until t={}s, but \"{b_id}\" takes it at t={}s",
                                            timeline.axis,
                                            js(end),
                                            js(tb)
                                        ),
                                    )
                                    .detail(Some(json!(format!("until <= {}", js(tb)))), Some(json!(end))),
                                );
                            }
                        }
                    }
                    (TimeBound::Window { .. }, TimeBound::Window { .. }) => {
                        let overlaps = a.start.earliest() <= b.start.latest()
                            && b.start.earliest() <= a.start.latest();
                        if overlaps {
                            out.push(
                                Issue::new(
                                    Severity::Warning,
                                    "axis_conflict_possible",
                                    path_a,
                                    format!(
                                        "\"{a_id}\" and \"{b_id}\" can both take the {} axis of \"{}\" in the same window; their order is not statically determined",
                                        timeline.axis, timeline.actor
                                    ),
                                )
                                .detail(
                                    None,
                                    Some(json!([
                                        [a.start.earliest(), a.start.latest()],
                                        [b.start.earliest(), b.start.latest()]
                                    ])),
                                ),
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Event order that the static times already contradict.
    for (index, invariant) in template.invariants.iter().enumerate() {
        let InvariantKind::EventOrder { events, .. } = &invariant.kind else {
            continue;
        };
        let mut previous: Option<(&str, f64)> = None;
        for id in events {
            let Some(interaction) = ctx.by_id.get(id.as_str()) else {
                continue;
            };
            let TimeBound::Exact(t) = resolve_trigger_time(&interaction.base.trigger, &ctx) else {
                previous = None;
                continue;
            };
            if let Some((prev_id, prev_t)) = previous {
                if t < prev_t {
                    out.push(
                        Issue::new(
                            Severity::Error,
                            "event_order_inconsistent",
                            format!("invariants.{index}.events"),
                            format!(
                                "\"{id}\" is declared after \"{prev_id}\" but fires earlier (t={}s vs t={}s)",
                                js(t),
                                js(prev_t)
                            ),
                        )
                        .detail(Some(json!(format!(">= {}", js(prev_t)))), Some(json!(t))),
                    );
                }
            }
            previous = Some((id, t));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_paths() {
        assert_eq!(
            parse_override_path("roles#challenger.initialSpeedKph"),
            Some(vec![
                Segment::Key("roles".into()),
                Segment::Id("challenger".into()),
                Segment::Key("initialSpeedKph".into())
            ])
        );
        assert_eq!(
            parse_override_path("choreography.interactions.0.dynamics"),
            Some(vec![
                Segment::Key("choreography".into()),
                Segment::Key("interactions".into()),
                Segment::Index(0),
                Segment::Key("dynamics".into())
            ])
        );
        assert!(parse_override_path("meta.name").is_none());
        assert!(parse_override_path("roles..x").is_none());
        assert!(parse_override_path("roles#1x").is_none());
        assert!(parse_override_path("roles.x#y").is_none());
    }

    #[test]
    fn cycles() {
        let mut edges = BTreeMap::new();
        edges.insert("a".to_owned(), vec!["b".to_owned()]);
        edges.insert("b".to_owned(), vec!["a".to_owned()]);
        assert_eq!(
            find_cycle("a", &edges),
            Some(vec!["a".into(), "b".into(), "a".into()])
        );
        edges.insert("b".to_owned(), vec!["c".to_owned()]);
        assert_eq!(find_cycle("a", &edges), None);
    }
}
