# Scenario Package (`simforge.scenario-package/v1`)

Implemented by the `simforge-package` Rust crate: container, manifest,
canonical encoding, strict reader, writer and verifier. It relies on the trace
upgrader chain, render timelines keyed by `timelineKey`
(`render-timeline.md`) and the archive corpus (`fixtures/archive-corpus/`),
and does not re-specify them.

A Scenario Package is the one self-contained, verifiable form of an authored
scenario revision: the document, the motion it was simulated to, and every
digest needed to replay that motion on any later release, on this
installation or another one.

| Piece | Where |
|---|---|
| Manifest types, canonical encoding, strict ZIP reader and writer, verifier | `native/crates/simforge-package` (Rust; the one implementation) |
| JSON Schema | `contracts/scenario-package/manifest.v1.schema.json`, `receipt.v1.schema.json` |
| Fixtures | `fixtures/scenario-package/` (valid packages and one hostile package per rule, with `expectations.json`) |
| Hosted exporter | The hosted app writes the same container through its own binding of the crate, so its packages are byte-identical to what the crate writes |
| CLI | `simforge package inspect \| verify \| import` (Rust `simforge` CLI, over the crate) |
| Tests | the crate's `tests/` and the CLI's `tests/package.rs` (section 11) |

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
map/closure.json                      the map registry release's canonical closure (native render assets)
map/web-closure.json                  the release's web closure, when it has one
actors/closure.json                   the actor-assets closure document
catalog/entries.json                  the gallery catalog entries the request key hashed
export/scenario.xosc                  optional: the derived OpenSCENARIO 1.4 export
render/pin.json                       reproduce-exactly only (section 6)
blobs/sha256/<aa>/<sha256>            full form only: closure members, content-addressed
```

- Every name matches the allowlist in section 10. None is derived from user
  text (titles, map labels, catalog ids).
- Map blobs and actor blobs share `blobs/`. A blob that appears in several
  closures is stored once.
- `receipt.json` is `{schema: "simforge.scenario-package-receipt/v1",
  packageId, form, exportedAt, exporterRelease, textureTier?,
  embeddedBlobs: {count, bytes}}`. It is not covered by any digest. The
  importer shows it and never makes a decision from it.

## 4. Manifest (`simforge.scenario-package/v1`)

### 4.1 Members

`manifest.members` is sorted by `path`. It lists every member except
`manifest.json`, `receipt.json` and `blobs/`. Blobs are listed by the closure
documents (map canonical, map web, actors), and those documents are
themselves members.

| `path` | `role` | Required | `mediaType` | Extra identity check on import |
|---|---|---|---|---|
| `document.json` | `document` | yes | `application/vnd.simforge.scenario+json` | canonical; `sha256 = scenario.contentSha256` |
| `simulation/trace.json.gz` | `trace` | yes | `application/vnd.simforge.trace+json+gzip` | `sha256 = simulation.traceGzipSha256`; decoded canonical digest `= simulation.traceSha256` |
| `simulation/resolution.json.gz` | `resolution` | yes | `application/vnd.simforge.sim-resolution+json+gzip` | `sha256 = simulation.resolutionSha256` |
| `simulation/materialized-traffic.json` | `traffic` | when present | `application/vnd.uniscenarios.materialized-traffic+json` | `sha256 = simulation.trafficSha256` |
| `timeline/<sha>.json` | `timeline` | at least one | `application/vnd.simforge.render-timeline+json` | `sha256 = <sha>`; its `identity.timelineKey` is listed in `timelines[]` |
| `map/closure.json` | `map-closure` | yes | `application/vnd.simforge.map-closure+json` | the registry release's canonical closure (`map-closure.v1`, kind `canonical`, `metadata.master`), canonical JSON byte for byte: `sha256 = map.canonicalClosureSha256`; pin digest (over both map closures) recomputes to `map.pinClosureSha256` |
| `map/web-closure.json` | `map-web-closure` | when the release has one | `application/vnd.simforge.map-closure+json` | the release's web closure (kind `web`, `toolFingerprint`): `sha256 = map.webClosureSha256`; a path both closures list names the same bytes |
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
    "mapClosureDigest": "…", "pinClosureSha256": "…",
    "canonicalClosureSha256": "…", "webClosureSha256": "…", "registryReleaseDigest": "…",
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
| `producer.minCli` | semver | The oldest `simforge` CLI that reads this package. A reader whose version is lower refuses it (`package_version_unsupported`, dimension `cli`, section 5.4). A producer raises it only when a contract the reader needs changes. |
| `scenario.title` | string ≤ 200 | Display only. Plain text, never interpreted. |
| `scenario.documentSchema`, `scenarioVersion` | string, int | Document contract (`SCENARIO_TEMPLATE_VERSION`, now 2). Drives the document upgrader chain. |
| `scenario.contentSha256` | sha256 | `canonicalJsonSha256(content)`, the revision's `content_sha256`. |
| `scenario.simContentSha256` | sha256 | `simContentHash(content)` (`simforge.sim-content/v1`). |
| `scenario.origin.*` | optional | Source document and revision ids, revision number and commit time. Provenance only. Never looked up on another installation. |
| `engine.engineSemVer` | semver | `ENGINE_SEM_VER` that produced the trace. Shown to the user. **Not** a skew gate (section 5.4). |
| `engine.solverVersion`, `pipelineRevision` | string, int | The producing host's solver version and simulation pipeline revision, as it recorded them. |
| `engine.build` | object | The engine build the producer recorded for the trace: exactly the recorded ones of `engineVersion`, `abiVersion`, `buildDigest`, `addonSha256`, `sourceRevision` (absent when not recorded; any other key is refused). Provenance only. |
| `engine.release` | string | The SimForge stack version (`0.1.0-rc.N` or stable) that produced the trace. |
| `simulation.simKey` | sha256 | `simforge.sim-key/v1`. Reused as the memo key on import (section 5.2). |
| `simulation.traceFormat`, `traceSchema` | int, string | `header.traceVersion` and the trace schema id. Drives the trace upgrader chain. |
| `simulation.traceSha256` | sha256 | Canonical trace identity (never the gzip bytes). |
| `simulation.traceGzipSha256` | sha256 | sha256 of the stored `.trace.json.gz` bytes, the member digest. |
| `simulation.authoredTraceSha256` | sha256 | Differs from `traceSha256` only for SUMO documents. |
| `simulation.resolvedInputDigest`, `resolutionSha256` | sha256 | The resolved input's digest and the resolution record's sha256, as the producer stored them. |
| `simulation.trafficProvider`, `trafficStepKey`, `trafficSha256`, `sumo` | | `sumo` is `{networkSha256, runtimeVersion, wasmSha256}` or null. |
| `simulation.groundDigest` | sha256 \| null | Trace v5 ground-contact source digest (`header.groundDigest`, the sha256 of the ground mesh). Null before trace format 5. From format 5: required, and equal to the mesh's sha256, when `map/closure.json` lists `derived/ground/ground-mesh.bin`; null when it does not (section 8.1, rule 10). |
| `simulation.producerKind` | enum | `inline`, `runner`, `cli`, `editor`. The raw `producer` string is **not** exported, because it contains host names. |
| `timelines[]` | array ≥ 1 | Every packaged timeline's identity (`render-timeline.md` section 2). The first entry is the one the source's renders used. |
| `executionPackage` | object \| null | Contract and xosc digest when `export/scenario.xosc` is present. |
| `map.mapVersionId` | string | The exact map version. The first lookup key on import. |
| `map.sourceMapId`, `label` | string | Display, and ranking of transfer offers. **Never used to bind.** |
| `map.xodrSha256`, `coordinateSystemSha256` | sha256 | Must equal the trace header's `engineGraphDigest` and the bound map version. |
| `map.mapClosureDigest` | sha256 | `simforge.map-closure/v1` (`MapBundle::closure_digest` in `simforge-compiler`), key material in `simKey`. |
| `map.pinClosureSha256` | sha256 | `simforge.map-pin-closure/v1` over the simulation members of both closures (`simforge-package/src/closure.rs`). |
| `map.canonicalClosureSha256` | sha256 | sha256 of `map/closure.json`: the registry release's canonical closure digest (`closureDigest` in the registry). The canonical closure lists the native render assets (`master.gltf`, `geometry.bin`) and every derivative built into it (ground, geometry LOD, luminaires, road decals, texture density, texture tiers, SUMO). |
| `map.webClosureSha256` | sha256 \| null | sha256 of `map/web-closure.json`, the release's web closure; null when the release has none. |
| `map.registryReleaseDigest` | sha256 \| null | The registry release document (`simforge.map-release.v1`) these closures belong to, when the map version came from a registry (hosted native asset sets record it). Import looks the release up by this digest first. |
| `map.heightSourceDigest` | sha256 | `heightSource.digest` of the timeline's height source. |
| `map.groundDigest` | sha256 \| null | Trace v5 ground source. Null before v5. |
| `map.closure` | object | Member count and total bytes of the canonical closure. |
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
and `map.groundDigest` are equal, null before trace format 5, and from
format 5 governed by the map closure (section 8.1, rule 10);
`members[]` is sorted by path, names every required role, and each
member's `sha256` equals its typed field (`document.json` =
`scenario.contentSha256`, trace = `traceGzipSha256`, resolution =
`resolutionSha256`, traffic = `trafficSha256`, `map/closure.json` =
`canonicalClosureSha256`, `map/web-closure.json` = `webClosureSha256` (null exactly when absent), `actors/closure.json` = `actorClosureDigest`,
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
     ─► bind: the CLI unpacks into a workspace directory; a host dedupes blobs into its content stores
        and records the binding in one transaction
```

