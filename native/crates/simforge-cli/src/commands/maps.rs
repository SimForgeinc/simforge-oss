//! `simforge maps`: content-addressed map releases.

use std::path::PathBuf;

use clap::{Args, Subcommand};
use serde_json::json;

use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::paths;
use crate::registry::{self, PullOptions};

#[derive(Debug, Subcommand)]
pub enum MapsCommand {
    /// List the maps and versions a registry offers (logged in: the maps your organization can use).
    List(ListArgs),
    /// Pull an immutable map release into the local cache, verifying every blob's sha256.
    Pull(PullArgs),
}

/// Which registry to read. Default: the logged-in account's registry on the
/// host, else the public registry.
#[derive(Debug, Args)]
pub struct RegistryArgs {
    /// Registry base URL (https:// or file://), instead of the account's. Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the logged-in account's registry, then the public registry. A private https registry named here reads a bearer token from SIMFORGE_MAPS_REGISTRY_TOKEN.
    #[arg(long, value_name = "URL")]
    pub registry: Option<String>,
    /// SimForge host whose account registry to use (see `simforge login`). Default: SIMFORGE_HOST, then simforge.ai.
    #[arg(long, value_name = "HOST")]
    pub host: Option<String>,
}

#[derive(Debug, Args)]
pub struct ListArgs {
    #[command(flatten)]
    pub source: RegistryArgs,
}

#[derive(Debug, Args)]
pub struct PullArgs {
    /// The release to pull, as `<name>@<version>` (e.g. `richmond-field-station@v2`); `<name>` alone pulls the latest.
    #[arg(value_name = "NAME@VERSION")]
    pub spec: String,
    #[command(flatten)]
    pub source: RegistryArgs,
    /// Map cache root. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps.
    #[arg(long, value_name = "DIR")]
    pub cache_root: Option<PathBuf>,
    /// Also install the verbatim source rasters (images/*.png|jpg|webp|avif) under dev-assets.
    #[arg(long)]
    pub archive: bool,
    /// Parallel blob downloads (1-32).
    #[arg(long, value_name = "N", default_value_t = 8)]
    pub concurrency: usize,
}

pub fn run(command: MapsCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        MapsCommand::List(args) => list(args),
        MapsCommand::Pull(args) => pull(args),
    }
}

fn list(args: ListArgs) -> CmdResult {
    let registry = registry::select(args.source.registry.as_deref(), args.source.host.as_deref())?;
    let mut listing = registry::list(&registry)?;
    listing["registry"] = registry.describe();
    Ok(Outcome::ok(listing))
}

fn pull(args: PullArgs) -> CmdResult {
    if !(1..=32).contains(&args.concurrency) {
        return Err(
            CliError::new("bad_value", "--concurrency must be an integer from 1 to 32")
                .with_path("--concurrency"),
        );
    }
    let cache_root = paths::maps_root(args.cache_root.as_deref())?;
    let registry = registry::select(args.source.registry.as_deref(), args.source.host.as_deref())?;
    let mut summary = registry::pull(
        &registry,
        &args.spec,
        &PullOptions {
            cache_root: cache_root.value.clone(),
            archive: args.archive,
            concurrency: args.concurrency,
        },
    )?;
    summary["registry"] = registry.describe();
    summary["cacheRootSource"] = json!(cache_root.source);
    Ok(Outcome::ok(summary))
}
