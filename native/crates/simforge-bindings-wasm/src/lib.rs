//! `@simforge-oss/native-runtime/browser` — WASM binding of the portable CPU
//! subset: scenario parsing, in-memory map bundles, whole-clip simulation,
//! sessions, batches (single-threaded), live worlds and policy execution.
//!
//! Not available in the browser build and rejected explicitly: loading a map
//! corpus from the filesystem (`MapBundle.load`) and any GPU profile. There is
//! no TypeScript fallback behind these errors.

use js_sys::{Float32Array, Float64Array, Uint32Array, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use simforge_bindings_common::runtime::{
    self as rt, Batch, Compiled, Env, Handoff, MapAsset, Policy, PolicyOutcome, RouteHandle,
    Scenario, Sim, Site, StepView, Trace, World,
};
use simforge_bindings_common::{action, BindingError};
use simforge_core::rng::Seed;

fn to_js(err: BindingError) -> JsValue {
    let error = js_sys::Error::new(&err.to_string());
    error.set_name(&format!("SimForge{}Error", capitalize(err.kind().as_str())));
    let _ = js_sys::Reflect::set(&error, &"kind".into(), &err.kind().as_str().into());
    if let Some(issues) = err.issues_json() {
        let _ = js_sys::Reflect::set(&error, &"issuesJson".into(), &issues.into());
    }
    error.into()
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

trait JsResultExt<T> {
    fn js(self) -> Result<T, JsValue>;
}
impl<T> JsResultExt<T> for Result<T, BindingError> {
    fn js(self) -> Result<T, JsValue> {
        self.map_err(to_js)
    }
}

/// `number | string | null | undefined` → `Seed`.
fn seed_of(value: &JsValue) -> Result<Option<Seed>, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if let Some(text) = value.as_string() {
        return Ok(Some(Seed::Text(text)));
    }
    if let Some(number) = value.as_f64() {
        if !number.is_finite() {
            return Err(to_js(BindingError::argument("seed must be finite")));
        }
        return Ok(Some(Seed::Number(number)));
    }
    Err(to_js(BindingError::argument(
        "seed must be a number, string or null",
    )))
}

fn unsupported(what: &str) -> JsValue {
    to_js(BindingError::unsupported(format!(
        "{what} is not available in the browser WASM build"
    )))
}

#[wasm_bindgen(js_name = engineHz)]
pub fn engine_hz() -> u32 {
    simforge_bindings_common::ENGINE_HZ
}
#[wasm_bindgen(js_name = stateVectorSize)]
pub fn state_vector_size() -> u32 {
    simforge_bindings_common::STATE_VECTOR_SIZE as u32
}
#[wasm_bindgen(js_name = objectFeatures)]
pub fn object_features() -> u32 {
    simforge_bindings_common::OBJECT_FEATURES as u32
}
#[wasm_bindgen(js_name = actionWidth)]
pub fn action_width() -> u32 {
    action::ACTION_WIDTH as u32
}
#[wasm_bindgen(js_name = actionFields)]
pub fn action_fields() -> Vec<JsValue> {
    action::ACTION_FIELD_NAMES
        .iter()
        .map(|s| JsValue::from_str(s))
        .collect()
}
#[wasm_bindgen(js_name = engineVersion)]
pub fn engine_version() -> String {
    simforge_bindings_common::ENGINE_VERSION.to_owned()
}
#[wasm_bindgen(js_name = actorRow)]
pub fn actor_row() -> u32 {
    rt::ACTOR_ROW as u32
}
/// Row width of `TrafficHandoff.step` actor inputs.
#[wasm_bindgen(js_name = handoffActorRow)]
pub fn handoff_actor_row() -> u32 {
    rt::HANDOFF_ACTOR_ROW as u32
}
/// Row width of `TrafficHandoff.bodies()`.
#[wasm_bindgen(js_name = handoffBodyRow)]
pub fn handoff_body_row() -> u32 {
    rt::HANDOFF_BODY_ROW as u32
}
/// Binding ABI version; the JS loader refuses any other value.
#[wasm_bindgen(js_name = abiVersion)]
pub fn abi_version() -> u32 {
    simforge_bindings_common::ABI_VERSION
}
#[wasm_bindgen(js_name = canonicalJson)]
pub fn canonical_json(document: &str) -> Result<String, JsValue> {
    rt::canonical_json(document).js()
}
#[wasm_bindgen(js_name = contentHash)]
pub fn content_hash(document: &str) -> Result<String, JsValue> {
    rt::content_hash(document).js()
}
#[wasm_bindgen(js_name = sha256Hex)]
pub fn sha256_hex(data: &[u8]) -> String {
    rt::sha256_hex(data)
}

fn strings(v: Vec<String>) -> Vec<JsValue> {
    v.into_iter().map(JsValue::from).collect()
}

/* ------------------------------------------------------------ assets */

#[wasm_bindgen(js_name = LaneGraph)]
pub struct WasmLaneGraph {
    inner: rt::Graph,
}

#[wasm_bindgen(js_class = LaneGraph)]
impl WasmLaneGraph {
    #[wasm_bindgen(js_name = fromTopology)]
    pub fn from_topology(data: &[u8]) -> Result<WasmLaneGraph, JsValue> {
        Ok(Self {
            inner: rt::Graph::from_topology_bytes(data).js()?,
        })
    }
    #[wasm_bindgen(getter)]
    pub fn digest(&self) -> String {
        self.inner.topology_digest().to_owned()
    }
    #[wasm_bindgen(getter, js_name = byteDigest)]
    pub fn byte_digest(&self) -> String {
        self.inner.byte_digest().to_owned()
    }
    #[wasm_bindgen(getter, js_name = laneCount)]
    pub fn lane_count(&self) -> u32 {
        self.inner.lane_count() as u32
    }
    #[wasm_bindgen(getter, js_name = laneIds)]
    pub fn lane_ids(&self) -> Vec<JsValue> {
        strings(self.inner.lane_ids())
    }
    #[wasm_bindgen(js_name = laneLengthM)]
    pub fn lane_length_m(&self, rsl: &str) -> Result<f64, JsValue> {
        self.inner.lane_length_m(rsl).js()
    }
    /// `[rsl, s, d]` or `null`.
    #[wasm_bindgen(js_name = nearestLane)]
    pub fn nearest_lane(&self, x: f64, y: f64, max_dist_m: Option<f64>) -> JsValue {
        match self.inner.nearest_lane(x, y, max_dist_m.unwrap_or(25.0)) {
            None => JsValue::NULL,
            Some((rsl, s, d)) => {
                let arr = js_sys::Array::new();
                arr.push(&rsl.into());
                arr.push(&s.into());
                arr.push(&d.into());
                arr.into()
            }
        }
    }
    #[wasm_bindgen(js_name = laneWidthAt)]
    pub fn lane_width_at(&self, rsl: &str, s: f64) -> Result<f64, JsValue> {
        self.inner.lane_width_at(rsl, s).js()
    }
    /// `[x, y, headingRad]` at arc length `s` measured along the traversal direction (`reversed` = from the last polyline point, storage `len - s`).
    #[wasm_bindgen(js_name = sampleLane)]
    pub fn sample_lane(
        &self,
        rsl: &str,
        s: f64,
        reversed: Option<bool>,
    ) -> Result<Float64Array, JsValue> {
        Ok(Float64Array::from(
            &self
                .inner
                .sample_lane(rsl, s, reversed.unwrap_or(false))
                .js()?[..],
        ))
    }
    /// `[s, d]` projection of a point onto the lane polyline.
    #[wasm_bindgen(js_name = projectOntoLane)]
    pub fn project_onto_lane(&self, rsl: &str, x: f64, y: f64) -> Result<Float64Array, JsValue> {
        Ok(Float64Array::from(
            &self.inner.project_onto_lane(rsl, x, y).js()?[..],
        ))
    }
    /// `{lanes: string[], downstreamM}` or `null` when no route provides the runway.
    #[wasm_bindgen(js_name = defaultPlacementRoute)]
    pub fn default_placement_route(
        &self,
        start_rsl: &str,
        start_storage_s: f64,
        required_downstream_m: f64,
    ) -> Result<JsValue, JsValue> {
        match self
            .inner
            .default_placement_route(start_rsl, start_storage_s, required_downstream_m)
            .js()?
        {
            None => Ok(JsValue::NULL),
            Some((lanes, downstream_m)) => {
                let out = js_sys::Object::new();
                js_sys::Reflect::set(
                    &out,
                    &"lanes".into(),
                    &strings(lanes).into_iter().collect::<js_sys::Array>().into(),
                )?;
                js_sys::Reflect::set(&out, &"downstreamM".into(), &downstream_m.into())?;
                Ok(out.into())
            }
        }
    }
    /// Lane rsls walking successors consuming `turns`; `null` when `strictTurns` finds a turn unavailable.
    #[wasm_bindgen(js_name = followRoute)]
    pub fn follow_route(
        &self,
        start_rsl: &str,
        turns: Vec<String>,
        max_length_m: f64,
        start_reversed: Option<bool>,
        strict_turns: Option<bool>,
    ) -> Result<JsValue, JsValue> {
        Ok(
            match self
                .inner
                .follow_route(
                    start_rsl,
                    &turns,
                    max_length_m,
                    start_reversed,
                    strict_turns.unwrap_or(false),
                )
                .js()?
            {
                None => JsValue::NULL,
                Some(lanes) => strings(lanes).into_iter().collect::<js_sys::Array>().into(),
            },
        )
    }
    /// Resolve a `RouteSpec` document to a route handle; throws the `RouteBuildError` JSON on failure.
    pub fn route(&self, spec_json: &str) -> Result<WasmRoute, JsValue> {
        Ok(WasmRoute {
            inner: self.inner.route(spec_json).js()?,
        })
    }
    #[wasm_bindgen(js_name = turnRelationOf)]
    pub fn turn_relation_of(&self, rsl: &str) -> Result<Option<String>, JsValue> {
        Ok(self.inner.turn_relation_of(rsl).js()?.map(str::to_owned))
    }
    /// Directed successors as `[[rsl, reversed], ...]`.
    #[wasm_bindgen]
    pub fn successors(&self, rsl: &str, reversed: Option<bool>) -> Result<js_sys::Array, JsValue> {
        let out = js_sys::Array::new();
        for (id, rev) in self.inner.successors(rsl, reversed.unwrap_or(false)).js()? {
            let pair = js_sys::Array::new();
            pair.push(&id.into());
            pair.push(&rev.into());
            out.push(&pair);
        }
        Ok(out)
    }
    #[wasm_bindgen(js_name = nominalReversed)]
    pub fn nominal_reversed(&self, rsl: &str) -> Result<Option<bool>, JsValue> {
        self.inner.nominal_reversed(rsl).js()
    }
    #[wasm_bindgen(js_name = laneJson)]
    pub fn lane_json(&self, rsl: &str) -> Result<String, JsValue> {
        self.inner.lane_json(rsl).js()
    }
}

/// A resolved route: engine-frame geometry plus its persisted snapshot.
#[wasm_bindgen(js_name = Route)]
pub struct WasmRoute {
    inner: RouteHandle,
}

#[wasm_bindgen(js_class = Route)]
impl WasmRoute {
    #[wasm_bindgen(getter, js_name = lengthM)]
    pub fn length_m(&self) -> f64 {
        self.inner.length_m()
    }
    /// Empty for polyline routes.
    #[wasm_bindgen(getter, js_name = laneRsls)]
    pub fn lane_rsls(&self) -> Vec<JsValue> {
        strings(self.inner.lane_rsls().to_vec())
    }
    /// `[x, y, headingRad]` at arc length `s` (clamped).
    #[wasm_bindgen(js_name = poseAt)]
    pub fn pose_at(&self, s: f64) -> Float64Array {
        Float64Array::from(&self.inner.pose_at(s)[..])
    }
    #[wasm_bindgen(js_name = snapshotJson)]
    pub fn snapshot_json(&self) -> Result<String, JsValue> {
        self.inner.snapshot_json().js()
    }
}

#[wasm_bindgen(js_name = ScenarioInput)]
pub struct WasmScenarioInput {
    inner: Scenario,
}

#[wasm_bindgen(js_class = ScenarioInput)]
impl WasmScenarioInput {
    /// Validate a scenario JSON document (string or bytes).
    pub fn parse(document: JsValue) -> Result<WasmScenarioInput, JsValue> {
        let bytes: Vec<u8> = if let Some(text) = document.as_string() {
            text.into_bytes()
        } else if document.is_instance_of::<Uint8Array>() {
            Uint8Array::from(document).to_vec()
        } else {
            return Err(to_js(BindingError::argument(
                "document must be a string or Uint8Array",
            )));
        };
        Ok(Self {
            inner: Scenario::parse(&bytes).js()?,
        })
    }
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsValue> {
        self.inner.to_json().js()
    }
    #[wasm_bindgen(js_name = withSeed)]
    pub fn with_seed(&self, seed: JsValue) -> Result<WasmScenarioInput, JsValue> {
        let seed =
            seed_of(&seed)?.ok_or_else(|| to_js(BindingError::argument("seed is required")))?;
        Ok(Self {
            inner: self.inner.with_seed(seed),
        })
    }
    #[wasm_bindgen(js_name = withClipSeconds)]
    pub fn with_clip_seconds(&self, clip_seconds: f64) -> Result<WasmScenarioInput, JsValue> {
        Ok(Self {
            inner: self.inner.with_clip_seconds(clip_seconds).js()?,
        })
    }
    #[wasm_bindgen(getter, js_name = contentHash)]
    pub fn content_hash(&self) -> Result<String, JsValue> {
        self.inner.content_hash().js()
    }
    #[wasm_bindgen(getter, js_name = mapId)]
    pub fn map_id(&self) -> String {
        self.inner.input().map_id.clone()
    }
    #[wasm_bindgen(getter, js_name = seedJson)]
    pub fn seed_json(&self) -> String {
        self.inner.seed_json()
    }
    #[wasm_bindgen(getter, js_name = clipSeconds)]
    pub fn clip_seconds(&self) -> f64 {
        self.inner.input().clip_seconds
    }
    #[wasm_bindgen(getter, js_name = warmupSeconds)]
    pub fn warmup_seconds(&self) -> f64 {
        self.inner.input().warmup_seconds
    }
    #[wasm_bindgen(getter)]
    pub fn dt(&self) -> f64 {
        self.inner.input().dt
    }
    #[wasm_bindgen(getter, js_name = metricSubject)]
    pub fn metric_subject(&self) -> Option<String> {
        self.inner.input().metric_subject.clone()
    }
    #[wasm_bindgen(getter, js_name = actorIds)]
    pub fn actor_ids(&self) -> Vec<JsValue> {
        strings(self.inner.actor_ids())
    }
    #[wasm_bindgen(getter, js_name = physicsMode)]
    pub fn physics_mode(&self) -> String {
        self.inner.input().physics_mode().as_str().to_owned()
    }
}

#[wasm_bindgen(js_name = MapBundle)]
pub struct WasmMapBundle {
    inner: MapAsset,
}

#[wasm_bindgen(js_class = MapBundle)]
impl WasmMapBundle {
    /// Filesystem map corpora do not exist in the browser; fetch the artifacts
    /// and use `fromTopology` (or the Node binding).
    pub fn load(_path: &str) -> Result<WasmMapBundle, JsValue> {
        Err(unsupported("MapBundle.load (filesystem map corpus)"))
    }
    #[wasm_bindgen(js_name = fromTopology)]
    pub fn from_topology(map_id: &str, topology: &[u8]) -> Result<WasmMapBundle, JsValue> {
        Ok(Self {
            inner: MapAsset::from_topology_bytes(map_id, topology).js()?,
        })
    }
    /// Bundle from in-memory sources: `sourcesJson = {mapId, derived?, locations?, searchIndex?, xodr?, signalsGeojson?}` plus the topology sidecar bytes.
    #[wasm_bindgen(js_name = fromSources)]
    pub fn from_sources(sources_json: &str, topology: &[u8]) -> Result<WasmMapBundle, JsValue> {
        Ok(Self {
            inner: MapAsset::from_sources(sources_json, topology).js()?,
        })
    }
    #[wasm_bindgen(js_name = topologyJson)]
    pub fn topology_json(&self) -> Result<String, JsValue> {
        self.inner.topology_json().js()
    }
    #[wasm_bindgen(js_name = signalCatalogJson)]
    pub fn signal_catalog_json(&self) -> Result<String, JsValue> {
        self.inner.signal_catalog_json().js()
    }
    #[wasm_bindgen(js_name = signalControlIndexJson)]
    pub fn signal_control_index_json(&self) -> Result<String, JsValue> {
        self.inner.signal_control_index_json().js()
    }
    #[wasm_bindgen(js_name = indexJson)]
    pub fn index_json(&self) -> Result<String, JsValue> {
        self.inner.index_json().js()
    }
    #[wasm_bindgen(js_name = staticColliderDiagnosticsJson)]
    pub fn static_collider_diagnostics_json(&self) -> Result<String, JsValue> {
        self.inner.static_collider_diagnostics_json().js()
    }
    #[wasm_bindgen(js_name = siteSignalPlanJson)]
    pub fn site_signal_plan_json(&self, site: &WasmSite) -> Result<String, JsValue> {
        self.inner.site_signal_plan_json(&site.inner).js()
    }
    #[wasm_bindgen(js_name = resolveSiteSignalProgram)]
    pub fn resolve_site_signal_program(
        &self,
        site: &WasmSite,
        ref_json: &str,
    ) -> Result<Option<String>, JsValue> {
        self.inner
            .resolve_site_signal_program(&site.inner, ref_json)
            .js()
    }
    #[wasm_bindgen(getter, js_name = mapId)]
    pub fn map_id(&self) -> String {
        self.inner.map_id().to_owned()
    }
    #[wasm_bindgen(getter)]
    pub fn digest(&self) -> String {
        self.inner.digest().to_owned()
    }
    #[wasm_bindgen(getter)]
    pub fn graph(&self) -> WasmLaneGraph {
        WasmLaneGraph {
            inner: self.inner.graph().clone(),
        }
    }
    #[wasm_bindgen(js_name = controlPlanJson)]
    pub fn control_plan_json(&self) -> Result<String, JsValue> {
        self.inner.control_plan_json().js()
    }
}

/// One grounded matched site (native handle; `toJson()` for the `MatchedSite` document).
#[wasm_bindgen(js_name = Site)]
pub struct WasmSite {
    inner: Site,
}

#[wasm_bindgen(js_class = Site)]
impl WasmSite {
    #[wasm_bindgen(getter, js_name = siteId)]
    pub fn site_id(&self) -> String {
        self.inner.site_id().to_owned()
    }
    #[wasm_bindgen(getter, js_name = mapId)]
    pub fn map_id(&self) -> String {
        self.inner.map_id().to_owned()
    }
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsValue> {
        self.inner.to_json().js()
    }
}

/// Resolve one site: `siteId = null` picks the top-ranked site.
#[wasm_bindgen(js_name = findSite)]
pub fn find_site(
    template_json: &str,
    bundle: &WasmMapBundle,
    site_id: Option<String>,
) -> Result<WasmSite, JsValue> {
    Ok(WasmSite {
        inner: rt::find_site(template_json, &bundle.inner, site_id.as_deref()).js()?,
    })
}

#[wasm_bindgen(js_name = CompileResult)]
pub struct WasmCompileResult {
    inner: Compiled,
}

#[wasm_bindgen(js_class = CompileResult)]
impl WasmCompileResult {
    #[wasm_bindgen(getter)]
    pub fn input(&self) -> WasmScenarioInput {
        WasmScenarioInput {
            inner: self.inner.scenario.clone(),
        }
    }
    #[wasm_bindgen(getter, js_name = manifestJson)]
    pub fn manifest_json(&self) -> String {
        self.inner.manifest_json().to_owned()
    }
    #[wasm_bindgen(getter, js_name = observationsJson)]
    pub fn observations_json(&self) -> String {
        self.inner.observations_json().to_owned()
    }
}

/// `site = null` picks the top-ranked matched site; map-bound documents skip matching.
#[wasm_bindgen(js_name = compileTemplate)]
pub fn compile_template(
    template_json: &str,
    bundle: &WasmMapBundle,
    site: Option<String>,
    seed: JsValue,
    options_json: Option<String>,
) -> Result<WasmCompileResult, JsValue> {
    let seed = seed_of(&seed)?;
    Ok(WasmCompileResult {
        inner: rt::compile_template(
            template_json,
            &bundle.inner,
            site.as_deref(),
            seed,
            options_json.as_deref(),
        )
        .js()?,
    })
}

/// Ranked `SiteMatch` JSON; `optionsJson = {minScore?, maxSites?, exactCatalogSiteResolution?}`.
#[wasm_bindgen(js_name = matchSites)]
pub fn match_sites(
    template_json: &str,
    bundle: &WasmMapBundle,
    options_json: Option<String>,
) -> Result<String, JsValue> {
    rt::match_sites(template_json, &bundle.inner, options_json.as_deref()).js()
}

/// Host policy for declared policy roles: `(contextJson) => actionJson | null`.
fn policy_callback(cb: &Option<js_sys::Function>) -> Option<Box<rt::PolicyCallback<'_>>> {
    cb.as_ref().map(|f| {
        Box::new(move |ctx: &str| {
            let out = f
                .call1(&JsValue::NULL, &JsValue::from_str(ctx))
                .map_err(|e| BindingError::Runtime(format!("{e:?}")))?;
            Ok(if out.is_null() || out.is_undefined() {
                None
            } else {
                out.as_string()
            })
        }) as Box<rt::PolicyCallback<'_>>
    })
}

