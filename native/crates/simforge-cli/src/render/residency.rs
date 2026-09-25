//! Per-job static mip residency (`texture-residency.ts`,
//! docs/engineering/texture-residency.md).
//!
//! The map's texture density derivative (`derived/texture-density/manifest.json`)
//! says, for every KTX2 image, where it is drawn and the lowest texel density
//! any of its triangles maps it at. A job knows every camera position before
//! the service starts, so the finest mip level an image can be sampled at is
//! bounded by `floor(log2(density * distance / focalCorner) + NATIVE_MIN_MIP_BIAS)`.
//! Every factor is conservative: the dropped levels are levels no rendered
//! pixel samples.
//!
//! Arithmetic follows the TypeScript engine exactly (V8's `Math.tan`,
//! `Math.log2`, `Math.round`), so the plan and its digest are identical.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use simforge_core::hash::{cmp_utf16, js_number_to_string};
use simforge_core::math::{js_round, tan};

use super::error::{PlanError, PlanResult};
use super::jsjson::JsValue;
use super::ktx2::{self, js_log2, u32le};
use super::map_closure::{MemberSource, MASTER_PATH};

pub const MANIFEST: &str = "derived/texture-density/manifest.json";
const SCHEMA: &str = "simforge.map-texture-density.v1";
pub const PLAN_SCHEMA: &str = "simforge.texture-residency-plan.v1";
/// The most negative mip bias any view samples with (TAA's `MipBias(-1)`).
pub const MIN_MIP_BIAS: f64 = -1.0;

/// One image of the derivative: `uses` are `[minX, minZ, maxX, maxZ, density]`.
#[derive(Debug, Clone, PartialEq)]
pub struct DensityImage {
    pub uri: String,
    pub width: u32,
    pub height: u32,
    pub uses: Vec<[f64; 5]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DensityPlan {
    pub manifest_sha256: String,
    pub build_key: String,
    pub images: Vec<DensityImage>,
}

fn invalid(detail: impl std::fmt::Display) -> PlanError {
    PlanError::new("native_texture_density_invalid", detail)
}

fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(other) => other.to_string(),
    }
}

fn js_integer(value: Option<&Value>) -> Option<u32> {
    let n = value?.as_f64()?;
    (n.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&n)).then_some(n as u32)
}

/// `planNativeTextureDensity`: `None` when the map carries no derivative
/// (every texture keeps its full chain; the evidence records it). A
/// derivative bound to another master or malformed is an error.
pub fn plan_texture_density(source: &dyn MemberSource) -> PlanResult<Option<DensityPlan>> {
    let Some(manifest_sha256) = source.sha256(MANIFEST).map(str::to_owned) else {
        return Ok(None);
    };
    let manifest: Value = serde_json::from_str(&source.read_text(MANIFEST)?)
        .map_err(|e| invalid(format!("{MANIFEST} is not JSON ({e})")))?;
    if manifest.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err(invalid(format!(
            "schema {} ({SCHEMA})",
            js_text(manifest.get("schema"))
        )));
    }
    let Some(build_key) = manifest.get("buildKey").and_then(Value::as_str) else {
        return Err(invalid("no buildKey"));
    };
    let master = manifest.pointer("/source/master");
    let master_sha = master.and_then(|m| m.get("sha256")).and_then(Value::as_str);
    if master.and_then(|m| m.get("path")).and_then(Value::as_str) != Some(MASTER_PATH)
        || master_sha.is_none()
        || master_sha != source.sha256(MASTER_PATH)
    {
        return Err(PlanError::new(
            "native_texture_density_master_mismatch",
            "the derivative was built from another master.gltf",
        ));
    }
    let Some(listed) = manifest.get("images").and_then(Value::as_array) else {
        return Err(invalid("images"));
    };
    let mut images = Vec::with_capacity(listed.len());
    let mut seen = std::collections::HashSet::new();
    for image in listed {
        let uri = image.get("uri").and_then(Value::as_str);
        let width = js_integer(image.get("width"));
        let height = js_integer(image.get("height"));
        let uses = image.get("uses").and_then(Value::as_array);
        let (Some(uri), Some(width), Some(height), Some(uses)) = (uri, width, height, uses) else {
            return Err(invalid(format!("image {}", js_text(image.get("uri")))));
        };
        if !seen.insert(uri.to_owned()) {
            return Err(invalid(format!("image {uri}")));
        }
        let mut parsed = Vec::with_capacity(uses.len());
        for u in uses {
            let values: Option<Vec<f64>> = u.as_array().filter(|a| a.len() == 5).and_then(|a| {
                a.iter()
                    .map(|v| v.as_f64().filter(|f| f.is_finite()))
                    .collect()
            });
            match values {
                Some(v) if v[4] >= 0.0 => parsed.push([v[0], v[1], v[2], v[3], v[4]]),
                _ => return Err(invalid(format!("a use of {uri}"))),
            }
        }
        images.push(DensityImage {
            uri: uri.to_owned(),
            width,
            height,
            uses: parsed,
        });
    }
    Ok(Some(DensityPlan {
        manifest_sha256,
        build_key: build_key.to_owned(),
        images,
    }))
}

