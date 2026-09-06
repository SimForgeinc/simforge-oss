//! The asset catalog's *metadata* view: ids, classes, footprints and physical
//! behaviour. Renderers own the meshes; the compiler only needs to answer
//! "does this id exist, what may it be, and how big is it".
//!
//! Two rules drive everything here:
//!
//! 1. **Unknown ids fail loudly for actors.** A template carrying
//!    `vehicle.boxTruck` (the real id is `vehicle.box_truck`) used to
//!    materialise as a sedan. An occluder that silently becomes a sedan deletes
//!    the point of the scenario, so an actor's `catalogId` must resolve.
//! 2. **Class and model must agree.** `class: animal` with
//!    `catalog: pedestrian.adult` passes every trajectory- and render-based
//!    check because only the catalog id can see the defect.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::template::ActorClass;

/// Length / width / height, metres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CatalogDims {
    pub l: f64,
    pub w: f64,
    pub h: f64,
}

/// One built-in catalog model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CatalogEntry {
    pub id: &'static str,
    pub class: &'static str,
    /// Explicit road-user class; `None` derives from `class`.
    pub actor_class: Option<&'static str>,
    pub compatible_actor_classes: &'static [&'static str],
    pub dims: CatalogDims,
}

const fn d(l: f64, w: f64, h: f64) -> CatalogDims {
    CatalogDims { l, w, h }
}

const fn e(
    id: &'static str,
    class: &'static str,
    actor_class: Option<&'static str>,
    compatible: &'static [&'static str],
    dims: CatalogDims,
) -> CatalogEntry {
    CatalogEntry {
        id,
        class,
        actor_class,
        compatible_actor_classes: compatible,
        dims,
    }
}

