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

/// Projected low beam: the spot light's reach, metres. The pattern still
/// puts ~10 lx on a vertical surface at 60 m, so the range is well past it.
pub const BEAM_RANGE_M: f32 = 120.0;
/// Projected low beam: the spot light's cone, degrees (half-angle). The
/// cone only bounds the photometric pattern ([`low_beam_candela`]), which
/// the spot light projects as a light texture of the same half-angle; the
/// pattern is zero well inside it.
pub const BEAM_CONE_DEG: f32 = 45.0;
/// Side length of the low-beam light texture, texels (0.22 deg per texel
/// at the axis, so the 0.3 deg cut-off stays sharp).
pub const BEAM_PATTERN_TEXELS: u32 = 512;

/// Driving side the low-beam pattern is built for: its cut-off rises on the
/// right (kerb) side and its hot spot sits right of the axis.
pub const LOW_BEAM_TRAFFIC_SIDE: &str = "right-hand";

/// One vehicle's low beams (both lamps, seen from far enough to be one
/// source), candela, in the direction `h_deg` right of the vehicle axis and
/// `v_deg` above the horizontal.
///
/// Shape of an ECE R112/R149 class-B passing beam for right-hand traffic:
/// - a sharp cut-off (0.3 deg soft edge) at 0.57 deg below the horizon on
///   the left (oncoming) side, rising at 15 deg right of the axis to 0.5 deg
///   above it on the kerb side;
/// - a hot spot 1.5 deg right of the axis, about 1 deg under the cut-off;
///   a wide spread (25L/25R, +-9 deg); a dimmer foreground; a small glare
///   floor above the cut-off.
///
/// Per lamp it meets the regulation's test points with typical (not
/// minimum) values: 75R ~13 400 cd (>= 6 300), 50V ~12 000 cd (>= 3 200),
/// 25L/25R ~2 600-3 300 cd (>= 1 060), B50L ~150 cd (<= 250), HV ~150 cd
/// (<= 440). On the road (lamp 0.62 m up) that is ~10 lx at 8-10 m,
/// ~2.5 lx at 20 m and ~0.25 lx at 40 m, and ~15 lx on a vertical surface
/// at 50 m: a long throw with a flat top, not a round pool.
pub fn low_beam_candela(h_deg: f32, v_deg: f32) -> f32 {
    fn g(x: f32, s: f32) -> f32 {
        (-(x / s) * (x / s)).exp()
    }
    fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
        let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }
    const CUT_LEFT_DEG: f32 = -0.57;
    const CUT_KERB_MAX_DEG: f32 = 0.5;
    // 15 deg rising cut-off on the kerb side.
    let rise = 0.267_949_2; // tan(15 deg)
    let cut = if h_deg <= 0.0 {
        CUT_LEFT_DEG
    } else {
        (CUT_LEFT_DEG + h_deg * rise).min(CUT_KERB_MAX_DEG)
    };
    // Degrees under the cut-off (negative above it).
    let d = cut - v_deg;
    let lit = smoothstep(-0.15, 0.15, d);
    let core = 14_000.0 * g(h_deg - 1.5, 5.0) * g(d - 1.2, 1.8);
    let spread = 3_500.0 * g(h_deg, 16.0) * g(d - 2.0, 3.0);
    // The foreground fades out gradually from 8 to 30 deg down (5 to 1 m
    // ahead of the lamp): the bumper's own ground gets spill only, without
    // a visible edge.
    let foreground = 400.0
        * g(h_deg, 25.0)
        * smoothstep(0.0, 4.0, d)
        * g((d - 4.0).max(0.0), 10.0)
        * (1.0 - smoothstep(8.0, 30.0, d));
    let glare = 150.0 * g((-d).max(0.0), 8.0);
    // Zero before the edge of the light's cone.
    let edge = 1.0 - smoothstep(38.0, 44.0, h_deg.hypot(v_deg));
    2.0 * edge * (lit * (core + spread + foreground) + (1.0 - lit) * glare)
}

/// The low-beam light texture: [`low_beam_candela`] over the spot light's
/// projection (square, half-angle [`BEAM_CONE_DEG`]; texel x grows to the
/// light's right, row 0 is up), normalised to its peak, as R16Float texels
/// (filterable; 8 bits band the dim spread into visible rings). Returns
/// the texels and the peak in candela (the spot light's intensity is the
/// peak times 4 pi: Bevy spreads a spot light's lumens over the sphere).
pub fn low_beam_pattern(size: u32) -> (Vec<u8>, f32) {
    let (relative, peak) = low_beam_relative(size);
    let texels = relative
        .iter()
        .flat_map(|r| half::f16::from_f32(*r).to_le_bytes())
        .collect();
    (texels, peak)
}

