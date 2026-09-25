import "server-only";

import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { collectGalleryCatalogIds, galleryCatalogEntry } from "@simforge-oss/studio-ui/lib/asset-gallery/catalog-entry";
import { PINNED_SUMO_RUNTIME_VERSION, PINNED_SUMO_WASM_SHA256 } from "@simforge-oss/engine/node";
import { SIMFORGE_OSS_RELEASE } from "@simforge-oss/compiler/node";
import {
  actorAssetBlobUrl,
  actorAssetsClosureUrl,
  PINNED_ACTOR_ASSETS_DIGEST,
  PINNED_ACTOR_ASSETS_SIZE_BYTES,
} from "@simforge-oss/render/native";

import { GalleryCatalogResolutionError, requireGalleryCatalogEntries } from "@/app/lib/asset-gallery/store";
import { queryOne, queryRows } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { HOST_KIND } from "@/app/lib/host/kind";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";
import { revisionMotion, SIMULATION_PIPELINE_REVISION } from "@/app/lib/scenario/sim-result-store";

import {
  ACTOR_CATALOG_PATH,
  EXECUTION_PACKAGE_CONTRACT,
  parseActorClosure,
  sha256Hex,
  type MapClosureMember,
  type ScenarioPackageSources,
} from "./compose";
import { ScenarioPackageExportError } from "./errors";

/**
 * Everything one revision's package is made of, read from this host's rows
 * and content stores and verified against the digests those rows record.
 * Nothing is simulated, derived or rebuilt here: a revision without a stored
 * simulation, render timeline or OpenSCENARIO export is refused, naming what
 * is missing, and the package is not written.
 */

const ISO = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function refuse(code: string, message: string, status = 409, detail: Record<string, unknown> = {}): never {
  throw new ScenarioPackageExportError(code, message, status, detail);
}

/** An object whose recorded length and sha256 the bytes must match. */
async function readVerified(bucket: string, key: string, expected: { sha256: string; byteLength: number | string }, what: string): Promise<Uint8Array> {
  const bytes = await getS3ObjectBytes(bucket, key).catch((error: unknown) =>
    refuse("package_member_unavailable", `${what} could not be read from the content store: ${error instanceof Error ? error.message : String(error)}`, 500),
  );
  if (bytes.byteLength !== Number(expected.byteLength) || sha256Hex(bytes) !== expected.sha256) {
    refuse("package_digest_mismatch", `${what} does not match its recorded digest`, 500);
  }
  return bytes;
}

type RevisionRow = {
  id: string;
  document_id: string;
  revision_number: number | string;
  committed_at: string;
  canonical_content: string | Record<string, unknown>;
  content_sha256: string;
  map_version_id: string | null;
  map_closure_sha256: string | null;
  asset_catalog_version_id: string | null;
  oss_release: string | null;
  title: string;
};

type ResultRow = {
  sim_key: string;
  trace_sha256: string;
  authored_trace_sha256: string;
  engine_sem_ver: string;
  solver_ver: string;
  trace_schema: string;
  resolved_input_digest: string;
  map_closure_digest: string;
  map_version_id: string;
  traffic_provider: string;
  traffic_step_key: string | null;
  engine_build: string | Record<string, unknown> | null;
  producer: string;
  storage_bucket: string;
  trace_storage_key: string;
  trace_byte_length: number | string;
  trace_gzip_sha256: string;
  resolution_storage_key: string;
  resolution_byte_length: number | string;
  resolution_sha256: string;
  traffic_artifact_id: string | null;
  ambient_provenance: string | Record<string, unknown> | null;
  timeline_key: string | null;
  timeline_sha256: string | null;
  timeline_storage_key: string | null;
  timeline_byte_length: number | string | null;
  created_at: string;
};

async function readRevision(workspaceId: string, revisionId: string): Promise<RevisionRow> {
  const row = await queryOne<RevisionRow>(
    `SELECT r.id, r.document_id, r.revision_number, ${ISO("r.created_at")} AS committed_at,
            r.canonical_content, r.content_sha256, r.map_version_id, r.map_closure_sha256,
            r.asset_catalog_version_id, r.oss_release, d.title
       FROM simforge.revisions r
       JOIN simforge.documents d ON d.id = r.document_id AND d.workspace_id = r.workspace_id
      WHERE r.workspace_id = :workspace_id AND r.id = :revision_id`,
    { workspace_id: workspaceId, revision_id: revisionId },
  );
  if (!row) refuse("revision_not_found", `revision ${revisionId} does not exist`, 404);
  if (!row.map_version_id) refuse("package_map_missing", `revision ${revisionId} is not bound to a map version`);
  return row;
}