`simforge package verify` runs every check up to the cross-checks and hashes
every member and blob. `simforge package import <package> --into <dir>` runs
them, unpacks the members into a workspace, and reports what a render or
re-simulation still needs locally: the map by its OpenDRIVE digest and the
actor closure by its digest.

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
    a determinism violation; the binding stays on the package trace.
    `simforge simulate <workspace>` is this check for an imported workspace
    (`deterministicMatch`, finding `determinism_violation`).

### 5.2 Binding

A host that imports into its own store binds a new document revision to the
package's own trace, timelines and digests. Storage keys derive from verified
digests only, and every row it writes references the digests the revision now
depends on (section 7).

**Memo conflicts.** Suppose the host already holds `simKey` with the
same `traceSha256`: the binding dedupes onto the existing result. Suppose it
holds `simKey` with a **different** trace: that is a determinism violation
between installations. The import still succeeds, and the package trace is
stored under
`simKey' = H("simforge.sim-key-import/v1", simKey, traceSha256)`. The conflict
is recorded, and the revision binds `simKey'`. The existing memo entry is
never replaced.

**Map resolution.** It is exact, and never by name:

1. **By id.** A local map version with id `map.mapVersionId` whose simulation
   members digest to `pinClosureSha256` and whose `xodr_sha256` matches: bind
   it.
   - Same id, different content: fail with `package_map_conflict`. Never bind.
