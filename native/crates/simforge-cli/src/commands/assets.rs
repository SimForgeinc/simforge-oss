//! `simforge assets`: the actor-asset closure (`simforge.actor-assets-closure/v1`).

use std::path::PathBuf;

use clap::{Args, Subcommand};

use super::not_implemented;
use crate::contract::{CmdResult, Ctx};

#[derive(Debug, Subcommand)]
pub enum AssetsCommand {
    /// Pull the actor-asset closure and its ATTRIBUTION.json, verifying every blob's sha256.
    Pull(PullArgs),
}

#[derive(Debug, Args)]
pub struct PullArgs {
    /// The closure digest (sha256). Default: the closure this build is pinned to.
    #[arg(long, value_name = "SHA256")]
    pub closure: Option<String>,
    /// Asset store base URL (https:// or file://). Default: SIMFORGE_ACTOR_ASSETS_BASE_URL, then the public store.
    #[arg(long, value_name = "URL")]
    pub base_url: Option<String>,
    /// Local asset root. Default: SIMFORGE_ACTOR_ASSETS_ROOT, then $XDG_DATA_HOME/simforge/actor-assets.
    #[arg(long, value_name = "DIR")]
    pub root: Option<PathBuf>,
}

pub fn run(command: AssetsCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        AssetsCommand::Pull(_) => Err(not_implemented("assets pull")),
    }
}
