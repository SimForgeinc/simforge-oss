# Document pinning

A scenario document pins everything that decides its simulation. The same
document on the same pinned map, catalog and engine semantics always simulates
to the same trace. Renames, saves and map republishes don't change that.

## What is pinned, and where

| Pin | Where it lives | Set when | Changes only by |
|---|---|---|---|
| Seed | `simulation.seed` in the document (ScenarioTemplateV2) | creation, or the one-time pin | an explicit edit of the block |
| Step | `simulation.dtS`, always `0.02` | creation, or the one-time pin | never. Any other value is a validation error |
| Map version | `drafts.map_version_id` | creation | an explicit re-pin (`updateDocument({ mapVersionId })`) |
| Map closure digest | `drafts.map_closure_sha256` | creation, re-pin, or migration backfill | an explicit re-pin |
| Asset catalog | `drafts.asset_catalog_version_id` | creation, re-pin, or migration backfill | an explicit re-pin |
| Ambient traffic | `extensions["studio.ambientTraffic.profile.v1"]` | the author, or the one-time pin | an explicit edit |

A revision freezes the draft's pins as they are: `revisions.map_version_id`,
`map_closure_sha256` and `asset_catalog_version_id`.

### Seed

- The compiler's per-cell seed is
  `sha256(seedIdentity|paramsVersion|siteId|drawIndex)`.
- `seedIdentity` is `simulation.seed` when the document has the block.
- Documents written before pinning have no block. For them, `seedIdentity` is
  the template id: `anchor.id`, falling back to `meta.name`
  (`ScenarioTemplate::seed_identity`).
- The one-time pin writes exactly that template id as the seed. Pinning
  therefore changes no simulation, and a later rename no longer changes one.
- The render seed now derives from `simulation.seed`. Unpinned revisions keep
  the old derivation, the first 32 bits of `content_sha256`, which changed on
  every save.

### Step

`dt = 0.02 s` is the only step SimForge executes. All of these reject any
other value:

- the document literal;
- the core input validation (`SimScenarioInput.dt`, both Rust and TypeScript);
- the legacy editor's `fixed_delta_seconds`.

Renderers sample the timeline and never assume their own step.

### Map version, closure and catalog

- A draft stays on the immutable map version it was pinned to.
- Resolution is exact (`resolveScenarioMap`).
- Suppose the pinned version is no longer installed, but a newer publication
  of the same source with identical OpenDRIVE is. Resolution then fails with
  `scenario_map_version_superseded`, naming that publication. The editor offers
  it as an explicit "Move to the newer map version" action.
- A revision commit never re-resolves. It verifies that the pinned version is
  still published (`scenario_map_version_unavailable`) with the pinned closure
  and catalog (`scenario_map_pin_mismatch`).

### Ambient traffic

- For documents with a `simulation` block, a missing profile means `off`. New
  documents therefore get no generated traffic unless the author adds some.
- Documents without the block keep the legacy default, City with seed
  `ambient-1`. Immutable old revisions resolve as they always did.
- The one-time pin writes that legacy default explicitly into every draft that
  names no profile. Their traffic doesn't change.
- A malformed profile is a validation error:
  - The document write boundary refuses it.
  - Simulation paths throw `AmbientTrafficProfileError`.
  - Only editor panels display it as `off`, so the author can fix it.
  - It is never silently replaced with City.

## The one-time pin

1. Migration `20260922150000_scenario_document_pinning.sql` does two things:
   - it adds the pin columns;
   - it backfills each draft's closure digest and catalog from the version the
     draft is bound to.
2. `studio/scripts/pin-scenario-documents.ts` pins the content itself:
   - It adds the `simulation` block and writes the legacy ambient profile where
     it is absent.
   - It recomputes `content_sha256` and bumps `draft_version`, so open editors
     refetch the pinned content.
   - It is idempotent. It has a dry-run mode (the default) and `--apply`.
   - It never touches revisions.
   - It leaves drafts with a malformed profile unpinned and lists them.

   Run it only once servers and compilers that understand the `simulation`
   block are deployed. Older code rejects the block as an unknown key.

## Cache keys

`simContentHash` (`@simforge-oss/scenario`) covers the document's
simulation-relevant content. That includes `simulation` and the ambient
profile. It excludes the name only once `simulation.seed` is pinned.

The map and catalog pins live in DB columns, not in the document. A cache key
therefore takes them through `mapClosureDigest` / `catalogDigest`, not through
`simContentHash`.
