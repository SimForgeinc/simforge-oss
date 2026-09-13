# Research brief: training-grade scenario generation

You are taking over a research lane with a long, honest, and partly negative history.
Read this whole brief before running anything. It contains the goal, the frozen contract you
must obey, the exact work items with their exit criteria, the baseline you must beat, and a
list of footguns that have already cost previous agents entire runs.

The single most important sentence in this document: **every large win in this project came
from changing the representation, never from adding a check.** Behave accordingly.

---

## 0. Model and credential constraints (hard)

**You** run on `claude-opus-5` at thinking level `high`. That is the lane agent.

**The authoring LLM inside the harness stays `gpt-5.6-luna` at reasoning effort `medium`.**
Do not change it, do not "upgrade" it, do not substitute. Every baseline number in section 5
was measured with that exact configuration; swapping it silently invalidates the comparison
and you will not be able to tell a real improvement from a model change. If you want to test
a different authoring model, that is a **separate experiment, run after the frozen run, and
reported separately**.

**Preflight the API key in your first cell before any batch.** Two previous agents concluded
the key or the model did not exist and wasted their entire runs; a third recorded 12 briefs as
scenario failures when it was purely a missing environment variable.

**Credential hygiene:** API keys have appeared in committed briefs and in saved session
transcripts in this repo's history. Treat any key you find on disk as compromised. Ask for a
freshly issued key; do not reuse one you discover, and never write one into a file you commit.

---

## 1. The goal

Produce **training-grade** edge-case driving scenarios at scale, from one-sentence briefs,
through a general algorithm — not by hand-tuning scenarios one at a time. Hand-tuning is the
explicit anti-goal and the primary failure mode to avoid.

### What "training-grade" means, precisely

A scenario is training-grade only if it clears **all seven axes**. Each axis exists because a
documented failure in this project's history slipped through without it.

| # | Axis | Question | Owned by | Why it exists |
|---|---|---|---|---|
| 1 | Intent fidelity | Did the requested interaction actually happen? | deterministic, from raw trace | merge triggers skipped, lane changes rejected-and-aborted, required stops omitted — all previously labelled successes |
| 2 | Criticality | Is it genuinely an edge case? | deterministic, published thresholds | `evaluate band="critical"` was satisfiable by two stationary actors at t=0 |
| 3 | Mechanism provenance | Did the *named* mechanism cause the criticality? | blind LLM judge on the symbolic trace | 10 "occlusion" archetypes had `declaredOcclusion` empty |
| 4 | Situational plausibility | Would this scene exist in the world? | blind judge, balanced sampling, gate-independent | brief-to-map fit measured bimodal 8/8 vs 1/8 |
| 5 | Portability | Does it transfer preserving the criticality signature? | deterministic: >=2 maps, >=3 sites | the founding requirement of this lane |
| 6 | Reproducibility | Same inputs, same trace? | deterministic: `evidence verify`, instance hash | the integrity gate found corruption every other layer passed |
| 7 | Rejection | Does the system refuse impossible requests? | deterministic negative controls | every prior method answered "flying car" with a road-driving approximation |

### The target, restated as a rate

**Do not chase a raw count of 100.** The corpus-layout judge has returned
`fitForTrainingData: false` in *every* round, and it has always cited **balance**, never
quality. Restate the target as:

> **>=6 admitted archetypes in each of the 15 taxonomy categories, none below 4, every one
> admitted under the frozen gate on >=2 maps and >=3 distinct sites.**

Arithmetic that matters: from 208 briefs, 47.6% -> 99 archetypes; 60% -> 125; 65% -> 135.
**Roughly doubling the admission rate is the single most valuable thing you can do.** The
generalization gap is already ~0 across four independent rounds; overfitting is not your
problem and you should not spend effort on it.

---

## 2. Scope — what is IN and what is OUT

**IN.** Work items W1-W7 in section 4: three representation fixes, the rubric collapse, moving
gate criteria into the solver objective, a brief-to-map feasibility pre-check, and one frozen
measured run.

**OUT, and do not attempt:**

- **Map authoring.** The five maps demonstrably lack a drivable parking aisle, a narrow
  residential street with kerbside parking, and multi-lane junction approaches
  (`throughLanesSameDir >= 2` fails at 157/210 sites). There are only **23 signalized
  junctions across all five maps** (yale 16, el-camino 6, richmond 1, belmont 0,
  easterbrook 0). This is a human dependency tracked alongside the RoadRunner signal handoff.
  **Your job is to quantify exactly what is missing and hand it over, not to fix it.**
