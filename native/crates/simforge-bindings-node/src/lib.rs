//! `@simforge-oss/native-runtime` — Node N-API binding of the SimForge runtime.
//!
//! Typed arrays returned to JS are fresh copies owned by the caller; JSON
//! strings carry per-call metadata. Long calls (`runSimulation`, batch
//! stepping) are synchronous by design: the consumer decides threading
//! (worker_threads) and the engine never holds JS objects across a call.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use simforge_bindings_common::runtime::{
    self as rt, Batch, Compiled, Env, Handoff, MapAsset, Policy, PolicyOutcome, RouteHandle,
    Scenario, Sim, Site, StepView, Trace, World,
};
use simforge_bindings_common::{action, BindingError, ErrorKind};
use simforge_core::physics::VehicleControl;
use simforge_core::rng::Seed;

fn to_napi(err: BindingError) -> Error {
    let status = match err.kind() {
        ErrorKind::Argument => Status::InvalidArg,
        _ => Status::GenericFailure,
    };
    // Structured payload as `kind|issues|message` reason so the JS wrapper can
    // rebuild a typed error class with `.kind` and `.issues`.
    let issues = err.issues_json().unwrap_or_default();
    Error::new(
        status,
        format!("{}\u{1f}{}\u{1f}{}", err.kind().as_str(), issues, err),
    )
}

trait NapiResultExt<T> {
    fn js(self) -> Result<T>;
}
impl<T> NapiResultExt<T> for std::result::Result<T, BindingError> {
    fn js(self) -> Result<T> {
        self.map_err(to_napi)
    }
}

/// JS seed values: `number | string | null | undefined`.
fn seed_of(value: Option<Either<f64, String>>) -> Result<Option<Seed>> {
    Ok(match value {
        None => None,
        Some(Either::A(n)) => {
            if !n.is_finite() {
                return Err(Error::new(Status::InvalidArg, "seed must be finite"));
            }
            Some(Seed::Number(n))
        }
        Some(Either::B(s)) => Some(Seed::Text(s)),
    })
}

#[napi]
pub const ENGINE_HZ: u32 = simforge_bindings_common::ENGINE_HZ;
#[napi]
pub const STATE_VECTOR_SIZE: u32 = simforge_bindings_common::STATE_VECTOR_SIZE as u32;
#[napi]
pub const OBJECT_FEATURES: u32 = simforge_bindings_common::OBJECT_FEATURES as u32;
#[napi]
pub const ACTION_WIDTH: u32 = action::ACTION_WIDTH as u32;
#[napi]
pub const DEFAULT_MAX_OBJECTS: u32 = simforge_bindings_common::DEFAULT_MAX_OBJECTS as u32;
#[napi]
pub const ACTOR_ROW: u32 = rt::ACTOR_ROW as u32;
/// Row width of `TrafficHandoff.step` actor inputs.
#[napi]
pub const HANDOFF_ACTOR_ROW: u32 = rt::HANDOFF_ACTOR_ROW as u32;
/// Row width of `TrafficHandoff.bodies()`.
#[napi]
pub const HANDOFF_BODY_ROW: u32 = rt::HANDOFF_BODY_ROW as u32;
/// Binding ABI version; the JS loader refuses any other value.
#[napi]
pub const ABI_VERSION: u32 = simforge_bindings_common::ABI_VERSION;

#[napi]
pub fn abi_version() -> u32 {
    simforge_bindings_common::ABI_VERSION
}

#[napi]
pub fn canonical_json(document: String) -> Result<String> {
    rt::canonical_json(&document).js()
}

#[napi]
pub fn content_hash(document: String) -> Result<String> {
    rt::content_hash(&document).js()
}

#[napi]
pub fn sha256_hex(data: Uint8Array) -> String {
    rt::sha256_hex(&data)
}

#[napi]
pub fn engine_version() -> String {
    simforge_bindings_common::ENGINE_VERSION.to_owned()
}

#[napi]
pub fn action_fields() -> Vec<String> {
    action::ACTION_FIELD_NAMES
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
}

/* ------------------------------------------------------------ assets */

#[napi(js_name = "LaneGraph")]
pub struct JsLaneGraph {
    inner: rt::Graph,
}

#[napi]
impl JsLaneGraph {
    #[napi(factory)]
    pub fn from_topology(data: Uint8Array) -> Result<Self> {
        Ok(Self {
            inner: rt::Graph::from_topology_bytes(&data).js()?,
        })
    }
    #[napi(getter)]
    pub fn digest(&self) -> String {
        self.inner.topology_digest().to_owned()
    }
    #[napi(getter)]
    pub fn byte_digest(&self) -> String {
        self.inner.byte_digest().to_owned()
    }
    #[napi(getter)]
    pub fn lane_count(&self) -> u32 {
        self.inner.lane_count() as u32
    }
    #[napi(getter)]
    pub fn lane_ids(&self) -> Vec<String> {
        self.inner.lane_ids()
    }
    #[napi]
    pub fn lane_length_m(&self, rsl: String) -> Result<f64> {
        self.inner.lane_length_m(&rsl).js()
    }
    /// `[rsl, s, d]` of the nearest drivable lane, or `null`.
    #[napi]
    pub fn nearest_lane(
        &self,
        x: f64,
        y: f64,
        max_dist_m: Option<f64>,
    ) -> Option<(String, f64, f64)> {
        self.inner.nearest_lane(x, y, max_dist_m.unwrap_or(25.0))
    }
    #[napi]
    pub fn lane_width_at(&self, rsl: String, s: f64) -> Result<f64> {
        self.inner.lane_width_at(&rsl, s).js()
    }
    /// `[x, y, headingRad]` at arc length `s` measured along the traversal direction (`reversed` = from the last polyline point, storage `len - s`).
    #[napi]
    pub fn sample_lane(&self, rsl: String, s: f64, reversed: Option<bool>) -> Result<Float64Array> {
        Ok(Float64Array::new(
            self.inner
                .sample_lane(&rsl, s, reversed.unwrap_or(false))
                .js()?
                .to_vec(),
        ))
    }
    /// `[s, d]` projection of a point onto the lane polyline.
    #[napi]
    pub fn project_onto_lane(&self, rsl: String, x: f64, y: f64) -> Result<Float64Array> {
        Ok(Float64Array::new(
            self.inner.project_onto_lane(&rsl, x, y).js()?.to_vec(),
        ))
    }
    /// Directed successors as `[rsl, reversed]` pairs.
    #[napi]
    pub fn successors(&self, rsl: String, reversed: Option<bool>) -> Result<Vec<(String, bool)>> {
        self.inner.successors(&rsl, reversed.unwrap_or(false)).js()
    }
    #[napi]
    pub fn nominal_reversed(&self, rsl: String) -> Result<Option<bool>> {
        self.inner.nominal_reversed(&rsl).js()
    }
    /// The decoded `TopologyLane` record as JSON.
    #[napi]
    pub fn lane_json(&self, rsl: String) -> Result<String> {
        self.inner.lane_json(&rsl).js()
    }
    /// Connected legal-direction lane chain for a newly placed road actor, or `null` when no route provides the runway.
    #[napi]
    pub fn default_placement_route(
        &self,
        start_rsl: String,
        start_storage_s: f64,
        required_downstream_m: f64,
    ) -> Result<Option<JsPlacementRoute>> {
        Ok(self
            .inner
            .default_placement_route(&start_rsl, start_storage_s, required_downstream_m)
            .js()?
            .map(|(lanes, downstream_m)| JsPlacementRoute {
                lanes,
                downstream_m,
            }))
    }
    /// Lane rsls walking successors from `startRsl` consuming `turns` (`Straight|Left|Right|UTurnLeft|UTurnRight`); `null` when `strictTurns` finds a turn unavailable.
    #[napi]
    pub fn follow_route(
        &self,
        start_rsl: String,
        turns: Vec<String>,
        max_length_m: f64,
        start_reversed: Option<bool>,
        strict_turns: Option<bool>,
    ) -> Result<Option<Vec<String>>> {
        self.inner
            .follow_route(
                &start_rsl,
                &turns,
                max_length_m,
                start_reversed,
                strict_turns.unwrap_or(false),
            )
            .js()
    }
    /// Resolve a `RouteSpec` document to a route handle; throws the `RouteBuildError` JSON on failure.
    #[napi]
    pub fn route(&self, spec_json: String) -> Result<JsRoute> {
        Ok(JsRoute {
            inner: self.inner.route(&spec_json).js()?,
        })
    }
    /// Turn relation of the first gate whose connecting lane is `rsl`, or `null`.
    #[napi]
    pub fn turn_relation_of(&self, rsl: String) -> Result<Option<String>> {
        Ok(self.inner.turn_relation_of(&rsl).js()?.map(str::to_owned))
    }
}

