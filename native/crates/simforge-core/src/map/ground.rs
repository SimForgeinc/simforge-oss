//! The map's one authoritative ground surface (`simforge.map-ground.v1`).
//!
//! Wheels must touch what cameras see. The surface is therefore the rendered
//! road/ground mesh itself: the map ingest stage (`derived/ground/`) extracts
//! every road, bridge, gutter, sidewalk, paved, terrain, curb-top and marking
//! triangle from the map master, re-frames it to xodr-local (x east, y north,
//! z up) and quantises vertices to integer millimetres. OpenDRIVE elevation is
//! used only as a *deck hint* (which of several stacked surfaces a body is on
//! at spawn), never as a height.
//!
//! Every query is deterministic `f64` arithmetic over integer-millimetre
//! vertices, so native, WASM and Python produce identical bits. A query that
//! finds no surface is an error; nothing here ever answers `0` or a default.
//!
//! ## Binary layout (`ground-mesh.bin`, little endian)
//!
//! ```text
//! magic        8 bytes  b"SFGRND01"
//! vertexCount  u32
//! triangleCount u32
//! vertices     vertexCount   x (i32 x_mm, i32 y_mm, i32 z_mm)
//! triangles    triangleCount x (u32 a, u32 b, u32 c)
//! classes      triangleCount x u8   (SurfaceClass)
//! ```
//!
//! The digest is `sha256` of those bytes; it is the render timeline's
//! `heightFieldDigest` and part of the simulation input identity.

use crate::hash::sha256_bytes;

/// Magic prefix of `ground-mesh.bin` format 1.
pub const GROUND_MESH_MAGIC: &[u8; 8] = b"SFGRND01";
/// Schema of the derivative manifest that names the mesh.
pub const GROUND_SCHEMA: &str = "simforge.map-ground.v1";
/// Closure member of the mesh.
pub const GROUND_MESH_MEMBER: &str = "derived/ground/ground-mesh.bin";
/// Closure member of the manifest.
pub const GROUND_MANIFEST_MEMBER: &str = "derived/ground/ground-manifest.json";

/// A point this close (horizontally) to a triangle counts as on it. Adjacent
/// exporter meshes (road / gutter / sidewalk layers) meet at shared edges but
/// are not welded; float export leaves hairline cracks well under a
/// centimetre. The tolerance is part of the surface definition, not a
/// fallback: anything farther is a hole and an error.
pub const SEAM_TOLERANCE_M: f64 = 0.05;
/// Largest rise a wheel follows between two consecutive contacts (a kerb is
/// 0.10-0.20 m). A surface higher than `z_ref + step` is overhead: a bridge
/// deck above a road is never snapped onto from below.
pub const DEFAULT_STEP_UP_M: f64 = 0.35;
/// Two surfaces closer than this are the same surface (a lane-marking decal
/// floating on asphalt).
const SAME_SURFACE_M: f64 = 1e-4;
const CELL_MM: i64 = 4_000;
const HEADER_BYTES: usize = 16;

/// What a surface triangle is. Stored per triangle; reported with contacts so
/// consumers (and the ingest report) can tell asphalt from grass or a kerb.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum SurfaceClass {
    Road = 1,
    Bridge = 2,
    Gutter = 3,
    Sidewalk = 4,
    /// Exporter "uncategorized" road surface: parking lots, driveways, plazas.
    Paved = 5,
    Terrain = 6,
    /// Top faces of kerbs (vertical faces are dropped at ingest).
    Curb = 7,
    /// Paint and decals.
    Marking = 8,
}

impl SurfaceClass {
    pub fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            1 => Self::Road,
            2 => Self::Bridge,
            3 => Self::Gutter,
            4 => Self::Sidewalk,
            5 => Self::Paved,
            6 => Self::Terrain,
            7 => Self::Curb,
            8 => Self::Marking,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Road => "road",
            Self::Bridge => "bridge",
            Self::Gutter => "gutter",
            Self::Sidewalk => "sidewalk",
            Self::Paved => "paved",
            Self::Terrain => "terrain",
            Self::Curb => "curb",
            Self::Marking => "marking",
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum GroundError {
    #[error("ground_mesh_invalid:{0}")]
    Invalid(String),
    #[error("ground_non_finite_position")]
    NonFinitePosition,
    /// No surface triangle under `(x, y)`: the body is off the rendered map.
    #[error("ground_no_surface{label}:x={x:.3}:y={y:.3}")]
    NoSurface { label: String, x: f64, y: f64 },
    /// Surfaces exist under `(x, y)` but every one is higher than the body can
    /// step up to (it is below the whole map there).
    #[error(
        "ground_no_surface_in_step{label}:x={x:.3}:y={y:.3}:zRef={z_ref:.3}:lowest={lowest:.3}"
    )]
    NoSurfaceInStep {
        label: String,
        x: f64,
        y: f64,
        z_ref: f64,
        lowest: f64,
    },
}

