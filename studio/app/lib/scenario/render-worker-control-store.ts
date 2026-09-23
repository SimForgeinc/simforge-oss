import { randomBytes } from "node:crypto";
import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows, withTransaction, type SqlParams } from "@/app/lib/db/data-api";
import { readLocalObject } from "@/app/lib/s3/s3-object";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedGetUrl,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";
import {
  NATIVE_ACTOR_ASSETS_INPUT_ID,
  NativeRenderManifestSchema,
  NativeRunDiagnosticsSchema,
  nativeActorAssetsInput,
  assertNativeMapMemberCapacity,
  nativeEvidenceFailure,
  nativeRunExpectations,
  type NativeRunDiagnostics,
} from "@simforge-oss/render/native";
import { RENDER_TIMELINE_INPUT_ID } from "@simforge-oss/render/timeline";
import { CONTROL_FEATURES_V1, WORKER_CONTROL_FEATURES_V1 } from "@simforge-oss/render";
import { RENDER_INTENT_V1_SCHEMA, RenderSpecV3Schema, captureScheduleFps, fixedStepFrameCount, hashRenderIntent, parseRenderIntent as parseRenderIntentDocument } from "@simforge-oss/scenario";
import {
  isScenarioParityEvidenceAccepted,
  SCENARIO_PARITY_EVIDENCE_VERSION,
  ScenarioParityEvidenceV1Schema,
  SIMFORGE_LOCAL_RTX5080_HARDWARE_PROFILE,
  SIMFORGE_RTX3080_HARDWARE_PROFILE,
  SIMFORGE_RTX3090_HARDWARE_PROFILE,
} from "@simforge-oss/studio-shared";
import { z } from "zod";
import { canonicalJsonSha256, sha256, scenarioId } from "./core";
import { expectedNativeClosure } from "./jobs/local-native-render-store";
import {
  ScenarioRenderIntentSchema,
  ScenarioRendererCapabilitySchema,
  type RenderArtifactIdentity,
  type RenderProgressRecord,
  type ScenarioRenderIntent,
  type ScenarioRendererCapability,
} from "./render-wire-contracts";
import { simforgeEnv } from "@/lib/simforge-env";

const REQUIRED_CARLA_BASE_IMAGE = "ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia";
const REQUIRED_CARLA_BASE_IMAGE_INDEX_DIGEST = "sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5";
const REQUIRED_CARLA_BASE_IMAGE_AMD64_DIGEST = "sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64";
const CONTROL_SCHEMA = "simforge.render-worker-control/v2";
const LEASE_SECONDS = 900;
/**
 * Every hardware profile the fleet admits, with the nominal VRAM its name
 * claims. Capability scheduling (`workerCanRun`) sizes a job against the
 * memory a worker registered, so a profile name has to be backed by a card
 * that really reports that much: a 20480 MiB board — vast.ai sells them as
 * 3090s — cannot enter the fleet as `rtx3090-24gb-v1`. The tolerance covers the
 * driver's reserved region and nothing more.
 */
export const RENDER_WORKER_GPU_PROFILES: Record<string, { gpuMemoryMiB: number }> = {
  [SIMFORGE_RTX3080_HARDWARE_PROFILE]: { gpuMemoryMiB: 10_240 },
  "rtx5080-16gb-v1": { gpuMemoryMiB: 16_384 },
  [SIMFORGE_LOCAL_RTX5080_HARDWARE_PROFILE]: { gpuMemoryMiB: 16_384 },
  [SIMFORGE_RTX3090_HARDWARE_PROFILE]: { gpuMemoryMiB: 24_576 },
};
const GPU_MEMORY_PROFILE_TOLERANCE = 0.975;
/**
 * The full authored rig is 18 simultaneous sources. It was admitted on the
 * 16 GiB 5080 class alone; keyed on the profile's memory instead of its name,
 * the same rule now also admits the 24 GiB 3090.
 */
const FULL_SENSOR_RIG_SOURCES = 18;
const FULL_SENSOR_RIG_MIN_GPU_MIB = 16_384;
function runtimeEnvironment(): "dev" | "staging" | "prod" {
  const value = process.env.SIMFORGE_ENV?.trim();
  if (value !== "dev" && value !== "staging" && value !== "prod") {
    throw new Error("SIMFORGE_ENV must identify the Scenario control-plane environment.");
  }
  return value;
}

function artifactBucket() { return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts"; }

function label(input: Record<string, string>, key: string) {
  const value = input[key]?.trim();
  if (!value) throw new Error(`worker_label_${key}_required`);
  return value;
}

export type RenderWorkerIdentity = {
  workerVersion: string;
  imageDigest: string;
  hardwareProfile: string;
  rendererEngine: ScenarioRendererCapability["backend"];
  capability: ScenarioRendererCapability;
  metadata: {
    labels: Record<string, string>;
    gpuModel: string;
    gpuMemoryMiB: number;
    baseImage: string | null;
    baseImageDigest: string | null;
    baseImagePlatformDigest: string | null;
    deployment: "container" | "host-native";
  };
};

/**
 * The exact identity tuple a worker binds through registration and an operator
 * pins through approval. One derivation for both sides so approval can only
 * ever pin what registration will later present.
 *
 * Digest binding is deployment-shaped but honestly named: containerized
 * workers send labels.imageDigest (image content digest); host-native workers
 * send labels.codeDigest (sha256 of the dependency lockfiles at the deployed
 * git revision — the revision itself rides in worker_version via the engine
 * capability). Both bind through the same approved_image_digest column, and
 * the approval row (approved_* = current_* + approved_at) stays the only
 * identity gate. CARLA additionally keeps its pinned base-image provenance;
 * the native engine has no container base image to attest.
 */
export function renderWorkerIdentity(
  engine: ScenarioRendererCapability,
  labels: Record<string, string>,
): RenderWorkerIdentity {
  const capability = ScenarioRendererCapabilitySchema.parse(engine);
  const imageDigestLabel = labels.imageDigest?.trim() || null;
  const codeDigestLabel = labels.codeDigest?.trim() || null;
  const imageDigest = imageDigestLabel ?? codeDigestLabel ?? "";
  const hardwareProfile = label(labels, "hardwareProfile");
  const gpuModel = label(labels, "gpuModel");
  const gpuMemoryMiB = Number(label(labels, "gpuMemoryMiB"));
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error("worker_image_digest_invalid");
  const baseImage = labels.baseImage?.trim() ?? null;
  const baseImageDigest = labels.baseImageDigest?.trim() ?? null;
  const baseImagePlatformDigest = labels.baseImagePlatformDigest?.trim() ?? null;
  if (capability.backend === "carla" && (
    baseImage !== REQUIRED_CARLA_BASE_IMAGE
    || baseImageDigest !== REQUIRED_CARLA_BASE_IMAGE_INDEX_DIGEST
    || baseImagePlatformDigest !== REQUIRED_CARLA_BASE_IMAGE_AMD64_DIGEST
  )) {
    throw new Error("worker_carla_base_image_provenance_invalid");
  }
  const profile = RENDER_WORKER_GPU_PROFILES[hardwareProfile];
  if (!profile) throw new Error("worker_hardware_profile_incompatible");
  if (!capability.requiresGpu
    || !Number.isInteger(gpuMemoryMiB)
    || gpuMemoryMiB < Math.floor(profile.gpuMemoryMiB * GPU_MEMORY_PROFILE_TOLERANCE)) {
    throw new Error("worker_gpu_capability_invalid");
  }
  return {
    workerVersion: capability.engineVersion,
    imageDigest,
    hardwareProfile,
    rendererEngine: capability.backend,
    capability,
    metadata: {
      labels,
      gpuModel,
      gpuMemoryMiB,
      baseImage,
      baseImageDigest,
      baseImagePlatformDigest,
      deployment: imageDigestLabel ? "container" : "host-native",
    },
  };
}

export async function registerRenderWorkerV2(input: {
  workerId: string;
  instanceId: string;
  engine: ScenarioRendererCapability;
  labels: Record<string, string>;
}) {
  const identity = renderWorkerIdentity(input.engine, input.labels);
  const registrationId = scenarioId("uswr");
  const rows = await queryRows<{ registration_id: string }>(
    `UPDATE simforge.worker_nodes
        SET registration_id = CASE WHEN instance_id = :instance_id THEN registration_id ELSE :registration_id END,
            instance_id = :instance_id,
            worker_version = :worker_version,
            image_digest = :image_digest,
            hardware_profile = :hardware_profile,
            renderer_engine = :renderer_engine,
            capabilities = CAST(:capabilities AS jsonb),
            metadata = CAST(:metadata AS jsonb),
            last_heartbeat_at = NOW(), last_idle_heartbeat_at = NOW()
      WHERE id = :worker_id AND environment = :environment
        AND registration_state IN ('active', 'draining')
        AND approved_worker_version = :worker_version
        AND approved_image_digest = :image_digest
        AND approved_hardware_profile = :hardware_profile
        AND approved_at IS NOT NULL
      RETURNING registration_id`,
    {
      registration_id: registrationId,
      instance_id: input.instanceId,
      worker_id: input.workerId,
      environment: runtimeEnvironment(),
      worker_version: identity.workerVersion,
      image_digest: identity.imageDigest,
      hardware_profile: identity.hardwareProfile,
      renderer_engine: identity.rendererEngine,
      capabilities: identity.capability,
      metadata: identity.metadata,
    },
  );
  if (!rows[0]) throw new Error("worker_registration_not_approved");
  await releaseOrphanedWorkerLeasesV2(input.workerId);
  return {
    schema: CONTROL_SCHEMA,
    type: "worker.registered" as const,
    registrationId: rows[0].registration_id,
    heartbeatIntervalMs: 30_000,
  };
}

export type Candidate = {
  id: string;
  renderer_engine: "browser" | "carla" | "native";
  /** Only the intent's render spec: screening never reads its asset closure. */
  render_spec: unknown;
  intent_sha256: string;
  resource_request: unknown;
  map_version_id?: string | null;
  render_textures?: string | null;
};

export type WorkerRow = {
  id: string;
  registration_id: string;
  worker_version: string;
  image_digest: string;
  renderer_engine: "browser" | "carla" | "native";
  base_image_digest: string | null;
  capabilities: string | Record<string, unknown>;
  base_image_platform_digest: string | null;
  gpu_memory_mib: number;
  hardware_profile: string;
  /** `batch-v1` when the worker signs lease inputs lazily (label `inputUrls`). */
  input_urls?: string | null;
  /** Per-map, per-tier scene memory this worker measured from its cache (`cacheStatus.demand`). */
  cache_demand?: string | unknown[] | null;
  /** `v1` when the worker understands `controlFeatures` on a lease. */
  control_features?: string | null;
};

function parseObject(value: string | Record<string, unknown>) {
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value;
}

function parseRenderIntent(value: unknown): ScenarioRenderIntent {
  return ScenarioRenderIntentSchema.parse(
    typeof value === "string" ? JSON.parse(value) : value,
  );
}

type RowQuery = <T>(sql: string, params?: SqlParams) => Promise<T[]>;

/**
 * Characters per slice when reading a stored render intent. A native intent
 * declares its whole map closure, so one row reaches megabytes for a large
 * map, while Aurora's Data API caps a single response at 1 MB and its seam can
 * page rows but never split one. 128k characters stays under that cap even if
 * every character came back escaped as a six-byte `\uXXXX`.
 */
export const RENDER_INTENT_TEXT_SLICE_CHARS = 131_072;

/** Postgres `length()` counts code points; a JS string counts UTF-16 units. */
function codePointLength(text: string) {
  let surrogatePairs = 0;
  for (const _ of text.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)) surrogatePairs += 1;
  return text.length - surrogatePairs;
}