/// `SituationRehearsal` JSON. `optionsJson = {materialize?, siteId?, geometryBindings?, runtime?}`.
#[wasm_bindgen(js_name = rehearseSituation)]
pub fn rehearse_situation(
    document_json: &str,
    bundle: &WasmMapBundle,
    options_json: Option<String>,
    policy: Option<js_sys::Function>,
) -> Result<String, JsValue> {
    let mut cb = policy_callback(&policy);
    rt::rehearse_situation_json(
        document_json,
        &bundle.inner,
        options_json.as_deref(),
        cb.as_deref_mut(),
    )
    .js()
}

/// `SituationSolveResult` JSON; `onEvaluation` receives each `{program, rehearsal}` JSON.
#[wasm_bindgen(js_name = solveSituation)]
pub fn solve_situation(
    document_json: &str,
    bundle: &WasmMapBundle,
    options_json: Option<String>,
    on_evaluation: Option<js_sys::Function>,
    policy: Option<js_sys::Function>,
) -> Result<String, JsValue> {
    let mut cb = policy_callback(&policy);
    let mut on_eval = on_evaluation.as_ref().map(|f| {
        move |doc: &str| -> std::result::Result<(), BindingError> {
            f.call1(&JsValue::NULL, &JsValue::from_str(doc))
                .map(|_| ())
                .map_err(|e| BindingError::Runtime(format!("{e:?}")))
        }
    });
    rt::solve_situation_json(
        document_json,
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
#[wasm_bindgen(js_name = compareSituation)]
pub fn compare_situation(
    document_json: &str,
    transaction_json: &str,
    bundle: &WasmMapBundle,
    options_json: Option<String>,
    policy: Option<js_sys::Function>,
) -> Result<String, JsValue> {
    let mut cb = policy_callback(&policy);
    rt::compare_situation_json(
        document_json,
        transaction_json,
        &bundle.inner,
        options_json.as_deref(),
        cb.as_deref_mut(),
    )
    .js()
}

/// `{templateId, paramsVersion}`: the replay-key identity of a template.
#[wasm_bindgen(js_name = templateIdentityJson)]
pub fn template_identity_json(template_json: &str) -> Result<String, JsValue> {
    rt::template_identity_json(template_json).js()
}

/// `AdaptNote[]` JSON (`{path, reason, severity, code?}`); needs no map.
#[wasm_bindgen(js_name = adaptTemplateNotesJson)]
pub fn adapt_template_notes_json(template_json: &str) -> Result<String, JsValue> {
    rt::adapt_template_notes_json(template_json).js()
}

/// `sha256(templateId|paramsVersion|siteId|drawIndex)`, the per-cell seed.
#[wasm_bindgen(js_name = cellSeed)]
pub fn cell_seed(
    template_id: &str,
    params_version: &str,
    site_id: &str,
    draw_index: f64,
) -> String {
    rt::cell_seed(template_id, params_version, site_id, draw_index as i64)
}

/// `SituationTransactionResult` JSON (no simulation).
#[wasm_bindgen(js_name = applySituationTransaction)]
pub fn apply_situation_transaction(
    document_json: &str,
    transaction_json: &str,
) -> Result<String, JsValue> {
    rt::apply_situation_transaction_json(document_json, transaction_json).js()
}

#[wasm_bindgen(js_name = findSites)]
pub fn find_sites(template_json: &str, bundle: &WasmMapBundle) -> Result<Vec<JsValue>, JsValue> {
    Ok(strings(rt::find_sites(template_json, &bundle.inner).js()?))
}

/// Returns `[ScenarioInput, boundSituationJson]`.
#[wasm_bindgen(js_name = compileSituation)]
pub fn compile_situation(
    document_json: &str,
    bundle: &WasmMapBundle,
    options_json: Option<String>,
) -> Result<js_sys::Array, JsValue> {
    let (scenario, program) =
        rt::compile_situation_json(document_json, &bundle.inner, options_json.as_deref()).js()?;
    let out = js_sys::Array::new();
    out.push(&WasmScenarioInput { inner: scenario }.into());
    out.push(&program.into());
    Ok(out)
}

/// Returns `[ScenarioInput, provenanceJson]`.
#[wasm_bindgen(js_name = materializeAmbientTraffic)]
pub fn materialize_ambient_traffic(
    input: &WasmScenarioInput,
    graph: &WasmLaneGraph,
    profile_json: &str,
    options_json: Option<String>,
) -> Result<js_sys::Array, JsValue> {
    let (scenario, provenance) = rt::materialize_ambient_traffic(
        &input.inner,
        &graph.inner,
        profile_json,
        options_json.as_deref(),
    )
    .js()?;
    let out = js_sys::Array::new();
    out.push(&WasmScenarioInput { inner: scenario }.into());
    out.push(&provenance.into());
    Ok(out)
}

/// The `t = 0` feasibility guards alone; `SimIssue[]` JSON (no clip run).
#[wasm_bindgen(js_name = checkFeasibility)]
pub fn check_feasibility(
    input: &WasmScenarioInput,
    graph: &WasmLaneGraph,
) -> Result<String, JsValue> {
    rt::check_feasibility_json(&input.inner, &graph.inner).js()
}

#[wasm_bindgen(js_name = runSimulation)]
pub fn run_simulation(
    input: &WasmScenarioInput,
    graph: &WasmLaneGraph,
    options_json: Option<String>,
) -> Result<String, JsValue> {
    rt::run_simulation_json(&input.inner, &graph.inner, options_json.as_deref()).js()
}

/* ------------------------------------------------------------ session */

/// One decision's result; typed arrays are owned copies.
#[wasm_bindgen(js_name = StepResult, getter_with_clone)]
pub struct WasmStepResult {
    #[wasm_bindgen(js_name = tS)]
    pub t_s: f64,
    pub reward: f64,
    pub terminated: bool,
    pub truncated: bool,
    #[wasm_bindgen(js_name = stateVector)]
    pub state_vector: Float64Array,
    pub objects: Float32Array,
    #[wasm_bindgen(js_name = objectCount)]
    pub object_count: u32,
    #[wasm_bindgen(js_name = objectIds)]
    pub object_ids: Vec<JsValue>,
    pub bev: Option<Float32Array>,
    #[wasm_bindgen(js_name = rewardTerms)]
    pub reward_terms: Float64Array,
    #[wasm_bindgen(js_name = infoJson)]
    pub info_json: String,
}

fn step_result(view: &StepView<'_>) -> Result<WasmStepResult, JsValue> {
    Ok(WasmStepResult {
        t_s: view.t_s(),
        reward: view.reward(),
        terminated: view.terminated(),
        truncated: view.truncated(),
        state_vector: Float64Array::from(view.state_vector()),
        objects: Float32Array::from(view.objects()),
        object_count: view.object_count() as u32,
        object_ids: strings(view.object_ids().to_vec()),
        bev: view.bev().map(|(_, data)| Float32Array::from(data)),
        reward_terms: Float64Array::from(&view.reward_terms()[..]),
        info_json: view.info_json().js()?,
    })
}

fn bev_shape(shape: Option<(usize, usize, usize)>) -> JsValue {
    match shape {
        None => JsValue::NULL,
        Some((h, w, c)) => Uint32Array::from(&[h as u32, w as u32, c as u32][..]).into(),
    }
}

#[wasm_bindgen(js_name = EnvSession)]
pub struct WasmEnvSession {
    inner: Env,
}

#[wasm_bindgen(js_class = EnvSession)]
impl WasmEnvSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        input: &WasmScenarioInput,
        graph: &WasmLaneGraph,
        episode_json: Option<String>,
        max_objects: Option<u32>,
    ) -> Result<WasmEnvSession, JsValue> {
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
    #[wasm_bindgen(getter)]
    pub fn ego(&self) -> String {
        self.inner.ego().to_owned()
    }
    #[wasm_bindgen(getter, js_name = decisionHz)]
    pub fn decision_hz(&self) -> u32 {
        self.inner.decision_hz()
    }
    #[wasm_bindgen(getter, js_name = decisionTicks)]
    pub fn decision_ticks(&self) -> u32 {
        self.inner.decision_ticks() as u32
    }
    #[wasm_bindgen(getter, js_name = clipSeconds)]
    pub fn clip_seconds(&self) -> f64 {
        self.inner.clip_seconds()
    }
    #[wasm_bindgen(getter, js_name = maxObjects)]
    pub fn max_objects(&self) -> u32 {
        self.inner.max_objects() as u32
    }
    /// `Uint32Array [height, width, channels]` or `null`.
    #[wasm_bindgen(getter, js_name = bevShape)]
    pub fn bev_shape(&self) -> JsValue {
        bev_shape(self.inner.bev_shape())
    }
    pub fn reset(&mut self, seed: JsValue) -> Result<WasmStepResult, JsValue> {
        let seed = seed_of(&seed)?;
        step_result(&self.inner.reset(seed).js()?)
    }
    /// `action`: `Float64Array(ACTION_WIDTH)` (NaN = unset) or `null`.
    pub fn step(&mut self, action: Option<Float64Array>) -> Result<WasmStepResult, JsValue> {
        let row = action.map(|a| a.to_vec());
        step_result(&self.inner.step(row.as_deref()).js()?)
    }
    pub fn checkpoint(&self) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(&self.inner.checkpoint().js()?[..]))
    }
    pub fn restore(&mut self, checkpoint: &[u8]) -> Result<WasmStepResult, JsValue> {
        step_result(&self.inner.restore(checkpoint).js()?)
    }
    #[wasm_bindgen(js_name = egoPose)]
    pub fn ego_pose(&self) -> Result<Float64Array, JsValue> {
        Ok(Float64Array::from(&self.inner.ego_pose().js()?[..]))
    }
    /// Actors in the world at the observation instant; throws before `reset()`.
    #[wasm_bindgen(getter, js_name = actorCount)]
    pub fn actor_count(&self) -> Result<u32, JsValue> {
        Ok(self.inner.actor_count().js()? as u32)
    }
    /// Canonical ids in snapshot order (the row order of `actors()`/`present()`/`actorDims`); throws before `reset()`.
    #[wasm_bindgen(getter, js_name = actorIds)]
    pub fn actor_ids(&self) -> Result<Vec<JsValue>, JsValue> {
        Ok(strings(self.inner.actor_ids().js()?))
    }
    #[wasm_bindgen(getter, js_name = actorKinds)]
    pub fn actor_kinds(&self) -> Result<Vec<JsValue>, JsValue> {
        Ok(self
            .inner
            .actor_kinds()
            .js()?
            .into_iter()
            .map(JsValue::from_str)
            .collect())
    }
    /// `Float64Array(N * 3)` rows `[l, w, h]`.
    #[wasm_bindgen(getter, js_name = actorDims)]
    pub fn actor_dims(&self) -> Result<Float64Array, JsValue> {
        Ok(Float64Array::from(&self.inner.actor_dims().js()?[..]))
    }
    /// `Float64Array(N * ACTOR_ROW)` rows `[x, y, headingRad, speedMps, accelMps2, lateralOffsetM, lateralRateMps, s]` (xodr-local) at the observation instant.
    pub fn actors(&self) -> Result<Float64Array, JsValue> {
        Ok(Float64Array::from(&self.inner.actor_rows().js()?[..]))
    }
    pub fn present(&self) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(
            &self
                .inner
                .actor_present()
                .js()?
                .into_iter()
                .map(u8::from)
                .collect::<Vec<u8>>()[..],
        ))
    }
    #[wasm_bindgen(js_name = signalBookJson)]
    pub fn signal_book_json(&self) -> Result<String, JsValue> {
        self.inner.signal_book_json().js()
    }
    /// The accumulated `CausalChannel` of the current episode as JSON.
    #[wasm_bindgen(js_name = causalChannelJson)]
    pub fn causal_channel_json(&self) -> Result<String, JsValue> {
        self.inner.causal_channel_json().js()
    }
}

