//! Per-axis controllers: cruise convergence, gap keeping, the safety governor,
//! the minimum-jerk lateral profile, leader search and stop-line distance.

use crate::map::Route;
use crate::math::{atan2, clamp, cos, pow, sin, sin_cos, Vec2};
use crate::physics::MotionDirection;
use crate::trace::pairs::{along_route_distance, PairActor};
use crate::types::{ActorKind, ControlIndication, Dims, GapMode};

use super::actor::{
    ActorIndex, ActorRuntime, DriverBehaviorProfile, LongitudinalKind, RoadControlRuntimeState,
};
use super::dynamics::transition_value;
use super::signals::{phase_forbids_entry, AuthorityKind, ControlSlot, SignalBook};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MotionLimits {
    pub accel_max: f64,
    pub brake_comfort: f64,
    pub brake_hard: f64,
    pub lateral_rate_max: f64,
    pub lateral_accel_max: f64,
    pub lateral_jerk_max: f64,
}

pub const VEHICLE_LIMITS: MotionLimits = MotionLimits {
    accel_max: 3.0,
    brake_comfort: 3.5,
    brake_hard: 8.0,
    lateral_rate_max: 2.5,
    lateral_accel_max: 3.0,
    // A 3.5 m quintic lane change in 3 s peaks at 7.78 m/s³.
    lateral_jerk_max: 8.0,
};

pub const PEDESTRIAN_LIMITS: MotionLimits = MotionLimits {
    accel_max: 1.5,
    brake_comfort: 1.5,
    brake_hard: 3.0,
    lateral_rate_max: 1.0,
    lateral_accel_max: 2.0,
    lateral_jerk_max: 4.0,
};

/// Per-class envelopes.
pub const fn limits_for_kind(kind: ActorKind) -> MotionLimits {
    match kind {
        ActorKind::Vehicle | ActorKind::Car => VEHICLE_LIMITS,
        ActorKind::Truck => MotionLimits {
            accel_max: 1.4,
            brake_comfort: 2.5,
            brake_hard: 6.0,
            lateral_rate_max: 1.25,
            lateral_accel_max: 1.5,
            lateral_jerk_max: 2.5,
        },
        ActorKind::Bus => MotionLimits {
            accel_max: 1.2,
            brake_comfort: 2.2,
            brake_hard: 5.5,
            lateral_rate_max: 1.1,
            lateral_accel_max: 1.3,
            lateral_jerk_max: 2.2,
        },
        ActorKind::Van => MotionLimits {
            accel_max: 2.4,
            brake_comfort: 3.2,
            brake_hard: 7.0,
            lateral_rate_max: 2.0,
            lateral_accel_max: 2.4,
            lateral_jerk_max: 5.0,
        },
        ActorKind::Motorcycle => MotionLimits {
            accel_max: 4.0,
            brake_comfort: 4.0,
            brake_hard: 9.0,
            lateral_rate_max: 3.0,
            lateral_accel_max: 4.0,
            lateral_jerk_max: 8.0,
        },
        ActorKind::Bicycle => MotionLimits {
            accel_max: 1.1,
            brake_comfort: 1.5,
            brake_hard: 3.5,
            lateral_rate_max: 1.2,
            lateral_accel_max: 2.0,
            lateral_jerk_max: 4.0,
        },
        ActorKind::Pedestrian => PEDESTRIAN_LIMITS,
        ActorKind::Scooter => MotionLimits {
            accel_max: 1.5,
            brake_comfort: 2.0,
            brake_hard: 4.0,
            lateral_rate_max: 1.5,
            lateral_accel_max: 2.5,
            lateral_jerk_max: 5.0,
        },
        ActorKind::SidewalkRobot => MotionLimits {
            accel_max: 1.2,
            brake_comfort: 1.8,
            brake_hard: 3.5,
            lateral_rate_max: 1.2,
            lateral_accel_max: 2.0,
            lateral_jerk_max: 4.0,
        },
        ActorKind::Drone => MotionLimits {
            accel_max: 3.0,
            brake_comfort: 3.0,
            brake_hard: 6.0,
            lateral_rate_max: 3.0,
            lateral_accel_max: 4.0,
            lateral_jerk_max: 8.0,
        },
        ActorKind::Animal => MotionLimits {
            accel_max: 2.0,
            brake_comfort: 2.0,
            brake_hard: 4.0,
            lateral_rate_max: 1.5,
            lateral_accel_max: 3.0,
            lateral_jerk_max: 6.0,
        },
        ActorKind::StaticObject => MotionLimits {
            accel_max: 0.0,
            brake_comfort: 0.0,
            brake_hard: 0.0,
            lateral_rate_max: 0.0,
            lateral_accel_max: 0.0,
            lateral_jerk_max: 0.0,
        },
    }
}

