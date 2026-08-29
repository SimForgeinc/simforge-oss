# Stream B — FootageLane: footage review at scale (owner mandate)

Status: **pipeline ready; calibration in progress.** Updated incrementally per contracts §8.
Branch `tg-rethink`. Gate tripwire at session start: PASS (v1 `1a08698e95fca4bc` / v2 `3823182614e5a5ba`),
command: `.venv/bin/python tools/gates/verify_gate_hash.py`.

Pre-registration: [`PREREG-v2.md`](PREREG-v2.md) — supersedes
`tools/tg-research/instrument/PREREG.md` (prior lead session; never produced a measured
result). Per-element reuse/supersede table is in the prereg. One-line summary: their
broken templates + marker metrics are REUSED verbatim (sha-pinned); their filmstrip
judge path is SUPERSEDED by `scripts/render-trace.mjs --redact --dev-assets`
(EngineLane underlay, commit `8acd6e5`) because the assignment consolidates rendering
there; their AUC ≥ 0.8 success threshold is kept unchanged.

## 1. Pipeline (tools/research/footage/)

```
cell/{instance.json,trace.json.gz,meta.json}          (contract §2, built by build_calibration.py
        |                                              or published by Streams A/C)
        v
render_cells.py  -> cell/render/{frames/*.png, rollout.mp4, render-manifest.json}
        |            node scripts/render-trace.mjs --redact --dev-assets dev-assets
        |            frame plan: 12 uniform + 6 conflict-centred times (deterministic)
        v
judge.py         -> contract-§3 verdict (blind: rubric + PNGs only; strategies spread8|burst6)
        v
calibrate.py     -> pilot (freeze strategy) -> grid {luna,sol,terra}x{low,med,high} -> AUC
```

- Renderer consumption, not a new renderer: lane/junction/crosswalk underlay and the
  `--redact` flag (suppresses actor ids + minTTC/reveal HUD text — gate metrics the
  judge must never see) were requested from and landed by EngineLane (`8acd6e5`).
  Only `t=<sim seconds>` text remains on redacted frames.
- Vision discipline: `assert_vision.py` randomized-colour probe per model per process,
  ≤3 attempts, all attempts recorded in run artifacts; fatal on exhaustion.
  Env required: `OPENAI_BASE_URL=http://127.0.0.1:4141/v1 OPENAI_API_KEY=x`
  (without it the probe correctly failed against api.openai.com — verified 401, fatal).

## 2. Dependency + smoke evidence (all commands exact)

- `sharp` resolves in-workspace (`node_modules/.pnpm/sharp@0.34.5`); `ffmpeg` at
  `/usr/bin/ffmpeg`. No local installs needed.
- Batch smoke: `node packages/cli/bin/uniscenarios.js batch examples/multiple-threat.template.json
  --map yale-street --draws 2 --out /tmp/tgr-footage-smoke` → 8 cells, 2.1 s.
- Render smoke (pre-underlay): `pnpm trace:render --instance .../draw-000.instance.json
  --trace .../draw-000.trace.json.gz --out /tmp/tgr-footage-smoke/render-000` → 4 PNG + MP4, 0.6 s.
- Contract-cell render smoke (underlay + redact):
  `.venv/bin/python tools/research/footage/render_cells.py /tmp/tgr-footage-smoke/cellsmoke
  --redact --dev-assets dev-assets` → 18 frames + rollout.mp4, 2.2 s, `redacted: true`
  in render-manifest.json.
- Judge smoke (real gateway call): `OPENAI_BASE_URL=http://127.0.0.1:4141/v1 OPENAI_API_KEY=x
  .venv/bin/python tools/research/footage/judge.py <cell> --model gpt-5.6-sol --effort low
  --strategy spread8` → valid §3 verdict (realism 6, dynamism 3, plausible true, defects [],
  4256+602 tokens, 13.6 s). Description correctly narrates ego + pedestrian + empty road.

## 3. Selection rule (declared before any measured verdict — also in PREREG-v2)

adequate(arm) := realism AUC ≥ 0.80 AND bootstrap-95% CI lower bound ≥ 0.70.
Chosen judge := cheapest adequate arm by mean total tokens/cell
(ties: latency, then lower effort, then sol<luna<terra). No adequate arm → calibration
FAILED, scaling does not run, finding reported plainly.

## 4. Calibration set (built; judging pending renderer glyph fix)

