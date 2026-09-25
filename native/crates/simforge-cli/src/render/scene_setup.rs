//! Scene assembly shared by `simforge render` (offline job) and
//! `simforge env serve` (closed-loop episodes): the installed native map and
//! its closure, the derivative plans, the staged texture tier, the actor
//! closure bound to the scene's actors and sensor hosts, the lighting at the
//! map's site with its luminaires, and the render service's scene spec.
//!
//! One assembly for both paths, the platform worker's native engine
//! (packages/render/src/native/engine.ts) step for step: a closed-loop
//! episode renders the same scene an offline job of the same workspace does.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::contract::CliError;
use crate::installed_maps::{self, InstalledMap, XODR};
use crate::paths;
use crate::render::actor_assets::{self, ActorAppearance, VerifiedActorAssets};
use crate::render::derivatives;
use crate::render::geometry_lod::{plan_geometry_lod, GeometryLodMode, GeometryLodPlan};
use crate::render::lighting;
use crate::render::luminaires::{self, LuminairesPlan};
use crate::render::map_closure::{MapClosure, MemberSource};
use crate::render::residency::{self, DensityPlan};
use crate::render::rig::{RenderSource, SensorHost};
use crate::render::road_decals::{plan_road_decals, RoadDecalsPlan};
use crate::render::textures::{stage_texture_profile, StageInput, TextureProfile, TextureTier};
use crate::workspace::Workspace;

/// `{code, message}` warnings a render or episode records instead of
/// substituting silently.
#[derive(Debug, Default, Clone)]
pub struct Warnings(pub Vec<Value>);

impl Warnings {
    pub fn push(&mut self, code: &str, message: impl Into<String>) {
        self.0
            .push(json!({ "code": code, "message": message.into() }));
    }
    pub fn extend_values(&mut self, values: impl IntoIterator<Item = Value>) {
        self.0.extend(values);
    }
}

/// The native (`.corpus`) install of the map the scenario was simulated on
/// (found by its OpenDRIVE digest), or `--map-dir` checked against it.
pub fn native_map(
    xodr_sha256: &str,
    map_id: &str,
    map_dir: Option<&Path>,
    cache_root: Option<&Path>,
) -> Result<InstalledMap, CliError> {
    if let Some(dir) = map_dir {
        let map =
            installed_maps::describe(&paths::absolutize(dir), "explicit").ok_or_else(|| {
                CliError::new("map_not_found", format!("{} has no {XODR}", dir.display()))
            })?;
        if map.xodr_sha256 != xodr_sha256 {
            return Err(CliError::findings(
                "map_mismatch",
                format!(
                    "{} holds an OpenDRIVE with sha256 {}, but the scenario was simulated on {xodr_sha256}",
                    dir.display(),
                    map.xodr_sha256
                ),
            ));
        }
        return Ok(map);
    }
    let root = paths::maps_root(cache_root)?;
    let installed = installed_maps::list(&root.value);
    installed
        .iter()
        .filter(|m| m.profile == ".corpus" && m.xodr_sha256 == xodr_sha256)
        .min_by_key(|m| m.name != map_id)
        .cloned()
        .ok_or_else(|| {
            CliError::new(
                "map_not_installed",
                format!(
                    "no native map install (.corpus/) has an OpenDRIVE with sha256 {xodr_sha256}"
                ),
            )
            .with_detail(json!({
                "xodrSha256": xodr_sha256,
                "mapId": map_id,
                "mapsRoot": root.value,
                "hint": format!("`simforge maps pull {map_id}@<version>` installs the native profile"),
            }))
        })
}

/// The map's closure (from its install receipt, else hashed in place, which
/// is recorded) with the derivatives `tier` reads checked as delivered.
pub fn open_closure(
    map: &InstalledMap,
    tier: TextureTier,
    warnings: &mut Warnings,
) -> Result<MapClosure, CliError> {
    let closure = if map.dir.join(".map-release.json").is_file() {
        MapClosure::open(&map.dir).map_err(|e| e.into_cli())?
    } else {
        warnings.push(
            "map_receipt_absent",
            format!(
                "{} has no .map-release.json; its members were hashed in place",
                map.dir.display()
            ),
        );
        MapClosure::hash_directory(&map.dir).map_err(|e| e.into_cli())?
    };
    derivatives::assert_closure_derivatives(tier, &closure).map_err(|e| e.into_cli())?;
    Ok(closure)
}