/* -------------------------------------------------------------- batch */

#[wasm_bindgen(js_name = BatchResult, getter_with_clone)]
pub struct WasmBatchResult {
    pub size: u32,
    #[wasm_bindgen(js_name = tS)]
    pub t_s: Float64Array,
    pub reward: Float64Array,
    pub terminated: Uint8Array,
    pub truncated: Uint8Array,
    #[wasm_bindgen(js_name = stateVector)]
    pub state_vector: Float64Array,
    pub objects: Float32Array,
    #[wasm_bindgen(js_name = objectCount)]
    pub object_count: Uint32Array,
    #[wasm_bindgen(js_name = rewardTerms)]
    pub reward_terms: Float64Array,
    pub bev: Option<Float32Array>,
}

fn batch_result(batch: &Batch) -> WasmBatchResult {
    let flat = batch.flat();
    WasmBatchResult {
        size: batch.len() as u32,
        t_s: Float64Array::from(&flat.t_s[..]),
        reward: Float64Array::from(&flat.rewards[..]),
        terminated: Uint8Array::from(&flat.terminated[..]),
        truncated: Uint8Array::from(&flat.truncated[..]),
        state_vector: Float64Array::from(&flat.state[..]),
        objects: Float32Array::from(batch.objects_f32()),
        object_count: Uint32Array::from(&flat.object_counts[..]),
        reward_terms: Float64Array::from(batch.reward_terms()),
        bev: batch.bev_shape().map(|_| Float32Array::from(&flat.bev[..])),
    }
}