#[inline]
pub fn limits_for(a: &ActorRuntime) -> MotionLimits {
    limits_for_kind(a.kind)
}

/// Cruise convergence gain: `τ = 0.5 s`.
pub const CRUISE_GAIN: f64 = 2.0;
/// Gap controller gains (PD on gap error).
const GAP_KP: f64 = 0.4;
const GAP_KD: f64 = 1.2;
/// Jam distance floor so a commanded time-gap does not collapse at standstill.
const GAP_MIN_M: f64 = 2.0;

/// The driver profile an actor runs when its document declares none: the
/// non-naturalistic PD follower with no reaction or start delay.
pub const DEFAULT_DRIVER: DriverBehaviorProfile = DriverBehaviorProfile {
    naturalistic: false,
    desired_speed_factor: 1.0,
    time_headway_s: 1.0,
    minimum_gap_m: 2.0,
    accel_scale: 1.0,
    comfort_brake_scale: 1.0,
    reaction_time_s: 0.0,
    start_delay_s: 0.0,
    comfortable_lateral_acceleration_mps2: 2.2,
    comfortable_deceleration_mps2: 2.5,
};

/// Aggression 0 → 1.3× gaps, 0.5 → 1.0×, 1 → 0.7×.
#[inline]
pub fn gap_scale_for(aggression: f64) -> f64 {
    1.3 - 0.6 * aggression
}

/// Desired free-flow speed for an actor at its current position.
#[inline]
pub fn cruise_speed(a: &ActorRuntime, lane_speed_limit_mps: f64) -> f64 {
    match a.cruise_override_mps {
        Some(v) => v,
        None => lane_speed_limit_mps * a.rules.speed_factor * a.driver.desired_speed_factor,
    }
}

/// Acceleration that converges on `v_target` with a first-order lag.
#[inline]
pub fn converge(a: &ActorRuntime, v_target: f64, lim: &MotionLimits) -> f64 {
    clamp(
        (v_target - a.speed_mps) * CRUISE_GAIN,
        -lim.brake_comfort,
        lim.accel_max,
    )
}

/// PD gap-keeping acceleration toward `gap_desired` behind `leader_speed`.
#[inline]
pub fn gap_accel(
    a: &ActorRuntime,
    gap_m: f64,
    leader_speed_mps: f64,
    gap_desired_m: f64,
    lim: &MotionLimits,
) -> f64 {
    let error = gap_m - gap_desired_m.max(GAP_MIN_M);
    let raw = GAP_KP * error + GAP_KD * (leader_speed_mps - a.speed_mps);
    clamp(raw, -lim.brake_hard, lim.accel_max)
}

/// Desired gap in metres for a `gap` command.
#[inline]
pub fn desired_gap_m(a: &ActorRuntime, value: f64, mode: GapMode, scaled: bool) -> f64 {
    let base = match mode {
        GapMode::Time => value * a.speed_mps,
        GapMode::Distance => value,
    };
    if scaled {
        base * gap_scale_for(a.rules.aggression)
    } else {
        base
    }
}

