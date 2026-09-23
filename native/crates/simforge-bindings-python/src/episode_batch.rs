use super::*;

#[pyclass(name = "EpisodeBatchView", frozen, extends = PyBatchView)]
pub struct PyEpisodeBatchView {
    collision: Py<PyArray1<bool>>,
    goal: Py<PyArray1<bool>>,
    autoreset: Py<PyArray1<bool>>,
    term_reasons: Vec<Option<String>>,
}

impl PyEpisodeBatchView {
    fn capture(py: Python<'_>, batch: &rt::EpisodeBatch, info: bool) -> PyResult<Py<Self>> {
        let n = batch.len();
        let flat = batch.flat();
        let base = PyBatchView {
            size: n,
            t_s: PyArray1::from_slice(py, &flat.t_s).unbind(),
            reward: PyArray1::from_slice(py, &flat.rewards).unbind(),
            terminated: flat.terminated.iter().map(|v| *v != 0).collect::<Vec<_>>().into_pyarray(py).unbind(),
            truncated: flat.truncated.iter().map(|v| *v != 0).collect::<Vec<_>>().into_pyarray(py).unbind(),
            state_vector: PyArray1::from_slice(py, &flat.state).reshape([n, if batch.state_vector_enabled() { 10 } else { 0 }])?.unbind(),
            objects: PyArray1::from_slice(py, batch.objects_f32()).reshape([n, batch.max_objects(), simforge_bindings_common::OBJECT_FEATURES])?.unbind(),
            object_count: PyArray1::from_slice(py, &flat.object_counts).unbind(),
            reward_terms: PyArray1::from_slice(py, batch.reward_terms()).reshape([n, simforge_bindings_common::REWARD_TERM_COUNT])?.unbind(),
            bev: batch.bev_shape().map(|(h, w, c)| PyArray1::from_slice(py, &flat.bev).reshape([n, h, w, c]).map(Bound::unbind)).transpose()?,
            object_ids: (0..n).map(|i| batch.object_ids(i).py()).collect::<PyResult<_>>()?,
            info_json: if info { (0..n).map(|i| batch.info_json(i).py()).collect::<PyResult<_>>()? } else { Vec::new() },
            signals_json: if batch.signals_enabled() { (0..n).map(|i| batch.signals_json(i).py()).collect::<PyResult<_>>()? } else { Vec::new() },
        };
        Py::new(py, (Self {
            collision: PyArray1::from_slice(py, batch.collisions()).unbind(),
            goal: PyArray1::from_slice(py, batch.goals()).unbind(),
            autoreset: PyArray1::from_slice(py, batch.autoreset()).unbind(),
            term_reasons: batch.term_reasons(),
        }, base))
    }
}

#[pymethods]
impl PyEpisodeBatchView {
    #[getter]
    fn collision(&self, py: Python<'_>) -> Py<PyArray1<bool>> { self.collision.clone_ref(py) }
    #[getter]
    fn goal(&self, py: Python<'_>) -> Py<PyArray1<bool>> { self.goal.clone_ref(py) }
    #[getter]
    fn autoreset(&self, py: Python<'_>) -> Py<PyArray1<bool>> { self.autoreset.clone_ref(py) }
    #[getter]
    fn term_reasons(&self) -> Vec<Option<String>> { self.term_reasons.clone() }
}

#[pyclass(name = "EpisodeBatch", unsendable)]
pub struct PyEpisodeBatch {
    inner: rt::EpisodeBatch,
    info: bool,
}

fn episode_seed(value: &Bound<'_, PyAny>) -> PyResult<u64> {
    if let Ok(seed) = value.extract::<u64>() { return Ok(seed); }
    seed_of(Some(value))?.map(|s| u64::from(simforge_core::rng::normalize_seed(&s)))
        .ok_or_else(|| PyValueError::new_err("seed cannot be None"))
}

#[pymethods]
impl PyEpisodeBatch {
    #[new]
    #[pyo3(signature = (specs, graphs, threads = None, max_objects = simforge_bindings_common::DEFAULT_MAX_OBJECTS, info_channel = false))]
    fn new(specs: Vec<String>, graphs: Vec<PyRef<'_, PyLaneGraph>>, threads: Option<usize>, max_objects: usize, info_channel: bool) -> PyResult<Self> {
        let graphs = graphs.iter().map(|g| g.inner.clone()).collect::<Vec<_>>();
        Ok(Self { inner: rt::EpisodeBatch::new(&specs, &graphs, max_objects, threads.unwrap_or(0)).py()?, info: info_channel })
    }
    #[getter]
    fn size(&self) -> usize { self.inner.len() }
    #[getter]
    fn egos(&self) -> Vec<String> { self.inner.egos() }
    #[getter]
    fn decision_hz(&self) -> u32 { self.inner.decision_hz() }
    #[getter]
    fn max_objects(&self) -> usize { self.inner.max_objects() }
    #[getter]
    fn bev_shape(&self, py: Python<'_>) -> PyResult<Py<PyAny>> { shape3(self.inner.bev_shape(), py) }
    #[pyo3(signature = (seeds = None))]
    fn reset_all(&mut self, py: Python<'_>, seeds: Option<&Bound<'_, PyAny>>) -> PyResult<Py<PyEpisodeBatchView>> {
        let inner = &mut self.inner;
        match seeds {
            None => py.detach(|| inner.reset_all(None)).py()?,
            Some(value) if value.is_none() => py.detach(|| inner.reset_all(None)).py()?,
            Some(value) if value.is_instance_of::<pyo3::types::PyInt>() => {
                let seed = value.extract::<u64>().map_err(|_| PyValueError::new_err("scalar batch seed must be an unsigned 64-bit integer"))?;
                py.detach(|| inner.reset_seed(seed)).py()?;
            }
            Some(values) => {
                let seeds = values.try_iter()?.map(|v| episode_seed(&v?)).collect::<PyResult<Vec<_>>>()?;
                py.detach(|| inner.reset_all(Some(&seeds))).py()?;
            }
        }
        PyEpisodeBatchView::capture(py, &self.inner, self.info)
    }
    fn step_all(&mut self, py: Python<'_>, actions: PyReadonlyArray2<'_, f64>) -> PyResult<Py<PyEpisodeBatchView>> {
        let shape = actions.shape();
        if shape[0] != self.inner.len() { return Err(PyValueError::new_err("action count must equal batch size")); }
        let width = shape[1];
        let rows = actions.as_slice()?;
        let inner = &mut self.inner;
        py.detach(|| inner.step_all(rows, width)).py()?;
        PyEpisodeBatchView::capture(py, &self.inner, self.info)
    }
    /// Compact Episode actions, including trajectories and preview setpoints.
    fn step_all_json(&mut self, py: Python<'_>, actions_json: &str) -> PyResult<Py<PyEpisodeBatchView>> {
        let inner = &mut self.inner;
        py.detach(|| inner.step_all_json(actions_json)).py()?;
        PyEpisodeBatchView::capture(py, &self.inner, self.info)
    }
    fn checkpoint<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> { Ok(PyBytes::new(py, &self.inner.checkpoint().py()?)) }
    fn restore(&mut self, py: Python<'_>, checkpoint: &[u8]) -> PyResult<Py<PyEpisodeBatchView>> {
        let inner = &mut self.inner;
        py.detach(|| inner.restore(checkpoint)).py()?;
        PyEpisodeBatchView::capture(py, &self.inner, self.info)
    }
    fn trace_digests(&self) -> Vec<String> { self.inner.trace_digests() }
    fn trace_json(&self, world: usize) -> PyResult<String> { Ok(self.inner.trace_json(world).py()?.to_owned()) }
}