/// The built-in catalog, mirroring `packages/asset-catalog/src/catalog.ts`.
pub const CATALOG: &[CatalogEntry] = &[
    e(
        "vehicle.sedan",
        "vehicle",
        Some("car"),
        &[],
        d(4.7, 1.82, 1.45),
    ),
    e(
        "vehicle.hatchback",
        "vehicle",
        Some("car"),
        &[],
        d(4.05, 1.75, 1.46),
    ),
    e(
        "vehicle.suv",
        "vehicle",
        Some("car"),
        &[],
        d(4.85, 1.95, 1.78),
    ),
    e(
        "vehicle.pickup",
        "vehicle",
        Some("truck"),
        &["car"],
        d(5.9, 2.03, 1.95),
    ),
    e("vehicle.van", "vehicle", Some("van"), &[], d(5.3, 2.0, 2.4)),
    e(
        "vehicle.kia.carnival",
        "vehicle",
        Some("van"),
        &["car"],
        d(5.15, 2.0, 1.78),
    ),
    e(
        "vehicle.box_truck",
        "vehicle",
        Some("truck"),
        &[],
        d(7.6, 2.44, 3.4),
    ),
    e(
        "vehicle.semi_truck",
        "vehicle",
        Some("truck"),
        &[],
        d(20.1, 2.6, 4.1),
    ),
    e(
        "vehicle.bus",
        "vehicle",
        Some("bus"),
        &[],
        d(12.2, 2.55, 3.2),
    ),
    e(
        "vehicle.motorcycle",
        "vehicle",
        Some("motorcycle"),
        &[],
        d(2.1, 0.75, 1.23),
    ),
    e(
        "vehicle.bicycle",
        "vehicle",
        Some("bicycle"),
        &[],
        d(1.75, 0.5, 1.71),
    ),
    e(
        "vehicle.ambulance",
        "vehicle",
        Some("van"),
        &["truck"],
        d(6.1, 2.1, 2.65),
    ),
    e(
        "vehicle.tram",
        "vehicle",
        Some("bus"),
        &["truck"],
        d(30.0, 2.65, 3.5),
    ),
    e(
        "vehicle.mobility_scooter",
        "vehicle",
        Some("scooter"),
        &[],
        d(1.35, 0.68, 1.35),
    ),
    e(
        "vehicle.honda_civic",
        "vehicle",
        Some("car"),
        &[],
        d(4.67, 1.8, 1.42),
    ),
    e(
        "vehicle.toyota_camry",
        "vehicle",
        Some("car"),
        &[],
        d(4.88, 1.84, 1.45),
    ),
    e(
        "vehicle.tesla_model_3",
        "vehicle",
        Some("car"),
        &[],
        d(4.72, 1.85, 1.44),
    ),
    e(
        "vehicle.ford_mustang",
        "vehicle",
        Some("car"),
        &[],
        d(4.81, 1.92, 1.4),
    ),
    e(
        "vehicle.chevrolet_corvette",
        "vehicle",
        Some("car"),
        &[],
        d(4.63, 1.93, 1.23),
    ),
    e(
        "vehicle.porsche_911",
        "vehicle",
        Some("car"),
        &[],
        d(4.52, 1.85, 1.3),
    ),
    e(
        "vehicle.jeep_wrangler",
        "vehicle",
        Some("car"),
        &[],
        d(4.79, 1.88, 1.87),
    ),
    e(
        "vehicle.minivan",
        "vehicle",
        Some("van"),
        &[],
        d(5.15, 2.0, 1.78),
    ),
    e(
        "vehicle.taxi",
        "vehicle",
        Some("car"),
        &[],
        d(4.9, 1.85, 1.55),
    ),
    e(
        "vehicle.police_cruiser",
        "vehicle",
        Some("car"),
        &[],
        d(5.1, 2.0, 1.55),
    ),
    e(
        "vehicle.police_suv",
        "vehicle",
        Some("car"),
        &[],
        d(5.1, 2.0, 1.9),
    ),
    e(
        "vehicle.fire_command_suv",
        "vehicle",
        Some("car"),
        &[],
        d(5.2, 2.0, 1.95),
    ),
    e(
        "vehicle.fire_engine",
        "vehicle",
        Some("truck"),
        &[],
        d(10.2, 2.55, 3.3),
    ),
    e(
        "vehicle.dump_truck",
        "vehicle",
        Some("truck"),
        &[],
        d(8.5, 2.55, 3.3),
    ),
    e(
        "vehicle.garbage_truck",
        "vehicle",
        Some("truck"),
        &[],
        d(9.2, 2.55, 3.45),
    ),
    e(
        "vehicle.tow_truck",
        "vehicle",
        Some("truck"),
        &[],
        d(7.5, 2.45, 2.8),
    ),
    e(
        "vehicle.cement_mixer",
        "vehicle",
        Some("truck"),
        &[],
        d(8.8, 2.5, 3.7),
    ),
    e(
        "vehicle.utility_bucket_truck",
        "vehicle",
        Some("truck"),
        &[],
        d(8.2, 2.5, 3.6),
    ),
    e(
        "vehicle.tanker_truck",
        "vehicle",
        Some("truck"),
        &[],
        d(10.5, 2.55, 3.6),
    ),
    e(
        "vehicle.flatbed_truck",
        "vehicle",
        Some("truck"),
        &[],
        d(8.0, 2.5, 2.65),
    ),
    e(
        "vehicle.school_bus",
        "vehicle",
        Some("bus"),
        &[],
        d(10.7, 2.55, 3.2),
    ),
    e(
        "vehicle.shuttle_bus",
        "vehicle",
        Some("bus"),
        &[],
        d(7.4, 2.3, 2.8),
    ),
    e(
        "vehicle.delivery_van",
        "vehicle",
        Some("van"),
        &[],
        d(6.0, 2.05, 2.65),
    ),
    e(
        "pedestrian.adult",
        "pedestrian",
        None,
        &[],
        d(0.32, 0.5, 1.75),
    ),
    e(
        "pedestrian.child",
        "pedestrian",
        None,
        &[],
        d(0.24, 0.35, 1.2),
    ),
    e(
        "pedestrian.traffic_marshal",
        "pedestrian",
        None,
        &[],
        d(0.72, 0.68, 1.88),
    ),
    e(
        "sidewalk_robot.delivery_rover",
        "sidewalk_robot",
        None,
        &[],
        d(0.75, 0.55, 0.8),
    ),
    e(
        "sidewalk_robot.cooler_bot",
        "sidewalk_robot",
        None,
        &[],
        d(0.95, 0.65, 0.95),
    ),
    e(
        "sidewalk_robot.quadruped_courier",
        "sidewalk_robot",
        None,
        &[],
        d(1.05, 0.5, 0.72),
    ),
    e(
        "sidewalk_robot.humanoid_general_purpose",
        "sidewalk_robot",
        None,
        &[],
        d(0.58, 0.62, 1.78),
    ),
    e(
        "sidewalk_robot.humanoid_delivery",
        "sidewalk_robot",
        None,
        &[],
        d(0.62, 0.68, 1.7),
    ),
    e(
        "sidewalk_robot.humanoid_warehouse",
        "sidewalk_robot",
        None,
        &[],
        d(0.64, 0.7, 1.75),
    ),
    e(
        "sidewalk_robot.humanoid_public_safety",
        "sidewalk_robot",
        None,
        &[],
        d(0.62, 0.68, 1.82),
    ),
    e(
        "sidewalk_robot.humanoid_construction",
        "sidewalk_robot",
        None,
        &[],
        d(0.66, 0.72, 1.85),
    ),
    e(
        "robot.delivery-4w",
        "robot",
        Some("static_object"),
        &[],
        d(0.7, 0.5, 0.3),
    ),
    e(
        "robot.wheel",
        "robot",
        Some("static_object"),
        &[],
        d(0.2, 0.05, 0.2),
    ),
    e(
        "drone.delivery_quadcopter",
        "drone",
        None,
        &[],
        d(1.1, 1.1, 0.45),
    ),
    e(
        "drone.camera_quadcopter",
        "drone",
        None,
        &[],
        d(0.65, 0.65, 0.32),
    ),
    e(
        "drone.emergency_responder",
        "drone",
        None,
        &[],
        d(1.4, 1.4, 0.5),
    ),
    e("animal.dog", "animal", None, &[], d(1.07, 0.3, 0.75)),
    e("animal.cat", "animal", None, &[], d(0.63, 0.15, 0.35)),
    e("animal.deer", "animal", None, &[], d(1.76, 0.46, 1.62)),
    e("animal.raccoon", "animal", None, &[], d(0.85, 0.22, 0.45)),
    e("animal.goose", "animal", None, &[], d(0.86, 0.5, 0.85)),
    e(
        "construction.traffic_cone",
        "construction",
        None,
        &[],
        d(0.36, 0.36, 0.7),
    ),
    e(
        "construction.channelizer_drum",
        "construction",
        None,
        &[],
        d(0.58, 0.58, 1.07),
    ),
    e(
        "construction.barricade_type3",
        "construction",
        None,
        &[],
        d(0.62, 2.44, 1.66),
    ),
    e(
        "construction.pedestrian_barrier",
        "construction",
        None,
        &[],
        d(2.0, 0.55, 1.1),
    ),
    e(
        "construction.jersey_barrier",
        "construction",
        None,
        &[],
        d(3.05, 0.61, 0.81),
    ),
    e(
        "construction.jersey_barrier_run",
        "construction",
        None,
        &[],
        d(12.2, 0.61, 0.81),
    ),
    e(
        "construction.sign_road_work",
        "construction",
        None,
        &[],
        d(0.9, 1.73, 2.21),
    ),
    e(
        "construction.flagger",
        "construction",
        Some("pedestrian"),
        &[],
        d(0.73, 0.7, 2.19),
    ),
    e(
        "construction.arrow_board",
        "construction",
        None,
        &[],
        d(3.45, 2.44, 2.53),
    ),
    e(
        "construction.excavator",
        "construction",
        None,
        &[],
        d(5.15, 2.24, 2.71),
    ),
    e(
        "construction.portable_toilet",
        "construction",
        None,
        &[],
        d(1.24, 1.22, 2.26),
    ),
    e(
        "construction.spoil_pile",
        "construction",
        None,
        &[],
        d(2.6, 2.55, 0.9),
    ),
    e(
        "construction.temporary_stop_sign",
        "construction",
        None,
        &[],
        d(0.82, 0.92, 2.16),
    ),
    e(
        "construction.portable_signal",
        "construction",
        None,
        &[],
        d(1.45, 1.2, 3.25),
    ),
    e(
        "construction.long_pipe",
        "construction",
        None,
        &[],
        d(8.0, 0.62, 0.62),
    ),
    e(
        "occluder.dumpster",
        "occluder",
        None,
        &[],
        d(1.9, 1.52, 1.25),
    ),
    e(
        "occluder.covered_car",
        "occluder",
        None,
        &[],
        d(4.58, 1.93, 1.48),
    ),
    e(
        "occluder.hedge_run",
        "occluder",
        None,
        &[],
        d(6.0, 0.8, 1.2),
    ),
    e(
        "occluder.fence_run",
        "occluder",
        None,
        &[],
        d(6.0, 0.065, 1.8),
    ),
    e(
        "street.mailbox_cluster",
        "street",
        None,
        &[],
        d(0.54, 0.98, 1.52),
    ),
    e("street.bus_shelter", "street", None, &[], d(4.0, 1.6, 2.5)),
    e("street.food_cart", "street", None, &[], d(1.84, 1.0, 2.18)),
    e(
        "street.shopping_cart",
        "street",
        Some("scooter"),
        &[],
        d(1.05, 0.65, 1.05),
    ),
    e(
        "hazard.tire_debris",
        "hazard",
        None,
        &[],
        d(0.74, 0.56, 0.24),
    ),
    e(
        "hazard.cardboard_box",
        "hazard",
        None,
        &[],
        d(0.58, 0.44, 0.47),
    ),
    e(
        "hazard.trash_bags",
        "hazard",
        None,
        &[],
        d(1.02, 0.93, 0.58),
    ),
    e(
        "hazard.downed_branch",
        "hazard",
        None,
        &[],
        d(2.44, 1.2, 0.45),
    ),
    e("hazard.ladder", "hazard", None, &[], d(3.55, 0.44, 0.08)),
    e("hazard.mattress", "hazard", None, &[], d(1.86, 1.32, 0.3)),
    e("hazard.debris", "hazard", None, &[], d(0.88, 0.85, 0.24)),
];

