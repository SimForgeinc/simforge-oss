//! Catalog vehicle GLB resolution — consumes the CarlaVehicles model
//! convention (catalog/vehicles-carla): per-catalog-id `model` assignments
//! `{glbPath, attribution, source}` plus the `tintable` / `scaleToDims`
//! sidecar extras, GLBs in the y-up/+X-forward/ground-origin actor frame
//! with `body`/`wheel_*` nodes and a neutral `body_paint` material slot
//! (see catalog/vehicles-carla/CONVENTIONS.md).
//!
//! Resolution order for a models directory:
//! 1. `catalog-models.json` — the precomputed catalog-id -> model sidecar.
//! 2. `manifest.json` — per-GLB metadata; ids are mapped through a built-in
//!    catalog-id -> manifest-key table (same assignments the sidecar ships).
//!
//! Ids without a model keep the procedural primitive path in `catalog.rs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// One resolvable vehicle model, in the vehicles-carla convention.
#[derive(Debug, Clone)]
pub struct VehicleModelEntry {
    /// Absolute path to the self-contained GLB.
    pub glb_path: PathBuf,
    /// CC BY attribution line (carried through to run reports).
    pub attribution: String,
    /// Asset provenance tag (e.g. `carla-0.10.0-ue5`).
    pub source: String,
    /// Whether the `body_paint` material may receive the authored tint.
    pub tintable: bool,
    /// Uniform-scale the GLB so its length matches the actor dims.
    pub scale_to_dims: bool,
    /// Authored model length in metres (manifest `dims_lwh_m[0]`), the
    /// denominator for `scale_to_dims`.
    pub model_length_m: Option<f64>,
    /// Manifest-authored uniform scale for raw asset-space geometry.
    pub uniform_scale: Option<f32>,
    /// Model-space yaw correction in radians (+Y).
    pub yaw_offset_rad: f32,
    /// Grounding offset added to the actor's authored Y coordinate.
    pub ground_offset_m: f32,
    /// Motion-state animation GLBs and their named clips.
    pub animations: HashMap<String, (PathBuf, String)>,
}

/// Catalog-id keyed model table. The sorted fallback list supports stable
/// per-actor assignment for generic pedestrian catalog ids.
#[derive(Debug, Default, Clone)]
pub struct VehicleModelCatalog {
    by_catalog_id: HashMap<String, VehicleModelEntry>,
    fallback: Vec<(String, VehicleModelEntry)>,
}

// Shared editorial assignments also generate the browser bindings and the
// sidecar; the sidecar is the only runtime source (see `load`).
mod assignments {
    #![allow(dead_code)]
    include!("vehicle_assignments.generated.rs");
}

impl VehicleModelCatalog {
    /// Load the model table from a catalog directory's `catalog-models.json`.
    ///
    /// Strict: a malformed entry is an error naming it, never a silently
    /// skipped id (which would later render as something else). The
    /// optional `manifest.json` beside it supplies model lengths; if present
    /// it must parse.
    pub fn load(dir: &Path) -> Result<Self> {
        let sidecar = dir.join("catalog-models.json");
        if !sidecar.is_file() {
            bail!("actor model catalog {} has no catalog-models.json", dir.display());
        }
        Self::from_sidecar(dir, &sidecar)
    }

    pub fn resolve(&self, catalog_id: &str) -> Option<&VehicleModelEntry> {
        self.by_catalog_id.get(catalog_id)
    }

