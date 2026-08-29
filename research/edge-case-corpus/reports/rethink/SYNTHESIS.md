# SYNTHESIS — rethink results (lead, FINAL; all five streams complete)

Branch `tg-rethink`. Every number is from a stream REPORT.md (command included there) or merged W8/W9.
Streams: A FreeformLane, B FootageLane, C EmergentLane, D EngineLane, E VistaLane. All PREREGs written before measurement; all falsifier verdicts stated.

## 1. The three-way authoring head-to-head (same frozen 50-brief sample, same gate, same judge)

| arm | admission | tokens/admitted | footage realism | footage dynamism | unique strengths |
|---|---:|---:|---:|---:|---|
| Compiler (author_llm, luna/med) | **40/50 = 0.80** | **3.5K** | 5.91 | 3.12 (max 5) | volume, cost, determinism |
| Visual agent (VISTA-style) — sol/high | **36/50 = 0.72** | 1.83M | ~6.0 (gate-passers) | ~3.2 | C8 workzone 2/2 by CONSTRUCTING features on maps with zero workzone sites; owner list 18/20; discovered warm-up physics unprompted; 40→8-13 action learning curve; **compiler∪visual = 0.94** |
| Visual agent — sol/low | **36/50 = 0.72** | 1.08M (60% wall) | — | — | effort buys nothing under visual freedom either |
| Text freedom (full schema, terra/low = grid winner) | 9/50 = 0.18 | 522K | 4.90 | 2.76 | 98% validity; 1 unique admission; only mid-clip signal changes ever recorded |

**Stream A verdict: clean negative.** Full-schema text freedom loses on admission, judged realism, AND cost. "Alive-but-inadmissible" disconfirmed (gate-failed freedom cells: realism 4.84 / dynamism 2.64 — dead AND inadmissible). The vocabulary is wieldable syntactically (98% validity); the criticality *physics* is what the 8 compilers encode and what blind text models cannot land.

**Stream E verdict: split, honestly.** Vision beats text-freedom 4× on admission — the historical "vision lost twice" claim was that repair-loop's design, not the pixels. Vision does NOT beat the compiler on admission (0.72 < 0.80 at ~300× tokens; the cost falsifier fires and is stated) and does NOT beat it on judged realism. Its real value is **reach**: it admits what the compiler structurally cannot (constructed work zones on maps with zero workzone sites, 18/20 owner-list items), and compiler∪visual covers **0.94** of the sample. Cross-brief GUIDE learning is real and measured.

**Cross-surface finding (new, load-bearing):** gate-passing scenarios from ALL THREE surfaces converge to the same ~6.0 realism / ~3.2 dynamism "tidy but dead" band. The gate shapes what authoring produces regardless of authoring freedom — realism/dynamism must come from levers OUTSIDE the authoring surface (ambient, emergence, gate-scope extension), which is exactly what streams B/C measured.

## 2. The effort question — answered, and it splits three ways

| surface | effort effect | evidence |
|---|---|---|
| compiler authoring | none (flat-to-down at 17-30× tokens) | W8, 30 arms (Mac, merged) |
| full-schema text authoring | not supported (luna 0→0→2, sol 1→2→2, terra 4→2→3; CIs overlap; winner is LOW effort) | FreeformLane grid, 9 arms |
| visual interactive authoring | none (sol/high 0.72 = sol/low 0.72, low at 60% wall / 59% tokens) | VistaLane paired full-sample cells |
| footage judging | **buys discrimination**: low→med +0.09–0.14 AUC all models | FootageLane, 432 blind calibration verdicts |

Model side: sol "never worse" (W8) and the chosen judge; **luna is the outlier judge (never adequate, ρ≈0.5)** — every historical number in this project was luna-judged.

## 3. Footage review (owner mandate) — VIABLE, calibrated, in production

- Judge sol/medium/spread8: **AUC 0.853** [.75,.95] good-vs-absurd; 4.9K tok / 13.5 s per verdict; ~2,400 verdicts/hour. Final service total: **4,360 cells / 13,080 verdicts / 80.4M tokens / 0 judge errors**, vision-asserted every session.
- **Gate ⊥ realism at scale** (AUC 0.47–0.51 vs gate verdicts): the gate certifies criticality, not looks. First independent instrument confirming the plan's thesis.
- **Corpus deadness quantified**: dynamism median 3/10 everywhere scripted; compiler = "tidy, plausible, dead".
- Known weak class: 1-2-frame VRU-occluder overlaps (render cue proposal filed). Realism is a score (test-retest SD 0.69), not a per-cell verdict.

