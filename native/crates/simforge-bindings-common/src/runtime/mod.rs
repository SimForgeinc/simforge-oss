//! Host-neutral handle layer over the native crates.
//!
//! Each handle owns its upstream object and a small set of reusable scratch
//! buffers. Methods hand back borrowed slices (`&[f64]`, `&[f32]`, `&[u8]`)
//! valid until the next mutating call, or owned `String`s for JSON metadata.
//! Hosts copy borrowed slices into their own typed arrays exactly once; no
//! host ever holds a pointer into live engine state.

mod batch;
mod compile;
mod env;
mod handoff;
mod policy;
mod simulate;
mod trace;
mod world;

use std::sync::Arc;

use simforge_core::engine::controllers::limits_for_kind;
use simforge_core::engine::{RunOptions, StaticMapCollider};
use simforge_core::map::{retarget_to_neighbour, LaneGraph, LaneSide, RetargetOptions};
use simforge_core::math::Vec2;
use simforge_core::types::ActorKind;
use simforge_core::rng::Seed;
use simforge_core::types::SimScenarioInput;
use simforge_session::episode::EpisodeConfig;

use crate::assets;
use crate::error::{BindingError, Result};

pub use batch::Batch;
pub use compile::{
    adapt_template_notes_json, apply_situation_transaction_json, cell_seed, compare_situation_json,
    compile_situation_json, compile_template, find_site, find_sites, match_sites,
    materialize_ambient_traffic, rehearse_situation_json, solve_situation_json,
    template_identity_json, Compiled, MapAsset, PolicyCallback, Site,
};
pub use env::{Env, StepView};
pub use handoff::{Handoff, HANDOFF_ACTOR_ROW, HANDOFF_BODY_ROW};
pub use policy::{Policy, PolicyOutcome};
pub use simulate::{check_feasibility_json, run_simulation_json, Sim, ACTOR_ROW};
pub use trace::{canonical_json, content_hash, sha256_hex, Trace};
pub use world::{replay_world_log_json, TruthSubscriber, World, WorldSnapshotView};

/// Shared immutable lane graph plus the static map colliders that travel with
/// it. Bare topologies carry no colliders; compiled map bundles do.
#[derive(Clone)]
pub struct Graph {
    graph: Arc<LaneGraph>,
    colliders: Arc<[StaticMapCollider]>,
    /// SHA-256 of the topology bytes this graph was decoded from.
    byte_digest: String,
}

impl Graph {
    pub fn from_topology_bytes(bytes: &[u8]) -> Result<Self> {
        let graph = assets::lane_graph_from_topology(bytes)?;
        Ok(Self {
            graph,
            colliders: Arc::from(Vec::new()),
            byte_digest: simforge_core::hash::sha256_bytes(bytes),
        })
    }

    pub(crate) fn new(
        graph: Arc<LaneGraph>,
        colliders: Vec<StaticMapCollider>,
        byte_digest: String,
    ) -> Self {
        Self {
            graph,
            colliders: Arc::from(colliders),
            byte_digest,
        }
    }

    #[inline]
    pub fn lane_graph(&self) -> &Arc<LaneGraph> {
        &self.graph
    }

    /// `source.xodrSha256` of the topology; empty for synthetic topologies.
    pub fn topology_digest(&self) -> &str {
        self.graph.topology_digest()
    }

    pub fn byte_digest(&self) -> &str {
        &self.byte_digest
    }

    pub fn lane_count(&self) -> usize {
        self.graph.lane_count()
    }

    pub fn lane_ids(&self) -> Vec<String> {
        self.graph
            .lane_ids()
            .map(|id| self.graph.rsl(id).to_owned())
            .collect()
    }

    fn lane(&self, rsl: &str) -> Result<simforge_core::map::LaneId> {
        self.graph
            .lane_id(rsl)
            .ok_or_else(|| BindingError::argument(format!("unknown lane {rsl}")))
    }

    pub fn lane_length_m(&self, rsl: &str) -> Result<f64> {
        Ok(self.graph.length_of(self.lane(rsl)?))
    }

