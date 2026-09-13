# PLAN — rethinking scenario generation (Fable lead, path-pc, 2026-08-15)

Companion: `~/tg-research/REVIEW-NOTES.md` (what was verified, what didn't survive).
Scout evidence with file:line: `agent://EngineScout`, `agent://SchemaScout`,
`agent://RenderScout`, `agent://HistoryScout`.

## 1. What I believe the real problem is

**The project has been optimizing a number that is now saturated, while the thing the
owner wants is unmeasured and unproduced.**

Evidence chain:

1. Admission rate is effectively solved. The deterministic no-LLM surface hits DEV 0.7534
   / HELDOUT 0.6963; the LLM surface lands just below it (0.6986/0.6222). Once the
   representation defects were fixed, the model added nothing — because the model is
   handed ~14 scalar knobs on 8 hand-written compilers. Effort plausibly does nothing for
   the same reason (unconfirmed: W8 data not committed yet).
2. The residual admission losses are not authoring losses. C8/C12/C4/C11 fail because the
   five maps contain **zero** work-zone corridors, school zones, roundabouts, parking
   aisles. Every corpus-layout FAIL across every round cites balance, and balance is
   blocked on map inventory. No authoring algorithm fixes that.
3. What is actually deficient in the *admitted* corpus:
   - **35% of admitted scenarios fail mechanism provenance** (blind judge axis 3): the
     scene is critical but not the mechanism the brief asked for.
   - **Every scenario is a dead world**: ego + one challenger + props on an empty road.
     No ambient traffic, no signal dynamics, no negotiation, no swerving unless one of
     the 8 compilers hard-coded it. This is precisely the owner's complaint.
   - **Nothing measures realism or dynamism.** The gate certifies "a critical conflict
     occurred"; no instrument certifies "this looks like real traffic".

4. The decisive structural fact (scout-verified): **the representation already supports
   most of what the owner wants.** ScenarioTemplateV2 takes up to 64 roles and 256
   interactions; any actor can react to any other; signal phase programs and mid-clip
   `set signal:*.phase` overrides exist; weather/fog/friction mid-clip changes exist;
   the engine has reactive ambient traffic with seeded per-driver personalities
   (aggression, headway, reaction time), queue settling, signal-compliant yielding —
   **and it is wired into the batch CLI, and no authoring pipeline has ever used any
   of it.** The bottleneck is the authoring surface, not the engine, not the model,
   and not (contra the last two lanes' focus) the gate.

So the real problem, stated as one sentence: **the pipeline constrains authoring to a
vocabulary an order of magnitude smaller than what the engine can execute, and the
project has no instrument that would even notice.**

## 2. Where I disagree with the handoff / seed ideas (plainly)

- **"Vision has been tried twice and lost twice" — overstated.** n=32/arm, p=0.187,
  image shown only at the repair step, HELDOUT converged, and a sight-favoring quality
  subgroup (17/18 vs 9/18) exists in the same data. Verdict should be "not tested
  properly", not "lost". I am re-opening it, but as a *judging* instrument first
  (footage review), where the vision defect table says Codex models genuinely see.
- **"Hundreds of agents, every agent is a driver" — not implementable as stated.** The
  engine has no per-actor policy hook and no external step-wise control API (advance()
  only, no action injection). LLM-per-driver at 20 ms ticks is also ~10^5 LLM calls per
  20 s scene — economically absurd. The *achievable* form of the owner's game-like idea
  is: seeded reactive ambient drivers (already in the engine) + LLM-authored dramaturgy
  (who provokes what, where), + emergence mining. That is Stream C.
- **"Brute-force at scale with less validation" — half right.** Scale is cheap (engine
  ~75 ms/scene, 24 cores ≈ 1M scene-seconds/hour). But without an instrument for realism,
  brute force reproduces the same ceiling at higher cost — the handoff itself says this.
  So the instrument (Stream B) is a prerequisite, not an afterthought.
- **The handoff's time-accounting table** implies engine cost is the pain point. It isn't
  at research scale; direction is. I will not spend a stream on throughput.
- **"Effort buys nothing" is treated as established.** It is not committed anywhere I can
  read. It is plausibly true *for the current 14-knob surface*; whether it stays true
  when the model authors the full schema is exactly what Stream A measures (an
  effort-sensitivity arm is included deliberately).
- **VISTA analogy, taken seriously rather than nominally:** VISTA's claim is that fuzzy
  language reasoning + faithful high-dimensional observation beats symbolic
  reconstruction *for an exploratory task with cheap ground truth*. Scenario authoring
  has a generative goal and a correctness oracle (engine + gate). The honest mapping is
  not "make the author look at pictures" — it's "give the agent the real action space
  and real observations of outcomes, minimal task-specific scaffolding". The 8 compilers
  are the symbolic reconstruction. Removing them is the VISTA move.

## 3. The three research goals (deliberately separate from the current approach)

### Stream A — Open-vocabulary authoring (kill the compilers)
**Hypothesis:** given the full ScenarioTemplateV2 vocabulary plus engine feedback, an
LLM can author scenarios that (a) match the compiler pipeline's admission rate, and
(b) beat it decisively on mechanism provenance and richness — because it can express
the mechanism the brief actually names instead of routing to the nearest of 8 families.

**Method:** agentic loop per brief: author full template JSON → `template validate`
(schema errors back verbatim) → `sites match --rejected` (failureSummary back) →
`batch` on matched sites → gate + per-criterion census + trace facts back → ≤3 repair
rounds. Model: sol or luna medium (Codex pool); an effort arm (low vs high) on a 20-brief
subsample rides along. DEV subset first (~40 briefs stratified), frozen surface, then
HELDOUT sample if DEV survives.
**Measured:** admission (frozen gate, tripwire before/after), provenance (blind judge
axis 3, outside the loop), richness census from raw traces (ambient actor count, lane
changes, signal events, reactive yields, # distinct interaction verbs used), schema-error
rate per round, cost per admitted scenario.
**Falsified if:** admission < 0.5× compiler pipeline on the same briefs after 3 repair
rounds (vocabulary too hard to wield), or provenance-yes does not beat W7's 0.489 on the
same judge, or richness ≈ compiler baseline (model doesn't use the freedom even when
offered).

### Stream B — The realism instrument (measure what the owner wants)
**Hypothesis:** "looks like real traffic" can be measured cheaply and reproducibly, by
(1) deterministic trace-derived dynamism/naturalism metrics and (2) a vision judge on
rendered rollouts — and the two agree well enough to trust at scale.

**Method:** build the metric battery from raw traces (speed/accel/jerk distributions vs
naturalistic bounds, reactive-event counts: yields, gap openings, lane changes not
authored, signal compliance events, PET distribution, actor density); render rollouts
via `render-trace.mjs` (2D, CPU) and the vista matplotlib path; vision judge = Codex
model, `assert_vision.py` fatal preflight, randomized-color probe. **Calibration
first**: judge + metrics must separate (i) gold templates + ambient traffic ON from
(ii) the same scenes ambient OFF, and (iii) obviously-broken scenes (teleports, frozen
ego from the TG-P2 archive) from healthy ones, blind, n≥30 each. Also probe 3D: do the
synced dev-assets contain per-map `3d/` bundles; if yes, one Studio render smoke on the
RTX 5080 (bonus, not gating).
**Measured:** discrimination (AUC) between known-rich and known-sparse/broken sets;
judge-metric agreement; cost per judged scenario.
**Falsified if:** neither metrics nor judge reach AUC ≥ 0.8 on the calibration split
(then "footage review" as a QA cohort is not currently viable and that is the finding —
with the 2D-render caveat stated), or the judge is vision-blind on this path (assert
fails → hard stop, per handoff).

### Stream C — World-first generation (emergence mining, the inverse pipeline)
**Hypothesis:** running populated worlds forward and *mining* them for critical
encounters yields training-grade scenarios that scripted authoring structurally cannot
produce (multi-party causation, negotiation, flow-induced conflicts) — the "game-like"
formulation in its implementable form.

**Method:** site × seed × ambient-density × aggression sweep using the native ambient
generator (no LLM in the hot loop); simulate 20–40 s worlds; mine traces for near-critical
events (TTC/PET/decel thresholds below gate criticality); for hits, perturb locally
(seeded aggression bump, signal override via `set signal:*.phase`, one injected hard
brake / laneOffset) to push past the gate threshold while keeping the world alive;
emit as scene_absolute-pinned instances first, then attempt portable re-anchoring
(logical anchor from the site's structure) for the survivors — portability is a
*second-stage* claim, never skipped silently. Category-label mined events from trace
facts; report coverage against the 15-category taxonomy.
**Measured:** critical-encounter yield per 1000 world-runs and per CPU-hour; gate
admission of perturbed encounters; category spectrum; provenance is N/A (no brief) —
instead blind-judge criticality + Stream B realism scores; overlap/novelty vs the
authored corpus (is it finding things authoring can't?).
**Falsified if:** yield < ~1 admissible encounter per 1000 runs after perturbation
(mining doesn't pay), or the spectrum collapses to 1–2 categories (rear-end soup), or
mined scenes score *worse* on the realism instrument than authored ones (the whole point
is that they should look alive).

### Explicitly not run (and why)
- **Throughput/efficiency work** (unknown_site waste, probe overhead): real, cheap, not
  a research question. Streams wire the existing precheck; that's it.
- **More model/effort sweeps on the current surface:** W8 is finishing on the Mac;
  duplicating it here would burn quota to confirm a ceiling we are trying to remove.
- **Map authoring:** the single hard blocker for corpus balance, but a heavy asset
  pipeline with human dependencies (RoadRunner handoff). I record it as the standing
  constraint it is; if Stream C shows emergent scenes are map-starved too, that doubles
  the case for the human map handoff and I will say so in the synthesis.
- **LLM-per-driver at tick rate:** no engine API for it, and the cost math is absurd.
  Recorded as the honest gap between the seed idea and the engine.

## 4. How I'd know I'm wrong (lead-level falsifiers)

- If Stream A's open vocabulary neither lifts provenance nor richness at comparable
  admission, then the compilers were not the binding constraint and the owner's thesis
  (and mine) is wrong for this engine — the ceiling is the maps and the gate's scope,
  and the correct next spend is map inventory, not authoring freedom.
- If Stream B cannot build any instrument that separates rich from dead scenes, then
  "realism" stays an aesthetic judgment; the honest report is that footage-review
  cohorts are premature and the owner's cohort design needs a 3D/asset investment first.
- If Stream C mines nothing admissible, the "game-like emergent" direction is dead on
  this engine at this fidelity; scripted choreography plus ambient dressing (A+B) is
  what remains.
- All three could fail. That combined negative — engine-expressiveness is not the
  bottleneck either — would itself be a clean, valuable result pointing all remaining
  effort at map inventory + gate scope.

## 5. Work-stream mechanics (contracts in each agent's brief)

- Branch `tg-rethink` off `training-grade-lane`, pushed to origin; the Mac's W8/W9 lane
  keeps `training-grade-lane` to itself. Single worktree; streams own disjoint dirs
  `tools/tg-research/<stream>/`; nobody edits `packages/` or `tools/gates/` without
  lead sign-off; lead owns commits and synthesis.
- Frozen gate untouched: `verify_gate_hash.py` PASS required in every stream report,
  start and end. Tightening only, and only via lead.
- Runs go to `/tmp/tgr-<stream>-<runid>/`, never reused.
- LLM calls via gateway `http://127.0.0.1:4141/v1` (hub-managed, persistent). Vision
  paths: Codex models only, `assert_vision.py` fatal preflight.
- Reports: `research/edge-case-corpus/reports/tg-research/<stream>/RESULTS.md` +
  `results.json` with metrics pre-registered in the stream brief before first run.
  Raw-trace reading only; no summary fields except evaluate verdict/band where C5
  defines them.
- CPU budget: ≤6 batch workers per stream (24 cores, 3 streams + lead).
- Honesty rule verbatim from the handoff: a clean negative is a real result; no metric
  invented after seeing results; deviations labelled, never silent.

## 6. Sequence

1. (done) Environment: pnpm build, venv, gateway up, dev-assets syncing from laptop.
2. Lead smoke: one gold template end-to-end (match → instantiate → simulate → gate →
   render) + one ambient-ON run to prove the full loop on this machine, before agents.
3. Spawn Streams A, B, C as omp Fable agents with the briefs in
   `~/tg-research/streams/`. B's calibration corpus depends on lead smoke artifacts;
   A and C are independent.
4. Mid-flight: pull origin for W8 results when they land; fold into the effort question.
5. Synthesis: `~/tg-research/SYNTHESIS.md` + commit reports to `tg-rethink`; push.