#[napi(object, js_name = "PlacementRoute")]
pub struct JsPlacementRoute {
    pub lanes: Vec<String>,
    pub downstream_m: f64,
}

/// A resolved route: engine-frame geometry plus its persisted snapshot.
#[napi(js_name = "Route")]
pub struct JsRoute {
    inner: RouteHandle,
}

#[napi]
impl JsRoute {
    #[napi(getter)]
    pub fn length_m(&self) -> f64 {
        self.inner.length_m()
    }
    /// Empty for polyline routes.
    #[napi(getter)]
    pub fn lane_rsls(&self) -> Vec<String> {
        self.inner.lane_rsls().to_vec()
    }
    /// `[x, y, headingRad]` at arc length `s` (clamped).
    #[napi]
    pub fn pose_at(&self, s: f64) -> Float64Array {
        Float64Array::new(self.inner.pose_at(s).to_vec())
    }
    /// `RouteSnapshot` JSON.
    #[napi]
    pub fn snapshot_json(&self) -> Result<String> {
        self.inner.snapshot_json().js()
    }
    /// `[s, d]` of the closest point on the route to `(x, y)`.
    #[napi]
    pub fn project_point(&self, x: f64, y: f64) -> Float64Array {
        Float64Array::new(self.inner.project_point(x, y).to_vec())
    }
    /// `[s, d]` with an explicit coarse scan step (0.5 m for stop-line-grade matching).
    #[napi]
    pub fn project_point_with_step(&self, x: f64, y: f64, step_m: f64) -> Result<Float64Array> {
        Ok(Float64Array::new(
            self.inner.project_point_with_step(x, y, step_m).js()?.to_vec(),
        ))
    }
    /// Lane width at arc length `s` (clamped).
    #[napi]
    pub fn width_at(&self, s: f64) -> f64 {
        self.inner.width_at(s)
    }
    /// `[{rsl, reversed, sStartM, lengthM, turnRelation}]` JSON; empty for a polyline route.
    #[napi]
    pub fn legs_json(&self) -> Result<String> {
        self.inner.legs_json().js()
    }
    /// `{x, y, headingRad, rsl, laneS, storageS, reversed, legIndex}` JSON at `s`.
    #[napi]
    pub fn pose_json(&self, s: f64) -> Result<String> {
        self.inner.pose_json(s).js()
    }
    /// Re-base onto the lateral neighbour at `s`; `null` when there is none.
    /// `side` is the driver's side ("left" | "right").
    #[napi]
    pub fn retarget_to_neighbour(
        &self,
        s: f64,
        side: String,
        legal_only: Option<bool>,
        max_length_m: Option<f64>,
    ) -> Result<Option<JsNeighbourRetarget>> {
        let retarget = self
            .inner
            .retarget_to_neighbour(s, &side, legal_only.unwrap_or(false), max_length_m)
            .js()?;
        Ok(retarget.map(|(route, meta)| JsNeighbourRetarget {
            route: JsRoute { inner: route },
            meta,
        }))
    }
}

/// A route re-based onto its lateral neighbour, plus where the actor lands on it.
#[napi(js_name = "NeighbourRetarget")]
pub struct JsNeighbourRetarget {
    route: JsRoute,
    meta: String,
}

#[napi]
impl JsNeighbourRetarget {
    /// The rebuilt route on the neighbour lane.
    #[napi(getter)]
    pub fn route(&self) -> JsRoute {
        JsRoute {
            inner: self.route.inner.clone(),
        }
    }
    /// `{s, separationM, legal, targetRsl}` JSON: `s` on the new route,
    /// the signed lane separation, whether the change is legal there, and the
    /// lane it landed on.
    #[napi(getter)]
    pub fn detail_json(&self) -> String {
        self.meta.clone()
    }
}

/// The motion envelope the engine integrates for an actor class, as JSON:
/// `{accelMax, brakeComfort, brakeHard, lateralRateMax, lateralAccelMax, lateralJerkMax}`.
#[napi]
pub fn motion_limits_json(kind: String) -> Result<String> {
    rt::motion_limits_json(&kind).js()
}

#[napi(js_name = "ScenarioInput")]
pub struct JsScenarioInput {
    inner: Scenario,
}

#[napi]
impl JsScenarioInput {
    /// Validate a scenario JSON document (string or bytes; raw input or `scenario-instance` envelope).
    #[napi(factory)]
    pub fn parse(document: Either<String, Uint8Array>) -> Result<Self> {
        let inner = match document {
            Either::A(text) => Scenario::parse(text.as_bytes()),
            Either::B(bytes) => Scenario::parse(&bytes),
        };
        Ok(Self { inner: inner.js()? })
    }
    #[napi]
    pub fn to_json(&self) -> Result<String> {
        self.inner.to_json().js()
    }
    #[napi]
    pub fn with_seed(&self, seed: Either<f64, String>) -> Result<JsScenarioInput> {
        let seed = seed_of(Some(seed))?.expect("present");
        Ok(JsScenarioInput {
            inner: self.inner.with_seed(seed),
        })
    }
    #[napi]
    pub fn with_clip_seconds(&self, clip_seconds: f64) -> Result<JsScenarioInput> {
        Ok(JsScenarioInput {
            inner: self.inner.with_clip_seconds(clip_seconds).js()?,
        })
    }
    #[napi(getter)]
    pub fn content_hash(&self) -> Result<String> {
        self.inner.content_hash().js()
    }
    #[napi(getter)]
    pub fn map_id(&self) -> String {
        self.inner.input().map_id.clone()
    }
    /// The authored seed as JSON (`number | string`).
    #[napi(getter)]
    pub fn seed_json(&self) -> String {
        self.inner.seed_json()
    }
    #[napi(getter)]
    pub fn clip_seconds(&self) -> f64 {
        self.inner.input().clip_seconds
    }
    #[napi(getter)]
    pub fn warmup_seconds(&self) -> f64 {
        self.inner.input().warmup_seconds
    }
    #[napi(getter)]
    pub fn dt(&self) -> f64 {
        self.inner.input().dt
    }
    #[napi(getter)]
    pub fn metric_subject(&self) -> Option<String> {
        self.inner.input().metric_subject.clone()
    }
    #[napi(getter)]
    pub fn actor_ids(&self) -> Vec<String> {
        self.inner.actor_ids()
    }
    #[napi(getter)]
    pub fn physics_mode(&self) -> String {
        self.inner.input().physics_mode().as_str().to_owned()
    }
}