2. **By content.** Look for another local map version with identical
   `xodrSha256`, `coordinateSystemSha256` and `pinClosureSha256`. This covers
   the same publication installed under another id on another installation.
   - Bind it, and record that it was bound by closure digest.
   - Only simulation members decide this. Render-only members (tiers, tiles)
     may differ, and the importer says so.
3. **Full form.** Install the embedded canonical closure (and the web-only
   members it carries) as the map release, exactly as `maps pull`
   materialises a registry release. Keep `mapVersionId` when the id is free,
   otherwise mint a new id and record `imported_from_map_version_id`.
4. **Thin form.** Resolve the release by digest (`registryReleaseDigest`,
   else a release whose canonical closure digest is
   `canonicalClosureSha256`), or fetch the closure members by digest from
   this installation's configured content origins (section 7).
5. **Otherwise fail** with `package_map_missing`. The error names the map
   (label, `mapVersionId`, `xodrSha256` prefix). A host may offer to import
   the full package instead, to install the map version, or to transfer the
   document to another version of the same `sourceMapId` (a new,
   re-simulated revision; the package's own revision is not created, because
   it cannot play).

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
- It never rewrites stored bytes. Upgraders run in memory. The
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
| `traceFormat` | Trace upgrader chain (v1/v3/v4, then v5) | Refuse |
| Timeline `version` | Timeline upgrader or re-derivation from the trace | Refuse |
| `samplerVersion` | Keep the packaged timeline as evidence. Derive the reader's sampler timeline from the trace | Refuse (open question 1) |
| `executionPackage.contract` | Informational; the xosc is not a render input | Ignore the xosc member and warn |
| `engineSemVer` | **Not a gate.** Replay needs no engine | **Not a gate** |
| `groundDigest` present, reader pre-v5 | n/a | Refused through `traceFormat` |

