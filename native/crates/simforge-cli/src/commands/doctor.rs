//! `simforge doctor`: can this machine pull, render and serve?
//!
//! Every check reports `ok`, `warn`, `fail` or `skipped`, with the evidence it
//! looked at. Nothing degrades silently: a check that was not run says
//! `skipped` and why, a software-only GPU is a finding rather than a pass, and
//! any `fail` makes the command exit 2 (it ran and found the environment
//! wrong) with the full report still on stdout.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use clap::Args;
use serde::Serialize;
use serde_json::{json, Value};

use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::net;
use crate::paths::{self, Resolved};

#[derive(Debug, Args)]
pub struct DoctorArgs {
    /// Do not probe the registry (the check is reported as skipped, never as ok).
    #[arg(long)]
    pub offline: bool,
    /// Registry to probe. Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the public registry.
    #[arg(long, value_name = "URL")]
    pub registry: Option<String>,
    /// Network timeout for the registry probe.
    #[arg(long, value_name = "SECONDS", default_value_t = 10)]
    pub timeout: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Warn,
    Fail,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub status: Status,
    pub summary: String,
    pub detail: Value,
    /// What to do about a `warn` or `fail`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

impl Check {
    fn new(id: &'static str, status: Status, summary: impl Into<String>, detail: Value) -> Self {
        Self {
            id,
            status,
            summary: summary.into(),
            detail,
            fix: None,
        }
    }

