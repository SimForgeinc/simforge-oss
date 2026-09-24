# Scenario Package (`simforge.scenario-package/v1`)

Status: proposed 2026-09-22 (playability phase 2); container, manifest and
verifier **implemented** 2026-09-24 in the `simforge-package` Rust crate
(SDK split track P), with the thin/full dedupe rules and the `producer`
field resolved in section 8.1 and section 4.3. Builds on phase 1: replay by
default (`motionSource`), timelines keyed by `timelineKey`, the trace
upgrader chain, exact map resolution on JSON import, and the archive corpus.
This page does not re-specify any of those.

A Scenario Package is the one self-contained, verifiable form of an authored
scenario revision: the document, the motion it was simulated to, and every
digest needed to replay that motion on any later release, on this
installation or another one.

| Piece | Where |
|---|---|
| Manifest types, canonical encoding, strict ZIP reader and writer, verifier | `native/crates/simforge-package` (Rust; the one implementation) |
| JSON Schema | `contracts/scenario-package/manifest.v1.schema.json`, `receipt.v1.schema.json` |
| Fixtures | `fixtures/scenario-package/` (valid packages and one hostile package per rule, with `expectations.json`) |
| Node (hosted exporter) | `simforge-bindings-node` `scenarioPackage*` functions, wrapped by `@simforge-oss/native-runtime` (`writeScenarioPackage`, `verifyScenarioPackage`, ...): byte-identical to the CLI's containers |
| CLI | `simforge package inspect \| verify \| import` (Rust `simforge` CLI, over the crate) |
| Studio routes (proposed) | `POST /api/simforge/revisions/:id/package` (export), `POST /api/simforge/packages` (import) |
| Tables (proposed) | `simforge.scenario_packages`, new `origin` values on `sim_results` / `revision_simulations` |
| Tests | the crate's `tests/` (fixtures, archive-corpus round trips, schema agreement), `native-runtime` `scenario-package.test.ts` (binding byte identity); later `fixtures/archive-corpus/<release>/packages/` |

## 1. What a package promises

1. **Replay, not re-simulation.** Importing a package binds a new revision to
   the package's own trace. Renders replay it (`motionSource: original`)
   under any later engine, as long as the reader's upgrader chain covers the
   trace format.
2. **Nothing is re-bound by name.** The map is identified by map version id,
   OpenDRIVE sha256 and closure digests. The actors are identified by catalog
   and actor-closure digests. A missing piece fails loudly. It is never
   substituted.
3. **Every byte is verified.** The package id is the sha256 of its manifest,
   and the manifest holds the sha256 and size of every member. A package
   either verifies completely or is refused.
4. **Pixels are a separate, opt-in promise.** The default guarantee is
   identical poses (render-timeline.md section 8). "Reproduce exactly"
   (section 6) adds a pinned renderer and holds per GPU model only.

Out of scope: OpenSCENARIO import (removed; see openscenario-conformance.md),
dataset packaging, and multi-revision bundles. A dataset export can later be
a list of package ids.

## 2. Identity

```
manifestBytes = canonicalJson(manifest)            // simforge.canonical-json/v1
packageId     = sha256(manifestBytes)               // lowercase hex, 64 chars
```

- `manifest.json` in the container holds exactly `manifestBytes`. A reader
  parses it, re-serialises it canonically and refuses the package if the
  bytes differ (`package_manifest_not_canonical`). So the sha256 of the
  member is the package id, as `timelineSha256` is for timelines.
- The id covers the **logical content**: document, simulation, timeline,
  map, catalog, and the optional render pin. It does not cover the container
  encoding, which blobs are embedded, or who exported it when.
- **Thin and full forms of one revision share one `packageId`.** The form is
  a property of the container (which `blobs/` members are present), not of
  the manifest. A full package is a thin package plus embedded blobs.
- Exporting the same revision twice from the same installation gives the same
  `packageId`. The export event is recorded in `receipt.json`, which is
  outside the identity (section 3.3).
- Display form: `pkg_<first 12 hex>`. Filename:
  `<title-slug>.<first 12 hex>.scenario.zip`. Media type:
  `application/vnd.simforge.scenario-package+zip`.

## 3. Container

### 3.1 Choice: ZIP, strict subset

We use ZIP, not tar.

| Need | ZIP | tar (+gzip/zstd) |
|---|---|---|
| Read and verify the manifest before touching members | Central directory: seek to the end, read the index, read `manifest.json` | Only if the manifest is first. Anything else needs a full sequential scan |
| Skip members the installation already has (dedupe) | Random access per member. A full package whose map is already installed reads a few MB of a 1 GB file | The whole compressed stream must be decompressed to reach later members |
| Per-member compression (store `.gz`/`.ktx2`, deflate JSON/XODR) | Native, per entry | One stream for everything, so already-compressed blobs are compressed again |
| Bomb control | The declared size per member is checked against the manifest before inflating | Only on the stream as a whole |
| Users can inspect it | Opens natively on every desktop OS | Needs tooling on Windows |
| Browser import | Small, audited readers, and range reads through `File.slice` | Streaming only |

ZIP's known weaknesses (two headers per entry, zip-slip, overlapping entries)
are closed by the strict reading rules in section 10. The writer emits only
the subset that the reader accepts.

### 3.2 Deterministic encoding

The writer emits:

- **Member order:** `manifest.json` first, then `receipt.json`, then the fixed
  role order of section 4.1, then `blobs/` sorted by path (bytewise).
- **Timestamps:** every entry has DOS time `1980-01-01 00:00:00`. There are
  no extended-timestamp (`0x5455`), Unix (`0x7875`) or NTFS extra fields.
- **Attributes:** "version made by" is Unix. External attributes are
  `0100644 << 16`. There are no directory entries, symlinks or comments.
- **Flags:** bit 11 (UTF-8) is set, although all names are ASCII. Bit 3 (data
  descriptor) is never set: CRC and sizes are in the local header. There is
  no encryption.
- **Method:** STORE (0) for media types that are already compressed (`*+gzip`,
  `.gz`, `.ktx2`, `.png`, `.jpg`, `.webp`, `.zst`). DEFLATE (8) at level 6
  for everything else.
- **ZIP64:** only when the archive needs it (a member or the archive is over
  4 GiB, or there are more than 65,535 entries). The rule is fixed, so the
  same content always takes the same branch.

