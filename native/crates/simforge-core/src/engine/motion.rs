//! Plan / apply / resolve: every actor plans from the same frozen snapshot,
//! every plan is applied, then all dynamic bodies are coupled through the
//! physical contact solver. Recording samples the state *at* `t` before the
//! tick's integration.

use std::collections::BTreeMap;
use std::f64::consts::PI;

use crate::error::{SimIssue, SimIssueCode};
use crate::map::LaneId;
use crate::math::{angle_delta, cos, hypot, normalize_angle, sin, Vec2};
use crate::physics::{
    BodyIndex, MotionBackend, MotionIntent, WorldContactRef,
    WorldStaticCollider, BALANCE_RECOVERY_DELTA_V_MPS,
};
use crate::trace::metrics::StaticShape;
use crate::trace::{AbortReason, ActorFrame, PhysicsFrame, ReleasedReason, SignalFrame, SimEvent};

use super::actor::{
    ActorIndex, ActorRuntime, AxisId, LateralKind, LongitudinalKind, PendingRetarget,
};
use super::controllers::{
    cruise_speed, desired_gap_m, distance_to_stop_line, find_leader, governor_cap,
    heading_with_slip, lateral_step, limits_for, longitudinal_accel, minimum_jerk_sample,
    ConflictHazard, Leader,
};
use super::cornering::{cornering_plan, CornerSpeedInput, CorneringPlan};
use super::gear::{govern_speed_for_gear, GEAR_ENGAGE_SPEED_MPS};
use super::signals::{AuthorityKind, ControlSlot};
use super::spatial::{candidate_pairs, point_cell, SpatialBounds};
use super::surface::SurfaceQuery;
use super::world::{
    ActionOverride, EngineResult, ShapeLabel, Simulation, CONFLICT_GRID_CELL_M,
    CONFLICT_MIN_ANGLE_RAD, CONFLICT_RADIUS_M, CONFLICT_SAMPLES, CONFLICT_STEP_M,
    CONFLICT_WINDOW_S, DYNAMIC_LATERAL_SETTLE_HEADING_RAD, DYNAMIC_LATERAL_SETTLE_POSITION_M,
    DYNAMIC_LATERAL_SETTLE_RATE_MPS, FREEFORM_LANE_REBIND_M, LOOKAHEAD_M, REACTIVE_GRID_CELL_M,
    REACTIVE_MAX_RANGE_M2, REACTIVE_SCAN_RADIUS_M, ROUTE_END_SLACK_M,
};
use crate::solve::guards::timed_route_speed_envelope_mps;
use crate::trace::pairs::along_route_gap_m;

/// How hard a timed-route body chases its authored station, in `1/s`: a
/// one-metre lag asks for this much extra speed. Deliberately gentle — the
/// authored schedule is a target, and overdriving it would make a drawn
/// route oscillate instead of flow.
const TIMED_STATION_GAIN_PER_S: f64 = 0.6;

/// One actor's planned next state.
#[derive(Debug, Clone, Default)]
pub(super) struct Plan {
    pub speed: f64,
    pub accel: f64,
    pub route_s: f64,
    pub lateral_offset: f64,
    pub lateral_rate: f64,
    pub lateral_accel: f64,
    pub lateral_reference_offset: f64,
    pub lateral_reference_rate: f64,
    pub lateral_reference_accel: f64,
    pub lateral_complete: bool,
    pub lateral_tracking_expired: Option<(f64, f64, f64)>,
    pub position: Vec2,
    pub heading: f64,
    pub required_decel: f64,
    pub retire: bool,
    pub swap: Option<PendingRetarget>,
    /// Timed-route hand-over happened while planning (the plan already
    /// reflects the released route).
    pub released_timed: bool,
}

impl Plan {
    fn hold(a: &ActorRuntime) -> Plan {
        Plan {
            speed: a.speed_mps,
            accel: 0.0,
            route_s: a.route_s,
            lateral_offset: a.lateral_offset_m,
            lateral_rate: a.lateral_rate_mps,
            lateral_accel: a.lateral_accel_mps2,
            lateral_reference_offset: a.lateral_reference_offset_m,
            lateral_reference_rate: a.lateral_reference_rate_mps,
            lateral_reference_accel: a.lateral_reference_accel_mps2,
            lateral_complete: false,
            lateral_tracking_expired: None,
            position: a.position,
            heading: a.heading_rad,
            required_decel: 0.0,
            retire: false,
            swap: None,
            released_timed: false,
        }
    }
}

impl Simulation {
    /* ------------------------------------------------------------ planning */

    pub(super) fn plan_all(&mut self, t: f64) -> EngineResult<()> {
        self.build_conflict_samples();
        self.build_nearby_index();
        let n = self.actors.len();
        let mut plans = std::mem::take(&mut self.scratch.plans);
        plans.clear();
        plans.resize_with(n, Plan::default);
        for index in 0..n {
            let plan = self.plan_actor(ActorIndex(index as u32), t)?;
            plans[index] = plan;
        }
        self.scratch.plans = plans;
        Ok(())
    }

    fn friction_scale_for(&self, a: &ActorRuntime) -> f64 {
        if self.surface.is_uniform() {
            return self.surface.baseline_friction_scale();
        }
        let lane = if a.route.is_freeform() {
            None
        } else {
            let pose = a.route.pose_at(a.route_s);
            pose.lane.map(|l| (l, pose.lane_s))
        };
        self.surface.friction_scale_at(&SurfaceQuery {
            position: a.position,
            lane,
        })
    }

    /// All-way-stop arbitration: first complete arrival wins; actor id is the
    /// stable same-tick tie break. `others` excludes the querying actor (it is
    /// mutably borrowed by the stop-line search); its own arrivals come from
    /// the `me_states` snapshot `(control slot, arrived_at_s, released)`.
    fn can_release_stop(
        signals: &super::signals::SignalBook,
        others: (&[ActorRuntime], &[ActorRuntime]),
        me_id: &str,
        me_states: &[(u32, Option<f64>, bool)],
        control: ControlSlot,
        coordination: u32,
        t: f64,
        ids: &mut Vec<u32>,
    ) -> bool {
        ids.clear();
        ids.extend(
            signals
                .stop_lines()
                .iter()
                .filter(|line| {
                    line.coordination == coordination
                        && signals.authority_at(line, t).kind == AuthorityKind::Stop
                })
                .map(|line| line.control.0),
        );
        ids.sort_unstable();
        ids.dedup();
        for other in others.0.iter().chain(others.1.iter()) {
            for id in ids.iter() {
                if let Some(released_at) = other
                    .road_control_states
                    .get(id)
                    .and_then(|s| s.released_at_s)
                {
                    if t - released_at < 2.5 {
                        return false;
                    }
                }
            }
        }
        // Same-tick ties break on actor id then control id, both with the
        // reference's `localeCompare`.
        let mut first: Option<(f64, &str, u32)> = None;
        fn consider<'a>(
            signals: &super::signals::SignalBook,
            arrived: f64,
            id: &'a str,
            control_id: u32,
            first: &mut Option<(f64, &'a str, u32)>,
        ) {
            let better = match *first {
                None => true,
                Some((fa, fid, fc)) => {
                    arrived < fa
                        || (arrived == fa
                            && match crate::hash::cmp_locale(id, fid) {
                                std::cmp::Ordering::Less => true,
                                std::cmp::Ordering::Equal => {
                                    crate::hash::cmp_locale(
                                        signals.control_id(ControlSlot(control_id)),
                                        signals.control_id(ControlSlot(fc)),
                                    ) == std::cmp::Ordering::Less
                                }
                                std::cmp::Ordering::Greater => false,
                            })
                }
            };
            if better {
                *first = Some((arrived, id, control_id));
            }
        }
        for other in others.0.iter().chain(others.1.iter()) {
            for id in ids.iter() {
                let Some(state) = other.road_control_states.get(id) else {
                    continue;
                };
                let Some(arrived) = state.arrived_at_s else {
                    continue;
                };
                if state.released {
                    continue;
                }
                consider(signals, arrived, other.id.as_str(), *id, &mut first);
            }
        }
        for &(id, arrived, released) in me_states {
            if released || ids.binary_search(&id).is_err() {
                continue;
            }
            if let Some(arrived) = arrived {
                consider(signals, arrived, me_id, id, &mut first);
            }
        }
        match first {
            None => true,
            Some((_, id, control_id)) => id == me_id && control_id == control.0,
        }
    }

