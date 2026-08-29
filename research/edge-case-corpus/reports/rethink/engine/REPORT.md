# EngineLane (Stream D) — base-repo capability and throughput

Owner standing order (RETHINK-PLAN §3D). Branch `tg-rethink`. Gate tripwire at session start: PASS
(`tools/gates/verify_gate_hash.py` — v1 `1a08698e95fca4bc` / v2 `3823182614e5a5ba` unchanged).

Prior-tooling mandate (lead, 2026-08-16): no prior tooling overlaps this stream directly.
`reports/tg-research/PLAN.md` §"Explicitly not run" declined throughput work ("not a research
question"); **superseded** here because the current lead's RETHINK-PLAN §3D item 2 orders it as
part of the owner's standing repo-improvement directive, demand-driven and measured.

Test-suite baseline note: the cli vitest suite has 62 pre-existing failures (documented in
FINDINGS M2); only regressions beyond that baseline count against changes here.

---

## 1. Renderer underlay + `--redact` (FootageLane dependency; RETHINK-PLAN §3D item 1)

**Motivation.** Stream B needs a vision judge to see roads, not boxes on a grid
(RETHINK-PLAN §3B); FootageLane requested via hub: strong road/off-road distinction, sidewalk +
crosswalk distinction, subtle junction surfaces, no judge-biasing text, <2 s/cell at 640–800 px.

**Commit.** `8acd6e5` — `scripts/render-trace-underlay-lib.mjs` (new, pure),
`scripts/render-trace.mjs` (flags `--dev-assets <root>`, `--redact`),
`scripts/__tests__/render-trace-underlay.test.mjs` (new, 6 tests).

**Failing test first.** `node --test scripts/__tests__/render-trace-underlay.test.mjs` — 1 fail
(module absent) → after implementation: 6 pass / 0 fail.

**Design facts (verified in-session):**
- Trace world frame == topology-index polyline frame (ego t=0 pose is 0.0024 m from its lane
  polyline on belmont; command: nearest-point scan over `topology-index.json.gz` lanes).
- `derived/locations.json.gz` crosswalk anchors are in the 3D scene frame; world `y = -scene.z`
  (verified: anchor lands 1.57 m from its recorded lane `909:0:1`, matching the recorded
  `offsetM 1.565`). Crosswalk bands are anchor+heading approximations, flagged
  `crosswalksApproximate: true` in the render manifest.
- `lane-polygons.geojson.gz` is WGS84 lon/lat (verified numerically) — unusable without an origin
  transform; topology-index polyline strokes used instead (also the named contract).
- Belmont adjacency: 649/662 driving lanes have no left-neighbour record → lane-marking semantics
  from adjacency unavailable; boundary lines drawn as ±width/2 offset polylines instead.

**Measurements (this box, 960×600, 4 stills + mp4 per cell):**

| arm | command | time |
|---|---|---|
| baseline (pre-change) | `node scripts/render-trace.mjs --instance …draw-000.instance.json --trace …draw-000.trace.json.gz --out …` | 0.353 s / 0.392 s (two runs) |
| underlay | same + `--dev-assets dev-assets` | 0.587 s (belmont) |
| underlay+redact per map | same + `--redact`, one cell per map via `/usr/bin/time` | yale 0.73 s, belmont 0.34 s, el-camino 0.78 s, easterbrook 0.50 s, richmond 0.41 s |

Target <2 s/cell: met. Topology load is 0.01–0.06 s/map (measured with gzip+json.load in python).

**Verification.**
- Determinism: two identical underlay runs → all 4 `svgSha256`/`pngSha256` equal AND
  `trace-render.mp4` byte-identical (`cmp`).
- Back-compat: no-flag run after the change → frame hashes byte-identical to renders made
  before the change (`diff` of manifest `.frames[].svgSha256/pngSha256`: empty).
- Error path: `--dev-assets /nonexistent` → hard error naming the missing topology path.
- Visual: belmont corridor + yale junction renders inspected; zebra crosswalk, sidewalks, bike
  lanes, junction coats, boundary lines all present; `--redact` leaves only `t=X.XXXs`.

Announced to FootageLane via hub with example render paths (delivered).

---

## 2. Evidence-join fix: ambient-induced control-binding repairs (EmergentLane hub request)

**Motivation.** EmergentLane (hub, 2026-08-16): cells with ambient traffic at certain signalized
sites die `trace_input_hash_mismatch` → frozen-gate C5 dead for the cell — a harness defect
booked as physics.

**Reproduction (pre-fix).**
`node packages/cli/bin/uniscenarios.js batch tools/tg-research/worldgen/templates/world-junction.template.json --map yale-street --max-sites 2 --draws 1 --ambient city --concurrency 2 --out /tmp/tgr-engine-r2/evjoin`
→ site `02331c12992a78c2`: `evidenceOk=false`, band `evidence-mismatch`, finding
`trace_input_hash_mismatch`. Same command without `--ambient`: `evidenceOk=true` — and the
repaired route (`320:0:-1`) belongs to `ambient:v1:ab75b45974c2631c`, proving the repair is
ambient-route-induced.

**Root cause.** `SimEngine`'s constructor applies `resolveOverlappingControlLanes` (signals.ts)
to its input and hashes the REPAIRED document into `trace.header.inputHash` (engine.ts);
the materializer stamped `manifest.inputHash` over the unrepaired input. Ambient placement is
the last input mutation in `materialize()` and is what introduces routes over coincident
control lanes, so authored-only cells never hit it.

**Fix.** `packages/scenario-materializer/src/materialize.ts`: bake
`resolveOverlappingControlLanes(normalize(input))` after ambient placement, immediately before
`inputHash: contentHash(input)`; record each repair as a `traffic_control_binding_repaired`
warning issue. Idempotent on the engine side (repairLines' key set), so the engine repairs
nothing and hashes the same bytes. Feasibility verdict unaffected (fixed before this point, by
design). Non-repair cells return the same input object — historical digests unchanged.

**Failing test first.** `packages/cli/src/__tests__/evidence-join-control-repair.test.ts`
(pinned repro site, vacuity-guarded: requires the repair issue to be present). Pre-fix: FAIL
(no repair issue, hashes diverge). Post-fix: PASS (6.4 s).

**Verification.**
- `npx vitest run` in `packages/scenario-materializer`: 14 files / 81 tests, all pass.
- CLI repro re-run with `--force` post-build: `02331c12992a78c2 evidenceOk=true`, issues
  include `traffic_control_binding_repaired`.
- Targeted cli tests (evidence, seeding, signal-campaign, materialize): 4 failures, byte-for-byte
  the same set with the fix stashed (pristine tree) — pre-existing baseline (62-failure cli
  baseline per FINDINGS M2), not regressions.

**Commit.** `b511f7c`, pushed.

---

## 3. Actor glyph legend (FootageLane hub request, judge legibility)

**Motivation.** FootageLane: glyphs keyed off literal id `'ped'`; real cells name VRUs
differently → pedestrians rendered as 4 px vehicle boxes, blocking their calibration pilot.
FootageLane landed the kind fix themselves (`c2af2bf`, announced first) after my 25 min silence
(head-down in the matcher probe); I adopted and extended it inside their 15-minute
legend-freeze window.

**Commit.** `194fc1f` — `actorGlyph(id, kind, isStatic)` single-sourced in
`render-trace-underlay-lib.mjs`, consumed for bodies and trails. Extensions over `c2af2bf`:
cyclist/bicycle/scooter now discs (a 1.8×0.6 m bike box at 8 px/m is an illegible sliver),
motorcycle violet `#c07fe8` (was `#b8d65a` ≈ vehicle green), animal `#d98f4a` disc,
sidewalk_robot/drone `#b48fd9` disc. Their rubric colors kept (ped `#ff5a5f`, cyclist `#e67e22`).
Precedence: ego blue > disc class > static amber > motorcycle > vehicle green; static VRUs keep
class color. Legacy id fallback (`'ped'`) preserved for pre-metadata traces.

**Verification.** Failing tests first (3 new lib tests, red on missing export), then green — 9
lib tests total. Real c5 VRU cell (`adult_crossing`, kind `pedestrian`) rendered: red disc
confirmed visually; two identical runs byte-identical after merging FootageLane's camera
changes. Final legend sent to FootageLane over hub before their rubric froze.

---

## 4. unknown_site engine waste eliminated (RETHINK-PLAN §3D item 2)

**Motivation.** LEAD-REVIEW/REVIEW-NOTES: ~30% of cells in W7-era runs were `unknown_site`
refusals — pure waste. Prior lead's PLAN.md declined this as "not a research question";
superseded by the current lead's ordered backlog (owner standing order).

**Root cause (found, not assumed).** `batch` plans cells from
`matchOnMaps(template, maps, { minScore, maxSites })`; `runCell` re-resolved each site via
`findSite(template, map, siteId, {})` — no options. Under a diversity policy,
`maxSitesPerMap` changes *which* sites are selected, not merely how many, so the worker's
re-match can lack planned sites entirely. Probe (`/tmp/tgr-engine-r3/probe-site-drift.mts`,
tsx, plan-vs-worker site-set comparison): c3-allway-stop drifts on 3 of 5 maps
(e.g. yale planned=5, missingInWorker=2). Each refusal also paid a full per-worker anchor
re-match — the most expensive step in the pipeline.

**Fix (representation-level).** `CellOptions.site` carries the `MatchedSite` exactly as the
plan resolved it (verified plain/structured-clone-safe data; crosses the worker_threads
boundary); `runCell` uses it and only loads the map bundle. Site resolution happens once, at
plan time. `findSite` fallback kept for the catalog path (exact-site policy) and external
callers.

**Failing test first.** `packages/cli/src/__tests__/batch-planned-site-resolution.test.ts` —
RED pre-fix on drift site `0d9cc5d57f76feec`; GREEN post-fix. (First draft asserted
`status==='ok'` for all sites; relaxed deliberately: `arrival_unconverged` is a legitimate
solver verdict, not a re-resolution failure.)

**Measurement (same batch, same box, `--force`):**
`node packages/cli/bin/uniscenarios.js batch research/edge-case-corpus/vista-corpus/templates/c3-allway-stop.template.json --all-maps --draws 10 --max-sites 5 --concurrency 8 --out …`

| arm | cells | wall | user CPU | unknown_site | ok cells | accepted |
|---|---|---|---|---|---|---|
| before (`allway-before`) | 180 | 96.4 s | 349.9 core-s | 50 (27.8%) | 115 | — |
| after (`allway-after`) | 180 | 37.7 s | 94.8 core-s | 0 | 165 | 41 |

2.6× wall / 3.7× CPU improvement while simulating 50 MORE cells. All 115 previously-ok cells
byte-identical across arms (paramSeed + inputHash + traceDigest + verdict compared pairwise).
Refused cells were valid matched sites — the fix converts waste into yield, not just speed.

**Suite state.** cli-smoke (4) + catalog-batch (1) failures identical on a pristine stash/rebuild
— pre-existing baseline, not regressions. `batch-worker-resolution` passes.

**Commit.** `6dc8e5f`, pushed.

---

## 5. Owner vocabulary (RETHINK-PLAN §3D item 3): status per item

Ordering per brief: (a) animal, (b) debris, (c) cart/robot, (d) EV lights. Commit `ec46376`.

**(a) Animal actor class — ALREADY LANDED, verified in-session.** `animal` is an ActorKind in
the engine (pedestrian-like motion, route/laneOffset verbs run — `custom-route.test.ts` exercises
kind `animal`), `animal.deer/dog/cat/raccoon/goose` carry real footprints in the materializer's
catalog, prop-catalog has quadruped builders, and the agreement check refuses an animal wearing
a pedestrian model (`actor-catalog-agreement.test.ts`). Renderer draws animals as tan discs
(my glyph commit `194fc1f`). No change needed.

**(b) Road debris props — ALREADY LANDED, verified in-session.** `hazard.tire_debris`,
`hazard.ladder`, `hazard.mattress`, `hazard.debris` (+ author-facing `object.*` aliases) exist
as static collidable props with `debris`+`roadway` tags and tests
(`animals-and-objects.test.ts`, `propBehavior` marks them collidable+occluder). No change needed.

**(c) Slow wheeled actors — HALF FIXED, HALF DOCUMENTED.**
- *Delivery robot:* real gap found — `actorClassesForCatalogId` sent `sidewalk_robot.*` to
  `static_object` only, while every downstream layer already hosts moving robots (engine kind is
  pedestrian-like; OpenSCENARIO exports it as Pedestrian mass 70; editor has a robot action
  family at 6 km/h; playback and glyphs ready). One-case fix in `prop-dims.ts` + failing-first
  agreement test: `sidewalk_robot.delivery_rover`/`cooler_bot` now materialize as moving actors.
  Materializer suite 82/82.
- *Rolling shopping cart:* `street.shopping_cart` exists as a static collidable prop (hostable
  today as an abandoned-cart obstacle). A MOVING cart cannot be represented honestly with any
  existing class — dressing it as `sidewalk_robot` is exactly the class/model lie the agreement
  check exists to prevent. **Seam and cost (stop rule applied):** a new ActorKind `cart`
  (unpowered wheeled object) touches sim-engine (`ACTOR_KINDS`, `DEFAULT_ACTOR_DIMS`,
  `isPedestrianLikeKind`), scenario-model (`ACTOR_CLASSES`, dims, VRU set, regenerated JSON
  schema), materializer (agreement table, driver-profile exclusion), openscenario exporter
  (OpenSCENARIO object category — semantic decision: Pedestrian-with-property vs MiscObject),
  editor-core (action family), playback (default catalog id), ambient defaults map — 7 packages,
  ~10 mechanical sites + 2 semantic decisions. Deferred as disproportionate for this window;
  recommended as the template for any future "unpowered wheeled" vocabulary (cart, wheelie bin,
  dolly).

**(d) Emergency-vehicle light state — DONE.** The `lights.emergency` set key
(`off|flashing|flashing_siren`) was already registered end-to-end and the engine already records
`state_set` events into the trace (`engine.ts` set-verb path). The 2D renderer now draws it:
red/blue roof lamps + halo ring (heavier for `flashing_siren`), flash phase
`floor(t/0.25) % 2` from frame time only — re-renders stay byte-identical.
`emergencyLightStateAt`/`emergencyFlashPhase` in the renderer lib, failing tests first
(11 lib tests). E2E: ambulance template with `set lights.emergency=flashing_siren @ t=1`,
batched on belmont site `003a42272f947bd0`; `state_set` event verified in the trace;
t=0.5 frame dark / t=1.74 frame lit, confirmed visually.
`/tmp/tgr-engine-r4/ev-render/frames/`.

**Latent defect noted (not fixed, out of scope):** the engine's ambient default catalog maps
kind `animal` → `pedestrian.child_walking` (`sim-engine/src/ambient/traffic.ts:599`) — the same
animal-wearing-human class/model lie the agreement check prohibits, in the ambient path. Ambient
flows do not currently spawn animals, so it is unreachable today; flagged for whoever extends
ambient flows.

**Renderer corpus-impact audit (for FootageLane's frozen calibration):** `lights.emergency`
appears in vista-corpus `c3-ev-crossing` with `value: true` (not in the enum) — stringifies to
`'true'`, draws nothing, so no pixel change to any existing W7-family render; only
`examples/edge-cases` 02/03/12 and new freeform-authored EV cells will light up. Reported to
FootageLane (with a correction to my initial too-strong "zero corpus usage" claim).

---

## 6. Per-actor policy hook design note (RETHINK-PLAN §3D item 4) — GO received, note delivered

Condition: "if EmergentLane's harvest shows promise." EmergentLane issued an explicit GO over
hub (2026-08-16, per their PREREG F1) on interim numbers: ≈7.7 admitted/1000 world-runs through
the frozen gate (3/36 promotion attempts, budget unexhausted), 8-category mechanism spectrum
with no rear-end collapse, one owner-list left-turn-across-traffic admission. Their dominant
promotion failure (C4 dissolution — reactive ego dissolves the promoted conflict) is precisely
the seam the hook controls.

**Deliverable:** `DESIGN-policy-hook.md` (this directory) — design ONLY, no implementation.
Policies as deterministic default-slot owners under the existing one-axis-one-owner contract
(`interaction > policy > built-in law`, all capped by `governorCap`), observation struct from
state the engine already computes, replay determinism by the same argument as existing driver
diversity, cost ~300-400 engine lines + pass-through schema fields, with pre-registered
falsifiers (policy diversity must out-yield scalar diversity sweeps; no-policy byte-identity
must hold).

---

## Session close

- Gate tripwire: PASS at session start and after final commit (v1 `1a08698e95fca4bc` /
  v2 `3823182614e5a5ba` unchanged).
- All commits `rethink(engine):` on `tg-rethink` (branch moved from `training-grade-lane` by
  lead mid-session), pushed: underlay `8acd6e5`, evidence-join `b511f7c`, glyphs `194fc1f`,
  unknown_site `6dc8e5f`, vocabulary `ec46376`, reports `0dda40f` + final.
- Hub requests served: FootageLane (underlay, redact, glyph legend — unblocked their
  calibration), EmergentLane (evidence-join fix — confirmed on their side), VistaLane
  (worktree unblock).
- Run dirs `/tmp/tgr-engine-r1..r4` retain only cited artifacts; bulky batch outputs deleted
  below.

