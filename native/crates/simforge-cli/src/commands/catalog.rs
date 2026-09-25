//! `simforge catalog create|verify`: the deterministic, map-grounded
//! authoring catalog (100 reserved scenario identities per installed map).

use std::path::PathBuf;

use clap::{Args, Subcommand};
use simforge_authoring::catalog::verify::{catalog_verify, VerifyOptions};
use simforge_authoring::catalog::{catalog_create, CreateOptions};
use simforge_authoring::maps::MapRoot;

use super::authoring_support::{cli_error, exit_for, map_root};
use crate::contract::{CliError, CmdResult, Ctx, Exit, Outcome};

#[derive(Debug, Subcommand)]
pub enum CatalogCommand {
    /// Reserve exactly 100 deterministic scenario identities per selected installed map
    /// (mechanisms no map can host are reported as `coverage`, exit 0).
    Create(CreateArgs),
    /// Reject catalog identity, cardinality, provenance or evidence gaps (exit 2); uncovered
    /// mechanisms are reported as `coverage` unless --require-full-coverage.
    Verify(VerifyArgs),
    /// Resumable catalog materialisation + simulation with an attempt ledger.
    Batch(BatchArgs),
}

#[derive(Debug, Args)]
pub struct BatchArgs {
    /// The catalog manifest (its slot statuses are updated in place).
    #[arg(value_name = "CATALOG")]
    pub file: PathBuf,
    /// The attempt ledger (default: catalog-execution-ledger.json beside the catalog).
    #[arg(long, value_name = "FILE")]
    pub ledger: Option<PathBuf>,
    /// Only these slot identities, comma-separated.
    #[arg(long, value_name = "IDS")]
    pub slots: Option<String>,
    /// Only slots on this map.
    #[arg(long, value_name = "MAP")]
    pub map: Option<String>,
    /// Only slots on these maps, comma-separated.
    #[arg(long, value_name = "MAPS")]
    pub maps: Option<String>,
    /// Only these incident mechanisms, comma-separated.
    #[arg(long, value_name = "IDS")]
    pub mechanisms: Option<String>,
    /// Attempts per slot, 1 to 100 (default 3).
    #[arg(long, value_name = "N", allow_hyphen_values = true)]
    pub attempts: Option<String>,
    /// Parallel slots, 1 to 32 (default: min(4, CPUs)).
    #[arg(long, value_name = "N", allow_hyphen_values = true)]
    pub concurrency: Option<String>,
    /// Start a fresh ledger instead of resuming.
    #[arg(long)]
    pub force: bool,
    /// Evaluation filter: critical | negative-control | all.
    #[arg(long, value_name = "MODE")]
    pub filter: Option<String>,
    /// Time-to-collision (s) below which a conflict counts as trivial.
    #[arg(long, value_name = "SECONDS", allow_hyphen_values = true)]
    pub trivial_ttc: Option<String>,
    /// Accept attempts whose simulation collided.
    #[arg(long)]
    pub allow_collisions: bool,
    /// Refuse a catalog that does not cover every taxonomy mechanism (default:
    /// run it and report the gap as `coverage`).
    #[arg(long)]
    pub require_full_coverage: bool,
}

#[derive(Debug, Args)]
pub struct CreateArgs {
    /// Write the catalog manifest here.
    #[arg(long, value_name = "FILE")]
    pub out: Option<String>,
    /// One installed map.
    #[arg(long, value_name = "MAP")]
    pub map: Option<String>,
    /// Several installed maps, comma-separated, in this order (default: every installed map).
    #[arg(long, value_name = "MAPS")]
    pub maps: Option<String>,
    /// The installed-maps directory (default: SCEN_DEV_ASSETS, else <maps root>/dev-assets).
    #[arg(long, value_name = "DIR")]
    pub dev_assets: Option<String>,
    /// Identity namespace mixed into every seed.
    #[arg(long, value_name = "NAME")]
    pub namespace: Option<String>,
    /// Evidence directory, relative to the catalog file (default: evidence).
    #[arg(long, value_name = "DIR")]
    pub evidence_root: Option<String>,
    /// Fail (exit 2, incomplete_mechanism_coverage) when the maps cannot cover
    /// every taxonomy mechanism. Default: write the catalog and report the gap
    /// as `coverage`.
    #[arg(long)]
    pub require_full_coverage: bool,
}

#[derive(Debug, Args)]
pub struct VerifyArgs {
    /// The catalog manifest.
    #[arg(value_name = "CATALOG")]
    pub file: PathBuf,
    /// Where the evidence tree physically is (default: beside the manifest).
    #[arg(long, value_name = "DIR")]
    pub evidence_root: Option<PathBuf>,
    /// Require every evidence file, not only those implied by slot status.
    #[arg(long)]
    pub require_evidence: bool,
    /// Fail (exit 2, insufficient_taxonomy_breadth) when the catalog does not
    /// cover every taxonomy mechanism. Default: report the gap as `coverage`.
    #[arg(long)]
    pub require_full_coverage: bool,
}

pub fn run(command: CatalogCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        CatalogCommand::Create(args) => create(args),
        CatalogCommand::Verify(args) => verify(args),
        CatalogCommand::Batch(args) => batch(args),
    }
}

