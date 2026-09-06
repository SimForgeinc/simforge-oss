//! `simforge_oss_gym._native` — the SimForge native runtime for Python.
//!
//! Every array returned is a fresh NumPy array the caller owns; the GIL is
//! released around stepping so batches run in parallel with Python-side work.
//! Metadata crosses as JSON `str` once per call; stepping never does.

use numpy::{
    IntoPyArray, PyArray1, PyArray2, PyArray3, PyArray4, PyArrayMethods, PyReadonlyArray1,
    PyReadonlyArray2, PyUntypedArrayMethods,
};
use pyo3::create_exception;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyTuple};

use simforge_bindings_common::runtime::{
    self as rt, Batch, Compiled, Env, MapAsset, Policy, PolicyOutcome, RouteHandle, Scenario, Sim,
    Site, StepView, Trace, World,
};
use simforge_bindings_common::{action, BindingError, ErrorKind};
use simforge_core::rng::Seed;

create_exception!(
    _native,
    NativeError,
    PyRuntimeError,
    "Base of every SimForge runtime error."
);
create_exception!(
    _native,
    SchemaError,
    NativeError,
    "The document violated the scenario/topology schema."
);
create_exception!(
    _native,
    EngineError,
    NativeError,
    "The engine rejected a validated document."
);
create_exception!(
    _native,
    SessionError,
    NativeError,
    "A session lifecycle rule was broken."
);
create_exception!(
    _native,
    UnsupportedError,
    NativeError,
    "Not available in this runtime."
);

fn to_py(err: BindingError) -> PyErr {
    let message = err.to_string();
    let issues = err.issues_json();
    let kind = err.kind();
    let exc = match kind {
        ErrorKind::Argument => PyValueError::new_err(message.clone()),
        ErrorKind::Schema => SchemaError::new_err(message.clone()),
        ErrorKind::Engine => EngineError::new_err(message.clone()),
        ErrorKind::Session => SessionError::new_err(message.clone()),
        ErrorKind::Unsupported => UnsupportedError::new_err(message.clone()),
        ErrorKind::Runtime => NativeError::new_err(message.clone()),
    };
    Python::attach(|py| {
        let value = exc.value(py);
        let _ = value.setattr("kind", kind.as_str());
        let _ = value.setattr("issues_json", issues);
    });
    exc
}

trait PyResultExt<T> {
    fn py(self) -> PyResult<T>;
}
impl<T> PyResultExt<T> for Result<T, BindingError> {
    fn py(self) -> PyResult<T> {
        self.map_err(to_py)
    }
}

/// `int | float | str | None` → `Seed`.
fn seed_of(value: Option<&Bound<'_, PyAny>>) -> PyResult<Option<Seed>> {
    let Some(value) = value else { return Ok(None) };
    if value.is_none() {
        return Ok(None);
    }
    if let Ok(text) = value.extract::<String>() {
        return Ok(Some(Seed::Text(text)));
    }
    if let Ok(number) = value.extract::<f64>() {
        if !number.is_finite() {
            return Err(PyValueError::new_err("seed must be finite"));
        }
        return Ok(Some(Seed::Number(number)));
    }
    Err(PyValueError::new_err(
        "seed must be an int, float, str or None",
    ))
}

fn seeds_of(values: Option<&Bound<'_, PyAny>>) -> PyResult<Option<Vec<Seed>>> {
    let Some(values) = values else {
        return Ok(None);
    };
    if values.is_none() {
        return Ok(None);
    }
    let mut out = Vec::new();
    for item in values.try_iter()? {
        let item = item?;
        out.push(seed_of(Some(&item))?.ok_or_else(|| {
            PyValueError::new_err(
                "seeds must not contain None; use reset_worlds for partial seeding",
            )
        })?);
    }
    Ok(Some(out))
}

fn seed_to_py<'py>(py: Python<'py>, seed_json: &str) -> PyResult<Bound<'py, PyAny>> {
    let value: serde_json::Value =
        serde_json::from_str(seed_json).map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    match value {
        serde_json::Value::String(s) => Ok(s.into_pyobject(py)?.into_any()),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.into_pyobject(py)?.into_any())
            } else {
                Ok(n.as_f64().unwrap_or(f64::NAN).into_pyobject(py)?.into_any())
            }
        }
        _ => Ok(py.None().into_bound(py)),
    }
}

fn shape3(shape: Option<(usize, usize, usize)>, py: Python<'_>) -> PyResult<Py<PyAny>> {
    match shape {
        None => Ok(py.None()),
        Some((h, w, c)) => Ok(PyTuple::new(py, [h, w, c])?.into_any().unbind()),
    }
}

/* ------------------------------------------------------------ assets */

#[pyclass(name = "LaneGraph", frozen)]
pub struct PyLaneGraph {
    inner: rt::Graph,
}

#[pymethods]
impl PyLaneGraph {
    #[staticmethod]
    fn from_topology(data: &[u8]) -> PyResult<Self> {
        Ok(Self {
            inner: rt::Graph::from_topology_bytes(data).py()?,
        })
    }
    #[getter]
    fn digest(&self) -> String {
        self.inner.topology_digest().to_owned()
    }
    #[getter]
    fn byte_digest(&self) -> String {
        self.inner.byte_digest().to_owned()
    }
    #[getter]
    fn lane_count(&self) -> usize {
        self.inner.lane_count()
    }
    #[getter]
    fn lane_ids(&self) -> Vec<String> {
        self.inner.lane_ids()
    }
    fn lane_length_m(&self, rsl: &str) -> PyResult<f64> {
        self.inner.lane_length_m(rsl).py()
    }
    #[pyo3(signature = (x, y, max_dist_m = 25.0))]
    fn nearest_lane(&self, x: f64, y: f64, max_dist_m: f64) -> Option<(String, f64, f64)> {
        self.inner.nearest_lane(x, y, max_dist_m)
    }
    fn lane_width_at(&self, rsl: &str, s: f64) -> PyResult<f64> {
        self.inner.lane_width_at(rsl, s).py()
    }
    #[pyo3(signature = (rsl, s, reversed = false))]
    fn sample_lane(&self, rsl: &str, s: f64, reversed: bool) -> PyResult<(f64, f64, f64)> {
        let [x, y, h] = self.inner.sample_lane(rsl, s, reversed).py()?;
        Ok((x, y, h))
    }
    fn project_onto_lane(&self, rsl: &str, x: f64, y: f64) -> PyResult<(f64, f64)> {
        let [s, d] = self.inner.project_onto_lane(rsl, x, y).py()?;
        Ok((s, d))
    }
    #[pyo3(signature = (rsl, reversed = false))]
    fn successors(&self, rsl: &str, reversed: bool) -> PyResult<Vec<(String, bool)>> {
        self.inner.successors(rsl, reversed).py()
    }
    fn nominal_reversed(&self, rsl: &str) -> PyResult<Option<bool>> {
        self.inner.nominal_reversed(rsl).py()
    }
    fn lane_json(&self, rsl: &str) -> PyResult<String> {
        self.inner.lane_json(rsl).py()
    }
    /// ``(lanes, downstream_m)`` or ``None`` when no route provides the runway.
    fn default_placement_route(
        &self,
        start_rsl: &str,
        start_storage_s: f64,
        required_downstream_m: f64,
    ) -> PyResult<Option<(Vec<String>, f64)>> {
        self.inner
            .default_placement_route(start_rsl, start_storage_s, required_downstream_m)
            .py()
    }
    /// Lane rsls walking successors consuming ``turns``; ``None`` when ``strict_turns`` finds a turn unavailable.
    #[pyo3(signature = (start_rsl, turns, max_length_m, start_reversed = None, strict_turns = false))]
    fn follow_route(
        &self,
        start_rsl: &str,
        turns: Vec<String>,
        max_length_m: f64,
        start_reversed: Option<bool>,
        strict_turns: bool,
    ) -> PyResult<Option<Vec<String>>> {
        self.inner
            .follow_route(
                start_rsl,
                &turns,
                max_length_m,
                start_reversed,
                strict_turns,
            )
            .py()
    }
    /// Resolve a ``RouteSpec`` document to a route handle.
    fn route(&self, spec_json: &str) -> PyResult<PyRoute> {
        Ok(PyRoute {
            inner: self.inner.route(spec_json).py()?,
        })
    }
    fn turn_relation_of(&self, rsl: &str) -> PyResult<Option<String>> {
        Ok(self.inner.turn_relation_of(rsl).py()?.map(str::to_owned))
    }
}

