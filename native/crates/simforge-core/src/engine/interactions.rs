//! Trigger cycle and verb → controller mapping: window ends, trigger firing
//! in sorted interaction order, `until` release, preemption, route commits,
//! gear engagement and door state. All mutations here happen between the
//! collision pass and planning, on the same frozen tick.

use std::f64::consts::PI;

use crate::error::{SimIssue, SimIssueCode};
use crate::map::{
    build_follow_route, build_route, retarget_to_lane, retarget_to_neighbour, FollowRouteOptions,
    LaneSide, RetargetOptions, TimedRoute,
};
use crate::math::{cbrt, clamp, normalize_angle, Vec2};
use crate::physics::{MotionActorInitialization, MotionBackend, MotionInitialState};
use crate::trace::{AbortReason, DespawnReason, ReleasedReason, SimEvent};
use crate::types::{
    ControlIndication, Dynamics, DynamicsConstraint, ExistState, Interaction, LaneChangeTarget,
    LaneOffsetMode, RouteActionTarget, RouteSpec, SetValue, SpeedTarget, Verb,
};

use super::actor::{
    axis_of, ActorIndex, AxisId, GapReference, InteractionIndex, LaneChangeSide, LateralCommand,
    LateralKind, LongitudinalCommand, LongitudinalKind, MatchReference, PendingRetarget,
};
use super::controllers::{cruise_speed, desired_gap_m, limits_for};
use super::doors::{
    articulated_door_obb_for, door_target, DoorName, DoorRuntime, DOOR_OPEN_DURATION_S,
};
use super::dynamics::transition_duration;
use super::gear::{
    gear_of_motion_direction, motion_direction_of_gear, GEAR_ENGAGE_SPEED_MPS,
    MOTION_GEAR_ENGAGED_KEY, MOTION_GEAR_KEY,
};
use super::triggers::{
    evaluate_condition, should_fire, trigger_predicate_value, ConditionContext, PerceptionQuery,
    ResolvedTrigger, TriggerStatus,
};
use super::world::{EngineResult, Shape, ShapeLabel, Simulation};
use crate::solve::guards::timed_route_feasibility_issues;
use crate::trace::pairs::along_route_gap_m;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteCommit {
    Wait,
    Ready,
    Missed,
}

