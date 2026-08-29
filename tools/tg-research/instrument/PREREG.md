# PREREG — Stream B realism instrument, calibration experiment (v1)

Registered 2026-08-15, BEFORE the first measured run. Branch `tg-rethink`.
Frozen gate tripwire (`verify_gate_hash.py`): PASS at registration
(v1 `1a08698e95fca4bc` / v2 `3823182614e5a5ba`); will be re-run before and after
every measured run and recorded in results.json.

Pinned implementations (sha256):

    metrics.py    0f089bc386af2abfabb683ec080ec336ac84c67d2b86dbea30a77aae6901440a
    judge.py      9697959b6b5ca37aade99f1bf6778b7e1e866ce001a504d54c1f0d5c45a19210  (rubric prompt inside;
                  re-pinned pre-measurement: token-usage telemetry added, rubric/scores untouched)
    score.py      af8f1e4782027bae23b775920ea4388b0cee9c805c9abf82e36ba492c621b613
    filmstrip.py  c7b9eb8c5708c3b0dbd2551f4968f7ddf6bad3a0b9b443b8ffe7526b630d927b
    b1-frozen-ego.template.json  04e0d5425c1c0ed7ee29b57322301bdf19a86c24502ee0e0cf0f460db4bdc4e7
    b2-zero-kph.template.json    9b06fc4a9f61c97386f34f6728841831231578b2bde11c9e48650d89de3bcf86

Any change to a metric definition, weight, rubric word, or threshold after the first
measured run requires a new PREREG with a `supersedes` note. No silent edits.

## Hypothesis

"Looks like real traffic" is measurable cheaply and reproducibly by (1) deterministic
trace-derived metrics and (2) a blind vision judge on rendered rollouts, and at least
one instrument reaches AUC >= 0.8 per axis on labelled calibration sets.

## Calibration sets (built by `build_sets.sh`, run dir `/tmp/tgr-instrument-calib1/`)

Maps: `easterbrook-discovery-school, belmont-research-center, richmond-field-station,
yale-street`. (`el-camino-road` EXCLUDED: derivedTopology/locations still syncing at
registration time — a build-availability fact, not a results-driven choice.)

Common: `--max-sites 2 --draws 1 --concurrency 6 --out /tmp/tgr-instrument-calib1/<arm>/<template>`.
R+ adds `--ambient moderate --ambient-seed 1234 --ambient-settle 20`. R- adds `--ambient off`.
B+ runs ambient-off (matches the historical broken corpus this class reproduces).

- **R+ rich-healthy** (target n≈64): gold templates
  `lead-hard-brake, disabled-vehicle, fallen-cargo, animal-crossing, oncoming-overtake,
  cyclist-crossing-path, c7-bus-shelter-fixed, c7-hedge-corner-fixed`, ambient ON.
- **R- sparse-healthy**: SAME templates, sites and draws, ambient OFF.
- **B+ broken-dynamic** (target n≈32), three known-broken classes from FINDINGS:
  - B1 frozen ego (TG-P2 class): `broken-templates/b1-frozen-ego.template.json` —
    ego route polyline starting 40 m downstream of spawn with full-lane kinks every ~3 m.
    Verified signature on 1 probe cell: ego distance 0.00 m.
  - B2 zero-kph actor (pre-TG-A1 class): `broken-templates/b2-zero-kph.template.json` —
    disabled-vehicle template with `actor.static` REMOVED, authored speed 0.
    Verified signature on 1 probe cell: authored_stop_violations = 1.
  - B3 VRU-in-occluder (pre-W2 class): existing probes `c7-bus-shelter-baseline,
    c7-hedge-corner-baseline` (tFrac-only occluder placement).
    Verified signature on 1 probe cell: prop_overlap_count = 1.

Exclusions: cells with batch `status != ok` or a missing trace are excluded and counted
in results.json. No exclusion on any metric or judge value. Every produced cell is
scored; none dropped after seeing scores.

## Axes and labels

- **Aliveness axis**: R+ (positive) vs R- (negative). Same scenes, only ambient differs.
- **Naturalism axis**: healthy = R+ ∪ R- (positive) vs B+ (negative).

## Instruments (primary, one per axis per instrument family)

Deterministic (metrics.py v1; full definitions and cited bounds in the module):
- Aliveness: `aliveness_score` = moving_actor_count_mean + 0.5*nonego_reactive_decels +
  lane_change_count + signal_phase_changes + 2*interacting_fraction + queue_max_cluster.
- Naturalism: `-naturalism_penalty`; penalty = teleport_ticks + heading_jump_ticks +
  50*accel_viol_frac(|a|>8 m/s²) + 3*frozen_ego + 2*nonstatic_stopped(non-ambient,
  non-ego) + 3*authored_stop_violations + 3*prop_overlap_count + 2*vru_overspeed_count.

Vision judge (judge.py v1; model `gpt-5.6-sol`, effort medium, `assert_vision.py`
preflight FATAL; blind: anonymized filmstrip only — 8 keyframes, ego-centric fixed
camera, no ids/arm info; cells judged in seeded-shuffled order, seed 20260815):
- Aliveness: `(density_plausible + reactions_present) / 2`.
- Naturalism: `(motion_natural + scene_coherent) / 2`.
- `overall` reported as secondary for both axes.

Secondary (reported, not gating): per-component metric AUCs, judge `overall` AUCs,
judge-metric rank agreement (Spearman), per-broken-class breakdown.

## Analysis

- AUC = Mann-Whitney U / (n_pos * n_neg); 95% CI by 1000-resample stratified bootstrap
  (seed 20260815). Reported per axis per instrument.
- **Success criterion (per brief): AUC >= 0.8 on >= 1 instrument per axis.**
- Any negative is reported with the confusion matrix at the Youden-J threshold.
- Judge-metric disagreement (cells ranked oppositely by the two instruments) is
  reported as a finding, not reconciled away.

## Cost accounting

Per-judgment latency and (if the gateway reports them) token counts are recorded;
target <= ~10 s / few thousand tokens per scenario.

## Post-calibration plan (only if the success criterion holds)

Announce scorer via hub broadcast; score (a) a re-batched sample of M8-authored corpus
templates via `tools/gates/author_corpus.py` (the Mac's /tmp trace paths are assumed
gone), (b) Stream A cell dirs as published, (c) Stream C mined scenes as published.
Report whether the current corpus scores as dead as the owner believes, numbered.

## 3D probe (bonus, timeboxed 1 h, after calibration ships)

Studio path from docs/scenario-visual-qa.md on a 10-scene subsample; judge 3D vs 2D
discrimination delta. Blocked-if-blocked, recorded either way.
