//! Hash identity of the route an actor actually owns on every sample. Two
//! actors (or two ticks) with the same directed lane chain — or the same
//! polyline — share the same ref, so an external ledger can tell "route
//! swapped" from "route continued" without comparing geometry.

use crate::hash::sha256;
use crate::map::{Route, RouteSnapshot};

/// Stable semantic route reference for a route binding.
pub fn semantic_resolved_route_ref(route: &Route) -> String {
    match route.snapshot() {
        RouteSnapshot::LaneChain { legs } => {
            let mut text = String::with_capacity(legs.len() * 24 + 8);
            text.push_str("lanes:");
            for (i, leg) in legs.iter().enumerate() {
                if i > 0 {
                    text.push('>');
                }
                text.push_str(&leg.rsl);
                text.push(if leg.reversed { '-' } else { '+' });
            }
            text
        }
        RouteSnapshot::Polyline { points } => {
            let mut text = String::with_capacity(points.len() * 32);
            for p in points {
                text.push_str(&crate::hash::js_number_to_string(p.x));
                text.push(',');
                text.push_str(&crate::hash::js_number_to_string(p.y));
                text.push(';');
            }
            let mut out = String::with_capacity(9 + 64);
            out.push_str("polyline:");
            out.push_str(&sha256(&text));
            out
        }
    }
}

/// Interned route-ref table: per-tick tracks store a `u32` slot, strings are
/// materialised once.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RouteRefTable {
    refs: Vec<String>,
}

impl RouteRefTable {
    pub fn intern(&mut self, route: &Route) -> u32 {
        let text = semantic_resolved_route_ref(route);
        if let Some(i) = self.refs.iter().position(|r| *r == text) {
            return i as u32;
        }
        self.refs.push(text);
        (self.refs.len() - 1) as u32
    }

    #[inline]
    pub fn get(&self, slot: u32) -> &str {
        &self.refs[slot as usize]
    }

    /// Interned refs in slot order.
    #[inline]
    pub fn entries(&self) -> &[String] {
        &self.refs
    }

    pub fn from_entries(refs: Vec<String>) -> Self {
        Self { refs }
    }
}
