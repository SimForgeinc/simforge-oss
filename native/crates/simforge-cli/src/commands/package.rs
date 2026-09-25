//! `simforge package`: `simforge.scenario-package/v1` containers
//! (docs/engineering/scenario-package.md), through the `simforge-package`
//! crate the hosted exporter writes them with.
//!
//! - `inspect` opens a package (structure, manifest, version skew) without
//!   hashing member data;
//! - `verify` hashes every member and runs every cross-check; any refusal
//!   exits 2 with the crate's stable `code` and the exact `rule`;
//! - `import` verifies, unpacks into a workspace directory, and resolves what
//!   a render needs that the package names by digest: the map (a release in
//!   the public registry whose OpenDRIVE and shared members match the
//!   package's map closure, pulled by digest into the maps cache exactly as
//!   `maps pull` does) and the actor closure (pulled by digest into the
//!   actor-asset root exactly as `assets pull` does). A thin package from the
//!   hosted app then renders on a clean machine with `package import` then
//!   `render`. What is not available publicly (a private map) fails with
//!   `package_closure_unavailable`, listing it; `--offline` fetches nothing
//!   and reports what is still missing.
//!
//! A package names everything by digest; nothing is resolved by name alone.

use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use serde_json::{json, Value};
use simforge_package::{Inspection, PackageError, PackageReader, Verification, VerifyOptions};

use crate::commands::assets;
use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::installed_maps;
use crate::paths;
use crate::registry::{self, PullOptions, Registry};

#[derive(Debug, Subcommand)]
pub enum PackageCommand {
    /// Print a package's manifest, producer and members without unpacking it.
    Inspect(PackageArgs),
    /// Verify the manifest and every member digest; exit 2 on any mismatch.
    Verify(PackageArgs),
    /// Verify, then unpack into a local workspace.
    Import(ImportArgs),
}

#[derive(Debug, Args)]
pub struct PackageArgs {
    /// The package file.
    #[arg(value_name = "PACKAGE.ZIP")]
    pub package: PathBuf,
}

#[derive(Debug, Args)]
pub struct ImportArgs {
    /// The package file.
    #[arg(value_name = "PACKAGE.ZIP")]
    pub package: PathBuf,
    /// The workspace directory to create (must not exist, or be empty).
    #[arg(long, value_name = "DIR")]
    pub into: PathBuf,
    /// Map cache root to check for the package's map. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps.
    #[arg(long, value_name = "DIR")]
    pub cache_root: Option<PathBuf>,
    /// Actor-asset root to check for the package's actor closure. Default: SIMFORGE_ACTOR_ASSETS_ROOT, then $XDG_DATA_HOME/simforge/actor-assets.
    #[arg(long, value_name = "DIR")]
    pub assets_root: Option<PathBuf>,
    /// Fetch nothing: report the map and actor closure this machine still lacks.
    #[arg(long)]
    pub offline: bool,
    /// Map registry to resolve the package's map from. Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the public registry.
    #[arg(long, value_name = "URL")]
    pub registry: Option<String>,
    /// Asset store for the actor closure. Default: SIMFORGE_ACTOR_ASSETS_BASE_URL, then the public store.
    #[arg(long, value_name = "URL")]
    pub assets_base_url: Option<String>,
}

pub fn run(command: PackageCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        PackageCommand::Inspect(args) => inspect(&args.package),
        PackageCommand::Verify(args) => verify(&args.package),
        PackageCommand::Import(args) => import(args),
    }
}

/// The package crate's refusals in the CLI contract: I/O is "could not run"
/// (exit 1), every other family is a finding about the package (exit 2).
fn package_error(error: PackageError, package: &Path) -> CliError {
    let code = error.code.as_str();
    let mut detail = json!({ "rule": error.rule });
    if !error.dimensions.is_empty() {
        detail["dimensions"] = json!(error.dimensions);
    }
    let base = if error.code == simforge_package::ErrorCode::Io {
        CliError::new(code, error.message.clone())
    } else {
        CliError::findings(code, error.message.clone())
    };
    let path = error
        .path
        .clone()
        .unwrap_or_else(|| package.display().to_string());
    base.with_path(path).with_detail(detail)
}

fn options() -> Result<VerifyOptions, CliError> {
    VerifyOptions::new(Some(env!("CARGO_PKG_VERSION")))
        .map_err(|e| CliError::new("internal_error", format!("reader support: {}", e.message)))
}

fn open(package: &Path) -> Result<PackageReader<std::io::BufReader<std::fs::File>>, CliError> {
    if !package.is_file() {
        return Err(CliError::new(
            "missing_file",
            format!("{} is not a file", package.display()),
        )
        .with_path(package.display().to_string()));
    }
    PackageReader::open_file(package, &options()?).map_err(|e| package_error(e, package))
}

