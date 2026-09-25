//! `simforge simulate`: re-simulate a workspace from its resolution record,
//! or (the positional is a file) run an authoring instance once.
//!
//! The resolution (`simulation/resolution.json.gz`, `simforge.sim-resolution/v1`)
//! holds the exact input the packaged trace was simulated from
//! (`resolvedInput`). Re-simulation runs it again on this build's engine
//! (`simforge_core::engine::run_simulation`) over the simulation world of the
//! installed map: the lane graph from the topology with the map's speed
//! limits, the static colliders, and the ground surface when the map carries
//! one, built exactly as the editor's and the host's map closure builds it
//! (`simforge_compiler::MapBundle` sources).
//!
//! The result is labelled `re-simulated`, gets its own `traceSha256` and is
//! written next to (never over) the packaged trace. Whether it must match is
//! a function of the engine: at the same `ENGINE_SEM_VER` as the package the
//! trace must be byte-identical (a mismatch is a `determinism_violation`,
//! exit 2; scenario-package.md section 5.1 "Deep verify"); under another
//! engine, or with `--seed`, a different trace is expected and reported.
//!
//! A SUMO document's packaged trace merges an external SUMO step; that step
//! is not run here, so the re-simulation is of the authored actors alone and
//! is compared with `simulation.authoredTraceSha256`, and says so.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clap::Args;
use serde_json::{json, Value};
use simforge_compiler::bundle::{
    load_static_colliders, DERIVED_FILE, LOCATIONS_FILE, SEARCH_INDEX_FILE, SIGNALS_FILE,
    TOPOLOGY_FILE,
};
use simforge_compiler::{MapBundle, MapBundleSources};
use simforge_core::engine::{run_simulation, GroundContext, RunOptions};
use simforge_core::map::TopologyIndex;

use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::installed_maps::{self, sha256_hex, GROUND_MESH};
use crate::paths;
use crate::workspace::{Workspace, RESOLUTION};

pub const RESOLUTION_CONTRACT: &str = "simforge.sim-resolution/v1";
/// Where re-simulated traces go inside a workspace.
pub const RESIMULATED_DIR: &str = "simulation/resimulated";

#[derive(Debug, Args)]
pub struct SimulateArgs {
    /// The workspace directory (an imported scenario package), or an instance file (scenario-instance or a bare SimScenarioInput).
    #[arg(value_name = "WORKSPACE|INSTANCE")]
    pub workspace: PathBuf,
    /// Override the resolution's seed (the trace is then expected to differ).
    #[arg(long, value_name = "SEED")]
    pub seed: Option<String>,
    /// Write the re-simulated trace here (gzip JSON). Default: the workspace's simulation/resimulated/<traceSha256>.trace.json.gz.
    #[arg(long, value_name = "FILE")]
    pub out: Option<PathBuf>,
    /// Use this map directory instead of the installed map found by content (map.xodr[.gz] sha256 = the manifest's map.xodrSha256).
    #[arg(long, value_name = "DIR")]
    pub map_dir: Option<PathBuf>,
    /// Map cache root to search. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps.
    #[arg(long, value_name = "DIR")]
    pub cache_root: Option<PathBuf>,
    /// Instance mode (the positional is an instance file): also write the trace here (gzip JSON).
    #[arg(long, value_name = "FILE")]
    pub trace: Option<PathBuf>,
}

/// `simulate <instance.json>`: when the positional is a file, it is an
/// authoring instance (`kind: scenario-instance`, or a bare SimScenarioInput)
/// run once on its installed map; a directory is a workspace re-simulation.
fn run_instance(args: SimulateArgs) -> CmdResult {
    let workspace_flags = [
        ("--seed", args.seed.is_some()),
        ("--out", args.out.is_some()),
        ("--map-dir", args.map_dir.is_some()),
        ("--cache-root", args.cache_root.is_some()),
    ];
    if let Some((flag, _)) = workspace_flags.iter().find(|(_, set)| *set) {
        return Err(CliError::new(
            "conflicting_arguments",
            format!("{flag} applies to a workspace; an instance file takes only --trace"),
        )
        .with_path(*flag));
    }
    let root = super::authoring_support::map_root()?;
    let (payload, ok) = simforge_authoring::simulate::run_simulate_instance(
        &root,
        &args.workspace,
        &args.workspace.display().to_string(),
        args.trace.as_deref(),
    )
    .map_err(super::authoring_support::cli_error)?;
    Ok(Outcome { value: payload.to_value(), exit: super::authoring_support::exit_for(ok) })
}

fn gunzip_if_needed(bytes: Vec<u8>) -> Result<Vec<u8>, std::io::Error> {
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return Ok(bytes);
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes.as_slice()).read_to_end(&mut out)?;
    Ok(out)
}

