//! Vertical ground contact: the engine grounds every present body on the
//! map's one ground surface (`map::ground`) every tick, so the trace carries
//! z, pitch and roll and every renderer only replays them
//! (docs/engineering/ground-height.md).
//!
//! The planar dynamics own x, y and heading. Contact is rigid: each wheel
//! stands on the surface under it, found by a downward ray from just above
//! its previous contact ([`GroundSurface::contact`]), and the body sits on
//! the least-squares plane through its wheels. A body spawns directly on the
//! surface, so nothing drops or settles. A contact that finds no surface is
//! an engine error; there is no default height.
//!
//! Wheel layout per class:
//!
//! - four-wheeled vehicles: wheels at `±wheelbase/2` along the body and
//!   `±track/2` across it, `track = 0.85 * width`. The fitted plane gives
//!   z (at the footprint centre), pitch (positive nose down) and roll
//!   (positive right side down). The twist the plane cannot follow is the
//!   per-wheel drop (suspension travel) a rigged model applies to its wheels.
//! - two-wheelers: front and rear contact on the centre line; pitch only. A
//!   two-wheeler stays upright on a cross-slope, so road roll is zero.
//! - everything else (walkers, animals, robots, props, static objects): one
//!   contact at the footprint centre.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::map::ground::{GroundError, GroundSurface, DEFAULT_STEP_UP_M};
use crate::math::{atan, sin_cos};
use crate::trace::timeline::height::{HeightField, HeightQuery};
use crate::trace::ContactFrame;
use crate::types::{ActorKind, Dims};

/// Planar displacement between two ticks beyond which a body is treated as
/// placed anew (spawn, respawn, teleport) and its deck is chosen again.
const RESEAT_DISTANCE_M: f64 = 5.0;
/// Track as a fraction of body width.
const TRACK_WIDTH_FRACTION: f64 = 0.85;

/// The ground a simulation runs on: the surface, plus an optional deck hint
/// (the OpenDRIVE lane elevation) used only to choose between stacked
/// surfaces when a body is first placed.
#[derive(Debug)]
pub struct GroundContext {
    surface: GroundSurface,
    deck_hint: Option<HeightField>,
}

impl GroundContext {
    pub fn new(surface: GroundSurface, deck_hint: Option<HeightField>) -> Self {
        Self { surface, deck_hint }
    }

    /// Decode `ground-mesh.bin`, optionally with the map's OpenDRIVE and
    /// topology for deck hints.
    pub fn from_bytes(
        ground_mesh: &[u8],
        xodr_and_topology: Option<(&[u8], &crate::map::TopologyIndex)>,
    ) -> Result<Self, String> {
        let surface = GroundSurface::decode(ground_mesh).map_err(|e| e.to_string())?;
        let deck_hint = match xodr_and_topology {
            Some((xodr, topology)) => Some(
                HeightField::from_xodr_topology(xodr, topology)
                    .map_err(|e| format!("ground deck hint: {e}"))?,
            ),
            None => None,
        };
        Ok(Self::new(surface, deck_hint))
    }

    pub fn surface(&self) -> &GroundSurface {
        &self.surface
    }

    /// `sha256` of the ground mesh: `trace.header.groundDigest`.
    pub fn digest(&self) -> &str {
        self.surface.digest()
    }
}

/// Shared handle carried by `RunOptions`.
pub type SharedGround = Arc<GroundContext>;

/// Where a body's wheels are, relative to its footprint centre.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContactGeometry {
    FourWheel {
        half_wheelbase_m: f64,
        half_track_m: f64,
    },
    TwoWheel {
        half_wheelbase_m: f64,
    },
    Point,
}

impl ContactGeometry {
    /// The contact layout of an actor class. `wheelbase_m` is the resolved
    /// physics profile's wheelbase (absent for bodies without a plant).
    pub fn for_actor(kind: ActorKind, dims: &Dims, wheelbase_m: Option<f64>) -> Self {
        let wheelbase = wheelbase_m.filter(|w| w.is_finite() && *w > 0.0);
        match (kind, wheelbase) {
            (
                ActorKind::Vehicle
                | ActorKind::Car
                | ActorKind::Truck
                | ActorKind::Bus
                | ActorKind::Van,
                Some(wheelbase),
            ) => Self::FourWheel {
                half_wheelbase_m: 0.5 * wheelbase.min(dims.l),
                half_track_m: 0.5 * TRACK_WIDTH_FRACTION * dims.w,
            },
            (ActorKind::Motorcycle | ActorKind::Bicycle | ActorKind::Scooter, Some(wheelbase)) => {
                Self::TwoWheel {
                    half_wheelbase_m: 0.5 * wheelbase.min(dims.l),
                }
            }
            _ => Self::Point,
        }
    }

