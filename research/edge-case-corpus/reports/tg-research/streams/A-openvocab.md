# Stream A — Open-vocabulary authoring (kill the compilers)

Read `~/tg-research/streams/SHARED-CONTRACT.md` first; it is binding.
Read `~/tg-research/PLAN.md` §1–3 for the reasoning. Your dir: `tools/tg-research/openvocab/`.

## Hypothesis
Given the FULL ScenarioTemplateV2 vocabulary plus real engine feedback, an LLM can
author scenarios that (a) match the compiler pipeline's admission rate on the same
briefs, and (b) beat it decisively on mechanism provenance and scene richness — because
it can express the mechanism the brief names instead of routing to the nearest of 8
hand-written families.

Baselines to beat, same gate, same briefs (from `reports/training-grade/`):
- W7 LLM+compiler: DEV 0.6986 admission, provenance yes 0.4889 / no 0.3481.
- M8 deterministic: DEV 0.7534.
Richness baseline: every W7/M8 scenario is ego + 1 challenger + props, zero ambient,
zero signal events, zero unscripted lane changes.

## Method (agentic loop, per brief)
1. The model receives: the one-sentence brief + category; a distilled vocabulary doc YOU
   write once (from `packages/scenario-model/src/schema/v2/` and `uniscenarios schemas`
   — spend real effort here, it is your main design artifact; include the gate criteria,
   the physics facts, and the map facts from SHARED-CONTRACT); 1–2 rich gold examples
   (`examples/school-dartout.template.json` shape, NOT content).
2. Model emits a complete ScenarioTemplateV2 JSON (not a decision dict).
3. Harness: `template validate` → schema errors back verbatim → up to 2 repair rounds.
4. `sites match --all-maps` → if no sites, failureSummary back → repair.
5. `batch` (draws 4 probe, ≤6 workers, `--ambient` as the model requested — expose
   ambient as part of its vocabulary) → gate census per criterion + solver refusal codes
   + trace facts back → up to 2 revise rounds → final batch draws 10.
6. Gate with `tg_gate.gate_cell` (version=2, verdict+band from result.json evaluate
   fields), portability ≥2 maps / ≥3 sites, exactly like `author_llm.py` does — read
   that file to copy the gating/reporting conventions (NOT the compilers).

Rules:
- ZERO per-brief tuning by you. The harness+prompt is the algorithm; freeze it by hash
  before the measured DEV run (record sha256 in PREREG.md).
- The model may use scene_absolute NEVER — portable logical anchors only (reject at
  validate step; the schema allows scene_absolute but the lane contract forbids it).
- Ambient traffic, signal programs, weather, multi-actor: EXPOSED to the model as
  first-class options, never forced. Log what it chooses; that distribution is itself a
  result (does freedom get used?).
- Model: `gpt-5.6-sol` effort `medium` primary (owner relaxed the luna restriction;
  spend Codex). Keep every request/response logged to the run dir.

## Sample
DEV split of `agent-authoring/brief-corpus-full.json` (split field in the file;
DEV n=73). Run all 73 DEV briefs. If wall-clock forces a cut, cut to a stratified 40
(pre-registered seed) — never cherry-pick.

## Arms
1. **Main arm:** full vocabulary, sol/medium, 73 DEV briefs.
2. **Effort arm:** 20-brief stratified subsample (pre-registered), sol low vs sol high,
   same harness. This tests whether effort matters once there is something to reason
   about — the committed record has NO data on this (W8 not landed).
3. If time permits after both: HELDOUT sample (40 stratified of 135) through the frozen
   surface, once, zero tuning.

## Measured (pre-register in PREREG.md before run 1)
- Admission per arm (frozen gate; tripwire before/after).
- Provenance: run `tools/gates/judge_blind.py` (or its axis-3 logic re-hosted in your
  dir if the script is too entangled) on admitted archetypes, Codex model, outside the
  loop. Compare yes/partial/no vs W7's 0.489/0.163/0.348.
- Richness census from RAW traces per admitted scenario: actor count (incl. ambient),
  distinct interaction verbs fired, signal phase changes observed, unscripted lane
  changes/yields by non-ego actors, challenger count. Report distribution vs W7's
  (constant: 2 actors, 0 signals, 0 ambient).
- Schema-error rate and repair-round distribution; wall+token cost per admitted.
- Refusal honesty: briefs whose named structure the maps lack (roundabout etc.) — did
  the model approximate (like W7 did) or state infeasibility? Report, don't punish.

## Falsifiers (report against these explicitly)
- Admission < 0.35 on DEV after repairs → vocabulary too hard to wield blind; the
  compilers were load-bearing. Report the dominant failure mode.
- Provenance-yes ≤ 0.49 (no better than W7) → freedom didn't buy mechanism fidelity.
- Richness ≈ baseline (model ignores ambient/signals/multi-actor when offered) → the
  owner's thesis fails at the authoring step itself.
- Effort arm: report CIs; flat is a finding, not a failure.

## Milestones (hub-ping Main at each)
M1 vocabulary doc + harness runs 3 briefs end-to-end (any outcome). M2 PREREG.md
committed + surface frozen. M3 main arm done → RESULTS draft. M4 effort arm. M5 final
RESULTS.md + results.json committed to tg-rethink.
