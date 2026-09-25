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
use crate::paths;
use crate::registry::{self, PullOptions, Registry, RegistryAuth};

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
    /// Map registry to resolve the package's map from. Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the logged-in account's registry (a private map needs no access URL then), then the public registry.
    #[arg(long, value_name = "URL")]
    pub registry: Option<String>,
    /// SimForge host whose account registry resolves the map (see `simforge login`). Default: SIMFORGE_HOST, then simforge.ai.
    #[arg(long, value_name = "HOST")]
    pub host: Option<String>,
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

/// Closure members: path to (sha256, bytes).
type Members = std::collections::BTreeMap<String, (String, u64)>;

/// A registry closure document in the package (`map/closure.json`, the
/// release's canonical closure; `map/web-closure.json`, its web closure).
fn closure_members(ws: &Path, member: &str) -> Result<Option<Members>, CliError> {
    let path = ws.join(member);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| {
        CliError::findings(
            "package_member_invalid",
            format!("cannot read {member}: {e}"),
        )
    })?;
    let doc: Value = serde_json::from_slice(&bytes).map_err(|e| {
        CliError::findings(
            "package_member_invalid",
            format!("{member} is not JSON: {e}"),
        )
    })?;
    let members = doc["members"].as_object().ok_or_else(|| {
        CliError::findings(
            "package_member_invalid",
            format!("{member} is not a registry closure (map-closure.v1 members)"),
        )
    })?;
    Ok(Some(
        members
            .iter()
            .filter_map(|(p, m)| {
                Some((
                    p.clone(),
                    (m["sha256"].as_str()?.to_owned(), m["bytes"].as_u64()?),
                ))
            })
            .collect(),
    ))
}

fn blob_embedded(ws: &Path, sha: &str, bytes: u64) -> bool {
    sha.len() == 64
        && std::fs::metadata(ws.join("blobs/sha256").join(&sha[..2]).join(sha))
            .map(|f| f.len() == bytes)
            .unwrap_or(false)
}

/// The part of the package's web closure a full package embeds (the members
/// the CLI reads: static colliders, simulation members, turn verdicts), as a
/// web closure document with its digest. A full package installs this as its
/// release's web profile.
fn embedded_web_subset(ws: &Path) -> Option<(Value, String)> {
    let bytes = std::fs::read(ws.join("map/web-closure.json")).ok()?;
    let mut doc: Value = serde_json::from_slice(&bytes).ok()?;
    let members = doc["members"].as_object()?.clone();
    let kept: serde_json::Map<String, Value> = members
        .into_iter()
        .filter(|(p, m)| {
            simforge_package::closure::is_cli_web_member(p)
                && blob_embedded(
                    ws,
                    m["sha256"].as_str().unwrap_or(""),
                    m["bytes"].as_u64().unwrap_or(u64::MAX),
                )
        })
        .collect();
    doc["members"] = Value::Object(kept);
    let digest = registry::sha256_hex(registry::canonical_json(&doc).as_bytes());
    Some((doc, digest))
}