For one exporter release, the same content gives the same container bytes.
Across releases the DEFLATE output may differ. That is harmless, because
identity is the manifest digest, never the container bytes. A server may
cache container bytes keyed by `(packageId, form, texture tier, exporter
release)`.

### 3.3 Layout

```
manifest.json                         canonical manifest; sha256 = packageId
receipt.json                          export event (outside the identity; display only)
document.json                         canonical ScenarioTemplate content of the revision
simulation/trace.json.gz              the stored trace object, byte for byte
simulation/resolution.json.gz         simforge.sim-resolution/v1, byte for byte
simulation/materialized-traffic.json  when the result has a traffic artifact
timeline/<timelineSha256>.json        the render timeline(s), canonical JSON
map/closure.json                      the map version's browser closure listing
actors/closure.json                   the actor-assets closure document
catalog/entries.json                  the gallery catalog entries the request key hashed
export/scenario.xosc                  optional: the derived OpenSCENARIO 1.4 export
render/pin.json                       reproduce-exactly only (section 6)
blobs/sha256/<aa>/<sha256>            full form only: closure members, content-addressed
```

- Every name matches the allowlist in section 10. None is derived from user
  text (titles, map labels, catalog ids).
- Map blobs and actor blobs share `blobs/`. A blob that appears in both
  closures is stored once.
- `receipt.json` is `{schema: "simforge.scenario-package-receipt/v1",
  packageId, form, exportedAt, exporterRelease, textureTier?,
  embeddedBlobs: {count, bytes}}`. It is not covered by any digest. The
  importer shows it and never makes a decision from it.

## 4. Manifest (`simforge.scenario-package/v1`)

### 4.1 Members

`manifest.members` is sorted by `path`. It lists every member except
`manifest.json`, `receipt.json` and `blobs/`. Blobs are listed by the two
closure documents, and those documents are themselves members.

| `path` | `role` | Required | `mediaType` | Extra identity check on import |
|---|---|---|---|---|
| `document.json` | `document` | yes | `application/vnd.simforge.scenario+json` | canonical; `sha256 = scenario.contentSha256` |
| `simulation/trace.json.gz` | `trace` | yes | `application/vnd.simforge.trace+json+gzip` | `sha256 = simulation.traceGzipSha256`; decoded canonical digest `= simulation.traceSha256` |
| `simulation/resolution.json.gz` | `resolution` | yes | `application/vnd.simforge.sim-resolution+json+gzip` | `sha256 = simulation.resolutionSha256` |
| `simulation/materialized-traffic.json` | `traffic` | when present | `application/vnd.uniscenarios.materialized-traffic+json` | `sha256 = simulation.trafficSha256` |
| `timeline/<sha>.json` | `timeline` | at least one | `application/vnd.simforge.render-timeline+json` | `sha256 = <sha>`; its `identity.timelineKey` is listed in `timelines[]` |
| `map/closure.json` | `map-closure` | yes | `application/vnd.simforge.browser-asset-set+json` | `sha256(canonicalJson) = map.browserClosureSha256`; pin digest recomputes to `map.pinClosureSha256` |
| `actors/closure.json` | `actor-closure` | yes | `application/vnd.simforge.actor-assets-closure+json` | `sha256 = catalog.actorClosureDigest` |
| `catalog/entries.json` | `catalog` | yes | `application/json` | canonical; `sha256 = catalog.catalogSha256` |
| `export/scenario.xosc` | `xosc` | no | `application/xml` | informational; never a render input |
| `render/pin.json` | `render-pin` | reproduce-exactly | `application/vnd.simforge.render-pin+json` | section 6 |

Each entry is `{path, role, sha256, size, mediaType, schema?}`. `size` is the
member's byte length after ZIP decoding. `schema` is the member's own
contract string where it has one (for example `simforge.sim-resolution/v1`).

### 4.2 Example

```jsonc
{
  "schema": "simforge.scenario-package/v1",
  "producer": { "app": "simcloud", "appVersion": "0.2.0", "minCli": "0.2.0" },
  "scenario": {
    "title": "Unprotected left, opposing sedan",
    "documentSchema": "simforge.scenario.v2", "scenarioVersion": 2,
    "contentSha256": "…", "simContentSha256": "…",
    "origin": { "documentId": "…", "revisionId": "…", "revisionNumber": 7, "committedAt": "2026-09-21T18:02:11Z" }
  },
  "engine": {
    "engineSemVer": "0.9.0", "solverVersion": "0.9.0", "pipelineRevision": 2,
    "build": { "engineVersion": "0.9.0", "abiVersion": 3, "buildDigest": "…", "addonSha256": "…", "sourceRevision": "…" },
    "release": "0.1.0-rc.73"
  },
  "simulation": {
    "simKey": "…", "traceFormat": 4, "traceSchema": "simforge.trace/v4",
    "traceSha256": "…", "traceGzipSha256": "…", "authoredTraceSha256": "…",
    "resolvedInputDigest": "…", "resolutionSha256": "…",
    "trafficProvider": "native", "trafficStepKey": null, "trafficSha256": null,
    "sumo": null, "groundDigest": null,
    "producerKind": "runner", "simulatedAt": "2026-09-21T18:02:40Z"
  },
  "timelines": [
    { "version": "simforge.render-timeline.v1", "samplerVersion": "simforge.timeline-sampler/1",
      "timelineKey": "…", "timelineSha256": "…", "heightFieldDigest": "…", "catalogDigest": null }
  ],
  "executionPackage": { "contract": "uniscenario.execution-package/v1", "xoscSha256": "…" },
  "map": {
    "mapVersionId": "…", "sourceMapId": "el-camino-road", "label": "El Camino Road",
    "xodrSha256": "…", "coordinateSystemSha256": "…",
    "mapClosureDigest": "…", "pinClosureSha256": "…", "browserClosureSha256": "…",
    "heightSourceDigest": "…", "groundDigest": null,
    "closure": { "memberCount": 9412, "bytes": 1161000000 }
  },
  "catalog": {
    "assetCatalogVersionId": "…", "catalogSha256": "…",
    "actorClosureDigest": "…", "actorClosureSchema": "simforge.actor-assets-closure/v1",
    "catalogIds": ["sedan-generic", "pedestrian-adult-01"],
    "referencedActorBlobs": { "count": 14, "bytes": 96000000 }
  },
  "members": [ { "path": "actors/closure.json", "role": "actor-closure", "sha256": "…", "size": 22969, "mediaType": "…" } ],
  "render": null,
  "provenance": { "installationKind": "simcloud", "installationId": "…", "authorDisplayName": null },
  "extensions": {}
}
```