    fn fix(mut self, fix: impl Into<String>) -> Self {
        self.fix = Some(fix.into());
        self
    }
}

/// Free space below which a cache root is a `fail` / a `warn`.
const DISK_FAIL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DISK_WARN_BYTES: u64 = 20 * 1024 * 1024 * 1024;

pub fn run(args: DoctorArgs, _ctx: &Ctx) -> CmdResult {
    if args.timeout == 0 {
        return Err(
            CliError::new("bad_value", "--timeout must be at least 1 second")
                .with_path("--timeout"),
        );
    }
    let mut checks = vec![gpu_check(), ffmpeg_check()];
    checks.extend(cache_checks());
    checks.push(registry_check(&args));
    Ok(report(checks))
}

pub fn report(checks: Vec<Check>) -> Outcome {
    let count = |s: Status| checks.iter().filter(|c| c.status == s).count();
    let summary = json!({
        "ok": count(Status::Ok),
        "warn": count(Status::Warn),
        "fail": count(Status::Fail),
        "skipped": count(Status::Skipped),
    });
    let failed = count(Status::Fail) > 0;
    let value = json!({
        "schema": "simforge.doctor/v1",
        "version": env!("CARGO_PKG_VERSION"),
        "ok": !failed,
        "summary": summary,
        "checks": checks,
    });
    if failed {
        Outcome::findings(value)
    } else {
        Outcome::ok(value)
    }
}

// ------------------------------------------------------------------ gpu

/// The renderer's baseline backends (render_core::platform::baseline_backends):
/// Metal on macOS, Vulkan or DX12 on Windows, Vulkan on Linux. `WGPU_BACKEND`
/// overrides it there for diagnostics, and here the same way. Kept in step by
/// hand until `render` links render-core, which then provides it.
fn baseline_backends() -> wgpu::Backends {
    if cfg!(target_os = "macos") {
        wgpu::Backends::METAL
    } else if cfg!(target_os = "windows") {
        wgpu::Backends::VULKAN | wgpu::Backends::DX12
    } else {
        wgpu::Backends::VULKAN
    }
}

fn is_software(kind: wgpu::DeviceType) -> bool {
    matches!(kind, wgpu::DeviceType::Cpu | wgpu::DeviceType::VirtualGpu)
}

/// The adapter a high-performance request picks among `infos`: discrete, then
/// integrated, then anything else that is hardware. `WGPU_ADAPTER_NAME`
/// (substring, case-insensitive) narrows the candidates first, as it does in
/// the renderer.
fn preferred(infos: &[wgpu::AdapterInfo], name_filter: Option<&str>) -> Option<usize> {
    let candidates: Vec<usize> = (0..infos.len())
        .filter(|&i| {
            name_filter.is_none_or(|n| infos[i].name.to_lowercase().contains(&n.to_lowercase()))
        })
        .collect();
    let rank = |kind: wgpu::DeviceType| match kind {
        wgpu::DeviceType::DiscreteGpu => 0,
        wgpu::DeviceType::IntegratedGpu => 1,
        wgpu::DeviceType::Other => 2,
        wgpu::DeviceType::VirtualGpu => 3,
        wgpu::DeviceType::Cpu => 4,
    };
    candidates
        .into_iter()
        .min_by_key(|&i| rank(infos[i].device_type))
}

fn gpu_check() -> Check {
    let backends = wgpu::Backends::from_env().unwrap_or_else(baseline_backends);
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = backends;
    descriptor.flags = wgpu::InstanceFlags::empty().with_env();
    let instance = wgpu::Instance::new(descriptor);
    let infos: Vec<wgpu::AdapterInfo> =
        futures_lite::future::block_on(instance.enumerate_adapters(backends))
            .iter()
            .map(|a| a.get_info())
            .collect();

    let name_filter = std::env::var("WGPU_ADAPTER_NAME")
        .ok()
        .filter(|s| !s.is_empty());
    let allow_software =
        std::env::var("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER").as_deref() == Ok("1");
    let adapters: Vec<Value> = infos
        .iter()
        .map(|info| {
            json!({
                "name": info.name,
                "type": format!("{:?}", info.device_type),
                "backend": format!("{:?}", info.backend),
                "driver": info.driver,
                "driverInfo": info.driver_info,
                "software": is_software(info.device_type),
            })
        })
        .collect();
    let env: Value = [
        "WGPU_BACKEND",
        "WGPU_ADAPTER_NAME",
        "VK_ICD_FILENAMES",
        "VK_DRIVER_FILES",
        "SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER",
    ]
    .iter()
    .filter_map(|k| {
        std::env::var(k)
            .ok()
            .map(|v| (k.to_string(), Value::String(v)))
    })
    .collect::<serde_json::Map<_, _>>()
    .into();
    let backend_names: Vec<&str> = [
        (wgpu::Backends::VULKAN, "vulkan"),
        (wgpu::Backends::METAL, "metal"),
        (wgpu::Backends::DX12, "dx12"),
        (wgpu::Backends::GL, "gl"),
        (wgpu::Backends::BROWSER_WEBGPU, "webgpu"),
    ]
    .into_iter()
    .filter(|(flag, _)| backends.contains(*flag))
    .map(|(_, name)| name)
    .collect();
    let mut detail = json!({ "backends": backend_names, "adapters": adapters, "env": env });

    let Some(selected) = preferred(&infos, name_filter.as_deref()) else {
        let summary = if infos.is_empty() {
            format!("no {} adapter found", backend_names.join("/"))
        } else {
            format!(
                "no adapter matches WGPU_ADAPTER_NAME={}",
                name_filter.as_deref().unwrap_or_default()
            )
        };
        return Check::new("gpu", Status::Fail, summary, detail).fix(if cfg!(target_os = "linux") {
            "install the GPU's Vulkan driver (or mesa-vulkan-drivers for lavapipe) and check `vulkaninfo --summary`"
        } else {
            "install the GPU driver for the platform's graphics API"
        });
    };
    let info = &infos[selected];
    detail["selected"] = json!(info.name);
    if !is_software(info.device_type) {
        return Check::new(
            "gpu",
            Status::Ok,
            format!("{} ({:?}, {:?})", info.name, info.device_type, info.backend),
            detail,
        );
    }
    if allow_software {
        Check::new(
            "gpu",
            Status::Warn,
            format!("only a software adapter: {} ({:?}); renders run on it by explicit opt-in, slowly, and differ from GPU output", info.name, info.device_type),
            detail,
        )
        .fix("use a hardware GPU for production renders; software adapters are for tests and goldens")
    } else {
        Check::new(
            "gpu",
            Status::Fail,
            format!("only a software adapter: {} ({:?}); the renderer refuses it", info.name, info.device_type),
            detail,
        )
        .fix("install a hardware GPU driver, or set SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER=1 to render on the software adapter explicitly")
    }
}

// ------------------------------------------------------------------ ffmpeg

fn find_on_path(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(&exe))
        .find(|p| p.is_file())
}

