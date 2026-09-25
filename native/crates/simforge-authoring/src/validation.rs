//! `validate <instance|template> [--tier 1|2]`.
//!
//! Tier 1 is the static pass: a template gets `template validate`, an
//! instance the engine contract plus the `t = 0` feasibility guards. Tier 2 is
//! one engine pass: the invariant residuals the template declared, the engine
//! issues, the never-fired triggers and the preemptions only a run can settle.
//! It is the acceptance test for a transfer: did what the author said must
//! stay true actually stay true on this site.

use std::path::Path;

use simforge_bindings_common::runtime::{check_feasibility_json, Scenario};
use simforge_compiler::expr::ExprScope;
use simforge_compiler::invariants::{check_invariants, InvariantContext, InvariantStatus};
use simforge_compiler::sites::{match_on_map, SiteMatchOptions};
use simforge_compiler::CompileError;
use simforge_core::error::SimIssueSeverity;
use simforge_core::solve::ArrivalSolution;
use simforge_core::types::SimScenarioInput;

use crate::engine::{engine_error, simulate};
use crate::instance::{compile_at, materialize_options};
use crate::jsvalue::JsValue;
use crate::maps::MapRoot;
use crate::metrics::metrics_summary;
use crate::readers::{read_instance, read_js};
use crate::sites::find_site;
use crate::template::{read_template, TemplateFile};

#[derive(Debug, Clone, Default)]
pub struct ValidateOptions {
    pub tier: u8,
    pub map_id: Option<String>,
    pub site_id: Option<String>,
    pub draw: Option<i64>,
    pub seed: Option<String>,
}

fn js<T: serde::Serialize + ?Sized>(value: &T) -> Result<JsValue, CompileError> {
    JsValue::from_serialize(value)
}