    /// Lane width at storage arc length `s`.
    pub fn lane_width_at(&self, rsl: &str, s: f64) -> Result<f64> {
        Ok(self.graph.width_at(self.lane(rsl)?, s))
    }

    /// `[x, y, heading_rad]` at arc length `s` (clamped) measured along the
    /// traversal direction: `reversed = false` follows storage order,
    /// `reversed = true` runs from the last polyline point (storage `len - s`).
    pub fn sample_lane(&self, rsl: &str, s: f64, reversed: bool) -> Result<[f64; 3]> {
        let sample = self.graph.sample_directed(
            simforge_core::map::DirectedLane::new(self.lane(rsl)?, reversed),
            s,
        );
        Ok([sample.point.x, sample.point.y, sample.heading_rad])
    }

    /// `[s, d]` projection of a point onto the lane polyline.
    pub fn project_onto_lane(&self, rsl: &str, x: f64, y: f64) -> Result<[f64; 2]> {
        let p = self
            .graph
            .project_onto(self.lane(rsl)?, simforge_core::math::Vec2 { x, y });
        Ok([p.s, p.d])
    }

    /// Directed successors as `(rsl, reversed)` pairs.
    pub fn successors(&self, rsl: &str, reversed: bool) -> Result<Vec<(String, bool)>> {
        let d = simforge_core::map::DirectedLane::new(self.lane(rsl)?, reversed);
        Ok(self
            .graph
            .successors(d)
            .iter()
            .map(|s| (self.graph.rsl(s.lane).to_owned(), s.reversed))
            .collect())
    }

    /// Whether the lane's nominal travel runs against storage order (`None` in junctions).
    pub fn nominal_reversed(&self, rsl: &str) -> Result<Option<bool>> {
        Ok(self.graph.nominal_reversed(self.lane(rsl)?))
    }

    /// The decoded `TopologyLane` record as JSON.
    pub fn lane_json(&self, rsl: &str) -> Result<String> {
        Ok(serde_json::to_string(self.graph.lane(self.lane(rsl)?))?)
    }

    /// `(rsl, s, d)` of the nearest drivable lane within `max_dist_m`.
    pub fn nearest_lane(&self, x: f64, y: f64, max_dist_m: f64) -> Option<(String, f64, f64)> {
        let q = simforge_core::map::NearestLaneQuery {
            max_dist_m,
            ..simforge_core::map::NearestLaneQuery::default()
        };
        self.graph
            .nearest_lane(simforge_core::math::Vec2 { x, y }, q)
            .map(|n| (self.graph.rsl(n.lane).to_owned(), n.s, n.d))
    }

    /// Connected legal-direction lane chain for a newly placed road actor:
    /// `(lane rsls, downstream_m)`, or `None` when no route provides the runway.
    pub fn default_placement_route(
        &self,
        start_rsl: &str,
        start_storage_s: f64,
        required_downstream_m: f64,
    ) -> Result<Option<(Vec<String>, f64)>> {
        let start = self.lane(start_rsl)?;
        let options = simforge_core::map::PlacementRouteOptions {
            start,
            start_storage_s,
            required_downstream_m,
            max_legs: None,
        };
        match simforge_core::map::build_default_placement_route(&self.graph, &options) {
            Ok(placed) => Ok(Some((self.leg_rsls(&placed.route), placed.downstream_m))),
            Err(e) if e.code == simforge_core::SimIssueCode::RouteDisconnected => Ok(None),
            Err(e) => Err(route_error(e)),
        }
    }