    /// Plan positions of the four probes `[FL, FR, RL, RR]` (two-wheelers:
    /// front, front, rear, rear; points: the centre four times).
    pub fn probes(&self, x: f64, y: f64, heading_rad: f64) -> [(f64, f64); 4] {
        let (sin, cos) = sin_cos(heading_rad);
        let (a, b) = match *self {
            Self::FourWheel {
                half_wheelbase_m,
                half_track_m,
            } => (half_wheelbase_m, half_track_m),
            Self::TwoWheel { half_wheelbase_m } => (half_wheelbase_m, 0.0),
            Self::Point => (0.0, 0.0),
        };
        // forward (cos, sin), left (-sin, cos)
        let at =
            |along: f64, left: f64| (x + along * cos - left * sin, y + along * sin + left * cos);
        [at(a, b), at(a, -b), at(-a, b), at(-a, -b)]
    }
}

/// Per-actor contact state carried from tick to tick (and in checkpoints).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactState {
    /// False before the first contact and whenever the body is absent: the
    /// next contact chooses its deck from the hint instead of the previous
    /// wheel elevations.
    pub grounded: bool,
    /// Contact elevation of each probe on the last tick.
    pub wheel_z: [f64; 4],
    /// Probes with no ground under them on the last tick (hanging wheels).
    #[serde(default)]
    pub unsupported: [bool; 4],
    /// Footprint centre on the last tick.
    pub x: f64,
    pub y: f64,
    /// What the trace records.
    pub frame: ContactFrame,
}

/// Why a body could not be grounded.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ContactError {
    /// Too few wheels have ground under them to carry the body (fewer than
    /// three for a four-wheeler, any for a two-wheeler or a point body): it
    /// has left the rendered map.
    #[error("{label}: {supported} of {needed} contacts have ground under them at x={x:.3} y={y:.3}; first miss: {first}")]
    Unsupported {
        label: String,
        supported: usize,
        needed: usize,
        x: f64,
        y: f64,
        first: GroundError,
    },
    #[error("{0}")]
    Ground(#[from] GroundError),
}

impl ContactState {
    fn supported(&self, probe: usize) -> bool {
        !self.unsupported[probe]
    }

    /// Whether any wheel hangs over a hole in the rendered map.
    pub fn any_unsupported(&self) -> bool {
        self.unsupported.iter().any(|u| *u)
    }
}

/// Ground one body. `road_hint` is the OpenDRIVE road the body is on (its
/// lane's road), which disambiguates overlapping decks for the spawn hint.
///
/// A four-wheeler whose footprint overhangs a hole in the rendered map (a
/// U-turn swinging a bumper past the terrain edge) rests on the wheels that
/// have ground: with three it sits on the plane through them and the fourth
/// hangs (`unsupported`, reported by the engine as
/// `ground_wheel_unsupported`); with fewer it has left the map and the
/// contact fails.
#[allow(clippy::too_many_arguments)]
pub fn solve_contact(
    ground: &GroundContext,
    geometry: ContactGeometry,
    x: f64,
    y: f64,
    heading_rad: f64,
    previous: &ContactState,
    road_hint: Option<i64>,
    label: &str,
) -> Result<ContactState, ContactError> {
    if !x.is_finite() || !y.is_finite() || !heading_rad.is_finite() {
        return Err(GroundError::NonFinitePosition.into());
    }
    let probes = geometry.probes(x, y, heading_rad);
    let reseat = !previous.grounded
        || (x - previous.x) * (x - previous.x) + (y - previous.y) * (y - previous.y)
            > RESEAT_DISTANCE_M * RESEAT_DISTANCE_M;
    let mut wheel_z: [Option<f64>; 4] = [None; 4];
    let mut first_miss: Option<GroundError> = None;
    for (i, (px, py)) in probes.iter().copied().enumerate() {
        // Points and two-wheelers repeat probes: reuse the first answer.
        if let Some(j) = (0..i).find(|&j| probes[j] == (px, py)) {
            wheel_z[i] = wheel_z[j];
            continue;
        }
        let hit = if reseat || !previous.supported(i) {
            // Choose the deck: the surface nearest the OpenDRIVE lane
            // elevation there (a hint, never a height). Without a usable hint
            // the body is placed on the topmost surface.
            let hint = ground.deck_hint.as_ref().and_then(|field| {
                field
                    .elevation(
                        px,
                        py,
                        HeightQuery {
                            preferred_road: road_hint,
                            label: Some(label),
                            continuity_z: None,
                        },
                    )
                    .ok()
            });
            let reference = if !reseat {
                Some(previous.wheel_z[i])
            } else {
                hint
            };
            match reference {
                Some(z_ref) => ground.surface.nearest_surface(px, py, z_ref, Some(label)),
                None => ground.surface.top(px, py, Some(label)),
            }
        } else {
            ground
                .surface
                .contact(px, py, previous.wheel_z[i], DEFAULT_STEP_UP_M, Some(label))
        };
        match hit {
            Ok(hit) => wheel_z[i] = Some(hit.z),
            Err(GroundError::NonFinitePosition) => {
                return Err(GroundError::NonFinitePosition.into())
            }
            Err(e) => {
                first_miss.get_or_insert(e);
            }
        }
    }
    let supported = wheel_z.iter().filter(|z| z.is_some()).count();
    let needed = match geometry {
        ContactGeometry::FourWheel { .. } => 3,
        ContactGeometry::TwoWheel { .. } | ContactGeometry::Point => 4,
    };
    if supported < needed {
        return Err(ContactError::Unsupported {
            label: label.to_owned(),
            supported,
            needed,
            x,
            y,
            first: first_miss.expect("a miss was recorded"),
        });
    }
    let frame = match wheel_z {
        [Some(fl), Some(fr), Some(rl), Some(rr)] => fit(geometry, &[fl, fr, rl, rr]),
        _ => fit_three(geometry, &wheel_z),
    };
    // Hanging wheels continue from the body plane.
    let resolved = plane_heights(geometry, &frame);
    let mut z = [0.0; 4];
    let mut unsupported = [false; 4];
    for i in 0..4 {
        match wheel_z[i] {
            Some(v) => z[i] = v,
            None => {
                z[i] = resolved[i];
                unsupported[i] = true;
            }
        }
    }
    Ok(ContactState {
        grounded: true,
        wheel_z: z,
        unsupported,
        x,
        y,
        frame,
    })
}