fn seeds_of(values: JsValue) -> Result<Option<Vec<Seed>>, JsValue> {
    if values.is_null() || values.is_undefined() {
        return Ok(None);
    }
    let arr = js_sys::Array::from(&values);
    let mut out = Vec::with_capacity(arr.length() as usize);
    for v in arr.iter() {
        out.push(
            seed_of(&v)?
                .ok_or_else(|| to_js(BindingError::argument("seeds must not contain null")))?,
        );
    }
    Ok(Some(out))
}

#[wasm_bindgen(js_name = SessionBatch)]
pub struct WasmSessionBatch {
    inner: Batch,
}

#[wasm_bindgen(js_class = SessionBatch)]
impl WasmSessionBatch {
    /// `inputs`/`graphs` are same-length arrays of `ScenarioInput`/`LaneGraph`.
    /// WASM has no threads: worlds step sequentially with identical results.
    #[wasm_bindgen(constructor)]
    pub fn new(
        inputs: Vec<WasmScenarioInput>,
        graphs: Vec<WasmLaneGraph>,
        episode_json: Option<String>,
        max_objects: Option<u32>,
    ) -> Result<WasmSessionBatch, JsValue> {
        let scenarios: Vec<Scenario> = inputs.into_iter().map(|s| s.inner).collect();
        let graphs: Vec<rt::Graph> = graphs.into_iter().map(|g| g.inner).collect();
        let max_objects = max_objects.map_or(simforge_bindings_common::DEFAULT_MAX_OBJECTS, |m| {
            m as usize
        });
        Ok(Self {
            inner: Batch::new(&scenarios, &graphs, episode_json.as_deref(), max_objects, 1).js()?,
        })
    }
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.inner.len() as u32
    }
    #[wasm_bindgen(getter)]
    pub fn egos(&self) -> Vec<JsValue> {
        strings(self.inner.egos())
    }
    #[wasm_bindgen(getter, js_name = decisionHz)]
    pub fn decision_hz(&self) -> u32 {
        self.inner.decision_hz()
    }
    #[wasm_bindgen(getter, js_name = maxObjects)]
    pub fn max_objects(&self) -> u32 {
        self.inner.max_objects() as u32
    }
    #[wasm_bindgen(getter, js_name = bevShape)]
    pub fn bev_shape(&self) -> JsValue {
        bev_shape(self.inner.bev_shape())
    }
    #[wasm_bindgen(js_name = resetAll)]
    pub fn reset_all(&mut self, seeds: JsValue) -> Result<WasmBatchResult, JsValue> {
        let seeds = seeds_of(seeds)?;
        self.inner.reset_all(seeds.as_deref()).js()?;
        Ok(batch_result(&self.inner))
    }
    #[wasm_bindgen(js_name = resetWorlds)]
    pub fn reset_worlds(
        &mut self,
        worlds: &[u32],
        seeds: JsValue,
    ) -> Result<WasmBatchResult, JsValue> {
        let worlds: Vec<usize> = worlds.iter().map(|w| *w as usize).collect();
        let seeds: Option<Vec<Option<Seed>>> = if seeds.is_null() || seeds.is_undefined() {
            None
        } else {
            Some(
                js_sys::Array::from(&seeds)
                    .iter()
                    .map(|v| seed_of(&v))
                    .collect::<Result<Vec<_>, _>>()?,
            )
        };
        self.inner.reset_worlds(&worlds, seeds.as_deref()).js()?;
        Ok(batch_result(&self.inner))
    }
    #[wasm_bindgen(js_name = stepBatch)]
    pub fn step_batch(
        &mut self,
        actions: &[f64],
        mask: Option<Vec<u8>>,
    ) -> Result<WasmBatchResult, JsValue> {
        let mask: Option<Vec<bool>> = mask.map(|m| m.into_iter().map(|v| v != 0).collect());
        self.inner.step_batch(actions, mask.as_deref()).js()?;
        Ok(batch_result(&self.inner))
    }
    #[wasm_bindgen(js_name = objectIds)]
    pub fn object_ids(&self, world: u32) -> Result<Vec<JsValue>, JsValue> {
        Ok(strings(self.inner.object_ids(world as usize).js()?))
    }
    #[wasm_bindgen(js_name = infoJson)]
    pub fn info_json(&self, world: u32) -> Result<String, JsValue> {
        self.inner.info_json(world as usize).js()
    }
    pub fn checkpoint(&self, world: u32) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(
            &self.inner.checkpoint(world as usize).js()?[..],
        ))
    }
    pub fn restore(&mut self, world: u32, checkpoint: &[u8]) -> Result<(), JsValue> {
        self.inner.restore(world as usize, checkpoint).js()
    }
}