#[napi(js_name = "MapBundle")]
pub struct JsMapBundle {
    inner: MapAsset,
}

#[napi]
impl JsMapBundle {
    /// Load an installed map directory from the immutable map corpus.
    #[napi(factory)]
    pub fn load(path: String) -> Result<Self> {
        Ok(Self {
            inner: MapAsset::load(std::path::Path::new(&path)).js()?,
        })
    }
    #[napi(factory)]
    pub fn from_topology(map_id: String, topology: Uint8Array) -> Result<Self> {
        Ok(Self {
            inner: MapAsset::from_topology_bytes(&map_id, &topology).js()?,
        })
    }
    #[napi(getter)]
    pub fn map_id(&self) -> String {
        self.inner.map_id().to_owned()
    }
    #[napi(getter)]
    pub fn digest(&self) -> String {
        self.inner.digest().to_owned()
    }
    #[napi(getter)]
    pub fn graph(&self) -> JsLaneGraph {
        JsLaneGraph {
            inner: self.inner.graph().clone(),
        }
    }
    /// Bundle from in-memory sources: `sourcesJson = {mapId, derived?, locations?, searchIndex?, xodr?, signalsGeojson?}` plus the topology sidecar bytes.
    #[napi(factory)]
    pub fn from_sources(sources_json: String, topology: Uint8Array) -> Result<Self> {
        Ok(Self {
            inner: MapAsset::from_sources(&sources_json, &topology).js()?,
        })
    }
    /// `{signalPrograms, roadControls}` bound from the map's signal catalog.
    #[napi]
    pub fn control_plan_json(&self) -> Result<String> {
        self.inner.control_plan_json().js()
    }
    /// The merged `TopologyIndex`.
    #[napi]
    pub fn topology_json(&self) -> Result<String> {
        self.inner.topology_json().js()
    }
    /// The `MapSignalCatalog`.
    #[napi]
    pub fn signal_catalog_json(&self) -> Result<String> {
        self.inner.signal_catalog_json().js()
    }
    #[napi]
    pub fn signal_control_index_json(&self) -> Result<String> {
        self.inner.signal_control_index_json().js()
    }
    /// The matcher's `DerivedMapIndex`.
    #[napi]
    pub fn index_json(&self) -> Result<String> {
        self.inner.index_json().js()
    }
    #[napi]
    pub fn static_collider_diagnostics_json(&self) -> Result<String> {
        self.inner.static_collider_diagnostics_json().js()
    }
    /// `SiteSignalPlan` JSON for the site's origin junction.
    #[napi]
    pub fn site_signal_plan_json(&self, site: &JsSite) -> Result<String> {
        self.inner.site_signal_plan_json(&site.inner).js()
    }
    /// Resolve `{"handle": id}` | `{"featureId", "approach"}` to a concrete program id, or `null`.
    #[napi]
    pub fn resolve_site_signal_program(
        &self,
        site: &JsSite,
        ref_json: String,
    ) -> Result<Option<String>> {
        self.inner
            .resolve_site_signal_program(&site.inner, &ref_json)
            .js()
    }
}

/// One grounded matched site (native handle; `toJson()` for the `MatchedSite` document).
#[napi(js_name = "Site")]
pub struct JsSite {
    inner: Site,
}

#[napi]
impl JsSite {
    #[napi(getter)]
    pub fn site_id(&self) -> String {
        self.inner.site_id().to_owned()
    }
    #[napi(getter)]
    pub fn map_id(&self) -> String {
        self.inner.map_id().to_owned()
    }
    #[napi]
    pub fn to_json(&self) -> Result<String> {
        self.inner.to_json().js()
    }
}

/// Resolve one site: `siteId = null` picks the top-ranked site.
#[napi]
pub fn find_site(
    template_json: String,
    bundle: &JsMapBundle,
    site_id: Option<String>,
) -> Result<JsSite> {
    Ok(JsSite {
        inner: rt::find_site(&template_json, &bundle.inner, site_id.as_deref()).js()?,
    })
}

#[napi(js_name = "CompileResult")]
pub struct JsCompileResult {
    inner: Compiled,
}

#[napi]
impl JsCompileResult {
    #[napi(getter)]
    pub fn input(&self) -> JsScenarioInput {
        JsScenarioInput {
            inner: self.inner.scenario.clone(),
        }
    }
    #[napi(getter)]
    pub fn manifest_json(&self) -> String {
        self.inner.manifest_json().to_owned()
    }
    /// Lowered observations (`LoweredObservation[]`).
    #[napi(getter)]
    pub fn observations_json(&self) -> String {
        self.inner.observations_json().to_owned()
    }
}

/// `site = null` picks the top-ranked matched site; map-bound documents skip matching.
#[napi]
pub fn compile_template(
    template_json: String,
    bundle: &JsMapBundle,
    site: Option<String>,
    seed: Option<Either<f64, String>>,
    options_json: Option<String>,
) -> Result<JsCompileResult> {
    let seed = seed_of(seed)?;
    Ok(JsCompileResult {
        inner: rt::compile_template(
            &template_json,
            &bundle.inner,
            site.as_deref(),
            seed,
            options_json.as_deref(),
        )
        .js()?,
    })
}

#[napi]
pub fn find_sites(template_json: String, bundle: &JsMapBundle) -> Result<Vec<String>> {
    rt::find_sites(&template_json, &bundle.inner).js()
}

/// Ranked `SiteMatch` JSON (`{mapId, report: MatchReport, notes}`); `optionsJson = {minScore?, maxSites?, exactCatalogSiteResolution?}`.
#[napi]
pub fn match_sites(
    template_json: String,
    bundle: &JsMapBundle,
    options_json: Option<String>,
) -> Result<String> {
    rt::match_sites(&template_json, &bundle.inner, options_json.as_deref()).js()
}

/// Returns `[scenarioInput, boundSituationJson]`.
#[napi]
pub fn compile_situation(
    document_json: String,
    bundle: &JsMapBundle,
    options_json: Option<String>,
) -> Result<(JsScenarioInput, String)> {
    let (scenario, program) =
        rt::compile_situation_json(&document_json, &bundle.inner, options_json.as_deref()).js()?;
    Ok((JsScenarioInput { inner: scenario }, program))
}

