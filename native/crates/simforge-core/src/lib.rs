//! `simforge-core` — the SIMFORGE native execution core.
//!
//! This crate owns the canonical scenario domain model and the deterministic
//! primitives every other native crate (compiler, session, runner, bindings)
//! builds on. It is independent of Bevy, Python, networking and storage.
//!
//! - [`types`]: the typed `SimScenarioInput` contract, its validating parser,
//!   canonical normalisation and content hashing.
//! - [`error`]: schema issues (repair-loop friendly) and engine issues.
//! - [`math`]: `f64` planar geometry in the xodr-local frame and the single
//!   scene-frame conversion.
//! - [`rng`]: the seeded xoshiro128** generator with the reference's exact
//!   seed folding and fork semantics.
//! - [`hash`]: canonical JSON and SHA-256 content ids that match the
//!   JavaScript reference byte for byte.
//! - [`map`]: topology decoding, immutable lane graph, routes.
//! - [`physics`]: the planar force-based motion backend and contact solver.
//! - [`trace`]: trace document, semantic ledger and metrics.
//! - [`evaluation`]: post-run evaluation (min clearance, realized PET, near miss).
//! - [`engine`]: authoritative fixed-step execution and resumable world state.
//! - [`solve`]: feasibility, arrival and nominal-motion solving.
//!
//! Session and compiler crates link this same execution authority.

pub mod checkpoint;
pub mod engine;
pub mod error;
pub mod evaluation;
pub mod hash;
pub mod map;
pub mod math;
pub mod physics;
pub mod rng;
pub mod solve;
pub mod trace;
pub mod types;

pub use engine::{
    run_simulation, ActionOverride, ActorAction, ActorIndex, ActorSnapshot, AmbientReactivity,
    GuardMode, RunOptions, SessionMode, SimResult, Simulation, SimulationCheckpoint,
    SimulationProgress, SimulationSnapshot, StaticMapCollider,
};
pub use error::{
    CoreError, SchemaError, SchemaIssue, SimEngineError, SimIssue, SimIssueCode, SimIssueSeverity,
};
pub use hash::{
    canonical_json, canonical_json_of, content_hash, content_hash_of, sha256, sha256_bytes,
};
pub use math::{Obb, SceneXZ, Vec2};
pub use rng::{Rng, Seed};
pub use types::{
    parse_scenario_input, parse_scenario_input_bytes, parse_scenario_input_value, SimScenarioInput,
    SCHEMA_VERSION,
};

/// Crate-wide result type.
pub type Result<T, E = CoreError> = std::result::Result<T, E>;

/// Engine semantics version recorded in every trace header. Bump on any change
/// that can move a trace byte — controller gains, integration order,
/// quantisation, metric definitions — so a cached artefact from an older
/// engine is never silently trusted.
///
/// History: 0.3.0 made omitted physics resolve to `dynamic-v1`; 0.4.0 added
/// deterministic rigid-body contact response and impulse telemetry; 0.5.0
/// added exact-time authored trajectories with collision-triggered physics
/// handoff; 0.6.0 made timed trajectories bounded position constraints with a
/// physics-controlled braking handoff.
pub const ENGINE_VERSION: &str = "0.6.0";

/// Validate canonical scenario JSON bytes into a typed document. Does not
/// normalise; call [`SimScenarioInput::normalized`] before hashing or running.
pub fn load_scenario(json: &[u8]) -> Result<SimScenarioInput> {
    parse_scenario_input_bytes(json)
}