    fn build_conflict_samples(&mut self) {
        let scratch = &mut self.scratch;
        scratch.conflict_points.clear();
        scratch.conflict_ranges.clear();
        scratch.conflict_ranges.resize(self.actors.len(), (0, 0));
        scratch.conflict_candidates.clear();
        for a in &self.actors {
            let start = scratch.conflict_points.len() as u32;
            if a.is_live() {
                for i in 0..CONFLICT_SAMPLES {
                    let s = a.route_s + i as f64 * CONFLICT_STEP_M;
                    if s > a.route.length_m() {
                        break;
                    }
                    scratch
                        .conflict_points
                        .push(a.route.point_with_offset(s, a.lateral_offset_m));
                }
            }
            scratch.conflict_ranges[a.index.index()] =
                (start, scratch.conflict_points.len() as u32);
        }
        if !self.has_ambient {
            return;
        }
        scratch.bounds.clear();
        for a in &self.actors {
            let (s, e) = scratch.conflict_ranges[a.index.index()];
            if s == e {
                continue;
            }
            let pts = &scratch.conflict_points[s as usize..e as usize];
            let mut b = SpatialBounds {
                id: a.index.0,
                min_x: f64::INFINITY,
                min_y: f64::INFINITY,
                max_x: f64::NEG_INFINITY,
                max_y: f64::NEG_INFINITY,
            };
            for p in pts {
                b.min_x = b.min_x.min(p.x);
                b.min_y = b.min_y.min(p.y);
                b.max_x = b.max_x.max(p.x);
                b.max_y = b.max_y.max(p.y);
            }
            b.min_x -= CONFLICT_RADIUS_M;
            b.min_y -= CONFLICT_RADIUS_M;
            b.max_x += CONFLICT_RADIUS_M;
            b.max_y += CONFLICT_RADIUS_M;
            scratch.bounds.push(b);
        }
        let mut pairs = std::mem::take(&mut scratch.pairs);
        candidate_pairs(
            &scratch.bounds,
            CONFLICT_GRID_CELL_M,
            &mut scratch.spatial,
            &mut pairs,
        );
        for &(a, b) in &pairs {
            scratch.conflict_candidates.push((a, b));
            scratch.conflict_candidates.push((b, a));
        }
        scratch.conflict_candidates.sort_unstable();
        scratch.pairs = pairs;
    }

    fn build_nearby_index(&mut self) {
        let grid = &mut self.scratch.reactive_grid;
        grid.clear();
        if !self.ambient_reactive {
            return;
        }
        for &index in &self.sorted_actors {
            let a = &self.actors[index.index()];
            if !a.is_live() {
                continue;
            }
            let (cx, cy) = point_cell(a.position.x, a.position.y, REACTIVE_GRID_CELL_M);
            grid.push((cx, cy, index));
        }
        // Stable sort keeps id order inside a cell.
        grid.sort_by(|p, q| (p.0, p.1).cmp(&(q.0, q.1)));
    }

    /// Live bodies within one scan radius, in deterministic cell order.
    fn nearby_actors(&self, a: &ActorRuntime, out: &mut Vec<ActorIndex>) {
        out.clear();
        let (cx, cy) = point_cell(a.position.x, a.position.y, REACTIVE_GRID_CELL_M);
        let reach = (REACTIVE_SCAN_RADIUS_M / REACTIVE_GRID_CELL_M).ceil() as i32;
        let grid = &self.scratch.reactive_grid;
        for dx in -reach..=reach {
            for dy in -reach..=reach {
                let key = (cx + dx, cy + dy);
                let start = grid.partition_point(|e| (e.0, e.1) < key);
                let mut i = start;
                while i < grid.len() && (grid[i].0, grid[i].1) == key {
                    out.push(grid[i].2);
                    i += 1;
                }
            }
        }
    }

    fn find_leader_for(
        &self,
        a: &ActorRuntime,
        nearby: &mut Vec<ActorIndex>,
        cache: &mut Vec<(u32, f64, f64, f64)>,
    ) -> Option<Leader> {
        if !self.ambient_reactive || !a.is_ambient {
            return find_leader(a, self.actors.iter(), f64::INFINITY, cache);
        }
        self.nearby_actors(a, nearby);
        find_leader(
            a,
            nearby.iter().map(|i| &self.actors[i.index()]),
            REACTIVE_MAX_RANGE_M2,
            cache,
        )
    }