fn inspection_json(inspection: &Inspection) -> Value {
    let m = &inspection.manifest;
    json!({
        "packageId": inspection.package_id,
        "displayId": inspection.display_id,
        "form": inspection.form,
        "containerBytes": inspection.container_bytes,
        "entries": inspection.entries,
        "cliCheck": inspection.cli_check,
        "producer": m.producer,
        "scenario": m.scenario,
        "engine": m.engine,
        "simulation": m.simulation,
        "timelines": m.timelines,
        "map": m.map,
        "catalog": m.catalog,
        "render": m.render,
        "members": m.members,
        "receipt": inspection.receipt,
    })
}

fn verification_json(verification: &Verification) -> Value {
    let mut out = inspection_json(&verification.inspection);
    out["verified"] = json!(true);
    out["content"] = json!(verification.content);
    out
}

fn inspect(package: &Path) -> CmdResult {
    let reader = open(package)?;
    let mut out = inspection_json(&reader.inspection());
    out["package"] = json!(paths::absolutize(package));
    out["verified"] = json!(false);
    Ok(Outcome::ok(out))
}

fn verify(package: &Path) -> CmdResult {
    let mut reader = open(package)?;
    let verification = reader.verify().map_err(|e| package_error(e, package))?;
    let mut out = verification_json(&verification);
    out["package"] = json!(paths::absolutize(package));
    Ok(Outcome::ok(out))
}

/// The package's map closure listing (`map/closure.json`, a
/// `uniscenario.browser-asset-set/v1`): relative path to (sha256, bytes).
fn package_map_members(
    ws: &Path,
) -> Result<std::collections::BTreeMap<String, (String, u64)>, CliError> {
    let path = ws.join("map").join("closure.json");
    let bytes = std::fs::read(&path).map_err(|e| {
        CliError::findings(
            "package_member_invalid",
            format!("cannot read map/closure.json: {e}"),
        )
    })?;
    let doc: Value = serde_json::from_slice(&bytes).map_err(|e| {
        CliError::findings(
            "package_member_invalid",
            format!("map/closure.json is not JSON: {e}"),
        )
    })?;
    let mut out = std::collections::BTreeMap::new();
    for m in doc["members"].as_array().into_iter().flatten() {
        if let (Some(p), Some(sha), Some(n)) = (
            m["relativePath"].as_str(),
            m["sha256"].as_str(),
            m["byteLength"].as_u64(),
        ) {
            out.insert(p.to_owned(), (sha.to_owned(), n));
        }
    }
    Ok(out)
}

/// Shared paths whose digests differ between the package's map closure and
/// `other` (path to sha256).
fn drift(
    package: &std::collections::BTreeMap<String, (String, u64)>,
    other: &std::collections::BTreeMap<String, String>,
) -> (usize, Vec<Value>) {
    let mut shared = 0;
    let mut differing = Vec::new();
    for (path, (sha, _)) in package {
        if let Some(theirs) = other.get(path) {
            shared += 1;
            if theirs != sha {
                differing.push(json!({ "path": path, "package": sha, "release": theirs }));
            }
        }
    }
    (shared, differing)
}

/// The native install of the package's map, when one matches by content.
fn installed_native(
    maps_root: &Path,
    xodr: &str,
    members: &std::collections::BTreeMap<String, (String, u64)>,
) -> Option<installed_maps::InstalledMap> {
    installed_maps::list(maps_root)
        .into_iter()
        .filter(|m| m.profile == ".corpus" && m.xodr_sha256 == xodr)
        .find(|m| {
            let receipt: Value = std::fs::read(m.dir.join(".map-release.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null);
            let theirs: std::collections::BTreeMap<String, String> = receipt["members"]
                .as_object()
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v["sha256"].as_str()?.to_owned())))
                        .collect()
                })
                .unwrap_or_default();
            drift(members, &theirs).1.is_empty()
        })
}