Run dir `/tmp/tgr-footage-calib1`. Commands (exact):

```
.venv/bin/python tools/research/footage/build_calibration.py --run /tmp/tgr-footage-calib1 --run-id calib1
# wave 2 (see PREREG-v2 amendment): 12 more mechanism templates, resample with same seed
rm -rf /tmp/tgr-footage-calib1/cells /tmp/tgr-footage-calib1/labels.json
.venv/bin/python tools/research/footage/build_calibration.py --run /tmp/tgr-footage-calib1 --run-id calib1 --skip-batch
.venv/bin/python tools/research/footage/render_cells.py /tmp/tgr-footage-calib1/cells --redact --dev-assets dev-assets --workers 4
```

Result: **24 good** (28 candidates; 7 templates: oncoming-overtake 8, c7-bus-shelter-fixed 7,
c7-hedge-corner-fixed 3, right-turn-crosswalk 2, cut-in-brake 2, lead-hard-brake 1,
delivery-double-park 1) / **24 absurd** (140 candidates; c7-*-baseline 16, b2-zero-kph 5,
b1-frozen-ego 3), marker-verified per PREREG-v2. Exclusion census (good candidates):
C5 44, C4 34, C2 28, C1 16, C3 9 (from set-manifest.json). Renders: 48/48 in 22 s
(4 workers), redacted, underlay on.

**Instrument fixes forced by the first (VOID) pilot** — all three were "the judge cannot
physically see the evidence" bugs, found because pilot-v1 AUCs sat at chance (~0.50)
and the verdicts' `mechanismObserved` text said why ("no visible EGO vehicle"):

1. **Kind glyphs** (`c2af2bf`, refined by EngineLane `194fc1f`): glyphs keyed off literal
   id `ped`; real cells use `vru` etc., so pedestrians drew as ~4 px unclassed boxes.
   Now keyed off `trace.header.actorMetadata[id].kind` (single-sourced, tested).
2. **Follow-ego camera** (`5873bce`): the minTTC-pair-midpoint camera drifts off EVERY
   actor as the pair separates; frozen-ego cells rendered as empty road mid-clip
   (`minTTC` can be entirely absent). `--camera follow-ego` centres each frame on the ego.
3. **Spawn-window frames** (`5873bce`): VRU-in-occluder overlap exists only at VRU spawn;
   a conflict-centred plan never sampled it. Every non-ego actor's first-present time
   (+0.6/+1.2 s) is now in the plan, label-blind, for all cells.

Pilot v1 (72 verdicts) is VOID per PREREG-v2 amendment 3 (kept at
`pilot-verdicts-VOID-v1.jsonl`; its chance-level result measured the broken instrument,
not the judge). Rubric legend aligned to the final glyph legend and frozen before pilot v2.

### Pilot v2 (measured, `calibrate.py pilot --run /tmp/tgr-footage-calib1 --workers 12`)

12 cells (6 good / 6 absurd, stratified) × {spread8, burst6} × 3 models @ medium:

| strategy | mean realism-AUC | per-model (luna/sol/terra) | mean tokens |
|---|---|---|---|
| **spread8 (frozen)** | **0.801** | 0.750 / 0.722 / 0.931 | 5073 |
| burst6 | 0.731 | 0.694 / 0.764 / 0.736 | 3968 |

Pick per pre-registered rule (higher mean AUC): **spread8**. Grid (48 cells × 9 arms =
432 blind verdicts) launched with the frozen strategy.

### Grid result — CALIBRATION PASSED (the load-bearing table)

Commands: `calibrate.py grid --run /tmp/tgr-footage-calib1 --workers 12` (432/432 verdicts,
0 errors, 835 s wall) then `calibrate.py analyze --run /tmp/tgr-footage-calib1`.
Realism AUC (good vs absurd, Mann-Whitney; CI = 1000-draw bootstrap, seed 20260816):

