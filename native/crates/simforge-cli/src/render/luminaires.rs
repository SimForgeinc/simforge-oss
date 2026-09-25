//! The map's street luminaires: the port of
//! packages/render/src/native/luminaires.ts. The ingest-built derivative
//! (`derived/luminaires/manifest.json`, `simforge.map-luminaires.v1`) becomes
//! the service's `lighting.night.fixtures`, ordered nearest the job's camera
//! path first; the service lights them once the sun is below
//! [`LUMINAIRES_ON_ELEVATION_DEG`].

use serde::Serialize;
use serde_json::{json, Value};

use crate::contract::CliError;

pub const LUMINAIRES_MANIFEST: &str = "derived/luminaires/manifest.json";
const LUMINAIRES_SCHEMA: &str = "simforge.map-luminaires.v1";
/// render-core `NIGHT_SOURCES_ELEVATION_DEG`.
pub const LUMINAIRES_ON_ELEVATION_DEG: f64 = -3.0;

/// One fixture as the service's `NightFixture` reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NightFixture {
    pub source_id: String,
    pub source_name: String,
    pub position: [f64; 3],
    pub heading_rad: f64,
    pub rule: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuminairesPlan {
    pub members: Vec<String>,
    pub manifest_sha256: String,
    pub build_key: String,
    pub fixtures: Vec<NightFixture>,
}

fn bad(code: &str, why: impl Into<String>) -> CliError {
    CliError::findings(code, why)
}

/// `planNativeLuminaires` over a map closure: `sha256_of(member)` is the
/// member's digest (None when the closure lacks it), `read_text(member)` its
/// contents. `Ok(None)` when the map carries no derivative (a night render
/// then warns `night_luminaires_absent`); a derivative from another master,
/// or a malformed one, is an error.
pub fn plan_luminaires(
    sha256_of: impl Fn(&str) -> Option<String>,
    read_text: impl Fn(&str) -> Result<String, CliError>,
) -> Result<Option<LuminairesPlan>, CliError> {
    let Some(manifest_sha256) = sha256_of(LUMINAIRES_MANIFEST) else {
        return Ok(None);
    };
    let manifest: Value = serde_json::from_str(&read_text(LUMINAIRES_MANIFEST)?).map_err(|e| {
        bad(
            "native_luminaires_invalid",
            format!("{LUMINAIRES_MANIFEST} is not JSON ({e})"),
        )
    })?;
    if manifest["schema"] != LUMINAIRES_SCHEMA {
        return Err(bad(
            "native_luminaires_invalid",
            format!("schema {} ({LUMINAIRES_SCHEMA})", manifest["schema"]),
        ));
    }
    let build_key = manifest["buildKey"]
        .as_str()
        .ok_or_else(|| bad("native_luminaires_invalid", "no buildKey"))?
        .to_owned();
    let list = manifest["fixtures"]
        .as_array()
        .ok_or_else(|| bad("native_luminaires_invalid", "fixtures"))?;
    let master = &manifest["source"]["master"];
    if master["path"] != "master.gltf"
        || master["sha256"].as_str().map(str::to_owned) != sha256_of("master.gltf")
        || master["sha256"].is_null()
    {
        return Err(bad(
            "native_luminaires_master_mismatch",
            "the derivative was built from another master.gltf",
        ));
    }
    let fixtures = list
        .iter()
        .enumerate()
        .map(|(index, f)| {
            let invalid = || bad("native_luminaires_invalid", format!("fixture {index}"));
            let source_id = f["sourceId"].as_str().ok_or_else(invalid)?;
            let position = f["position"]
                .as_array()
                .filter(|p| p.len() == 3)
                .ok_or_else(invalid)?;
            let position: Vec<f64> = position
                .iter()
                .map(|v| v.as_f64().filter(|v| v.is_finite()))
                .collect::<Option<_>>()
                .ok_or_else(invalid)?;
            let heading = f["headingRad"]
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(invalid)?;
            Ok(NightFixture {
                source_id: source_id.to_owned(),
                source_name: f["sourceName"].as_str().unwrap_or(source_id).to_owned(),
                position: [position[0], position[1], position[2]],
                heading_rad: heading,
                rule: f["rule"].as_str().unwrap_or("").to_owned(),
            })
        })
        .collect::<Result<Vec<_>, CliError>>()?;
    Ok(Some(LuminairesPlan {
        members: vec![LUMINAIRES_MANIFEST.to_owned()],
        manifest_sha256,
        build_key,
        fixtures,
    }))
}

