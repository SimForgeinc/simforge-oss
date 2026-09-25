//! `simforge variation fork|transfer`: one executable child of a template,
//! with its lineage (`instance.json`, `trace.json.gz`, `variation.json`).

use std::path::PathBuf;

use clap::{Args, Subcommand};
use simforge_authoring::variation::{fork, transfer, VariationOptions};

use super::authoring_support::{cli_error, map_root};
use crate::contract::{CmdResult, Ctx, Outcome};

#[derive(Debug, Subcommand)]
pub enum VariationCommand {
    /// Portable template x target site -> an executable child variation with lineage.
    Fork(ForkArgs),
    /// Lift a map-bound template on its source map and bind it to a site on the target map.
    Transfer(TransferArgs),
}

#[derive(Debug, Args)]
pub struct ForkArgs {
    /// The portable v2 template.
    #[arg(value_name = "TEMPLATE")]
    pub template: PathBuf,
    /// The installed target map.
    #[arg(long, value_name = "MAP")]
    pub map: String,
    /// A site id from `simforge sites match`.
    #[arg(long, value_name = "SITE")]
    pub site: String,
    /// Override the per-cell parameter seed.
    #[arg(long, value_name = "SEED")]
    pub seed: Option<String>,
    /// The parameter draw index.
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub draw: Option<i64>,
    /// The variation directory to write.
    #[arg(long, value_name = "DIR")]
    pub out: PathBuf,
}

#[derive(Debug, Args)]
pub struct TransferArgs {
    /// The map-bound v2 template.
    #[arg(value_name = "TEMPLATE")]
    pub template: PathBuf,
    /// The installed map the template is bound to.
    #[arg(long, value_name = "MAP")]
    pub source_map: String,
    /// The installed map to transfer onto.
    #[arg(long, value_name = "MAP")]
    pub target_map: String,
    /// A site id of the lifted template on the target map.
    #[arg(long, value_name = "SITE")]
    pub site: String,
    /// Override the per-cell parameter seed.
    #[arg(long, value_name = "SEED")]
    pub seed: Option<String>,
    /// The parameter draw index.
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub draw: Option<i64>,
    /// The variation directory to write.
    #[arg(long, value_name = "DIR")]
    pub out: PathBuf,
}

pub fn run(command: VariationCommand, _ctx: &Ctx) -> CmdResult {
    let root = map_root()?;
    let payload = match command {
        VariationCommand::Fork(args) => fork(
            &root,
            &args.template,
            &args.map,
            &args.site,
            &args.out,
            &VariationOptions { seed: args.seed, draw: args.draw },
        ),
        VariationCommand::Transfer(args) => transfer(
            &root,
            &args.template,
            &args.source_map,
            &args.target_map,
            &args.site,
            &args.out,
            &VariationOptions { seed: args.seed, draw: args.draw },
        ),
    }
    .map_err(cli_error)?;
    Ok(Outcome::ok(payload))
}