/// Author-facing synonyms. The catalog files a prop under the class that owns
/// it — a tyre carcass is a `hazard`, a cone is `construction` — while authors
/// and LLMs write `object.cone`. Resolving synonyms is a vocabulary fix, not a
/// second copy of every prop.
pub const CATALOG_ALIASES: &[(&str, &str)] = &[
    ("object.tyre", "hazard.tire_debris"),
    ("object.tire", "hazard.tire_debris"),
    ("object.box", "hazard.cardboard_box"),
    ("object.cardboard_box", "hazard.cardboard_box"),
    ("object.branch", "hazard.downed_branch"),
    ("object.trash_bags", "hazard.trash_bags"),
    ("object.ladder", "hazard.ladder"),
    ("object.mattress", "hazard.mattress"),
    ("object.debris", "hazard.debris"),
    ("object.shed_load", "hazard.debris"),
    ("object.shopping_cart", "street.shopping_cart"),
    ("object.cone", "construction.traffic_cone"),
    ("object.traffic_cone", "construction.traffic_cone"),
    ("object.barrel", "construction.channelizer_drum"),
    ("object.drum", "construction.channelizer_drum"),
    ("object.barrier", "construction.jersey_barrier"),
    ("object.jersey_barrier", "construction.jersey_barrier"),
    ("object.barrier_run", "construction.jersey_barrier_run"),
    ("object.barricade", "construction.barricade_type3"),
    (
        "object.pedestrian_barrier",
        "construction.pedestrian_barrier",
    ),
    ("object.sign_board", "construction.sign_road_work"),
    ("object.arrow_board", "construction.arrow_board"),
    ("object.stop_sign", "construction.temporary_stop_sign"),
    ("animal.doe", "animal.deer"),
    ("animal.buck", "animal.deer"),
    ("animal.stray_dog", "animal.dog"),
];