/* -------------------------------------------------------------- world */

#[wasm_bindgen(js_name = WorldSnapshot, getter_with_clone)]
pub struct WasmWorldSnapshot {
    #[wasm_bindgen(js_name = tS)]
    pub t_s: f64,
    pub tick: u32,
    pub done: bool,
    #[wasm_bindgen(js_name = actorIds)]
    pub actor_ids: Vec<JsValue>,
    pub kinds: Vec<JsValue>,
    #[wasm_bindgen(js_name = laneRsls)]
    pub lane_rsls: Vec<JsValue>,
    pub present: Uint8Array,
    /// `(N, 5)` rows `[x, z, headingRad, speedMps, s]`, scene frame.
    pub pose: Float64Array,
}

#[wasm_bindgen(js_name = TruthSubscription)]
pub struct WasmTruthSubscription {
    inner: rt::TruthSubscriber,
}

#[wasm_bindgen(js_class = TruthSubscription)]
impl WasmTruthSubscription {
    pub fn drain(&mut self) -> Result<Vec<JsValue>, JsValue> {
        Ok(strings(self.inner.drain_json().js()?))
    }
    /// Every queued frame as `Uint8Array` = `u32le length || msgpack(TruthFrame)`.
    #[wasm_bindgen(js_name = drainFrames)]
    pub fn drain_frames(&mut self) -> Result<Vec<JsValue>, JsValue> {
        Ok(self
            .inner
            .drain_framed()
            .js()?
            .iter()
            .map(|f| Uint8Array::from(&f[..]).into())
            .collect())
    }
    #[wasm_bindgen(getter)]
    pub fn dropped(&self) -> f64 {
        self.inner.dropped() as f64
    }
    #[wasm_bindgen(getter)]
    pub fn queued(&self) -> u32 {
        self.inner.queued() as u32
    }
    #[wasm_bindgen(getter)]
    pub fn active(&self) -> bool {
        self.inner.is_active()
    }
    pub fn close(&self) {
        self.inner.close()
    }
}