/// Host policy for declared policy roles: `(contextJson) => actionJson | null`.
fn policy_callback<'a>(
    cb: &'a Option<Function<'a, String, Option<String>>>,
) -> Option<Box<rt::PolicyCallback<'a>>> {
    cb.as_ref().map(|f| {
        Box::new(move |ctx: &str| {
            f.call(ctx.to_owned())
                .map_err(|e| BindingError::Runtime(e.to_string()))
        }) as Box<rt::PolicyCallback<'a>>
    })
}

/// `SituationRehearsal` JSON. `optionsJson = {materialize?, siteId?, geometryBindings?, runtime?}`.
#[napi]
pub fn rehearse_situation(
    document_json: String,
    bundle: &JsMapBundle,
    options_json: Option<String>,
    policy: Option<Function<String, Option<String>>>,
) -> Result<String> {
    let mut cb = policy_callback(&policy);
    rt::rehearse_situation_json(
        &document_json,
        &bundle.inner,
        options_json.as_deref(),
        cb.as_deref_mut(),
    )
    .js()
}

/// `SituationSolveResult` JSON; `onEvaluation` receives each `{program, rehearsal}` JSON. Options add `maxEvaluations?`, `relativeResolution?`.
#[napi]
pub fn solve_situation(
    document_json: String,
    bundle: &JsMapBundle,
    options_json: Option<String>,
    on_evaluation: Option<Function<String, ()>>,
    policy: Option<Function<String, Option<String>>>,
) -> Result<String> {
    let mut cb = policy_callback(&policy);
    let mut on_eval = on_evaluation.as_ref().map(|f| {
        move |doc: &str| {
            f.call(doc.to_owned())
                .map_err(|e| BindingError::Runtime(e.to_string()))
        }
    });
    rt::solve_situation_json(
        &document_json,
        &bundle.inner,
        options_json.as_deref(),
        cb.as_deref_mut(),
        on_eval
            .as_mut()
            .map(|f| f as &mut dyn FnMut(&str) -> std::result::Result<(), BindingError>),
    )
    .js()
}

/// `SituationComparison` JSON. Options add `reactiveRoleIds?`.
#[napi]
pub fn compare_situation(
    document_json: String,
    transaction_json: String,
    bundle: &JsMapBundle,
    options_json: Option<String>,
    policy: Option<Function<String, Option<String>>>,
) -> Result<String> {
    let mut cb = policy_callback(&policy);
    rt::compare_situation_json(
        &document_json,
        &transaction_json,
        &bundle.inner,
        options_json.as_deref(),
        cb.as_deref_mut(),
    )
    .js()
}

/// `{templateId, paramsVersion}`: the replay-key identity of a template.
#[napi]
pub fn template_identity_json(template_json: String) -> Result<String> {
    rt::template_identity_json(&template_json).js()
}

/// `AdaptNote[]` JSON (`{path, reason, severity, code?}`); needs no map.
#[napi]
pub fn adapt_template_notes_json(template_json: String) -> Result<String> {
    rt::adapt_template_notes_json(&template_json).js()
}

/// `sha256(templateId|paramsVersion|siteId|drawIndex)`, the per-cell seed.
#[napi]
pub fn cell_seed(
    template_id: String,
    params_version: String,
    site_id: String,
    draw_index: i64,
) -> String {
    rt::cell_seed(&template_id, &params_version, &site_id, draw_index)
}

/// `SituationTransactionResult` JSON (no simulation).
#[napi]
pub fn apply_situation_transaction(
    document_json: String,
    transaction_json: String,
) -> Result<String> {
    rt::apply_situation_transaction_json(&document_json, &transaction_json).js()
}

/// Materialise an ambient-traffic profile onto `input` over `graph`; returns `[scenarioInput, provenanceJson]`.
#[napi]
pub fn materialize_ambient_traffic(
    input: &JsScenarioInput,
    graph: &JsLaneGraph,
    profile_json: String,
    options_json: Option<String>,
) -> Result<(JsScenarioInput, String)> {
    let (scenario, provenance) = rt::materialize_ambient_traffic(
        &input.inner,
        &graph.inner,
        &profile_json,
        options_json.as_deref(),
    )
    .js()?;
    Ok((JsScenarioInput { inner: scenario }, provenance))
}

/// The `t = 0` feasibility guards alone; returns the `SimIssue[]` JSON (no clip run).
#[napi]
pub fn check_feasibility(input: &JsScenarioInput, graph: &JsLaneGraph) -> Result<String> {
    rt::check_feasibility_json(&input.inner, &graph.inner).js()
}

/// Run a whole clip; returns the `SimResult` JSON document.
#[napi]
pub fn run_simulation(
    input: &JsScenarioInput,
    graph: &JsLaneGraph,
    options_json: Option<String>,
) -> Result<String> {
    rt::run_simulation_json(&input.inner, &graph.inner, options_json.as_deref()).js()
}

/* ------------------------------------------------------------ session */

/// One decision's result; every typed array is an owned copy.
#[napi(object, js_name = "StepResult")]
pub struct JsStepResult {
    pub t_s: f64,
    pub reward: f64,
    pub terminated: bool,
    pub truncated: bool,
    /// `Float64Array(STATE_VECTOR_SIZE)` (empty when disabled).
    pub state_vector: Float64Array,
    /// `Float32Array(maxObjects * OBJECT_FEATURES)` row-major, zero-padded.
    pub objects: Float32Array,
    pub object_count: u32,
    pub object_ids: Vec<String>,
    /// `Float32Array(height * width * channels)` when BEV is configured.
    pub bev: Option<Float32Array>,
    /// `[progress, proximity, comfort]`.
    pub reward_terms: Float64Array,
    /// JSON `{events, minima, causal}`.
    pub info_json: String,
}

fn step_result(view: &StepView<'_>) -> Result<JsStepResult> {
    Ok(JsStepResult {
        t_s: view.t_s(),
        reward: view.reward(),
        terminated: view.terminated(),
        truncated: view.truncated(),
        state_vector: Float64Array::new(view.state_vector().to_vec()),
        objects: Float32Array::new(view.objects().to_vec()),
        object_count: view.object_count() as u32,
        object_ids: view.object_ids().to_vec(),
        bev: view.bev().map(|(_, data)| Float32Array::new(data.to_vec())),
        reward_terms: Float64Array::new(view.reward_terms().to_vec()),
        info_json: view.info_json().js()?,
    })
}

#[napi(object)]
pub struct BevShape {
    pub height: u32,
    pub width: u32,
    pub channels: u32,
}

fn bev_shape(shape: Option<(usize, usize, usize)>) -> Option<BevShape> {
    shape.map(|(h, w, c)| BevShape {
        height: h as u32,
        width: w as u32,
        channels: c as u32,
    })
}

#[napi(js_name = "EnvSession")]
pub struct JsEnvSession {
    inner: Env,
}