/// A resolved route: engine-frame geometry plus its persisted snapshot.
#[pyclass(name = "Route", frozen)]
pub struct PyRoute {
    inner: RouteHandle,
}

#[pymethods]
impl PyRoute {
    #[getter]
    fn length_m(&self) -> f64 {
        self.inner.length_m()
    }
    #[getter]
    fn lane_rsls(&self) -> Vec<String> {
        self.inner.lane_rsls().to_vec()
    }
    /// ``(x, y, heading_rad)`` at arc length ``s`` (clamped).
    fn pose_at(&self, s: f64) -> (f64, f64, f64) {
        let [x, y, h] = self.inner.pose_at(s);
        (x, y, h)
    }
    fn snapshot_json(&self) -> PyResult<String> {
        self.inner.snapshot_json().py()
    }
}

#[pyclass(name = "ScenarioInput", frozen)]
pub struct PyScenarioInput {
    inner: Scenario,
}

#[pymethods]
impl PyScenarioInput {
    #[staticmethod]
    fn parse(document: &Bound<'_, PyAny>) -> PyResult<Self> {
        let bytes: Vec<u8> = if let Ok(text) = document.extract::<String>() {
            text.into_bytes()
        } else {
            document.extract::<Vec<u8>>()?
        };
        Ok(Self {
            inner: Scenario::parse(&bytes).py()?,
        })
    }
    fn to_json(&self) -> PyResult<String> {
        self.inner.to_json().py()
    }
    fn with_seed(&self, seed: &Bound<'_, PyAny>) -> PyResult<Self> {
        let seed = seed_of(Some(seed))?.ok_or_else(|| PyValueError::new_err("seed is required"))?;
        Ok(Self {
            inner: self.inner.with_seed(seed),
        })
    }
    fn with_clip_seconds(&self, clip_seconds: f64) -> PyResult<Self> {
        Ok(Self {
            inner: self.inner.with_clip_seconds(clip_seconds).py()?,
        })
    }
    #[getter]
    fn content_hash(&self) -> PyResult<String> {
        self.inner.content_hash().py()
    }
    #[getter]
    fn map_id(&self) -> String {
        self.inner.input().map_id.clone()
    }
    #[getter]
    fn seed<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        seed_to_py(py, &self.inner.seed_json())
    }
    #[getter]
    fn clip_seconds(&self) -> f64 {
        self.inner.input().clip_seconds
    }
    #[getter]
    fn warmup_seconds(&self) -> f64 {
        self.inner.input().warmup_seconds
    }
    #[getter]
    fn dt(&self) -> f64 {
        self.inner.input().dt
    }
    #[getter]
    fn metric_subject(&self) -> Option<String> {
        self.inner.input().metric_subject.clone()
    }
    #[getter]
    fn actor_ids(&self) -> Vec<String> {
        self.inner.actor_ids()
    }
    #[getter]
    fn physics_mode(&self) -> String {
        self.inner.input().physics_mode().as_str().to_owned()
    }
}

#[pyclass(name = "MapBundle", frozen)]
pub struct PyMapBundle {
    inner: MapAsset,
}

#[pymethods]
impl PyMapBundle {
    #[staticmethod]
    fn load(path: &str) -> PyResult<Self> {
        Ok(Self {
            inner: MapAsset::load(std::path::Path::new(path)).py()?,
        })
    }
    #[staticmethod]
    fn from_topology(map_id: &str, topology: &[u8]) -> PyResult<Self> {
        Ok(Self {
            inner: MapAsset::from_topology_bytes(map_id, topology).py()?,
        })
    }
    /// Bundle from in-memory sources: ``sources_json = {mapId, derived?, locations?, searchIndex?, xodr?, signalsGeojson?}`` plus the topology sidecar bytes.
    #[staticmethod]
    fn from_sources(sources_json: &str, topology: &[u8]) -> PyResult<Self> {
        Ok(Self {
            inner: MapAsset::from_sources(sources_json, topology).py()?,
        })
    }
    fn topology_json(&self) -> PyResult<String> {
        self.inner.topology_json().py()
    }
    fn signal_catalog_json(&self) -> PyResult<String> {
        self.inner.signal_catalog_json().py()
    }
    fn signal_control_index_json(&self) -> PyResult<String> {
        self.inner.signal_control_index_json().py()
    }
    fn index_json(&self) -> PyResult<String> {
        self.inner.index_json().py()
    }
    fn static_collider_diagnostics_json(&self) -> PyResult<String> {
        self.inner.static_collider_diagnostics_json().py()
    }
    /// ``SiteSignalPlan`` JSON for the site's origin junction.
    fn site_signal_plan_json(&self, site: &PySite) -> PyResult<String> {
        self.inner.site_signal_plan_json(&site.inner).py()
    }
    /// Resolve ``{"handle": id}`` | ``{"featureId", "approach"}`` to a concrete program id, or ``None``.
    fn resolve_site_signal_program(
        &self,
        site: &PySite,
        ref_json: &str,
    ) -> PyResult<Option<String>> {
        self.inner
            .resolve_site_signal_program(&site.inner, ref_json)
            .py()
    }
    #[getter]
    fn map_id(&self) -> String {
        self.inner.map_id().to_owned()
    }
    #[getter]
    fn digest(&self) -> String {
        self.inner.digest().to_owned()
    }
    #[getter]
    fn graph(&self) -> PyLaneGraph {
        PyLaneGraph {
            inner: self.inner.graph().clone(),
        }
    }
    fn control_plan_json(&self) -> PyResult<String> {
        self.inner.control_plan_json().py()
    }
}

/// One grounded matched site (native handle; ``to_json()`` for the ``MatchedSite`` document).
#[pyclass(name = "Site", frozen)]
pub struct PySite {
    inner: Site,
}

#[pymethods]
impl PySite {
    #[getter]
    fn site_id(&self) -> String {
        self.inner.site_id().to_owned()
    }
    #[getter]
    fn map_id(&self) -> String {
        self.inner.map_id().to_owned()
    }
    fn to_json(&self) -> PyResult<String> {
        self.inner.to_json().py()
    }
}

