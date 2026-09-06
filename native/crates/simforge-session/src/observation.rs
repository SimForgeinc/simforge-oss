//! Observation builders: ego state vector, perception-gated object list and
//! the ego-centric BEV raster. All three write into caller-owned buffers so a
//! stepping loop never allocates per decision.
//!
//! Actor iteration is in canonical id order (a per-episode permutation of the
//! engine's stable [`ActorIndex`] handles) so every output is independent of
//! engine-internal storage order.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use simforge_core::engine::visibility::{has_line_of_sight, OccluderShape, StaticOccluder};
use simforge_core::engine::{ActorIndex, ActorSnapshot};
use simforge_core::map::{LaneGraph, LaneId};
use simforge_core::math::{atan2, cos, hypot, obb_corners, sin, sin_cos, Obb, Vec2};
use simforge_core::types::Dims;

use crate::episode::{BevConfig, ObservationConfig};
use crate::error::{Result, SessionError};

/// Range reported for "nearest other actor" when the ego is alone.
pub const NEAREST_RANGE_SENTINEL_M: f64 = 1e6;

/// Ego state vector, fixed layout (documented contract, do not reorder):
///
/// | idx | meaning                                   | unit   |
/// |----:|-------------------------------------------|--------|
/// | 0   | x (xodr-local, east)                      | m      |
/// | 1   | y (xodr-local, north)                     | m      |
/// | 2   | cos(heading)                              | -      |
/// | 3   | sin(heading)                              | -      |
/// | 4   | speed                                     | m/s    |
/// | 5   | longitudinal acceleration                 | m/s²   |
/// | 6   | lane-relative lateral offset (+left)      | m      |
/// | 7   | lateral rate                              | m/s    |
/// | 8   | route arc length                          | m      |
/// | 9   | range to nearest other actor              | m      |
pub const STATE_VECTOR_SIZE: usize = 10;

pub const BEV_CHANNELS: usize = 3;

/// Perception-gated object entry, sorted by range then id.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerceivedObject {
    /// Engine handle; resolve the canonical id through the owning session.
    pub actor: ActorIndex,
    /// Range from the ego reference point, metres.
    pub range_m: f64,
    /// Bearing from the ego heading, radians, positive left, wrapped to [-π, π).
    pub bearing_rad: f64,
    /// Range rate (negative = closing), m/s.
    pub range_rate_mps: f64,
    /// Geometric line of sight was clear at this decision.
    pub line_of_sight: bool,
}

/// Ego-centric BEV raster: row-major `[row][col]`, channel-last within each
/// cell. Row 0 is farthest forward. Channels: 0 drivable lane surface, 1 the
/// ego's current lane surface, 2 other-actor OBB occupancy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BevRaster {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub resolution_m: f64,
    pub data: Vec<f32>,
}

impl BevRaster {
    pub fn new(cfg: &BevConfig) -> Self {
        let (width, height) = (cfg.width(), cfg.height());
        Self {
            width,
            height,
            channels: BEV_CHANNELS,
            resolution_m: cfg.resolution_m,
            data: vec![0.0; width * height * BEV_CHANNELS],
        }
    }
}

/// One decision's observation. Buffers are reused across decisions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub t_s: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_vector: Option<[f64; STATE_VECTOR_SIZE]>,
    pub objects: Vec<PerceivedObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bev: Option<BevRaster>,
}

impl Observation {
    pub fn new(cfg: &ObservationConfig) -> Self {
        Self {
            t_s: 0.0,
            state_vector: cfg.state_vector.then_some([0.0; STATE_VECTOR_SIZE]),
            objects: Vec::new(),
            bev: cfg.bev.as_ref().map(BevRaster::new),
        }
    }
}

/// A LOS relation evaluated for the causal channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LosPair {
    pub observer: ActorIndex,
    pub target: ActorIndex,
    pub visible: bool,
}

/// Static per-episode facts every builder needs. Rebuilt on reset (the actor
/// set is fixed for an episode; live worlds are `WorldSession`'s domain).
pub struct ObservationContext {
    pub graph: Arc<LaneGraph>,
    pub ego: ActorIndex,
    pub config: ObservationConfig,
    /// Actor handles in canonical id order (= snapshot row order).
    pub sorted: Vec<ActorIndex>,
    /// Snapshot row of each handle, indexed by `ActorIndex::index()`.
    pub slots: Vec<usize>,
    /// Dims indexed by `ActorIndex::index()`.
    pub dims: Vec<Dims>,
    pub static_occluders: Vec<StaticOccluder>,
    /// `(horizontal_fov_deg, far_m)` of every enabled ego sensor.
    pub sensor_apertures: Vec<(f64, f64)>,
}

