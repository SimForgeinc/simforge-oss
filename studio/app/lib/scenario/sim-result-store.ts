import "server-only";

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import {
  collectGalleryCatalogIds,
  galleryCatalogEntry,
} from "@simforge-oss/studio-ui/lib/asset-gallery/catalog-entry";
import {
  engineBuildProvenance,
  engineSemantics,
  hostTrafficStep,
  SIMULATION_RESOLUTION_MEDIA_TYPE,
  SUMO_RUNTIME_FILES,
  SUMO_RUNTIME_OBJECT_PREFIX,
  sumoStepIdentity,
  SIMULATION_TRACE_MEDIA_TYPE,
  simulateAuthoritative,
  simulationCompletion,
  type AuthoritativeSimulation,
  type SimulationCompletionRecord,
  type SimulationMapClosure,
  type SimulationTimeline,
} from "@simforge-oss/compiler/node";
import type {
  ScenarioSimulationResultDto,
  ScenarioSimulationStatusDto,
  ScenarioSimulationTrafficProvider,
} from "@simforge-oss/studio-host";

import { resolveGalleryCatalogIds } from "@/app/lib/asset-gallery/store";
import { queryOne, queryRows, withTransaction, type Transaction } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { getPresignedGetUrl, getPresignedPutUrl, headS3Object } from "@/app/lib/s3/s3-presign";
import { putS3Object } from "@/app/lib/s3/s3-put-object";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";
import { SUMO_RUNTIME_BUCKET } from "@/app/lib/s3/s3-config";
import { evaluateTrace, type EvaluateFilters, type TraceEvaluation } from "@simforge-oss/engine/node";
import { simforgeEnv } from "@/lib/simforge-env";

import { simContentHash } from "@simforge-oss/scenario";
import { canonicalJsonSha256, scenarioId, sha256 } from "./core";
import { createLocalArtifactProducer } from "./jobs/local-artifact-producer-store";
import {
  loadServerSimulationClosure,
  readServerMapMember,
  readSimulationMapIdentity,
  serverSumoRuntime,
  type SimulationMapIdentity,
} from "./sim-closure.server";

/**
 * Worker-authoritative, content-addressed simulation.
 *
 * `sim_requests` is the unit of work and the in-flight join. A request key
 * names *what* to simulate (content digest, map version and closure, gallery
 * catalog, engine semantics, pipeline). The first caller inserts the row with
 * `ON CONFLICT DO NOTHING`; whoever claims it (this host inline, or a CPU
 * runner through `/internal/sim-jobs`) executes under a fenced lease, and
 * every other caller waits on that same row. An expired lease is claimable
 * again, so a host that dies mid-run never strands the request.
 *
 * `sim_results` is the immutable memo keyed by `sim_key`. Two requests that
 * resolve to the same input share one result (`ON CONFLICT (sim_key) DO
 * NOTHING`); a second producer whose trace differs under the same key is a
 * determinism violation, recorded and never allowed to replace the original.
 */

/** Bump when the TypeScript half of the pipeline changes what a request resolves to. */
export const SIMULATION_PIPELINE_REVISION = 2;
const REQUEST_CONTRACT = "simforge.sim-request/v1";
const RESOLUTION_MEDIA_TYPE = SIMULATION_RESOLUTION_MEDIA_TYPE;
const MATERIALIZED_TRAFFIC_MEDIA_TYPE = "application/vnd.uniscenarios.materialized-traffic+json";
const TIMELINE_MEDIA_TYPE = "application/vnd.simforge.render-timeline+json";
const INLINE_LEASE_SECONDS = 120;
const POLL_INTERVAL_MS = 300;

export class SimulationFailedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SimulationFailedError";
  }
}

function artifactBucket() {
  return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts";
}

/** Inline execution is the fast path; `SIMFORGE_SIMULATION_INLINE=0` routes every request to the CPU runner. */
export function inlineSimulationEnabled(): boolean {
  return (simforgeEnv("SIMULATION_INLINE") ?? "1").trim() !== "0";
}

function inlineProducer(): string {
  return `inline:${hostname()}:${process.pid}`.slice(0, 200);
}

export type SimulationSubject = {
  workspaceId: string;
  userId: string | null;
  canonicalContent: unknown;
  contentSha256: string;
  mapVersionId: string;
};

type RequestIdentity = {
  requestKey: string;
  map: SimulationMapIdentity;
  catalogSha256: string;
  engineSemVer: string;
};

async function catalogEntriesFor(content: unknown) {
  const gallery = await resolveGalleryCatalogIds(collectGalleryCatalogIds(content as Record<string, unknown>));
  return gallery.entries.map(galleryCatalogEntry);
}

