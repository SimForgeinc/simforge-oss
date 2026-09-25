//! One engine pass over a compiled instance, and the trace file it leaves.
//!
//! The run is the engine's own (`simforge_core::engine::run_simulation` over
//! the installed map's lane graph, static colliders and ground, trace capture
//! on), fed exactly what every host feeds it: the instance input re-read
//! through the scenario parser.

use std::io::Write;
use std::path::Path;

use simforge_bindings_common::runtime::{MapAsset, Scenario};
use simforge_bindings_common::BindingError;
use simforge_compiler::CompileError;
use simforge_core::engine::SimResult;
use simforge_core::trace::SimTrace;
use simforge_core::types::SimScenarioInput;

use crate::json::io_error;
use crate::maps::split_compile_message;

/// A binding-layer failure in the structured form (the compiler's
/// `"<code> at <path>: <reason>"` text is split back into its parts).
pub fn engine_error(error: BindingError) -> CompileError {
    let text = error.to_string();
    split_compile_message(&text).unwrap_or_else(|| CompileError::new("engine_error", text))
}

/// `runSimulation(input, { graph })`: the whole clip, trace captured.
pub fn simulate(input: &SimScenarioInput, map: &MapAsset) -> Result<SimResult, CompileError> {
    let bytes = serde_json::to_vec(input)
        .map_err(|e| CompileError::internal(format!("serialise input: {e}")))?;
    let scenario = Scenario::parse(&bytes).map_err(engine_error)?;
    let mut options = map.graph().run_options(None).map_err(engine_error)?;
    options.capture_trace = true;
    simforge_core::engine::run_simulation(scenario.input().clone(), options)
        .map_err(|e| engine_error(BindingError::from(e)))
}

/// `parseTrace(trace)`: the trace document read back through the trace
/// reader, as a host hands it to the native side.
pub fn reparse_trace(trace: &SimTrace) -> Result<SimTrace, CompileError> {
    let bytes = serde_json::to_vec(trace)
        .map_err(|e| CompileError::internal(format!("serialise trace: {e}")))?;
    SimTrace::from_json_slice(&bytes)
        .map_err(|e| CompileError::new("invalid_trace", format!("trace: {e}")))
}

/// The quantised trace JSON a native trace handle serialises to
/// (`TraceHandle.serialize()`).
pub fn quantized_json(trace: &SimTrace) -> Result<String, CompileError> {
    let mut quantized = trace.clone();
    quantized.quantize();
    serde_json::to_string(&quantized).map_err(|e| CompileError::internal(format!("serialise trace: {e}")))
}

/// `canonicalJson(trace)` of a plain trace document.
pub fn canonical_json(trace: &SimTrace) -> Result<String, CompileError> {
    simforge_core::hash::canonical_json_of(trace)
        .map_err(|e| CompileError::internal(format!("canonical trace: {e}")))
}

/// Write `.trace.json.gz`: gzip of the given trace JSON.
///
/// The decompressed bytes are what traces are compared by. The compressed
/// bytes follow the same gzip header as Node's `CompressionStream` (no name,
/// mtime 0, OS 3) at the same default level; the deflate stream itself is
/// flate2's, which Node's bundled zlib does not reproduce bit for bit.
pub fn write_trace_gz(file: &Path, json: &str) -> Result<(), CompileError> {
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
        }
    }
    let mut encoder = flate2::GzBuilder::new()
        .operating_system(3)
        .mtime(0)
        .write(Vec::with_capacity(json.len() / 4), flate2::Compression::default());
    encoder.write_all(json.as_bytes()).map_err(|e| io_error(file, e))?;
    let bytes = encoder.finish().map_err(|e| io_error(file, e))?;
    std::fs::write(file, bytes).map_err(|e| io_error(file, e))
}