| arm | realism AUC | 95% CI | dyn AUC | good μ/med | absurd μ/med | plaus G/A | defect G/A | tok/cell | lat |
|---|---|---|---|---|---|---|---|---|---|
| luna/low | 0.665 | [0.52, 0.80] | 0.688 | 6.04/6 | 5.21/6 | .96/1.00 | .17/.25 | 4636 | 7.7s |
| luna/medium | 0.801 | [0.68, 0.90] | 0.709 | 6.62/7 | 4.83/5 | .96/.88 | .17/.42 | 5130 | 16.8s |
| luna/high | 0.695 | [0.55, 0.84] | 0.694 | 6.71/7 | 5.46/6 | 1.00/.79 | .12/.50 | 7637 | 61.6s |
| sol/low | 0.763 | [0.61, 0.89] | 0.763 | 6.71/7 | 5.21/6 | .92/.96 | .21/.54 | 4601 | 7.8s |
| **sol/medium** | **0.853** | **[0.75, 0.95]** | 0.779 | 6.96/7 | 4.88/5 | .96/.83 | .17/.62 | **4934** | 14.0s |
| sol/high | 0.872 | [0.75, 0.97] | 0.859 | 7.29/8 | 4.92/5 | .96/.71 | .12/.79 | 5719 | 27.9s |
| terra/low | 0.803 | [0.68, 0.91] | 0.664 | 6.46/7 | 4.75/5 | .96/.79 | .12/.50 | 4807 | 12.0s |
| terra/medium | 0.862 | [0.75, 0.96] | 0.622 | 6.75/7 | 4.58/5 | .92/.62 | .08/.67 | 4987 | 16.0s |
| terra/high | 0.888 | [0.79, 0.96] | 0.742 | 6.67/7 | 4.25/5 | .92/.50 | .08/.54 | 5733 | 30.2s |

- **Adequate arms** (AUC ≥ 0.80 ∧ CI-lo ≥ 0.70): sol/medium, sol/high, terra/medium,
  terra/high. **Chosen judge: `gpt-5.6-sol / medium / spread8`** (cheapest adequate,
  4934 tok/cell — rule declared in PREREG-v2 before any verdict).
