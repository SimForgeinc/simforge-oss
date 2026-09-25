//! `sites match`: anchor -> ranked concrete sites on installed maps.
//!
//! The mechanical stage of generation: no randomness, the same site ids on
//! every machine. An empty result still says why (`failureSummary`, the
//! failed required clauses), because "nothing matched" without a reason is
//! what makes an agent start guessing.

use std::path::Path;

use serde_json::{json, Value};
use simforge_compiler::anchor::{MatchedSite, Verdict};
use simforge_compiler::sites::{match_on_map, site_summary, SiteMatch, SiteMatchOptions};
use simforge_compiler::CompileError;

use crate::json::round3;
use crate::maps::MapRoot;
use crate::template::read_template;

#[derive(Debug, Clone, Default)]
pub struct SitesMatchOptions {
    pub min_score: Option<f64>,
    pub max_sites: Option<usize>,
    /// Include up to 25 rejected sites per map.
    pub include_rejected: bool,
}

/// The `sites match` document, and whether any site matched.
pub fn sites_match(
    root: &MapRoot,
    file: &Path,
    file_arg: &str,
    map_ids: &[String],
    options: &SitesMatchOptions,
) -> Result<(Value, bool), CompileError> {
    let template = read_template(file)?.template;
    let match_options = SiteMatchOptions {
        min_score: options.min_score,
        max_sites: options.max_sites,
        exact_catalog_site_resolution: false,
    };
    let mut matches: Vec<(SiteMatch, String)> = Vec::with_capacity(map_ids.len());
    for map_id in map_ids {
        let map = root.load(map_id)?;
        let matched = match_on_map(&template, map.bundle(), &match_options)?;
        matches.push((matched, map.bundle().index().topology_digest.clone()));
    }

    let mut total = 0usize;
    let maps: Vec<Value> = matches
        .iter()
        .map(|(m, topology_digest)| {
            let sites = &m.report.sites;
            total += sites.len();
            let score_range = if sites.is_empty() {
                Value::Null
            } else {
                let min = sites.iter().map(|s| s.score).fold(f64::INFINITY, f64::min);
                let max = sites.iter().map(|s| s.score).fold(f64::NEG_INFINITY, f64::max);
                json!({ "min": round3(min), "max": round3(max) })
            };
            let count = |v: Verdict| sites.iter().filter(|s| s.degradation.verdict == v).count();
            let mut entry = json!({
                "mapId": m.map_id,
                "topologyDigest": topology_digest,
                "siteCount": sites.len(),
                "scoreRange": score_range,
                "verdicts": { "exact": count(Verdict::Exact), "degraded": count(Verdict::Degraded) },
                "stats": m.report.stats,
                "warnings": m.report.warnings,
                "failureSummary": m.report.failure_summary,
                "sites": sites.iter().map(site_summary).collect::<Vec<_>>(),
            });
            if options.include_rejected {
                entry["rejected"] = Value::Array(
                    m.report.rejected.iter().take(25).map(site_summary).collect(),
                );
            }
            entry
        })
        .collect();

    let payload = json!({
        "template": file_arg,
        "templateId": template.template_id(),
        "archetype": template.meta.archetype,
        "adapterNotes": matches.first().map(|(m, _)| json!(m.notes)).unwrap_or_else(|| json!([])),
        "totalSites": total,
        "maps": maps,
    });
    Ok((payload, total > 0))
}

/// Find one site by id on a map, the way `instantiate` and `batch` resolve a
/// persisted id: the ranked match (up to 100 sites), then its rejected list.
/// A stale id still resolves from `rejected` and fails closed in the compiler.
pub fn find_site(
    template: &simforge_compiler::ScenarioTemplate,
    bundle: &simforge_compiler::MapBundle,
    site_id: &str,
    exact_catalog: bool,
) -> Result<MatchedSite, CompileError> {
    let options = SiteMatchOptions {
        min_score: None,
        max_sites: Some(100),
        exact_catalog_site_resolution: exact_catalog,
    };
    let matched = match_on_map(template, bundle, &options)?;
    let found = matched
        .report
        .sites
        .iter()
        .chain(matched.report.rejected.iter())
        .find(|s| s.site_id == site_id)
        .cloned();
    found.ok_or_else(|| {
        CompileError::at(
            "unknown_site",
            "--site",
            format!("site \"{site_id}\" was not produced on {}", bundle.map_id()),
        )
        .detail_entry(
            "known",
            json!(matched.report.sites.iter().map(|s| &s.site_id).collect::<Vec<_>>()),
        )
        .detail_entry(
            "rejected",
            json!(matched.report.rejected.iter().map(|s| &s.site_id).collect::<Vec<_>>()),
        )
    })
}