Two more dimensions come first, before any member is read:

| Dimension | Rule |
|---|---|
| `manifest` | A manifest whose `schema` is `simforge.scenario-package/v<N>` with N > 1 is refused as `package_version_unsupported`, not as a schema error, and the message still names the producer and `minCli` when the newer manifest carries them. |
| `cli` | `producer.minCli` greater than the reading CLI's version is refused. A producer re-checking its own output passes no CLI version; the report then says `cliCheck: "not-evaluated"`. |

The refusal text is: *"This package was made by simcloud 0.3.0 and needs
simforge 0.3.0 or later; this is simforge 0.2.0. Ahead of this reader:
traceFormat 5 (this reader supports <= 4). Update simforge to 0.3.0 or later
to read it."* The error code is `package_version_unsupported`, with
`{dimension, found, supported}` per entry, every dimension that is ahead
listed.

The archive corpus (`fixtures/archive-corpus/`, section 11) is what makes "older → upgraders" a
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

- A producer writes the pin only for a succeeded render job whose
  `imageDigest` it retains (section 7). The pin is copied from that job and
  is never assembled by hand.
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
- A pinned image is itself a retention reference (section 7). Without
  immutable, non-expiring image retention this mode must not be offered.

## 7. Retention requirements (what the thin form relies on)

A thin package is only as good as the stores behind it. An installation that
exports thin packages must guarantee, for as long as a package may be
imported:

- **Reachability from references.** Every digest a revision, simulation
  result, timeline, render job, map version or package record references is
  reachable, and reachability is computed from those references, not from a
  separate counter.
- **No deletion of referenced bytes.** Every deletion path refuses a
  referenced digest with an error that lists the referrers; deleting a
  workspace, document or revision removes its references only, and a garbage
  collector deletes a digest only after it has been unreachable for a grace
  period.
- **Write-once content stores** for traces, resolutions, timelines, map
  blobs and actor blobs.
- **Immutable map versions.** A re-export creates a new map version and never
  modifies a referenced one.
- **Renderer images by digest.** Images referenced by a render job or a
  `render` pin are kept with immutable tags and no expiry.
- **Public actor closure.** The actor-assets closure a package references is
  resolvable by digest from every installation that accepts thin packages
  from this one, which today means the public actor origin.

Cached package containers are disposable: they are never the source of truth
and are rebuilt from the content stores on demand. A host that cannot meet
these requirements offers the full form only.

Content origins for thin import are configured per installation (an ordered
list of the content stores the installation is entitled to read). Members
are requested by digest only, and the list never comes from the package.

## 8. Thin vs full

