//! Bounded resource declarations and worker admission.
//!
//! A job declares what it may consume up front; a worker declares what it
//! has. Admission is the only place the two meet: a job that does not fit
//! the free capacity is refused with an explicit reason, never queued into an
//! oversubscribed device. GPU devices are exclusive and owned through a lock
//! file, so a crashed job releases its device without any ledger repair.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::now_rfc3339;
use crate::error::{Result, RunnerError};
use crate::fsatomic::{ensure_dir, read_json};
use crate::lockfile::{FileLock, LockAttempt};

pub const WORKER_CAPACITY_SCHEMA: &str = "simforge.worker-capacity/v1";
pub const MAX_GPUS_PER_JOB: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDeclaration {
    pub cpu_threads: u32,
    pub memory_bytes: u64,
    /// Scratch bytes for staging outputs and checkpoints under the job dir.
    pub scratch_bytes: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gpus: Vec<GpuRequest>,
    /// Upper bound on wall clock for one attempt; the engine's cancel token
    /// trips when it elapses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_clock_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuRequest {
    pub min_vram_bytes: u64,
    /// Restrict to one physical device (driver UUID such as `GPU-...`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
}

impl ResourceDeclaration {
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.cpu_threads == 0 {
            return Err("resources.cpuThreads must be at least 1".into());
        }
        if self.memory_bytes == 0 {
            return Err("resources.memoryBytes must be at least 1".into());
        }
        if self.gpus.len() > MAX_GPUS_PER_JOB {
            return Err(format!(
                "resources.gpus may declare at most {MAX_GPUS_PER_JOB} devices"
            ));
        }
        if self.wall_clock_seconds == Some(0) {
            return Err("resources.wallClockSeconds must be positive when present".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerCapacity {
    pub schema: String,
    pub cpu_threads: u32,
    pub memory_bytes: u64,
    pub scratch_bytes: u64,
    #[serde(default)]
    pub gpus: Vec<GpuDevice>,
    /// `declared` when read from `worker/capacity.json`, `probed` when derived
    /// from the operating system (which never reports GPUs).
    pub origin: CapacityOrigin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapacityOrigin {
    Declared,
    Probed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuDevice {
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    pub vram_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    pub cpu_threads: u32,
    pub memory_bytes: u64,
    pub scratch_bytes: u64,
}

impl ResourceUsage {
    pub fn add(&mut self, declaration: &ResourceDeclaration) {
        self.cpu_threads = self.cpu_threads.saturating_add(declaration.cpu_threads);
        self.memory_bytes = self.memory_bytes.saturating_add(declaration.memory_bytes);
        self.scratch_bytes = self.scratch_bytes.saturating_add(declaration.scratch_bytes);
    }
}

/// What a running attempt was granted; persisted in the job state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceGrant {
    pub cpu_threads: u32,
    pub memory_bytes: u64,
    pub scratch_bytes: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gpus: Vec<GpuDevice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_clock_seconds: Option<u64>,
    pub granted_at: String,
}

/// Holds the GPU locks for the lifetime of an attempt.
#[derive(Debug)]
pub struct Admission {
    pub grant: ResourceGrant,
    _gpu_locks: Vec<FileLock>,
}

impl WorkerCapacity {
    pub fn capacity_path(worker_dir: &Path) -> PathBuf {
        worker_dir.join("capacity.json")
    }

    /// Reads the declared capacity or probes the host. A declared file with
    /// the wrong schema is an error, not a silent probe.
    pub fn load(worker_dir: &Path) -> Result<Self> {
        let path = Self::capacity_path(worker_dir);
        if path.exists() {
            let mut capacity: WorkerCapacity = read_json(&path)?;
            if capacity.schema != WORKER_CAPACITY_SCHEMA {
                return Err(RunnerError::Runtime {
                    path,
                    reason: format!("capacity schema must be {WORKER_CAPACITY_SCHEMA}"),
                });
            }
            let mut seen = std::collections::BTreeSet::new();
            for gpu in &capacity.gpus {
                if !seen.insert(gpu.index) {
                    return Err(RunnerError::Runtime {
                        path,
                        reason: format!("duplicate gpu index {}", gpu.index),
                    });
                }
            }
            capacity.origin = CapacityOrigin::Declared;
            return Ok(capacity);
        }
        Ok(Self::probe(worker_dir))
    }

    pub fn probe(worker_dir: &Path) -> Self {
        WorkerCapacity {
            schema: WORKER_CAPACITY_SCHEMA.to_owned(),
            cpu_threads: std::thread::available_parallelism()
                .map(|count| count.get() as u32)
                .unwrap_or(1),
            memory_bytes: probe_memory_bytes(),
            scratch_bytes: probe_free_bytes(worker_dir),
            gpus: Vec::new(),
            origin: CapacityOrigin::Probed,
        }
    }

    /// Admits `request` against free capacity, taking exclusive GPU locks
    /// under `worker_dir/locks`. `in_use` is the sum of declarations of jobs
    /// currently owned by live processes on this worker.
    pub fn admit(
        &self,
        worker_dir: &Path,
        request: &ResourceDeclaration,
        in_use: &ResourceUsage,
    ) -> Result<Admission> {
        let refuse = |reason: String| Err(RunnerError::Admission { reason });
        let free_cpu = self.cpu_threads.saturating_sub(in_use.cpu_threads);
        if request.cpu_threads > free_cpu {
            return refuse(format!(
                "cpuThreads {} exceeds free {free_cpu} of {}",
                request.cpu_threads, self.cpu_threads
            ));
        }
        let free_memory = self.memory_bytes.saturating_sub(in_use.memory_bytes);
        if request.memory_bytes > free_memory {
            return refuse(format!(
                "memoryBytes {} exceeds free {free_memory} of {}",
                request.memory_bytes, self.memory_bytes
            ));
        }
        let free_scratch = self.scratch_bytes.saturating_sub(in_use.scratch_bytes);
        if request.scratch_bytes > free_scratch {
            return refuse(format!(
                "scratchBytes {} exceeds free {free_scratch} of {}",
                request.scratch_bytes, self.scratch_bytes
            ));
        }
        if !request.gpus.is_empty() && self.gpus.is_empty() {
            return refuse(format!(
                "job requests {} gpu(s) but this worker declares none ({})",
                request.gpus.len(),
                match self.origin {
                    CapacityOrigin::Declared => "capacity.json lists no gpus",
                    CapacityOrigin::Probed =>
                        "no worker/capacity.json; probed capacity never includes gpus",
                }
            ));
        }

        let locks_dir = worker_dir.join("locks");
        ensure_dir(&locks_dir)?;
        let mut locks = Vec::with_capacity(request.gpus.len());
        let mut granted = Vec::with_capacity(request.gpus.len());
        for wanted in &request.gpus {
            let mut acquired = None;
            for device in &self.gpus {
                if device.vram_bytes < wanted.min_vram_bytes {
                    continue;
                }
                if let Some(uuid) = &wanted.uuid {
                    if device.uuid.as_deref() != Some(uuid.as_str()) {
                        continue;
                    }
                }
                if granted
                    .iter()
                    .any(|taken: &GpuDevice| taken.index == device.index)
                {
                    continue;
                }
                let lock_path = locks_dir.join(format!("gpu-{}.lock", device.index));
                if let LockAttempt::Acquired(lock) = FileLock::try_acquire(&lock_path, "gpu")? {
                    acquired = Some((device.clone(), lock));
                    break;
                }
            }
            match acquired {
                Some((device, lock)) => {
                    granted.push(device);
                    locks.push(lock);
                }
                None => {
                    return refuse(format!(
                        "no free gpu with at least {} bytes vram{}",
                        wanted.min_vram_bytes,
                        wanted
                            .uuid
                            .as_ref()
                            .map(|uuid| format!(" and uuid {uuid}"))
                            .unwrap_or_default()
                    ));
                }
            }
        }
        Ok(Admission {
            grant: ResourceGrant {
                cpu_threads: request.cpu_threads,
                memory_bytes: request.memory_bytes,
                scratch_bytes: request.scratch_bytes,
                gpus: granted,
                wall_clock_seconds: request.wall_clock_seconds,
                granted_at: now_rfc3339(),
            },
            _gpu_locks: locks,
        })
    }
}

fn probe_memory_bytes() -> u64 {
    // SAFETY: sysconf has no preconditions; negative results mean "unknown".
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGE_SIZE) };
    if pages <= 0 || page_size <= 0 {
        return 0;
    }
    (pages as u64).saturating_mul(page_size as u64)
}

fn probe_free_bytes(dir: &Path) -> u64 {
    let _ = ensure_dir(dir);
    let Ok(c_path) = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()) else {
        return 0;
    };
    // SAFETY: `stats` is a plain C struct fully written by statvfs on success.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    let status = unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) };
    if status != 0 {
        return 0;
    }
    (stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64)
}
