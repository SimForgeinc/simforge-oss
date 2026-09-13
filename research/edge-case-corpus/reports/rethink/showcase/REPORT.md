# SHOWCASE implementation report

### P4 — showcase frontend

Implemented a Vite + Preact single-page frontend in `apps/showcase/web/` against the frozen §5 API:

- Gallery: responsive render-card grid with headline still/looping MP4 support, brief, engine, admitted-cell, realism, dynamism, and map chips.
- Job detail: SSE connection and stage-status merge across stages 00→90, raw JSON expanders, image/video/download artifact views, Vista2 author-action filmstrip, and per-cell gate/judge verdicts.
- Submit: every §1 knob is represented and posted using the frozen field names and the exact five repository map IDs; a successful `{jobId}` response navigates directly to the live detail view.
- Auth token from `?token=` is preserved on REST, SSE, and artifact URLs.
- A small contract-compatible mock server is available through `pnpm --filter showcase-web dev -- --mock`; it does not invent video and serves labeled stills for visual development.

Verification run on 2026-08-16:

```text
$ pnpm --filter showcase-web test
Test Files  1 passed (1)
Tests       4 passed (4)

$ pnpm --filter showcase-web build
vite v6.4.3 building for production...
✓ 9 modules transformed.
dist/index.html                  0.45 kB │ gzip:  0.29 kB
dist/assets/index-DK7YcmS9.css   8.54 kB │ gzip:  2.84 kB
dist/assets/index-CotKFEUW.js   30.35 kB │ gzip: 11.45 kB
✓ built in 325ms

$ pnpm build
$ pnpm -r build
Scope: 20 of 21 workspace projects
...
apps/showcase/web build: ✓ built in 246ms
apps/showcase/web build: Done
apps/studio build: ✓ built in 9.44s
apps/studio build: Done
# exit 0
```

The production `dist/` bundle was served with `pnpm --filter showcase-web mock -- --static` and walked with `playwright-core` using `/usr/bin/google-chrome` at 1440×1000. The walkthrough also submitted the form and asserted navigation to the mock server's returned job ID. Captures are committed in `p4-screens/`: `gallery.png`, `job-detail.png`, and `submit.png`.

After P3 commit `5bb710b` landed, P4 added and tested adapters for its concrete `/full` file-index shape, nested gallery `gate`/`scores`, and job-relative SSE artifact paths. The P3 server suite also passes:

```text
$ pnpm --filter @uniscenarios/showcase test
# tests 3
# pass 3
# fail 0

# Real committed server on :4317, frontend on :4318 through its API proxy:
gallery_http=200
real_server_browser_smoke=PASS
server_root_http=404
```

Still needs server/integration work: P3 does not currently mount `apps/showcase/web/dist` at `/` (`GET /?token=...` returned 404), so the single-process production deployment promised by the plan is not yet wired. P4 does not own `apps/showcase/server/` and did not change it. The browser smoke confirmed the authenticated real gallery API through the frontend proxy; a full costly generation/render job and real MP4 playback were not run in P4. The mock verifies POST, SSE, full job navigation, filmstrip, cells, and artifact presentation without inventing rendered evidence.

### P2 — 3D render tier + Q3D qualification

#### Q3D milestone: qualified on real NVIDIA GPU

The frozen gate tripwire passed before qualification (manifest v1 `1a08698e95fca4bc`, v2
`3823182614e5a5ba`). Xvfb `:99`, system Chrome, and Studio were started with:

```text
Xvfb :99 -screen 0 1920x1080x24 +extension GLX +render -noreset
DISPLAY=:99 pnpm --filter @uniscenarios/studio dev --host 127.0.0.1 --port 5199
DISPLAY=:99 VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json \
  /usr/bin/time -f 'WALL_SECONDS=%e' node scripts/verify-city-renderer.mjs \
  --url 'http://127.0.0.1:5199/?map=belmont-research-center' \
  --out /tmp/q3d-angle-vulkan-belmont --min-tiles 20 \
  --settle 60000 --bench 15000 \
  --chrome-flags '--use-gl=angle,--use-angle=vulkan,--enable-features=Vulkan'
```