- **A new authoring-model sweep.** The 2026-08-04 postmortem established the model is not the
  bottleneck. Another ranking would optimise a misleading score.
- **Anything that relaxes the gate.** See section 3.
- **Vision/render-based authoring as a primary strategy.** It has been tried twice and lost
  twice: the bird's-eye vision condition scored *worse* than iterative text, and the C2 loss
  the VISTA lane predicted sight would recover turned out to be arithmetic (`D1-RESOLVED.json`).
  Rendering is permitted as a *debugging aid*. It is not a research direction here.

---

## 3. The frozen contract

### 3.1 The admission gate
Pre-registered, sha256 `1a08698e95fca4bc` (v1) and `3823182614e5a5ba` (v2, adds the occlusion
criterion). A brief is ADMITTED only if some trace satisfies **all** of:

- **C1** ego actually drives: `maxSpeedMps >= 2.0` AND `distanceTravelledM >= 10.0`
- **C2** closest approach is not a spawn artifact: it occurs at `t > warmupSeconds + 0.5`
- **C3** genuine proximity: **true OBB clearance <= 5.0 m** (never `minDistance`)
- **C4** genuine demand: ego `requiredDecelMax >= 1.5` OR `minTTC <= 3.0`
- **C5** `evaluate` verdict=accept AND band=critical AND zero collisions AND no never-fired trigger
- **C6** (v2) if the brief's mechanism is occlusion, the target was genuinely hidden and then
  revealed before the conflict, with `occluderIneffective` empty
- across cells: **>= 2 maps AND >= 3 distinct sites**

**Tightening is allowed. Loosening is forbidden.** This gate exists because a blind judge
rejected 27/52 traces the old pipeline called critical; after tightening, blind-judge agreement
moved **0.481 -> 0.917**.

### 3.2 The brief corpus and split
- `agent-authoring/brief-corpus.json` — tranche 1, 92 briefs, split sha256 `dd4f360c16fd416f`, DEV 32 / HELDOUT 60
- `agent-authoring/brief-corpus-tranche2.json` — tranche 2, 116 briefs, split sha256 `9327be880d9673a1`, DEV 41 / HELDOUT 75
- `agent-authoring/brief-corpus-full.json` — all 208 briefs, 15 categories

**DEV develops the algorithm. HELDOUT is authored ONCE, through a surface frozen by hash, with
zero per-brief tuning.** Report the generalization gap.

### 3.3 Portability
The emitted artifact is a **portable ScenarioTemplate v2**: logical anchor over road structure,
**no coordinates and no road IDs**. If you bake map coordinates into a template you have failed
the primary requirement no matter how good the numbers look.

### 3.4 Evidence discipline
Read every metric from the **raw trace**, never from a summary or a verdict field. A gate that
reads a summary instead of the evidence will silently pass bad scenarios — this project has
proven it twice, most expensively when a harness reported `collisions: 0` for a batch in which
**159 of 288 cells had contact**, because `evaluate` defaults to `rejectCollisions: false`.

---

## 4. The work, in order, with exit criteria

Each item names a general fix, the evidence that motivates it, and a **command that must pass**.
Do not proceed to the next item until the current exit criterion is met and recorded.

### W1 — warm-up compensation (highest value per unit of work)
**What.** Trace `t = 0` is the state *after* `warmupSeconds` of simulation, so an actor authored
G metres ahead of the ego arrives at t=0 at `G - warmupSeconds*(v_ego - v_challenger)`. Compensate
inside `place_actor` (authoring-side; **no `packages/` change is required or wanted**).

**Evidence.** `tools/vista/findings/D1-RESOLVED.json` — predicted vs actual loss agrees to
<=0.02 m on 3/3 cells. C2 is **29.3% of all admission losses** across an 819-trace census, and
C2 failures start a median 8.1 m ahead versus 11.0 m for passing traces (Mann-Whitney p=0.0001).

**Do not** re-attempt the `coverTarget()` patch in `scenario-materializer`. It addressed a cause
that does not exist and was correctly reverted.