/// Resolve one site: ``site_id=None`` picks the top-ranked site.
#[pyfunction]
#[pyo3(signature = (template_json, bundle, site_id = None))]
fn find_site(template_json: &str, bundle: &PyMapBundle, site_id: Option<&str>) -> PyResult<PySite> {
    Ok(PySite {
        inner: rt::find_site(template_json, &bundle.inner, site_id).py()?,
    })
}

#[pyclass(name = "CompileResult", frozen)]
pub struct PyCompileResult {
    inner: Compiled,
}

#[pymethods]
impl PyCompileResult {
    #[getter]
    fn input(&self) -> PyScenarioInput {
        PyScenarioInput {
            inner: self.inner.scenario.clone(),
        }
    }
    #[getter]
    fn manifest_json(&self) -> String {
        self.inner.manifest_json().to_owned()
    }
    #[getter]
    fn observations_json(&self) -> String {
        self.inner.observations_json().to_owned()
    }
}

/// ``site=None`` picks the top-ranked matched site; map-bound documents skip matching.
#[pyfunction]
#[pyo3(signature = (template_json, bundle, site = None, *, seed = None, options_json = None))]
fn compile_template(
    template_json: &str,
    bundle: &PyMapBundle,
    site: Option<&str>,
    seed: Option<&Bound<'_, PyAny>>,
    options_json: Option<&str>,
) -> PyResult<PyCompileResult> {
    let seed = seed_of(seed)?;
    Ok(PyCompileResult {
        inner: rt::compile_template(template_json, &bundle.inner, site, seed, options_json).py()?,
    })
}

/// Ranked ``SiteMatch`` JSON; ``options_json = {minScore?, maxSites?, exactCatalogSiteResolution?}``.
#[pyfunction]
#[pyo3(signature = (template_json, bundle, options_json = None))]
fn match_sites(
    template_json: &str,
    bundle: &PyMapBundle,
    options_json: Option<&str>,
) -> PyResult<String> {
    rt::match_sites(template_json, &bundle.inner, options_json).py()
}

/// Host policy for declared policy roles: ``callable(context_json) -> action_json | None``.
fn policy_callback<'a>(cb: &'a Option<Bound<'a, PyAny>>) -> Option<Box<rt::PolicyCallback<'a>>> {
    cb.as_ref().map(|f| {
        Box::new(move |ctx: &str| {
            let out = f
                .call1((ctx,))
                .map_err(|e| BindingError::Runtime(e.to_string()))?;
            out.extract::<Option<String>>().map_err(|e| {
                BindingError::Runtime(format!("policy callback must return str or None: {e}"))
            })
        }) as Box<rt::PolicyCallback<'a>>
    })
}

/// ``SituationRehearsal`` JSON. ``options_json = {materialize?, siteId?, geometryBindings?, runtime?}``.
#[pyfunction]
#[pyo3(signature = (document_json, bundle, options_json = None, policy = None))]
fn rehearse_situation(
    document_json: &str,
    bundle: &PyMapBundle,
    options_json: Option<&str>,
    policy: Option<Bound<'_, PyAny>>,
) -> PyResult<String> {
    let mut cb = policy_callback(&policy);
    rt::rehearse_situation_json(
        document_json,
        &bundle.inner,
        options_json,
        cb.as_deref_mut(),
    )
    .py()
}

/// ``SituationSolveResult`` JSON; ``on_evaluation(doc_json)`` receives each ``{program, rehearsal}``.
#[pyfunction]
#[pyo3(signature = (document_json, bundle, options_json = None, on_evaluation = None, policy = None))]
fn solve_situation(
    document_json: &str,
    bundle: &PyMapBundle,
    options_json: Option<&str>,
    on_evaluation: Option<Bound<'_, PyAny>>,
    policy: Option<Bound<'_, PyAny>>,
) -> PyResult<String> {
    let mut cb = policy_callback(&policy);
    let mut on_eval = on_evaluation.as_ref().map(|f| {
        move |doc: &str| -> std::result::Result<(), BindingError> {
            f.call1((doc,))
                .map(|_| ())
                .map_err(|e| BindingError::Runtime(e.to_string()))
        }
    });
    rt::solve_situation_json(
        document_json,
        &bundle.inner,
        options_json,
        cb.as_deref_mut(),
        on_eval
            .as_mut()
            .map(|f| f as &mut dyn FnMut(&str) -> std::result::Result<(), BindingError>),
    )
    .py()
}

/// ``SituationComparison`` JSON. Options add ``reactiveRoleIds?``.
#[pyfunction]
#[pyo3(signature = (document_json, transaction_json, bundle, options_json = None, policy = None))]
fn compare_situation(
    document_json: &str,
    transaction_json: &str,
    bundle: &PyMapBundle,
    options_json: Option<&str>,
    policy: Option<Bound<'_, PyAny>>,
) -> PyResult<String> {
    let mut cb = policy_callback(&policy);
    rt::compare_situation_json(
        document_json,
        transaction_json,
        &bundle.inner,
        options_json,
        cb.as_deref_mut(),
    )
    .py()
}

/// ``{templateId, paramsVersion}``: the replay-key identity of a template.
#[pyfunction]
fn template_identity_json(template_json: &str) -> PyResult<String> {
    rt::template_identity_json(template_json).py()
}

/// ``AdaptNote[]`` JSON (``{path, reason, severity, code?}``); needs no map.
#[pyfunction]
fn adapt_template_notes_json(template_json: &str) -> PyResult<String> {
    rt::adapt_template_notes_json(template_json).py()
}

/// ``sha256(templateId|paramsVersion|siteId|drawIndex)``, the per-cell seed.
#[pyfunction]
fn cell_seed(template_id: &str, params_version: &str, site_id: &str, draw_index: i64) -> String {
    rt::cell_seed(template_id, params_version, site_id, draw_index)
}

/// ``SituationTransactionResult`` JSON (no simulation).
#[pyfunction]
fn apply_situation_transaction(document_json: &str, transaction_json: &str) -> PyResult<String> {
    rt::apply_situation_transaction_json(document_json, transaction_json).py()
}

#[pyfunction]
fn find_sites(template_json: &str, bundle: &PyMapBundle) -> PyResult<Vec<String>> {
    rt::find_sites(template_json, &bundle.inner).py()
}

#[pyfunction]
#[pyo3(signature = (document_json, bundle, options_json = None))]
fn compile_situation(
    document_json: &str,
    bundle: &PyMapBundle,
    options_json: Option<&str>,
) -> PyResult<(PyScenarioInput, String)> {
    let (scenario, program) =
        rt::compile_situation_json(document_json, &bundle.inner, options_json).py()?;
    Ok((PyScenarioInput { inner: scenario }, program))
}

#[pyfunction]
#[pyo3(signature = (input, graph, profile_json, options_json = None))]
fn materialize_ambient_traffic(
    input: &PyScenarioInput,
    graph: &PyLaneGraph,
    profile_json: &str,
    options_json: Option<&str>,
) -> PyResult<(PyScenarioInput, String)> {
    let (scenario, provenance) =
        rt::materialize_ambient_traffic(&input.inner, &graph.inner, profile_json, options_json)
            .py()?;
    Ok((PyScenarioInput { inner: scenario }, provenance))
}

/// The ``t = 0`` feasibility guards alone; ``SimIssue[]`` JSON (no clip run).
#[pyfunction]
fn check_feasibility(input: &PyScenarioInput, graph: &PyLaneGraph) -> PyResult<String> {
    rt::check_feasibility_json(&input.inner, &graph.inner).py()
}