    /// Crossing-path conflict: nearest point where two future paths pass
    /// within `CONFLICT_RADIUS_M`, when the other actor gets there first and
    /// the arrival times are within `CONFLICT_WINDOW_S`.
    fn find_conflict(&self, a: &ActorRuntime) -> Option<ConflictHazard> {
        let (ms, me) = self.scratch.conflict_ranges[a.index.index()];
        if ms == me || a.speed_mps < 0.2 {
            return None;
        }
        let mine = &self.scratch.conflict_points[ms as usize..me as usize];
        let mut best: Option<ConflictHazard> = None;
        let candidates = &self.scratch.conflict_candidates;
        let (cs, ce) = if self.has_ambient {
            let s = candidates.partition_point(|c| c.0 < a.index.0);
            let e = candidates.partition_point(|c| c.0 <= a.index.0);
            (s, e)
        } else {
            (0, 0)
        };
        let mut check = |b: &ActorRuntime| {
            if b.index == a.index || !b.is_live() {
                return;
            }
            if !a.is_ambient && b.is_ambient {
                return;
            }
            if normalize_angle(b.heading_rad - a.heading_rad).abs() < CONFLICT_MIN_ANGLE_RAD {
                return;
            }
            let (ts, te) = self.scratch.conflict_ranges[b.index.index()];
            if ts == te {
                return;
            }
            let theirs = &self.scratch.conflict_points[ts as usize..te as usize];
            let authored_has_priority = a.is_ambient && !b.is_ambient;
            // Reference semantics: the row scan stops as soon as *any*
            // conflict is held — including one found against an earlier
            // candidate — so later candidates only ever contest row 1.
            for (i, p) in mine.iter().enumerate().skip(1) {
                for (j, q) in theirs.iter().enumerate() {
                    if (p.x - q.x).abs() > CONFLICT_RADIUS_M
                        || (p.y - q.y).abs() > CONFLICT_RADIUS_M
                    {
                        continue;
                    }
                    if hypot(p.x - q.x, p.y - q.y) > CONFLICT_RADIUS_M {
                        continue;
                    }
                    let my_dist = i as f64 * CONFLICT_STEP_M;
                    let their_dist = j as f64 * CONFLICT_STEP_M;
                    let my_t = my_dist / a.speed_mps.max(0.2);
                    let their_t = their_dist / b.speed_mps.max(0.2);
                    if !authored_has_priority && their_t >= my_t {
                        continue;
                    }
                    let delta = if authored_has_priority {
                        (my_t - their_t).abs()
                    } else {
                        my_t - their_t
                    };
                    if delta > CONFLICT_WINDOW_S {
                        continue;
                    }
                    if best.map_or(true, |bst| my_dist < bst.dist_m) {
                        best = Some(ConflictHazard {
                            dist_m: my_dist,
                            delta_t: delta,
                            other_kind: b.kind,
                            other: b.index,
                        });
                    }
                    break;
                }
                if best.is_some() {
                    break;
                }
            }
        };
        if self.has_ambient {
            for c in &candidates[cs..ce] {
                check(&self.actors[c.1 as usize]);
            }
        } else {
            for b in &self.actors {
                check(b);
            }
        }
        best
    }

    fn leader_from_index(&self, a: &ActorRuntime, other: ActorIndex) -> Option<Leader> {
        let b = &self.actors[other.index()];
        if !b.is_live() {
            return None;
        }
        let gap = along_route_gap_m(a, b)?;
        Some(Leader {
            gap_m: gap.max(0.05),
            speed_mps: b.speed_mps,
            actor: other,
        })
    }

    fn intent_with_override(intent: MotionIntent, action: Option<&ActionOverride>) -> MotionIntent {
        let Some(o) = action else { return intent };
        MotionIntent {
            motion_direction: o.motion_direction.unwrap_or(intent.motion_direction),
            target_speed_mps: o.target_speed_mps.unwrap_or(intent.target_speed_mps),
            target_acceleration_mps2: o
                .target_acceleration_mps2
                .unwrap_or(intent.target_acceleration_mps2),
            preview_point: o.preview_point.unwrap_or(intent.preview_point),
            preview_heading_rad: o.preview_heading_rad.unwrap_or(intent.preview_heading_rad),
            downed: intent.downed,
            control: o.control.or(intent.control),
        }
    }

