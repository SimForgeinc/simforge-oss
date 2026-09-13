# Stream E — VistaLane: a faithful VISTA-style visual authoring harness

Status: harness frozen after pilot; main run pending. Updated at every milestone.
Owner question this stream answers: does closed-loop VISUAL authoring (the agent sees
the road, places actors by sight, watches rollouts, and plays the frozen gate as a
game) beat the compiler baseline and the text-schema freedom arm on the SAME brief
sample — on admission, on cost, or on realism/dynamism?

## 0. Session integrity

- Frozen-gate tripwire at session start: `PASS manifest-v1 1a08698e95fca4bc / v2
  3823182614e5a5ba` (`tools/gates/verify_gate_hash.py`, run 2026-08-16; also run by
  the harness preflight before every run).
- Vision assertion (in-session, gateway `127.0.0.1:4141`): `gpt-5.6-sol` effort=high
  **PASS** ("sees green", randomized colour probe); per-run preflight repeats this and
  is fatal on FAIL. Anthropic models never touch an image path.
- Branch `tg-rethink`; run outputs under `/tmp/tgr-vista-<runid>/`, never reused.

## 1. Prior-work reconciliation (lead mandate)

- `tools/tg-research/*` (instrument / openvocab / worldgen): **no overlap** with this
  stream — none of it renders scenes for an authoring agent or implements a visual
  action loop. Read `reports/tg-research/PLAN.md` for the shared framing.
- One inherited claim is directly at stake here: that prior lead wrote *"the honest
  mapping [of VISTA] is not 'make the author look at pictures'"* and re-aimed vision
  at judging only. The current owner mandate (stream E) is to test exactly that bet
  with a *faithful* harness rather than the earlier repair-loop strawman. This report
  is the test; either outcome resolves the disagreement with data.
- `research/edge-case-corpus/tools/vista/` (the previous visual attempt): its
  **render primitives are reused** (`render.py`: topology loader, pixel<->world
  transform, nearest-lane projection — proven, and the feasibility of VLM perception
  on these renders was already established there). Its harness design (numeric
  repair loop with images attached at the repair step only) is **superseded**: it
  showed the model images of a scene it never chose, at a moment it never chose, with
  no memory, no notes, no game formulation. VISTA's three pillars were absent.
- W8/W9 (merged mid-session): on the compiler surface, effort does not raise
  admission and sol/low is the production config. Consequence adopted here: the main
  arm stays `sol/high` (the paper's own Codex backend at high effort — assignment
  spec), and the pre-registered secondary cell is `sol/low` on the same briefs — the
  open question W8 cannot answer is whether effort matters once the model has real
  freedom. W8's result is surface-specific and is not treated as universal.

## 2. What was built (tools/research/vista2/)

Four modules, ~1,300 lines total, no packages/ edits:

- `vrender.py` — top-down renders from `dev-assets/<map>/topology-index.json.gz`:
  lanes coloured by type, junction surfaces, route highlight, actor OBBs with heading
  noses and per-actor speed labels, motion trails, metre grid. `semantic_at()` answers
  read_pixels from the topology index (drivable/sidewalk/shoulder/parking/junction/
  off_road + lane width/speed-limit/travel-heading) — ground truth, not colour
  sampling. Keyframe renders use one fixed view per rollout so frames are comparable.
- `vworld.py` — the scene under construction and its PORTABLE template. Placement
  projection: pixel → world → route-arc/lateral → `relative_to` (dsM/dLane/tFrac,
  metric `lateralM` off-carriageway) or ego `on_reference` pose. Calibration per
  working site from the materialized ego's `behavior.route.lanes` chain; round-trip
  error measured 0.0 m (ego spawn reprojects to its authored s exactly). Simplified
  motions compile 1:1 onto schema verbs (speed/route/nearMiss/laneOffset/changeLane/
  gap/set) and the trigger union (at/after/arrival/when) — primitives, not mechanisms;
  criticality still has to be discovered and composed by the agent. `simulate()` =
  instantiate+simulate+evaluate+frozen `tg_gate.gate_cell` at the working site;
  `emit()` = all-maps batch + gate every cell + portability. The emitted template
  contains no coordinates and no road ids (the anchor is a corridor + optional
  feature; all poses are lane-relative).