#[pyfunction]
#[pyo3(signature = (input, graph, options_json = None))]
fn run_simulation(
    py: Python<'_>,
    input: &PyScenarioInput,
    graph: &PyLaneGraph,
    options_json: Option<&str>,
) -> PyResult<String> {
    let scenario = input.inner.clone();
    let graph = graph.inner.clone();
    let options = options_json.map(str::to_owned);
    py.detach(move || rt::run_simulation_json(&scenario, &graph, options.as_deref()))
        .py()
}

/* --------------------------------------------------------- env session */

/// Owned copy of one decision, materialised while the GIL is held.
#[pyclass(name = "StepView", frozen)]
pub struct PyStepView {
    t_s: f64,
    reward: f64,
    terminated: bool,
    truncated: bool,
    state_vector: Py<PyArray1<f64>>,
    objects: Py<PyArray2<f32>>,
    object_ids: Vec<String>,
    bev: Option<Py<PyArray3<f32>>>,
    reward_terms: Py<PyArray1<f64>>,
    info_json: String,
}

impl PyStepView {
    fn capture(py: Python<'_>, view: &StepView<'_>, max_objects: usize) -> PyResult<Self> {
        let state_vector = PyArray1::from_slice(py, view.state_vector()).unbind();
        let objects = PyArray1::from_slice(py, view.objects())
            .reshape([max_objects, simforge_bindings_common::OBJECT_FEATURES])?
            .unbind();
        let bev = match view.bev() {
            None => None,
            Some(((h, w, c), data)) => {
                Some(PyArray1::from_slice(py, data).reshape([h, w, c])?.unbind())
            }
        };
        Ok(Self {
            t_s: view.t_s(),
            reward: view.reward(),
            terminated: view.terminated(),
            truncated: view.truncated(),
            state_vector,
            objects,
            object_ids: view.object_ids().to_vec(),
            bev,
            reward_terms: PyArray1::from_slice(py, &view.reward_terms()).unbind(),
            info_json: view.info_json().py()?,
        })
    }
}

#[pymethods]
impl PyStepView {
    #[getter]
    fn t_s(&self) -> f64 {
        self.t_s
    }
    #[getter]
    fn reward(&self) -> f64 {
        self.reward
    }
    #[getter]
    fn terminated(&self) -> bool {
        self.terminated
    }
    #[getter]
    fn truncated(&self) -> bool {
        self.truncated
    }
    #[getter]
    fn state_vector(&self, py: Python<'_>) -> Py<PyArray1<f64>> {
        self.state_vector.clone_ref(py)
    }
    #[getter]
    fn objects(&self, py: Python<'_>) -> Py<PyArray2<f32>> {
        self.objects.clone_ref(py)
    }
    #[getter]
    fn object_count(&self) -> usize {
        self.object_ids.len()
    }
    #[getter]
    fn object_ids(&self) -> Vec<String> {
        self.object_ids.clone()
    }
    #[getter]
    fn bev(&self, py: Python<'_>) -> Option<Py<PyArray3<f32>>> {
        self.bev.as_ref().map(|b| b.clone_ref(py))
    }
    #[getter]
    fn reward_terms(&self, py: Python<'_>) -> Py<PyArray1<f64>> {
        self.reward_terms.clone_ref(py)
    }
    fn info_json(&self) -> String {
        self.info_json.clone()
    }
}

#[pyclass(name = "EnvSession", unsendable)]
pub struct PyEnvSession {
    inner: Env,
}

fn action_row<'py>(
    action: Option<&Bound<'py, PyAny>>,
) -> PyResult<Option<PyReadonlyArray1<'py, f64>>> {
    match action {
        None => Ok(None),
        Some(a) if a.is_none() => Ok(None),
        Some(a) => Ok(Some(a.extract::<PyReadonlyArray1<'py, f64>>()?)),
    }
}

#[pymethods]
impl PyEnvSession {
    #[new]
    #[pyo3(signature = (input, graph, episode_json = None, max_objects = simforge_bindings_common::DEFAULT_MAX_OBJECTS))]
    fn new(
        input: &PyScenarioInput,
        graph: &PyLaneGraph,
        episode_json: Option<&str>,
        max_objects: usize,
    ) -> PyResult<Self> {
        Ok(Self {
            inner: Env::new(&input.inner, &graph.inner, episode_json, max_objects).py()?,
        })
    }
    #[getter]
    fn ego(&self) -> String {
        self.inner.ego().to_owned()
    }
    #[getter]
    fn decision_hz(&self) -> u32 {
        self.inner.decision_hz()
    }
    #[getter]
    fn decision_ticks(&self) -> usize {
        self.inner.decision_ticks()
    }
    #[getter]
    fn clip_seconds(&self) -> f64 {
        self.inner.clip_seconds()
    }
    #[getter]
    fn max_objects(&self) -> usize {
        self.inner.max_objects()
    }
    #[getter]
    fn bev_shape(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        shape3(self.inner.bev_shape(), py)
    }
    #[pyo3(signature = (seed = None))]
    fn reset(&mut self, py: Python<'_>, seed: Option<&Bound<'_, PyAny>>) -> PyResult<PyStepView> {
        let seed = seed_of(seed)?;
        let max_objects = self.inner.max_objects();
        let inner = &mut self.inner;
        py.detach(|| inner.reset(seed).map(|_| ())).py()?;
        PyStepView::capture(py, &self.inner.view(), max_objects)
    }
    #[pyo3(signature = (action = None))]
    fn step(&mut self, py: Python<'_>, action: Option<&Bound<'_, PyAny>>) -> PyResult<PyStepView> {
        let row = action_row(action)?;
        let row = row.as_ref().map(|r| r.as_slice()).transpose()?;
        let max_objects = self.inner.max_objects();
        let inner = &mut self.inner;
        py.detach(|| inner.step(row).map(|_| ())).py()?;
        PyStepView::capture(py, &self.inner.view(), max_objects)
    }
    fn checkpoint<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        Ok(PyBytes::new(py, &self.inner.checkpoint().py()?))
    }
    fn restore(&mut self, py: Python<'_>, checkpoint: &[u8]) -> PyResult<PyStepView> {
        self.inner.restore(checkpoint).py()?;
        PyStepView::capture(py, &self.inner.view(), self.inner.max_objects())
    }
    fn ego_pose(&self) -> PyResult<(f64, f64, f64, f64, f64)> {
        let [t, x, y, yaw, v] = self.inner.ego_pose().py()?;
        Ok((t, x, y, yaw, v))
    }
    /// Actors in the world at the observation instant; raises before ``reset()``.
    #[getter]
    fn actor_count(&self) -> PyResult<usize> {
        self.inner.actor_count().py()
    }
    /// Canonical ids in snapshot order (the row order of ``actors()``/``present()``/``actor_dims``); raises before ``reset()``.
    #[getter]
    fn actor_ids(&self) -> PyResult<Vec<String>> {
        self.inner.actor_ids().py()
    }
    #[getter]
    fn actor_kinds(&self) -> PyResult<Vec<&'static str>> {
        self.inner.actor_kinds().py()
    }
    /// ``(N, 3)`` rows ``[l, w, h]``.
    #[getter]
    fn actor_dims<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray2<f64>>> {
        let dims = self.inner.actor_dims().py()?;
        PyArray1::from_slice(py, &dims).reshape([dims.len() / 3, 3])
    }
    /// ``(N, ACTOR_ROW)`` rows ``[x, y, heading_rad, speed_mps, accel_mps2, lateral_offset_m, lateral_rate_mps, s]`` (xodr-local) at the observation instant.
    fn actors<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray2<f64>>> {
        let rows = self.inner.actor_rows().py()?;
        PyArray1::from_slice(py, &rows).reshape([rows.len() / rt::ACTOR_ROW, rt::ACTOR_ROW])
    }
    fn present<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray1<bool>>> {
        Ok(PyArray1::from_slice(py, &self.inner.actor_present().py()?))
    }
    fn signal_book_json(&self) -> PyResult<String> {
        self.inner.signal_book_json().py()
    }
    /// The accumulated ``CausalChannel`` of the current episode as JSON.
    fn causal_channel_json(&self) -> PyResult<String> {
        self.inner.causal_channel_json().py()
    }
}

