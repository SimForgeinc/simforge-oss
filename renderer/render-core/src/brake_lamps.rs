//! Brake lamps of catalog vehicle models.
//!
//! The vehicles-carla GLBs have no per-function lamp slots: CARLA drives
//! its lamps through material parameters the conversion dropped, so each
//! model carries its lamp geometry under one or more lamp materials
//! (`lights_patrol2021`, `lincoln_mkz_emissive`, `citroen_lights_back`, ...)
//! that cover head, tail and indicator lamps together. The brake-lamp slot
//! of a model is derived from that geometry, deterministically, when the
//! model is attached: the triangles of its lamp materials that sit in the
//! rear of the body (see [`LampSelection`]). The renderer draws them again,
//! 3 mm proud of the lens along the vertex normal, under an emissive red
//! material that is visible exactly while the timeline's `brake` light is
//! on. A model whose lamp materials have no rear triangles has no brake
//! slot; the service records `native_actor_brake_lamp_missing` for every
//! braking actor that uses it rather than rendering it unlit in silence.

use bevy::color::LinearRgba;

/// Rear zone: triangles whose centroid lies within this fraction of the
/// model length from its rearmost point.
pub const REAR_FRACTION: f32 = 0.12;

/// Triangles lower than this fraction of the model height (reflectors,
/// licence-plate lamps, exhaust trims sharing the lamp atlas) are not
/// brake lamps.
pub const MIN_HEIGHT_FRACTION: f32 = 0.18;

/// How far the lit lens is drawn proud of the modelled lens (metres, model
/// space), so the two never tie in depth.
pub const LENS_OFFSET_M: f32 = 0.003;

/// Stop-lamp luminance, cd/m². SAE J586 asks 80-300 cd per lamp over a lens
/// of roughly 0.02-0.05 m², i.e. about 2,000-15,000 cd/m²; the lit area
/// here is the whole rear lamp cluster, so the low-middle of that range.
pub const BRAKE_LAMP_LUMINANCE_CDM2: f32 = 5_000.0;

/// Chromaticity of a red stop lamp in linear Rec.709 (unit red channel).
pub const BRAKE_LAMP_CHROMA: [f32; 3] = [1.0, 0.04, 0.0];

/// Emissive of the lit brake lens: [`BRAKE_LAMP_CHROMA`] scaled to
/// [`BRAKE_LAMP_LUMINANCE_CDM2`] (`StandardMaterial::emissive` is luminance
/// in cd/m² at the renderer's internal scale of 1).
pub fn brake_lamp_emissive() -> LinearRgba {
    let [r, g, b] = BRAKE_LAMP_CHROMA;
    let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let k = BRAKE_LAMP_LUMINANCE_CDM2 / luminance;
    LinearRgba::rgb(r * k, g * k, b * k)
}

/// Whether a glTF material is a vehicle lamp material. Siren, interior,
/// reversing and headlamp-only materials and lamp brackets are not.
pub fn is_lamp_material(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let lamp = ["light", "lamp", "emissive"]
        .iter()
        .any(|token| name.contains(token));
    let excluded = ["siren", "_int", "backup", "reverse", "front", "support"]
        .iter()
        .any(|token| name.contains(token));
    lamp && !excluded
}

/// One primitive of a model, in model space (the model root's frame before
/// its actor scale): the input to [`select_brake_triangles`].
pub struct LampPrimitive<'a> {
    pub material: &'a str,
    /// Vertex positions in model space.
    pub positions: &'a [[f32; 3]],
    /// Triangle list indices into `positions`.
    pub indices: &'a [u32],
}

/// The model's bounds along its length (+X forward) and height (+Y up).
#[derive(Debug, Clone, Copy)]
pub struct ModelExtent {
    pub min_x: f32,
    pub max_x: f32,
    pub min_y: f32,
    pub max_y: f32,
}