- `vagent.py` — the VISTA loop. Minimal game prompt (the paper's shape: task, win
  condition, predict/verify instruction, notes instruction) + factual action
  reference + the gate criteria as game rules. One JSON action per turn; EVERY action
  returns PNGs. Lossless memory: every frame's source state is stored; `inspect`
  re-renders any past frame at any region/zoom; frames never expire even when old
  turns' images are pruned from the context window (only the last ~5 turns carry
  pixels — exactly VISTA's KV-cache-vs-visual-memory argument). GUIDE.md persists
  across briefs; WORKING.md per brief; both written only by the agent — no physics
  facts are pre-taught (warm-up erosion, clearance semantics, TTC demand are there to
  be DISCOVERED; that discovery is the experiment).
- `run_vista2.py` — preflight (gate tripwire + vision assert, both fatal), episode
  orchestration, per-brief metrics rows, GUIDE.md snapshots per brief, cell artifacts
  per RETHINK-CONTRACTS §2 from each episode's final emit (for FootageLane).

Action accounting (RHAE analogue): world-touching actions count against the budget
(view_site, place_actor, set_motion, simulate, emit, remove; default budget 40);
read-only looks (inspect, read_pixels) are free, as in VISTA's scoring.

## 3. Shakedown findings (run `shakedown1`, sol/high, 1 brief, budget 14)

The loop plays: the agent enumerated sites, locked one, placed actors by relative
offsets and by pixels (pixel placement projected to `dsM=25.63, tFrac=0.027`),
read pixels to disambiguate surfaces, simulated 5 times, and wrote real, discovered
engine truths into GUIDE.md unprompted — including the warmup/spawn-artifact
threshold and the placement-vs-rollout participation gap. 267 s, 218k input tokens.