| | Thin | Full |
|---|---|---|
| Contains | Manifest, document, trace, resolution, timeline(s), closure listings, catalog, optional xosc | Thin + `blobs/` for every member of the canonical closure (the native render assets and their derivatives, texture tiers included), the web-only members the CLI reads, and the actor blobs reachable from `catalogIds` |
| Plays | Where the map version (by id or closure digest) and the actor closure are available (section 7) | Anywhere, offline, including another installation |
| Built | In well under a second | Streamed from the content stores; minutes for large maps |

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
5. **The full set.** The map closure is the registry release's canonical
   closure, not the browser asset set, which has no native master and could
   not render on the CLI:
   - every member of `map/closure.json`, the canonical closure: the native
     render assets (`master.gltf`, `geometry.bin`) and every derivative
     built into it (ground, geometry LOD, luminaires, road decals, texture
     density, texture tiers, SUMO). A full package therefore renders
     offline with the native renderer;
   - the web-only members of `map/web-closure.json` the CLI reads
     (`is_cli_web_member`: the simulation members published web-side, the
     static colliders, and `derived/ambient/turn-verdicts.json.gz`);
   - the actor blobs reachable from `catalog.catalogIds` through the actor
     closure's `catalog-models.json` (that file itself, each id's
     `model.glbPath` and every `animations.<motion>.glbPath`; an id the
     table does not list is procedural and reaches nothing).
   Other listed blobs (other web members, unbound actor models) may be
   embedded and are verified like any blob.
6. **Two listings, verbatim.** `map/closure.json` and `map/web-closure.json`
   are the registry's own `map-closure.v1` documents, canonical JSON byte for
   byte, so their sha256 are the registry's closure digests and an importer
   matches a release by digest instead of member by member. (One merged
   listing was the alternative; it would have had a digest no registry
   knows.) The canonical closure must be `kind: canonical` with
   `metadata.master: true`; the web closure `kind: web` with a
   `toolFingerprint`; a path both list must name the same bytes
   (`closure_path_conflict`). The pin closure is computed over the
   simulation members of both.
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
   container has (thin: 64 MiB, full: 32 GiB, since a full package carries the whole canonical closure, about 3–4 GB for Richmond Field Station); the writer refuses to produce
   a container the default reader would refuse.
10. **Ground (trace format 5 on).** The engine records `header.groundDigest`
    only when the map has a ground surface, so a trace v5 on a map without
    one has none. The rule follows the map closure, not the trace format:
    when `map/closure.json` lists `derived/ground/ground-mesh.bin`, a trace
    of format 5 or later must carry `groundDigest` equal to that member's
    sha256; when it does not list one, `groundDigest` must be null.
    `simulation.groundDigest` must also equal the trace header's
    (`trace_ground`). Violations are `package_identity_mismatch`, rule
    `ground_digest`.
11. **Withheld and licensed actor models.** An actor closure may carry a
    per-member `licenses` table (every key a member, every record naming a
    `license`) and its `catalog-models.json` a `withheld` table. A full
    package whose `catalogIds` bind a withheld id is refused by name
    (`package_closure_invalid`, `actor_model_withheld`); it is never treated
    as procedural.
**Default: thin.** It is small enough to attach to an issue or an email, and
it is complete as a record: every digest needed to prove what played is
inside it. It also plays on the exporting installation for as long as the
section 7 requirements hold. Full is the explicit choice for another
installation, offline use (the CLI), or archiving outside SimForge.

## 9. Refusal codes

Every refusal from the crate carries a stable `code` and the exact `rule`
that failed (for example `package_container_invalid` / `duplicate_name`);
the fixture corpus (`fixtures/scenario-package/`) pins one hostile package to
each code and rule. The CLI reports both, exiting 1 for `package_io_error`
(could not run) and 2 for every other code (a finding about the package).

| Code | Meaning |
|---|---|
| `package_container_invalid` | Not a valid scenario package container (section 10); the first violation is named |
| `package_manifest_not_canonical` / `package_manifest_invalid` | The manifest is not canonical JSON, or does not match the schema |
| `package_digest_mismatch` | A member does not match its recorded size or sha256 |
| `package_identity_mismatch` | Two digests that must agree do not: trace header, timeline identity, map, resolution record |
| `package_member_invalid` | A member does not decode as its role |
| `package_closure_invalid` | A closure listing is malformed or contradicts itself |
| `package_form_incomplete` | A full package is missing a blob of the full set (section 8.1) |
| `package_version_unsupported` | The package is ahead of this reader on some dimension (section 5.4) |
| `package_too_large` / `package_limit_exceeded` | A limit was hit; the message names the limit and its value |
| `package_argument_invalid` / `package_io_error` | Writer argument and I/O errors |