Verdict: **Q3D GPU qualified**. The WebGL renderer was
`ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 5080 (0x00002C02)), NVIDIA)`
(`Google Inc. (NVIDIA)`, driver 595.84). The complete Belmont city reached 20 resident tiles in
10.196 s. The 15.057 s, 1600×960 orbit benchmark rendered 212 frames at 14.080 average FPS
(p50 63.5 ms, p95 134.4 ms, minimum 5.319 FPS). The complete verifier took 48.55 s, exercised
city/vegetation visibility, orbit and fly controls, and reported zero console errors. Raw results
and five screenshots are in `p2-q3d/`.

Qualification harness fixes were necessary and are part of P2: seed Studio's required first-run
`balanced` quality preference, report the unmasked WebGL renderer and Chrome flags, allow a
map-appropriate resident-tile threshold, choose a street camera from the current map's longest
lane, and exercise current viewer layer groups instead of removed UI test IDs.

The default Yale qualification could not be used honestly: its local manifest references 132 LOD
files, but 111 are absent from `dev-assets/yale-street/3d/tiles/`; requests returned Vite's HTML
fallback and the old verifier timed out. The other four map bundles have all manifest-referenced LOD
files. Belmont was selected because its bundle is complete. Baseline Chrome without ANGLE Vulkan
reported `ANGLE (Mesa, llvmpipe (LLVM 20.1.2 256 bits), OpenGL 4.5)` and timed out at the old
30-tile gate; it is not the qualified configuration.

#### Tier3d implementation and E2E acceptance

`packages/cli/src/commands/render/tier3d.ts` now implements P1's dispatch seam. With no `--3d-url`
it allocates a free localhost port and starts a minimal ephemeral Studio Vite server; with no
`DISPLAY` it also allocates an Xvfb display. Both process groups are terminated on success or
failure. Chrome uses the qualified ANGLE/Vulkan arguments and the NVIDIA Vulkan ICD when present.
`--3d-url` is wired through the CLI for callers that already run Studio.

The existing `scripts/export-render.mjs` remains runnable and now accepts Chrome flags, accepts a
validated instance/trace pair without requiring a catalog result, and has a separate
`--all-authored` mode. That mode constrains the camera composition to every non-ambient authored
actor **and every authored prop**, while keeping the video to the incident window rather than the
full corpus clip. The manifest is wall-clock-free (`generatedAt: null`, `deterministic: true`) and
its machine assessment rejects missing phases, actors, props, failed composition, or video/hash
mismatches. Two stale review-provenance paths were updated from the removed Studio-local playback
files to `packages/playback/src/{controller,model}.ts`.

E2E fixture:
`/tmp/tgr-emergent-pair1/cells/emergent-pair1-c11-aisle-conflict.off-belmont-research-center-1fe43cbb-2`.
Its run metadata says frozen-gate `pass: true`, clearance 0.491 m at t=6.58 s. The built
CLI was run without a prestarted display or Studio:

```text
env -u DISPLAY /usr/bin/time -f 'WALL_SECONDS=%e' \
  node packages/cli/bin/uniscenarios.js render \
  /tmp/tgr-emergent-pair1/cells/emergent-pair1-c11-aisle-conflict.off-belmont-research-center-1fe43cbb-2/trace.json.gz \
  --instance /tmp/tgr-emergent-pair1/cells/emergent-pair1-c11-aisle-conflict.off-belmont-research-center-1fe43cbb-2/instance.json \
  --out /tmp/q3d-cli-e2e --tier 3d --format both --fps 12
```

Verdict: **PASS**, 130.27 wall seconds per 3D render (128.00 s inside tier3d). The requested browser
viewport was 1600×960; the UI-hidden Studio canvas artifacts are 1040×918. Output is four distinct
phase PNGs plus a 3.25 s H.264/yuv420p MP4 (39 frames, exactly 12 FPS). Manifest
`52269e1bda7c9a3ed0a3ae77d01216fd2bc49e376538b2480bdb375c22edb2a8` passed every machine gate.
Both actors (`ego`, `reversingVan`) and the authored `parked-occluding-vehicle` box-truck prop were
in-frame and scenery-clear in every phase. The MP4 SHA-256 is
`dca68b036bc9191fa3c8a4b23cac4b5adde455beab682a59398bff8b0b90d777`. The manifest, preflight,
four phase images, and MP4 are committed in `p2-e2e/`.

Focused verification:

```text
$ pnpm --filter @uniscenarios/cli exec vitest run src/commands/render/tier3d.test.ts
Test Files  1 passed (1)
Tests       4 passed (4)

$ node --test scripts/__tests__/scenario-review-ledger.test.mjs
tests 8; pass 8; fail 0

$ pnpm -r build
exit 0
```

### P1 — trace-render package + `uniscenarios render` 2D tier

Implemented `@uniscenarios/trace-render` as an importable ESM workspace package by promoting the
deterministic renderer and underlay internals. `scripts/render-trace.mjs` is now a thin adapter to
the package. The package exposes `renderTrace(options)` and keeps the legacy script defaults,
stdout path, manifest shape, renderer identifier, SVG/PNG encoding, and H.264 encoding byte-identical.

Added `uniscenarios render <trace.json.gz> --instance <instance.json>` with the complete P1 option
surface: `--out`, `--tier 2d|3d|both` (default `2d`), `--format stills|video|both` (default `both`),
`--camera follow-ego|overview`, `--fps`, `--redact`, and `--dev-assets`. The 2D path calls the new
package. `packages/cli/src/commands/render/tier3d.ts` is only the requested typed P2 dispatch seam
and returns a structured unavailable result; P1 did not implement 3D.

The wrapper regression uses committed fixture `fixtures/evidence/golden-yale-bus-stop/` and hashes
the legacy script before promotion, then pins all four SVGs, all four PNGs, the MP4, and the manifest.
The post-promotion script produced the same hashes. Representative pinned hashes:

- `frame-000.svg`: `257ce36d5c8686d97d31bcc61c41af6cde6220bc08f5261ee0b382d1dd490ea4`
- `frame-000.png`: `a15e0f4678325b0577dfc75b123b4e132678f8412181cb83ff10f11b420267d0`
- `trace-render.mp4`: `714c75e7f3602c38dbcf52ec48037f080bada214b709e16298bdcb958a40abc4`
- `manifest.json`: `055c6f20dfbecd4f9cb60c920093deb337d86be83ff5114edf79191ab3b36c82`

Verification on 2026-08-16:

```text
$ .venv/bin/python tools/gates/verify_gate_hash.py
GATE-HASH TRIPWIRE: PASS -- frozen gate v1 1a08698e95fca4bc / v2 3823182614e5a5ba unchanged

$ pnpm --filter @uniscenarios/trace-render test
tests 3, pass 3, fail 0

$ pnpm --filter @uniscenarios/cli exec vitest run src/__tests__/render-args.test.ts
Test Files  1 passed (1)
Tests       6 passed (6)

$ pnpm --filter @uniscenarios/cli typecheck
$ tsc --noEmit
# exit 0

$ pnpm -r build
# exit 0; 20 of 21 workspace projects built
```

The built CLI acceptance smoke was:

```text
$ node packages/cli/bin/uniscenarios.js render \
    fixtures/evidence/golden-yale-bus-stop/trace.json.gz \
    --instance fixtures/evidence/golden-yale-bus-stop/instance.json \
    --out /tmp/p1-cli-render.LElHv4 --tier 2d --format both --camera follow-ego --fps 12
{"trace":"fixtures/evidence/golden-yale-bus-stop/trace.json.gz","instance":"fixtures/evidence/golden-yale-bus-stop/instance.json","out":"/tmp/p1-cli-render.LElHv4","tier":"2d","format":"both","camera":"follow-ego","fps":12,"tiers":{"2d":{"status":"rendered","manifest":"/tmp/p1-cli-render.LElHv4/manifest.json"}}}
```

It produced four SVG stills, four PNG stills, `manifest.json`, and a 21,320-byte H.264
`trace-render.mp4`. A CLI smoke with a different instance exited 1, emitted no stdout, and returned
structured `render_failed` evidence-integrity details (input hash and actor IDs differed).

The full pre-existing CLI suite was also run (`pnpm --filter @uniscenarios/cli test`): the six new
render argument tests passed, but the overall suite exited nonzero on numerous unrelated existing
simulation/map regression assertions, including temporary-lane-drop, bus-pullout, and
intersection-arrival cases. No P1 renderer assertion failed. This broader-suite limitation is
reported rather than represented as green; the requested new tests, CLI typecheck, workspace build,
and end-to-end 2D acceptance smoke are green.