    /// Select one entry deterministically for an actor whose generic catalog id
    /// has no exact blueprint model. Uses a process-independent FNV-1a hash.
    /// Only for callers that record the substitution (scen-play's
    /// `actor-visuals.json`); the render service never substitutes.
    pub fn resolve_deterministic(&self, actor_id: &str) -> Option<(&str, &VehicleModelEntry)> {
        if self.fallback.is_empty() {
            return None;
        }
        let hash = actor_id
            .bytes()
            .fold(0xcbf29ce484222325_u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
            });
        let (catalog_id, entry) = &self.fallback[hash as usize % self.fallback.len()];
        Some((catalog_id.as_str(), entry))
    }

    pub fn is_empty(&self) -> bool {
        self.by_catalog_id.is_empty()
    }

    pub fn len(&self) -> usize {
        self.by_catalog_id.len()
    }

    /// `catalog-models.json`: `{ "<catalogId>": { "model": {glbPath,
    /// attribution, source, clips?}, "tintable", "scaleToDims",
    /// "animations"? }, ... }`, optionally under a top-level
    /// `"models"`/`"entries"`/`"vehicles"` wrapper. Keys without a dot are
    /// wrapper metadata (`version`).
    ///
    /// Animation clips come from `animations` (`{<motion>: {glbPath, clip}}`,
    /// separate animation GLBs) or `model.clips` (`{idle, locomotion}` clips
    /// inside the model GLB, bound as `idle` / `walk`). An entry marked
    /// `model.animated` without either is an error: it would render frozen.
    fn from_sidecar(dir: &Path, path: &Path) -> Result<Self> {
        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("read {}", path.display()))?,
        )
        .with_context(|| format!("parse {}", path.display()))?;
        let map = ["models", "entries", "vehicles"]
            .iter()
            .find_map(|k| raw.get(*k).and_then(|v| v.as_object()))
            .or_else(|| raw.as_object())
            .context("catalog-models.json: expected an object")?;

        // Model lengths come from the manifest when it is available.
        let lengths = manifest_lengths(&dir.join("manifest.json"))?;

        let mut by_catalog_id = HashMap::new();
        for (catalog_id, value) in map {
            if !catalog_id.contains('.') {
                continue; // wrapper metadata like "version"
            }
            let entry = || format!("{}: entry {catalog_id}", path.display());
            let value = value.as_object().with_context(|| format!("{} is not an object", entry()))?;
            let model = match value.get("model") {
                Some(model) => model.as_object().with_context(|| format!("{} model is not an object", entry()))?,
                None => value,
            };
            let glb = model
                .get("glbPath")
                .and_then(|v| v.as_str())
                .with_context(|| format!("{} has no model.glbPath", entry()))?;
            let glb_path = resolve_glb_path(dir, glb);
            let file_stem = glb_path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .with_context(|| format!("{} glbPath {glb:?} has no file name", entry()))?;
            let bool_field = |key: &str| -> Result<bool> {
                value
                    .get(key)
                    .map(|v| v.as_bool().with_context(|| format!("{} {key} is not a boolean", entry())))
                    .transpose()?
                    .with_context(|| format!("{} does not declare {key}", entry()))
            };
            let number_field = |key: &str| -> Result<Option<f64>> {
                value
                    .get(key)
                    .map(|v| v.as_f64().filter(|v| v.is_finite()).with_context(|| format!("{} {key} is not a finite number", entry())))
                    .transpose()
            };
            let mut animations = HashMap::new();
            if let Some(table) = value.get("animations") {
                let table = table.as_object().with_context(|| format!("{} animations is not an object", entry()))?;
                for (name, animation) in table {
                    let path = animation
                        .get("glbPath")
                        .and_then(|v| v.as_str())
                        .with_context(|| format!("{} animation {name} has no glbPath", entry()))?;
                    let clip = animation
                        .get("clip")
                        .and_then(|v| v.as_str())
                        .with_context(|| format!("{} animation {name} has no clip", entry()))?;
                    animations.insert(name.clone(), (resolve_glb_path(dir, path), clip.to_string()));
                }
            }
            if let Some(clips) = model.get("clips") {
                let clips = clips.as_object().with_context(|| format!("{} model.clips is not an object", entry()))?;
                for (key, motion) in [("idle", "idle"), ("locomotion", "walk")] {
                    if let Some(clip) = clips.get(key) {
                        let clip = clip.as_str().with_context(|| format!("{} model.clips.{key} is not a string", entry()))?;
                        if animations.insert(motion.to_string(), (glb_path.clone(), clip.to_string())).is_some() {
                            bail!("{} binds the {motion} clip twice (animations and model.clips)", entry());
                        }
                    }
                }
                if let Some(unknown) = clips.keys().find(|key| !matches!(key.as_str(), "idle" | "locomotion")) {
                    bail!("{} model.clips.{unknown} is not a known motion (idle, locomotion)", entry());
                }
            }
            if model.get("animated").and_then(|v| v.as_bool()) == Some(true) && animations.is_empty() {
                bail!("{} is animated but binds no animation clips", entry());
            }
            by_catalog_id.insert(
                catalog_id.clone(),
                VehicleModelEntry {
                    glb_path,
                    attribution: model
                        .get("attribution")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    source: model
                        .get("source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    tintable: bool_field("tintable")?,
                    scale_to_dims: bool_field("scaleToDims")?,
                    model_length_m: lengths.get(&file_stem).copied(),
                    uniform_scale: number_field("uniformScale")?.map(|v| v as f32),
                    yaw_offset_rad: number_field("yawOffsetRad")?.unwrap_or(0.0) as f32,
                    ground_offset_m: number_field("groundOffsetM")?.unwrap_or(0.0) as f32,
                    animations,
                },
            );
        }
        let mut fallback: Vec<_> = by_catalog_id
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect();
        fallback.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(Self {
            by_catalog_id,
            fallback,
        })
    }
}

