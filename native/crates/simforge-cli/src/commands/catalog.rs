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