/**
 * The result the package holds: the revision's original (commit) simulation
 * when it has one, whatever renders by default; otherwise its active result,
 * labelled as re-simulated motion. A revision with no stored simulation is refused.
 */
async function chooseResult(workspaceId: string, revisionId: string): Promise<{ simKey: string; motionSource: "original" | "resimulated" }> {
  const motion = await revisionMotion(workspaceId, revisionId);
  if (!motion) refuse("revision_not_found", `revision ${revisionId} does not exist`, 404);
  const original = motion.results.find((r) => r.origin === "commit");
  if (original) return { simKey: original.simKey, motionSource: "original" };
  const fallbackToActive = motion.active ?? null;
  if (!fallbackToActive) {
    refuse(
      "package_simulation_missing",
      `revision ${revisionId} has no stored simulation yet. Simulate it (open it in the editor, or re-simulate it on engine ${motion.currentEngineSemVer}) before exporting it for the CLI.`,
      409,
      { currentEngineSemVer: motion.currentEngineSemVer },
    );
  }
  return { simKey: fallbackToActive.simKey, motionSource: fallbackToActive.original ? "original" : "resimulated" };
}

async function readResult(workspaceId: string, simKey: string): Promise<ResultRow> {
  const row = await queryOne<ResultRow>(
    `SELECT r.sim_key, r.trace_sha256, r.authored_trace_sha256, r.engine_sem_ver, r.solver_ver, r.trace_schema,
            r.resolved_input_digest, r.map_closure_digest, r.map_version_id, r.traffic_provider, r.traffic_step_key,
            r.engine_build, r.producer, r.storage_bucket, r.trace_storage_key, r.trace_byte_length, r.trace_gzip_sha256,
            r.resolution_storage_key, r.resolution_byte_length, r.resolution_sha256, r.traffic_artifact_id,
            r.ambient_provenance, r.timeline_key, r.timeline_sha256, r.timeline_storage_key, r.timeline_byte_length,
            ${ISO("r.created_at")} AS created_at
       FROM simforge.sim_results r
      WHERE r.workspace_id = :workspace_id AND r.sim_key = :sim_key`,
    { workspace_id: workspaceId, sim_key: simKey },
  );
  if (!row) refuse("package_simulation_missing", `simulation result ${simKey} is bound to the revision but missing`, 409);
  return row;
}

function samplerNumber(version: string): number {
  const match = /^simforge\.timeline-sampler\/(\d+)$/.exec(version);
  return match ? Number(match[1]) : -1;
}

/**
 * The stored render timeline of the result's trace: the newest sampler's
 * registered timeline, else the one recorded at completion. None is refused;
 * the exporter never derives one (rendering or re-simulating the revision does).
 */
async function readTimeline(workspaceId: string, result: ResultRow): Promise<Uint8Array> {
  const rows = await queryRows<{
    timeline_sha256: string;
    byte_length: number | string;
    sampler_version: string;
    storage_bucket: string;
    storage_key: string;
    storage_encoding: "identity" | "gzip";
    stored_sha256: string;
    stored_byte_length: number | string;
  }>(
    `SELECT timeline_sha256, byte_length, sampler_version, storage_bucket, storage_key, storage_encoding,
            stored_sha256, stored_byte_length
       FROM simforge.sim_timelines
      WHERE workspace_id = :workspace_id AND trace_sha256 = :trace_sha256
      ORDER BY created_at, timeline_key`,
    { workspace_id: workspaceId, trace_sha256: result.trace_sha256 },
  );
  const best = [...rows].sort((a, b) => samplerNumber(b.sampler_version) - samplerNumber(a.sampler_version))[0];
  if (best) {
    const stored = await getS3ObjectBytes(best.storage_bucket, best.storage_key).catch((error: unknown) =>
      refuse("package_member_unavailable", `the stored render timeline could not be read: ${error instanceof Error ? error.message : String(error)}`, 500),
    );
    // A `gzip` row stores the gzip of the canonical bytes; the store may already have decoded it.
    const bytes = best.storage_encoding === "gzip" && stored[0] === 0x1f && stored[1] === 0x8b ? new Uint8Array(gunzipSync(stored)) : stored;
    if (bytes.byteLength !== Number(best.byte_length) || sha256Hex(bytes) !== best.timeline_sha256) {
      refuse("package_digest_mismatch", "the stored render timeline does not match its recorded digest", 500);
    }
    return bytes;
  }
  if (result.timeline_sha256 && result.timeline_storage_key && result.timeline_byte_length !== null) {
    return readVerified(
      result.storage_bucket,
      result.timeline_storage_key,
      { sha256: result.timeline_sha256, byteLength: result.timeline_byte_length },
      "the render timeline recorded with the simulation",
    );
  }
  return refuse(
    "package_timeline_missing",
    `simulation ${result.sim_key.slice(0, 12)} has no stored render timeline yet. Render the revision once (which builds it) before exporting it for the CLI.`,
  );
}

