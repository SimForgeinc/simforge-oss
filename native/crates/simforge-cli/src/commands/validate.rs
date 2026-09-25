//! `simforge validate <instance|template> [--tier 1|2]`: tier 1 is the static
//! pass, tier 2 one engine pass with the declared invariant residuals.

use std::path::PathBuf;

use clap::Args;
use simforge_authoring::validation::{run_validate, ValidateOptions};

use super::authoring_support::{cli_error, exit_for, map_root};
use crate::contract::{CliError, CmdResult, Ctx, Outcome};

#[derive(Debug, Args)]
pub struct ValidateArgs {
    /// A v2 template or an instance (or a bare SimScenarioInput).
    #[arg(value_name = "INSTANCE|TEMPLATE")]
    pub file: PathBuf,
    /// 1: static checks (default); 2: one engine pass with invariant residuals.
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub tier: Option<i64>,
    /// The installed map (tier-1 map checks; required for a tier-2 template).
    #[arg(long, value_name = "MAP")]
    pub map: Option<String>,
    /// Bind this site instead of the best one.
    #[arg(long, value_name = "SITE")]
    pub site: Option<String>,
    /// The parameter draw index (tier 2, template).
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub draw: Option<i64>,
    /// Override the per-cell parameter seed (tier 2, template).
    #[arg(long, value_name = "SEED")]
    pub seed: Option<String>,
}

/// Exit 2 when validation finds errors.
pub fn run(args: ValidateArgs, _ctx: &Ctx) -> CmdResult {
    let tier = args.tier.unwrap_or(1);
    if tier != 1 && tier != 2 {
        return Err(CliError::new("bad_value", "--tier must be 1 or 2").with_path("--tier"));
    }
    let root = map_root()?;
    let (payload, ok) = run_validate(
        &root,
        &args.file,
        &args.file.display().to_string(),
        &ValidateOptions {
            tier: tier as u8,
            map_id: args.map,
            site_id: args.site,
            draw: args.draw,
            seed: args.seed,
        },
    )
    .map_err(cli_error)?;
    Ok(Outcome {
        value: payload.to_value(),
        exit: exit_for(ok),
    })
}
