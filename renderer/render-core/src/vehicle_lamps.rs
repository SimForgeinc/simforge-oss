//! Vehicle lamps of catalog models: what the render timeline lights and how
//! each lamp is drawn.
//!
//! - **Tail / brake** ([`crate::brake_lamps`]): the model's rear lamp slot,
//!   glowing at [`TAIL_LAMP_LUMINANCE_CDM2`] with the low beams and at
//!   [`crate::brake_lamps::BRAKE_LAMP_LUMINANCE_CDM2`] while braking.
//! - **Headlamps**: the model's front lamp slot (the same selection at the
//!   front of the body) at [`HEAD_LAMP_LUMINANCE_CDM2`] with the low beams,
//!   and a projected beam (a spot light, no shadows) for at most
//!   [`crate::actor_lights::PROJECTED_HEADLIGHT_LIMIT`] vehicles per tick,
//!   chosen by relevance: the camera hosts, then the vehicles nearest a
//!   camera, ties by actor id (the service's `beam_priority`).
//! - **Reverse, indicators, emergency**: the renderer contract's lens boxes
//!   ([`crate::actor_lights`]), placed from the model's own bounds.
//!
//! Luminances are cd/m² at the renderer's internal scale of 1 (the same
//! model as the night windows and street luminaires). Every lamp the
//! timeline lights that a model cannot draw is reported by the caller,
//! never dropped.

use bevy::color::LinearRgba;
use bevy::math::Vec3;

use crate::actor_lights::{emergency_lens, indicator_lens, reverse_lens, LensBox};

/// Lamps the timeline lights on one vehicle at one frame (`lights_at`,
/// flashing already phased), plus whether it carries a projected beam.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VehicleLamps {
    pub low_beam: bool,
    pub brake: bool,
    pub reverse: bool,
    pub indicator_left: bool,
    pub indicator_right: bool,
    pub emergency: bool,
    /// Draw the projected headlamp beam (only with `low_beam`, within the
    /// beam budget).
    pub beam: bool,
}

/// Which of the lit lamps a model actually drew.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LampsDrawn {
    /// Headlamp lenses (the front slot).
    pub head: bool,
    /// Tail glow (the rear slot, with the low beams).
    pub tail: bool,
    pub brake: bool,
    pub reverse: bool,
    pub indicator_left: bool,
    pub indicator_right: bool,
    pub emergency: bool,
    pub beam: bool,
}

/// Low-beam headlamp lens luminance, cd/m². Real LED/halogen lenses run
/// from 1e4 to above 1e6 cd/m²; this is the low end, which already reads
/// as a blown-out lamp at every night exposure without swamping bloom.
pub const HEAD_LAMP_LUMINANCE_CDM2: f32 = 20_000.0;
/// Headlamp colour temperature, kelvin.
pub const HEAD_LAMP_CCT_K: f32 = 4_300.0;
/// Tail lamp (position lamp) luminance with the low beams on, cd/m²:
/// ECE R7 asks 4-17 cd per lamp, a tenth of the stop lamp.
pub const TAIL_LAMP_LUMINANCE_CDM2: f32 = 500.0;
/// Reversing lamp luminance, cd/m².
pub const REVERSE_LAMP_LUMINANCE_CDM2: f32 = 3_000.0;
/// Direction indicator luminance, cd/m² (amber).
pub const INDICATOR_LUMINANCE_CDM2: f32 = 4_000.0;
/// Emergency beacon luminance, cd/m².
pub const BEACON_LUMINANCE_CDM2: f32 = 8_000.0;

/// Projected low beam: luminous flux, lumens (two ~900 lm low beams).
pub const BEAM_LUMENS: f32 = 1_800.0;
/// Projected low beam: reach, metres.
pub const BEAM_RANGE_M: f32 = 70.0;
/// Projected low beam: inner / outer cone half-angles, degrees.
pub const BEAM_INNER_DEG: f32 = 10.0;
pub const BEAM_OUTER_DEG: f32 = 26.0;

/// Emissive of a lamp: `chroma` (linear Rec.709) scaled to `luminance`.
pub fn lamp_emissive(chroma: [f32; 3], luminance: f32) -> LinearRgba {
    let [r, g, b] = chroma;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let k = luminance / y.max(1e-6);
    LinearRgba::rgb(r * k, g * k, b * k)
}

/// Linear chromaticities of the lamp colours.
pub const TAIL_CHROMA: [f32; 3] = [1.0, 0.04, 0.0];
pub const AMBER_CHROMA: [f32; 3] = [1.0, 0.45, 0.0];
pub const WHITE_CHROMA: [f32; 3] = [1.0, 1.0, 1.0];
pub const BEACON_RED_CHROMA: [f32; 3] = [1.0, 0.02, 0.02];
pub const BEACON_BLUE_CHROMA: [f32; 3] = [0.05, 0.15, 1.0];

/// The contract lens boxes of one model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum LampBox {
    Reverse,
    IndicatorFrontLeft,
    IndicatorFrontRight,
    IndicatorRearLeft,
    IndicatorRearRight,
    BeaconRed,
    BeaconBlue,
}

