# W8 — model × effort sweep on scenario authoring (PRE-REGISTERED)

Added 2026-08-15 by the human owner's instruction: *"feel free to use Sol models, Terra models, and
Luna models freely with different levels of effort. This should be a whole experiment as well."*

**This document is pre-registered.** It is written before any arm runs, and the primary metric and
analysis are fixed here. Do not edit the metric, the brief sample, or the analysis after seeing
results. If the design turns out to be wrong, say so in FINDINGS and start a new pre-registration —
do not quietly revise this one. Post-hoc metric selection is the exact failure the frozen contract
exists to prevent.

## Relationship to W7 — read this before touching anything

**W7 is not part of this experiment and does not change.** The frozen run stays
`gpt-5.6-luna` at reasoning effort `medium`, because `VISTA-LANE-BRIEF.md:17` says *"Do not
substitute another model"*, `vlm.py`'s contract line says *"The only permitted model: gpt-5.6-luna,
reasoning effort medium"*, and W7's entire purpose is a like-for-like comparison against the
published DEV/HELDOUT baselines. Swapping its model would make the comparison meaningless.

W8 is a **separate arm alongside it**. `luna/medium` is W8's reference cell, which is what ties the
sweep back to the frozen run.

**Hard constraint:** W8 results must never be used to retroactively re-pick W7's model or effort.
If a different arm scores better, that is a finding to report, not a licence to re-run W7.

## Availability — verified, not assumed

All 15 combinations return `status=completed` over the omp auth-gateway
(`OPENAI_BASE_URL=http://127.0.0.1:4141/v1`):

```
gpt-5.6-luna    low medium high xhigh max    all completed
gpt-5.6-sol     low medium high xhigh max    all completed
gpt-5.6-terra   low medium high xhigh max    all completed
```

Effort is genuinely honored — on a prompt that requires real reasoning, `luna`:

| effort | reasoning tokens | wall |
|---|---|---|
| `low` | 2,258 | 57 s |
| `max` | 11,888 | 239 s |

5.3× reasoning tokens, 4.2× latency. On a trivial prompt every arm reports
`reasoning_tokens=0`, so **do not preflight effort with a trivial prompt** — it looks like the
parameter is being dropped when it is not.

Two observations worth carrying: `max_output_tokens=6000` did not cap a response that reported
`output_tokens=13161`, so do not rely on that field as a cost bound; and latency scales steeply
with effort, which is the main driver of wall-clock cost below.

## Hypotheses (fixed now)

- **H1.** Higher reasoning effort raises gate admission rate, monotonically, within each model.
- **H2.** Model rank at fixed effort is stable across effort levels.
- **H3.** Effort helps most on the criteria that need multi-step spatial reasoning (C2 gap
  realisation, C4 deceleration demand), and not on criteria that are mostly lookup.

All three are falsifiable and **a negative result is a real result.** If effort does nothing, that
is the finding, and it is a useful one: it would mean authoring quality is bounded by the tool
surface and the brief, not by model deliberation.

## Design

- **Arms:** 3 models × 5 efforts = **15 arms**.
- **Sample:** a fixed, stratified sample of **n = 20 briefs** drawn once from
  `agent-authoring/brief-corpus-full.json`, stratified by category, with the seed and the resulting
  brief ids recorded in the report. **Every arm sees exactly the same 20 briefs.** Do not resample
  per arm.
- **Everything else held constant:** identical authoring prompt, identical tool surface, identical
  maps and seeds, identical gate. Only `model` and `reasoning.effort` vary.
- **Gate integrity:** run `tools/gates/verify_gate_hash.py` before the first arm and after the last,
  and record both hashes in the report. The gate is frozen; W8 may not relax it, and admission must
  be computed by the same unmodified gate that produced the W7 numbers.
- **No prompt tuning between arms.** If the prompt is changed, every arm is invalid and the sweep
  restarts.

### Primary metric (fixed)

**Gate admission rate** over the 20 briefs, per arm, under the frozen gate. Report with a binomial
95% confidence interval. With n=20 the CI is wide — that is expected and must be stated rather than
glossed; the sweep is powered to detect large effects only.

### Secondary metrics (fixed)

