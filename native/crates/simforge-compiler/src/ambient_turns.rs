//! Turn feasibility for generated traffic.
//!
//! The ambient generator walks a lane graph and picks a successor at every
//! junction. A junction connector drawn for a passenger car can be far tighter
//! than a bus or a box truck can steer, and a car or cyclist that meets a
//! hairpin connector at cruise speed runs wide however hard it steers. The
//! engine's road-departure guard (`road_departure_prevented`) then freezes and
//! retires that vehicle mid-junction. The guard is a safety net for the
//! engine; normal generated traffic should never reach it.
//!
//! So the generator only assigns a transition a vehicle class can actually
//! drive. A transition `from -> to` is *feasible* for a class when a body of
//! that class, driven by the same plant (`dynamic-v1` with the class profile:
//! wheelbase, steering lock, steer rate and lag, tyre and lateral limits), the
//! same corner-speed planner and the same steering preview rule the engine
//! uses, follows it without its lateral error exceeding
//! [`TURN_PROBE_MAX_ALLOWANCE_FRACTION`] of the corridor the guard allows
//! (`max(0.2, laneWidth/2 - bodyWidth/2 + 0.5)`).
//!
//! The probe is a pure function of the lane graph, the two directed lanes,
//! the class and a speed bucket. It draws no random numbers, and the
//! generator filters successors BEFORE its weighted draw. So the number and
//! order of RNG draws per candidate do not depend on probe results, and the
//! same seed always yields the same population.
//!
//! Authored and timed routes never pass through here: they stay
//! kinematic/exact as authored.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use simforge_core::map::{build_lane_path_route, DirectedLane, LaneGraph, Route};
use simforge_core::math::{angle_delta, clamp, cos, sin, Vec2};
use simforge_core::physics::{
    actor_physics_profile, DynamicV1Backend, MotionActorInitialization, MotionBackend,
    MotionDirection, MotionInitialState, MotionIntent,
};
use simforge_core::types::ActorKind;

/// Tick of the probe. Simulations run at 0.02 s (enforced by input
/// validation); the probe uses the coarser 0.05 s because it updates the
/// steering preview less often, so a transition feasible at 0.05 s is feasible
/// at 0.02 s, at 40% of the probe cost. Measured on the stop-spin corpus at
/// 0.02 s (60 s heavy, 3 maps × 3 seeds): guard firings 35 → 3; the remaining
/// three exceed the corridor by ≤ 2 cm at 1–5 m/s while queueing or yielding
/// inside a junction, which is interaction, not route feasibility.
pub const TURN_PROBE_DT_S: f64 = 0.05;
/// Run-up on the incoming lane before the join, so the body arrives at the
/// speed the corner planner would have braked it to.
pub const TURN_PROBE_LEAD_M: f64 = 25.0;
/// Share of the guard's corridor a feasible transition may use. The rest is
/// headroom for what the probe does not model: traffic, signals, lateral
/// offsets and a body that arrives slightly off-centre.
pub const TURN_PROBE_MAX_ALLOWANCE_FRACTION: f64 = 0.8;
/// Transitions whose heading never changes by more than this over the probed
/// span are feasible for every class without running the probe.
pub const GENTLE_HEADING_CHANGE_RAD: f64 = 12.0 * std::f64::consts::PI / 180.0;
/// Headroom over the posted limit for the probe speed. Generated cruise is
/// the limit times `1 ± speedVariance`; presets vary by at most 12%. A custom
/// profile may vary more, and the corner planner brakes those bodies to the
/// same corner speed before a tight turn.
pub const TURN_PROBE_SPEED_MARGIN: f64 = 1.15;
/// Cruise the generator gives cyclists (`ambient::create_ambient_candidate_pool`).
pub const CYCLIST_CRUISE_MPS: f64 = 5.5;

/// Mirrors `engine::motion` (preview and projection windows).
const ROUTE_TRACK_BEHIND_M: f64 = 6.0;
const ROUTE_TRACK_AHEAD_M: f64 = 6.0;
const STRAIGHT_PREVIEW_THRESHOLD_RAD: f64 = 3.0 * std::f64::consts::PI / 180.0;
/// Default driver comfort values the engine uses when a document declares none.
const COMFORT_LATERAL_MPS2: f64 = 2.2;
const COMFORT_DECEL_MPS2: f64 = 2.5;
const CRUISE_GAIN: f64 = 0.8;

/// How the probe body meets the transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arrival {
    /// At the speed the corner planner allows at the probe start.
    Rolling,
    /// From rest (a stop line or a queue), pulling away toward cruise.
    Standing,
}

/// Where a standing probe starts, before the end of the incoming lane.
pub const TURN_PROBE_STOP_SETBACK_M: f64 = 2.0;

/// Outcome of probing one transition for one class at one speed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TurnProbe {
    /// Largest |lateral error| from the route centreline over the probe, m.
    pub max_lateral_error_m: f64,
    /// Largest `|lateral error| / guard corridor` over the probe.
    pub max_allowance_fraction: f64,
    /// `max_allowance_fraction <= TURN_PROBE_MAX_ALLOWANCE_FRACTION`.
    pub feasible: bool,
    /// Ticks simulated (diagnostic).
    pub ticks: usize,
}

/// Memoised feasibility per `(from, to, class)`. Lookup-only
/// state: the answer never depends on the order transitions are asked in.
#[derive(Debug, Default)]
pub struct TurnFeasibilityCache {
    answers: BTreeMap<(usize, usize, u8), bool>,
    probes_run: usize,
}

impl TurnFeasibilityCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Transitions actually probed (cache misses that needed the plant).
    pub fn probes_run(&self) -> usize {
        self.probes_run
    }
}