### 4.3 Field table

| Field | Type | Meaning / source |
|---|---|---|
| `schema` | const | `simforge.scenario-package/v1`. The manifest version. |
| `producer.app` | `^[a-z][a-z0-9-]{0,63}$` | The writing application (`simcloud`, `simforge-cli`, ...). Display only. |
| `producer.appVersion` | semver | The writing application's version. Display only. |
| `producer.minCli` | semver | The oldest `simforge` CLI that reads this package. A reader whose version is lower refuses it (`package_version_unsupported`, dimension `cli`, section 5.4). The hosted exporter takes it from a table the release agent bumps only when a contract changes (PLAN section 4.2). |
| `scenario.title` | string ≤ 200 | Display only. Plain text, never interpreted. |
| `scenario.documentSchema`, `scenarioVersion` | string, int | Document contract (`SCENARIO_TEMPLATE_VERSION`, now 2). Drives the document upgrader chain. |
| `scenario.contentSha256` | sha256 | `canonicalJsonSha256(content)`, the revision's `content_sha256`. |
| `scenario.simContentSha256` | sha256 | `simContentHash(content)` (`simforge.sim-content/v1`). |
| `scenario.origin.*` | optional | Source document and revision ids, revision number and commit time. Provenance only. Never looked up on another installation. |
| `engine.engineSemVer` | semver | `ENGINE_SEM_VER` that produced the trace. Shown to the user. **Not** a skew gate (section 5.4). |
| `engine.solverVersion`, `pipelineRevision` | string, int | As in `sim_results.solver_ver` and `SIMULATION_PIPELINE_REVISION`. |
| `engine.build` | object | From `sim_results.engine_build`: exactly the recorded ones of `engineVersion`, `abiVersion`, `buildDigest`, `addonSha256`, `sourceRevision` (absent when not recorded; any other key is refused). Provenance only. |
| `engine.release` | string | The SimForge stack version (`0.1.0-rc.N` or stable) that produced the trace. |
| `simulation.simKey` | sha256 | `simforge.sim-key/v1`. Reused as the memo key on import (section 5.3). |
| `simulation.traceFormat`, `traceSchema` | int, string | `header.traceVersion` and `sim_results.trace_schema`. Drives the trace upgrader chain. |
| `simulation.traceSha256` | sha256 | Canonical trace identity (never the gzip bytes). |
| `simulation.traceGzipSha256` | sha256 | sha256 of the stored `.trace.json.gz` bytes, the member digest. |
| `simulation.authoredTraceSha256` | sha256 | Differs from `traceSha256` only for SUMO documents. |
| `simulation.resolvedInputDigest`, `resolutionSha256` | sha256 | As stored in `sim_results`. |
| `simulation.trafficProvider`, `trafficStepKey`, `trafficSha256`, `sumo` | | `sumo` is `{networkSha256, runtimeVersion, wasmSha256}` or null. |
| `simulation.groundDigest` | sha256 \| null | Trace v5 ground-contact source digest. Required when `traceFormat ≥ 5`, null before. |
| `simulation.producerKind` | enum | `inline`, `runner`, `cli`, `editor`. The raw `producer` string is **not** exported, because it contains host names. |
| `timelines[]` | array ≥ 1 | Every packaged timeline's identity (`render-timeline.md` section 2). The first entry is the one the source's renders used. |
| `executionPackage` | object \| null | Contract and xosc digest when `export/scenario.xosc` is present. |
| `map.mapVersionId` | string | The exact map version. The first lookup key on import. |
| `map.sourceMapId`, `label` | string | Display, and ranking of transfer offers. **Never used to bind.** |
| `map.xodrSha256`, `coordinateSystemSha256` | sha256 | Must equal the trace header's `engineGraphDigest` and the map version row. |
| `map.mapClosureDigest` | sha256 | `simforge.map-closure/v1` (native `MapBundle.closureDigest`), key material in `simKey`. |
| `map.pinClosureSha256` | sha256 | `simforge.map-pin-closure/v1` over the simulation members (document-pinning.md). |
| `map.browserClosureSha256` | sha256 | `uniscenario.browser-asset-set/v1` digest of `map/closure.json`. |
| `map.heightSourceDigest` | sha256 | `heightSource.digest` of the timeline's height source. |
| `map.groundDigest` | sha256 \| null | Trace v5 ground source. Null before v5. |
| `map.closure` | object | Member count and total bytes of the whole browser closure. |
| `catalog.assetCatalogVersionId` | string \| null | The revision's catalog pin. |
| `catalog.catalogSha256` | sha256 | `canonicalJsonSha256(catalogEntries)` from the request key. |
| `catalog.actorClosureDigest` | sha256 | `actors.native-closure` digest (`simforge.actor-assets-closure/v1`). |
| `catalog.catalogIds` | string[] | Catalog ids the timeline's actors and props bind, sorted. They select the actor blobs that a full package embeds. |
| `catalog.referencedActorBlobs` | object | Count and bytes of the closure members those ids reach. |
| `members[]` | array | Section 4.1. |
| `render` | object \| null | Reproduce-exactly pin (section 6). |
| `provenance.installationKind` | enum | `local-studio`, `simcloud`, `cli`. |
| `provenance.installationId` | uuid | A random, opaque id generated once per installation. It contains no host name. |
| `provenance.authorDisplayName` | string \| null | Opt-in at export. No user ids, emails or workspace ids are ever exported. |
| `extensions` | object | The only place for additive fields within v1 (namespaced keys). Readers ignore unknown extensions. |

Everything else is strict. An unknown top-level or nested field is a v1
violation (`package_manifest_invalid`). A field that must be understood
bumps the manifest to v2. An optional field is either present with a value
or absent: `null` where the table does not allow it is refused, not dropped.

