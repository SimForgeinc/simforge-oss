//! `simforge evidence verify <instance> <trace>`: is this trace the run of
//! this instance (input hash, map, actors, engine graph, catalog closure,
//! operational conditions, physics mode)?

use std::path::PathBuf;

use clap::{Args, Subcommand};
use simforge_authoring::evidence::run_verify;

use super::authoring_support::{cli_error, exit_for};
use crate::contract::{CmdResult, Ctx, Outcome};

#[derive(Debug, Subcommand)]
pub enum EvidenceCommand {
    /// Check that a trace is the run of an instance (exit 2 on any mismatch).
    Verify(VerifyArgs),
}

#[derive(Debug, Args)]
pub struct VerifyArgs {
    /// The instance file (or a bare SimScenarioInput).
    #[arg(value_name = "INSTANCE")]
    pub instance: PathBuf,
    /// The trace (`.trace.json` or `.trace.json.gz`).
    #[arg(value_name = "TRACE")]
    pub trace: PathBuf,
}

pub fn run(command: EvidenceCommand, _ctx: &Ctx) -> CmdResult {
    let EvidenceCommand::Verify(args) = command;
    let (payload, ok) = run_verify(
        &args.instance,
        &args.instance.display().to_string(),
        &args.trace,
        &args.trace.display().to_string(),
    )
    .map_err(cli_error)?;
    Ok(Outcome { value: payload.to_value(), exit: exit_for(ok) })
}
