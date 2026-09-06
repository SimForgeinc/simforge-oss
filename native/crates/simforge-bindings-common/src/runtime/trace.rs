//! Trace documents: current-format parsing, digest, scene-state emission and
//! evaluation. Everything reads the trace alone; older trace versions are
//! rejected by the core parser, never backfilled.

use simforge_compiler::expr::ExprScope;
use simforge_compiler::invariants::{check_invariants, InvariantContext};
use simforge_compiler::parse_template;
use simforge_core::evaluation::intent::{
    create_blind_review_packet, evaluate_intent_rubric, parse_intent_rubric, summarize_behavior,
    BehaviorSummaryLimits, IntentRubric,
};
use simforge_core::evaluation::{evaluate_trace, EvaluateFilters};
use simforge_core::solve::ArrivalSolution;
use simforge_core::trace::scene_state::emit_scene_state;
use simforge_core::trace::SimTrace;

use crate::error::{BindingError, Result};

fn gunzip_if_needed(bytes: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>> {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        use std::io::Read;
        let mut plain = Vec::new();
        flate2::read::MultiGzDecoder::new(bytes)
            .read_to_end(&mut plain)
            .map_err(|e| BindingError::runtime(format!("gunzip: {e}")))?;
        Ok(std::borrow::Cow::Owned(plain))
    } else {
        Ok(std::borrow::Cow::Borrowed(bytes))
    }
}

/// A validated current-format trace.
pub struct Trace {
    trace: SimTrace,
}

impl Trace {
    /// Parse plain or gzip trace JSON; rejects non-current formats.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let plain = gunzip_if_needed(bytes)?;
        let trace = SimTrace::from_json_slice(&plain)
            .map_err(|e| BindingError::runtime(format!("trace: {e}")))?;
        Ok(Self { trace })
    }

    #[inline]
    pub fn inner(&self) -> &SimTrace {
        &self.trace
    }

    /// `sha256(canonicalJson(quantize(trace)))`, the current `traceDigest`.
    pub fn digest(&self) -> Result<String> {
        Ok(self.trace.digest()?)
    }

    /// The trace re-serialised (quantised) as canonical JSON.
    pub fn to_json(&self) -> Result<String> {
        let mut trace = self.trace.clone();
        trace.quantize();
        Ok(serde_json::to_string(&trace)?)
    }

    /// `simforge.scene-state.v1` document JSON.
    pub fn scene_state_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&emit_scene_state(&self.trace))?)
    }

    /// `EpisodeMetrics` recorded in the trace, as JSON.
    pub fn metrics_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.trace.metrics)?)
    }

    /// `TraceEvaluation` JSON; `filters_json` is an optional camelCase `EvaluateFilters` (unknown keys rejected).
    pub fn evaluate_json(&self, filters_json: Option<&str>) -> Result<String> {
        let filters = match filters_json {
            None => EvaluateFilters::default(),
            Some(text) => {
                // `EvaluateFilters` is a strict camelCase DTO: absent fields keep
                // the evaluator's defaults, unknown fields are rejected.
                serde_json::from_str(text)
                    .map_err(|e| BindingError::argument(format!("evaluate filters: {e}")))?
            }
        };
        Ok(serde_json::to_string(&evaluate_trace(
            &self.trace,
            &filters,
        ))?)
    }

    /// `IntentEvaluation` JSON for an intent rubric document.
    pub fn intent_rubric_json(&self, rubric_json: &str) -> Result<String> {
        let rubric = parse_rubric(rubric_json)?;
        Ok(serde_json::to_string(&evaluate_intent_rubric(
            &self.trace,
            &rubric,
        ))?)
    }

    /// `BlindReviewPacket` JSON: the rubric evaluated against this trace,
    /// stripped for review without the authored intent.
    pub fn blind_review_packet_json(&self, rubric_json: &str) -> Result<String> {
        let rubric = parse_rubric(rubric_json)?;
        let evaluation = evaluate_intent_rubric(&self.trace, &rubric);
        Ok(serde_json::to_string(&create_blind_review_packet(
            &rubric,
            &evaluation,
        ))?)
    }

    /// `BehaviorSummary` JSON; `limits_json` is an optional camelCase `BehaviorSummaryLimits`.
    pub fn behavior_summary_json(&self, limits_json: Option<&str>) -> Result<String> {
        let limits: BehaviorSummaryLimits = match limits_json {
            None => BehaviorSummaryLimits::default(),
            Some(text) => serde_json::from_str(text)
                .map_err(|e| BindingError::argument(format!("behavior summary limits: {e}")))?,
        };
        Ok(serde_json::to_string(&summarize_behavior(
            &self.trace,
            &limits,
        ))?)
    }
}

/// `{scope?: {lane?: {speedLimitKph?, widthM?}, junction?: {sizeM?}, clip?: {seconds?}, params?: {id: number}}, arrival?: ArrivalSolution[], speedLimitKph?}`
/// - the TS `ExprScope` wire shape, flattened onto the compiler's scope.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct InvariantOptions {
    scope: ScopeJson,
    arrival: Vec<ArrivalSolution>,
    speed_limit_kph: Option<f64>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct ScopeJson {
    lane: LaneScope,
    junction: JunctionScope,
    clip: ClipScope,
    params: std::collections::BTreeMap<String, f64>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct LaneScope {
    speed_limit_kph: Option<f64>,
    width_m: Option<f64>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct JunctionScope {
    size_m: Option<f64>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct ClipScope {
    seconds: Option<f64>,
}

impl From<ScopeJson> for ExprScope {
    fn from(s: ScopeJson) -> Self {
        ExprScope {
            lane_speed_limit_kph: s.lane.speed_limit_kph,
            lane_width_m: s.lane.width_m,
            junction_size_m: s.junction.size_m,
            clip_seconds: s.clip.seconds,
            params: s.params,
        }
    }
}

impl Trace {
    /// `InvariantResidualReport[]` JSON: the template's declared invariants
    /// checked against this trace.
    pub fn invariants_json(
        &self,
        template_json: &str,
        options_json: Option<&str>,
    ) -> Result<String> {
        let document: serde_json::Value = serde_json::from_str(template_json)
            .map_err(|e| BindingError::argument(format!("template: {e}")))?;
        let template = parse_template(&document)?;
        let o: InvariantOptions = match options_json {
            None => InvariantOptions::default(),
            Some(text) => serde_json::from_str(text)
                .map_err(|e| BindingError::argument(format!("invariant options: {e}")))?,
        };
        let scope: ExprScope = o.scope.into();
        let ctx = InvariantContext {
            template: &template,
            trace: &self.trace,
            scope: &scope,
            arrival: &o.arrival,
            speed_limit_kph: o.speed_limit_kph,
        };
        Ok(serde_json::to_string(&check_invariants(&ctx))?)
    }
}

fn parse_rubric(rubric_json: &str) -> Result<IntentRubric> {
    let value: serde_json::Value = serde_json::from_str(rubric_json)
        .map_err(|e| BindingError::argument(format!("intent rubric: {e}")))?;
    Ok(parse_intent_rubric(&value)?)
}

/// Canonical JSON (`canonicalJson`) of an arbitrary document.
pub fn canonical_json(document: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(document)?;
    Ok(simforge_core::hash::canonical_json(&value)?)
}

/// `contentHash` = sha256 of the canonical JSON of an arbitrary document.
pub fn content_hash(document: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(document)?;
    Ok(simforge_core::hash::content_hash(&value)?)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    simforge_core::hash::sha256_bytes(bytes)
}