async function requestIdentity(subject: SimulationSubject): Promise<RequestIdentity & { catalogEntries: Awaited<ReturnType<typeof catalogEntriesFor>> }> {
  const map = await readSimulationMapIdentity(subject.mapVersionId);
  const catalogEntries = await catalogEntriesFor(subject.canonicalContent);
  const catalogSha256 = canonicalJsonSha256(catalogEntries);
  const { engineSemVer } = engineSemantics();
  const build = engineBuildProvenance();
  const requestKey = canonicalJsonSha256({
    contract: REQUEST_CONTRACT,
    // Simulation-relevant content only (WS-A `simContentHash`): a rename, a
    // description edit or a save timestamp resolves to the same request.
    simContentSha256: simContentHash(subject.canonicalContent),
    mapVersionId: map.mapVersionId,
    browserClosureSha256: map.browserClosureSha256,
    catalogSha256,
    engineSemVer,
    // The request key is a memo of what a request resolves to, not an identity:
    // a new engine build or pipeline revision re-resolves once and then dedupes
    // into the same `sim_key` whenever the semantics did not change.
    engineBuild: build.addonSha256 ?? `${build.engineVersion}:${build.abiVersion}`,
    pipeline: SIMULATION_PIPELINE_REVISION,
    // SUMO documents: the network and the pinned runtime their traffic step runs.
    sumo: sumoStepIdentity(subject.canonicalContent, map.sumoNetworkSha256),
  });
  return { requestKey, map, catalogSha256, engineSemVer, catalogEntries };
}

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
  traffic_provider: ScenarioSimulationTrafficProvider;
  storage_bucket: string;
  trace_storage_key: string;
  trace_byte_length: number | string;
  trace_gzip_sha256: string;
  resolution_storage_key: string;
  resolution_byte_length: number | string;
  resolution_sha256: string;
  traffic_artifact_id: string | null;
  ambient_provenance: unknown;
  timeline_sha256: string | null;
  timeline_byte_length: number | string | null;
  producer: string;
  created_at: string;
};

const RESULT_COLUMNS = `r.sim_key, r.trace_sha256, r.authored_trace_sha256, r.engine_sem_ver, r.solver_ver,
  r.trace_schema, r.resolved_input_digest, r.map_closure_digest, r.map_version_id, r.traffic_provider,
  r.storage_bucket, r.trace_storage_key, r.trace_byte_length, r.trace_gzip_sha256,
  r.resolution_storage_key, r.resolution_byte_length, r.resolution_sha256,
  r.traffic_artifact_id, r.ambient_provenance, r.timeline_sha256, r.timeline_byte_length, r.producer,
  r.created_at::text AS created_at`;

async function resultDto(row: ResultRow): Promise<ScenarioSimulationResultDto> {
  return {
    simKey: row.sim_key,
    traceSha256: row.trace_sha256,
    authoredTraceSha256: row.authored_trace_sha256,
    engineSemVer: row.engine_sem_ver,
    solverVer: row.solver_ver,
    traceSchema: row.trace_schema,
    resolvedInputDigest: row.resolved_input_digest,
    mapClosureDigest: row.map_closure_digest,
    mapVersionId: row.map_version_id,
    trafficProvider: row.traffic_provider,
    trace: {
      mediaType: SIMULATION_TRACE_MEDIA_TYPE,
      sizeBytes: Number(row.trace_byte_length),
      gzipSha256: row.trace_gzip_sha256,
      downloadUrl: await getPresignedGetUrl(
        row.trace_storage_key,
        row.storage_bucket,
        undefined,
        undefined,
        "private, max-age=31536000, immutable",
      ),
    },
    resolution: {
      sizeBytes: Number(row.resolution_byte_length),
      sha256: row.resolution_sha256,
      downloadUrl: await getPresignedGetUrl(
        row.resolution_storage_key,
        row.storage_bucket,
        undefined,
        undefined,
        "private, max-age=31536000, immutable",
      ),
    },
    timelineSha256: row.timeline_sha256,
    timelineSizeBytes: row.timeline_byte_length === null ? null : Number(row.timeline_byte_length),
    producer: row.producer,
    createdAt: row.created_at,
  };
}

/** One authoritative result by key, within the workspace. */
export async function getSimulationResult(workspaceId: string, simKey: string): Promise<ScenarioSimulationResultDto | null> {
  const row = await queryOne<ResultRow>(
    `SELECT ${RESULT_COLUMNS} FROM simforge.sim_results r WHERE r.workspace_id = :workspace_id AND r.sim_key = :sim_key`,
    { workspace_id: workspaceId, sim_key: simKey },
  );
  return row ? resultDto(row) : null;
}

/** The server-side record of one result, for the export and revision binding. */
export async function readSimulationRecord(workspaceId: string, simKey: string, tx?: Transaction): Promise<ResultRow | null> {
  const sql = `SELECT ${RESULT_COLUMNS} FROM simforge.sim_results r WHERE r.workspace_id = :workspace_id AND r.sim_key = :sim_key`;
  const params = { workspace_id: workspaceId, sim_key: simKey };
  return tx ? tx.queryOne<ResultRow>(sql, params) : queryOne<ResultRow>(sql, params);
}

type RequestRow = {
  request_key: string;
  request_state: "queued" | "running" | "succeeded" | "failed";
  sim_key: string | null;
  failure_code: string | null;
  failure_detail: unknown;
  lease_expires_at: string | null;
  attempt_count: number;
  max_attempts: number;
};

async function readRequest(workspaceId: string, requestKey: string): Promise<RequestRow | null> {
  return queryOne<RequestRow>(
    `SELECT request_key, request_state, sim_key, failure_code, failure_detail,
            lease_expires_at::text AS lease_expires_at, attempt_count, max_attempts
       FROM simforge.sim_requests WHERE workspace_id = :workspace_id AND request_key = :request_key`,
    { workspace_id: workspaceId, request_key: requestKey },
  );
}

async function statusOf(workspaceId: string, request: RequestRow): Promise<ScenarioSimulationStatusDto> {
  if (request.request_state === "succeeded" && request.sim_key) {
    const result = await getSimulationResult(workspaceId, request.sim_key);
    if (result) return { state: "succeeded", requestKey: request.request_key, result };
  }
  if (request.request_state === "failed") {
    const detail = parseJsonObject(request.failure_detail as string | Record<string, unknown> | null) ?? {};
    return {
      state: "failed",
      requestKey: request.request_key,
      failureCode: request.failure_code ?? "simulation_failed",
      message: typeof detail.message === "string" ? detail.message : null,
    };
  }
  return { state: request.request_state === "running" ? "running" : "queued", requestKey: request.request_key };
}