**Exit:** on a fixed 200-cell probe, the C2 share of failures falls from 29.3% to **< 10%**, and
the realised t=0 gap correlates with the requested gap at **r > 0.9**.

### W2 — lateral placement that can reach the verge
**What.** `props.pose.tFrac` is clamped to `[-1, 1]` — the ego lane's own edges — so a roadside
occluder cannot sit off the carriageway and ends up at the same lateral position as the VRU it
is supposed to hide. Add a `lateral_m` form with `reference: 'lane_edge' | 'verge'` to
`FramePoseSchema` plus the materializer's lateral resolution.

**Evidence.** `OCCLUSION-FINDING.md`. Occlusion proven progression: 0/30 (no operation at all)
-> 0/80 (hedge at tFrac -1) -> 9/80 (box truck in the adjacent lane) -> 1/120 under a joint
occlusion+criticality solve. The adjacent-lane workaround needs multi-lane roads, which fail at
157/210 sites, so it cannot satisfy the >=2 maps / >=3 sites clause.

**Exit:** occlusion proven (`revealed_before_conflict`, `occluderIneffective` empty) in **>= 50%**
of cells for a C7 brief, on **>= 2 maps and >= 3 sites**, and **>= 5 C7 archetypes** pass gate v2.

### W3 — a lane closure that actually closes the lane
**What.** `roadControlSchema` supports only `kind: 'stop'` (`sim-engine/src/schema/input.ts:526`).
There is no lane-availability override, so `close_lane` places devices but does not change the
drivable surface: the closure is scenery and the ego drives into the barriers. Add the override
plus `reroute_ego` / automatic lane-shift.

**Evidence.** `STATE.json` blocker B1; first honest attempt scored 91/126 cells with contact.
`narrow_lane` (MUTCD *shifting* taper) sidesteps this for single-lane work zones and took
contacts 110/148 -> 19/148 — the largest single measured jump in the project, and it came from
adding an **operation**, not tuning a parameter.

**Exit:** `close_lane` produces **zero** ego-into-device contacts on a 40-cell probe, and a
work-zone archetype is admitted at **>= 2 maps and >= 3 sites**.

### W4 — collapse the rubric ceremony
**What.** `tools/` holds **259 `*.rubric.json` files. All 259 have identical structure and
exactly two criteria** — `R-clearance` (centre_distance >= 0.5 m) and `R-nocoll` — both already
enforced more strictly by gate C3 and C5. Their `originalIntent` reads "Assembled from the agent
require() calls". They pre-register **nothing about the mechanism** and cannot reject anything
the gate would not already reject.

Replace with **~15 mechanism-level rubrics**, one per taxonomy category, shaped like the four
hand-written ones in `rubrics/` — which carry trigger-fired, event-order, mechanism-specific
criticality bands with citations (Euro NCAP CCRb, UN R157, NHTSA pre-crash types), and which
**rejected 223 of 240 cells of their own author's tuning**. That is what a rubric is for.

**Exit:** <= 20 rubric files, each pre-registered by sha256 before any solving; and on a replay
of a previously-admitted batch the new rubrics **reject at least one archetype the old ones
accepted**. If they reject nothing, they are still ceremony and you have not finished.

### W5 — move the gate into the solver objective
**What.** The graded solver currently optimises one thing while gate C1-C4 rejects on another,
so ~53% of authored cells are thrown away. Express C1-C4 as terms in the solver objective so
the parameters are *solved toward* admission rather than *filtered after* it.

**Caution — this is the highest-risk item in the lane.** Optimising against your own validator
is exactly how this project previously converged on "passing the test" rather than producing a
good scene. Mitigation: the pre-registered rubrics (W4) and the blind judge remain **outside**
the solver loop and are never used as an optimisation signal.

**Exit:** DEV admission **>= 0.60** with the gate unchanged, the rubrics unchanged, and blind
judge "is a critical edge case" **not lower** than the 0.968 baseline.

### W6 — brief-to-map feasibility pre-check
**What.** Brief-to-map fit is **binary** — a balanced blind measurement scored archetypes 8/8,
8/8, 8/8, 7/8 versus 1/8, 1/8, 1/8, with nothing in between. Refusing an infeasible brief in one
second beats discovering it after a full batch. This deletes downstream work; it is not another
check.

