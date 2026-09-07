import { pathToFileURL } from "node:url";
import { z } from "zod";
import { queryRows } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { readLocalObject } from "@/app/lib/s3/s3-object";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedGetUrl,
  getMapArtifactDownloadUrl,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";
import { ensureLocalMap } from "@/app/lib/cloud/maps";
import {
  NATIVE_ACTOR_ASSETS_INPUT_ID,
  NativeRenderManifestSchema,
  NativeRunDiagnosticsSchema,
  actorAssetsClosureUrl,
  nativeActorAssetsInput,
  nativeEvidenceFailure,
  nativeMapMemberInputId,
  nativeRunExpectations,
  resolveActorAssets,
  type NativeRunDiagnostics,
} from "@simforge-oss/render/native";
import { RENDER_INTENT_V1_SCHEMA, parseRenderIntent } from "@simforge-oss/scenario";
import { simforgeEnv } from "@/lib/simforge-env";
import { canonicalJsonSha256, sha256, scenarioId } from "../core";
import {
  RenderArtifactIdentitySchema,
  RenderProgressRecordSchema,
  ScenarioRenderIntentSchema,
  type RenderArtifactIdentity,
  type RenderProgressRecord,
} from "../render-wire-contracts";
import type { JobTransaction } from "./lifecycle-lock";

/**
 * The local native (Bevy) render lane.
 *
 * A `full_render` job with `renderer_engine = 'native'` is executed on this
 * machine by the local worker. Its lease is the CPU ledger
 * (`simforge.cpu_job_attempts`, family `openscenario_render`): heartbeats,
 * expiry, cancellation and retry are the same durable mechanics every other
 * local job has, and the reaper reconciles a worker that died with the GUI.
 * The registered fleet lane (`worker_leases`/`render_attempts`) is not used:
 * it pins approved fleet hardware and would be a fabricated attestation here.
 *
 * Inputs are the intent's immutable declarations: the frozen OpenSCENARIO,
 * OpenDRIVE and catalog artifacts, the pinned actor closure, and the map's
 * native closure served from the ensured local map directory
 * (`ensureLocalMap(mapVersionId, 'semantic')`) instead of a per-attempt
 * download. Outputs are identity-bound reservations verified against object
 * storage, and success is fenced on the engine's own evidence exactly as the
 * fleet lane fences it (`nativeEvidenceFailure`).
 */

export const LOCAL_NATIVE_RENDER_MODE = "native_render" as const;
const NATIVE_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
const NATIVE_MAP_RELEASE_RECEIPT = ".map-release.json";
const NATIVE_MAP_MAX_MEMBERS = 4093;