/// [`low_beam_candela`] over the light texture, relative to its peak, row
/// major; and the peak, candela.
pub fn low_beam_relative(size: u32) -> (Vec<f32>, f32) {
    let t = BEAM_CONE_DEG.to_radians().tan();
    let n = size as usize;
    let mut candela = vec![0.0f32; n * n];
    let mut peak = 0.0f32;
    for row in 0..n {
        for col in 0..n {
            // The border stays black (the texture is clamped at its edge).
            if row == 0 || col == 0 || row == n - 1 || col == n - 1 {
                continue;
            }
            let x = ((col as f32 + 0.5) / size as f32 - 0.5) * 2.0 * t;
            let y = (0.5 - (row as f32 + 0.5) / size as f32) * 2.0 * t;
            let h = x.atan().to_degrees();
            let v = (y / (1.0 + x * x).sqrt()).atan().to_degrees();
            let c = low_beam_candela(h, v);
            peak = peak.max(c);
            candela[row * n + col] = c;
        }
    }
    for c in &mut candela {
        *c /= peak;
    }
    (candela, peak)
}

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

/// Projected beam source and aim in model space, from the model's front
/// face: the source at headlamp height, aimed level along the vehicle axis
/// (the pattern itself carries the downward aim and the cut-off).
pub fn beam_pose(min: Vec3, max: Vec3) -> (Vec3, Vec3) {
    let h = max.y - min.y;
    let cz = (min.z + max.z) * 0.5;
    let source = Vec3::new(max.x, min.y + h * 0.43, cz);
    let aim = source + Vec3::X * 20.0;
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
        assert!(aim.x > source.x && (aim.y - source.y).abs() < 1e-6);
    }

    /// Per-lamp values at the ECE R112 class-B test points (vehicle / 2).
    #[test]
    fn low_beam_meets_the_passing_beam_test_points() {
        let lamp = |h: f32, v: f32| low_beam_candela(h, v) / 2.0;
        assert!(lamp(1.15, -0.57) >= 6_300.0, "75R {}", lamp(1.15, -0.57));
        assert!(lamp(0.0, -0.86) >= 3_200.0, "50V {}", lamp(0.0, -0.86));
        assert!(lamp(-9.0, -1.72) >= 1_060.0, "25L {}", lamp(-9.0, -1.72));
        assert!(lamp(9.0, -1.72) >= 1_060.0, "25R {}", lamp(9.0, -1.72));
        assert!(lamp(-3.43, 0.57) <= 250.0, "B50L {}", lamp(-3.43, 0.57));
        assert!(lamp(0.0, 0.0) <= 440.0, "HV {}", lamp(0.0, 0.0));
        // Asymmetric: the kerb side is lit above where the oncoming side is cut.
        assert!(lamp(8.0, 0.0) > 5.0 * lamp(-8.0, 0.0));
    }

    /// On the road the beam throws long with a sharp top: the lit area is
    /// not a round pool at the bumper.
    #[test]
    fn low_beam_throws_down_the_road() {
        let lamp_height = 0.62f32;
        let ground_lux = |d: f32| {
            let v = -(lamp_height / d).atan().to_degrees();
            let r2 = d * d + lamp_height * lamp_height;
            low_beam_candela(0.0, v) * lamp_height / (r2 * r2.sqrt())
        };
        assert!(ground_lux(10.0) > 5.0 && ground_lux(10.0) >= ground_lux(4.0) * 0.7);
        assert!(ground_lux(20.0) > 1.5, "20 m {}", ground_lux(20.0));
        assert!(ground_lux(40.0) > 0.15, "40 m {}", ground_lux(40.0));
        // Past the cut-off only the glare floor remains.
        assert!(low_beam_candela(-2.0, 1.0) < 400.0);
    }

    #[test]
    fn pattern_texture_is_oriented_and_bounded() {
        let (texels, peak) = low_beam_relative(64);
        assert!(peak > 25_000.0 && peak < 45_000.0, "peak {peak}");
        assert_eq!(low_beam_pattern(64).0.len(), 64 * 64 * 2);
        let at = |row: usize, col: usize| texels[row * 64 + col];
        // Border black; the upper half (above ~+1 deg) nearly dark; the
        // brightest texel just below the centre row and right of it.
        assert!((0..64)
            .all(|i| at(0, i) == 0.0 && at(63, i) == 0.0 && at(i, 0) == 0.0 && at(i, 63) == 0.0));
        assert!((1..28).all(|row| (1..63).all(|col| at(row, col) <= 0.015)));
        // Nothing near the bottom of the cone (the bumper's own ground).
        assert!((56..63).all(|row| (1..63).all(|col| at(row, col) < 1e-3)));
        let brightest = (0..64 * 64)
            .max_by(|&a, &b| texels[a].total_cmp(&texels[b]))
            .unwrap();
        let (row, col) = (brightest / 64, brightest % 64);
        assert!(row >= 32 && row <= 34 && col >= 32, "row {row} col {col}");
    }
}