/**
 * The stored canonical text of a job's render intent, read in bounded slices
 * and reassembled. The column is written once at submission and never
 * updated, so slices read by separate statements cannot tear; the lease path
 * still verifies the reassembled document against `intent_sha256`.
 * Resolves `null` when the job does not exist.
 */
export async function readRenderIntentText(
  query: RowQuery,
  jobId: string,
  sliceChars = RENDER_INTENT_TEXT_SLICE_CHARS,
): Promise<string | null> {
  const [head] = await query<{ chars: number | string; part: string }>(
    `SELECT length(render_intent::text) AS chars,
            substr(render_intent::text, 1, CAST(:size AS integer)) AS part
       FROM simforge.render_jobs WHERE id = :job_id`,
    { job_id: jobId, size: sliceChars },
  );
  if (!head) return null;
  const total = Number(head.chars);
  const parts = [head.part];
  for (let start = sliceChars + 1; start <= total; start += sliceChars) {
    const [slice] = await query<{ part: string }>(
      `SELECT substr(render_intent::text, CAST(:start AS integer), CAST(:size AS integer)) AS part
         FROM simforge.render_jobs WHERE id = :job_id`,
      { job_id: jobId, start, size: sliceChars },
    );
    if (!slice) throw new Error("render_intent_read_incomplete");
    parts.push(slice.part);
  }
  const text = parts.join("");
  if (codePointLength(text) !== total) throw new Error("render_intent_read_incomplete");
  return text;
}

export function workerCanRun(worker: WorkerRow, candidate: Candidate) {
  const capability = ScenarioRendererCapabilitySchema.safeParse(parseObject(worker.capabilities));
  const specValue = typeof candidate.render_spec === "string"
    ? JSON.parse(candidate.render_spec) as unknown
    : candidate.render_spec;
  const renderSpec = RenderSpecV3Schema.safeParse(specValue);
  if (!capability.success || !renderSpec.success || capability.data.backend !== candidate.renderer_engine) return false;
  const sources = renderSpec.data.sources;
  const resources = typeof candidate.resource_request === "string"
    ? JSON.parse(candidate.resource_request) as { estimatedGpuBytes?: unknown }
    : candidate.resource_request as { estimatedGpuBytes?: unknown };
  if (
    typeof resources.estimatedGpuBytes !== "number"
    || resources.estimatedGpuBytes > (Number(worker.gpu_memory_mib) - 1024) * 1024 * 1024
  ) return false;
  // Map textures dominate a native job's device memory. When this worker has
  // measured the job's map at its tier, leave a job it cannot hold to a larger
  // worker instead of leasing it into a scene-load failure.
  if (candidate.renderer_engine === "native" && candidate.map_version_id && candidate.render_textures) {
    const measured = (typeof worker.cache_demand === "string" ? JSON.parse(worker.cache_demand) as unknown[] : worker.cache_demand ?? [])
      .find((entry) => {
        const demand = entry as { mapVersionId?: unknown; renderTextures?: unknown };
        return demand.mapVersionId === candidate.map_version_id && demand.renderTextures === candidate.render_textures;
      }) as { sceneBytes?: unknown } | undefined;
    if (typeof measured?.sceneBytes === "number"
      && measured.sceneBytes + resources.estimatedGpuBytes > (Number(worker.gpu_memory_mib) - 1024) * 1024 * 1024) return false;
  }
  const physicalSensors = new Set(sources.map((source) => `${source.actorId}\0${source.sensorId}`));
  if (physicalSensors.size > capability.data.limits.maxSimultaneousSensors) return false;
  if (physicalSensors.size === FULL_SENSOR_RIG_SOURCES
    && (RENDER_WORKER_GPU_PROFILES[worker.hardware_profile]?.gpuMemoryMiB ?? 0) < FULL_SENSOR_RIG_MIN_GPU_MIB
  ) return false;
  if (sources.some((source) => !capability.data.modalities.includes(source.modality))) return false;
  if (sources.some((source) => {
    const attributes = source.attributes;
    return "width" in attributes && (
      attributes.width > capability.data.limits.maxWidth
      || attributes.height > capability.data.limits.maxHeight
      || attributes.fps > capability.data.limits.maxFramesPerSecond
    );
  })) return false;
  const required = renderSpec.data.capabilityIntent.required;
  return required.every((item) =>
    capability.data.capabilities.includes(item as typeof capability.data.capabilities[number])
  );
}

type Claimed = {
  jobId: string;
  attempt: number;
  attemptId: string;
  leaseId: string;
  fenceToken: string;
  expiresAt: string;
  intent: ScenarioRenderIntent;
  intentSha256: string;
  executionPackageControlSha256: string;
  inputs: ClaimedInput[];
  /** The worker signs stored inputs on demand (cache misses only): send no per-input URL. */
  lazyInputUrls: boolean;
  /** The worker parses `controlFeatures`: tell it which newer output fields this plane accepts. */
  controlFeatures: boolean;
};

type StoredInput = {
  inputId: string;
  relativePath?: string;
  sha256: string;
  sizeBytes: number;
  bucket: string;
  key: string;
};

/** Stored inputs are presigned at lease time; the pinned actor closure is served from its public immutable URL. */
type ClaimedInput = StoredInput | {
  inputId: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  url: string;
};

/**
 * Ends active leases and puts their jobs back in the queue (or fails them
 * when their attempts are spent). `force` ends leases that have not expired
 * yet: used when the holder is known to be gone.
 */
async function releaseRenderLeasesV2(
  items: readonly { lease_id: string; attempt_id: string; job_id: string }[],
  force: boolean,
) {
  for (const item of items) {
    await withTransaction(async (tx) => {
      const released = await tx.queryOne<{ id: string }>(
        `UPDATE simforge.worker_leases SET lease_state = 'expired', released_at = NOW()
          WHERE id = :lease_id AND lease_state = 'active' ${force ? "" : "AND expires_at <= NOW()"}
          RETURNING id`,
        { lease_id: item.lease_id },
      );
      if (!released) return;
      await tx.execute(
        `UPDATE simforge.render_attempts SET attempt_state = 'expired', completed_at = NOW()
          WHERE id = :attempt_id AND attempt_state IN ('leased', 'running')`,
        { attempt_id: item.attempt_id },
      );
      await tx.execute(
        `UPDATE simforge.render_jobs
            SET job_state = CASE
                  WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                  WHEN attempt_count < max_attempts THEN 'queued'
                  ELSE 'failed'
                END,
                failure_code = CASE WHEN attempt_count < max_attempts THEN NULL ELSE 'lease_expired' END,
                progress = CASE WHEN cancel_requested_at IS NULL AND attempt_count < max_attempts THEN 0 ELSE progress END,
                progress_detail = CASE
                  WHEN cancel_requested_at IS NULL AND attempt_count < max_attempts THEN NULL
                  ELSE progress_detail
                END,
                updated_at = NOW(),
                completed_at = CASE
                  WHEN cancel_requested_at IS NOT NULL OR attempt_count >= max_attempts THEN NOW()
                  ELSE NULL
                END
          WHERE id = :job_id AND job_state IN ('leased', 'running')`,
        { job_id: item.job_id },
      );
    });
  }
}

