//! Generated background road users: a map-wide candidate pool, local
//! selection around the authored choreography, and the ambient-only warm-up
//! ("settle") that advances the generated population before `t = 0` without
//! touching a single authored byte.
//!
//! Background traffic exists to populate the road, never to become the
//! conflict. A generated car that spawns in the ego's own lane becomes the
//! ego's leader and can manufacture the braking demand and the closest
//! approach that the authored challenger was supposed to own. Reserving the
//! authored corridor makes that structurally impossible rather than
//! statistically unlikely.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use simforge_core::engine::{run_simulation, GuardMode, RunOptions};
use simforge_core::hash::{cmp_locale, content_hash, content_hash_of};
use simforge_core::map::{build_route, DirectedLane, LaneGraph, LaneId};
use simforge_core::math::{hypot, local_from_scene, to_scene_xz, SceneXZ, Vec2};
use simforge_core::rng::Rng;
use simforge_core::types::{
    ActorBehavior, ActorInitial, ActorKind, ActorRules, Interaction, LaneRef, Pose, RouteSpec,
    SimActor, SimScenarioInput, Trigger, TurnRelation,
};

use crate::error::{CompileError, CompileResult};

/* ---------------------------------------------------------------- profile */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AmbientPreset {
    #[default]
    Off,
    Light,
    Moderate,
    City,
    Heavy,
    Custom,
}