Cross-field rules the reader enforces (the JSON Schema cannot express them):
`documentSchema = simforge.scenario.v<scenarioVersion>`;
`traceSchema = simforge.trace/v<traceFormat>`; `simulation.groundDigest`
and `map.groundDigest` are equal, set from trace format 5 and null before;
`members[]` is sorted by path, names every required role, and each
member's `sha256` equals its typed field (`document.json` =
`scenario.contentSha256`, trace = `traceGzipSha256`, resolution =
`resolutionSha256`, traffic = `trafficSha256`, `map/closure.json` =
`browserClosureSha256`, `actors/closure.json` = `actorClosureDigest`,
`catalog/entries.json` = `catalogSha256`, xosc = `executionPackage.xoscSha256`);
`timelines[]` and the `timeline/` members name the same timelines;
`render` is set exactly when `render/pin.json` is a member, and
`render/pin.json` holds `canonicalJson(render)`. Each member's `mediaType`
and `schema` are fixed by its role (section 4.1).

## 5. Import

### 5.1 Pipeline

```
open container ─► structural checks (section 10) ─► read manifest.json ─► canonical check ─► packageId
     ─► skew check (5.4) ─► verify every member's size + sha256 while streaming it into staging
     ─► verify closures: map/closure.json, actors/closure.json, catalog/entries.json
     ─► verify embedded blobs (full form) against the closure listings
     ─► decode: document (upgraders), trace (upgraders), timeline(s)
     ─► cross-check digests (trace header ↔ manifest ↔ timeline identity ↔ map)
     ─► resolve map (5.2) and actors (5.2)
     ─► one transaction: dedupe blobs into content stores, write rows (their foreign keys make the blobs reachable)
```

- **Staging.** Members stream into a per-import staging area keyed by
  digest. Nothing reaches a content store until every check has passed.
- **Cross-checks** that must all hold:
  - `trace.header.engineGraphDigest = map.xodrSha256`;
  - `trace.header.inputHash = simulation.resolvedInputDigest`;
  - each timeline's `identity.traceSha256 = simulation.traceSha256` and
    `heightFieldDigest = map.heightSourceDigest`;
  - `timelineKey` recomputes from the identity fields;
  - the resolution record's `completion` block equals the manifest's
    `simulation` fields.
- **Deep verify** (optional, background, never blocking):
  - Rebuild the timeline from the trace and the map's height source under
    the packaged sampler. It must reproduce `timelineSha256`.
  - When the reader's `ENGINE_SEM_VER` equals `engine.engineSemVer`,
    re-simulate. The result must reproduce `traceSha256`. A mismatch is
    recorded as a determinism violation (`sim_verification_events`). The
    binding stays on the package trace.

### 5.2 Binding

Import creates a new document and its first revision in the target
workspace. Importing into an existing document as a new revision is an open
question (section 13).

| Record | Written as |
|---|---|
| `document` / `revision` | `content` from `document.json` (after upgraders); `map_version_id`, `map_closure_sha256 = pinClosureSha256`, `asset_catalog_version_id` from the resolved map and catalog. `revisions.imported_package_id = packageId`. |
| `sim_results` | New row with `origin = 'import'` (new column; default `'simulated'`). `sim_key` and every digest come from the package. `producer = 'import:<packageId>'`. Object keys are derived from verified digests only. |
| `revision_simulations` | `(revision, engine.engineSemVer, simKey, origin = 'import')`. Phase-1 replay picks it as the revision's original result. |
| timelines (phase-1 table) | One row per packaged timeline, keyed by `timelineKey`. A timeline under the reader's sampler is derived on demand from the stored trace, as phase 1 does for any sampler bump. |
| `scenario_packages` | `(package_id, workspace_id, direction = 'import', manifest jsonb, form, receipt jsonb, created_by, created_at)`. |
| Reachability | The new rows reference every digest the revision now depends on (section 7); nothing else is written for retention. |

**Memo conflicts.** Suppose the workspace already holds `sim_key` with the
same `trace_sha256`: the rows dedupe and the revision binds the existing row.
Suppose it holds `sim_key` with a **different** trace: that is a determinism
violation between installations. The import still succeeds, and the package
trace is stored under
`simKey' = H("simforge.sim-key-import/v1", simKey, traceSha256)`. The conflict
is recorded, and the revision binds `simKey'`. The existing memo row is never
replaced.

**Map resolution.** It is exact, and never by name:

1. **By id.** A local map version with id `map.mapVersionId` whose simulation
   members digest to `pinClosureSha256` and whose `xodr_sha256` matches: bind
   it.
   - Same id, different content: fail with `package_map_conflict`. Never bind.
2. **By content.** Look for another local map version with identical
   `xodrSha256`, `coordinateSystemSha256` and `pinClosureSha256`. This covers
   the same publication installed under another id, for example local Studio
   against SimCloud.
   - Bind it, and record `bound_by = 'closure-digest'`.
   - Only simulation members decide this. Render-only members (tiers, tiles)
     may differ, and the UI says so.
3. **Full form.** Install the embedded closure as a map version. Keep
   `mapVersionId` when the id is free, otherwise mint a new id and record
   `imported_from_map_version_id`. The browser asset set is verified exactly
   as a map publication is (`closure.ts`). Render members that were not
   embedded (other texture tiers) are listed and marked `unavailable` (see
   open question 2).
4. **Thin form.** Fetch the closure members by digest from this installation's
   configured content origins (section 7).
5. **Otherwise fail** with `package_map_missing`. The error names the map
   (label, `mapVersionId`, `xodrSha256` prefix) and offers:
   - **"Transfer to map version X"**, for each local map version of the same
     `sourceMapId`, newest first. This runs the existing transfer flow: a new
     revision, re-simulated on X, shown with a motion diff against the package
     trace. The package's own revision is **not** created (it cannot play).
   - **"Import the full package instead"**, when the package is thin.
   - **"Install map version …"**, when the host's map catalog lists that
     version id or closure digest as downloadable.

**Actor resolution.** The actor closure must be available by
`actorClosureDigest`, from a full package's blobs, the installation's actor
store, or a configured origin. Only the members reachable from
`catalog.catalogIds` are required. When they are missing, the import fails
with `package_actor_assets_missing`, which names the ids. There is no
fallback to a class default or a nearby model. A catalog id that the local
catalog maps to different bytes is irrelevant, because rendering binds the
closure by digest.

### 5.3 What import never does

- It never re-binds a map by label, source id or "newest compatible
  publication".
- It never re-simulates to create the binding. Deep verify is only a check.
- It never rewrites stored bytes. Upgraders run in memory (phase 1). The
  stored trace and timelines are the package's bytes.