async function reapExpiredRenderIntentLeasesV2() {
  const expired = await queryRows<{ lease_id: string; attempt_id: string; job_id: string }>(
    `SELECT id AS lease_id, render_attempt_id AS attempt_id, render_job_id AS job_id
       FROM simforge.worker_leases
      WHERE lease_state = 'active' AND expires_at <= NOW()
      ORDER BY expires_at LIMIT 100`,
  );
  await releaseRenderLeasesV2(expired, false);
}

/**
 * A worker runs one job at a time and registers only when its process
 * starts, so any lease still active for its node at registration belongs to
 * a process that is gone (crash, restart, redeploy). Release those at once
 * so the job is retried now instead of after the lease runs out (up to
 * LEASE_SECONDS later).
 */
export async function releaseOrphanedWorkerLeasesV2(workerNodeId: string) {
  const orphaned = await queryRows<{ lease_id: string; attempt_id: string; job_id: string }>(
    `SELECT id AS lease_id, render_attempt_id AS attempt_id, render_job_id AS job_id
       FROM simforge.worker_leases
      WHERE worker_node_id = :worker_node_id AND lease_state = 'active'`,
    { worker_node_id: workerNodeId },
  );
  await releaseRenderLeasesV2(orphaned, true);
  if (orphaned.length > 0) {
    console.error(JSON.stringify({ event: "render_worker_orphaned_leases_released", workerNodeId, jobIds: orphaned.map((item) => item.job_id) }));
  }
  return orphaned.length;
}

