# SHOWCASE PLAN — end-to-end demo website + built-in rendering (v1, 2026-08-17)

Owner asks: a temporary website where they can (1) browse a gallery of generated scenarios, (2) submit
their own edge-case prompt, (3) set counts/locations/options, (4) watch renders (including 3D) and
videos appear, and (5) inspect the intermediate output of EVERY pipeline stage. Additionally:
**rendering — including 3D with all actors — must be a built-in capability of the UniScenarios repo
(a first-class CLI command), not ad-hoc scripts.** Implementation workforce: **gpt-5.6-sol / medium
agents** (Codex pool, owner directive), coordinated by this lead.

Everything below composes from parts that already exist and were measured this week. No speculative
components.

## 0. Verified feasibility facts (checked on this machine, 2026-08-17)

- All five maps have full 3D bundles in `dev-assets/<map>/3d/` (629M/2.1G/1.5G/118M/586M manifests OK).
- `google-chrome` + `Xvfb` installed; no X display (headless box) — 3D path needs Xvfb+GPU
  qualification (`verify-city-renderer.mjs` warns headless SwiftShader lies; we must qualify real
  NVIDIA GL under Xvfb, else fall back).
- 2D pipeline fully working: `render-trace.mjs` with map underlay/glyphs/follow-cam, 0.34–0.78 s/cell.
- 3D exporter exists: `scripts/export-render.mjs` (Playwright → Studio/Three → 4 PNGs + H.264 MP4),
  consumes instance+trace+result.
- Generation engines ready: compiler (`author_llm.py`, ~47 s/admitted archetype), vista2 harness
  (~5–7 min/brief warm), light-ambient flag, frozen gate, calibrated footage judge (sol/medium).
- RTX 5080, 24 cores, gateway on :4141, Tailscale reachable.

## 1. Architecture (deliberately small)

```
browser (owner, via Tailscale)
   │ token auth (single shared token, temporary site)
   ▼
showcase server  — one Bun/Node process, apps/showcase/  (NEW, ~600 lines)
   │  REST + SSE: POST /api/jobs, GET /api/jobs/:id (SSE progress), GET /api/gallery, static /artifacts
   ▼
job runner — one queue, one directory per job: showcase-data/jobs/<jobId>/
   stages (each writes stage.json + artifacts BEFORE the next starts — this IS the
   "intermediate outputs" requirement, the UI just renders the directory):
   00-brief.json          the prompt + options as submitted
   10-route.json          engine choice: compiler | vista2 (+why: category heuristic, precheck result)
   15-precheck.json       map-feasibility verdict per structure clause (existing precheck logic)
   20-author/             template.json + authoring transcript (compiler decision JSON or vista2
                          action log with its per-action PNGs — the owner can watch the agent think)
   30-sites.json          matched sites per map (uniscenarios sites match), incl. rejected + why
   40-cells/<cellId>/     instance.json, trace.json.gz, meta.json  (uniscenarios batch, N×M×draws)
   50-gate.json           frozen-gate verdict per cell, per-criterion first failures
   60-render2d/<cellId>/  stills + rollout.mp4 (built-in renderer, always)
   65-render3d/<cellId>/  4 phase PNGs + incident MP4 (qualified 3D tier, top-K gate-passing cells)
   70-judge.json          footage-judge verdicts (sol/medium, vision-asserted) per rendered cell
   90-gallery.json        summary card: headline render, scores, admit/reject, timings per stage
```