/* ------------------------------------------------------------- batch */

#[pyclass(name = "BatchView", frozen)]
pub struct PyBatchView {
    size: usize,
    t_s: Py<PyArray1<f64>>,
    reward: Py<PyArray1<f64>>,
    terminated: Py<PyArray1<bool>>,
    truncated: Py<PyArray1<bool>>,
    state_vector: Py<PyArray2<f64>>,
    objects: Py<PyArray3<f32>>,
    object_count: Py<PyArray1<u32>>,
    reward_terms: Py<PyArray2<f64>>,
    bev: Option<Py<PyArray4<f32>>>,
    object_ids: Vec<Vec<String>>,
    info_json: Vec<String>,
}

impl PyBatchView {
    fn capture(py: Python<'_>, batch: &Batch) -> PyResult<Self> {
        let n = batch.len();
        let flat = batch.flat();
        let state_rows = if batch.state_vector_enabled() {
            simforge_bindings_common::STATE_VECTOR_SIZE
        } else {
            0
        };
        let bev = match batch.bev_shape() {
            None => None,
            Some((h, w, c)) => Some(
                PyArray1::from_slice(py, &flat.bev)
                    .reshape([n, h, w, c])?
                    .unbind(),
            ),
        };
        let mut object_ids = Vec::with_capacity(n);
        let mut info_json = Vec::with_capacity(n);
        for i in 0..n {
            object_ids.push(batch.object_ids(i).py()?);
            info_json.push(batch.info_json(i).py()?);
        }
        Ok(Self {
            size: n,
            t_s: PyArray1::from_slice(py, &flat.t_s).unbind(),
            reward: PyArray1::from_slice(py, &flat.rewards).unbind(),
            terminated: flat
                .terminated
                .iter()
                .map(|v| *v != 0)
                .collect::<Vec<bool>>()
                .into_pyarray(py)
                .unbind(),
            truncated: flat
                .truncated
                .iter()
                .map(|v| *v != 0)
                .collect::<Vec<bool>>()
                .into_pyarray(py)
                .unbind(),
            state_vector: PyArray1::from_slice(py, &flat.state)
                .reshape([n, state_rows])?
                .unbind(),
            objects: PyArray1::from_slice(py, batch.objects_f32())
                .reshape([
                    n,
                    batch.max_objects(),
                    simforge_bindings_common::OBJECT_FEATURES,
                ])?
                .unbind(),
            object_count: PyArray1::from_slice(py, &flat.object_counts).unbind(),
            reward_terms: PyArray1::from_slice(py, batch.reward_terms())
                .reshape([n, 3])?
                .unbind(),
            bev,
            object_ids,
            info_json,
        })
    }
}

#[pymethods]
impl PyBatchView {
    #[getter]
    fn size(&self) -> usize {
        self.size
    }
    #[getter]
    fn t_s(&self, py: Python<'_>) -> Py<PyArray1<f64>> {
        self.t_s.clone_ref(py)
    }
    #[getter]
    fn reward(&self, py: Python<'_>) -> Py<PyArray1<f64>> {
        self.reward.clone_ref(py)
    }
    #[getter]
    fn terminated(&self, py: Python<'_>) -> Py<PyArray1<bool>> {
        self.terminated.clone_ref(py)
    }
    #[getter]
    fn truncated(&self, py: Python<'_>) -> Py<PyArray1<bool>> {
        self.truncated.clone_ref(py)
    }
    #[getter]
    fn state_vector(&self, py: Python<'_>) -> Py<PyArray2<f64>> {
        self.state_vector.clone_ref(py)
    }
    #[getter]
    fn objects(&self, py: Python<'_>) -> Py<PyArray3<f32>> {
        self.objects.clone_ref(py)
    }
    #[getter]
    fn object_count(&self, py: Python<'_>) -> Py<PyArray1<u32>> {
        self.object_count.clone_ref(py)
    }
    #[getter]
    fn reward_terms(&self, py: Python<'_>) -> Py<PyArray2<f64>> {
        self.reward_terms.clone_ref(py)
    }
    #[getter]
    fn bev(&self, py: Python<'_>) -> Option<Py<PyArray4<f32>>> {
        self.bev.as_ref().map(|b| b.clone_ref(py))
    }
    fn object_ids(&self, world: usize) -> PyResult<Vec<String>> {
        self.object_ids
            .get(world)
            .cloned()
            .ok_or_else(|| PyValueError::new_err(format!("world {world} out of range")))
    }
    fn info_json(&self, world: usize) -> PyResult<String> {
        self.info_json
            .get(world)
            .cloned()
            .ok_or_else(|| PyValueError::new_err(format!("world {world} out of range")))
    }
}

#[pyclass(name = "SessionBatch", unsendable)]
pub struct PySessionBatch {
    inner: Batch,
}