export async function claimRenderJobV2(registrationId: string, workerNodeId: string): Promise<Claimed | null> {
  await reapExpiredRenderIntentLeasesV2();
  // An authenticated poll is liveness evidence even when the queue is empty
  // or contains no work compatible with this worker.
  const [pollingWorker] = await queryRows<{ id: string }>(
    `UPDATE simforge.worker_nodes w
        SET last_heartbeat_at = NOW(),
            last_idle_heartbeat_at = CASE WHEN NOT EXISTS (
              SELECT 1 FROM simforge.worker_leases lease
               WHERE lease.worker_node_id = w.id AND lease.lease_state = 'active'
                 AND lease.expires_at > NOW()
            ) THEN NOW() ELSE w.last_idle_heartbeat_at END
      WHERE w.registration_id = :registration_id AND w.id = :worker_node_id
        AND w.environment = :environment AND w.registration_state = 'active'
        AND w.approved_worker_version = w.worker_version
        AND w.approved_image_digest = w.image_digest
        AND w.approved_hardware_profile = w.hardware_profile
        AND w.approved_at IS NOT NULL
      RETURNING w.id`,
    { registration_id: registrationId, worker_node_id: workerNodeId, environment: runtimeEnvironment() },
  );
  if (!pollingWorker) return null;
  // The candidate page carries only what screening reads. Whole intents put up
  // to 32 map closures in one response, which exceeds the Data API's 1 MB cap
  // as soon as two large-map native jobs are queued.
  const candidates = await queryRows<Candidate>(
    `SELECT id, renderer_engine, render_intent->'renderSpec' AS render_spec, intent_sha256, resource_request,
            render_intent->'scenarioRevision'->'map'->>'revisionId' AS map_version_id,
            render_intent->>'renderTextures' AS render_textures
       FROM simforge.render_jobs
      WHERE job_state = 'queued' AND cancel_requested_at IS NULL
        AND request_contract_version = :contract
      ORDER BY priority DESC, created_at, id LIMIT 32`,
    { contract: RENDER_INTENT_V1_SCHEMA },
  );
  for (const candidate of candidates) {
    const claimed = await withTransaction(async (tx): Promise<Claimed | null> => {
      const worker = await tx.queryOne<WorkerRow>(
        `SELECT id, registration_id, worker_version, image_digest, renderer_engine, hardware_profile,
                metadata->>'baseImageDigest' AS base_image_digest,
                (metadata->>'gpuMemoryMiB')::integer AS gpu_memory_mib,
                metadata->>'baseImagePlatformDigest' AS base_image_platform_digest,
                capabilities::text AS capabilities,
                metadata->'labels'->>'inputUrls' AS input_urls,
                metadata->'cacheStatus'->'demand' AS cache_demand,
                metadata->'labels'->>'controlFeatures' AS control_features
           FROM simforge.worker_nodes
          WHERE registration_id = :registration_id AND id = :worker_node_id AND environment = :environment
            AND registration_state = 'active'
            AND approved_worker_version = worker_version
            AND approved_image_digest = image_digest
            AND approved_hardware_profile = hardware_profile
            AND approved_at IS NOT NULL
          FOR UPDATE`,
        { registration_id: registrationId, worker_node_id: workerNodeId, environment: runtimeEnvironment() },
      );
      if (!worker || !workerCanRun(worker, candidate)) return null;
      const busy = await tx.queryOne<{ id: string }>(
        `SELECT id FROM simforge.worker_leases
          WHERE worker_node_id = :worker_id AND lease_state = 'active' LIMIT 1`,
        { worker_id: worker.id },
      );
      if (busy) return null;
      const row = await tx.queryOne<{
        id: string; workspace_id: string; revision_id: string; execution_package_id: string;
        execution_package_control_sha256: string; attempt_count: number; intent_sha256: string;
      }>(
        `SELECT id, workspace_id, revision_id, execution_package_id,
                execution_package_control_sha256, attempt_count, intent_sha256
           FROM simforge.render_jobs
          WHERE id = :job_id AND renderer_engine = :renderer_engine
            AND job_state = 'queued' AND cancel_requested_at IS NULL
            AND request_contract_version = :contract
          FOR UPDATE`,
        { job_id: candidate.id, renderer_engine: worker.renderer_engine, contract: RENDER_INTENT_V1_SCHEMA },
      );
      if (!row) return null;
      // The row is locked above, so its intent is read in slices under that lock.
      const intentText = await readRenderIntentText((sql, params) => tx.queryRows(sql, params), row.id);
      if (intentText === null) return null;
      const intent = ScenarioRenderIntentSchema.parse(JSON.parse(intentText));
      if (hashRenderIntent(intent) !== row.intent_sha256) throw new Error("render_intent_digest_mismatch");
      const attempt = Number(row.attempt_count) + 1;
      const attemptId = scenarioId("usat");
      const leaseId = scenarioId("uslease");
      const fenceToken = randomBytes(32).toString("hex");
      const expiry = await tx.queryOne<{ expires_at: string }>(
        `SELECT (NOW() + (:seconds * INTERVAL '1 second'))::text AS expires_at`,
        { seconds: LEASE_SECONDS },
      );
      if (!expiry) throw new Error("lease_expiry_missing");
      await tx.execute(
        `INSERT INTO simforge.render_attempts (
           id, workspace_id, render_job_id, attempt_number, worker_node_id,
           execution_package_id, execution_package_control_sha256,
           worker_class, runtime_version, image_digest,
           renderer_engine, base_image_digest, base_image_platform_digest, engine_capabilities_sha256
         ) SELECT :attempt_id, workspace_id, id, :attempt, :worker_id,
                  execution_package_id, execution_package_control_sha256,
                  :worker_class, :runtime_version, :image_digest,
                  :renderer_engine, :base_image_digest, :base_image_platform_digest, :engine_capabilities_sha256
             FROM simforge.render_jobs WHERE id = :job_id`,
        {
          attempt_id: attemptId,
          attempt,
          worker_id: worker.id,
          worker_class: worker.renderer_engine,
          runtime_version: worker.worker_version,
          image_digest: worker.image_digest,
          renderer_engine: worker.renderer_engine,
          base_image_digest: worker.base_image_digest,
          base_image_platform_digest: worker.base_image_platform_digest,
          engine_capabilities_sha256: canonicalJsonSha256(parseObject(worker.capabilities)),
          job_id: row.id,
        },
      );
      await tx.execute(
        `INSERT INTO simforge.worker_leases (
           id, workspace_id, render_job_id, render_attempt_id, worker_node_id, lease_token_sha256, expires_at
         ) VALUES (
           :lease_id, :workspace_id, :job_id, :attempt_id, :worker_id, :token_sha256, CAST(:expires_at AS timestamptz)
         )`,
        {
          lease_id: leaseId,
          workspace_id: row.workspace_id,
          job_id: row.id,
          attempt_id: attemptId,
          worker_id: worker.id,
          token_sha256: sha256(fenceToken),
          expires_at: expiry.expires_at,
        },
      );
      await tx.execute(
        `UPDATE simforge.render_jobs
            SET job_state = 'leased', attempt_count = :attempt, started_at = COALESCE(started_at, NOW()),
                updated_at = NOW()
          WHERE id = :job_id`,
        { attempt, job_id: row.id },
      );
      // Every engine claims the intent's own input identities: the scenario as
      // `scenario.xosc` and each declared asset under its `assetId` (the XODR
      // and asset-catalog artifact ids). The worker admits exactly that set
      // (`validateClaimedInputs`) and the CARLA engine requires it
      // (`local.py` `_intent_lease`), so legacy package-role names such as
      // `openscenario`/`map`/`catalog`/`execution-package` would fail every lease.
      const inputs: ClaimedInput[] = await tx.queryRows<StoredInput>(
          `SELECT input_id AS "inputId", sha256, size_bytes AS "sizeBytes",
                  storage_bucket AS bucket, storage_key AS key
             FROM (
               SELECT 'scenario.xosc'::text AS input_id, a.sha256, a.byte_length AS size_bytes,
                      a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep
                 JOIN simforge.artifacts a ON a.id = ep.xosc_artifact_id
                WHERE ep.id = :package_id
               UNION ALL
               SELECT a.id::text, a.sha256, a.byte_length, a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep
                 JOIN simforge.artifacts a ON a.id = ep.xodr_artifact_id
                WHERE ep.id = :package_id
               UNION ALL
               SELECT a.id::text, a.sha256, a.byte_length, a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep
                 JOIN simforge.asset_catalog_versions c ON c.id = ep.asset_catalog_version_id
                 JOIN simforge.artifacts a ON a.id = c.manifest_artifact_id
                WHERE ep.id = :package_id
             ) input_rows`,
          { package_id: row.execution_package_id },
        );
      // The authoritative render timeline, when the revision's simulation has
      // one: canonical JSON bytes whose sha256 is the intent's timelineSha256.
      // Both engines prefer it; jobs without it fall back to the xosc.
      const timelineAsset = intent.assets.find((asset) => asset.assetId === RENDER_TIMELINE_INPUT_ID);
      if (timelineAsset) {
        const timeline = (await renderTimelineObject(
          (sql, params) => tx.queryRows(sql, params), row.id,
        ));
        if (!timeline || timeline.sha256 !== timelineAsset.sha256 || timeline.sizeBytes !== timelineAsset.sizeBytes) {
          throw new Error("render_timeline_unavailable");
        }
        inputs.push({
          inputId: RENDER_TIMELINE_INPUT_ID,
          sha256: timeline.sha256,
          sizeBytes: timeline.sizeBytes,
          bucket: timeline.bucket,
          key: timeline.key,
        });
      }
      if (worker.renderer_engine === "native") {
        const nativeMembers = await tx.queryRows<{
          relative_path: string;
          sha256: string;
          byte_length: number | string;
          storage_bucket: string;
          storage_key: string;
          object_count: number | string;
        }>(
          `SELECT m.relative_path, b.sha256, b.byte_length, b.storage_bucket, b.storage_key,
                  s.object_count
             FROM simforge.revisions r
             JOIN simforge.map_versions mv
               ON mv.id = r.map_version_id
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
            WHERE r.id = :revision_id AND r.workspace_id = :workspace_id
            ORDER BY m.relative_path`,
          { revision_id: row.revision_id, workspace_id: row.workspace_id },
        );
        const expectedCount = Number(nativeMembers[0]?.object_count ?? -1);
        if (expectedCount < 1 || nativeMembers.length !== expectedCount) {
          throw new Error("native_map_asset_set_incomplete");
        }
        const renderMembers = nativeMembers.filter((member) => member.relative_path !== ".map-release.json");
        if (!renderMembers.some((member) => member.relative_path === "master.gltf")) {
          throw new Error("native_map_master_unavailable");
        }
        assertNativeMapMemberCapacity(renderMembers.length);
        inputs.push(...renderMembers.map((member) => ({
          inputId: member.relative_path === "master.gltf"
            ? "map.tile.000000"
            : `map.resource.${sha256(member.relative_path)}`,
          relativePath: member.relative_path,
          sha256: member.sha256,
          sizeBytes: Number(member.byte_length),
          bucket: member.storage_bucket,
          key: member.storage_key,
        })));
        const actorAssets = nativeActorAssetsInput();
        inputs.push({
          inputId: actorAssets.inputId,
          relativePath: actorAssets.relativePath,
          sha256: actorAssets.sha256,
          sizeBytes: actorAssets.sizeBytes,
          url: actorAssets.downloadUrl,
        });
        const byInputId = new Map(inputs.map((input) => [input.inputId, input]));
        if (byInputId.size !== inputs.length
          || inputs.length !== intent.assets.length + 1
          || !intent.assets.some((asset) => asset.assetId === NATIVE_ACTOR_ASSETS_INPUT_ID)
          || intent.assets.some((asset) => {
            const declared = byInputId.get(asset.assetId);
            return !declared || declared.sha256 !== asset.sha256 || Number(declared.sizeBytes) !== asset.sizeBytes;
          })) {
          throw new Error("native_render_input_declaration_mismatch");
        }
      } else {
        const byInputId = new Map(inputs.map((input) => [input.inputId, input]));
        if (byInputId.size !== inputs.length
          || inputs.length !== intent.assets.length + 1
          || !byInputId.has("scenario.xosc")
          || intent.assets.some((asset) => {
            const declared = byInputId.get(asset.assetId);
            return !declared || declared.sha256 !== asset.sha256 || Number(declared.sizeBytes) !== asset.sizeBytes;
          })) {
          throw new Error("carla_render_input_declaration_mismatch");
        }
      }
      return {
        jobId: row.id,
        attempt,
        attemptId,
        leaseId,
        fenceToken,
        expiresAt: expiry.expires_at,
        intent,
        intentSha256: row.intent_sha256,
        executionPackageControlSha256: row.execution_package_control_sha256,
        inputs,
        lazyInputUrls: worker.input_urls === "batch-v1",
        controlFeatures: worker.control_features === WORKER_CONTROL_FEATURES_V1,
      };
    }).catch((error: unknown): null => {
      // One job that cannot be leased (an incomplete map closure, a digest
      // mismatch, an oversized read) must not fail every worker's poll: the
      // candidates are oldest first, so rethrowing would pin the whole queue
      // behind it. Its transaction rolled back, so the job stays queued and
      // unleased, and the next candidate is offered instead.
      console.error(JSON.stringify({
        event: "render_lease_candidate_failed",
        jobId: candidate.id,
        workerNodeId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return null;
    });
    if (claimed) return claimed;
  }
  return null;
}

export async function claimResponseV2(registrationId: string, workerNodeId: string, request?: Request) {
  const claimed = await claimRenderJobV2(registrationId, workerNodeId);
  if (!claimed) {
    return { schema: CONTROL_SCHEMA, type: "job.none" as const, retryAfterMs: 2_000 };
  }
  return {
    schema: CONTROL_SCHEMA,
    type: "job.leased" as const,
    jobId: claimed.jobId,
    attempt: claimed.attempt,
    lease: {
      leaseId: claimed.leaseId,
      fenceToken: claimed.fenceToken,
      expiresAt: new Date(claimed.expiresAt).toISOString(),
    },
    intent: claimed.intent,
    intentSha256: claimed.intentSha256,
    executionPackageControlSha256: claimed.executionPackageControlSha256,
    ...(claimed.controlFeatures ? { controlFeatures: [...CONTROL_FEATURES_V1] } : {}),
    // A `batch-v1` worker gets identities only for stored inputs and signs
    // just its cache misses (`input-urls`): a large native map would
    // otherwise put thousands of signed URLs, each with a refresh block
    // repeating the worker's bearer token, into one ~12 MB claim.
    inputs: await Promise.all(claimed.inputs.map(async (input) => ({
      inputId: input.inputId,
      ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
      sha256: input.sha256,
      sizeBytes: Number(input.sizeBytes),
      ...(claimed.lazyInputUrls && !("url" in input) ? {} : { download: {
        url: "url" in input ? input.url : await getPresignedGetUrl(input.key, input.bucket, LEASE_SECONDS),
        headers: {},
        ...("url" in input ? {} : {
          expiresAt: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(),
          ...(request ? { refresh: {
            url: new URL(`/api/simforge/internal/render-jobs/${claimed.jobId}/inputs/${encodeURIComponent(input.inputId)}`, request.url).href,
            headers: {
              authorization: request.headers.get("authorization") ?? "",
              "x-simforge-worker-node-id": workerNodeId,
              "x-simforge-lease-id": claimed.leaseId,
              "x-simforge-fence-token": claimed.fenceToken,
            },
          } } : {}),
        }),
      } }),
    }))),
  };
}

type ActiveLease = {
  lease_id: string;
  job_id: string;
  workspace_id: string;
  attempt_id: string;
  attempt_number: number;
  worker_node_id: string;
  intent_sha256: string;
  render_intent: string | Record<string, unknown>;
  cancel_requested_at: string | null;
  renderer_engine: "browser" | "carla" | "native";
  execution_package_id: string;
  execution_package_control_sha256: string;
  source_input_digest: string;
  xsd_sha256: string;
};

async function activeLease(
  leaseId: string,
  fenceToken: string,
  workerNodeId: string,
  jobId: string,
) {
  const rows = await queryRows<Omit<ActiveLease, "render_intent">>(
    `SELECT l.id AS lease_id, j.id AS job_id, j.workspace_id, l.render_attempt_id AS attempt_id,
            a.attempt_number, l.worker_node_id, j.intent_sha256,
            j.cancel_requested_at::text AS cancel_requested_at,
            j.renderer_engine, j.execution_package_id, j.execution_package_control_sha256,
            ep.source_input_digest, ep.xsd_sha256
       FROM simforge.worker_leases l
       JOIN simforge.render_jobs j ON j.id = l.render_job_id
       JOIN simforge.render_attempts a ON a.id = l.render_attempt_id
       JOIN simforge.execution_packages ep ON ep.id = j.execution_package_id
      WHERE l.id = :lease_id AND l.worker_node_id = :worker_node_id
        AND j.id = :job_id
        AND l.lease_token_sha256 = :token_sha256 AND l.lease_state = 'active'
        AND l.expires_at > NOW() AND j.job_state IN ('leased', 'running')
      LIMIT 1`,
    { lease_id: leaseId, job_id: jobId, worker_node_id: workerNodeId, token_sha256: sha256(fenceToken) },
  );
  const lease = rows[0];
  if (!lease) return null;
  const renderIntent = await readRenderIntentText(queryRows, lease.job_id);
  if (renderIntent === null) return null;
  return { ...lease, render_intent: renderIntent } satisfies ActiveLease;
}

/** The stored render timeline of a job's authoritative simulation result. */
async function renderTimelineObject(
  query: <T>(sql: string, params: SqlParams) => Promise<T[]>,
  jobId: string,
): Promise<{ sha256: string; sizeBytes: number; bucket: string; key: string } | null> {
  const rows = await query<{
    storage_bucket: string; timeline_storage_key: string | null; timeline_sha256: string | null; timeline_byte_length: number | string | null;
  }>(
    `SELECT s.storage_bucket, s.timeline_storage_key, s.timeline_sha256, s.timeline_byte_length
       FROM simforge.sim_results s
       JOIN simforge.render_jobs j ON j.workspace_id = s.workspace_id AND j.sim_key = s.sim_key
      WHERE j.id = :job_id`,
    { job_id: jobId },
  );
  const row = rows[0];
  if (!row?.timeline_storage_key || !row.timeline_sha256 || row.timeline_byte_length === null) return null;
  return { sha256: row.timeline_sha256, sizeBytes: Number(row.timeline_byte_length), bucket: row.storage_bucket, key: row.timeline_storage_key };
}

/** Re-authorize each refresh against the live lease and immutable input digest; no URL/session state is stored. */
export async function refreshRenderInputV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; inputId: string;
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease || lease.cancel_requested_at) return null;
  const intent = parseRenderIntent(lease.render_intent);
  const declared = intent.assets.find((asset) => asset.assetId === input.inputId);
  const scenarioInput = input.inputId === "scenario.xosc";
  if (!declared && !scenarioInput) return null;
  if (declared && input.inputId === RENDER_TIMELINE_INPUT_ID) {
    const timeline = await renderTimelineObject(queryRows, lease.job_id);
    if (!timeline || timeline.sha256 !== declared.sha256 || timeline.sizeBytes !== declared.sizeBytes) return null;
    const url = await getPresignedGetUrl(timeline.key, timeline.bucket, LEASE_SECONDS);
    return { url, headers: {}, expiresAt: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString() };
  }
  const rows = scenarioInput
    ? await queryRows<{ storage_bucket: string; storage_key: string }>(
      `SELECT a.storage_bucket, a.storage_key FROM simforge.execution_packages ep
       JOIN simforge.artifacts a ON a.id = ep.xosc_artifact_id
       WHERE ep.id = :package_id`,
      { package_id: lease.execution_package_id },
    )
    : await queryRows<{ storage_bucket: string; storage_key: string }>(
      `SELECT storage_bucket, storage_key FROM simforge.artifacts
       WHERE sha256 = :sha256 AND byte_length = :size
       UNION ALL SELECT storage_bucket, storage_key FROM simforge.native_map_asset_blobs
       WHERE sha256 = :sha256 AND byte_length = :size AND verification_state = 'verified'
       LIMIT 1`,
      { sha256: declared!.sha256, size: declared!.sizeBytes },
    );
  const object = rows[0];
  if (!object) return null;
  const url = await getPresignedGetUrl(object.storage_key, object.storage_bucket, LEASE_SECONDS);
  return { url, headers: {}, expiresAt: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString() };
}

/**
 * Batch download URLs for a live lease's inputs (`render-jobs/{jobId}/input-urls`).
 * Each id is authorized exactly like a single-input refresh: it must be a
 * package input or an asset the leased intent declares, and the object is
 * found by the declared digest and size. Unknown ids are omitted.
 */
export async function signRenderInputsV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; inputIds: readonly string[];
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease || lease.cancel_requested_at) return null;
  const intent = parseRenderIntent(lease.render_intent);
  const declared = new Map(intent.assets.map((asset) => [asset.assetId, asset]));
  const expiresAt = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  const downloads: Record<string, { url: string; headers: Record<string, string>; expiresAt?: string }> = {};
  const byDigest = new Map<string, string[]>();
  for (const inputId of new Set(input.inputIds)) {
    if (inputId === NATIVE_ACTOR_ASSETS_INPUT_ID) {
      downloads[inputId] = { url: nativeActorAssetsInput().downloadUrl, headers: {} };
      continue;
    }
    const asset = declared.get(inputId);
    if (asset) {
      const key = `${asset.sha256}:${asset.sizeBytes}`;
      byDigest.set(key, [...(byDigest.get(key) ?? []), inputId]);
      continue;
    }
    // Package inputs (scenario, and CARLA's map/catalog/package) resolve through the single-input path.
    const single = await refreshRenderInputV2({ ...input, inputId });
    if (single) downloads[inputId] = single;
  }
  if (byDigest.size > 0) {
    const digests = [...new Set([...byDigest.keys()].map((key) => key.split(":")[0]!))];
    const rows = await queryRows<{ sha256: string; byte_length: number | string; storage_bucket: string; storage_key: string }>(
      `SELECT sha256, byte_length, storage_bucket, storage_key FROM simforge.native_map_asset_blobs
        WHERE sha256 = ANY(string_to_array(:digests, ',')) AND verification_state = 'verified'
       UNION ALL
       SELECT sha256, byte_length, storage_bucket, storage_key FROM simforge.artifacts
        WHERE sha256 = ANY(string_to_array(:digests, ','))`,
      { digests: digests.join(",") },
    );
    const objects = new Map<string, { storage_bucket: string; storage_key: string }>();
    for (const row of rows) {
      const key = `${row.sha256}:${Number(row.byte_length)}`;
      if (!objects.has(key)) objects.set(key, row);
    }
    await Promise.all([...byDigest].map(async ([key, inputIds]) => {
      const object = objects.get(key);
      if (!object) return;
      const url = await getPresignedGetUrl(object.storage_key, object.storage_bucket, LEASE_SECONDS);
      for (const inputId of inputIds) downloads[inputId] = { url, headers: {}, expiresAt };
    }));
  }
  return { schema: CONTROL_SCHEMA, type: "lease.input-urls" as const, downloads };
}