function artifactBucket() { return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts"; }

/** The claim row for a queued local native render, locked for this attempt. */
export type LocalNativeRenderSource = {
  job_family: "openscenario_render";
  job_id: string;
  workspace_id: string;
  revision_id: string;
  priority: number;
  created_at: string;
  attempt_count: number;
  map_version_id: string;
  render_intent: string;
  intent_sha256: string;
  execution_package_control_sha256: string;
  xosc_bucket: string;
  xosc_key: string;
  xosc_sha256: string;
  xosc_size: number;
  xodr_artifact_id: string;
  xodr_bucket: string;
  xodr_key: string;
  xodr_sha256: string;
  xodr_size: number;
  catalog_artifact_id: string;
  catalog_bucket: string;
  catalog_key: string;
  catalog_sha256: string;
  catalog_size: number;
};

/** SQL predicate selecting render jobs this lane executes. */
export const LOCAL_NATIVE_RENDER_JOB_FILTER = "job.job_mode = 'full_render' AND job.renderer_engine = 'native'";

/**
 * Whether this host can offer native renders to a claiming worker right now:
 * the worker declares the engine, and the host itself must be able to serve
 * the pinned actor closure (packaged directory or explicitly configured
 * origin). Without both, the leg is not added and the job stays queued
 * truthfully instead of being leased into a certain failure.
 */
export function localNativeRenderOffered(engines: readonly string[]): boolean {
  return engines.includes("native") && resolveActorAssets().state === "available";
}

export function localNativeRenderCandidateLeg(): string {
  return `SELECT 'openscenario_render'::text AS job_family, job.id AS job_id,
              job.workspace_id, job.revision_id, job.priority::int, job.created_at::text,
              job.job_mode::text AS job_mode
         FROM simforge.render_jobs job
        WHERE job.job_state = 'queued' AND job.cancel_requested_at IS NULL
          AND job.attempt_count < job.max_attempts
          AND ${LOCAL_NATIVE_RENDER_JOB_FILTER}
          AND job.request_contract_version = '${RENDER_INTENT_V1_SCHEMA}'`;
}

export async function claimLocalNativeRenderSource(tx: JobTransaction, jobId: string): Promise<LocalNativeRenderSource | null> {
  const source = await tx.queryOne<LocalNativeRenderSource>(
    `SELECT 'openscenario_render'::text AS job_family, job.id AS job_id, job.workspace_id,
            job.revision_id, job.priority::int, job.created_at::text, job.attempt_count,
            r.map_version_id, job.render_intent::text AS render_intent, job.intent_sha256,
            job.execution_package_control_sha256,
            xosc.storage_bucket AS xosc_bucket, xosc.storage_key AS xosc_key,
            xosc.sha256 AS xosc_sha256, xosc.byte_length AS xosc_size,
            xodr.id AS xodr_artifact_id, xodr.storage_bucket AS xodr_bucket, xodr.storage_key AS xodr_key,
            xodr.sha256 AS xodr_sha256, xodr.byte_length AS xodr_size,
            catalog_artifact.id AS catalog_artifact_id, catalog_artifact.storage_bucket AS catalog_bucket,
            catalog_artifact.storage_key AS catalog_key, catalog_artifact.sha256 AS catalog_sha256,
            catalog_artifact.byte_length AS catalog_size
       FROM simforge.render_jobs job
       JOIN simforge.revisions r
         ON r.id = job.revision_id AND r.workspace_id = job.workspace_id
       JOIN simforge.execution_packages ep
         ON ep.id = job.execution_package_id AND ep.workspace_id = job.workspace_id
       JOIN simforge.artifacts xosc
         ON xosc.id = ep.xosc_artifact_id AND xosc.workspace_id = ep.workspace_id
        AND xosc.artifact_state = 'available'
       JOIN simforge.artifacts xodr
         ON xodr.id = ep.xodr_artifact_id AND xodr.artifact_state = 'available'
       JOIN simforge.asset_catalog_versions catalog
         ON catalog.id = ep.asset_catalog_version_id
       JOIN simforge.artifacts catalog_artifact
         ON catalog_artifact.id = catalog.manifest_artifact_id
        AND catalog_artifact.artifact_state = 'available'
      WHERE job.id = :job_id AND job.job_state = 'queued' AND job.cancel_requested_at IS NULL
        AND job.attempt_count < job.max_attempts
        AND ${LOCAL_NATIVE_RENDER_JOB_FILTER}
        AND job.request_contract_version = :contract
      FOR UPDATE OF job SKIP LOCKED`,
    { job_id: jobId, contract: RENDER_INTENT_V1_SCHEMA },
  );
  if (!source) return null;
  await tx.execute(
    `UPDATE simforge.render_jobs
        SET job_state = 'running', attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, NOW()), updated_at = NOW(),
            failure_code = NULL, failure_detail = NULL, progress = 0, progress_detail = NULL
      WHERE id = :job_id`,
    { job_id: source.job_id },
  );
  return source;
}

type NativeMapMemberRow = {
  relative_path: string;
  sha256: string;
  byte_length: number | string;
  object_count: number | string;
};

/**
 * The map's declared native closure, exactly as the intent bound it. Members
 * are served from the ensured local directory, so no storage location is
 * handed out; the worker verifies every byte against these digests.
 */
async function declaredNativeMapMembers(mapVersionId: string, workspaceId: string) {
  const rows = await queryRows<NativeMapMemberRow>(
    `SELECT m.relative_path, b.sha256, b.byte_length, s.object_count
       FROM simforge.map_versions mv
       JOIN simforge.native_map_asset_sets s
         ON s.id = mv.native_map_asset_set_id
        AND s.workspace_id = mv.workspace_id
        AND s.map_version_id = mv.id
        AND s.asset_set_state = 'available'
        AND s.contract_version = 'simforge.native-map-asset-set.v1'
        AND s.registry_release_digest = mv.descriptor->>'registryReleaseDigest'
       JOIN simforge.native_map_asset_members m ON m.asset_set_id = s.id
       JOIN simforge.native_map_asset_blobs b
         ON b.id = m.blob_id AND b.verification_state = 'verified'
      WHERE mv.id = :map_version_id AND mv.workspace_id = :workspace_id
      ORDER BY m.relative_path`,
    { map_version_id: mapVersionId, workspace_id: workspaceId },
  );
  const expectedCount = Number(rows[0]?.object_count ?? -1);
  if (expectedCount < 1 || rows.length !== expectedCount) throw new Error("native_map_asset_set_incomplete");
  const members = rows.filter((member) => member.relative_path !== NATIVE_MAP_RELEASE_RECEIPT);
  if (!members.some((member) => member.relative_path === "master.gltf")) throw new Error("native_map_master_unavailable");
  if (members.length > NATIVE_MAP_MAX_MEMBERS) throw new Error("native_map_asset_set_too_large");
  return members.map((member) => ({
    inputId: nativeMapMemberInputId(member.relative_path),
    relativePath: member.relative_path,
    sha256: member.sha256,
    sizeBytes: Number(member.byte_length),
  }));
}

export type LocalNativeClaimPayload = {
  mode: typeof LOCAL_NATIVE_RENDER_MODE;
  engine: "native";
  intent: Record<string, unknown>;
  intentSha256: string;
  executionPackageControlSha256: string;
  attemptNumber: number;
  mapVersionId: string;
  inputs: Array<{
    inputId: string;
    relativePath: string;
    sha256: string;
    sizeBytes: number;
    download: { url: string; headers: Record<string, string> };
  }>;
  map: {
    members: Array<{ inputId: string; relativePath: string; sha256: string; sizeBytes: number }>;
  };
};

export async function localNativeClaimPayload(source: LocalNativeRenderSource): Promise<LocalNativeClaimPayload> {
  const intent = ScenarioRenderIntentSchema.parse(parseJsonObject(source.render_intent));
  if (canonicalJsonSha256(intent) !== source.intent_sha256) throw new Error("render_intent_digest_mismatch");
  const members = await declaredNativeMapMembers(source.map_version_id, source.workspace_id);
  const actorClosure = nativeActorAssetsInput();
  const actorSource = resolveActorAssets();
  if (actorSource.state !== "available") throw new Error("native_actor_assets_unavailable");
  const actorClosureUrl = actorSource.closurePath
    ? pathToFileURL(actorSource.closurePath).href
    : actorAssetsClosureUrl(actorSource.digest, actorSource.blobBaseUrl);
  const inputs: LocalNativeClaimPayload["inputs"] = [
    {
      inputId: "scenario.xosc",
      relativePath: "scenario.xosc",
      sha256: source.xosc_sha256,
      sizeBytes: Number(source.xosc_size),
      download: { url: await getPresignedGetUrl(source.xosc_key, source.xosc_bucket), headers: {} },
    },
    {
      inputId: source.xodr_artifact_id,
      relativePath: "map.xodr",
      sha256: source.xodr_sha256,
      sizeBytes: Number(source.xodr_size),
      download: { url: await getMapArtifactDownloadUrl(source.map_version_id, source.xodr_key, source.xodr_bucket, source.xodr_sha256, Number(source.xodr_size)), headers: {} },
    },
    {
      inputId: source.catalog_artifact_id,
      relativePath: "catalog-manifest.json",
      sha256: source.catalog_sha256,
      sizeBytes: Number(source.catalog_size),
      download: { url: await getPresignedGetUrl(source.catalog_key, source.catalog_bucket), headers: {} },
    },
    {
      inputId: actorClosure.inputId,
      relativePath: actorClosure.relativePath,
      sha256: actorClosure.sha256,
      sizeBytes: actorClosure.sizeBytes,
      download: { url: actorClosureUrl, headers: {} },
    },
  ];
  // The claim must present exactly the intent's declared assets: anything
  // else is a misrouted or tampered lease and is refused before the worker
  // fetches a byte.
  const declared = new Map<string, { sha256: string; sizeBytes: number }>([
    ...inputs.filter((input) => input.inputId !== "scenario.xosc").map((input) => [input.inputId, input] as const),
    ...members.map((member) => [member.inputId, member] as const),
  ]);
  if (
    declared.size !== intent.assets.length
    || !intent.assets.some((asset) => asset.assetId === NATIVE_ACTOR_ASSETS_INPUT_ID)
    || intent.assets.some((asset) => {
      const input = declared.get(asset.assetId);
      return !input || input.sha256 !== asset.sha256 || input.sizeBytes !== asset.sizeBytes;
    })
  ) {
    throw new Error("native_render_input_declaration_mismatch");
  }
  return {
    mode: LOCAL_NATIVE_RENDER_MODE,
    engine: "native",
    intent,
    intentSha256: source.intent_sha256,
    executionPackageControlSha256: source.execution_package_control_sha256,
    attemptNumber: Number(source.attempt_count) + 1,
    mapVersionId: source.map_version_id,
    inputs,
    map: { members },
  };
}

type ActiveAttempt = {
  workspace_id: string;
  attempt_number: number;
  map_version_id: string;
  revision_id: string;
  intent_sha256: string;
  render_intent: string;
  execution_package_control_sha256: string;
  cancel_requested: boolean;
};

/**
 * The fenced owner of a running local native render: an active, unexpired
 * CPU attempt with the presented fence over a running native `full_render`
 * job. `cancel_requested` is reported, not filtered, so callers can tell a
 * cancelled attempt from a lost one.
 */
async function activeAttempt(jobId: string, fence: { attemptId: string; fenceToken: string }): Promise<ActiveAttempt | null> {
  const rows = await queryRows<ActiveAttempt>(
    `SELECT job.workspace_id, attempt.attempt_number, r.map_version_id, job.revision_id,
            job.intent_sha256, job.render_intent::text AS render_intent,
            job.execution_package_control_sha256,
            (job.cancel_requested_at IS NOT NULL) AS cancel_requested
       FROM simforge.cpu_job_attempts attempt
       JOIN simforge.render_jobs job ON job.id = attempt.job_id AND job.workspace_id = attempt.workspace_id
       JOIN simforge.revisions r ON r.id = job.revision_id AND r.workspace_id = job.workspace_id
      WHERE attempt.id = :attempt_id AND attempt.job_id = :job_id
        AND attempt.job_family = 'openscenario_render'
        AND attempt.attempt_state = 'active' AND attempt.expires_at > NOW()
        AND attempt.fence_token_sha256 = :fence_token_sha256
        AND job.job_state = 'running' AND ${LOCAL_NATIVE_RENDER_JOB_FILTER}
      LIMIT 1`,
    { attempt_id: fence.attemptId, job_id: jobId, fence_token_sha256: sha256(fence.fenceToken) },
  );
  return rows[0] ?? null;
}

// Module state that must outlive a Next module reload lives on globalThis under symbol keys.
const globalRegistries = globalThis as unknown as Record<symbol, unknown>;
function globalRegistry<T>(key: symbol, create: () => T): T {
  globalRegistries[key] ??= create();
  return globalRegistries[key] as T;
}

// ── Map preparation ──────────────────────────────────────────────────────────

export type LocalNativeMapPreparation =
  | { state: "preparing"; startedAt: string }
  | { state: "ready"; directory: string; mapVersionId: string; startedAt: string; readyAt: string }
  | { state: "failed"; code: string; message: string; startedAt: string };

type PreparationEntry = { attemptId: string; controller: AbortController; status: LocalNativeMapPreparation };

/**
 * Per-attempt map preparation. Survives Next module reloads through the
 * global registry; a server restart forgets preparations, and the worker's
 * next poll simply starts one again (ensureLocalMap is idempotent).
 */
const PREPARATIONS_KEY = Symbol.for("simforge.local-native-map-preparations");
function preparations(): Map<string, PreparationEntry> {
  return globalRegistry(PREPARATIONS_KEY, () => new Map<string, PreparationEntry>());
}

function mapFailure(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "NotAuthorized") return { code: "map_not_authorized", message };
  if (error instanceof Error && error.name === "AbortError") return { code: "map_preparation_aborted", message };
  return { code: "map_preparation_failed", message: message.slice(0, 2_000) };
}

