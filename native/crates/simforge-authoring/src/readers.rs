//! Reading the instance and trace files the authoring commands exchange.
//!
//! Both readers report a structured error an agent can act on: a missing file
//! (`file_not_found`), a document that is not JSON (`invalid_json`), an
//! instance whose input breaks the engine contract (`instance_invalid`, exit
//! 2, with the schema issues) or a trace no released format reads
//! (`invalid_trace`).

use std::path::Path;

use serde_json::json;
use simforge_bindings_common::runtime::Trace;
use simforge_compiler::CompileError;
use simforge_core::types::{parse_scenario_input_value, SimScenarioInput};

use crate::jsvalue::JsValue;

fn not_found(file: &Path) -> CompileError {
    CompileError::at(
        "file_not_found",
        file.display().to_string(),
        format!("cannot read {}", file.display()),
    )
}

/// `JSON.parse(readFile(file))`, in JavaScript's property order.
pub fn read_js(file: &Path) -> Result<JsValue, CompileError> {
    let text = std::fs::read_to_string(file).map_err(|_| not_found(file))?;
    JsValue::parse(&text)
        .map_err(|e| CompileError::at("invalid_json", file.display().to_string(), e.to_string()))
}

/// An instance file (`scenario-instance` v1) or a bare `SimScenarioInput`.
pub struct InstanceDoc {
    /// `{kind, version, catalogSlot?, manifest, input}` with `input` the parsed
    /// (defaulted) engine input; `manifest` absent for a bare input.
    pub document: JsValue,
    pub input: SimScenarioInput,
}

fn parse_input(value: &JsValue, file: &Path, reason: &str) -> Result<SimScenarioInput, CompileError> {
    parse_scenario_input_value(&value.to_value()).map_err(|e| {
        CompileError::at("instance_invalid", file.display().to_string(), reason)
            .detail_entry("issues", json!(e.issues))
            .as_findings()
    })
}

/// `readInstance(file)`.
pub fn read_instance(file: &Path) -> Result<InstanceDoc, CompileError> {
    let raw = read_js(file)?;
    let is_instance = raw.get("kind").and_then(JsValue::as_str) == Some("scenario-instance");
    let null = JsValue::Null;
    let (input_raw, reason) = if is_instance {
        (raw.get("input").unwrap_or(&null), "the instance does not satisfy the engine contract")
    } else {
        (&raw, "the document is neither an instance nor a SimScenarioInput")
    };
    let input = parse_input(input_raw, file, reason)?;
    let parsed = JsValue::from_serialize(&input)?;
    let mut entries = vec![
        ("kind".to_owned(), JsValue::String("scenario-instance".into())),
        ("version".to_owned(), JsValue::Number(1.0)),
    ];
    if is_instance {
        if let Some(slot) = raw.get("catalogSlot") {
            entries.push(("catalogSlot".to_owned(), slot.clone()));
        }
        if let Some(manifest) = raw.get("manifest") {
            entries.push(("manifest".to_owned(), manifest.clone()));
        }
    }
    entries.push(("input".to_owned(), parsed));
    Ok(InstanceDoc { document: JsValue::object(entries), input })
}

/// `readTraceHandle(file)`: plain or gzipped trace JSON of any released format.
pub fn read_trace(file: &Path) -> Result<Trace, CompileError> {
    let bytes = std::fs::read(file).map_err(|_| not_found(file))?;
    Trace::parse(&bytes)
        .map_err(|e| CompileError::at("invalid_trace", file.display().to_string(), e.to_string()))
}

/// A binding-layer failure while reading a parsed trace.
pub fn trace_error(error: simforge_bindings_common::BindingError) -> CompileError {
    crate::engine::engine_error(error)
}

/// Parse native JSON output in its own property order.
pub fn native_js(text: &str) -> Result<JsValue, CompileError> {
    JsValue::parse(text).map_err(|e| CompileError::internal(format!("native JSON: {e}")))
}