export async function heartbeatRenderLeaseV2(input: {
  jobId: string; leaseId: string; fenceToken: string; progressSequence: number; workerNodeId: string;
}) {
  const rows = await queryRows<{ expires_at: string; cancel_requested_at: string | null; durable_sequence: number }>(
    `UPDATE simforge.worker_leases l
        SET heartbeat_at = NOW(), expires_at = NOW() + (:seconds * INTERVAL '1 second')
       FROM simforge.render_jobs j
      WHERE l.id = :lease_id AND l.render_job_id = j.id
        AND j.id = :job_id
        AND l.worker_node_id = :worker_node_id AND l.lease_token_sha256 = :token_sha256
        AND l.lease_state = 'active' AND l.expires_at > NOW()
        AND COALESCE((j.progress_detail->>'sequence')::bigint, 0) >= :progress_sequence
      RETURNING l.expires_at::text AS expires_at, j.cancel_requested_at::text AS cancel_requested_at,
                COALESCE((j.progress_detail->>'sequence')::bigint, 0)::bigint AS durable_sequence`,
    {
      job_id: input.jobId,
      lease_id: input.leaseId,
      worker_node_id: input.workerNodeId,
      token_sha256: sha256(input.fenceToken),
      progress_sequence: input.progressSequence,
      seconds: LEASE_SECONDS,
    },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    schema: CONTROL_SCHEMA,
    type: "lease.heartbeat-ack" as const,
    leaseExpiresAt: new Date(row.expires_at).toISOString(),
    cancelRequested: row.cancel_requested_at !== null,
    cancelReason: row.cancel_requested_at ? "user_requested" : null,
  };
}

function progressRatio(record: RenderProgressRecord) {
  if (record.event !== "stage.progress") return null;
  const stageOffset: Record<typeof record.stage, number> = {
    downloading: 0,
    preparing: 0.1,
    rendering: 0.2,
    encoding: 0.75,
    uploading: 0.85,
    finalizing: 0.95,
  };
  const stageSpan: Record<typeof record.stage, number> = {
    downloading: 0.1,
    preparing: 0.1,
    rendering: 0.55,
    encoding: 0.1,
    uploading: 0.1,
    finalizing: 0.05,
  };
  return Math.min(0.999, stageOffset[record.stage] + stageSpan[record.stage] * record.completed / record.total);
}

