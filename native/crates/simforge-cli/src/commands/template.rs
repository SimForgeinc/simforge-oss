//! `simforge template new | validate`: a schema-valid skeleton, and schema +
//! tier-1 validation (with map checks against a bound site when `--map` is
//! given).

use std::path::PathBuf;

use clap::{Args, Subcommand};
use simforge_authoring::template_new::template_new;
use simforge_authoring::validate::template_validate;

use super::authoring_support::{cli_error, exit_for, map_root};
use crate::contract::{CmdResult, Ctx, Outcome};

#[derive(Debug, Subcommand)]
pub enum TemplateCommand {
    /// Emit a minimal schema-valid v2 template skeleton (deterministic).
    New(NewArgs),
    /// Schema + tier-1 validation; map checks against a matched site with --map (exit 2 on any error).
    Validate(ValidateArgs),
}

#[derive(Debug, Args)]
pub struct NewArgs {
    /// Also write the template here.
    #[arg(long, value_name = "FILE")]
    pub out: Option<PathBuf>,
    /// Pre-bind the skeleton to an installed map (`anchor.pin`, `sourceMap`).
    #[arg(long, value_name = "MAP")]
    pub map: Option<String>,
    /// Pin a site id too (requires --map).
    #[arg(long, value_name = "SITE")]
    pub site: Option<String>,
}

#[derive(Debug, Args)]
pub struct ValidateArgs {
    /// The v2 template.
    #[arg(value_name = "FILE")]
    pub file: PathBuf,
    /// Run the map checks against the best site on this installed map.
    #[arg(long, value_name = "MAP")]
    pub map: Option<String>,
    /// Bind this site instead of the best one (with --map).
    #[arg(long, value_name = "SITE")]
    pub site: Option<String>,
}

pub fn run(command: TemplateCommand, _ctx: &Ctx) -> CmdResult {
    let root = map_root()?;
    match command {
        TemplateCommand::New(args) => {
            let value = template_new(
                &root,
                args.out.as_deref(),
                args.map.as_deref(),
                args.site.as_deref(),
            )
            .map_err(cli_error)?;
            Ok(Outcome::ok(value))
        }
        TemplateCommand::Validate(args) => {
            let (value, ok) = template_validate(
                &root,
                &args.file,
                &args.file.display().to_string(),
                args.map.as_deref(),
                args.site.as_deref(),
            )
            .map_err(cli_error)?;
            Ok(Outcome {
                value,
                exit: exit_for(ok),
            })
        }
    }
}