/**
 * Starts (or reports) the ensured semantic map for this attempt. The worker
 * polls while heartbeating; a lost fence aborts the preparation so a dead
 * attempt never keeps a download running on its behalf.
 */
export async function prepareLocalNativeMap(
  jobId: string,
  fence: { attemptId: string; fenceToken: string },
): Promise<LocalNativeMapPreparation | null> {
  const registry = preparations();
  const owner = await activeAttempt(jobId, fence);
  if (!owner) {
    releaseLocalNativeMap(fence.attemptId);
    return null;
  }
  const existing = registry.get(fence.attemptId);
  if (existing) return existing.status;
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const entry: PreparationEntry = { attemptId: fence.attemptId, controller, status: { state: "preparing", startedAt } };
  registry.set(fence.attemptId, entry);
  void ensureLocalMap(owner.map_version_id, "semantic", controller.signal).then(
    (ensured) => {
      entry.status = { state: "ready", directory: ensured.directory, mapVersionId: owner.map_version_id, startedAt, readyAt: new Date().toISOString() };
    },
    (error: unknown) => {
      entry.status = { state: "failed", ...mapFailure(error), startedAt };
    },
  );
  return entry.status;
}

/** Aborts and forgets an attempt's preparation; safe to call for unknown attempts. */
export function releaseLocalNativeMap(attemptId: string): void {
  const registry = preparations();
  const entry = registry.get(attemptId);
  if (!entry) return;
  registry.delete(attemptId);
  if (entry.status.state === "preparing") entry.controller.abort(new Error("local native render attempt released"));
}

