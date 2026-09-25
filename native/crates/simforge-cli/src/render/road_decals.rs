//! The map's road decal derivative (`road-decals.ts`;
//! `derived/road-decals/manifest.json`, schema `simforge.map-road-decals.v1`):
//! the RoadRunner wear-decal layers and their calibrated opacity.

use serde_json::Value;

use super::error::{PlanError, PlanResult};
use super::map_closure::{MemberSource, MASTER_PATH};

pub const MANIFEST: &str = "derived/road-decals/manifest.json";
const SCHEMA: &str = "simforge.map-road-decals.v1";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadDecalsPlan {
    pub members: Vec<String>,
    pub manifest_sha256: String,
    pub build_key: String,
    pub opacity_scale: f64,
    pub materials: usize,
}

/// `planNativeRoadDecals`: `None` when the map carries no derivative (decals
/// composite at authored opacity; the evidence records it). A derivative
/// bound to another master or malformed is an error.
pub fn plan_road_decals(source: &dyn MemberSource) -> PlanResult<Option<RoadDecalsPlan>> {
    let Some(manifest_sha256) = source.sha256(MANIFEST).map(str::to_owned) else {
        return Ok(None);
    };
    let manifest: Value = serde_json::from_str(&source.read_text(MANIFEST)?).map_err(|e| {
        PlanError::new(
            "native_road_decals_invalid",
            format!("{MANIFEST} is not JSON ({e})"),
        )
    })?;
    if manifest.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        let found = match manifest.get("schema") {
            None => "undefined".to_owned(),
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
        };
        return Err(PlanError::new(
            "native_road_decals_invalid",
            format!("schema {found} ({SCHEMA})"),
        ));
    }
    let Some(build_key) = manifest.get("buildKey").and_then(Value::as_str) else {
        return Err(PlanError::new("native_road_decals_invalid", "no buildKey"));
    };
    let opacity_scale = manifest
        .get("opacityScale")
        .and_then(Value::as_f64)
        .filter(|v| (0.0..=1.0).contains(v));
    let Some(opacity_scale) = opacity_scale else {
        return Err(PlanError::new("native_road_decals_invalid", "opacityScale"));
    };
    let Some(materials) = manifest.get("materials").and_then(Value::as_array) else {
        return Err(PlanError::new("native_road_decals_invalid", "materials"));
    };
    let master = manifest.pointer("/source/master");
    let master_sha = master.and_then(|m| m.get("sha256")).and_then(Value::as_str);
    if master.and_then(|m| m.get("path")).and_then(Value::as_str) != Some(MASTER_PATH)
        || master_sha.is_none()
        || master_sha != source.sha256(MASTER_PATH)
    {
        return Err(PlanError::new(
            "native_road_decals_master_mismatch",
            "the derivative was built from another master.gltf",
        ));
    }
    Ok(Some(RoadDecalsPlan {
        members: vec![MANIFEST.to_owned()],
        manifest_sha256,
        build_key: build_key.to_owned(),
        opacity_scale,
        materials: materials.len(),
    }))
}

#[cfg(test)]
mod tests {
    //! Ported from `road-decals.test.ts`.
    use super::*;
    use crate::render::testing::FakeSource;
    use serde_json::json;

    fn source(manifest: Option<&Value>, master: &str) -> FakeSource {
        let s = FakeSource::default().file("master.gltf", master, "{}");
        match manifest {
            Some(m) => s.file(MANIFEST, &"c".repeat(64), &m.to_string()),
            None => s,
        }
    }

    fn manifest() -> Value {
        json!({
            "schema": SCHEMA, "buildKey": "b".repeat(64), "opacityScale": 0.2,
            "source": { "master": { "path": "master.gltf", "sha256": "a".repeat(64) } },
            "materials": [{ "index": 3, "name": "OilPath01_Road_Roads_Road_Layer1" }],
        })
    }

    #[test]
    fn is_absent_when_the_map_carries_none() {
        assert_eq!(
            plan_road_decals(&source(None, &"a".repeat(64))).unwrap(),
            None
        );
    }

    #[test]
    fn plans_the_manifest_member_and_reports_what_it_applies() {
        assert_eq!(
            plan_road_decals(&source(Some(&manifest()), &"a".repeat(64))).unwrap(),
            Some(RoadDecalsPlan {
                members: vec![MANIFEST.to_owned()],
                manifest_sha256: "c".repeat(64),
                build_key: "b".repeat(64),
                opacity_scale: 0.2,
                materials: 1,
            })
        );
    }

    #[test]
    fn refuses_a_derivative_from_another_master_never_renders_authored_opacity_silently() {
        assert_eq!(
            plan_road_decals(&source(Some(&manifest()), &"d".repeat(64)))
                .unwrap_err()
                .code,
            "native_road_decals_master_mismatch"
        );
        let mut bad = manifest();
        bad["opacityScale"] = json!(3);
        assert!(plan_road_decals(&source(Some(&bad), &"a".repeat(64)))
            .unwrap_err()
            .message
            .contains("opacityScale"));
    }
}