    /// Walk successors from `start_rsl` consuming `turns` (`Straight|Left|Right|UTurnLeft|UTurnRight`)
    /// at each junction; the chosen lane rsls, or `None` when `strict_turns`
    /// finds a requested turn unavailable.
    pub fn follow_route(
        &self,
        start_rsl: &str,
        turns: &[String],
        max_length_m: f64,
        start_reversed: Option<bool>,
        strict_turns: bool,
    ) -> Result<Option<Vec<String>>> {
        let start = self.lane(start_rsl)?;
        let turns = turns
            .iter()
            .map(|t| {
                simforge_core::types::TurnRelation::parse(t)
                    .ok_or_else(|| BindingError::argument(format!("unknown turn relation {t:?}")))
            })
            .collect::<Result<Vec<_>>>()?;
        let options = simforge_core::map::FollowRouteOptions {
            start,
            turns: &turns,
            max_length_m,
            start_reversed,
            strict_turns,
        };
        match simforge_core::map::build_follow_route(&self.graph, &options) {
            Ok(route) => Ok(Some(self.leg_rsls(&route))),
            Err(e) if e.code == simforge_core::SimIssueCode::RouteTurnUnavailable => Ok(None),
            Err(e) => Err(route_error(e)),
        }
    }

    /// Resolve a `RouteSpec` document (`{kind: lanePath|follow|polyline|timedPolyline, ...}`)
    /// to a route handle. Build failures surface as argument errors carrying the `RouteBuildError` JSON.
    pub fn route(&self, spec_json: &str) -> Result<RouteHandle> {
        let spec: simforge_core::types::RouteSpec = serde_json::from_str(spec_json)
            .map_err(|e| BindingError::argument(format!("route spec: {e}")))?;
        let route = simforge_core::map::build_route(&self.graph, &spec).map_err(route_error)?;
        Ok(RouteHandle {
            lane_rsls: self.leg_rsls(&route),
            route,
        })
    }

    /// Turn relation of the first gate whose connecting lane is `rsl`, if any.
    pub fn turn_relation_of(&self, rsl: &str) -> Result<Option<&'static str>> {
        Ok(self
            .graph
            .turn_relation_of(self.lane(rsl)?)
            .map(|t| t.as_str()))
    }

    fn leg_rsls(&self, route: &simforge_core::map::Route) -> Vec<String> {
        route
            .legs()
            .iter()
            .map(|leg| self.graph.rsl(leg.lane).to_owned())
            .collect()
    }

    /// Engine run options for one world over this graph. `overrides` is the
    /// optional JSON `{captureTrace?, resolveArrival?, includeWarmupTrace?, ambientReactivity?: "scripted"|"reactive"}`.
    pub fn run_options(&self, overrides: Option<&str>) -> Result<RunOptions> {
        let mut options = RunOptions::new(Arc::clone(&self.graph));
        options.static_colliders = self.colliders.to_vec();
        if let Some(text) = overrides {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Overrides {
                capture_trace: Option<bool>,
                resolve_arrival: Option<bool>,
                include_warmup_trace: Option<bool>,
                ambient_reactivity: Option<simforge_core::engine::AmbientReactivity>,
            }
            let o: Overrides = serde_json::from_str(text)
                .map_err(|e| BindingError::argument(format!("run options: {e}")))?;
            if let Some(v) = o.ambient_reactivity {
                options.ambient_reactivity = v;
            }
            if let Some(v) = o.capture_trace {
                options.capture_trace = v;
            }
            if let Some(v) = o.resolve_arrival {
                options.resolve_arrival = v;
            }
            if let Some(v) = o.include_warmup_trace {
                options.include_warmup_trace = v;
            }
        }
        Ok(options)
    }
}

/// A resolved route: engine-frame geometry plus its persisted snapshot.
#[derive(Clone)]
pub struct RouteHandle {
    route: simforge_core::map::Route,
    /// Empty for freeform (polyline) routes.
    lane_rsls: Vec<String>,
}