### P5 — pipeline glue + gallery preseed

Implemented the three requested entrypoints under `tools/research/showcase/` without changing the
frozen source implementations:

- `author_one.py` writes `20-author/template.json` and inspectable transcripts for either a
  single compiler brief or one Vista2 episode. Compiler mode imports
  `tools/gates/author_llm.py`, calls its `decide()` then `compile_and_validate()` functions, and
  sets `VISTA_MODEL=gpt-5.6-sol` / `VISTA_EFFORT=medium` before that module imports `vlm.py`.
  Vista2 requires a caller-provided `--guide`, preserves the action JSONL, LLM JSONL, GUIDE,
  action PNGs, and current validated template even if a deliberately short episode ends without
  portability admission.
- `judge_cells.py` discovers contract cell directories and fixes the configuration to
  gpt-5.6-sol/medium/spread8, vision assertion required, redacted render required. It atomically
  checkpoints after every cell and skips completed `cellId`s on resume.
- `preseed_gallery.py` ranks vision-asserted sol verdicts lexicographically by gate pass then
  realism+dynamism (with score tie-breaks), reserves representation for every surviving source
  root, copies each instance/trace/meta/verdict out of `/tmp`, and re-renders at 12 FPS. It wrote
  24 independent `showcase-data/gallery-seed/<n>/90-gallery.json` layouts with MP4s. P5 also made
  the showcase server discover these per-card seed files and verified their media endpoint, so
  `/api/gallery` is populated on first load.

Frozen gate verification at session start:

```text
$ .venv/bin/python tools/gates/verify_gate_hash.py
GATE-HASH TRIPWIRE: PASS -- frozen gate v1 1a08698e95fca4bc / v2 3823182614e5a5ba unchanged
```

Compiler smoke (gateway environment was explicitly set as shown):

```text
$ /usr/bin/time -f 'COMMAND_WALL_S=%e' env \
    OPENAI_BASE_URL=http://127.0.0.1:4141/v1 OPENAI_API_KEY=x \
    .venv/bin/python tools/research/showcase/author_one.py \
    --engine compiler --brief 'a slower lead vehicle brakes hard' \
    --out /tmp/showcase-p5-compiler
valid=true; 20-author/template.json + transcript.json written
adapter wall=12.590 s; command wall=12.71 s
```

The reused frozen `decide()` interface returns decision text but not response usage, so compiler
tokens are recorded as `null` with that reason; no token count was estimated.

Short Vista2 smoke using the mature, provided main-run GUIDE seed:

```text
$ /usr/bin/time -f 'COMMAND_WALL_S=%e' env \
    OPENAI_BASE_URL=http://127.0.0.1:4141/v1 OPENAI_API_KEY=x \
    .venv/bin/python tools/research/showcase/author_one.py \
    --engine vista2 --brief 'a delivery van pulls out while a cyclist approaches' \
    --guide /tmp/tgr-vista-main1/GUIDE.md --budget 4 --wall-cap 600 \
    --out /tmp/showcase-p5-vista2
PASS gpt-5.6-sol sees red ('Red'); valid=true; admitted=false
adapter wall=60.655 s; command wall=62.86 s
4 calls; input=29,827; output=2,016; reasoning=1,251 tokens; LLM wall=42.877 s
```

This was intentionally a four-action smoke, not an admission run. It ended with a valid template,
5 action transcript rows, 4 LLM rows, and 3 PNG observations, but did **not** win the portability
gate; P5 does not claim that it did.

Three-cell judge smoke and fully cached resume:

```text
$ /usr/bin/time -f 'COMMAND_WALL_S=%e' env \
    OPENAI_BASE_URL=http://127.0.0.1:4141/v1 OPENAI_API_KEY=x \
    .venv/bin/python tools/research/showcase/judge_cells.py \
    --cells /tmp/showcase-p5-judge-cells --out /tmp/showcase-p5-judge.json
discovered=3; completed=3; errors=0; command wall=28.84 s
judge latency sum=27.47 s; input=12,882; output=1,206; reasoning=943 tokens

$ .venv/bin/python tools/research/showcase/judge_cells.py \
    --cells /tmp/showcase-p5-judge-cells --out /tmp/showcase-p5-judge.json
cached <cell-1>; cached <cell-2>; cached <cell-3>
discovered=3; completed=3; errors=0
```

