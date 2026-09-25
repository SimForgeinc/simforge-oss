//! `simforge export <instance> --format xosc-1.4|xosc-1.3-esmini|osc-2.2 --out`:
//! a concrete instance as an ASAM OpenSCENARIO document, with its capability
//! report. Unsupported content is refused (exit 2), never dropped.

use std::path::PathBuf;

use clap::Args;
use serde_json::json;
use simforge_authoring::export::{run_export, AsamFormat, ExportOptions};

use super::authoring_support::{cli_error, map_root};
use crate::contract::{CliError, CmdResult, Ctx, Outcome};

#[derive(Debug, Args)]
pub struct ExportArgs {
    /// The instance file (or a bare SimScenarioInput).
    #[arg(value_name = "INSTANCE")]
    pub instance: PathBuf,
    /// xosc-1.4 | xosc-1.3-esmini | osc-2.2.
    #[arg(long, value_name = "FORMAT")]
    pub format: String,
    /// Write the document here.
    #[arg(long, value_name = "FILE")]
    pub out: PathBuf,
    /// The road-network file the document references (default `<mapId>.xodr`).
    #[arg(long, value_name = "FILE")]
    pub road_file: Option<String>,
    /// FileHeader author.
    #[arg(long, value_name = "NAME")]
    pub author: Option<String>,
    /// FileHeader description.
    #[arg(long, value_name = "TEXT")]
    pub description: Option<String>,
    /// Maximum distance between exported route waypoints, metres (default 20).
    #[arg(long, value_name = "M", allow_negative_numbers = true)]
    pub route_sample_m: Option<f64>,
}

pub fn run(args: ExportArgs, _ctx: &Ctx) -> CmdResult {
    let Some(format) = AsamFormat::parse(&args.format) else {
        return Err(CliError::new("bad_value", "--format must be xosc-1.4 | xosc-1.3-esmini | osc-2.2")
            .with_path("--format")
            .with_detail(json!({ "known": AsamFormat::KNOWN })));
    };
    let root = map_root()?;
    let payload = run_export(
        &root,
        &args.instance,
        &args.instance.display().to_string(),
        format,
        &args.out,
        &ExportOptions {
            road_file: args.road_file,
            author: args.author,
            description: args.description,
            route_sample_m: args.route_sample_m,
            provenance: None,
        },
    )
    .map_err(cli_error)?;
    Ok(Outcome::ok(payload.to_value()))
}