Harness defects found and fixed (mechanism-level, never per-brief):
1. **Catalog-id silent death**: short ids ("sedan") pass `template validate` (known
   footgun #7: the CLI is not wired to `isKnownPropCatalogId`) and materialize as
   `static_object`-class actors that die in simulation while showing up at t=0.
   The harness now normalizes short ids and rejects unknown ones with candidates.
2. Motion-argument crashes → clean in-game errors (missing speedKph, bad triggers).
3. Site ordering made deterministic (matcher tie-break is not).
4. CLI exit code 2 (findings) treated as success when the artifact exists — the
   documented CLI contract.

## 4. Pre-registered run design

- Pilot: 3 DEV briefs OUTSIDE the frozen sample (`c1-lead-stopped`, `c5b-runner`,
  `c7b-van-hides-ped`), budget 40, sol/high. Purpose: harness defects only. The
  harness is then frozen by sha256 and never edited during the main run; per-brief
  tuning is prohibited and impossible through the harness surface.
- Main run: ALL 50 briefs of `tools/research/shared/briefs-sample.json` (30 DEV +
  20 owner-list; the exact sample FreeformLane's arms use), sol/high, budget 40,
  fresh GUIDE.md at run start (so cross-brief learning is measured within the run,
  uncontaminated by pilot).
- Secondary cell (owner sweep directive, budget permitting): sol/low on the same 50,
  fresh GUIDE.md — the "does effort matter under real freedom" cell.
- Metrics per brief (from raw traces / transcripts, no summary fields): admitted
  under the frozen gate incl. portability; counted actions (RHAE analogue); turns;
  simulate/emit counts; wall seconds; tokens in/out/reasoning; GUIDE.md snapshot
  diffs; dynamism census (`tools/research/shared/dynamism_census.py`, sha256
  `e22b25d73930804f...`) over emitted cells; cell artifacts for FootageLane's judge.
- Headline observables declared in advance:
  1. admission vs the compiler baseline and FreeformLane's text-schema arm on the
     same sample;
  2. cost multiple vs both arms (tokens and wall);
  3. does the agent discover the C2 warm-up trap in GUIDE.md without being told;
  4. census + footage-judge deltas on admitted cells.
- Falsifiers (verbatim intent): if the visual agent cannot beat the text-schema arm
  on admission OR on realism/dynamism, or burns >5x cost for parity, that is the
  answer to the owner's question and will be stated plainly.

## 5. Results

### 5.1 Pilot (run `pilot1`, sol/high, budget 40) — harness frozen

Command: `.venv/bin/python tools/research/vista2/run_vista2.py --run-id pilot1
--briefs c1-lead-stopped,c5b-runner,c7b-van-hides-ped --model gpt-5.6-sol
--effort high --budget 40 --wall-cap 3600`

**Harness frozen by sha256 `c8ac279cdd26f45b8a393f6be58a4808361987a729e8d74a7839f0254cbe6327`**
(printed by the run preflight; over vrender.py+vworld.py+vagent.py+run_vista2.py;
unchanged for the main run — verified equal before launch).

| brief | admitted | actions | turns | sims | emits | wall s | tok in | tok out | portability |
|---|---|---|---|---|---|---|---|---|---|
| c1-lead-stopped | **YES** | 20 | 20 | 7 | 1 | 315 | 256k | 9.4k | 5 maps / 10 sites |
| c5b-runner | no (C4 demand) | 40 | 42 | 10 | 1 | 671 | 772k | 23.7k | 0 / 0 |
| c7b-van-hides-ped (occlusion, C6 armed) | **YES** | 40 | 45 | 11 | 1 | 674 | 947k | 19.8k | 2 maps / 6 sites |

- Zero harness errors, zero protocol errors across all three episodes (grep over
  transcripts).
- **Headline observable #3 answered on brief 1**: GUIDE.md, written by the agent
  unprompted after observing warmup drift in the renders: *"A vehicle merely placed
  at 0 km/h may move during the 2 s warmup; an at:0 speed interaction stops it at
  rollout start."* It also discovered and recorded the collision-avoidance
  preemption pattern (*"set rules.collisionAvoidance=false at t=0, apply explicit
  TTC-triggered braking, then restore when that braking ends"*), that `static:true`
  props are excluded from TTC/clearance evaluation, and that `cross_path` at t=0 can
  complete during warmup. None of these facts appear in the prompt.
- Emitted-template portability audit: zero coordinates, zero road/lane ids
  (`grep -cE '"(x|y|z)":|rsl|siteId'` = 0 on the winning templates); roles are
  `on_reference`/`relative_to`, anchors corridor+features only.
- Cell artifacts: 88 cells in contract layout at `/tmp/tgr-vista-pilot1/cells/`
  (announced to FootageLane).
- c5b-runner is a clean game loss, not a harness defect: the agent got C1/C2/C3 and
  C5 passing but never generated C4 demand (ego braked too gently) before the budget
  ran out; its single emit at action 40 passed nowhere.

### 5.2 Main run (run `main1`, sol/high, ALL 50 shared-sample briefs)

Command: `run_vista2.py --run-id main1 --briefs sample --model gpt-5.6-sol --effort
high --budget 40 --wall-cap 2400`. Harness sha256 `c8ac279cdd26f45b…` (= frozen pilot
sha, printed by preflight). Fresh GUIDE.md at run start. Sequential episodes (GUIDE
persistence IS the measured cross-brief learning). 6h07m, zero episode errors, zero
protocol failures. Full per-brief table: `metrics-main1.jsonl` (committed beside this
report); numbers below from `analyze.py /tmp/tgr-vista-main1 --census`.

**Headline: 27/50 admitted (0.54) under the frozen gate including portability —
DEV 18/30 (0.60), owner-list 9/20 (0.45; but see the defect below: 11 of the 20
were unwinnable by harness bug, and the agent won ALL 9 unaffected owner briefs.)**

| aggregate | value |
|---|---|
| briefs / admitted | 50 / 27 (0.54) |
| tokens in / out / reasoning | 55.48M / 736k / 420k |
| wall | 6h07m total; mean 440 s/brief; admitted-brief mean 351 s |
| actions | mean 30.2/brief; admitted-brief mean 22.7 (median 20); total-actions-per-admitted 55.9 |
| engine passes | 234 simulates, 154 emit batches |
| cells produced (final emits) | 1,086 (contract §2 layout, `/tmp/tgr-vista-main1/cells/`) |

Per-category (admitted/briefs): C1 2/2, C2 1/2, C3 1/3, C4 1/1, C5 2/2, C6 2/2,
C7 0/2, C8 2/2, C9 2/2, C10 0/2, C11 0/2, C12 0/2, C13 2/2, C14 2/2, C15 1/2;
owner: adversarial 1/3, control-anomalies 1/3, erratic 2/3, map-divergence 2/3,
negotiation 0/2, occlusion-visibility 1/2, sudden-hazards 1/2, weather 1/2.

**The learning curve is real and visible.** First briefs: 40 actions, 600-750 s,
repeated experiments. After GUIDE.md matured: `c6b-cargo-bike` admitted in 8 actions
/ 95 s, `c1b-multi-brake` 10/136 s, `c3b-late-yield` 11/160 s,
`owner-…-snowbanks` 10/100 s, `owner-…-fog` 10/141 s. The mechanism is exactly
VISTA's: durable notes + immediate visual verification of a first-try plan.

**Genuine category unlock — constructed features.** `c8-taper-merge` and
`c8-construction-junction` (compiler: 0 sites map-wide, category written off as map
inventory) were admitted portably by BUILDING the work zone: four
`construction.channelizer_drum` props placed visually as a taper (dsM/tFrac
80/-0.95 → 104/-0.7 in the anchor frame) plus a pickup cut-in that moves traffic
inward ahead of the ego. Rows of the owner list that were "unhostable by map
inventory" are partially constructible after all — by an agent that can see.

**Provenance honesty (correcting my own mid-run note).** The two C13.control
admissions are NOT signal-mechanism scenarios. The agent systematically probed
signal-phase keys (GUIDE.md records ten rejected owner-scope spellings), concluded
they were unusable from its action surface, and won with a braking-lead mechanism
instead. Census over all 1,086 emitted cells: `signalPhaseChanges = 0`. The frozen
gate certifies criticality+portability, not mechanism provenance — the visual arm
has the same provenance gap the compiler corpus has (34.8% in W7). FootageLane's
judge on my cells is the instrument that will quantify mine.

**Post-freeze harness defect, disclosed and quantified.** Anchor ids were derived
from brief ids; 11 owner-list briefs have ids long enough that the anchor id
exceeded the schema's 64-char bound — `template validate` rejected EVERY emit, so
those 11 episodes were mathematically unwinnable (they also tripped a
simulate-without-site crash path, wasting further actions). The 9 owner briefs with
short ids went **9/9 admitted**. All 30 DEV briefs were unaffected. Fixed as
harness v2 (`b08de7d453e6a944…`), agent surface unchanged (bounded anchor id +
crash→game-message); main1 results above stand AS MEASURED under v1; a labeled
supplementary run of exactly the 11 sabotaged briefs (v2, sol/high, seeded with
main1's final GUIDE) is reported in §5.3.

**Dynamism census** (frozen shared implementation sha256 `e22b25d73930804f…`,
n=1,086 cells): actorCount mean 2.25 (max 4); interactingPairs 1.24; hardBrakeEvents
in 86.4% of cells; swerveEvents in 16.8%; laneChangesExecuted in 5.0%;
signalPhaseChanges 0; ambientCount 0 (ambient traffic is not in the action set —
a deliberate scope cut, and an honest limitation vs EmergentLane's arm).
Per-cell rows: `census-per-cell.json` in the run dir.

**Visual confabulation (falsifier-side evidence).** GUIDE.md also contains a wrong
"discovery": the agent interpreted renderer texture as brief-specific weather
("Snow-covered lane markings … rollout views showed irregular accumulation covering
nearly all painted lines"). The renderer draws no lane paint and no weather. The
perception channel that finds real spatial defects also invites over-reading;
judged-realism claims from this arm must be externally validated (FootageLane).

### 5.3 Supplementary run: the 11 defect-affected owner briefs (harness v2)

Command: `run_vista2.py --run-id main2ownerfix --briefs <the 11 ids> --model
gpt-5.6-sol --effort high --budget 40 --guide /tmp/tgr-vista-main1/GUIDE.md`
(continuation of main1's learning trajectory, labeled; harness v2
`b08de7d453e6a944…`). 57 min, 10.4M input tokens.

**9/11 admitted.** Mean 19 actions per admitted brief; `newly-painted-lanes` in 10
actions / 87 s at 4 maps / 10 sites. Losses: `human-intentionally-confusing-an-av`
(C4 demand never achieved) and `blind-crest-of-hill` (2 maps / 2 sites — one site
short of portability; crest occlusion exists on too few mapped corridors).

**Corrected owner-list picture: 18/20 admitted** (9/9 unaffected in main1 + 9/11
here). Rows the compiler pipeline never reached — police manually directing traffic,
double-parked negotiation, texting drift, freeway-shoulder reversing, snow-altered
geometry — admitted portably. Combined sample admission, honestly labeled
(39 briefs under v1 + 11 under v2): **36/50 = 0.72**.


### 5.4 Effort cell: sol/low, same 50 briefs (run `low2`, harness v2, clean single run)

Command: `run_vista2.py --run-id low2 --briefs sample --model gpt-5.6-sol --effort
low --budget 40 --wall-cap 2400`. Fresh GUIDE.md. 3h39m, zero episode errors.

**36/50 admitted (0.72) — DEV 19/30, owner 17/20.** 38.7M in / 339k out tokens
(74.8k reasoning vs sol/high's 420k), 258 simulates, 56 emits, mean 263 s/brief,
19.2 actions per admitted brief.

**Effort finding, extending W8 to the visual surface: sol/low equals sol/high on
admission (0.72 = 0.72) at 60% of the wall and 70% of the tokens.** W8 showed
effort buys nothing on the compiler surface; the open question was whether that
held once the model has real freedom. On this surface, with a 50-brief single run
per cell: it holds. (Point estimates without CIs; n=50 paired briefs, 33/36 and
27/36 admitted-brief overlap with high — same categories fail: C7, C10, C12 losses
are shared.) Low-effort census is statistically indistinguishable on the
pre-registered dynamism metrics (hardBrake 88.5% vs 86.4%, actors 2.23 vs 2.25,
pairs 1.30 vs 1.24; swerve 8.0% vs 16.8% is the one visible drop).

## 6. Three-way comparison (same 50-brief sample, same frozen gate, same census)

Sources: compiler baseline & text-freedom arm = FreeformLane
(`reports/rethink/freeform/data/{base1,main1}-report.json`, confirmed final by the
stream owner: baseline = frozen `author_llm` compilers luna/medium; freedom arm =
gpt-5.6-terra/low picked by their pre-registered grid rule; their grid CEILING
across all 9 model×effort cells was 0.27 on the selection subset). Visual arm =
this stream. FootageLane judged realism/dynamism (same calibrated judge, all-cell
means; gate-PASS-subset means in §7.2): freedom 4.90/2.76, baseline 5.91/3.12,
vista2 sol/high 5.11/2.79 (n=1086), sol/low 5.34/3.02 (partial n=375).

| arm | admission | wall s/brief | LLM tokens/brief | tokens per admitted brief |
|---|---|---|---|---|
| compiler baseline (deterministic families, luna fills scalars) | **0.80** (40/50) | 47 | 2.8k | 3.5k |
| text-schema freedom (terra/low, best-of-grid ≤0.27) | 0.18 (9/50) | 80 | 94k | 522k |
| **visual closed-loop, sol/high** (39 v1 + 11 v2, defect §5.2) | 0.72 (36/50) | 440 | 1.32M | 1.83M |
| **visual closed-loop, sol/low** (clean v2 run) | 0.72 (36/50) | 263 | 775k | 1.08M |

Per-brief complementarity (compiler vs visual sol/high+fix): both admit 29;
compiler-only 11 (C7 occlusion ×2, C11 parking ×2, C12 school ×2, C2, C10, C15,
2 owner); vision-only 7 (BOTH C8 workzone briefs — constructed from props — both
control-anomaly owner briefs, c13b-yellow-late, c15b-road-rage, c4b-ped-at-exit);
neither 3. **Union 47/50 = 0.94.**

## 7. Falsifier verdicts (pre-registered in §4) and conclusions

1. **"Visual cannot beat the text-schema arm on admission" — decisively not the
   case.** 0.72 vs 0.18 (and vs their 0.27 grid ceiling), same sample, same gate,
   same schema underneath. Given the SAME full vocabulary, the model with eyes,
   an engine loop, and a win condition beats the model with a schema and repair
   rounds by ~4x. The prior lead's bet that authoring-by-pixels was the weak form
   of VISTA is answered: it was the repair-loop design that was weak, not the
   pixels.
2. **"…or beat it on realism/dynamism" — measured, and the visual arm does NOT
   beat the compiler there.** FootageLane's calibrated judge (sol/medium, same
   instrument as the other arms; all three vista roots judged to completion,
   verdicts in the cell dirs): vista2 sol/high n=1086 realism 5.11 / dynamism 2.79
   / plausible 0.85 (gate-PASS subset n=336: 6.05/3.22); sol/low n=1082: 5.42/3.05
   (PASS n=438: **6.18**/3.27); ownerfix n=338: 5.15/2.88 (PASS n=144: 5.93/3.31).
   Compiler baseline: 5.91/3.12 (its passers 6.04/3.27); text-freedom arm
   4.90/2.76. **Gate-passing scenes from EVERY arm converge to the same ~6.0
   realism / ~3.2-3.3 dynamism band** — the "tidy-but-dead" signature. (Footnote:
   sol/low's passers at 6.18 are the highest-realism bucket measured anywhere in
   the rethink — but still inside the dead dynamism band; EmergentLane's
   ambient-ON pairs move dynamism +1.74 where no authoring surface moved it at
   all.) Census agrees: 2.2 actors, high hard-brake share, no ambient, no signal
   events — the visual arm did not wield the deep vocabulary (signal probes
   failed; ambient not in the action set). Realism is currently bounded by the
   gate's shape and the dead-world vocabulary, not by the authoring surface — the
   lead's original diagnosis, now measured across three authoring surfaces.
3. **">5x cost for parity" — fires against the COMPILER.** The visual arm does not
   reach compiler admission (0.72 < 0.80) and costs ~300x tokens and ~6-9x wall
   per brief. For raw gate admission on briefs the compilers already host, the
   deterministic pipeline remains unbeatable per dollar. The visual arm's value is
   where the compiler cannot go at any price: constructed features (both C8
   workzone briefs on maps with ZERO workzone sites), owner-list control anomalies
   (police directing traffic, flashing-yellow logic), and 7 vision-only admissions
   that raise the two-arm union to 0.94.
4. **Effort under real freedom: buys nothing on admission** (0.72 = 0.72, sol/low
   at 60% wall). W8's compiler-surface finding generalizes to this surface.
5. **Cross-brief learning (the paper's cross-level claim) is real and measured:**
   admitted-brief action cost fell from 40 (early) to 8-13 (late familiar
   mechanisms); the supplementary run, seeded with the mature GUIDE, admitted 9/11
   previously-lost briefs at 19 actions/brief mean. The agent discovered the C2
   warm-up trap, the collision-avoidance release pattern, prop/evaluation
   semantics, and site pathologies on its own, and its notes transferred.
6. **Honesty items:** gate admission ≠ mechanism provenance (C13 wins are braking
   leads, not signal scenarios — signalPhaseChanges=0 across 2,168 cells of both
   runs); one GUIDE.md entry is a visual confabulation (weather read into renderer
   texture); 11 owner briefs in main1 were unwinnable by a post-freeze harness
   defect, disclosed and re-run labeled under v2.

**Bottom line for the owner's question:** vision is not a cheaper or stronger path
to gate admission than the hand-built compilers — it is ~300x the token cost for
0.9x the admission. It IS, on this evidence, (a) the strongest authoring surface
measured for the open-vocabulary owner rows (18/20 vs the text arm's collapse),
(b) the only arm that constructs missing map features instead of being blocked by
inventory, and (c) a genuine engine-discovery machine whose GUIDE.md reads like an
onboarding doc nobody wrote. The right production shape suggested by the union
number (0.94): compilers for the categories they own, the visual game for the rows
they cannot host, and the footage judge over both.

## 8. Artifacts

- Runs: `/tmp/tgr-vista-{pilot1,main1,main2ownerfix,low2}/` — metrics.jsonl,
  transcripts, llm logs, frames, GUIDE snapshots; cells in contract §2 layout under
  `<run>/cells/` (announced to FootageLane; deleted only after their extraction).
- Committed beside this report: `metrics-{main1,main2ownerfix,low2}.jsonl`,
  `GUIDE-main1-final.md`, `GUIDE-ownerfix-final.md`, `GUIDE-low2-final.md`,
  `guide-snapshots/`, `run-config-main1.json`.
- Gate tripwire re-verified after all runs: PASS (v1 `1a08698e95fca4bc` / v2
  `3823182614e5a5ba` unchanged).

## 9. The GUIDE.md the agent wrote (main1 final, verbatim excerpts)

> "Site matching does not support feature:'curve' or reliably support
> feature:'merge'/'lane_drop' … query unconstrained sites and construct unsupported
> features with portable props."
>
> "Parking-zone query results can advertise a long runway while binding ego to a
> short parking-access stub; simulate early and reject sites where ego stops near
> 10 m or route-relative actors disappear."
>
> "Signal phase keys and environmental rules are world-scoped and cannot be
> attached to ordinary actors. Attempts to target env.weather through `world`,
> `environment`, `env`, `__world__`, `scene`, or an omitted actor all fail … do not
> repeat these guesses."
>
> "A vehicle merely placed at 0 km/h may move during the 2 s warmup; an at:0 speed
> interaction stops it at rollout start." *(the C2 warm-up trap, discovered on
> brief 1 of the pilot)*
>
> "For a constructed lane-closure taper, add static channelizer drums on the
> closing-side edge at dsM/tFrac 80/-0.95, 88/-0.9, 96/-0.8, and 104/-0.7; pair
> them with the pickup cut-in pattern so traffic moves inward ahead of ego."
>
> "A three-vehicle braking wave uses same-route leads at dsM 55/75/95, all
> 40 km/h, stopping at t=3.0/2.5/2.0 respectively…"

Full files committed beside this report; all 50 per-brief snapshots in the run dir.