impl LampBox {
    pub const ALL: [LampBox; 7] = [
        LampBox::Reverse,
        LampBox::IndicatorFrontLeft,
        LampBox::IndicatorFrontRight,
        LampBox::IndicatorRearLeft,
        LampBox::IndicatorRearRight,
        LampBox::BeaconRed,
        LampBox::BeaconBlue,
    ];

    /// Whether the frame's lamps light this box.
    pub fn lit(self, lamps: &VehicleLamps) -> bool {
        match self {
            LampBox::Reverse => lamps.reverse,
            LampBox::IndicatorFrontLeft | LampBox::IndicatorRearLeft => lamps.indicator_left,
            LampBox::IndicatorFrontRight | LampBox::IndicatorRearRight => lamps.indicator_right,
            LampBox::BeaconRed | LampBox::BeaconBlue => lamps.emergency,
        }
    }

    /// Emissive of the lit box.
    pub fn emissive(self) -> LinearRgba {
        match self {
            LampBox::Reverse => lamp_emissive(WHITE_CHROMA, REVERSE_LAMP_LUMINANCE_CDM2),
            LampBox::IndicatorFrontLeft
            | LampBox::IndicatorFrontRight
            | LampBox::IndicatorRearLeft
            | LampBox::IndicatorRearRight => lamp_emissive(AMBER_CHROMA, INDICATOR_LUMINANCE_CDM2),
            LampBox::BeaconRed => lamp_emissive(BEACON_RED_CHROMA, BEACON_LUMINANCE_CDM2),
            LampBox::BeaconBlue => lamp_emissive(BEACON_BLUE_CHROMA, BEACON_LUMINANCE_CDM2),
        }
    }

    /// The box in model space for a model whose bounds are `min..max`
    /// (+X forward, -Z left, ground at `min.y`): the contract geometry for
    /// the model's own length, width and height, centred on its footprint.
    pub fn placement(self, min: Vec3, max: Vec3) -> LensBox {
        let (l, h, w) = ((max.x - min.x), (max.y - min.y), (max.z - min.z));
        let lens = match self {
            LampBox::Reverse => reverse_lens(l, w, h),
            LampBox::IndicatorFrontLeft => indicator_lens(l, w, h, -1.0, true),
            LampBox::IndicatorFrontRight => indicator_lens(l, w, h, 1.0, true),
            LampBox::IndicatorRearLeft => indicator_lens(l, w, h, -1.0, false),
            LampBox::IndicatorRearRight => indicator_lens(l, w, h, 1.0, false),
            LampBox::BeaconRed => emergency_lens(l, w, h, -1.0),
            LampBox::BeaconBlue => emergency_lens(l, w, h, 1.0),
        };
        let centre = Vec3::new((min.x + max.x) * 0.5, min.y, (min.z + max.z) * 0.5);
        LensBox {
            translation: (centre + Vec3::from_array(lens.translation)).to_array(),
            scale: lens.scale,
        }
    }
}

/// Projected beam source and aim in model space (the contract's
/// `beam_source` / `beam_aim`, from the model's front face).
pub fn beam_pose(min: Vec3, max: Vec3) -> (Vec3, Vec3) {
    let h = max.y - min.y;
    let cz = (min.z + max.z) * 0.5;
    let source = Vec3::new(max.x, min.y + h * 0.43, cz);
    let aim = Vec3::new(max.x + 18.0, min.y + 0.15, cz);
    (source, aim)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lamp_emissive_hits_the_stated_luminance() {
        for (chroma, lum) in [
            (TAIL_CHROMA, TAIL_LAMP_LUMINANCE_CDM2),
            (AMBER_CHROMA, INDICATOR_LUMINANCE_CDM2),
            (BEACON_BLUE_CHROMA, BEACON_LUMINANCE_CDM2),
        ] {
            let e = lamp_emissive(chroma, lum);
            let y = 0.2126 * e.red + 0.7152 * e.green + 0.0722 * e.blue;
            assert!((y - lum).abs() < 1e-2 * lum, "{chroma:?}");
        }
    }

    #[test]
    fn boxes_follow_the_lamps_and_sit_on_the_model() {
        let lamps = VehicleLamps {
            indicator_left: true,
            ..Default::default()
        };
        let lit: Vec<LampBox> = LampBox::ALL.into_iter().filter(|b| b.lit(&lamps)).collect();
        assert_eq!(
            lit,
            vec![LampBox::IndicatorFrontLeft, LampBox::IndicatorRearLeft]
        );
        // An off-centre model: the reverse panel sits on its rear face,
        // the left indicators on its -Z side.
        let (min, max) = (Vec3::new(-2.0, 0.0, -1.0), Vec3::new(3.0, 1.5, 1.0));
        let reverse = LampBox::Reverse.placement(min, max);
        assert!(reverse.translation[0] < -1.99 && reverse.translation[0] > -2.1);
        let left = LampBox::IndicatorRearLeft.placement(min, max);
        assert!(left.translation[2] < -0.9);
        let (source, aim) = beam_pose(min, max);
        assert_eq!(source.x, 3.0);
        assert!(aim.x > source.x && aim.y < source.y);
    }
}