- It never fetches a URL named by the package. Packages contain no URLs.
- It never trusts `receipt.json`, `scenario.origin` or `provenance` for any
  decision.

### 5.4 Version skew

Each versioned dimension is checked separately. When the reader refuses a
package, the message lists every dimension that is ahead.

| Dimension | Package older than reader | Package newer than reader |
|---|---|---|
| Manifest `schema` | Manifest upgrader chain (`vN → vN+1`, pure) | Refuse |
| `scenarioVersion` | Document upgrader chain (today `migrate-v2`) | Refuse |
| `traceFormat` | Trace upgrader chain (phase 1: v1/v3/v4, then v5) | Refuse |
| Timeline `version` | Timeline upgrader or re-derivation from the trace | Refuse |
| `samplerVersion` | Keep the packaged timeline as evidence. Derive the reader's sampler timeline from the trace (phase 1) | Refuse (open question 3) |
| `executionPackage.contract` | Informational; the xosc is not a render input | Ignore the xosc member and warn |
| `engineSemVer` | **Not a gate.** Replay needs no engine | **Not a gate** |
| `groundDigest` present, reader pre-v5 | n/a | Refused through `traceFormat` |

Two more dimensions come first, before any member is read:

| Dimension | Rule |
|---|---|
| `manifest` | A manifest whose `schema` is `simforge.scenario-package/v<N>` with N > 1 is refused as `package_version_unsupported`, not as a schema error, and the message still names the producer and `minCli` when the newer manifest carries them. |
| `cli` | `producer.minCli` greater than the reading CLI's version is refused. (This is PLAN section 4.2's `package_reader_too_old`, expressed as one dimension of the one skew code.) A producer re-checking its own output passes no CLI version; the report then says `cliCheck: "not-evaluated"`. |

The refusal text is: *"This package was made by simcloud 0.3.0 and needs
simforge 0.3.0 or later; this is simforge 0.2.0. Ahead of this reader:
traceFormat 5 (this reader supports <= 4). Update simforge to 0.3.0 or later
to read it."* The error code is `package_version_unsupported`, with
`{dimension, found, supported}` per entry, every dimension that is ahead
listed.

The archive corpus (section 11) is what makes "older → upgraders" a
guarantee rather than a hope.

## 6. Reproduce exactly

The default promise is identical poses. Pixels may differ across renderer
releases. "Reproduce exactly" also pins the renderer.

**Manifest `render` block** (the details are in `render/pin.json`, which is
also a digest-covered member):

| Field | Meaning |
|---|---|
| `mode` | `reproduce-exactly` |
| `renderer` | `native-bevy` or `carla` |
| `imageDigest` | OCI digest (`sha256:…`) of the worker image that rendered the source job. For CARLA, this image carries the cooked map |
| `runtimeVersion` | Native runtime version and tarball sha256 (local installs), or the CARLA runtime version |
| `rendererBuild` | Renderer build digest from the job manifest |
| `gpu` | `{model, driverVersion, vramGiB}` of the source job's worker |
| `profile` | Render profile id, resolution, fps, `capture.policy`, texture tier |
| `timelineSha256` | The exact timeline the source job rendered |
| `sourceOutputs` | Optional: digests of the source job's frame manifest and video, for comparison |

**Requirements:**

- Export offers the mode only for a revision with a succeeded render job
  whose `imageDigest` is retained (R6, section 7). The pin is copied from that job
  and is never assembled by hand.
- Import records the pin. A render in this mode:
  - runs on exactly `imageDigest` / `runtimeVersion`;
  - is scheduled only on a worker whose `gpuModel` equals `gpu.model`;
  - fails with `render_pin_unavailable` when either is missing. It never
    falls back to the current renderer.
- The result is labelled "Reproduced exactly on <GPU>". When `sourceOutputs`
  is present, the frame digests are compared and a mismatch is reported (not
  hidden). Bit-identical pixels are expected per GPU model plus driver only.
  A different driver is a warning, not a refusal.
- The CARLA exact-map rule stays in force. A CARLA pin whose image lacks the
  cooked map for `xodrSha256` fails. `allow-approximate` is never implied by a
  pin.
- A pinned image is itself a retention reference (R6). Without immutable,
  non-expiring image retention this mode must not be offered.

## 7. Retention requirements (what the thin form relies on)

A thin package is only as good as the stores behind it. These are
requirements on every installation that exports thin packages. A host that
cannot meet them offers the full form only.

| # | Requirement |
|---|---|
| R1 | Reachability is computed from the rows that reference content, not kept in a separate counter table (counts drift): revisions, `revision_simulations`, `revision_active_simulation`, `sim_results`, `sim_timelines`, render jobs, map versions (retired included) and their asset sets, and package records. Every one of those rows is written in the transaction that creates the thing it references. |
| R2 | Every deletion path computes reachability and refuses referenced digests: map `prune --gc`, map-asset edits that drop artifacts, the render-upload cleanup queue, the dataset and export cleanup jobs, and any future GC. A refusal is an error with the referrers listed. It is never skipped silently. |
| R3 | Deleting a workspace, document or revision removes **its refs** only. Bytes are collected by a GC that deletes a digest only when nothing reaches it across all workspaces and it has been unreachable for at least 30 days. |
| R4 | Content-addressed stores (traces, resolutions, timelines, map blobs, actor blobs) are write-once at the storage layer. Either Object Lock in governance mode (new buckets) or a bucket policy that denies `DeleteObject` and `DeleteObjectVersion` to every principal except the GC role. Noncurrent-version expiry must not apply to them. |
| R5 | Map re-exports create a new map version and never modify a referenced one. Environment migrations copy map version rows and closure bytes exactly and never use `--map-by-name`. |
| R6 | Renderer images referenced by a render job or a `render` pin are kept in repositories with immutable tags and no expiry policy, and are addressable by digest. Local installs keep pinned runtime tarballs in the runtime store under the same ref rule. |
| R7 | Package containers stored server-side (cached full zips) are disposable caches. They are never the source of truth, may expire, and are rebuilt from the content stores on demand. |
| R8 | The actor-assets closure a package references must be resolvable by digest from every installation that accepts thin packages from this one. Today that means publishing the pinned closure document and its blobs to the public actor origin. |