/// A rendered camera: its eye (scene frame, metres) and its projection.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResidencyCamera {
    pub eye: [f64; 3],
    pub width: u32,
    pub height: u32,
    /// Vertical field of view, degrees.
    pub fov_deg: f64,
}

/// `nativeCornerFocalPx`: focal length in pixels over cos^2 of the corner ray.
pub fn corner_focal_px(camera: &ResidencyCamera) -> f64 {
    let tan_y = tan((camera.fov_deg * std::f64::consts::PI) / 360.0);
    let tan_x = (tan_y * f64::from(camera.width)) / f64::from(camera.height);
    let focal = f64::from(camera.height) / 2.0 / tan_y;
    focal * (1.0 + tan_x * tan_x + tan_y * tan_y)
}

/// `nativeTextureResidencyLevels`: the finest mip level each image can be
/// sampled at by any camera of any frame (0: the full chain). An image no
/// camera bounds (no frames) is absent. Pure and deterministic.
pub fn texture_residency_levels(
    images: &[DensityImage],
    frames: &[Vec<ResidencyCamera>],
    near_m: f64,
) -> PlanResult<BTreeMap<String, u32>> {
    if near_m.is_nan() || near_m <= 0.0 {
        return Err(PlanError::new(
            "native_texture_residency_invalid",
            format!("near plane {}", js_number_to_string(near_m)),
        ));
    }
    // Distinct horizontal positions (cm grid) per corner focal length.
    let mut rigs: Vec<(f64, Vec<(f64, f64)>)> = Vec::new();
    for camera in frames.iter().flatten() {
        let focal = corner_focal_px(camera);
        if !focal.is_finite() || focal <= 0.0 {
            return Err(PlanError::new(
                "native_texture_residency_invalid",
                format!(
                    "camera {}x{} fov {}",
                    camera.width,
                    camera.height,
                    js_number_to_string(camera.fov_deg)
                ),
            ));
        }
        let x = js_round(camera.eye[0] * 100.0) / 100.0;
        let z = js_round(camera.eye[2] * 100.0) / 100.0;
        let slot = match rigs.iter().position(|(f, _)| *f == focal) {
            Some(i) => i,
            None => {
                rigs.push((focal, Vec::new()));
                rigs.len() - 1
            }
        };
        let positions = &mut rigs[slot].1;
        if !positions.iter().any(|&(px, pz)| px == x && pz == z) {
            positions.push((x, z));
        }
    }
    let mut levels = BTreeMap::new();
    for image in images {
        let mut lowest = f64::INFINITY;
        'uses: for &[min_x, min_z, max_x, max_z, density] in &image.uses {
            if density == 0.0 {
                lowest = 0.0;
                break;
            }
            for (focal, positions) in &rigs {
                let mut nearest = f64::INFINITY;
                for &(px, pz) in positions {
                    let dx = 0f64.max(min_x - px).max(px - max_x);
                    let dz = 0f64.max(min_z - pz).max(pz - max_z);
                    let d = dx * dx + dz * dz;
                    if d < nearest {
                        nearest = d;
                    }
                }
                let texels_per_pixel = (density * near_m.max(nearest.sqrt())) / focal;
                if texels_per_pixel < lowest {
                    lowest = texels_per_pixel;
                }
            }
            if lowest == 0.0 {
                break 'uses;
            }
        }
        if !lowest.is_finite() {
            continue; // no camera: nothing to bound
        }
        let finest = if lowest > 0.0 {
            (js_log2(lowest) + MIN_MIP_BIAS).floor()
        } else {
            0.0
        };
        levels.insert(image.uri.clone(), finest.max(0.0) as u32);
    }
    Ok(levels)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanImage {
    pub uri: String,
    pub drop_levels: u32,
}