- **Effort DOES buy judge discrimination** (contrast W8's authoring result): low→medium
  is +0.09-0.14 AUC on every model; medium→high adds +0.02-0.03 for sol/terra at ~15%
  more tokens and ~2× latency, and **hurts luna** (0.80→0.70). The W8 "effort buys
  nothing" finding is authoring-surface-specific, not universal.
- **Score distributions overlap in the 6-7 band** (chosen arm: good sorted
  [4,4,5,5,6,6,7×7,8×11], absurd [1,2,3,3,3,4,4,4,4,5,5,5,5,6×8,7,7,7]); Youden-J
  threshold 7 → tp 18 fn 6 fp 3 tn 21 (J = 0.625). The instrument RANKS reliably but a
  hard per-cell accept/reject cut costs ~12% error each way.
- **Per-broken-class (chosen arm)**: frozen-ego caught decisively (mean realism 2.0);
  zero-kph 4.6; the five c7 VRU-in-occluder baselines are the weak class (5.2-6.3;
  worst hedge-corner 6.3 — after the VRU emerges, the scene looks normal; the overlap
  moment is 1-2 frames). Defect-flag rate on absurd: 0.62 (sol/medium).
- **Inter-model agreement** (Spearman on realism, 48 common cells): sol~terra
  0.72 (medium) / 0.83 (high); luna~sol 0.44-0.55; luna~terra 0.52-0.56. Not chance —
  falsifier "agreement near chance" is CLEARED; luna is the outlier judge.
- Vision preflight: all 3 models PASS in-session (randomized colours; terra passed on a
  green probe first try). visionAsserted=true on all 432 verdicts; judgeErrors 0.

### Falsifier verdicts (plan §3B), stated plainly

1. *"Judge cannot separate calibration classes"* — **FALSIFIED** (calibration PASSED):
   4 of 9 arms adequate; best CI-lo 0.79. Footage review is NOT ceremony on this render.
2. *"Inter-model agreement near chance"* — **FALSIFIED** for sol~terra (ρ 0.72-0.83);
   PARTIAL for luna (ρ ~0.5 with others and weakest AUCs — do not use luna as sole judge).
3. *"Verdicts uncorrelated with deterministic absurdity markers"* — **MIXED**: strong on
   frozen-ego/zero-kph (kinetic markers), weak on VRU-in-occluder (geometric overlap,
   1-2 frame visibility). What the render lacks for that class: an explicit overlap cue —
   options: outline flash on OBB intersection (deterministic, label-blind), higher fps
   burst at spawn, or 3D tier. Filed for EngineLane consideration; NOT added mid-run.

## 5. Scaled run — first round DONE (W7 regen + VistaLane pilot)

```
.venv/bin/python tools/research/footage/scale_run.py w7 --run /tmp/tgr-footage-scale1 --calib /tmp/tgr-footage-calib1 --rows 24
```

W7-luna DEV decision-replay regeneration (no LLM: committed final decision dicts through
the frozen `author_llm.COMPILERS`): 24 rows sampled stratified by (admitted, category)
seed 20260816 → **170 cells** (12 admitted rows → 103 cells incl. 28 gate-PASS; 12
rejected rows; per-cell first-failure census C5 46 / C4 31 / C3 29 / C2 21 / C1 15).
Two rows produced 0 ok cells (c7b-truck-hides-oncoming, c8-construction-junction —
site-infeasible on regen). Sibling roots from FreeformLane/EmergentLane will be added
via `scale_run.py roots --roots <dir>` as announced over hub; frozen judge + strategy;
inter-model agreement measured on every 3rd cell with all three models.

### Round-1 results (254 cells: 170 W7 + 84 VistaLane pilot; frozen judge sol/medium/spread8)

```
.venv/bin/python tools/research/footage/scale_run.py roots --run /tmp/tgr-footage-scale1 --calib /tmp/tgr-footage-calib1 --roots /tmp/tgr-vista-pilot1/cells
.venv/bin/python tools/research/footage/scale_run.py judge --run /tmp/tgr-footage-scale1 --calib /tmp/tgr-footage-calib1 --workers 12 --render-workers 4
.venv/bin/python tools/research/footage/scale_run.py analyze --run /tmp/tgr-footage-scale1 --calib /tmp/tgr-footage-calib1
```

424 verdicts (every 3rd cell judged by all 3 models), 0 errors, 468 s wall.

**Headline: the gate and the judge are ORTHOGONAL.** Realism AUC of gate-PASS vs
gate-FAIL cells = **0.499** (chance); W7 row-level admitted-vs-rejected AUC = **0.514**.
Judged realism/plausibility carry no admission information and vice versa — the frozen
gate certifies criticality/portability, not looks. This replicates, with an independent
instrument, the lead's plausibility≈equal-for-admitted-and-rejected observation
(plausible-rate here: 0.850 pass vs 0.851 fail).

| bucket | n | realism μ/med | dynamism μ/med | plausible |
|---|---|---|---|---|
| gate-pass cells | 60 | 5.15 / 5 | 3.03 / 3 | 0.85 |
| gate-fail cells | 194 | 5.06 / 6 | 2.52 / 3 | 0.85 |
| W7 admitted rows | 103 | 5.42 / 6 | 2.90 / 3 | 0.78 |
| W7 rejected rows | 67 | 5.33 / 6 | 2.72 / 3 | 0.90 |
| stream: footage (W7 regen) | 170 | 5.38 / 6 | — | — |
| stream: vista | 84 | 4.48 / 5 | — | — |

**The corpus is dead, quantified:** dynamism median 3/10 (max 5) across every bucket —
gate-passing cells included. The owner's "scenes aren't alive" complaint is now a number,
measured by an instrument that provably separates alive-vs-broken classes at 0.85 AUC.

**Inter-model agreement at scale** (85 common cells, all-3-models subsample): Spearman
luna~sol 0.693, luna~terra 0.745, sol~terra 0.766 — better than calibration (more score
spread), comfortably above chance.

**Cost/cell:** mean 4806 tokens, 11.3 s latency per verdict; round-1 total 2.04 M tokens
/ 424 verdicts. At this rate ~2400 verdicts/hour/12-workers; quota is not a constraint.

### Round 1b — full 3-model coverage + VistaLane main (progressive)

`scale_run.py roots ... --roots /tmp/tgr-vista-main1/cells` (62 cells at registration;
progressive) then `judge --agree-every 1` (all three models on every cell; owner wants
quota spent, and it upgrades agreement from a subsample to the full corpus):
**316 cells / 948 verdicts, 0 errors.** Findings hold at full coverage:
realism AUC gate-pass-vs-fail **0.465** (chance); inter-model Spearman n=316:
luna~sol 0.638, luna~terra 0.713, sol~terra 0.749. Cumulative scaled-run cost
4,575,010 tokens / 948 verdicts (mean 4826 tok, 11.7 s).

### Instrument property: test-retest reliability (chosen judge)

20 calibration cells (10/10 seeded) × 5 repeats × sol/medium/spread8 (100 verdicts,
`/tmp/tgr-footage-calib1/retest-sol-medium.json`): within-cell realism SD mean **0.69**
(median 0.71, worst 1.92; worst range 5 on one ambiguous cell); the boolean `plausible`
flipped across repeats on **6/20** cells. AUC of the 5-repeat mean (0.82) ≈ single-shot
AUC on the same cells (0.845): repeats do not buy separation. Read: single verdicts are
fine for RANKING and population statistics; a single `plausible` bool or a hard per-cell
threshold is noisy — consume realism as a score, not a verdict.

### Round 2 — EmergentLane paired-ambient cells (456) + VistaLane main growth

`scale_run.py roots ... --roots /tmp/tgr-emergent-pair1/cells` (456 cells, gate blocks
filled by EmergentLane) + `judge --agree-every 1`: 1488 verdicts, 0 errors, 2230 s.
Terra's red-probe quirk fired once in-session (answered "Orange" to a red probe;
randomized retry PASSED on blue — both attempts recorded; a blind model cannot pass
this retry ladder).