#[pymethods]
impl PySessionBatch {
    #[new]
    #[pyo3(signature = (inputs, graphs, episode_json = None, threads = None, max_objects = simforge_bindings_common::DEFAULT_MAX_OBJECTS))]
    fn new(
        inputs: Vec<PyRef<'_, PyScenarioInput>>,
        graphs: Vec<PyRef<'_, PyLaneGraph>>,
        episode_json: Option<&str>,
        threads: Option<usize>,
        max_objects: usize,
    ) -> PyResult<Self> {
        let scenarios: Vec<Scenario> = inputs.iter().map(|s| s.inner.clone()).collect();
        let graphs: Vec<rt::Graph> = graphs.iter().map(|g| g.inner.clone()).collect();
        Ok(Self {
            inner: Batch::new(
                &scenarios,
                &graphs,
                episode_json,
                max_objects,
                threads.unwrap_or(0),
            )
            .py()?,
        })
    }
    #[getter]
    fn size(&self) -> usize {
        self.inner.len()
    }
    #[getter]
    fn egos(&self) -> Vec<String> {
        self.inner.egos()
    }
    #[getter]
    fn decision_hz(&self) -> u32 {
        self.inner.decision_hz()
    }
    #[getter]
    fn max_objects(&self) -> usize {
        self.inner.max_objects()
    }
    #[getter]
    fn bev_shape(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        shape3(self.inner.bev_shape(), py)
    }
    #[pyo3(signature = (seeds = None))]
    fn reset_all(
        &mut self,
        py: Python<'_>,
        seeds: Option<&Bound<'_, PyAny>>,
    ) -> PyResult<PyBatchView> {
        let seeds = seeds_of(seeds)?;
        let inner = &mut self.inner;
        py.detach(|| inner.reset_all(seeds.as_deref())).py()?;
        PyBatchView::capture(py, &self.inner)
    }
    #[pyo3(signature = (worlds, seeds = None))]
    fn reset_worlds(
        &mut self,
        py: Python<'_>,
        worlds: PyReadonlyArray1<'_, i64>,
        seeds: Option<&Bound<'_, PyAny>>,
    ) -> PyResult<PyBatchView> {
        let worlds: Vec<usize> = worlds
            .as_slice()?
            .iter()
            .map(|&w| {
                usize::try_from(w)
                    .map_err(|_| PyValueError::new_err(format!("negative world index {w}")))
            })
            .collect::<PyResult<_>>()?;
        let seeds: Option<Vec<Option<Seed>>> = match seeds {
            None => None,
            Some(s) if s.is_none() => None,
            Some(s) => Some(
                s.try_iter()?
                    .map(|item| seed_of(Some(&item?)))
                    .collect::<PyResult<_>>()?,
            ),
        };
        let inner = &mut self.inner;
        py.detach(|| inner.reset_worlds(&worlds, seeds.as_deref()))
            .py()?;
        PyBatchView::capture(py, &self.inner)
    }
    #[pyo3(signature = (actions, mask = None))]
    fn step_batch(
        &mut self,
        py: Python<'_>,
        actions: PyReadonlyArray2<'_, f64>,
        mask: Option<PyReadonlyArray1<'_, bool>>,
    ) -> PyResult<PyBatchView> {
        let shape = actions.shape();
        if shape[1] != action::ACTION_WIDTH {
            return Err(PyValueError::new_err(format!(
                "actions must be (N, {}) float64, got {:?}",
                action::ACTION_WIDTH,
                shape
            )));
        }
        let rows = actions.as_slice()?;
        let mask = mask.as_ref().map(|m| m.as_slice()).transpose()?;
        let inner = &mut self.inner;
        py.detach(|| inner.step_batch(rows, mask)).py()?;
        PyBatchView::capture(py, &self.inner)
    }
    fn checkpoint<'py>(&self, py: Python<'py>, world: usize) -> PyResult<Bound<'py, PyBytes>> {
        Ok(PyBytes::new(py, &self.inner.checkpoint(world).py()?))
    }
    fn restore(&mut self, world: usize, checkpoint: &[u8]) -> PyResult<()> {
        self.inner.restore(world, checkpoint).py()
    }
}

/* ------------------------------------------------------------- world */

#[pyclass(name = "WorldSnapshot", frozen)]
pub struct PyWorldSnapshot {
    inner: rt::WorldSnapshotView,
}

#[pymethods]
impl PyWorldSnapshot {
    #[getter]
    fn t_s(&self) -> f64 {
        self.inner.t_s()
    }
    #[getter]
    fn tick(&self) -> usize {
        self.inner.tick()
    }
    #[getter]
    fn done(&self) -> bool {
        self.inner.done()
    }
    #[getter]
    fn actor_ids(&self) -> Vec<String> {
        self.inner.actor_ids()
    }
    #[getter]
    fn kinds(&self) -> Vec<&'static str> {
        self.inner.kinds()
    }
    #[getter]
    fn lane_rsls(&self) -> Vec<Option<String>> {
        self.inner.lane_rsls()
    }
    #[getter]
    fn present<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray1<bool>> {
        PyArray1::from_slice(py, self.inner.present())
    }
    /// `(N, 5)` rows `[x, z, heading_rad, speed_mps, s]` in the scene frame.
    #[getter]
    fn pose<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray2<f64>>> {
        PyArray1::from_slice(py, self.inner.pose()).reshape([self.inner.present().len(), 5])
    }
    fn to_json(&self) -> PyResult<String> {
        self.inner.to_json().py()
    }
}

#[pyclass(name = "TruthSubscription", unsendable)]
pub struct PyTruthSubscription {
    inner: rt::TruthSubscriber,
}

#[pymethods]
impl PyTruthSubscription {
    fn drain(&mut self) -> PyResult<Vec<String>> {
        self.inner.drain_json().py()
    }
    /// Every queued frame as ``bytes`` = ``u32le length || msgpack(TruthFrame)``.
    fn drain_frames<'py>(&mut self, py: Python<'py>) -> PyResult<Vec<Bound<'py, PyBytes>>> {
        Ok(self
            .inner
            .drain_framed()
            .py()?
            .iter()
            .map(|f| PyBytes::new(py, f))
            .collect())
    }
    #[getter]
    fn dropped(&self) -> u64 {
        self.inner.dropped()
    }
    #[getter]
    fn queued(&self) -> usize {
        self.inner.queued()
    }
    #[getter]
    fn active(&self) -> bool {
        self.inner.is_active()
    }
    fn close(&self) {
        self.inner.close()
    }
}

#[pyclass(name = "WorldSession", unsendable)]
pub struct PyWorldSession {
    inner: World,
}

#[pymethods]
impl PyWorldSession {
    #[new]
    #[pyo3(signature = (input, graph, options_json = None))]
    fn new(
        input: &PyScenarioInput,
        graph: &PyLaneGraph,
        options_json: Option<&str>,
    ) -> PyResult<Self> {
        Ok(Self {
            inner: World::new(&input.inner, &graph.inner, options_json).py()?,
        })
    }
    #[getter]
    fn time(&self) -> f64 {
        self.inner.time()
    }
    #[getter]
    fn tick(&self) -> usize {
        self.inner.tick()
    }
    #[getter]
    fn digest(&self) -> String {
        self.inner.digest().to_owned()
    }
    #[pyo3(signature = (command_json, client_id = "python", seq = 0))]
    fn command(&mut self, command_json: &str, client_id: &str, seq: u64) -> PyResult<String> {
        self.inner.command_json(client_id, seq, command_json).py()
    }
    fn advance(&mut self, py: Python<'_>, ticks: usize) -> PyResult<String> {
        let inner = &mut self.inner;
        py.detach(|| inner.advance_json(ticks)).py()
    }
    fn snapshot(&mut self) -> PyWorldSnapshot {
        PyWorldSnapshot {
            inner: self.inner.snapshot(),
        }
    }
    #[pyo3(signature = (capacity = None))]
    fn subscribe(&mut self, capacity: Option<usize>) -> PyResult<PyTruthSubscription> {
        Ok(PyTruthSubscription {
            inner: self.inner.subscribe(capacity).py()?,
        })
    }
    fn log_json(&self) -> PyResult<String> {
        self.inner.log_json().py()
    }
    fn checkpoint<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        Ok(PyBytes::new(py, &self.inner.checkpoint().py()?))
    }
    fn restore(&mut self, checkpoint: &[u8]) -> PyResult<()> {
        self.inner.restore(checkpoint).py()
    }
}

#[pyfunction]
fn replay_world_log(
    log_json: &str,
    input: &PyScenarioInput,
    graph: &PyLaneGraph,
) -> PyResult<String> {
    rt::replay_world_log_json(log_json, &input.inner, &graph.inner).py()
}

/* ------------------------------------------------------------ policy */

#[pyclass(name = "PolicyStep", frozen)]
pub struct PyPolicyStep {
    step: Py<PyStepView>,
    limit_ms: Option<f64>,
    elapsed_ms: Option<f64>,
    miss: bool,
    applied: &'static str,
    executor_json: Option<String>,
}