/// The service's plan (`simforge.texture-residency-plan.v1`), written to a
/// file the scene spec's `textureResidency` names.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidencyPlanDoc {
    pub schema: &'static str,
    pub plan_sha256: String,
    pub images: Vec<PlanImage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Residency {
    pub plan: ResidencyPlanDoc,
    /// Device bytes of the staged textures with their full chains, and as planned.
    pub full_texture_bytes: u64,
    pub resident_texture_bytes: u64,
    /// Planned textures by levels dropped, 0..7 (7: seven or more).
    pub levels_dropped: [u64; 8],
}

impl Residency {
    /// The plan file's bytes (`JSON.stringify(plan, null, 2)`, as the worker's `writeJson`).
    pub fn plan_json(&self) -> String {
        serde_json::to_string_pretty(&self.plan).expect("plan serializes") + "\n"
    }
}

/// Device bytes of a KTX2's levels from `first` down.
fn level_bytes_from(header: &[u8], first: u32) -> u64 {
    let format = u32le(header, 12);
    let levels = u32le(header, 40).max(1);
    let (w, h) = (u32le(header, 20), u32le(header, 24));
    (first..levels)
        .map(|level| {
            ktx2::level_bytes(
                format,
                ktx2::shr(w, level).max(1),
                ktx2::shr(h, level).max(1),
            )
        })
        .sum()
}