Content origins for thin import are configured per installation
(`SIMFORGE_PACKAGE_ORIGINS`: an ordered list of the local content stores and
upstream stores the installation is entitled to read). Members are
requested by digest only, and the list never comes from the package.

## 8. Thin vs full

| | Thin | Full |
|---|---|---|
| Contains | Manifest, document, trace, resolution, timeline(s), closure listings, catalog, optional xosc | Thin + `blobs/` for the map's simulation members, the render geometry (`3d/manifest.json`, `3d/tiles`, `3d/runtime`, `3d/env`), **one** texture tier, and the actor blobs reachable from `catalogIds` |
| Plays | Where the map version (by id or closure digest) and the actor closure are available (R1–R8) | Anywhere, offline, including another installation |
| Built | Synchronously in the request (< 1 s) | As a background export job, with progress; streamed from the content stores |

**Measured sizes** (dev data, September 2026; installed bundles):

| Part | Typical | Range |
|---|---|---|
| Trace (gzip) | 60 KB | 7 KB–750 KB (SUMO and heavy ambient at the top) |
| Timeline (canonical JSON, deflated in the zip) | 150 KB raw | 36 KB–4.9 MB raw; about 5–10× smaller deflated |
| Resolution record | 4 KB | 2–7 KB |
| Document, catalog entries, closure listings | 0.3–1.5 MB | The map closure listing grows with member count (about 12k members for the largest maps) |
| **Thin package total** | **≈ 1 MB** | 0.3–4 MB |
| Map simulation members (xodr, topology, signals, derived, colliders) | 7 MB | 2.5–25 MB before deflate |
| Render geometry (`3d/tiles` + runtime + env) | 110 MB | 70–550 MB |
| One texture tier: `256-uastc` / `512-*` | 50 MB / 140 MB | 40–200 MB / 130–640 MB |
| Referenced actor blobs | 60 MB | 10–300 MB (the whole closure is 1.29 GiB over 165 entries) |
| **Full package, 256-uastc tier** | **≈ 250 MB** | 120 MB (El Camino) – 1 GB (San Ramon phase 1) |

### 8.1 Forms and dedupe (resolved 2026-09-24)

These rules close open question 1 and the container half of open question 2.

1. **One id.** The form is a property of the container, never of the
   manifest. Thin and full exports of one revision have byte-identical
   `manifest.json` and one `packageId`.
2. **Two forms, nothing in between.** A container with no `blobs/` entry is
   thin. A container with any blob is full, and must then hold every blob
   of the full set (rule 5). Anything else is refused as
   `package_form_incomplete` (rule `blob_missing`, naming the first missing
   path), so "partial" packages cannot circulate.
3. **Every blob is named.** Each `blobs/sha256/<aa>/<sha256>` must be a
   digest listed by `map/closure.json` or `actors/closure.json`
   (`blob_unreferenced` otherwise), its name must be the sha256 of its bytes
   (`blob_name`), and its size must be the listed size (`blob_size`).
4. **Stored once.** A digest listed several times, within one closure or
   across both (a model shared by map and actors, two paths with one
   content), is one entry. All its listings must agree on the size
   (`package_closure_invalid`, `closure_size_conflict`). The writer dedupes
   blobs it is given twice. Role members (`document.json`, timelines, ...)
   are never deduplicated against blobs: they are always present by path.
5. **The full set.** Every member of the map closure whose `role` is not
   `texture` (simulation members, render geometry, runtime, environment,
   manifests and metadata, so the embedded closure installs and verifies as
   a map publication does), plus the actor blobs reachable from
   `catalog.catalogIds` through the closure's `catalog-models.json` (that
   file itself, each id's `model.glbPath` and every
   `animations.<motion>.glbPath`; an id the table does not list is
   procedural and reaches nothing). Other listed blobs (unbound actor
   models, texture members) may be embedded and are verified like any blob.
6. **Textures.** A full package embeds the texture members of the tier(s)
   its exporter selected; `receipt.textureTier` names the tier for display.
   The container verifier does not decide tier completeness (it cannot tell
   tiers apart from the listing); the map installer does, exactly as for a
   map publication, and marks texture members that were not embedded
   `unavailable`. A render that needs an unavailable member fails loudly;
   it never substitutes another tier.
7. **`referencedActorBlobs`** is `{count, bytes}` over the *distinct
   digests* of the reachable set in rule 5 (including
   `catalog-models.json`). A full package proves it; a thin package cannot
   (it carries no `catalog-models.json`) and its verification report lists
   it under `notVerifiable` instead of skipping it silently.
8. **Import may skip bytes it already has.** Because every entry's size,
   CRC and position are proven from the central directory before any data
   is read, an importer may leave a blob unread when its content store
   already holds that digest. `simforge package verify` never skips: it
   hashes every member and every blob.
9. **Limits by form.** The container-size limit is chosen by the form the
   container has (thin: 64 MiB, full: 4 GiB); the writer refuses to produce
   a container the default reader would refuse.

**Default: thin.** It is small enough to attach to an issue or an email, and
it is complete as a record: every digest needed to prove what played is
inside it. It also plays on this installation for as long as R1–R8 hold,
which is what the retention work guarantees. Full is the explicit choice for
another installation, offline use, or archiving outside SimForge. The dialog
shows the size of each form before download.

## 9. Studio UI

**Export**

- Where:
  - the scenario row menu: **"Export package…"**, which exports the latest
    revision;
  - the revision history panel: the same item per revision.
- "Download JSON" stays, relabelled **"Download document (JSON)"**. Its
  tooltip says it holds the document only.
- A draft with uncommitted changes shows "Commit a revision to export a
  package". Packages are revision-only.
- The dialog shows:
  - title, revision number and commit time;
  - **"Motion from engine 0.9.0, simulated 21 Sep 2026 (trace format 4,
    sampler 1)"**. If the revision's render used a re-simulated result, a
    note says which result the package holds: always the original result
    when one exists (phase 1 `motionSource`);
  - the map (label, short version id, closure digest prefix) and the actor
    count;
  - the form choice with live sizes: **Thin, 1.2 MB** ("plays where map El
    Camino Road @ ab12cd… is installed") and **Full, 318 MB** (map 212 MB,
    actors 96 MB, textures 256-uastc). For full, a texture tier selector,
    defaulting to the tier this installation's viewer uses;
  - **"Pin renderer for exact reproduction"**: enabled only when a retained
    pinned render exists; shows the renderer, image digest prefix and GPU
    model;
  - optionally, "Include author name".