/// The map's OpenDRIVE text.
pub fn xodr_text(map: &InstalledMap) -> Result<String, CliError> {
    std::fs::read_to_string(map.file(XODR)).map_err(|e| {
        CliError::new(
            "missing_file",
            format!("cannot read {}: {e}", map.file(XODR).display()),
        )
    })
}

/// The derivative plans of one map closure.
pub struct Derivatives {
    pub geometry_lod: Option<GeometryLodPlan>,
    pub road_decals: Option<RoadDecalsPlan>,
    pub luminaires: Option<LuminairesPlan>,
    /// The texture-density plan residency is computed from (`uastc-full`
    /// only, and only when the caller can plan residency).
    pub density: Option<DensityPlan>,
}

impl Derivatives {
    /// Members the staged tier must carry besides the textures.
    pub fn extra_members(&self) -> Vec<String> {
        let mut extra = Vec::new();
        extra.extend(self.geometry_lod.iter().flat_map(|p| p.members.clone()));
        extra.extend(self.road_decals.iter().flat_map(|p| p.members.clone()));
        extra.extend(self.luminaires.iter().flat_map(|p| p.members.clone()));
        extra
    }
}

/// Plan geometry LOD, road decals, luminaires and (when `plan_residency`)
/// texture density. A closed-loop episode cannot plan residency (it needs
/// every future camera pose): with `plan_residency` false a density
/// derivative the map carries is recorded as unplanned, never silently
/// ignored.
pub fn plan_derivatives(
    closure: &MapClosure,
    tier: TextureTier,
    plan_residency: bool,
    warnings: &mut Warnings,
) -> Result<Derivatives, CliError> {
    let geometry_lod =
        plan_geometry_lod(GeometryLodMode::Auto, closure).map_err(|e| e.into_cli())?;
    let road_decals = plan_road_decals(closure).map_err(|e| e.into_cli())?;
    let luminaires = luminaires::plan_luminaires(
        |member| closure.sha256(member).map(str::to_owned),
        |member| closure.read_text(member).map_err(|e| e.into_cli()),
    )?;
    let residency_off = derivatives::residency_disabled();
    if let Some(w) = &residency_off {
        warnings.extend_values([w.to_json()]);
    }
    let density = if tier == TextureTier::UastcFull && residency_off.is_none() {
        residency::plan_texture_density(closure).map_err(|e| e.into_cli())?
    } else {
        None
    };
    let density = match density {
        Some(plan) if !plan_residency => {
            warnings.push(
                "texture_residency_unplanned_closed_loop",
                "the map carries a texture-density derivative, but a closed-loop episode has no future camera poses to plan mip residency from: every texture uploads its full mip chain",
            );
            drop(plan);
            None
        }
        other => other,
    };
    Ok(Derivatives {
        geometry_lod,
        road_decals,
        luminaires,
        density,
    })
}

/// Pixels per rendered tick for the texture admission estimate: every RGB
/// camera, plus `sensor_video` (width, height) per lidar/radar source when
/// the caller rasterizes sensor videos.
pub fn frame_pixels(sources: &[RenderSource], sensor_video: Option<(u32, u32)>) -> u64 {
    sources
        .iter()
        .map(|s| match s.rgb() {
            Some(c) => u64::from(c.attributes.width) * u64::from(c.attributes.height),
            None => sensor_video.map_or(0, |(w, h)| u64::from(w) * u64::from(h)),
        })
        .sum()
}

/// Stage the texture tier (with the derivative members) into the native
/// texture cache.
pub fn stage_textures(
    closure: &MapClosure,
    tier: TextureTier,
    frame_pixels: u64,
    budget_bytes: Option<u64>,
    derivatives: &Derivatives,
    warnings: &mut Warnings,
) -> Result<TextureProfile, CliError> {
    let extra = derivatives.extra_members();
    let profile = stage_texture_profile(StageInput {
        closure,
        render_textures: tier,
        frame_pixels,
        budget_bytes,
        device_capacity_bytes: None,
        cache_directory: None,
        extra_members: &extra,
        defer_capacity_check: derivatives.density.is_some(),
    })
    .map_err(|e| e.into_cli())?;
    warnings.extend_values(profile.warnings.iter().map(|w| w.to_json()));
    Ok(profile)
}