impl RouteHandle {
    pub fn length_m(&self) -> f64 {
        self.route.length_m()
    }
    pub fn lane_rsls(&self) -> &[String] {
        &self.lane_rsls
    }
    /// `[x, y, heading_rad]` at arc length `s` (clamped to the route).
    pub fn pose_at(&self, s: f64) -> [f64; 3] {
        let pose = self.route.pose_at(s);
        [pose.point.x, pose.point.y, pose.heading_rad]
    }
    /// `RouteSnapshot` JSON.
    pub fn snapshot_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.route.snapshot())?)
    }
    /// `[s, d]`: arc length of the closest point on the route, and its signed
    /// lateral offset. The pair a caller needs to say "where along this route is
    /// that world point", which no other accessor answers.
    pub fn project_point(&self, x: f64, y: f64) -> [f64; 2] {
        let projection = self.route.project_point(Vec2 { x, y });
        [projection.s, projection.d]
    }
    /// [`project_point`] with an explicit coarse scan step. Stop-line-grade
    /// matching uses 0.5 m; the default 2 m scan can settle in a different
    /// basin on a route that doubles back, so the caller has to be able to say
    /// which resolution its comparison needs.
    pub fn project_point_with_step(&self, x: f64, y: f64, step_m: f64) -> Result<[f64; 2]> {
        if !(step_m > 0.0) || !step_m.is_finite() {
            return Err(BindingError::argument(format!(
                "step_m must be positive and finite, got {step_m}"
            )));
        }
        let projection = self.route.project_point_with_step(Vec2 { x, y }, step_m);
        Ok([projection.s, projection.d])
    }
    /// Lane width at arc length `s` (clamped); the basis of a lane-change
    /// separation, so it must come from the same geometry the route walks.
    pub fn width_at(&self, s: f64) -> f64 {
        self.route.width_at(s)
    }
    /// The route's legs as JSON: `[{rsl, reversed, sStartM, lengthM, turnRelation}]`.
    /// Empty for a polyline route, which has no lane lineage.
    pub fn legs_json(&self) -> Result<String> {
        // A LaneId is an index into its graph; only the graph can name it.
        let graph = self.route.graph();
        let legs: Vec<_> = self
            .route
            .legs()
            .iter()
            .map(|leg| {
                serde_json::json!({
                    "rsl": graph.map(|graph| graph.rsl(leg.lane).to_string()),
                    "reversed": leg.reversed,
                    "sStartM": leg.s_start,
                    "lengthM": leg.length_m,
                    "turnRelation": leg.turn_relation,
                })
            })
            .collect();
        Ok(serde_json::to_string(&legs)?)
    }
    /// The pose at `s`, including its lane lineage: `{x, y, headingRad, rsl,
    /// laneS, storageS, reversed, legIndex}`. `pose_at` alone loses the lane,
    /// and every caller that rebases a route across map versions needs it.
    pub fn pose_json(&self, s: f64) -> Result<String> {
        let pose = self.route.pose_at(s);
        Ok(serde_json::to_string(&serde_json::json!({
            "x": pose.point.x,
            "y": pose.point.y,
            "headingRad": pose.heading_rad,
            "rsl": pose
                .lane
                .and_then(|lane| self.route.graph().map(|graph| graph.rsl(lane).to_string())),
            "laneS": pose.lane_s,
            "storageS": pose.storage_s,
            "reversed": pose.reversed,
            "legIndex": pose.leg_index,
        }))?)
    }
    /// Re-base this route onto its lateral neighbour at `s`, as a lane change
    /// completing does. `side` is the DRIVER's side; a reversed leg swaps
    /// storage left/right, which is why this cannot be composed correctly from
    /// `successors` outside the engine.
    pub fn retarget_to_neighbour(
        &self,
        s: f64,
        side: &str,
        legal_only: bool,
        max_length_m: Option<f64>,
    ) -> Result<Option<(RouteHandle, String)>> {
        let side = match side {
            "left" => LaneSide::Left,
            "right" => LaneSide::Right,
            other => {
                return Err(BindingError::argument(format!(
                    "side must be \"left\" or \"right\", got {other:?}"
                )))
            }
        };
        let options = RetargetOptions {
            legal_only,
            remaining_turns: &[],
            max_length_m,
        };
        let Some(retarget) = retarget_to_neighbour(&self.route, s, side, &options) else {
            return Ok(None);
        };
        let target_rsl = retarget
            .route
            .graph()
            .map(|graph| graph.rsl(retarget.target).to_string());
        let meta = serde_json::to_string(&serde_json::json!({
            "s": retarget.s,
            "separationM": retarget.separation_m,
            "legal": retarget.legal,
            "targetRsl": target_rsl,
        }))?;
        let lane_rsls = retarget
            .route
            .graph()
            .map(|graph| {
                retarget
                    .route
                    .legs()
                    .iter()
                    .map(|leg| graph.rsl(leg.lane).to_string())
                    .collect()
            })
            .unwrap_or_default();
        Ok(Some((
            RouteHandle {
                route: retarget.route,
                lane_rsls,
            },
            meta,
        )))
    }
}