/// Probe layout `(along, left)` of `[FL, FR, RL, RR]` in body metres.
fn layout(geometry: ContactGeometry) -> [(f64, f64); 4] {
    let (a, b) = match geometry {
        ContactGeometry::FourWheel {
            half_wheelbase_m,
            half_track_m,
        } => (half_wheelbase_m, half_track_m),
        ContactGeometry::TwoWheel { half_wheelbase_m } => (half_wheelbase_m, 0.0),
        ContactGeometry::Point => (0.0, 0.0),
    };
    [(a, b), (a, -b), (-a, b), (-a, -b)]
}

/// Body-plane elevation at each probe.
fn plane_heights(geometry: ContactGeometry, frame: &ContactFrame) -> [f64; 4] {
    // z(u, v) = z0 - u * tan(pitch) + v * tan(roll)
    let (gu, gv) = (
        -crate::math::tan(frame.pitch_rad),
        crate::math::tan(frame.roll_rad),
    );
    layout(geometry).map(|(u, v)| frame.z + gu * u + gv * v)
}

/// The plane through three supported wheels of a four-wheeler.
fn fit_three(geometry: ContactGeometry, z: &[Option<f64>; 4]) -> ContactFrame {
    let points: Vec<((f64, f64), f64)> = layout(geometry)
        .into_iter()
        .zip(z.iter())
        .filter_map(|(p, z)| z.map(|z| (p, z)))
        .take(3)
        .collect();
    let [(p0, z0), (p1, z1), (p2, z2)] = [points[0], points[1], points[2]];
    // Solve z = c + gu*u + gv*v through three points.
    let (du1, dv1, dz1) = (p1.0 - p0.0, p1.1 - p0.1, z1 - z0);
    let (du2, dv2, dz2) = (p2.0 - p0.0, p2.1 - p0.1, z2 - z0);
    let det = du1 * dv2 - du2 * dv1;
    let gu = (dz1 * dv2 - dz2 * dv1) / det;
    let gv = (du1 * dz2 - du2 * dz1) / det;
    let c = z0 - gu * p0.0 - gv * p0.1;
    ContactFrame {
        z: c,
        pitch_rad: atan(-gu),
        roll_rad: atan(gv),
        wheel_drop_m: [0.0; 4],
    }
}

