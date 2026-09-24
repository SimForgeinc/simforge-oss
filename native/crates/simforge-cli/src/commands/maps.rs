//! `simforge maps`: content-addressed map releases.

use std::path::PathBuf;

use clap::{Args, Subcommand};

use super::not_implemented;
use crate::contract::{CmdResult, Ctx};

#[derive(Debug, Subcommand)]
pub enum MapsCommand {
    /// Pull an immutable map release into the local cache, verifying every blob's sha256.
    Pull(PullArgs),
}

#[derive(Debug, Args)]
pub struct PullArgs {
    /// The release to pull, as `<name>@<version>` (e.g. `richmond-field-station@v2`).
    #[arg(value_name = "NAME@VERSION")]
    pub spec: String,
    /// Registry base URL (https:// or file://). Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the public registry.
    #[arg(long, value_name = "URL")]
    pub registry: Option<String>,
    /// Map cache root. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps.
    #[arg(long, value_name = "DIR")]
    pub cache_root: Option<PathBuf>,
}

pub fn run(command: MapsCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        MapsCommand::Pull(_) => Err(not_implemented("maps pull")),
    }
}