/// Physical defaults for semantic campaign props: whether the engine can hit
/// it and whether it blocks sight lines. Everything not listed is a
/// non-collidable occluder; authored `extensions.collidable` still overrides.
const COLLIDABLE_PROPS: &[&str] = &[
    "construction.traffic_cone",
    "construction.channelizer_drum",
    "construction.excavator",
    "construction.barricade_type3",
    "construction.jersey_barrier",
    "construction.jersey_barrier_run",
    "construction.temporary_stop_sign",
    "construction.portable_signal",
    "construction.long_pipe",
    "street.shopping_cart",
    // Loose objects in the travelled way are physical objects. Whether an ADS
    // *should* brake for a tyre carcass is a behaviour question; whether the
    // tyre is there is not.
    "hazard.tire_debris",
    "hazard.cardboard_box",
    "hazard.downed_branch",
    "hazard.trash_bags",
    "hazard.ladder",
    "hazard.mattress",
    "hazard.debris",
    "animal.deer",
    "animal.dog",
    "animal.cat",
    "animal.raccoon",
    "animal.goose",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PropBehavior {
    pub collidable: bool,
    pub occluder: bool,
}

/// Canonical built-in id for anything an author might write, else `None`.
pub fn resolve_builtin_id(catalog_id: &str) -> Option<&'static str> {
    if let Some(entry) = CATALOG.iter().find(|e| e.id == catalog_id) {
        return Some(entry.id);
    }
    CATALOG_ALIASES
        .iter()
        .find(|(alias, _)| *alias == catalog_id)
        .map(|(_, target)| *target)
}

