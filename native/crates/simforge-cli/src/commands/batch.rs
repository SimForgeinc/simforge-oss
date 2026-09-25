//! `simforge batch`: a template's sites x draws matrix, instantiate ->
//! simulate -> evaluate per cell, resumable, over a thread pool.

use std::path::PathBuf;

use clap::Args;
use serde_json::{json, Value};
use simforge_authoring::batch::{run_batch, BatchOptions, AMBIENT_PRESETS, DEFAULT_AMBIENT_SETTLE_S};
use simforge_authoring::evaluate::FilterMode;
use simforge_compiler::AmbientTrafficProfile;

use super::authoring_support::{cli_error, exit_for, map_root};
use crate::contract::{CliError, CmdResult, Ctx, Outcome};

#[derive(Debug, Args)]
pub struct BatchArgs {
    /// The v2 template.
    #[arg(value_name = "TEMPLATE")]
    pub template: PathBuf,
    /// One installed map.
    #[arg(long, value_name = "MAP")]
    pub map: Option<String>,
    /// Several installed maps, comma-separated, in this order.
    #[arg(long, value_name = "MAPS", value_delimiter = ',')]
    pub maps: Vec<String>,
    /// Every installed map.
    #[arg(long)]
    pub all_maps: bool,
    /// Parameter draws per site.
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub draws: Option<i64>,
    /// The batch directory (cells and batch-summary.json).
    #[arg(long, value_name = "DIR")]
    pub out: String,
    /// Drop sites scoring below this.
    #[arg(long, value_name = "SCORE", allow_negative_numbers = true)]
    pub min_score: Option<f64>,
    /// Keep at most this many sites per map.
    #[arg(long, value_name = "N")]
    pub max_sites: Option<usize>,
    /// Worker threads (default min(4, cpus - 1)).
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub concurrency: Option<i64>,
    /// Do not write the per-cell traces.
    #[arg(long)]
    pub no_trace: bool,
    /// Reject filters: critical | negative-control | all.
    #[arg(long, value_name = "MODE")]
    pub filter: Option<String>,
    /// The trivially-safe TTC threshold, seconds.
    #[arg(long, value_name = "S", allow_negative_numbers = true)]
    pub trivial_ttc: Option<f64>,
    /// Re-run every cell, even one whose results still hold.
    #[arg(long)]
    pub force: bool,
    /// Generated background traffic: off | light | moderate | city | heavy.
    #[arg(long, value_name = "PRESET")]
    pub ambient: Option<String>,
    /// Ambient density override, vehicles per km of eligible lane.
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub ambient_density: Option<f64>,
    /// Ambient actor cap.
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub ambient_max_actors: Option<i64>,
    /// Ambient candidate radius around the choreography, metres.
    #[arg(long, value_name = "M", allow_negative_numbers = true)]
    pub ambient_radius_m: Option<f64>,
    /// Ambient population seed.
    #[arg(long, value_name = "SEED")]
    pub ambient_seed: Option<String>,
    /// Seconds of ambient-only warm-up before t = 0 (default 20 with --ambient).
    #[arg(long, value_name = "S", allow_negative_numbers = true)]
    pub ambient_settle: Option<f64>,
}

fn presets() -> String {
    AMBIENT_PRESETS.join("|")
}

/// `--filter` (default `critical`).
pub fn filter_mode(raw: Option<&str>) -> Result<FilterMode, CliError> {
    match raw {
        None => Ok(FilterMode::Critical),
        Some(text) => FilterMode::parse(text).ok_or_else(|| {
            CliError::new("bad_value", "--filter must be critical | negative-control | all").with_path("--filter")
        }),
    }
}

/// `--ambient <preset>` and its overrides. `None` keeps the roads empty; an
/// override without `--ambient` is refused rather than silently ignored.
fn ambient_profile(args: &BatchArgs) -> Result<Option<AmbientTrafficProfile>, CliError> {
    let Some(preset) = args.ambient.as_deref() else {
        let overrides = [
            ("--ambient-density", args.ambient_density.is_some()),
            ("--ambient-max-actors", args.ambient_max_actors.is_some()),
            ("--ambient-radius-m", args.ambient_radius_m.is_some()),
            ("--ambient-seed", args.ambient_seed.is_some()),
        ];
        if let Some((flag, _)) = overrides.iter().find(|(_, given)| *given) {
            return Err(CliError::new(
                "missing_argument",
                format!("{flag} requires --ambient <{}>", presets()),
            )
            .with_path(*flag));
        }
        return Ok(None);
    };
    if !AMBIENT_PRESETS.contains(&preset) {
        return Err(CliError::new("bad_value", format!("--ambient must be {}", AMBIENT_PRESETS.join(" | ")))
            .with_path("--ambient"));
    }
    let mut profile = json!({ "version": 1, "preset": preset });
    if let Some(v) = args.ambient_density {
        profile["densityVehiclesPerKm"] = json!(v);
    }
    if let Some(v) = args.ambient_max_actors {
        profile["maxActors"] = json!(v);
    }
    if let Some(v) = args.ambient_radius_m {
        profile["radiusM"] = json!(v);
    }
    if let Some(v) = &args.ambient_seed {
        profile["seed"] = Value::String(v.clone());
    }
    serde_json::from_value(profile)
        .map(Some)
        .map_err(|e| CliError::new("bad_value", format!("ambient profile: {e}")).with_path("--ambient"))
}

/// `--ambient-settle`: only with an ambient preset other than `off`.
fn ambient_settle(args: &BatchArgs) -> Result<Option<f64>, CliError> {
    match args.ambient.as_deref() {
        None | Some("off") => match args.ambient_settle {
            Some(_) => Err(CliError::new(
                "missing_argument",
                format!("--ambient-settle requires --ambient <{}>", presets()),
            )
            .with_path("--ambient-settle")),
            None => Ok(None),
        },
        Some(_) => match args.ambient_settle {
            None => Ok(Some(DEFAULT_AMBIENT_SETTLE_S)),
            Some(s) if !(s >= 0.0) || !s.is_finite() || s > 300.0 => Err(CliError::new(
                "bad_value",
                "--ambient-settle must be between 0 and 300 seconds",
            )
            .with_path("--ambient-settle")),
            Some(s) => Ok(Some(s)),
        },
    }
}

/// Exit 2 when the matrix is empty (no site matched on any map).
pub fn run(args: BatchArgs, _ctx: &Ctx) -> CmdResult {
    let root = map_root()?;
    let maps: Vec<String> = args.maps.iter().map(|m| m.trim().to_owned()).filter(|m| !m.is_empty()).collect();
    let map_ids = root
        .select(args.map.as_deref(), &maps, args.all_maps)
        .map_err(cli_error)?;
    let filter = filter_mode(args.filter.as_deref())?;
    let ambient = ambient_profile(&args)?;
    let ambient_settle_seconds = ambient_settle(&args)?;
    let options = BatchOptions {
        map_ids,
        draws: args.draws.unwrap_or(1),
        out_dir: args.out.clone(),
        min_score: args.min_score,
        max_sites: args.max_sites,
        concurrency: args.concurrency,
        write_trace: !args.no_trace,
        filter,
        trivial_ttc_s: args.trivial_ttc,
        force: args.force,
        ambient,
        ambient_settle_seconds,
    };
    let (payload, any) = run_batch(&root, &args.template, &options).map_err(cli_error)?;
    Ok(Outcome { value: payload, exit: exit_for(any) })
}