/// The actor closure digest: `--actor-closure`, else the workspace's pin.
pub fn actor_closure_digest(ws: &Workspace, explicit: Option<&str>) -> Result<String, CliError> {
    match explicit {
        Some(d) => Ok(d.to_owned()),
        None => ws
            .manifest
            .pointer("/catalog/actorClosureDigest")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                CliError::findings(
                    "workspace_invalid",
                    "the workspace manifest has no catalog.actorClosureDigest; pass --actor-closure",
                )
            }),
    }
}

/// Verify the actor closure and bind it: every actor and sensor host has a
/// model, every animated actor its clips (`states` are scene-state frames).
pub fn bind_actor_assets(
    digest: &str,
    assets_root: Option<&Path>,
    appearances: &[ActorAppearance],
    hosts: &[SensorHost],
    states: &[Value],
) -> Result<VerifiedActorAssets, CliError> {
    let root = paths::assets_root(assets_root)?;
    let assets = actor_assets::ensure_actor_assets(&root.value, digest, None, None)?;
    let asset_hosts: Vec<actor_assets::SensorHost> = hosts
        .iter()
        .map(|h| actor_assets::SensorHost {
            source_id: h.source_id.clone(),
            actor_id: h.actor_id.clone(),
            catalog_asset_id: h.vehicle_asset["catalogAssetId"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        })
        .collect();
    actor_assets::assert_actor_appearance_grounded(
        appearances,
        &asset_hosts,
        digest,
        &assets.models,
    )?;
    actor_assets::assert_actor_animations_bound(appearances, states, digest, &assets.models)?;
    Ok(assets)
}

/// The scenario's lighting at the map's site (the workspace document's
/// authored environment), with the map's luminaires ordered by `eyes`.
/// Returns the scene spec's `lighting` and the resolution provenance.
pub fn scene_lighting(
    ws: &Workspace,
    xodr_text: &str,
    map_id: &str,
    rgb_fps: &[f64],
    luminaires_plan: Option<&LuminairesPlan>,
    eyes: &[[f64; 3]],
    warnings: &mut Warnings,
) -> Result<(Value, Value), CliError> {
    let document: Value =
        serde_json::from_slice(&ws.read_member("document.json")?).map_err(|e| {
            CliError::findings(
                "workspace_invalid",
                format!("document.json is not JSON: {e}"),
            )
        })?;
    let environment = lighting::authored_environment_from_document(&document)?;
    let site = lighting::lighting_site_from_opendrive(xodr_text, map_id)?;
    let look = lighting::resolve_native_lighting(
        &environment,
        &site,
        None,
        Some(lighting::cloud_fixed_step_s(rgb_fps)),
    )?;
    let sun_elev = look.lighting["sun_elev_deg"].as_f64().unwrap_or(90.0);
    let night = sun_elev <= luminaires::LUMINAIRES_ON_ELEVATION_DEG;
    let lighting = match luminaires_plan {
        Some(plan) => {
            let (ordered, observer) = luminaires::order_fixtures(&plan.fixtures, eyes);
            luminaires::with_fixtures(&look.lighting, &ordered, observer)
        }
        None => {
            if night {
                warnings.push(
                    "night_luminaires_absent",
                    format!(
                        "the sun is {sun_elev:.1} deg below the horizon but the map carries no {}: street lights stay dark",
                        luminaires::LUMINAIRES_MANIFEST
                    ),
                );
            }
            look.lighting.clone()
        }
    };
    Ok((lighting, look.provenance))
}

/// Everything the render service's scene spec names.
pub struct SpecInput<'a> {
    pub profile: &'a TextureProfile,
    pub lighting: Value,
    pub near_m: f64,
    pub far_m: f64,
    pub models_dir: &'a Path,
    pub preset: &'a str,
    pub tier: TextureTier,
    pub derivatives: &'a Derivatives,
    pub residency_path: Option<&'a Path>,
    pub ground_mesh: Option<&'a Path>,
}