#[napi]
impl JsEnvSession {
    #[napi(constructor)]
    pub fn new(
        input: &JsScenarioInput,
        graph: &JsLaneGraph,
        episode_json: Option<String>,
        max_objects: Option<u32>,
    ) -> Result<Self> {
        let max_objects = max_objects.map_or(simforge_bindings_common::DEFAULT_MAX_OBJECTS, |m| {
            m as usize
        });
        Ok(Self {
            inner: Env::new(
                &input.inner,
                &graph.inner,
                episode_json.as_deref(),
                max_objects,
            )
            .js()?,
        })
    }
    #[napi(getter)]
    pub fn ego(&self) -> String {
        self.inner.ego().to_owned()
    }
    #[napi(getter)]
    pub fn decision_hz(&self) -> u32 {
        self.inner.decision_hz()
    }
    #[napi(getter)]
    pub fn decision_ticks(&self) -> u32 {
        self.inner.decision_ticks() as u32
    }
    #[napi(getter)]
    pub fn clip_seconds(&self) -> f64 {
        self.inner.clip_seconds()
    }
    #[napi(getter)]
    pub fn max_objects(&self) -> u32 {
        self.inner.max_objects() as u32
    }
    #[napi(getter)]
    pub fn bev_shape(&self) -> Option<BevShape> {
        bev_shape(self.inner.bev_shape())
    }
    #[napi]
    pub fn reset(&mut self, seed: Option<Either<f64, String>>) -> Result<JsStepResult> {
        let seed = seed_of(seed)?;
        step_result(&self.inner.reset(seed).js()?)
    }
    /// `action` is one flat `Float64Array(ACTION_WIDTH)` row (NaN = unset) or `null` for choreography.
    #[napi]
    pub fn step(&mut self, action: Option<Float64Array>) -> Result<JsStepResult> {
        step_result(&self.inner.step(action.as_deref()).js()?)
    }
    #[napi]
    pub fn checkpoint(&self) -> Result<Buffer> {
        Ok(self.inner.checkpoint().js()?.into())
    }
    #[napi]
    pub fn restore(&mut self, checkpoint: Buffer) -> Result<JsStepResult> {
        step_result(&self.inner.restore(&checkpoint).js()?)
    }
    /// `[tS, x, y, yawRad, speedMps]`.
    #[napi]
    pub fn ego_pose(&self) -> Result<Float64Array> {
        Ok(Float64Array::new(self.inner.ego_pose().js()?.to_vec()))
    }
    /// Actors in the world at the observation instant; throws before `reset()`.
    #[napi(getter)]
    pub fn actor_count(&self) -> Result<u32> {
        Ok(self.inner.actor_count().js()? as u32)
    }
    /// Canonical ids in snapshot order (the row order of `actors()`/`present()`/`actorDims`); throws before `reset()`.
    #[napi(getter)]
    pub fn actor_ids(&self) -> Result<Vec<String>> {
        self.inner.actor_ids().js()
    }
    #[napi(getter)]
    pub fn actor_kinds(&self) -> Result<Vec<String>> {
        Ok(self
            .inner
            .actor_kinds()
            .js()?
            .into_iter()
            .map(str::to_owned)
            .collect())
    }
    /// `Float64Array(N * 3)` rows `[l, w, h]`.
    #[napi(getter)]
    pub fn actor_dims(&self) -> Result<Float64Array> {
        Ok(Float64Array::new(self.inner.actor_dims().js()?))
    }
    /// `Float64Array(N * ACTOR_ROW)` rows `[x, y, headingRad, speedMps, accelMps2, lateralOffsetM, lateralRateMps, s]` (xodr-local) at the observation instant.
    #[napi]
    pub fn actors(&self) -> Result<Float64Array> {
        Ok(Float64Array::new(self.inner.actor_rows().js()?))
    }
    #[napi]
    pub fn present(&self) -> Result<Uint8Array> {
        Ok(Uint8Array::new(
            self.inner
                .actor_present()
                .js()?
                .into_iter()
                .map(u8::from)
                .collect(),
        ))
    }
    #[napi]
    pub fn signal_book_json(&self) -> Result<String> {
        self.inner.signal_book_json().js()
    }
    /// The accumulated `CausalChannel` of the current episode as JSON.
    #[napi]
    pub fn causal_channel_json(&self) -> Result<String> {
        self.inner.causal_channel_json().js()
    }
}

/* -------------------------------------------------------------- batch */

/// World-major flat results of one batch call; every array is an owned copy.
#[napi(object, js_name = "BatchResult")]
pub struct JsBatchResult {
    pub size: u32,
    pub t_s: Float64Array,
    pub reward: Float64Array,
    pub terminated: Uint8Array,
    pub truncated: Uint8Array,
    /// `(N, STATE_VECTOR_SIZE)` row-major.
    pub state_vector: Float64Array,
    /// `(N, maxObjects, OBJECT_FEATURES)` row-major.
    pub objects: Float32Array,
    pub object_count: Uint32Array,
    /// `(N, 3)` row-major.
    pub reward_terms: Float64Array,
    /// `(N, height, width, channels)` row-major when BEV is configured.
    pub bev: Option<Float32Array>,
}

fn batch_result(batch: &Batch) -> JsBatchResult {
    let flat = batch.flat();
    JsBatchResult {
        size: batch.len() as u32,
        t_s: Float64Array::new(flat.t_s.clone()),
        reward: Float64Array::new(flat.rewards.clone()),
        terminated: Uint8Array::new(flat.terminated.clone()),
        truncated: Uint8Array::new(flat.truncated.clone()),
        state_vector: Float64Array::new(flat.state.clone()),
        objects: Float32Array::new(batch.objects_f32().to_vec()),
        object_count: Uint32Array::new(flat.object_counts.clone()),
        reward_terms: Float64Array::new(batch.reward_terms().to_vec()),
        bev: batch
            .bev_shape()
            .map(|_| Float32Array::new(flat.bev.clone())),
    }
}

#[napi(js_name = "SessionBatch")]
pub struct JsSessionBatch {
    inner: Batch,
}

