//! `simforge timeline build`: canonical trace to render timeline
//! (`simforge.render-timeline.v1`, docs/engineering/render-timeline.md).
//!
//! The same Rust function the editor (WASM), the Bevy renderer and CARLA
//! use: `simforge_core::trace::timeline::build_render_timeline`. The height
//! source is chosen explicitly and reported: the map ground derivative, the
//! OpenDRIVE elevation, or a flat plane. A workspace pins it by digest, and a
//! choice that does not reproduce that digest is refused, never swapped.
//!
//! The map is found by content: the installed map whose `map.xodr` sha256 is
//! the trace's `engineGraphDigest` (see [`crate::installed_maps`]).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clap::{Args, Subcommand, ValueEnum};
use serde_json::{json, Value};
use simforge_core::trace::timeline::{
    self as tl, build_render_timeline, maybe_gunzip, HeightField, RenderTimeline,
};
use simforge_core::trace::SimTrace;

use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::installed_maps::{self, InstalledMap, GROUND_MESH, TOPOLOGY, XODR};
use crate::paths;
use crate::workspace::{Workspace, TRACE};

#[derive(Debug, Subcommand)]
pub enum TimelineCommand {
    /// Build the render timeline for a workspace's trace (deterministic, content-keyed).
    Build(BuildArgs),
}

/// Which surface the timeline's heights and road attitude come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum HeightChoice {
    /// The workspace's pinned height source; without a workspace, the map
    /// ground derivative when the map has one, else the OpenDRIVE elevation.
    Auto,
    /// The map ground surface (`derived/ground/ground-mesh.bin`).
    Ground,
    /// The OpenDRIVE elevation projected on lane topology (maps published before the ground derivative).
    Xodr,
    /// A constant plane at --flat-z (maps without elevation, tests).
    Flat,
}

#[derive(Debug, Args)]
pub struct BuildArgs {
    /// The workspace directory (an imported scenario package). Omit it and pass --trace instead.
    #[arg(value_name = "WORKSPACE", required_unless_present = "trace")]
    pub workspace: Option<PathBuf>,
    /// A trace file (JSON or gzip; any released trace format) instead of a workspace.
    #[arg(long, value_name = "FILE", conflicts_with = "workspace")]
    pub trace: Option<PathBuf>,
    /// The identity recorded next to the stored trace (bound to an upgraded trace; checked against a current one).
    #[arg(long, value_name = "SHA256", conflicts_with = "workspace")]
    pub recorded_trace_sha256: Option<String>,
    /// Actor-catalog closure digest to key the timeline by (a workspace supplies its own).
    #[arg(long, value_name = "SHA256", conflicts_with = "workspace")]
    pub catalog_digest: Option<String>,
    /// The height source.
    #[arg(long, value_enum, default_value = "auto")]
    pub height: HeightChoice,
    /// Elevation of the plane for --height flat.
    #[arg(long, value_name = "METRES", allow_negative_numbers = true)]
    pub flat_z: Option<f64>,
    /// Use this map directory (map.xodr + topology-index.json.gz [+ derived/ground]) instead of the installed map found by content.
    #[arg(long, value_name = "DIR")]
    pub map_dir: Option<PathBuf>,
    /// Map cache root to search. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps.
    #[arg(long, value_name = "DIR")]
    pub cache_root: Option<PathBuf>,
    /// Write the canonical timeline here (`.gz` compresses). Default: the workspace's timeline/<sha256>.json; with --trace, nothing is written.
    #[arg(long, value_name = "FILE")]
    pub out: Option<PathBuf>,
}

pub fn run(command: TimelineCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        TimelineCommand::Build(args) => build(args),
    }
}

/// Everything a timeline build needs, resolved and reported.
pub struct Built {
    pub timeline: RenderTimeline,
    pub bytes: String,
    pub sha256: String,
    pub map: Option<InstalledMap>,
    pub height_selection: String,
}

fn read(path: &Path, what: &str) -> Result<Vec<u8>, CliError> {
    std::fs::read(path).map_err(|e| {
        CliError::new(
            "missing_file",
            format!("cannot read {what} {}: {e}", path.display()),
        )
        .with_path(path.display().to_string())
    })
}