/// The body plane through the probe contacts.
pub fn fit(geometry: ContactGeometry, z: &[f64; 4]) -> ContactFrame {
    match geometry {
        ContactGeometry::FourWheel {
            half_wheelbase_m,
            half_track_m,
        } => {
            let [fl, fr, rl, rr] = *z;
            let centre = 0.25 * (fl + fr + rl + rr);
            let pitch = atan(((rl + rr) - (fl + fr)) / (4.0 * half_wheelbase_m));
            let roll = atan(((fl + rl) - (fr + rr)) / (4.0 * half_track_m));
            // Least-squares residual of a symmetric rectangle: the twist.
            let twist = 0.25 * (fl - fr - rl + rr);
            ContactFrame {
                z: centre,
                pitch_rad: pitch,
                roll_rad: roll,
                wheel_drop_m: [twist, -twist, -twist, twist],
            }
        }
        ContactGeometry::TwoWheel { half_wheelbase_m } => {
            let (front, rear) = (z[0], z[2]);
            ContactFrame {
                z: 0.5 * (front + rear),
                pitch_rad: atan((rear - front) / (2.0 * half_wheelbase_m)),
                roll_rad: 0.0,
                wheel_drop_m: [0.0; 4],
            }
        }
        ContactGeometry::Point => ContactFrame {
            z: z[0],
            pitch_rad: 0.0,
            roll_rad: 0.0,
            wheel_drop_m: [0.0; 4],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::ground::{encode_ground_mesh, SurfaceClass};

    /// A 40 m x 40 m plane `z = 10 + 0.05 x + 0.02 y` plus a flat deck at
    /// z = 20 over x in 15..25.
    fn ground() -> GroundContext {
        let z = |x: f64, y: f64| ((10.0 + 0.05 * x + 0.02 * y) * 1000.0).round() as i32;
        let v = vec![
            [-20_000, -20_000, z(-20.0, -20.0)],
            [20_000, -20_000, z(20.0, -20.0)],
            [20_000, 20_000, z(20.0, 20.0)],
            [-20_000, 20_000, z(-20.0, 20.0)],
            [15_000, -20_000, 20_000],
            [25_000, -20_000, 20_000],
            [25_000, 20_000, 20_000],
            [15_000, 20_000, 20_000],
        ];
        let t = vec![[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]];
        let c = vec![
            SurfaceClass::Road,
            SurfaceClass::Road,
            SurfaceClass::Bridge,
            SurfaceClass::Bridge,
        ];
        GroundContext::new(
            GroundSurface::decode(&encode_ground_mesh(&v, &t, &c)).unwrap(),
            None,
        )
    }

    #[test]
    fn a_car_sits_on_the_plane_through_its_wheels() {
        let g = ground();
        let geometry = ContactGeometry::FourWheel {
            half_wheelbase_m: 1.35,
            half_track_m: 0.8,
        };
        // Heading +x: the road climbs 5 % ahead (nose up = negative pitch)
        // and 2 % to the left (left side up = right side down = positive roll).
        let s = solve_contact(
            &g,
            geometry,
            0.0,
            0.0,
            0.0,
            &ContactState::default(),
            None,
            "car",
        )
        .unwrap();
        assert!((s.frame.z - 10.0).abs() < 1e-3);
        assert!((s.frame.pitch_rad - atan(-0.05)).abs() < 1e-3);
        assert!((s.frame.roll_rad - atan(0.02)).abs() < 1e-3);
        assert!(s.frame.wheel_drop_m.iter().all(|d| d.abs() < 1e-3));
        // Every wheel contact lies on the body plane.
        for (i, (along, left)) in [(1.35, 0.8), (1.35, -0.8), (-1.35, 0.8), (-1.35, -0.8)]
            .into_iter()
            .enumerate()
        {
            let body = s.frame.z - along * s.frame.pitch_rad.tan() + left * s.frame.roll_rad.tan();
            assert!((body - s.wheel_z[i]).abs() < 1e-3, "wheel {i}");
        }
    }

    #[test]
    fn a_body_stays_on_its_deck_and_a_miss_is_an_error() {
        let g = ground();
        let geometry = ContactGeometry::Point;
        // Placed without a hint: the topmost surface (the deck).
        let on_deck = solve_contact(
            &g,
            geometry,
            20.0,
            0.0,
            0.0,
            &ContactState::default(),
            None,
            "p",
        )
        .unwrap();
        assert_eq!(on_deck.frame.z, 20.0);
        let next = solve_contact(&g, geometry, 20.5, 0.0, 0.0, &on_deck, None, "p").unwrap();
        assert_eq!(next.frame.z, 20.0);
        // Under the deck: a body at road level stays on the road.
        let under = ContactState {
            grounded: true,
            unsupported: [false; 4],
            wheel_z: [11.0; 4],
            x: 19.3,
            y: 0.0,
            frame: ContactFrame::default(),
        };
        let road = solve_contact(&g, geometry, 19.5, 0.0, 0.0, &under, None, "p").unwrap();
        assert!((road.frame.z - 10.975).abs() < 1e-3);
        // Off the surface.
        assert!(solve_contact(&g, geometry, 60.0, 0.0, 0.0, &on_deck, None, "p").is_err());
    }

    #[test]
    fn two_wheelers_pitch_but_never_roll() {
        let g = ground();
        let geometry = ContactGeometry::TwoWheel {
            half_wheelbase_m: 0.7,
        };
        let s = solve_contact(
            &g,
            geometry,
            0.0,
            0.0,
            1.5707963267948966,
            &ContactState::default(),
            None,
            "bike",
        )
        .unwrap();
        // Heading +y: 2 % climb ahead.
        assert!((s.frame.pitch_rad - atan(-0.02)).abs() < 1e-3);
        assert_eq!(s.frame.roll_rad, 0.0);
    }
}