export async function appendRenderProgressV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; records: RenderProgressRecord[];
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease) return null;
  if (input.records.some((record) => record.jobId !== lease.job_id || record.attempt !== lease.attempt_number)) {
    throw new Error("render_progress_lineage_mismatch");
  }
  const ordered = [...input.records].sort((left, right) => left.sequence - right.sequence);
  if (ordered.some((record, index) => index > 0 && record.sequence !== ordered[index - 1]!.sequence + 1)) {
    throw new Error("render_progress_sequence_gap");
  }
  await withTransaction(async (tx) => {
    const current = await tx.queryOne<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence), -1)::bigint AS sequence
         FROM simforge.render_progress_records WHERE render_attempt_id = :attempt_id`,
      { attempt_id: lease.attempt_id },
    );
    const expected = Number(current?.sequence ?? -1) + 1;
    if (ordered[0]!.sequence > expected) throw new Error("render_progress_sequence_gap");
    for (const record of ordered) {
      await tx.execute(
        `INSERT INTO simforge.render_progress_records (
           render_job_id, render_attempt_id, sequence, record
         ) VALUES (:job_id, :attempt_id, :sequence, CAST(:record AS jsonb))
         ON CONFLICT (render_attempt_id, sequence) DO NOTHING`,
        { job_id: lease.job_id, attempt_id: lease.attempt_id, sequence: record.sequence, record },
      );
    }
    const latest = ordered.at(-1)!;
    const ratio = progressRatio(latest);
    await tx.execute(
      `UPDATE simforge.render_jobs
          SET job_state = CASE WHEN job_state = 'leased' THEN 'running' ELSE job_state END,
              progress_detail = CAST(:detail AS jsonb),
              progress = GREATEST(progress, COALESCE(:progress, progress)), updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id`,
      { detail: latest, progress: ratio, job_id: lease.job_id, workspace_id: lease.workspace_id },
    );
    await tx.execute(
      `UPDATE simforge.render_attempts SET attempt_state = 'running', started_at = COALESCE(started_at, NOW())
        WHERE id = :attempt_id`,
      { attempt_id: lease.attempt_id },
    );
  });
  return {
    schema: CONTROL_SCHEMA,
    type: "lease.progress-ack" as const,
    acceptedThroughSequence: ordered.at(-1)!.sequence,
  };
}

function identityKind(identity: RenderArtifactIdentity) {
  return identity.actorId
    ? `${identity.role}-${identity.actorId}-${identity.sensorId}-${identity.modality}`
    : identity.role;
}

function identityExpected(intentValue: unknown, identity: RenderArtifactIdentity) {
  const intent = parseRenderIntent(intentValue);
  if (identity.role === "diagnostics") return true;
  if (identity.actorId === null) return intent.renderSpec.artifacts.includes(identity.role);
  if (!intent.renderSpec.artifacts.includes(identity.role)) return false;
  return intent.renderSpec.sources.some((source) =>
    source.actorId === identity.actorId
    && source.sensorId === identity.sensorId
    && source.modality === identity.modality
  );
}

export async function reserveRenderArtifactV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; identity: RenderArtifactIdentity;
  sha256: string; sizeBytes: number; mediaType: string;
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease || !identityExpected(lease.render_intent, input.identity)) return null;
  const artifactId = scenarioId("usart");
  const bucket = artifactBucket();
  const key = `${lease.workspace_id}/renders/${lease.job_id}/${lease.attempt_id}/${artifactId}`;
  const rows = await queryRows<{ id: string }>(
    `INSERT INTO simforge.artifact_uploads (
       id, workspace_id, revision_id, render_job_id, render_attempt_id,
       artifact_kind, artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality,
       media_type, expected_sha256, expected_size_bytes, bound_at,
       storage_bucket, storage_key, expires_at
     ) SELECT :id, j.workspace_id, j.revision_id, j.id, :attempt_id,
              :artifact_kind, :artifact_role, :actor_id, :sensor_id, :modality,
              :media_type, :sha256, :size_bytes, NOW(),
              :bucket, :key, NOW() + INTERVAL '15 minutes'
         FROM simforge.render_jobs j
        WHERE j.id = :job_id AND j.cancel_requested_at IS NULL
          AND EXISTS (
            SELECT 1 FROM simforge.worker_leases l
             WHERE l.id = :lease_id AND l.render_attempt_id = :attempt_id
               AND l.worker_node_id = :worker_node_id
               AND l.lease_token_sha256 = :token_sha256
               AND l.lease_state = 'active' AND l.expires_at > NOW()
          )
     ON CONFLICT DO NOTHING RETURNING id`,
    {
      id: artifactId,
      attempt_id: lease.attempt_id,
      artifact_kind: `${identityKind(input.identity)}-${lease.attempt_id}`,
      artifact_role: input.identity.role,
      actor_id: input.identity.actorId,
      sensor_id: input.identity.sensorId,
      modality: input.identity.modality,
      media_type: input.mediaType,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      bucket,
      key,
      job_id: lease.job_id,
      lease_id: input.leaseId,
      worker_node_id: input.workerNodeId,
      token_sha256: sha256(input.fenceToken),
    },
  );
  if (!rows[0]) return null;
  return {
    schema: CONTROL_SCHEMA,
    type: "artifact.reserved" as const,
    artifactId,
    upload: {
      url: await getPresignedPutUrl(key, input.mediaType, bucket, 900, input.sha256),
      method: "PUT" as const,
      headers: checksumBoundPutRequiredHeaders(input.mediaType, input.sha256),
    },
  };
}

function identityKey(identity: RenderArtifactIdentity) {
  return `${identity.role}\0${identity.actorId ?? ""}\0${identity.sensorId ?? ""}\0${identity.modality ?? ""}`;
}

function expectedClosure(intentValue: unknown, rendererEngine: ActiveLease["renderer_engine"]) {
  const intent = parseRenderIntent(intentValue);
  if (rendererEngine === "native") {
    const expected = expectedNativeClosure(intent);
    expected.delete(identityKey({ role: "diagnostics", actorId: null, sensorId: null, modality: null }));
    return expected;
  }
  const expected = new Set<string>();
  for (const role of ["manifest", "trace", "annotations"] as const) {
    if (intent.renderSpec.artifacts.includes(role)) {
      expected.add(identityKey({ role, actorId: null, sensorId: null, modality: null }));
    }
  }
  for (const role of ["video", "frames", "sensorArchive"] as const) {
    if (!intent.renderSpec.artifacts.includes(role)) continue;
    for (const source of intent.renderSpec.sources) {
      expected.add(identityKey({
        role,
        actorId: source.actorId,
        sensorId: source.sensorId,
        modality: source.modality,
      }));
    }
  }
  return expected;
}

type CompletionArtifact = {
  artifactId: string;
  identity: RenderArtifactIdentity;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
};

type NativeReservation = {
  artifact_role: RenderArtifactIdentity["role"]; artifact_actor_id: string | null; artifact_sensor_id: string | null;
  artifact_modality: RenderArtifactIdentity["modality"];
  media_type: string; expected_sha256: string; expected_size_bytes: number; storage_bucket: string; storage_key: string;
};
const NATIVE_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;

async function readReservedJson(reservation: NativeReservation): Promise<unknown> {
  if (Number(reservation.expected_size_bytes) > NATIVE_EVIDENCE_MAX_BYTES) throw new Error("render_evidence_too_large");
  return JSON.parse(Buffer.from(await readLocalObject(reservation.storage_bucket, reservation.storage_key)).toString("utf8"));
}

/**
 * A native completion is accepted only when the engine's own manifest and
 * diagnostics (parsed through the shared `@simforge-oss/render/native`
 * evidence schemas) agree with the lease and the intent's schedules and
 * actor closure; see `nativeEvidenceFailure`. The validated diagnostics are
 * the run's evidence: they bind the actor appearance closure, the lowering
 * and the service protocol the run actually rendered with.
 */
/**
 * Worker evidence parsed tolerantly at the top level: fields this control
 * plane does not know (written by a newer worker) are dropped before the
 * strict parse instead of failing the whole job. Every field this plane
 * does know keeps its strict validation, so the lineage checks are intact.
 */
export function parseEvidenceTolerant<T>(schema: { shape: Record<string, unknown>; parse(value: unknown): T }, value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return schema.parse(value);
  const known = new Set(Object.keys(schema.shape));
  const dropped = Object.keys(value).filter((key) => !known.has(key));
  if (dropped.length > 0) console.error(JSON.stringify({ event: "render_evidence_unknown_fields_ignored", fields: dropped }));
  return schema.parse(Object.fromEntries(Object.entries(value).filter(([key]) => known.has(key))));
}

async function verifyNativeCompletion(lease: ActiveLease, intentSha256: string, reservations: readonly NativeReservation[]): Promise<NativeRunDiagnostics> {
  const manifestReservation = reservations.find((item) => item.artifact_role === "manifest");
  const diagnosticsReservation = reservations.find((item) => item.artifact_role === "diagnostics");
  if (!manifestReservation || !diagnosticsReservation) throw new Error("native_artifact_evidence_incomplete");
  const intent = parseRenderIntentDocument(typeof lease.render_intent === "string" ? JSON.parse(lease.render_intent) : lease.render_intent);
  const diagnostics = parseEvidenceTolerant(NativeRunDiagnosticsSchema, await readReservedJson(diagnosticsReservation));
  const failure = nativeEvidenceFailure(
    reservations.map((item) => ({
      role: item.artifact_role,
      actorId: item.artifact_actor_id,
      sensorId: item.artifact_sensor_id,
      mediaType: item.media_type,
      sha256: item.expected_sha256,
      sizeBytes: Number(item.expected_size_bytes),
    })),
    parseEvidenceTolerant(NativeRenderManifestSchema, await readReservedJson(manifestReservation)),
    diagnostics,
    nativeRunExpectations(intent, { intentSha256, executionPackageControlSha256: lease.execution_package_control_sha256 }),
  );
  if (failure) throw new Error(failure);
  return diagnostics;
}

/** Evidence a completed attempt/job is fenced on: engine-specific schema, document and attestation. */
type CompletionEvidence = {
  schema: string;
  evidence: Record<string, unknown>;
  accepted: boolean;
  attestation: Record<string, unknown>;
};

/**
 * A CARLA completion carries the executor's own manifest (`manifest.json`,
 * role `manifest`), which embeds `uniscenario.parity-evidence/v1`, the XSD
 * validation of the exact OpenSCENARIO document it replayed and the worker
 * attestation. The evidence identity must name this lease's revision, package,
 * control digest and source-input digest; the XOSC attestation must name the
 * document the intent bound. Acceptance is the parity verdict under native
 * physics, exactly as `isScenarioParityEvidenceAccepted` defines it.
 */
async function verifyCarlaCompletion(lease: ActiveLease, reservations: readonly NativeReservation[]): Promise<CompletionEvidence> {
  const manifestReservation = reservations.find((item) => item.artifact_role === "manifest");
  if (!manifestReservation) throw new Error("render_manifest_missing");
  const intent = parseRenderIntentDocument(typeof lease.render_intent === "string" ? JSON.parse(lease.render_intent) : lease.render_intent);
  const engineManifest = await readReservedJson(manifestReservation) as Record<string, unknown>;
  if (!engineManifest || typeof engineManifest !== "object" || Array.isArray(engineManifest)) throw new Error("render_manifest_invalid");
  const evidence = ScenarioParityEvidenceV1Schema.parse(engineManifest.parityEvidence);
  if (
    evidence.identity.revisionId !== intent.scenarioRevision.revisionId
    || evidence.identity.executionPackageId !== lease.execution_package_id
    || evidence.identity.executionPackageControlSha256 !== lease.execution_package_control_sha256
    || evidence.identity.sourceInputDigest !== lease.source_input_digest
  ) {
    throw new Error("parity_evidence_identity_mismatch");
  }
  const xoscValidation = engineManifest.xoscValidation as Record<string, unknown> | undefined;
  if (
    !xoscValidation
    || typeof xoscValidation !== "object"
    || Array.isArray(xoscValidation)
    || xoscValidation.valid !== true
    || xoscValidation.standardVersion !== "1.4.0"
    || xoscValidation.xmlSha256 !== intent.scenarioRevision.openScenario.sha256
    || xoscValidation.xsdSha256 !== lease.xsd_sha256
  ) {
    throw new Error("xosc_validation_evidence_mismatch");
  }
  const attestation = engineManifest.attestation ?? engineManifest.workerAttestation;
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) throw new Error("worker_attestation_invalid");
  return {
    schema: SCENARIO_PARITY_EVIDENCE_VERSION,
    evidence,
    accepted: isScenarioParityEvidenceAccepted(evidence),
    attestation: attestation as Record<string, unknown>,
  };
}

const BROWSER_RENDER_MANIFEST_V1_SCHEMA = "simforge.browser-render-manifest/v1";
const BrowserReceiptSchema = z.object({
  role: z.enum(["sensor-frames", "sensor-archive", "sensor-video", "render-manifest"]),
  actorId: z.string().min(1).nullable(),
  sensorId: z.string().min(1).nullable(),
  modality: z.string().min(1),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** The document `captureBrowserArtifacts` writes as its `render-manifest` artifact. */
const BrowserRenderManifestSchema = z.object({
  schema: z.literal(BROWSER_RENDER_MANIFEST_V1_SCHEMA),
  engine: z.literal("browser"),
  intentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  frameMajor: z.literal(true),
  schedule: z.object({
    startSeconds: z.number().finite().min(0),
    endSeconds: z.number().finite().positive(),
    fps: z.number().finite().positive(),
    frameCount: z.number().int().positive(),
    timestampUnit: z.literal("microseconds"),
    firstTimestampUs: z.literal(0),
    endTimestampUs: z.number().int().positive(),
  }),
  artifacts: z.array(BrowserReceiptSchema).max(4096),
  omittedArtifacts: z.array(z.object({
    role: z.enum(["sensor-archive", "sensor-video"]),
    actorId: z.string().min(1),
    sensorId: z.string().min(1),
    modality: z.string().min(1),
    reason: z.string().min(1),
  })).max(4096),
}).passthrough();
/**
 * Receipt roles as `@simforge-oss/render/web` uploads them: the per-frame
 * pose stream (`sensor-frames`) travels as the global `diagnostics` artifact.
 */
const BROWSER_RECEIPT_ROLE: Record<string, RenderArtifactIdentity["role"]> = {
  "sensor-frames": "diagnostics",
  "sensor-archive": "sensorArchive",
  "sensor-video": "video",
  "render-manifest": "manifest",
};

/**
 * A browser completion carries the capture's own `render-manifest`: the
 * frame-major fixed-step schedule it rendered and a hashed receipt for every
 * byte stream it wrote. The schedule must be exactly the intent's clip at the
 * intent's capture rate, and every reserved output must be a receipt with the
 * same identity, media type, size and digest (and vice versa), so the frames
 * and bytes the host verified are the ones the capture attests. No CARLA
 * parity is demanded of the browser: it replays immutable playback evidence.
 */
async function verifyBrowserCompletion(lease: ActiveLease, intentSha256: string, reservations: readonly NativeReservation[]): Promise<CompletionEvidence> {
  const manifestReservation = reservations.find((item) => item.artifact_role === "manifest");
  if (!manifestReservation) throw new Error("render_manifest_missing");
  const intent = parseRenderIntentDocument(typeof lease.render_intent === "string" ? JSON.parse(lease.render_intent) : lease.render_intent);
  const manifest = BrowserRenderManifestSchema.parse(await readReservedJson(manifestReservation));
  if (manifest.intentSha256 !== intentSha256) throw new Error("browser_render_manifest_intent_mismatch");
  const { clip } = intent.renderSpec;
  const fps = captureScheduleFps(intent.renderSpec);
  const frameCount = fixedStepFrameCount(clip.startSeconds, clip.endSeconds, fps);
  const { schedule } = manifest;
  if (
    schedule.startSeconds !== clip.startSeconds
    || schedule.endSeconds !== clip.endSeconds
    || schedule.fps !== fps
    || schedule.frameCount !== frameCount
    || schedule.endTimestampUs !== Math.round(frameCount * 1_000_000 / fps)
  ) {
    throw new Error("browser_render_schedule_mismatch");
  }
  const receipts = new Map<string, z.infer<typeof BrowserReceiptSchema>>();
  for (const receipt of manifest.artifacts) {
    if (receipt.role === "render-manifest") continue;
    const sensor = receipt.role !== "sensor-frames";
    const key = identityKey({
      role: BROWSER_RECEIPT_ROLE[receipt.role]!,
      actorId: sensor ? receipt.actorId : null,
      sensorId: sensor ? receipt.sensorId : null,
      modality: sensor ? receipt.modality : null,
    } as RenderArtifactIdentity);
    if (receipts.has(key)) throw new Error("browser_render_manifest_duplicate_receipt");
    receipts.set(key, receipt);
  }
  const outputs = reservations.filter((item) => item.artifact_role !== "manifest");
  if (outputs.length !== receipts.size) throw new Error("browser_render_manifest_closure_mismatch");
  for (const reserved of outputs) {
    const receipt = receipts.get(identityKey({
      role: reserved.artifact_role,
      actorId: reserved.artifact_actor_id,
      sensorId: reserved.artifact_sensor_id,
      modality: reserved.artifact_modality,
    } as RenderArtifactIdentity));
    if (!receipt
      || receipt.sha256 !== reserved.expected_sha256
      || receipt.byteLength !== Number(reserved.expected_size_bytes)
      || receipt.mediaType !== reserved.media_type) {
      throw new Error("browser_render_manifest_receipt_mismatch");
    }
  }
  return {
    schema: BROWSER_RENDER_MANIFEST_V1_SCHEMA,
    evidence: manifest,
    accepted: true,
    attestation: {
      schema: "simforge.browser-render-attestation/v1",
      intentSha256,
      engine: manifest.engine,
      frameCount: schedule.frameCount,
      omittedArtifacts: manifest.omittedArtifacts,
    },
  };
}

async function verifyCompletion(lease: ActiveLease, intentSha256: string, reservations: readonly NativeReservation[]): Promise<CompletionEvidence> {
  if (lease.renderer_engine === "native") {
    const diagnostics = await verifyNativeCompletion(lease, intentSha256, reservations);
    return {
      schema: diagnostics.schema,
      evidence: diagnostics,
      accepted: true,
      attestation: {
        schema: "simforge.native-render-attestation/v1",
        intentSha256,
        loweringSha256: diagnostics.loweringSha256,
        actorAssetsSha256: diagnostics.actorAssetsSha256,
        service: diagnostics.service,
      },
    };
  }
  if (lease.renderer_engine === "carla") return verifyCarlaCompletion(lease, reservations);
  return verifyBrowserCompletion(lease, intentSha256, reservations);
}

export async function completeRenderJobV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; intentSha256: string;
  manifest: { artifacts: CompletionArtifact[] };
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease || lease.intent_sha256 !== input.intentSha256) return null;
  const expected = expectedClosure(lease.render_intent, lease.renderer_engine);
  const actual = new Set(input.manifest.artifacts.filter((item) => item.identity.role !== "diagnostics").map((item) => identityKey(item.identity)));
  if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key))) {
    throw new Error("render_artifact_closure_mismatch");
  }
  const reservations = await queryRows<{
    id: string; artifact_role: RenderArtifactIdentity["role"]; artifact_actor_id: string | null;
    artifact_sensor_id: string | null; artifact_modality: RenderArtifactIdentity["modality"];
    artifact_kind: string; media_type: string; expected_sha256: string; expected_size_bytes: number;
    storage_bucket: string; storage_key: string;
  }>(
    `SELECT id, artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality,
            artifact_kind, media_type, expected_sha256, expected_size_bytes,
            storage_bucket, storage_key
       FROM simforge.artifact_uploads
      WHERE render_attempt_id = :attempt_id AND upload_state = 'reserved'`,
    { attempt_id: lease.attempt_id },
  );
  if (reservations.length !== input.manifest.artifacts.length) throw new Error("render_artifact_closure_mismatch");
  const byId = new Map(reservations.map((row) => [row.id, row]));
  for (const declared of input.manifest.artifacts) {
    const reserved = byId.get(declared.artifactId);
    if (!reserved
      || reserved.expected_sha256 !== declared.sha256
      || Number(reserved.expected_size_bytes) !== declared.sizeBytes
      || reserved.media_type !== declared.mediaType
      || identityKey({
        role: reserved.artifact_role,
        actorId: reserved.artifact_actor_id,
        sensorId: reserved.artifact_sensor_id,
        modality: reserved.artifact_modality,
      } as RenderArtifactIdentity) !== identityKey(declared.identity)) {
      throw new Error("render_artifact_reservation_mismatch");
    }
    const object = await headS3Object(reserved.storage_key, reserved.storage_bucket);
    const checksum = object.checksumSha256
      ? Buffer.from(object.checksumSha256, "base64").toString("hex")
      : null;
    if (object.contentLength !== declared.sizeBytes || object.contentType !== declared.mediaType || checksum !== declared.sha256) {
      throw new Error("render_artifact_verification_failed");
    }
  }
  // Success is fenced by the database: a succeeded full render must carry
  // accepted evidence of the engine that rendered it, verified against the
  // engine's own output document before the fenced transaction.
  const completion = await verifyCompletion(lease, input.intentSha256, reservations);
  // A CARLA run whose parity verdict failed is a verified, rejected result: it
  // never becomes a succeeded job (the database fence would refuse it too).
  if (!completion.accepted) throw new Error("parity_evidence_rejected");
  const evidence = {
    parity_schema: completion.schema,
    parity_evidence: JSON.stringify(completion.evidence),
    attestation: JSON.stringify(completion.attestation),
  };
  await withTransaction(async (tx) => {
    const fenced = await tx.queryOne<{ id: string }>(
      `SELECT l.id FROM simforge.worker_leases l
        JOIN simforge.render_jobs j ON j.id = l.render_job_id
       WHERE l.id = :lease_id AND l.render_attempt_id = :attempt_id
         AND l.worker_node_id = :worker_node_id AND l.lease_token_sha256 = :token_sha256
         AND l.lease_state = 'active' AND l.expires_at > NOW()
         AND j.intent_sha256 = :intent_sha256 AND j.job_state IN ('leased', 'running')
         AND j.cancel_requested_at IS NULL
       FOR UPDATE OF l, j`,
      {
        lease_id: input.leaseId,
        attempt_id: lease.attempt_id,
        worker_node_id: input.workerNodeId,
        token_sha256: sha256(input.fenceToken),
        intent_sha256: input.intentSha256,
      },
    );
    if (!fenced) throw new Error("render_lease_fence_rejected");
    for (const declared of input.manifest.artifacts) {
      await tx.execute(
        `INSERT INTO simforge.artifacts (
           id, workspace_id, revision_id, artifact_kind, media_type,
           storage_bucket, storage_key, sha256, byte_length, artifact_state, metadata, verified_at
         ) SELECT u.id, u.workspace_id, u.revision_id, u.artifact_kind, u.media_type,
                  u.storage_bucket, u.storage_key, u.expected_sha256, u.expected_size_bytes,
                  'available', jsonb_build_object('renderIdentity', jsonb_build_object(
                    'role', u.artifact_role, 'actorId', u.artifact_actor_id,
                    'sensorId', u.artifact_sensor_id, 'modality', u.artifact_modality
                  )), NOW()
             FROM simforge.artifact_uploads u WHERE u.id = :artifact_id
         ON CONFLICT (id) DO NOTHING`,
        { artifact_id: declared.artifactId },
      );
      await tx.execute(
        `UPDATE simforge.artifact_uploads
            SET upload_state = 'uploaded', completed_artifact_id = :artifact_id, completed_at = NOW()
          WHERE id = :artifact_id AND render_attempt_id = :attempt_id`,
        { artifact_id: declared.artifactId, attempt_id: lease.attempt_id },
      );
      await tx.execute(
        `INSERT INTO simforge.artifact_links (
           id, workspace_id, artifact_id, render_job_id, render_attempt_id, relationship,
           artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality
         ) VALUES (
           :id, :workspace_id, :artifact_id, :job_id, :attempt_id, 'render_output',
           :role, :actor_id, :sensor_id, :modality
         ) ON CONFLICT DO NOTHING`,
        {
          id: scenarioId("usal"),
          workspace_id: lease.workspace_id,
          artifact_id: declared.artifactId,
          job_id: lease.job_id,
          attempt_id: lease.attempt_id,
          role: declared.identity.role,
          actor_id: declared.identity.actorId,
          sensor_id: declared.identity.sensorId,
          modality: declared.identity.modality,
        },
      );
    }
    await tx.execute(
      `UPDATE simforge.render_attempts
          SET attempt_state = 'succeeded', completed_at = NOW(),
              parity_evidence_schema = :parity_schema,
              parity_evidence = CAST(:parity_evidence AS jsonb),
              parity_accepted = TRUE
        WHERE id = :attempt_id`,
      { attempt_id: lease.attempt_id, parity_schema: evidence.parity_schema, parity_evidence: evidence.parity_evidence },
    );
    await tx.execute(
      `UPDATE simforge.worker_leases SET lease_state = 'released', released_at = NOW()
        WHERE id = :lease_id`,
      { lease_id: input.leaseId },
    );
    await tx.execute(
      `UPDATE simforge.render_jobs
          SET job_state = 'succeeded', progress = 1, completed_at = NOW(), updated_at = NOW(),
              parity_evidence_schema = :parity_schema,
              parity_evidence = CAST(:parity_evidence AS jsonb),
              parity_accepted = TRUE,
              worker_attestation = CAST(:attestation AS jsonb)
        WHERE id = :job_id AND intent_sha256 = :intent_sha256`,
      { job_id: lease.job_id, intent_sha256: input.intentSha256, ...evidence },
    );
  });
  return { schema: CONTROL_SCHEMA, type: "mutation.accepted" as const };
}

export async function failRenderJobV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; intentSha256: string;
  failure: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease || lease.intent_sha256 !== input.intentSha256) return null;
  await withTransaction(async (tx) => {
    const released = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.worker_leases SET lease_state = 'released', released_at = NOW()
        WHERE id = :lease_id AND worker_node_id = :worker_node_id
          AND lease_token_sha256 = :token_sha256 AND lease_state = 'active' AND expires_at > NOW()
        RETURNING id`,
      { lease_id: input.leaseId, worker_node_id: input.workerNodeId, token_sha256: sha256(input.fenceToken) },
    );
    if (!released) throw new Error("render_lease_fence_rejected");
    await tx.execute(
      `UPDATE simforge.render_attempts
          SET attempt_state = CASE WHEN :cancelled THEN 'cancelled' ELSE 'failed' END,
              completed_at = NOW(), metrics = jsonb_build_object('failureCode', :code)
        WHERE id = :attempt_id`,
      { attempt_id: lease.attempt_id, code: input.failure.code, cancelled: lease.cancel_requested_at !== null },
    );
    await tx.execute(
      `UPDATE simforge.render_jobs
          SET job_state = CASE
                WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                WHEN :retryable AND attempt_count < max_attempts THEN 'queued'
                ELSE 'failed'
              END,
              failure_code = :code,
              failure_detail = CAST(:detail AS jsonb),
              progress = CASE WHEN :retryable AND attempt_count < max_attempts THEN 0 ELSE progress END,
              progress_detail = CASE WHEN :retryable AND attempt_count < max_attempts THEN NULL ELSE progress_detail END,
              updated_at = NOW(),
              completed_at = CASE
                WHEN cancel_requested_at IS NOT NULL THEN NOW()
                WHEN :retryable AND attempt_count < max_attempts THEN NULL
                ELSE NOW()
              END
        WHERE id = :job_id AND intent_sha256 = :intent_sha256
          AND job_state IN ('leased', 'running')`,
      {
        retryable: input.failure.retryable,
        code: input.failure.code,
        detail: { message: input.failure.message, details: input.failure.details ?? null },
        job_id: lease.job_id,
        intent_sha256: input.intentSha256,
      },
    );
  });
  return { schema: CONTROL_SCHEMA, type: "mutation.accepted" as const };
}

export async function drainRenderWorkerV2(registrationId: string, workerNodeId: string) {
  const rows = await queryRows<{ registration_id: string }>(
    `UPDATE simforge.worker_nodes SET registration_state = 'draining', last_heartbeat_at = NOW()
      WHERE id = :worker_node_id AND registration_id = :registration_id
        AND registration_state IN ('active', 'draining')
      RETURNING registration_id`,
    { worker_node_id: workerNodeId, registration_id: registrationId },
  );
  return rows[0] ? { schema: CONTROL_SCHEMA, type: "worker.draining" as const } : null;
}

export async function renderProgressForJob(context: Pick<AppContext, "workspaceId">, jobId: string) {
  return queryRows<{ sequence: number; record: unknown; recorded_at: string }>(
    `SELECT p.sequence, p.record, p.recorded_at::text AS recorded_at
       FROM simforge.render_progress_records p
       JOIN simforge.render_jobs j ON j.id = p.render_job_id
      WHERE j.workspace_id = :workspace_id AND p.render_job_id = :job_id
      ORDER BY p.render_attempt_id, p.sequence LIMIT 5000`,
    { workspace_id: context.workspaceId, job_id: jobId },
  );
}
