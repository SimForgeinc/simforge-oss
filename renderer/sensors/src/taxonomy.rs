//! Semantic class taxonomy and legend for the native sensor suite.
//!
//! Semantic-class IDs are a small closed set derived from (a) the scenario
//! model actor classes and (b) static map classes. They are stable across
//! maps, scenes and runs — the semantic pass encodes the class ID in the red
//! channel of an unlit RGBA render (see `class_color_bytes`).
//!
//! Instance IDs are per-scene and assigned deterministically (entities sorted
//! by mesh/actor name then entity index, 1-based; 0 = background), matching
//! the spike approach. The instance legend (id -> name) is written next to
//! every capture as `legend.json`.

use serde::{Deserialize, Serialize};

/// Closed semantic class set. Serialized values are the canonical names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum SemanticClass {
    /// No geometry (sky / clear color).
    Unlabeled = 0,
    Road = 1,
    Building = 2,
    Vegetation = 3,
    Car = 4,
    /// Trucks and buses (scenario model `kind: bus` folds into truck class).
    Truck = 5,
    Pedestrian = 6,
    /// A bicycle. With ridden models the person on it is `Rider`; before
    /// riders existed this class covered the whole cyclist actor.
    Cyclist = 7,
    /// Props and anything else authored in the prop catalog.
    Prop = 8,
    /// The person riding a bicycle or motorcycle (Cityscapes/CARLA `rider`),
    /// labelled apart from the two-wheeler they ride.
    Rider = 9,
}

impl SemanticClass {
    pub const ALL: [SemanticClass; 10] = [
        SemanticClass::Unlabeled,
        SemanticClass::Road,
        SemanticClass::Building,
        SemanticClass::Vegetation,
        SemanticClass::Car,
        SemanticClass::Truck,
        SemanticClass::Pedestrian,
        SemanticClass::Cyclist,
        SemanticClass::Prop,
        SemanticClass::Rider,
    ];

    pub fn id(self) -> u8 {
        self as u8
    }

    pub fn name(self) -> &'static str {
        match self {
            SemanticClass::Unlabeled => "unlabeled",
            SemanticClass::Road => "road",
            SemanticClass::Building => "building",
            SemanticClass::Vegetation => "vegetation",
            SemanticClass::Car => "car",
            SemanticClass::Truck => "truck",
            SemanticClass::Pedestrian => "pedestrian",
            SemanticClass::Cyclist => "cyclist",
            SemanticClass::Prop => "prop",
            SemanticClass::Rider => "rider",
        }
    }

    /// Strict actor-class mapping (every class the render engine emits:
    /// `packages/render/src/native/lowering.ts` NATIVE_ACTOR_CLASSES). Vans,
    /// SUVs, pickups and motorcycles are motor vehicles (`Car`); `prop` is
    /// the prop class. Any other class is an error, never a silent `Prop`.
    pub fn try_from_actor_class(actor_class: &str) -> Result<SemanticClass, String> {
        match actor_class {
            "car" | "van" | "suv" | "pickup" | "motorcycle" => Ok(SemanticClass::Car),
            "truck" | "bus" => Ok(SemanticClass::Truck),
            "pedestrian" => Ok(SemanticClass::Pedestrian),
            "cyclist" => Ok(SemanticClass::Cyclist),
            // A ridden two-wheeler's rider meshes (engine rider instance ids).
            "rider" => Ok(SemanticClass::Rider),
            "prop" => Ok(SemanticClass::Prop),
            other => Err(format!("[native_actor_class_unmapped] actor class {other:?} has no semantic class")),
        }
    }

    /// The ray sensors' class of a static corpus mesh (see [`StaticKind`]):
    /// poles, signs, fences and unknown meshes are props (TAXONOMY.md).
    pub fn from_mesh_name(name: &str) -> SemanticClass {
        match StaticKind::of(name) {
            StaticKind::Vegetation => SemanticClass::Vegetation,
            StaticKind::Building => SemanticClass::Building,
            StaticKind::Road => SemanticClass::Road,
            StaticKind::Pole | StaticKind::TrafficSign | StaticKind::Fence | StaticKind::Unknown => SemanticClass::Prop,
        }
    }
}