/// Whether the generator may route a `kind` body from `from` into `to`.
/// Walkers and other point agents turn on the spot and are always feasible.
///
/// The verdict is a function of the transition and the class only: the probe
/// drives at [`probe_speed_mps`], a conservative cruise for that class on
/// those lanes. Speed matters little above the corner speed anyway, because
/// the corner planner brakes every body to the same corner speed.
pub fn turn_is_feasible(
    graph: &Arc<LaneGraph>,
    from: DirectedLane,
    to: DirectedLane,
    kind: ActorKind,
    cache: &mut TurnFeasibilityCache,
) -> bool {
    if !is_steered_class(kind) {
        return true;
    }
    let key = (from.slot(), to.slot(), kind as u8);
    if let Some(&answer) = cache.answers.get(&key) {
        return answer;
    }
    let global_key = (transition_fingerprint(graph, from, to), kind as u8);
    if let Some(answer) = global_answers()
        .lock()
        .ok()
        .and_then(|m| m.get(&global_key).copied())
    {
        cache.answers.insert(key, answer);
        return answer;
    }
    let speed = probe_speed_mps(graph, from, to, kind);
    let answer = match build_lane_path_route(graph, &[from.lane, to.lane]) {
        Ok(route) => {
            let join_s = graph.length_of(from.lane);
            let start_s = (join_s - TURN_PROBE_LEAD_M).max(0.0);
            if max_heading_change(&route, start_s) <= GENTLE_HEADING_CHANGE_RAD {
                true
            } else {
                cache.probes_run += 1;
                // Both ways traffic meets a junction: rolling through it, and
                // pulling away from a stop at its entry (signal, stop sign,
                // queue), where a body turns hardest per metre.
                probe_route(&route, start_s, kind, speed, Arrival::Rolling, true).feasible
                    && probe_route(
                        &route,
                        (join_s - TURN_PROBE_STOP_SETBACK_M).max(0.0),
                        kind,
                        speed,
                        Arrival::Standing,
                        true,
                    )
                    .feasible
            }
        }
        Err(_) => false,
    };
    cache.answers.insert(key, answer);
    if let Ok(mut global) = global_answers().lock() {
        if global.len() >= GLOBAL_ANSWER_LIMIT {
            global.clear();
        }
        global.insert(global_key, answer);
    }
    answer
}

type GlobalKey = (String, u8);

/// SHA-256 over everything a probe reads about a transition: both lanes'
/// orientation, polyline and widths. Content-addressed, so a memo keyed by it
/// cannot be confused by two maps (or two builds of one map) that share an
/// id or an OpenDRIVE digest.
fn transition_fingerprint(graph: &LaneGraph, from: DirectedLane, to: DirectedLane) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(4096);
    for d in [from, to] {
        bytes.push(d.reversed as u8);
        let geometry = graph.geometry(d.lane);
        for p in geometry.path.points() {
            bytes.extend_from_slice(&p.x.to_bits().to_le_bytes());
            bytes.extend_from_slice(&p.y.to_bits().to_le_bytes());
        }
        bytes.extend_from_slice(&geometry.width_m.to_bits().to_le_bytes());
        for w in &graph.lane(d.lane).width_samples {
            bytes.extend_from_slice(&w.s.to_bits().to_le_bytes());
            bytes.extend_from_slice(&w.width_m.to_bits().to_le_bytes());
        }
        bytes.push(0xff);
    }
    simforge_core::hash::sha256_bytes(&bytes)
}

/// Answers survive across pool builds (the editor rebuilds the pool on every
/// compile), keyed by [`transition_fingerprint`] and class. The
/// answers are pure functions of the key, so this memo changes timing and
/// never a result.
fn global_answers() -> &'static Mutex<HashMap<GlobalKey, bool>> {
    static ANSWERS: OnceLock<Mutex<HashMap<GlobalKey, bool>>> = OnceLock::new();
    ANSWERS.get_or_init(|| Mutex::new(HashMap::new()))
}

const GLOBAL_ANSWER_LIMIT: usize = 250_000;

/// Schema of the persisted verdict table ([`turn_verdicts_json`]).
pub const TURN_VERDICTS_SCHEMA: &str = "simforge.ambient-turn-verdicts/v1";

/// Every directed transition of `graph` the generator can ask about.
fn graph_transitions(graph: &LaneGraph) -> Vec<(DirectedLane, DirectedLane)> {
    let mut out = Vec::new();
    for lane in graph.lane_ids() {
        for reversed in [false, true] {
            let from = DirectedLane::new(lane, reversed);
            for to in graph.successors(from) {
                out.push((from, *to));
            }
        }
    }
    out
}

/// Every class the generator can steer through a junction.
pub const STEERED_CLASSES: [ActorKind; 8] = [
    ActorKind::Vehicle,
    ActorKind::Car,
    ActorKind::Van,
    ActorKind::Truck,
    ActorKind::Bus,
    ActorKind::Motorcycle,
    ActorKind::Bicycle,
    ActorKind::Scooter,
];

/// Probe every transition of `graph` for every steered class, so the memo
/// (and [`turn_verdicts_json`]) holds the complete table for the map. This is
/// what a map publish runs once, per `(closureDigest, ENGINE_SEM_VER)`; hosts
/// that load the table never probe that map again. Returns the number of
/// transitions actually probed (cache misses).
pub fn compute_all_turn_verdicts(graph: &Arc<LaneGraph>) -> usize {
    let mut cache = TurnFeasibilityCache::new();
    for (from, to) in graph_transitions(graph) {
        for kind in STEERED_CLASSES {
            turn_is_feasible(graph, from, to, kind, &mut cache);
        }
    }
    cache.probes_run()
}