- Per-criterion failure share (C1–C7) per arm — this is where H3 is tested.
- Reasoning tokens, output tokens, and wall time per brief per arm.
- **Authoring determinism:** re-author 5 of the 20 briefs a second time per arm and report whether
  the authored output is identical. Non-determinism at fixed effort would confound H1 and must be
  measured, not assumed away.
- Refusal/error rate, separated from gate rejection. A model that fails to emit a usable artifact
  is not the same as one whose artifact gets rejected, and collapsing the two would flatter the
  weaker arms.

### Cost control

Budget the wall clock before launching: at `max` effort a single call ran 239 s, so a naive serial
sweep is 15 arms × 20 briefs × up to ~4 min ≈ **20 hours**. Therefore:

- Run briefs **concurrently** within an arm (the gateway handles parallel requests; start at 4–6
  concurrent and back off on errors).
- Run the sweep in two stages: **all 15 arms at n=20 first**, then deepen only the arms that the
  first stage shows to be interesting, with the deepening pre-registered as an amendment.
- Record wall time and token counts per arm so the cost/benefit of effort is itself a result. If
  `max` costs 4× for no admission gain, that is one of the more useful things this experiment can
  say.

Codex quota headroom is adequate as of writing (`omp usage`: openai-codex 7-day at 1% and 28% on two
accounts), but check it before launching and again mid-sweep.

## Analysis (fixed)

1. Admission rate per arm with binomial 95% CI, as a 3 × 5 table.
2. H1: is admission monotone in effort within each model? Report the direction and whether the CIs
   overlap. Do not claim a trend that the CIs do not support.
3. H2: is model rank stable across effort levels? Report rank per effort level.
4. H3: per-criterion failure share by effort, specifically C2 and C4 against the lookup-ish criteria.
5. State plainly which hypotheses survived and which did not.

## Reporting

Write `reports/training-grade/W8-model-effort-sweep.json` with the full per-arm, per-brief records
(brief id, model, effort, admitted, failing criterion, tokens, wall time), and a `W8` section in
`FINDINGS-TRAINING-GRADE.md` with the 3 × 5 table and the hypothesis verdicts. Include the arm
count, the brief sample seed, both gate hashes, and the total token and wall-clock cost.

`LANE-COMPLETE.json` must include a `W8` entry, and must not be written before W8 has either
completed or been explicitly recorded as not-run with a reason.

## The deviation still applies

Every W8 arm reaches the models over the omp auth-gateway backed by **Codex OAuth**, which
`VISTA-LANE-BRIEF.md:17` tells the lane not to use. The owner accepted this knowingly. Record it
once in the W8 section as the same labelled deviation noted for W7, so the numbers stay honest and
re-runnable if raw API keys turn up.

---

# AMENDMENT 1 — the model restriction is relaxed; W9 production arm added

Added 2026-08-15 ~20:45 PDT on the owner's explicit instruction: *"Yes you should run another ARM.
Relax this model restriction. We want the absolute best model to be used for this process."*

This amendment is made **before any W8 arm has run**, so no result has been observed and the
pre-registration is still clean. Nothing in the original design is edited; this only widens the
candidate pool and adds an arm.

## The restriction being relaxed, stated exactly

`VISTA-LANE-BRIEF.md:17` — *"Do not substitute another model. Do not use a Codex OAuth token."* —
and `vlm.py`'s former contract line, *"The only permitted model: gpt-5.6-luna, reasoning effort
medium."*

Both are **overridden by owner decision**, recorded here and to be recorded in
`FINDINGS-TRAINING-GRADE.md`. The owner's stated goal is that the best available model be used for
the authoring process, not that the lane remain bound to luna.

## What still does not move, and why

**W7 keeps a luna/medium run.** This is not a hedge against the instruction; it is the only thing
that keeps every other number interpretable. The published DEV 0.466 / HELDOUT 0.452 baselines were
produced under luna/medium, and the lane has already shown those numbers were inflated by a gate
bug (`tools/vista/gate.py:206`). If the model changes at the same time as the gate correction, the
two effects are inseparable and no delta is attributable to either. luna/medium is the calibration
point. It is cheap — one run — and without it the sweep and the production arm measure nothing
against history.

