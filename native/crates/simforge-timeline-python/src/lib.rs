//! `simforge_oss_timeline._native` — Python face of the shared render
//! timeline sampler. The sampler itself lives in
//! `simforge_core::trace::timeline`; this module only marshals, so a pose
//! sampled here is bit-identical to one sampled in Rust or in the browser.

use pyo3::exceptions::{PyKeyError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};

use simforge_core::trace::timeline::{
    self as tl, sampler, HeightField, RenderTimeline, TimelinePose,
};
use simforge_core::trace::SimTrace;

fn value_err(e: impl std::fmt::Display) -> PyErr {
    PyValueError::new_err(e.to_string())
}

fn sample_err(e: sampler::SampleError) -> PyErr {
    match e {
        sampler::SampleError::UnknownActor(id) => PyKeyError::new_err(id),
        other => value_err(other),
    }
}

fn bytes_of(data: &Bound<'_, PyAny>) -> PyResult<Vec<u8>> {
    if let Ok(b) = data.cast::<PyBytes>() {
        return Ok(b.as_bytes().to_vec());
    }
    if let Ok(s) = data.extract::<String>() {
        return Ok(s.into_bytes());
    }
    Err(PyValueError::new_err("expected bytes or str"))
}

fn pose_dict<'py>(py: Python<'py>, p: &TimelinePose) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("present", p.present)?;
    d.set_item("tick", p.tick)?;
    d.set_item("x", p.x)?;
    d.set_item("y", p.y)?;
    d.set_item("z", p.z)?;
    d.set_item("headingRad", p.heading_rad)?;
    d.set_item("pitchRad", p.pitch_rad)?;
    d.set_item("rollRad", p.roll_rad)?;
    d.set_item("speedMps", p.speed_mps)?;
    d.set_item("velocity", p.velocity.to_vec())?;
    d.set_item("acceleration", p.acceleration.to_vec())?;
    d.set_item("roadPitchRad", p.road_pitch_rad)?;
    d.set_item("roadRollRad", p.road_roll_rad)?;
    d.set_item("bodyPitchRad", p.body_pitch_rad)?;
    d.set_item("bodyRollRad", p.body_roll_rad)?;
    d.set_item("wheelSteerRad", p.wheel_steer_rad)?;
    d.set_item("wheelSpinRad", p.wheel_spin_rad)?;
    d.set_item("downed", p.downed)?;
    Ok(d)
}

/// A parsed, validated `simforge.render-timeline.v1` document.
#[pyclass(name = "Timeline", module = "simforge_oss_timeline._native", frozen)]
struct PyTimeline {
    inner: RenderTimeline,
}

#[pymethods]
impl PyTimeline {
    /// Parse a timeline from JSON (`bytes` or `str`; gzip accepted).
    #[staticmethod]
    fn from_json(data: &Bound<'_, PyAny>) -> PyResult<Self> {
        let bytes = bytes_of(data)?;
        RenderTimeline::from_json_slice(&bytes)
            .map(|inner| Self { inner })
            .map_err(value_err)
    }

    /// Read a timeline file (`.json` or `.json.gz`).
    #[staticmethod]
    fn load(path: std::path::PathBuf) -> PyResult<Self> {
        let bytes =
            std::fs::read(&path).map_err(|e| value_err(format!("{}: {e}", path.display())))?;
        RenderTimeline::from_json_slice(&bytes)
            .map(|inner| Self { inner })
            .map_err(value_err)
    }

    /// Canonical JSON-serialisable document text.
    fn to_json(&self) -> PyResult<String> {
        self.inner.to_json().map_err(value_err)
    }

    /// `canonicalJson(timeline)`: the bytes whose sha256 is `sha256`.
    fn to_canonical_json(&self) -> PyResult<String> {
        self.inner.to_canonical_json().map_err(value_err)
    }

    /// `timelineSha256` (content digest of the document).
    #[getter]
    fn sha256(&self) -> PyResult<String> {
        self.inner.sha256().map_err(value_err)
    }
    /// `H(traceSha256, heightFieldDigest, catalogDigest, samplerVersion)`.
    #[getter]
    fn key(&self) -> String {
        self.inner.identity.timeline_key.clone()
    }
    #[getter]
    fn trace_sha256(&self) -> String {
        self.inner.identity.trace_sha256.clone()
    }
    #[getter]
    fn map_id(&self) -> String {
        self.inner.map_id.clone()
    }
    #[getter]
    fn xodr_sha256(&self) -> Option<String> {
        self.inner.height_source.xodr_sha256.clone()
    }
    #[getter]
    fn dt(&self) -> f64 {
        self.inner.dt_s
    }
    #[getter]
    fn tick_count(&self) -> u32 {
        self.inner.tick_count
    }
    #[getter]
    fn warmup_s(&self) -> f64 {
        self.inner.time.warmup_s
    }
    #[getter]
    fn clip_end_s(&self) -> f64 {
        self.inner.time.clip_end_s
    }
    /// Clip-relative tick times.
    #[getter]
    fn times(&self) -> Vec<f64> {
        self.inner.t.clone()
    }
    #[getter]
    fn actor_ids(&self) -> Vec<String> {
        self.inner.actors.iter().map(|a| a.id.clone()).collect()
    }

