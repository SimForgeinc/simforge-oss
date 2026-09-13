# Stream C — World-first generation (emergence mining)

Read `~/tg-research/streams/SHARED-CONTRACT.md` first; it is binding.
Read `~/tg-research/PLAN.md` §1–3. Your dir: `tools/tg-research/worldgen/`.

## Hypothesis
Running populated worlds forward and MINING them for critical encounters yields
training-grade scenarios that scripted authoring structurally cannot produce
(multi-party causation, negotiation, flow-induced conflicts). This is the implementable
form of the owner's "every agent is a driver" idea: the engine's seeded reactive
ambient drivers ARE the agents; no LLM in the hot loop; LLM only for dramaturgy and
labelling at the edges.

## Engine facts you build on (verified)
- `batch --ambient light|moderate|city|heavy --ambient-seed S --ambient-density D
  --ambient-max-actors K --ambient-radius-m R --ambient-settle SEC` populates reactive
  actors (`ambient:v1:*`) with per-driver seeded personalities (aggression, headway,
  reaction, speed variance), signal obedience, yielding, queue settling. ~2 s/cell at
  moderate density on this box; 24 cores; you get ≤6 workers but sim itself
  parallelizes across cells.
- Deterministic: same input → bit-identical trace. Seeds are your exploration axis.
- The engine has NO external per-tick control API. Do not attempt one. Perturbation
  happens through the INPUT: seeds, ambient profile, and authored interactions
  (`set signal:<id>.phase`, one injected hard-brake `speed` or `laneOffset` on a chosen
  actor via a minimal template).

## Method
1. **World template:** a minimal portable template — ego role driving a corridor (or
   through a signalized junction; there are 23 signalized junctions, 16 on yale), no
   challenger, no scripted conflict — plus heavy/varied ambient. A few variants
   (corridor, junction approach, multi-lane). This is scaffolding, not choreography.
2. **Sweep:** sites × ambient-seed × density × aggression (if the CLI can't set
   aggressiveness directly, vary preset+density+seed; check `--ambient-*` flags and the
   ambient profile JSON in batch-summary). Thousands of 20–40 s worlds. Budget compute,
   record cells/hour.
3. **Mine:** scan RAW traces for near-critical events between ANY actor pair (ego or
   not): TTC ≤ 4 s, OBB clearance ≤ 8 m, decel ≥ 2.5 m/s², yield-forced-stop, junction
   conflicts. Use tg_gate helpers for OBB clearance. Cluster events by kinematic
   signature; map to the 15-category taxonomy by trace facts (crossing geometry, lane
   relation, actor classes). Report the raw yield per 1000 world-runs FIRST — that
   number decides everything downstream.
4. **Promote:** for mined events not involving the ego, re-cast: author a template
   that reproduces the encounter with the ego in one participant's role (same site
   class, same kinematics as parameters, ambient kept ON). For ego-involved events,
   perturb the input (seed-local aggression bump / signal override timed via `at` /
   one injected hard brake) to push past the gate threshold. Then gate normally
   (frozen gate, portability ≥2 maps / ≥3 sites for the re-cast templates).
5. **Label:** an LLM (Codex pool) names the mechanism per admitted scene from trace
   facts; that label vs taxonomy = coverage claim.

Portability is a SECOND-STAGE claim: mined instances are site-pinned; only re-cast
templates can claim it. Never blur the two in reporting.

## Measured (PREREG.md before the sweep)
- Near-critical yield per 1000 world-runs, per density/preset; CPU-hour cost.
- Promotion rate: mined → gate-admitted (both perturbation and re-cast routes).
- Category spectrum of mined + admitted events (the interesting claim is breadth:
  does emergence find C-classes authoring is weak at — merges, negotiation, queues?).
- Novelty vs the authored corpus: kinematic-signature overlap with W7/M8 admitted cells.
- Realism scores from Stream B's scorer when it announces (expected: mined >> authored
  on aliveness — verify, don't assume).
- Blind-judge criticality on admitted scenes (judge_blind.py stage A conventions).

## Falsifiers
- Yield < ~1 admissible encounter per 1000 runs after promotion → mining doesn't pay
  on this engine at this fidelity. Report where it dies (no near-criticals at all? or
  near-criticals that can't be promoted past C5-collision/C2-spawn?).
- Spectrum collapses to 1–2 categories (rear-end soup) → emergence adds nothing over
  the longitudinal compiler.
- Mined scenes score WORSE than authored on Stream B's instrument → the "alive world"
  premise itself fails.
- Ambient determinism makes seeds a weak exploration axis (many seeds → near-identical
  worlds) → measure world-diversity first (actor count/paths across 20 seeds on one
  site); if diversity is low, that is an early honest exit.

## Milestones (hub-ping Main)
M1 world template + 20-seed diversity probe on easterbrook (GO/NO-GO on seed axis).
M2 PREREG.md + sweep launched (hub start for the driver). M3 mining yield table.
M4 promotion + gating results. M5 RESULTS.md + results.json committed to tg-rethink.