- **Job options** (the owner's knobs, all plumbed to existing flags): brief text; engine
  (auto/compiler/vista2); nScenarios (draws); maps[] (which of the 5); maxSites/map; ambient
  off|light|moderate|city|heavy; seed; 3D on/off + topK; judge on/off.
- **Gallery** = flat scan of `90-gallery.json` files + the week's existing corpus roots
  (best-of cells from W7 regen, emergent harvest, vista main — pre-seeded so the gallery isn't empty
  on first visit).
- **No database.** The filesystem is the state; jobs are resumable by re-reading stage files. SSE
  streams stage completions. Delete the directory = delete the job. Temporary site, boring tech.

## 2. Repo work item R1 — `uniscenarios render` (built-in, owner directive)

New CLI command in `packages/cli` (this is permanent repo capability, not showcase glue):

```
uniscenarios render <trace.json.gz> --instance <instance.json> [--out DIR]
    --tier 2d|3d|both        (default 2d)
    --format stills|video|both
    --camera follow-ego|overview|site   --fps 12   --redact
    --3d-url <studio url>    (default: auto-start ephemeral studio server)
```

- **2d tier**: promote `scripts/render-trace.mjs` internals into a proper workspace package
  (`packages/trace-render`), CLI imports it. Behavior byte-identical to the current script (tests
  pin this); the script becomes a thin wrapper.
- **3d tier**: promote `scripts/export-render.mjs` orchestration into the CLI: auto-start a vite
  studio server if none given, Playwright-drive it, capture 4 phase PNGs + MP4 **with every actor,
  prop, closure and signal state drawn from the trace** (that is what the Studio playback path
  already does; the work is packaging, determinism, and lifecycle, not new rendering).
- **Qualification gate Q3D** (before the 3d tier is claimed working): Xvfb + google-chrome with
  real NVIDIA GL on this box, `verify-city-renderer.mjs` must report GPU rasterization (not
  SwiftShader), and one known trace must render with actors visible in all 4 phases. If Q3D fails
  after honest effort: 3D tier ships behind `--experimental` with the failure documented, showcase
  falls back to 2D everywhere, and the gap is reported — not papered over.
- Tests: render determinism (SVG/PNG hashes), instance/trace hash validation refuses mismatched
  pairs (exists), CLI arg surface typechecked, one E2E smoke per tier.

## 3. Stage engines (all existing, wrapped)

| stage | implementation | measured cost |
|---|---|---|
| route | trivial classifier: compiler families keyword map (from author_llm) else vista2; precheck first | ~1 s |
| author/compiler | `author_llm.py` single-brief mode (sol/medium per owner preference for new work; luna/medium remains the frozen-baseline config) | ~1–2 min |
| author/vista2 | `tools/research/vista2/` episode with mature GUIDE.md seeded | ~5–15 min |
| simulate | `uniscenarios batch` with ambient flag | ~0.05–2 s/cell |
| gate | `tg_gate.py` (frozen, untouched) | ~3 ms/cell |
| render 2d | R1 CLI, follow-ego + redact for judge, unredacted for gallery | ~0.5 s/cell |
| render 3d | R1 CLI 3d tier, top-K gate-passing cells (default K=3) | ~1–2 min/cell (to be measured in Q3D) |
| judge | FootageLane `judge.py` sol/medium spread8 | ~14 s/cell |

UI shows each stage as a card: status, wall time, and a "raw output" expander (the stage JSON,
the authoring transcript, per-criterion gate table, judge verdict text). Vista2 jobs additionally
show the action-by-action PNG filmstrip — the owner explicitly wants to see the process think.

## 4. Frontend (one page app, no framework ceremony)

- `apps/showcase/` Vite + preact (or plain lit-html) — NOT a fork of Studio; Studio stays untouched
  except being started headlessly for the 3d tier.
- Views: **Gallery** (grid of cards: headline MP4 loop, brief, scores, engine badge, map chips) ·
  **Job detail** (stage timeline with intermediate artifacts, cell grid with per-cell gate/judge
  chips, video player) · **Submit** (prompt box + knobs listed in §1) · live progress via SSE.
- Auth: `?token=` checked by middleware; bind 0.0.0.0, reachable via Tailscale (path-pc address in
  AGENTS.md). Temporary site: no users, no persistence beyond the data dir.

## 5. Implementation plan — gpt-5.6-sol/medium agents (owner directive)

Lead (me) owns contracts and review; implementation is delegated to **Codex CLI agents pinned to
gpt-5.6-sol, reasoning medium**, run as hub-managed processes (`codex exec` non-interactive, one
per work packet, gateway credentials). Fable agents are used only where a packet needs repo-wide
judgment (review/integration), per the owner's model split.

Work packets (parallel where independent):
- **P1 `packages/trace-render` + CLI `render` 2d tier** (R1a) — promote script → package, tests.
- **P2 CLI `render` 3d tier + Q3D qualification** (R1b) — Xvfb/GPU qualification FIRST, then packaging.
- **P3 showcase server + job runner** — stages, SSE, artifact layout above.
- **P4 showcase frontend** — gallery/job/submit views against P3's API (API contract frozen in this
  file before P3/P4 start).
- **P5 pipeline glue** — single-brief author entrypoints (compiler + vista2), judge wrapper, gallery
  pre-seed from this week's corpus roots.
- Integration + review: lead + one Fable reviewer pass; smoke: owner-style E2E (submit prompt →
  watch stages → see 2D video; 3D if Q3D passed) before handover.

API contract (frozen now): `POST /api/jobs {brief, engine?, nScenarios?, maps?, maxSitesPerMap?,
ambient?, seed?, render3d?, topK?, judge?}` → `{jobId}` · `GET /api/jobs/:id` → SSE of
`{stage, status, artifacts[]}` · `GET /api/jobs/:id/full` → job dir index JSON · `GET /api/gallery`
→ card list · `GET /artifacts/<path>` → static files. Stage names and file layout as in §1.

## 6. Order, risks, honesty

1. P1+P3 first (2D end-to-end is the demo's spine; guaranteed to work). P2 in parallel (risk item).
2. Q3D is the only real unknown: NVIDIA GL under Xvfb on this driver. Mitigation documented in §2;
   2D-only demo is still a complete demo of the pipeline with videos.
3. Vista2 jobs are slow (~5–15 min) — the UI must say so up front and stream the filmstrip live so
   waiting is watchable; compiler jobs give first videos in ~2–3 min.
4. Nothing in the showcase touches the frozen gate, the rubrics, or the measured reports.
5. Disk: showcase-data on the 915G volume, per-job traces pruned to gate-passing + rendered cells
   after judge stage (raw fails keep gate.json only). ~45 GB free — enforce a per-job cap.