impl ObservationContext {
    #[inline]
    fn dims_of(&self, actor: ActorIndex) -> &Dims {
        &self.dims[actor.index()]
    }

    /// The snapshot row of `actor` (rows are id-sorted; handles are stable).
    #[inline]
    pub fn actor<'a>(&self, actors: &'a [ActorSnapshot], actor: ActorIndex) -> &'a ActorSnapshot {
        &actors[self.slots[actor.index()]]
    }
}

#[inline]
fn wrap_pi(a: f64) -> f64 {
    let mut a = a;
    while a >= std::f64::consts::PI {
        a -= 2.0 * std::f64::consts::PI;
    }
    while a < -std::f64::consts::PI {
        a += 2.0 * std::f64::consts::PI;
    }
    a
}

/// Per-episode observation state (range-rate memory, LOS results) plus the
/// scratch buffers the builders reuse.
#[derive(Debug, Default)]
pub struct ObservationBuilders {
    /// Range at the previous decision, indexed by actor; NaN = none yet.
    prev_range: Vec<f64>,
    last_los: Vec<LosPair>,
    /// Scratch: other-actor OBB shapes for LOS, indexed by actor (`None` = ego).
    actor_shapes: Vec<Option<([Vec2; 4], Obb)>>,
    /// Scratch: BEV polygon row crossings.
    crossings: Vec<f64>,
}

impl ObservationBuilders {
    /// Drop per-episode memory and size scratch for `actor_count` actors.
    pub fn reset(&mut self, actor_count: usize) {
        self.prev_range.clear();
        self.prev_range.resize(actor_count, f64::NAN);
        self.last_los.clear();
        self.actor_shapes.clear();
        self.actor_shapes.resize(actor_count, None);
    }

    /// Range-rate memory (range at the previous decision per actor; NaN =
    /// none), for episode checkpoints.
    #[inline]
    pub fn range_memory(&self) -> &[f64] {
        &self.prev_range
    }

    /// Restore range-rate memory captured by [`range_memory`](Self::range_memory).
    pub fn restore_range_memory(&mut self, memory: &[f64]) {
        self.prev_range.clear();
        self.prev_range.extend_from_slice(memory);
        self.actor_shapes.clear();
        self.actor_shapes.resize(memory.len(), None);
        self.last_los.clear();
    }

    /// LOS pairs evaluated by the most recent `observe`, for the causal channel.
    #[inline]
    pub fn last_los(&self) -> &[LosPair] {
        &self.last_los
    }

    /// Build every configured channel for the frame at `t_s`. `dt_s` is the
    /// seconds since the previous decision (0 on reset).
    pub fn observe(
        &mut self,
        ctx: &ObservationContext,
        actors: &[ActorSnapshot],
        t_s: f64,
        dt_s: f64,
        out: &mut Observation,
    ) -> Result<()> {
        if ctx
            .slots
            .get(ctx.ego.index())
            .is_none_or(|&row| row >= actors.len())
        {
            return Err(SessionError::MissingEgo(format!("#{}", ctx.ego.index())));
        }
        let ego = ctx.actor(actors, ctx.ego);
        out.t_s = t_s;
        if let Some(sv) = &mut out.state_vector {
            Self::state_vector(ctx, actors, ego, sv);
        }
        self.object_list(ctx, actors, ego, dt_s, &mut out.objects);
        if let (Some(bev_cfg), Some(bev)) = (&ctx.config.bev, &mut out.bev) {
            self.bev(ctx, actors, ego, bev_cfg, bev);
        }
        Ok(())
    }

    fn state_vector(
        ctx: &ObservationContext,
        actors: &[ActorSnapshot],
        ego: &ActorSnapshot,
        v: &mut [f64; STATE_VECTOR_SIZE],
    ) {
        let mut nearest = NEAREST_RANGE_SENTINEL_M;
        for &idx in &ctx.sorted {
            if idx == ctx.ego {
                continue;
            }
            let a = ctx.actor(actors, idx);
            nearest = nearest.min(hypot(a.x - ego.x, a.y - ego.y));
        }
        v[0] = ego.x;
        v[1] = ego.y;
        v[2] = cos(ego.heading_rad);
        v[3] = sin(ego.heading_rad);
        v[4] = ego.speed_mps;
        v[5] = ego.accel_mps2;
        v[6] = ego.lateral_offset_m;
        v[7] = ego.lateral_rate_mps;
        v[8] = ego.s;
        v[9] = nearest;
    }