// ── Progress projection ───────────────────────────────────────────────────────

const ProgressEventPayloadSchema = z.object({
  stage: z.enum(["downloading", "preparing", "rendering", "encoding", "uploading", "finalizing"]),
  completed: z.number().finite().nonnegative(),
  total: z.number().finite().positive(),
  unit: z.enum(["frames", "bytes", "items", "seconds"]),
});

function progressRatio(record: RenderProgressRecord): number | null {
  if (record.event !== "stage.progress") return null;
  const stageOffset: Record<typeof record.stage, number> = {
    downloading: 0, preparing: 0.1, rendering: 0.2, encoding: 0.75, uploading: 0.85, finalizing: 0.95,
  };
  const stageSpan: Record<typeof record.stage, number> = {
    downloading: 0.1, preparing: 0.1, rendering: 0.55, encoding: 0.1, uploading: 0.1, finalizing: 0.05,
  };
  return Math.min(0.999, stageOffset[record.stage] + stageSpan[record.stage] * record.completed / record.total);
}

/**
 * Projects a worker event onto the job's reconnect snapshot
 * (`render_jobs.progress_detail`, the record the details tab parses) so a
 * reopened GUI sees the stage a local render is actually in. Events that are
 * not progress records leave the snapshot alone.
 */
export async function projectLocalRenderProgress(
  tx: JobTransaction,
  input: { workspaceId: string; jobId: string; attemptNumber: number; sequence: number; type: string; payload: Record<string, unknown> },
): Promise<void> {
  const base = {
    schema: "simforge.render-progress/v1" as const,
    jobId: input.jobId,
    attempt: input.attemptNumber,
    sequence: input.sequence,
    timestamp: new Date().toISOString(),
  };
  let record: RenderProgressRecord;
  if (input.type === "job.started") {
    record = { ...base, event: "job.started" };
  } else if (input.type === "stage.progress") {
    const payload = ProgressEventPayloadSchema.safeParse(input.payload);
    if (!payload.success) return;
    record = RenderProgressRecordSchema.parse({ ...base, event: "stage.progress", ...payload.data });
  } else {
    return;
  }
  const ratio = progressRatio(record);
  await tx.execute(
    `UPDATE simforge.render_jobs
        SET progress_detail = CAST(:detail AS jsonb),
            progress = GREATEST(progress, COALESCE(:progress, progress)), updated_at = NOW()
      WHERE id = :job_id AND workspace_id = :workspace_id AND job_state = 'running'`,
    { detail: record, progress: ratio, job_id: input.jobId, workspace_id: input.workspaceId },
  );
}