/// The verdicts the process memo holds for `graph`'s transitions, as a
/// persisted table (canonical JSON):
///
/// ```json
/// {"schema":"simforge.ambient-turn-verdicts/v1","engineSemVer":"0.9.0",
///  "classes":["vehicle","car","van","truck","bus","motorcycle","bicycle","scooter"],
///  "verdicts":[["<transition fingerprint>", knownMask, feasibleMask], ...]}
/// ```
///
/// One row per transition, sorted by fingerprint; bit `i` of the masks is
/// `classes[i]`. Probing is the expensive part of building an ambient
/// candidate pool (the first build on a map runs the dynamic-v1 plant through
/// every tight transition). A verdict is a pure function of its content
/// fingerprint and class under one `ENGINE_SEM_VER`, so a host may persist
/// this table beside the map closure (keyed by `closureDigest` and
/// `ENGINE_SEM_VER`) and load it with [`load_turn_verdicts_json`]: the pool
/// comes out byte-identical, only faster.
pub fn turn_verdicts_json(graph: &LaneGraph) -> String {
    let fingerprints: std::collections::BTreeSet<String> = graph_transitions(graph)
        .into_iter()
        .map(|(from, to)| transition_fingerprint(graph, from, to))
        .collect();
    let mut rows: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    if let Ok(global) = global_answers().lock() {
        for ((fingerprint, code), answer) in global.iter() {
            if !fingerprints.contains(fingerprint) {
                continue;
            }
            let Some(bit) = STEERED_CLASSES.iter().position(|k| *k as u8 == *code) else {
                continue;
            };
            let row = rows.entry(fingerprint.clone()).or_insert((0, 0));
            row.0 |= 1 << bit;
            if *answer {
                row.1 |= 1 << bit;
            }
        }
    }
    let value = serde_json::json!({
        "schema": TURN_VERDICTS_SCHEMA,
        "engineSemVer": simforge_core::ENGINE_SEM_VER,
        "classes": STEERED_CLASSES.iter().map(|k| k.as_str()).collect::<Vec<_>>(),
        "verdicts": rows.iter().map(|(f, (known, feasible))| serde_json::json!([f, known, feasible])).collect::<Vec<_>>(),
    });
    simforge_core::hash::canonical_json(&value).unwrap_or_default()
}

/// Seed the process memo from a table written by [`turn_verdicts_json`].
/// Returns the number of verdicts (transition × class) loaded. A table from
/// another schema or another `ENGINE_SEM_VER` is refused: its verdicts came
/// from other probe semantics and would change the generated population.
pub fn load_turn_verdicts_json(text: &str) -> Result<usize, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("turn verdicts: {e}"))?;
    if value.get("schema").and_then(|v| v.as_str()) != Some(TURN_VERDICTS_SCHEMA) {
        return Err("turn verdicts: unsupported schema".into());
    }
    let semver = value.get("engineSemVer").and_then(|v| v.as_str()).unwrap_or("");
    if semver != simforge_core::ENGINE_SEM_VER {
        return Err(format!(
            "turn verdicts were computed by engine {semver}, this is {}",
            simforge_core::ENGINE_SEM_VER
        ));
    }
    let classes = value
        .get("classes")
        .and_then(|v| v.as_array())
        .ok_or("turn verdicts: no classes")?
        .iter()
        .map(|c| c.as_str().and_then(ActorKind::parse).ok_or("turn verdicts: unknown class"))
        .collect::<Result<Vec<ActorKind>, _>>()?;
    if classes.len() > 32 {
        return Err("turn verdicts: too many classes".into());
    }
    let rows = value.get("verdicts").and_then(|v| v.as_array()).ok_or("turn verdicts: no verdicts")?;
    let mut parsed = Vec::with_capacity(rows.len() * classes.len());
    for row in rows {
        let (Some(fingerprint), Some(known), Some(feasible)) = (
            row.get(0).and_then(|v| v.as_str()),
            row.get(1).and_then(|v| v.as_u64()),
            row.get(2).and_then(|v| v.as_u64()),
        ) else {
            return Err("turn verdicts: malformed row".into());
        };
        if fingerprint.len() != 64 || feasible & !known != 0 || known >> classes.len() != 0 {
            return Err("turn verdicts: malformed row".into());
        }
        for (bit, kind) in classes.iter().enumerate() {
            if known & (1 << bit) != 0 {
                parsed.push(((fingerprint.to_owned(), *kind as u8), feasible & (1 << bit) != 0));
            }
        }
    }
    let mut global = global_answers().lock().map_err(|_| "turn verdicts: memo poisoned".to_string())?;
    let count = parsed.len();
    for (key, answer) in parsed {
        global.insert(key, answer);
    }
    Ok(count)
}

/// The cruise a probe drives at: the faster posted limit of the two lanes
/// (the cyclist cruise for bicycles and scooters) with
/// [`TURN_PROBE_SPEED_MARGIN`] on top.
pub fn probe_speed_mps(
    graph: &LaneGraph,
    from: DirectedLane,
    to: DirectedLane,
    kind: ActorKind,
) -> f64 {
    let posted = match kind {
        ActorKind::Bicycle | ActorKind::Scooter => CYCLIST_CRUISE_MPS,
        _ => graph
            .geometry(from.lane)
            .speed_limit_mps
            .max(graph.geometry(to.lane).speed_limit_mps),
    };
    posted * TURN_PROBE_SPEED_MARGIN
}

/// Classes whose motion is steered through wheels (`dynamic-v1`
/// single-track). Everything else is a point agent.
pub fn is_steered_class(kind: ActorKind) -> bool {
    matches!(
        kind,
        ActorKind::Vehicle
            | ActorKind::Car
            | ActorKind::Van
            | ActorKind::Truck
            | ActorKind::Bus
            | ActorKind::Motorcycle
            | ActorKind::Bicycle
            | ActorKind::Scooter
    )
}