impl Simulation {
    /// Build a condition context over the current frozen tick. Callers
    /// borrow `self` immutably for the closure's duration.
    fn with_condition_context<R>(
        &mut self,
        t: f64,
        f: impl FnOnce(&Simulation, &ConditionContext<'_>) -> R,
    ) -> R {
        self.rebuild_prop_occluders();
        let occluders = self.tick_occluders();
        let view = self
            .perception
            .as_ref()
            .map(|p| p.pass.view(&p.accumulator, &self.actors));
        let ctx = ConditionContext {
            t,
            actors: &self.actors,
            signals: &self.signals,
            occluders: &occluders,
            visibility_range_m: self.input.operational_conditions.effects.visibility_range_m,
            collisions: &self.scratch.detected,
            perception: view.as_ref().map(|v| v as &dyn PerceptionQuery),
        };
        f(self, &ctx)
    }

    pub(super) fn evaluate_triggers(&mut self, t: f64) {
        // The reference walks triggers in interaction order against live
        // state: a trigger skipped or fired earlier in the same tick is
        // already visible to every later dependency (`after`, `dependency_skipped`)
        // and so are the actor mutations its verb applied. Decide from a
        // frozen view only up to the first mutating verdict, apply it, then
        // resume from the next trigger with a fresh view.
        let n = self.triggers.len();
        let mut next = 0usize;
        let mut decisions: Vec<(usize, bool, Verdict)> = Vec::new();
        while next < n {
            decisions.clear();
            let resume = self.with_condition_context(t, |sim, ctx| {
                for i in next..n {
                    let tr = &sim.triggers[i];
                    if tr.status != TriggerStatus::Pending {
                        continue;
                    }
                    let truth = trigger_predicate_value(ctx, tr, &sim.triggers);
                    let it = &sim.interactions[i];
                    let verdict = if let Some(window) = &it.window {
                        if t < window.start_s - 1e-9 {
                            Verdict::Hold
                        } else if t >= window.end_s - 1e-9 {
                            Verdict::Skip("window_elapsed")
                        } else {
                            Verdict::from_fire(should_fire(ctx, tr, &sim.triggers), &tr.trigger)
                        }
                    } else {
                        Verdict::from_fire(should_fire(ctx, tr, &sim.triggers), &tr.trigger)
                    };
                    decisions.push((i, truth, verdict));
                    if !matches!(verdict, Verdict::Hold) {
                        return i + 1;
                    }
                }
                n
            });
            next = resume;
            for &(i, truth, verdict) in &decisions {
                self.record_trigger_truth(InteractionIndex(i as u32), t, truth);
                let index = InteractionIndex(i as u32);
                match verdict {
                    Verdict::Hold => continue,
                    Verdict::Skip(reason) => {
                        self.skip_trigger(index, t, reason);
                        continue;
                    }
                    Verdict::Fire { forced } => {
                        let commit = if matches!(self.interactions[i].verb, Verb::Route { .. }) {
                            self.route_commit_status(index)
                        } else {
                            RouteCommit::Ready
                        };
                        match commit {
                            RouteCommit::Missed => {
                                self.skip_trigger(index, t, "route_commit_missed");
                                continue;
                            }
                            RouteCommit::Wait => continue,
                            RouteCommit::Ready => {}
                        }
                        let target = self.triggers[i].actor;
                        let crashed =
                            target.map_or(false, |a| self.actors[a.index()].crash.is_some());
                        if crashed && !matches!(self.interactions[i].verb, Verb::Set { .. }) {
                            self.skip_trigger(index, t, "actor-crash-disabled");
                            continue;
                        }
                        {
                            let tr = &mut self.triggers[i];
                            tr.status = TriggerStatus::Fired;
                            tr.fired_at = Some(t);
                            tr.forced = forced;
                        }
                        let it = &self.interactions[i];
                        self.events.push(SimEvent::TriggerFired {
                            t,
                            interaction_id: it.id.clone(),
                            actor_id: it.actor_id.clone(),
                            verb: crate::trace::ledger::verb_name(&it.verb).to_owned(),
                            forced,
                        });
                        self.apply_interaction(index, t);
                        let axis = axis_of(&self.interactions[i].verb);
                        if matches!(axis, AxisId::Route | AxisId::Existence | AxisId::State(_)) {
                            self.triggers[i].ended_at = Some(t);
                        }
                    }
                }
            }
        }
    }

    fn skip_trigger(&mut self, index: InteractionIndex, t: f64, reason: &str) {
        let tr = &mut self.triggers[index.index()];
        tr.status = TriggerStatus::Skipped;
        let it = &self.interactions[index.index()];
        self.events.push(SimEvent::TriggerSkipped {
            t,
            interaction_id: it.id.clone(),
            actor_id: it.actor_id.clone(),
            reason: reason.to_owned(),
        });
        if self.capture || self.live {
            self.metrics.record_trigger_never_fired(&it.id);
        }
    }

    fn record_trigger_truth(&mut self, index: InteractionIndex, t: f64, value: bool) {
        let transitions = &mut self.truth_transitions[index.index()];
        if transitions.last().map_or(true, |(_, v)| *v != value) {
            transitions.push((t, value));
        }
    }

    /// Whether a route action has reached the junction where its target path
    /// diverges from the actor's current path. Identical paths are ready now.
    fn route_commit_status(&self, index: InteractionIndex) -> RouteCommit {
        let it = &self.interactions[index.index()];
        let Some(actor) = self.triggers[index.index()].actor else {
            return RouteCommit::Ready;
        };
        let a = &self.actors[actor.index()];
        let Verb::Route {
            target: RouteActionTarget::Spec(spec @ RouteSpec::LanePath { .. }),
            ..
        } = &it.verb
        else {
            return RouteCommit::Ready;
        };
        if a.route.is_freeform() {
            return RouteCommit::Ready;
        }
        let Ok(target) = build_route(&self.graph, spec) else {
            return RouteCommit::Ready;
        };
        if target.is_freeform() {
            return RouteCommit::Ready;
        }
        let Some(current_index) = a.route.leg_index_at(a.route_s) else {
            return RouteCommit::Ready;
        };
        let legs = a.route.legs();
        let target_legs = target.legs();
        let current_lane = legs[current_index].lane;
        let Some(target_index) = target_legs.iter().position(|l| l.lane == current_lane) else {
            let passed_shared_approach = legs[..current_index]
                .iter()
                .any(|leg| target_legs.iter().any(|tl| tl.lane == leg.lane));
            return if passed_shared_approach {
                RouteCommit::Missed
            } else {
                RouteCommit::Ready
            };
        };
        let mut shared = 0usize;
        while let (Some(mine), Some(theirs)) = (
            legs.get(current_index + shared),
            target_legs.get(target_index + shared),
        ) {
            if mine.lane != theirs.lane {
                break;
            }
            shared += 1;
        }
        if shared == 0
            || (current_index + shared >= legs.len() && target_index + shared >= target_legs.len())
        {
            return RouteCommit::Ready;
        }
        let last_shared = &legs[current_index + shared - 1];
        let commit_s = last_shared.s_start + last_shared.length_m;
        if a.route_s > commit_s + 1e-6 {
            return RouteCommit::Missed;
        }
        let lookahead_m = clamp(a.speed_mps * 1.5, 5.0, 20.0);
        if a.route_s >= commit_s - lookahead_m {
            RouteCommit::Ready
        } else {
            RouteCommit::Wait
        }
    }

    pub(super) fn evaluate_until(&mut self, t: f64) {
        let releases: Vec<(ActorIndex, AxisId, InteractionIndex)> =
            self.with_condition_context(t, |sim, ctx| {
                let statics_index = std::collections::BTreeMap::new();
                let tables = super::triggers::ReferenceTables {
                    actors: &sim.actor_index,
                    statics: &statics_index,
                    signals: &sim.signals,
                    graph: &sim.graph,
                };
                let mut out = Vec::new();
                for a in &sim.actors {
                    for entry in &a.until_by_axis {
                        let resolved = sim.triggers[entry.interaction.index()].until.as_ref();
                        let value = match resolved {
                            Some(cond) => evaluate_condition(ctx, cond),
                            None => evaluate_condition(ctx, &tables.resolve(&entry.condition)),
                        };
                        if value {
                            out.push((a.index, entry.axis.clone(), entry.interaction));
                        }
                    }
                }
                out
            });
        for (actor, axis, interaction) in releases {
            self.actors[actor.index()].clear_until(&axis);
            self.release_axis(actor, &axis, t, interaction, ReleasedReason::Until);
        }
    }

    /// Existing non-lateral commands retain their authored release window.
    /// Lateral clips are different: their end is only the exclusive last
    /// instant at which a manoeuvre may begin, never a request to truncate
    /// body motion.
    pub(super) fn evaluate_window_ends(&mut self, t: f64) {
        for i in 0..self.triggers.len() {
            let Some(window) = &self.interactions[i].window else {
                continue;
            };
            if self.triggers[i].status != TriggerStatus::Fired
                || t < window.end_s - 1e-9
                || self.released_windows[i]
            {
                continue;
            }
            let axis = axis_of(&self.interactions[i].verb);
            if axis == AxisId::Lateral {
                continue;
            }
            self.released_windows[i] = true;
            if self.triggers[i].ended_at.is_none() {
                self.triggers[i].ended_at = Some(t);
            }
            let Some(actor) = self.triggers[i].actor else {
                continue;
            };
            let index = InteractionIndex(i as u32);
            let owner = if axis == AxisId::Longitudinal {
                self.actors[actor.index()]
                    .long_cmd
                    .as_ref()
                    .map(|c| c.interaction)
            } else {
                None
            };
            if owner == Some(index) {
                self.release_axis(actor, &axis, t, index, ReleasedReason::Window);
            }
        }
    }

    pub(super) fn release_axis(
        &mut self,
        actor: ActorIndex,
        axis: &AxisId,
        t: f64,
        interaction: InteractionIndex,
        reason: ReleasedReason,
    ) {
        let a_id = self.actors[actor.index()].id.clone();
        if *axis == AxisId::Lateral && reason == ReleasedReason::Until {
            if self.actors[actor.index()]
                .lat_cmd
                .as_ref()
                .map(|c| c.interaction)
                == Some(interaction)
            {
                self.abort_lateral(interaction, actor, t, AbortReason::Until);
            }
        }
        {
            let speed_limit = self.speed_limit_at(&self.actors[actor.index()]);
            let a = &mut self.actors[actor.index()];
            match axis {
                AxisId::Longitudinal => {
                    if reason == ReleasedReason::Until {
                        if let Some(cmd) = &a.long_cmd {
                            if cmd.interaction == interaction {
                                if let Some(prior) = cmd.prior_cruise_override_mps {
                                    a.cruise_override_mps = prior;
                                    a.cruise_speed_mps = cruise_speed(a, speed_limit);
                                }
                            }
                        }
                    }
                    a.long_cmd = None;
                }
                AxisId::Lateral => a.lat_cmd = None,
                _ => {}
            }
            if a.until_for(axis).map(|e| e.interaction) == Some(interaction) {
                a.clear_until(axis);
            }
        }
        let tr = &mut self.triggers[interaction.index()];
        if tr.ended_at.is_none() {
            tr.ended_at = Some(t);
        }
        self.events.push(SimEvent::Released {
            t,
            actor_id: a_id,
            axis: axis.as_trace_str().into_owned(),
            interaction_id: self.interactions[interaction.index()].id.clone(),
            reason,
        });
    }

    pub(super) fn abort_lateral(
        &mut self,
        interaction: InteractionIndex,
        actor: ActorIndex,
        t: f64,
        reason: AbortReason,
    ) {
        let tr = &mut self.triggers[interaction.index()];
        if tr.ended_at.is_none() {
            tr.ended_at = Some(t);
        }
        self.events.push(SimEvent::InteractionAborted {
            t,
            interaction_id: self.interactions[interaction.index()].id.clone(),
            actor_id: self.actors[actor.index()].id.clone(),
            reason,
        });
    }

    /* ----------------------------------------------------- verb → controller */

    fn apply_interaction(&mut self, index: InteractionIndex, t: f64) {
        let Some(actor) = self.triggers[index.index()].actor else {
            return;
        };
        let it: Interaction = self.interactions[index.index()].clone();
        if self.actors[actor.index()].crash.is_some() && !matches!(it.verb, Verb::Set { .. }) {
            self.events.push(SimEvent::TriggerSkipped {
                t,
                interaction_id: it.id.clone(),
                actor_id: self.actors[actor.index()].id.clone(),
                reason: "actor-crash-disabled".to_owned(),
            });
            return;
        }
        let axis = axis_of(&it.verb);
        self.preempt(actor, &axis, index, t);

        match &it.verb {
            Verb::Speed { target, dynamics } => {
                let speed_limit = self.speed_limit_at(&self.actors[actor.index()]);
                let match_ref = match target {
                    SpeedTarget::Match {
                        actor_id,
                        offset_mps,
                    } => Some(MatchReference {
                        actor: self.actor_index.get(actor_id).copied(),
                        offset_mps: *offset_mps,
                    }),
                    _ => None,
                };
                let resolved = self.resolve_speed_target(actor, target, speed_limit);
                let a = &mut self.actors[actor.index()];
                let duration =
                    transition_duration(dynamics, resolved - a.speed_mps, a.speed_mps.max(0.1));
                let cmd = LongitudinalCommand {
                    kind: LongitudinalKind::Speed,
                    interaction: index,
                    fired_at: t,
                    dynamics: dynamics.clone(),
                    v0: a.speed_mps,
                    duration,
                    target: resolved,
                    gap: None,
                    match_ref,
                    prior_cruise_override_mps: Some(a.cruise_override_mps),
                };
                // A SpeedAction changes the actor's desired cruise state; its
                // editor clip is not a temporary throttle press.
                a.cruise_override_mps = Some(resolved);
                a.cruise_speed_mps = resolved;
                a.long_cmd = Some(cmd);
            }
            Verb::Gap {
                target,
                value,
                mode,
                dynamics,
            } => {
                let leader = self.actor_index.get(&target.actor_id).copied();
                let gap_now = leader
                    .and_then(|l| {
                        along_route_gap_m(&self.actors[actor.index()], &self.actors[l.index()])
                    })
                    .unwrap_or(0.0);
                let a = &mut self.actors[actor.index()];
                let gap_target = desired_gap_m(a, *value, *mode, true);
                let duration =
                    transition_duration(dynamics, gap_target - gap_now, a.speed_mps.max(0.1));
                a.long_cmd = Some(LongitudinalCommand {
                    kind: LongitudinalKind::Gap,
                    interaction: index,
                    fired_at: t,
                    dynamics: dynamics.clone(),
                    v0: gap_now,
                    duration,
                    target: gap_target,
                    gap: leader.map(|l| GapReference {
                        actor: l,
                        value: *value,
                        mode: *mode,
                    }),
                    match_ref: None,
                    prior_cruise_override_mps: None,
                });
            }
            Verb::ChangeLane { target, dynamics } => {
                let cmd = self.start_lane_change(actor, index, target, dynamics, t);
                self.actors[actor.index()].lat_cmd = cmd;
            }
            Verb::LaneOffset { target, dynamics } => {
                let a = &self.actors[actor.index()];
                let width = a.route.width_at(a.route_s);
                let to = match target.mode {
                    LaneOffsetMode::Meters => target.value,
                    LaneOffsetMode::Fraction => target.value * width,
                };
                let from = a.lateral_offset_m;
                let planned = self.bounded_lateral_duration(actor, index, dynamics, to - from);
                let a = &mut self.actors[actor.index()];
                self.events.push(SimEvent::LateralManeuverPlanned {
                    t,
                    actor_id: a.id.clone(),
                    interaction_id: it.id.clone(),
                    requested_duration_s: planned.0,
                    effective_duration_s: planned.1,
                    displacement_m: to - from,
                });
                a.lat_cmd = Some(LateralCommand {
                    kind: LateralKind::LaneOffset,
                    interaction: index,
                    fired_at: t,
                    dynamics: dynamics.clone(),
                    from,
                    to,
                    duration: planned.1,
                    pending: None,
                    side: None,
                    done: false,
                });
            }
            Verb::Route {
                target,
                join_from_current_pose,
                best_effort_world_path,
            } => {
                self.apply_route_verb(
                    actor,
                    index,
                    &it,
                    target,
                    join_from_current_pose.unwrap_or(false),
                    best_effort_world_path.unwrap_or(false),
                    t,
                );
            }
            Verb::Exist { target } => {
                let present = target.state == ExistState::Present;
                let a = &mut self.actors[actor.index()];
                if present != a.present {
                    a.present = present;
                    let id = a.id.clone();
                    if present {
                        a.retired = false;
                        self.events.push(SimEvent::Spawn { t, actor_id: id });
                    } else {
                        self.events.push(SimEvent::Despawn {
                            t,
                            actor_id: id,
                            reason: DespawnReason::Interaction,
                        });
                    }
                }
            }
            Verb::Set { target } => {
                let key = target.key.to_string();
                let value = target.value.clone();
                self.actors[actor.index()].set_state_key(&target.key, value.clone());
                let forced = key
                    .strip_prefix("signal:")
                    .and_then(|rest| rest.strip_suffix(".phase"))
                    .or_else(|| {
                        key.strip_prefix("control:")
                            .and_then(|rest| rest.strip_suffix(".indication"))
                    });
                if let (Some(signal_id), SetValue::Text(phase)) = (forced, &value) {
                    if let Some(indication) = ControlIndication::parse(phase) {
                        self.signals.set_override(signal_id, Some(indication));
                    }
                }
                self.apply_state_key(actor, &key, &value, t);
                self.events.push(SimEvent::StateSet {
                    t,
                    actor_id: self.actors[actor.index()].id.clone(),
                    key,
                    value,
                });
            }
        }

        let a = &mut self.actors[actor.index()];
        match &it.until {
            Some(condition) => a.set_until(axis, index, condition.clone()),
            None => {
                a.clear_until(&axis);
            }
        }
    }

    fn apply_route_verb(
        &mut self,
        actor: ActorIndex,
        index: InteractionIndex,
        it: &Interaction,
        target: &RouteActionTarget,
        join_from_current_pose: bool,
        best_effort_world_path: bool,
        t: f64,
    ) {
        let a = &self.actors[actor.index()];
        let a_id = a.id.clone();
        let current_pose = a.route.pose_at(a.route_s);
        let joins_live_pose = join_from_current_pose
            && matches!(target, RouteActionTarget::Spec(RouteSpec::Polyline { .. }));
        let built = match target {
            RouteActionTarget::NextJunction { turn, max_length_m } => match current_pose.lane {
                Some(lane) => build_follow_route(
                    &self.graph,
                    &FollowRouteOptions {
                        start: lane,
                        turns: std::slice::from_ref(turn),
                        max_length_m: *max_length_m,
                        start_reversed: current_pose.leg_index.map(|i| a.route.legs()[i].reversed),
                        strict_turns: true,
                    },
                ),
                None => Err(crate::map::RouteBuildError {
                    code: SimIssueCode::RouteTurnUnavailable,
                    reason: format!(
                        "actor {} has no live lane identity from which to find the next junction",
                        a.id
                    ),
                    detail: None,
                }),
            },
            RouteActionTarget::Spec(spec) => {
                if joins_live_pose {
                    let RouteSpec::Polyline { points } = spec else {
                        unreachable!()
                    };
                    let mut local: Vec<Vec2> = Vec::with_capacity(points.len() + 1);
                    local.push(a.position);
                    local.extend(points.iter().map(|p| {
                        crate::math::local_from_scene(crate::math::SceneXZ { x: p.x, z: p.z })
                    }));
                    Ok(crate::map::Route::from_polyline(local))
                } else {
                    build_route(&self.graph, spec)
                }
            }
        };
        let route = match built {
            Ok(route) => route,
            Err(err) => {
                if let RouteActionTarget::NextJunction { turn, .. } = target {
                    self.events.push(SimEvent::RouteChangeRejected {
                        t,
                        actor_id: a_id,
                        interaction_id: it.id.clone(),
                        reason: err.reason.clone(),
                        requested_turn: Some(turn.as_str().to_owned()),
                    });
                }
                let mut issue = err.into_issue(format!("interactions.{}.target", it.id));
                issue.severity = crate::error::SimIssueSeverity::Warning;
                self.issues.push(issue);
                return;
            }
        };
        let a = &mut self.actors[actor.index()];
        let s = if joins_live_pose {
            0.0
        } else {
            route.project_point(a.position).s
        };
        a.route = route;
        a.route_s = s;
        a.timed_route = match target {
            RouteActionTarget::Spec(RouteSpec::TimedPolyline { points }) => {
                Some(TimedRoute::from_scene_points(points))
            }
            _ => None,
        };
        a.best_effort_world_path = best_effort_world_path;
        a.lateral_offset_m = if joins_live_pose {
            0.0
        } else {
            a.route.lateral_offset_at(s, a.position)
        };
        a.lateral_reference_offset_m = a.lateral_offset_m;
        a.lateral_reference_rate_mps = 0.0;
        a.lateral_reference_accel_mps2 = 0.0;
        a.lateral_rest_offset_m = a.lateral_offset_m;
        a.remaining_turns = match target {
            RouteActionTarget::Spec(RouteSpec::Follow { turns, .. }) => turns.clone(),
            _ => Vec::new(),
        };
        // Re-routing is an explicit new motion path: an actor that reached
        // its previous route end must be allowed to move again.
        a.retired = false;
        let route_ref = self.route_refs.intern(&a.route);
        a.route_ref = route_ref;
        let path = format!("interactions.{}.target", it.id);
        timed_route_feasibility_issues(&self.actors[actor.index()], &path, &mut self.issues);
        let _ = index;
    }

    fn preempt(&mut self, actor: ActorIndex, axis: &AxisId, by: InteractionIndex, t: f64) {
        let a = &self.actors[actor.index()];
        let previous = match axis {
            AxisId::Longitudinal => a.long_cmd.as_ref().map(|c| c.interaction),
            AxisId::Lateral => a.lat_cmd.as_ref().map(|c| c.interaction),
            _ => None,
        };
        let Some(previous) = previous else { return };
        if previous == by {
            return;
        }
        if *axis == AxisId::Lateral {
            self.abort_lateral(previous, actor, t, AbortReason::Preempted);
        }
        self.events.push(SimEvent::Preemption {
            t,
            actor_id: self.actors[actor.index()].id.clone(),
            axis: axis.as_trace_str().into_owned(),
            by_interaction_id: self.interactions[by.index()].id.clone(),
            preempted_interaction_id: self.interactions[previous.index()].id.clone(),
        });
    }

    fn apply_state_key(&mut self, actor: ActorIndex, key: &str, value: &SetValue, t: f64) {
        if let Some(name) = key.strip_prefix("doors.").and_then(DoorName::parse) {
            self.apply_door_state(actor, name, value, t);
        }
        let truthy = match value {
            SetValue::Bool(b) => *b,
            SetValue::Number(n) => *n != 0.0,
            SetValue::Text(s) => !s.is_empty(),
        };
        let number = match value {
            SetValue::Number(n) => Some(*n),
            _ => None,
        };
        let speed_limit = self.speed_limit_at(&self.actors[actor.index()]);
        let a = &mut self.actors[actor.index()];
        match key {
            "rules.obeySignals" => a.rules.obey_signals = truthy,
            "rules.yieldToVehicles" => a.rules.yield_to_vehicles = truthy,
            "rules.yieldToPedestrians" => a.rules.yield_to_pedestrians = truthy,
            "rules.collisionAvoidance" => a.rules.collision_avoidance = truthy,
            "rules.aggression" => {
                if let Some(n) = number {
                    a.rules.aggression = n;
                }
            }
            "rules.speedFactor" => {
                if let Some(n) = number {
                    a.rules.speed_factor = n;
                    a.cruise_speed_mps = cruise_speed(a, speed_limit);
                }
            }
            MOTION_GEAR_KEY => {
                // Gear selection is a request, held until the body is at rest.
                let Some(requested) = motion_direction_of_gear(value) else {
                    return;
                };
                a.pending_motion_direction = if requested == a.motion_direction {
                    None
                } else {
                    Some(requested)
                };
                // Engagement errors are backend contract errors; surface them
                // as issues rather than aborting a state write mid-tick.
                if let Err(e) = self.engage_pending_gear(actor, t) {
                    self.issues.push(SimIssue::warning(
                        SimIssueCode::ReverseSpawnHeadingAdjusted,
                        format!("actors.{}.state.motion.gear", self.actors[actor.index()].id),
                        e.to_string(),
                    ));
                }
            }
            _ => {}
        }
    }

    /// Engage an outstanding gear change if the body is slow enough. Selecting
    /// the opposite gear reverses the route rather than rotating the body.
    pub(super) fn engage_pending_gear(&mut self, actor: ActorIndex, t: f64) -> EngineResult<()> {
        let (next, has_moved) = {
            let a = &mut self.actors[actor.index()];
            let Some(next) = a.pending_motion_direction else {
                return Ok(());
            };
            if next == a.motion_direction {
                a.pending_motion_direction = None;
                return Ok(());
            }
            if a.speed_mps.abs() > GEAR_ENGAGE_SPEED_MPS {
                return Ok(());
            }
            (next, a.has_moved)
        };
        if has_moved {
            let a = &mut self.actors[actor.index()];
            let flipped = a.route.reversed_route();
            a.route_s = clamp(a.route.length_m() - a.route_s, 0.0, flipped.length_m());
            a.route = flipped;
            a.remaining_turns.clear();
            a.lateral_offset_m = -a.lateral_offset_m;
            a.lateral_reference_offset_m = -a.lateral_reference_offset_m;
            a.lateral_rest_offset_m = -a.lateral_rest_offset_m;
            a.lateral_reference_rate_mps = -a.lateral_reference_rate_mps;
            a.lateral_rate_mps = -a.lateral_rate_mps;
            let route_ref = self.route_refs.intern(&a.route);
            a.route_ref = route_ref;
        } else {
            // The body has never driven: keep the authored escape path and
            // re-derive the heading from it (route tangent + PI in reverse).
            let a = &mut self.actors[actor.index()];
            a.heading_rad = normalize_angle(
                a.route.pose_at(a.route_s).heading_rad + if next.is_reverse() { PI } else { 0.0 },
            );
            if a.body.is_some() {
                let profile = self.physics_profile_for_actor(actor);
                let a = &self.actors[actor.index()];
                let init = MotionActorInitialization {
                    actor_id: a.id.clone(),
                    kind: a.kind,
                    dimensions: Some(a.dims),
                    motion_direction: next,
                    state: MotionInitialState::at_rest(
                        a.position.x,
                        a.position.y,
                        a.heading_rad,
                        0.0,
                    ),
                    profile,
                };
                let body = self
                    .physics
                    .register(&init)
                    .map_err(|e| crate::error::SimEngineError::new(e.to_string(), Vec::new()))?;
                self.actors[actor.index()].body = Some(body);
            }
        }
        let a = &mut self.actors[actor.index()];
        a.motion_direction = next;
        a.pending_motion_direction = None;
        a.retired = false;
        let gear = gear_of_motion_direction(next);
        a.set_state_key_str(MOTION_GEAR_ENGAGED_KEY, SetValue::Text(gear.to_owned()));
        let actor_id = a.id.clone();
        self.events.push(SimEvent::StateSet {
            t,
            actor_id,
            key: MOTION_GEAR_ENGAGED_KEY.to_owned(),
            value: SetValue::Text(gear.to_owned()),
        });
        Ok(())
    }

    pub(super) fn physics_profile_for_actor(
        &self,
        actor: ActorIndex,
    ) -> Option<crate::types::VehiclePhysicsProfile> {
        let a = &self.actors[actor.index()];
        let authored = self.physics_config.profile(&a.id).cloned();
        if !a.tags.iter().any(|t| t == "catalog:pedestrian.child") {
            return authored;
        }
        let base = crate::physics::child_pedestrian_physics_profile();
        Some(match authored {
            None => base,
            Some(over) => overlay_profile(&base, &over),
        })
    }

    fn apply_door_state(&mut self, actor: ActorIndex, name: DoorName, value: &SetValue, t: f64) {
        let existing = self.door_at(actor, name).copied();
        let current = existing.map_or(0.0, |d| d.openness(t));
        let (target, transitioning) = door_target(value);
        let runtime = DoorRuntime {
            actor,
            name,
            from: current,
            target,
            started_t: t,
            duration_s: if transitioning {
                DOOR_OPEN_DURATION_S * (target - current).abs()
            } else {
                0.0
            },
            transitioning,
        };
        match self
            .doors
            .binary_search_by(|d| (d.actor, d.name).cmp(&(actor, name)))
        {
            Ok(i) => self.doors[i] = runtime,
            Err(i) => self.doors.insert(i, runtime),
        }
        // Seed the hinge pose at the trigger instant so next tick's sweep
        // includes the entire opening arc.
        let snapshot = &mut self.collision_snapshots[actor.index()];
        if snapshot.live
            && !snapshot
                .shapes
                .iter()
                .any(|s| s.label == ShapeLabel::Door(name))
        {
            let obb = articulated_door_obb_for(&self.actors[actor.index()], name, current);
            snapshot.shapes.push(Shape {
                label: ShapeLabel::Door(name),
                obb,
            });
        }
    }

    pub(super) fn resolve_speed_target(
        &self,
        actor: ActorIndex,
        target: &SpeedTarget,
        speed_limit: f64,
    ) -> f64 {
        let a = &self.actors[actor.index()];
        match target {
            SpeedTarget::Absolute { value } => *value,
            SpeedTarget::Delta { value } => (a.speed_mps + value).max(0.0),
            SpeedTarget::Factor { value } => (a.speed_mps * value).max(0.0),
            SpeedTarget::Stop => 0.0,
            SpeedTarget::Match {
                actor_id,
                offset_mps,
            } => {
                let other = self
                    .actor_index
                    .get(actor_id)
                    .map(|i| self.actors[i.index()].speed_mps);
                (other.unwrap_or_else(|| cruise_speed(a, speed_limit)) + offset_mps).max(0.0)
            }
        }
    }

    pub(super) fn resolve_match_target(
        &self,
        actor: ActorIndex,
        m: &MatchReference,
        speed_limit: f64,
    ) -> f64 {
        let a = &self.actors[actor.index()];
        let other = m.actor.map(|i| self.actors[i.index()].speed_mps);
        (other.unwrap_or_else(|| cruise_speed(a, speed_limit)) + m.offset_mps).max(0.0)
    }

    fn start_lane_change(
        &mut self,
        actor: ActorIndex,
        index: InteractionIndex,
        target: &LaneChangeTarget,
        dynamics: &Dynamics,
        t: f64,
    ) -> Option<LateralCommand> {
        let a = &self.actors[actor.index()];
        let mut retarget: Option<PendingRetarget> = None;
        let mut side: Option<LaneChangeSide> = None;
        let mut legal = true;
        let in_progress = a
            .lat_cmd
            .as_ref()
            .map_or(false, |c| c.kind == LateralKind::ChangeLane && !c.done);

        match target {
            LaneChangeTarget::Left { count } | LaneChangeTarget::Right { count } => {
                let lane_side = if matches!(target, LaneChangeTarget::Left { .. }) {
                    LaneSide::Left
                } else {
                    LaneSide::Right
                };
                side = Some(if lane_side == LaneSide::Left {
                    LaneChangeSide::Left
                } else {
                    LaneChangeSide::Right
                });
                let mut cursor_route = a.route.clone();
                let mut cursor_s = a.route_s;
                let mut separation_m = 0.0;
                for _ in 0..*count {
                    let opts = RetargetOptions {
                        legal_only: true,
                        remaining_turns: &a.remaining_turns,
                        max_length_m: None,
                    };
                    let Some(next) =
                        retarget_to_neighbour(&cursor_route, cursor_s, lane_side, &opts)
                    else {
                        legal = false;
                        retarget = None;
                        break;
                    };
                    separation_m += next.separation_m;
                    cursor_s = next.s;
                    cursor_route = next.route.clone();
                    retarget = Some(PendingRetarget {
                        route: next.route,
                        s: next.s,
                        separation_m,
                        target_lane: Some(next.target),
                    });
                }
            }
            LaneChangeTarget::Lane { rsl } => {
                let current_lane = a.route.pose_at(a.route_s).lane;
                let target_lane = self.graph.lane_id(rsl);
                if target_lane.is_some()
                    && current_lane == target_lane
                    && in_progress
                    && a.lateral_offset_m.abs() > 1e-3
                {
                    // Abort an in-progress incursion back to the source centre.
                    retarget = Some(PendingRetarget {
                        route: a.route.clone(),
                        s: a.route_s,
                        separation_m: -a.lateral_offset_m,
                        target_lane,
                    });
                } else if let Some(lane) = target_lane {
                    let opts = RetargetOptions {
                        legal_only: false,
                        remaining_turns: &a.remaining_turns,
                        max_length_m: None,
                    };
                    match retarget_to_lane(&a.route, a.route_s, lane, &opts) {
                        Some(r)
                            if in_progress
                                && r.separation_m.abs() <= 0.1
                                && a.lateral_offset_m.abs() > 1e-3 =>
                        {
                            retarget = Some(PendingRetarget {
                                route: a.route.clone(),
                                s: a.route_s,
                                separation_m: -a.lateral_offset_m,
                                target_lane: current_lane,
                            });
                        }
                        Some(r) => {
                            retarget = Some(PendingRetarget {
                                route: r.route,
                                s: r.s,
                                separation_m: r.separation_m,
                                target_lane: Some(lane),
                            })
                        }
                        None => legal = false,
                    }
                } else {
                    legal = false;
                }
            }
            LaneChangeTarget::ActorLane { actor_id } => {
                let lane = self.actor_index.get(actor_id).and_then(|i| {
                    let o = &self.actors[i.index()];
                    o.route.pose_at(o.route_s).lane
                });
                if let Some(lane) = lane {
                    let opts = RetargetOptions {
                        legal_only: false,
                        remaining_turns: &a.remaining_turns,
                        max_length_m: None,
                    };
                    if let Some(r) = retarget_to_lane(&a.route, a.route_s, lane, &opts) {
                        retarget = Some(PendingRetarget {
                            route: r.route,
                            s: r.s,
                            separation_m: r.separation_m,
                            target_lane: Some(lane),
                        });
                    }
                }
                if retarget.is_none() {
                    legal = false;
                }
            }
        }

        let interaction_id = self.interactions[index.index()].id.clone();
        let Some(retarget) = retarget else {
            let a_id = a.id.clone();
            let mode = match target {
                LaneChangeTarget::Left { .. } => "left",
                LaneChangeTarget::Right { .. } => "right",
                LaneChangeTarget::Lane { .. } => "lane",
                LaneChangeTarget::ActorLane { .. } => "actor",
            };
            self.events.push(SimEvent::LaneChangeRejected {
                t,
                actor_id: a_id.clone(),
                interaction_id: interaction_id.clone(),
                reason: if legal {
                    "no_target_lane"
                } else {
                    "illegal_or_missing_neighbour"
                }
                .to_owned(),
            });
            let mut detail = serde_json::Map::new();
            detail.insert("actorId".into(), a_id.clone().into());
            detail.insert("mode".into(), mode.into());
            self.issues.push(
                SimIssue::warning(
                    SimIssueCode::LaneChangeIllegal,
                    format!("interactions.{interaction_id}.target"),
                    format!("no legal lane-change target for {a_id} at t={t:.2}"),
                )
                .with_detail(detail),
            );
            self.abort_lateral(index, actor, t, AbortReason::Rejected);
            return None;
        };

        let from = a.lateral_offset_m;
        let to = from + retarget.separation_m;
        let planned = self.bounded_lateral_duration(actor, index, dynamics, retarget.separation_m);
        self.events.push(SimEvent::LateralManeuverPlanned {
            t,
            actor_id: self.actors[actor.index()].id.clone(),
            interaction_id,
            requested_duration_s: planned.0,
            effective_duration_s: planned.1,
            displacement_m: retarget.separation_m,
        });
        Some(LateralCommand {
            kind: LateralKind::ChangeLane,
            interaction: index,
            fired_at: t,
            dynamics: dynamics.clone(),
            from,
            to,
            duration: planned.1,
            pending: Some(retarget),
            side,
            done: false,
        })
    }

    /// `(requested_s, effective_s)`; the effective duration honours the
    /// class's lateral rate/accel/jerk envelope (minimum-jerk peaks).
    fn bounded_lateral_duration(
        &mut self,
        actor: ActorIndex,
        index: InteractionIndex,
        dynamics: &Dynamics,
        displacement_m: f64,
    ) -> (f64, f64) {
        let a = &self.actors[actor.index()];
        let distance_m = displacement_m.abs();
        let requested_s = if dynamics.constraint == DynamicsConstraint::Rate && distance_m > 1e-9 {
            distance_m * 1.875 / dynamics.value
        } else {
            transition_duration(dynamics, displacement_m, a.speed_mps.max(0.1))
        };
        if distance_m <= 1e-6 {
            return (requested_s, requested_s);
        }
        let limits = limits_for(a);
        const PEAK_RATE: f64 = 1.875;
        const PEAK_ACCEL: f64 = 5.773_502_692;
        const PEAK_JERK: f64 = 60.0;
        let required_s = (distance_m * PEAK_RATE / limits.lateral_rate_max.max(1e-6))
            .max((distance_m * PEAK_ACCEL / limits.lateral_accel_max.max(1e-6)).sqrt())
            .max(cbrt(
                distance_m * PEAK_JERK / limits.lateral_jerk_max.max(1e-6),
            ));
        let effective_s = requested_s.max(required_s);
        if effective_s > requested_s + 1e-6 && !self.lateral_clamp_diagnostics[index.index()] {
            self.lateral_clamp_diagnostics[index.index()] = true;
            let mut detail = serde_json::Map::new();
            detail.insert("actorId".into(), a.id.clone().into());
            detail.insert("requestedDurationS".into(), requested_s.into());
            detail.insert("effectiveDurationS".into(), effective_s.into());
            detail.insert("displacementM".into(), displacement_m.into());
            detail.insert("lateralRateMaxMps".into(), limits.lateral_rate_max.into());
            detail.insert(
                "lateralAccelMaxMps2".into(),
                limits.lateral_accel_max.into(),
            );
            detail.insert("lateralJerkMaxMps3".into(), limits.lateral_jerk_max.into());
            let interaction_id = &self.interactions[index.index()].id;
            self.issues.push(
                SimIssue::warning(
                    SimIssueCode::LateralDurationClamped,
                    format!("interactions.{interaction_id}.dynamics.value"),
                    format!("requested {requested_s:.2} s lateral manoeuvre is infeasible for {}; clamped to {effective_s:.2} s", a.kind.as_str()),
                )
                .with_detail(detail),
            );
        }
        (requested_s, effective_s)
    }

    pub(super) fn finish_never_fired(&mut self) {
        let clip_s = self.input.clip_seconds;
        for i in 0..self.triggers.len() {
            if self.triggers[i].status == TriggerStatus::Pending {
                self.skip_trigger(InteractionIndex(i as u32), clip_s, "clip_ended");
            }
        }
        for index in 0..self.actors.len() {
            let Some(cmd) = self.actors[index].lat_cmd.take() else {
                continue;
            };
            let actor = ActorIndex(index as u32);
            self.abort_lateral(cmd.interaction, actor, clip_s, AbortReason::ClipEnd);
            if self.actors[index].body.is_none() {
                self.actors[index].lateral_accel_mps2 = 0.0;
            }
        }
    }
}

/// `{ ...base, ...over }`: authored fields win where present.
pub(super) fn overlay_profile(
    base: &crate::types::VehiclePhysicsProfile,
    over: &crate::types::VehiclePhysicsProfile,
) -> crate::types::VehiclePhysicsProfile {
    crate::types::VehiclePhysicsProfile {
        mass_kg: over.mass_kg.or(base.mass_kg),
        yaw_inertia_kg_m2: over.yaw_inertia_kg_m2.or(base.yaw_inertia_kg_m2),
        wheelbase_m: over.wheelbase_m.or(base.wheelbase_m),
        cg_to_front_m: over.cg_to_front_m.or(base.cg_to_front_m),
        cg_height_m: over.cg_height_m.or(base.cg_height_m),
        wheel_radius_m: over.wheel_radius_m.or(base.wheel_radius_m),
        cornering_stiffness_front_n_per_rad: over
            .cornering_stiffness_front_n_per_rad
            .or(base.cornering_stiffness_front_n_per_rad),
        cornering_stiffness_rear_n_per_rad: over
            .cornering_stiffness_rear_n_per_rad
            .or(base.cornering_stiffness_rear_n_per_rad),
        drag_coefficient_n_per_mps2: over
            .drag_coefficient_n_per_mps2
            .or(base.drag_coefficient_n_per_mps2),
        rolling_resistance_coefficient: over
            .rolling_resistance_coefficient
            .or(base.rolling_resistance_coefficient),
        max_drive_force_n: over.max_drive_force_n.or(base.max_drive_force_n),
        max_brake_force_n: over.max_brake_force_n.or(base.max_brake_force_n),
        max_steer_rad: over.max_steer_rad.or(base.max_steer_rad),
        steer_rate_rad_per_s: over.steer_rate_rad_per_s.or(base.steer_rate_rad_per_s),
        steer_time_constant_s: over.steer_time_constant_s.or(base.steer_time_constant_s),
        tire_mu: over.tire_mu.or(base.tire_mu),
        max_longitudinal_accel_mps2: over
            .max_longitudinal_accel_mps2
            .or(base.max_longitudinal_accel_mps2),
        max_longitudinal_decel_mps2: over
            .max_longitudinal_decel_mps2
            .or(base.max_longitudinal_decel_mps2),
        max_jerk_mps3: over.max_jerk_mps3.or(base.max_jerk_mps3),
        max_lateral_acceleration_mps2: over
            .max_lateral_acceleration_mps2
            .or(base.max_lateral_acceleration_mps2),
        max_yaw_rate_radps: over.max_yaw_rate_radps.or(base.max_yaw_rate_radps),
    }
}

#[derive(Debug, Clone, Copy)]
enum Verdict {
    Hold,
    Skip(&'static str),
    Fire { forced: bool },
}

impl Verdict {
    fn from_fire(v: super::triggers::FireVerdict, trigger: &ResolvedTrigger) -> Verdict {
        if v.skip {
            return Verdict::Skip(if matches!(trigger, ResolvedTrigger::When { .. }) {
                "byLatest_elapsed"
            } else {
                "dependency_skipped"
            });
        }
        if v.fire {
            Verdict::Fire { forced: v.forced }
        } else {
            Verdict::Hold
        }
    }
}