So: **W7 = calibration** (luna/medium, unchanged). **W9 = production** (best available model). Both
are reported, and the difference between them is one of the more useful results here.

## Widened candidate pool

`VISTA_MODEL` and `VISTA_EFFORT` now override the model and effort in `vlm.py`, defaulting to
`gpt-5.6-luna` / `medium` so an unset environment still reproduces W7 exactly.

Text-only authoring — all verified live over the gateway:

| model | api family | vision | notes |
|---|---|---|---|
| `gpt-5.6-luna` | openai-codex-responses | **4/4** | W7 reference cell |
| `gpt-5.6-sol` | openai-codex-responses | **4/4** | |
| `gpt-5.6-terra` | openai-codex-responses | 3/4 | sees images; calls pure red "orange" |
| `claude-opus-5` | anthropic-messages | **0/4** | text-only use ONLY |
| `claude-fable-5` | anthropic-messages | **0/4** | text-only use ONLY |

**CORRECTION (same amendment, before any arm ran).** As first written this section said "a sixth
model arm ... 6 x 5 = 30 arms" while the table above listed only five models. The arithmetic was
wrong, not the table. The lane spotted the contradiction and resolved it by adding
`claude-sonnet-5`, having verified it answers through the harness path. That resolution is
**ratified here deliberately**, so the arm count is a fixed decision rather than an inference from a
typo:

**Pool = 6 models** — `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `claude-opus-5`,
`claude-fable-5`, `claude-sonnet-5` — **x 5 efforts = 30 arms.**

Authoring is text-only (`author_llm.py:538` calls `vlm.ask_json` with no images), so the vision
defect does not affect authoring validity for any of the six. `claude-sonnet-5` inherits the same
vision prohibition as the other Anthropic models and must be re-probed with `assert_vision.py`
before it is ever used on an image path.

Note also, observed while preflighting: these models **confabulate their own identity** when asked,
so a self-reported model name is not evidence of routing. Trust `omp dry-balance`, the gateway's
`model` field in the response, and per-arm request logs instead.

## MANDATORY vision guard — do not skip this

The gateway's Anthropic translation **silently drops `input_image`** and answers in confident prose
anyway. `claude-opus-5` and `claude-fable-5` score 0/4 on solid-colour probes while returning
`status=completed`.

The blind judge (axes 3–4) and `loccritic` score *rendered rollouts*. Running either on an Anthropic
model would produce fluent, plausible, completely ungrounded verdicts that no downstream metric
would expose. Therefore:

- **Every vision path stays on an openai-codex model.** Not negotiable, and not covered by the
  owner's relaxation, which was about authoring quality — a blind judge is not a better model, it is
  a broken measurement.
- **`tools/gates/assert_vision.py` must pass before any run that scores images**, and its failure is
  fatal. It probes a randomly chosen colour per call, because terra confabulates a fixed "orange"
  and a red-only probe would misjudge it while a blue-only probe would miss its naming flaw.

## W9 — production arm, best available model

1. Run the **stage-1 W8 sweep** (30 arms, n=20 briefs) to identify the best configuration by the
   pre-registered primary metric: gate admission rate under the frozen gate.
2. Select the winner **by that metric alone**, declared before looking at anything else. Break ties
   on the lower cost arm (tokens × wall time). If two arms overlap within their binomial CIs, say so
   and take the cheaper — do not manufacture a winner the data does not support.
3. Run the **full DEV and HELDOUT authoring** with that configuration, through the same unmodified
   frozen gate, and report admission for both plus the generalization gap with a p-value, exactly as
   W7 does.
4. Report **W7 (luna/medium) and W9 (best) side by side.** The headline number is the delta and
   whether it survives on HELDOUT — a production arm that wins on DEV and not on HELDOUT has bought
   overfitting, not quality, and must be reported as such.
5. If the winner is a vision-blind model, W9 still uses it for authoring, but the judge stays on a
   vision-capable model and the split is stated explicitly in the report.

`LANE-COMPLETE.json` must carry a `W9` key with the selected configuration, the selection rule as
applied, DEV and HELDOUT admission, the gap and p-value, and the W7-versus-W9 comparison.
