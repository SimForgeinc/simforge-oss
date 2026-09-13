# tg-rethink landing report

## Result

- Target branch: `e2e/tg-rethink-land`
- Base: `e2e/night-run` at `7ee40d11`
- Source: `origin/tg-rethink` at `77a99c03636564d4de087896cf3e6f7a7085afc4`
- Strategy: targeted port after an attempted full merge exposed broad conflicts with retired and renamed infrastructure.
- Landed diff: 844 files, 346,983 insertions, 288 deletions before this report.

The landed program includes the showcase service and web UI, campaign definitions, the 600-scenario AV catalog, showcase/gallery seed data, authoring and gate tools, the Vista/research tooling, research corpus and reports, the semantic review contract, trace validity support, and the deterministic 2D trace renderer.

## Recon

Commands were run only in this isolated worktree.

```text
$ git log --oneline main..origin/tg-rethink | wc -l
219

$ git merge-base main origin/tg-rethink
9e8cf17bfb05ed1b28f0bcefa04355240273ad70

$ git diff --stat main...origin/tg-rethink
785 files changed, 355307 insertions(+), 1655 deletions(-)

$ git rev-parse origin/tg-rethink
77a99c03636564d4de087896cf3e6f7a7085afc4
```

The requested local name `tg-rethink` was not present; the verified remote-tracking ref `origin/tg-rethink` points at the required tip.

The source tip's catalog was verified directly:

```text
$ jq '{declared:.counts.total,actual:(.scenarios|length),first:.scenarios[0].id,last:.scenarios[-1].id}' tools/research/av-scenario-corpus-500.json
{
  "declared": 600,
  "actual": 600,
  "first": "S001",
  "last": "S600"
}
```

## Merge attempt and conflict triage

`git merge --no-commit origin/tg-rethink` was attempted and then aborted cleanly. The conflict set crossed the exact infrastructure retired or renamed on the consolidated line:

