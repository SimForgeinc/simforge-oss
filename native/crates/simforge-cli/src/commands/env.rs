//! `simforge env`: the closed-loop episode server.

use std::path::PathBuf;

use clap::{Args, Subcommand};

use super::{not_implemented, Preset};
use crate::contract::{CmdResult, Ctx};

#[derive(Debug, Subcommand)]
pub enum EnvCommand {
    /// Serve reset/step/observe episodes with rendered sensors over a Unix socket.
    Serve(ServeArgs),
}

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// The workspace directory (an imported scenario package).
    #[arg(value_name = "WORKSPACE")]
    pub workspace: PathBuf,
    /// The Unix socket to listen on.
    #[arg(long, value_name = "PATH")]
    pub socket: PathBuf,
    /// The render preset for observations.
    #[arg(long, value_enum, default_value = "training")]
    pub preset: Preset,
    /// Policy decisions per second (the simulation steps at its fixed rate in between).
    #[arg(long, value_name = "HZ")]
    pub decision_hz: Option<f64>,
}

pub fn run(command: EnvCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        EnvCommand::Serve(_) => Err(not_implemented("env serve")),
    }
}