    /// Static description of one actor (`id, kind, catalogId, actorClass,
    /// dims, color, static, ambient, lifecycle`) as a dict.
    fn actor<'py>(&self, py: Python<'py>, actor_id: &str) -> PyResult<Bound<'py, PyAny>> {
        let a = self
            .inner
            .actor(actor_id)
            .ok_or_else(|| PyKeyError::new_err(actor_id.to_owned()))?;
        let value = serde_json::json!({
            "id": a.id, "kind": a.kind, "catalogId": a.catalog_id,
            "actorClass": a.actor_class, "dims": a.dims, "color": a.color,
            "static": a.is_static, "origin": a.origin, "lifecycle": a.lifecycle,
        });
        let json = py.import("json")?;
        json.call_method1("loads", (value.to_string(),))
    }

    /// Props with baked heights, as a list of dicts.
    fn props<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let text = serde_json::to_string(&self.inner.props).map_err(value_err)?;
        py.import("json")?.call_method1("loads", (text,))
    }

    /// `pose(actorId, t)` → dict with `present, x, y, z, headingRad,
    /// pitchRad, rollRad, speedMps, velocity, acceleration, ...`.
    fn pose<'py>(&self, py: Python<'py>, actor_id: &str, t: f64) -> PyResult<Bound<'py, PyDict>> {
        let p = sampler::pose(&self.inner, actor_id, t).map_err(sample_err)?;
        pose_dict(py, &p)
    }

    /// The flat 20-float encoding (see `TimelinePose::to_array`).
    fn pose_array(&self, actor_id: &str, t: f64) -> PyResult<Vec<f64>> {
        let p = sampler::pose(&self.inner, actor_id, t).map_err(sample_err)?;
        Ok(p.to_array().to_vec())
    }

    /// Every actor at `t` → `{actorId: pose}` (absent actors included).
    fn poses<'py>(&self, py: Python<'py>, t: f64) -> PyResult<Bound<'py, PyDict>> {
        let out = PyDict::new(py);
        for (id, p) in sampler::poses(&self.inner, t).map_err(sample_err)? {
            out.set_item(id, pose_dict(py, &p)?)?;
        }
        Ok(out)
    }

    /// Signal indications held at `t` → `{signalId: indication}`.
    fn signals_at<'py>(&self, py: Python<'py>, t: f64) -> PyResult<Bound<'py, PyDict>> {
        let out = PyDict::new(py);
        for (id, ind) in sampler::signals_at(&self.inner, t).map_err(sample_err)? {
            out.set_item(id, ind.as_str())?;
        }
        Ok(out)
    }

    /// Resolved light states at `t` (flashing phased on the timeline clock).
    fn lights_at<'py>(
        &self,
        py: Python<'py>,
        actor_id: &str,
        t: f64,
    ) -> PyResult<Bound<'py, PyDict>> {
        let l = sampler::lights_at(&self.inner, actor_id, t).map_err(sample_err)?;
        let d = PyDict::new(py);
        d.set_item("lowBeam", l.low_beam)?;
        d.set_item("brake", l.brake)?;
        d.set_item("reverse", l.reverse)?;
        d.set_item("indicatorLeft", l.indicator_left)?;
        d.set_item("indicatorRight", l.indicator_right)?;
        d.set_item("emergency", l.emergency)?;
        Ok(d)
    }

    /// Raw light modes held at `t` → `{lightType: "on"|"off"|"flashing"}`.
    fn light_modes_at<'py>(
        &self,
        py: Python<'py>,
        actor_id: &str,
        t: f64,
    ) -> PyResult<Bound<'py, PyDict>> {
        let modes = sampler::light_modes_at(&self.inner, actor_id, t).map_err(sample_err)?;
        let d = PyDict::new(py);
        for (k, m) in modes {
            let key = serde_json::to_value(k).map_err(value_err)?;
            let mode = serde_json::to_value(m).map_err(value_err)?;
            d.set_item(
                key.as_str().unwrap_or_default(),
                mode.as_str().unwrap_or_default(),
            )?;
        }
        Ok(d)
    }

    /// `simforge.scene-state.v1` document (JSON text) sampled at `times`.
    #[pyo3(signature = (times, yaw_only=false))]
    fn scene_state_json(&self, times: Vec<f64>, yaw_only: bool) -> PyResult<String> {
        let doc =
            sampler::scene_state_document(&self.inner, &times, yaw_only).map_err(sample_err)?;
        tl::to_json_string(&doc).map_err(value_err)
    }

    fn __repr__(&self) -> String {
        format!(
            "Timeline(map_id={:?}, ticks={}, actors={}, key={})",
            self.inner.map_id,
            self.inner.tick_count,
            self.inner.actors.len(),
            &self.inner.identity.timeline_key[..12.min(self.inner.identity.timeline_key.len())]
        )
    }
}

