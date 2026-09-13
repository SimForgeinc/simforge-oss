# CONTRACTS — shared interfaces for the rethink work streams (v1, frozen 2026-08-16)

Owned by the lead (`Main`). Streams: FreeformLane (A), FootageLane (B), EmergentLane (C), EngineLane (D), VistaLane (E — owner-mandated VISTA-faithful visual authoring harness, added 2026-08-16).
Changes to this file are lead-only; streams propose via hub message.

## 0. Ground rules (inherited, non-negotiable)
- **Never fake or overstate a result.** A clean negative is a deliverable.
- **Read metrics from raw traces**, never summary fields.
- **The frozen gate (`tools/gates/tg_gate.py`, manifests v1 `1a08698e95fca4bc` / v2 `3823182614e5a5ba`) is never loosened.** Run `tools/gates/verify_gate_hash.py` at the start of each session; if it fails, stop and report.
- Frozen artifacts are read-only: `tools/gates/*` existing scripts, `research/edge-case-corpus/agent-authoring/*`, `rubrics/mechanism/*`, all `reports/training-grade/*`.
- Do not touch `~/UniScenarios` (parent repo). Work only in `~/UniScenarios-training-grade`.
- Commit early and often on `training-grade-lane`; push to origin. Commit messages prefixed `rethink(<stream>):`.

## 1. Directory ownership
| stream | owns (new code) | reports |
|---|---|---|
| A FreeformLane | `tools/research/freeform/` | `research/edge-case-corpus/reports/rethink/freeform/` |
| B FootageLane | `tools/research/footage/` | `research/edge-case-corpus/reports/rethink/footage/` |
| C EmergentLane | `tools/research/emergent/` | `research/edge-case-corpus/reports/rethink/emergent/` |
| D EngineLane | `packages/*`, `scripts/*` (general fixes with tests) | `research/edge-case-corpus/reports/rethink/engine/` |
| E VistaLane | `tools/research/vista2/` | `research/edge-case-corpus/reports/rethink/vista2/` |
| shared (lead-owned, D implements changes on request) | `tools/research/shared/` | — |

Run outputs: `/tmp/tgr-<stream>-<runid>/` — unique per run, never reused. Disk is tight (69 GB free at start): delete trace dirs after metrics/renders are extracted; keep only what a report cites.

## 2. Cell artifact contract (produced by A/C, consumed by B)
A "cell" directory contains:
```
cell/
  instance.json          # materialized instance (CLI output)
  trace.json.gz          # engine trace
  meta.json              # {cellId, briefId|harvestId, stream, templateSha256, map, site, draw, seed,
                         #  gate: {pass, firstFailure, clearanceM, tMinClearance}, notes}
```
`cellId` = `<stream>-<runid>-<briefOrHarvestId>-<map>-<site>-<draw>`. B renders in place: `cell/render/` (frames + `rollout.mp4` + `render-manifest.json`).

## 3. Footage verdict schema (B produces; everyone consumes)
One JSON per cell per judge model, `cell/review-<model>.json`:
```json
{
  "cellId": "...", "model": "gpt-5.6-luna", "effort": "medium",
  "visionAsserted": true,
  "realism": 0.0,            // 0-10: does this look like real traffic behaving like traffic
  "plausible": true,          // would this scene exist in the world
  "dynamism": 0.0,           // 0-10: how alive is the scene (motion variety, interaction)
  "mechanismObserved": "free text: what actually happened",
  "defects": ["teleport", "frozen_actor", "overlap", "off_road", "unnatural_speed", "other:..."],
  "confidence": 0.0,          // 0-1
  "rawResponseSha256": "..."
}
```
Rules: `visionAsserted` must be true (per-model `assert_vision.py` PASS in the same session) or the verdict is invalid. Judge models: openai-codex only (luna/sol/terra). The judge never sees gate results or the brief's expected mechanism unless the experiment explicitly tests provenance.

