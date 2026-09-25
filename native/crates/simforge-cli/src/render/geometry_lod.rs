//! The map's geometry LOD derivative (`geometry-lod.ts`;
//! `derived/geometry-lod/`, schema `simforge.map-geometry-lod.v1`): the index,
//! `lod.gltf` + `lod.bin` and the impostor atlases the renderer reads. The
//! sensor proxy is not read: lidar and radar trace full detail.

use serde_json::Value;

use super::error::{PlanError, PlanResult};
use super::map_closure::{assert_safe_member_path, MemberSource, MASTER_PATH};

pub const DIRECTORY: &str = "derived/geometry-lod";
pub const MANIFEST: &str = "derived/geometry-lod/manifest.json";
const SCHEMA: &str = "simforge.map-geometry-lod.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GeometryLodMode {
    Auto,
    Off,
}

impl GeometryLodMode {
    pub fn as_str(self) -> &'static str {
        match self {
            GeometryLodMode::Auto => "auto",
            GeometryLodMode::Off => "off",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeometryLodPlan {
    /// Closure members the renderer reads (map-root relative), manifest first.
    pub members: Vec<String>,
    pub manifest_sha256: String,
    pub build_key: String,
}

fn text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// `planNativeGeometryLod`: `None` when the mode is `off` or the map
/// carries no derivative (full detail; the evidence records it). A
/// derivative present but bound to another master, malformed or missing a
/// member is an error, never a silent full-detail render.
pub fn plan_geometry_lod(
    mode: GeometryLodMode,
    source: &dyn MemberSource,
) -> PlanResult<Option<GeometryLodPlan>> {
    if mode == GeometryLodMode::Off {
        return Ok(None);
    }
    let Some(manifest_sha256) = source.sha256(MANIFEST).map(str::to_owned) else {
        return Ok(None);
    };
    let manifest: Value = serde_json::from_str(&source.read_text(MANIFEST)?).map_err(|e| {
        PlanError::new(
            "native_geometry_lod_invalid",
            format!("{MANIFEST} is not JSON ({e})"),
        )
    })?;
    if manifest.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err(PlanError::new(
            "native_geometry_lod_invalid",
            format!("schema {} ({SCHEMA})", text(manifest.get("schema"))),
        ));
    }
    let Some(build_key) = manifest.get("buildKey").and_then(Value::as_str) else {
        return Err(PlanError::new("native_geometry_lod_invalid", "no buildKey"));
    };
    let master = manifest.pointer("/source/master");
    let master_path = master.and_then(|m| m.get("path")).and_then(Value::as_str);
    let master_sha = master.and_then(|m| m.get("sha256")).and_then(Value::as_str);
    if master_path != Some(MASTER_PATH)
        || master_sha.is_none()
        || master_sha != source.sha256(MASTER_PATH)
    {
        return Err(PlanError::new(
            "native_geometry_lod_master_mismatch",
            "the derivative was built from another master.gltf",
        ));
    }
    let files = manifest.get("files");
    let lod = files.and_then(|f| f.get("lod")).filter(|v| !v.is_null());
    let lod_buffer = files
        .and_then(|f| f.get("lodBuffer"))
        .filter(|v| !v.is_null());
    let images = files
        .and_then(|f| f.get("images"))
        .and_then(Value::as_array);
    let (Some(lod), Some(lod_buffer), Some(images)) = (lod, lod_buffer, images) else {
        return Err(PlanError::new(
            "native_geometry_lod_invalid",
            "files.lod/lodBuffer/images",
        ));
    };
    if lod.get("path").and_then(Value::as_str) != Some("lod.gltf") {
        return Err(PlanError::new(
            "native_geometry_lod_invalid",
            format!(
                "files.lod is {} (the renderer reads lod.gltf)",
                text(lod.get("path"))
            ),
        ));
    }
    let mut members = vec![MANIFEST.to_owned()];
    for file in [lod, lod_buffer].into_iter().chain(images.iter()) {
        let uri = format!("{DIRECTORY}/{}", text(file.get("path")));
        assert_safe_member_path(&uri)?;
        let Some(sha256) = source.sha256(&uri) else {
            return Err(PlanError::new("native_geometry_lod_member_missing", &uri));
        };
        if Some(sha256) != file.get("sha256").and_then(Value::as_str) {
            return Err(PlanError::new("native_geometry_lod_digest_mismatch", &uri));
        }
        members.push(uri);
    }
    Ok(Some(GeometryLodPlan {
        members,
        manifest_sha256,
        build_key: build_key.to_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::testing::FakeSource;
    use serde_json::json;

    const MASTER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn manifest() -> Value {
        json!({
            "schema": SCHEMA, "buildKey": "k",
            "source": { "master": { "path": "master.gltf", "sha256": MASTER } },
            "files": {
                "lod": { "path": "lod.gltf", "sha256": "1".repeat(64) },
                "lodBuffer": { "path": "lod.bin", "sha256": "2".repeat(64) },
                "images": [{ "path": "atlas/0.ktx2", "sha256": "3".repeat(64) }],
            },
        })
    }

    fn source(manifest: Option<&Value>) -> FakeSource {
        let mut s = FakeSource::default().file("master.gltf", MASTER, "{}");
        if let Some(m) = manifest {
            s = s
                .file(MANIFEST, &"c".repeat(64), &m.to_string())
                .file("derived/geometry-lod/lod.gltf", &"1".repeat(64), "")
                .file("derived/geometry-lod/lod.bin", &"2".repeat(64), "")
                .file("derived/geometry-lod/atlas/0.ktx2", &"3".repeat(64), "");
        }
        s
    }

    #[test]
    fn plans_the_derivative_manifest_first() {
        let plan = plan_geometry_lod(GeometryLodMode::Auto, &source(Some(&manifest())))
            .unwrap()
            .unwrap();
        assert_eq!(
            plan.members,
            [
                MANIFEST,
                "derived/geometry-lod/lod.gltf",
                "derived/geometry-lod/lod.bin",
                "derived/geometry-lod/atlas/0.ktx2"
            ]
        );
        assert_eq!(plan.build_key, "k");
        assert_eq!(
            plan_geometry_lod(GeometryLodMode::Off, &source(Some(&manifest()))).unwrap(),
            None
        );
        assert_eq!(
            plan_geometry_lod(GeometryLodMode::Auto, &source(None)).unwrap(),
            None
        );
    }

    #[test]
    fn refuses_a_bad_derivative_instead_of_rendering_full_detail() {
        let mut other = manifest();
        other["source"]["master"]["sha256"] = json!("d".repeat(64));
        assert_eq!(
            plan_geometry_lod(GeometryLodMode::Auto, &source(Some(&other)))
                .unwrap_err()
                .code,
            "native_geometry_lod_master_mismatch"
        );
        let mut digest = manifest();
        digest["files"]["lodBuffer"]["sha256"] = json!("9".repeat(64));
        assert_eq!(
            plan_geometry_lod(GeometryLodMode::Auto, &source(Some(&digest)))
                .unwrap_err()
                .message,
            "native_geometry_lod_digest_mismatch: derived/geometry-lod/lod.bin"
        );
        let mut schema = manifest();
        schema["schema"] = json!("v0");
        assert_eq!(
            plan_geometry_lod(GeometryLodMode::Auto, &source(Some(&schema)))
                .unwrap_err()
                .message,
            "native_geometry_lod_invalid: schema v0 (simforge.map-geometry-lod.v1)"
        );
        let mut lod = manifest();
        lod["files"]["lod"]["path"] = json!("x.gltf");
        assert!(
            plan_geometry_lod(GeometryLodMode::Auto, &source(Some(&lod)))
                .unwrap_err()
                .message
                .contains("files.lod is x.gltf")
        );
    }
}