/// Grade observed per-frame transforms (JSONL text) against the sampler.
/// `profile` is `"bevy"`, `"carla"`, or a full profile dict
/// (`name, positionToleranceM, angleToleranceDeg, frame, heightReference,
/// compareAttitude`). Returns the `simforge.render-parity/v1` report dict.
#[pyfunction]
#[pyo3(signature = (timeline, observed_jsonl, profile=None))]
fn compare_observed<'py>(
    py: Python<'py>,
    timeline: &Bound<'py, PyTimeline>,
    observed_jsonl: &str,
    profile: Option<Bound<'py, PyAny>>,
) -> PyResult<Bound<'py, PyAny>> {
    let json = py.import("json")?;
    let profile = match profile {
        Some(p) => p,
        None => "bevy".into_pyobject(py)?.into_any(),
    };
    let profile = if let Ok(name) = profile.extract::<String>() {
        tl::parity::ParityProfile::named(&name)
            .ok_or_else(|| PyValueError::new_err(format!("unknown parity profile {name:?}")))?
    } else {
        let text: String = json.call_method1("dumps", (profile,))?.extract()?;
        serde_json::from_str(&text).map_err(value_err)?
    };
    let report =
        tl::parity::compare_observed_jsonl(&timeline.get().inner, observed_jsonl, &profile)
            .map_err(value_err)?;
    let text = tl::to_json_string(&report).map_err(value_err)?;
    json.call_method1("loads", (text,))
}

/// Module-level `pose(timeline, actor_id, t)`, the documented contract form.
#[pyfunction]
fn pose<'py>(
    py: Python<'py>,
    timeline: &PyTimeline,
    actor_id: &str,
    t: f64,
) -> PyResult<Bound<'py, PyDict>> {
    timeline.pose(py, actor_id, t)
}

/// Build a timeline from a trace (JSON bytes/str, gzip ok) and the map's
/// `.xodr` + topology sidecar; `flat_z` replaces the map with a constant
/// surface (tests / maps without elevation). Returns the timeline JSON text.
#[pyfunction]
#[pyo3(signature = (trace, xodr=None, topology=None, catalog_digest=None, flat_z=None, plane=None))]
fn build_timeline(
    trace: &Bound<'_, PyAny>,
    xodr: Option<&Bound<'_, PyAny>>,
    topology: Option<&Bound<'_, PyAny>>,
    catalog_digest: Option<String>,
    flat_z: Option<f64>,
    plane: Option<(f64, f64, f64)>,
) -> PyResult<String> {
    let trace_bytes = gunzip(bytes_of(trace)?)?;
    let trace = SimTrace::from_json_slice(&trace_bytes).map_err(value_err)?;
    let height = match (xodr, topology, flat_z, plane) {
        (Some(x), Some(t), None, None) => {
            HeightField::from_xodr(&bytes_of(x)?, &bytes_of(t)?).map_err(value_err)?
        }
        (None, None, Some(z), None) => HeightField::flat(z),
        (None, None, None, Some((z0, gx, gy))) => HeightField::plane(z0, gx, gy),
        _ => {
            return Err(PyValueError::new_err(
                "pass xodr and topology, or flat_z, or plane=(z0, gx, gy)",
            ))
        }
    };
    tl::build_render_timeline(&trace, &height, catalog_digest.as_deref())
        .and_then(|t| t.to_json())
        .map_err(value_err)
}

fn gunzip(bytes: Vec<u8>) -> PyResult<Vec<u8>> {
    tl::maybe_gunzip(&bytes)
        .map(|b| b.into_owned())
        .map_err(value_err)
}

/// `timeline_key(trace_sha256, height_field_digest, catalog_digest)`.
#[pyfunction]
#[pyo3(signature = (trace_sha256, height_field_digest, catalog_digest=None))]
fn timeline_key(
    trace_sha256: &str,
    height_field_digest: &str,
    catalog_digest: Option<&str>,
) -> String {
    tl::timeline_key(trace_sha256, height_field_digest, catalog_digest)
}

/// `traceSha256` of a trace document: sha256 of the canonical JSON of the
/// quantised trace (never of gzip bytes).
#[pyfunction]
fn trace_sha256(trace: &Bound<'_, PyAny>) -> PyResult<String> {
    let bytes = gunzip(bytes_of(trace)?)?;
    let trace = SimTrace::from_json_slice(&bytes).map_err(value_err)?;
    trace.digest().map_err(value_err)
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyTimeline>()?;
    m.add_function(wrap_pyfunction!(pose, m)?)?;
    m.add_function(wrap_pyfunction!(compare_observed, m)?)?;
    m.add_function(wrap_pyfunction!(build_timeline, m)?)?;
    m.add_function(wrap_pyfunction!(timeline_key, m)?)?;
    m.add_function(wrap_pyfunction!(trace_sha256, m)?)?;
    m.add("RENDER_TIMELINE_VERSION", tl::RENDER_TIMELINE_VERSION)?;
    m.add("SAMPLER_VERSION", tl::SAMPLER_VERSION)?;
    m.add("TIMELINE_DT_S", tl::TIMELINE_DT_S)?;
    m.add("POSE_ARRAY_LEN", sampler::POSE_ARRAY_LEN)?;
    Ok(())
}