- Full export runs as a job. The dialog shows progress and a download link
  when done. The link expires; the package id does not.

**Import**

- The existing "Import Scenario JSON" button becomes **"Import scenario…"**
  and accepts `.json` (documents, phase 1 rules) and `.scenario.zip`.
- Verification runs with visible progress ("Verifying 9,412 members…").
- A summary card follows before anything is written:
  - title, `pkg_…` id, and the source (installation kind, export time, from
    the receipt, labelled as unverified);
  - **"Motion from engine 0.9.0. This installation runs 0.10.0. The
    original motion will be replayed. Re-simulating is a separate, explicit
    action."**
  - map status: *Bound to installed version* / *Bound by identical content*
    (render assets may differ) / *Will be installed from package (212 MB)* /
    *Missing* (error state);
  - actors: available or missing;
  - reproduce-exactly pin, if any, and whether this installation can honour
    it;
  - an **Import** button, which creates the document and opens it.

**Error states** (each with a copyable detail block, per the studio style
guide):

Every refusal carries a stable `code` (below) and the exact `rule` that
failed (for example `package_container_invalid` / `duplicate_name`); the
fixture corpus pins one hostile package to each code and rule. Codes added
by the implementation: `package_identity_mismatch` (two digests that must
agree do not: trace header, timeline identity, map, resolution record),
`package_member_invalid` (a member does not decode as its role),
`package_closure_invalid` (a closure listing is malformed or contradicts
itself), `package_form_incomplete` (section 8.1), and, for writers,
`package_argument_invalid` and `package_io_error`.

| Code | User sees | Offered action |
|---|---|---|
| `package_container_invalid` | "This file is not a valid SimForge scenario package." + first violation | none |
| `package_manifest_not_canonical` / `_invalid` | "The package manifest is malformed." | none |
| `package_digest_mismatch` | "The package is damaged: `<path>` does not match its recorded hash." | Re-download |
| `package_version_unsupported` | Section 5.4 text, per dimension | "Update SimForge" link |
| `package_map_missing` | "Map El Camino Road (version …, OpenDRIVE ab12…) is not available here." | Transfer to map version X · Import full package · Install map version |
| `package_map_conflict` | "A different map already uses version id …; the package was not bound." | Import full package (installs under a new id) |
| `package_actor_assets_missing` | "Actor models `sedan-generic`, … are not available here." | Import full package |
| `package_too_large` / `package_limit_exceeded` | Which limit was hit, and the host's value | none |
| `render_pin_unavailable` (at render time) | "The pinned renderer (image sha256:…, RTX 4090) is not available." | Render with the current renderer (a new, unpinned job, labelled) |

## 10. Security

The package, including its manifest, is untrusted input until verification
completes.

**Container (strict reader):**

- Names must match
  `^(manifest\.json|receipt\.json|document\.json|simulation/[a-z-]+\.json(\.gz)?|timeline/[0-9a-f]{64}\.json|(map|actors)/closure\.json|catalog/entries\.json|export/scenario\.xosc|render/pin\.json|blobs/sha256/[0-9a-f]{2}/[0-9a-f]{64})$`.
  This rejects absolute paths, `..`, backslashes, drive letters, NUL,
  non-ASCII and zip-slip by construction. Members are never written to a
  path taken from the archive. They stream into a staging store keyed by
  digest.
- Reject:
  - duplicate names;
  - directory entries, symlinks (Unix mode `S_IFLNK`) and encryption;
  - methods other than STORE and DEFLATE;
  - multi-disk archives;
  - disagreement between the local header and the central directory (name,
    method, CRC, sizes);
  - overlapping entry byte ranges;
  - prefix or trailing data;
  - comments;
  - inconsistent ZIP64 records;
  - a `blobs/` entry whose name does not equal the sha256 of its bytes.
- Every entry's uncompressed size must equal the size the manifest (or the
  closure listing) declares. Inflation stops at the declared size, and one
  more byte is an error.

The reader also requires the writer's exact subset, which makes every
accepted container canonical for its content: entries tile the file from
offset 0 in the order of section 3.2 (manifest, receipt, members by role
then path, blobs by digest); "version made by" Unix and "version needed"
2.0 (4.5 with ZIP64); flags exactly bit 11; time and date 1980-01-01 00:00;
mode `0100644`; no extra field other than ZIP64; ZIP64 exactly when section
3.2's rule requires it (`zip64_required`: more than 65,535 entries or at
least 4 GiB - 64 MiB of entry data, the margin keeping every 32-bit field
safe), and then on every entry; the end records exactly at the end of the
file with the central directory immediately before them.

**Limits** (host-configurable; the defaults are shown):

| Limit | Default |
|---|---|
| Container size, thin | 64 MiB |
| Container size, full | 4 GiB |
| Entry count | 100,000 |
| `manifest.json` | 1 MiB |
| Any single non-blob member | 256 MiB |
| DEFLATE ratio per entry | ≤ 200:1 (for entries over 1 MiB; smaller entries cannot be bombs) |
| Total inflated bytes | ≤ 1.05 × declared total |
| Concurrent imports per workspace | 2 |

**Manifest handling:**

- The manifest is parsed with a size cap and a strict schema. Every digest
  field matches `^[0-9a-f]{64}$`.
- Strings from the manifest are never used as file paths, storage keys, SQL
  fragments, URLs or HTML. Storage keys derive from verified digests.
  `mapVersionId` and catalog ids are used only as parameterised lookup
  values.
- Titles and labels render as plain text.
- The document goes through `parseTemplate` (strict), and the trace and
  timeline through their own validating readers. Both run in the import
  worker with memory and time caps.
- No member is executed or evaluated. The xosc is stored as bytes only.
- Imports are authorised like document creation in the target workspace.
  Thin-form fetches use the importing user's entitlements to the configured
  origins, never the package's claims.

**Signatures (later, optional):** a detached `signatures/<keyid>.sig` member
over `packageId`, outside the identity like the receipt. It is verified
against keys the installation trusts. An unsigned package is still valid:
integrity comes from the digests, and a signature only adds authenticity.
The scheme is open question 7.