## 4. Ambient + emergence (owner's game-like thesis) — the cheap levers, with one structural ceiling

- **Light ambient is the production default**: realism +0.17 (p=0.012) AND dynamism up, gate survival −3 pp only, determinism 36/36 byte-identical, authored choreography unharmed. Beats authoring-freedom as a dynamism lever at a fraction of the cost.
- **Harvest works as a diversity engine**: 11.6–17 admitted/1000 world-runs (floor, budget-capped), 8-category spectrum, no rear-end soup, 2 organic unprotected-lefts (owner list), 3/11 promoted cells beat every authored gate-passer on joint axes. Harvest footage is the most alive measured (dynamism median 6 vs corpus 3). Cost ~2.8 core-h/admitted — diversity engine, not volume engine.
- **Signal blackout probe: implicit four-way stop EMERGES** (stop-and-proceed ×7, no gridlock).
- **Structural ceiling, stated as an instrument fact**: C4 rejects hesitation by construction — four-way negotiation and zipper merges are abundant in the mined layer (8,913 yield-stops, 2,934 merge negotiations) and **un-certifiable by the frozen gate**. Certifying them requires a new pre-registered criterion (gate-scope extension, argued openly), not a loosening.
- Promotion ceiling: C4-dissolution (52% of deaths) → per-actor policy hook is the lever (design note delivered, ~300-400 lines, not built).

## 5. Base repo improvements (owner standing order) — landed, tested, pushed

- **30% engine waste eliminated** (plan-vs-worker matcher drift; refused cells were VALID sites): 96.4→37.7 s wall, refusals 50→0, ok cells 115→165 on the reference batch (6dc8e5f).
- **Evidence-join defect fixed** (TG-H1 family — control-lane repair after inputHash stamp; capped 22% of the old corpus) (b511f7c).
- **Renderer**: map/lane/crosswalk underlay, --redact, kind glyphs, follow-ego camera, spawn-window frames, EV light rendering; 0.34–0.78 s/cell (8acd6e5, c2af2bf, 5873bce, 194fc1f, ec46376).
- **Vocabulary**: delivery robots now real movers (failing-test-first); animal + debris verified end-to-end; shopping cart honestly deferred (7-package seam documented).
- Every change: failing test first; cli 62-failure baseline verified unchanged; tripwire PASS start+end of every stream.

## 6. What remains between here and "any amount of high-quality edge cases"

1. **Gate-scope extension for negotiation criticality** (pre-registered new criterion; the mined events are waiting).
2. **Map inventory** (roundabout, school zone, parking, unstructured spaces) — human/RoadRunner dependency; blocks categories at ANY authoring skill. Owner-list unstructured rows land here.
3. **Per-actor policy hook** (designed) — unlocks harvest's C4-dissolution ceiling.
4. **Provenance**: ~35% of admitted scenarios critical for the wrong reason; even the visual agent routed around failed signal probes. Judge partially catches this; a provenance check in the footage rubric is the cheap next step.
5. Render cue for 1-2-frame occlusion overlaps (judge's one weak class).

## 7. Production recipe supported by the evidence

Route briefs: compiler (standard mechanisms) | visual agent (unhosted/hard categories) | harvest (no-brief diversity). Dress everything with light ambient. Simulate. Filter by frozen gate AND footage judge (both, they're orthogonal). Feed per-criterion failures back. Corpus = portable templates, bit-identical replay.

## 8. Inheritances and integrity notes
- W8/W9 (Mac) merged: H1 falsified, W9 = sol/low, DEV 0.7397 / HELDOUT 0.6815 (≈ luna/medium, cheaper).
- Prior dead lead session's plan/tooling absorbed with explicit reuse/supersede lines in each REPORT §0.
- Frozen gate untouched throughout: tripwire PASS on every stream, start and end. FreeformLane pilot v1 and FootageLane pilot v1 were VOIDED as instrument defects with PREREG amendments — kept on disk, not deleted.
- VistaLane self-corrected two of its own favorable claims (C13 "signal wins" were routing-around; 11 owner briefs sabotaged by a post-freeze harness defect, supplementary run labeled).
