# Review notes — 2026-08-15, Fable lead on path-pc

Everything below was verified on this machine or by read-only scouts with file:line
evidence (full reports: `agent://EngineScout`, `agent://SchemaScout`, `agent://RenderScout`,
`agent://HistoryScout`; transcripts under `history://`). Where a handoff claim did not
survive scrutiny, it is flagged.

## Claims verified

1. **Gate tripwire passes here.** `verify_gate_hash.py` → PASS, v1 `1a08698e95fca4bc`,
   v2 `3823182614e5a5ba` unchanged.
2. **Repo is at origin/training-grade-lane HEAD** (816a7ee), clean tree.
3. **Gateway works from this machine**: `omp auth-gateway serve` on 127.0.0.1:4141,
   `/v1/responses` with `gpt-5.6-luna` returns `completed`. Quota confirmed: Codex pool
   ~3.66× accounts free, Fable on michael@simforge.ai at 21%.
4. **dev-assets were absent on this machine** (gitignored, 7.9 GB store lives on the Macs).
   Rsynced from simforgelaptop over Tailscale. Nothing could have simulated before this.

## Claims that do NOT survive scrutiny (or are weaker than stated)

1. **"Reasoning effort buys nothing" — NOT on disk.** `reports/training-grade/` has no
   W8 sweep artifact; the 12-arm flat-admission table in the handoff lives only in the
   Mac's in-flight run. The only committed effort datum is one availability probe (luna
   low 2,258 vs max 11,888 reasoning tokens). Plausible, but treat as unconfirmed until
   W8 lands on origin. My plan does not depend on it either way.
2. **"Vision tried twice and lost twice" — weak negative.** The actual experiment:
   n=32/arm, only the repair step saw an image, pooled 17/64 vs 25/64, Fisher p=0.187;
   HELDOUT converged (20/60 vs 22/60); and among 6 HELDOUT briefs admitted by both arms,
   sight quality won 17/18 vs 9/18 (p=.0072 uncorrected). `tools/vista/FINDINGS.md` itself
   says nothing is significant. Additionally `tools/vista/audit2/REPORT-6-AUTHORING.md`
   shows visual-audit authoring raised actual lateral-incursion prevalence .281→.521 while
   placement defects fell .290→.102. The defensible reading: *this particular repair-loop
   design showed no admission gain*, not "vision loses".
3. **Round-5 does not exist** (no round5/ artifacts); round-6's "99, 15/15" was corrected
   to 89/98 and 14/15 by the occlusion audit; the published 0.466 baseline is inflated by
   TG-G1 (honest ~0.401/0.341). The handoff already says this; confirmed from the reports.

## The load-bearing structural facts (scout-verified, file:line in agent reports)

1. **ScenarioTemplateV2 is already a multi-actor choreography language.** ≤64 roles,
   ≤256 interactions, any role can trigger on / react to any other role. Signal phase
   programs (`trafficControls`), map-bound signal plan clips (`mapSignalPlans`), mid-clip
   `set signal:<id>.phase` overrides, weather/time-of-day/sun/friction + mid-clip env
   changes, lane closures, occluder declarations — all expressible TODAY.
2. **The engine executes it.** Mid-sim `changeLane` (legality-checked), `laneOffset`
   swerves (minimum-jerk lateral), mid-sim `route` replacement, signal compliance with
   yellow-decision logic, dark-signal all-way-stop semantics.
3. **Reactive ambient traffic EXISTS and is wired into batch** (`sim-engine/src/ambient/
   traffic.ts`, `batch-cell.ts:197-202`): deterministic seeded actors with per-driver
   profiles (aggression, headway, reaction), signal obedience, yielding, queue settling
   before t=0. **The authoring pipelines never use it** — every authored scenario is an
   empty road with ego + 1 challenger + props.
4. **What is genuinely missing in the engine:** per-actor policy/controller hooks, a
   time-indexed trajectory contract, an external step-wise control API (advance() only,
   no action injection). "Hundreds of agents each driving a car tick-by-tick" is NOT
   supported without engine work.
5. **`author_llm.py` gives the model ~14 scalar fields** routed into 8 hand-written
   compilers. The model literally cannot ask for ambient traffic, a second challenger,
   a signal change, weather, or any interaction shape the compiler didn't hard-code.
   The owner's "there is very little for reasoning to do" is correct, and the unused
   schema surface is the cheapest possible test of it.
6. **Rendering:** cheapest working path is `scripts/render-trace.mjs` (CPU, needs
   instance+trace, emits PNG stills + MP4, needs sharp+ffmpeg). The vista matplotlib
   `render.py` also works (top-down lane-colored map + OBBs, ~1 s/site). Studio 3D needs
   per-map `3d/` bundles (checking presence after rsync) + headed Chrome; CARLA is
   unqualified infrastructure. 2D is sufficient for a footage-review loop test; 3D is a
   bonus on this GPU.
7. **Judging:** blind judge axes exist (`judge_blind.py`). W7's admitted corpus scored
   criticality .9185 but **mechanism provenance no=0.348** — one third of admitted
   scenarios do not exhibit the mechanism their brief named. Plausibility .93 regardless
   of admission. The corpus-layout judge has failed EVERY round on balance, and the
   missing categories map 1:1 to absent map structures (roundabout, school zone, parking
   aisle, work-zone corridor: 0 sites).

## What the current gate actually certifies, and what nothing certifies

- Gate C1–C6: *a critical conflict happened, on ≥2 maps, deterministically*. It is
  computationally free (3.4 ms/cell) and fine as-is.
- Blind judge axis 3: *the named mechanism caused it* — currently failing 35% of admitted.
- **Nothing measures**: does the scene look like real traffic (density, reactive flow,
  negotiation), is the motion natural (no teleports/robotic profiles), is there any
  life beyond the scripted conflict pair. This is exactly the owner's stated desideratum
  and it is entirely uninstrumented.

## Where the compute goes (from handoff, consistent with engine README ~75 ms/run)

Engine ~95% of non-LLM time; 30.3% of cells were `unknown_site` refusals (wasted);
probe rounds 45% of engine time. On 24 cores an engine-only pipeline can do ~1M
cell-seconds/hour; scale is not the constraint — direction is.