// ── Artifact reservations ─────────────────────────────────────────────────────

function identityKey(identity: RenderArtifactIdentity): string {
  return `${identity.role}\0${identity.actorId ?? ""}\0${identity.sensorId ?? ""}\0${identity.modality ?? ""}`;
}

/**
 * The closure a native run produces: one mp4 per RGB source plus manifest,
 * trace and diagnostics. This is the engine's evidence contract
 * (`nativeEvidenceFailure`), not a per-spec selection.
 */
function expectedNativeClosure(intentValue: unknown): Set<string> {
  const intent = parseRenderIntent(intentValue);
  const expected = new Set<string>();
  for (const role of ["manifest", "trace", "diagnostics"] as const) {
    expected.add(identityKey({ role, actorId: null, sensorId: null, modality: null }));
  }
  for (const source of intent.renderSpec.sources) {
    if (source.modality !== "rgb") continue;
    expected.add(identityKey({ role: "video", actorId: source.actorId, sensorId: source.sensorId, modality: "rgb" }));
  }
  return expected;
}

export type LocalNativeReservation = {
  artifactId: string;
  upload: { url: string; method: "PUT"; headers: Readonly<Record<string, string>> };
};

export async function reserveLocalNativeArtifact(
  jobId: string,
  input: { attemptId: string; fenceToken: string; identity: RenderArtifactIdentity; sha256: string; sizeBytes: number; mediaType: string },
): Promise<LocalNativeReservation | null> {
  const owner = await activeAttempt(jobId, input);
  if (!owner || owner.cancel_requested) return null;
  const identity = RenderArtifactIdentitySchema.parse(input.identity);
  if (!expectedNativeClosure(parseJsonObject(owner.render_intent)).has(identityKey(identity))) return null;
  const artifactId = scenarioId("usart");
  const bucket = artifactBucket();
  const key = `${owner.workspace_id}/renders/${jobId}/${input.attemptId}/${artifactId}`;
  const kind = identity.actorId
    ? `${identity.role}-${identity.actorId}-${identity.sensorId}-${identity.modality}-${input.attemptId}`
    : `${identity.role}-${input.attemptId}`;
  const inserted = await queryRows<{ id: string }>(
    `INSERT INTO simforge.artifact_uploads (
       id, workspace_id, revision_id, render_job_id, render_attempt_id,
       artifact_kind, artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality,
       media_type, expected_sha256, expected_size_bytes,
       storage_bucket, storage_key, expires_at
     ) SELECT :id, job.workspace_id, job.revision_id, job.id, NULL,
              :artifact_kind, :artifact_role, :actor_id, :sensor_id, :modality,
              :media_type, :sha256, :size_bytes,
              :bucket, :key, NOW() + INTERVAL '15 minutes'
         FROM simforge.render_jobs job
        WHERE job.id = :job_id AND job.cancel_requested_at IS NULL AND job.job_state = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM simforge.artifact_uploads existing
             WHERE existing.render_job_id = job.id AND existing.artifact_kind = :artifact_kind
               AND existing.upload_state = 'reserved'
          )
     ON CONFLICT DO NOTHING RETURNING id`,
    {
      id: artifactId,
      artifact_kind: kind,
      artifact_role: identity.role,
      actor_id: identity.actorId,
      sensor_id: identity.sensorId,
      modality: identity.modality,
      media_type: input.mediaType,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      bucket,
      key,
      job_id: jobId,
    },
  );
  if (!inserted[0]) return null;
  return {
    artifactId,
    upload: {
      url: await getPresignedPutUrl(key, input.mediaType, bucket, 900, input.sha256),
      method: "PUT",
      headers: checksumBoundPutRequiredHeaders(input.mediaType, input.sha256),
    },
  };
}