fn image_uris(master: &Path) -> PlanResult<Vec<Option<String>>> {
    let text = std::fs::read_to_string(master).map_err(|e| {
        PlanError::new(
            "native_texture_residency_invalid",
            format!("{}: {e}", master.display()),
        )
    })?;
    let doc: Value = serde_json::from_str(&text).map_err(|e| {
        PlanError::new(
            "native_texture_residency_invalid",
            format!("{}: {e}", master.display()),
        )
    })?;
    Ok(doc
        .get("images")
        .and_then(Value::as_array)
        .map(|images| {
            images
                .iter()
                .map(|i| i.get("uri").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
}

/// `nativeTextureResidencyPlan`: the plan for a staged tree. The staged
/// master names each image by the file it uploads, the closure's master by
/// the source uri the derivative keys on; images correspond by index.
pub fn texture_residency_plan(
    closure_master: &Path,
    staged_master: &Path,
    levels: &BTreeMap<String, u32>,
    density: &DensityPlan,
) -> PlanResult<Residency> {
    let source = image_uris(closure_master)?;
    let staged = image_uris(staged_master)?;
    let directory = staged_master
        .parent()
        .expect("a staged master lives in its tree");
    let mut images: Vec<PlanImage> = Vec::new();
    let mut levels_dropped = [0u64; 8];
    let (mut full, mut resident) = (0u64, 0u64);
    let mut counted = std::collections::HashSet::new();
    for (index, uri) in source.iter().enumerate() {
        let Some(finest) = uri.as_ref().and_then(|u| levels.get(u)).copied() else {
            continue;
        };
        let Some(staged_uri) = staged
            .get(index)
            .cloned()
            .flatten()
            .filter(|u| !u.is_empty())
        else {
            continue;
        };
        if !counted.insert(staged_uri.clone()) {
            continue;
        }
        let path = staged_uri
            .split('/')
            .fold(directory.to_path_buf(), |p, part| p.join(part));
        let header = ktx2::read_header(&path, 48).map_err(|e| {
            PlanError::new(
                "native_texture_residency_invalid",
                format!("{staged_uri}: {e}"),
            )
        })?;
        if header[..12] != ktx2::MAGIC {
            return Err(PlanError::new(
                "native_texture_residency_invalid",
                format!("{staged_uri} is not KTX2"),
            ));
        }
        let uri = uri.as_ref().expect("levels matched a uri");
        let expected = density
            .images
            .iter()
            .find(|i| &i.uri == uri)
            .ok_or_else(|| {
                PlanError::new(
                    "native_texture_residency_invalid",
                    format!("{uri} has no density entry"),
                )
            })?;
        let chain = u32le(&header, 40).max(1);
        let (width, height, format) = (u32le(&header, 20), u32le(&header, 24), u32le(&header, 12));
        if width != expected.width || height != expected.height {
            return Err(PlanError::new(
                "native_texture_residency_dims_mismatch",
                format!(
                    "{staged_uri} is {width}x{height}, the density derivative says {}x{}",
                    expected.width, expected.height
                ),
            ));
        }
        // A block-compressed base must be whole 4x4 blocks: keep the finest level that is.
        let mut drop = finest.min(chain - 1);
        if !ktx2::is_rgba8(format) {
            while drop > 0 && (ktx2::shr(width, drop) % 4 != 0 || ktx2::shr(height, drop) % 4 != 0)
            {
                drop -= 1;
            }
        }
        full += level_bytes_from(&header, 0);
        resident += level_bytes_from(&header, drop);
        levels_dropped[drop.min(7) as usize] += 1;
        if drop > 0 {
            images.push(PlanImage {
                uri: staged_uri,
                drop_levels: drop,
            });
        }
    }
    images.sort_by(|a, b| cmp_utf16(&a.uri, &b.uri));
    let preimage = JsValue::Array(vec![
        density.manifest_sha256.as_str().into(),
        JsValue::Array(
            images
                .iter()
                .map(|i| {
                    JsValue::Object(vec![
                        ("uri".to_owned(), i.uri.as_str().into()),
                        (
                            "dropLevels".to_owned(),
                            JsValue::Number(f64::from(i.drop_levels)),
                        ),
                    ])
                })
                .collect(),
        ),
    ]);
    let plan_sha256 = super::map_closure::sha256_hex(preimage.stringify().as_bytes());
    Ok(Residency {
        plan: ResidencyPlanDoc {
            schema: PLAN_SCHEMA,
            plan_sha256,
            images,
        },
        full_texture_bytes: full,
        resident_texture_bytes: resident,
        levels_dropped,
    })
}

#[cfg(test)]
mod tests {
    //! Ported from `texture-residency.test.ts`.
    use super::*;
    use crate::render::testing::FakeSource;
    use serde_json::json;

    const MASTER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn image(uri: &str, uses: Vec<[f64; 5]>) -> DensityImage {
        DensityImage {
            uri: uri.to_owned(),
            width: 2048,
            height: 2048,
            uses,
        }
    }

    fn vfov() -> f64 {
        // 1920x1080 at a 90 degree horizontal field of view (same float ops as the TS test).
        let pi = std::f64::consts::PI;
        (2.0 * simforge_core::math::atan(tan(pi / 4.0) * 1080.0 / 1920.0) * 180.0) / pi
    }

    fn camera(x: f64, z: f64) -> ResidencyCamera {
        ResidencyCamera {
            eye: [x, 1.5, z],
            width: 1920,
            height: 1080,
            fov_deg: vfov(),
        }
    }

    #[test]
    fn bounds_the_pixel_footprint_by_the_corner_ray() {
        let (tan_x, tan_y) = (1.0, 1080.0 / 1920.0);
        let expected: f64 = 960.0 * (1.0 + tan_x * tan_x + tan_y * tan_y);
        assert!((corner_focal_px(&camera(0.0, 0.0)) - expected).abs() < 1e-6);
    }

    #[test]
    fn keeps_the_levels_the_closest_approach_can_sample_with_the_taa_bias() {
        let focal = corner_focal_px(&camera(0.0, 0.0));
        let far = image("images/far.ktx2", vec![[400.0, -5.0, 410.0, 5.0, 512.0]]);
        let levels =
            texture_residency_levels(std::slice::from_ref(&far), &[vec![camera(0.0, 0.0)]], 0.1)
                .unwrap();
        assert_eq!(
            levels["images/far.ktx2"],
            (js_log2((512.0 * 400.0) / focal) + MIN_MIP_BIAS).floor() as u32
        );
        let inside = texture_residency_levels(
            &[far],
            &[vec![camera(0.0, 0.0)], vec![camera(405.0, 0.0)]],
            0.1,
        )
        .unwrap();
        assert_eq!(inside["images/far.ktx2"], 0);
    }

    #[test]
    fn keeps_every_level_of_an_image_a_triangle_samples_at_one_texel() {
        let constant = image(
            "images/constant.ktx2",
            vec![
                [1e5, 1e5, 1e5 + 1.0, 1e5 + 1.0, 1000.0],
                [0.0, 0.0, 1.0, 1.0, 0.0],
            ],
        );
        assert_eq!(
            texture_residency_levels(&[constant], &[vec![camera(0.0, 0.0)]], 0.1).unwrap()
                ["images/constant.ktx2"],
            0
        );
    }

    #[test]
    fn is_a_function_of_the_poses_not_their_order_or_duplicates() {
        let images = [
            image("images/a.ktx2", vec![[50.0, 50.0, 60.0, 60.0, 256.0]]),
            image("images/b.ktx2", vec![[-300.0, 0.0, -290.0, 20.0, 1024.0]]),
        ];
        let frames = vec![
            vec![camera(0.0, 0.0)],
            vec![camera(10.0, 5.0)],
            vec![camera(20.0, 10.0)],
        ];
        let mut doubled: Vec<_> = frames.iter().rev().cloned().collect();
        doubled.extend(frames.iter().cloned());
        assert_eq!(
            texture_residency_levels(&images, &frames, 0.1).unwrap(),
            texture_residency_levels(&images, &doubled, 0.1).unwrap()
        );
        assert_eq!(
            texture_residency_levels(&images, &frames, 0.0)
                .unwrap_err()
                .message,
            "native_texture_residency_invalid: near plane 0"
        );
    }

    fn manifest(images: Value) -> Value {
        json!({
            "schema": SCHEMA, "buildKey": "b".repeat(64), "cellM": 64,
            "source": { "master": { "path": "master.gltf", "sha256": MASTER } },
            "builder": { "revision": 1, "fingerprint": "f" }, "images": images,
        })
    }

    fn source(manifest: Option<&Value>, master: &str) -> FakeSource {
        let s = FakeSource::default().file("master.gltf", master, "{}");
        match manifest {
            Some(m) => s.file(MANIFEST, &"c".repeat(64), &m.to_string()),
            None => s,
        }
    }

    #[test]
    fn reads_the_derivative_and_refuses_one_built_from_another_master() {
        let good = manifest(
            json!([{ "uri": "images/a.ktx2", "width": 2048, "height": 2048, "uses": [[0, 0, 10, 10, 512]] }]),
        );
        assert_eq!(plan_texture_density(&source(None, MASTER)).unwrap(), None);
        let plan = plan_texture_density(&source(Some(&good), MASTER))
            .unwrap()
            .unwrap();
        assert_eq!(
            (plan.manifest_sha256.as_str(), plan.build_key.len()),
            ("c".repeat(64).as_str(), 64)
        );
        assert_eq!(plan.images[0].uses, vec![[0.0, 0.0, 10.0, 10.0, 512.0]]);
        assert_eq!(
            plan_texture_density(&source(Some(&good), &"d".repeat(64)))
                .unwrap_err()
                .code,
            "native_texture_density_master_mismatch"
        );
        let negative = manifest(
            json!([{ "uri": "images/a.ktx2", "width": 2048, "height": 2048, "uses": [[0, 0, 1, 1, -1]] }]),
        );
        assert_eq!(
            plan_texture_density(&source(Some(&negative), MASTER))
                .unwrap_err()
                .code,
            "native_texture_density_invalid"
        );
    }

    fn ktx(width: u32, height: u32, levels: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 80];
        bytes[..12].copy_from_slice(&ktx2::MAGIC);
        bytes[12..16].copy_from_slice(&145u32.to_le_bytes());
        bytes[20..24].copy_from_slice(&width.to_le_bytes());
        bytes[24..28].copy_from_slice(&height.to_le_bytes());
        bytes[40..44].copy_from_slice(&levels.to_le_bytes());
        bytes
    }

    #[test]
    fn plans_the_staged_files_by_source_uri_and_counts_the_bytes_each_keeps() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        std::fs::create_dir_all(staged.join("objects")).unwrap();
        std::fs::write(staged.join("objects/a.ktx2"), ktx(16, 16, 5)).unwrap();
        std::fs::write(staged.join("objects/b.ktx2"), ktx(16, 16, 5)).unwrap();
        std::fs::write(
            dir.path().join("master.gltf"),
            r#"{"images":[{"uri":"images/a.ktx2"},{"uri":"images/b.ktx2"}]}"#,
        )
        .unwrap();
        std::fs::write(
            staged.join("master.gltf"),
            r#"{"images":[{"uri":"objects/a.ktx2"},{"uri":"objects/b.ktx2"}]}"#,
        )
        .unwrap();
        let density = DensityPlan {
            manifest_sha256: "c".repeat(64),
            build_key: "b".repeat(64),
            images: ["images/a.ktx2", "images/b.ktx2"]
                .iter()
                .map(|u| DensityImage {
                    uri: (*u).to_owned(),
                    width: 16,
                    height: 16,
                    uses: vec![],
                })
                .collect(),
        };
        let run = |levels: &[(&str, u32)], density: &DensityPlan| {
            let levels = levels.iter().map(|(u, l)| ((*u).to_owned(), *l)).collect();
            texture_residency_plan(
                &dir.path().join("master.gltf"),
                &staged.join("master.gltf"),
                &levels,
                density,
            )
        };
        let residency = run(&[("images/a.ktx2", 2), ("images/b.ktx2", 0)], &density).unwrap();
        let clamped = run(&[("images/a.ktx2", 9)], &density).unwrap();
        assert_eq!(
            clamped.plan.images,
            vec![PlanImage {
                uri: "objects/a.ktx2".into(),
                drop_levels: 2
            }]
        );
        assert_eq!(residency.plan.schema, PLAN_SCHEMA);
        assert_eq!(
            residency.plan.images,
            vec![PlanImage {
                uri: "objects/a.ktx2".into(),
                drop_levels: 2
            }]
        );
        assert_eq!(residency.full_texture_bytes, 2 * 368);
        assert_eq!(residency.resident_texture_bytes, 48 + 368);
        assert_eq!(residency.levels_dropped, [1, 0, 1, 0, 0, 0, 0, 0]);
        let mut wide = density.clone();
        wide.images[0].width = 32;
        assert_eq!(
            run(&[("images/a.ktx2", 2)], &wide).unwrap_err().code,
            "native_texture_residency_dims_mismatch"
        );
    }
}