#[wasm_bindgen(js_name = WorldSession)]
pub struct WasmWorldSession {
    inner: World,
}

#[wasm_bindgen(js_class = WorldSession)]
impl WasmWorldSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        input: &WasmScenarioInput,
        graph: &WasmLaneGraph,
        options_json: Option<String>,
    ) -> Result<WasmWorldSession, JsValue> {
        Ok(Self {
            inner: World::new(&input.inner, &graph.inner, options_json.as_deref()).js()?,
        })
    }
    #[wasm_bindgen(getter)]
    pub fn time(&self) -> f64 {
        self.inner.time()
    }
    #[wasm_bindgen(getter)]
    pub fn tick(&self) -> u32 {
        self.inner.tick() as u32
    }
    #[wasm_bindgen(getter)]
    pub fn digest(&self) -> String {
        self.inner.digest().to_owned()
    }
    pub fn command(
        &mut self,
        command_json: &str,
        client_id: Option<String>,
        seq: Option<f64>,
    ) -> Result<String, JsValue> {
        self.inner
            .command_json(
                client_id.as_deref().unwrap_or("browser"),
                seq.unwrap_or(0.0).max(0.0) as u64,
                command_json,
            )
            .js()
    }
    pub fn advance(&mut self, ticks: u32) -> Result<String, JsValue> {
        self.inner.advance_json(ticks as usize).js()
    }
    pub fn snapshot(&mut self) -> WasmWorldSnapshot {
        let view = self.inner.snapshot();
        WasmWorldSnapshot {
            t_s: view.t_s(),
            tick: view.tick() as u32,
            done: view.done(),
            actor_ids: strings(view.actor_ids()),
            kinds: view.kinds().into_iter().map(JsValue::from_str).collect(),
            lane_rsls: view
                .lane_rsls()
                .into_iter()
                .map(|l| l.map_or(JsValue::NULL, JsValue::from))
                .collect(),
            present: Uint8Array::from(
                &view
                    .present()
                    .iter()
                    .map(|p| u8::from(*p))
                    .collect::<Vec<u8>>()[..],
            ),
            pose: Float64Array::from(view.pose()),
        }
    }
    pub fn subscribe(&mut self, capacity: Option<u32>) -> Result<WasmTruthSubscription, JsValue> {
        Ok(WasmTruthSubscription {
            inner: self.inner.subscribe(capacity.map(|c| c as usize)).js()?,
        })
    }
    #[wasm_bindgen(js_name = logJson)]
    pub fn log_json(&self) -> Result<String, JsValue> {
        self.inner.log_json().js()
    }
    pub fn checkpoint(&self) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(&self.inner.checkpoint().js()?[..]))
    }
    pub fn restore(&mut self, checkpoint: &[u8]) -> Result<(), JsValue> {
        self.inner.restore(checkpoint).js()
    }
}

