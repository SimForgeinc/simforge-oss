//! `simforge-runner`: the durable headless job host of the SIMFORGE native
//! runtime.
//!
//! Responsibilities (all UI-independent):
//! - immutable job manifests identified by canonical sha256 ([`manifest`]);
//! - a verified runtime identity for the executing binary ([`runtime`]);
//! - worker-local content-addressed inputs and artifacts ([`cas`]);
//! - bounded resource declarations with exclusive device ownership
//!   ([`resources`]);
//! - crash-safe persisted lifecycle with an append-only event log
//!   ([`state`], [`fsatomic`]);
//! - process ownership through kernel locks, detachment and reconciliation
//!   ([`lockfile`], [`supervise`], [`job`]) over one portable OS layer
//!   ([`platform`]: Linux/macOS and Windows implementations);
//! - cooperative cancellation ([`cancel`]) and atomically published
//!   continuation checkpoints ([`checkpoint`]);
//! - artifact contract verification before any job is reported complete
//!   ([`artifacts`]).
//!
//! Engines plug in through [`engine::JobEngine`]; the workload adapters in
//! [`workloads`] link simforge-core/simforge-session directly.

pub mod artifacts;
pub mod cancel;
pub mod cas;
pub mod checkpoint;
pub mod cli;
pub mod clock;
pub mod engine;
pub mod error;
pub mod fsatomic;
pub mod hash;
pub mod job;
pub mod lockfile;
pub mod manifest;
pub mod platform;
pub mod provider;
pub mod resources;
pub mod runtime;
pub mod state;
pub mod supervise;
pub mod workloads;

pub use engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, EngineRegistry, ExecutionContext,
    ExecutionOutcome, JobEngine, ProducedArtifact, ResolvedInput,
};
pub use error::{ExitClass, Result, RunnerError};
pub use job::Worker;
pub use manifest::JobManifest;
pub use runtime::{RuntimeComponent, RuntimeManifest, VerifiedRuntime};
pub use state::{JobState, JobStatus};