A host that binds packages into its own store adds the binding refusals:
`package_map_missing` and `package_map_conflict` (section 5.2),
`package_actor_assets_missing` (actor models named by `catalogIds` are not
available), and, at render time, `render_pin_unavailable` (section 6).

## 10. Security

The package, including its manifest, is untrusted input until verification
completes.

**Container (strict reader):**

- Names must match
  `^(manifest\.json|receipt\.json|document\.json|simulation/[a-z-]+\.json(\.gz)?|timeline/[0-9a-f]{64}\.json|(map|actors)/closure\.json|map/web-closure\.json|catalog/entries\.json|export/scenario\.xosc|render/pin\.json|blobs/sha256/[0-9a-f]{2}/[0-9a-f]{64})$`.
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
| Container size, full | 32 GiB |
| Entry count | 100,000 |
| `manifest.json` | 1 MiB |
| Any single non-blob member | 256 MiB |
| DEFLATE ratio per entry | ≤ 200:1 (for entries over 1 MiB; smaller entries cannot be bombs) |

**Manifest handling:**

- The manifest is parsed with a size cap and a strict schema. Every digest
  field matches `^[0-9a-f]{64}$`.
- Strings from the manifest are never used as file paths, storage keys, SQL
  fragments, URLs or HTML. Storage keys derive from verified digests.
  `mapVersionId` and catalog ids are used only as parameterised lookup
  values.
- Titles and labels render as plain text.
- The document must be canonical and carry the manifest's
  `scenarioVersion`; an importer that authors from it parses it strictly
  (`simforge_compiler::parse_template`). The trace and timeline go through
  their own validating readers. A host runs these with memory and time caps.
- No member is executed or evaluated. The xosc is stored as bytes only.
- A host authorises an import like document creation in the target
  workspace. Thin-form fetches use the importing user's entitlements to the
  configured origins, never the package's claims.

**Signatures (later, optional):** a detached `signatures/<keyid>.sig` member
over `packageId`, outside the identity like the receipt. It is verified
against keys the installation trusts. An unsigned package is still valid:
integrity comes from the digests, and a signature only adds authenticity.
The scheme is open question 2.

**Privacy:** packages carry no workspace ids, user ids, emails, host names,
bucket names, object keys or presigned URLs. An exporter must check this over
the manifest, the receipt and the resolution record.

## 11. Tests

| Test | What it proves | Where |
|---|---|---|
| Fixture corpus | The committed fixtures regenerate byte for byte (the writer is deterministic); every valid fixture verifies; every hostile fixture (one per section 10 rule and each refusal code) is refused with its `code` and `rule`; thin and full forms share one `packageId`. Regenerate with `SIMFORGE_UPDATE_PACKAGE_FIXTURES=1 cargo test -p simforge-package --test fixtures` | `native/crates/simforge-package/tests/fixtures.rs`, `fixtures/scenario-package/` (`expectations.json`) |
| Round trips | Every archive-corpus trace and document, packaged thin and full on the committed Richmond closure, is written, read back and verified; the writer refuses what the reader would | `tests/round_trip.rs` |
| Schema agreement | `contracts/scenario-package/*.schema.json` agree with the typed reader | `tests/schema.rs` |
| Release smoke | The thin release smoke package names the public Richmond release and actor closure, and verifies | `tests/smoke.rs`, `fixtures/scenario-package/smoke/` |
| CLI | `simforge package inspect \| verify \| import` exit codes and reports | `native/crates/simforge-cli/tests/package.rs` |
| Replay | A workspace laid out as an import writes it re-simulates to its packaged trace under the same engine | `native/crates/simforge-cli/tests/simulate.rs` |
| Render | The release smoke package has a lavapipe golden scene (`package-smoke-richmond`), gated once recorded | `qualification/golden-harness/` |

## 12. Open questions

1. **Newer sampler.** Refuse (as specified), or accept and render with a
   timeline the reader derives from the trace with its own sampler? Poses x,
   y and heading are identical either way; z, pitch, roll and lights may
   differ.
2. **Signatures.** Which scheme, when we add them: keyless signing tied to a
   workspace identity, or a per-installation Ed25519 key?