impl PyPolicyStep {
    fn capture(py: Python<'_>, outcome: &PolicyOutcome<'_>, max_objects: usize) -> PyResult<Self> {
        Ok(Self {
            step: Py::new(py, PyStepView::capture(py, &outcome.step, max_objects)?)?,
            limit_ms: outcome.deadline.limit_ms,
            elapsed_ms: outcome.deadline.elapsed_ms,
            miss: outcome.deadline.miss,
            applied: outcome.applied_str(),
            executor_json: outcome.executor_json().py()?,
        })
    }
}

#[pymethods]
impl PyPolicyStep {
    #[getter]
    fn step(&self, py: Python<'_>) -> Py<PyStepView> {
        self.step.clone_ref(py)
    }
    #[getter]
    fn deadline_limit_ms(&self) -> Option<f64> {
        self.limit_ms
    }
    #[getter]
    fn deadline_elapsed_ms(&self) -> Option<f64> {
        self.elapsed_ms
    }
    #[getter]
    fn deadline_miss(&self) -> bool {
        self.miss
    }
    #[getter]
    fn applied(&self) -> &'static str {
        self.applied
    }
    fn executor_json(&self) -> Option<String> {
        self.executor_json.clone()
    }
}

/// Policy executor bound to one `EnvSession`. The session object stays owned by
/// Python; the executor borrows it per call.
#[pyclass(name = "PolicySession", unsendable)]
pub struct PyPolicySession {
    inner: Policy,
    session: Py<PyEnvSession>,
}

#[pymethods]
impl PyPolicySession {
    #[new]
    #[pyo3(signature = (session, deadline_ms = None, fallback = "repeat-last", execution = "pure-pursuit"))]
    fn new(
        session: Py<PyEnvSession>,
        deadline_ms: Option<f64>,
        fallback: &str,
        execution: &str,
    ) -> PyResult<Self> {
        Ok(Self {
            inner: Policy::new(deadline_ms, fallback, execution).py()?,
            session,
        })
    }
    #[getter]
    fn execution(&self) -> &'static str {
        self.inner.execution_str()
    }
    #[pyo3(signature = (seed = None))]
    fn reset(&mut self, py: Python<'_>, seed: Option<&Bound<'_, PyAny>>) -> PyResult<PyStepView> {
        let seed = seed_of(seed)?;
        let mut env = self.session.borrow_mut(py);
        let max_objects = env.inner.max_objects();
        self.inner.reset(&mut env.inner, seed).py()?;
        PyStepView::capture(py, &env.inner.view(), max_objects)
    }
    #[pyo3(signature = (throttle, brake, steer, elapsed_ms = None))]
    fn act_control(
        &mut self,
        py: Python<'_>,
        throttle: f64,
        brake: f64,
        steer: f64,
        elapsed_ms: Option<f64>,
    ) -> PyResult<PyPolicyStep> {
        let mut env = self.session.borrow_mut(py);
        let max_objects = env.inner.max_objects();
        let outcome = self
            .inner
            .act_control(&mut env.inner, throttle, brake, steer, elapsed_ms)
            .py()?;
        PyPolicyStep::capture(py, &outcome, max_objects)
    }
    #[pyo3(signature = (points, elapsed_ms = None))]
    fn act_trajectory(
        &mut self,
        py: Python<'_>,
        points: PyReadonlyArray2<'_, f64>,
        elapsed_ms: Option<f64>,
    ) -> PyResult<PyPolicyStep> {
        if points.shape()[1] != 5 {
            return Err(PyValueError::new_err(format!(
                "trajectory must be (K, 5) float64, got {:?}",
                points.shape()
            )));
        }
        let rows = points.as_slice()?;
        let mut env = self.session.borrow_mut(py);
        let max_objects = env.inner.max_objects();
        let outcome = self
            .inner
            .act_trajectory(&mut env.inner, rows, elapsed_ms)
            .py()?;
        PyPolicyStep::capture(py, &outcome, max_objects)
    }
    /// Env continuation state plus the executor's held plan / last applied action.
    fn checkpoint<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        let env = self.session.borrow(py);
        Ok(PyBytes::new(py, &self.inner.checkpoint(&env.inner).py()?))
    }
    fn restore(&mut self, py: Python<'_>, checkpoint: &[u8]) -> PyResult<PyStepView> {
        let mut env = self.session.borrow_mut(py);
        let max_objects = env.inner.max_objects();
        self.inner.restore(&mut env.inner, checkpoint).py()?;
        PyStepView::capture(py, &env.inner.view(), max_objects)
    }
}

/* ---------------------------------------------------------- simulation */

/// Bare engine world: explicit per-actor action batches, no episode semantics.
#[pyclass(name = "Simulation", unsendable)]
pub struct PySimulation {
    inner: Sim,
}

#[pymethods]
impl PySimulation {
    #[new]
    #[pyo3(signature = (input, graph, options_json = None))]
    fn new(
        input: &PyScenarioInput,
        graph: &PyLaneGraph,
        options_json: Option<&str>,
    ) -> PyResult<Self> {
        Ok(Self {
            inner: Sim::new(&input.inner, &graph.inner, options_json).py()?,
        })
    }
    #[getter]
    fn t_s(&self) -> f64 {
        self.inner.t_s()
    }
    #[getter]
    fn dt_s(&self) -> f64 {
        self.inner.dt_s()
    }
    #[getter]
    fn tick_index(&self) -> u64 {
        self.inner.tick_index()
    }
    #[getter]
    fn done(&self) -> bool {
        self.inner.done()
    }
    /// The completed run's ``SimResult`` JSON (``{input, trace, issues, arrival}``); errors until ``done``.
    fn result_json(&mut self) -> PyResult<String> {
        self.inner.result_json().py()
    }
    /// Recorded trace prefix; does not advance or finalize the simulation.
    fn trace_json(&self) -> PyResult<String> {
        self.inner.trace_json().py()
    }
    fn input_json(&self) -> PyResult<String> {
        self.inner.input_json().py()
    }
    fn issues_json(&self) -> PyResult<String> {
        self.inner.issues_json().py()
    }
    fn arrival_json(&self) -> PyResult<String> {
        self.inner.arrival_json().py()
    }
    #[getter]
    fn actor_count(&self) -> usize {
        self.inner.actor_count()
    }
    #[getter]
    fn actor_ids(&self) -> Vec<String> {
        self.inner.actor_ids()
    }
    #[getter]
    fn actor_kinds(&self) -> Vec<&'static str> {
        self.inner.actor_kinds()
    }
    /// ``(N, 3)`` rows ``[l, w, h]``.
    #[getter]
    fn actor_dims<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray2<f64>>> {
        PyArray1::from_slice(py, &self.inner.actor_dims()).reshape([self.inner.actor_count(), 3])
    }
    fn actor_index(&self, id: &str) -> PyResult<usize> {
        self.inner.actor_index(id).py()
    }
    /// ``actions`` is ``(K, 1 + ACTION_WIDTH)`` float64 rows ``[actor_index, ...action]``; returns ``(ticks_advanced, done)``.
    #[pyo3(signature = (max_ticks, actions = None))]
    fn advance(
        &mut self,
        py: Python<'_>,
        max_ticks: usize,
        actions: Option<PyReadonlyArray2<'_, f64>>,
    ) -> PyResult<(usize, bool)> {
        let rows = match &actions {
            None => &[][..],
            Some(a) => {
                if a.shape()[1] != 1 + action::ACTION_WIDTH {
                    return Err(PyValueError::new_err(format!(
                        "actions must be (K, {}) float64, got {:?}",
                        1 + action::ACTION_WIDTH,
                        a.shape()
                    )));
                }
                a.as_slice()?
            }
        };
        let inner = &mut self.inner;
        py.detach(|| inner.advance(max_ticks, rows)).py()
    }
    /// ``(N, 8)`` rows ``[x, y, heading_rad, speed_mps, accel_mps2, lateral_offset_m, lateral_rate_mps, s]`` (xodr-local).
    fn actors<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyArray2<f64>>> {
        PyArray1::from_slice(py, self.inner.actor_rows())
            .reshape([self.inner.actor_count(), rt::ACTOR_ROW])
    }
    fn present<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray1<bool>> {
        PyArray1::from_slice(py, self.inner.present())
    }
    fn lane_rsls(&self) -> Vec<Option<String>> {
        self.inner.lane_rsls().to_vec()
    }
    fn minima_json(&self) -> PyResult<String> {
        self.inner.minima_json().py()
    }
    fn drain_events_json(&mut self) -> PyResult<String> {
        self.inner.drain_events_json().py()
    }
    fn signal_state_json(&self) -> PyResult<String> {
        self.inner.signal_state_json().py()
    }
    fn checkpoint<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        Ok(PyBytes::new(py, &self.inner.checkpoint().py()?))
    }
    fn restore(&mut self, checkpoint: &[u8]) -> PyResult<()> {
        self.inner.restore(checkpoint).py()
    }
}