impl ModelExtent {
    pub fn of<'a>(positions: impl IntoIterator<Item = &'a [f32; 3]>) -> Option<Self> {
        let mut extent: Option<Self> = None;
        for p in positions {
            let e = extent.get_or_insert(Self {
                min_x: p[0],
                max_x: p[0],
                min_y: p[1],
                max_y: p[1],
            });
            e.min_x = e.min_x.min(p[0]);
            e.max_x = e.max_x.max(p[0]);
            e.min_y = e.min_y.min(p[1]);
            e.max_y = e.max_y.max(p[1]);
        }
        extent
    }
}

/// The brake-lamp triangles of one primitive: indices (a triangle list into
/// the primitive's own vertices) of the lamp-material triangles whose
/// centroid lies in the rear zone above [`MIN_HEIGHT_FRACTION`]. Empty for
/// non-lamp materials.
pub fn select_brake_triangles(primitive: &LampPrimitive, extent: ModelExtent) -> Vec<u32> {
    if !is_lamp_material(primitive.material) {
        return Vec::new();
    }
    let length = extent.max_x - extent.min_x;
    let height = extent.max_y - extent.min_y;
    let rear_limit = extent.min_x + REAR_FRACTION * length;
    let floor = extent.min_y + MIN_HEIGHT_FRACTION * height;
    let mut out = Vec::new();
    for tri in primitive.indices.chunks_exact(3) {
        let Some(corners) = tri
            .iter()
            .map(|&i| primitive.positions.get(i as usize))
            .collect::<Option<Vec<_>>>()
        else {
            continue; // fallback-ok: an out-of-range index draws nothing in the source mesh either
        };
        let cx = (corners[0][0] + corners[1][0] + corners[2][0]) / 3.0;
        let cy = (corners[0][1] + corners[1][1] + corners[2][1]) / 3.0;
        if cx <= rear_limit && cy >= floor {
            out.extend_from_slice(tri);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lamp_materials_exclude_sirens_interiors_and_brackets() {
        for name in [
            "lights_patrol2021",
            "lincoln_mkz_emissive",
            "citroen_lights_back",
            "vh_car_seat_leon_light_back_mat_base_color_mat",
            "european_hgv_emissive",
        ] {
            assert!(is_lamp_material(name), "{name}");
        }
        for name in [
            "body_paint",
            "glass",
            "ambulance_emissive_sirens",
            "european_hgv_glass_emissive_int",
            "ambulance_glass_emissive_ext_backup",
            "audi_a2_front_lights",
            "harley_lamp_support",
        ] {
            assert!(!is_lamp_material(name), "{name}");
        }
    }

    /// Two lamp quads: a headlamp at the nose and a tail lamp at the rear.
    /// Only the tail lamp is a brake lamp; a non-lamp material never is.
    #[test]
    fn rear_lamp_triangles_are_selected() {
        let positions = [
            // headlamp, x = +2.3
            [2.3, 0.7, -0.6],
            [2.3, 0.9, -0.6],
            [2.3, 0.9, -0.3],
            // tail lamp, x = -2.3
            [-2.3, 0.8, 0.6],
            [-2.3, 1.0, 0.6],
            [-2.3, 1.0, 0.3],
            // rear reflector, x = -2.35, low
            [-2.35, 0.1, 0.6],
            [-2.35, 0.15, 0.6],
            [-2.35, 0.15, 0.3],
        ];
        let extent = ModelExtent {
            min_x: -2.4,
            max_x: 2.4,
            min_y: 0.0,
            max_y: 1.5,
        };
        let lamp = LampPrimitive {
            material: "lights_patrol2021",
            positions: &positions,
            indices: &[0, 1, 2, 3, 4, 5, 6, 7, 8],
        };
        assert_eq!(select_brake_triangles(&lamp, extent), vec![3, 4, 5]);
        let paint = LampPrimitive {
            material: "body_paint",
            ..lamp
        };
        assert!(select_brake_triangles(&paint, extent).is_empty());
    }

    #[test]
    fn brake_emissive_is_red_at_the_stated_luminance() {
        let e = brake_lamp_emissive();
        let luminance = 0.2126 * e.red + 0.7152 * e.green + 0.0722 * e.blue;
        assert!((luminance - BRAKE_LAMP_LUMINANCE_CDM2).abs() < 1.0);
        assert!(e.red > 10.0 * e.green && e.blue == 0.0);
    }
}