async function readTraffic(workspaceId: string, result: ResultRow): Promise<Uint8Array | null> {
  if (!result.traffic_artifact_id) return null;
  const artifact = await queryOne<{ storage_bucket: string; storage_key: string; sha256: string; byte_length: number | string }>(
    `SELECT storage_bucket, storage_key, sha256, byte_length FROM simforge.artifacts
      WHERE workspace_id = :workspace_id AND id = :id AND artifact_state = 'available'`,
    { workspace_id: workspaceId, id: result.traffic_artifact_id },
  );
  if (!artifact) refuse("package_member_unavailable", `the materialized traffic of simulation ${result.sim_key.slice(0, 12)} is not available`, 500);
  return readVerified(artifact.storage_bucket, artifact.storage_key, { sha256: artifact.sha256, byteLength: artifact.byte_length }, "the materialized traffic");
}

/**
 * The revision's OpenSCENARIO export derived from exactly this simulation
 * (`compileExecutionPackage`, the export job): the execution manifest names
 * the `simKey` its XOSC replays.
 */
async function readXosc(workspaceId: string, revisionId: string, simKey: string): Promise<Uint8Array> {
  const packages = await queryRows<{
    xosc_bucket: string; xosc_key: string; xosc_sha256: string; xosc_length: number | string;
    manifest_bucket: string; manifest_key: string; manifest_sha256: string; manifest_length: number | string;
  }>(
    `SELECT xosc.storage_bucket AS xosc_bucket, xosc.storage_key AS xosc_key, xosc.sha256 AS xosc_sha256,
            xosc.byte_length AS xosc_length, man.storage_bucket AS manifest_bucket, man.storage_key AS manifest_key,
            man.sha256 AS manifest_sha256, man.byte_length AS manifest_length
       FROM simforge.execution_packages ep
       JOIN simforge.artifacts xosc ON xosc.id = ep.xosc_artifact_id AND xosc.workspace_id = ep.workspace_id
        AND xosc.artifact_state = 'available'
       JOIN simforge.artifacts man ON man.id = ep.package_artifact_id AND man.workspace_id = ep.workspace_id
        AND man.artifact_state = 'available'
      WHERE ep.workspace_id = :workspace_id AND ep.revision_id = :revision_id
      ORDER BY ep.created_at DESC, ep.id`,
    { workspace_id: workspaceId, revision_id: revisionId },
  );
  for (const candidate of packages) {
    const manifest = JSON.parse(Buffer.from(await readVerified(
      candidate.manifest_bucket,
      candidate.manifest_key,
      { sha256: candidate.manifest_sha256, byteLength: candidate.manifest_length },
      "the execution package manifest",
    )).toString("utf8")) as { contract?: string; simKey?: string };
    if (manifest.contract === EXECUTION_PACKAGE_CONTRACT && manifest.simKey === simKey) {
      return readVerified(candidate.xosc_bucket, candidate.xosc_key, { sha256: candidate.xosc_sha256, byteLength: candidate.xosc_length }, "the OpenSCENARIO export");
    }
  }
  return refuse(
    "package_xosc_missing",
    `revision ${revisionId} has no OpenSCENARIO export of simulation ${simKey.slice(0, 12)} yet. Export OpenSCENARIO for it first.`,
  );
}

