//! Lifecycle contract of the runner against a deterministic counting engine.
//! The engine is a test fixture, not a simulator: it exercises checkpoints,
//! cancellation, artifact claims and failure paths the way a real workload
//! adapter must.

use std::fs;
use std::path::{Path, PathBuf};

use simforge_runner::cancel::CancelRequest;
use simforge_runner::checkpoint::CheckpointStore;
use simforge_runner::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, EngineRegistry, ExecutionContext,
    ExecutionOutcome, JobEngine, ProducedArtifact,
};
use simforge_runner::hash::{hash_file, sha256_hex};
use simforge_runner::runtime::{load_verified, RuntimeManifest};
use simforge_runner::state::JobStatus;
use simforge_runner::{Result, RunnerError, VerifiedRuntime, Worker};

const WORKLOAD: &str = "test.counter/v1";

struct Counter;

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    steps: u64,
    checkpoint_every: u64,
    fail_at: Option<u64>,
    claim_wrong_hash: bool,
    /// Simulate an operator cancel arriving at this step.
    cancel_at: Option<u64>,
    /// Simulate the first attempt dying with an I/O error at this step.
    die_at: Option<u64>,
}

impl JobEngine for Counter {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            workload: WORKLOAD.into(),
            requires_gpu: false,
            supports_continuation: true,
            backend_profiles: vec!["cpu".into()],
        }
    }

    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport> {
        let params: Params = serde_json::from_value(ctx.manifest.params.clone()).map_err(|e| {
            RunnerError::Engine {
                workload: WORKLOAD.into(),
                reason: e.to_string(),
            }
        })?;
        let seed = ctx.input("seed").ok_or_else(|| RunnerError::Engine {
            workload: WORKLOAD.into(),
            reason: "missing input seed".into(),
        })?;
        Ok(AdmissionReport {
            execution_identity: sha256_hex(
                format!("{}:{}", seed.digest.sha256, params.steps).as_bytes(),
            ),
            summary: serde_json::json!({ "steps": params.steps }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        let params: Params = serde_json::from_value(ctx.manifest.params.clone()).unwrap();
        let seed = fs::read_to_string(&ctx.input("seed").unwrap().path).unwrap();
        let mut step = 0u64;
        let mut total: u64 = 0;
        if let Some(point) = ctx.resume {
            let saved: serde_json::Value =
                serde_json::from_slice(&fs::read(point.dir.join("state.json")).unwrap()).unwrap();
            step = saved["step"].as_u64().unwrap();
            total = saved["total"].as_u64().unwrap();
        }
        let start_step = step;
        while step < params.steps {
            ctx.cancel.check()?;
            if params.cancel_at == Some(step) {
                CancelRequest::write(
                    &ctx.workspace.parent().unwrap().to_path_buf(),
                    "test cancel",
                )
                .unwrap();
                std::thread::sleep(std::time::Duration::from_millis(300));
                continue;
            }
            if params.fail_at == Some(step) {
                return Err(RunnerError::Engine {
                    workload: WORKLOAD.into(),
                    reason: format!("failed at step {step}"),
                });
            }
            if params.die_at == Some(step) && ctx.attempt == 1 {
                return Err(RunnerError::Io {
                    path: PathBuf::from("simulated crash"),
                    source: std::io::Error::other("owner died"),
                });
            }
            total += seed.trim().parse::<u64>().unwrap() + step;
            step += 1;
            if params.checkpoint_every > 0 && step % params.checkpoint_every == 0 {
                let snapshot = serde_json::json!({ "step": step, "total": total });
                ctx.checkpoint(serde_json::json!({ "step": step }), |dir| {
                    fs::write(
                        dir.join("state.json"),
                        serde_json::to_vec(&snapshot).unwrap(),
                    )
                    .map_err(|e| RunnerError::io(dir, e))
                })?;
            }
        }
        let out = ctx.output_dir.join("result.json");
        fs::write(
            &out,
            serde_json::to_vec(&serde_json::json!({ "total": total, "resumedFrom": start_step }))
                .unwrap(),
        )
        .unwrap();
        let digest = hash_file(&out)?;
        let sha256 = if params.claim_wrong_hash {
            "0".repeat(64)
        } else {
            digest.sha256
        };
        Ok(ExecutionOutcome {
            artifacts: vec![ProducedArtifact {
                output_id: "result".into(),
                relative_path: "result.json".into(),
                sha256,
                size_bytes: digest.size_bytes,
                media_type: "application/json".into(),
            }],
            summary: serde_json::json!({ "steps": step }),
        })
    }
}

struct Fixture {
    root: PathBuf,
    runtime: VerifiedRuntime,
    engines: EngineRegistry,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "simforge-runner-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let exe = std::env::current_exe().unwrap();
        let manifest = RuntimeManifest::describe_binary(
            &exe,
            &"a".repeat(40),
            "x86_64-unknown-linux-gnu",
            "2026-09-05T00:00:00.000Z",
        )
        .unwrap();
        let manifest_path = root.join("runtime-manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let runtime = load_verified(&manifest_path, &exe).unwrap();
        let mut engines = EngineRegistry::new();
        engines.register(Box::new(Counter)).unwrap();
        Fixture {
            root,
            runtime,
            engines,
        }
    }

    fn worker(&self) -> Worker {
        Worker::open(&self.root).unwrap()
    }

    fn submit(
        &self,
        job_id: &str,
        params: serde_json::Value,
        expected_sha256: Option<&str>,
    ) -> Worker {
        let seed = self.root.join("seed.txt");
        fs::write(&seed, "7\n").unwrap();
        let digest = hash_file(&seed).unwrap();
        let manifest = serde_json::json!({
            "schema": "simforge.native-job/v1",
            "jobId": job_id,
            "workload": WORKLOAD,
            "params": params,
            "inputs": [{ "inputId": "seed", "sha256": digest.sha256, "sizeBytes": digest.size_bytes, "source": { "kind": "file", "path": "seed.txt" } }],
            "resources": { "cpuThreads": 1, "memoryBytes": 1024, "scratchBytes": 1024 },
            "outputs": [{ "outputId": "result", "relativePath": "result.json", "mediaType": "application/json", "expectedSha256": expected_sha256 }],
        });
        let path = self.root.join(format!("{job_id}.job.json"));
        fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
        let worker = self.worker();
        let report = worker.submit(&path).unwrap();
        assert!(report.created);
        assert_eq!(report.status, JobStatus::Queued);
        worker
    }

    fn run(&self, worker: &Worker, job_id: &str, restart: bool) -> Result<JobStatus> {
        worker
            .run(job_id, &self.runtime, &self.engines, restart)
            .map(|report| report.state.status)
    }
}

fn result_total(root: &Path, job_id: &str) -> serde_json::Value {
    serde_json::from_slice(
        &fs::read(
            root.join("jobs")
                .join(job_id)
                .join("outputs")
                .join("result.json"),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn completes_and_publishes_verified_artifacts() {
    let fx = Fixture::new("complete");
    let worker = fx.submit("job-a", serde_json::json!({ "steps": 5 }), None);
    assert_eq!(
        fx.run(&worker, "job-a", false).unwrap(),
        JobStatus::Completed
    );
    let artifacts = worker.artifacts("job-a").unwrap();
    assert!(artifacts.verified);
    assert_eq!(artifacts.manifest.artifacts.len(), 1);
    assert_eq!(result_total(&fx.root, "job-a")["total"], 7 * 5 + 10);
    let blob = worker
        .cas()
        .blob_path(&artifacts.manifest.artifacts[0].sha256);
    assert!(blob.is_file(), "artifact bytes are content-addressed");
    // Resubmitting the identical manifest is idempotent; a finished job cannot restart.
    let again = worker.submit(&fx.root.join("job-a.job.json")).unwrap();
    assert!(!again.created);
    assert!(matches!(
        fx.run(&worker, "job-a", false),
        Err(RunnerError::JobState { .. })
    ));
    // Tampering with a published output is detected by re-verification.
    fs::write(fx.root.join("jobs/job-a/outputs/result.json"), b"{}").unwrap();
    assert!(!worker.artifacts("job-a").unwrap().verified);
}

#[test]
fn wrong_artifact_claim_or_pinned_hash_fails_completion() {
    let fx = Fixture::new("claims");
    let worker = fx.submit(
        "job-bad",
        serde_json::json!({ "steps": 1, "claimWrongHash": true }),
        None,
    );
    assert_eq!(
        fx.run(&worker, "job-bad", false).unwrap(),
        JobStatus::Failed
    );
    let state = worker.status("job-bad").unwrap().state;
    assert_eq!(
        state.failure.as_ref().unwrap().code,
        "artifact.contract_violated"
    );
    assert!(!state.failure.unwrap().retryable);
    assert!(!fx.root.join("jobs/job-bad/outputs").exists());

    let worker = fx.submit(
        "job-pin",
        serde_json::json!({ "steps": 1 }),
        Some(&"f".repeat(64)),
    );
    assert_eq!(
        fx.run(&worker, "job-pin", false).unwrap(),
        JobStatus::Failed
    );
    assert!(worker
        .status("job-pin")
        .unwrap()
        .state
        .failure
        .unwrap()
        .message
        .contains("not byte-identical"));
}

#[test]
fn cancel_request_stops_at_safe_boundary() {
    let fx = Fixture::new("cancel");
    let worker = fx.submit(
        "job-c",
        serde_json::json!({ "steps": 10, "cancelAt": 3 }),
        None,
    );
    assert_eq!(
        fx.run(&worker, "job-c", false).unwrap(),
        JobStatus::Canceled
    );
    let report = worker.status("job-c").unwrap();
    assert_eq!(report.state.cancel.as_ref().unwrap().reason, "test cancel");
    assert!(!report.owner_alive);
    assert!(matches!(
        worker.cancel("job-c", "again"),
        Err(RunnerError::JobState { .. })
    ));

    let worker = fx.submit("job-q", serde_json::json!({ "steps": 1 }), None);
    assert_eq!(
        worker
            .cancel("job-q", "never started")
            .unwrap()
            .state
            .status,
        JobStatus::Canceled
    );
    assert_eq!(
        fx.run(&worker, "job-q", false).unwrap_err().code(),
        "job.invalid_state"
    );
}

#[test]
fn interrupted_attempt_resumes_from_verified_checkpoint() {
    let fx = Fixture::new("resume");
    let worker = fx.submit(
        "job-r",
        serde_json::json!({ "steps": 10, "checkpointEvery": 2, "dieAt": 5 }),
        None,
    );
    // The engine "dies" with an I/O failure after checkpoint 2 (step 4).
    assert_eq!(fx.run(&worker, "job-r", false).unwrap(), JobStatus::Failed);
    let state = worker.status("job-r").unwrap().state;
    assert!(state.failure.as_ref().unwrap().retryable);
    assert_eq!(state.checkpoint.as_ref().unwrap().sequence, 2);
    assert_eq!(state.attempt, 1);

    assert_eq!(
        fx.run(&worker, "job-r", false).unwrap(),
        JobStatus::Completed
    );
    let state = worker.status("job-r").unwrap().state;
    assert_eq!(state.attempt, 2);
    let result = result_total(&fx.root, "job-r");
    assert_eq!(
        result["resumedFrom"], 4,
        "second attempt continued from checkpoint 2"
    );
    assert_eq!(
        result["total"],
        7 * 10 + 45,
        "continuation matches uninterrupted execution"
    );
    let events = worker.attach("job-r", 0, |_| Ok(())).unwrap();
    assert_eq!(events.state.status, JobStatus::Completed);
}

#[test]
fn corrupt_checkpoint_is_refused_and_restart_discards_it() {
    let fx = Fixture::new("corrupt");
    let worker = fx.submit(
        "job-k",
        serde_json::json!({ "steps": 6, "checkpointEvery": 2, "dieAt": 5 }),
        None,
    );
    assert_eq!(fx.run(&worker, "job-k", false).unwrap(), JobStatus::Failed);
    let store = CheckpointStore::new(fx.root.join("jobs/job-k/checkpoints"));
    let latest = store.latest().unwrap().unwrap();
    fs::write(
        fx.root.join(format!(
            "jobs/job-k/checkpoints/{:012}/state.json",
            latest.sequence
        )),
        b"{\"step\":1,\"total\":0}",
    )
    .unwrap();
    assert_eq!(fx.run(&worker, "job-k", false).unwrap(), JobStatus::Failed);
    let failure = worker.status("job-k").unwrap().state.failure.unwrap();
    assert_eq!(failure.code, "content.integrity_mismatch");
    assert!(failure.retryable);
    // --restart discards the checkpoints and reruns from the immutable inputs.
    assert_eq!(
        fx.run(&worker, "job-k", true).unwrap(),
        JobStatus::Completed
    );
    assert_eq!(result_total(&fx.root, "job-k")["resumedFrom"], 0);
    assert_eq!(
        store.latest().unwrap().unwrap().attempt,
        3,
        "only checkpoints from the restarted attempt remain"
    );
}

#[test]
fn reconcile_marks_orphaned_jobs_interrupted_without_touching_content() {
    let fx = Fixture::new("reconcile");
    let worker = fx.submit("job-o", serde_json::json!({ "steps": 1 }), None);
    // Forge an active state with no live owner, as left by a SIGKILLed attempt.
    let dir = worker.job_dir("job-o").unwrap();
    let mut state = dir.load_state().unwrap();
    state.status = JobStatus::Running;
    state.attempt = 1;
    dir.save_state(&mut state).unwrap();
    let blob_count_before = fs::read_dir(fx.root.join("cas/sha256")).unwrap().count();
    let report = worker.reconcile().unwrap();
    assert_eq!(report.interrupted, vec!["job-o".to_string()]);
    assert_eq!(
        worker.status("job-o").unwrap().state.status,
        JobStatus::Interrupted
    );
    assert_eq!(
        fs::read_dir(fx.root.join("cas/sha256")).unwrap().count(),
        blob_count_before
    );
    assert!(fx.root.join("seed.txt").is_file(), "source asset untouched");
    assert_eq!(
        fx.run(&worker, "job-o", false).unwrap(),
        JobStatus::Completed
    );
}

#[test]
fn unavailable_engine_and_runtime_pin_are_explicit_errors() {
    let fx = Fixture::new("engine");
    let worker = fx.submit("job-e", serde_json::json!({ "steps": 1 }), None);
    let empty = EngineRegistry::new();
    let error = worker.run("job-e", &fx.runtime, &empty, false).unwrap_err();
    assert_eq!(error.code(), "engine.unavailable");
    assert_eq!(
        worker.status("job-e").unwrap().state.status,
        JobStatus::Queued,
        "job stays queued for a runtime that has the engine"
    );

    let manifest_path = fx.root.join("job-e.job.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["jobId"] = "job-pinned".into();
    manifest["runtime"] = serde_json::json!({ "runtimeId": "b".repeat(64) });
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    worker.submit(&manifest_path).unwrap();
    assert_eq!(
        fx.run(&worker, "job-pinned", false).unwrap_err().code(),
        "job.invalid_state"
    );
}

#[test]
fn manifest_validation_rejects_escapes_and_duplicates() {
    let fx = Fixture::new("manifest");
    let worker = fx.worker();
    let bad = fx.root.join("bad.json");
    let base = serde_json::json!({
        "schema": "simforge.native-job/v1", "jobId": "x", "workload": WORKLOAD,
        "resources": { "cpuThreads": 1, "memoryBytes": 1, "scratchBytes": 0 },
        "outputs": [{ "outputId": "o", "relativePath": "../escape", "mediaType": "text/plain" }],
    });
    fs::write(&bad, serde_json::to_vec(&base).unwrap()).unwrap();
    assert_eq!(
        worker.submit(&bad).unwrap_err().code(),
        "job.invalid_manifest"
    );
    let mut dup = base.clone();
    dup["outputs"] = serde_json::json!([
        { "outputId": "o", "relativePath": "a", "mediaType": "text/plain" },
        { "outputId": "o", "relativePath": "b", "mediaType": "text/plain" }
    ]);
    fs::write(&bad, serde_json::to_vec(&dup).unwrap()).unwrap();
    assert_eq!(
        worker.submit(&bad).unwrap_err().code(),
        "job.invalid_manifest"
    );
    let mut unknown = base.clone();
    unknown["outputs"] =
        serde_json::json!([{ "outputId": "o", "relativePath": "a", "mediaType": "text/plain" }]);
    unknown["legacyField"] = serde_json::json!(true);
    fs::write(&bad, serde_json::to_vec(&unknown).unwrap()).unwrap();
    assert_eq!(
        worker.submit(&bad).unwrap_err().code(),
        "runner.invalid_json"
    );
}