fn read_plain(path: &Path) -> Result<Vec<u8>, CliError> {
    std::fs::read(path).and_then(gunzip_if_needed).map_err(|e| {
        CliError::new(
            "missing_file",
            format!("cannot read {}: {e}", path.display()),
        )
        .with_path(path.display().to_string())
    })
}

fn json_file(path: &Path) -> Result<Value, CliError> {
    serde_json::from_slice(&read_plain(path)?).map_err(|e| {
        CliError::findings(
            "map_invalid",
            format!("{} is not JSON: {e}", path.display()),
        )
        .with_path(path.display().to_string())
    })
}

/// The map's OpenDRIVE (`map.xodr`, or `map.xodr.gz` in a fixture closure).
fn xodr_file(dir: &Path) -> Option<PathBuf> {
    ["map.xodr", "map.xodr.gz"]
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.is_file())
}

/// The simulation world of one map directory.
pub struct World {
    pub dir: PathBuf,
    pub options: RunOptions,
    pub xodr_sha256: String,
    /// `simforge.map-closure/v1`, combined with the ground digest when a
    /// ground surface is attached (`simforge.map-closure-ground/v1`), as the
    /// hosts key simulations.
    pub closure_digest: String,
    pub ground_digest: Option<String>,
    pub colliders: usize,
    pub collider_status: Value,
}

/// Build the simulation world from a map directory: topology (with the
/// map's speed limits from its signal catalog), static colliders, and the
/// ground surface when the map publishes one.
pub fn load_world(dir: &Path) -> Result<World, CliError> {
    let bad = |code: &str, reason: String| {
        CliError::findings(code.to_owned(), reason).with_path(dir.display().to_string())
    };
    let xodr_path = xodr_file(dir)
        .ok_or_else(|| bad("map_invalid", format!("{} has no map.xodr", dir.display())))?;
    let xodr = read_plain(&xodr_path)?;
    let xodr_sha256 = sha256_hex(&xodr);
    let topology_bytes = read_plain(&dir.join(TOPOLOGY_FILE))?;
    let topology = TopologyIndex::decode(&topology_bytes)
        .map_err(|e| bad("map_invalid", format!("topology: {e}")))?;
    let optional = |name: &str| -> Result<Option<Value>, CliError> {
        let path = dir.join(name);
        path.is_file().then(|| json_file(&path)).transpose()
    };
    let signals = json_file(&dir.join(SIGNALS_FILE))?;
    let xodr_text = String::from_utf8(xodr.clone())
        .map_err(|_| bad("map_invalid", "map.xodr is not UTF-8".into()))?;
    let (colliders, diagnostics) = load_static_colliders(dir);
    let collider_status = serde_json::to_value(diagnostics.status).unwrap_or(Value::Null);
    let bundle = MapBundle::from_sources(MapBundleSources {
        map_id: dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        topology: Some(topology),
        derived: optional(DERIVED_FILE)?,
        locations: optional(LOCATIONS_FILE)?,
        search_index: optional(SEARCH_INDEX_FILE)?,
        xodr: Some(xodr_text),
        signals_geojson: Some(signals),
        static_colliders: Some((colliders, diagnostics)),
    })
    .map_err(|e| bad("map_invalid", format!("map bundle: {e}")))?;

    let mut options = RunOptions::new(Arc::clone(bundle.graph()));
    options.static_colliders = bundle.static_colliders().to_vec();
    let mut closure_digest = bundle.closure_digest().to_owned();
    let mut ground_digest = None;
    let ground_path = dir.join(GROUND_MESH);
    if ground_path.is_file() {
        let mesh = std::fs::read(&ground_path)
            .map_err(|e| bad("map_invalid", format!("{}: {e}", ground_path.display())))?;
        let ground = GroundContext::from_bytes(&mesh, Some((&xodr, bundle.topology())))
            .map_err(|e| bad("map_invalid", format!("ground: {e}")))?;
        let digest = ground.digest().to_owned();
        closure_digest = simforge_core::hash::content_hash_of(&json!({
            "schema": "simforge.map-closure-ground/v1",
            "closureDigest": closure_digest,
            "groundDigest": digest,
        }))
        .expect("plain strings");
        options.ground = Some(Arc::new(ground));
        ground_digest = Some(digest);
    }
    options.capture_trace = true;
    Ok(World {
        dir: dir.to_path_buf(),
        colliders: options.static_colliders.len(),
        options,
        xodr_sha256,
        closure_digest,
        ground_digest,
        collider_status,
    })
}