- CLI: `packages/cli/package.json`, tests, batch workers, batch/catalog commands, `index.ts`, and `main.ts`.
- Renamed packages: source additions under `packages/scenario-materializer` and `packages/sim-engine` collided with the consolidated `packages/compiler` and `packages/engine` locations.
- Engine/compiler/schema: actor agreement tests, `prop-dims.ts`, hash/engine/motion code, OpenSCENARIO export, scenario schemas, and structural definitions.
- Retired surfaces: deleted Studio campaign/variation files, `packages/anchor-matcher`, old sim-engine tests, and old render/migration tests.
- Renderer/map infrastructure: viewer, map derivative scripts, review-ledger script, and the workspace lockfile.
- Root/workspace: `.gitignore`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`.

A full merge would have reintroduced deleted package names and mixed old CLI/renderer infrastructure into the consolidated stack. Following the requested preference rules, it was abandoned in favor of a targeted port of showcase/corpus-owned paths:

```text
apps/showcase/**
config/showcase-review-contract.json
packages/trace-render/**
research/edge-case-corpus/**
showcase-data/**
tools/gates/**
tools/research/**
tools/tg-research/**
scripts/trace-validity-lib.mjs
```

Adaptations made for the consolidated tree:

- Renamed runtime packages to `@simforge-oss/showcase` and `@simforge-oss/trace-render`.
- Replaced executable references to `packages/cli/bin/uniscenarios.js` with `packages/cli/bin/simforge.js`.
- Removed one machine-specific path from the deterministic work-zone rederivation tool.
- Registered `apps/showcase/web` as a workspace package.
- Added the `simforge-trace-render` executable to the trace-render package.
- Routed pipeline tier-2D rendering through the landed trace-render package instead of the retired positional CLI render surface; `SCEN_DEV_ASSETS` is honored, with `<repo>/dev-assets` as fallback.

## Builds

All scoped package builds succeeded after the port:

```text
$ pnpm --filter @simforge-oss/showcase build
$ node --check server/index.mjs && node --check server/pipeline.mjs && node --check server/failures.mjs && node --check server/campaign.mjs

$ pnpm --filter @simforge-oss/trace-render build
$ tsc --noEmit

$ pnpm --filter showcase-web build
$ tsc -b && vite build
vite v6.4.3 building for production...
✓ 9 modules transformed.
dist/index.html                  0.45 kB │ gzip:  0.29 kB
dist/assets/index-arm3K2nh.css  17.86 kB │ gzip:  4.69 kB
dist/assets/index-D1DDFyAw.js   54.35 kB │ gzip: 18.43 kB
✓ built
```

The consolidated CLI dependency graph was also built successfully with `pnpm --filter @simforge-oss/cli... build` so the current CLI and its renamed package dependencies were present in this isolated worktree. Importing the landed pipeline produced:

```text
{"pipeline":"function","maps":5}
```

## Smoke execution

### 600-corpus stage smoke

The no-LLM structural precheck stage ran end-to-end on catalog scenario `S001` (`Cloudburst Oil-Film Spinout`) from `tools/research/av-scenario-corpus-500.json`:

```text
$ python3 tools/research/showcase/stages.py precheck --brief /tmp/tg-rethink-s001-brief.json \
    | jq '{id,feasible,requires,missing,inventoryFile,implementation}'
{
  "id": "S001",
  "feasible": true,
  "requires": [
    "plain_corridor"
  ],
  "missing": [],
  "inventoryFile": "tools/gates/structure-inventory.json",
  "implementation": "tools/gates/precheck_briefs.py:precheck"
}
```

### Render2D execution proof

The landed tier-2D renderer also rendered one existing corpus instance/trace pair with the same settings used by the showcase pipeline. Files were created at `/tmp/tg-rethink-render2d-smoke/manifest.json`, `/tmp/tg-rethink-render2d-smoke/trace-render.mp4`, and `/tmp/tg-rethink-render2d-smoke/frames/`.

```text
$ node packages/trace-render/bin/trace-render.js \
    --instance research/edge-case-corpus/gold-corpus-v3/c6-dooring/yale-street__67f8fd8fe01ea4d2__draw-007.instance.json \
    --trace research/edge-case-corpus/gold-corpus-v3/c6-dooring/yale-street__67f8fd8fe01ea4d2__draw-007.trace.json.gz \
    --out /tmp/tg-rethink-render2d-smoke --format both --camera follow-ego \
    --fps 12 --full-clip --dev-assets /home/path/simforge-oss/dev-assets
/tmp/tg-rethink-render2d-smoke/manifest.json
```

Manifest summary:

```json
{
  "kind": "trace-render-manifest",
  "scenarioId": "c6-dooring",
  "mapId": "yale-street",
  "actorCount": 3,
  "frameCount": 192,
  "video": {
    "file": "trace-render.mp4",
    "fps": 12,
    "width": 960,
    "height": 600,
    "sha256": "c1650666b1f3dbd792cf8ba2565138079bdc0a202d1587b01528200bc3d35301"
  },
  "underlayLaneCount": 1141
}
```

The frozen gate adapter was additionally executed on that trace. It completed normally and returned a deterministic rejection (`firstFailure: C2`) rather than an operational failure; this is evidence that the stage ran, not a claim that this historical cell passes the current gate.

## Known gaps and intentionally deferred work

- The tier-3D branch still describes the historical trace-oriented renderer invocation. The consolidated CLI now exposes immutable `render run <intent> --engine ... --inputs ...`; converting old instance/trace evidence into that contract belongs with renderer unification. Tier-2D is adapted and smoked here.
- LLM author/judge stages require the local OpenAI-compatible gateway at `127.0.0.1:4141` and the Python environment expected by the research tools. No LLM call was needed for the deterministic smoke.
- Historical campaign map IDs are retained because the corpus and recorded evidence use them. Compatibility map directories exist for the five-map corpus on this workstation; canonical current registry names remain owned by consolidated map infrastructure.
- The omniscient-ego bug, child actor behavior, provenance gate, and judge ensemble were not changed, per the assignment.
- Research documents intentionally preserve historical `UniScenarios` names when quoting old commands, package paths, or findings. Executable/runtime references used by the landed program were migrated to SimForge names.