    fn plan_actor(&mut self, index: ActorIndex, t: f64) -> EngineResult<Plan> {
        let dt = self.dt;
        let a = &self.actors[index.index()];
        let mut plan = Plan::hold(a);
        plan.lateral_accel = a.lateral_accel_mps2;
        if !a.is_live() {
            return Ok(plan);
        }
        // Static actors and props have no plant: the motion backend refuses
        // to register them, so there is nothing to integrate and they hold
        // the pose they were placed at. Every other actor is a body.
        if a.is_static || a.body.is_none() {
            plan.speed = 0.0;
            plan.lateral_rate = 0.0;
            plan.lateral_accel = 0.0;
            return Ok(plan);
        }

        let action = self.scratch.actions.get(index.index()).copied().flatten();

        if a.crash.is_some() {
            let friction_scale = self.friction_scale_for(a);
            let emergency =
                (limits_for(a).brake_hard * friction_scale).min((a.speed_mps / dt).max(0.0));
            plan.accel = -emergency;
            plan.speed = (a.speed_mps - emergency * dt).max(0.0);
            if let Some(body) = a.body {
                let backend = &mut self.physics;
                let intent = Self::intent_with_override(
                    MotionIntent {
                        motion_direction: a.motion_direction,
                        target_speed_mps: 0.0,
                        target_acceleration_mps2: -emergency,
                        preview_point: Vec2 {
                            x: a.position.x + cos(a.heading_rad),
                            y: a.position.y + sin(a.heading_rad),
                        },
                        preview_heading_rad: a.heading_rad,
                        downed: a.downed_at_s.is_some(),
                        control: None,
                    },
                    action.as_ref(),
                );
                let result = backend
                    .step(body, &intent, dt, friction_scale)
                    .map_err(engine_err)?;
                let st = result.state;
                plan.speed = if a.downed_at_s.is_some() {
                    hypot(st.longitudinal_velocity_mps, st.lateral_velocity_mps)
                } else {
                    st.longitudinal_velocity_mps.abs()
                };
                plan.accel = st.longitudinal_acceleration_mps2 * a.direction_sign();
                plan.position = Vec2 { x: st.x, y: st.y };
                plan.heading = st.yaw_rad;
                let projected = a.route.project_point(plan.position);
                plan.route_s = projected.s;
                plan.lateral_offset = a.route.lateral_offset_at(projected.s, plan.position);
                plan.lateral_rate = st.lateral_velocity_mps;
                plan.lateral_accel = (st.lateral_velocity_mps - a.lateral_rate_mps) / dt;
                self.telemetry[index.index()] = Some(result.telemetry);
            }
            return Ok(plan);
        }

        // A freehand timed route is a speed profile over an authored path,
        // not a choreography: `a.route` already *is* the drawn polyline, so
        // the path tracker steers along it while the keyframes say how fast
        // the body should be at each moment. The body gets to its waypoints
        // by driving there under tyre and drivetrain limits. A station error
        // against the authored schedule is corrected through the speed
        // target, which is the only channel a force-based body has.
        let mut schedule_active = false;
        if let Some(timed) = &a.timed_route {
            let end = timed.end_time_s();
            schedule_active = timed.len() == 1 || end.map_or(false, |e| t + dt <= e + 1e-9);
            if schedule_active {
                let sample_at = (t + dt).min(self.input.clip_seconds);
                let sample = timed.sample(sample_at, a.heading_rad);
                let scheduled_s = a.route.project_point(sample.position).s;
                let station_error = scheduled_s - a.route_s;
                let target = (sample.speed_mps + TIMED_STATION_GAIN_PER_S * station_error)
                    .clamp(0.0, timed_route_speed_envelope_mps(a.kind));
                let a = &mut self.actors[index.index()];
                a.cruise_override_mps = Some(target);
                a.cruise_speed_mps = target;
            }
        }
        // The schedule has run out: release the body onto a freeform runway
        // and let it brake. Only once — the route is taken here.
        if !schedule_active && self.actors[index.index()].timed_route.is_some() {
            // Hand-off to physics-controlled braking, not an implicit cruise.
            let a = &mut self.actors[index.index()];
            let released = a
                .timed_route
                .take()
                .expect("timed")
                .released_route(a.heading_rad);
            a.route = released;
            a.route_s = 0.0;
            a.lateral_offset_m = 0.0;
            a.lateral_reference_offset_m = 0.0;
            a.lateral_rest_offset_m = 0.0;
            a.long_cmd = None;
            a.clear_until(&AxisId::Longitudinal);
            a.cruise_override_mps = Some(0.0);
            a.cruise_speed_mps = 0.0;
            let route_ref = self.route_refs.intern(&a.route);
            a.route_ref = route_ref;
            plan.route_s = 0.0;
            plan.lateral_offset = 0.0;
            plan.lateral_reference_offset = 0.0;
            plan.released_timed = true;
        }

        let lane_speed_limit = self.speed_limit_at(&self.actors[index.index()]);
        // Re-resolve dynamic longitudinal targets (match / gap follow a moving ref).
        {
            let long_kind = self.actors[index.index()]
                .long_cmd
                .as_ref()
                .map(|c| (c.kind, c.match_ref, c.gap));
            match long_kind {
                Some((LongitudinalKind::Speed, Some(m), _)) => {
                    let target = self.resolve_match_target(index, &m, lane_speed_limit);
                    let a = &mut self.actors[index.index()];
                    a.long_cmd.as_mut().expect("cmd").target = target;
                    a.cruise_override_mps = Some(target);
                    a.cruise_speed_mps = target;
                }
                Some((LongitudinalKind::Gap, _, Some(g))) => {
                    let a = &mut self.actors[index.index()];
                    let target = desired_gap_m(a, g.value, g.mode, true);
                    a.long_cmd.as_mut().expect("cmd").target = target;
                }
                _ => {}
            }
        }

        let a = &self.actors[index.index()];
        let lim = limits_for(a);
        let dynamic_profile = a.body.and_then(|body| self.physics.profile(body).cloned());
        let desired_speed = match &a.long_cmd {
            Some(cmd) if cmd.kind == LongitudinalKind::Speed => cmd.target,
            _ => cruise_speed(a, lane_speed_limit),
        };
        let corner = if a.kind.is_road_actor() {
            cornering_plan(&CornerSpeedInput {
                route: &a.route,
                route_s: a.route_s,
                current_speed_mps: a.speed_mps.abs(),
                desired_speed_mps: desired_speed,
                comfortable_lateral_acceleration_mps2: a
                    .driver
                    .comfortable_lateral_acceleration_mps2,
                comfortable_deceleration_mps2: a.driver.comfortable_deceleration_mps2,
                physical_lateral_acceleration_mps2: dynamic_profile
                    .as_ref()
                    .map_or(lim.lateral_accel_max, |p| p.max_lateral_acceleration_mps2),
                physical_deceleration_mps2: dynamic_profile
                    .as_ref()
                    .map_or(lim.brake_hard, |p| p.max_longitudinal_decel_mps2),
            })
        } else {
            CorneringPlan::UNBOUNDED
        };

        let mut nearby = std::mem::take(&mut self.scratch.nearby);
        let mut caches = std::mem::take(&mut self.scratch.leader_projection_cache);
        caches.resize_with(self.actors.len(), Vec::new);
        let mut cache = std::mem::take(&mut caches[index.index()]);

        let commanded_leader = match &a.long_cmd {
            Some(cmd) if cmd.kind == LongitudinalKind::Gap => {
                cmd.gap.and_then(|g| self.leader_from_index(a, g.actor))
            }
            _ => None,
        };
        let source_leader = if a.best_effort_world_path {
            None
        } else {
            self.find_leader_for(a, &mut nearby, &mut cache)
        };
        // Reserve the destination gap from the start of a lane change: swap
        // the pending route in temporarily (no clone) and search from it.
        let mut target_leader: Option<Leader> = None;
        let pending_target = a.lat_cmd.as_ref().and_then(|c| {
            if c.kind == LateralKind::ChangeLane {
                c.pending.as_ref().map(|_| ())
            } else {
                None
            }
        });
        if !a.best_effort_world_path && pending_target.is_some() {
            let a = &mut self.actors[index.index()];
            let cmd = a.lat_cmd.as_mut().expect("lat");
            let pending = cmd.pending.as_mut().expect("pending");
            std::mem::swap(&mut a.route, &mut pending.route);
            let saved_s = a.route_s;
            let saved_offset = a.lateral_offset_m;
            a.route_s = a.route.project_point(a.position).s;
            a.lateral_offset_m = 0.0;
            let mut target_cache: Vec<(u32, f64, f64, f64)> = Vec::new();
            {
                let a = &self.actors[index.index()];
                target_leader =
                    find_leader(a, self.actors.iter(), f64::INFINITY, &mut target_cache);
            }
            let a = &mut self.actors[index.index()];
            let cmd = a.lat_cmd.as_mut().expect("lat");
            let pending = cmd.pending.as_mut().expect("pending");
            std::mem::swap(&mut a.route, &mut pending.route);
            a.route_s = saved_s;
            a.lateral_offset_m = saved_offset;
        }
        let nearest_leader = match (source_leader, target_leader) {
            (None, t) => t,
            (Some(s), None) => Some(s),
            (Some(s), Some(t)) => Some(if s.gap_m <= t.gap_m { s } else { t }),
        };
        let a = &self.actors[index.index()];
        let mut accel = longitudinal_accel(
            a,
            t,
            dt,
            lane_speed_limit,
            commanded_leader.as_ref().or(nearest_leader.as_ref()),
        );

        let conflict = if a.best_effort_world_path {
            None
        } else {
            self.find_conflict(a)
        };
        let governor_leader = nearest_leader.filter(|l| self.ego_perceives(index, l.actor));
        let governor_conflict = conflict.filter(|c| self.ego_perceives(index, c.other));
        let leader_is_ambient =
            nearest_leader.map_or(false, |l| self.actors[l.actor.index()].is_ambient);
        let friction_scale = self.friction_scale_for(a);
        let best_effort = a.best_effort_world_path;

        // Stop-line search mutates per-control memory.
        let stop_line_dist = if best_effort {
            None
        } else {
            let signals = &self.signals;
            let me_id = &self.recorder.actor_ids()[index.index()];
            let mut me_states = std::mem::take(&mut self.scratch.stop_states);
            let mut ids = std::mem::take(&mut self.scratch.stop_ids);
            me_states.clear();
            me_states.extend(
                self.actors[index.index()]
                    .road_control_states
                    .iter()
                    .map(|(k, v)| (*k, v.arrived_at_s, v.released)),
            );
            let (lo, rest) = self.actors.split_at_mut(index.index());
            let (a, hi) = rest.split_first_mut().expect("actor");
            let lo: &[ActorRuntime] = lo;
            let hi: &[ActorRuntime] = hi;
            let mut can_release =
                |control: ControlSlot, coordination: u32, _actor: ActorIndex, at: f64| -> bool {
                    Self::can_release_stop(
                        signals,
                        (lo, hi),
                        me_id,
                        &me_states,
                        control,
                        coordination,
                        at,
                        &mut ids,
                    )
                };
            let d = distance_to_stop_line(
                a,
                signals,
                t,
                LOOKAHEAD_M,
                nearest_leader.as_ref(),
                Some(&mut can_release),
            );
            self.scratch.stop_states = me_states;
            self.scratch.stop_ids = ids;
            d
        };
        let a = &self.actors[index.index()];
        let gov = governor_cap(
            a,
            governor_leader.as_ref(),
            stop_line_dist,
            governor_conflict.as_ref(),
        );
        if gov.accel_cap < accel {
            accel = gov.accel_cap;
        }
        if corner.acceleration_cap_mps2 < accel {
            accel = corner.acceleration_cap_mps2;
        }
        accel = accel.max(-lim.brake_hard * friction_scale);
        plan.required_decel = if leader_is_ambient && !a.is_ambient {
            gov.required_decel_excluding_leader
        } else {
            gov.required_decel
        };

        let mut speed = a.speed_mps + accel * dt;
        if speed < 0.0 {
            speed = 0.0;
            accel = -a.speed_mps / dt;
        }
        let geared = govern_speed_for_gear(speed, a.motion_direction);
        if geared < speed {
            accel = ((geared - a.speed_mps) / dt).max(-lim.brake_hard * friction_scale);
            speed = (a.speed_mps + accel * dt).max(0.0);
        }
        plan.accel = accel;
        plan.speed = speed;
        plan.route_s = a.route_s + speed * dt;

        let lat = lateral_step(a, t, dt);
        plan.lateral_reference_offset = lat.offset;
        plan.lateral_reference_rate = lat.rate;
        plan.lateral_reference_accel = lat.accel;
        plan.lateral_complete = lat.complete;
        {
            let body = a.body.expect("every planned actor is a body");
            let short_lookahead = match &dynamic_profile {
                Some(p) => (p.wheelbase_m * 0.85).max(a.speed_mps.abs() * 0.25),
                None => 5.0f64.max(a.speed_mps.abs() * 0.8),
            };
            let heading_at_s = a.route.pose_at(a.route_s).heading_rad;
            let curvature_horizon = 10.0f64.max(a.speed_mps.abs());
            let mut max_heading_change = 0.0f64;
            let mut sample_m = 2.5;
            while sample_m <= curvature_horizon + 1e-9 {
                let h = a
                    .route
                    .pose_at(a.route.length_m().min(a.route_s + sample_m))
                    .heading_rad;
                max_heading_change = max_heading_change.max(angle_delta(heading_at_s, h).abs());
                sample_m += 2.5;
            }
            let steering_lookahead = if a.lat_cmd.is_some() {
                5.0f64.max(a.speed_mps.abs() * 0.8)
            } else if max_heading_change < 3.0 * PI / 180.0 {
                4.0f64.max(a.speed_mps.abs() * 0.5).max(short_lookahead)
            } else {
                short_lookahead
            };
            let preview_s = a.route.length_m().min(a.route_s + steering_lookahead);
            let preview_pose = a.route.pose_at(preview_s);
            let preview_time = 0.4f64.max((preview_s - a.route_s) / a.speed_mps.abs().max(1.0));
            let preview_ref = match &a.lat_cmd {
                Some(cmd) => minimum_jerk_sample(
                    cmd.from,
                    cmd.to,
                    t + dt + preview_time - cmd.fired_at,
                    cmd.duration,
                ),
                None => super::controllers::LateralSample {
                    offset: plan.lateral_reference_offset,
                    rate: plan.lateral_reference_rate,
                    accel: plan.lateral_reference_accel,
                },
            };
            let tracking_error = a.lateral_offset_m - a.lateral_reference_offset_m;
            let tracking_preview_offset = preview_ref.offset
                - if a.lat_cmd.is_some() {
                    tracking_error
                } else {
                    0.0
                };
            let intent = Self::intent_with_override(
                MotionIntent {
                    motion_direction: a.motion_direction,
                    target_speed_mps: speed,
                    target_acceleration_mps2: accel,
                    preview_point: a
                        .route
                        .point_with_offset(preview_s, tracking_preview_offset),
                    preview_heading_rad: heading_with_slip(
                        preview_pose.heading_rad,
                        plan.lateral_reference_rate,
                        plan.speed.max(0.5),
                    ),
                    downed: false,
                    control: None,
                },
                action.as_ref(),
            );
            let backend = &mut self.physics;
            let result = backend
                .step(body, &intent, dt, friction_scale)
                .map_err(engine_err)?;
            let st = result.state;
            let a = &self.actors[index.index()];
            let position = Vec2 { x: st.x, y: st.y };
            let projected = a.route.project_point(position);
            let projected_offset = a.route.lateral_offset_at(projected.s, position);
            let road_center_allowance =
                0.2f64.max(a.route.width_at(projected.s) / 2.0 - a.dims.w / 2.0 + 0.5);
            let commanded_allowance = match &a.lat_cmd {
                Some(cmd) => cmd.from.abs().max(cmd.to.abs()) + a.dims.w / 2.0 + 0.25,
                None => 0.0,
            };
            let allowed = road_center_allowance.max(commanded_allowance);
            if a.is_ambient
                && !a.tags.iter().any(|t| t == "motion:off-road")
                && projected_offset.abs() > allowed
            {
                // Never publish the first off-corridor integration for
                // generated traffic; hold the last valid pose and retire.
                plan.speed = 0.0;
                plan.accel = -a.speed_mps / dt;
                plan.route_s = a.route_s;
                plan.lateral_offset = a.lateral_offset_m;
                plan.lateral_rate = 0.0;
                plan.lateral_accel = 0.0;
                plan.position = a.position;
                plan.heading = a.heading_rad;
                plan.retire = true;
                let lane = a
                    .route
                    .pose_at(a.route_s)
                    .lane
                    .map(|l| self.graph.rsl(l).to_owned());
                self.events.push(SimEvent::RoadDeparturePrevented {
                    t,
                    actor_id: a.id.clone(),
                    lane_rsl: lane,
                    lateral_error_m: projected_offset.abs(),
                    allowed_center_offset_m: allowed,
                });
                self.finish_plan_scratch(index, nearby, caches, cache);
                return Ok(plan);
            }
            plan.speed = st.longitudinal_velocity_mps.abs();
            plan.accel = st.longitudinal_acceleration_mps2 * a.direction_sign();
            plan.route_s = projected.s;
            plan.lateral_offset = projected_offset;
            plan.lateral_rate = (projected_offset - a.lateral_offset_m) / dt;
            plan.lateral_accel = (plan.lateral_rate - a.lateral_rate_mps) / dt;
            plan.position = position;
            plan.heading = st.yaw_rad;
            self.telemetry[index.index()] = Some(result.telemetry);
            if let (true, Some(cmd)) = (lat.complete, &a.lat_cmd) {
                let reference_heading = normalize_angle(
                    heading_with_slip(
                        a.route.pose_at(projected.s).heading_rad,
                        plan.lateral_reference_rate,
                        plan.speed.max(0.5),
                    ) + if a.is_reverse() { PI } else { 0.0 },
                );
                let position_error = plan.lateral_offset - plan.lateral_reference_offset;
                let rate_error = plan.lateral_rate - plan.lateral_reference_rate;
                let heading_error = angle_delta(reference_heading, plan.heading);
                plan.lateral_complete = position_error.abs() <= DYNAMIC_LATERAL_SETTLE_POSITION_M
                    && rate_error.abs() <= DYNAMIC_LATERAL_SETTLE_RATE_MPS
                    && heading_error.abs() <= DYNAMIC_LATERAL_SETTLE_HEADING_RAD;
                if plan.lateral_complete && cmd.kind == LateralKind::ChangeLane {
                    plan.swap = cmd.pending.clone();
                } else {
                    let settle_deadline = cmd.fired_at + cmd.duration + 2.0f64.max(cmd.duration);
                    if t + dt >= settle_deadline - 1e-9 {
                        plan.lateral_tracking_expired =
                            Some((position_error, rate_error, heading_error));
                    }
                }
            }
        }

        let a = &self.actors[index.index()];
        if plan.route_s >= a.route.length_m() - ROUTE_END_SLACK_M {
            plan.route_s = a.route.length_m();
            // A route is a motion path, not a lifecycle instruction: hold the
            // terminal pose; only exist(absent) despawns.
            plan.accel = -a.speed_mps / dt;
            plan.speed = 0.0;
            plan.lateral_rate = 0.0;
            plan.lateral_accel = 0.0;
            plan.retire = true;
            let terminal = a.route.pose_at(plan.route_s);
            plan.position = a.route.point_with_offset(plan.route_s, plan.lateral_offset);
            plan.heading = normalize_angle(
                heading_with_slip(terminal.heading_rad, 0.0, 0.0)
                    + if a.is_reverse() { PI } else { 0.0 },
            );
        }

        self.finish_plan_scratch(index, nearby, caches, cache);
        Ok(plan)
    }