fn resolve_map_dir(
    want_xodr: &str,
    map_hint: Option<&str>,
    map_dir: Option<&Path>,
    cache_root: Option<&Path>,
) -> Result<(PathBuf, String), CliError> {
    if let Some(dir) = map_dir {
        return Ok((paths::absolutize(dir), "explicit".to_owned()));
    }
    let root = paths::maps_root(cache_root)?;
    let found = installed_maps::find_by_xodr(&root.value, want_xodr, map_hint)?;
    Ok((found.dir, found.profile))
}

fn write_gzip(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| {
            CliError::new(
                "write_failed",
                format!("cannot create {}: {e}", parent.display()),
            )
        })?;
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    let data = encoder
        .write_all(bytes)
        .and_then(|_| encoder.finish())
        .map_err(|e| CliError::new("write_failed", format!("gzip: {e}")))?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, &data)
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            CliError::new(
                "write_failed",
                format!("cannot write {}: {e}", path.display()),
            )
            .with_path(path.display().to_string())
        })
}

pub fn run(args: SimulateArgs, _ctx: &Ctx) -> CmdResult {
    // A file (or a missing `*.json` path, so it is reported as the missing
    // instance it names) is an instance; anything else is a workspace.
    let instance_path = args.workspace.is_file()
        || (!args.workspace.exists() && args.workspace.extension().is_some_and(|e| e == "json"));
    if instance_path {
        return run_instance(args);
    }
    if args.trace.is_some() {
        return Err(CliError::new(
            "conflicting_arguments",
            "--trace applies to an instance file; a workspace re-simulation writes --out",
        )
        .with_path("--trace"));
    }
    let ws = Workspace::open(&args.workspace)?;
    let resolution_path = ws.member(RESOLUTION);
    let resolution: Value =
        serde_json::from_slice(&read_plain(&resolution_path)?).map_err(|e| {
            CliError::findings(
                "resolution_invalid",
                format!("{RESOLUTION} is not JSON: {e}"),
            )
            .with_path(resolution_path.display().to_string())
        })?;
    let invalid = |reason: String| {
        CliError::findings("resolution_invalid", reason)
            .with_path(resolution_path.display().to_string())
    };
    if resolution["contract"] != RESOLUTION_CONTRACT {
        return Err(invalid(format!(
            "{RESOLUTION} has contract {}, expected {RESOLUTION_CONTRACT}",
            resolution["contract"]
        )));
    }
    let mut input_value = resolution
        .get("resolvedInput")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| invalid("the resolution has no resolvedInput".into()))?;
    let recorded_input_digest = resolution["resolvedInputDigest"]
        .as_str()
        .ok_or_else(|| invalid("the resolution has no resolvedInputDigest".into()))?
        .to_owned();
    // The record must name exactly the input it carries.
    let input_digest = simforge_core::hash::content_hash(&input_value)
        .map_err(|e| invalid(format!("resolvedInput: {e}")))?;
    if input_digest != recorded_input_digest {
        return Err(invalid(format!(
            "resolvedInput digests to {input_digest}, but the record says {recorded_input_digest}"
        ))
        .with_detail(json!({ "computed": input_digest, "recorded": recorded_input_digest })));
    }
    if let Some(manifest_digest) = ws
        .manifest
        .pointer("/simulation/resolvedInputDigest")
        .and_then(Value::as_str)
    {
        if manifest_digest != recorded_input_digest {
            return Err(CliError::findings(
                "workspace_inconsistent",
                "the resolution's resolvedInputDigest differs from the manifest's simulation.resolvedInputDigest",
            )
            .with_detail(json!({ "resolution": recorded_input_digest, "manifest": manifest_digest })));
        }
    }
    let original_seed = input_value.get("seed").cloned().unwrap_or(Value::Null);
    if let Some(seed) = &args.seed {
        input_value["seed"] = Value::String(seed.clone());
    }
    let input = simforge_core::types::parse_scenario_input_value(&input_value)
        .map_err(|e| invalid(format!("resolvedInput: {e}")))?
        .normalized();

    // The world: the map this trace was simulated on, found by content.
    let want_xodr = ws.xodr_sha256()?.to_owned();
    let map_hint = input_value["mapId"].as_str().map(str::to_owned);
    let (map_dir, profile) = resolve_map_dir(
        &want_xodr,
        map_hint.as_deref(),
        args.map_dir.as_deref(),
        args.cache_root.as_deref(),
    )?;
    let world = load_world(&map_dir)?;
    if world.xodr_sha256 != want_xodr {
        return Err(CliError::findings(
            "map_mismatch",
            format!(
                "{} holds an OpenDRIVE with sha256 {}, but the workspace was simulated on {want_xodr}",
                map_dir.display(),
                world.xodr_sha256
            ),
        )
        .with_path(map_dir.display().to_string()));
    }
    let packaged_closure = ws
        .manifest
        .pointer("/map/mapClosureDigest")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let map_json = json!({
        "dir": world.dir,
        "profile": profile,
        "xodrSha256": world.xodr_sha256,
        "mapClosureDigest": world.closure_digest,
        "packagedMapClosureDigest": packaged_closure,
        "groundDigest": world.ground_digest,
        "staticColliders": world.colliders,
        "colliderStatus": world.collider_status,
    });
    if let Some(packaged) = &packaged_closure {
        if packaged != &world.closure_digest {
            // Another simulation world: nothing is re-bound, the run is refused.
            return Err(CliError::findings(
                "map_closure_mismatch",
                format!(
                    "the installed map's simulation closure is {}, but the package was simulated on {packaged}",
                    world.closure_digest
                ),
            )
            .with_detail(json!({ "map": map_json })));
        }
    }

    let result = run_simulation(input, world.options).map_err(|e| {
        CliError::findings("simulation_failed", e.to_string())
            .with_path(resolution_path.display().to_string())
    })?;
    let trace = &result.trace;
    let trace_sha256 = trace
        .digest()
        .map_err(|e| CliError::new("internal_error", format!("trace digest: {e}")))?;
    let trace_json = serde_json::to_vec(trace)
        .map_err(|e| CliError::new("internal_error", format!("trace JSON: {e}")))?;

    // What the re-simulation is compared with, and whether it must match.
    let sumo = resolution["trafficProvider"] == "sumo";
    let (compared_field, packaged_sha) = if sumo {
        (
            "authoredTraceSha256",
            ws.manifest.pointer("/simulation/authoredTraceSha256"),
        )
    } else {
        (
            "traceSha256",
            ws.manifest.pointer("/simulation/traceSha256"),
        )
    };
    let packaged_sha = packaged_sha.and_then(Value::as_str).map(str::to_owned);
    let packaged_engine = ws
        .manifest
        .pointer("/engine/engineSemVer")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let engine = simforge_core::ENGINE_SEM_VER;
    let same_engine = packaged_engine.as_deref() == Some(engine);
    let matches = packaged_sha.as_deref().map(|p| p == trace_sha256);
    let expected_to_match = same_engine && args.seed.is_none();
    let deterministic_match = if expected_to_match { matches } else { None };
    let reason = match (same_engine, args.seed.is_some()) {
        (_, true) => "the seed was overridden: a different trace is expected",
        (false, false) => "the engine differs from the package's: a different trace is expected",
        (true, false) => "same engine semver: the trace must be byte-identical",
    };
    let input_hash_matches = trace.header.input_hash == recorded_input_digest;

    let out_path = args.out.clone().unwrap_or_else(|| {
        ws.member(RESIMULATED_DIR)
            .join(format!("{trace_sha256}.trace.json.gz"))
    });
    write_gzip(&out_path, &trace_json)?;

    let mut findings = Vec::new();
    if expected_to_match && matches == Some(false) {
        findings.push(json!({
            "code": "determinism_violation",
            "reason": format!("re-simulating under engine {engine} gave trace {trace_sha256}, the package records {compared_field} {}", packaged_sha.as_deref().unwrap_or("")),
        }));
    }
    if args.seed.is_none() && !input_hash_matches {
        findings.push(json!({
            "code": "resolution_input_mismatch",
            "reason": format!("the executed input hashes to {}, the resolution records {recorded_input_digest}", trace.header.input_hash),
        }));
    }
    let value = json!({
        "label": "re-simulated",
        "workspace": ws.dir,
        "engineSemVer": engine,
        "packagedEngineSemVer": packaged_engine,
        "traceSha256": trace_sha256,
        "packagedTraceSha256": packaged_sha,
        "comparedWith": compared_field,
        "deterministicMatch": deterministic_match,
        "matchesPackaged": matches,
        "expectation": reason,
        "trafficProvider": resolution["trafficProvider"],
        "sumoStep": if sumo { json!("not run: the re-simulation covers the authored actors only") } else { Value::Null },
        "seed": {
            "value": input_value["seed"],
            "overridden": args.seed.is_some(),
            "original": original_seed,
        },
        "inputHash": trace.header.input_hash,
        "resolvedInputDigest": recorded_input_digest,
        "map": map_json,
        "ticks": trace.ticks.t.len(),
        "actors": trace.ticks.actors.len(),
        "issues": result.issues,
        "out": paths::absolutize(&out_path),
        "findings": findings,
    });
    if value["findings"].as_array().is_some_and(|f| !f.is_empty()) {
        Ok(Outcome::findings(value))
    } else {
        Ok(Outcome::ok(value))
    }
}
