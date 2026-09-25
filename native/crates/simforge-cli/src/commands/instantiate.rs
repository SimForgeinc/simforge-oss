//! `simforge instantiate`: template x site x draw -> one concrete instance.

use std::path::PathBuf;

use clap::Args;
use simforge_authoring::instance::{run_instantiate, InstantiateOptions};

use super::authoring_support::{cli_error, exit_for, map_root};
use crate::contract::{CmdResult, Ctx, Outcome};

#[derive(Debug, Args)]
pub struct InstantiateArgs {
    /// The v2 template.
    #[arg(value_name = "TEMPLATE")]
    pub template: PathBuf,
    /// The installed map.
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
    /// Also write the instance file here.
    #[arg(long, value_name = "FILE")]
    pub out: Option<PathBuf>,
}

/// Exit 2 when the instance is infeasible (the document says why).
pub fn run(args: InstantiateArgs, _ctx: &Ctx) -> CmdResult {
    let root = map_root()?;
    let (payload, feasible) = run_instantiate(
        &root,
        &args.template,
        &args.map,
        &args.site,
        &InstantiateOptions {
            seed: args.seed,
            draw: args.draw,
            out: args.out,
        },
    )
    .map_err(cli_error)?;
    Ok(Outcome {
        value: payload,
        exit: exit_for(feasible),
    })
}
