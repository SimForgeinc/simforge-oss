//! Road decal layers from the map's `derived/road-decals` derivative
//! (schema `simforge.map-road-decals.v1`, built at ingest by
//! `@simforge-oss/map-pipeline` `buildRoadDecals`).
//!
//! RoadRunner exports wear decals (oil paths, oil stains, linear cracks) as
//! alpha-blended layers (`..._Road_Layer1..N`, `..._Marking_Layer1..N`,
//! `..._Terrain_..._Layer1..N`) drawn over the road surface. Composited at
//! their authored opacity as plain albedo, the stretched oil paths read as
//! dark streaks down every lane; Unreal (CARLA) blends the same layers far
//! more faintly. The derivative names those materials and carries one
//! calibrated opacity scale; the renderer multiplies each listed material's
//! base-colour alpha by it when the scene is finalized.
use anyhow::{Context, Result};
use std::collections::HashSet;

pub const SCHEMA: &str = "simforge.map-road-decals.v1";

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestMaterial {
    /// glTF material index in the master.
    pub index: u32,
    /// glTF material name (what the renderer matches).
    pub name: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: String,
    /// Multiplier on every listed material's base-colour alpha, in [0, 1].
    pub opacity_scale: f32,
    pub materials: Vec<ManifestMaterial>,
}

impl Manifest {
    pub fn load(path: &std::path::Path) -> Result<Self> {
        let manifest: Manifest = serde_json::from_slice(
            &std::fs::read(path)
                .with_context(|| format!("read road decal manifest {}", path.display()))?,
        )
        .with_context(|| format!("parse road decal manifest {}", path.display()))?;
        anyhow::ensure!(
            manifest.schema == SCHEMA,
            "road decal manifest {} has schema {:?}, expected {SCHEMA}",
            path.display(),
            manifest.schema
        );
        anyhow::ensure!(
            (0.0..=1.0).contains(&manifest.opacity_scale),
            "road decal manifest {}: opacityScale {} is outside [0, 1]",
            path.display(),
            manifest.opacity_scale
        );
        Ok(manifest)
    }

    pub fn names(&self) -> HashSet<String> {
        self.materials.iter().map(|m| m.name.clone()).collect()
    }
}