fn receipt(dir: &Path) -> Value {
    std::fs::read(dir.join(".map-release.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

/// The installed release whose canonical (and, when the package names one,
/// web) closure digests are the package's: every profile `maps pull` writes.
fn installed_release(maps_root: &Path, canonical: &str, web: &[String]) -> Option<Value> {
    let entries = std::fs::read_dir(maps_root.join(".corpus")).ok()?;
    for entry in entries.flatten() {
        let native = entry.path();
        let r = receipt(&native);
        if r["canonicalDigest"].as_str() != Some(canonical) {
            continue;
        }
        let name = entry.file_name();
        let semantic = maps_root.join("dev-assets").join(&name);
        if receipt(&semantic)["canonicalDigest"].as_str() != Some(canonical) {
            continue;
        }
        let web_dir = maps_root.join("map-bundles").join(&name);
        let installed_web = receipt(&web_dir);
        if !web.is_empty()
            && !web
                .iter()
                .any(|w| installed_web["webDigest"].as_str() == Some(w.as_str()))
        {
            continue;
        }
        return Some(json!({
            "native": native,
            "semantic": semantic,
            "web": (!web.is_empty()).then_some(web_dir),
            "release": format!("{}@{}", r["name"].as_str().unwrap_or(""), r["version"].as_str().unwrap_or("")),
            "releaseDigest": r["releaseDigest"],
        }));
    }
    None
}

/// Install a full package's embedded map closures through the registry path
/// (the same verification, profiles and receipts as `maps pull`): a file://
/// registry is laid out beside the workspace with the package's own closure
/// documents and its `blobs/`, as one release of the map.
fn install_embedded(
    ws: &Path,
    manifest: &simforge_package::Manifest,
    maps_root: &Path,
) -> Result<Value, CliError> {
    use crate::registry::{canonical_json, sha256_hex};
    let name = manifest.map.source_map_id.clone();
    let reg = ws.join(".simforge-import-registry");
    let _ = std::fs::remove_dir_all(&reg);
    let write = |rel: &str, bytes: &[u8]| -> Result<(), CliError> {
        let path = reg.join(rel);
        std::fs::create_dir_all(path.parent().expect("has a parent"))
            .and_then(|_| std::fs::write(&path, bytes))
            .map_err(|e| CliError::new("write_failed", format!("{}: {e}", path.display())))
    };
    // The registry path takes `v<N>`: a version derived from the closure
    // digest, relabelled `package-<digest>` in the receipts once installed.
    let label = format!("package-{}", &manifest.map.canonical_closure_sha256[..12]);
    let version = format!(
        "v{}",
        u64::from_str_radix(&manifest.map.canonical_closure_sha256[..12], 16).unwrap_or(0) + 1
    );
    let base = format!("maps/{name}/{version}");
    let canonical_bytes = std::fs::read(ws.join("map/closure.json"))
        .map_err(|e| CliError::new("write_failed", e.to_string()))?;
    write(&format!("{base}/closure.json"), &canonical_bytes)?;
    let canonical: Value = serde_json::from_slice(&canonical_bytes)
        .map_err(|e| CliError::findings("package_member_invalid", e.to_string()))?;
    let mut release = json!({
        "schema": "simforge.map-release.v1",
        "name": name,
        "version": version,
        "visibility": if name == "richmond-field-station" { "public" } else { "private" },
        "createdAt": "1970-01-01T00:00:00Z",
        "canonical": { "key": format!("{base}/closure.json"), "digest": sha256_hex(canonical_json(&canonical).as_bytes()) },
    });
    if let Some((web, digest)) = embedded_web_subset(ws) {
        write(
            &format!("{base}/derived/web-package.json"),
            canonical_json(&web).as_bytes(),
        )?;
        release["web"] =
            json!({ "key": format!("{base}/derived/web-package.json"), "digest": digest });
    }
    write(
        &format!("{base}/release.json"),
        canonical_json(&release).as_bytes(),
    )?;
    let record = json!([{
        "version": version,
        "closureDigest": release["canonical"]["digest"],
        "releaseDigest": sha256_hex(canonical_json(&release).as_bytes()),
        "createdAt": "1970-01-01T00:00:00Z",
    }]);
    write(
        &format!("maps/{name}/versions.json"),
        record.to_string().as_bytes(),
    )?;
    write(
        "index.json",
        json!({ &name: { "latest": version, "versions": [version], "summary": { "label": name } } })
            .to_string()
            .as_bytes(),
    )?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(ws.join("blobs"), reg.join("blobs"))
        .map_err(|e| CliError::new("write_failed", e.to_string()))?;
    let registry = Registry::new(
        &format!("file://{}", reg.display()),
        RegistryAuth::None,
        "package",
    )?;
    let result = registry::pull(
        &registry,
        &format!("{name}@{version}"),
        &PullOptions {
            cache_root: maps_root.to_path_buf(),
            archive: false,
            concurrency: 8,
        },
    );
    let _ = std::fs::remove_dir_all(&reg);
    let mut summary = result?;
    for dir in ["dev-assets", ".corpus", "map-bundles"] {
        let path = maps_root.join(dir).join(&name).join(".map-release.json");
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(mut r) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        r["version"] = json!(label);
        r["source"] = json!("package");
        std::fs::write(&path, format!("{}\n", registry::canonical_json(&r)))
            .map_err(|e| CliError::new("write_failed", format!("{}: {e}", path.display())))?;
    }
    summary["version"] = json!(label);
    summary["source"] = json!("package");
    Ok(summary)
}

/// Resolve the package's map: installed, installed from the package's own
/// blobs (full form), pulled from a registry release named by digest,
/// skipped (offline), or unavailable (the returned detail lists why).
fn resolve_map(
    ws: &Path,
    manifest: &simforge_package::Manifest,
    args: &ImportArgs,
) -> Result<Result<Value, Value>, CliError> {
    let map = &manifest.map;
    let canonical = map.canonical_closure_sha256.clone();
    let web = map.web_closure_sha256.clone();
    let members = closure_members(ws, "map/closure.json")?.ok_or_else(|| {
        CliError::findings(
            "package_member_invalid",
            "the package has no map/closure.json",
        )
    })?;
    let web_members = closure_members(ws, "map/web-closure.json")?.unwrap_or_default();
    // An install satisfies the package when its web profile is the release's
    // web closure or the part of it a full package embeds.
    let web_accepted: Vec<String> = web
        .iter()
        .cloned()
        .chain(embedded_web_subset(ws).map(|(_, d)| d))
        .collect();
    let maps = paths::maps_root(args.cache_root.as_deref())?;
    let base = json!({
        "mapId": map.source_map_id, "xodrSha256": map.xodr_sha256, "mapsRoot": maps.value,
        "canonicalClosureSha256": canonical, "webClosureSha256": web,
        "registryReleaseDigest": map.registry_release_digest,
    });
    if let Some(found) = installed_release(&maps.value, &canonical, &web_accepted) {
        let mut out = base;
        out["state"] = json!("installed");
        out["installed"] = found;
        return Ok(Ok(out));
    }
    // A full package carries every member: install from its own blobs.
    if members.values().all(|(sha, n)| blob_embedded(ws, sha, *n)) {
        let summary = install_embedded(ws, manifest, &maps.value)?;
        let mut out = base;
        out["state"] = json!("installed-from-package");
        out["pull"] = summary;
        return Ok(Ok(out));
    }
    if args.offline {
        let mut out = base;
        out["state"] = json!("skipped");
        out["reason"] = json!("--offline");
        return Ok(Ok(out));
    }
    let reg = registry::select(args.registry.as_deref(), args.host.as_deref())?;
    if let Some(reference) = reg.find_release(
        map.registry_release_digest.as_deref(),
        &canonical,
        &map.source_map_id,
    )? {
        let resolved = registry::resolve(&reg, &reference)?;
        let web_ok = match (&web, &resolved.release.web) {
            (Some(w), Some(r)) => &r.digest == w,
            (None, _) => true,
            (Some(_), None) => false,
        };
        if resolved.record_closure_digest == canonical && web_ok {
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
            out["registry"] = reg.describe();
            out["pull"] = summary;
            return Ok(Ok(out));
        }
    }
    // No registry this CLI can read has the release: say what is missing, by digest.
    let blob_root = maps.value.join(".blobs");
    let missing: Vec<(&String, &(String, u64))> = members
        .iter()
        .chain(web_members.iter().filter(|(p, _)| {
            simforge_package::closure::is_cli_web_member(p) && !members.contains_key(*p)
        }))
        .filter(|(_, (sha, n))| {
            std::fs::metadata(blob_root.join("sha256").join(&sha[..2]).join(sha))
                .map(|m| m.len() != *n)
                .unwrap_or(true)
        })
        .collect();
    let mut out = base;
    out["state"] = json!("unavailable");
    out["registry"] = reg.describe();
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
        only: Some(assets::Only::Actors),
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
    // The sky plates every render lights with (a pinned public closure):
    // fetched now so the render that follows needs no network for them. Not
    // fetching them does not fail the import; the render fetches them or
    // fails loudly, and the result says which.
    let sky = if map.is_err() || actors.is_err() {
        json!({ "state": "not-attempted" })
    } else if let Ok(paths) = render_core::sky_pass::SkyAssetPaths::resolve() {
        json!({ "state": "installed", "dir": paths.dir })
    } else if args.offline {
        json!({ "state": "skipped", "reason": "--offline" })
    } else {
        match assets::pull(assets::PullArgs {
            only: Some(assets::Only::Sky),
            closure: None,
            base_url: None,
            root: None,
            timeout: 60,
        }) {
            Ok(outcome) => json!({ "state": "pulled", "pull": outcome.value["sky"] }),
            Err(e) => {
                json!({ "state": "unavailable", "error": { "code": e.code, "reason": e.reason } })
            }
        }
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
        let hint = if form == "full" {
            "the full package does not embed every member it lists (a partial or damaged export): re-export the full package"
        } else {
            "the map release or actor closure is not available from the stores this CLI can read (a private map): re-export the full package from the hosted app (Export for CLI, full), or pass the package's access URL as --registry and --assets-base-url"
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
            "`simforge maps pull {}@<version>` for the release whose canonical closure is {} (or import without --offline)",
            map["mapId"].as_str().unwrap_or(""),
            map["canonicalClosureSha256"].as_str().unwrap_or("")
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
    if sky["state"] == "skipped" || sky["state"] == "unavailable" {
        next.push("`simforge assets pull --only sky` (or import without --offline)".to_owned());
    }
    out["resolved"] =
        json!({ "offline": args.offline, "map": map, "actorClosure": actors, "sky": sky });
    out["next"] = json!(next);
    Ok(out)
}