/// `orderNativeFixtures`: nearest first to the camera path (closest approach
/// over every scheduled eye), ties by source id; the observer is the first eye.
pub fn order_fixtures(
    fixtures: &[NightFixture],
    eyes: &[[f64; 3]],
) -> (Vec<NightFixture>, Option<[f64; 3]>) {
    let closest = |f: &NightFixture| -> f64 {
        let mut best = f64::INFINITY;
        for eye in eyes {
            let (dx, dy, dz) = (
                f.position[0] - eye[0],
                f.position[1] - eye[1],
                f.position[2] - eye[2],
            );
            let d = dx * dx + dy * dy + dz * dz;
            if d < best {
                best = d;
            }
        }
        best
    };
    let mut keyed: Vec<(f64, &NightFixture)> = fixtures.iter().map(|f| (closest(f), f)).collect();
    keyed.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.1.source_id
                    .encode_utf16()
                    .cmp(b.1.source_id.encode_utf16())
            })
    });
    (
        keyed.into_iter().map(|(_, f)| f.clone()).collect(),
        eyes.first().copied(),
    )
}

/// The engine's `lighting` with the ordered fixtures (and the observer) in
/// `night`, as it writes the scene spec.
pub fn with_fixtures(
    lighting: &Value,
    fixtures: &[NightFixture],
    observer: Option<[f64; 3]>,
) -> Value {
    let mut out = lighting.clone();
    out["night"]["fixtures"] = json!(fixtures);
    if let Some(observer) = observer {
        out["night"]["observer_position"] = json!(observer);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn manifest() -> Value {
        json!({
            "schema": "simforge.map-luminaires.v1", "buildKey": "b".repeat(64),
            "source": { "master": { "path": "master.gltf", "sha256": "a".repeat(64) } }, "builder": { "revision": 1, "fingerprint": "f" }, "rejected": 0,
            "fixtures": [
                { "sourceId": "n1", "sourceName": "{x}StreetLight_30ft", "position": [100, 8, 0], "headingRad": 0.5, "rule": "head" },
                { "sourceId": "n2", "sourceName": "{y}Luminaire_Head02", "position": [10, 6, 0], "headingRad": 0, "rule": "lamp-head" },
            ],
        })
    }

    fn plan(value: Option<Value>, master: &str) -> Result<Option<LuminairesPlan>, CliError> {
        let mut files: BTreeMap<&str, (String, String)> = BTreeMap::new();
        files.insert("master.gltf", (master.to_owned(), "{}".into()));
        if let Some(v) = value {
            files.insert(LUMINAIRES_MANIFEST, ("c".repeat(64), v.to_string()));
        }
        plan_luminaires(
            |uri| files.get(uri).map(|f| f.0.clone()),
            |uri| Ok(files[uri].1.clone()),
        )
    }

    #[test]
    fn reads_the_derivative_and_refuses_one_from_another_master() {
        assert!(plan(None, &"a".repeat(64)).unwrap().is_none());
        let p = plan(Some(manifest()), &"a".repeat(64)).unwrap().unwrap();
        assert_eq!(
            json!(p.fixtures),
            json!([
                { "source_id": "n1", "source_name": "{x}StreetLight_30ft", "position": [100.0, 8.0, 0.0], "heading_rad": 0.5, "rule": "head" },
                { "source_id": "n2", "source_name": "{y}Luminaire_Head02", "position": [10.0, 6.0, 0.0], "heading_rad": 0.0, "rule": "lamp-head" },
            ])
        );
        assert_eq!(
            plan(Some(manifest()), &"d".repeat(64)).unwrap_err().code,
            "native_luminaires_master_mismatch"
        );
        let mut broken = manifest();
        broken["fixtures"] = json!([{ "sourceId": "n1", "position": [0, 0], "headingRad": 0 }]);
        let err = plan(Some(broken), &"a".repeat(64)).unwrap_err();
        assert_eq!(
            (err.code.as_str(), err.reason.as_str()),
            ("native_luminaires_invalid", "fixture 0")
        );
    }

    #[test]
    fn orders_fixtures_nearest_to_the_camera_path_first() {
        let p = plan(Some(manifest()), &"a".repeat(64)).unwrap().unwrap();
        let (ordered, observer) = order_fixtures(&p.fixtures, &[[0.0, 1.5, 0.0], [95.0, 1.5, 0.0]]);
        assert_eq!(
            ordered
                .iter()
                .map(|f| f.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["n1", "n2"]
        );
        assert_eq!(observer, Some([0.0, 1.5, 0.0]));
        let (ordered, _) = order_fixtures(&p.fixtures, &[[0.0, 1.5, 0.0]]);
        assert_eq!(
            ordered
                .iter()
                .map(|f| f.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["n2", "n1"]
        );
    }
}
