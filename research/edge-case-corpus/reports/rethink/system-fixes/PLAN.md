# Plan: fewer checks, fixed system — 2026-08-18

Owner premise: most errors are ours (rendering/simulation), not the LLM's, so remove checks
and fix root causes. **The evidence mostly supports this**, with two named exceptions where a
check is the product definition rather than a compensation.

## 1. Is the LLM bad? Measured answer: no.

- Authoring: ~0 refusals across every campaign; compiler-path admission 0.80; W9 compiler
  DEV 0.7397 / HELDOUT 0.6815 on the frozen research gate. The generator holds its research
  baseline (14/21 and 12/21 raw gate accepts even mid-campaign).
- Defect ledger across all reviewed jobs (70-judge + 95-benchmark, this box):
  26 defect instances → `render.*` 9, `capture.*`+`judge.uncertain` 5 (all capture-caused),
  `simulation.*` 5, `scenario.*` 10. So **≥19/26 (~73%) trace to our renderer, capture path,
  simulation infra, or compiler expressiveness** — not to model judgment.
- The remaining `scenario.mechanism/sequence` failures are cases like "will-they-won't-they
  hesitation": the model authored a sane template; the **compiler has no lever** to express
  hesitation/reactive behavior. That is our representation, not the LLM.
- Historic infra losses: ~80% of one campaign's 160 attempts died on provider/gateway access
  and vision-assertion failures; 21+ 3D renders were spent on cells that had already failed
  semantics. All ours.

## 2. Check inventory — keep / demote / remove

KEEP (deterministic, cheap, catch OUR bugs — these are the product definition):
- Frozen physical gate (C1–C13, tg_gate). Non-negotiable per contract; it caught spawn
  artifacts and 30 m "conflicts". Removing it re-opens the fake-0.466 failure.
- Trace validity / evidence identity (sha-bound instance↔trace↔result). Caught TG-H1
  evidence corruption. Costs ms, no LLM.
- Deterministic eligibility (collision-contract, frozen-actor, off-road, clip window).
  Each exists because the simulator emitted a real defect class; they are bug detectors
  for §3. Once a root cause is fixed and its detector stays silent for a full breadth run,
  the detector demotes to an assertion.
- 62-semantic2d — the ONE LLM check kept: brief-aware 2D semantic gate. It replaced the
  11M-token repair recursion with a 674K-token loop (16×) and is the acceptance oracle.

DEMOTE to telemetry (stop blocking acceptance; report in benchmark only):
- 70-judge realism/aesthetic axes (`scenario.realism`, `render.asset.*` as verdicts).
  Presentation-clean was 0/24 cells — that is a renderer backlog metric, not a scenario verdict.
- `judge.uncertain` — already reduced by one-shot recapture; remaining instances page a human,
  never fail a scenario.

REMOVE outright:
- Reviewer gold-set calibration apparatus as a campaign prerequisite (already blocked-off;
  delete the gate wiring, keep qualify.py for later product-SLA work).
- v4 conjunctive acceptance predicate remnants (empty-defect-array requirement, duplicated
  JS/Python predicate) — acceptance is: semantic-2d pass + deterministic checks pass.
- Recursive reauthor plumbing left unreachable behind the semantic gate (dead code now).
- Proven-recipe fallback paths in benchmark jobs (already banned; remove the flag branches).

## 3. Root-cause fixes, priority order (each with its silencing detector)

P0 renderer exposure/lighting: 3× `render.camera.exposure`, "extremely dark rendering
   prevents verification". Fix tonemap/exposure in Studio renderer; acceptance = exposure
   defect count 0 across re-rendered showcase set and 2D/3D luminance histogram check in CI.
P0 capture robustness: transient browser failure, empty-scene frames, duration drift.
   Root fix in streamIdle/settle logic (retry already in); acceptance = 0 `capture.*` and 0
   `judge.uncertain` on a 10-job soak.
P1 authoring-surface levers (representation change, the lane's own maxim): add
   hesitation/pause/react-to choreography verbs + reactive triggers to template schema v2 and
   compiler. This unblocks the measured 0-semantic-yield cases (midblock-will-they class).
   Acceptance = semantic-2d yield >0 on the 3-case smoke without vista fallback.
P1 TG-H1 junction inputHash mismatch (half still unexplained, caps 22% of corpus briefs).
   Root-cause the remaining 8/48; acceptance = 0 evidence-mismatch bands on junction family.
P1 ENDPOINT_CLAMP: matcher accepts sites with no upstream runway, spawn silently clamps.
   Make required runway a matcher constraint derived from spawn offsets; clamping becomes an
   error. Acceptance = 0 clamped spawns in breadth run.
P2 asset backlog: sparse/low-detail construction assets, grounding, LOD — file as asset work
   items (render.asset.* telemetry drives the queue), never scenario failures.
P2 camera solving polish (framing/cuts) — after exposure, re-measure; may vanish with light.
P2 map inventory: 17/67 cases structurally unsupported (school zone, work zone, parking
   aisle, roundabout). Map-derivative toolchain or new maps; until then they report
   `unsupported`, honestly, in every benchmark.

## 4. Measurement protocol (fixed before running)

1. After P0s: re-run 3-case golden smoke. Report tokens, wall, semantic yield, defect ledger.
2. After P1 levers: same smoke; falsification = if semantic yield still 0 with hesitation
   levers present, the compiler-family thesis is wrong — escalate to owner before more work.
3. Then one 67-case breadth attempt (every hostable case exactly once), Wilson intervals,
   cold/warm separated. No unbounded retries; unsupported cases emit explicit records.
4. Rule held from the frozen contract: no threshold moves after seeing results; a clean
   negative is a result.

## 5. Two disagreements, stated plainly

- "Remove as many checks as possible" must not include the frozen gate or evidence-identity
  checks: they are cheap, deterministic, and every one of them exists because OUR system once
  lied to us. They are how we know a renderer fix worked.
- The LLM is not blameless everywhere: blind 2D screening was measured at AUC 0.853 with an
  unknown false-rejection rate, so the semantic gate keeps confidence + full-text verdicts in
  the ledger, and any acceptance-relevant disagreement stays human-inspectable. Trust, with
  receipts.
