//! `simforge simulate`: re-simulation from a workspace's resolution.

use std::path::PathBuf;

use clap::Args;

use super::not_implemented;
use crate::contract::{CmdResult, Ctx};

#[derive(Debug, Args)]
pub struct SimulateArgs {
    /// The workspace directory (an imported scenario package).
    #[arg(value_name = "WORKSPACE")]
    pub workspace: PathBuf,
    /// Override the resolution's seed.
    #[arg(long, value_name = "SEED")]
    pub seed: Option<String>,
    /// Write the re-simulated trace here (gzip JSON).
    #[arg(long, value_name = "FILE")]
    pub out: Option<PathBuf>,
}

pub fn run(_args: SimulateArgs, _ctx: &Ctx) -> CmdResult {
    Err(not_implemented("simulate"))
}
