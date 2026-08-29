# PREREG — Stream C (worldgen): emergence mining, 2026-08-15

Registered BEFORE the first measured run (diversity probe M1 and everything after).
Gate: frozen, `verify_gate_hash.py` PASS required at start and end of every measured
stage; hashes recorded in results.json. All kinematics read from RAW traces via
`tg_gate.load_trace`; the only summary fields consumed are `verdict`/`band` (C5's
definition) and cell coordinates/paths.

## World templates (scaffolding, not choreography)
- `templates/world-corridor.template.json` — ego cruises a corridor, no challenger,
  no scripted conflict, 30 s clip, warmup 2 s. 12 exact sites on easterbrook.
- `templates/world-junction.template.json` — ego crosses a 3–4-arm junction (any
  control; signalized preferred), otherwise identical. 12 exact sites on easterbrook.
- Ambient via CLI flags only. Presets used: `heavy` (density 16 veh/km, aggressiveness
  0.35, cyclistShare 0.04, pedestrianShare 0) and `city` (density 8, aggressiveness
  0.25, pedestrianShare 0.06, cyclistShare 0.02). Density override arm: `--ambient-density 32`.
  `--ambient-settle` left at default (20 s). Recorded per cell from batch-summary
  `ambient.profile` + per-result `ambient.actorCount`.

## M1 — seed-diversity probe (GO/NO-GO on the seed axis)
Design: corridor template, easterbrook, `--max-sites 1` (deterministic top site),
`--draws 1`, `--ambient heavy`, seeds S = 1..20, one batch invocation per seed,
unique out dirs under `/tmp/tgr-worldgen-m1-<runid>/`.
Metrics (per seed world, ambient actors only):
- `actorCount` = len(header.ambientActorIds).
- `spawnSet` = set of (kind, floor(x0/10), floor(y0/10)) at each ambient actor's first
  present tick.
- `occGrid` = set of 10 m grid cells visited by any ambient actor over the clip.
Diversity statistics: mean pairwise Jaccard similarity of `spawnSet` (J_spawn) and of
`occGrid` (J_occ); number of distinct `actorCount` values.
**Decision rule (registered):** NO-GO iff J_spawn ≥ 0.8 (seed axis near-degenerate →
early honest exit per brief falsifier 4; report and stop the stream at M1).
GO iff J_spawn < 0.5. In between: GO with a stated caveat iff J_occ < 0.9, else NO-GO.

## M2 — sweep (launched only on GO)
Cells: {corridor, junction} × 12 sites/template (easterbrook) ×
{heavy@default16, heavy@32, city@default8} × seeds 1..25, `--draws 1` (no template
params; draws are not an exploration axis), clip 30 s.
= 2 × 12 × 3 × 25 = 1800 world-runs on easterbrook. If further maps finish syncing
(rsync in flight) before mining starts, the same templates are re-matched and the same
grid is run per additional map with seeds 1..10 (÷2.5 cell count) — additive, reported
per map, never pooled silently into the easterbrook yield table.
Driver runs under hub `start`; ≤6 concurrent workers (batch `--concurrency 6`,
one invocation at a time). Recorded per cell: elapsed, ambient actorCount, verdict/band.
CPU-hour accounting from batch `elapsedMs` (wall) and cells/hour.

## M3 — mining (raw traces, ANY actor pair incl. ambient–ambient)
For every unordered actor pair (both present ≥ 1 common tick; pairs of two static
actors excluded when both max speeds in window < 0.5 m/s):
- Broad phase: center distance − (r_A + r_B) ≤ 8.0 m (r = half-diagonal from
  actorMetadata dims; defaults as in tg_gate for missing dims).
- OBB clearance (tg_gate.obb_clearance) on surviving ticks; candidate ticks =
  clearance ≤ 8.0 m; contiguous runs merged into one EVENT WINDOW when gaps ≤ 1.0 s.
- Per window: minClearanceM + t*, TTC_rr = min over closing ticks of
  clearance / closingSpeed with closingSpeed = −d(clearance)/dt smoothed over 5 ticks
  (0.1 s) and required > 0.1 m/s; maxDecel per actor over window ±1 s from smoothed
  d(speed)/dt; relativeHeadingDeg, laneRelation (same lane rsl / different) at t*;
  yieldStop flag (either actor reaches < 0.3 m/s inside the window after decel ≥ 2.0).
- **Near-critical event (registered):** minClearance ≤ 8.0 AND
  (TTC_rr ≤ 4.0 s OR maxDecel(either) ≥ 2.5 m/s²), with t* > 2.5 s (mirrors gate C2
  margin; kills spawn/settle-edge artifacts).
- **Gate-grade tier T1:** additionally minClearance ≤ 5.0 AND TTC_rr ≤ 3.0
  (mirrors frozen C3/C4 thresholds). T2 = near-critical but not T1.