/// Largest absolute heading change between the probe start and any later
/// point, sampled every metre.
fn max_heading_change(route: &Route, start_s: f64) -> f64 {
    let length = route.length_m();
    let h0 = route.pose_at(start_s).heading_rad;
    let mut prev = h0;
    let mut unwrapped = 0.0f64;
    let mut max_change = 0.0f64;
    let mut s = start_s + 1.0;
    while s <= length + 1e-9 {
        let h = route.pose_at(s.min(length)).heading_rad;
        unwrapped += angle_delta(prev, h);
        prev = h;
        max_change = max_change.max(unwrapped.abs());
        s += 1.0;
    }
    max_change
}

/// Drive one `kind` body along `lanes` from `start_s` to the end (plus a
/// straight run-out) and record its lateral error against the guard's
/// corridor. With `exit_early` the probe stops as soon as the transition is
/// known to be infeasible; the verdict is the same either way.
pub fn probe_route(
    lanes: &Route,
    start_s: f64,
    kind: ActorKind,
    cruise_mps: f64,
    arrival: Arrival,
    exit_early: bool,
) -> TurnProbe {
    let infeasible = TurnProbe {
        max_lateral_error_m: f64::INFINITY,
        max_allowance_fraction: f64::INFINITY,
        feasible: false,
        ticks: 0,
    };
    let Some(profile) = actor_physics_profile(kind) else {
        return infeasible;
    };
    let dims = kind.default_dims();
    let lane_length = lanes.length_m();
    if lane_length <= start_s + 1.0 {
        return TurnProbe {
            max_lateral_error_m: 0.0,
            max_allowance_fraction: 0.0,
            feasible: true,
            ticks: 0,
        };
    }
    // The error of a tight turn peaks on the way OUT of it, after the
    // connector has ended. Whatever lane follows is not chosen yet, so the
    // probe continues straight along the exit heading for
    // `TURN_PROBE_RUN_OUT_M`, which is also where the engine's preview goes
    // past a route end.
    let route = &extended_path(lanes, start_s);
    let lane_start = start_s;
    let length = route.length_m();
    if length <= 1.0 {
        return TurnProbe {
            max_lateral_error_m: 0.0,
            max_allowance_fraction: 0.0,
            feasible: true,
            ticks: 0,
        };
    }
    let table = PathTable::new(route);
    let corners = CornerProfile::new(
        &table,
        COMFORT_LATERAL_MPS2
            .min(profile.max_lateral_acceleration_mps2 * 0.8)
            .max(0.5),
        COMFORT_DECEL_MPS2
            .min(profile.max_longitudinal_decel_mps2 * 0.8)
            .max(0.5),
    );
    // Arrive the way the engine would: never faster than the planner allows here.
    let v0 = match arrival {
        Arrival::Rolling => corners.speed_limit(0.0, cruise_mps, cruise_mps).0.max(0.5),
        Arrival::Standing => 0.0,
    };
    let start_s = 0.0;
    let start = route.pose_at(start_s);
    let mut backend = DynamicV1Backend::with_default_substep();
    let Ok(body) = backend.register(&MotionActorInitialization {
        actor_id: "turn-probe".to_owned(),
        kind,
        dimensions: Some(dims),
        motion_direction: MotionDirection::Forward,
        state: MotionInitialState::at_rest(start.point.x, start.point.y, start.heading_rad, v0),
        profile: None,
    }) else {
        return infeasible;
    };

    let mut s = start_s;
    let mut v = v0;
    let mut max_error = 0.0f64;
    let mut max_fraction = 0.0f64;
    // Enough ticks to cover the span at a crawl; a body that never gets there
    // is not following the route.
    let max_ticks = (((length - start_s) / 0.5) / TURN_PROBE_DT_S).ceil() as usize + 200;
    // Past the last curvature window plus a settling distance nothing turns
    // any more; the error only decays from there.
    let done_s = (corners.last_turn_end() + TURN_PROBE_SETTLE_M).min(length - 0.5);
    let mut ticks = 0usize;
    for _ in 0..max_ticks {
        ticks += 1;
        if s >= done_s {
            break;
        }
        let (limit, accel_cap) = corners.speed_limit(s, v, cruise_mps);
        let accel = clamp(
            ((limit - v) * CRUISE_GAIN).min(accel_cap),
            -profile.max_longitudinal_decel_mps2,
            profile.max_longitudinal_accel_mps2,
        );
        let speed_cmd = (v + accel * TURN_PROBE_DT_S).max(0.0);
        let lookahead = steering_lookahead(&table, s, v, profile.wheelbase_m);
        let intent = MotionIntent {
            motion_direction: MotionDirection::Forward,
            target_speed_mps: speed_cmd,
            target_acceleration_mps2: accel,
            preview_point: preview_point(route, s + lookahead),
            preview_heading_rad: table.heading(s + lookahead),
            downed: false,
            control: None,
        };
        let Ok(step) = backend.step(body, &intent, TURN_PROBE_DT_S, 1.0) else {
            return infeasible;
        };
        let st = step.state;
        let position = Vec2 { x: st.x, y: st.y };
        let projected = route.project_point_near(
            position,
            s,
            ROUTE_TRACK_BEHIND_M,
            ROUTE_TRACK_AHEAD_M + v.abs() * TURN_PROBE_DT_S,
        );
        let error = route.lateral_offset_at(projected.s, position).abs();
        let lane_s = (lane_start + projected.s).min(lane_length);
        let allowance = 0.2f64.max(lanes.width_at(lane_s) / 2.0 - dims.w / 2.0 + 0.5);
        max_error = max_error.max(error);
        max_fraction = max_fraction.max(error / allowance);
        s = projected.s.max(s);
        v = st.longitudinal_velocity_mps.abs();
        if exit_early && max_fraction > TURN_PROBE_MAX_ALLOWANCE_FRACTION {
            break;
        }
    }
    TurnProbe {
        max_lateral_error_m: max_error,
        max_allowance_fraction: max_fraction,
        feasible: max_fraction <= TURN_PROBE_MAX_ALLOWANCE_FRACTION,
        ticks,
    }
}