#[napi]
impl JsSessionBatch {
    #[napi(constructor)]
    pub fn new(
        inputs: Vec<ClassInstance<'_, JsScenarioInput>>,
        graphs: Vec<ClassInstance<'_, JsLaneGraph>>,
        episode_json: Option<String>,
        threads: Option<u32>,
        max_objects: Option<u32>,
    ) -> Result<Self> {
        let scenarios: Vec<Scenario> = inputs.iter().map(|s| s.inner.clone()).collect();
        let graphs: Vec<rt::Graph> = graphs.iter().map(|g| g.inner.clone()).collect();
        let max_objects = max_objects.map_or(simforge_bindings_common::DEFAULT_MAX_OBJECTS, |m| {
            m as usize
        });
        Ok(Self {
            inner: Batch::new(
                &scenarios,
                &graphs,
                episode_json.as_deref(),
                max_objects,
                threads.unwrap_or(0) as usize,
            )
            .js()?,
        })
    }
    #[napi(getter)]
    pub fn size(&self) -> u32 {
        self.inner.len() as u32
    }
    #[napi(getter)]
    pub fn egos(&self) -> Vec<String> {
        self.inner.egos()
    }
    #[napi(getter)]
    pub fn decision_hz(&self) -> u32 {
        self.inner.decision_hz()
    }
    #[napi(getter)]
    pub fn max_objects(&self) -> u32 {
        self.inner.max_objects() as u32
    }
    #[napi(getter)]
    pub fn bev_shape(&self) -> Option<BevShape> {
        bev_shape(self.inner.bev_shape())
    }
    #[napi]
    pub fn reset_all(&mut self, seeds: Option<Vec<Either<f64, String>>>) -> Result<JsBatchResult> {
        let seeds = seeds
            .map(|v| {
                v.into_iter()
                    .map(|s| seed_of(Some(s)).map(|o| o.expect("present")))
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?;
        self.inner.reset_all(seeds.as_deref()).js()?;
        Ok(batch_result(&self.inner))
    }
    /// Reset only `worlds`; `seeds[k]` (may be `null`) applies to `worlds[k]`.
    #[napi]
    pub fn reset_worlds(
        &mut self,
        worlds: Vec<u32>,
        seeds: Option<Vec<Option<Either<f64, String>>>>,
    ) -> Result<JsBatchResult> {
        let worlds: Vec<usize> = worlds.into_iter().map(|w| w as usize).collect();
        let seeds = seeds
            .map(|v| v.into_iter().map(seed_of).collect::<Result<Vec<_>>>())
            .transpose()?;
        self.inner.reset_worlds(&worlds, seeds.as_deref()).js()?;
        Ok(batch_result(&self.inner))
    }
    /// `actions` is `Float64Array(N * ACTION_WIDTH)`; `mask[i] == 0` skips world `i`.
    #[napi]
    pub fn step_batch(
        &mut self,
        actions: Float64Array,
        mask: Option<Uint8Array>,
    ) -> Result<JsBatchResult> {
        let mask: Option<Vec<bool>> = mask.map(|m| m.iter().map(|v| *v != 0).collect());
        self.inner.step_batch(&actions, mask.as_deref()).js()?;
        Ok(batch_result(&self.inner))
    }
    #[napi]
    pub fn object_ids(&self, world: u32) -> Result<Vec<String>> {
        self.inner.object_ids(world as usize).js()
    }
    #[napi]
    pub fn info_json(&self, world: u32) -> Result<String> {
        self.inner.info_json(world as usize).js()
    }
    #[napi]
    pub fn checkpoint(&self, world: u32) -> Result<Buffer> {
        Ok(self.inner.checkpoint(world as usize).js()?.into())
    }
    #[napi]
    pub fn restore(&mut self, world: u32, checkpoint: Buffer) -> Result<()> {
        self.inner.restore(world as usize, &checkpoint).js()
    }
}

/* -------------------------------------------------------------- world */

#[napi(object, js_name = "WorldSnapshot")]
pub struct JsWorldSnapshot {
    pub t_s: f64,
    pub tick: u32,
    pub done: bool,
    pub actor_ids: Vec<String>,
    pub kinds: Vec<String>,
    pub lane_rsls: Vec<Option<String>>,
    pub present: Uint8Array,
    /// `(N, 5)` rows `[x, z, headingRad, speedMps, s]` in the scene frame.
    pub pose: Float64Array,
}

#[napi(js_name = "TruthSubscription")]
pub struct JsTruthSubscription {
    inner: rt::TruthSubscriber,
}

#[napi]
impl JsTruthSubscription {
    /// Every queued tick frame (JSON), oldest first.
    #[napi]
    pub fn drain(&mut self) -> Result<Vec<String>> {
        self.inner.drain_json().js()
    }
    /// Every queued frame as `u32le length || msgpack(TruthFrame)` (the truth-stream wire framing).
    #[napi]
    pub fn drain_frames(&mut self) -> Result<Vec<Buffer>> {
        Ok(self
            .inner
            .drain_framed()
            .js()?
            .into_iter()
            .map(Buffer::from)
            .collect())
    }
    #[napi(getter)]
    pub fn dropped(&self) -> i64 {
        self.inner.dropped() as i64
    }
    #[napi(getter)]
    pub fn queued(&self) -> u32 {
        self.inner.queued() as u32
    }
    #[napi(getter)]
    pub fn active(&self) -> bool {
        self.inner.is_active()
    }
    #[napi]
    pub fn close(&self) {
        self.inner.close()
    }
}

#[napi(js_name = "WorldSession")]
pub struct JsWorldSession {
    inner: World,
}

#[napi]
impl JsWorldSession {
    /// `optionsJson`: `{mode?: "clip"|"live", horizonSeconds?}`.
    #[napi(constructor)]
    pub fn new(
        input: &JsScenarioInput,
        graph: &JsLaneGraph,
        options_json: Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            inner: World::new(&input.inner, &graph.inner, options_json.as_deref()).js()?,
        })
    }
    #[napi(getter)]
    pub fn time(&self) -> f64 {
        self.inner.time()
    }
    #[napi(getter)]
    pub fn tick(&self) -> u32 {
        self.inner.tick() as u32
    }
    #[napi(getter)]
    pub fn digest(&self) -> String {
        self.inner.digest().to_owned()
    }
    /// Apply one `WorldCommand` JSON; returns the `CommandOutcome` JSON.
    #[napi]
    pub fn command(
        &mut self,
        command_json: String,
        client_id: Option<String>,
        seq: Option<i64>,
    ) -> Result<String> {
        self.inner
            .command_json(
                client_id.as_deref().unwrap_or("node"),
                seq.unwrap_or(0).max(0) as u64,
                &command_json,
            )
            .js()
    }
    /// Hold one actor's pedals and wheel until replaced. Omit `throttle`,
    /// `brake` and `steer` — pass `null` for the whole command — to release
    /// the actor back to its scenario controller. Returns the
    /// `CommandOutcome` JSON.
    #[napi(js_name = "setDriverCommand")]
    pub fn set_driver_command(
        &mut self,
        actor_id: String,
        throttle: Option<f64>,
        brake: Option<f64>,
        steer: Option<f64>,
        handbrake: Option<bool>,
        client_id: Option<String>,
        seq: Option<i64>,
    ) -> Result<String> {
        let command = match (throttle, brake, steer) {
            (None, None, None) => None,
            (throttle, brake, steer) => Some(VehicleControl {
                throttle: throttle.unwrap_or(0.0),
                brake: brake.unwrap_or(0.0),
                steer: steer.unwrap_or(0.0),
                handbrake: handbrake.unwrap_or(false),
            }),
        };
        self.inner
            .set_driver_command(
                client_id.as_deref().unwrap_or("node"),
                seq.unwrap_or(0).max(0) as u64,
                &actor_id,
                command,
            )
            .js()
    }
    /// Advance engine ticks; returns the `AdvanceResult` JSON.
    #[napi]
    pub fn advance(&mut self, ticks: u32) -> Result<String> {
        self.inner.advance_json(ticks as usize).js()
    }
    #[napi]
    pub fn snapshot(&mut self) -> JsWorldSnapshot {
        let view = self.inner.snapshot();
        JsWorldSnapshot {
            t_s: view.t_s(),
            tick: view.tick() as u32,
            done: view.done(),
            actor_ids: view.actor_ids(),
            kinds: view.kinds().into_iter().map(str::to_owned).collect(),
            lane_rsls: view.lane_rsls(),
            present: Uint8Array::new(view.present().iter().map(|p| u8::from(*p)).collect()),
            pose: Float64Array::new(view.pose().to_vec()),
        }
    }
    #[napi]
    pub fn subscribe(&mut self, capacity: Option<u32>) -> Result<JsTruthSubscription> {
        Ok(JsTruthSubscription {
            inner: self.inner.subscribe(capacity.map(|c| c as usize)).js()?,
        })
    }
    #[napi]
    pub fn log_json(&self) -> Result<String> {
        self.inner.log_json().js()
    }
    #[napi]
    pub fn checkpoint(&self) -> Result<Buffer> {
        Ok(self.inner.checkpoint().js()?.into())
    }
    #[napi]
    pub fn restore(&mut self, checkpoint: Buffer) -> Result<()> {
        self.inner.restore(&checkpoint).js()
    }
}