/**
 * Claim one request for execution: a queued row, or a running row whose lease
 * expired. The fence token authorizes the completion; a stale executor's
 * completion is refused because its fence no longer matches.
 */
async function claimRequest(
  workspaceId: string,
  requestKey: string,
  owner: string,
  leaseSeconds: number,
): Promise<{ fenceToken: string } | null> {
  const fenceToken = randomBytes(32).toString("hex");
  const row = await queryOne<{ request_key: string }>(
    `UPDATE simforge.sim_requests
        SET request_state = 'running', lease_owner = :owner, fence_token_sha256 = :fence,
            lease_expires_at = NOW() + (:lease_seconds * INTERVAL '1 second'),
            attempt_count = attempt_count + 1, updated_at = NOW(),
            failure_code = NULL, failure_detail = NULL
      WHERE workspace_id = :workspace_id AND request_key = :request_key
        AND attempt_count < max_attempts
        AND (request_state = 'queued' OR (request_state = 'running' AND lease_expires_at < NOW()))
      RETURNING request_key`,
    { workspace_id: workspaceId, request_key: requestKey, owner, fence: sha256(fenceToken), lease_seconds: leaseSeconds },
  );
  return row ? { fenceToken } : null;
}

/** Everything a completion carries, whoever executed it (shared with the CPU runner via `@simforge-oss/compiler/node`). */
export type SimulationCompletion = Omit<SimulationCompletionRecord, "trafficProvider"> & {
  trafficProvider: ScenarioSimulationTrafficProvider;
};

export function simulationObjectKeys(workspaceId: string, completion: Pick<SimulationCompletion, "traceSha256" | "resolution" | "traffic" | "timeline">) {
  return {
    trace: `${workspaceId}/sim/sha256/${completion.traceSha256}.trace.json.gz`,
    resolution: `${workspaceId}/sim/resolution/sha256/${completion.resolution.sha256}.json.gz`,
    traffic: completion.traffic ? `${workspaceId}/materialized-traffic/sha256/${completion.traffic.sha256}.json` : null,
    // Uncompressed canonical JSON: sha256(object) is exactly `timelineSha256`.
    timeline: completion.timeline ? `${workspaceId}/timelines/sha256/${completion.timeline.timelineSha256}.json` : null,
  };
}

/**
 * The render timeline step (WS-B): trace + the map's height source → the
 * canonical timeline every renderer samples. Best effort: a render without it
 * falls back to the XOSC, so a failure here never fails the simulation.
 */