/// One surface under a query point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SurfaceHit {
    /// Surface elevation, xodr-local metres.
    pub z: f64,
    pub class: SurfaceClass,
    /// Index of the triangle that answered.
    pub triangle: u32,
}

/// The decoded ground surface with its query grid.
#[derive(Debug, Clone)]
pub struct GroundSurface {
    vertices: Vec<[i32; 3]>,
    triangles: Vec<[u32; 3]>,
    classes: Vec<SurfaceClass>,
    grid_min: (i64, i64),
    grid_dims: (i64, i64),
    cell_start: Vec<u32>,
    cell_items: Vec<u32>,
    digest: String,
    bounds_mm: [i32; 4],
    median_z_mm: i32,
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"))
}

fn read_i32(bytes: &[u8], at: usize) -> i32 {
    i32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"))
}

fn cell_of_mm(v: i64) -> i64 {
    v.div_euclid(CELL_MM)
}

impl GroundSurface {
    /// Decode and index `ground-mesh.bin` bytes. Rejects anything malformed:
    /// a truncated file, an out-of-range index, an unknown class or an empty
    /// surface.
    pub fn decode(bytes: &[u8]) -> Result<Self, GroundError> {
        if bytes.len() < HEADER_BYTES || &bytes[..8] != GROUND_MESH_MAGIC {
            return Err(GroundError::Invalid("bad magic".to_owned()));
        }
        let vertex_count = read_u32(bytes, 8) as usize;
        let triangle_count = read_u32(bytes, 12) as usize;
        let expected = HEADER_BYTES + vertex_count * 12 + triangle_count * 13;
        if bytes.len() != expected {
            return Err(GroundError::Invalid(format!(
                "length {} != expected {expected}",
                bytes.len()
            )));
        }
        if vertex_count == 0 || triangle_count == 0 {
            return Err(GroundError::Invalid("empty surface".to_owned()));
        }
        let mut vertices = Vec::with_capacity(vertex_count);
        let mut at = HEADER_BYTES;
        for _ in 0..vertex_count {
            vertices.push([
                read_i32(bytes, at),
                read_i32(bytes, at + 4),
                read_i32(bytes, at + 8),
            ]);
            at += 12;
        }
        let mut triangles = Vec::with_capacity(triangle_count);
        for index in 0..triangle_count {
            let tri = [
                read_u32(bytes, at),
                read_u32(bytes, at + 4),
                read_u32(bytes, at + 8),
            ];
            if tri.iter().any(|&v| v as usize >= vertex_count) {
                return Err(GroundError::Invalid(format!(
                    "triangle {index} indexes past {vertex_count} vertices"
                )));
            }
            triangles.push(tri);
            at += 12;
        }
        let mut classes = Vec::with_capacity(triangle_count);
        for index in 0..triangle_count {
            let raw = bytes[at + index];
            classes.push(SurfaceClass::from_u8(raw).ok_or_else(|| {
                GroundError::Invalid(format!("triangle {index} has unknown class {raw}"))
            })?);
        }
        let mut surface = Self {
            vertices,
            triangles,
            classes,
            grid_min: (0, 0),
            grid_dims: (0, 0),
            cell_start: Vec::new(),
            cell_items: Vec::new(),
            digest: sha256_bytes(bytes),
            bounds_mm: [0; 4],
            median_z_mm: 0,
        };
        surface.build_grid();
        Ok(surface)
    }

