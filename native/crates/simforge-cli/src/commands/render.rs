//! `simforge render`: one offline render job over a workspace.

use std::path::PathBuf;

use clap::Args;

use super::{not_implemented, Preset};
use crate::contract::{CmdResult, Ctx};

#[derive(Debug, Args)]
pub struct RenderArgs {
    /// The workspace directory (an imported scenario package).
    #[arg(value_name = "WORKSPACE")]
    pub workspace: PathBuf,
    /// The render preset.
    #[arg(long, value_enum)]
    pub preset: Preset,
    /// The sensor rig (cameras, lidar, radar) as JSON.
    #[arg(long, value_name = "RIG.JSON")]
    pub rig: PathBuf,
    /// Output directory (created; must be empty if it exists).
    #[arg(long, value_name = "DIR")]
    pub out: PathBuf,
}

pub fn run(_args: RenderArgs, _ctx: &Ctx) -> CmdResult {
    Err(not_implemented("render"))
}