#[napi]
pub fn replay_world_log(
    log_json: String,
    input: &JsScenarioInput,
    graph: &JsLaneGraph,
) -> Result<String> {
    rt::replay_world_log_json(&log_json, &input.inner, &graph.inner).js()
}

/* --------------------------------------------------------- simulation */

/// Bare engine world: explicit per-actor action batches, no episode semantics.
#[napi(js_name = "Simulation")]
pub struct JsSimulation {
    inner: Sim,
}

#[napi]
impl JsSimulation {
    #[napi(constructor)]
    pub fn new(
        input: &JsScenarioInput,
        graph: &JsLaneGraph,
        options_json: Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            inner: Sim::new(&input.inner, &graph.inner, options_json.as_deref()).js()?,
        })
    }
    #[napi(getter)]
    pub fn t_s(&self) -> f64 {
        self.inner.t_s()
    }
    #[napi(getter)]
    pub fn dt_s(&self) -> f64 {
        self.inner.dt_s()
    }
    #[napi(getter)]
    pub fn tick_index(&self) -> i64 {
        self.inner.tick_index() as i64
    }
    #[napi(getter)]
    pub fn done(&self) -> bool {
        self.inner.done()
    }
    /// The completed run's `SimResult` JSON (`{input, trace, issues, arrival}`); errors until `done`.
    #[napi]
    pub fn result_json(&mut self) -> Result<String> {
        self.inner.result_json().js()
    }
    /// Recorded trace prefix; does not advance or finalize the simulation.
    #[napi]
    pub fn trace_json(&self) -> Result<String> {
        self.inner.trace_json().js()
    }
    #[napi]
    pub fn input_json(&self) -> Result<String> {
        self.inner.input_json().js()
    }
    #[napi]
    pub fn issues_json(&self) -> Result<String> {
        self.inner.issues_json().js()
    }
    #[napi]
    pub fn arrival_json(&self) -> Result<String> {
        self.inner.arrival_json().js()
    }
    #[napi(getter)]
    pub fn actor_count(&self) -> u32 {
        self.inner.actor_count() as u32
    }
    #[napi(getter)]
    pub fn actor_ids(&self) -> Vec<String> {
        self.inner.actor_ids()
    }
    #[napi(getter)]
    pub fn actor_kinds(&self) -> Vec<String> {
        self.inner
            .actor_kinds()
            .into_iter()
            .map(str::to_owned)
            .collect()
    }
    /// `Float64Array(N * 3)` rows `[l, w, h]`.
    #[napi(getter)]
    pub fn actor_dims(&self) -> Float64Array {
        Float64Array::new(self.inner.actor_dims())
    }
    #[napi]
    pub fn actor_index(&self, id: String) -> Result<u32> {
        Ok(self.inner.actor_index(&id).js()? as u32)
    }
    /// `actions` is `Float64Array(K * (1 + ACTION_WIDTH))` rows `[actorIndex, ...action]`; returns `[ticksAdvanced, done ? 1 : 0]`.
    #[napi]
    pub fn advance(&mut self, max_ticks: u32, actions: Option<Float64Array>) -> Result<Vec<u32>> {
        let (ticks, done) = self
            .inner
            .advance(max_ticks as usize, actions.as_deref().unwrap_or(&[]))
            .js()?;
        Ok(vec![ticks as u32, u32::from(done)])
    }
    /// `Float64Array(N * ACTOR_ROW)` rows `[x, y, headingRad, speedMps, accelMps2, lateralOffsetM, lateralRateMps, s]` (xodr-local).
    #[napi]
    pub fn actors(&self) -> Float64Array {
        Float64Array::new(self.inner.actor_rows().to_vec())
    }
    #[napi]
    pub fn present(&self) -> Uint8Array {
        Uint8Array::new(self.inner.present().iter().map(|p| u8::from(*p)).collect())
    }
    #[napi]
    pub fn lane_rsls(&self) -> Vec<Option<String>> {
        self.inner.lane_rsls().to_vec()
    }
    #[napi]
    pub fn minima_json(&self) -> Result<String> {
        self.inner.minima_json().js()
    }
    #[napi]
    pub fn drain_events_json(&mut self) -> Result<String> {
        self.inner.drain_events_json().js()
    }
    #[napi]
    pub fn signal_state_json(&self) -> Result<String> {
        self.inner.signal_state_json().js()
    }
    #[napi]
    pub fn checkpoint(&self) -> Result<Buffer> {
        Ok(self.inner.checkpoint().js()?.into())
    }
    #[napi]
    pub fn restore(&mut self, checkpoint: Buffer) -> Result<()> {
        self.inner.restore(&checkpoint).js()
    }
}

/* ------------------------------------------------------------ handoff */

/// Contact-ownership handoff between an external traffic provider (browser SUMO) and the native contact solver.
/// Poses are scene ground-plane `x/z`; released bodies stay owned until `clear()`.
#[napi(js_name = "TrafficHandoff")]
pub struct JsTrafficHandoff {
    inner: Handoff,
}

impl Default for JsTrafficHandoff {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl JsTrafficHandoff {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Handoff::new(),
        }
    }
    /// `StaticMapCollider[]` JSON (scene-frame OBBs) released bodies collide with; retained across `clear()`.
    #[napi]
    pub fn set_static_colliders(&mut self, colliders_json: String) -> Result<()> {
        self.inner.set_static_colliders_json(&colliders_json).js()
    }
    /// Return every actor to its owner.
    #[napi]
    pub fn clear(&mut self) {
        self.inner.clear();
    }
    /// One provider interval. `authored`/`traffic` are `Float64Array(N * HANDOFF_ACTOR_ROW)` rows
    /// `[x, z, headingRad, speedMps, lengthM, widthM, present, static]` with one id and kind per row.
    /// Returns the number of traffic actors released to physics during this step.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        dt_s: f64,
        authored_ids: Vec<String>,
        authored_kinds: Vec<String>,
        authored: Float64Array,
        traffic_ids: Vec<String>,
        traffic_kinds: Vec<String>,
        traffic: Float64Array,
    ) -> Result<u32> {
        Ok(self
            .inner
            .step(
                dt_s,
                &authored_ids,
                &authored_kinds,
                &authored,
                &traffic_ids,
                &traffic_kinds,
                &traffic,
            )
            .js()? as u32)
    }
    #[napi(getter)]
    pub fn body_count(&self) -> u32 {
        self.inner.body_count() as u32
    }
    /// Traffic actors currently owned by physics.
    #[napi(getter)]
    pub fn traffic_body_count(&self) -> u32 {
        self.inner.traffic_body_count() as u32
    }
    /// Released body ids in `bodies()` row order.
    #[napi]
    pub fn body_ids(&self) -> Vec<String> {
        self.inner.body_ids()
    }
    /// `Float64Array(N * HANDOFF_BODY_ROW)` rows `[origin, x, z, headingRad, speedMps, angularVelocityRadS]`; `origin` 0 = traffic, 1 = authored.
    #[napi]
    pub fn bodies(&self) -> Float64Array {
        Float64Array::new(self.inner.body_rows().to_vec())
    }
}