    fn build_grid(&mut self) {
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for v in &self.vertices {
            min_x = min_x.min(v[0]);
            min_y = min_y.min(v[1]);
            max_x = max_x.max(v[0]);
            max_y = max_y.max(v[1]);
        }
        self.bounds_mm = [min_x, min_y, max_x, max_y];
        let mut z: Vec<i32> = self.vertices.iter().map(|v| v[2]).collect();
        let middle = z.len() / 2;
        z.select_nth_unstable(middle);
        self.median_z_mm = z[middle];
        // Pad by the seam tolerance so a point just outside the outermost
        // triangle still finds it.
        let pad = (SEAM_TOLERANCE_M * 1000.0) as i64 + 1;
        let gx0 = cell_of_mm(min_x as i64 - pad);
        let gy0 = cell_of_mm(min_y as i64 - pad);
        let gx1 = cell_of_mm(max_x as i64 + pad);
        let gy1 = cell_of_mm(max_y as i64 + pad);
        let nx = gx1 - gx0 + 1;
        let ny = gy1 - gy0 + 1;
        self.grid_min = (gx0, gy0);
        self.grid_dims = (nx, ny);
        let cells = (nx * ny) as usize;
        let mut counts = vec![0u32; cells + 1];
        let mut spans = Vec::with_capacity(self.triangles.len());
        for tri in &self.triangles {
            let [a, b, c] = tri.map(|i| self.vertices[i as usize]);
            let x0 = cell_of_mm(a[0].min(b[0]).min(c[0]) as i64 - pad) - gx0;
            let x1 = cell_of_mm(a[0].max(b[0]).max(c[0]) as i64 + pad) - gx0;
            let y0 = cell_of_mm(a[1].min(b[1]).min(c[1]) as i64 - pad) - gy0;
            let y1 = cell_of_mm(a[1].max(b[1]).max(c[1]) as i64 + pad) - gy0;
            for cy in y0..=y1 {
                for cx in x0..=x1 {
                    counts[(cy * nx + cx) as usize + 1] += 1;
                }
            }
            spans.push((x0, x1, y0, y1));
        }
        for i in 1..counts.len() {
            counts[i] += counts[i - 1];
        }
        let mut fill = counts.clone();
        let mut items = vec![0u32; counts[cells] as usize];
        for (index, (x0, x1, y0, y1)) in spans.into_iter().enumerate() {
            for cy in y0..=y1 {
                for cx in x0..=x1 {
                    let cell = (cy * nx + cx) as usize;
                    items[fill[cell] as usize] = index as u32;
                    fill[cell] += 1;
                }
            }
        }
        self.cell_start = counts;
        self.cell_items = items;
    }