    fn finish_plan_scratch(
        &mut self,
        index: ActorIndex,
        nearby: Vec<ActorIndex>,
        mut caches: Vec<Vec<(u32, f64, f64, f64)>>,
        cache: Vec<(u32, f64, f64, f64)>,
    ) {
        caches[index.index()] = cache;
        self.scratch.nearby = nearby;
        self.scratch.leader_projection_cache = caches;
    }

    /* ------------------------------------------------------------ applying */

    pub(super) fn apply_all(&mut self, t: f64) -> EngineResult<()> {
        let mut plans = std::mem::take(&mut self.scratch.plans);
        for (index, plan) in plans.iter_mut().enumerate() {
            let actor = ActorIndex(index as u32);
            if !self.actors[index].is_live() {
                continue;
            }
            {
                let a = &mut self.actors[index];
                a.speed_mps = plan.speed;
                a.accel_mps2 = plan.accel;
                a.route_s = plan.route_s;
                a.lateral_offset_m = plan.lateral_offset;
                a.lateral_rate_mps = plan.lateral_rate;
                a.lateral_accel_mps2 = plan.lateral_accel;
                a.lateral_reference_offset_m = plan.lateral_reference_offset;
                a.lateral_reference_rate_mps = plan.lateral_reference_rate;
                a.lateral_reference_accel_mps2 = plan.lateral_reference_accel;
                a.position = plan.position;
                a.heading_rad = plan.heading;
                if t >= 0.0 {
                    a.required_decel_max = a.required_decel_max.max(plan.required_decel);
                }
                if a.speed_mps < 0.05 {
                    if a.standstill_since_s.is_none() {
                        a.standstill_since_s = Some(t);
                    }
                } else {
                    a.standstill_since_s = None;
                }
                if a.speed_mps > GEAR_ENGAGE_SPEED_MPS {
                    a.has_moved = true;
                }
            }
            let dynamic = self.actors[index].body.is_some();

            if let Some((position_error, rate_error, heading_error)) = plan.lateral_tracking_expired
            {
                if let Some(cmd) = self.actors[index].lat_cmd.take() {
                    self.abort_lateral(cmd.interaction, actor, t, AbortReason::TrackingError);
                    let a = &self.actors[index];
                    let interaction_id = self.interactions[cmd.interaction.index()].id.clone();
                    let mut detail = serde_json::Map::new();
                    detail.insert("actorId".into(), a.id.clone().into());
                    detail.insert("interactionId".into(), interaction_id.clone().into());
                    detail.insert("referenceDurationS".into(), cmd.duration.into());
                    detail.insert("positionErrorM".into(), position_error.into());
                    detail.insert("rateErrorMps".into(), rate_error.into());
                    detail.insert("headingErrorRad".into(), heading_error.into());
                    self.issues.push(
                        SimIssue::warning(
                            SimIssueCode::LateralTrackingFailed,
                            format!("interactions.{interaction_id}"),
                            format!("dynamic actor {} did not physically settle onto its authored lateral reference", a.id),
                        )
                        .with_detail(detail),
                    );
                    let a = &mut self.actors[index];
                    if a.until_for(&AxisId::Lateral).map(|e| e.interaction) == Some(cmd.interaction)
                    {
                        a.clear_until(&AxisId::Lateral);
                    }
                    a.lateral_reference_offset_m = a.lateral_rest_offset_m;
                    a.lateral_reference_rate_mps = 0.0;
                    a.lateral_reference_accel_mps2 = 0.0;
                }
            }

            if plan.lateral_tracking_expired.is_none() {
                if let Some(swap) = plan.swap.take() {
                    if let Some(cmd) = self.actors[index].lat_cmd.take() {
                        let a = &mut self.actors[index];
                        let from_lane = a.route.pose_at(a.route_s).lane;
                        let completed = a.position;
                        let projected = swap.route.project_point(completed);
                        a.route = swap.route;
                        a.route_s = projected.s;
                        a.lateral_offset_m = a.route.lateral_offset_at(projected.s, completed);
                        a.lateral_reference_offset_m = 0.0;
                        a.lateral_reference_rate_mps = 0.0;
                        a.lateral_reference_accel_mps2 = 0.0;
                        a.lateral_rest_offset_m = 0.0;
                        if !dynamic {
                            a.lateral_rate_mps = 0.0;
                            a.lateral_accel_mps2 = 0.0;
                        }
                        a.position = completed;
                        let route_ref = self.route_refs.intern(&a.route);
                        a.route_ref = route_ref;
                        let a_id = a.id.clone();
                        self.events.push(SimEvent::LaneChange {
                            t,
                            actor_id: a_id.clone(),
                            from_rsl: from_lane.map(|l| self.graph.rsl(l).to_owned()),
                            to_rsl: swap.target_lane.map(|l| self.graph.rsl(l).to_owned()),
                            legal: true,
                        });
                        self.events.push(SimEvent::InteractionCompleted {
                            t,
                            actor_id: a_id,
                            interaction_id: self.interactions[cmd.interaction.index()].id.clone(),
                            final_lateral_offset_m: Some(0.0),
                        });
                        self.release_axis(
                            actor,
                            &AxisId::Lateral,
                            t,
                            cmd.interaction,
                            ReleasedReason::Complete,
                        );
                    }
                } else if plan.lateral_complete {
                    let is_offset = self.actors[index]
                        .lat_cmd
                        .as_ref()
                        .map_or(false, |c| c.kind == LateralKind::LaneOffset);
                    if is_offset {
                        let cmd = self.actors[index].lat_cmd.take().expect("cmd");
                        let a = &mut self.actors[index];
                        a.lateral_reference_offset_m = cmd.to;
                        a.lateral_reference_rate_mps = 0.0;
                        a.lateral_reference_accel_mps2 = 0.0;
                        a.lateral_rest_offset_m = cmd.to;
                        if !dynamic {
                            a.lateral_offset_m = cmd.to;
                            a.position = a.route.point_with_offset(a.route_s, cmd.to);
                            a.lateral_rate_mps = 0.0;
                            a.lateral_accel_mps2 = 0.0;
                        }
                        self.events.push(SimEvent::InteractionCompleted {
                            t,
                            actor_id: a.id.clone(),
                            interaction_id: self.interactions[cmd.interaction.index()].id.clone(),
                            final_lateral_offset_m: Some(cmd.to),
                        });
                        self.release_axis(
                            actor,
                            &AxisId::Lateral,
                            t,
                            cmd.interaction,
                            ReleasedReason::Complete,
                        );
                    }
                }
            }

            if plan.retire {
                self.actors[index].retired = true;
            }
        }
        self.scratch.plans = plans;
        self.resolve_dynamic_contacts(t)
    }

