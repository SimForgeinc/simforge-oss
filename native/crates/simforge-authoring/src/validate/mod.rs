//! `template validate`: schema + tier 1.
//!
//! Tier 1 is the "on every edit" pass: it never simulates. It reads the
//! document (structural and timing checks) and, when `--map` binds a site,
//! asks that site about lanes, runway, movements and signals. Without a site
//! there is no anchor frame and no honest way to answer "is there a lane at
//! (k, s)", so the map checks are skipped and `mapChecked` says so rather
//! than reporting a pass nobody earned. Schema failures come back in the same
//! issue shape (`schema_invalid`), so a repair loop reads one list either way.

pub mod issue;
pub mod manual_drive;
pub mod map_checks;
pub mod map_context;
pub mod set_keys;
pub mod structural;
pub mod timing;

use std::path::Path;

use serde_json::{json, Value};
use simforge_compiler::anchor::adapt::{adapt_template, AdaptSeverity};
use simforge_compiler::sites::{match_on_map, SiteMatchOptions};
use simforge_compiler::{CompileError, ScenarioTemplate};

pub use issue::{sort_issues, Issue, Severity};
use map_context::SiteContext;

use crate::json::read_json;
use crate::maps::MapRoot;
use crate::template::parse_template_issues;

/// Every tier-1 issue for a parsed template, sorted; the map checks run when
/// a site context is given.
pub fn validate_template(template: &ScenarioTemplate, map: Option<&SiteContext<'_>>) -> Vec<Issue> {
    let mut issues = structural::structural_issues(template);
    if let Some(map) = map {
        issues.extend(map_checks::map_issues(template, map));
    }
    sort_issues(&mut issues);
    issues
}

fn counts(issues: &[Issue]) -> Value {
    let n = |s: Severity| issues.iter().filter(|i| i.severity == s).count();
    json!({ "error": n(Severity::Error), "warning": n(Severity::Warning), "info": n(Severity::Info) })
}

/// The `template validate` document, and whether it has no errors.
pub fn template_validate(
    root: &MapRoot,
    file: &Path,
    file_arg: &str,
    map_id: Option<&str>,
    site_id: Option<&str>,
) -> Result<(Value, bool), CompileError> {
    let document = read_json(file)?;
    let template = match parse_template_issues(&document) {
        Ok(template) => template,
        Err(schema) => {
            let issues: Vec<Issue> = schema
                .into_iter()
                .map(|i| Issue::new(Severity::Error, "schema_invalid", i.path, i.message))
                .collect();
            let payload = json!({
                "file": file_arg,
                "ok": false,
                "mapChecked": false,
                "counts": counts(&issues),
                "issues": issues,
            });
            return Ok((payload, false));
        }
    };

    let mut map_checked = false;
    let mut bound_site: Option<String> = None;
    let mut map_check_skipped: Option<String> = None;
    let mut issues = match map_id {
        None => validate_template(&template, None),
        Some(map_id) => {
            let map = root.load(map_id)?;
            let matched = match_on_map(&template, map.bundle(), &SiteMatchOptions::default())?;
            let site = match site_id {
                Some(id) => matched.report.sites.iter().find(|s| s.site_id == id),
                None => matched.report.sites.first(),
            };
            match site {
                Some(site) => {
                    map_checked = true;
                    bound_site = Some(site.site_id.clone());
                    validate_template(&template, Some(&SiteContext::new(map.bundle(), site)))
                }
                None => {
                    map_check_skipped = Some(format!(
                        "the anchor matched no site on {map_id}: {}",
                        matched.report.failure_summary
                    ));
                    validate_template(&template, None)
                }
            }
        }
    };

    // A clause the matcher cannot express is a document error, not a footnote.
    let notes = adapt_template(&template).notes;
    issues.extend(
        notes
            .iter()
            .filter(|n| n.severity == AdaptSeverity::Error)
            .map(|n| {
                Issue::new(
                    Severity::Error,
                    "clause_unmatchable",
                    n.path.clone(),
                    n.reason.clone(),
                )
            }),
    );
    let ok = !issues.iter().any(|i| i.severity == Severity::Error);
    let payload = json!({
        "file": file_arg,
        "ok": ok,
        "mapChecked": map_checked,
        "mapCheckSkipped": map_check_skipped,
        "mapId": map_id,
        "siteId": bound_site,
        "counts": counts(&issues),
        "issues": issues,
        "adapterNotes": notes,
    });
    Ok((payload, ok))
}