impl AmbientPreset {
    fn density_per_km(self) -> f64 {
        match self {
            Self::Off => 0.0,
            Self::Light => 3.0,
            Self::Moderate | Self::City | Self::Custom => 8.0,
            Self::Heavy => 16.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientFlows {
    pub through: f64,
    pub left: f64,
    pub right: f64,
    pub u_turn: f64,
}

impl Default for AmbientFlows {
    fn default() -> Self {
        Self {
            through: 0.7,
            left: 0.12,
            right: 0.16,
            u_turn: 0.02,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AmbientVehicleMix {
    pub car: f64,
    pub van: f64,
    pub truck: f64,
    pub bus: f64,
    pub motorcycle: f64,
}

impl Default for AmbientVehicleMix {
    fn default() -> Self {
        Self {
            car: 0.72,
            van: 0.1,
            truck: 0.08,
            bus: 0.04,
            motorcycle: 0.06,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AmbientSeed {
    Text(String),
    Number(i64),
}

impl Default for AmbientSeed {
    fn default() -> Self {
        Self::Text("ambient".to_owned())
    }
}

/// Versioned authored configuration for generated background road users.
/// Optional fields are the ones a preset may fill in.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AmbientTrafficProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(default)]
    pub preset: AmbientPreset,
    /// Target moving road users per kilometre of eligible lane near the scenario.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density_vehicles_per_km: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flows: Option<AmbientFlows>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vehicle_mix: Option<AmbientVehicleMix>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pedestrian_share: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cyclist_share: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggressiveness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_variance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<AmbientSeed>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_actors: Option<u32>,
    /// Candidate selection is local to authored choreography, not the whole city.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius_m: Option<f64>,
    /// Empty road around authored starts and explicit reservations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclusion_radius_m: Option<f64>,
}

/// Defaults resolved once so hashes and worker messages have one shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAmbientTrafficProfile {
    pub version: u32,
    pub preset: AmbientPreset,
    pub density_vehicles_per_km: f64,
    pub flows: AmbientFlows,
    pub vehicle_mix: AmbientVehicleMix,
    pub pedestrian_share: f64,
    pub cyclist_share: f64,
    pub aggressiveness: f64,
    pub speed_variance: f64,
    pub seed: AmbientSeed,
    pub max_actors: u32,
    pub radius_m: f64,
    pub exclusion_radius_m: f64,
}

pub const AMBIENT_TRAFFIC_EXTENSION_KEY: &str = "studio.ambientTraffic.profile.v1";

fn check_range(name: &str, value: f64, lo: f64, hi: f64) -> CompileResult<f64> {
    if !value.is_finite() || value < lo || value > hi {
        return Err(CompileError::at(
            "ambient_profile_invalid",
            format!("ambient.{name}"),
            format!("{name} must be within [{lo}, {hi}], got {value}"),
        ));
    }
    Ok(value)
}

/// Resolve defaults. The City preset is deliberately car-heavy while still
/// making sidewalks feel inhabited; its defaults apply only to fields the
/// author left unset, so a stored City profile remains a stable setting.
pub fn resolve_ambient_traffic_profile(
    profile: &AmbientTrafficProfile,
) -> CompileResult<ResolvedAmbientTrafficProfile> {
    if let Some(v) = profile.version {
        if v != 1 {
            return Err(CompileError::at(
                "ambient_profile_invalid",
                "ambient.version",
                format!("unsupported ambient profile version {v}"),
            ));
        }
    }
    let city = profile.preset == AmbientPreset::City;
    let pedestrian_share = check_range(
        "pedestrianShare",
        profile
            .pedestrian_share
            .unwrap_or(if city { 0.06 } else { 0.0 }),
        0.0,
        1.0,
    )?;
    let cyclist_share = check_range(
        "cyclistShare",
        profile
            .cyclist_share
            .unwrap_or(if city { 0.02 } else { 0.04 }),
        0.0,
        1.0,
    )?;
    if pedestrian_share + cyclist_share > 1.0 {
        return Err(CompileError::at(
            "ambient_profile_invalid",
            "ambient.cyclistShare",
            "pedestrianShare + cyclistShare must not exceed 1",
        ));
    }
    let flows = profile.flows.unwrap_or_default();
    for (name, value) in [
        ("through", flows.through),
        ("left", flows.left),
        ("right", flows.right),
        ("uTurn", flows.u_turn),
    ] {
        check_range(&format!("flows.{name}"), value, 0.0, f64::INFINITY)?;
    }
    let mix = profile.vehicle_mix.unwrap_or_default();
    for (name, value) in [
        ("car", mix.car),
        ("van", mix.van),
        ("truck", mix.truck),
        ("bus", mix.bus),
        ("motorcycle", mix.motorcycle),
    ] {
        check_range(&format!("vehicleMix.{name}"), value, 0.0, f64::INFINITY)?;
    }
    let max_actors = profile.max_actors.unwrap_or(if city { 32 } else { 40 });
    if max_actors > 128 {
        return Err(CompileError::at(
            "ambient_profile_invalid",
            "ambient.maxActors",
            "maxActors must not exceed 128",
        ));
    }
    Ok(ResolvedAmbientTrafficProfile {
        version: 1,
        preset: profile.preset,
        density_vehicles_per_km: match profile.density_vehicles_per_km {
            Some(v) => check_range("densityVehiclesPerKm", v, 0.0, 80.0)?,
            None => profile.preset.density_per_km(),
        },
        flows,
        vehicle_mix: mix,
        pedestrian_share,
        cyclist_share,
        aggressiveness: check_range(
            "aggressiveness",
            profile
                .aggressiveness
                .unwrap_or(if city { 0.25 } else { 0.35 }),
            0.0,
            1.0,
        )?,
        speed_variance: check_range(
            "speedVariance",
            profile
                .speed_variance
                .unwrap_or(if city { 0.1 } else { 0.12 }),
            0.0,
            0.8,
        )?,
        seed: profile.seed.clone().unwrap_or_default(),
        max_actors,
        radius_m: check_range(
            "radiusM",
            profile.radius_m.unwrap_or(if city { 275.0 } else { 250.0 }),
            25.0,
            2000.0,
        )?,
        exclusion_radius_m: check_range(
            "exclusionRadiusM",
            profile
                .exclusion_radius_m
                .unwrap_or(if city { 16.0 } else { 12.0 }),
            2.0,
            100.0,
        )?,
    })
}

pub fn default_ambient_traffic_profile() -> ResolvedAmbientTrafficProfile {
    resolve_ambient_traffic_profile(&AmbientTrafficProfile {
        version: Some(1),
        preset: AmbientPreset::City,
        seed: Some(AmbientSeed::Text("ambient-1".to_owned())),
        ..Default::default()
    })
    .expect("the default city profile is valid")
}

/* -------------------------------------------------------------- candidates */

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AmbientReservation {
    pub x: f64,
    pub z: f64,
    pub radius_m: f64,
}

#[derive(Debug, Clone, Default)]
pub struct AmbientTrafficOptions {
    pub reservations: Vec<AmbientReservation>,
    /// Extra lanes generated traffic may neither spawn on nor route through.
    pub excluded_lane_rsls: Vec<String>,
    /// Opt out of the automatic authored-corridor exclusion (robustness
    /// evaluators only, which deliberately drive traffic at authored actors).
    pub allow_authored_corridor: bool,
    /// Extra seconds of downstream runway every candidate must own.
    pub extra_travel_seconds: f64,
    /// Multiply the placement target to build an oversized settle cohort.
    pub target_multiplier: f64,
    /// Extra selection radius for the settle cohort: a LARGER neighbourhood
    /// at the SAME density, never the same neighbourhood at four times it.
    pub cohort_radius_bonus_m: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientActorProvenance {
    pub id: String,
    pub kind: ActorKind,
    pub route_lane_rsls: Vec<String>,
    pub seed_key: String,
    pub origin: &'static str,
    pub timeline_visible: bool,
    pub editable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientScreening {
    pub evaluated: bool,
    pub passes: u32,
    pub max_achievable_decel_mps2: Option<f64>,
    pub count: u32,
    pub actor_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientTrafficProvenance {
    pub version: u32,
    pub profile: ResolvedAmbientTrafficProfile,
    pub profile_hash: String,
    /// Stable population identity. Authored choreography is deliberately absent.
    pub candidate_pool_key: String,
    pub map_graph_digest: String,
    pub base_input_hash: String,
    pub generated_input_hash: String,
    pub actors: Vec<AmbientActorProvenance>,
    pub rejected_spawn_count: u32,
    pub authored_corridor_rejects: u32,
    pub authored_corridor_lane_rsls: Vec<String>,
    pub eligible_lane_km: f64,
    /// Actors an un-settled run would have placed: the profile's density over
    /// its own radius under its own cap; the settle's post-selection budget.
    pub placement_target: u32,
    pub screening: AmbientScreening,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AmbientCandidate {
    pub id: String,
    pub actor: SimActor,
    pub lane_rsl: String,
    pub route_lane_rsls: Vec<String>,
    pub seed_key: String,
    pub footprint_radius_m: f64,
}

#[derive(Debug, Clone)]
pub struct AmbientCandidatePool {
    pub key: String,
    pub map_graph_digest: String,
    pub profile: ResolvedAmbientTrafficProfile,
    pub profile_hash: String,
    pub candidates: Vec<AmbientCandidate>,
}

pub struct AmbientTrafficResult {
    pub input: SimScenarioInput,
    pub provenance: AmbientTrafficProvenance,
}

fn ambient_catalog_id(kind: ActorKind) -> &'static str {
    match kind {
        ActorKind::Vehicle | ActorKind::Car => "vehicle.sedan",
        ActorKind::Truck => "vehicle.box_truck",
        ActorKind::Bus => "vehicle.bus",
        ActorKind::Van => "vehicle.van",
        ActorKind::Motorcycle => "vehicle.motorcycle",
        ActorKind::Bicycle | ActorKind::Scooter => "vehicle.bicycle",
        ActorKind::SidewalkRobot => "sidewalk_robot.delivery_rover",
        ActorKind::Drone => "drone.camera_quadcopter",
        ActorKind::Pedestrian => "pedestrian.adult",
        ActorKind::Animal => "animal.dog",
        ActorKind::StaticObject => "hazard.cardboard_box",
    }
}

/// The reference orders eligible lanes with `String.prototype.localeCompare`
/// (ICU root collation), and the candidate pool indexes that list with a raw
/// draw (`lanes[floor(u · n)]`), so the order is population identity: every
/// candidate id, kind and route on every map depends on it. ICU puts `:`
/// before the digits where UTF-16 puts it after, so `"4:0:1"` precedes
/// `"41:0:1"` here and follows it in code-unit order.
fn eligible_directed_lanes(
    graph: &LaneGraph,
    lane_types: &[&str],
    focus: &[SceneXZ],
    radius_m: f64,
) -> Vec<DirectedLane> {
    let mut out = Vec::new();
    for lane in graph.lane_ids() {
        let spec = graph.lane(lane);
        if spec.is_junction || !lane_types.contains(&spec.lane_type.as_str()) {
            continue;
        }
        let Some(reversed) = graph.nominal_reversed(lane) else {
            continue;
        };
        if !focus.is_empty()
            && !focus
                .iter()
                .any(|p| graph.project_onto(lane, local_from_scene(*p)).d <= radius_m)
        {
            continue;
        }
        out.push(DirectedLane::new(lane, reversed));
    }
    // `lane_ids` is code-unit sorted; the pool draw needs the reference's
    // locale order, which also fixes the summation order of `eligible_lane_km`.
    out.sort_by(|a, b| cmp_locale(graph.rsl(a.lane), graph.rsl(b.lane)));
    out
}

fn weighted_successor(
    graph: &LaneGraph,
    candidates: &[DirectedLane],
    profile: &ResolvedAmbientTrafficProfile,
    rng: &mut Rng,
) -> DirectedLane {
    let weight = |c: &DirectedLane| match graph.turn_relation_of(c.lane) {
        Some(TurnRelation::Left) => profile.flows.left,
        Some(TurnRelation::Right) => profile.flows.right,
        Some(TurnRelation::UTurnLeft | TurnRelation::UTurnRight) => profile.flows.u_turn,
        _ => profile.flows.through,
    };
    let total: f64 = candidates.iter().map(weight).sum();
    if total <= 0.0 {
        return candidates[0];
    }
    let mut draw = rng.range(0.0, total);
    for c in candidates {
        draw -= weight(c);
        if draw <= 0.0 {
            return *c;
        }
    }
    candidates[candidates.len() - 1]
}

fn walk_route(
    graph: &Arc<LaneGraph>,
    start: DirectedLane,
    profile: &ResolvedAmbientTrafficProfile,
    rng: &mut Rng,
    start_route_s: f64,
    required_downstream_m: f64,
) -> Vec<LaneId> {
    let mut lanes = vec![start.lane];
    let mut current = start;
    let mut length_m = (graph.length_of(start.lane) - start_route_s).max(0.0);
    let need_m = required_downstream_m.max(80.0);
    let mut visited: BTreeSet<usize> = BTreeSet::new();
    visited.insert(start.slot());
    let mut successors: Vec<DirectedLane> = Vec::new();
    while length_m < need_m && lanes.len() < 32 {
        successors.clear();
        successors.extend(
            graph
                .successors(current)
                .iter()
                .copied()
                .filter(|c| !visited.contains(&c.slot())),
        );
        if successors.is_empty() {
            break;
        }
        let next = weighted_successor(graph, &successors, profile, rng);
        current = next;
        visited.insert(next.slot());
        lanes.push(next.lane);
        length_m += graph.length_of(next.lane);
    }
    if simforge_core::map::build_lane_path_route(graph, &lanes).is_ok() {
        lanes
    } else {
        Vec::new()
    }
}

fn choose_vehicle_kind(profile: &ResolvedAmbientTrafficProfile, rng: &mut Rng) -> ActorKind {
    let mix = &profile.vehicle_mix;
    let entries = [
        (ActorKind::Car, mix.car),
        (ActorKind::Van, mix.van),
        (ActorKind::Truck, mix.truck),
        (ActorKind::Bus, mix.bus),
        (ActorKind::Motorcycle, mix.motorcycle),
    ];
    let total: f64 = entries.iter().map(|(_, w)| w).sum();
    if total <= 0.0 {
        return ActorKind::Car;
    }
    let mut draw = rng.range(0.0, total);
    for (kind, weight) in entries {
        draw -= weight;
        if draw <= 0.0 {
            return kind;
        }
    }
    ActorKind::Car
}

fn choose_road_user_kind(profile: &ResolvedAmbientTrafficProfile, rng: &mut Rng) -> ActorKind {
    let share = rng.next_f64();
    if share < profile.pedestrian_share {
        ActorKind::Pedestrian
    } else if share < profile.pedestrian_share + profile.cyclist_share {
        ActorKind::Bicycle
    } else {
        choose_vehicle_kind(profile, rng)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PoolKeyInput<'a> {
    version: u32,
    map_graph_digest: &'a str,
    profile: &'a ResolvedAmbientTrafficProfile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedKeyInput<'a> {
    key: &'a str,
    attempt: u32,
    lane: &'a str,
    storage_s: f64,
}

/// Generate map-wide candidates once. The key intentionally excludes authored state.
pub fn create_ambient_candidate_pool(
    graph: &Arc<LaneGraph>,
    profile: &ResolvedAmbientTrafficProfile,
) -> CompileResult<AmbientCandidatePool> {
    let profile_hash = content_hash_of(profile)?;
    let key = content_hash_of(&PoolKeyInput {
        version: 1,
        map_graph_digest: graph.topology_digest(),
        profile,
    })?;
    let mut pool = AmbientCandidatePool {
        key: key.clone(),
        map_graph_digest: graph.topology_digest().to_owned(),
        profile: profile.clone(),
        profile_hash: profile_hash.clone(),
        candidates: Vec::new(),
    };
    if profile.preset == AmbientPreset::Off
        || profile.density_vehicles_per_km == 0.0
        || profile.max_actors == 0
    {
        return Ok(pool);
    }
    let road_lanes = eligible_directed_lanes(graph, &["driving"], &[], f64::INFINITY);
    let walking_lanes =
        eligible_directed_lanes(graph, &["sidewalk", "walking"], &[], f64::INFINITY);
    let total_lane_km: f64 = road_lanes
        .iter()
        .map(|l| graph.length_of(l.lane))
        .sum::<f64>()
        / 1000.0;
    // Oversample: selection is local to a site while the pool is map-wide, so
    // the budget must cover the rejection rate at the densest point.
    let candidate_budget = ((profile.max_actors as f64 * 16.0)
        .max((total_lane_km * profile.density_vehicles_per_km * 8.0).ceil())
        as usize)
        .min(4096);
    let rng = Rng::from_label(&format!("{key}|ambient-candidate-pool-v1"));
    let attempt_limit = (candidate_budget * 4).max(80);
    let profile_tag = &profile_hash[..16];
    for attempt in 0..attempt_limit {
        if pool.candidates.len() >= candidate_budget {
            break;
        }
        let mut actor_rng = rng.fork(&format!("candidate:{attempt}"));
        let requested_kind = choose_road_user_kind(profile, &mut actor_rng);
        let lanes = if requested_kind == ActorKind::Pedestrian {
            &walking_lanes
        } else {
            &road_lanes
        };
        if lanes.is_empty() {
            continue;
        }
        let lane = lanes[(actor_rng.next_f64() * lanes.len() as f64).floor() as usize];
        let geom = graph.geometry(lane.lane);
        let length_m = geom.length_m();
        // Degenerate stubs cannot hold a road user; with `length >= 1` the
        // margin is at most `0.2·L` so both branches below stay in the lane.
        if length_m < 1.0 {
            continue;
        }
        let margin = (length_m * 0.2).min(8.0);
        let route_s = actor_rng.range(margin, length_m - margin);
        let sample = graph.sample_directed(lane, route_s);
        let scene = to_scene_xz(sample.point);
        let lane_speed = match requested_kind {
            ActorKind::Pedestrian => 1.35,
            ActorKind::Bicycle => 5.5,
            _ => geom.speed_limit_mps,
        };
        let factor =
            (1.0 + actor_rng.range(-profile.speed_variance, profile.speed_variance)).max(0.35);
        let cruise = lane_speed * factor;
        let route = walk_route(graph, lane, profile, &mut actor_rng, route_s, 5_000.0);
        if route.is_empty() {
            continue;
        }
        let storage_s = (if lane.reversed {
            length_m - route_s
        } else {
            route_s
        })
        .clamp(0.0, length_m);
        let rsl = graph.rsl(lane.lane);
        let seed_key = content_hash_of(&SeedKeyInput {
            key: &key,
            attempt: attempt as u32,
            lane: rsl,
            storage_s,
        })?[..16]
            .to_owned();
        let id = format!("ambient:v1:{seed_key}");
        let route_lane_rsls: Vec<String> = route.iter().map(|l| graph.rsl(*l).to_owned()).collect();
        let actor = SimActor {
            id: id.clone(),
            kind: requested_kind,
            dims: requested_kind.default_dims(),
            initial: ActorInitial {
                lane_ref: Some(LaneRef {
                    rsl: rsl.to_owned(),
                    s: storage_s,
                    t_frac: 0.0,
                }),
                pose: Pose {
                    x: scene.x,
                    z: scene.z,
                    heading_rad: sample.heading_rad,
                },
                speed_mps: cruise,
            },
            behavior: ActorBehavior {
                rules: ActorRules {
                    aggression: profile.aggressiveness,
                    speed_factor: factor,
                    ..ActorRules::default()
                },
                route: RouteSpec::LanePath {
                    lanes: route_lane_rsls.clone(),
                },
                driving_profile: None,
                cruise_speed_mps: Some(cruise),
            },
            present_at_start: true,
            is_static: false,
            tags: vec![
                "ambient".to_owned(),
                "ambient:v1".to_owned(),
                format!("catalog:{}", ambient_catalog_id(requested_kind)),
                format!("ambient-profile:{profile_tag}"),
                format!("ambient-seed:{seed_key}"),
            ],
            sensors: None,
        };
        pool.candidates.push(AmbientCandidate {
            id,
            actor,
            lane_rsl: rsl.to_owned(),
            route_lane_rsls,
            seed_key,
            footprint_radius_m: match requested_kind {
                ActorKind::Bus | ActorKind::Truck => 7.0,
                ActorKind::Pedestrian => 1.2,
                _ => 3.5,
            },
        });
    }
    Ok(pool)
}

struct Occupied {
    x: f64,
    z: f64,
    radius_m: f64,
}

fn authored_reservations(base: &SimScenarioInput, exclusion_radius_m: f64) -> Vec<Occupied> {
    let mut out: Vec<Occupied> = base
        .actors
        .iter()
        .map(|a| Occupied {
            x: a.initial.pose.x,
            z: a.initial.pose.z,
            radius_m: exclusion_radius_m + hypot(a.dims.l, a.dims.w) * 0.5,
        })
        .collect();
    out.extend(
        base.props
            .iter()
            .filter(|p| p.collidable && p.attachment.is_none())
            .map(|p| Occupied {
                x: p.pose.x,
                z: p.pose.z,
                radius_m: exclusion_radius_m + hypot(p.dims.l * p.scale, p.dims.w * p.scale) * 0.5,
            }),
    );
    out
}

fn focus_poses(base: &SimScenarioInput) -> Vec<SceneXZ> {
    let moving: Vec<SceneXZ> = base
        .actors
        .iter()
        .filter(|a| !a.is_static)
        .map(|a| SceneXZ {
            x: a.initial.pose.x,
            z: a.initial.pose.z,
        })
        .collect();
    if moving.is_empty() {
        base.actors
            .iter()
            .map(|a| SceneXZ {
                x: a.initial.pose.x,
                z: a.initial.pose.z,
            })
            .collect()
    } else {
        moving
    }
}

/// Select stable candidates around authored geometry and compile them into
/// the concrete input. Never runs the clip.
pub fn materialize_ambient_candidate_pool(
    base: &SimScenarioInput,
    graph: &Arc<LaneGraph>,
    pool: &AmbientCandidatePool,
    options: &AmbientTrafficOptions,
) -> CompileResult<AmbientTrafficResult> {
    if pool.map_graph_digest != graph.topology_digest() {
        return Err(CompileError::new(
            "ambient_pool_mismatch",
            "ambient candidate pool does not match the lane graph",
        ));
    }
    let profile = &pool.profile;
    let base_input_hash = content_hash_of(base)?;
    let all_focus = focus_poses(base);
    let cohort_radius_bonus_m = options.cohort_radius_bonus_m.max(0.0);
    let road_lanes = eligible_directed_lanes(
        graph,
        &["driving"],
        &all_focus,
        profile.radius_m + cohort_radius_bonus_m,
    );
    let mut authored_corridor: BTreeSet<String> =
        options.excluded_lane_rsls.iter().cloned().collect();
    if !options.allow_authored_corridor {
        for actor in &base.actors {
            if let RouteSpec::LanePath { lanes } = &actor.behavior.route {
                authored_corridor.extend(lanes.iter().cloned());
            }
            if let Some(lane_ref) = &actor.initial.lane_ref {
                authored_corridor.insert(lane_ref.rsl.clone());
            }
        }
    }
    let extra_travel_seconds = options.extra_travel_seconds.max(0.0);
    let eligible: BTreeSet<&str> = road_lanes
        .iter()
        .map(|l| graph.rsl(l.lane))
        .filter(|rsl| !authored_corridor.contains(*rsl))
        .collect();
    let lane_km = |lanes: &[DirectedLane]| {
        lanes
            .iter()
            .filter(|l| eligible.contains(graph.rsl(l.lane)))
            .map(|l| graph.length_of(l.lane))
            .sum::<f64>()
            / 1000.0
    };
    let eligible_lane_km = lane_km(&road_lanes);
    let base_eligible_lane_km = if cohort_radius_bonus_m == 0.0 {
        eligible_lane_km
    } else {
        lane_km(&eligible_directed_lanes(
            graph,
            &["driving"],
            &all_focus,
            profile.radius_m,
        ))
    };
    let cap = |km: f64| {
        (profile.max_actors as f64).min((km * profile.density_vehicles_per_km).round()) as u32
    };
    let placement_target = cap(base_eligible_lane_km);
    let target_multiplier = options.target_multiplier.round().max(1.0) as u32;
    let target = target_multiplier * cap(eligible_lane_km);

    let mut occupied = authored_reservations(base, profile.exclusion_radius_m);
    occupied.extend(options.reservations.iter().map(|r| Occupied {
        x: r.x,
        z: r.z,
        radius_m: r.radius_m,
    }));

    // Spend the actor budget where it is visible: rank by distance to the
    // authored choreography, tie-broken on the stable candidate id.
    let mut ranked: Vec<(f64, &AmbientCandidate)> = pool
        .candidates
        .iter()
        .filter(|c| eligible.contains(c.lane_rsl.as_str()))
        .map(|c| {
            let nearest = all_focus
                .iter()
                .map(|p| hypot(c.actor.initial.pose.x - p.x, c.actor.initial.pose.z - p.z))
                .fold(f64::INFINITY, f64::min);
            (nearest, c)
        })
        .collect();
    ranked.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));

    let travel_seconds = base.warmup_seconds + base.clip_seconds + extra_travel_seconds;
    let mut selected: Vec<&AmbientCandidate> = Vec::new();
    let mut rejected_spawn_count = 0u32;
    let mut authored_corridor_rejects = 0u32;
    for (_, candidate) in ranked {
        if selected.len() as u32 >= target {
            break;
        }
        let cruise = candidate
            .actor
            .behavior
            .cruise_speed_mps
            .unwrap_or(candidate.actor.initial.speed_mps);
        // A route that re-enters the authored corridor DURING THE CLIP is
        // rejected too; only ground contested inside the travel budget can
        // affect the evidence, so only that much of the route is protected.
        let travel_budget_m = cruise * travel_seconds * 1.1;
        let mut travelled = 0.0;
        let mut enters_corridor = false;
        for rsl in &candidate.route_lane_rsls {
            if authored_corridor.contains(rsl) {
                enters_corridor = true;
                break;
            }
            travelled += graph.lane_id(rsl).map_or(0.0, |l| graph.length_of(l));
            if travelled >= travel_budget_m {
                break;
            }
        }
        if enters_corridor {
            authored_corridor_rejects += 1;
            rejected_spawn_count += 1;
            continue;
        }
        let (x, z) = (
            candidate.actor.initial.pose.x,
            candidate.actor.initial.pose.z,
        );
        if occupied
            .iter()
            .any(|o| hypot(x - o.x, z - o.z) < o.radius_m + candidate.footprint_radius_m)
        {
            rejected_spawn_count += 1;
            continue;
        }
        let start_on_route = build_route(graph, &candidate.actor.behavior.route)
            .ok()
            .and_then(|route| {
                let lane_ref = candidate.actor.initial.lane_ref.as_ref()?;
                let lane = graph.lane_id(&lane_ref.rsl)?;
                route
                    .s_of_lane_storage(lane, lane_ref.s)
                    .map(|s| route.length_m() - s)
            });
        match start_on_route {
            Some(remaining) if remaining >= travel_budget_m => {}
            _ => {
                rejected_spawn_count += 1;
                continue;
            }
        }
        occupied.push(Occupied {
            x,
            z,
            radius_m: candidate.footprint_radius_m + 4.0,
        });
        selected.push(candidate);
    }

    let mut input = base.clone();
    input
        .actors
        .extend(selected.iter().map(|c| c.actor.clone()));
    let input = input.normalized();
    let mut warnings = Vec::new();
    if target == 0 && profile.preset != AmbientPreset::Off {
        warnings.push(
            "No eligible drivable lane length was available near the authored scenario.".to_owned(),
        );
    }
    if (selected.len() as u32) < target {
        warnings.push(format!("Placed {}/{target} ambient actors; reservations and route feasibility rejected the remainder.", selected.len()));
    }
    if authored_corridor_rejects > 0 {
        warnings.push(format!("{authored_corridor_rejects} candidate(s) rejected for entering the authored corridor ({} lane(s)).", authored_corridor.len()));
    }
    let generated_input_hash = content_hash_of(&input)?;
    Ok(AmbientTrafficResult {
        input,
        provenance: AmbientTrafficProvenance {
            version: 1,
            profile: profile.clone(),
            profile_hash: pool.profile_hash.clone(),
            candidate_pool_key: pool.key.clone(),
            map_graph_digest: pool.map_graph_digest.clone(),
            base_input_hash,
            generated_input_hash,
            actors: selected
                .iter()
                .map(|c| AmbientActorProvenance {
                    id: c.id.clone(),
                    kind: c.actor.kind,
                    route_lane_rsls: c.route_lane_rsls.clone(),
                    seed_key: c.seed_key.clone(),
                    origin: "ambient",
                    timeline_visible: false,
                    editable: false,
                })
                .collect(),
            rejected_spawn_count,
            authored_corridor_rejects,
            authored_corridor_lane_rsls: authored_corridor.into_iter().collect(),
            eligible_lane_km,
            placement_target,
            screening: AmbientScreening {
                evaluated: false,
                passes: 0,
                max_achievable_decel_mps2: None,
                count: 0,
                actor_ids: Vec::new(),
            },
            warnings,
        },
    })
}

/// Pool construction plus selection; never runs the clip.
pub fn apply_ambient_traffic(
    base: &SimScenarioInput,
    graph: &Arc<LaneGraph>,
    profile: &ResolvedAmbientTrafficProfile,
    options: &AmbientTrafficOptions,
) -> CompileResult<AmbientTrafficResult> {
    let pool = create_ambient_candidate_pool(graph, profile)?;
    materialize_ambient_candidate_pool(base, graph, &pool, options)
}

/// Remove ambient provenance so an editor can adopt the actor as authored.
pub fn promote_ambient_actor(mut actor: SimActor, authored_id: &str) -> CompileResult<SimActor> {
    if !actor.has_tag("ambient") {
        return Err(CompileError::new(
            "ambient_actor_required",
            format!("{} is not an ambient actor", actor.id),
        ));
    }
    actor.id = authored_id.to_owned();
    actor
        .tags
        .retain(|t| t != "ambient" && !t.starts_with("ambient:") && !t.starts_with("ambient-"));
    Ok(actor)
}

/* ----------------------------------------------------------------- settle */

/// Ambient warm-up options. `keep` is the post-settle selection budget: the
/// population that matters is the one on the road at `t = 0`, not the one
/// spawned `settle_seconds` earlier, so the caller hands in an oversized
/// cohort and this pass re-applies ranking and budget to the settled
/// positions. `exclusion_radius_m` re-establishes authored clearance at the
/// instant the recording actually begins.
#[derive(Debug, Clone, Default)]
pub struct AmbientSettleOptions {
    pub settle_seconds: f64,
    /// Explicit population; defaults to every actor tagged `ambient`.
    pub ambient_actor_ids: Option<Vec<String>>,
    /// Integration step; defaults to the scenario `dt`.
    pub dt: Option<f64>,
    pub keep: Option<u32>,
    pub exclusion_radius_m: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleSpeedSummary {
    pub min: f64,
    pub median: f64,
    pub max: f64,
    pub below_half_mps: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientSettleProvenance {
    pub version: u32,
    pub settle_seconds: f64,
    pub dt: f64,
    pub settled_actor_ids: Vec<String>,
    pub cohort_size: u32,
    pub keep: Option<u32>,
    pub dropped_actor_ids: Vec<String>,
    pub authored_clearance_rejects: u32,
    pub budget_rejects: u32,
    pub unresolved_actor_ids: Vec<String>,
    pub signal_programs_shifted: u32,
    pub final_speed_mps: Option<SettleSpeedSummary>,
    pub input_hash_before: String,
    pub input_hash_after: String,
    pub warnings: Vec<String>,
}

pub struct AmbientSettleResult {
    pub input: SimScenarioInput,
    pub provenance: Option<AmbientSettleProvenance>,
}

/// Re-express a settled position as a lane reference. `Route::s_of_lane_storage`
/// maps lane storage to route arc length affinely inside a leg, so the inverse
/// is one linear solve; `t_frac` comes from the settled lateral offset.
fn settled_lane_ref(
    graph: &Arc<LaneGraph>,
    actor: &SimActor,
    lane_rsl: Option<&str>,
    route_s: f64,
    lateral_offset_m: f64,
) -> Option<LaneRef> {
    let lane_rsl = lane_rsl?;
    let lane = graph.lane_id(lane_rsl)?;
    let route = build_route(graph, &actor.behavior.route).ok()?;
    let lane_length_m = graph.length_of(lane);
    if lane_length_m <= 0.0 {
        return None;
    }
    let s_at_zero = route.s_of_lane_storage(lane, 0.0)?;
    let s_at_end = route.s_of_lane_storage(lane, lane_length_m)?;
    if s_at_end == s_at_zero {
        return None;
    }
    let storage_s = ((route_s - s_at_zero) / (s_at_end - s_at_zero)) * lane_length_m;
    if !storage_s.is_finite() {
        return None;
    }
    let width_m = route.width_at(route_s);
    let t_frac = if width_m > 0.0 {
        lateral_offset_m / width_m
    } else {
        0.0
    };
    Some(LaneRef {
        rsl: lane_rsl.to_owned(),
        s: storage_s.clamp(0.0, lane_length_m),
        t_frac: t_frac.clamp(-1.0, 1.0),
    })
}

/// Advance ONLY the generated population by `settle_seconds` and fold the
/// result back into their initial state. Authored actors never enter the
/// settle simulation, so their bytes cannot change; with nothing to settle
/// the input is returned unchanged.
///
/// `SignalBook` reads `elapsed = t + warmup + offset`. The real run's prologue
/// starts at `elapsed = offset`; a settle run with `warmup = 0` ends at
/// `elapsed = settle + offset'`, so `offset' = offset - settle` hands the
/// real run exactly the phase the settle finished on.
pub fn settle_ambient_traffic(
    base: &SimScenarioInput,
    graph: &Arc<LaneGraph>,
    options: &AmbientSettleOptions,
) -> CompileResult<AmbientSettleResult> {
    let settle_seconds = options.settle_seconds;
    let explicit: Option<BTreeSet<&str>> = options
        .ambient_actor_ids
        .as_ref()
        .map(|ids| ids.iter().map(String::as_str).collect());
    let population: Vec<&SimActor> = base
        .actors
        .iter()
        .filter(|a| match &explicit {
            Some(ids) => ids.contains(a.id.as_str()),
            None => a.has_tag("ambient"),
        })
        .collect();
    if !(settle_seconds > 0.0) || population.is_empty() {
        return Ok(AmbientSettleResult {
            input: base.clone(),
            provenance: None,
        });
    }

    let dt = options.dt.unwrap_or(base.dt);
    let mut settle_input = base.clone();
    settle_input.clip_seconds = settle_seconds;
    settle_input.warmup_seconds = 0.0;
    settle_input.dt = dt;
    settle_input.actors = population.iter().map(|a| (*a).clone()).collect();
    // Authored choreography cannot be carried: every interaction, near-miss
    // criterion and the metric subject name an authored actor.
    settle_input.interactions.clear();
    settle_input.near_miss_criteria = None;
    settle_input.metric_subject = Some(population[0].id.clone());
    for program in &mut settle_input.signal_programs {
        program.offset_s -= settle_seconds;
    }
    let settle_input = settle_input.normalized();

    let mut run_options = RunOptions::new(Arc::clone(graph));
    run_options.guards = GuardMode::Skip;
    run_options.resolve_arrival = false;
    let result = run_simulation(settle_input, run_options)
        .map_err(|e| CompileError::new("ambient_settle_failed", e.to_string()))?;
    let ticks = &result.trace.ticks;
    let Some(last) = ticks.t.len().checked_sub(1) else {
        return Ok(AmbientSettleResult {
            input: base.clone(),
            provenance: None,
        });
    };

    let population_ids: BTreeSet<&str> = population.iter().map(|a| a.id.as_str()).collect();
    let authored: Vec<&SimActor> = base
        .actors
        .iter()
        .filter(|a| !population_ids.contains(a.id.as_str()))
        .collect();
    let authored_moving: Vec<&SimActor> =
        authored.iter().copied().filter(|a| !a.is_static).collect();
    let focus: Vec<(f64, f64)> = (if authored_moving.is_empty() {
        &authored
    } else {
        &authored_moving
    })
    .iter()
    .map(|a| (a.initial.pose.x, a.initial.pose.z))
    .collect();

    let mut dropped = Vec::new();
    let mut unresolved = Vec::new();
    struct Survivor {
        actor: SimActor,
        nearest_authored_m: f64,
        speed_mps: f64,
    }
    let mut survivors: Vec<Survivor> = Vec::new();
    for actor in &population {
        let Some(track) = ticks.actors.get(&actor.id) else {
            unresolved.push(actor.id.clone());
            continue;
        };
        if track.present.get(last).copied() != Some(1) {
            dropped.push(actor.id.clone());
            continue;
        }
        let (Some(&x), Some(&y), Some(&heading_rad), Some(&speed_mps)) = (
            track.x.get(last),
            track.y.get(last),
            track.heading_rad.get(last),
            track.speed_mps.get(last),
        ) else {
            unresolved.push(actor.id.clone());
            continue;
        };
        let pose = to_scene_xz(Vec2 { x, y });
        let speed_mps = speed_mps.max(0.0);
        let lane_rsl = track.lane_rsl.get(last).and_then(|l| l.as_deref());
        let route_s = track.s.get(last).copied().unwrap_or(0.0);
        let lateral = track.lateral_offset_m.get(last).copied().unwrap_or(0.0);
        let mut settled = (*actor).clone();
        settled.initial = ActorInitial {
            lane_ref: settled_lane_ref(graph, actor, lane_rsl, route_s, lateral),
            pose: Pose {
                x: pose.x,
                z: pose.z,
                heading_rad,
            },
            speed_mps,
        };
        let nearest = focus
            .iter()
            .map(|(fx, fz)| hypot(pose.x - fx, pose.z - fz))
            .fold(f64::INFINITY, f64::min);
        survivors.push(Survivor {
            actor: settled,
            nearest_authored_m: nearest,
            speed_mps,
        });
    }
    survivors.sort_by(|a, b| {
        a.nearest_authored_m
            .total_cmp(&b.nearest_authored_m)
            .then_with(|| a.actor.id.cmp(&b.actor.id))
    });

    let exclusion_radius_m = options.exclusion_radius_m.max(0.0);
    let occupied: Vec<Occupied> = if exclusion_radius_m == 0.0 {
        Vec::new()
    } else {
        let mut base_authored = base.clone();
        base_authored.actors = authored.iter().map(|a| (*a).clone()).collect();
        authored_reservations(&base_authored, exclusion_radius_m)
    };
    let keep = options.keep;
    let mut selected: Vec<SimActor> = Vec::new();
    let mut final_speeds: Vec<f64> = Vec::new();
    let mut authored_clearance_rejects = 0u32;
    let mut budget_rejects = 0u32;
    for survivor in survivors {
        if keep.is_some_and(|k| selected.len() as u32 >= k) {
            budget_rejects += 1;
            continue;
        }
        let (x, z) = (survivor.actor.initial.pose.x, survivor.actor.initial.pose.z);
        let footprint = hypot(survivor.actor.dims.l, survivor.actor.dims.w) * 0.5;
        if occupied
            .iter()
            .any(|o| hypot(x - o.x, z - o.z) < o.radius_m + footprint)
        {
            authored_clearance_rejects += 1;
            continue;
        }
        // Bodies that ended the settle interpenetrating are separated the way
        // spawn selection separates them: the nearer-to-authored one wins.
        if selected.iter().any(|o| {
            hypot(x - o.initial.pose.x, z - o.initial.pose.z)
                < footprint + hypot(o.dims.l, o.dims.w) * 0.5
        }) {
            authored_clearance_rejects += 1;
            continue;
        }
        final_speeds.push(survivor.speed_mps);
        selected.push(survivor.actor);
    }

    let mut warnings = Vec::new();
    if selected.is_empty() {
        return Ok(AmbientSettleResult {
            input: base.clone(),
            provenance: None,
        });
    }
    // Authored actors keep their position AND their order; the settled
    // population is appended in selection order.
    let settled_by_id: BTreeMap<String, SimActor> =
        selected.into_iter().map(|a| (a.id.clone(), a)).collect();
    let mut actors: Vec<SimActor> = authored.iter().map(|a| (*a).clone()).collect();
    actors.extend(
        base.actors
            .iter()
            .filter_map(|a| settled_by_id.get(&a.id).cloned()),
    );
    let mut input = base.clone();
    input.actors = actors;
    let input = input.normalized();

    final_speeds.sort_by(f64::total_cmp);
    let n = final_speeds.len();
    let median = if n % 2 == 1 {
        final_speeds[n / 2]
    } else {
        (final_speeds[n / 2 - 1] + final_speeds[n / 2]) / 2.0
    };
    if !dropped.is_empty() {
        warnings.push(format!("{} ambient actor(s) left the world during the {settle_seconds}s settle and were removed.", dropped.len()));
    }
    if !unresolved.is_empty() {
        warnings.push(format!(
            "{} ambient actor(s) had no readable settle state and kept their spawn state.",
            unresolved.len()
        ));
    }
    dropped.sort();
    unresolved.sort();
    Ok(AmbientSettleResult {
        provenance: Some(AmbientSettleProvenance {
            version: 1,
            settle_seconds,
            dt,
            settled_actor_ids: settled_by_id.keys().cloned().collect(),
            cohort_size: population.len() as u32,
            keep,
            dropped_actor_ids: dropped,
            authored_clearance_rejects,
            budget_rejects,
            unresolved_actor_ids: unresolved,
            signal_programs_shifted: base.signal_programs.len() as u32,
            final_speed_mps: Some(SettleSpeedSummary {
                min: final_speeds[0],
                median,
                max: final_speeds[n - 1],
                below_half_mps: final_speeds.iter().filter(|v| **v < 0.5).count() as u32,
            }),
            input_hash_before: content_hash_of(base)?,
            input_hash_after: content_hash_of(&input)?,
            warnings,
        }),
        input,
    })
}

/* ------------------------------------------------------- interaction repair */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedDanglingInteraction {
    pub interaction_id: String,
    pub missing_interaction_id: String,
}

/// Drop `after(<id>)` commands whose source interaction no longer exists.
/// Only site degradation deliberately removes commands; this makes their
/// dependants consistent, transitively and atomically.
pub fn prune_dangling_after_interactions(
    interactions: Vec<Interaction>,
) -> (Vec<Interaction>, Vec<RemovedDanglingInteraction>) {
    let mut kept = interactions;
    let mut removed = Vec::new();
    loop {
        let ids: BTreeSet<&str> = kept.iter().map(|i| i.id.as_str()).collect();
        let stale: Vec<RemovedDanglingInteraction> = kept
            .iter()
            .filter_map(|i| match &i.trigger {
                Trigger::After { interaction_id, .. } if !ids.contains(interaction_id.as_str()) => {
                    Some(RemovedDanglingInteraction {
                        interaction_id: i.id.clone(),
                        missing_interaction_id: interaction_id.clone(),
                    })
                }
                _ => None,
            })
            .collect();
        if stale.is_empty() {
            break;
        }
        kept.retain(|i| !stale.iter().any(|s| s.interaction_id == i.id));
        removed.extend(stale);
    }
    (kept, removed)
}

/// `content_hash` of the document, as the trace header records it.
pub fn input_hash(input: &SimScenarioInput) -> CompileResult<String> {
    Ok(content_hash(&serde_json::to_value(input)?)?)
}