/// What a static map mesh is, from its mesh name: the one table behind both
/// the camera's CARLA semantic pass and the ray sensors' classes. RoadRunner
/// masters name meshes after their asset (`SM_NorwayMaple_Field_02_PP`,
/// `FencePost_6ft_Prop`, `Sign_R1-1_1_StopSign`, `signal_post_35ft_mesh_Prop`).
/// A name no rule matches is [`StaticKind::Unknown`]; consumers report those
/// instead of guessing a class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaticKind {
    Vegetation,
    Building,
    Road,
    Pole,
    TrafficSign,
    Fence,
    Unknown,
}

impl StaticKind {
    /// Order matters: vegetation first; fences before poles (a fence post is
    /// fence); poles before signs (a sign post is a pole, its face a sign);
    /// road keywords last.
    pub fn of(name: &str) -> StaticKind {
        let n = name.to_ascii_lowercase();
        let any = |keys: &[&str]| keys.iter().any(|k| n.contains(k));
        if any(&[
            "tree", "veg", "bush", "shrub", "plant", "foliage", "grass", "hedge", "maple", "oak", "pine", "alder",
            "birch", "eucalyptus", "palm", "spruce", "cypress", "willow", "conifer",
        ]) {
            StaticKind::Vegetation
        } else if n.contains("building") {
            StaticKind::Building
        } else if any(&["fence", "guardrail", "railbracket", "barrier"]) {
            StaticKind::Fence
        } else if any(&["post", "pole", "luminaire", "streetlight", "street_light"]) {
            StaticKind::Pole
        } else if n.contains("sign") {
            StaticKind::TrafficSign
        } else if any(&["road", "asphalt", "sidewalk", "curb", "ground", "pavement", "crosswalk", "marking"]) {
            StaticKind::Road
        } else {
            StaticKind::Unknown
        }
    }
}

/// The legend written as `<out>/legend.json` for every capture: semantic
/// classes plus the deterministic instance-ID assignment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Legend {
    pub schema: &'static str,
    /// Semantic class id -> name.
    pub classes: Vec<(u8, &'static str)>,
    /// Instance id -> display name (mesh name or actor id). Sorted by id.
    pub instances: Vec<(u32, String)>,
    /// Per instance: semantic class id.
    pub instance_classes: Vec<(u32, u8)>,
}

/// LiDAR intensity proxy albedo per semantic class (0..1). Deterministic,
/// hand-calibrated order-of-magnitude values; documented in TAXONOMY.md.
pub fn lidar_albedo(class: SemanticClass) -> f32 {
    match class {
        SemanticClass::Unlabeled => 0.0,
        SemanticClass::Road => 0.25,
        SemanticClass::Building => 0.45,
        SemanticClass::Vegetation => 0.55,
        SemanticClass::Car => 0.70,
        SemanticClass::Truck => 0.65,
        SemanticClass::Pedestrian => 0.60,
        SemanticClass::Cyclist => 0.60,
        SemanticClass::Prop => 0.50,
        SemanticClass::Rider => 0.60,
    }
}

#[cfg(test)]
mod tests {
    use super::SemanticClass;

    #[test]
    fn rider_is_its_own_class() {
        assert_eq!(SemanticClass::try_from_actor_class("rider"), Ok(SemanticClass::Rider));
        // RoadRunner asset names (Belmont master).
        assert_eq!(super::StaticKind::of("SM_NorwayMaple_Field_02_PP"), super::StaticKind::Vegetation);
        assert_eq!(super::StaticKind::of("FencePost_6ft_Prop"), super::StaticKind::Fence);
        assert_eq!(super::StaticKind::of("signal_post_35ft_mesh_Prop"), super::StaticKind::Pole);
        assert_eq!(super::StaticKind::of("sign_post_10_mesh_Prop"), super::StaticKind::Pole);
        assert_eq!(super::StaticKind::of("Sign_R1-1_1_StopSign"), super::StaticKind::TrafficSign);
        assert_eq!(super::StaticKind::of("Luminaire_Head02_mesh_Prop"), super::StaticKind::Pole);
        assert_eq!(super::StaticKind::of("ParkingBlocks_Lg01_Prop"), super::StaticKind::Unknown);
        assert_eq!(SemanticClass::Rider.id(), 9);
        assert_eq!(SemanticClass::Rider.name(), "rider");
        assert!(SemanticClass::ALL.contains(&SemanticClass::Rider));
        assert_ne!(SemanticClass::try_from_actor_class("cyclist"), Ok(SemanticClass::Rider));
    }
}