    /// Resolve all moving bodies together. Only explicit fixed/static actors,
    /// props, and map proxies have infinite mass.
    fn resolve_dynamic_contacts(&mut self, t: f64) -> EngineResult<()> {
        let dt = self.dt;
        let mut active: Vec<BodyIndex> = Vec::new();
        let mut speed_before: Vec<(ActorIndex, f64)> = Vec::new();
        let mut static_slots: Vec<u32> = Vec::new();
        let mut shapes = std::mem::take(&mut self.scratch.current_shapes);
        shapes.resize_with(self.actors.len(), Vec::new);
        for a in &self.actors {
            let Some(body) = a.body else { continue };
            if !a.is_live() {
                continue;
            }
            active.push(body);
            if a.kind.is_knockdown_vulnerable() {
                if let Some(st) = self.physics.state(body) {
                    speed_before.push((
                        a.index,
                        hypot(st.longitudinal_velocity_mps, st.lateral_velocity_mps),
                    ));
                }
            }
            let mut current = std::mem::take(&mut shapes[a.index.index()]);
            self.collision_shapes_into(a.index, t, &mut current);
            let previous = &self.collision_snapshots[a.index.index()];
            let bounds = Self::swept_bounds_of(
                &current,
                if previous.live {
                    Some(&previous.shapes)
                } else {
                    None
                },
            );
            let mut candidates = std::mem::take(&mut self.scratch.static_candidates);
            self.statics
                .candidates(bounds.0, bounds.1, bounds.2, bounds.3, &mut candidates);
            static_slots.extend_from_slice(&candidates);
            self.scratch.static_candidates = candidates;
            shapes[a.index.index()] = current;
        }
        self.scratch.current_shapes = shapes;
        static_slots.sort_unstable();
        static_slots.dedup();
        let mut colliders: Vec<WorldStaticCollider<'_>> =
            Vec::with_capacity(static_slots.len() + self.actors.len());
        for &slot in &static_slots {
            let shape = self.statics.shape(slot);
            colliders.push(WorldStaticCollider::fixed(&shape.id, shape.obb));
        }
        for a in &self.actors {
            if a.body.is_some() || !a.is_live() {
                continue;
            }
            colliders.push(WorldStaticCollider {
                id: &a.id,
                obb: a.obb(),
                velocity: a.velocity(),
                angular_velocity: 0.0,
            });
        }
        let backend = &mut self.physics;
        backend
            .step_world(&active, &colliders, dt)
            .map_err(engine_err)?;
        let backend = &*backend;
        // Knockdowns: normal impulse per actor body, first partner wins.
        let mut normal_by_actor: Vec<(ActorIndex, f64, String)> = Vec::new();
        for contact in backend.contacts() {
            for (me, other) in [(contact.a, contact.b), (contact.b, contact.a)] {
                let WorldContactRef::Body(body) = me else {
                    continue;
                };
                let Some(id) = backend.actor_id(body) else {
                    continue;
                };
                let Some(&actor) = self.actor_index.get(id) else {
                    continue;
                };
                let other_id = match other {
                    WorldContactRef::Body(b) => backend.actor_id(b).unwrap_or("").to_owned(),
                    WorldContactRef::Static(slot) => colliders[slot as usize].id.to_owned(),
                };
                match normal_by_actor.iter_mut().find(|e| e.0 == actor) {
                    Some(e) => e.1 += contact.normal_impulse_ns,
                    None => normal_by_actor.push((actor, contact.normal_impulse_ns, other_id)),
                }
            }
        }
        drop(colliders);
        normal_by_actor.sort_by(|x, y| {
            crate::hash::cmp_utf16(&self.actors[x.0.index()].id, &self.actors[y.0.index()].id)
        });
        for (actor, impulse_ns, other_id) in normal_by_actor {
            let a = &self.actors[actor.index()];
            if a.is_static || a.downed_at_s.is_some() || !a.kind.is_knockdown_vulnerable() {
                continue;
            }
            let Some(&(_, before)) = speed_before.iter().find(|e| e.0 == actor) else {
                continue;
            };
            let Some(st) = self.physics.state(a.body.expect("body"))
            else {
                continue;
            };
            let after = hypot(st.longitudinal_velocity_mps, st.lateral_velocity_mps);
            if after - before < BALANCE_RECOVERY_DELTA_V_MPS {
                continue;
            }
            let a = &mut self.actors[actor.index()];
            a.downed_at_s = Some(t);
            a.downed_by_actor_id = Some(other_id.clone());
            if a.crash.is_none() {
                a.crash = Some(super::actor::CrashLatch {
                    at_s: t,
                    other_id: other_id.clone(),
                });
                a.long_cmd = None;
                a.lat_cmd = None;
                a.lateral_accel_mps2 = 0.0;
                a.until_by_axis.clear();
            }
            self.events.push(SimEvent::KnockedDown {
                t,
                actor_id: a.id.clone(),
                other_id,
                normal_impulse_ns: impulse_ns,
            });
        }
        let backend = &self.physics;
        for a in &mut self.actors {
            let Some(body) = a.body else { continue };
            if !a.is_live() {
                continue;
            }
            let Some(st) = backend.state(body) else {
                continue;
            };
            a.position = Vec2 { x: st.x, y: st.y };
            a.heading_rad = st.yaw_rad;
            a.speed_mps = if a.downed_at_s.is_some() {
                hypot(st.longitudinal_velocity_mps, st.lateral_velocity_mps)
            } else {
                st.longitudinal_velocity_mps.abs()
            };
            a.lateral_rate_mps = st.lateral_velocity_mps;
            let projected = a.route.project_point(a.position);
            a.route_s = projected.s;
            a.lateral_offset_m = a.route.lateral_offset_at(projected.s, a.position);
            if let Some(telemetry) = backend.telemetry(body) {
                self.telemetry[a.index.index()] = Some(telemetry);
            }
        }
        Ok(())
    }