#[wasm_bindgen(js_name = replayWorldLog)]
pub fn replay_world_log(
    log_json: &str,
    input: &WasmScenarioInput,
    graph: &WasmLaneGraph,
) -> Result<String, JsValue> {
    rt::replay_world_log_json(log_json, &input.inner, &graph.inner).js()
}

/* --------------------------------------------------------- simulation */

#[wasm_bindgen(js_name = Simulation)]
pub struct WasmSimulation {
    inner: Sim,
}

#[wasm_bindgen(js_class = Simulation)]
impl WasmSimulation {
    #[wasm_bindgen(constructor)]
    pub fn new(
        input: &WasmScenarioInput,
        graph: &WasmLaneGraph,
        options_json: Option<String>,
    ) -> Result<WasmSimulation, JsValue> {
        Ok(Self {
            inner: Sim::new(&input.inner, &graph.inner, options_json.as_deref()).js()?,
        })
    }
    #[wasm_bindgen(getter, js_name = tS)]
    pub fn t_s(&self) -> f64 {
        self.inner.t_s()
    }
    #[wasm_bindgen(getter, js_name = dtS)]
    pub fn dt_s(&self) -> f64 {
        self.inner.dt_s()
    }
    #[wasm_bindgen(getter, js_name = tickIndex)]
    pub fn tick_index(&self) -> f64 {
        self.inner.tick_index() as f64
    }
    #[wasm_bindgen(getter)]
    pub fn done(&self) -> bool {
        self.inner.done()
    }
    /// The completed run's `SimResult` JSON; errors until `done`.
    #[wasm_bindgen(js_name = resultJson)]
    pub fn result_json(&mut self) -> Result<String, JsValue> {
        self.inner.result_json().js()
    }
    /// Recorded trace prefix; does not advance or finalize the simulation.
    #[wasm_bindgen(js_name = traceJson)]
    pub fn trace_json(&self) -> Result<String, JsValue> {
        self.inner.trace_json().js()
    }
    #[wasm_bindgen(js_name = inputJson)]
    pub fn input_json(&self) -> Result<String, JsValue> {
        self.inner.input_json().js()
    }
    #[wasm_bindgen(js_name = issuesJson)]
    pub fn issues_json(&self) -> Result<String, JsValue> {
        self.inner.issues_json().js()
    }
    #[wasm_bindgen(js_name = arrivalJson)]
    pub fn arrival_json(&self) -> Result<String, JsValue> {
        self.inner.arrival_json().js()
    }
    #[wasm_bindgen(getter, js_name = actorCount)]
    pub fn actor_count(&self) -> u32 {
        self.inner.actor_count() as u32
    }
    #[wasm_bindgen(getter, js_name = actorIds)]
    pub fn actor_ids(&self) -> Vec<JsValue> {
        strings(self.inner.actor_ids())
    }
    #[wasm_bindgen(getter, js_name = actorKinds)]
    pub fn actor_kinds(&self) -> Vec<JsValue> {
        self.inner
            .actor_kinds()
            .into_iter()
            .map(JsValue::from_str)
            .collect()
    }
    #[wasm_bindgen(getter, js_name = actorDims)]
    pub fn actor_dims(&self) -> Float64Array {
        Float64Array::from(&self.inner.actor_dims()[..])
    }
    #[wasm_bindgen(js_name = actorIndex)]
    pub fn actor_index(&self, id: &str) -> Result<u32, JsValue> {
        Ok(self.inner.actor_index(id).js()? as u32)
    }
    /// `actions`: `Float64Array(K * (1 + ACTION_WIDTH))` rows `[actorIndex, ...action]`; returns `[ticksAdvanced, done ? 1 : 0]`.
    pub fn advance(
        &mut self,
        max_ticks: u32,
        actions: Option<Float64Array>,
    ) -> Result<Uint32Array, JsValue> {
        let rows = actions.map(|a| a.to_vec()).unwrap_or_default();
        let (ticks, done) = self.inner.advance(max_ticks as usize, &rows).js()?;
        Ok(Uint32Array::from(&[ticks as u32, u32::from(done)][..]))
    }
    pub fn actors(&self) -> Float64Array {
        Float64Array::from(self.inner.actor_rows())
    }
    pub fn present(&self) -> Uint8Array {
        Uint8Array::from(
            &self
                .inner
                .present()
                .iter()
                .map(|p| u8::from(*p))
                .collect::<Vec<u8>>()[..],
        )
    }
    #[wasm_bindgen(js_name = laneRsls)]
    pub fn lane_rsls(&self) -> Vec<JsValue> {
        self.inner
            .lane_rsls()
            .iter()
            .map(|l| l.clone().map_or(JsValue::NULL, JsValue::from))
            .collect()
    }
    #[wasm_bindgen(js_name = minimaJson)]
    pub fn minima_json(&self) -> Result<String, JsValue> {
        self.inner.minima_json().js()
    }
    #[wasm_bindgen(js_name = drainEventsJson)]
    pub fn drain_events_json(&mut self) -> Result<String, JsValue> {
        self.inner.drain_events_json().js()
    }
    #[wasm_bindgen(js_name = signalStateJson)]
    pub fn signal_state_json(&self) -> Result<String, JsValue> {
        self.inner.signal_state_json().js()
    }
    pub fn checkpoint(&self) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(&self.inner.checkpoint().js()?[..]))
    }
    pub fn restore(&mut self, checkpoint: &[u8]) -> Result<(), JsValue> {
        self.inner.restore(checkpoint).js()
    }
}

/* ------------------------------------------------------------ handoff */

/// Contact-ownership handoff between an external traffic provider (browser
/// SUMO) and the native contact solver. Poses are scene ground-plane `x/z`;
/// released bodies stay owned until `clear()`.
#[wasm_bindgen(js_name = TrafficHandoff)]
pub struct WasmTrafficHandoff {
    inner: Handoff,
}