    /// Gating uses the engine's occluder layer: static occluders from the
    /// input plus every other actor's body OBB, with the target excluded. When
    /// the ego declares sensors, each object must fall inside some sensor's
    /// aperture (FOV + far range); otherwise a single 360° range gate applies.
    fn object_list(
        &mut self,
        ctx: &ObservationContext,
        actors: &[ActorSnapshot],
        ego: &ActorSnapshot,
        dt_s: f64,
        out: &mut Vec<PerceivedObject>,
    ) {
        for &idx in &ctx.sorted {
            let slot = &mut self.actor_shapes[idx.index()];
            if idx == ctx.ego {
                *slot = None;
                continue;
            }
            let a = ctx.actor(actors, idx);
            let d = ctx.dims_of(idx);
            let obb = Obb {
                center: Vec2 { x: a.x, y: a.y },
                length_m: d.l,
                width_m: d.w,
                heading_rad: a.heading_rad,
            };
            *slot = Some((obb_corners(&obb), obb));
        }
        let ego_p = Vec2 { x: ego.x, y: ego.y };

        out.clear();
        for &idx in &ctx.sorted {
            if idx == ctx.ego {
                continue;
            }
            let a = ctx.actor(actors, idx);
            let dx = a.x - ego.x;
            let dy = a.y - ego.y;
            let range = hypot(dx, dy);
            if range > ctx.config.object_list_range_m {
                continue;
            }
            let target_p = Vec2 { x: a.x, y: a.y };
            let statics = ctx.static_occluders.iter().map(StaticOccluder::shape);
            let bodies = ctx.sorted.iter().filter(|&&o| o != idx).filter_map(|&o| {
                self.actor_shapes[o.index()].map(|(corners, obb)| OccluderShape {
                    id: "",
                    group_id: None,
                    actor: Some(o),
                    obb,
                    height_m: ctx.dims_of(o).h,
                    corners,
                })
            });
            let los = has_line_of_sight(ego_p, target_p, statics.chain(bodies), f64::INFINITY);
            let bearing = wrap_pi(atan2(dy, dx) - ego.heading_rad);
            if !ctx.sensor_apertures.is_empty() {
                let seen = ctx.sensor_apertures.iter().any(|&(fov_deg, far_m)| {
                    range <= far_m && bearing.abs() <= fov_deg * std::f64::consts::PI / 360.0
                });
                if !seen {
                    continue;
                }
            }
            let prev = self.prev_range[idx.index()];
            let range_rate = if !prev.is_nan() && dt_s > 0.0 {
                (range - prev) / dt_s
            } else {
                0.0
            };
            self.prev_range[idx.index()] = range;
            out.push(PerceivedObject {
                actor: idx,
                range_m: range,
                bearing_rad: bearing,
                range_rate_mps: range_rate,
                line_of_sight: los,
            });
        }
        // `sorted` order is canonical id order, so a stable sort by range
        // yields range-then-id ordering.
        out.sort_by(|x, y| {
            x.range_m
                .partial_cmp(&y.range_m)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        self.last_los.clear();
        self.last_los.extend(out.iter().map(|o| LosPair {
            observer: ctx.ego,
            target: o.actor,
            visible: o.line_of_sight,
        }));
    }

    /// The raster frame is the ego pose: +x forward, +y left, so a policy
    /// never sees a world-frame discontinuity when the map frame differs.
    fn bev(
        &mut self,
        ctx: &ObservationContext,
        actors: &[ActorSnapshot],
        ego: &ActorSnapshot,
        cfg: &BevConfig,
        out: &mut BevRaster,
    ) {
        let width = cfg.width();
        let height = cfg.height();
        if out.width != width || out.height != height || out.channels != BEV_CHANNELS {
            *out = BevRaster::new(cfg);
        } else {
            out.data.fill(0.0);
            out.resolution_m = cfg.resolution_m;
        }
        let data = &mut out.data;
        let (sin_h, cos_h) = sin_cos(ego.heading_rad);
        let to_cell = |wx: f64, wy: f64| -> (i64, i64) {
            let dx = wx - ego.x;
            let dy = wy - ego.y;
            let fwd = dx * cos_h + dy * sin_h;
            let left = -dx * sin_h + dy * cos_h;
            let col = ((left + cfg.half_width_m) / cfg.resolution_m).floor() as i64;
            let row = ((cfg.forward_m - fwd) / cfg.resolution_m).floor() as i64;
            (row, col)
        };
        let (w_i, h_i) = (width as i64, height as i64);
        let mut stamp_disc = |wx: f64, wy: f64, radius_m: f64, channel: usize| {
            let r = (radius_m / cfg.resolution_m).ceil() as i64;
            let (crow, ccol) = to_cell(wx, wy);
            for dr in -r..=r {
                let row = crow + dr;
                if row < 0 || row >= h_i {
                    continue;
                }
                for dc in -r..=r {
                    if dr * dr + dc * dc > r * r {
                        continue;
                    }
                    let col = ccol + dc;
                    if col < 0 || col >= w_i {
                        continue;
                    }
                    data[((row * w_i + col) as usize) * BEV_CHANNELS + channel] = 1.0;
                }
            }
        };

        // Lane surfaces: sample every visible lane's polyline densely enough
        // that stamped discs overlap at any resolution. Cull by a world-axis
        // box around the ego first: real maps have thousands of lanes.
        let margin = cfg.lane_half_width_m + cfg.resolution_m * 2.0;
        let x_min = ego.x - (cfg.forward_m + margin);
        let x_max = ego.x + (cfg.forward_m + margin);
        let y_min = ego.y - (cfg.half_width_m + margin);
        let y_max = ego.y + (cfg.half_width_m + margin);
        let step = cfg.resolution_m / 2.0;
        let ego_lane: Option<LaneId> = ego.lane;
        for lane in ctx.graph.lane_ids() {
            let geom = ctx.graph.geometry(lane);
            let points = geom.path.points();
            if !points
                .iter()
                .any(|p| p.x >= x_min && p.x <= x_max && p.y >= y_min && p.y <= y_max)
            {
                continue;
            }
            let channel = if Some(lane) == ego_lane { 1 } else { 0 };
            let half_width =
                (ctx.graph.width_at(lane, geom.length_m() / 2.0) / 2.0).max(cfg.lane_half_width_m);
            for i in 1..points.len() {
                let a = points[i - 1];
                let b = points[i];
                let seg_len = hypot(b.x - a.x, b.y - a.y);
                let steps = ((seg_len / step).ceil() as i64).max(1);
                for k in 0..=steps {
                    let t = k as f64 / steps as f64;
                    stamp_disc(
                        a.x + (b.x - a.x) * t,
                        a.y + (b.y - a.y) * t,
                        half_width,
                        channel,
                    );
                }
            }
        }

        // Actor OBB occupancy: fill each corner polygon row by row.
        for &idx in &ctx.sorted {
            if idx == ctx.ego {
                continue;
            }
            let a = ctx.actor(actors, idx);
            let d = ctx.dims_of(idx);
            let corners = obb_corners(&Obb {
                center: Vec2 { x: a.x, y: a.y },
                length_m: d.l,
                width_m: d.w,
                heading_rad: a.heading_rad,
            });
            let cells: [(i64, i64); 4] = [
                to_cell(corners[0].x, corners[0].y),
                to_cell(corners[1].x, corners[1].y),
                to_cell(corners[2].x, corners[2].y),
                to_cell(corners[3].x, corners[3].y),
            ];
            let r_min = cells.iter().map(|c| c.0).min().unwrap().max(0);
            let r_max = cells.iter().map(|c| c.0).max().unwrap().min(h_i - 1);
            for row in r_min..=r_max {
                // Even-odd crossing count along this raster row.
                self.crossings.clear();
                for i in 0..4 {
                    let (pr, pc) = cells[i];
                    let (qr, qc) = cells[(i + 1) % 4];
                    if (pr <= row && qr > row) || (qr <= row && pr > row) {
                        let t = (row - pr) as f64 / (qr - pr) as f64;
                        self.crossings.push(pc as f64 + (qc - pc) as f64 * t);
                    }
                }
                self.crossings
                    .sort_by(|m, n| m.partial_cmp(n).unwrap_or(std::cmp::Ordering::Equal));
                let mut k = 0;
                while k + 1 < self.crossings.len() {
                    let c0 = (self.crossings[k].ceil() as i64).max(0);
                    let c1 = (self.crossings[k + 1].floor() as i64).min(w_i - 1);
                    for col in c0..=c1 {
                        data[((row * w_i + col) as usize) * BEV_CHANNELS + 2] = 1.0;
                    }
                    k += 2;
                }
            }
        }
    }
}