/// The motion envelope the engine applies to an actor class, as JSON
/// (`{accelMax, brakeComfort, brakeHard, lateralRateMax, lateralAccelMax,
/// lateralJerkMax}`).
///
/// The presets live in the native controller and are what the simulation
/// actually integrates; re-declaring them in JS is how a generator ends up
/// authoring an envelope the engine does not use.
pub fn motion_limits_json(kind: &str) -> Result<String> {
    let actor_kind: ActorKind = serde_json::from_value(serde_json::Value::String(kind.to_string()))
        .map_err(|_| BindingError::argument(format!("unknown actor kind {kind:?}")))?;
    let limits = limits_for_kind(actor_kind);
    Ok(serde_json::to_string(&serde_json::json!({
        "accelMax": limits.accel_max,
        "brakeComfort": limits.brake_comfort,
        "brakeHard": limits.brake_hard,
        "lateralRateMax": limits.lateral_rate_max,
        "lateralAccelMax": limits.lateral_accel_max,
        "lateralJerkMax": limits.lateral_jerk_max,
    }))?)
}

fn route_error(e: simforge_core::map::RouteBuildError) -> BindingError {
    BindingError::argument(serde_json::to_string(&e).unwrap_or_else(|_| e.reason.clone()))
}

/// Validated, normalised scenario input shared by reference.
#[derive(Clone)]
pub struct Scenario {
    input: Arc<SimScenarioInput>,
}

impl Scenario {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        Ok(Self {
            input: Arc::new(assets::parse_scenario(bytes)?),
        })
    }

    pub(crate) fn from_input(input: SimScenarioInput) -> Self {
        Self {
            input: Arc::new(input.normalized()),
        }
    }

    #[inline]
    pub fn input(&self) -> &SimScenarioInput {
        &self.input
    }

    pub fn to_json(&self) -> Result<String> {
        assets::scenario_to_json(&self.input)
    }

    pub fn content_hash(&self) -> Result<String> {
        Ok(self.input.content_hash()?)
    }

    pub fn with_seed(&self, seed: Seed) -> Self {
        let mut input = (*self.input).clone();
        input.seed = seed;
        Self::from_input(input)
    }

    pub fn with_clip_seconds(&self, clip_seconds: f64) -> Result<Self> {
        if !(clip_seconds > 0.0) || !clip_seconds.is_finite() {
            return Err(BindingError::argument(
                "clip_seconds must be positive and finite",
            ));
        }
        let mut input = (*self.input).clone();
        input.clip_seconds = clip_seconds;
        Ok(Self::from_input(input))
    }

    pub fn actor_ids(&self) -> Vec<String> {
        self.input.actors.iter().map(|a| a.id.clone()).collect()
    }

    pub fn seed_json(&self) -> String {
        serde_json::to_string(&self.input.seed).unwrap_or_else(|_| "null".to_owned())
    }
}

/// Parse an `EpisodeConfig` from optional JSON (camelCase, defaults applied).
pub fn episode_config_from_json(text: Option<&str>) -> Result<EpisodeConfig> {
    match text {
        None => Ok(EpisodeConfig::default()),
        Some(text) => serde_json::from_str(text)
            .map_err(|e| BindingError::argument(format!("episode config: {e}"))),
    }
}

/// Decode the checkpoint byte form (`simforge_core::checkpoint`, MessagePack).
/// Opaque to hosts, portable across them; malformed bytes are a host argument
/// error.
pub(crate) fn decode_checkpoint<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    simforge_core::checkpoint::decode(bytes)
        .map_err(|e| BindingError::argument(format!("invalid checkpoint: {e}")))
}

pub(crate) fn encode_checkpoint<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    simforge_core::checkpoint::encode(value).map_err(|e| BindingError::runtime(e.to_string()))
}
