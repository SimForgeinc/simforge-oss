//! `template new`: a minimal, schema-valid v2 skeleton.
//!
//! Deterministic: the same flags give byte-identical output (fixed epoch
//! timestamps, a pinned simulation seed), so two agents comparing skeletons
//! diff their edits, not their clocks. The shape is one `on_reference` ego,
//! an empty corridor anchor with matcher policy and a 20 s clip with no
//! interactions. With `--map` (and optionally `--site`) the skeleton is
//! pre-bound through `anchor.pin`. The emitted template is the parsed one,
//! with every schema default filled in, exactly what a validator will read.

use std::path::Path;

use serde_json::{json, Value};
use simforge_compiler::{CompileError, ScenarioTemplate};

use crate::json::write_json_file;
use crate::maps::MapRoot;
use crate::paths::resolve;
use crate::template::parse_template_issues;

const EPOCH: &str = "1970-01-01T00:00:00.000Z";

/// The skeleton document, before parsing.
pub fn skeleton(map_id: Option<&str>, site_id: Option<&str>) -> Value {
    let mut template = json!({
        "scenarioVersion": 2,
        "meta": {
            "name": "New template",
            "description": "Minimal v2 skeleton from `simforge template new`. Constrain the anchor corridor, add roles and choreography interactions, then run `simforge template validate`.",
            "createdAt": EPOCH,
            "modifiedAt": EPOCH,
            "appVersion": "simforge/template-new/v1",
            "tags": ["skeleton"],
            "author": "cli/template-new",
            "negativeControl": false,
        },
        // Pinned at birth: renaming the template never changes its simulation.
        "simulation": { "seed": "new-template", "dtS": 0.02 },
        "anchor": {
            "id": "new-template",
            "corridor": {},
            "features": [],
            "policy": { "allowMirror": true, "maxSitesPerMap": 10 },
        },
        "roles": [{
            "id": "ego",
            "kind": "on_reference",
            "actor": { "class": "car" },
            "pose": { "laneOffset": 0, "s": 15, "tFrac": 0, "headingOffsetRad": 0 },
            "initialSpeedKph": "clamp(0.8 * lane.speedLimitKph, 25, 50)",
        }],
        "choreography": { "clipSeconds": 20, "warmupSeconds": 5, "interactions": [] },
        "metricSubject": "ego",
    });
    if let Some(map_id) = map_id {
        template["sourceMap"] = json!({ "mapId": map_id, "mapName": map_id });
        let mut pin = json!({ "mapId": map_id });
        if let Some(site_id) = site_id {
            pin["siteId"] = json!(site_id);
        }
        template["anchor"]["pin"] = pin;
    }
    template
}

/// The `template new` document (`{ok, template, out}`), writing `out` when given.
pub fn template_new(
    root: &MapRoot,
    out: Option<&Path>,
    map_id: Option<&str>,
    site_id: Option<&str>,
) -> Result<Value, CompileError> {
    if site_id.is_some() && map_id.is_none() {
        return Err(CompileError::at(
            "missing_option",
            "--site",
            "--site requires --map",
        ));
    }
    if let Some(map_id) = map_id {
        root.assert_known(map_id)?;
    }
    let template: ScenarioTemplate =
        parse_template_issues(&skeleton(map_id, site_id)).map_err(|issues| {
            CompileError::internal(format!("the template skeleton does not parse: {issues:?}"))
        })?;
    let written = match out {
        Some(out) => {
            write_json_file(out, &template)?;
            Some(resolve(out).display().to_string())
        }
        None => None,
    };
    Ok(json!({ "ok": true, "template": template.to_value(), "out": written }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_parses_with_defaults() {
        let template =
            parse_template_issues(&skeleton(Some("richmond-field-station"), Some("abc"))).unwrap();
        let value = template.to_value();
        assert_eq!(value["anchor"]["pin"]["siteId"], "abc");
        assert_eq!(value["environment"]["weather"], "cloudy");
        assert_eq!(value["roles"][0]["essentiality"], "required");
        assert_eq!(value["roles"][0]["initialSpeedKph"]["kind"], "call");
    }
}