**Privacy:** packages carry no workspace ids, user ids, emails, host names,
bucket names, object keys or presigned URLs. The exporter asserts this with a
denylist test over the manifest, the receipt and the resolution record.

## 11. Test plan

| Test | What it proves | Where |
|---|---|---|
| Manifest canonical round trip | `parse → canonicalJson → sha256` is stable. The TS and Rust canonical encoders agree on manifest vectors | `packages/scenario/src/package/__tests__/manifest.test.ts`; add vectors to `fixtures/canonical-json/` |
| Container determinism | Two exports of one revision are byte-identical within one release. Both forms have the same `packageId` | `package-writer.test.ts` |
| Strict reader corpus | One hostile fixture per section 10 rule (zip-slip, symlink, duplicate, overlap, header mismatch, bomb, ZIP64 lie, trailing data, non-canonical manifest, wrong blob name). Each is refused with its code | `fixtures/package-hostile/` + `package-reader.test.ts` |
| Round trip, thin | Export → import into a fresh workspace on the same host. The revision binds the same `traceSha256` / `timelineSha256`, `motionSource = original`, the render timeline is identical, and no simulation request is created | `studio/app/lib/scenario/__tests__/scenario-package.test.ts` |
| Round trip, full | Export full → import into an empty installation, which installs the map version and actors. Bevy pose parity against the package timeline is ≤ 1e-3 m / 0.05° | same + `simforge render parity` in the native CI lane |
| Map resolution matrix | By id; by content under a different id; id conflict; missing (thin) with transfer offers; full install under a new id. Never by name | scenario-package.test.ts |
| Skew | A synthetic package one version ahead on each dimension is refused with the right message. Older manifests, documents, traces and timelines upgrade | `package-skew.test.ts` |
| Memo conflict | Same `simKey` with a different trace → `simKey'` binding, violation recorded, original row untouched | scenario-package.test.ts |
| Retention | Every cleanup path in R2 refuses a digest referenced by an imported package. GC deletes only unreachable digests after the grace period | `retention-reachability.test.ts` |
| **Archive corpus packages** | Each release appends `fixtures/archive-corpus/<release>/packages/*.scenario.zip`: thin packages plus one full package on the committed Richmond closure, with a stored pose ledger. Every later release must import every one of them, verify all hashes, upgrade, and reproduce the pose ledger within Bevy tolerance | the phase-1 archive corpus job; append-only (a new CI check refuses edits or deletions under past releases) |
| Cross-installation | OSS local Studio exports thin + full → SimCloud dev imports, and the reverse. Asserts identical `traceSha256`, `timelineSha256` and sampled poses. Thin succeeds only when the other side has the map by closure digest, and otherwise fails with `package_map_missing` | real-stack suite (`docs/engineering/real-stack-test-suite.md`), nightly |
| Reproduce exactly | A pinned render on the same GPU model reproduces the source frame digests. A different GPU is refused by the scheduler | per-GPU golden lane |
| Privacy denylist | No host name, bucket, object key, email or user/workspace id in any exported metadata member | `package-privacy.test.ts` |

## 12. Staged plan

| Stage | Scope | Effort | Depends on (phase 1) |
|---|---|---|---|
| **A. Thin export** | Manifest schema + canonical encoder + verifier (`@simforge-oss/scenario/package`), ZIP writer, export route, `simforge package export\|inspect\|verify`, the "Export package…" dialog (thin only), `scenario_packages` table | 3–4 days | `motionSource` / original-result lookup; timelines keyed by `timelineKey` |
| **B. Import (thin)** | Strict ZIP reader, staging + verification pipeline, skew rules, map/actor resolution (id, content, missing + transfer offer), `origin = 'import'` rows, memo-conflict rule, import summary UI, error states, `simforge package import` | 4–6 days | trace upgrader chain (v1/v3/v4, v5 when it lands); exact map resolution on JSON import; archive corpus harness |
| **C. Full form** | Blob embedding (simulation members, render geometry, one tier, actor subset), background export job with progress, map-version install from a package, partial-tier asset sets, actor-closure subset delivery to the native renderer, cross-installation test | 6–8 days | B; R8 (actor closure on the public origin) |
| **D. Reproduce exactly** | `render/pin.json`, pin capture from a succeeded job, pinned scheduling by image digest + GPU model, pinned-mode labels, frame-digest comparison | 3–4 days + infra | R6 (immutable image repos, pushed native worker images, immutable CARLA tags) |
| **E. Retention hardening** | reachability from references, refusal in every R2 path, reachability GC with grace, write-once stores (Object Lock on new content-addressed buckets and copy-over, or deny-delete policies), fix of the export-prefix expiry, migration tooling without `--map-by-name` | 5–7 days + infra | none. **Start in parallel with A.** Thin packages should not be advertised as durable until E is done |

Total: about 4–5 engineer-weeks plus infrastructure changes. Archive-corpus
packages start with stage B and grow every release.

## 13. Open questions

1. ~~**One id for thin and full.**~~ Resolved: one id; the form is a
   container property (section 8.1).
2. **Texture tiers in full packages.** The container rules are resolved
   (section 8.1, rule 6: any selected tier, the installer marks the rest
   `unavailable` and renders fail loudly on them). Still open: the default
   tier (proposed `256-uastc`) and whether exporters may embed several.
3. **Newer sampler.** Refuse (as specified), or accept and render with a
   timeline the reader derives from the trace with its own sampler? Poses x,
   y and heading are identical either way; z, pitch, roll and lights may
   differ.
4. **Import target.** Always a new document, or also "add as a new revision
   of document D" when `scenario.origin` matches a local document?
5. **Cross-installation thin.** May local Studio fetch thin members from
   SimCloud with the user's credentials (SimCloud as a configured origin), or
   is thin strictly same-installation and full the only cross-installation
   form?
6. **Legacy revisions** whose only result is a lazy re-simulation (no
   original result). Export them labelled "motion re-simulated under 0.x", or
   refuse?
7. **Signatures.** Which scheme, when we add them: keyless signing tied to a
   workspace identity, or a per-installation Ed25519 key?
8. **Object Lock vs deny-delete policy.** Object Lock needs new buckets and a
   copy of every content-addressed object. A deny-delete policy works in
   place but is weaker (an administrator can lift it). Which one?
9. **Author name.** Off by default (as proposed), or on by default for
   SimCloud workspaces?