**Exit:** the pre-check agrees with the blind plausibility measurement at **>= 0.85** on the
seven archetypes already measured, and running it over all 208 briefs produces a ranked list of
**exactly which categories the five maps cannot host**, with site counts. That list is a
deliverable for the map-authoring dependency (section 2).

### W7 — one frozen run
Freeze the tool surface by hash. Author DEV, then HELDOUT **once**, with zero per-brief tuning.

**Exit:** report admitted/total per split, the generalization gap with a p-value, per-category
archetype counts, replay determinism, blind per-scenario judge, and the corpus-layout judge
verdict. **A negative result measured honestly is a real result.**

---

## 5. The baseline you must beat

| metric | value | source |
|---|---|---|
| archetypes admitted | 99 / 208 (gate v1) · **89** (gate v2) | `RESULTS-round6.md`, `OCCLUSION-FINDING.md` |
| DEV admission | 0.521 (v1) · 0.466 (v2) | same |
| HELDOUT admission | 0.452 (v1) · 0.407 (v2) | same |
| generalization gap | +0.069 (p=0.344) · +0.058 (p=0.417) | same |
| categories covered | 15/15 (v1) · **14/15** (v2) | same |
| replay bit-identical | 297/297 | same |
| blind judge: is a critical edge case | 0.980 | same |
| blind judge: category agreement | 0.384 (kappa 0.336) | same |
| corpus-layout judge | **inadequate / fitForTrainingData FALSE** | same |
| wall clock | ~35 s per brief | `VISTA-LANE-BRIEF.md` |

**Beat the admission rate. The gap is already ~0 and does not need improving.**

### Where the losses are (census over 819 traces, 37.5% pass)
| cause | share | dominant in |
|---|---:|---|
| **C2 closest approach at spawn** | **29.3%** | C6 (58%), C14 (54%), C11 (50%), C8 (41%), C7 (40%) |
| C3 clearance > 5 m | 17.6% | C3.intersection (76%), C13.control (93%) |
| C1 ego never really drives | 11.0% | C11 (29%), C1 (24%) |
| C4 no deceleration demand | 4.6% | C15 (20%), C4 (33%) |

C13.control has **no conflict mechanism at all** — a signal phase change is not by itself an
encounter; it needs a second actor whose movement the phase provokes.

---

## 6. Autonomous gates — write these first

These scripts are your definition of done. Write them before W1, keep them cheap, and wire them
as `--autonomous-gate` commands so you cannot declare completion without them passing.

| gate | command shape | passes when |
|---|---|---|
| typecheck | `npx tsc --noEmit` | exit 0 |
| unit tests | `pnpm test` (affected packages) | exit 0 |
| C2 probe | `python tools/gates/probe_c2.py` | C2 failure share < 10% |
| occlusion probe | `python tools/gates/probe_occlusion.py` | >= 50% proven on >= 2 maps |
| determinism | `python tools/gates/verify_replay.py` | 100% bit-identical |
| no-relaxation | `python tools/gates/verify_gate_hash.py` | gate sha256 unchanged from `1a08698e95fca4bc` / `3823182614e5a5ba` |

The last one matters most. It is a tripwire against the failure mode this whole lane exists to
avoid, and it should run on every continuation.

---

## 7. Footguns that have already cost real time

1. **Traces are columnar and enormous.** `ticks['actors'][id]` holds parallel arrays. Never
   print a whole tick or actor object; slice explicitly.
2. **Lane `s` restarts per lane.** Never compare `s` across actors to decide ahead/behind. Use
   geometric projection onto the ego's heading. A previously-claimed "sign bug" was retracted
   for exactly this reason.
3. **`minDistance` is a circumscribed-circle proxy, not clearance.** Car r=2.58 + pedestrian
   r=0.42 = 3.00 m, so it reports 0 m at 3 m of real separation. Use `trace/min-clearance.ts`
   or compute OBB clearance yourself.
4. **`minPET` is a prediction, not post-encroachment time**, and is ~0 by construction for
   arrival-solved near misses. Use `trace/realized-pet.ts`.
5. **`evaluate band="critical"` is not sufficient** — it accepts spawn artifacts and 30 m
   separations. That is why the physical gate exists.
6. **Write every run to a UNIQUE output dir.** A restart once reused `/tmp/toolrun-<briefId>`,
   overwrote its own evidence, and two admitted archetypes had to be withdrawn. Treat every
   existing `/tmp/toolrun-*` and `/tmp/vista-*` path as untrustworthy.