export async function buildSimulationTimeline(
  simulation: AuthoritativeSimulation,
  closure: Pick<SimulationMapClosure, "xodr" | "topology">,
): Promise<SimulationTimeline | null> {
  try {
    const { buildRenderTimeline } = await import("@simforge-oss/render/timeline");
    return await buildRenderTimeline({
      trace: simulation.trace,
      xodr: closure.xodr,
      topology: closure.topology,
      catalogDigest: null,
    });
  } catch (error) {
    console.warn(`[simulation] render timeline for ${simulation.simKey} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The completed producer job a server-derived traffic artifact is attributed
 * to. Created before the result transaction: it runs its own transaction, and
 * a single-connection host (PGlite) serializes the two.
 */
async function trafficProducerJob(
  workspaceId: string,
  userId: string | null,
  mapVersion: SimulationMapIdentity,
  completion: SimulationCompletion,
): Promise<string | null> {
  const traffic = completion.traffic;
  if (!traffic) return null;
  return createLocalArtifactProducer({
    workspaceId,
    requestedByUserId: userId,
    operation: "materialize_traffic",
    artifactKind: "materialized-traffic",
    artifactSha256: traffic.sha256,
    // Server-derived from the authoritative trace, so it is complete the moment it exists.
    completed: true,
    idempotencyKey: `simulation-traffic:${traffic.sha256}`,
    requestPayload: {
      simKey: completion.simKey,
      sourceInputDigest: traffic.sourceInputDigest,
      mapVersionId: mapVersion.mapVersionId,
      producer: "authoritative-simulation",
    },
  });
}

async function registerTrafficArtifact(
  tx: Transaction,
  workspaceId: string,
  mapVersion: SimulationMapIdentity,
  completion: SimulationCompletion,
  storageKey: string,
  producerJobId: string | null,
): Promise<string | null> {
  const traffic = completion.traffic;
  if (!traffic || !producerJobId) return null;
  const row = await tx.queryOne<{ id: string }>(
    `INSERT INTO simforge.artifacts (
       id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
       sha256, byte_length, artifact_state, verified_at, metadata,
       producer_job_family, producer_job_id, provenance
     ) VALUES (
       :id, :workspace_id, 'materialized-traffic', :media_type, :bucket, :storage_key,
       :sha256, :size_bytes, 'available', NOW(), CAST(:metadata AS jsonb),
       'artifact_postprocess', :producer_job_id, CAST(:provenance AS jsonb)
     ) ON CONFLICT (workspace_id, sha256, artifact_kind)
       WHERE artifact_state IN ('pending', 'available') AND deleted_at IS NULL
     DO UPDATE SET metadata = simforge.artifacts.metadata
     RETURNING id`,
    {
      id: scenarioId("usart"),
      workspace_id: workspaceId,
      media_type: MATERIALIZED_TRAFFIC_MEDIA_TYPE,
      bucket: artifactBucket(),
      storage_key: storageKey,
      sha256: traffic.sha256,
      size_bytes: traffic.sizeBytes,
      metadata: {
        simKey: completion.simKey,
        sourceInputDigest: traffic.sourceInputDigest,
        mapAssetId: mapVersion.mapAssetId,
        mapVersionId: mapVersion.mapVersionId,
      },
      producer_job_id: producerJobId,
      provenance: {
        contract: "uniscenario.artifact-provenance/v1",
        producerJobFamily: "artifact_postprocess",
        producerJobId,
        operation: "materialize_traffic",
        simKey: completion.simKey,
        sourceInputDigest: traffic.sourceInputDigest,
      },
    },
  );
  if (!row) throw new Error("simulation_traffic_registration_failed");
  return row.id;
}

/**
 * Finalize an executed request. The objects must already be stored at their
 * content keys; this verifies them, registers the traffic artifact, inserts
 * the immutable result (or joins an existing one under the same key) and
 * closes the request under its fence.
 */
export async function completeSimulationRequest(input: {
  workspaceId: string;
  userId: string | null;
  requestKey: string;
  fenceToken: string;
  producer: string;
  completion: SimulationCompletion;
  verifyObjects?: boolean;
}): Promise<{ simKey: string; determinismViolation: boolean }> {
  const { workspaceId, completion } = input;
  const request = await queryOne<{ map_version_id: string; fence_token_sha256: string | null; request_state: string }>(
    `SELECT map_version_id, fence_token_sha256, request_state FROM simforge.sim_requests
      WHERE workspace_id = :workspace_id AND request_key = :request_key`,
    { workspace_id: workspaceId, request_key: input.requestKey },
  );
  if (!request || request.request_state !== "running" || request.fence_token_sha256 !== sha256(input.fenceToken)) {
    throw new SimulationFailedError("simulation_lease_lost", "The simulation request is no longer held by this executor.");
  }
  const map = await readSimulationMapIdentity(request.map_version_id);
  const keys = simulationObjectKeys(workspaceId, completion);
  const bucket = artifactBucket();
  if (input.verifyObjects !== false) {
    for (const [key, expected] of [
      [keys.trace, completion.trace],
      [keys.resolution, completion.resolution],
      ...(keys.traffic && completion.traffic ? [[keys.traffic, completion.traffic] as const] : []),
      ...(keys.timeline && completion.timeline
        ? [[keys.timeline, { sha256: completion.timeline.timelineSha256, sizeBytes: completion.timeline.sizeBytes }] as const]
        : []),
    ] as const) {
      const head = await headS3Object(key, bucket);
      const checksum = head.checksumSha256 ? Buffer.from(head.checksumSha256, "base64").toString("hex") : null;
      if (head.contentLength !== expected.sizeBytes || (checksum !== null && checksum !== expected.sha256)) {
        throw new SimulationFailedError("simulation_object_mismatch", `stored object ${key} does not match its declared digest`);
      }
    }
  }
  const producerJobId = await trafficProducerJob(workspaceId, input.userId, map, completion);
  return withTransaction(async (tx) => {
    const trafficArtifactId = await registerTrafficArtifact(tx, workspaceId, map, completion, keys.traffic ?? "", producerJobId);
    const inserted = await tx.queryOne<{ sim_key: string }>(
      `INSERT INTO simforge.sim_results (
         workspace_id, sim_key, trace_sha256, authored_trace_sha256, engine_sem_ver, solver_ver, trace_schema,
         resolved_input_digest, map_closure_digest, traffic_step_key, traffic_provider, map_version_id,
         engine_build, producer, storage_bucket, trace_storage_key, trace_byte_length, trace_gzip_sha256,
         resolution_storage_key, resolution_byte_length, resolution_sha256, traffic_artifact_id,
         ambient_provenance, metrics, timeline_key, timeline_sha256, timeline_storage_key, timeline_byte_length
       ) VALUES (
         :workspace_id, :sim_key, :trace_sha256, :authored_trace_sha256, :engine_sem_ver, :solver_ver, :trace_schema,
         :resolved_input_digest, :map_closure_digest, :traffic_step_key, :traffic_provider, :map_version_id,
         CAST(:engine_build AS jsonb), :producer, :bucket, :trace_key, :trace_size, :trace_gzip_sha256,
         :resolution_key, :resolution_size, :resolution_sha256, :traffic_artifact_id,
         CAST(:ambient AS jsonb), CAST(:metrics AS jsonb), :timeline_key, :timeline_sha256, :timeline_storage_key,
         :timeline_byte_length
       ) ON CONFLICT (workspace_id, sim_key) DO NOTHING
       RETURNING sim_key`,
      {
        workspace_id: workspaceId,
        sim_key: completion.simKey,
        trace_sha256: completion.traceSha256,
        authored_trace_sha256: completion.authoredTraceSha256,
        engine_sem_ver: completion.engineSemVer,
        solver_ver: completion.solverVer,
        trace_schema: completion.traceSchema,
        resolved_input_digest: completion.resolvedInputDigest,
        map_closure_digest: completion.mapClosureDigest,
        traffic_step_key: completion.trafficStepKey,
        traffic_provider: completion.trafficProvider,
        map_version_id: map.mapVersionId,
        engine_build: completion.engineBuild,
        producer: input.producer,
        bucket,
        trace_key: keys.trace,
        trace_size: completion.trace.sizeBytes,
        trace_gzip_sha256: completion.trace.sha256,
        resolution_key: keys.resolution,
        resolution_size: completion.resolution.sizeBytes,
        resolution_sha256: completion.resolution.sha256,
        traffic_artifact_id: trafficArtifactId,
        ambient: completion.traffic?.ambient ?? null,
        metrics: completion.metrics,
        timeline_key: completion.timeline?.timelineKey ?? null,
        timeline_sha256: completion.timeline?.timelineSha256 ?? null,
        timeline_storage_key: keys.timeline,
        timeline_byte_length: completion.timeline?.sizeBytes ?? null,
      },
    );
    let determinismViolation = false;
    if (!inserted) {
      const existing = await tx.queryOne<{ trace_sha256: string }>(
        `SELECT trace_sha256 FROM simforge.sim_results WHERE workspace_id = :workspace_id AND sim_key = :sim_key`,
        { workspace_id: workspaceId, sim_key: completion.simKey },
      );
      if (existing && existing.trace_sha256 !== completion.traceSha256) {
        // Same key, different trace: the engine is not a function of its key.
        // The original stays authoritative; this is evidence of a bug.
        determinismViolation = true;
        await tx.execute(
          `INSERT INTO simforge.sim_verification_events (
             id, workspace_id, sim_key, document_id, outcome, local_trace_sha256, authoritative_trace_sha256,
             local_runtime, created_by_user_id
           ) VALUES (:id, :workspace_id, :sim_key, NULL, 'mismatch', :local, :authoritative, CAST(:runtime AS jsonb), :user_id)`,
          {
            id: scenarioId("ussv"),
            workspace_id: workspaceId,
            sim_key: completion.simKey,
            local: completion.traceSha256,
            authoritative: existing.trace_sha256,
            runtime: { producer: input.producer, source: "authority-rerun", ...completion.engineBuild },
            user_id: input.userId,
          },
        );
        console.error(`[simulation] determinism violation: sim_key ${completion.simKey} produced trace ${completion.traceSha256}, stored ${existing.trace_sha256} (producer ${input.producer})`);
      }
    }
    const closed = await tx.queryOne<{ request_key: string }>(
      `UPDATE simforge.sim_requests
          SET request_state = 'succeeded', sim_key = :sim_key, completed_at = NOW(), updated_at = NOW(),
              lease_expires_at = NULL
        WHERE workspace_id = :workspace_id AND request_key = :request_key
          AND request_state = 'running' AND fence_token_sha256 = :fence
        RETURNING request_key`,
      { workspace_id: workspaceId, request_key: input.requestKey, sim_key: completion.simKey, fence: sha256(input.fenceToken) },
    );
    if (!closed) throw new SimulationFailedError("simulation_lease_lost", "The simulation request lease was lost before completion.");
    return { simKey: completion.simKey, determinismViolation };
  });
}

export async function failSimulationRequest(input: {
  workspaceId: string;
  requestKey: string;
  fenceToken: string;
  code: string;
  message: string;
  retryable: boolean;
}): Promise<void> {
  await queryRows(
    `UPDATE simforge.sim_requests
        SET request_state = CASE WHEN :retryable AND attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
            failure_code = :code, failure_detail = CAST(:detail AS jsonb), lease_expires_at = NULL,
            updated_at = NOW(),
            completed_at = CASE WHEN :retryable AND attempt_count < max_attempts THEN NULL ELSE NOW() END
      WHERE workspace_id = :workspace_id AND request_key = :request_key
        AND request_state = 'running' AND fence_token_sha256 = :fence
      RETURNING request_key`,
    {
      workspace_id: input.workspaceId,
      request_key: input.requestKey,
      fence: sha256(input.fenceToken),
      retryable: input.retryable,
      code: input.code.slice(0, 100),
      detail: { message: input.message.slice(0, 2000) },
    },
  );
}

type InlineExecutor = (subject: SimulationSubject) => Promise<AuthoritativeSimulation>;
let inlineExecutorOverride: InlineExecutor | null = null;

/** Test seam: replace the closure load + native run with a fixed executor (null restores it). */
export function setSimulationExecutorForTests(executor: InlineExecutor | null): void {
  inlineExecutorOverride = executor;
}

async function executeInline(
  subject: SimulationSubject,
  identity: Awaited<ReturnType<typeof requestIdentity>>,
  fenceToken: string,
): Promise<void> {
  const producer = inlineProducer();
  try {
    let simulation: AuthoritativeSimulation;
    let timeline: SimulationTimeline | null = null;
    if (inlineExecutorOverride) {
      simulation = await inlineExecutorOverride(subject);
    } else {
      const closure = await loadServerSimulationClosure(identity.map);
      const trafficStep = await hostTrafficStep(subject.canonicalContent, {
        sumoNetworkSha256: identity.map.sumoNetworkSha256,
        readMember: (relativePath) => readServerMapMember(identity.map.mapVersionId, relativePath),
        runtime: serverSumoRuntime,
      });
      simulation = simulateAuthoritative({
        canonicalContent: subject.canonicalContent,
        closure,
        catalogEntries: identity.catalogEntries,
        trafficStep,
      });
      timeline = await buildSimulationTimeline(simulation, closure);
    }
    const { completion, bytes } = simulationCompletion(simulation, timeline);
    const keys = simulationObjectKeys(subject.workspaceId, completion);
    const existing = await readSimulationRecord(subject.workspaceId, completion.simKey);
    const bucket = artifactBucket();
    // Content-addressed objects: rewriting identical bytes is harmless, skipping them is the dedupe.
    if (!existing) {
      await putS3Object(bucket, keys.trace, bytes.trace, SIMULATION_TRACE_MEDIA_TYPE);
      await putS3Object(bucket, keys.resolution, bytes.resolution, RESOLUTION_MEDIA_TYPE);
    }
    if (keys.traffic && bytes.traffic) await putS3Object(bucket, keys.traffic, bytes.traffic, MATERIALIZED_TRAFFIC_MEDIA_TYPE);
    if (!existing && keys.timeline && bytes.timeline) await putS3Object(bucket, keys.timeline, bytes.timeline, TIMELINE_MEDIA_TYPE);
    await completeSimulationRequest({
      workspaceId: subject.workspaceId,
      userId: subject.userId,
      requestKey: identity.requestKey,
      fenceToken,
      producer,
      completion,
      verifyObjects: false,
    });
  } catch (error) {
    const code = error instanceof SimulationFailedError
      ? error.code
      : error instanceof Error && /^[a-z0-9_:-]{3,100}$/i.test(error.message.split(":")[0] ?? "")
        ? error.message.split(":")[0]!.slice(0, 100)
        : "simulation_failed";
    // Scenario errors (infeasible, invalid) fail the request; infrastructure errors requeue it.
    const scenarioError = /^(template_invalid|materialization_infeasible|semantic_loss|unsupported_portable_semantics|map_bound_|runtime_asset_identity|actor_catalog|sumo_network_unavailable)/.test(code);
    console.warn(`[simulation] inline execution of ${identity.requestKey} failed (${scenarioError ? "scenario" : "retryable"}): ${error instanceof Error ? error.message : String(error)}`);
    await failSimulationRequest({
      workspaceId: subject.workspaceId,
      requestKey: identity.requestKey,
      fenceToken,
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: !scenarioError,
    });
    throw error;
  }
}

/**
 * Resolve the authoritative simulation of `subject`: return the memoized
 * result, join the in-flight execution, or execute it inline. `waitMs` bounds
 * how long a caller waits on someone else's execution; the returned status is
 * then `queued`/`running` and the caller polls or retries.
 */
export async function resolveSimulation(
  subject: SimulationSubject,
  options: { waitMs?: number; inline?: boolean } = {},
): Promise<ScenarioSimulationStatusDto> {
  const identity = await requestIdentity(subject);
  const { workspaceId } = subject;
  let request = await readRequest(workspaceId, identity.requestKey);
  if (request?.request_state === "succeeded") return statusOf(workspaceId, request);
  if (!request) {
    await queryRows(
      `INSERT INTO simforge.sim_requests (
         workspace_id, request_key, request_state, content_sha256, canonical_content, map_version_id,
         catalog_sha256, engine_sem_ver, requested_by_user_id
       ) VALUES (
         :workspace_id, :request_key, 'queued', :content_sha256, CAST(:content AS jsonb), :map_version_id,
         :catalog_sha256, :engine_sem_ver, :user_id
       ) ON CONFLICT (workspace_id, request_key) DO NOTHING
       RETURNING request_key`,
      {
        workspace_id: workspaceId,
        request_key: identity.requestKey,
        content_sha256: subject.contentSha256,
        content: subject.canonicalContent as Record<string, unknown>,
        map_version_id: identity.map.mapVersionId,
        catalog_sha256: identity.catalogSha256,
        engine_sem_ver: identity.engineSemVer,
        user_id: subject.userId,
      },
    );
  } else if (request.request_state === "failed" && request.attempt_count < request.max_attempts) {
    // A retryable failure left attempts: requeue it for whoever asks next.
    await queryRows(
      `UPDATE simforge.sim_requests SET request_state = 'queued', updated_at = NOW()
        WHERE workspace_id = :workspace_id AND request_key = :request_key AND request_state = 'failed'
          AND attempt_count < max_attempts AND failure_code NOT LIKE 'template_invalid%'
      RETURNING request_key`,
      { workspace_id: workspaceId, request_key: identity.requestKey },
    );
  }
  if ((options.inline ?? true) && inlineSimulationEnabled()) {
    const claim = await claimRequest(workspaceId, identity.requestKey, inlineProducer(), INLINE_LEASE_SECONDS);
    if (claim) {
      try {
        await executeInline(subject, identity, claim.fenceToken);
      } catch {
        // Recorded on the request; the status below reports it.
      }
    }
  }
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (;;) {
    request = await readRequest(workspaceId, identity.requestKey);
    if (!request) throw new Error("simulation_request_missing");
    if (request.request_state === "succeeded" || request.request_state === "failed" || Date.now() >= deadline) {
      return statusOf(workspaceId, request);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// ── CPU runner lane (/api/simforge/internal/sim-jobs) ─────────────────────────

const MAP_MEMBER_PATHS = [
  "3d/manifest.json",
  "topology-index.json.gz",
  "derived/topology-derived.json.gz",
  "derived/locations.json.gz",
  "map.xodr",
  "signals.geojson.gz",
] as const;

/**
 * Claim the oldest claimable request for a CPU runner. The payload carries the
 * content, the gallery catalog and presigned URLs for exactly the browser
 * members the editor loads (plus the collider derivative the manifest names).
 */
export async function claimSimulationJob(input: { workerId: string; leaseSeconds: number }) {
  const candidates = await queryRows<{ workspace_id: string; request_key: string }>(
    `SELECT workspace_id, request_key FROM simforge.sim_requests
      WHERE attempt_count < max_attempts
        AND (request_state = 'queued' OR (request_state = 'running' AND lease_expires_at < NOW()))
      ORDER BY created_at LIMIT 8`,
  );
  for (const candidate of candidates) {
    const claim = await claimRequest(candidate.workspace_id, candidate.request_key, `cpu:${input.workerId}`.slice(0, 200), input.leaseSeconds);
    if (!claim) continue;
    const row = await queryOne<{
      content_sha256: string; canonical_content: unknown; map_version_id: string; lease_expires_at: string;
    }>(
      `SELECT content_sha256, canonical_content, map_version_id,
              to_char(lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at
         FROM simforge.sim_requests WHERE workspace_id = :workspace_id AND request_key = :request_key`,
      candidate,
    );
    if (!row) continue;
    const content = parseJsonObject(row.canonical_content as string | Record<string, unknown>) ?? {};
    try {
      const map = await readSimulationMapIdentity(row.map_version_id);
      const runsSumo = sumoStepIdentity(content, map.sumoNetworkSha256) !== null;
      const members = await presignedMapMembers(row.map_version_id, runsSumo);
      return {
        contract: "simforge.sim-job-claim/v1" as const,
        workspaceId: candidate.workspace_id,
        requestKey: candidate.request_key,
        fenceToken: claim.fenceToken,
        leaseExpiresAt: row.lease_expires_at,
        contentSha256: row.content_sha256,
        canonicalContent: content,
        catalogEntries: await catalogEntriesFor(content),
        map: { ...map, members },
        // SUMO documents: the pinned runtime, verified against the pin on load.
        sumoRuntime: runsSumo ? await presignedSumoRuntime() : null,
      };
    } catch (error) {
      await failSimulationRequest({
        workspaceId: candidate.workspace_id,
        requestKey: candidate.request_key,
        fenceToken: claim.fenceToken,
        code: "simulation_claim_map_unavailable",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }
  return null;
}

async function presignedSumoRuntime() {
  return Promise.all(SUMO_RUNTIME_FILES.map(async (file) => ({
    file,
    downloadUrl: await getPresignedGetUrl(`${SUMO_RUNTIME_OBJECT_PREFIX}${file}`, SUMO_RUNTIME_BUCKET),
  })));
}

async function presignedMapMembers(mapVersionId: string, includeSumo: boolean) {
  const rows = await queryRows<{ relative_path: string; sha256: string; byte_length: number | string; storage_bucket: string; storage_key: string }>(
    `SELECT bm.relative_path, bb.sha256, bb.byte_length, bb.storage_bucket, bb.storage_key
       FROM simforge.map_versions mv
       JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id AND bs.asset_set_state = 'available'
       JOIN simforge.browser_asset_members bm ON bm.asset_set_id = bs.id
       JOIN simforge.browser_asset_blobs bb ON bb.id = bm.blob_id AND bb.verification_state = 'verified'
      WHERE mv.id = :map_version_id
        AND (bm.relative_path IN (${MAP_MEMBER_PATHS.map((_, index) => `:p${index}`).join(", ")})
             OR bm.relative_path = '3d/variants/manifest.json'
             OR bm.relative_path LIKE '3d/variants/static-colliders%'
             OR (:include_sumo AND bm.relative_path LIKE 'derived/sumo/%'))`,
    { map_version_id: mapVersionId, include_sumo: includeSumo, ...Object.fromEntries(MAP_MEMBER_PATHS.map((path, index) => [`p${index}`, path])) },
  );
  return Promise.all(rows.map(async (row) => ({
    relativePath: row.relative_path,
    sha256: row.sha256,
    sizeBytes: Number(row.byte_length),
    downloadUrl: await getPresignedGetUrl(row.storage_key, row.storage_bucket),
  })));
}

/** Presigned, checksum-bound uploads for a runner's result objects; already-stored objects are skipped. */
export async function reserveSimulationJobOutputs(input: {
  workspaceId: string;
  requestKey: string;
  fenceToken: string;
  completion: Pick<SimulationCompletion, "simKey" | "traceSha256" | "trace" | "resolution" | "traffic" | "timeline">;
}) {
  const request = await queryOne<{ fence_token_sha256: string | null; request_state: string }>(
    `SELECT fence_token_sha256, request_state FROM simforge.sim_requests
      WHERE workspace_id = :workspace_id AND request_key = :request_key`,
    { workspace_id: input.workspaceId, request_key: input.requestKey },
  );
  if (!request || request.request_state !== "running" || request.fence_token_sha256 !== sha256(input.fenceToken)) return null;
  const existing = await readSimulationRecord(input.workspaceId, input.completion.simKey);
  const keys = simulationObjectKeys(input.workspaceId, input.completion);
  const bucket = artifactBucket();
  const upload = async (key: string | null, mediaType: string, object: { sha256: string } | null, required: boolean) =>
    key && object && required
      ? { uploadRequired: true, uploadUrl: await getPresignedPutUrl(key, mediaType, bucket, 900, object.sha256), mediaType }
      : { uploadRequired: false, uploadUrl: null, mediaType };
  return {
    trace: await upload(keys.trace, SIMULATION_TRACE_MEDIA_TYPE, input.completion.trace, !existing),
    resolution: await upload(keys.resolution, RESOLUTION_MEDIA_TYPE, input.completion.resolution, !existing),
    traffic: await upload(keys.traffic, MATERIALIZED_TRAFFIC_MEDIA_TYPE, input.completion.traffic, true),
    timeline: await upload(
      keys.timeline,
      TIMELINE_MEDIA_TYPE,
      input.completion.timeline ? { sha256: input.completion.timeline.timelineSha256 } : null,
      !existing,
    ),
  };
}

// ── Revisions ─────────────────────────────────────────────────────────────────

/** Bind a revision to its result under the result's engine semantics. */
export async function linkRevisionSimulation(
  tx: Transaction | null,
  input: { workspaceId: string; revisionId: string; simKey: string; engineSemVer: string; origin: "commit" | "lazy" },
): Promise<void> {
  const sql = `INSERT INTO simforge.revision_simulations (workspace_id, revision_id, engine_sem_ver, sim_key, origin)
     VALUES (:workspace_id, :revision_id, :engine_sem_ver, :sim_key, :origin)
     ON CONFLICT (workspace_id, revision_id, engine_sem_ver) DO NOTHING`;
  const params = {
    workspace_id: input.workspaceId,
    revision_id: input.revisionId,
    engine_sem_ver: input.engineSemVer,
    sim_key: input.simKey,
    origin: input.origin,
  };
  if (tx) await tx.execute(sql, params);
  else await queryRows(`${sql} RETURNING revision_id`, params);
}

/**
 * The authoritative simulation a revision renders under the current engine
 * semantics. A revision committed without one (before this pipeline, or under
 * another engine) is simulated now, lazily, and bound with `origin = 'lazy'`;
 * its original artifacts are untouched.
 */
export async function resolveRevisionSimulation(
  context: { workspaceId: string; userId: string | null },
  revisionId: string,
  options: { waitMs?: number } = {},
): Promise<ScenarioSimulationStatusDto | null> {
  const { engineSemVer } = engineSemantics();
  const linked = await queryOne<{ sim_key: string; origin: string }>(
    `SELECT sim_key, origin FROM simforge.revision_simulations
      WHERE workspace_id = :workspace_id AND revision_id = :revision_id AND engine_sem_ver = :engine_sem_ver`,
    { workspace_id: context.workspaceId, revision_id: revisionId, engine_sem_ver: engineSemVer },
  );
  if (linked) {
    const result = await getSimulationResult(context.workspaceId, linked.sim_key);
    if (result) return { state: "succeeded", requestKey: "", result, resimulated: linked.origin === "lazy" };
  }
  const revision = await queryOne<{ canonical_content: unknown; content_sha256: string; map_version_id: string }>(
    `SELECT canonical_content, content_sha256, map_version_id FROM simforge.revisions
      WHERE workspace_id = :workspace_id AND id = :revision_id`,
    { workspace_id: context.workspaceId, revision_id: revisionId },
  );
  if (!revision) return null;
  const status = await resolveSimulation({
    workspaceId: context.workspaceId,
    userId: context.userId,
    canonicalContent: parseJsonObject(revision.canonical_content as string | Record<string, unknown>),
    contentSha256: revision.content_sha256,
    mapVersionId: revision.map_version_id,
  }, options);
  if (status.state !== "succeeded") return status;
  await linkRevisionSimulation(null, {
    workspaceId: context.workspaceId,
    revisionId,
    simKey: status.result.simKey,
    engineSemVer: status.result.engineSemVer,
    origin: "lazy",
  });
  const origin = await queryOne<{ origin: string }>(
    `SELECT origin FROM simforge.revision_simulations
      WHERE workspace_id = :workspace_id AND revision_id = :revision_id AND engine_sem_ver = :engine_sem_ver`,
    { workspace_id: context.workspaceId, revision_id: revisionId, engine_sem_ver: status.result.engineSemVer },
  );
  return { ...status, resimulated: origin?.origin === "lazy" };
}

/** Record the editor's comparison of its local preview against the authoritative trace. */
export async function recordSimulationVerification(input: {
  workspaceId: string;
  userId: string | null;
  simKey: string;
  documentId: string | null;
  localTraceSha256: string;
  localRuntime: Record<string, unknown>;
}): Promise<{ outcome: "verified" | "mismatch"; authoritativeTraceSha256: string } | null> {
  const result = await queryOne<{ trace_sha256: string; authored_trace_sha256: string }>(
    `SELECT trace_sha256, authored_trace_sha256 FROM simforge.sim_results WHERE workspace_id = :workspace_id AND sim_key = :sim_key`,
    { workspace_id: input.workspaceId, sim_key: input.simKey },
  );
  if (!result) return null;
  // The editor runs SUMO documents with ambient off, so it verifies the authored trace.
  const verified = input.localTraceSha256 === result.trace_sha256 || input.localTraceSha256 === result.authored_trace_sha256;
  const outcome = verified ? "verified" : "mismatch";
  await queryRows(
    `INSERT INTO simforge.sim_verification_events (
       id, workspace_id, sim_key, document_id, outcome, local_trace_sha256, authoritative_trace_sha256,
       local_runtime, created_by_user_id
     ) VALUES (:id, :workspace_id, :sim_key, :document_id, :outcome, :local, :authoritative, CAST(:runtime AS jsonb), :user_id)
     RETURNING id`,
    {
      id: scenarioId("ussv"),
      workspace_id: input.workspaceId,
      sim_key: input.simKey,
      document_id: input.documentId,
      outcome,
      local: input.localTraceSha256,
      authoritative: result.trace_sha256,
      runtime: input.localRuntime,
      user_id: input.userId,
    },
  );
  if (!verified) {
    console.error(`[simulation] editor preview mismatch: sim_key ${input.simKey} local ${input.localTraceSha256} authoritative ${result.trace_sha256}`);
  }
  return { outcome, authoritativeTraceSha256: result.trace_sha256 };
}

/**
 * Evaluation reads the authoritative trace by key: the same bytes every render
 * replays, graded by the native evaluator. Nothing is simulated again.
 */
export async function evaluateSimulationResult(
  workspaceId: string,
  simKey: string,
  filters: EvaluateFilters = {},
): Promise<{ simKey: string; traceSha256: string; evaluation: TraceEvaluation } | null> {
  const row = await readSimulationRecord(workspaceId, simKey);
  if (!row) return null;
  const bytes = await getS3ObjectBytes(row.storage_bucket, row.trace_storage_key);
  if (bytes.byteLength !== Number(row.trace_byte_length) || sha256(bytes) !== row.trace_gzip_sha256) {
    throw new SimulationFailedError("simulation_trace_corrupt", `stored trace for ${simKey} does not match its recorded digest`);
  }
  return { simKey, traceSha256: row.trace_sha256, evaluation: evaluateTrace(bytes, filters) };
}
