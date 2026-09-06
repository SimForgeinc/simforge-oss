//! Deterministic uniform-grid broadphase used by dense ambient simulations.
//!
//! Sort-based rather than map-based so the per-tick query is allocation-free
//! once the scratch buffers have warmed up: every `(cell, item)` occupancy is
//! pushed into one vector, sorted, and runs of equal cells are expanded into
//! candidate pairs. The output is sorted and deduplicated so declaration order
//! cannot affect results.

/// Axis-aligned bounds of one item. `id` is any dense index the caller owns;
/// ties and output order are by `id`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpatialBounds {
    pub id: u32,
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Reusable scratch for [`candidate_pairs`].
#[derive(Debug, Default, Clone)]
pub struct SpatialScratch {
    occupancy: Vec<(i32, i32, u32)>,
}

#[inline]
fn cell_of(v: f64, cell_size_m: f64) -> i32 {
    (v / cell_size_m).floor() as i32
}

/// Every unordered pair `(a, b)` with `a < b` whose bounds share at least one
/// grid cell. False positives are intentional; narrow-phase geometry remains
/// authoritative. `out` is cleared and filled sorted by `(a, b)`.
pub fn candidate_pairs(
    items: &[SpatialBounds],
    cell_size_m: f64,
    scratch: &mut SpatialScratch,
    out: &mut Vec<(u32, u32)>,
) {
    debug_assert!(cell_size_m > 0.0 && cell_size_m.is_finite());
    out.clear();
    let occ = &mut scratch.occupancy;
    occ.clear();
    for item in items {
        if !(item.min_x.is_finite()
            && item.min_y.is_finite()
            && item.max_x.is_finite()
            && item.max_y.is_finite())
        {
            continue;
        }
        let x0 = cell_of(item.min_x.min(item.max_x), cell_size_m);
        let x1 = cell_of(item.min_x.max(item.max_x), cell_size_m);
        let y0 = cell_of(item.min_y.min(item.max_y), cell_size_m);
        let y1 = cell_of(item.min_y.max(item.max_y), cell_size_m);
        for x in x0..=x1 {
            for y in y0..=y1 {
                occ.push((x, y, item.id));
            }
        }
    }
    occ.sort_unstable();
    let mut start = 0;
    while start < occ.len() {
        let (cx, cy, _) = occ[start];
        let mut end = start + 1;
        while end < occ.len() && occ[end].0 == cx && occ[end].1 == cy {
            end += 1;
        }
        let run = &occ[start..end];
        for i in 0..run.len() {
            for j in (i + 1)..run.len() {
                let a = run[i].2;
                let b = run[j].2;
                out.push(if a < b { (a, b) } else { (b, a) });
            }
        }
        start = end;
    }
    out.sort_unstable();
    out.dedup();
}

/// Cell coordinate of a point for callers that bucket by point rather than by
/// bounds (the reactive-ambient neighbour index).
#[inline]
pub fn point_cell(x: f64, y: f64, cell_size_m: f64) -> (i32, i32) {
    (cell_of(x, cell_size_m), cell_of(y, cell_size_m))
}