/// Distance the probe keeps driving after the last curve (see `probe_route`).
pub const TURN_PROBE_SETTLE_M: f64 = 10.0;

/// Straight run-out appended past the probed lanes (see [`probe_route`]).
pub const TURN_PROBE_RUN_OUT_M: f64 = 15.0;
const PATH_SAMPLE_M: f64 = 0.5;

/// The probed lanes from `start_s`, sampled every [`PATH_SAMPLE_M`], plus a
/// straight run-out along the terminal heading, as one freeform route whose
/// arc length 0 is lane-route arc length `start_s`.
fn extended_path(lanes: &Route, start_s: f64) -> Route {
    let length = lanes.length_m();
    let mut points = Vec::new();
    let mut s = start_s;
    while s < length {
        points.push(lanes.pose_at(s).point);
        s += PATH_SAMPLE_M;
    }
    let end = lanes.pose_at(length);
    points.push(end.point);
    let steps = (TURN_PROBE_RUN_OUT_M / PATH_SAMPLE_M) as usize;
    for i in 1..=steps {
        let d = i as f64 * PATH_SAMPLE_M;
        points.push(Vec2 {
            x: end.point.x + cos(end.heading_rad) * d,
            y: end.point.y + sin(end.heading_rad) * d,
        });
    }
    Route::from_polyline(points)
}

/// Headings of a probe path on a fixed grid, so the per-tick planner and
/// preview queries are table lookups rather than route searches.
struct PathTable {
    headings: Vec<f64>,
    length: f64,
}

impl PathTable {
    const STEP_M: f64 = 0.5;

    fn new(route: &Route) -> Self {
        let length = route.length_m();
        let n = (length / Self::STEP_M).ceil() as usize + 1;
        let headings = (0..n)
            .map(|i| {
                route
                    .pose_at((i as f64 * Self::STEP_M).min(length))
                    .heading_rad
            })
            .collect();
        Self { headings, length }
    }

    fn heading(&self, s: f64) -> f64 {
        let i = (clamp(s, 0.0, self.length) / Self::STEP_M).round() as usize;
        self.headings[i.min(self.headings.len() - 1)]
    }
}

/// `engine::cornering::cornering_plan` over a fixed probe path: the turn speed
/// at every curvature centre is computed once, and each tick only folds the
/// braking approach from the body's position. Same window, threshold,
/// budgets and horizon as the engine planner.
struct CornerProfile {
    /// `(window start s, centre s, turn speed)` for every centre whose
    /// window curvature reaches the planner's threshold.
    turns: Vec<(f64, f64, f64)>,
    braking_budget: f64,
    length: f64,
}

impl CornerProfile {
    const WINDOW_M: f64 = 12.0;
    const CENTRE_STEP_M: f64 = 1.0;
    const MIN_CURVATURE_PER_M: f64 = (2.0 * std::f64::consts::PI / 180.0) / Self::WINDOW_M;

    fn new(table: &PathTable, lateral_budget: f64, braking_budget: f64) -> Self {
        let length = table.length;
        let mut turns = Vec::new();
        let mut centre = 0.0;
        while centre <= length + 1e-9 {
            let before = (centre - Self::WINDOW_M / 2.0).max(0.0);
            let after = (centre + Self::WINDOW_M / 2.0).min(length);
            let span = after - before;
            if span > 1e-6 {
                let curvature =
                    angle_delta(table.heading(before), table.heading(after)).abs() / span;
                if curvature >= Self::MIN_CURVATURE_PER_M {
                    turns.push((before, centre, (lateral_budget / curvature).sqrt()));
                }
            }
            centre += Self::CENTRE_STEP_M;
        }
        Self {
            turns,
            braking_budget,
            length,
        }
    }

    /// End of the last curvature window at or above the planner threshold
    /// (0 when the path never curves).
    fn last_turn_end(&self) -> f64 {
        self.turns.last().map_or(0.0, |&(_, centre, _)| {
            (centre + Self::WINDOW_M / 2.0).min(self.length)
        })
    }

    /// `(speed limit, acceleration cap)` at `s` for a body doing `v` that
    /// wants `desired`.
    fn speed_limit(&self, s: f64, v: f64, desired: f64) -> (f64, f64) {
        let braking_distance = v * v / (2.0 * self.braking_budget);
        let end = self
            .length
            .min(s + clamp(braking_distance + 18.0, 25.0, 80.0));
        let mut cap = desired;
        for &(before, centre, turn_speed) in &self.turns {
            if centre <= s || centre > end {
                continue;
            }
            let distance = (before - s).max(0.0);
            cap = cap.min((turn_speed * turn_speed + 2.0 * self.braking_budget * distance).sqrt());
        }
        let limit = clamp(cap, 0.0, desired);
        let accel_cap = if limit < desired {
            limit - v
        } else {
            f64::INFINITY
        };
        (limit, accel_cap)
    }
}

/// `engine::motion`'s steering lookahead for a dynamic body with no lateral
/// command: short near curves, longer on the straight.
fn steering_lookahead(table: &PathTable, s: f64, v: f64, wheelbase_m: f64) -> f64 {
    let short = (wheelbase_m * 0.85).max(v.abs() * 0.25);
    let heading = table.heading(s);
    let horizon = 10.0f64.max(v.abs());
    let mut max_change = 0.0f64;
    let mut sample = 2.5;
    while sample <= horizon + 1e-9 {
        let h = table.heading(s + sample);
        max_change = max_change.max(angle_delta(heading, h).abs());
        sample += 2.5;
    }
    if max_change < STRAIGHT_PREVIEW_THRESHOLD_RAD {
        4.0f64.max(v.abs() * 0.5).max(short)
    } else {
        short
    }
}