/// A leader as seen from an observer's route.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Leader {
    pub gap_m: f64,
    pub speed_mps: f64,
    pub actor: ActorIndex,
}

/// Commanded acceleration from the axis owner (or the default cruise law).
pub fn longitudinal_accel(
    a: &ActorRuntime,
    t: f64,
    dt: f64,
    lane_speed_limit_mps: f64,
    leader: Option<&Leader>,
) -> f64 {
    let lim = limits_for(a);
    let Some(cmd) = &a.long_cmd else {
        return converge(a, cruise_speed(a, lane_speed_limit_mps), &lim);
    };
    if cmd.kind == LongitudinalKind::Speed {
        let v_next = transition_value(
            &cmd.dynamics,
            cmd.v0,
            cmd.target,
            t + dt - cmd.fired_at,
            cmd.duration,
        );
        return clamp((v_next - a.speed_mps) / dt, -lim.brake_hard, lim.accel_max);
    }
    // gap: the profile shapes the approach; a PD loop tracks it.
    let (gap_now, leader_v) = match leader {
        Some(l) => (l.gap_m, l.speed_mps),
        None => (f64::INFINITY, a.speed_mps),
    };
    if !gap_now.is_finite() {
        return converge(a, cruise_speed(a, lane_speed_limit_mps), &lim);
    }
    let gap_commanded = transition_value(
        &cmd.dynamics,
        cmd.v0,
        cmd.target,
        t + dt - cmd.fired_at,
        cmd.duration,
    );
    let accel = gap_accel(a, gap_now, leader_v, gap_commanded, &lim);
    let v_cap = cruise_speed(a, lane_speed_limit_mps);
    if a.speed_mps + accel * dt > v_cap {
        clamp((v_cap - a.speed_mps) / dt, -lim.brake_hard, lim.accel_max)
    } else {
        accel
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HazardReason {
    None,
    Leader,
    Signal,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HazardResult {
    /// Most restrictive acceleration the governor will allow, m/s².
    pub accel_cap: f64,
    /// Decel that *would* have been required to avoid contact, m/s² (≥ 0).
    pub required_decel: f64,
    /// The same figure with the car-following term removed.
    pub required_decel_excluding_leader: f64,
    pub reason: HazardReason,
}

/// Deceleration needed to shed `dv` over `gap` metres.
#[inline]
pub fn required_decel_for(dv: f64, gap_m: f64) -> f64 {
    if dv <= 0.0 {
        0.0
    } else {
        (dv * dv) / (2.0 * gap_m.max(0.05))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConflictHazard {
    pub dist_m: f64,
    pub delta_t: f64,
    pub other_kind: ActorKind,
    pub other: ActorIndex,
}

/// The safety governor. Returns a *cap* on acceleration; the caller takes the
/// minimum with the commanded value, so the governor can only ever brake.
pub fn governor_cap(
    a: &ActorRuntime,
    leader: Option<&Leader>,
    stop_line_dist_m: Option<f64>,
    conflict: Option<&ConflictHazard>,
) -> HazardResult {
    let lim = limits_for(a);
    let mut cap = f64::INFINITY;
    let mut required = 0.0f64;
    let mut required_without_leader = 0.0f64;
    let mut reason = HazardReason::None;

    if a.rules.collision_avoidance {
        if let Some(leader) = leader {
            let driver = &a.driver;
            let closing = a.speed_mps - leader.speed_mps;
            let desired = driver.minimum_gap_m
                + a.speed_mps * driver.time_headway_s
                + ((a.speed_mps * closing)
                    / (2.0
                        * (lim.accel_max
                            * driver.accel_scale
                            * lim.brake_comfort
                            * driver.comfort_brake_scale)
                            .max(0.1)
                            .sqrt()))
                .max(0.0);
            let free_speed = a.cruise_speed_mps.max(0.1);
            let accel = if driver.naturalistic {
                // `Math.pow(x, 4)` in the reference goes through fdlibm's
                // log2/exp2 path, not `(x·x)·(x·x)`; keep the same rounding.
                lim.accel_max
                    * driver.accel_scale
                    * (1.0
                        - pow(a.speed_mps / free_speed, 4.0)
                        - pow(desired / leader.gap_m.max(0.2), 2.0))
            } else {
                gap_accel(
                    a,
                    leader.gap_m,
                    leader.speed_mps,
                    (a.speed_mps * (1.5 - a.rules.aggression)).max(GAP_MIN_M),
                    &lim,
                )
            };
            let req = required_decel_for(a.speed_mps - leader.speed_mps, leader.gap_m);
            required = required.max(req);
            if accel < cap {
                cap = accel;
                reason = HazardReason::Leader;
            }
        }
    }

    if let Some(stop_line_dist_m) = stop_line_dist_m {
        // Brake to a stop at the line: a = -v² / 2d with a 0.5 m standoff, after
        // reserving the driver's reaction distance.
        let d = stop_line_dist_m - 0.5 - a.speed_mps * a.driver.reaction_time_s;
        let accel = if d <= 0.05 || (stop_line_dist_m <= 6.0 && a.speed_mps < 1.5) {
            -lim.brake_hard
        } else {
            -(a.speed_mps * a.speed_mps) / (2.0 * d)
        };
        required = required.max(-accel);
        required_without_leader = required_without_leader.max(-accel);
        let capped = accel.max(-lim.brake_hard);
        if capped < cap {
            cap = capped;
            reason = HazardReason::Signal;
        }
    }

    if let Some(conflict) = conflict {
        let yields = if conflict.other_kind.is_pedestrian_like() {
            a.rules.yield_to_pedestrians
        } else {
            a.rules.yield_to_vehicles
        };
        if a.rules.collision_avoidance && yields {
            let accel = -(a.speed_mps * a.speed_mps) / (2.0 * (conflict.dist_m - 2.0).max(0.5));
            required = required.max(-accel);
            required_without_leader = required_without_leader.max(-accel);
            let capped = accel.max(-lim.brake_comfort);
            if capped < cap {
                cap = capped;
                reason = HazardReason::Conflict;
            }
        }
    }

    HazardResult {
        accel_cap: cap,
        required_decel: required,
        required_decel_excluding_leader: required_without_leader,
        reason,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LateralSample {
    pub offset: f64,
    pub rate: f64,
    pub accel: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LateralStep {
    pub offset: f64,
    pub rate: f64,
    pub accel: f64,
    pub complete: bool,
}

/// Lateral offset for this tick on the minimum-jerk profile.
pub fn lateral_step(a: &ActorRuntime, t: f64, dt: f64) -> LateralStep {
    let lim = limits_for(a);
    let (offset, rate, accel, complete) = match &a.lat_cmd {
        Some(cmd) => {
            let elapsed = t + dt - cmd.fired_at;
            let s = minimum_jerk_sample(cmd.from, cmd.to, elapsed, cmd.duration);
            (s.offset, s.rate, s.accel, elapsed >= cmd.duration - 1e-9)
        }
        // No owner: hold the completed lane-relative offset. A new command
        // owns any subsequent recentering explicitly.
        None => (a.lateral_rest_offset_m, 0.0, 0.0, false),
    };
    // Inactive when the duration was analytically bounded; floating-point rails.
    LateralStep {
        offset,
        rate: clamp(rate, -lim.lateral_rate_max, lim.lateral_rate_max),
        accel: clamp(accel, -lim.lateral_accel_max, lim.lateral_accel_max),
        complete,
    }
}

/// Full Frenet reference on the minimum-jerk quintic.
pub fn minimum_jerk_sample(from: f64, to: f64, elapsed_s: f64, duration_s: f64) -> LateralSample {
    let duration = duration_s.max(1e-9);
    let u = clamp(elapsed_s / duration, 0.0, 1.0);
    let u2 = u * u;
    let u3 = u2 * u;
    let u4 = u3 * u;
    let u5 = u4 * u;
    let distance = to - from;
    LateralSample {
        offset: from + distance * (10.0 * u3 - 15.0 * u4 + 6.0 * u5),
        rate: distance * (30.0 * u2 - 60.0 * u3 + 30.0 * u4) / duration,
        accel: distance * (60.0 * u - 180.0 * u2 + 120.0 * u3) / (duration * duration),
    }
}

/// Position-only helper for pair prediction.
#[inline]
pub fn minimum_jerk_value(from: f64, to: f64, elapsed_s: f64, duration_s: f64) -> f64 {
    minimum_jerk_sample(from, to, elapsed_s, duration_s).offset
}

/// Heading including the body slip implied by lateral motion.
#[inline]
pub fn heading_with_slip(path_heading: f64, lateral_rate: f64, speed: f64) -> f64 {
    path_heading + atan2(lateral_rate, speed.max(0.5))
}

/// The read-only view the pair readouts and the leader search consume. Lives
/// here because the lateral prediction follows the profile this module owns.
impl PairActor for ActorRuntime {
    #[inline]
    fn id(&self) -> &str {
        &self.id
    }
    #[inline]
    fn kind(&self) -> ActorKind {
        self.kind
    }
    #[inline]
    fn dims(&self) -> Dims {
        self.dims
    }
    #[inline]
    fn is_static(&self) -> bool {
        self.is_static
    }
    #[inline]
    fn is_present(&self) -> bool {
        self.present
    }
    #[inline]
    fn is_retired(&self) -> bool {
        self.retired
    }
    #[inline]
    fn position(&self) -> Vec2 {
        self.position
    }
    #[inline]
    fn heading_rad(&self) -> f64 {
        self.heading_rad
    }
    #[inline]
    fn speed_mps(&self) -> f64 {
        self.speed_mps
    }
    #[inline]
    fn motion_direction(&self) -> MotionDirection {
        self.motion_direction
    }
    #[inline]
    fn route(&self) -> &Route {
        &self.route
    }
    #[inline]
    fn route_s(&self) -> f64 {
        self.route_s
    }
    #[inline]
    fn lateral_offset_m(&self) -> f64 {
        self.lateral_offset_m
    }

    /// Anchor the active lateral command's profile at the measured offset and
    /// advance it by `future_s`; the profile never carries the body past its
    /// authored target even when a rate limit left the body a fraction behind.
    fn predicted_lateral_offset_m(&self, now_s: f64, future_s: f64) -> f64 {
        let Some(cmd) = self.lat_cmd.as_ref().filter(|c| !c.done) else {
            return self.lateral_offset_m;
        };
        let elapsed_now = (now_s - cmd.fired_at).max(0.0);
        let at_now = transition_value(&cmd.dynamics, cmd.from, cmd.to, elapsed_now, cmd.duration);
        let at_future = transition_value(
            &cmd.dynamics,
            cmd.from,
            cmd.to,
            elapsed_now + future_s.max(0.0),
            cmd.duration,
        );
        let predicted = self.lateral_offset_m + (at_future - at_now);
        if cmd.to >= cmd.from {
            predicted.min(cmd.to)
        } else {
            predicted.max(cmd.to)
        }
    }
}

/// Route station of `b` on `a`'s route. Fixed bodies fall back to a route
/// projection, memoised in the caller-owned `cache` (`(actor, x, y, s)`) and
/// invalidated when a collision or teleport moved the body.
fn leader_route_s(
    a: &ActorRuntime,
    b: &ActorRuntime,
    cache: &mut Vec<(u32, f64, f64, f64)>,
) -> f64 {
    if let Some(joined) = along_route_distance(a, b) {
        return a.route_s + joined;
    }
    if !b.is_static {
        return a.route.project_point(b.position).s;
    }
    if let Some(entry) = cache.iter().find(|e| e.0 == b.index.0) {
        if entry.1 == b.position.x && entry.2 == b.position.y {
            return entry.3;
        }
    }
    let s = a.route.project_point(b.position).s;
    match cache.iter_mut().find(|e| e.0 == b.index.0) {
        Some(entry) => *entry = (b.index.0, b.position.x, b.position.y, s),
        None => cache.push((b.index.0, b.position.x, b.position.y, s)),
    }
    s
}

/// Nearest body entering the observer's route corridor. Lane storage is only
/// a projection fast path, never a membership filter: parked/freeform and
/// adjacent-lane bodies can intrude without sharing any route leg.
pub fn find_leader<'a>(
    a: &ActorRuntime,
    others: impl IntoIterator<Item = &'a ActorRuntime>,
    max_range_m2: f64,
    projection_cache: &mut Vec<(u32, f64, f64, f64)>,
) -> Option<Leader> {
    let mut best: Option<Leader> = None;
    let observer_heading = a.route.pose_at(a.route_s).heading_rad;
    let observer_angle = a.heading_rad - observer_heading;
    let observer_cos = cos(observer_angle).abs();
    let observer_sin = sin(observer_angle).abs();
    let observer_front = (a.dims.l * observer_cos + a.dims.w * observer_sin) / 2.0;
    let observer_side = (a.dims.w * observer_cos + a.dims.l * observer_sin) / 2.0;
    for b in others {
        if b.index == a.index || !b.is_live() {
            continue;
        }
        let dx = b.position.x - a.position.x;
        let dy = b.position.y - a.position.y;
        if dx * dx + dy * dy > max_range_m2 {
            continue;
        }
        let s = leader_route_s(a, b, projection_cache);
        let pose = a.route.pose_at(s);
        let (sin, cos) = sin_cos(pose.heading_rad);
        let px = b.position.x - pose.point.x;
        let py = b.position.y - pose.point.y;
        let ahead = s - a.route_s + px * cos + py * sin;
        if ahead <= 0.0 {
            continue;
        }
        let lateral = -px * sin + py * cos - a.lateral_offset_m;
        let angle = b.heading_rad - pose.heading_rad;
        let (body_sin, body_cos) = sin_cos(angle);
        let side = (b.dims.w * body_cos.abs() + b.dims.l * body_sin.abs()) / 2.0;
        if !lateral.is_finite() || lateral.abs() > observer_side + side {
            continue;
        }
        let front = (b.dims.l * body_cos.abs() + b.dims.w * body_sin.abs()) / 2.0;
        let gap = ahead - observer_front - front;
        if best.map_or(true, |l| gap < l.gap_m) {
            best = Some(Leader {
                gap_m: gap,
                speed_mps: b.speed_mps * b.direction_sign() * body_cos,
                actor: b.index,
            });
        }
    }
    best
}

/// Callback deciding whether a stopped actor may leave an all-way stop.
pub type CanReleaseStop<'c> = &'c mut dyn FnMut(ControlSlot, u32, ActorIndex, f64) -> bool;

/// Distance to the next stop line the actor must respect, or `None`. Mutates
/// the actor's per-control memory (stop dwell, yellow commitment, release).
pub fn distance_to_stop_line(
    a: &mut ActorRuntime,
    signals: &SignalBook,
    t: f64,
    lookahead_m: f64,
    leader: Option<&Leader>,
    mut can_release_stop: Option<CanReleaseStop<'_>>,
) -> Option<f64> {
    if !a.rules.obey_signals || signals.is_empty() || a.route.is_freeform() {
        return None;
    }
    let mut best: Option<f64> = None;
    let route_s = a.route_s;
    let speed = a.speed_mps;
    let legs = a.route.legs();
    for (leg_index, leg) in legs.iter().enumerate() {
        if leg.s_start + leg.length_m < route_s {
            continue;
        }
        if leg.s_start - route_s > lookahead_m {
            break;
        }
        for line in signals.on_lane(leg.lane) {
            if !line.connecting_lanes.is_empty()
                && !legs[leg_index..].iter().any(|c| {
                    c.s_start >= leg.s_start && line.connecting_lanes.binary_search(&c.lane).is_ok()
                })
            {
                continue;
            }
            let lane_s = if leg.reversed {
                leg.length_m - line.s
            } else {
                line.s
            };
            let line_route_s = leg.s_start + lane_s;
            let d = line_route_s - route_s;
            if d < -0.5 || d > lookahead_m {
                continue;
            }
            let authority = signals.authority_at(line, t);
            match authority.kind {
                AuthorityKind::None => continue,
                AuthorityKind::Stop => {
                    let state = a
                        .road_control_states
                        .entry(line.control.0)
                        .or_insert_with(RoadControlRuntimeState::default);
                    if state.released {
                        continue;
                    }
                    // dynamic-v1 can settle a few metres upstream under its
                    // bounded brake actuator; that is a complete stop.
                    if speed <= 0.05 && d <= 6.0 {
                        if state.stopped_since_s.is_none() {
                            state.stopped_since_s = Some(t);
                            state.arrived_at_s = Some(t);
                        }
                        if t - state.stopped_since_s.unwrap() >= authority.dwell_s {
                            if state.proceed_after_s.is_none() {
                                let allowed = match can_release_stop.as_mut() {
                                    Some(f) => f(line.control, line.coordination, a.index, t),
                                    None => true,
                                };
                                if allowed {
                                    state.proceed_after_s = Some(t + a.driver.start_delay_s);
                                }
                            }
                            if let Some(after) = state.proceed_after_s {
                                if t >= after {
                                    state.released = true;
                                    state.released_at_s = Some(t);
                                    continue;
                                }
                            }
                        }
                    } else if speed > 0.05 {
                        // Dwell must be continuous; rolling stops reset the clock.
                        state.stopped_since_s = None;
                    }
                }
                AuthorityKind::Signal => {
                    let phase = line.signal.map(|s| signals.phase_at_index(s, t));
                    let state = a
                        .road_control_states
                        .entry(line.control.0)
                        .or_insert_with(RoadControlRuntimeState::default);
                    if state.released {
                        continue;
                    }
                    // Yellow is a dilemma-zone decision: once the comfort
                    // envelope says continue, commit.
                    if phase == Some(ControlIndication::Yellow) {
                        let comfort_required = required_decel_for(speed, (d - 0.5).max(0.05));
                        if comfort_required > limits_for_kind(a.kind).brake_comfort {
                            state.released = true;
                            continue;
                        }
                    }
                    // Keep-clear: do not enter a junction whose connecting lane
                    // and immediate exit are occupied by a stopped queue.
                    let connecting_leg_length = line
                        .connecting_lanes
                        .iter()
                        .filter_map(|rsl| {
                            legs[leg_index..]
                                .iter()
                                .find(|c| c.s_start >= leg.s_start && c.lane == *rsl)
                        })
                        .map(|c| c.length_m)
                        .next();
                    let blocked_exit = match leader {
                        Some(l) => {
                            l.speed_mps < 1.5
                                && l.gap_m > d
                                && l.gap_m < d + connecting_leg_length.unwrap_or(12.0) + 8.0
                        }
                        None => false,
                    };
                    let forbidden = blocked_exit || phase.map_or(false, phase_forbids_entry);
                    if forbidden {
                        state.was_blocked = true;
                        state.proceed_after_s = None;
                    } else if state.was_blocked {
                        if state.proceed_after_s.is_none() {
                            state.proceed_after_s = Some(t + a.driver.start_delay_s);
                        }
                        if t >= state.proceed_after_s.unwrap() {
                            state.released = true;
                            state.released_at_s = Some(t);
                            continue;
                        }
                    } else {
                        continue;
                    }
                }
            }
            if best.map_or(true, |b| d < b) {
                best = Some(d.max(0.0));
            }
        }
    }
    best
}
