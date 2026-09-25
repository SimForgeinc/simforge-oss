//! The reject filters as the authoring commands apply them: the filter mode
//! (`critical | negative-control | all`), the headline criticality band and
//! the verdict an intent rubric may combine with.

use simforge_core::evaluation::{EvaluateFilters, RejectCode, RejectFinding, Verdict};

/// `--filter`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FilterMode {
    #[default]
    Critical,
    NegativeControl,
    All,
}

impl FilterMode {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "critical" => Some(Self::Critical),
            "negative-control" => Some(Self::NegativeControl),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Critical => "critical",
            Self::NegativeControl => "negative-control",
            Self::All => "all",
        }
    }
}

/// `filtersFor(mode, {trivialTtcS, rejectCollisions})`. `negative-control`
/// is the same filter set with `trivially_safe` demoted to a tag.
pub fn filters_for(
    mode: FilterMode,
    trivial_ttc_s: Option<f64>,
    reject_collisions: bool,
) -> EvaluateFilters {
    EvaluateFilters {
        negative_control: mode == FilterMode::NegativeControl,
        trivial_ttc_s,
        reject_collisions,
        ..EvaluateFilters::default()
    }
}

pub fn verdict_str(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Accept => "accept",
        Verdict::Reject => "reject",
    }
}

pub fn code_str(code: RejectCode) -> String {
    match serde_json::to_value(code) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

/// `criticalityBand(verdict, findings)`: the batch's headline bucket.
pub fn criticality_band(verdict: Verdict, findings: &[RejectFinding]) -> &'static str {
    if verdict == Verdict::Accept {
        return "critical";
    }
    let has = |code: RejectCode| findings.iter().any(|f| f.code == code);
    // Physically impossible motion is wrong before it is anything else.
    if has(RejectCode::ImplausibleMotion) {
        "implausible-motion"
    } else if has(RejectCode::NoInteraction) {
        "no-interaction"
    } else if has(RejectCode::TriviallySafe) {
        "trivially-safe"
    } else if has(RejectCode::PhysicallyUnavoidable) {
        "unavoidable"
    } else if has(RejectCode::NeverFired) {
        "never-fired"
    } else if has(RejectCode::OutOfWindow) {
        "out-of-window"
    } else {
        "trivially-safe"
    }
}

/// `combinedEvaluationVerdict`: intent evidence may explain a deliberately
/// uneventful episode, never a hard safety or execution failure.
pub fn combined_verdict(
    verdict: Verdict,
    findings: &[RejectFinding],
    intent_verdict: Option<&str>,
) -> &'static str {
    match intent_verdict {
        None => verdict_str(verdict),
        Some("reject") => "reject",
        Some(_) => {
            let explained = [
                RejectCode::NoInteraction,
                RejectCode::TriviallySafe,
                RejectCode::OutOfWindow,
            ];
            if findings.iter().any(|f| !explained.contains(&f.code)) {
                "reject"
            } else {
                "accept"
            }
        }
    }
}

/// `simforge evaluate` options.
#[derive(Debug, Clone, Default)]
pub struct EvaluateOptions {
    pub filter: FilterMode,
    pub trivial_ttc_s: Option<f64>,
    pub reject_collisions: bool,
    /// An intent rubric evaluated alongside criticality.
    pub rubric: Option<std::path::PathBuf>,
    /// Write the context-blind review packet here (needs `rubric`).
    pub blind_review_out: Option<std::path::PathBuf>,
}

/// The `filtersFor` object as the native evaluator reads it (only the keys
/// that are set).
fn filters_json(mode: FilterMode, trivial_ttc_s: Option<f64>, reject_collisions: bool) -> String {
    let mut filters = serde_json::Map::new();
    if mode == FilterMode::NegativeControl {
        filters.insert("negativeControl".into(), serde_json::Value::Bool(true));
    }
    if let Some(v) = trivial_ttc_s {
        filters.insert("trivialTtcS".into(), serde_json::json!(v));
    }
    if reject_collisions {
        filters.insert("rejectCollisions".into(), serde_json::Value::Bool(true));
    }
    serde_json::Value::Object(filters).to_string()
}