/// Route point at `s`, continued straight past the end (as the engine does).
fn preview_point(route: &Route, s: f64) -> Vec2 {
    let length = route.length_m();
    let base = route.point_with_offset(s.min(length), 0.0);
    let beyond = s - length;
    if beyond <= 0.0 {
        return base;
    }
    let heading = route.pose_at(length).heading_rad;
    Vec2 {
        x: base.x + cos(heading) * beyond,
        y: base.y + sin(heading) * beyond,
    }
}

#[cfg(test)]
mod diagnostics {
    use super::*;
    use simforge_core::map::TopologyIndex;
    use simforge_core::types::TurnRelation;

    /// Map-wide feasibility census. Diagnostic only:
    /// `SIMFORGE_TURN_PROBE_TOPOLOGY=<map>/topology-index.json.gz cargo test -p simforge-compiler turn_census -- --ignored --nocapture`
    /// Candidate-pool build time with the feasibility filter. Diagnostic only.
    #[test]
    #[ignore]
    fn pool_timing() {
        let path = std::env::var("SIMFORGE_TURN_PROBE_TOPOLOGY")
            .expect("set SIMFORGE_TURN_PROBE_TOPOLOGY");
        let bytes = std::fs::read(&path).unwrap();
        let mut text = String::new();
        use std::io::Read;
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_string(&mut text)
            .unwrap();
        let index: TopologyIndex = serde_json::from_str(&text).unwrap();
        let graph = Arc::new(LaneGraph::new(index));
        let profile: crate::ambient::AmbientTrafficProfile = serde_json::from_value(serde_json::json!({
            "version": 1, "preset": "heavy", "seed": "ambient-1", "maxActors": 128, "radiusM": 2000
        })).unwrap();
        let resolved = crate::ambient::resolve_ambient_traffic_profile(&profile).unwrap();
        let t0 = std::time::Instant::now();
        let pool = crate::ambient::create_ambient_candidate_pool(&graph, &resolved).unwrap();
        println!(
            "pool {} candidates in {:?} (cold)",
            pool.candidates.len(),
            t0.elapsed()
        );
        let t1 = std::time::Instant::now();
        let again = crate::ambient::create_ambient_candidate_pool(&graph, &resolved).unwrap();
        println!(
            "pool {} candidates in {:?} (warm)",
            again.candidates.len(),
            t1.elapsed()
        );
        assert_eq!(pool.key, again.key);
        assert_eq!(
            pool.candidates.iter().map(|c| &c.id).collect::<Vec<_>>(),
            again.candidates.iter().map(|c| &c.id).collect::<Vec<_>>(),
            "the process-wide memo must not change the population"
        );
    }

