# Review ledger — what I verified myself vs. what I'm taking on trust

Lead: omp Fable agent on path-pc, 2026-08-16. Repo: ~/UniScenarios-training-grade @ training-grade-lane (816a7ee, in sync with origin).

## Claims verified first-hand

| claim | verdict | evidence |
|---|---|---|
| TG-G1 unsound cull in published gate | **CONFIRMED** | `tools/vista/gate.py:212` — skips any tick with centre distance > (radii+6 m) once *any* clearance is recorded; approaches that close later but outside the cut are never measured. Corrected cull in `tg_gate.py:135-146` is a provable lower-bound skip. |
| M8 deterministic surface DEV .7534 / HELDOUT .6963 | **CONFIRMED from raw rows** | `reports/training-grade/W7-authored-{DEV,HELDOUT}.json`: 55/73, 94/135 recomputed from per-row `admitted`. |
| M11 luna surface DEV .6986 / HELDOUT .6222 | **CONFIRMED from raw rows** | `W7-luna-{DEV,HELDOUT}.json`: 51/73, 84/135. |
| Anthropic models blind through gateway, HTTP 200 + confident prose | **CONFIRMED live on this machine** | `assert_vision.py`: luna/sol/terra PASS; claude-fable-5 FAIL — "I don't see any image" with status=completed. |
| Gate tripwire intact | **CONFIRMED** | `verify_gate_hash.py` PASS, v1 1a08698e95fca4bc / v2 3823182614e5a5ba. |
| Gateway reaches gpt-5.6-luna from this machine | **CONFIRMED** | /v1/responses round-trip OK; Fable routes 100% to michael@simforge.ai (21% used); Codex pool ~0-30% used across 4 accounts. |

## Claims the handoff treats as solid that are NOT

1. **"Reasoning effort buys nothing" — NO COMMITTED DATA.** `reports/training-grade/` has no W8 sweep file anywhere in the repo; the 12-arm numbers in the handoff live only in the Mac's in-flight run. Directionally plausible (consistent with M8≈M11), but treat as unverified until W8 lands or we re-measure.
2. **"Vision-based authoring tried twice and lost twice" — WEAK.** tools/vista/FINDINGS.md: n=32/arm, pooled Fisher p=0.187, HELDOUT converged (20/60 vs 22/60), and a sight-favoring quality subgroup (17/18 vs 9/18, p=.0072 uncorrected). The honest reading: *no evidence vision helps admission under that specific repair-loop design.* It says nothing about vision for realism/QA judging.
3. **Round-5 results** referenced in some prose: no round5/ exists; any R5 number is unsupported.

## Facts that reframe the problem (from scouts, all with file:line evidence)

- **Schema v2 is already a 64-actor / 256-interaction choreography language** with signal phase programs (`traffic-controls.ts`, `map-signal-plans.ts`), mid-sim `set signal:*.phase`, `changeLane`, `laneOffset` (swerve), polyline routes, weather/friction/timeOfDay, and non-ego reactive `when` triggers. The owner's "swerving, traffic-light manipulation" is expressible TODAY. The 8 compilers in author_llm.py emit ~none of it.
- **Reactive ambient traffic exists engine-native** (`sim-engine/src/ambient/traffic.ts`), deterministic, seeded driver diversity (desired speed, headway, reaction), wired into batch (`batch-cell.ts:197-202`). Authored actors keep priority. Nobody has used it in any corpus run.
- **Real gaps** (engine): no per-actor policy hooks, no external tick-by-tick control API, no goal/planner layer — actors are choreographed, not autonomous. `advance()` exists (resumable stepping) but no action injection.
- **Renderer**: cheap CPU path `scripts/render-trace.mjs` (instance+trace → PNG/MP4, needs sharp+ffmpeg, no GPU); rich path = Studio/Three via Playwright + headed Chrome + dev-assets (unqualified on Linux/RTX5080). Existing review ledger is manual/binary, not an LLM loop.
- **Gate ≠ owner's goal.** The gate certifies criticality+portability. W7: 34.8% of admitted archetypes fail mechanism provenance; plausibility ≈0.93 for admitted AND rejected. Corpus-layout judge fails every round on *balance*, which is map inventory (0 sites for workzone/school/roundabout), not authoring.
- **Admission is near its ceiling**: deterministic no-LLM surface 0.75/0.70 ≥ luna 0.70/0.62. Pushing admission further mostly optimizes against the gate, not toward the owner's stated want.

## Environment on path-pc

- pnpm 11.18.0 (corepack), repo built, `.venv` with httpx.
- `dev-assets` was ABSENT here; rsync from simforgelaptop:…/Simforge/UniScenarios/dev-assets in progress (7.9 GB).
- auth-gateway live at 127.0.0.1:4141 under hub (`auth-gateway`, persist).
- 24 cores / 62 GB / RTX 5080. Prior host contended at 3 parallel arms; this one should take ~8-16 batch workers.