**Ambient traffic, judged (sol/medium, paired same map/site/draw vs `off`):**

| arm | n | realism μ/med | dynamism μ/med | plausible | gate-pass | Δrealism (sign p) | Δdynamism up/down |
|---|---|---|---|---|---|---|---|
| off | 117 | 5.21 / 5 | 3.02 / 3 | 0.69 | 54/117 | — | — |
| light | 117 | 5.52 / 5 | 4.95 / 5 | 0.60 | 48/117 | **+0.31 (p=0.007)** | 92/9 |
| city | 111 | 5.08 / 5 | 4.98 / 5 | 0.51 | 41/111 | −0.18 (p=0.74) | 96/4 |
| heavy | 111 | 5.03 / 4 | 5.23 / 5 | 0.52 | 43/111 | −0.23 (p=0.65) | 99/4 |

Reading: ambient decisively raises judged **aliveness** at every density; **light**
density also raises judged realism (paired sign-test p=0.007); city/heavy buy no further
realism and slide plausibility (the "identical sedans" effect is a plateau, not a
penalty). Judge-side answer to Stream C hypothesis (i): **ambient ON, light, is strictly
better footage** — and it costs some gate admissions (54→48/117 paired).

### Round 3 — FreeformLane baseline arm (300) + VistaLane growth

`roots --roots /tmp/tgr-freeform-base1/cells` + `judge --agree-every 1`: 1572 verdicts,
0 errors, 1884 s (all three vision probes passed first-try this session).

**Freeform BASELINE arm (frozen compiler pipeline, luna/medium, 50-brief sample):**
n=300, realism μ 5.91 / med 6 (p25 4, p75 7) — the best-scoring stream so far — but
dynamism μ 3.12 / med 3 / **max 5**, plausible 0.87. Gate-pass 250/300; gate-passers
realism μ 6.04, dynamism μ 3.27. The compiler produces tidy, plausible, DEAD scenes —
the "static-duet" census signature FreeformLane measured (2 actors, no signals, no lane
changes) is exactly what the judge sees. This is the anchor the freedom arm must beat
on dynamism without losing realism.

### Cumulative scaled-run state (at report time)

**1594 cells / 4422 verdicts / 21.65 M tokens** (mean 4897 tok/verdict); streams:
w7-regen 170 (realism μ 5.38/med 6), vista 548 (μ 4.96/med 5), emergent 456 (μ 5.22/med 5),
freeform-baseline 300 (μ 5.91/med 6). Gate-pass-vs-fail realism AUC over everything:
0.631 (W7-only stays chance at 0.465-0.499; the cross-stream figure is confounded by
stream mix — freeform-baseline is both highest-realism and highest-pass-rate).
Inter-model Spearman at n≈1594: luna~sol 0.585, luna~terra 0.652, sol~terra 0.698.
Dynamism stays dead in every stream: median ≤ 5 everywhere; only ambient-ON emergent
arms reach μ ≈ 5.

Remaining rounds (standing procedure, judge stage resumable): EmergentLane harvest
(`/tmp/tgr-emergent-h2/cells`, tonight), FreeformLane freedom arm (after their grid),
VistaLane main continues. Each announced root: `roots` + `judge --agree-every 1` +
re-`analyze`.

### Round 4 — pair1 COMPLETE (964 cells) + vista growth; h2 registered