Gallery generation and measured result:

```text
$ /usr/bin/time -f 'COMMAND_WALL_S=%e' \
    .venv/bin/python tools/research/showcase/preseed_gallery.py \
    --count 24 --out showcase-data/gallery-seed
freeform: 300 eligible; emergent-pair: 964; emergent-h2: 1,117; vista-main: 1,086
populated 24 cards; command wall=20.00 s
```

The committed seed is 46 MB: 24 cards, 24 non-empty H.264 MP4s, 24 copied instances, and 24 copied
gzip traces. All selected cells pass the frozen gate; realism+dynamism sums range 11–16. The
selection contains six cells from each of the four requested roots, covers all five maps, and no
card depends on its temporary source root. A second render after correcting evidence-derived map
IDs and artifact-root-relative URLs took 20.93 s.

Focused verification:

```text
$ .venv/bin/python tools/research/showcase/test_showcase_tools.py -v
Ran 5 tests in 0.001s — OK

$ pnpm --filter @uniscenarios/showcase test
tests 3; pass 3; fail 0

$ pnpm --filter @uniscenarios/showcase build
node --check server/index.mjs && node --check server/pipeline.mjs  # exit 0
```

### P3 — showcase server + job runner

Implemented `@uniscenarios/showcase` as one Node process with the frozen REST/SSE surface, token
authentication, byte-range artifact serving, the built P4 frontend, and a filesystem-backed queue
capped at two concurrent jobs. A successful `?token=` page request establishes a same-site,
HTTP-only cookie for the frontend's hashed assets; API and artifact calls continue to accept the
contracted query token or Authorization header. The runner reconstructs completed SSE events on
restart and resumes incomplete jobs from their atomically committed stage artifacts.

The default engine writes the exact `00` through `90` layout. Its Python adapter imports
`precheck_briefs.precheck`, `author_llm.author_brief`, `tg_gate.gate_cell`, the Vista2 `Episode`, and
`footage/judge.py` rather than copying protected implementations. Compiler and judge calls use
`gpt-5.6-sol`/`medium` and the local gateway environment. `uniscenarios batch` receives maps,
draws, site cap, ambient preset, and ambient seed; the user seed also determines a stable template
identity so it flows through batch's existing per-cell seed derivation. Rendering tries the
built-in `uniscenarios render` command first and retains the required legacy-script fallback.
Judge-disabled and gateway-down jobs commit an explicit skipped `70-judge.json`; unavailable 3D
commits an explicit skipped `65-render3d/index.json`.

Frozen-gate verification at session start passed:

```text
$ .venv/bin/python tools/gates/verify_gate_hash.py
GATE-HASH TRIPWIRE: PASS -- frozen gate v1 1a08698e95fca4bc / v2 3823182614e5a5ba unchanged
```

Focused verification:

```text
$ pnpm --filter @uniscenarios/showcase test
tests 3; pass 3; fail 0

$ pnpm --filter @uniscenarios/showcase build
node --check server/index.mjs && node --check server/pipeline.mjs  # exit 0

$ pnpm -r build
Scope: 20 of 21 workspace projects
# exit 0; showcase frontend and all workspace packages built

$ .venv/bin/python -m py_compile \
    tools/research/showcase/stages.py tools/research/showcase/preseed.py
# exit 0
```

The P3 pre-seed script was exercised against all three requested available roots:

```text
$ .venv/bin/python tools/research/showcase/preseed.py --limit 24
{"gallery": "/home/path/UniScenarios-training-grade/showcase-data/jobs/preseed/90-gallery.json", "cards": 24, "failures": 0}
```

It selected and rendered 24 vision-asserted judged cells in 17.79 s with zero failures. P5's
committed, source-balanced 24-card seed is what supplies a fresh clone on first load; the P3 run
verified the required live-job gallery scan path without committing generated job data.

Real HTTP compiler acceptance was run with the package start command:

```text
$ SHOWCASE_TOKEN=showcase-p3-acceptance SHOWCASE_PORT=4174 \
    pnpm --filter @uniscenarios/showcase start
showcase server listening on http://0.0.0.0:4174
```

These are the exact successful curl commands used to submit and verify the job:

```text
$ curl -sS -X POST \
    'http://127.0.0.1:4174/api/jobs?token=showcase-p3-acceptance' \
    -H 'Content-Type: application/json' \
    --data '{"brief":"A stopped lead car blocks the ego lane. The ego approaches at speed and brakes late to avoid it.","engine":"compiler","nScenarios":1,"maps":["yale-street"],"maxSitesPerMap":1,"ambient":"light","seed":17,"render3d":false,"topK":1,"judge":false}'
{"jobId":"3bda5e51-dbd7-4981-961d-2c9111bd9c74"}

$ curl -sS -N \
    'http://127.0.0.1:4174/api/jobs/3bda5e51-dbd7-4981-961d-2c9111bd9c74?token=showcase-p3-acceptance'
# emitted every stage through:
data: {"stage":"90-gallery","status":"complete","artifacts":["90-gallery.json"]}

$ curl -sS \
    'http://127.0.0.1:4174/api/jobs/3bda5e51-dbd7-4981-961d-2c9111bd9c74/full?token=showcase-p3-acceptance' \
    | jq '{jobId, stages: [.files[].path]}'
# listed 00-brief.json through 90-gallery.json, concrete instance/trace/meta, frames, manifests, and MP4

$ curl -sS \
    'http://127.0.0.1:4174/api/gallery?token=showcase-p3-acceptance' \
    | jq '.[] | select(.jobId == "3bda5e51-dbd7-4981-961d-2c9111bd9c74")'
# returned the compiler gallery card and headline artifact URL

$ curl -sS -o /tmp/showcase-p3-acceptance.mp4 \
    'http://127.0.0.1:4174/artifacts/jobs/3bda5e51-dbd7-4981-961d-2c9111bd9c74/60-render2d/yale-street-23686233753633fd-0/rollout.mp4?token=showcase-p3-acceptance'
$ ffprobe -v error -show_entries format=duration,size -of json \
    /tmp/showcase-p3-acceptance.mp4
{"format":{"duration":"0.333333","size":"29095"}}

$ curl -sS -D - -o /tmp/showcase-p3-index.html \
    'http://127.0.0.1:4175/?token=showcase-p3-acceptance'
HTTP/1.1 200 OK
set-cookie: showcase_token=showcase-p3-acceptance; Path=/; HttpOnly; SameSite=Strict
content-type: text/html; charset=utf-8

$ curl -sS -o /dev/null -w 'asset_http=%{http_code}\n' \
    -H 'Cookie: showcase_token=showcase-p3-acceptance' \
    'http://127.0.0.1:4175/assets/index-CotKFEUW.js'
asset_http=200
```

Measured stage times were author 43.764 s, site match 3.448 s, batch/cell copy 26.161 s, frozen gate
0.065 s, and 2D render 0.725 s. The one sampled cell was honestly rejected by the frozen gate
(`passed=0/1`), so the gallery card says `admitted:false`; the job itself nevertheless completed
the required brief-to-gallery pipeline and serves a valid MP4. Judge and 3D were explicitly
disabled in this acceptance request and their stages were recorded as skipped, not claimed as run.

The first real submission exposed that the frozen compiler expects `brief.id`; it terminated at
`20-author` with a recorded `job-error.json`. P3 added the missing ID to normalized submissions and
backward-compatible restart hydration, then reran the complete successful job above. No result from
the failed attempt is represented as successful evidence.

## Lead acceptance — owner-facing browser flow, 2D + real 3D + judge

After all five packets landed, the lead built the web bundle, started the actual production server,
opened it in Chromium, submitted a job through the UI, and observed every intermediate stage.

```text
SHOWCASE_TOKEN=demo-local SHOWCASE_HOST=127.0.0.1 SHOWCASE_PORT=4174 \
  pnpm --filter @uniscenarios/showcase start

# Browser submission:
# brief: A stopped lead vehicle is revealed beyond a blind crest and the ego brakes hard to avoid it.
# engine=compiler, draws=1, maxSites/map=1, ambient=light, render3d=true, topK=1, judge=true
# Browser UI job id: 32c6c35f-9fa8-4354-b757-cc65399bb6c0
```

The browser exposed stages 00, 10, 15, 20, 30, 40, 50, 60, 65, 70 and 90 independently. After
completion, every stage read `COMPLETE`; the cell grid showed three failures and one frozen-gate pass
across four maps. The gallery record reports:

```json
{
  "engine": "compiler",
  "maps": 4,
  "gate": {"passed": 1, "cells": 4},
  "render3d": true,
  "scores": {"realism": 2.5, "dynamism": 3.0},
  "timingsSeconds": {
    "author": 68.283,
    "simulate": 55.050,
    "gate": 0.097,
    "render2d": 3.753,
    "render3d": 310.372,
    "judge": 100.619
  }
}
```

Artifacts include four 2D rollout videos and one real Studio/Three 3D bundle for the admitted
El Camino cell: three PNG frames, a 2.2 MB H.264 video, matching source instance/trace, preflight,
render manifest, and review JSON. Visual inspection confirmed the authored vehicles, ambient
traffic, multilane road geometry and city assets are visible in the 3D frame. This is a complete,
browser-submitted prompt-to-gallery receipt; unlike the P3 acceptance, neither 3D nor judging was
skipped.

## Post-acceptance correction — product acceptance is not gate admission

The owner correctly rejected a later 3D job that the first UI presented as output. The frozen
physics gate had admitted the trace, but the requested motorcycle/SUV mechanism was not visibly
realized and one vehicle was sunk into a stacked road surface. The old product path made two
incorrect assumptions: a gate pass was sufficient to publish a 3D video, and the lowest sampled
road mesh was always the actor's deck.

The corrected path separates those contracts. Every 3D candidate now receives a brief-aware
multiframe vision review after rendering. Publication requires gate admission plus explicit passes
for requested-mechanism fidelity, actor fidelity, event sequence, visual grounding, plausibility,
realism, confidence, and an empty defect list. Failed candidates remain available under Pipeline
details but never appear in the accepted-video gallery. The pipeline renders and reviews up to
`3 × topK` gate-passing candidates, preserving each defect report, and publishes at most `topK`
review-passing alternatives. The known broken Belmont candidate was re-reviewed and rejected with
`mechanismFidelity=no`, `visualGrounding=fail`, `eventSequence=fail`, and `accepted=false`.

The 3D exporter now queries all road surfaces under every actor and prop. It accepts coincident
triangles, uses the verified surface height, and fails closed when vertically separated decks make
the planar simulation trace elevation-ambiguous. Re-running the broken Belmont input now terminates
with `stacked road surfaces are elevation-ambiguous (1.077m separation)` rather than emitting a
misgrounded vehicle. This is deliberately a rejection, not a guessed elevation.

Showcase-authored templates are normalized to a minimum `clipSeconds: 20`; longer authored clips
are preserved. Both the 2D and 3D showcase render paths now request full-clip frame plans instead
of the renderers' four-frame/incident-window defaults. A concrete 20-second trace produced exactly
`20.000000` seconds in the 2D renderer and `20.083333` seconds in the real RTX 5080 Studio renderer
at 12 FPS. The accepted-video UI is hidden while a job is running and says explicitly when no
candidate passed 3D product review.

## Semantic repair loop and final acceptance boundary

The authoring path now freezes a request-derived executable contract before generation. For the
motorcycle/SUV request this requires a signalized junction, ego left turn, oncoming motorcycle,
two opposing lanes, SUV-to-motorcycle occlusion, delayed ego stop response, collision freedom, and
a 20-second clip. Description text is not evidence: a template that omits any executable field is
rejected before simulation. Vista2 receives the contract on every attempt, and each failed
contract or frozen-gate result is fed into the next attempt. Post-render 3D defects are converted
into a repair brief and run through the same pipeline once; failed original and repair artifacts
remain inspectable.

A deterministic specialization of the proven signalized-LTAP recipe handles this exact contract
without spending three visual-author attempts first. It uses two independently solved conflicting
gate roles (SUV and motorcycle), because the earlier relative-role experiment projected a
post-solved conflicting actor onto the wrong route. The clean implementation added lateral
`tFrac` to `conflicting_gate` itself. The final recipe keeps the motorcycle at `tFrac=0.45`
(the measured safe lane-boundary limit), uses a separate SUV arrival, starts the ego response at
4.8 seconds, and holds a real frozen-gate pass under the production light-ambient configuration.

The product boundary found two additional systematic defects:

1. The 3D exporter required `revealToConflict.pair`, but a valid trace may carry the proved pair
   only in `declaredOcclusion`. It now accepts that evidence source and still fails closed unless
   the pair names exactly two input actors.
2. The product reviewer previously sent the conflict frame first, followed by pre-event, reveal,
   and aftermath. It now sends the four named frames chronologically and includes trace-grounded
   actor identities, frame times, trigger events, collisions, and ego line-of-sight results. The
   metadata clarifies that the incident camera is not the driver's eye point; it does not override
   visible grounding or plausibility failures. This is review contract
   `showcase-3d-product-review-v2`.

The corrected motorcycle run is an honest negative at the final boundary. One production cell
passes all six frozen rules (`C1` through `C6`), renders successfully in the real Studio renderer,
and visibly grounds the ego, SUV, and moving motorcycle. Product review still rejects it because
the requested dense two-lane oncoming stream and surrounding-driver reactions are not visually
established. Therefore the gallery publishes **zero accepted videos** for that request. This is
the intended outcome: the old UI's apparent success was a frozen-gate result, not an end-to-end
product acceptance.

## Production methodology integration

The website now has two explicit modes. `production` is server-owned: client attempts to weaken
the configuration are ignored. It routes structurally hostable standard mechanisms to the
compiler, routes structural gaps to Vista2, uses `gpt-5.6-sol/low` for authoring, samples all five
maps with three sites and three deterministic draws under light ambient traffic, applies the
unchanged C1–C6 gate, uses the `gpt-5.6-sol/medium` spread-8 footage judge, ranks candidates with
site diversity, and requires brief-aware 3D product acceptance. `custom` retains the old controls
for debugging and ablations. The three-by-three sampling envelope is an online operational budget,
not a claim that the website reruns the frozen 50-brief research experiment on every submission.

The compiler and visual lanes are now a real union rather than a one-shot router. A compiler
template that violates the request-derived executable contract is preserved under
`20-author/compiler-rejected` and immediately escalates to Vista2. If a compiler-authored product
survives the semantic contract but fails final review, the same escalation occurs after review.
A rejected Vista2 product receives one evidence-driven Vista2 repair. The repair route is forced to
Vista2; an end-to-end run exposed and fixed a bug where the nested `auto` route had silently sent
that repair back through the compiler.

Rendering now begins only after the gate and only for admitted cells. This preserves the research
ordering and avoids spending footage and 3D work on known gate failures. The route artifact records
the production profile, model/effort choices, fallback policy, rejected compiler failures, and
fallback artifacts. The browser displays the methodology on both submission and job pages and
keeps every rejection available in the stage and cell drilldown.

Production job `4a93f3f4-d78a-4bb3-bc73-df2b5df1257f` exercised the full path in the real service:
compiler contract rejection, Vista2 fallback, 21 simulated cells, 3 frozen-gate admissions,
footage judging, 3D attempts, defect feedback, forced Vista2 repair, 21 repaired cells, 13 repaired
admissions, and final product rejection. The UI showed all 11 stages complete and zero accepted
videos. This remains an honest negative: gate yield improved, but the footage did not establish
the requested lead-braking sequence strongly enough.

That run also found a production-only 3D mismatch. The CLI always passed `--all-authored`, which
made the product camera frame irrelevant authored actors in addition to the incident pair; all
three first-pass 3D candidates failed composition before review. The render command now exposes
`--composition all-authored|incident`. Corpus exports keep the conservative all-authored default;
the brief-driven product pipeline requests incident composition. Re-rendering the previously
failing El Camino cell with the production command completed successfully: deterministic real-map
Studio output, 241 H.264 frames at 12 FPS, and a machine-passed manifest. The independent product
review still rejected the footage (`mechanismFidelity=no`, `visualGrounding=pass`,
`eventSequence=fail`, realism `3.0`), which confirms that the fix restores reviewability without
weakening acceptance.

The no-brief emergent harvest remains a separate batch corpus-replenishment lane. It is not
misrepresented as an interactive prompt feature: the measured full harvest costs about 24 core
hours and its promoted scenarios are site-pinned rather than portable. Production request handling
uses the compiler/visual union; scheduled corpus refresh should continue to use the existing
pre-registered harvest commands and publish only frozen-gate and product-review survivors.
