# Stream B — The realism instrument (measure what the owner wants)

Read `~/tg-research/streams/SHARED-CONTRACT.md` first; it is binding.
Read `~/tg-research/PLAN.md` §1–3. Your dir: `tools/tg-research/instrument/`.

## Hypothesis
"Looks like real traffic" can be measured cheaply and reproducibly by (1) deterministic
trace-derived naturalism/dynamism metrics and (2) a vision judge on rendered rollouts,
and the two agree well enough to trust at scale. Nothing in the project measures this
today; the gate certifies criticality only, and the owner's actual complaint (dead,
templated scenes) is uninstrumented.

## Deliverable 1 — trace metrics (deterministic)
From RAW traces (`tg_gate.load_trace`; columnar ticks, slice explicitly, never print):
- Naturalism: per-actor accel/jerk distributions vs naturalistic bounds (cite the bound
  you adopt, e.g. comfortable decel ≤ 3.5 m/s², jerk ≤ 2 m/s³ typical); teleport/heading
  discontinuity detection; stopped-actor sanity.
- Aliveness: actor count over time, reactive events by NON-ego actors (yields = decel
  correlated with a leader/crosser, gap openings, lane changes, queue formation),
  signal phase changes observed, fraction of actors that ever interact.
- Flow realism: speed variance across actors, headway distribution, PET distribution
  between all pairs (use OBB clearance helpers in tg_gate, NOT minDistance).
Output: `score.py` per SHARED-CONTRACT interface. Version every change.

## Deliverable 2 — vision judge on rendered rollouts
- Render: `node scripts/render-trace.mjs --instance I --trace T --out D` (frames + MP4).
  Also try the vista matplotlib `research/edge-case-corpus/tools/vista/render.py` for
  map-context stills (lanes colored by type). Choose what carries most signal per token;
  a filmstrip of 6–10 keyframes at 512px is a reasonable start.
- Judge: Codex model ONLY (sol or luna). `assert_vision.py` MUST pass first, fatal.
  Blind protocol: the judge never sees which arm a clip came from; randomize order;
  fixed rubric prompt (pre-register it): "does this read as real traffic" subscores
  (density plausible, motion natural, reactions present, scene coherent) + 0–10 overall.
- Cost target: ≤ ~10s and a few thousand tokens per scenario at scale.

## Calibration (THE experiment — do this before scoring anything else)
Build 4 labelled sets on easterbrook first (extend to more maps when synced), n≥30 each,
using `batch` on existing gold/probe templates (`examples/`, `tools/gates/probes/`):
  R+ rich-healthy: gold templates, `--ambient moderate|city`, settle on.
  R- sparse-healthy: SAME templates/sites/draws, `--ambient off`.
  B+ broken-dynamic: reproduce known-broken classes from the findings: frozen ego
     (route starting downstream of spawn — TG-P2 class), 0-kph actor driven by warm-up
     (pre-TG-A1 class: author speed 0 without static:true), physically absurd VRU-in-
     occluder (tFrac-only occluder placement, pre-W2 class).
  Healthy references for B+ comparisons come from R+/R-.
Measure: can metrics separate R+ vs R- (aliveness axis) and B+ vs healthy (naturalism
axis)? Can the vision judge, blind, on renders alone? Report AUC per axis per instrument.

## Then (only if calibration passes, AUC ≥ 0.8 on at least one instrument per axis)
- Score W7's retained corpus cells (reports name trace paths; if the Mac's /tmp paths
  are gone, re-batch a sample of M8-authored templates — `tools/gates/author_corpus.py`
  regenerates deterministically) vs Stream A's corpus as A publishes runs, vs Stream C's
  mined scenes. Publish scorer availability via hub broadcast.
- Report: does the current corpus score as dead as the owner believes? Number it.

## 3D probe (bonus, timeboxed to ~1 h, AFTER calibration ships)
dev-assets contain per-map `3d/` bundles; RTX 5080 present. Try the Studio path from
docs/scenario-visual-qa.md (`pnpm --filter @uniscenarios/studio dev` under hub start +
`pnpm render:export -- --headless`). Needs system Chrome — check availability; if absent
or flaky, record as blocked and move on. One successful 3D capture of a calibration
scene = report whether the vision judge's discrimination improves on 3D vs 2D for a
10-scene subsample. Do not sink time here; 2D is the deliverable.

## Falsifiers
- No instrument reaches AUC ≥ 0.8 on either axis → footage review / realism scoring is
  not currently viable on 2D renders; say so with the confusion matrices, and state the
  3D caveat explicitly. That negative kills a whole cohort design the owner floated —
  it must be airtight, not vibes.
- Vision judge fails assert_vision → hard stop on that model, try the other Codex model,
  else record blocked.
- Judge-metric disagreement is a finding: report where each catches what the other misses.

## Milestones (hub-ping Main)
M1 metrics v1 + score.py runs on the smoke cells at /tmp/tgr-ambient-smoke4 and
/tmp/tgr-lead-smoke1. M2 calibration sets built. M3 PREREG.md + calibration result
(the AUC table). M4 scorer announced / negative declared. M5 corpus scoring +
RESULTS.md + results.json committed.
