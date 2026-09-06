//! The engine integration boundary.
//!
//! The runner owns everything around a job (identity, inputs, resources,
//! lifecycle, cancellation, checkpoints, artifact verification). An engine
//! owns what happens between "inputs are on disk" and "outputs are in the
//! staging directory". `simforge-core`/`simforge-session` implement
//! [`JobEngine`] for each workload and register in `main.rs`; the runner
//! never reaches into engine types.
//!
//! Contract for engine authors:
//! - `admit` parses `manifest.params` and the inputs exactly once and returns
//!   the deterministic execution identity of the compiled work.
//! - `execute` writes outputs only under `ctx.output_dir` and consults
//!   `ctx.cancel` at every safe boundary (tick batch, episode, checkpoint).
//!   Returning `Err(RunnerError::Canceled)` from `ctx.cancel.check()` is the
//!   cancellation path; the runner records the attempt as canceled.
//! - `ctx.checkpoint` publishes a complete state closure; on resume
//!   `ctx.resume` is the verified latest checkpoint and the engine continues
//!   from it or errors, never silently restarts.
//! - The returned artifacts are re-hashed by the runner. A claimed digest that
//!   does not match the bytes fails the job.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cancel::CancelToken;
use crate::checkpoint::{CheckpointRef, CheckpointStore, ResumePoint};
use crate::error::{Result, RunnerError};
use crate::hash::ContentDigest;
use crate::manifest::JobManifest;
use crate::resources::ResourceGrant;
use crate::runtime::RuntimeIdentity;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    /// Workload identifier matched against `JobManifest.workload`.
    pub workload: String,
    pub requires_gpu: bool,
    /// Whether `execute` can continue from a checkpoint. Engines without
    /// continuation restart interrupted attempts from their immutable inputs.
    pub supports_continuation: bool,
    /// Backend profiles this engine can be asked for through `params`.
    pub backend_profiles: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedInput {
    pub input_id: String,
    /// Read-only file inside the workspace.
    pub path: PathBuf,
    pub digest: ContentDigest,
}

pub struct AdmissionContext<'a> {
    /// Worker root (provider interpreters, caches live under it).
    pub root: &'a Path,
    pub manifest: &'a JobManifest,
    pub inputs: &'a [ResolvedInput],
    pub runtime: &'a RuntimeIdentity,
}