impl Default for WasmTrafficHandoff {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen(js_class = TrafficHandoff)]
impl WasmTrafficHandoff {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmTrafficHandoff {
        Self {
            inner: Handoff::new(),
        }
    }
    /// `StaticMapCollider[]` JSON (scene-frame OBBs) released bodies collide with; retained across `clear()`.
    #[wasm_bindgen(js_name = setStaticColliders)]
    pub fn set_static_colliders(&mut self, colliders_json: &str) -> Result<(), JsValue> {
        self.inner.set_static_colliders_json(colliders_json).js()
    }
    /// Return every actor to its owner.
    pub fn clear(&mut self) {
        self.inner.clear();
    }
    /// One provider interval. `authored`/`traffic` are `Float64Array(N * handoffActorRow())` rows
    /// `[x, z, headingRad, speedMps, lengthM, widthM, present, static]` with one id and kind per row.
    /// Returns the number of traffic actors released to physics during this step.
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        dt_s: f64,
        authored_ids: Vec<String>,
        authored_kinds: Vec<String>,
        authored: &[f64],
        traffic_ids: Vec<String>,
        traffic_kinds: Vec<String>,
        traffic: &[f64],
    ) -> Result<u32, JsValue> {
        Ok(self
            .inner
            .step(
                dt_s,
                &authored_ids,
                &authored_kinds,
                authored,
                &traffic_ids,
                &traffic_kinds,
                traffic,
            )
            .js()? as u32)
    }
    #[wasm_bindgen(getter, js_name = bodyCount)]
    pub fn body_count(&self) -> u32 {
        self.inner.body_count() as u32
    }
    /// Traffic actors currently owned by physics.
    #[wasm_bindgen(getter, js_name = trafficBodyCount)]
    pub fn traffic_body_count(&self) -> u32 {
        self.inner.traffic_body_count() as u32
    }
    /// Released body ids in `bodies()` row order.
    #[wasm_bindgen(js_name = bodyIds)]
    pub fn body_ids(&self) -> Vec<JsValue> {
        strings(self.inner.body_ids())
    }
    /// `Float64Array(N * handoffBodyRow())` rows `[origin, x, z, headingRad, speedMps, angularVelocityRadS]`; `origin` 0 = traffic, 1 = authored.
    pub fn bodies(&self) -> Float64Array {
        Float64Array::from(self.inner.body_rows())
    }
}

/* -------------------------------------------------------------- trace */

#[wasm_bindgen(js_name = Trace)]
pub struct WasmTrace {
    inner: Trace,
}

#[wasm_bindgen(js_class = Trace)]
impl WasmTrace {
    pub fn parse(data: &[u8]) -> Result<WasmTrace, JsValue> {
        Ok(Self {
            inner: Trace::parse(data).js()?,
        })
    }
    pub fn digest(&self) -> Result<String, JsValue> {
        self.inner.digest().js()
    }
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsValue> {
        self.inner.to_json().js()
    }
    #[wasm_bindgen(js_name = sceneStateJson)]
    pub fn scene_state_json(&self) -> Result<String, JsValue> {
        self.inner.scene_state_json().js()
    }
    #[wasm_bindgen(js_name = metricsJson)]
    pub fn metrics_json(&self) -> Result<String, JsValue> {
        self.inner.metrics_json().js()
    }
    #[wasm_bindgen(js_name = evaluateJson)]
    pub fn evaluate_json(&self, filters_json: Option<String>) -> Result<String, JsValue> {
        self.inner.evaluate_json(filters_json.as_deref()).js()
    }
    #[wasm_bindgen(js_name = intentRubricJson)]
    pub fn intent_rubric_json(&self, rubric_json: &str) -> Result<String, JsValue> {
        self.inner.intent_rubric_json(rubric_json).js()
    }
    #[wasm_bindgen(js_name = blindReviewPacketJson)]
    pub fn blind_review_packet_json(&self, rubric_json: &str) -> Result<String, JsValue> {
        self.inner.blind_review_packet_json(rubric_json).js()
    }
    #[wasm_bindgen(js_name = behaviorSummaryJson)]
    pub fn behavior_summary_json(&self, limits_json: Option<String>) -> Result<String, JsValue> {
        self.inner
            .behavior_summary_json(limits_json.as_deref())
            .js()
    }
    #[wasm_bindgen(js_name = invariantsJson)]
    pub fn invariants_json(
        &self,
        template_json: &str,
        options_json: Option<String>,
    ) -> Result<String, JsValue> {
        self.inner
            .invariants_json(template_json, options_json.as_deref())
            .js()
    }
}

/* ------------------------------------------------------------- policy */

#[wasm_bindgen(js_name = PolicyStepResult, getter_with_clone)]
pub struct WasmPolicyStepResult {
    pub step: WasmStepResult,
    #[wasm_bindgen(js_name = deadlineLimitMs)]
    pub deadline_limit_ms: Option<f64>,
    #[wasm_bindgen(js_name = deadlineElapsedMs)]
    pub deadline_elapsed_ms: Option<f64>,
    #[wasm_bindgen(js_name = deadlineMiss)]
    pub deadline_miss: bool,
    pub applied: String,
    #[wasm_bindgen(js_name = executorJson)]
    pub executor_json: Option<String>,
}

impl Clone for WasmStepResult {
    fn clone(&self) -> Self {
        Self {
            t_s: self.t_s,
            reward: self.reward,
            terminated: self.terminated,
            truncated: self.truncated,
            state_vector: self.state_vector.clone(),
            objects: self.objects.clone(),
            object_count: self.object_count,
            object_ids: self.object_ids.clone(),
            bev: self.bev.clone(),
            reward_terms: self.reward_terms.clone(),
            info_json: self.info_json.clone(),
        }
    }
}

fn policy_result(outcome: &PolicyOutcome<'_>) -> Result<WasmPolicyStepResult, JsValue> {
    Ok(WasmPolicyStepResult {
        step: step_result(&outcome.step)?,
        deadline_limit_ms: outcome.deadline.limit_ms,
        deadline_elapsed_ms: outcome.deadline.elapsed_ms,
        deadline_miss: outcome.deadline.miss,
        applied: outcome.applied_str().to_owned(),
        executor_json: outcome.executor_json().js()?,
    })
}

#[wasm_bindgen(js_name = PolicySession)]
pub struct WasmPolicySession {
    env: Env,
    policy: Policy,
}

#[wasm_bindgen(js_class = PolicySession)]
impl WasmPolicySession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        input: &WasmScenarioInput,
        graph: &WasmLaneGraph,
        episode_json: Option<String>,
        deadline_ms: Option<f64>,
        fallback: Option<String>,
        execution: Option<String>,
        max_objects: Option<u32>,
    ) -> Result<WasmPolicySession, JsValue> {
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
    #[wasm_bindgen(getter)]
    pub fn ego(&self) -> String {
        self.env.ego().to_owned()
    }
    #[wasm_bindgen(getter)]
    pub fn execution(&self) -> String {
        self.policy.execution_str().to_owned()
    }
    pub fn reset(&mut self, seed: JsValue) -> Result<WasmStepResult, JsValue> {
        let seed = seed_of(&seed)?;
        step_result(&self.policy.reset(&mut self.env, seed).js()?)
    }
    #[wasm_bindgen(js_name = actControl)]
    pub fn act_control(
        &mut self,
        throttle: f64,
        brake: f64,
        steer: f64,
        elapsed_ms: Option<f64>,
    ) -> Result<WasmPolicyStepResult, JsValue> {
        policy_result(
            &self
                .policy
                .act_control(&mut self.env, throttle, brake, steer, elapsed_ms)
                .js()?,
        )
    }
    #[wasm_bindgen(js_name = actTrajectory)]
    pub fn act_trajectory(
        &mut self,
        points: &[f64],
        elapsed_ms: Option<f64>,
    ) -> Result<WasmPolicyStepResult, JsValue> {
        policy_result(
            &self
                .policy
                .act_trajectory(&mut self.env, points, elapsed_ms)
                .js()?,
        )
    }
    pub fn checkpoint(&self) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(
            &self.policy.checkpoint(&self.env).js()?[..],
        ))
    }
    pub fn restore(&mut self, checkpoint: &[u8]) -> Result<WasmStepResult, JsValue> {
        step_result(&self.policy.restore(&mut self.env, checkpoint).js()?)
    }
    #[wasm_bindgen(js_name = egoPose)]
    pub fn ego_pose(&self) -> Result<Float64Array, JsValue> {
        Ok(Float64Array::from(&self.env.ego_pose().js()?[..]))
    }
}
