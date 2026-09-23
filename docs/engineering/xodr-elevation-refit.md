# OpenDRIVE elevation refit

`pnpm maps:refit-elevation` rewrites a map's OpenDRIVE road surface so that it
matches the rendered road mesh of the same export. Code:
`packages/map-pipeline/src/elevation-refit/`. The CLI is
`scripts/refit-xodr-elevation.mts`.

## Why

The RoadRunner exports ship a GLB (what cameras see) and an XODR (what every
OpenDRIVE consumer reads), and their road surfaces disagree. See
`ground-height.md` and the ten-map survey: drivable-lane p95 is 7-55 cm, the
max is up to 1 m, and one road is off by 12 m. The simulation grounds bodies
on the mesh (`derived/ground`). Other consumers still read XODR heights:

- editor overlays
- signals and props placed from the XODR
- SUMO
- OpenSCENARIO/OpenDRIVE exports
- CARLA waypoints
- map grades

The refit brings those consumers onto the visible road.

## What changes, what does not

Only three things change:
- `<elevationProfile>`
- `<lateralProfile>` (superelevation; a non-zero `<shape>` becomes one zero record)
- lane `<height>` (laneHeight)

The corrected file is produced by splicing text into the original at those
elements' byte ranges. Every other byte stays identical:
- planView
- lanes and widths
- links and junctions
- signals and objects
- ids and the header

`structuralDiff` proves it:
- The element-by-element diff must have no difference outside those elements.
- The bytes outside those elements must be identical.

## Method

1. **Mesh.** Use the ground derivative's surface (`extractGroundSurface`,
   queried with `GroundQuery`). This is the same code and the same mesh as
   `derived/ground`, so the refit and the simulation's height field agree. The
   mesh sha256 is recorded in the report.
2. **Samples.** Every lane, 3 lateral positions (0.2/0.5/0.8 of the lane
   width), every 0.5 m of s.
3. **Deck choice.** Each lane line is followed along s from seeds:
   - A seed is a surface within 0.3 m of the current z, or a lone surface
     within 2 m.
   - Following continues while consecutive samples stay within 0.2 m.
   - A bridge keeps its deck.
   - A profile error (a spurious bump, a ramp to z = 0) snaps to the single
     continuous surface under it.
   - A deck missing from the mesh breaks continuity and is treated as a hole.
   - Carriageway lanes prefer paved classes (road, bridge, gutter, paved,
     marking) over kerb, sidewalk and terrain tops.
4. **Fit.** Per road, `z(s,t) = E(s) + t tan(phi(s))` is fitted to the
   carriageway (driving-type lanes):
   - E and tan(phi) are C1 cubic Hermite splines on one knot vector.
   - Knots start at 8 m and are split adaptively down to 1 m while any
     station's mean or cross-slope residual exceeds 8 mm.
   - The fit is robust: Huber IRLS at 2 cm.
   - The cross-slope is fitted only across at least 2 m of lateral span, and
     is dropped if it would exceed 12 %.
   - The Hermite pieces become OpenDRIVE cubic records, so value and slope
     match at every record joint.
5. **Continuity.**
   - Non-junction roads are fitted first. Their contacts are pinned in E, E',
     tan(phi) and its slope: either to an unchanged neighbour, or to a
     consensus of both first-pass fits.
   - Junction connecting roads are fitted next, pinned at both contact points
     to the final incoming and outgoing road surfaces. The pins account for
     the lateral offset of the connecting road's reference line and for the
     curvature of the neighbour's frame over 0.25 m.
   - An unchanged connecting road whose neighbour changed is refitted.
   - Connecting roads with no carriageway lane (shoulder or sidewalk only)
     interpolate between their contacts. Their lanes' levels go to laneHeight.
6. **Second round.** Decks are re-selected against the first-round surface
   (this settles closely stacked decks), then everything is fitted again.
7. **laneHeight.** Per lane:
   - Compute the residual from the fitted plane, segmented along s (1 cm
     bands, records at least 1 m long, real steps over 5 cm kept) with an
     inner/outer tilt between 2 and 25 cm.
   - Keep the original records if they already match (p95 ≤ 1.5 cm).
   - Remove them where the mesh has no offset.
8. **Unchanged roads.** A road whose carriageway already matches (p95 ≤
   1.5 cm, max ≤ 3 cm) and is not a data error keeps its profile byte for byte.
9. **Holes.** Where the mesh has no surface, the original OpenDRIVE surface is
   the observation, so it is kept there. Every hole is listed with its s
   ranges.
10. **Data errors.** Grades over 30 %, record steps over 5 cm, and
    laneHeight over 1 m are reported. They are corrected like any other
    disagreement.

## Gates (per map; any failure exits 2 and nothing is published)

- No structural difference outside the three elements, and the bytes outside
  them are identical.
- Drivable lane-centre p95 |XODR − mesh| ≤ 3 cm. This is the ground
  derivative's own survey (`validateGround`); mesh holes are excluded.
- At every road-to-road contact of a refitted road: C0 ≤ 1 mm and slope
  difference ≤ 1 %, measured over 0.25 m by `verifyContinuity`.
- Elevation record joints: step ≤ 0.1 mm, kink ≤ 1e-4.

## Usage

```
pnpm maps:refit-elevation -- --map <id>[,<id>] | --all --out DIR
    [--maps-root DIR] [--xodr FILE --master-dir DIR | --ground-mesh FILE]
    [--title T --source-name N --corrected-name N]
```

It writes `DIR/<map>/{map.xodr, refit-report.json, CHANGES.md,
survey-before.f64, survey-after.f64}`. The survey rows use the ground survey's
layout `[road, junction, lane, s, x, y, xodrZ, meshZ, topZ, driving]`.

A corrected XODR has a new digest, so it becomes a new map version. It is
published through the normal registry path (`maps build/ingest
--reuse-master`), which keeps master.gltf and geometry.bin byte-identical and
regenerates the XODR-derived members (topology, signals, SUMO, ground).
`REFIT_REVISION` must be bumped whenever identical inputs would produce a
different file. The Richmond fixture test pins the corrected digest.