/// The scene spec (`render_service::server::SceneSpec` wire form), exactly as
/// the platform worker writes `native-service-scene.json`.
pub fn scene_spec(input: &SpecInput<'_>) -> Value {
    let master_dir: PathBuf = input
        .profile
        .master_path
        .parent()
        .expect("the staged master has a directory")
        .to_path_buf();
    let mut render_set = serde_json::Map::new();
    render_set.insert("textures.tier".into(), json!(input.tier.as_str()));
    let mut scene = json!({
        "glbs": [input.profile.master_path],
        "lighting": input.lighting,
        "autoMeter": true,
        "nearM": input.near_m,
        "farM": input.far_m,
        "warmupFrames": 20,
        "vehicleModels": input.models_dir,
        "pedestrianModels": input.models_dir,
        "render": { "preset": input.preset, "set": render_set },
        "textureTier": input.tier.as_str(),
    });
    if input.derivatives.geometry_lod.is_some() {
        scene["geometryLod"] = json!(master_dir.join("derived/geometry-lod/manifest.json"));
    }
    if input.derivatives.road_decals.is_some() {
        scene["roadDecals"] = json!(master_dir.join("derived/road-decals/manifest.json"));
    }
    if let Some(path) = input.residency_path {
        scene["textureResidency"] = json!(path);
    }
    if let Some(path) = input.ground_mesh {
        scene["groundMesh"] = json!(path);
    }
    scene
}

/// Cross-check the installed map against the workspace's map closure
/// (`map/closure.json`, the browser asset set the scenario was made with):
/// every member both list must have the same digest. `None` when the
/// workspace carries no map closure.
pub fn map_drift(ws: &Workspace, closure: &MapClosure) -> Result<Option<Value>, CliError> {
    let path = ws.member("map/closure.json");
    if !path.is_file() {
        return Ok(None);
    }
    let doc: Value = serde_json::from_slice(&ws.read_member("map/closure.json")?).map_err(|e| {
        CliError::findings(
            "workspace_invalid",
            format!("map/closure.json is not JSON: {e}"),
        )
    })?;
    let members = doc["members"].as_array().ok_or_else(|| {
        CliError::findings("workspace_invalid", "map/closure.json has no members list")
    })?;
    let mut shared = 0u64;
    let mut differing = Vec::new();
    for m in members {
        let (Some(rel), Some(sha)) = (m["relativePath"].as_str(), m["sha256"].as_str()) else {
            continue;
        };
        if let Some(installed) = closure.sha256(rel) {
            shared += 1;
            if installed != sha {
                differing.push(json!({ "path": rel, "workspace": sha, "installed": installed }));
            }
        }
    }
    let count = differing.len();
    differing.truncate(20);
    Ok(Some(
        json!({ "shared": shared, "differingCount": count, "differing": differing }),
    ))
}

/// The renderer's sky plates, verified before any staging or GPU work: a
/// render without them fails in the renderer after minutes of setup.
pub fn sky_assets() -> Result<render_core::sky_pass::SkyAssetPaths, CliError> {
    render_core::sky_pass::SkyAssetPaths::resolve().map_err(|e| {
        CliError::new("sky_assets_missing", format!("{e:#}")).with_detail(json!({
            "hint": "set SIMFORGE_SKY_ASSETS to a directory holding SOURCES.json and the two .skytex plates (`simforge doctor` checks it)",
        }))
    })
}

/// [`map_drift`] with its verdict: a member the workspace's map and the
/// installed release both list with different digests refuses the scene
/// (`map_release_mismatch`, exit 2) unless `allow` (`--allow-map-drift`),
/// which is recorded; a closure that shares nothing is recorded as
/// unverified. Returns the drift report for the result.
pub fn check_map_drift(
    ws: &Workspace,
    closure: &MapClosure,
    map: &InstalledMap,
    allow: bool,
    warnings: &mut Warnings,
) -> Result<Option<Value>, CliError> {
    let drift = map_drift(ws, closure)?;
    if let Some(drift) = &drift {
        let release = map.release.as_deref().unwrap_or("(no receipt)");
        if drift["differing"].as_array().is_some_and(|d| !d.is_empty()) {
            if !allow {
                return Err(CliError::findings(
                    "map_release_mismatch",
                    format!(
                        "the installed map {release} differs from the workspace's map in {} shared member(s); pull the release the scenario was made on, or pass --allow-map-drift to render on this one",
                        drift["differingCount"]
                    ),
                )
                .with_detail(drift.clone()));
            }
            warnings.push(
                "map_release_drift_accepted",
                format!(
                    "--allow-map-drift: rendering on {release} although {} shared member(s) differ from the workspace's map",
                    drift["differingCount"]
                ),
            );
        } else if drift["shared"] == 0 {
            warnings.push(
                "map_release_unverified",
                "the workspace's map closure shares no member with the installed map; its release could not be cross-checked",
            );
        }
    }
    Ok(drift)
}