/// Resolve the package's map: installed, pulled from the registry by digest,
/// skipped (offline), or unavailable (the returned detail lists why).
fn resolve_map(
    ws: &Path,
    manifest: &simforge_package::Manifest,
    args: &ImportArgs,
) -> Result<Result<Value, Value>, CliError> {
    let xodr = manifest.map.xodr_sha256.clone();
    let map_id = manifest.map.source_map_id.clone();
    let members = package_map_members(ws)?;
    let maps = paths::maps_root(args.cache_root.as_deref())?;
    let base = json!({ "xodrSha256": xodr, "mapId": map_id, "mapsRoot": maps.value });
    if let Some(m) = installed_native(&maps.value, &xodr, &members) {
        let mut out = base;
        out["state"] = json!("installed");
        out["native"] = json!(m.dir);
        out["release"] = json!(m.release);
        return Ok(Ok(out));
    }
    if args.offline {
        let mut out = base;
        out["state"] = json!("skipped");
        out["reason"] = json!("--offline");
        return Ok(Ok(out));
    }
    let url = paths::registry_url(args.registry.as_deref());
    let token = std::env::var(registry::TOKEN_ENV)
        .ok()
        .filter(|t| !t.trim().is_empty());
    let reg = Registry::new(&url.value, token)?;
    let index = reg.index()?;
    // The map's own name first, then every other published map: content decides.
    let mut names: Vec<String> = index
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    names.sort_by_key(|n| n != &map_id);
    let mut candidates = Vec::new();
    for name in names {
        let mut versions: Vec<String> = index[&name]["versions"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        versions.sort_by_key(|v| {
            std::cmp::Reverse(v.trim_start_matches('v').parse::<u64>().unwrap_or(0))
        });
        for version in versions {
            let reference = format!("{name}@{version}");
            let resolved = match registry::resolve(&reg, &reference) {
                Ok(r) => r,
                Err(e) if e.exit == crate::contract::Exit::Findings => {
                    candidates.push(json!({ "release": reference, "unusable": e.reason }));
                    continue;
                }
                Err(e) => return Err(e),
            };
            if resolved
                .closure
                .members
                .get("map.xodr")
                .map(|m| m.sha256.as_str())
                != Some(xodr.as_str())
            {
                continue;
            }
            let theirs = resolved
                .closure
                .members
                .iter()
                .map(|(p, m)| (p.clone(), m.sha256.clone()))
                .collect();
            let (shared, differing) = drift(&members, &theirs);
            if !differing.is_empty() || !resolved.closure.master {
                candidates.push(json!({
                    "release": reference,
                    "shared": shared,
                    "differingCount": differing.len(),
                    "differing": differing.into_iter().take(10).collect::<Vec<_>>(),
                    "master": resolved.closure.master,
                }));
                continue;
            }
            let summary = registry::pull(
                &reg,
                &reference,
                &PullOptions {
                    cache_root: maps.value.clone(),
                    archive: false,
                    concurrency: 8,
                },
            )?;
            let mut out = base;
            out["state"] = json!("pulled");
            out["release"] = json!(reference);
            out["registry"] = json!(reg.url);
            out["sharedMembers"] = json!(shared);
            out["pull"] = summary;
            return Ok(Ok(out));
        }
    }
    // Nothing public carries this map: say what is missing, by digest.
    let blob_root = maps.value.join(".blobs");
    let missing: Vec<(&String, &(String, u64))> = members
        .iter()
        .filter(|(_, (sha, n))| {
            std::fs::metadata(blob_root.join("sha256").join(&sha[..2]).join(sha))
                .map(|m| m.len() != *n)
                .unwrap_or(true)
        })
        .collect();
    let mut out = base;
    out["state"] = json!("unavailable");
    out["registry"] = json!(reg.url);
    out["candidates"] = json!(candidates);
    out["missing"] = json!({
        "count": missing.len(),
        "bytes": missing.iter().map(|(_, (_, n))| n).sum::<u64>(),
        "members": missing.iter().take(20).map(|(p, (sha, n))| json!({ "path": p, "sha256": sha, "bytes": n })).collect::<Vec<_>>(),
    });
    Ok(Err(out))
}

/// Resolve the package's actor closure: installed, pulled by digest,
/// skipped (offline), or unavailable.
fn resolve_actors(
    manifest: &simforge_package::Manifest,
    args: &ImportArgs,
) -> Result<Result<Value, Value>, CliError> {
    let digest = manifest.catalog.actor_closure_digest.clone();
    let root = paths::assets_root(args.assets_root.as_deref())?;
    let base = json!({ "digest": digest, "root": root.value });
    let doc = root.value.join("closures").join(format!("{digest}.json"));
    let installed = std::fs::read(&doc).ok().and_then(|bytes| {
        use sha2::Digest;
        let sha: String = sha2::Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if sha != digest {
            return None;
        }
        let closure: Value = serde_json::from_slice(&bytes).ok()?;
        let complete = closure["members"].as_object()?.values().all(|m| {
            let (Some(sha), Some(n)) = (m["sha256"].as_str(), m["bytes"].as_u64()) else {
                return false;
            };
            std::fs::metadata(root.value.join("blobs/sha256").join(&sha[..2]).join(sha))
                .map(|f| f.len() == n)
                .unwrap_or(false)
        });
        complete.then_some(())
    });
    if installed.is_some() {
        let mut out = base;
        out["state"] = json!("installed");
        out["note"] = json!("sizes checked here; render re-verifies every byte");
        return Ok(Ok(out));
    }
    if args.offline {
        let mut out = base;
        out["state"] = json!("skipped");
        out["reason"] = json!("--offline");
        return Ok(Ok(out));
    }
    match assets::pull(assets::PullArgs {
        closure: Some(digest.clone()),
        base_url: args.assets_base_url.clone(),
        root: args.assets_root.clone(),
        timeout: 60,
    }) {
        Ok(outcome) => {
            let mut out = base;
            out["state"] = json!("pulled");
            out["pull"] = outcome.value;
            Ok(Ok(out))
        }
        Err(e) if e.code == "unknown_closure" => {
            let mut out = base;
            out["state"] = json!("unavailable");
            out["reason"] = json!(e.reason);
            Ok(Err(out))
        }
        Err(e) => Err(e),
    }
}

fn import(args: ImportArgs) -> CmdResult {
    let into = paths::absolutize(&args.into);
    if into.exists()
        && std::fs::read_dir(&into)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        return Err(CliError::new(
            "workspace_not_empty",
            format!("--into {} exists and is not empty", into.display()),
        )
        .with_path("--into"));
    }
    // Unpack into a sibling staging directory; it becomes the workspace only
    // once everything it needs resolves, so a failed import leaves nothing.
    let parent = into
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&parent).map_err(|e| {
        CliError::new(
            "write_failed",
            format!("cannot create {}: {e}", parent.display()),
        )
    })?;
    let staging = parent.join(format!(
        ".{}.importing-{}",
        into.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    let result = import_into(&args, &staging);
    match result {
        Ok(mut out) => {
            if into.exists() {
                let _ = std::fs::remove_dir(&into);
            }
            std::fs::rename(&staging, &into).map_err(|e| {
                let _ = std::fs::remove_dir_all(&staging);
                CliError::new(
                    "write_failed",
                    format!("cannot create {}: {e}", into.display()),
                )
            })?;
            out["workspace"] = json!(into);
            Ok(Outcome::ok(out))
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(e)
        }
    }
}

fn import_into(args: &ImportArgs, staging: &Path) -> Result<Value, CliError> {
    let mut reader = open(&args.package)?;
    let verification = reader
        .extract_to(staging)
        .map_err(|e| package_error(e, &args.package))?;
    let manifest = verification.manifest();

    let map = resolve_map(staging, manifest, args)?;
    // A map that cannot be resolved fails the import: do not download the
    // actor closure (about a gigabyte) for a workspace that will be refused.
    let actors = if map.is_err() {
        Ok(
            json!({ "digest": manifest.catalog.actor_closure_digest, "state": "not-attempted", "reason": "the map is unavailable" }),
        )
    } else {
        resolve_actors(manifest, args)?
    };
    let form = serde_json::to_value(verification.form()).unwrap_or(Value::Null);
    if map.is_err() || actors.is_err() {
        let mut missing = Vec::new();
        if let Err(m) = &map {
            missing.push(json!({ "closure": "map", "detail": m }));
        }
        if let Err(a) = &actors {
            missing.push(json!({ "closure": "actors", "detail": a }));
        }
        let drifted = map
            .as_ref()
            .err()
            .and_then(|m| m["candidates"].as_array())
            .map(|c| {
                c.iter()
                    .any(|c| c["differingCount"].as_u64().unwrap_or(0) > 0)
            })
            .unwrap_or(false);
        let hint = if drifted {
            "the registry has releases of this map with the same OpenDRIVE, but they differ from the package's map (it was made on a release that is not published there); publish that release, point --registry at a registry that has it, or re-export the full package"
        } else if form == "full" {
            "the package's map closure is the browser asset set, which carries no native master (master.gltf, geometry.bin) for this map, and no public registry release matches it; a native render of it needs its map release published to a registry this CLI can read (--registry)"
        } else {
            "these members are not available from the public stores (a private map or closure): re-export the full package from the hosted app (Export for CLI, full), or pass --registry / --assets-base-url for a store that has them"
        };
        return Err(CliError::findings(
            "package_closure_unavailable",
            format!(
                "{} closure(s) this package needs are not available: {hint}",
                missing.len()
            ),
        )
        .with_path(args.package.display().to_string())
        .with_detail(json!({ "form": form, "missing": missing, "hint": hint })));
    }
    let map = map.expect("checked");
    let actors = actors.expect("checked");
    let mut next = Vec::new();
    if map["state"] == "skipped" {
        next.push(format!(
            "`simforge maps pull {}@<version>` for the map whose OpenDRIVE is {} (or import without --offline)",
            map["mapId"].as_str().unwrap_or(""),
            map["xodrSha256"].as_str().unwrap_or("")
        ));
    }
    if actors["state"] == "skipped" {
        next.push(format!(
            "`simforge assets pull --closure {}` (or import without --offline)",
            actors["digest"].as_str().unwrap_or("")
        ));
    }
    let mut out = verification_json(&verification);
    out["package"] = json!(paths::absolutize(&args.package));
    out["resolved"] = json!({ "offline": args.offline, "map": map, "actorClosure": actors });
    out["next"] = json!(next);
    Ok(out)
}