    /// `sha256` of the encoded mesh.
    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }

    /// Median vertex elevation of the surface, metres: the map's reference
    /// ground level (atmosphere anchor), never a body height.
    pub fn median_z(&self) -> f64 {
        self.median_z_mm as f64 / 1000.0
    }

    /// `[min_x, min_y, max_x, max_y]` of the surface, metres.
    pub fn bounds(&self) -> [f64; 4] {
        self.bounds_mm.map(|v| v as f64 / 1000.0)
    }

    fn cell_members(&self, x: f64, y: f64) -> &[u32] {
        let cx = cell_of_mm((x * 1000.0).floor() as i64) - self.grid_min.0;
        let cy = cell_of_mm((y * 1000.0).floor() as i64) - self.grid_min.1;
        if cx < 0 || cy < 0 || cx >= self.grid_dims.0 || cy >= self.grid_dims.1 {
            return &[];
        }
        let cell = (cy * self.grid_dims.0 + cx) as usize;
        &self.cell_items[self.cell_start[cell] as usize..self.cell_start[cell + 1] as usize]
    }

    fn corners(&self, triangle: u32) -> [[f64; 3]; 3] {
        self.triangles[triangle as usize].map(|i| {
            let v = self.vertices[i as usize];
            [
                v[0] as f64 / 1000.0,
                v[1] as f64 / 1000.0,
                v[2] as f64 / 1000.0,
            ]
        })
    }

    /// Height of `triangle`'s plane at `(x, y)` when the point lies on the
    /// triangle (or within the seam tolerance of it, measured horizontally).
    fn triangle_height(&self, triangle: u32, x: f64, y: f64) -> Option<f64> {
        let [a, b, c] = self.corners(triangle);
        let (e0x, e0y) = (b[0] - a[0], b[1] - a[1]);
        let (e1x, e1y) = (c[0] - a[0], c[1] - a[1]);
        let den = e0x * e1y - e1x * e0y;
        // Vertical or degenerate in plan: carries no ground height.
        if den.abs() < 1e-9 {
            return None;
        }
        let (px, py) = (x - a[0], y - a[1]);
        let v = (px * e1y - e1x * py) / den;
        let w = (e0x * py - px * e0y) / den;
        let u = 1.0 - v - w;
        const EPS: f64 = 1e-12;
        if u >= -EPS && v >= -EPS && w >= -EPS {
            return Some(u * a[2] + v * b[2] + w * c[2]);
        }
        // Outside: accept a hairline seam. Distance from the point to the
        // triangle in plan, then the height of the plane at the query point.
        let d2 = [(a, b), (b, c), (c, a)]
            .iter()
            .map(|(p, q)| segment_distance2(x, y, p[0], p[1], q[0], q[1]))
            .fold(f64::INFINITY, f64::min);
        if d2 <= SEAM_TOLERANCE_M * SEAM_TOLERANCE_M {
            // Clamp the barycentric weights onto the triangle so a steep
            // triangle's plane is not extrapolated away from its edge.
            let (u, v, w) = (u.max(0.0), v.max(0.0), w.max(0.0));
            let sum = u + v + w;
            return Some((u * a[2] + v * b[2] + w * c[2]) / sum);
        }
        None
    }

    /// Every distinct surface under `(x, y)`, highest first.
    pub fn surfaces_at(&self, x: f64, y: f64) -> Result<Vec<SurfaceHit>, GroundError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(GroundError::NonFinitePosition);
        }
        let mut exact: Vec<SurfaceHit> = Vec::new();
        for &triangle in self.cell_members(x, y) {
            if let Some(z) = self.triangle_height(triangle, x, y) {
                exact.push(SurfaceHit {
                    z,
                    class: self.classes[triangle as usize],
                    triangle,
                });
            }
        }
        // Highest first; ties by class then triangle index, so the answer
        // never depends on grid insertion order.
        exact.sort_by(|a, b| {
            b.z.total_cmp(&a.z)
                .then(a.class.cmp(&b.class))
                .then(a.triangle.cmp(&b.triangle))
        });
        exact.dedup_by(|next, kept| (kept.z - next.z).abs() <= SAME_SURFACE_M);
        Ok(exact)
    }

    /// The surface a body resting at `z_ref` stands on at `(x, y)`: the highest
    /// surface no more than `step_up_m` above `z_ref`. This is a downward ray
    /// from just above the body, so a deck overhead is never snapped onto and
    /// a kerb up to `step_up_m` is climbed.
    pub fn contact(
        &self,
        x: f64,
        y: f64,
        z_ref: f64,
        step_up_m: f64,
        label: Option<&str>,
    ) -> Result<SurfaceHit, GroundError> {
        let surfaces = self.surfaces_at(x, y)?;
        let label = label.map(|l| format!(":{l}")).unwrap_or_default();
        if surfaces.is_empty() {
            return Err(GroundError::NoSurface { label, x, y });
        }
        let ceiling = z_ref + step_up_m;
        surfaces
            .iter()
            .find(|hit| hit.z <= ceiling)
            .copied()
            .ok_or_else(|| GroundError::NoSurfaceInStep {
                label,
                x,
                y,
                z_ref,
                lowest: surfaces.last().map(|h| h.z).unwrap_or(f64::NAN),
            })
    }

    /// The surface nearest `z_hint` at `(x, y)`: chooses the deck at spawn
    /// (the hint is the OpenDRIVE lane elevation, which may be off by a metre
    /// but never by a storey). Ties go to the higher surface.
    pub fn nearest_surface(
        &self,
        x: f64,
        y: f64,
        z_hint: f64,
        label: Option<&str>,
    ) -> Result<SurfaceHit, GroundError> {
        let surfaces = self.surfaces_at(x, y)?;
        surfaces
            .iter()
            .min_by(|a, b| {
                (a.z - z_hint)
                    .abs()
                    .total_cmp(&(b.z - z_hint).abs())
                    .then(b.z.total_cmp(&a.z))
            })
            .copied()
            .ok_or_else(|| GroundError::NoSurface {
                label: label.map(|l| format!(":{l}")).unwrap_or_default(),
                x,
                y,
            })
    }

    /// The topmost surface at `(x, y)` (what a camera looking straight down
    /// sees). For maps without stacked decks this is the only surface.
    pub fn top(&self, x: f64, y: f64, label: Option<&str>) -> Result<SurfaceHit, GroundError> {
        let surfaces = self.surfaces_at(x, y)?;
        surfaces
            .first()
            .copied()
            .ok_or_else(|| GroundError::NoSurface {
                label: label.map(|l| format!(":{l}")).unwrap_or_default(),
                x,
                y,
            })
    }
}