/* -------------------------------------------------------------- trace */

#[napi(js_name = "Trace")]
pub struct JsTrace {
    inner: Trace,
}

#[napi]
impl JsTrace {
    /// Parse plain or gzip current-format trace JSON; older formats are rejected.
    #[napi(factory)]
    pub fn parse(data: Uint8Array) -> Result<Self> {
        Ok(Self {
            inner: Trace::parse(&data).js()?,
        })
    }
    #[napi]
    pub fn digest(&self) -> Result<String> {
        self.inner.digest().js()
    }
    #[napi]
    pub fn to_json(&self) -> Result<String> {
        self.inner.to_json().js()
    }
    #[napi]
    pub fn scene_state_json(&self) -> Result<String> {
        self.inner.scene_state_json().js()
    }
    #[napi]
    pub fn metrics_json(&self) -> Result<String> {
        self.inner.metrics_json().js()
    }
    #[napi]
    pub fn evaluate_json(&self, filters_json: Option<String>) -> Result<String> {
        self.inner.evaluate_json(filters_json.as_deref()).js()
    }
    /// `IntentEvaluation` JSON for an intent rubric document.
    #[napi]
    pub fn intent_rubric_json(&self, rubric_json: String) -> Result<String> {
        self.inner.intent_rubric_json(&rubric_json).js()
    }
    /// `BlindReviewPacket` JSON.
    #[napi]
    pub fn blind_review_packet_json(&self, rubric_json: String) -> Result<String> {
        self.inner.blind_review_packet_json(&rubric_json).js()
    }
    /// `BehaviorSummary` JSON; `limitsJson` is an optional camelCase `BehaviorSummaryLimits`.
    #[napi]
    pub fn behavior_summary_json(&self, limits_json: Option<String>) -> Result<String> {
        self.inner
            .behavior_summary_json(limits_json.as_deref())
            .js()
    }
    /// `InvariantResidualReport[]` JSON; `optionsJson = {scope?: ExprScope, arrival?: ArrivalSolution[], speedLimitKph?}`.
    #[napi]
    pub fn invariants_json(
        &self,
        template_json: String,
        options_json: Option<String>,
    ) -> Result<String> {
        self.inner
            .invariants_json(&template_json, options_json.as_deref())
            .js()
    }
}

/* ------------------------------------------------------------- policy */

#[napi(object, js_name = "PolicyStepResult")]
pub struct JsPolicyStepResult {
    pub step: JsStepResult,
    pub deadline_limit_ms: Option<f64>,
    pub deadline_elapsed_ms: Option<f64>,
    pub deadline_miss: bool,
    /// `policy | repeat-last | zero-control | scripted`.
    pub applied: String,
    pub executor_json: Option<String>,
}

fn policy_result(outcome: &PolicyOutcome<'_>) -> Result<JsPolicyStepResult> {
    Ok(JsPolicyStepResult {
        step: step_result(&outcome.step)?,
        deadline_limit_ms: outcome.deadline.limit_ms,
        deadline_elapsed_ms: outcome.deadline.elapsed_ms,
        deadline_miss: outcome.deadline.miss,
        applied: outcome.applied_str().to_owned(),
        executor_json: outcome.executor_json().js()?,
    })
}

/// Deadline-accounted policy executor owning its `EnvSession`.
#[napi(js_name = "PolicySession")]
pub struct JsPolicySession {
    env: Env,
    policy: Policy,
}

#[napi]
impl JsPolicySession {
    #[napi(constructor)]
    pub fn new(
        input: &JsScenarioInput,
        graph: &JsLaneGraph,
        episode_json: Option<String>,
        deadline_ms: Option<f64>,
        fallback: Option<String>,
        execution: Option<String>,
        max_objects: Option<u32>,
    ) -> Result<Self> {
        let max_objects = max_objects.map_or(simforge_bindings_common::DEFAULT_MAX_OBJECTS, |m| {
            m as usize
        });
        Ok(Self {
            env: Env::new(
                &input.inner,
                &graph.inner,
                episode_json.as_deref(),
                max_objects,
            )
            .js()?,
            policy: Policy::new(
                deadline_ms,
                fallback.as_deref().unwrap_or("repeat-last"),
                execution.as_deref().unwrap_or("pure-pursuit"),
            )
            .js()?,
        })
    }
    #[napi(getter)]
    pub fn ego(&self) -> String {
        self.env.ego().to_owned()
    }
    #[napi(getter)]
    pub fn execution(&self) -> String {
        self.policy.execution_str().to_owned()
    }
    #[napi]
    pub fn reset(&mut self, seed: Option<Either<f64, String>>) -> Result<JsStepResult> {
        let seed = seed_of(seed)?;
        step_result(&self.policy.reset(&mut self.env, seed).js()?)
    }
    #[napi]
    pub fn act_control(
        &mut self,
        throttle: f64,
        brake: f64,
        steer: f64,
        elapsed_ms: Option<f64>,
    ) -> Result<JsPolicyStepResult> {
        policy_result(
            &self
                .policy
                .act_control(&mut self.env, throttle, brake, steer, elapsed_ms)
                .js()?,
        )
    }
    /// `points` is `Float64Array(K * 5)` rows `[x, y, headingRad, speedMps, tS]` in the ego frame at issuance.
    #[napi]
    pub fn act_trajectory(
        &mut self,
        points: Float64Array,
        elapsed_ms: Option<f64>,
    ) -> Result<JsPolicyStepResult> {
        policy_result(
            &self
                .policy
                .act_trajectory(&mut self.env, &points, elapsed_ms)
                .js()?,
        )
    }
    /// Env continuation state plus the executor's held plan / last applied action.
    #[napi]
    pub fn checkpoint(&self) -> Result<Buffer> {
        Ok(self.policy.checkpoint(&self.env).js()?.into())
    }
    #[napi]
    pub fn restore(&mut self, checkpoint: Buffer) -> Result<JsStepResult> {
        step_result(&self.policy.restore(&mut self.env, &checkpoint).js()?)
    }
    #[napi]
    pub fn ego_pose(&self) -> Result<Float64Array> {
        Ok(Float64Array::new(self.env.ego_pose().js()?.to_vec()))
    }
}