async function readMap(mapVersionId: string): Promise<ScenarioPackageSources["map"]> {
  const version = await queryOne<{
    id: string;
    source_map_id: string | null;
    source_map_asset_id: string | null;
    label: string;
    xodr_sha256: string;
    coordinate_system_sha256: string;
    browser_asset_set_id: string | null;
    closure_sha256: string | null;
  }>(
    `SELECT mv.id, mv.source_map_id, mv.source_map_asset_id, mv.label, mv.xodr_sha256, mv.coordinate_system_sha256,
            bs.id AS browser_asset_set_id, bs.closure_sha256
       FROM simforge.map_versions mv
       LEFT JOIN simforge.browser_asset_sets bs
         ON bs.id = mv.browser_asset_set_id AND bs.map_version_id = mv.id AND bs.asset_set_state = 'available'
      WHERE mv.id = :map_version_id`,
    { map_version_id: mapVersionId },
  );
  if (!version) refuse("package_map_missing", `map version ${mapVersionId} does not exist`, 409);
  if (!version.browser_asset_set_id || !version.closure_sha256) {
    refuse("package_map_missing", `map version ${mapVersionId} has no available browser asset closure`, 409);
  }
  const sourceMapId = version.source_map_id ?? version.source_map_asset_id;
  if (!sourceMapId) refuse("package_map_missing", `map version ${mapVersionId} records no source map`, 409);
  const members = await queryRows<{
    relative_path: string; sha256: string; byte_length: number | string; media_type: string;
    role: MapClosureMember["role"]; required: boolean;
  }>(
    `SELECT m.relative_path, b.sha256, b.byte_length, b.media_type, m.role, m.required
       FROM simforge.browser_asset_members m
       JOIN simforge.browser_asset_blobs b ON b.id = m.blob_id
      WHERE m.asset_set_id = :asset_set_id
      ORDER BY m.relative_path COLLATE "C"`,
    { asset_set_id: version.browser_asset_set_id },
  );
  return {
    mapVersionId: version.id,
    sourceMapId,
    label: version.label,
    xodrSha256: version.xodr_sha256,
    coordinateSystemSha256: version.coordinate_system_sha256,
    browserClosureSha256: version.closure_sha256,
    members: members.map((m) => ({
      relativePath: m.relative_path,
      sha256: m.sha256,
      byteLength: Number(m.byte_length),
      mediaType: m.media_type,
      role: m.role,
      required: m.required === true || (m.required as unknown) === "true",
    })),
  };
}

/** Immutable, content-addressed: fetched once per process. */
const actorBytes = new Map<string, Promise<Uint8Array>>();

/** One actor-closure object from the configured actor origin, verified by digest. */
export function fetchActorObject(url: string, expected: { sha256: string; bytes: number }): Promise<Uint8Array> {
  const cached = actorBytes.get(expected.sha256);
  if (cached) return cached;
  const loading = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      refuse("package_actor_assets_missing", `the actor asset ${expected.sha256.slice(0, 12)} is not available from the actor origin (${response.status})`, 502);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== expected.bytes || sha256Hex(bytes) !== expected.sha256) {
      refuse("package_digest_mismatch", `the actor origin served other bytes for ${expected.sha256.slice(0, 12)}`, 502);
    }
    return bytes;
  })();
  actorBytes.set(expected.sha256, loading);
  loading.catch(() => { if (actorBytes.get(expected.sha256) === loading) actorBytes.delete(expected.sha256); });
  return loading;
}

async function readActors(): Promise<ScenarioPackageSources["actors"]> {
  const closure = await fetchActorObject(actorAssetsClosureUrl(PINNED_ACTOR_ASSETS_DIGEST), {
    sha256: PINNED_ACTOR_ASSETS_DIGEST,
    bytes: PINNED_ACTOR_ASSETS_SIZE_BYTES,
  });
  const entry = parseActorClosure(closure).members[ACTOR_CATALOG_PATH]!;
  const catalogModels = await fetchActorObject(actorAssetBlobUrl(entry.sha256), { sha256: entry.sha256, bytes: entry.bytes });
  return { closure, catalogModels };
}

async function readCatalogEntries(content: Record<string, unknown>): Promise<unknown[]> {
  try {
    const entries = await requireGalleryCatalogEntries(collectGalleryCatalogIds(content));
    return entries.map(galleryCatalogEntry);
  } catch (error) {
    if (error instanceof GalleryCatalogResolutionError) {
      refuse(error.code, error.message, 422, { missing: error.missing });
    }
    throw error;
  }
}