/// Keys of each criterion kind (after `id`, `kind`, `required`), as the
/// rubric schema declares them.
const CRITERION_KEYS: &[(&str, &[&str])] = &[
    ("event_order", &["mode", "interactionIds"]),
    ("trigger", &["interactionId", "outcome"]),
    ("speed_band", &["actorId", "window", "minMps", "maxMps"]),
    (
        "stationary_success",
        &["actorId", "window", "maxSpeedMps", "minPresentSeconds"],
    ),
    (
        "stop_hold_resume",
        &[
            "actorId",
            "window",
            "stopSpeedMps",
            "minHoldSeconds",
            "mustResume",
            "resumeMinSpeedMps",
            "resumeByS",
        ],
    ),
    ("clearance", &["pair", "window", "measure", "minM"]),
    ("criticality", &["metric", "pair", "window", "minS", "maxS"]),
    (
        "occlusion",
        &["observer", "target", "occluderId", "outcome"],
    ),
    ("lane_occupancy", &["actorId", "laneRsl", "mode", "window"]),
    ("zone_occupancy", &["actorId", "mode", "window", "zone"]),
    ("collision", &["pair", "maxCount"]),
    (
        "control_indication",
        &["signalId", "window", "mode", "indications"],
    ),
    ("unsupported", &["description", "reason"]),
];

fn retain(value: &mut serde_json::Value, keys: &[&str]) {
    if let serde_json::Value::Object(map) = value {
        map.retain(|k, _| keys.contains(&k.as_str()));
    }
}

/// The rubric schema's object semantics: properties it does not declare are
/// dropped, not refused (an author's note on a criterion is not an error).
fn strip_undeclared(rubric: &mut serde_json::Value) {
    retain(
        rubric,
        &["version", "intentId", "title", "originalIntent", "criteria"],
    );
    let Some(criteria) = rubric
        .get_mut("criteria")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for criterion in criteria {
        let kind = criterion
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let Some((_, keys)) = CRITERION_KEYS
            .iter()
            .find(|(k, _)| Some(*k) == kind.as_deref())
        else {
            continue;
        };
        let mut all = vec!["id", "kind", "required"];
        all.extend_from_slice(keys);
        retain(criterion, &all);
        if let Some(zone) = criterion.get_mut("zone") {
            match zone.get("shape").and_then(serde_json::Value::as_str) {
                Some("circle") => retain(zone, &["shape", "x", "y", "radiusM"]),
                Some("box") => retain(zone, &["shape", "minX", "maxX", "minY", "maxY"]),
                _ => {}
            }
        }
    }
}

/// `readIntentRubric`: the rubric document, validated.
fn read_rubric(file: &std::path::Path) -> Result<String, simforge_compiler::CompileError> {
    use simforge_compiler::CompileError;
    let path = file.display().to_string();
    let text = std::fs::read_to_string(file).map_err(|e| {
        CompileError::at(
            "invalid_json",
            path.clone(),
            format!("cannot read intent rubric {path}: {e}"),
        )
    })?;
    let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        CompileError::at(
            "invalid_json",
            path.clone(),
            format!("cannot read intent rubric {path}: {e}"),
        )
    })?;
    strip_undeclared(&mut value);
    match simforge_core::evaluation::intent::parse_intent_rubric(&value) {
        Ok(_) => Ok(value.to_string()),
        Err(error) => {
            let issues: Vec<serde_json::Value> = match &error {
                simforge_core::error::CoreError::Schema(schema) => schema
                    .issues
                    .iter()
                    .map(|i| serde_json::json!({ "path": i.path, "reason": i.message }))
                    .collect(),
                other => vec![serde_json::json!({ "path": "", "reason": other.to_string() })],
            };
            Err(
                CompileError::at("bad_value", path, "the intent rubric is invalid")
                    .detail_entry("issues", serde_json::json!(issues))
                    .as_findings(),
            )
        }
    }
}