fn entries(pairs: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::object(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

/// `detectKind`: `scenarioVersion: 2` is a template, anything else an instance.
fn is_template(file: &Path) -> Result<bool, CompileError> {
    let doc = read_js(file)?;
    Ok(doc.get("scenarioVersion").and_then(JsValue::as_f64) == Some(2.0))
}

/// The `validate` document and whether it passed.
pub fn run_validate(
    root: &MapRoot,
    file: &Path,
    file_arg: &str,
    options: &ValidateOptions,
) -> Result<(JsValue, bool), CompileError> {
    let template_kind = is_template(file)?;
    let kind = if template_kind {
        "template"
    } else {
        "instance"
    };

    if options.tier == 1 {
        if template_kind {
            let (value, ok) = crate::validate::template_validate(
                root,
                file,
                file_arg,
                options.map_id.as_deref(),
                options.site_id.as_deref(),
            )?;
            return Ok((JsValue::from_serialize(&value)?, ok));
        }
        // A tier-1 pass on an instance: the engine contract plus the guards.
        let instance = read_instance(file)?;
        let map = root.load(&instance.input.map_id)?;
        let bytes = serde_json::to_vec(&instance.input)
            .map_err(|e| CompileError::internal(format!("serialise input: {e}")))?;
        let scenario = Scenario::parse(&bytes).map_err(engine_error)?;
        let issues_text = check_feasibility_json(&scenario, map.graph()).map_err(engine_error)?;
        let issues: Vec<simforge_core::error::SimIssue> = serde_json::from_str(&issues_text)
            .map_err(|e| CompileError::internal(format!("feasibility issues: {e}")))?;
        let errors = issues
            .iter()
            .filter(|i| i.severity == SimIssueSeverity::Error)
            .count();
        let doc = entries(vec![
            ("file", JsValue::String(file_arg.to_owned())),
            ("tier", JsValue::Number(1.0)),
            ("kind", JsValue::String("instance".into())),
            ("ok", JsValue::Bool(errors == 0)),
            ("issues", js(&issues)?),
        ]);
        return Ok((doc, errors == 0));
    }

    // --- tier 2 ------------------------------------------------------------
    let input: SimScenarioInput;
    let mut template: Option<TemplateFile> = None;
    let arrival: Vec<ArrivalSolution>;
    let mut speed_limit_kph: Option<f64> = None;
    if template_kind {
        let Some(map_id) = options.map_id.as_deref() else {
            return Err(CompileError::at(
                "missing_option",
                "--map",
                "tier-2 validation of a template needs --map",
            ));
        };
        let file_template = read_template(file)?;
        let map = root.load(map_id)?;
        let site = match options.site_id.as_deref() {
            Some(site_id) => find_site(&file_template.template, map.bundle(), site_id, false)?,
            None => {
                let matched = match_on_map(
                    &file_template.template,
                    map.bundle(),
                    &SiteMatchOptions::default(),
                )?;
                match matched.report.sites.first() {
                    Some(site) => site.clone(),
                    None => {
                        return Err(CompileError::at(
                            "no_site",
                            "--map",
                            format!("no site matched on {map_id}"),
                        )
                        .detail_entry(
                            "failureSummary",
                            serde_json::json!(matched.report.failure_summary),
                        )
                        .as_findings());
                    }
                }
            }
        };
        let compiled = compile_at(
            &file_template.document,
            map.bundle(),
            &site.site_id,
            &materialize_options(options.seed.clone(), options.draw),
        )?;
        speed_limit_kph = map
            .bundle()
            .topology()
            .lanes
            .get(site.frame.entry_lane_rsl.as_str())
            .and_then(|lane| lane.speed_limit_kph);
        arrival = compiled.manifest.arrival.clone();
        input = compiled.input;
        template = Some(file_template);
    } else {
        let instance = read_instance(file)?;
        arrival = match instance.document.at(&["manifest", "arrival"]) {
            Some(value) => serde_json::from_value(value.to_value())
                .map_err(|e| CompileError::internal(format!("manifest arrival: {e}")))?,
            None => Vec::new(),
        };
        if let Some(map_id) = options.map_id.as_deref() {
            let map = root.load(map_id)?;
            let rsl = instance
                .input
                .actors
                .first()
                .and_then(|a| a.initial.lane_ref.as_ref())
                .map(|r| r.rsl.clone())
                .unwrap_or_default();
            speed_limit_kph = map
                .bundle()
                .topology()
                .lanes
                .get(rsl.as_str())
                .and_then(|lane| lane.speed_limit_kph);
        }
        input = instance.input;
    }

    let map = root.load(&input.map_id)?;
    let run = simulate(&input, &map)?;
    let trace = crate::engine::reparse_trace(&run.trace)?;

    let invariants = match &template {
        Some(t) => {
            let scope = ExprScope {
                lane_speed_limit_kph: speed_limit_kph,
                lane_width_m: None,
                junction_size_m: None,
                clip_seconds: Some(trace.header.clip_seconds),
                params: Default::default(),
            };
            check_invariants(&InvariantContext {
                template: &t.template,
                trace: &trace,
                scope: &scope,
                arrival: &arrival,
                speed_limit_kph,
            })
        }
        None => Vec::new(),
    };
    let violated = invariants
        .iter()
        .filter(|r| r.status == InvariantStatus::Violated && r.essentiality == "required")
        .count();
    let errors = run
        .issues
        .iter()
        .filter(|i| i.severity == SimIssueSeverity::Error)
        .count();
    let ok = violated == 0 && errors == 0;
    let events = js(&run.trace.events)?;
    let preemptions = match events {
        JsValue::Array(items) => JsValue::Array(
            items
                .into_iter()
                .filter(|e| e.get("kind").and_then(JsValue::as_str) == Some("preemption"))
                .collect(),
        ),
        other => other,
    };
    let doc = entries(vec![
        ("file", JsValue::String(file_arg.to_owned())),
        ("tier", JsValue::Number(2.0)),
        ("kind", JsValue::String(kind.to_owned())),
        ("ok", JsValue::Bool(ok)),
        ("mapId", JsValue::String(input.map_id.clone())),
        ("metrics", js(&metrics_summary(&run.trace.metrics))?),
        ("invariants", js(&invariants)?),
        ("issues", js(&run.issues)?),
        (
            "triggerNeverFired",
            js(&run.trace.metrics.trigger_never_fired)?,
        ),
        ("preemptions", preemptions),
    ]);
    Ok((doc, ok))
}