## 4. Dynamism census (pre-registered here, before any arm runs)
Shared implementation: `tools/research/shared/dynamism_census.py` (built by A, reviewed by lead, then frozen by sha256 in each report that uses it). Metrics, all computed from the raw trace (and template where noted):
- `actorsMoving`: actors with ≥5 m travelled and ≥1 m/s max speed.
- `laneChangesExecuted`: count of realized lane-change maneuvers (laneRsl transitions to a neighbour with lateral sweep, not chain successors).
- `swerveEvents`: |lateral offset| excursions ≥0.8 m with return, per actor.
- `signalPhaseChanges`: phase transitions during the recorded clip (from signal programs/overrides in the input + events).
- `interactingPairs`: distinct actor pairs with pairwise TTC < 5 s at any tick.
- `speedVarianceEgoPath`: variance of ego speed; `hardBrakeEvents`: decel ≥3 m/s² sustained ≥0.5 s, any actor.
- `authoredEventsFired` / `authoredEventsTotal` (from template interactions vs events).
- `actorCount`, `ambientCount`.
Report as a per-cell row + per-arm aggregate. No metric added/removed after first measured arm without a version bump reported as such.

## 5. Brief sample (A generates, everyone reuses)
`tools/research/shared/briefs-sample.json`: 30 DEV briefs stratified by category (seeded, seed recorded, from `brief-corpus-full.json` DEV split only — HELDOUT stays untouched) + up to 20 owner-list scenarios (from `~/tg-research/OWNER-EDGE-CASES.md`) that pass the W6 structural pre-check (`precheck_briefs.py` logic) as hostable on the five maps. Committed before any arm runs. All A/C comparative arms use exactly this sample.

## 6. Model policy
- Stream agents themselves: Fable (this pool), effort high.
- Authoring & judging calls: codex pool via `OPENAI_BASE_URL=http://127.0.0.1:4141/v1` (gateway already running under hub as `auth-gateway`, `OPENAI_API_KEY=x` placeholder). Default author = `gpt-5.6-luna`/`medium`; deviations recorded in the report.
- Vision: `assert_vision.py` per model per session, fatal on FAIL. Anthropic models never on an image path.
- Owner wants codex quota SPENT. Don't ration; do record token/wall cost per arm.
- **Owner amendment (2026-08-16): exercise different gpt-5.6 models AND efforts.** Authoring (A): pre-registered {luna,sol,terra}×{low,medium,high} grid on a fixed subset before the full run; selection rule declared before results. Judging (B): calibration AUC per model×effort; cheapest adequate judge scales. Cost recorded per arm everywhere.
- Before blaming research for a failure: `omp usage` / gateway health (`hub logs auth-gateway`).

## 7. Engine/CLI facts every stream needs
- Build required after any `packages/` edit: `pnpm -r build` (bundled CLI). CLI: `node packages/cli/bin/uniscenarios.js`.
- Python: `.venv/bin/python` (httpx installed).
- Warm-up 2.0 s precedes trace t=0; C2 needs conflict after warmup+0.5 s; keep `dsM` free of site-dependent terms; `actor.static: true` for genuinely stopped actors; `rules.collisionAvoidance: false` zeroes requiredDecel (TG-P1) — release avoidance late via reactAtTtc-style triggers instead.
- Batch workers ≤16 total across all streams (24 cores; B's ffmpeg also competes). Coordinate over hub if saturating.
- Traces are columnar; never print whole tick objects.

## 8. Reporting cadence
- Each stream: `REPORT.md` in its reports dir, updated at every milestone (not at the end), plus hub message to `Main` at: (1) harness ready, (2) calibration/pilot result, (3) main arm result, (4) final. Numbers in reports must be command output, and the command must be in the report.
- Blockers: message `Main` immediately; don't sit on them. Cross-stream needs (e.g. B needs D's renderer underlay): message the stream directly, cc `Main`.
