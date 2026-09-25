//! `simforge locations find | get | resolve`: query an installed map's
//! location catalog in semantics (type, facts, affordances, proximity) and get
//! handles back; never road ids.

use clap::{Args, Subcommand};
use simforge_authoring::locations::find::{fact_filter, js_number, FindQuery};
use simforge_authoring::locations::{locations_find, locations_get, locations_resolve};

use super::authoring_support::{cli_error, exit_for, map_root};
use crate::contract::{CliError, CmdResult, Ctx, Outcome};

#[derive(Debug, Subcommand)]
pub enum LocationsCommand {
    /// Structured query: type, subtype, tags, affordances, facts, proximity.
    Find(FindArgs),
    /// One location by handle or id (optionally with a description paragraph).
    Get(GetArgs),
    /// Free text -> ranked handles (exit 2 when nothing matched).
    Resolve(ResolveArgs),
}

#[derive(Debug, Args)]
pub struct FindArgs {
    /// The installed map.
    #[arg(long, value_name = "MAP")]
    pub map: String,
    /// Location types, comma-separated (any of).
    #[arg(long = "type", value_name = "TYPES", value_delimiter = ',')]
    pub r#type: Option<Vec<String>>,
    /// Subtypes, comma-separated (any of).
    #[arg(long, value_name = "SUBTYPES", value_delimiter = ',')]
    pub subtype: Option<Vec<String>>,
    /// Tags, comma-separated (any of).
    #[arg(long, value_name = "TAGS", value_delimiter = ',')]
    pub tags: Option<Vec<String>>,
    /// Affordances, comma-separated (any of).
    #[arg(long, value_name = "AFFORDANCES", value_delimiter = ',')]
    pub affordances: Option<Vec<String>>,
    /// Fact predicates, comma-separated, all of: `k=v`, `k>=v`, `k<=v`, `k!=v`, `k>v`, `k<v`, `k~v`, `k=?`, `k=!?`.
    #[arg(long, value_name = "FACTS", value_delimiter = ',')]
    pub facts: Option<Vec<String>>,
    /// Only locations within --within-m of this handle or id, nearest first.
    #[arg(long, value_name = "HANDLE")]
    pub near: Option<String>,
    /// Radius for --near, metres (default 250).
    #[arg(long, value_name = "M", allow_negative_numbers = true)]
    pub within_m: Option<String>,
    /// At most this many results (default 25, cap 200).
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub limit: Option<String>,
    /// Drop results within this many metres of an already selected one.
    #[arg(long, value_name = "M", allow_negative_numbers = true)]
    pub diversity_m: Option<String>,
}

#[derive(Debug, Args)]
pub struct GetArgs {
    /// A handle (`junction/rd-38-rd-34`) or id (`loc_...`).
    #[arg(value_name = "HANDLE_OR_ID")]
    pub r#ref: String,
    /// The installed map.
    #[arg(long, value_name = "MAP")]
    pub map: String,
    /// Add the natural-language description an agent reads before authoring.
    #[arg(long)]
    pub describe: bool,
}

#[derive(Debug, Args)]
pub struct ResolveArgs {
    /// Free text ("the crosswalk by the school").
    #[arg(value_name = "TEXT")]
    pub text: Vec<String>,
    /// The installed map.
    #[arg(long, value_name = "MAP")]
    pub map: String,
    /// At most this many results (default 8).
    #[arg(long, value_name = "N", allow_negative_numbers = true)]
    pub limit: Option<String>,
}

/// `Number(raw)` for a numeric flag (`bad_value` otherwise).
fn number(raw: Option<&str>, flag: &str) -> Result<Option<f64>, CliError> {
    let Some(raw) = raw else { return Ok(None) };
    js_number(raw).map(Some).ok_or_else(|| {
        CliError::new(
            "bad_value",
            format!("--{flag} must be a number, got \"{raw}\""),
        )
        .with_path(format!("--{flag}"))
    })
}

/// An integer-valued numeric flag (`5.0` is accepted, as `Number.isInteger` does).
fn integer(raw: Option<&str>, flag: &str) -> Result<Option<i64>, CliError> {
    let Some(value) = number(raw, flag)? else {
        return Ok(None);
    };
    if value.fract() != 0.0 {
        return Err(CliError::new(
            "bad_value",
            format!(
                "--{flag} must be an integer, got \"{}\"",
                simforge_core::hash::js_number_to_string(value)
            ),
        )
        .with_path(format!("--{flag}")));
    }
    Ok(Some(value as i64))
}

/// Trimmed, non-empty list entries.
fn list(values: Option<Vec<String>>) -> Option<Vec<String>> {
    values.map(|v| {
        v.into_iter()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

pub fn run(command: LocationsCommand, _ctx: &Ctx) -> CmdResult {
    let root = map_root()?;
    match command {
        LocationsCommand::Find(args) => {
            let mut facts = Vec::new();
            for entry in list(args.facts).unwrap_or_default() {
                let Some((key, value)) = entry.split_once('=') else {
                    return Err(CliError::new(
                        "bad_value",
                        format!("--facts entries must be key=value, got \"{entry}\""),
                    )
                    .with_path("--facts"));
                };
                facts.push(fact_filter(key, value));
            }
            let within = number(args.within_m.as_deref(), "within-m")?;
            let query = FindQuery {
                r#type: list(args.r#type),
                subtype: list(args.subtype),
                tags: list(args.tags),
                affordances: list(args.affordances),
                facts,
                near: args
                    .near
                    .filter(|n| !n.is_empty())
                    .map(|n| (n, within.unwrap_or(250.0))),
                limit: integer(args.limit.as_deref(), "limit")?,
                diversity_radius_m: number(args.diversity_m.as_deref(), "diversity-m")?,
            };
            let value = locations_find(&root, &args.map, &query).map_err(cli_error)?;
            Ok(Outcome::ok(value))
        }
        LocationsCommand::Get(args) => {
            let value =
                locations_get(&root, &args.map, &args.r#ref, args.describe).map_err(cli_error)?;
            Ok(Outcome::ok(value))
        }
        LocationsCommand::Resolve(args) => {
            let limit = integer(args.limit.as_deref(), "limit")?;
            let (value, any) = locations_resolve(&root, &args.map, &args.text.join(" "), limit)
                .map_err(cli_error)?;
            Ok(Outcome {
                value,
                exit: exit_for(any),
            })
        }
    }
}
