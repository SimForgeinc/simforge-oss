//! Line of sight against the coarse occluder set.
//!
//! A deliberately 2-D test on the ground plane: heights are carried but not
//! used, because reveal-to-conflict is dominated by plan-view geometry and a
//! 3-D test would need render meshes the engine refuses to depend on.
//!
//! The per-tick occluder set is authored boxes, then every static or declared
//! actor body, then attached props ([`collect_tick_occluders`]). Undeclared
//! moving traffic is never silently promoted to an occluder.

use std::borrow::Borrow;

use crate::math::{hypot, obb_corners, segment_intersection, Obb, Vec2};
use crate::types::{Occluder, OcclusionPair};

use super::actor::{ActorIndex, ActorRuntime};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OccluderShape<'a> {
    /// Trace vocabulary: document id for authored occluders/props,
    /// `actor:<id>` for live bodies, `prop:`/`map:` for collision proxies.
    pub id: &'a str,
    pub group_id: Option<&'a str>,
    /// The live body this shape is, so a sight line can exclude its own
    /// endpoints without comparing keys. `None` for authored/static shapes.
    pub actor: Option<ActorIndex>,
    pub obb: Obb,
    pub height_m: f64,
    pub corners: [Vec2; 4],
}

/// An authored occluder resolved into the engine frame, owned by the world.
#[derive(Debug, Clone, PartialEq)]
pub struct StaticOccluder {
    pub id: String,
    pub group_id: Option<String>,
    pub obb: Obb,
    pub height_m: f64,
    pub corners: [Vec2; 4],
}

impl StaticOccluder {
    #[inline]
    pub fn shape(&self) -> OccluderShape<'_> {
        OccluderShape {
            id: &self.id,
            group_id: self.group_id.as_deref(),
            actor: None,
            obb: self.obb,
            height_m: self.height_m,
            corners: self.corners,
        }
    }
}

/// Convert scene-frame occluders from the input into local-frame shapes,
/// sorted by id.
pub fn build_occluders<'a>(
    occluders: impl IntoIterator<Item = &'a Occluder>,
) -> Vec<StaticOccluder> {
    let mut out: Vec<StaticOccluder> = occluders
        .into_iter()
        .map(|o| {
            let obb = Obb {
                center: o.obb.center.to_local(),
                length_m: o.obb.length_m,
                width_m: o.obb.width_m,
                heading_rad: o.obb.heading_rad,
            };
            StaticOccluder {
                id: o.id.clone(),
                group_id: o.group_id.clone(),
                obb,
                height_m: o.obb.height_m,
                corners: obb_corners(&obb),
            }
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// The trace key of an actor body used as an occluder.
pub fn actor_occluder_key(actor_id: &str) -> String {
    format!("actor:{actor_id}")
}

/// Per-actor occluder identity, built once so the per-tick set borrows
/// stable keys instead of formatting them. Indexed by [`ActorIndex`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActorOccluderKeys {
    /// `actor:<id>` per actor index.
    keys: Vec<String>,
    /// Static bodies and bodies named as `occluderId` by an occlusion pair.
    declared: Vec<bool>,
    /// Declared bodies sorted by actor id, so the set is declaration-order
    /// independent like every other fan-out.
    order: Vec<ActorIndex>,
}

impl ActorOccluderKeys {
    pub fn new(actors: &[ActorRuntime], occlusion_pairs: &[OcclusionPair]) -> Self {
        let mut this = Self {
            keys: Vec::with_capacity(actors.len()),
            declared: Vec::with_capacity(actors.len()),
            order: Vec::new(),
        };
        for actor in actors {
            this.add(actor, occlusion_pairs);
        }
        this
    }

    /// Register an actor (at construction or on spawn). Indices are dense
    /// and assigned in registration order, so this must be called in that
    /// order once per actor.
    pub fn add(&mut self, actor: &ActorRuntime, occlusion_pairs: &[OcclusionPair]) {
        debug_assert_eq!(
            actor.index.index(),
            self.keys.len(),
            "actor occluder keys must follow registration order"
        );
        let key = actor_occluder_key(&actor.id);
        let declared = actor.is_static
            || occlusion_pairs
                .iter()
                .any(|pair| pair.occluder_id.as_deref() == Some(key.as_str()));
        if declared {
            let at = self
                .order
                .partition_point(|&other| self.keys[other.index()] < key);
            self.order.insert(at, actor.index);
        }
        self.keys.push(key);
        self.declared.push(declared);
    }

    #[inline]
    pub fn key(&self, actor: ActorIndex) -> &str {
        &self.keys[actor.index()]
    }

    /// `true` when this body is promoted to an occluder while live.
    #[inline]
    pub fn is_declared(&self, actor: ActorIndex) -> bool {
        self.declared[actor.index()]
    }

    /// Declared bodies, sorted by actor id.
    #[inline]
    pub fn declared(&self) -> &[ActorIndex] {
        &self.order
    }
}

/// A live body as an occluder shape.
#[inline]
pub fn actor_occluder<'a>(actor: &ActorRuntime, key: &'a str) -> OccluderShape<'a> {
    let obb = actor.obb();
    OccluderShape {
        id: key,
        group_id: None,
        actor: Some(actor.index),
        obb,
        height_m: actor.dims.h,
        corners: obb_corners(&obb),
    }
}