fn rejected(error: impl std::fmt::Display, path: &Path) -> CliError {
    CliError::findings("timeline_rejected", error.to_string()).with_path(path.display().to_string())
}

/// Parse a stored trace (any released format, upgraded in memory) and bind
/// its recorded identity.
pub fn load_trace(path: &Path, recorded: Option<&str>) -> Result<SimTrace, CliError> {
    let raw = read(path, "trace")?;
    let bytes = maybe_gunzip(&raw).map_err(|e| rejected(e, path))?;
    let mut trace = SimTrace::from_json_slice(&bytes).map_err(|e| rejected(e, path))?;
    if let Some(recorded) = recorded {
        trace
            .bind_recorded_identity(recorded)
            .map_err(|e| rejected(e, path))?;
    }
    Ok(trace)
}

fn resolve_map(
    trace: &SimTrace,
    map_dir: Option<&Path>,
    cache_root: Option<&Path>,
) -> Result<InstalledMap, CliError> {
    let want = trace.header.engine_graph_digest.as_str();
    if let Some(dir) = map_dir {
        let map =
            installed_maps::describe(&paths::absolutize(dir), "explicit").ok_or_else(|| {
                CliError::new("map_not_found", format!("{} has no {XODR}", dir.display()))
                    .with_path(dir.display().to_string())
            })?;
        if map.xodr_sha256 != want {
            return Err(CliError::findings(
                "map_mismatch",
                format!(
                    "{} holds an OpenDRIVE with sha256 {}, but the trace was simulated on {want}",
                    dir.display(),
                    map.xodr_sha256
                ),
            )
            .with_path(dir.display().to_string())
            .with_detail(
                json!({ "traceEngineGraphDigest": want, "mapXodrSha256": map.xodr_sha256 }),
            ));
        }
        return Ok(map);
    }
    let root = paths::maps_root(cache_root)?;
    installed_maps::find_by_xodr(&root.value, want, Some(trace.header.map_id.as_str()))
}

fn height_field(map: &InstalledMap, ground: bool) -> Result<HeightField, CliError> {
    let xodr = read(&map.file(XODR), "OpenDRIVE")?;
    let topology = read(&map.file(TOPOLOGY), "topology sidecar")?;
    let bad =
        |e: String| CliError::findings("map_invalid", e).with_path(map.dir.display().to_string());
    if !ground {
        return HeightField::from_xodr(&xodr, &topology).map_err(|e| bad(format!("height: {e}")));
    }
    let mesh = read(&map.file(GROUND_MESH), "ground derivative")?;
    let topology = simforge_core::map::TopologyIndex::decode(&topology)
        .map_err(|e| bad(format!("topology: {e}")))?;
    let ground = simforge_core::engine::GroundContext::from_bytes(&mesh, Some((&xodr, &topology)))
        .map_err(|e| bad(format!("ground: {e}")))?;
    Ok(HeightField::ground(Arc::new(ground)))
}