function sumoRuntime(result: ResultRow): ScenarioPackageSources["sumo"] {
  if (result.traffic_provider !== "sumo") return null;
  const ambient = parseJsonObject(result.ambient_provenance as never);
  if (ambient.sumoVersion !== PINNED_SUMO_RUNTIME_VERSION) {
    // The wasm digest is recorded per runtime version only for the pinned one.
    refuse(
      "package_sumo_provenance_missing",
      `simulation ${result.sim_key.slice(0, 12)} ran SUMO ${String(ambient.sumoVersion ?? "(unrecorded)")}; this exporter can state the runtime digest of ${PINNED_SUMO_RUNTIME_VERSION} only`,
      409,
    );
  }
  return { runtimeVersion: PINNED_SUMO_RUNTIME_VERSION, wasmSha256: PINNED_SUMO_WASM_SHA256 };
}

/**
 * `provenance.installationId`: a random, opaque UUID generated once per
 * installation (one database) and never derived from a host, bucket or tenant.
 */
export async function installationId(): Promise<string> {
  await queryRows(
    `INSERT INTO simforge.installation_identity (singleton, installation_id) VALUES (TRUE, :id)
     ON CONFLICT (singleton) DO NOTHING`,
    { id: randomUUID() },
  );
  const row = await queryOne<{ installation_id: string }>(`SELECT installation_id::text AS installation_id FROM simforge.installation_identity WHERE singleton`);
  if (!row) refuse("package_installation_unidentified", "this installation has no identity row", 500);
  return row.installation_id.toLowerCase();
}

export async function readRevisionPackageSources(workspaceId: string, revisionId: string): Promise<ScenarioPackageSources> {
  const revision = await readRevision(workspaceId, revisionId);
  const { simKey, motionSource } = await chooseResult(workspaceId, revisionId);
  const result = await readResult(workspaceId, simKey);
  if (result.map_version_id !== revision.map_version_id) {
    refuse(
      "package_identity_mismatch",
      `simulation ${simKey.slice(0, 12)} ran on map version ${result.map_version_id}, the revision is bound to ${revision.map_version_id}`,
      500,
    );
  }
  const content = parseJsonObject(revision.canonical_content);
  // What the revision must already have, in the order a user fixes it: a
  // simulation (above), its render timeline, its OpenSCENARIO export. Checked
  // before any content is fetched, so the refusal names the first gap.
  const timeline = await readTimeline(workspaceId, result);
  const xosc = await readXosc(workspaceId, revisionId, simKey);
  const [traceGzip, resolutionGzip, traffic, map, actors, catalogEntries, installation] = await Promise.all([
    readVerified(result.storage_bucket, result.trace_storage_key, { sha256: result.trace_gzip_sha256, byteLength: result.trace_byte_length }, "the stored trace"),
    readVerified(result.storage_bucket, result.resolution_storage_key, { sha256: result.resolution_sha256, byteLength: result.resolution_byte_length }, "the stored resolution record"),
    readTraffic(workspaceId, result),
    readMap(revision.map_version_id!),
    readActors(),
    readCatalogEntries(content),
    installationId(),
  ]);
  return {
    motionSource,
    revision: {
      id: revision.id,
      documentId: revision.document_id,
      revisionNumber: Number(revision.revision_number),
      committedAt: revision.committed_at,
      title: revision.title,
      content,
      storedContentSha256: revision.content_sha256,
      assetCatalogVersionId: revision.asset_catalog_version_id,
      mapClosureSha256: revision.map_closure_sha256,
      ossRelease: revision.oss_release,
    },
    result: {
      simKey: result.sim_key,
      traceSha256: result.trace_sha256,
      authoredTraceSha256: result.authored_trace_sha256,
      traceGzipSha256: result.trace_gzip_sha256,
      engineSemVer: result.engine_sem_ver,
      solverVer: result.solver_ver,
      traceSchema: result.trace_schema,
      resolvedInputDigest: result.resolved_input_digest,
      resolutionSha256: result.resolution_sha256,
      mapClosureDigest: result.map_closure_digest,
      mapVersionId: result.map_version_id,
      trafficProvider: result.traffic_provider,
      trafficStepKey: result.traffic_step_key,
      engineBuild: parseJsonObject(result.engine_build as never),
      producer: result.producer,
      createdAt: result.created_at,
      ambientProvenance: parseJsonObject(result.ambient_provenance as never),
    },
    traceGzip,
    resolutionGzip,
    traffic,
    timeline,
    map,
    actors,
    catalogEntries,
    xosc,
    sumo: sumoRuntime(result),
    pipelineRevision: SIMULATION_PIPELINE_REVISION,
    installation: { kind: HOST_KIND === "cloud" ? "simcloud" : "local-studio", id: installation },
    appVersion: SIMFORGE_OSS_RELEASE,
  };
}