// ── Completion ────────────────────────────────────────────────────────────────

type Reservation = {
  id: string;
  artifact_role: RenderArtifactIdentity["role"];
  artifact_actor_id: string | null;
  artifact_sensor_id: string | null;
  artifact_modality: RenderArtifactIdentity["modality"];
  media_type: string;
  expected_sha256: string;
  expected_size_bytes: number | string;
  storage_bucket: string;
  storage_key: string;
};

async function readReservedJson(reservation: Reservation): Promise<unknown> {
  if (Number(reservation.expected_size_bytes) > NATIVE_EVIDENCE_MAX_BYTES) throw new Error("render_evidence_too_large");
  return JSON.parse(Buffer.from(await readLocalObject(reservation.storage_bucket, reservation.storage_key)).toString("utf8"));
}

export type LocalNativeCompletionArtifact = {
  artifactId: string;
  identity: RenderArtifactIdentity;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
};

/** What {@link completeLocalNativeRender} proved; the fenced transaction records it. */
export type LocalNativeVerifiedCompletion = {
  workspaceId: string;
  evidence: NativeRunDiagnostics;
  attestation: Record<string, unknown>;
};

/**
 * Verifies every reserved upload against object storage, then the engine's
 * manifest and diagnostics against the lease and intent, and only then
 * succeeds the job inside the fenced transaction. The diagnostics become the
 * job's accepted evidence (`simforge.native-run-diagnostics/v1`), which the
 * database fence requires of every succeeded native `full_render`.
 */