/// Pick and build the height field. `pinned` is the digest a workspace's
/// timelines were baked with; the result must reproduce it.
fn choose_height(
    trace: &SimTrace,
    choice: HeightChoice,
    flat_z: Option<f64>,
    map_dir: Option<&Path>,
    cache_root: Option<&Path>,
    pinned: Option<&str>,
) -> Result<(HeightField, Option<InstalledMap>, String), CliError> {
    if flat_z.is_some() && choice != HeightChoice::Flat {
        return Err(
            CliError::new("bad_value", "--flat-z needs --height flat").with_path("--flat-z")
        );
    }
    let (field, map, why) = match choice {
        HeightChoice::Flat => {
            let z = flat_z.unwrap_or(0.0);
            if !z.is_finite() {
                return Err(
                    CliError::new("bad_value", "--flat-z must be finite").with_path("--flat-z")
                );
            }
            (
                HeightField::flat(z),
                None,
                format!("flat: --height flat at z={z}"),
            )
        }
        HeightChoice::Ground | HeightChoice::Xodr => {
            let map = resolve_map(trace, map_dir, cache_root)?;
            let ground = choice == HeightChoice::Ground;
            if ground && !map.has(GROUND_MESH) {
                return Err(CliError::findings(
                    "ground_missing",
                    format!("{} has no {GROUND_MESH}", map.dir.display()),
                )
                .with_path(map.dir.display().to_string()));
            }
            let field = height_field(&map, ground)?;
            let why = format!(
                "{}: --height {}",
                if ground { "ground" } else { "xodr" },
                if ground { "ground" } else { "xodr" }
            );
            (field, Some(map), why)
        }
        HeightChoice::Auto => {
            let map = resolve_map(trace, map_dir, cache_root)?;
            let has_ground = map.has(GROUND_MESH);
            match pinned {
                Some(pinned) => {
                    // The workspace names the height source by digest: build
                    // each candidate the map offers and keep the one that
                    // reproduces it.
                    let mut tried = Vec::new();
                    let mut found = None;
                    for ground in [true, false] {
                        if ground && !has_ground {
                            continue;
                        }
                        let field = height_field(&map, ground)?;
                        tried.push(
                            json!({ "kind": field.source().kind, "digest": field.source().digest }),
                        );
                        if field.source().digest == pinned {
                            found = Some(field);
                            break;
                        }
                    }
                    let field = found.ok_or_else(|| {
                        CliError::findings(
                            "height_source_mismatch",
                            format!("no height source of {} reproduces the workspace's heightSourceDigest {pinned}", map.dir.display()),
                        )
                        .with_detail(json!({ "pinned": pinned, "tried": tried, "map": map.dir }))
                    })?;
                    let why = format!(
                        "{}: matches the workspace's heightSourceDigest",
                        field.source().kind
                    );
                    (field, Some(map), why)
                }
                None if trace.header.ground_digest.is_some() || has_ground => {
                    if !has_ground {
                        return Err(CliError::findings(
                            "ground_missing",
                            format!("the trace was recorded on a ground surface, but {} has no {GROUND_MESH}", map.dir.display()),
                        ));
                    }
                    let field = height_field(&map, true)?;
                    (
                        field,
                        Some(map),
                        "ground: auto, the map has a ground derivative".to_owned(),
                    )
                }
                None => {
                    let field = height_field(&map, false)?;
                    (
                        field,
                        Some(map),
                        "xodr: auto, the map has no ground derivative (legacy elevation)"
                            .to_owned(),
                    )
                }
            }
        }
    };
    if let Some(pinned) = pinned {
        if field.source().digest != pinned {
            return Err(CliError::findings(
                "height_source_mismatch",
                format!(
                    "the {} height source has digest {}, but the workspace's timelines were baked on {pinned}",
                    field.source().kind,
                    field.source().digest
                ),
            ));
        }
    }
    Ok((field, map, why))
}

/// Build the timeline for `trace` (the one entry point `render` shares).
#[allow(clippy::too_many_arguments)]
pub fn build_timeline(
    trace: &SimTrace,
    trace_path: &Path,
    choice: HeightChoice,
    flat_z: Option<f64>,
    map_dir: Option<&Path>,
    cache_root: Option<&Path>,
    pinned_height: Option<&str>,
    catalog_digest: Option<&str>,
) -> Result<Built, CliError> {
    let (height, map, height_selection) =
        choose_height(trace, choice, flat_z, map_dir, cache_root, pinned_height)?;
    let timeline = build_render_timeline(trace, &height, catalog_digest)
        .map_err(|e| rejected(e, trace_path))?;
    let bytes = timeline
        .to_canonical_json()
        .map_err(|e| rejected(e, trace_path))?;
    let sha256 = installed_maps::sha256_hex(bytes.as_bytes());
    Ok(Built {
        timeline,
        bytes,
        sha256,
        map,
        height_selection,
    })
}

fn write_out(path: &Path, bytes: &str) -> Result<(), CliError> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| {
            CliError::new(
                "write_failed",
                format!("cannot create {}: {e}", parent.display()),
            )
        })?;
    }
    let data = if path.extension().is_some_and(|e| e == "gz") {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(bytes.as_bytes())
            .and_then(|_| encoder.finish())
            .map_err(|e| CliError::new("write_failed", format!("gzip: {e}")))?
    } else {
        bytes.as_bytes().to_vec()
    };
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