Resumed `judge --agree-every 1` after EmergentLane's completion ping: 1884 verdicts,
0 errors, 2913 s (all vision probes first-try; sol asserted on a red probe).
`/tmp/tgr-emergent-h2/cells` registered (0 complete dirs at registration; picked up on
the next resume). **Full-pair1 ambient table (n=241/arm, sol/medium):**

| arm | realism μ/med | dyn μ | plausible | gate-pass | Δrealism paired (p) | Δdyn |
|---|---|---|---|---|---|---|
| off | 5.17 / 5 | 3.29 | 0.64 | 96/241 | — | — |
| light | 5.34 / 5 | 5.03 | 0.54 | 89/241 | **+0.17 (p=0.012)** | +1.74 |
| city | 5.06 / 5 | 5.19 | 0.47 | 80/241 | −0.11 (p=0.49) | +1.90 |
| heavy | 4.97 / 4 | 5.44 | 0.46 | 79/241 | −0.20 (p=0.19) | +2.15 |

The half-sample conclusion holds at full n: light ambient lifts BOTH axes (realism
p=0.012 paired), heavier densities trade plausibility for aliveness.
**Cumulative: 2452 cells / 6306 verdicts / 31.13 M tokens**, gate-vs-judge AUC 0.615
all-corpus (W7-only unchanged at chance), inter-model ρ 0.59-0.69.

### Round 5 — EmergentLane h2 harvest (stage-1) + vista growth

Resumed `judge --agree-every 1`: 2199 verdicts, 0 errors, 3223 s. **Harvest world-cells
(dense ambient, no authored challenger; n=379 judged so far, sol/medium):**

| profile | n | realism μ | dynamism μ/med | plausible |
|---|---|---|---|---|
| heavy16 | 132 | 5.51 | 5.36 / 6 | 0.55 |
| aggr24-aggressive | 127 | 5.31 | 5.65 / 6 | 0.46 |
| dense32-heterogeneous | 120 | 5.12 | 5.42 / 6 | 0.45 |

Harvest scenes are the most ALIVE footage measured in the whole rethink (dynamism
median 6 vs corpus-wide 3) at scripted-corpus realism (μ 5.1-5.5 vs W7 5.38), with
plausibility ~0.5 (dense worlds read busier than believable to the judge about half
the time). Emergence delivers aliveness; realism is not the casualty — plausibility is
the axis to watch.

**Cumulative: 3147 cells / 8505 verdicts / 41.97 M tokens, 0 judge errors across every
round.** Gate-vs-judge AUC all-corpus 0.623 (W7-only unchanged at chance). Inter-model
ρ: luna~sol 0.600, luna~terra 0.637, sol~terra 0.709. Still pending: FreeformLane
freedom arm, EmergentLane h2 completion, vista tail — standing resumable procedure.

### Round 6 — h2 completion + tag-strip promotions (mined-vs-authored, PREREG-F3 input)

h2 parent cells complete (711 judged; raw worlds: realism μ 5.19, dyn μ 5.65/med 6,
plaus 0.46, gate-pass 0 by design). All 120 `promoted-*/` de-ambiented counterparts
judged after EmergentLane added metas (nested-cell discovery fix committed).
**Promotions: dynamism μ 6.6 (highest measured anywhere) but realism μ 4.55 / plaus
0.27** — de-ambienting strips crowd context and the judge calls the leftover maneuvers
implausible. The 11 gate-PASS harvest admits are bimodal: **3/11 are joint-axis wins
beating every authored gate-passer on realism+dynamism together** (8/7, 7/8, 7/6 vs the
authored anchor 6.04/3.27); the other 8 read alive-but-weird. Mined scenarios CAN
out-footage authored ones — as a minority worth filtering for, which is exactly what
this instrument is for.


### Round 7 — FreeformLane FREEDOM arm (the Stream-A decisive cut)

h2 stage-2 depth cells + vista growth judged in passing (648 verdicts), then
`roots --roots /tmp/tgr-freeform-main1/cells` + `judge --agree-every 1`
(906 verdicts, 0 errors). Freedom arm = terra/low (their grid winner), 264 cells,
admission 9/50 briefs. **Clean negative, stated plainly (sol/medium judge):**