export async function completeLocalNativeRender(
  jobId: string,
  input: { attemptId: string; fenceToken: string; intentSha256: string; artifacts: readonly LocalNativeCompletionArtifact[] },
): Promise<LocalNativeVerifiedCompletion | null> {
  const owner = await activeAttempt(jobId, input);
  if (!owner || owner.cancel_requested || owner.intent_sha256 !== input.intentSha256) return null;
  const intentValue = parseJsonObject(owner.render_intent);
  const expected = expectedNativeClosure(intentValue);
  const actual = new Set(input.artifacts.map((item) => identityKey(item.identity)));
  if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key))) {
    throw new Error("render_artifact_closure_mismatch");
  }
  const reservations = await queryRows<Reservation>(
    `SELECT id, artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality,
            media_type, expected_sha256, expected_size_bytes, storage_bucket, storage_key
       FROM simforge.artifact_uploads
      WHERE render_job_id = :job_id AND upload_state = 'reserved'
        AND artifact_kind LIKE :kind_suffix`,
    { job_id: jobId, kind_suffix: `%-${input.attemptId}` },
  );
  if (reservations.length !== input.artifacts.length) throw new Error("render_artifact_closure_mismatch");
  const byId = new Map(reservations.map((row) => [row.id, row]));
  for (const declared of input.artifacts) {
    const reserved = byId.get(declared.artifactId);
    const reservedIdentity = reserved
      ? RenderArtifactIdentitySchema.parse({
          role: reserved.artifact_role,
          actorId: reserved.artifact_actor_id,
          sensorId: reserved.artifact_sensor_id,
          modality: reserved.artifact_modality,
        })
      : null;
    if (!reserved || !reservedIdentity
      || reserved.expected_sha256 !== declared.sha256
      || Number(reserved.expected_size_bytes) !== declared.sizeBytes
      || reserved.media_type !== declared.mediaType
      || identityKey(reservedIdentity) !== identityKey(declared.identity)) {
      throw new Error("render_artifact_reservation_mismatch");
    }
    const object = await headS3Object(reserved.storage_key, reserved.storage_bucket);
    const checksum = object.checksumSha256 ? Buffer.from(object.checksumSha256, "base64").toString("hex") : null;
    if (object.contentLength !== declared.sizeBytes || object.contentType !== declared.mediaType || checksum !== declared.sha256) {
      throw new Error("render_artifact_verification_failed");
    }
  }
  const manifestReservation = reservations.find((item) => item.artifact_role === "manifest");
  const diagnosticsReservation = reservations.find((item) => item.artifact_role === "diagnostics");
  if (!manifestReservation || !diagnosticsReservation) throw new Error("native_artifact_evidence_incomplete");
  const diagnostics = NativeRunDiagnosticsSchema.parse(await readReservedJson(diagnosticsReservation));
  const failure = nativeEvidenceFailure(
    reservations.map((item) => ({
      role: item.artifact_role,
      actorId: item.artifact_actor_id,
      sensorId: item.artifact_sensor_id,
      mediaType: item.media_type,
      sha256: item.expected_sha256,
      sizeBytes: Number(item.expected_size_bytes),
    })),
    NativeRenderManifestSchema.parse(await readReservedJson(manifestReservation)),
    diagnostics,
    nativeRunExpectations(parseRenderIntent(intentValue), {
      intentSha256: input.intentSha256,
      executionPackageControlSha256: owner.execution_package_control_sha256,
    }),
  );
  if (failure) throw new Error(failure);
  const attestation = {
    schema: "simforge.native-render-attestation/v1",
    intentSha256: input.intentSha256,
    loweringSha256: diagnostics.loweringSha256,
    actorAssetsSha256: diagnostics.actorAssetsSha256,
    service: diagnostics.service,
    execution: { lane: "local-cpu-lease", attemptId: input.attemptId },
  };
  return { workspaceId: owner.workspace_id, evidence: diagnostics, attestation };
}

/**
 * Inside the caller's fenced job transaction (the CPU attempt row already
 * locked): registers every reserved upload as an available artifact linked
 * to the job as a render output, and succeeds the job with its evidence.
 */
