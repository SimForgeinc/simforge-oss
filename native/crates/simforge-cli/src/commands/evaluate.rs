//! `simforge evaluate <trace>`: the reject filters over a trace, optionally
//! with an intent rubric and a context-blind review packet.

use std::path::PathBuf;

use clap::Args;
use simforge_authoring::evaluate::{run_evaluate, EvaluateOptions};

use super::authoring_support::{cli_error, exit_for};
use super::batch::filter_mode;
use crate::contract::{CmdResult, Ctx, Outcome};

#[derive(Debug, Args)]
pub struct EvaluateArgs {
    /// The trace (`.trace.json` or `.trace.json.gz`, any released format).
    #[arg(value_name = "TRACE")]
    pub trace: PathBuf,
    /// Reject filters: critical | negative-control | all.
    #[arg(long, value_name = "MODE")]
    pub filter: Option<String>,
    /// The trivially-safe TTC threshold, seconds.
    #[arg(long, value_name = "S", allow_negative_numbers = true)]
    pub trivial_ttc: Option<f64>,
    /// Reject any collision.
    #[arg(long)]
    pub reject_collisions: bool,
    /// An intent rubric (IntentRubric JSON) evaluated alongside criticality.
    #[arg(long, value_name = "FILE")]
    pub rubric: Option<PathBuf>,
    /// Write the context-blind review packet here (needs --rubric).
    #[arg(long, value_name = "FILE")]
    pub blind_review_out: Option<PathBuf>,
}

/// Exit 2 when the combined verdict rejects (a definite answer, not a failure).
pub fn run(args: EvaluateArgs, _ctx: &Ctx) -> CmdResult {
    let filter = filter_mode(args.filter.as_deref())?;
    let (payload, accept) = run_evaluate(
        &args.trace,
        &args.trace.display().to_string(),
        &EvaluateOptions {
            filter,
            trivial_ttc_s: args.trivial_ttc,
            reject_collisions: args.reject_collisions,
            rubric: args.rubric,
            blind_review_out: args.blind_review_out,
        },
    )
    .map_err(cli_error)?;
    Ok(Outcome {
        value: payload.to_value(),
        exit: exit_for(accept),
    })
}
