//! `simforge package`: `simforge.scenario-package/v1` containers
//! (docs/engineering/scenario-package.md), through the `simforge-package`
//! crate the hosted exporter writes them with.
//!
//! - `inspect` opens a package (structure, manifest, version skew) without
//!   hashing member data;
//! - `verify` hashes every member and runs every cross-check; any refusal
//!   exits 2 with the crate's stable `code` and the exact `rule`;
//! - `import` verifies, then unpacks into a workspace directory, and reports
//!   what a render or re-simulation of it still needs locally (the map by
//!   its OpenDRIVE digest, the actor closure by its digest).
//!
//! A package names everything by digest; nothing is resolved by name here.

use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use serde_json::{json, Value};
use simforge_package::{Inspection, PackageError, PackageReader, Verification, VerifyOptions};

use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::installed_maps;
use crate::paths;

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
    let mut reader = open(&args.package)?;
    let verification = reader
        .extract_to(&into)
        .map_err(|e| package_error(e, &args.package))?;
    let manifest = verification.manifest();

    // What this machine still needs to render or re-simulate it: reported,
    // never fetched or substituted here.
    let xodr = manifest.map.xodr_sha256.clone();
    let map_id = manifest.map.source_map_id.clone();
    let maps = paths::maps_root(args.cache_root.as_deref())?;
    let installed = installed_maps::list(&maps.value);
    let semantic = installed
        .iter()
        .find(|m| m.xodr_sha256 == xodr && m.profile == "dev-assets");
    let native = installed
        .iter()
        .find(|m| m.xodr_sha256 == xodr && m.profile == ".corpus");
    let assets = paths::assets_root(args.assets_root.as_deref())?;
    let closure_digest = manifest.catalog.actor_closure_digest.clone();
    let closure_installed = assets
        .value
        .join("closures")
        .join(format!("{closure_digest}.json"))
        .is_file();
    let mut next = Vec::new();
    if native.is_none() {
        next.push(format!(
            "`simforge maps pull {map_id}@<version>` for the map whose OpenDRIVE is {xodr} (render and simulate need it)"
        ));
    }
    if !closure_installed {
        next.push(format!(
            "`simforge assets pull --closure {closure_digest}` (render needs the actor closure)"
        ));
    }
    let mut out = verification_json(&verification);
    out["package"] = json!(paths::absolutize(&args.package));
    out["workspace"] = json!(into);
    out["local"] = json!({
        "map": {
            "xodrSha256": xodr,
            "mapId": map_id,
            "mapsRoot": maps.value,
            "semantic": semantic.map(|m| &m.dir),
            "native": native.map(|m| &m.dir),
        },
        "actorClosure": {
            "digest": closure_digest,
            "root": assets.value,
            "installed": closure_installed,
        },
    });
    out["next"] = json!(next);
    Ok(Outcome::ok(out))
}