fn ffmpeg_check() -> Check {
    let (path, source) = match std::env::var("SIMFORGE_FFMPEG_BINARY")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        Some(explicit) => (
            Some(PathBuf::from(explicit.trim())),
            "env:SIMFORGE_FFMPEG_BINARY",
        ),
        None => (find_on_path("ffmpeg"), "path"),
    };
    let Some(path) = path else {
        return Check::new(
            "ffmpeg",
            Status::Warn,
            "ffmpeg not found: renders write frames and record the video as skipped",
            json!({ "searched": "PATH" }),
        )
        .fix("install ffmpeg with libx264, or set SIMFORGE_FFMPEG_BINARY");
    };
    let run = |args: &[&str]| Command::new(&path).args(args).output();
    let version = match run(&["-hide_banner", "-version"]) {
        // "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) ..." -> "ffmpeg version 6.1.1-3ubuntu5"
        Ok(out) if out.status.success() => {
            let line = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or_default().to_owned();
            line.split(" Copyright").next().unwrap_or(&line).trim().to_owned()
        }
        Ok(out) => {
            return Check::new(
                "ffmpeg",
                Status::Fail,
                format!("{} exited with {} for -version", path.display(), out.status),
                json!({ "path": path, "source": source, "stderr": String::from_utf8_lossy(&out.stderr).trim() }),
            )
            .fix("repair or replace this ffmpeg")
        }
        Err(error) => {
            // An explicit SIMFORGE_FFMPEG_BINARY that does not run is a configuration error.
            let status = if source == "path" { Status::Warn } else { Status::Fail };
            return Check::new("ffmpeg", status, format!("could not run {}: {error}", path.display()), json!({ "path": path, "source": source }))
                .fix("point SIMFORGE_FFMPEG_BINARY at a working ffmpeg");
        }
    };
    let encoders = run(&["-hide_banner", "-encoders"])
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let has = |name: &str| {
        encoders
            .lines()
            .any(|line| line.split_whitespace().nth(1) == Some(name))
    };
    let detail = json!({
        "path": path,
        "source": source,
        "version": version,
        "encoders": { "libx264": has("libx264"), "h264_nvenc": has("h264_nvenc") },
    });
    if has("libx264") {
        Check::new("ffmpeg", Status::Ok, version, detail)
    } else {
        Check::new(
            "ffmpeg",
            Status::Warn,
            format!("{version}, but without libx264 (the reference video encoder)"),
            detail,
        )
        .fix("install an ffmpeg build with libx264")
    }
}

// ------------------------------------------------------------------ cache roots + disk

fn nearest_existing(path: &Path) -> Option<&Path> {
    path.ancestors().find(|p| p.exists())
}

/// Whether a file can be created in `dir` (created and removed again).
fn writable(dir: &Path) -> Result<(), std::io::Error> {
    let probe = dir.join(format!(".simforge-doctor-{}", std::process::id()));
    std::fs::write(&probe, b"")?;
    std::fs::remove_file(&probe)
}

fn gib(bytes: u64) -> f64 {
    (bytes as f64 / (1024.0 * 1024.0 * 1024.0) * 10.0).round() / 10.0
}

fn root_checks(
    id: &'static str,
    disk_id: &'static str,
    label: &str,
    root: Result<Resolved<PathBuf>, CliError>,
    out: &mut Vec<Check>,
) {
    let root = match root {
        Ok(root) => root,
        Err(error) => {
            out.push(
                Check::new(
                    id,
                    Status::Fail,
                    format!("no {label} root: {}", error.reason),
                    error.to_json(),
                )
                .fix("set XDG_DATA_HOME or HOME"),
            );
            out.push(Check::new(
                disk_id,
                Status::Skipped,
                format!("no {label} root to measure"),
                json!({}),
            ));
            return;
        }
    };
    let path = &root.value;
    let exists = path.is_dir();
    let base = detail_base(root.clone(), exists);
    if path.exists() && !exists {
        out.push(
            Check::new(
                id,
                Status::Fail,
                format!("{} exists but is not a directory", path.display()),
                base.clone(),
            )
            .fix("move the file away or choose another root"),
        );
        out.push(Check::new(
            disk_id,
            Status::Skipped,
            format!("{label} root is not a directory"),
            json!({}),
        ));
        return;
    }
    let Some(anchor) = nearest_existing(path) else {
        out.push(
            Check::new(
                id,
                Status::Fail,
                format!("no existing ancestor of {}", path.display()),
                base,
            )
            .fix("choose a root on a mounted filesystem"),
        );
        out.push(Check::new(
            disk_id,
            Status::Skipped,
            format!("{label} root has no existing ancestor"),
            json!({}),
        ));
        return;
    };
    match writable(anchor) {
        Ok(()) => {
            let summary = if exists {
                format!("{} ({})", path.display(), root.source)
            } else {
                format!(
                    "{} ({}; created on first use under {})",
                    path.display(),
                    root.source,
                    anchor.display()
                )
            };
            out.push(Check::new(id, Status::Ok, summary, base));
        }
        Err(error) => out.push(
            Check::new(
                id,
                Status::Fail,
                format!("{} is not writable: {error}", anchor.display()),
                base,
            )
            .fix(format!(
                "fix the permissions on {} or choose another root",
                anchor.display()
            )),
        ),
    }
    match fs4::available_space(anchor) {
        Ok(free) => {
            let detail = json!({ "path": path, "measuredAt": anchor, "freeBytes": free, "freeGiB": gib(free) });
            let check = if free < DISK_FAIL_BYTES {
                Check::new(
                    disk_id,
                    Status::Fail,
                    format!("{} GiB free for the {label}", gib(free)),
                    detail,
                )
                .fix("free disk space or move the root")
            } else if free < DISK_WARN_BYTES {
                Check::new(
                    disk_id,
                    Status::Warn,
                    format!(
                        "{} GiB free for the {label}; a large map needs several GiB",
                        gib(free)
                    ),
                    detail,
                )
                .fix("free disk space or move the root")
            } else {
                Check::new(
                    disk_id,
                    Status::Ok,
                    format!("{} GiB free for the {label}", gib(free)),
                    detail,
                )
            };
            out.push(check);
        }
        Err(error) => out.push(Check::new(
            disk_id,
            Status::Fail,
            format!(
                "could not measure free space at {}: {error}",
                anchor.display()
            ),
            json!({ "path": path }),
        )),
    }
}