/// `simforge evaluate <trace>`: the reject filters (and an optional intent
/// rubric) over a trace. The document, and whether the combined verdict
/// accepts (a rejection is a finding, exit 2, not a failure to run).
pub fn run_evaluate(
    file: &std::path::Path,
    file_arg: &str,
    options: &EvaluateOptions,
) -> Result<(crate::jsvalue::JsValue, bool), simforge_compiler::CompileError> {
    use crate::jsvalue::JsValue;
    use crate::readers::{native_js, read_trace, trace_error};
    use simforge_compiler::CompileError;

    let handle = read_trace(file)?;
    let mut trace = handle.inner().clone();
    trace.quantize();
    let evaluation_text = handle
        .evaluate_json(Some(&filters_json(
            options.filter,
            options.trivial_ttc_s,
            options.reject_collisions,
        )))
        .map_err(trace_error)?;
    let evaluation: simforge_core::evaluation::TraceEvaluation =
        serde_json::from_str(&evaluation_text)
            .map_err(|e| CompileError::internal(format!("evaluation: {e}")))?;
    let evaluation_js = native_js(&evaluation_text)?;
    let band = criticality_band(evaluation.verdict, &evaluation.findings);

    let mut intent: Option<JsValue> = None;
    if let Some(rubric_file) = &options.rubric {
        let rubric = read_rubric(rubric_file)?;
        intent = Some(native_js(
            &handle.intent_rubric_json(&rubric).map_err(trace_error)?,
        )?);
        if let Some(out) = &options.blind_review_out {
            let packet = native_js(
                &handle
                    .blind_review_packet_json(&rubric)
                    .map_err(trace_error)?,
            )?;
            crate::json::write_json_file(out, &packet)?;
        }
    } else if options.blind_review_out.is_some() {
        return Err(CompileError::at(
            "missing_argument",
            "--rubric",
            "--blind-review-out requires --rubric",
        ));
    }
    let intent_verdict = intent
        .as_ref()
        .and_then(|i| i.get("verdict"))
        .and_then(JsValue::as_str)
        .map(str::to_owned);
    let combined = combined_verdict(
        evaluation.verdict,
        &evaluation.findings,
        intent_verdict.as_deref(),
    );

    let field = |name: &str| evaluation_js.get(name).cloned().unwrap_or(JsValue::Null);
    let mut entries: Vec<(String, JsValue)> = vec![
        ("file".into(), JsValue::String(file_arg.to_owned())),
        ("mapId".into(), JsValue::String(trace.header.map_id.clone())),
        (
            "metricSubject".into(),
            trace
                .header
                .metric_subject
                .clone()
                .map_or(JsValue::Null, JsValue::String),
        ),
        (
            "filter".into(),
            JsValue::String(options.filter.as_str().to_owned()),
        ),
        (
            "verdict".into(),
            JsValue::String(verdict_str(evaluation.verdict).to_owned()),
        ),
        (
            "combinedVerdict".into(),
            JsValue::String(combined.to_owned()),
        ),
        ("band".into(), JsValue::String(band.to_owned())),
        ("tags".into(), field("tags")),
        ("findings".into(), field("findings")),
        ("summary".into(), field("summary")),
        (
            "metrics".into(),
            JsValue::from_serialize(&crate::metrics::metrics_summary(&trace.metrics))?,
        ),
    ];
    if let (Some(rubric), Some(intent)) = (&options.rubric, intent) {
        entries.push((
            "intentRubric".into(),
            JsValue::String(rubric.display().to_string()),
        ));
        entries.push(("intentEvaluation".into(), intent));
    }
    if let Some(out) = &options.blind_review_out {
        entries.push((
            "blindReviewPacket".into(),
            JsValue::String(out.display().to_string()),
        ));
    }
    Ok((JsValue::object(entries), combined == "accept"))
}
