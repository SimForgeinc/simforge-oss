# PREREG v2 — Stream B footage-judge calibration (model × effort grid)

Registered 2026-08-16, BEFORE any measured pilot or grid verdict. Branch `tg-rethink`.
Gate tripwire at registration: PASS (v1 `1a08698e95fca4bc` / v2 `3823182614e5a5ba`).

**Supersedes** `tools/tg-research/instrument/PREREG.md` (v1, previous lead session),
which pre-registered a calibration of a filmstrip judge + deterministic metrics but
never produced a measured result (no results.json exists in its run dir or in git).
Per-change reasons:

| v1 element | disposition | reason (one line each) |
|---|---|---|
| Naturalism axis (healthy vs broken) | **kept** — this is our good-vs-absurd axis | same question, same labels |
| Aliveness axis (R+ vs R- ambient) | **dropped here** | ambient on/off is Stream C's paired-arm experiment (plan §3C); duplicating it in calibration confounds classes |
| AUC ≥ 0.8 success threshold | **kept unchanged** | no goalpost moves after the fact |
| Judge rubric (5 subscores) | **replaced** by contract-§3 verdict (realism/dynamism/plausible/defects) | RETHINK-CONTRACTS §3 is lead-mandated and shared by all streams |
| Single filmstrip PNG input | **replaced** by multi-frame input from `scripts/render-trace.mjs` | assignment mandates consuming render-trace.mjs (+EngineLane `--redact`/`--dev-assets` underlay); filmstrip.py's blinding rationale is carried over via `--redact` |
| Single judge (sol/medium) | **replaced** by {luna,sol,terra}×{low,medium,high} grid | owner amendment 2026-08-16 (contracts §6) |
| broken-templates b1/b2 | **reused verbatim** (sha256 below) | verified absurdity signatures, cheap to regenerate |
| metrics.py markers | **reused read-only** for label verification only | deterministic absurdity markers; NOT an instrument under test here |
| calibrate.py/judge.py/filmstrip.py code | **superseded** by tools/research/footage/* | contract cell layout + grid + strategies require a rewrite; AUC/Youden math re-implemented and spot-checked |

## Pinned implementations (sha256 at registration)

    tools/research/footage/futil.py               0073afd42e2a26cbd0773ca986bc82d91335036dbc4b7439f2ce85baa3887a46
    tools/research/footage/render_cells.py        f064d2d51dc0818b8681ce6c6e00768170433c650bddda73e9d16f3a1b3bd7ae
    tools/research/footage/judge.py               9fd592c79c6d6f9f52241743fb7c6fc23e199b0875d79d25a73b1774e50f5d89
    tools/tg-research/instrument/metrics.py       0f089bc386af2abfabb683ec080ec336ac84c67d2b86dbea30a77aae6901440a
    b1-frozen-ego.template.json                   04e0d5425c1c0ed7ee29b57322301bdf19a86c24502ee0e0cf0f460db4bdc4e7
    b2-zero-kph.template.json                     9b06fc4a9f61c97386f34f6728841831231578b2bde11c9e48650d89de3bcf86

Note: analysis/driver code may be bug-fixed before the first measured verdict of each
stage; the shas actually used are recorded in REPORT.md per stage. Rubric wording,
metric definitions, thresholds, and the selection rule are frozen NOW. The judge
rubric's sha256 travels inside every verdict (`_meta.promptSha256`).

## Hypothesis

A codex-vision judge on redacted top-down renders separates physically-absurd from
known-good cells (realism AUC ≥ 0.8 for at least one model×effort arm), giving the
project its first validated realism instrument.

## Calibration set

- **good** (target 24, min 20): regenerated cells from 8 gold/example templates
  (6 `examples/mechanisms/*` + 2 `c7-*-fixed` probes) that PASS the frozen gate
  (verdict/band from batch result.json; `brief` set to arm C6 for occlusion probes).
- **absurd** (target 24, min 20): regenerated cells from 7 committed broken templates
  (5 `c7-*-baseline` VRU-in-occluder probes; `b1-frozen-ego`; `b2-zero-kph`), each kept
  ONLY when its deterministic absurdity marker verifies on the raw trace
  (prop_overlap_count ≥ 1 / frozen_ego = 1 / authored_stop_violations ≥ 1).
- Both classes: ambient OFF, maps = all five, `--max-sites 2 --draws 2`, seed 20260816
  stratified round-robin sampling across (template, map). Exclusions counted in
  set-manifest.json. No cell dropped after a judge score exists.

**Amendment 2026-08-16 (before any judge verdict):** the first 8 good templates yielded
only 4 distinct gate-passing mechanisms (C5/C4 losses); 12 further `examples/mechanisms/*`
templates were added to the good pool for mechanism diversity (final good class: 24 cells /
7 templates; absurd: 24 cells / 7 templates). No judge had seen any pixel at amendment time.

**Amendment 2 (2026-08-16, still before any measured verdict):** the renderer keyed VRU
glyphs off the literal actor id `ped`; real cells use other ids, so pedestrians rendered
as ~4 px unclassed boxes. Fixed in `scripts/render-trace.mjs` (glyph/colour from
`trace.header.actorMetadata[id].kind`, id fallback preserved), and the rubric's legend
sentence was extended to name the cyclist/motorcycle glyphs that fix introduces. Scores,
defect classes, thresholds, strategies, and the selection rule are untouched. The only
measured verdict at amendment time was the pipeline smoke (recorded in REPORT §2), which
enters no statistic.

**Amendment 3 (2026-08-16, before any GRID verdict):** the first pilot (72 verdicts,
`pilot-verdicts.jsonl`, kept on disk) is **VOID** — it exposed two instrument bugs, not
judge behaviour: (a) the renderer's minTTC-pair-midpoint camera drifts off every actor
as the pair separates (verified: frozen-ego cells rendered as empty road by mid-clip;
judge correctly reported "no visible ego"), and (b) the frame plan sampled only the
conflict window, while the VRU-in-occluder overlap exists only at VRU spawn. Fixes:
`--camera follow-ego` render mode (ego-centred every frame) and label-blind
spawn-window frames (first-present +0.6/+1.2 s of every non-ego actor, all cells).
The pilot is re-run from scratch post-fix; strategy selection uses only post-fix
verdicts. Rubric, scores, thresholds, strategies, and the selection rule unchanged.

## Judge input and strategies

Renders via `scripts/render-trace.mjs` with `--redact` (no ids, no minTTC/reveal HUD —
the judge NEVER sees gate metrics) and `--dev-assets` underlay when available.
Frame plan: 12 uniform + 6 conflict-centred frames (render_cells.py, deterministic).
Two payload strategies, piloted then ONE frozen for all measured runs:
- `spread8`: 8 frames spanning the clip.
- `burst6`: ~6 frames at ~0.5 s spacing around the conflict moment.
Pilot: 12 cells (6/6 stratified), 3 models @ medium, both strategies. Pick = higher
mean realism-AUC across models; tie → fewer mean tokens. Pilot verdicts are excluded
from grid statistics.

## Grid and analysis

Frozen strategy × {luna, sol, terra} × {low, medium, high} × all cells, seeded-shuffled
order, blind (only PNGs + rubric). Primary metric: **realism AUC** (Mann-Whitney,
midranks) good-vs-absurd per arm, 95% CI by 1000-draw stratified bootstrap
(seed 20260816). Secondary: dynamism AUC, plausible/defect rates per class, Youden-J
confusion, per-broken-template realism, inter-model Spearman per effort, tokens +
latency per verdict.

## Selection rule (declared before any grid verdict)

    adequate(arm) := realismAUC >= 0.80 AND bootstrapCI95.lo >= 0.70
    chosen judge  := argmin over adequate arms of mean total tokens/cell
                     (ties: lower mean latency, then lower effort, then sol<luna<terra
                      — sol first per W9 production default)
    no adequate arm -> calibration FAILED: report plainly, propose render fixes, DO NOT scale.

## Vision discipline

`assert_vision.py` randomized-colour probe per model per process, ≤3 attempts
(fresh random colour each; a blind model fails all colours), every attempt recorded.
Anthropic models never on an image path. `visionAsserted` in every verdict.

## Falsifiers being tested (plan §3B)

1. No arm separates the classes → footage review is currently ceremony; report + stop.
2. Inter-model agreement near chance → single-judge verdicts untrustworthy at scale.
3. Judge verdicts uncorrelated with the deterministic absurdity markers → judge sees
   pixels but not physics; render lacks the needed cues.