fn detail_base(root: Resolved<PathBuf>, exists: bool) -> Value {
    json!({ "path": root.value, "source": root.source, "exists": exists })
}

fn cache_checks() -> Vec<Check> {
    let mut out = Vec::new();
    root_checks(
        "maps-cache",
        "maps-disk",
        "map cache",
        paths::maps_root(None),
        &mut out,
    );
    root_checks(
        "assets-cache",
        "assets-disk",
        "actor-asset store",
        paths::assets_root(None),
        &mut out,
    );
    out
}

// ------------------------------------------------------------------ registry

fn registry_check(args: &DoctorArgs) -> Check {
    let registry = paths::registry_url(args.registry.as_deref());
    let url = format!("{}/index.json", registry.value);
    let base = json!({ "registry": registry.value, "source": registry.source, "url": url });
    if args.offline {
        return Check::new("registry", Status::Skipped, "not probed (--offline)", base);
    }
    let started = Instant::now();
    let result = net::get_bytes(&url, Duration::from_secs(args.timeout));
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let mut detail = base;
    detail["elapsedMs"] = json!(elapsed_ms);
    match result {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Map<String, Value>>(&bytes) {
            Ok(index) => {
                let maps: Vec<&String> = index.keys().collect();
                detail["maps"] = json!(maps);
                Check::new(
                    "registry",
                    Status::Ok,
                    format!("{} reachable, {} map(s)", registry.value, maps.len()),
                    detail,
                )
            }
            Err(error) => {
                detail["error"] = json!(error.to_string());
                Check::new(
                    "registry",
                    Status::Fail,
                    format!("{url} is not a registry index"),
                    detail,
                )
                .fix("check the registry URL")
            }
        },
        Err(error) => {
            detail["error"] = json!(error.to_string());
            Check::new("registry", Status::Fail, format!("{url}: {error}"), detail)
                .fix("check the network or the registry URL; use --offline to skip this probe explicitly")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(name: &str, kind: wgpu::DeviceType) -> wgpu::AdapterInfo {
        wgpu::AdapterInfo {
            name: name.into(),
            vendor: 0,
            device: 0,
            device_type: kind,
            device_pci_bus_id: String::new(),
            driver: String::new(),
            driver_info: String::new(),
            backend: wgpu::Backend::Vulkan,
            subgroup_min_size: 0,
            subgroup_max_size: 0,
            transient_saves_memory: false,
        }
    }

    #[test]
    fn prefers_discrete_then_integrated_and_honours_the_name_filter() {
        let infos = vec![
            info("llvmpipe", wgpu::DeviceType::Cpu),
            info("Intel UHD", wgpu::DeviceType::IntegratedGpu),
            info("NVIDIA GeForce RTX 5080", wgpu::DeviceType::DiscreteGpu),
        ];
        assert_eq!(preferred(&infos, None), Some(2));
        assert_eq!(preferred(&infos, Some("intel")), Some(1));
        assert_eq!(preferred(&infos, Some("llvm")), Some(0));
        assert_eq!(preferred(&infos, Some("radeon")), None);
        assert_eq!(preferred(&infos[..1], None), Some(0));
        assert_eq!(preferred(&[], None), None);
    }

    #[test]
    fn any_fail_is_exit_2_and_skips_are_counted() {
        let outcome = report(vec![
            Check::new("a", Status::Ok, "", json!({})),
            Check::new("b", Status::Skipped, "", json!({})),
        ]);
        assert_eq!(outcome.exit, crate::contract::Exit::Ok);
        assert_eq!(outcome.value["summary"]["skipped"], 1);
        let outcome = report(vec![
            Check::new("a", Status::Warn, "", json!({})),
            Check::new("b", Status::Fail, "", json!({})),
        ]);
        assert_eq!(outcome.exit, crate::contract::Exit::Findings);
        assert_eq!(outcome.value["ok"], false);
    }
}