- Collisions (clearance = 0 at any tick, or trace metrics.collisions naming the pair)
  are counted in a separate `collision` bucket, never as near-critical.
Headline numbers (the brief's "decides everything"): events per 1000 world-runs, per
(template × preset × density), T1/T2 split, ego-involved vs ambient-only split, and
events per CPU-hour.

## Clustering + taxonomy mapping (deterministic, rule-based)
Signature per event: (headingBucket: same-dir < 45° | crossing 45–135° | opposing
> 135°; laneRelation; kindPair (ego treated as car); movementClass: both-moving |
counterpart-stopped | low-speed-both(< 3 m/s); yieldStop; template context).
Cluster = distinct signature tuple. Taxonomy rules, applied in order:
1. counterpart kind pedestrian → C5; bicycle/motorcycle → C6.
2. opposing → C10.
3. crossing + junction template → C3; crossing + corridor → C2 (driveway/merge geometry).
4. same-dir + same lane + counterpart-stopped ≥ 2 s before window → C9 if speed at
   window start ≥ 3 m/s else C11.
5. same-dir + same lane (both moving) → C1.
6. same-dir + different lane + lateral convergence (|Δ lateralOffsetM| ≥ 0.5 m or lane
   rsl change inside window) → C2; without convergence → C1 (adjacent-queue shear,
   reported as C1-adjacent).
7. yieldStop + junction template, not otherwise classified → C3 (negotiation).
Spectrum = event share per category. **Falsifier check (registered):** "spectrum
collapse" iff fewer than 3 categories hold ≥ 5% of mined events each.

## M4 — promotion
Structural fact (verified in tg_gate source, will be demonstrated on real cells):
`trace_facts` skips every id in `header.ambientActorIds`, so an ambient counterpart can
never satisfy C2/C3 — a raw world-run can never pass the frozen gate, and
seed/signal/hard-brake perturbation alone cannot fix that. Therefore BOTH promotion
routes author a template with a real (non-ambient) challenger, ambient kept ON:
- **Re-cast (ego-involved mined event):** challenger reproduces the ambient
  counterpart's approach (same site class anchor, speed/gap/arrival as tier-1 params
  bracketing the mined values), ego in its mined role.
- **Re-cast (ambient–ambient mined event):** ego takes one participant's role,
  challenger the other. Same construction.
- Perturbation arm (registered as a measurement, expected structural FAIL): take ≥ 3
  mined ego-involved cells, re-run same inputs with one input-level perturbation
  (different near-by seed / density bump), gate directly — records WHERE the direct
  route dies (expected C3 clearance=None). This documents the engine/gate boundary
  honestly rather than assuming it.
Caps (compute + authoring budget): ≤ 12 re-cast template attempts, chosen to cover the
widest set of clusters, T1 events first. Each attempt: match → batch ≥ 3 sites ×
≥ 4 draws with `--ambient heavy` + template params, gate every cell with
`gate_cell(version=2)`, portability over passing cells (≥ 2 maps / ≥ 3 sites) when ≥ 2
maps are synced; if assets block portability at run time, portability is reported
BLOCKED, never claimed.
**Promotion rate** = re-cast templates with ≥ 1 admitted cell / attempts; plus
cell-level admission rate; plus per-criterion first-failure census.

## M5 — labelling, novelty, cross-stream
- LLM mechanism label per admitted scene: Codex model (`gpt-5.6-sol`, medium effort)
  from trace facts only (no vision); label vs rule-mapped category = coverage claim.
- Novelty vs authored corpus: signature tuples (headingBucket, laneRelation, kindPair,
  movementClass) computed identically for (a) mined events, (b) every admitted
  gold-corpus-v3 trace (ego × non-ambient challengers). Novelty = share of mined
  event signatures absent from the authored signature set; also category-spectrum
  comparison against gold-corpus-v3 MANIFEST categories.
- Stream B scorer: IF announced calibrated before M5 close, run `score.py` on 30
  mined near-critical cells + 30 gold cells; report distribution comparison.
  Non-blocking; absence reported as "not available in window".
- Blind-judge criticality (judge_blind.py stage A conventions) on admitted scenes.

## Falsifier verdicts to be reported explicitly
F1 mining doesn't pay: promoted admissible yield < ~1 per 1000 world-runs (report
   where it dies: no near-criticals / near-criticals unpromotable past C5-collision or
   C2-spawn).
F2 spectrum collapse: < 3 categories at ≥ 5% share of mined events.
F3 realism: mined scenes score worse than authored on Stream B's instrument (only if
   scorer lands in time).
F4 weak seed axis: M1 NO-GO rule above → early exit, stream stops at M1 with the probe
   as the result.
