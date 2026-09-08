# Second-scene selection rule

Fixed before any gate metric was computed on any candidate, and recorded here so the choice
cannot be mistaken for one made after seeing results.

## Rule as first declared

1. The package must calibrate all four Alpamayo cameras `[0, 1, 2, 6]`.
2. Among those, prefer the **lowest mean absolute heading rate** over the recorded rig
   trajectory.

Both come from the package's own `rig_trajectories.json` — scene metadata, not a gate
measurement. Curvature is the criterion for a diagnostic reason: the first scene's G5 residual
was a curvature-dependent tracking error (±0.6–0.9 m signed swing, endpoints agreeing to 1.7 m
over 171 m), so a straighter drive isolates whether curvature is the cause. It is chosen to
test that, not because it is expected to score better.

Candidates: the first 10 scenes of AlpaSim suite `public_2604` in deterministic `scene_id`
order — not curated, and probed by Range-fetching each package's ZIP central directory plus one
JSON member rather than downloading ~1.7 GB apiece.

## Amendment, made before any gate ran

The rule as first stated selected `clipgt-00097de1…` at 0.0011 rad/s — but that drive covers
**23 m in 20 s**, roughly 1.1 m/s. A near-stationary clip makes G5 trivially easy: an executor
barely has to track anything, so a pass would say little about whether the sim/executor chain
reproduces a real drive.

Added criterion: **path length ≥ 100 m**, so the scene is an actual drive. This is a statement
about what makes a scene a meaningful test, it was added before any G1–G5 measurement on any
candidate, and it makes the selection *harder* rather than easier.

## Ranking (all 10 eligible; all four cameras present)

| scene_id | mean abs heading rate (rad/s) | path length (m) | selected |
|---|---|---|---|
| clipgt-00097de1-5ded-4fba-a5ed-4b527678d1b0 | 0.0011 | 23 | rejected: < 100 m |
| **clipgt-000a3a34-1031-4f90-9bc3-5b5c132fd1ed** | **0.0025** | **139** | **SELECTED** |
| clipgt-00064c58-7047-4a53-8a36-b033baaaa5fb | 0.0076 | 257 | |
| clipgt-000ff49d-aa30-46ee-af57-b4a0c1143f55 | 0.0111 | 381 | |
| clipgt-0009402a-a514-443b-9a4c-0e792f5ae581 | 0.0172 | 667 | |
| clipgt-000e95f7-560d-4411-8069-b9f531ed3cd6 | 0.0209 | 271 | |
| clipgt-000525f6-3999-4812-9924-8adff40ca514 | 0.0294 | 221 | |
| clipgt-00040136-e651-4abd-991d-0655ccda9430 | 0.0388 | 312 | |
| clipgt-000a74ae-5c01-486e-ab6f-7f5160136357 | 0.0445 | 225 | |
| clipgt-000548db-e266-49e5-a832-6674ab53a615 | 0.0734 | 208 | |

Selected: `clipgt-000a3a34-1031-4f90-9bc3-5b5c132fd1ed`, artifact uuid pinned by the catalogue
row, dataset revision `26.04`. 139 m over 20 s (~7 m/s) at 0.0025 rad/s — a real drive that is
nearly straight.

Every scene probed is kept in this table, including the rejected one and the ones ranked below
the selection, so the candidate set is visible rather than just the winner.

## What this scene is not

It is a licensed, gated PhysicalAI-AV asset: read with the dev credential, staged on
product-owned storage, never committed, never published, and not a research frozen set. If it
fails its gates, that is the recorded outcome — the rule above will not be revisited to find a
scene that passes.