7. **`catalogId` typos used to substitute a sedan silently.** Fixed at source
   (`isKnownPropCatalogId`), but `uniscenarios template validate` is **still not wired to it**.
   Wiring it is a cheap, general fix worth doing.
8. **`sites match --rejected` + `failureSummary`** is the fastest debugging output in the repo.
   There is no `--limit` flag.
9. **`uniscenarios batch` is CPU-bound node.** Cap at 6-8 parallel workers; oversubscribing
   slows everything and helps nothing.
10. **THERE IS NOW A BUILD STEP — the older briefs are stale on this point and it will cost you
    a run if you trust them.** `packages/cli/bin/uniscenarios.js` imports `../dist/main.js`.
    `VISTA-LANE-BRIEF.md` §3 claims every package's `main` points at `src/index.ts` with a `tsx`
    loader and no `dist/`; that was true then and is **false now**. After **every** edit under
    `packages/`, run `pnpm -r build` (or the affected package's build) before the change reaches
    the CLI. Verify with a deliberate throwaway edit the first time. This is the same class as
    defect F4 in `ALGORITHM.md`, where stale copies meant fixes silently did not reach the
    pipeline: a manual run gave 40 sites and the pipeline gave 0.
11. **Do not add a check when a representation change would make the error unrepresentable.**
    Every recurring `explain_failure` code is a bug report against the tool surface, not a
    reason for another validator.

---

## 8. Working style and deliverables

- **Report incrementally**, checkpointed to disk after each work item — never only at the end.
- **Prefer fixing a mechanism over fixing a scenario.** Per-scenario fixes are the anti-goal.
- **If you find a defect, produce a minimal reproduction and a failing test before fixing it.**
- **Design the experiment that could refute your own explanation.** This document contains three
  retractions by previous agents who did exactly that; they are the most valuable entries in it.
- Any change under `packages/` must be a **general** fix with a test that fails first.

Deliver:
1. `FINDINGS-TRAINING-GRADE.md` — incremental, with measured numbers and honest negatives.
2. Per-item exit-criterion evidence (command output, not prose).
3. The frozen-run scorecard from W7.
4. The map-inventory gap list from W6 — the ranked set of categories the five maps cannot host,
   with site counts, ready to hand to whoever owns map authoring.
5. Every withheld or withdrawn scenario recorded in the manifest, never silently dropped.

---

## 9. Your worktree

Work in a dedicated git worktree. **Never write to the main checkout**, and never to another
lane's directories.

```
WORKTREE : /Users/michaelvu-simforge/Documents/Programming/UniScenarios-training-grade   (branch `training-grade-lane`)
MAIN     : /Users/michaelvu-simforge/Documents/Programming/Simforge/UniScenarios          (read only)
```

Note `/Users/maikyon` is a symlink to `/Users/michaelvu-simforge`, so older absolute paths in
`VISTA-LANE-BRIEF.md` and elsewhere still resolve. Do not "fix" them.

**The worktree is already set up and verified. Do not re-run setup.**

- `dev-assets` -> symlink to the shared map store (read-only, ~7.9 GB — never copy or write).
- `node_modules` -> a **real `pnpm install` inside this worktree**, deliberately *not* a symlink
  from main. Symlinking it would make workspace links resolve to main's package sources and
  silently destroy lane isolation. Do not "optimise" this back into a symlink.
- `pnpm -r build` has been run once and succeeds.
- `.venv` -> Python 3.14 with matplotlib, httpx, numpy, pillow. Use `.venv/bin/python`.
  If you hit `ValueError: Key backend: 'module://matplotlib_inline...'`, do
  `os.environ.pop('MPLBACKEND', None)` before importing matplotlib, then `matplotlib.use("Agg")`.

Verified working from inside this worktree: `node packages/cli/bin/uniscenarios.js maps list`
returns all five maps and resolves `devAssets` to this worktree's own path.

Write run outputs to `/tmp/tg-<workitem>-<briefId>/`, never reusing a directory between
attempts. Write rubrics inside your worktree — the main checkout's `tools/` holds 259 rubric
files under identical brief IDs and writing there would clobber pre-registrations.

Commit on `training-grade-lane` whenever you want a checkpoint. Do not merge to `main`.
