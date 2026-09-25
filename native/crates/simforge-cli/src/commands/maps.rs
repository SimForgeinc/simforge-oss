//! `simforge maps`: content-addressed map releases.

use std::path::PathBuf;

use clap::{Args, Subcommand};
use serde_json::json;

use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::paths;
use crate::registry::{self, PullOptions, Registry};

#[derive(Debug, Subcommand)]
pub enum MapsCommand {
    /// Pull an immutable map release into the local cache, verifying every blob's sha256.
    Pull(PullArgs),
}

#[derive(Debug, Args)]
pub struct PullArgs {
    /// The release to pull, as `<name>@<version>` (e.g. `richmond-field-station@v2`); `<name>` alone pulls the latest.
    #[arg(value_name = "NAME@VERSION")]
    pub spec: String,
    /// Registry base URL (https:// or file://). Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the public registry. A private https registry reads a bearer token from SIMFORGE_MAPS_REGISTRY_TOKEN.
    #[arg(long, value_name = "URL")]
    pub registry: Option<String>,
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
        MapsCommand::Pull(args) => pull(args),
    }
}

fn pull(args: PullArgs) -> CmdResult {
    if !(1..=32).contains(&args.concurrency) {
        return Err(
            CliError::new("bad_value", "--concurrency must be an integer from 1 to 32")
                .with_path("--concurrency"),
        );
    }
    let url = paths::registry_url(args.registry.as_deref());
    let cache_root = paths::maps_root(args.cache_root.as_deref())?;
    let token = std::env::var(registry::TOKEN_ENV)
        .ok()
        .filter(|t| !t.trim().is_empty());
    let registry = Registry::new(&url.value, token)?;
    let mut summary = registry::pull(
        &registry,
        &args.spec,
        &PullOptions {
            cache_root: cache_root.value.clone(),
            archive: args.archive,
            concurrency: args.concurrency,
        },
    )?;
    summary["registry"] = json!(registry.url);
    summary["registrySource"] = json!(url.source);
    // Whether a token was sent; never the token.
    summary["registryAuth"] = json!(if registry.authenticated() {
        format!("bearer (env:{})", registry::TOKEN_ENV)
    } else {
        "none".to_owned()
    });
    summary["cacheRootSource"] = json!(cache_root.source);
    Ok(Outcome::ok(summary))
}