    fn swept_bounds_of(
        current: &[super::world::Shape],
        previous: Option<&[super::world::Shape]>,
    ) -> (f64, f64, f64, f64) {
        let mut b = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        let mut fold = |shapes: &[super::world::Shape]| {
            for s in shapes {
                let r = hypot(s.obb.length_m, s.obb.width_m) / 2.0;
                b.0 = b.0.min(s.obb.center.x - r);
                b.1 = b.1.min(s.obb.center.y - r);
                b.2 = b.2.max(s.obb.center.x + r);
                b.3 = b.3.max(s.obb.center.y + r);
            }
        };
        fold(current);
        if let Some(p) = previous {
            fold(p);
        }
        b
    }

    /* ------------------------------------------------------------- output */

    /// Lane membership for a freeform-routed body, re-solved once it has
    /// moved a metre.
    fn freeform_lane(&mut self, index: ActorIndex) -> Option<LaneId> {
        let a = &self.actors[index.index()];
        if let Some((at, lane)) = a.freeform_lane_binding {
            if hypot(at.x - a.position.x, at.y - a.position.y) < FREEFORM_LANE_REBIND_M {
                return lane;
            }
        }
        let found = self.graph.nearest_lane(
            a.position,
            crate::map::NearestLaneQuery {
                max_dist_m: a.dims.w.max(1.5),
                ..Default::default()
            },
        );
        let lane = found.map(|f| f.lane);
        let position = a.position;
        self.actors[index.index()].freeform_lane_binding = Some((position, lane));
        lane
    }

