//! Host handle over [`TrafficHandoffWorld`]: flat scene-plane actor rows in,
//! flat released-body rows out. The host keeps presentation data (catalog,
//! dimensions, height) for the ids it receives back; only pose, velocity and
//! ownership cross the boundary.

use simforge_core::engine::StaticMapCollider;
use simforge_core::math::{Obb, Vec2};
use simforge_core::physics::{HandoffActor, HandoffOrigin, TrafficHandoffWorld};

use crate::error::{BindingError, Result};

/// Per-actor input row: `[x, z, headingRad, speedMps, lengthM, widthM, present, static]`
/// in the scene ground plane (`present`/`static` are `0`/`1` flags).
pub const HANDOFF_ACTOR_ROW: usize = 8;
/// Per-body output row: `[origin, x, z, headingRad, speedMps, angularVelocityRadS]`
/// where `origin` is `0` for provider traffic and `1` for an authored actor.
pub const HANDOFF_BODY_ROW: usize = 6;

/// Contact-ownership handoff between an external traffic provider and the
/// native contact solver.
#[derive(Default)]
pub struct Handoff {
    world: TrafficHandoffWorld,
    rows: Vec<f64>,
}

impl Handoff {
    pub fn new() -> Self {
        Self::default()
    }

    /// `StaticMapCollider[]` JSON (scene-frame OBBs) released bodies collide with.
    pub fn set_static_colliders_json(&mut self, text: &str) -> Result<()> {
        let colliders: Vec<StaticMapCollider> = serde_json::from_str(text)
            .map_err(|e| BindingError::argument(format!("static colliders: {e}")))?;
        let obbs: Vec<Obb> = colliders
            .iter()
            .map(|c| Obb {
                center: Vec2 {
                    x: c.obb.center.x,
                    y: c.obb.center.z,
                },
                length_m: c.obb.length_m,
                width_m: c.obb.width_m,
                heading_rad: c.obb.heading_rad,
            })
            .collect();
        self.world.set_static_colliders(&obbs);
        Ok(())
    }

    pub fn clear(&mut self) {
        self.world.clear();
        self.rows.clear();
    }

    /// One provider interval. `authored`/`traffic` are `(N, HANDOFF_ACTOR_ROW)`
    /// row-major with one id and kind per row. Returns the number of provider
    /// actors released to physics during this step.
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        dt_s: f64,
        authored_ids: &[String],
        authored_kinds: &[String],
        authored_rows: &[f64],
        traffic_ids: &[String],
        traffic_kinds: &[String],
        traffic_rows: &[f64],
    ) -> Result<usize> {
        let authored = actors("authored", authored_ids, authored_kinds, authored_rows)?;
        let traffic = actors("traffic", traffic_ids, traffic_kinds, traffic_rows)?;
        let released = self.world.step(dt_s, &authored, &traffic);
        self.refresh();
        Ok(released)
    }

    pub fn body_count(&self) -> usize {
        self.world.bodies().len()
    }

    pub fn traffic_body_count(&self) -> usize {
        self.world.traffic_body_count()
    }

    /// Released body ids in row order.
    pub fn body_ids(&self) -> Vec<String> {
        self.world.bodies().iter().map(|b| b.id.clone()).collect()
    }

    /// `(N, HANDOFF_BODY_ROW)` rows for the released bodies, valid until the next `step`/`clear`.
    pub fn body_rows(&self) -> &[f64] {
        &self.rows
    }

    fn refresh(&mut self) {
        self.rows.clear();
        for body in self.world.bodies() {
            self.rows.extend_from_slice(&[
                match body.origin {
                    HandoffOrigin::Traffic => 0.0,
                    HandoffOrigin::Authored => 1.0,
                },
                body.x,
                body.z,
                body.heading_rad,
                body.speed_mps(),
                body.angular_velocity_rad_s,
            ]);
        }
    }
}

fn actors<'a>(
    what: &str,
    ids: &'a [String],
    kinds: &'a [String],
    rows: &[f64],
) -> Result<Vec<HandoffActor<'a>>> {
    if ids.len() != kinds.len() || rows.len() != ids.len() * HANDOFF_ACTOR_ROW {
        return Err(BindingError::argument(format!(
            "{what} actors must supply one id and kind per (N, {HANDOFF_ACTOR_ROW}) row, got {} ids, {} kinds, {} values",
            ids.len(),
            kinds.len(),
            rows.len()
        )));
    }
    ids.iter()
        .zip(kinds)
        .zip(rows.chunks_exact(HANDOFF_ACTOR_ROW))
        .map(|((id, kind), row)| {
            if !row[..6].iter().all(|v| v.is_finite()) {
                return Err(BindingError::argument(format!(
                    "{what} actor {id} has a non-finite pose"
                )));
            }
            Ok(HandoffActor {
                id: id.as_str(),
                kind: kind.as_str(),
                x: row[0],
                z: row[1],
                heading_rad: row[2],
                speed_mps: row[3],
                length_m: row[4],
                width_m: row[5],
                present: row[6] != 0.0,
                is_static: row[7] != 0.0,
            })
        })
        .collect()
}