fn segment_distance2(x: f64, y: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((x - ax) * dx + (y - ay) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (px, py) = (ax + t * dx - x, ay + t * dy - y);
    px * px + py * py
}

/// Encode a surface (tests, fixtures and the synthetic builders). The map
/// pipeline's TypeScript encoder writes the same bytes.
pub fn encode_ground_mesh(
    vertices_mm: &[[i32; 3]],
    triangles: &[[u32; 3]],
    classes: &[SurfaceClass],
) -> Vec<u8> {
    assert_eq!(triangles.len(), classes.len());
    let mut out = Vec::with_capacity(HEADER_BYTES + vertices_mm.len() * 12 + triangles.len() * 13);
    out.extend_from_slice(GROUND_MESH_MAGIC);
    out.extend_from_slice(&(vertices_mm.len() as u32).to_le_bytes());
    out.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
    for v in vertices_mm {
        for c in v {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    for t in triangles {
        for c in t {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    out.extend(classes.iter().map(|c| *c as u8));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 20 m x 20 m road at z = 10 with a bridge deck 5 m above its middle
    /// strip (x in 8..12), and a 0.15 m kerb-top strip at y in 18..20.
    fn fixture() -> GroundSurface {
        let mm = |x: f64, y: f64, z: f64| {
            [
                (x * 1000.0) as i32,
                (y * 1000.0) as i32,
                (z * 1000.0) as i32,
            ]
        };
        let mut v = Vec::new();
        let mut t = Vec::new();
        let mut c = Vec::new();
        let mut quad = |corners: [[i32; 3]; 4], class: SurfaceClass| {
            let base = v.len() as u32;
            v.extend_from_slice(&corners);
            t.push([base, base + 1, base + 2]);
            t.push([base, base + 2, base + 3]);
            c.push(class);
            c.push(class);
        };
        quad(
            [
                mm(0.0, 0.0, 10.0),
                mm(20.0, 0.0, 10.0),
                mm(20.0, 18.0, 10.0),
                mm(0.0, 18.0, 10.0),
            ],
            SurfaceClass::Road,
        );
        quad(
            [
                mm(8.0, 0.0, 15.0),
                mm(12.0, 0.0, 15.0),
                mm(12.0, 18.0, 15.0),
                mm(8.0, 18.0, 15.0),
            ],
            SurfaceClass::Bridge,
        );
        quad(
            [
                mm(0.0, 18.0, 10.15),
                mm(20.0, 18.0, 10.15),
                mm(20.0, 20.0, 10.15),
                mm(0.0, 20.0, 10.15),
            ],
            SurfaceClass::Curb,
        );
        GroundSurface::decode(&encode_ground_mesh(&v, &t, &c)).unwrap()
    }

    #[test]
    fn contact_follows_the_deck_the_body_is_on() {
        let g = fixture();
        // Under the bridge: a body at road level stays on the road.
        let hit = g.contact(10.0, 5.0, 10.0, DEFAULT_STEP_UP_M, None).unwrap();
        assert_eq!(hit.z, 10.0);
        assert_eq!(hit.class, SurfaceClass::Road);
        // On the bridge: stays on the deck.
        let hit = g.contact(10.0, 5.0, 15.0, DEFAULT_STEP_UP_M, None).unwrap();
        assert_eq!(hit.z, 15.0);
        assert_eq!(hit.class, SurfaceClass::Bridge);
        // Climbs a kerb.
        let hit = g.contact(3.0, 19.0, 10.0, DEFAULT_STEP_UP_M, None).unwrap();
        assert!((hit.z - 10.15).abs() < 1e-9);
        assert_eq!(hit.class, SurfaceClass::Curb);
    }

    #[test]
    fn spawn_picks_the_surface_nearest_the_hint() {
        let g = fixture();
        assert_eq!(g.nearest_surface(10.0, 5.0, 14.2, None).unwrap().z, 15.0);
        assert_eq!(g.nearest_surface(10.0, 5.0, 11.0, None).unwrap().z, 10.0);
        assert_eq!(g.top(10.0, 5.0, None).unwrap().z, 15.0);
    }

    #[test]
    fn a_miss_is_an_error_never_zero() {
        let g = fixture();
        assert!(matches!(
            g.contact(40.0, 5.0, 10.0, DEFAULT_STEP_UP_M, Some("car")),
            Err(GroundError::NoSurface { .. })
        ));
        // Below the whole surface (e.g. a body that fell through): error.
        assert!(matches!(
            g.contact(3.0, 5.0, 2.0, DEFAULT_STEP_UP_M, None),
            Err(GroundError::NoSurfaceInStep { .. })
        ));
        assert!(matches!(
            g.surfaces_at(f64::NAN, 0.0),
            Err(GroundError::NonFinitePosition)
        ));
    }

    #[test]
    fn hairline_seams_are_part_of_the_surface_but_holes_are_not() {
        let g = fixture();
        // 3 cm outside the road's west edge: a seam.
        assert_eq!(g.top(-0.03, 5.0, None).unwrap().z, 10.0);
        // 20 cm outside: a hole.
        assert!(g.top(-0.2, 5.0, None).is_err());
    }

    #[test]
    fn decode_rejects_malformed_bytes() {
        assert!(GroundSurface::decode(b"nope").is_err());
        let mut bytes = encode_ground_mesh(
            &[[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            &[[0, 1, 2]],
            &[SurfaceClass::Road],
        );
        let last = bytes.len() - 1;
        bytes[last] = 99;
        assert!(GroundSurface::decode(&bytes).is_err());
        let bytes = encode_ground_mesh(&[[0, 0, 0]], &[[0, 1, 2]], &[SurfaceClass::Road]);
        assert!(GroundSurface::decode(&bytes).is_err());
    }

    /// The committed Richmond derivative (written by the TypeScript ingest
    /// stage) decodes here and answers exactly what the ingest report
    /// recorded: one byte layout, one query semantics, two languages.
    #[test]
    fn decodes_the_ingest_derivative_and_agrees_with_its_report() {
        let dir = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../fixtures/golden-traces/maps/richmond-field-station/derived/ground"
        );
        let bytes = std::fs::read(format!("{dir}/ground-mesh.bin")).unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(format!("{dir}/ground-manifest.json")).unwrap())
                .unwrap();
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(format!("{dir}/ground-report.json")).unwrap())
                .unwrap();
        let g = GroundSurface::decode(&bytes).unwrap();
        assert_eq!(g.digest(), manifest["mesh"]["sha256"].as_str().unwrap());
        assert_eq!(
            g.triangle_count() as u64,
            manifest["mesh"]["triangles"].as_u64().unwrap()
        );
        let roads = report["validation"]["flaggedRoads"].as_array().unwrap();
        assert!(roads.len() > 10);
        for road in roads {
            let w = &road["worst"];
            let (x, y) = (w["x"].as_f64().unwrap(), w["y"].as_f64().unwrap());
            let hit = g
                .nearest_surface(x, y, w["xodrZ"].as_f64().unwrap(), None)
                .unwrap();
            let expected = w["meshZ"].as_f64().unwrap();
            assert!(
                (hit.z - expected).abs() < 1e-4,
                "road {} at ({x}, {y}): {} vs {expected}",
                road["road"],
                hit.z
            );
        }
    }

    #[test]
    fn digest_is_the_sha256_of_the_bytes() {
        let bytes = encode_ground_mesh(
            &[[0, 0, 0], [1000, 0, 0], [0, 1000, 0]],
            &[[0, 1, 2]],
            &[SurfaceClass::Road],
        );
        let g = GroundSurface::decode(&bytes).unwrap();
        assert_eq!(g.digest(), sha256_bytes(&bytes));
        // A sloped triangle: z interpolates.
        let bytes = encode_ground_mesh(
            &[[0, 0, 0], [1000, 0, 100], [0, 1000, 0]],
            &[[0, 1, 2]],
            &[SurfaceClass::Road],
        );
        let g = GroundSurface::decode(&bytes).unwrap();
        assert!((g.top(0.5, 0.25, None).unwrap().z - 0.05).abs() < 1e-12);
    }
}
