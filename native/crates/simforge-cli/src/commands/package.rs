//! `simforge package`: `simforge.scenario-package/v1` containers.

use std::path::PathBuf;

use clap::{Args, Subcommand};

use super::not_implemented;
use crate::contract::{CmdResult, Ctx};

#[derive(Debug, Subcommand)]
pub enum PackageCommand {
    /// Print a package's manifest, producer and members without unpacking it.
    Inspect(PackageArgs),
    /// Verify the manifest and every member digest; exit 2 on any mismatch.
    Verify(PackageArgs),
    /// Verify, then unpack into a local workspace.
    Import(ImportArgs),
}

#[derive(Debug, Args)]
pub struct PackageArgs {
    /// The package file.
    #[arg(value_name = "PACKAGE.ZIP")]
    pub package: PathBuf,
}

#[derive(Debug, Args)]
pub struct ImportArgs {
    /// The package file.
    #[arg(value_name = "PACKAGE.ZIP")]
    pub package: PathBuf,
    /// The workspace directory to create.
    #[arg(long, value_name = "DIR")]
    pub into: PathBuf,
}

pub fn run(command: PackageCommand, _ctx: &Ctx) -> CmdResult {
    Err(not_implemented(match command {
        PackageCommand::Inspect(_) => "package inspect",
        PackageCommand::Verify(_) => "package verify",
        PackageCommand::Import(_) => "package import",
    }))
}
