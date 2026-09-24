# Multi-driver Jev: shared contracts

Read `~/tmp/jev-findings.md` (API contract, measured latency, hard safety rules) and
`~/tmp/jev-simforge-integration.md` (current design, hook point, schema v2) first.
Current package: `adapters/jev-driver/jevdrive/`. The original prototype lived in
`~/tmp/jevdrive/`; the render launcher now imports this checkout's package.

## What exists and is PROVEN (do not re-derive, do not regress)

- Hook: `simforge_oss_gym.PolicyRunner` over `SimForgeEnv`; `act_trajectory` takes `(K,5)`
  `[x, y, heading_rad, speed_mps, t_s]`. No renderer change needed for perception.
- Jev is text-only; it cannot emit trajectories. Code enumerates candidates, Jev selects one.
- Latency ~124 ms median / 152 ms p90 with the POOLED SDK client, and FLAT in question count.
  Batch every question for one driver into ONE request.
- `SceneObservation` schema v2: ego-relative, SI units in field names, occluded actors OMITTED
  (never flagged), nullable uncertainty never faked, two timestamps + monotonic seq,
  capability profile asserted at construction.
- Deterministic safety layer owns actuation; every candidate offered to Jev is already feasible.
- scene-state.v1 conventions, VERIFIED against the canonical native emitter
  (`Trace.scene_state_json()` via `Simulation(input, graph, {"captureTrace": true})`):
  `position = [x, 0, -y]`, `yawRad = +heading`, `rotation = [0, sin(yaw/2), 0, cos(yaw/2)]`,
  `velocity = [v*cos(yaw), 0, -v*sin(yaw)]`, plus `acceleration`. Catalog ids come from
  `CATALOG_BY_KIND` in `packages/engine/src/scene-state/helpers.ts` (`pedestrian.adult`, not
  `pedestrian.adult_walking`).
- Renderer: build from source (`cargo build --release --locked --offline -p render-core --bin scen-play`);
  the prebuilt `target-glibc235` binary lacks `KHR_texture_basisu`. Map tiles need
  meshopt/quantization stripped once (`gltf-transform dequantize`). `--glbs` needs ABSOLUTE paths.
  NEVER pass `--ground-y` with real tiles (it disables the terrain raycast and actors float).
  `--pedestrian-models` aborts the render (skinned-mesh bind-group bug) — vehicles only.

### Current native render path

`render.sh RUN [TICKS]` uses `${PYTHON:-python3}` with this adapter at the front
of `PYTHONPATH`. Select an interpreter with the adapter's dependencies installed.
It always requests `scen-play --quality high` for atmosphere, IBL, sun/shadows,
GTAO, AgX and SMAA; the native CLI's historical `sensor` shading is not the
human-facing video default. Sensor capture requires an explicit separate
`scen-play --quality sensor` invocation.

Texture representation is independent of shading: the adapter explicitly selects
`textures-512-bc7`. It verifies `3d/variants/manifest.json`, the referenced index
and object digests, then dequantizes nearby geometry (including vegetation) with
only those tier images. Authored BC7-tier RGBA exceptions are preserved. Missing
tiers or corrupt objects fail rather than falling back to uncapped master images
or unsupported BasisLZ/ETC1S. `map-glbs/selection.json` records the selected tier,
digests, `downgradeReason` and exact cached GLBs passed to playback.

The map root is `MAPS_ROOT`, then `SCEN_DEV_ASSETS`, otherwise
`${SIMFORGE_MAPS_CACHE_ROOT:-${XDG_DATA_HOME:-~/.local/share}/simforge/maps}/map-bundles`.
The selected bundle must include the published render manifest and BC7 tier;
a canonical-only map installation is not a renderable bundle. Source bundles
are read-only, and all preparation outputs stay under the run directory.

## Contract A — driver abstraction (multi-driver core owns; everyone else consumes)

```python
class JevDriver:                     # one per controlled actor
    actor_id: str
    persona: Persona                 # question set + safety envelope + candidate family
    def observe(self, world) -> SceneObservation: ...
    def decide(self, obs, feasible) -> Decision: ...   # one batched Jev request
    def latch(self) -> Maneuver: ...                   # held between decision ticks
```

- `Persona` is data, not a subclass tree: `{name, question_set, candidate_family,
  safety_profile, decision_hz}`. `"cooperative"` and `"reckless"` are two Persona values.
- All drivers in a tick issue their requests CONCURRENTLY (one request each, pooled client,
  `ThreadPoolExecutor`), then all latches commit together. No driver sees another's answer
  within a tick — reaction happens through the world at the next observation, which is what
  makes it genuinely agentic rather than turn-based.
- Each driver observes ONLY what its own sensor gate permits. Driver A must never receive
  B's internal state, intent, or latched maneuver. Reaction is mediated by observation.

## Contract B — safety envelope is per-persona, and the bad actor is NOT a safety bypass

The reckless persona is implemented by WIDENING ITS OWN envelope and offering it aggressive
candidates, never by disabling collision checking or by letting Jev emit raw control.
- Its candidate family may include aggressive closing speeds, late braking, lane intrusion.
- Every other driver keeps its normal conservative envelope and must react defensively.
- A collision, if it happens, must be an EMERGENT outcome of the reckless persona's legal-but-
  aggressive choices plus others' reactions — never an unchecked trajectory written straight
  to the actuator. Record `collision_ticks` and who was at fault by the envelope that was
  violated. If the scene never produces a near-miss, say so; do not fabricate one.

## Contract C — video output

- 20-second clips (1000 ticks at 50 Hz), rendered via the existing `render.sh` path.
- Canvas is EXTENDED TO THE RIGHT with a decision sidebar: total width 1440 (960 render +
  480 panel), height 540. The render pane is NOT cropped or scaled to make room.
- The sidebar shows, for the current tick and per driver: actor id and persona, latched
  maneuver, Jev's raw choice with its probability distribution (a small bar per option),
  confidence, API latency, staleness in metres, fallback reason if any, and the visible-object
  and omitted-occluded counts. With several drivers, show the focused driver expanded and the
  others as one compact row each.
- A scrolling strip of the last N decisions so a viewer can see the decision history, not just
  the current instant.
- Every number in the panel MUST come from the decision log. Nothing is recomputed for display,
  nothing is invented for a frame with no decision.

## Contract D — code quality bar (this is a first-class deliverable)

- `~/tmp/jevdrive/` becomes a proper package with modules, not a pile of scripts.
  One `Persona`/question/threshold module remains the single reviewable place for questions and
  thresholds (TypeSafe's own guidance).
- DRY: the tick loop, candidate generation, feasibility filter, decision latching, logging and
  scene-state recording exist ONCE and are shared by single- and multi-driver runs. The current
  `run.py` is ~460 lines doing all of it inline; decompose it.
- Delete superseded code rather than leaving parallel paths. No compatibility shims.
- Reuse repo abstractions wherever they exist and cite them; only write new ones where you have
  checked and none exists. The yaw-convention bug happened because a hand-rolled conversion
  duplicated a canonical one — do not repeat that.
- `qa_scenestate.py` stays a hard gate before every render.

## Required outputs

1. A COORDINATED driving clip: several Jev drivers on a real map, interacting sensibly
   (following, yielding, merging) with no collisions.
2. A BAD-ACTOR clip: one reckless-persona Jev plus cooperative drivers, on a scenario authored
   so aggression actually creates conflict, with the others' defensive reactions visible.
3. Both 20 s, both with the decision sidebar, both QA-gated, both with their decision logs.