    #[test]
    #[ignore]
    fn turn_census() {
        let path = std::env::var("SIMFORGE_TURN_PROBE_TOPOLOGY")
            .expect("set SIMFORGE_TURN_PROBE_TOPOLOGY");
        let bytes = std::fs::read(&path).unwrap();
        let mut text = String::new();
        use std::io::Read;
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_string(&mut text)
            .unwrap();
        let index: TopologyIndex = serde_json::from_str(&text).unwrap();
        let graph = Arc::new(LaneGraph::new(index));
        let kinds = [
            ActorKind::Car,
            ActorKind::Van,
            ActorKind::Truck,
            ActorKind::Bus,
            ActorKind::Motorcycle,
            ActorKind::Bicycle,
        ];
        let mut table: BTreeMap<(String, String), (usize, usize)> = BTreeMap::new();
        let mut fractions: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        for lane in graph.lane_ids() {
            let spec = graph.lane(lane);
            if spec.is_junction || spec.lane_type != "driving" {
                continue;
            }
            let Some(rev) = graph.nominal_reversed(lane) else {
                continue;
            };
            let from = DirectedLane::new(lane, rev);
            for &to in graph.successors(from) {
                let rel = match graph.turn_relation_of(to.lane) {
                    Some(TurnRelation::Left) => "left",
                    Some(TurnRelation::Right) => "right",
                    Some(TurnRelation::UTurnLeft | TurnRelation::UTurnRight) => "uturn",
                    _ => "through",
                };
                for kind in kinds {
                    let speed = if kind == ActorKind::Bicycle {
                        5.5
                    } else {
                        graph.geometry(lane).speed_limit_mps
                    };
                    let route = build_lane_path_route(&graph, &[from.lane, to.lane]).unwrap();
                    let start_s = (graph.length_of(from.lane) - TURN_PROBE_LEAD_M).max(0.0);
                    let gentle = max_heading_change(&route, start_s) <= GENTLE_HEADING_CHANGE_RAD;
                    let probe = if gentle {
                        None
                    } else {
                        Some(probe_route(
                            &route,
                            start_s,
                            kind,
                            speed.ceil(),
                            Arrival::Rolling,
                            false,
                        ))
                    };
                    let ok = probe.map_or(true, |p| p.feasible);
                    let e = table
                        .entry((format!("{kind:?}"), rel.to_owned()))
                        .or_default();
                    e.0 += 1;
                    if ok {
                        e.1 += 1;
                    }
                    if let Some(p) = probe {
                        fractions
                            .entry(format!("{kind:?}/{rel}"))
                            .or_default()
                            .push(p.max_allowance_fraction);
                    }
                }
            }
        }
        for ((kind, rel), (n, ok)) in &table {
            println!("{kind:>10} {rel:>8} feasible {ok:>4}/{n:<4}");
        }
        for (k, mut v) in fractions {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let q = |p: f64| v[((v.len() - 1) as f64 * p) as usize];
            println!(
                "{k:>20} probed {:>4} p25 {:.2} p50 {:.2} p75 {:.2}",
                v.len(),
                q(0.25),
                q(0.5),
                q(0.75)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use simforge_core::map::TopologyIndex;

    fn lane(
        rsl: &str,
        road: i64,
        junction: bool,
        preds: &[&str],
        succs: &[&str],
        pts: Vec<[f64; 2]>,
    ) -> serde_json::Value {
        json!({
            "rsl": rsl, "roadId": road, "section": 0, "laneId": -1, "laneType": "driving",
            "isJunction": junction, "predecessors": preds, "successors": succs,
            "speedLimitKph": 40.0, "representativeWidthM": 3.5, "polyline": pts
        })
    }

    /// `in` (60 m east, ending at the origin) → an arc of `radius` turning
    /// left by `angle` → `out` (60 m straight on the new heading).
    fn turn_graph(radius: f64, angle: f64) -> Arc<LaneGraph> {
        let mut arc = Vec::new();
        let n = ((radius * angle) / 0.5).ceil().max(2.0) as usize;
        for i in 0..=n {
            let a = angle * i as f64 / n as f64;
            arc.push([radius * a.sin(), radius * (1.0 - a.cos())]);
        }
        let end = *arc.last().unwrap();
        let out = vec![
            end,
            [end[0] + 60.0 * angle.cos(), end[1] + 60.0 * angle.sin()],
        ];
        let index: TopologyIndex = serde_json::from_value(json!({
            "schemaVersion": 1, "mapName": "turn-probe", "source": { "xodrSha256": "fixture" },
            "lanes": {
                "1:0:-1": lane("1:0:-1", 1, false, &[], &["2:0:-1"], vec![[-60.0, 0.0], [0.0, 0.0]]),
                "2:0:-1": lane("2:0:-1", 2, true, &["1:0:-1"], &["3:0:-1"], arc),
                "3:0:-1": lane("3:0:-1", 3, false, &["2:0:-1"], &[], out)
            },
            "gates": [], "junctions": {}
        }))
        .expect("synthetic topology");
        Arc::new(LaneGraph::new(index))
    }

    fn feasible(radius: f64, angle_deg: f64, kind: ActorKind) -> (bool, TurnProbe) {
        let graph = turn_graph(radius, angle_deg.to_radians());
        let from = DirectedLane::new(graph.lane_id("1:0:-1").unwrap(), false);
        let to = *graph
            .successors(from)
            .first()
            .expect("connector is a successor");
        let route = build_lane_path_route(&graph, &[from.lane, to.lane]).unwrap();
        let start = (graph.length_of(from.lane) - TURN_PROBE_LEAD_M).max(0.0);
        let speed = probe_speed_mps(&graph, from, to, kind);
        let probe = probe_route(&route, start, kind, speed, Arrival::Rolling, false);
        let mut cache = TurnFeasibilityCache::new();
        let cached = turn_is_feasible(&graph, from, to, kind, &mut cache);
        (cached, probe)
    }

    #[test]
    fn a_tight_right_angle_is_rejected_for_a_truck_and_a_bus_but_allowed_for_a_car() {
        let (car, car_probe) = feasible(7.0, 90.0, ActorKind::Car);
        let (truck, truck_probe) = feasible(7.0, 90.0, ActorKind::Truck);
        let (bus, _) = feasible(7.0, 90.0, ActorKind::Bus);
        assert!(car, "car should make a 7 m right angle: {car_probe:?}");
        assert!(
            !truck,
            "truck cannot make a 7 m right angle: {truck_probe:?}"
        );
        assert!(!bus, "bus cannot make a 7 m right angle");
    }

    #[test]
    fn a_wide_turn_is_feasible_for_every_class() {
        for kind in [
            ActorKind::Car,
            ActorKind::Van,
            ActorKind::Truck,
            ActorKind::Bus,
            ActorKind::Motorcycle,
            ActorKind::Bicycle,
        ] {
            let _speed = if kind == ActorKind::Bicycle {
                5.5
            } else {
                11.0
            };
            let (ok, probe) = feasible(30.0, 90.0, kind);
            assert!(ok, "{kind:?} should make a 30 m right angle: {probe:?}");
        }
    }

    #[test]
    fn a_hairpin_tighter_than_a_car_can_steer_is_rejected_for_a_car() {
        // Car rear-axle minimum radius is 2.7 / tan(0.58) ≈ 4.1 m.
        let (car, probe) = feasible(2.0, 150.0, ActorKind::Car);
        assert!(!car, "car cannot make a 2 m hairpin: {probe:?}");
        let (moto, probe) = feasible(2.0, 150.0, ActorKind::Motorcycle);
        assert!(
            moto || probe.max_allowance_fraction > 0.0,
            "probe ran: {probe:?}"
        );
    }

    #[test]
    fn a_standing_start_into_a_tight_corner_is_probed_too() {
        // The verdict needs both arrivals: rolling in at the planner's corner
        // speed, and pulling away from a stop line into the corner.
        let graph = turn_graph(3.8, 90f64.to_radians());
        let from = DirectedLane::new(graph.lane_id("1:0:-1").unwrap(), false);
        let to = graph.successors(from)[0];
        let route = build_lane_path_route(&graph, &[from.lane, to.lane]).unwrap();
        let join = graph.length_of(from.lane);
        let speed = probe_speed_mps(&graph, from, to, ActorKind::Van);
        let standing = probe_route(
            &route,
            join - TURN_PROBE_STOP_SETBACK_M,
            ActorKind::Van,
            speed,
            Arrival::Standing,
            false,
        );
        let rolling = probe_route(
            &route,
            join - TURN_PROBE_LEAD_M,
            ActorKind::Van,
            speed,
            Arrival::Rolling,
            false,
        );
        let mut cache = TurnFeasibilityCache::new();
        let verdict = turn_is_feasible(&graph, from, to, ActorKind::Van, &mut cache);
        assert_eq!(
            verdict,
            standing.feasible && rolling.feasible,
            "standing {standing:?} rolling {rolling:?}"
        );
    }

    /// Cost of probing one transition (both arrivals). Diagnostic only.
    #[test]
    #[ignore]
    fn probe_bench() {
        let graph = turn_graph(8.0, 90f64.to_radians());
        let from = DirectedLane::new(graph.lane_id("1:0:-1").unwrap(), false);
        let to = graph.successors(from)[0];
        let route = build_lane_path_route(&graph, &[from.lane, to.lane]).unwrap();
        let join = graph.length_of(from.lane);
        let _t0 = std::time::Instant::now();
        for _ in 0..200 {
            std::hint::black_box(probe_route(
                &route,
                join - TURN_PROBE_LEAD_M,
                ActorKind::Car,
                12.0,
                Arrival::Rolling,
                false,
            ));
            std::hint::black_box(probe_route(
                &route,
                join - TURN_PROBE_STOP_SETBACK_M,
                ActorKind::Car,
                12.0,
                Arrival::Standing,
                false,
            ));
        }
        println!(
            "{:?}",
            probe_route(
                &route,
                join - TURN_PROBE_LEAD_M,
                ActorKind::Car,
                12.0,
                Arrival::Rolling,
                false
            )
        );
        println!(
            "{:?}",
            probe_route(
                &route,
                join - TURN_PROBE_STOP_SETBACK_M,
                ActorKind::Car,
                12.0,
                Arrival::Standing,
                false
            )
        );
    }

    #[test]
    fn walkers_are_never_restricted() {
        let graph = turn_graph(1.0, 3.0);
        let from = DirectedLane::new(graph.lane_id("1:0:-1").unwrap(), false);
        let to = graph.successors(from)[0];
        let mut cache = TurnFeasibilityCache::new();
        assert!(turn_is_feasible(
            &graph,
            from,
            to,
            ActorKind::Pedestrian,
            &mut cache
        ));
        assert_eq!(cache.probes_run(), 0);
    }

    #[test]
    fn the_probe_is_deterministic_and_the_cache_does_not_change_answers() {
        let a = feasible(9.0, 90.0, ActorKind::Van);
        let b = feasible(9.0, 90.0, ActorKind::Van);
        assert_eq!(
            a.1.max_lateral_error_m.to_bits(),
            b.1.max_lateral_error_m.to_bits()
        );
        assert_eq!(a.0, b.0);
        let graph = turn_graph(9.0, 90f64.to_radians());
        let from = DirectedLane::new(graph.lane_id("1:0:-1").unwrap(), false);
        let to = graph.successors(from)[0];
        let mut cache = TurnFeasibilityCache::new();
        let first = turn_is_feasible(&graph, from, to, ActorKind::Van, &mut cache);
        let again = turn_is_feasible(&graph, from, to, ActorKind::Van, &mut cache);
        assert_eq!(first, again, "same speed bucket, same answer");
        // At most one probe: the second ask is served from the cache (the
        // first may already be, from the process-wide memo another test filled).
        assert!(
            cache.probes_run() <= 1,
            "second ask is served from the cache"
        );
    }

    #[test]
    fn persisted_verdicts_round_trip_and_refuse_other_semantics() {
        // A radius no other test uses, so this test's verdicts are its own.
        let graph = turn_graph(7.25, 90f64.to_radians());
        let from = DirectedLane::new(graph.lane_id("1:0:-1").unwrap(), false);
        let to = *graph.successors(from).first().expect("connector");
        let mut cache = TurnFeasibilityCache::new();
        let truck = turn_is_feasible(&graph, from, to, ActorKind::Truck, &mut cache);
        let car = turn_is_feasible(&graph, from, to, ActorKind::Car, &mut cache);
        let table = turn_verdicts_json(&graph);
        let value: serde_json::Value = serde_json::from_str(&table).expect("json");
        assert_eq!(value["schema"], TURN_VERDICTS_SCHEMA);
        assert_eq!(value["engineSemVer"], simforge_core::ENGINE_SEM_VER);
        let rows = value["verdicts"].as_array().expect("rows");
        assert_eq!(rows.len(), 1, "one row per transition: {table}");
        // Reloading is idempotent and changes no answer: truck and car are known.
        assert_eq!(load_turn_verdicts_json(&table).expect("load"), 2);
        let mut fresh = TurnFeasibilityCache::new();
        assert_eq!(turn_is_feasible(&graph, from, to, ActorKind::Truck, &mut fresh), truck);
        assert_eq!(turn_is_feasible(&graph, from, to, ActorKind::Car, &mut fresh), car);
        assert_eq!(fresh.probes_run(), 0, "answers came from the loaded table");
        assert_eq!(turn_verdicts_json(&graph), table, "export is canonical and stable");
        // Other probe semantics are refused.
        let stale = table.replace(simforge_core::ENGINE_SEM_VER, "0.0.1");
        assert!(load_turn_verdicts_json(&stale).is_err());
        assert!(load_turn_verdicts_json("{}").is_err());
    }

    #[test]
    fn gentle_transitions_skip_the_plant() {
        let graph = turn_graph(200.0, 10f64.to_radians());
        let from = DirectedLane::new(graph.lane_id("1:0:-1").unwrap(), false);
        let to = graph.successors(from)[0];
        let mut cache = TurnFeasibilityCache::new();
        assert!(turn_is_feasible(
            &graph,
            from,
            to,
            ActorKind::Bus,
            &mut cache
        ));
        assert_eq!(cache.probes_run(), 0);
    }
}