/// GLB path resolution: absolute as-is; else relative to the models dir;
/// else (sidecar paths are repo-root-relative like
/// `catalog/vehicles-carla/models/x.glb`) strip the leading components that
/// duplicate the models dir name.
fn resolve_glb_path(dir: &Path, glb: &str) -> PathBuf {
    let p = Path::new(glb);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    let local = dir.join(p);
    if local.is_file() {
        return local;
    }
    // Repo-root-relative: keep everything after the models dir's own name.
    if let Some(dir_name) = dir.file_name().and_then(|n| n.to_str()) {
        if let Some(idx) = glb.find(&format!("{dir_name}/")) {
            let tail = &glb[idx + dir_name.len() + 1..];
            let candidate = dir.join(tail);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    local
}

/// Model lengths (`dims_lwh_m[0]`) keyed by GLB stem from an optional
/// `manifest.json`. Absent is fine (no length-scaled entries can then
/// resolve a scale, which the renderer reports); present but unreadable is
/// an error, not an empty table.
fn manifest_lengths(manifest: &Path) -> Result<HashMap<String, f64>> {
    let mut out = HashMap::new();
    if !manifest.is_file() {
        return Ok(out);
    }
    let bytes = std::fs::read(manifest).with_context(|| format!("read {}", manifest.display()))?;
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", manifest.display()))?;
    if let Some(vehicles) = raw.get("vehicles").and_then(|v| v.as_object()) {
        for (key, entry) in vehicles {
            if let Some(l) = entry
                .get("dims_lwh_m")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_f64())
            {
                out.insert(key.clone(), l);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::VehicleModelCatalog;
    use std::fs;

    #[test]
    fn meshy_sidecar_resolves_scale_grounding_yaw_and_animation() {
        let root = std::env::temp_dir().join(format!("simforge-actor-catalog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("models/vehicle.sedan/animations")).unwrap();
        fs::write(root.join("models/vehicle.sedan/model.glb"), b"glb").unwrap();
        fs::write(root.join("models/vehicle.sedan/animations/walk.glb"), b"glb").unwrap();
        fs::write(
            root.join("catalog-models.json"),
            r#"{
              "vehicle.sedan": {
                "model": {"glbPath":"models/vehicle.sedan/model.glb","source":"meshy"},
                "tintable":false,
                "scaleToDims":false,
                "uniformScale":2.5,
                "yawOffsetRad":1.5707964,
                "groundOffsetM":0.72,
                "animations":{"walk":{"glbPath":"models/vehicle.sedan/animations/walk.glb","clip":"Walk"}}
              }
            }"#,
        )
        .unwrap();

        let catalog = VehicleModelCatalog::load(&root).unwrap();
        let entry = catalog.resolve("vehicle.sedan").unwrap();
        assert_eq!(entry.uniform_scale, Some(2.5));
        assert!((entry.yaw_offset_rad - std::f32::consts::FRAC_PI_2).abs() < 1e-6);
        assert_eq!(entry.ground_offset_m, 0.72);
        assert_eq!(
            entry.animations.get("walk").map(|(_, clip)| clip.as_str()),
            Some("Walk")
        );
        assert!(catalog.resolve("vehicle.unmapped").is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
