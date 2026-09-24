//! `simforge timeline`: canonical trace to render timeline (`simforge.render-timeline.v1`).

use std::path::PathBuf;

use clap::{Args, Subcommand};

use super::not_implemented;
use crate::contract::{CmdResult, Ctx};

#[derive(Debug, Subcommand)]
pub enum TimelineCommand {
    /// Build the render timeline for a workspace's trace (deterministic, content-keyed).
    Build(BuildArgs),
}

#[derive(Debug, Args)]
pub struct BuildArgs {
    /// The workspace directory (an imported scenario package).
    #[arg(value_name = "WORKSPACE")]
    pub workspace: PathBuf,
    /// Write the timeline here instead of the workspace's timeline/<sha256>.json.
    #[arg(long, value_name = "FILE")]
    pub out: Option<PathBuf>,
}

pub fn run(command: TimelineCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        TimelineCommand::Build(_) => Err(not_implemented("timeline build")),
    }
}
