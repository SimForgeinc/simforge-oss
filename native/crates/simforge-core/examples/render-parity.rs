//! `render-parity <timeline> <observed.jsonl> [--profile bevy|carla] [--profile-json <file>]`
//!
//! Grades a renderer's observed per-frame actor transforms against the render
//! timeline's shared sampler and prints the `simforge.render-parity/v1` report
//! (one JSON line) on stdout. Exit 0 pass, 1 findings, 2 usage or input error.
//! The lavapipe golden harness (`qualification/golden-harness/golden.mjs`)
//! runs this until the `simforge` CLI drives the goldens.
use simforge_core::trace::timeline::parity::{compare_observed_jsonl, ParityProfile};
use simforge_core::trace::timeline::RenderTimeline;
use std::process::ExitCode;

fn fail(message: String) -> ExitCode {
    eprintln!(
        "{}",
        serde_json::json!({ "code": "parity_rejected", "reason": message })
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut positionals = Vec::new();
    let mut profile = ParityProfile::bevy();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--profile" => {
                let name = args.next().unwrap_or_default();
                match ParityProfile::named(&name) {
                    Some(p) => profile = p,
                    None => return fail(format!("--profile must be bevy or carla, not {name:?}")),
                }
            }
            "--profile-json" => {
                let path = args.next().unwrap_or_default();
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => return fail(format!("{path}: {e}")),
                };
                profile = match ParityProfile::from_json(&text) {
                    Ok(p) => p,
                    Err(e) => return fail(format!("{path}: {e}")),
                };
            }
            _ => positionals.push(arg),
        }
    }
    let [timeline_path, observed_path] = positionals.as_slice() else {
        return fail(
            "usage: render-parity <timeline> <observed.jsonl> [--profile bevy|carla]".into(),
        );
    };
    let timeline = match std::fs::read(timeline_path)
        .map_err(|e| e.to_string())
        .and_then(|b| RenderTimeline::from_json_slice(&b).map_err(|e| e.to_string()))
    {
        Ok(t) => t,
        Err(e) => return fail(format!("{timeline_path}: {e}")),
    };
    let observed = match std::fs::read_to_string(observed_path) {
        Ok(t) => t,
        Err(e) => return fail(format!("{observed_path}: {e}")),
    };
    let report = match compare_observed_jsonl(&timeline, &observed, &profile) {
        Ok(r) => r,
        Err(e) => return fail(e.to_string()),
    };
    println!(
        "{}",
        serde_json::to_string(&report).expect("report serializes")
    );
    if report.pass {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