impl AdmissionContext<'_> {
    pub fn input(&self, input_id: &str) -> Option<&ResolvedInput> {
        self.inputs.iter().find(|input| input.input_id == input_id)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionReport {
    /// Deterministic identity of the compiled executable work (inputs +
    /// normalized params + profile). Recorded in job state; two jobs with the
    /// same execution identity on the same runtime are expected to produce
    /// identical required outputs.
    pub execution_identity: String,
    /// Coarse admission facts for operators (actor counts, profile, ticks).
    #[serde(default)]
    pub summary: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducedArtifact {
    pub output_id: String,
    /// Path relative to `ExecutionContext::output_dir`; must equal the
    /// manifest's contract path for `output_id`.
    pub relative_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOutcome {
    pub artifacts: Vec<ProducedArtifact>,
    /// Coarse completion facts (ticks executed, episodes, timings).
    #[serde(default)]
    pub summary: serde_json::Value,
}

pub type ProgressSink<'a> = &'a mut dyn FnMut(&str, serde_json::Value) -> Result<u64>;

pub struct ExecutionContext<'a> {
    pub root: &'a Path,
    pub manifest: &'a JobManifest,
    pub attempt: u32,
    pub inputs: &'a [ResolvedInput],
    pub workspace: &'a Path,
    /// Attempt-local staging directory; outputs written here are verified
    /// and published by the runner after `execute` returns.
    pub output_dir: &'a Path,
    pub grant: &'a ResourceGrant,
    pub runtime: &'a RuntimeIdentity,
    /// Verified latest checkpoint when continuing an interrupted attempt.
    pub resume: Option<&'a ResumePoint>,
    pub cancel: &'a CancelToken,
    checkpoints: &'a CheckpointStore,
    next_checkpoint_sequence: u64,
    progress: ProgressSink<'a>,
}

impl<'a> ExecutionContext<'a> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        root: &'a Path,
        manifest: &'a JobManifest,
        attempt: u32,
        inputs: &'a [ResolvedInput],
        workspace: &'a Path,
        output_dir: &'a Path,
        grant: &'a ResourceGrant,
        runtime: &'a RuntimeIdentity,
        resume: Option<&'a ResumePoint>,
        cancel: &'a CancelToken,
        checkpoints: &'a CheckpointStore,
        progress: ProgressSink<'a>,
    ) -> Self {
        let next_checkpoint_sequence = resume.map_or(1, |point| point.manifest.sequence + 1);
        ExecutionContext {
            root,
            manifest,
            attempt,
            inputs,
            workspace,
            output_dir,
            grant,
            runtime,
            resume,
            cancel,
            checkpoints,
            next_checkpoint_sequence,
            progress,
        }
    }

    pub fn input(&self, input_id: &str) -> Option<&ResolvedInput> {
        self.inputs.iter().find(|input| input.input_id == input_id)
    }

    /// Emits a coarse `job.progress` event. Call at batch/episode boundaries,
    /// never per tick.
    pub fn progress(&mut self, data: serde_json::Value) -> Result<u64> {
        (self.progress)("job.progress", data)
    }

    /// Publishes a checkpoint: `write` fills the staging directory with a
    /// complete state closure, then the runner hashes and publishes it
    /// atomically and records `job.checkpoint`.
    pub fn checkpoint(
        &mut self,
        metadata: serde_json::Value,
        write: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<CheckpointRef> {
        let sequence = self.next_checkpoint_sequence;
        let staging = self.checkpoints.begin(sequence)?;
        if let Err(error) = write(&staging) {
            let _ = crate::fsatomic::remove_dir_if_present(&staging);
            return Err(error);
        }
        let reference = self.checkpoints.publish(
            &staging,
            sequence,
            self.attempt,
            &self.runtime.runtime_id,
            metadata,
        )?;
        self.next_checkpoint_sequence = sequence + 1;
        (self.progress)(
            "job.checkpoint",
            serde_json::json!({ "sequence": reference.sequence, "manifestSha256": reference.manifest_sha256, "metadata": reference.metadata }),
        )?;
        Ok(reference)
    }
}

pub trait JobEngine {
    fn capabilities(&self) -> EngineCapabilities;
    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport>;
    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome>;
}

/// Engines available in this binary, keyed by workload.
#[derive(Default)]
pub struct EngineRegistry {
    engines: Vec<Box<dyn JobEngine>>,
}

impl EngineRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, engine: Box<dyn JobEngine>) -> Result<()> {
        let workload = engine.capabilities().workload;
        if self
            .engines
            .iter()
            .any(|existing| existing.capabilities().workload == workload)
        {
            return Err(RunnerError::Engine {
                workload,
                reason: "registered twice".into(),
            });
        }
        self.engines.push(engine);
        Ok(())
    }

    pub fn find(&self, workload: &str) -> Result<&dyn JobEngine> {
        self.engines
            .iter()
            .find(|engine| engine.capabilities().workload == workload)
            .map(|engine| engine.as_ref())
            .ok_or_else(|| RunnerError::EngineUnavailable {
                workload: workload.to_owned(),
                available: self.workloads(),
            })
    }

    pub fn workloads(&self) -> Vec<String> {
        self.engines
            .iter()
            .map(|engine| engine.capabilities().workload)
            .collect()
    }

    pub fn capabilities(&self) -> Vec<EngineCapabilities> {
        self.engines
            .iter()
            .map(|engine| engine.capabilities())
            .collect()
    }
}