/// This tick's occluder set: authored boxes, then every declared body that is
/// present and not retired, sorted by id. `out` is cleared and filled; the
/// engine appends attached-prop shapes after this. The same set feeds
/// conditions, occlusion-pair metrics and the perception pass.
pub fn collect_tick_occluders<'a>(
    statics: &'a [StaticOccluder],
    actors: &[ActorRuntime],
    keys: &'a ActorOccluderKeys,
    out: &mut Vec<OccluderShape<'a>>,
) {
    out.clear();
    out.extend(statics.iter().map(StaticOccluder::shape));
    for &index in keys.declared() {
        let actor = &actors[index.index()];
        if actor.present && !actor.retired {
            out.push(actor_occluder(actor, keys.key(index)));
        }
    }
}

#[inline]
fn segment_hits_corners(a: Vec2, b: Vec2, corners: &[Vec2; 4]) -> Option<f64> {
    let mut best: Option<f64> = None;
    for i in 0..4 {
        let p = corners[i];
        let q = corners[(i + 1) % 4];
        if let Some(t) = segment_intersection(a, b, p, q) {
            if best.map_or(true, |b| t < b) {
                best = Some(t);
            }
        }
    }
    best
}

/// `true` when the segment `a → b` is not blocked by any occluder and is
/// within `max_range_m`. Accepts owned shapes or references.
pub fn has_line_of_sight<'a, O: Borrow<OccluderShape<'a>>>(
    a: Vec2,
    b: Vec2,
    occluders: impl IntoIterator<Item = O>,
    max_range_m: f64,
) -> bool {
    if hypot(b.x - a.x, b.y - a.y) > max_range_m {
        return false;
    }
    for occ in occluders {
        let corners = &occ.borrow().corners;
        for i in 0..4 {
            if segment_intersection(a, b, corners[i], corners[(i + 1) % 4]).is_some() {
                return false;
            }
        }
    }
    true
}

/// The blocking occluder nearest `a`, or `None` — used for explainability.
pub fn blocking_occluder<'a, O: Borrow<OccluderShape<'a>>>(
    a: Vec2,
    b: Vec2,
    occluders: impl IntoIterator<Item = O>,
) -> Option<&'a str> {
    let mut best: Option<(&'a str, f64)> = None;
    for occ in occluders {
        let occ = occ.borrow();
        if let Some(t) = segment_hits_corners(a, b, &occ.corners) {
            if best.map_or(true, |(_, bt)| t < bt) {
                best = Some((occ.id, t));
            }
        }
    }
    best.map(|(id, _)| id)
}

impl<'a> crate::trace::metrics::OccluderView for OccluderShape<'a> {
    #[inline]
    fn id(&self) -> &str {
        self.id
    }
    #[inline]
    fn group_id(&self) -> Option<&str> {
        self.group_id
    }
    #[inline]
    fn corners(&self) -> &[Vec2] {
        &self.corners
    }
}
