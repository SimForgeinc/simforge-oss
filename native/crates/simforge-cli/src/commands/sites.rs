//! `simforge sites match`: a template's anchor -> ranked concrete sites.

use std::path::PathBuf;

use clap::{Args, Subcommand};
use simforge_authoring::sites::{sites_match, SitesMatchOptions};

use super::authoring_support::{cli_error, exit_for, map_root};
use crate::contract::{CmdResult, Ctx, Outcome};

#[derive(Debug, Subcommand)]
pub enum SitesCommand {
    /// Rank the concrete sites a template's anchor matches on installed maps (exit 2 when none).
    Match(MatchArgs),
}

#[derive(Debug, Args)]
pub struct MatchArgs {
    /// The v2 template.
    #[arg(value_name = "TEMPLATE")]
    pub template: PathBuf,
    /// One installed map.
    #[arg(long, value_name = "MAP")]
    pub map: Option<String>,
    /// Several installed maps, comma-separated, in this order.
    #[arg(long, value_name = "MAPS", value_delimiter = ',')]
    pub maps: Vec<String>,
    /// Every installed map.
    #[arg(long)]
    pub all_maps: bool,
    /// Drop sites scoring below this.
    #[arg(long, value_name = "SCORE")]
    pub min_score: Option<f64>,
    /// Keep at most this many sites per map.
    #[arg(long, value_name = "N")]
    pub max_sites: Option<usize>,
    /// Also list up to 25 rejected sites per map, with why.
    #[arg(long)]
    pub rejected: bool,
}

pub fn run(command: SitesCommand, _ctx: &Ctx) -> CmdResult {
    let SitesCommand::Match(args) = command;
    let root = map_root()?;
    let maps: Vec<String> = args.maps.iter().map(|m| m.trim().to_owned()).filter(|m| !m.is_empty()).collect();
    let map_ids = root
        .select(args.map.as_deref(), &maps, args.all_maps)
        .map_err(cli_error)?;
    let (payload, any) = sites_match(
        &root,
        &args.template,
        &args.template.display().to_string(),
        &map_ids,
        &SitesMatchOptions {
            min_score: args.min_score,
            max_sites: args.max_sites,
            include_rejected: args.rejected,
        },
    )
    .map_err(cli_error)?;
    Ok(Outcome { value: payload, exit: exit_for(any) })
}