/* --------------------------------------------------------------- trace */

#[pyclass(name = "Trace", frozen)]
pub struct PyTrace {
    inner: Trace,
}

#[pymethods]
impl PyTrace {
    #[staticmethod]
    fn parse(data: &[u8]) -> PyResult<Self> {
        Ok(Self {
            inner: Trace::parse(data).py()?,
        })
    }
    fn digest(&self) -> PyResult<String> {
        self.inner.digest().py()
    }
    fn to_json(&self) -> PyResult<String> {
        self.inner.to_json().py()
    }
    fn scene_state_json(&self) -> PyResult<String> {
        self.inner.scene_state_json().py()
    }
    fn metrics_json(&self) -> PyResult<String> {
        self.inner.metrics_json().py()
    }
    #[pyo3(signature = (filters_json = None))]
    fn evaluate_json(&self, filters_json: Option<&str>) -> PyResult<String> {
        self.inner.evaluate_json(filters_json).py()
    }
    fn intent_rubric_json(&self, rubric_json: &str) -> PyResult<String> {
        self.inner.intent_rubric_json(rubric_json).py()
    }
    fn blind_review_packet_json(&self, rubric_json: &str) -> PyResult<String> {
        self.inner.blind_review_packet_json(rubric_json).py()
    }
    #[pyo3(signature = (limits_json = None))]
    fn behavior_summary_json(&self, limits_json: Option<&str>) -> PyResult<String> {
        self.inner.behavior_summary_json(limits_json).py()
    }
    #[pyo3(signature = (template_json, options_json = None))]
    fn invariants_json(&self, template_json: &str, options_json: Option<&str>) -> PyResult<String> {
        self.inner.invariants_json(template_json, options_json).py()
    }
}

#[pyfunction]
fn canonical_json(document: &str) -> PyResult<String> {
    rt::canonical_json(document).py()
}

#[pyfunction]
fn content_hash(document: &str) -> PyResult<String> {
    rt::content_hash(document).py()
}

#[pyfunction]
fn sha256_hex(data: &[u8]) -> String {
    rt::sha256_hex(data)
}

/* ------------------------------------------------------------ module */

#[pymodule]
fn _native(py: Python<'_>, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("ENGINE_HZ", simforge_bindings_common::ENGINE_HZ)?;
    m.add(
        "STATE_VECTOR_SIZE",
        simforge_bindings_common::STATE_VECTOR_SIZE,
    )?;
    m.add("OBJECT_FEATURES", simforge_bindings_common::OBJECT_FEATURES)?;
    m.add("ACTION_WIDTH", action::ACTION_WIDTH)?;
    m.add(
        "ACTION_FIELDS",
        PyTuple::new(py, action::ACTION_FIELD_NAMES)?,
    )?;
    m.add("ENGINE_VERSION", simforge_bindings_common::ENGINE_VERSION)?;
    m.add(
        "DEFAULT_MAX_OBJECTS",
        simforge_bindings_common::DEFAULT_MAX_OBJECTS,
    )?;
    m.add("ABI_VERSION", simforge_bindings_common::ABI_VERSION)?;
    m.add("ACTOR_ROW", rt::ACTOR_ROW)?;

    m.add("NativeError", py.get_type::<NativeError>())?;
    m.add("SchemaError", py.get_type::<SchemaError>())?;
    m.add("EngineError", py.get_type::<EngineError>())?;
    m.add("SessionError", py.get_type::<SessionError>())?;
    m.add("UnsupportedError", py.get_type::<UnsupportedError>())?;

    m.add_class::<PyLaneGraph>()?;
    m.add_class::<PyScenarioInput>()?;
    m.add_class::<PyMapBundle>()?;
    m.add_class::<PySite>()?;
    m.add_class::<PyRoute>()?;
    m.add_class::<PyCompileResult>()?;
    m.add_class::<PyStepView>()?;
    m.add_class::<PyEnvSession>()?;
    m.add_class::<PyBatchView>()?;
    m.add_class::<PySessionBatch>()?;
    m.add_class::<PyWorldSnapshot>()?;
    m.add_class::<PyTruthSubscription>()?;
    m.add_class::<PyWorldSession>()?;
    m.add_class::<PyPolicyStep>()?;
    m.add_class::<PyPolicySession>()?;
    m.add_class::<PySimulation>()?;
    m.add_class::<PyTrace>()?;

    m.add_function(wrap_pyfunction!(compile_template, m)?)?;
    m.add_function(wrap_pyfunction!(find_sites, m)?)?;
    m.add_function(wrap_pyfunction!(find_site, m)?)?;
    m.add_function(wrap_pyfunction!(match_sites, m)?)?;
    m.add_function(wrap_pyfunction!(rehearse_situation, m)?)?;
    m.add_function(wrap_pyfunction!(solve_situation, m)?)?;
    m.add_function(wrap_pyfunction!(compare_situation, m)?)?;
    m.add_function(wrap_pyfunction!(apply_situation_transaction, m)?)?;
    m.add_function(wrap_pyfunction!(template_identity_json, m)?)?;
    m.add_function(wrap_pyfunction!(cell_seed, m)?)?;
    m.add_function(wrap_pyfunction!(adapt_template_notes_json, m)?)?;
    m.add_function(wrap_pyfunction!(compile_situation, m)?)?;
    m.add_function(wrap_pyfunction!(run_simulation, m)?)?;
    m.add_function(wrap_pyfunction!(check_feasibility, m)?)?;
    m.add_function(wrap_pyfunction!(materialize_ambient_traffic, m)?)?;
    m.add_function(wrap_pyfunction!(replay_world_log, m)?)?;
    m.add_function(wrap_pyfunction!(canonical_json, m)?)?;
    m.add_function(wrap_pyfunction!(content_hash, m)?)?;
    m.add_function(wrap_pyfunction!(sha256_hex, m)?)?;
    Ok(())
}