pub fn builtin_entry(catalog_id: &str) -> Option<&'static CatalogEntry> {
    let id = resolve_builtin_id(catalog_id)?;
    CATALOG.iter().find(|e| e.id == id)
}

pub fn prop_behavior(catalog_id: &str) -> PropBehavior {
    let id = resolve_builtin_id(catalog_id).unwrap_or(catalog_id);
    PropBehavior {
        collidable: COLLIDABLE_PROPS.contains(&id),
        occluder: true,
    }
}

/// Is this a catalog id the compiler can resolve to real dimensions?
pub fn is_known_prop_catalog_id(catalog_id: &str) -> bool {
    resolve_builtin_id(catalog_id).is_some()
}

/// Every id this crate can resolve, sorted — a "did you mean" repair hint.
pub fn known_prop_catalog_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = CATALOG
        .iter()
        .map(|e| e.id)
        .chain(CATALOG_ALIASES.iter().map(|(a, _)| *a))
        .collect();
    ids.sort_unstable();
    ids
}

/// Prop footprint. Unknown ids remain parseable for non-Studio consumers
/// (vehicle-prefixed ids default to a sedan, everything else to a unit cube);
/// author-time surfaces refuse them through [`is_known_prop_catalog_id`].
pub fn prop_dims(catalog_id: &str, override_dims: Option<PartialDims>) -> CatalogDims {
    let base = builtin_entry(catalog_id).map(|e| e.dims).unwrap_or(
        if catalog_id.starts_with("vehicle.") {
            d(4.7, 1.82, 1.45)
        } else {
            d(1.0, 1.0, 1.0)
        },
    );
    match override_dims {
        None => base,
        Some(o) => CatalogDims {
            l: o.l.unwrap_or(base.l),
            w: o.w.unwrap_or(base.w),
            h: o.h.unwrap_or(base.h),
        },
    }
}

/// `extensions.dims` on a prop placement: any subset of `{l, w, h}`.
#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
pub struct PartialDims {
    #[serde(default)]
    pub l: Option<f64>,
    #[serde(default)]
    pub w: Option<f64>,
    #[serde(default)]
    pub h: Option<f64>,
}

/* ------------------------------------------------- actor class agreement */

const ACTOR_CLASSES: &[&str] = &[
    "car",
    "truck",
    "bus",
    "van",
    "motorcycle",
    "bicycle",
    "pedestrian",
    "scooter",
    "sidewalk_robot",
    "drone",
    "animal",
    "static_object",
];

/// A user-imported model. External ids use gallery/CARLA namespaces rather
/// than class prefixes; actor class and dimensions come from the manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCatalogEntry {
    pub id: String,
    pub class: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_class: Option<String>,
    #[serde(default)]
    pub compatible_actor_classes: Vec<String>,
    #[serde(default)]
    pub description: String,
    pub dims: CatalogDims,
}

fn primary_actor_class(class: &str, actor_class: Option<&str>) -> &'static str {
    if let Some(explicit) = actor_class {
        if let Some(known) = ACTOR_CLASSES.iter().find(|c| **c == explicit) {
            return known;
        }
    }
    match class {
        "pedestrian" => "pedestrian",
        "sidewalk_robot" => "sidewalk_robot",
        "drone" => "drone",
        "animal" => "animal",
        _ => "static_object",
    }
}