fn identity_json(built: &Built) -> Value {
    let id = &built.timeline.identity;
    json!({
        "version": tl::RENDER_TIMELINE_VERSION,
        "timelineSha256": built.sha256,
        "timelineKey": id.timeline_key,
        "traceSha256": id.trace_sha256,
        "heightFieldDigest": id.height_field_digest,
        "catalogDigest": id.catalog_digest,
        "samplerVersion": id.sampler_version,
        "heightSource": built.timeline.height_source,
        "contactOrigin": built.timeline.contact_origin,
        "heightSelection": built.height_selection,
        "map": built.map,
        "mapId": built.timeline.map_id,
        "actors": built.timeline.actors.len(),
        "ticks": built.timeline.tick_count,
        "clipEndS": built.timeline.time.clip_end_s,
        "byteLength": built.bytes.len(),
    })
}

fn build(args: BuildArgs) -> CmdResult {
    let cache_root = args.cache_root.as_deref();
    let map_dir = args.map_dir.as_deref();
    let Some(ws_dir) = args.workspace.as_deref() else {
        let trace_path = args
            .trace
            .as_deref()
            .expect("clap requires --trace without a workspace");
        let trace = load_trace(trace_path, args.recorded_trace_sha256.as_deref())?;
        let built = build_timeline(
            &trace,
            trace_path,
            args.height,
            args.flat_z,
            map_dir,
            cache_root,
            None,
            args.catalog_digest.as_deref(),
        )?;
        let mut out = identity_json(&built);
        if let Some(path) = &args.out {
            write_out(path, &built.bytes)?;
            out["out"] = json!(paths::absolutize(path));
        }
        return Ok(Outcome::ok(out));
    };

    let ws = Workspace::open(ws_dir)?;
    let packaged = ws.timelines()?;
    let first = packaged.first().ok_or_else(|| {
        CliError::findings(
            "workspace_invalid",
            "the workspace manifest lists no timelines",
        )
    })?;
    let trace_path = ws.member(TRACE);
    let trace = load_trace(&trace_path, Some(ws.trace_sha256()?))?;
    if trace.header.engine_graph_digest != ws.xodr_sha256()? {
        return Err(CliError::findings(
            "workspace_inconsistent",
            "the trace's engineGraphDigest differs from the manifest's map.xodrSha256",
        )
        .with_detail(
            json!({ "trace": trace.header.engine_graph_digest, "manifest": ws.xodr_sha256()? }),
        ));
    }
    // A workspace pins the height source and the catalog digest by its first
    // (source-rendered) timeline, unless --height overrides it explicitly.
    let pinned = match args.height {
        HeightChoice::Auto => Some(
            ws.height_source_digest()
                .unwrap_or(first.height_field_digest.as_str()),
        ),
        _ => None,
    };
    let built = build_timeline(
        &trace,
        &trace_path,
        args.height,
        args.flat_z,
        map_dir,
        cache_root,
        pinned,
        first.catalog_digest.as_deref(),
    )?;

    // Compare against every packaged timeline: same key under the same
    // sampler must be the same bytes; another sampler is re-derived by design.
    let mut comparisons = Vec::new();
    let mut mismatch = false;
    for p in &packaged {
        let same_key = p.timeline_key == built.timeline.identity.timeline_key;
        let reproduces = same_key.then(|| p.timeline_sha256 == built.sha256);
        if reproduces == Some(false) {
            mismatch = true;
        }
        comparisons.push(json!({
            "timelineSha256": p.timeline_sha256,
            "timelineKey": p.timeline_key,
            "samplerVersion": p.sampler_version,
            "sameKey": same_key,
            "reproduces": reproduces,
            "note": if same_key { Value::Null } else if p.sampler_version != built.timeline.identity.sampler_version {
                json!(format!("packaged under {}; this build derives {}", p.sampler_version, built.timeline.identity.sampler_version))
            } else {
                json!("different key inputs (height source or catalog)")
            },
        }));
    }
    let mut out = identity_json(&built);
    out["workspace"] = json!(ws.dir);
    out["packaged"] = json!(comparisons);
    if mismatch {
        out["reproduces"] = json!(false);
        return Ok(Outcome::findings(out));
    }
    let target = args
        .out
        .clone()
        .unwrap_or_else(|| ws.timeline_path(&built.sha256));
    write_out(&target, &built.bytes)?;
    out["out"] = json!(paths::absolutize(&target));
    Ok(Outcome::ok(out))
}
