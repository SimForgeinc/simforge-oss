//! Site matching: `template × map -> ranked MatchedSite[]`.
//!
//! Thin on purpose: the matcher is a pure function and the only things this
//! layer adds are the vocabulary translation in `anchor::adapt`, the
//! matchability gate, and the executable-map-control filter that keeps sites
//! with incomplete physical signal/stop bindings out of the ranked result so
//! the first reported site is always executable.

use serde::Serialize;
use serde_json::Value;

use crate::anchor::adapt::{adapt_template, unmatchable_notes, AdaptNote};
use crate::anchor::matcher::{match_anchor_report, MatchOptions};
use crate::anchor::{MDiversity, MatchReport, MatchedSite};
use crate::bundle::MapBundle;
use crate::error::{detail, CompileError, CompileResult};
use crate::map_signals::{build_site_road_controls, build_site_signal_plan};
use crate::materialize::{assert_materializable_map_controls, SiteSelection};
use crate::template::ScenarioTemplate;

/// The catalog persists a concrete matcher-site id rather than an instruction
/// to pick the best currently-visible site, so authoring and replay share one
/// policy: retain every otherwise-eligible exact site (up to the validated
/// model cap) and never discard it for presentation diversity.
pub const CATALOG_EXACT_MAX_SITES: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SiteMatchOptions {
    pub min_score: Option<f64>,
    pub max_sites: Option<usize>,
    /// Use the catalog's lossless persisted-site replay policy.
    pub exact_catalog_site_resolution: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteMatch {
    pub map_id: String,
    pub report: MatchReport,
    pub notes: Vec<AdaptNote>,
}

/// Refuse to match an anchor whose author stated a requirement the matcher
/// threw away. A clause the matcher cannot express is a requirement nobody
/// will ever check; matching anyway returns sites at score 1.00 / `exact`
/// scored against a strictly smaller predicate than the one the author wrote.
/// The escape hatch is the schema's own: `essentiality: "cosmetic"`.
pub fn assert_matchable_anchor(notes: &[AdaptNote]) -> CompileResult<()> {
    let fatal = unmatchable_notes(notes);
    let Some(first) = fatal.first() else {
        return Ok(());
    };
    let reason = if fatal.len() == 1 {
        first.reason.clone()
    } else {
        format!(
            "{} authored clauses are unmatchable; the first is at {}: {}",
            fatal.len(),
            first.path,
            first.reason
        )
    };
    Err(CompileError::at("clause_unmatchable", first.path.clone(), reason).with_detail(detail(&[
        ("clauses", Value::Array(fatal.iter().map(|n| serde_json::json!({ "path": n.path, "reason": n.reason })).collect())),
        (
            "hint",
            Value::String("express the requirement with a clause the matcher supports, or mark it essentiality: \"cosmetic\" to state on the record that it is not a requirement".to_owned()),
        ),
    ])))
}

/// Required map controls are part of site feasibility, not a later
/// best-effort materialization detail. Rejected sites stay resolvable by id
/// (`find_site`) and fail closed in the materializer with the precise error.
fn filter_executable_map_control_sites(
    template: &ScenarioTemplate,
    bundle: &MapBundle,
    mut report: MatchReport,
) -> CompileResult<MatchReport> {
    let view = bundle.signal_view();
    let before = report.sites.len();
    let mut kept = Vec::with_capacity(before);
    for site in std::mem::take(&mut report.sites) {
        let plan = build_site_signal_plan(&view, &site);
        let road_controls = build_site_road_controls(&view, &site);
        match assert_materializable_map_controls(template, bundle, &site, &plan, &road_controls) {
            Ok(()) => kept.push(site),
            Err(e) if e.code == "map_control_missing" => report.rejected.push(site),
            Err(e) => return Err(e),
        }
    }
    let dropped = before - kept.len();
    report.sites = kept;
    if dropped > 0 {
        if report.sites.is_empty() {
            report.failure_summary = "candidate geometry matched, but every site lacked an executable required map-control binding".to_owned();
        }
        report.warnings.push(format!("{dropped} site(s) were rejected because required map controls lacked executable physical bindings."));
    }
    Ok(report)
}

/// Match one template against one map.
pub fn match_on_map(
    template: &ScenarioTemplate,
    bundle: &MapBundle,
    options: &SiteMatchOptions,
) -> CompileResult<SiteMatch> {
    let adapted = adapt_template(template);
    assert_matchable_anchor(&adapted.notes)?;
    let mut anchor = adapted.anchor;
    if let Some(min) = options.min_score {
        anchor.policy.min_score = min;
    }
    if let Some(max) = options.max_sites {
        anchor.policy.max_sites_per_map = max;
    }
    if options.exact_catalog_site_resolution {
        anchor.policy.diversity = MDiversity::None;
        anchor.policy.max_sites_per_map = CATALOG_EXACT_MAX_SITES;
    }
    let report = match_anchor_report(
        &anchor,
        bundle.index(),
        &MatchOptions {
            roles: adapted.roles,
            max_frames: None,
        },
    );
    let report = filter_executable_map_control_sites(template, bundle, report)?;
    Ok(SiteMatch {
        map_id: bundle.map_id().to_owned(),
        report,
        notes: adapted.notes,
    })
}

/// Match across several maps, in the given order.
pub fn match_on_maps<'a>(
    template: &ScenarioTemplate,
    bundles: impl IntoIterator<Item = &'a MapBundle>,
    options: &SiteMatchOptions,
) -> CompileResult<Vec<SiteMatch>> {
    bundles
        .into_iter()
        .map(|b| match_on_map(template, b, options))
        .collect()
}