| bucket | n | realism μ/med | dynamism μ/med | plausible |
|---|---|---|---|---|
| freedom ALL | 264 | 4.90 / 5 | 2.76 / 3 | 0.82 |
| freedom gate-PASS | 44 | 5.20 / 5 | 3.39 / 3 | 0.84 |
| freedom gate-FAIL | 220 | 4.84 / 4 | 2.64 / 3 | 0.81 |
| baseline ALL | 300 | 5.91 / 6 | 3.12 / 3 | 0.87 |
| baseline gate-PASS | 250 | 6.04 / 7 | 3.27 / 3 | 0.85 |
| baseline gate-FAIL | 50 | 5.26 / 5 | 2.38 / 3 | 0.96 |

AUC freedom>baseline: realism **0.345**, dynamism **0.382** (all cells); gate-PASS-only
realism 0.365, dynamism 0.527 (flat). The "alive-but-inadmissible" hypothesis is
DISCONFIRMED: freedom's gate-failures are less real AND no more alive. Full-schema
freedom at terra/low bought neither admission nor footage quality — the compiler's
static duets remain better-looking. (Stream A's falsifier, measured by Stream B's
instrument; the ambient/harvest levers from Stream C remain the only measured footage
wins.)

### Round 8 (final) — VistaLane retained roots complete

`roots --roots /tmp/tgr-vista-main2ownerfix/cells /tmp/tgr-vista-low2/cells` +
`judge --agree-every 1` (timed out once at 3600 s mid-render; resumed cleanly —
resumability doing its job; 0 errors total). Three-way vista column (sol/medium judge):

| root | n | realism μ/med | dyn μ/med | plaus | gate-PASS bucket |
|---|---|---|---|---|---|
| vista-main1 (sol/high) | 1086 | 5.11 / 5 | 2.79 / 3 | 0.85 | n=336: 6.05 / 3.22 |
| vista-main2ownerfix | 338 | 5.15 / 5 | 2.88 / 3 | 0.80 | n=144: 5.93 / 3.31 |
| vista-low2 (sol/low) | 1082 | 5.42 / 6 | 3.05 / 3 | 0.75 | n=438: **6.18** / 3.27 |

vista-low2's gate-passers are the highest-realism bucket measured in the rethink (6.18);
dynamism stays in the dead ~3.2-3.3 band, like every non-ambient arm. The cross-stream
picture is consistent: **admission-grade authored scenarios of every flavor converge to
"tidy, plausible, static duet" (realism ~6, dynamism ~3); only ambient/emergent levers
move aliveness.**

**FINAL cumulative: 4360 cells / 13,080 verdicts / 80.43 M tokens / 0 judge errors.**
Inter-model Spearman (full corpus): luna~sol 0.627, luna~terra 0.655, sol~terra 0.735.
Standing judge service hands over to the showcase pipeline (P3/P5 wrap judge.py).

## Cost ledger (updated per stage)

| stage | calls | tokens in/out | wall |
|---|---|---|---|
| smoke | 1 judge + 1 probe | 4256/602 (+probe) | 15.7 s |
| pilot v1 (VOID) | 72 judge + 3 probes | 317,030 total | ~2 min |
| pilot v2 | 72 judge | 325,454 total (spread8 5073/cell, burst6 3968/cell) | 117 s |
| calibration grid | 432 judge + 3 probes | 2,312,777 total (per-arm tok/cell in table) | 835 s |
| scaled round 1 | 424 judge + 3 probes | 2,037,969 total (4806/cell mean) | 468 s |
| scaled 1b (all-model) | 524 judge | (cumulative below) | 577 s |
| scaled vista growth | 414 judge | (cumulative below) | 482 s |
| test-retest | 100 judge | ~493k | ~3 min |
| scaled round 2 (emergent) | 1488 judge | (cumulative below) | 2230 s |
| scaled round 3 (freeform base) | 1572 judge | (cumulative below) | 1884 s |
| scaled round 4 (pair1 full + vista) | 1884 judge | (cumulative below) | 2913 s |
| scaled round 5 (h2 + vista) | 2199 judge | (cumulative below) | 3223 s |
| scaled round 6 (h2 complete + promotions) | 1839 judge | (cumulative below) | ~48 min |
| scaled round 7 (h2 stage-2 + freedom arm) | 1554 judge | (cumulative below) | ~37 min |
| scaled round 8 (vista ownerfix + low2) | 1182+1841 judge | (cumulative below) | 60+24 min |
| **scaled cumulative (final)** | **13,080 judge** | **80,431,512 total** | — |
