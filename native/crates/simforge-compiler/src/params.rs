//! Per-cell parameter resolution: `sha256(templateId|paramsVersion|siteId|drawIndex)`
//! seeds one xoshiro128** stream, forked once per declaration.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use simforge_core::hash::{content_hash, sha256};
use simforge_core::rng::Rng;

use crate::error::{CompileError, CompileResult};
use crate::expr::{evaluate_expr, ExprScope};
use crate::template::{ParamDecl, ParamKind, ScenarioTemplate};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDraw {
    /// Numeric parameter values, by id — the scope `param.*` reads.
    pub values: BTreeMap<String, f64>,
    /// Categorical parameter values, by id. Not visible to expressions.
    pub categorical: BTreeMap<String, String>,
    /// The hex seed the draw came from.
    pub param_seed: String,
    /// Constraints that rejected, with their messages. Empty on a good draw.
    pub rejected_constraints: Vec<String>,
}

/// Content hash of the parameter block alone (first 16 hex chars).
pub fn params_version(template: &ScenarioTemplate) -> String {
    let value = serde_json::json!({
        "declarations": template.params.declarations,
        "constraints": template.params.constraints,
    });
    content_hash(&value)
        .map(|h| h[..16].to_owned())
        .unwrap_or_default()
}

/// `sha256(templateId|paramsVersion|siteId|drawIndex)`.
pub fn cell_seed(
    template_id: &str,
    params_version: &str,
    site_id: &str,
    draw_index: i64,
) -> String {
    sha256(&format!(
        "{template_id}|{params_version}|{site_id}|{draw_index}"
    ))
}

/// Discrete parameter values, expanded from `values` or `range` + `step`.
pub fn discrete_values(decl: &ParamDecl) -> Vec<f64> {
    let ParamKind::Discrete {
        values,
        range,
        step,
        ..
    } = &decl.kind
    else {
        return Vec::new();
    };
    if let Some(v) = values {
        if !v.is_empty() {
            return v.clone();
        }
    }
    let (Some(lo), Some(hi), Some(step)) =
        (range.and_then(|r| r.0), range.and_then(|r| r.1), *step)
    else {
        return Vec::new();
    };
    // Integer-indexed accumulation: a float walk drifts and can drop the last value.
    let n = ((hi - lo) / step + 1e-9).floor() as i64;
    (0..=n).map(|i| lo + i as f64 * step).collect()
}

#[derive(Debug, Clone, PartialEq)]
enum Drawn {
    Number(f64),
    Text(String),
    Missing,
}

fn draw_one(decl: &ParamDecl, rng: &mut Rng, scope: &ExprScope) -> Result<Drawn, String> {
    Ok(match &decl.kind {
        ParamKind::Continuous { range, .. } => match (range.0, range.1) {
            (Some(lo), Some(hi)) => Drawn::Number(rng.range(lo, hi)),
            _ => decl.default_value().map_or(Drawn::Missing, Drawn::Number),
        },
        ParamKind::Discrete { .. } => {
            let values = discrete_values(decl);
            if values.is_empty() {
                decl.default_value().map_or(Drawn::Missing, Drawn::Number)
            } else {
                let idx =
                    ((rng.next_f64() * values.len() as f64).floor() as usize).min(values.len() - 1);
                Drawn::Number(values[idx])
            }
        }
        ParamKind::Categorical { values, .. } => {
            let idx =
                ((rng.next_f64() * values.len() as f64).floor() as usize).min(values.len() - 1);
            Drawn::Text(values[idx].clone())
        }
        ParamKind::Derived { expr } => {
            Drawn::Number(evaluate_expr(&expr.0, scope).map_err(|e| e.to_string())?)
        }
    })
}

/// Resolve every declared parameter for one `(site, draw)` cell.
///
/// `draw_index < 0` means "do not sample": every parameter takes its declared
/// default, which keeps a hand-authored template's numbers exactly what the
/// author wrote.
pub fn resolve_params(
    template: &ScenarioTemplate,
    site_id: &str,
    draw_index: i64,
    seed_override: Option<&str>,
) -> CompileResult<ParamDraw> {
    let version = params_version(template);
    let param_seed = seed_override
        .map(str::to_owned)
        .unwrap_or_else(|| cell_seed(template.template_id(), &version, site_id, draw_index));
    let rng = Rng::from_label(&param_seed);

    let mut values: BTreeMap<String, f64> = BTreeMap::new();
    let mut categorical: BTreeMap<String, String> = BTreeMap::new();
    let mut scope = ExprScope::default().with_clip(Some(template.choreography.clip_seconds));

    // `derived` last: it reads the others.
    let ordered = template
        .params
        .declarations
        .iter()
        .filter(|d| !d.is_derived())
        .chain(
            template
                .params
                .declarations
                .iter()
                .filter(|d| d.is_derived()),
        );

    for decl in ordered {
        let path = format!("params.declarations.{}", decl.id());
        let drawn = if draw_index < 0 && !decl.is_derived() {
            match &decl.kind {
                ParamKind::Categorical { values, default } => {
                    Drawn::Text(default.clone().unwrap_or_else(|| values[0].clone()))
                }
                _ => decl.default_value().map_or(Drawn::Missing, Drawn::Number),
            }
        } else {
            let mut forked = rng.fork(decl.id());
            draw_one(decl, &mut forked, &scope).map_err(|reason| {
                CompileError::at(
                    "param_unresolvable",
                    path.clone(),
                    format!("parameter \"{}\" could not be resolved", decl.id()),
                )
                .detail_entry("reason", Value::String(reason))
            })?
        };
        match drawn {
            Drawn::Number(v) => {
                values.insert(decl.id().to_owned(), v);
                scope.params.insert(decl.id().to_owned(), v);
            }
            Drawn::Text(s) => {
                categorical.insert(decl.id().to_owned(), s);
            }
            Drawn::Missing => {
                return Err(CompileError::at(
                    "param_unresolvable",
                    path,
                    format!("parameter \"{}\" has no value or default", decl.id()),
                ));
            }
        }
    }

    let mut rejected = Vec::new();
    for (i, constraint) in template.params.constraints.iter().enumerate() {
        let (Ok(left), Ok(right)) = (
            constraint.left.evaluate(&scope),
            constraint.right.evaluate(&scope),
        ) else {
            // A site-dependent constraint cannot be judged before the site is
            // bound; the materializer re-checks it with the full scope.
            continue;
        };
        if !constraint.op.compare(left, right) {
            rejected.push(constraint.message.clone().unwrap_or_else(|| {
                format!(
                    "constraint {i} rejected the draw: {} {} {} is false",
                    simforge_core::hash::js_number_to_string(left),
                    constraint.op.symbol(),
                    simforge_core::hash::js_number_to_string(right)
                )
            }));
        }
    }

    Ok(ParamDraw {
        values,
        categorical,
        param_seed,
        rejected_constraints: rejected,
    })
}
