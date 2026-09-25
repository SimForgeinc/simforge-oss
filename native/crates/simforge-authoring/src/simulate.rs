//! `simulate <instance> [--trace <file>]`: one engine pass over an instance
//! file (or a bare SimScenarioInput). Feasibility guards are collected, not
//! thrown: a scenario that fails a guard is still worth simulating, because
//! the metrics are how "the runway is 8 m short" differs from "200 m short".

use std::path::Path;

use simforge_compiler::CompileError;

use crate::engine::{quantized_json, reparse_trace, simulate, write_trace_gz};
use crate::jsvalue::JsValue;
use crate::maps::MapRoot;
use crate::metrics::metrics_summary;
use crate::readers::read_instance;

/// The `simulate` document and whether the run had no error-severity issue.
pub fn run_simulate_instance(
    root: &MapRoot,
    file: &Path,
    file_arg: &str,
    trace_out: Option<&Path>,
) -> Result<(JsValue, bool), CompileError> {
    let instance = read_instance(file)?;
    let map = root.load(&instance.input.map_id)?;
    let result = simulate(&instance.input, &map)?;
    let handle = reparse_trace(&result.trace)?;
    let digest = handle
        .digest()
        .map_err(|e| CompileError::internal(format!("trace digest: {e}")))?;
    let written = match trace_out {
        Some(out) => {
            write_trace_gz(out, &quantized_json(&handle)?)?;
            JsValue::String(crate::paths::resolve(out).display().to_string())
        }
        None => JsValue::Null,
    };
    // `countEvents`: occurrences per event kind, in first-seen order.
    let mut counts: Vec<(String, JsValue)> = Vec::new();
    for event in JsValue::from_serialize(&result.trace.events)?
        .as_array()
        .unwrap_or(&[])
    {
        let kind = event
            .get("kind")
            .and_then(JsValue::as_str)
            .unwrap_or("undefined")
            .to_owned();
        match counts.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, JsValue::Number(n))) => *n += 1.0,
            _ => counts.push((kind, JsValue::Number(1.0))),
        }
    }
    let errors = result
        .issues
        .iter()
        .any(|i| i.severity == simforge_core::error::SimIssueSeverity::Error);
    let doc = JsValue::object(vec![
        ("file".into(), JsValue::String(file_arg.to_owned())),
        (
            "mapId".into(),
            JsValue::String(instance.input.map_id.clone()),
        ),
        (
            "header".into(),
            JsValue::from_serialize(&result.trace.header)?,
        ),
        ("traceDigest".into(), JsValue::String(digest)),
        (
            "metrics".into(),
            JsValue::from_serialize(&metrics_summary(&result.trace.metrics))?,
        ),
        ("events".into(), JsValue::object(counts)),
        ("issues".into(), JsValue::from_serialize(&result.issues)?),
        ("arrival".into(), JsValue::from_serialize(&result.arrival)?),
        ("trace".into(), written),
    ]);
    Ok((doc, !errors))
}