    pub(super) fn record_tracks(&mut self, t: f64) -> EngineResult<()> {
        // Resolve freeform lane bindings first (mutable), then borrow for frames.
        for index in 0..self.actors.len() {
            if self.actors[index].route.is_freeform() {
                self.freeform_lane(ActorIndex(index as u32));
            }
        }
        let mut signal_frames = std::mem::take(&mut self.scratch.signal_frames);
        signal_frames.clear();
        for i in 0..self.signals.program_count() as u32 {
            signal_frames.push(SignalFrame {
                phase: self.signals.phase_at_index(i, t),
            });
        }
        {
            let backend = &self.physics;
            let frames: Vec<ActorFrame<'_>> = self
                .actors
                .iter()
                .map(|a| {
                    let pose = a.route.pose_at(a.route_s);
                    let lane = pose.lane.or_else(|| {
                        if a.route.is_freeform() {
                            a.freeform_lane_binding.and_then(|b| b.1)
                        } else {
                            None
                        }
                    });
                    let physics = a.body.map(|body| {
                        let st = backend.state(body);
                        let telemetry = self.telemetry[a.index.index()]
                            .or_else(|| backend.telemetry(body));
                        PhysicsFrame {
                            vx_body_mps: st.map_or(0.0, |s| s.longitudinal_velocity_mps),
                            vy_body_mps: st.map_or(0.0, |s| s.lateral_velocity_mps),
                            yaw_rate_radps: st.map_or(0.0, |s| s.yaw_rate_radps),
                            steer_rad: st.map_or(0.0, |s| s.steer_rad),
                            wheel_angular_speed_radps: st
                                .map_or(0.0, |s| s.wheel_angular_speed_radps),
                            tire_utilization: telemetry.map_or(0.0, |s| s.tire_utilization),
                            front_normal_force_n: telemetry.map_or(0.0, |s| s.front_normal_force_n),
                            rear_normal_force_n: telemetry.map_or(0.0, |s| s.rear_normal_force_n),
                            collision_impulse_ns: telemetry.map_or(0.0, |s| s.collision_impulse_ns),
                            collision_count: telemetry.map_or(0, |s| s.collision_count),
                        }
                    });
                    ActorFrame {
                        x: a.position.x,
                        y: a.position.y,
                        heading_rad: a.heading_rad,
                        speed_mps: a.speed_mps,
                        lateral_offset_m: a.lateral_offset_m,
                        motion_direction: a.motion_direction,
                        lane_rsl: lane.map(|l| self.graph.rsl(l)),
                        s: a.route_s,
                        present: a.present,
                        physics,
                        route_ref: self.route_refs.get(a.route_ref),
                    }
                })
                .collect();
            self.recorder
                .record_tick(t, &frames, &signal_frames)
                .map_err(engine_err)?;
        }
        self.scratch.signal_frames = signal_frames;
        Ok(())
    }

    /// Feed the episode metrics with the state at `t` (recorded ticks and
    /// live sessions alike).
    pub(super) fn observe_metrics(&mut self, t: f64) {
        {
            self.rebuild_prop_occluders();
            let mut shapes = std::mem::take(&mut self.scratch.current_shapes);
            shapes.resize_with(self.actors.len(), Vec::new);
            for a in &self.actors {
                if !a.is_static {
                    continue;
                }
                let mut current = std::mem::take(&mut shapes[a.index.index()]);
                self.collision_shapes_into(a.index, t, &mut current);
                shapes[a.index.index()] = current;
            }
            {
                let occluders = super::world::collect_world_occluders(
                    &self.occluders,
                    &self.actors,
                    &self.occluder_keys,
                    &self.scratch.prop_occluders,
                    &self.input.props,
                );
                let mut static_shapes: Vec<StaticShape<'_>> = Vec::new();
                for a in &self.actors {
                    if !a.is_static {
                        continue;
                    }
                    for s in &shapes[a.index.index()] {
                        let name = match s.label {
                            ShapeLabel::Body => "body",
                            ShapeLabel::Door(d) => d.collider_label(),
                            ShapeLabel::Prop(slot) => self.input.props
                                [self.attached[a.index.index()][slot as usize].prop_index as usize]
                                .id
                                .as_str(),
                        };
                        static_shapes.push(StaticShape {
                            actor_id: &a.id,
                            name,
                            obb: s.obb,
                        });
                    }
                }
                self.metrics.observe_tick(
                    t,
                    &self.actors,
                    &occluders,
                    self.input.operational_conditions.effects.visibility_range_m,
                    &static_shapes,
                );
            }
            self.scratch.current_shapes = shapes;
        }
    }

    pub(super) fn downed_since(&self) -> BTreeMap<String, f64> {
        self.actors
            .iter()
            .filter_map(|a| a.downed_at_s.map(|t| (a.id.clone(), t)))
            .collect()
    }
}

#[inline]
pub(super) fn engine_err(e: impl std::fmt::Display) -> crate::error::SimEngineError {
    crate::error::SimEngineError::new(e.to_string(), Vec::new())
}
