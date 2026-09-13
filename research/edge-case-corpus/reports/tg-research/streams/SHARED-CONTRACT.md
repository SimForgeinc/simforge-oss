# Shared contract — tg-rethink streams (binding for A, B, C)

Lead: `Main` (omp Fable agent on path-pc). Message via hub; incremental reports expected
at every milestone, not at the end.

## Repo and branch
- Worktree: `/home/path/UniScenarios-training-grade`, branch **`tg-rethink`** (pushed to
  origin). Do NOT touch `~/UniScenarios` (someone else's uncommitted work) and do not
  commit to `training-grade-lane` (the Mac's W8/W9 lane owns it).
- Your code lives ONLY in `tools/tg-research/<stream>/` (openvocab | instrument |
  worldgen). Reports in `research/edge-case-corpus/reports/tg-research/<stream>/`.
- NEVER edit `packages/`, `tools/gates/`, or another stream's dir. If you need an engine
  or gate change, message Main with the evidence; Main decides.
- You may commit to `tg-rethink` (your dirs only). Do not push; Main pushes.

## Integrity (non-negotiable, verbatim from the project's ground rules)
- The admission gate is FROZEN. `.venv/bin/python tools/gates/verify_gate_hash.py` must
  PASS at the start and end of every measured run; record both in results.
- Read every metric from the RAW TRACE (`tg_gate.load_trace` / `trace_facts`), never
  from summary fields. Exception: `evaluate` verdict/band, which C5 is defined over.
- Pre-register your metrics in `tools/tg-research/<stream>/PREREG.md` BEFORE the first
  measured run; commit it. Changing a metric after seeing results = new prereg with a
  `supersedes` note, never a silent edit.
- A clean negative is a real result. Do not fake, do not smooth, do not drop cells.
- Every run writes to a UNIQUE `/tmp/tgr-<stream>-<runid>/`. Never reuse.

## Environment (already verified working by Main)
- Build is done (`pnpm -r build` green). CLI: `node packages/cli/bin/uniscenarios.js`.
  NOTE: this repo's CLI runs from `dist/` — if you are ever told packages changed,
  rebuild first; you should not be changing packages anyway.
- Python: `.venv/bin/python` (httpx installed). Gate lib: `tools/gates/tg_gate.py`
  (`gate_cell(trace_path, verdict, band, brief, version=2)`), probe plumbing
  `tools/gates/probe_lib.py`.
- LLM gateway (hub-managed, persistent): `OPENAI_BASE_URL=http://127.0.0.1:4141/v1`,
  any placeholder `OPENAI_API_KEY`. Speaks /v1/responses, /v1/chat/completions,
  /v1/messages. Models: `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` (Codex pool —
  owner wants it SPENT; use it freely). `reasoning.effort` ∈ low|medium|high|xhigh|max.
- VISION: Anthropic models through the gateway are BLIND to input_image while answering
  fluently (0/4 on probes). Any image-scoring path MUST use a Codex model AND run
  `.venv/bin/python tools/gates/assert_vision.py` first; treat failure as fatal.
- Models confabulate their identity; trust request logs, not self-report.
- Maps: dev-assets syncing from the laptop (rsync in flight). `easterbrook-discovery-school`
  is complete NOW; check `uniscenarios maps list` for `present:true` before using others;
  the full five-map set should land within ~2 h. Design runs so they extend to 5 maps.
- CPU budget: ≤6 concurrent `batch` workers per stream (24 cores, 3 streams + lead).
- Long-running processes under hub `start`, never bare bash (3600 s timeout will kill it).

## Facts you should not rediscover (Main verified these today)
- `uniscenarios batch <template> --map <m> --draws N --ambient off|light|moderate|city|heavy
  [--ambient-seed S --ambient-density D --ambient-max-actors K --ambient-radius-m R
  --ambient-settle SEC] --out <dir>` works; ambient actors appear in the trace as
  `ambient:v1:<hash>` and are reactive (yield, obey signals, queue).
- 2D render: `node scripts/render-trace.mjs --instance <instance.json> --trace
  <trace.json.gz> --out <dir>` → frames/*.png + trace-render.mp4 (~0.5 s). ffmpeg present.
- Template vocabulary: see `packages/scenario-model/src/schema/v2/` — up to 64 roles /
  256 interactions, triggers `at|after|when|arrival`, verbs `speed|gap|changeLane|
  laneOffset|route|exist|set`, signal phase programs (`trafficControls`), mid-clip
  `set signal:<id>.phase`, weather/env set-keys, `closures`, `lateralM`/`lateralRef`,
  `actor.static`. `uniscenarios schemas` dumps JSON schemas.
- Site matching: `uniscenarios sites match <template> --all-maps [--rejected]`; the
  `failureSummary` names failing clauses. No corridor is posted below ~60 kph on any
  map; there are NO roundabouts, school zones, parking aisles, rail crossings.
- Gate criteria interplay: C2 wants conflict after t=2.5 s, C4 wants demand; at ego
  35 kph the stopped-lead admissible gap window is EMPTY (≥50 kph needed). C5 requires
  evaluate accept+critical+zero collisions; evaluate bands trivially_safe unless
  minTTC ≤ 3 s. `rules.collisionAvoidance:false` zeroes requiredDecel — never use it to
  hold course; use late `reactAtTtcS`-style release instead (see gold template
  `lead-hard-brake`'s `ego-delays-response`).
- Site-dependent `dsM` expressions (over `lane.*`) get evaluated as 0 by the structural
  pass and clamp placements — keep `dsM` constant.

## Cross-stream interfaces (fixed now)
- A cell dir is the unit of exchange: contains `draw-XXX.instance.json`,
  `draw-XXX.trace.json.gz`, `draw-XXX.result.json` (batch layout).
- Stream B publishes a scorer CLI at `tools/tg-research/instrument/score.py`:
  input = one cell dir (or explicit --instance/--trace), output = one JSON line
  `{cellDir, metrics:{...}, judge:{score, verdict, model}|null, version}`. A and C
  consume it AFTER B announces calibration passed (via hub broadcast). Until then, A and
  C proceed without it — it is an add-on measurement, never a blocker.
- Stream A publishes each authored corpus run as
  `/tmp/tgr-openvocab-<runid>/` + an index JSON mapping briefId → cell dirs + gate row.
  B may pull these as evaluation material.
- Report schema for all streams: `results.json` with
  `{stream, prereg_sha256, gate_hash_before, gate_hash_after, runs:[...], metrics:{...},
  negatives:[...], verdict}` and a human RESULTS.md. Milestone pings to Main via hub.