fn actor_classes_for(
    class: &str,
    actor_class: Option<&str>,
    compatible: &[&str],
) -> Vec<&'static str> {
    let mut out = vec![primary_actor_class(class, actor_class)];
    for c in compatible {
        if let Some(known) = ACTOR_CLASSES.iter().find(|k| *k == c) {
            if !out.contains(known) {
                out.push(known);
            }
        }
    }
    if !out.contains(&"static_object") {
        out.push("static_object");
    }
    out
}

/// Resolved metadata for one actor model, built-in or imported.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedActorEntry {
    pub id: String,
    pub actor_classes: Vec<&'static str>,
    pub dims: CatalogDims,
}

/// Built-in catalog plus validated user imports. Imports cannot shadow a
/// built-in id: a custom vehicle needs metadata, not a code release.
#[derive(Debug, Clone, Default)]
pub struct ActorCatalog {
    external: BTreeMap<String, ExternalCatalogEntry>,
}

impl ActorCatalog {
    pub fn builtin() -> Self {
        Self::default()
    }

    /// Overlay imported entries. Errors name the offending id so an authoring
    /// loop can repair the manifest.
    pub fn with_external(entries: &[ExternalCatalogEntry]) -> Result<Self, String> {
        let mut out = Self::default();
        out.extend(entries)?;
        Ok(out)
    }

    /// Overlay more imported entries onto an existing catalog (generated
    /// geometry proxies land this way, after the user's own imports).
    pub fn extend(&mut self, entries: &[ExternalCatalogEntry]) -> Result<(), String> {
        for entry in entries {
            if entry.id.is_empty() {
                return Err("custom catalog entry has an empty id".to_owned());
            }
            if !(entry.dims.l > 0.0 && entry.dims.w > 0.0 && entry.dims.h > 0.0) {
                return Err(format!(
                    "custom catalog entry \"{}\" has non-positive dimensions",
                    entry.id
                ));
            }
            if builtin_entry(&entry.id).is_some() {
                return Err(format!(
                    "custom catalog entry \"{}\" shadows a built-in catalog id",
                    entry.id
                ));
            }
            if self
                .external
                .insert(entry.id.clone(), entry.clone())
                .is_some()
            {
                return Err(format!("duplicate custom catalog id \"{}\"", entry.id));
            }
        }
        Ok(())
    }

    pub fn resolve(&self, catalog_id: &str) -> Option<ResolvedActorEntry> {
        if let Some(entry) = builtin_entry(catalog_id) {
            return Some(ResolvedActorEntry {
                id: entry.id.to_owned(),
                actor_classes: actor_classes_for(
                    entry.class,
                    entry.actor_class,
                    entry.compatible_actor_classes,
                ),
                dims: entry.dims,
            });
        }
        let entry = self.external.get(catalog_id)?;
        let compatible: Vec<&str> = entry
            .compatible_actor_classes
            .iter()
            .map(String::as_str)
            .collect();
        Some(ResolvedActorEntry {
            id: entry.id.clone(),
            actor_classes: actor_classes_for(
                &entry.class,
                entry.actor_class.as_deref(),
                &compatible,
            ),
            dims: entry.dims,
        })
    }

    /// Why this `class` may not be filled by this `catalog_id`, or `None` if
    /// it may. A sentence rather than a boolean because the caller's job is to
    /// fail loudly and say what to fix; an unknown id is a mismatch too.
    pub fn actor_mismatch(&self, class: ActorClass, catalog_id: &str) -> Option<String> {
        let Some(entry) = self.resolve(catalog_id) else {
            return Some(format!("catalog id \"{catalog_id}\" does not exist; an unresolved id silently materialises as a default model"));
        };
        let wanted = class.as_str();
        if entry.actor_classes.iter().any(|c| *c == wanted) {
            return None;
        }
        Some(format!(
            "actor class \"{wanted}\" cannot be filled by catalog model \"{catalog_id}\" (that model may only be {})",
            entry.actor_classes.join(", ")
        ))
    }

    /// The model's own footprint, in the scenario-model dims convention.
    pub fn actor_dims(&self, catalog_id: &str) -> Option<CatalogDims> {
        self.resolve(catalog_id).map(|e| e.dims)
    }
}