/// `--maps a,b` as the reference splits it: trimmed, empty entries dropped.
fn list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn create(args: CreateArgs) -> CmdResult {
    let out = args
        .out
        .filter(|o| !o.is_empty())
        .ok_or_else(|| CliError::new("missing_option", "--out is required").with_path("--out"))?;
    if args.map.is_some() && args.maps.is_some() {
        return Err(CliError::new(
            "bad_value",
            "catalog create accepts only one of --map <id> or --maps a,b,c",
        )
        .with_path("--map"));
    }
    let map_ids = match (args.map, args.maps) {
        (Some(map), _) => Some(vec![map]),
        (None, Some(maps)) => Some(list(&maps)),
        (None, None) => None,
    };
    let (root, dev_assets_arg) = match &args.dev_assets {
        Some(dir) => (MapRoot::at(dir), dir.clone()),
        None => {
            let root = map_root()?;
            let shown = root.dir.display().to_string();
            (root, shown)
        }
    };
    let summary = catalog_create(
        &root,
        &dev_assets_arg,
        std::path::Path::new(&out),
        &CreateOptions {
            map_ids,
            namespace: args.namespace,
            evidence_root: args.evidence_root,
            require_full_coverage: args.require_full_coverage,
        },
    )
    .map_err(cli_error)?;
    Ok(Outcome {
        value: summary,
        exit: Exit::Ok,
    })
}

fn verify(args: VerifyArgs) -> CmdResult {
    let root = map_root()?;
    let (payload, ok) = catalog_verify(
        &root,
        &args.file,
        &VerifyOptions {
            manifest_file: None,
            evidence_root_override: args.evidence_root.filter(|p| !p.as_os_str().is_empty()),
            require_evidence: args.require_evidence,
            require_full_coverage: args.require_full_coverage,
        },
    )
    .map_err(cli_error)?;
    Ok(Outcome {
        value: payload,
        exit: exit_for(ok),
    })
}

/// `Number(raw)` for a flag value: surrounding whitespace ignored, `""` is 0,
/// `0x`/`0o`/`0b` prefixes, `Infinity`; anything else is NaN.
fn js_number(raw: &str) -> f64 {
    let t = raw.trim();
    if t.is_empty() {
        return 0.0;
    }
    let radix =
        |digits: &str, base: u32| u64::from_str_radix(digits, base).map_or(f64::NAN, |v| v as f64);
    match t.get(..2) {
        Some("0x" | "0X") => return radix(&t[2..], 16),
        Some("0o" | "0O") => return radix(&t[2..], 8),
        Some("0b" | "0B") => return radix(&t[2..], 2),
        _ => {}
    }
    let unsigned = t.trim_start_matches(['+', '-']);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if !unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

fn number_flag(name: &str, raw: Option<&str>) -> Result<Option<f64>, CliError> {
    let Some(raw) = raw else { return Ok(None) };
    let value = js_number(raw);
    if !value.is_finite() {
        return Err(CliError::new(
            "bad_value",
            format!("--{name} must be a number, got \"{raw}\""),
        )
        .with_path(format!("--{name}")));
    }
    Ok(Some(value))
}

fn int_flag(name: &str, raw: Option<&str>) -> Result<Option<f64>, CliError> {
    let value = number_flag(name, raw)?;
    if let Some(v) = value {
        if v.fract() != 0.0 {
            let shown = simforge_authoring::catalog::js::number_to_string(v);
            return Err(CliError::new(
                "bad_value",
                format!("--{name} must be an integer, got \"{shown}\""),
            )
            .with_path(format!("--{name}")));
        }
    }
    Ok(value)
}

fn batch(args: BatchArgs) -> CmdResult {
    use simforge_authoring::batch::cell::CollisionPolicy;
    use simforge_authoring::catalog::batch::{catalog_batch, CatalogBatchOptions};
    use simforge_authoring::evaluate::FilterMode;

    // Flag errors in the reference's order: attempts, concurrency, filter, trivial-ttc.
    let max_attempts = int_flag("attempts", args.attempts.as_deref())?.unwrap_or(3.0);
    let concurrency = int_flag("concurrency", args.concurrency.as_deref())?;
    let filter_raw = args.filter.as_deref().unwrap_or("critical");
    let filter = FilterMode::parse(filter_raw).ok_or_else(|| {
        CliError::new(
            "bad_value",
            "--filter must be critical | negative-control | all",
        )
        .with_path("--filter")
    })?;
    let trivial_ttc_s = number_flag("trivial-ttc", args.trivial_ttc.as_deref())?;
    let map_ids = match args.map.as_deref() {
        Some(map) if !map.is_empty() => vec![map.to_owned()],
        _ => args.maps.as_deref().map(list).unwrap_or_default(),
    };
    let root = map_root()?;
    let (payload, ok) = catalog_batch(
        &root,
        &CatalogBatchOptions {
            file: args.file,
            ledger: args.ledger,
            slot_ids: args.slots.as_deref().map(list).unwrap_or_default(),
            map_ids,
            mechanism_ids: args.mechanisms.as_deref().map(list).unwrap_or_default(),
            max_attempts,
            concurrency,
            force: args.force,
            filter,
            trivial_ttc_s,
            collision_policy: if args.allow_collisions {
                CollisionPolicy::Allow
            } else {
                CollisionPolicy::Reject
            },
            require_full_coverage: args.require_full_coverage,
        },
    )
    .map_err(cli_error)?;
    Ok(Outcome {
        value: payload,
        exit: exit_for(ok),
    })
}