export async function recordLocalNativeSuccess(
  tx: JobTransaction,
  jobId: string,
  input: { attemptId: string; intentSha256: string; artifacts: readonly LocalNativeCompletionArtifact[] },
  verified: LocalNativeVerifiedCompletion,
): Promise<void> {
  const fenced = await tx.queryOne<{ id: string }>(
    `SELECT id FROM simforge.render_jobs
      WHERE id = :job_id AND intent_sha256 = :intent_sha256 AND job_state = 'running'
        AND cancel_requested_at IS NULL AND ${LOCAL_NATIVE_RENDER_JOB_FILTER}
      FOR UPDATE`,
    { job_id: jobId, intent_sha256: input.intentSha256 },
  );
  if (!fenced) throw new Error("render_lease_fence_rejected");
  for (const declared of input.artifacts) {
    await tx.execute(
      `INSERT INTO simforge.artifacts (
         id, workspace_id, revision_id, artifact_kind, media_type,
         storage_bucket, storage_key, sha256, byte_length, artifact_state, metadata, verified_at,
         producer_job_family, producer_job_id, producer_attempt_id, provenance
       ) SELECT u.id, u.workspace_id, u.revision_id, u.artifact_kind, u.media_type,
                u.storage_bucket, u.storage_key, u.expected_sha256, u.expected_size_bytes,
                'available', jsonb_build_object('renderIdentity', jsonb_build_object(
                  'role', u.artifact_role, 'actorId', u.artifact_actor_id,
                  'sensorId', u.artifact_sensor_id, 'modality', u.artifact_modality
                )), NOW(),
                'openscenario_render', :job_id, :attempt_id, CAST(:provenance AS jsonb)
           FROM simforge.artifact_uploads u WHERE u.id = :artifact_id
       ON CONFLICT (id) DO NOTHING`,
      {
        artifact_id: declared.artifactId,
        job_id: jobId,
        attempt_id: input.attemptId,
        provenance: {
          contract: "uniscenario.artifact-provenance/v1",
          producerJobFamily: "openscenario_render",
          producerJobId: jobId,
          producerAttemptId: input.attemptId,
        },
      },
    );
    await tx.execute(
      `UPDATE simforge.artifact_uploads
          SET upload_state = 'uploaded', completed_artifact_id = :artifact_id, completed_at = NOW()
        WHERE id = :artifact_id AND render_job_id = :job_id`,
      { artifact_id: declared.artifactId, job_id: jobId },
    );
    await tx.execute(
      `INSERT INTO simforge.artifact_links (
         id, workspace_id, artifact_id, render_job_id, render_attempt_id, relationship,
         artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality
       ) VALUES (
         :id, :workspace_id, :artifact_id, :job_id, NULL, 'output',
         :role, :actor_id, :sensor_id, :modality
       ) ON CONFLICT DO NOTHING`,
      {
        id: scenarioId("usal"),
        workspace_id: verified.workspaceId,
        artifact_id: declared.artifactId,
        job_id: jobId,
        role: declared.identity.role,
        actor_id: declared.identity.actorId,
        sensor_id: declared.identity.sensorId,
        modality: declared.identity.modality,
      },
    );
  }
  await tx.execute(
    `UPDATE simforge.render_jobs
        SET job_state = 'succeeded', progress = 1, completed_at = NOW(), updated_at = NOW(),
            parity_evidence_schema = :parity_schema,
            parity_evidence = CAST(:parity_evidence AS jsonb),
            parity_accepted = TRUE,
            worker_attestation = CAST(:attestation AS jsonb)
      WHERE id = :job_id AND intent_sha256 = :intent_sha256`,
    {
      job_id: jobId,
      intent_sha256: input.intentSha256,
      parity_schema: verified.evidence.schema,
      parity_evidence: JSON.stringify(verified.evidence),
      attestation: JSON.stringify(verified.attestation),
    },
  );
}

/** Reserved uploads of an attempt that will never complete are closed so a retry starts clean. */
export async function cancelLocalNativeReservations(tx: JobTransaction, jobId: string, attemptId: string): Promise<void> {
  await tx.execute(
    `UPDATE simforge.artifact_uploads SET upload_state = 'cancelled'
      WHERE render_job_id = :job_id AND upload_state = 'reserved' AND artifact_kind LIKE :kind_suffix`,
    { job_id: jobId, kind_suffix: `%-${attemptId}` },
  );
}

// ── Worker presence ───────────────────────────────────────────────────────────

export type LocalWorkerPresence = { workerId: string; engines: readonly string[]; lastSeenAt: string };

const PRESENCE_KEY = Symbol.for("simforge.local-worker-presence");
function presence(): Map<string, LocalWorkerPresence> {
  return globalRegistry(PRESENCE_KEY, () => new Map<string, LocalWorkerPresence>());
}

/** Every claim is a liveness signal: the worker that polled most recently, per engine it offered. */
export function noteLocalWorkerPresence(workerId: string, engines: readonly string[]): void {
  presence().set(workerId, { workerId, engines, lastSeenAt: new Date().toISOString() });
}

/** Workers seen within `windowMs`; a worker that died with the GUI drops out of this list, not into "ready". */
export function liveLocalWorkers(windowMs = 15_000): LocalWorkerPresence[] {
  const cutoff = Date.now() - windowMs;
  return [...presence().values()].filter((worker) => Date.parse(worker.lastSeenAt) >= cutoff);
}