/// Resolve one site on a map: the top-ranked site, or an explicit id (which
/// may name a rejected site; the materializer then fails with the precise
/// reason).
pub fn find_site(
    template: &ScenarioTemplate,
    bundle: &MapBundle,
    selection: SiteSelection<'_>,
) -> CompileResult<MatchedSite> {
    let options = SiteMatchOptions {
        max_sites: Some(100),
        ..Default::default()
    };
    let matched = match_on_map(template, bundle, &options)?;
    match selection {
        SiteSelection::Auto => matched.report.sites.into_iter().next().ok_or_else(|| {
            CompileError::at(
                "no_site",
                "anchor",
                format!("no site matched on {}", bundle.map_id()),
            )
            .with_detail(detail(&[
                (
                    "failureSummary",
                    Value::String(matched.report.failure_summary.clone()),
                ),
                (
                    "warnings",
                    Value::Array(
                        matched
                            .report
                            .warnings
                            .iter()
                            .cloned()
                            .map(Value::String)
                            .collect(),
                    ),
                ),
            ]))
        }),
        SiteSelection::Id(site_id) => {
            let available: Vec<Value> = matched
                .report
                .sites
                .iter()
                .take(10)
                .map(|s| Value::String(s.site_id.clone()))
                .collect();
            matched
                .report
                .sites
                .into_iter()
                .chain(matched.report.rejected)
                .find(|s| s.site_id == site_id)
                .ok_or_else(|| {
                    CompileError::at(
                        "unknown_site",
                        "--site",
                        format!("site \"{site_id}\" was not produced on {}", bundle.map_id()),
                    )
                    .with_detail(detail(&[
                        ("available", Value::Array(available)),
                        (
                            "failureSummary",
                            Value::String(matched.report.failure_summary),
                        ),
                    ]))
                })
        }
    }
}

pub fn round3(value: f64) -> f64 {
    simforge_core::math::js_round(value * 1000.0) / 1000.0
}

/// The compact site view the CLI prints.
pub fn site_summary(site: &MatchedSite) -> Value {
    serde_json::json!({
        "siteId": site.site_id,
        "mapId": site.map_id,
        "score": round3(site.score),
        "verdict": site.degradation.verdict,
        "intentPreserved": site.degradation.intent_preserved,
        "origin": site.frame.origin.map_feature_id,
        "entryLaneRsl": site.frame.entry_lane_rsl,
        "egoTurn": site.frame.ego_turn,
        "runwayUpstreamM": round3(site.frame.runway_upstream_m),
        "runwayDownstreamM": round3(site.frame.runway_downstream_m),
        "mirrored": site.frame.mirrored,
        "alternateFrames": site.alternate_frames,
        "degradation": {
            "summary": site.degradation.summary,
            "repairs": site.degradation.repairs.iter().map(|r| serde_json::json!({ "kind": r.kind_name(), "touchesRequired": r.touches_required(), "note": r.note() })).collect::<Vec<_>>(),
            "failedRequiredClauses": site.degradation.failed_required_clauses,
        },
        "bindings": site.bindings.iter().map(|b| serde_json::json!({
            "role": b.role,
            "kind": b.kind,
            "status": b.status,
            "laneRsl": b.lane_rsl,
            "routeLanes": b.route_lane_chain.as_ref().map_or(0, Vec::len),
            "conflict": b.conflict.as_ref().map(|c| serde_json::json!({
                "gateId": c.gate_id,
                "crossingAngleDeg": round3(c.crossing_angle_deg),
                "relation": c.relation,
                "sOnEgo": round3(c.s_on_ego),
                "sOnActor": round3(c.s_on_actor),
            })),
            "notes": b.notes,
        })).collect::<Vec<_>>(),
        "clauses": site.clauses.iter().map(|c| serde_json::json!({
            "path": c.path,
            "essentiality": c.essentiality,
            "score": round3(c.score),
            "slack": round3(c.slack),
            "supported": c.supported,
            "required": c.required,
            "actual": c.actual,
            "reason": c.reason,
        })).collect::<Vec<_>>(),
        "matchedReasons": site.matched_reasons,
    })
}
