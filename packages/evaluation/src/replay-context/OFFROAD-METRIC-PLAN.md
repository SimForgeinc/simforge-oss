# Off-road metric v2: plan, pre-recorded before any recomputation

Written and committed **before** the new metric is implemented or any scene is re-scored, so
the comparison cannot be shaped by its result. Nothing in this document is contingent on what
the new numbers turn out to be.

## Owner decision being implemented

Off-road means **vehicle-footprint containment in authoritative drivable-area polygons**. It
does **not** mean distance from a single pre-bound lane centreline. That second quantity is a
real thing worth measuring, but it is *lane/route departure*, and it keeps that separate name.

## Why v1 was wrong (already diagnosed, not re-litigated here)

At tick 1 of the `clipgt-0009402a` stock replay the ego was 0.16 m from `ego.recordedPath` — to
within 16 cm exactly where the human drove — while the v1 detector reported 5.454 m from the
centreline of a lane bound 1.101 m off at the start. The recorded human trajectory itself would
have been flagged. A metric that fails the ground-truth drive is measuring the binding.

## Versioning, and what does not move

- The new metric is `simforge.offroad/v2` (footprint-in-drivable-area). The old one is
  `simforge.offroad/v1` (centreline offset), retained under the name **lane-departure**.
- **G5 v1 verdicts stay failed and stay on the record.** No prior receipt is relabelled,
  rewritten or re-scored in place. `007a5809` failed G5 v1 on a systematic 0.6 m deviation and
  that is untouched by any of this; `clipgt-0009402a`'s v1 verdict remains exactly as recorded.
- Any v2 result is written as a **new, separately identified measurement** alongside the v1 one,
  never over it.
- No threshold changes. G5's bounds (max 0.35 m after 1 s settle, p95 0.10 m, zero infractions)
  are untouched. This fixes a metric that measured the wrong quantity; it does not loosen one.

## Pre-registered comparison

Before recomputing, the following are fixed:

1. **Control that must hold, or v2 is wrong too.** Score `ego.recordedPath` itself — the human
   drive — under v2. It must produce **zero** off-road events. A ground-truth drive that its own
   scene calls off-road falsifies the metric, exactly as it falsified v1. This is the primary
   acceptance check for v2 and it is independent of any replay.
2. **Report both, always.** For every scene: v1 lane-departure statistics and v2 off-road
   events, side by side, with the v1 numbers unchanged from what is already recorded.
3. **A v2 pass does not admit a scene by itself.** `clipgt-0009402a` also has speeding and
   wrong-way *unavailable* (no authoritative speed limits, no authoritative lane directionality),
   and G5 fails while any category is unavailable. So even a clean v2 leaves this scene
   **not admitted**, and admission still requires either the missing metadata or a separately
   approved partial-metric policy. The policy was not chosen to admit a scene, and cannot.
4. **Prediction recorded in advance:** v2 will report zero off-road events for both the recorded
   path and the stock replay on `clipgt-0009402a`, because the replay stays within 0.43 m of a
   trajectory a human drove on a real road. If v2 instead reports off-road events, that is
   evidence of a geometry or transform defect in the ingestion and will be investigated as such
   rather than reported as scene behaviour.

## Correctness work required before any scene number is quoted

- **Coordinate/transform verification.** ClipGT geometry must be proven to land in the same
  metric frame as `ego.recordedPath` (`nurec-source-z-up`). The check: the recorded rig
  footprint across the whole drive must lie inside the drivable area. A systematic offset shows
  up immediately as the human driving off the road.
- **Containment unit tests**, on authored geometry, covering: fully inside; fully outside; inside
  a hole (a road island cut out of the drivable polygon); straddling a boundary; and a footprint
  larger than a narrow polygon. Footprint containment is an oriented-rectangle-vs-polygon test,
  not a point test, and the corner cases are where such tests are usually wrong.

## Scope

Feature branch only, with the scoring owner. Not core release scope. CPU only — no GPU is
needed until an actual render is required, and none is required for any of the above.
