import { z } from 'zod';

import { RENDER_INTENT_MAX_ASSETS, RenderIntentV1Schema, RenderSha256Schema } from '@simforge-oss/scenario';

import { ArtifactIdentitySchema } from './artifacts.js';
import { EngineCapabilityDeclarationSchema } from './capabilities.js';
import { RenderProgressRecordSchema } from './progress.js';

export const RENDER_WORKER_CONTROL_V2_SCHEMA = 'simforge.render-worker-control/v2' as const;

const ControlBaseShape = {
  schema: z.literal(RENDER_WORKER_CONTROL_V2_SCHEMA),
} as const;
const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const FenceTokenSchema = z.string().min(16).max(1024);
const HeadersSchema = z.record(z.string().min(1).max(255), z.string().max(8192));
const LeaseShape = {
  leaseId: IdSchema,
  fenceToken: FenceTokenSchema,
} as const;

export const WorkerRegisterRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.register'),
  workerId: IdSchema,
  instanceId: IdSchema,
  engine: EngineCapabilityDeclarationSchema,
  labels: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/), z.string().max(256)),
});
export const WorkerRegisteredResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.registered'),
  registrationId: IdSchema,
  heartbeatIntervalMs: z.number().int().min(1000).max(300_000),
});
export const JobClaimRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.claim'),
  registrationId: IdSchema,
});
export const NoJobResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.none'),
  retryAfterMs: z.number().int().min(100).max(300_000),
});
export const InputDownloadSchema = z.strictObject({
  url: z.url(),
  headers: HeadersSchema,
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  refresh: z.strictObject({ url: z.url(), headers: HeadersSchema }).optional(),
});
/** Worker label announcing lazy, batched input URL signing (see `JobInputTransferSchema.download`). */
export const WORKER_INPUT_URLS_LABEL = 'inputUrls' as const;
export const WORKER_INPUT_URLS_BATCH_V1 = 'batch-v1' as const;
export const INPUT_URLS_MAX_BATCH = 500;
/** Worker label announcing it understands `controlFeatures` on a lease. */
export const WORKER_CONTROL_FEATURES_LABEL = 'controlFeatures' as const;
export const WORKER_CONTROL_FEATURES_V1 = 'v1' as const;
/**
 * Output fields newer than the baseline native evidence contract. A worker
 * writes one only when the lease's control plane lists it; a control plane
 * lists only what its parsers accept. Every new output field gets a feature.
 */
export const CONTROL_FEATURE_NATIVE_SCENE_SOURCE = 'native-evidence.scene-source' as const;
export const CONTROL_FEATURE_NATIVE_PARITY = 'native-evidence.parity' as const;
/** `timings.stages` in native run diagnostics (per-stage service and host timings). */
export const CONTROL_FEATURE_NATIVE_STAGE_TIMINGS = 'native-evidence.stage-timings' as const;
/** `capture` in the native render manifest: how captured pixels relate to time (capture clock, AA samples). */
export const CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK = 'native-evidence.capture-clock' as const;
/**
 * `substitutions` in an engine's render manifest: every substitution the
 * intent's `allowSubstitutions` permitted and the engine made
 * (docs/engineering/no-silent-fallbacks.md). A worker whose lease lacks the
 * feature must refuse an intent that allows substitutions, since it could
 * not report them.
 */
export const CONTROL_FEATURE_RENDER_SUBSTITUTIONS = 'render-evidence.substitutions' as const;
/**
 * `encoder` in the native render manifest: the ffmpeg that encoded the
 * videos (resolved path, how it was found, its `-version` banner) and each
 * video's codec and encoder arguments.
 */
export const CONTROL_FEATURE_NATIVE_ENCODER = 'native-evidence.encoder' as const;
/** `textureProfile.detectedCapacityBytes`: the job's measured device capacity the profile was checked against. */
export const CONTROL_FEATURE_NATIVE_VRAM_DETECTED = 'native-evidence.vram-detected' as const;
/**
 * `render` in the native render manifest (the request, the service's resolved
 * `RenderConfig`, the geometry LOD mode and derivative), with `look` then
 * carrying only lighting/metering; an older plane gets the rc.73 `look`
 * (`profile: cinematic`, `profileConfig` = the resolved config).
 */
export const CONTROL_FEATURE_NATIVE_RENDER_CONFIG = 'native-evidence.render-config' as const;
/**
 * `roadDecals` in the native render manifest: the map's road decal
 * derivative the render applied (manifest digest, build key, opacity scale,
 * material count), or null when the map carries none.
 */
export const CONTROL_FEATURE_NATIVE_ROAD_DECALS = 'native-evidence.road-decals' as const;
export const CONTROL_FEATURES_V1 = [
  CONTROL_FEATURE_NATIVE_SCENE_SOURCE, CONTROL_FEATURE_NATIVE_PARITY, CONTROL_FEATURE_NATIVE_STAGE_TIMINGS, CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK,
  CONTROL_FEATURE_RENDER_SUBSTITUTIONS, CONTROL_FEATURE_NATIVE_ENCODER, CONTROL_FEATURE_NATIVE_VRAM_DETECTED, CONTROL_FEATURE_NATIVE_RENDER_CONFIG,
  CONTROL_FEATURE_NATIVE_ROAD_DECALS,
] as const;
/**
 * Control-plane fields newer than a worker's baseline parsers, in the other
 * direction: the worker lists what it parses in `labels.prewarmFeatures`
 * (comma-separated) and the control plane sends a field only to a worker that
 * listed its feature. `prewarm.derivatives` = `PrewarmSet.derivativesSha256`.
 */
export const WORKER_PREWARM_FEATURES_LABEL = 'prewarmFeatures' as const;
export const CONTROL_FEATURE_PREWARM_DERIVATIVES = 'prewarm.derivatives' as const;
export const WORKER_PREWARM_FEATURES = [CONTROL_FEATURE_PREWARM_DERIVATIVES] as const;
/**
 * The worker output keys each CONTROL_FEATURES_V1 feature unlocks, as
 * `document:key.path` with documents from `WORKER_OUTPUT_DOCUMENTS`
 * (contract/worker-output-contract.ts). The frozen contract snapshot and the
 * N/N-1 contract job read this map: a key not listed here and not in the frozen
 * baseline fails CI. A gated key covers its whole subtree.
 */
export const CONTROL_FEATURE_OUTPUTS: Readonly<Record<(typeof CONTROL_FEATURES_V1)[number], readonly string[]>> = {
  [CONTROL_FEATURE_NATIVE_SCENE_SOURCE]: [
    'native.manifest:sceneSource', 'native.manifest:timelineSha256',
    'native.diagnostics:sceneSource', 'native.diagnostics:timelineSha256',
  ],
  [CONTROL_FEATURE_NATIVE_PARITY]: ['native.diagnostics:parity'],
  [CONTROL_FEATURE_NATIVE_STAGE_TIMINGS]: ['native.diagnostics:timings.stages'],
  [CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK]: ['native.manifest:capture'],
  [CONTROL_FEATURE_RENDER_SUBSTITUTIONS]: ['render.artifact-manifest:substitutions'],
  [CONTROL_FEATURE_NATIVE_ENCODER]: ['native.manifest:encoder'],
  [CONTROL_FEATURE_NATIVE_VRAM_DETECTED]: ['native.manifest:textureProfile.detectedCapacityBytes', 'native.diagnostics:textureProfile.detectedCapacityBytes'],
  [CONTROL_FEATURE_NATIVE_ROAD_DECALS]: ['native.manifest:roadDecals'],
  [CONTROL_FEATURE_NATIVE_RENDER_CONFIG]: ['native.manifest:render', 'native.diagnostics:exposure'],
};

export const JobInputTransferSchema = z.strictObject({
  inputId: z.string().min(1).max(256),
  relativePath: z.string().min(1).max(1024).refine((value) =>
    !/[\\:%?#\u0000-\u001f]/u.test(value)
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
  { message: 'must be a safe relative map member path' }).optional(),
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /**
   * Omitted for a worker that registered `labels.inputUrls = "batch-v1"`: it
   * serves most inputs from its content-addressed cache and asks for URLs
   * only for the misses (`render-jobs/{jobId}/input-urls`).
   */
  download: InputDownloadSchema.optional(),
});
export const JobLeasedResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.leased'),
  jobId: IdSchema,
  attempt: z.number().int().positive().max(1_000_000),
  lease: z.strictObject({
    ...LeaseShape,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  intent: RenderIntentV1Schema,
  intentSha256: RenderSha256Schema,
  executionPackageControlSha256: RenderSha256Schema,
  // scenario.xosc is transferred in addition to the intent's declared assets.
  inputs: z.array(JobInputTransferSchema).max(RENDER_INTENT_MAX_ASSETS + 1),
  /**
   * What this control plane accepts in worker outputs beyond the baseline
   * contract (e.g. `native-evidence.scene-source`). Sent only to a worker that
   * registered `labels.controlFeatures = "v1"`; absent means baseline only, and
   * the worker must omit every newer output field.
   */
  controlFeatures: z.array(z.string().min(1).max(128)).max(64).optional(),
});
export const JobClaimResponseSchema = z.discriminatedUnion('type', [NoJobResponseSchema, JobLeasedResponseSchema]);

export const LeaseHeartbeatRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.heartbeat'),
  ...LeaseShape,
  progressSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const LeaseHeartbeatResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.heartbeat-ack'),
  leaseExpiresAt: z.iso.datetime({ offset: true }),
  cancelRequested: z.boolean(),
  cancelReason: z.string().min(1).max(4096).nullable(),
});
export const LeaseProgressRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.progress'),
  ...LeaseShape,
  records: z.array(RenderProgressRecordSchema).min(1).max(256),
});
export const LeaseProgressResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.progress-ack'),
  acceptedThroughSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const ArtifactReserveRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('artifact.reserve'),
  ...LeaseShape,
  identity: ArtifactIdentitySchema,
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(255),
});
export const ArtifactReservedResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('artifact.reserved'),
  artifactId: IdSchema,
  upload: z.strictObject({
    url: z.url(),
    method: z.literal('PUT'),
    headers: HeadersSchema,
  }),
});
export const CompletedArtifactSchema = z.strictObject({
  artifactId: IdSchema,
  identity: ArtifactIdentitySchema,
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(255),
});
export const JobCompleteRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.complete'),
  ...LeaseShape,
  intentSha256: RenderSha256Schema,
  manifest: z.strictObject({
    artifacts: z.array(CompletedArtifactSchema).min(1).max(4096),
  }),
});
export const JobFailureSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  message: z.string().min(1).max(8192),
  retryable: z.boolean(),
  details: z.json().optional(),
});
export const JobFailRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.fail'),
  ...LeaseShape,
  intentSha256: RenderSha256Schema,
  failure: JobFailureSchema,
});
export const FencedMutationResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('mutation.accepted'),
});
export const WorkerDrainRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.drain'),
  registrationId: IdSchema,
});
export const WorkerDrainResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.draining'),
});

/** Batch URL signing for a lease's inputs (`render-jobs/{jobId}/input-urls`). */
export const InputUrlsRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.input-urls'),
  ...LeaseShape,
  inputIds: z.array(z.string().min(1).max(256)).min(1).max(INPUT_URLS_MAX_BATCH),
});
export const InputUrlsResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.input-urls'),
  downloads: z.record(z.string().min(1).max(256), InputDownloadSchema),
});

/** Published native map closures a worker may prewarm (`workers/prewarm`). */
export const PrewarmSetSchema = z.strictObject({
  setId: IdSchema,
  mapVersionId: IdSchema,
  mapId: z.string().min(1).max(256),
  closureSha256: RenderSha256Schema,
  objectCount: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.string().min(1).max(64),
  /** The bound ambient turn-verdict table (an extra member), when the map version has one. */
  turnVerdictsSha256: RenderSha256Schema.optional(),
  /**
   * Digest of the render derivatives bound to the map version by descriptor
   * (geometry LODs, the GPU texture tier), listed as extra members. Sent only
   * to a worker whose `prewarmFeatures` lists `prewarm.derivatives`; it keys
   * the worker's cached member list so a backfill is prewarmed too.
   */
  derivativesSha256: RenderSha256Schema.optional(),
});
export const PrewarmManifestRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.prewarm-manifest'),
});
export const PrewarmManifestResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.prewarm-manifest'),
  /** Digest over the set list: unchanged generation means nothing to re-plan. */
  generation: RenderSha256Schema,
  sets: z.array(PrewarmSetSchema).max(10_000),
});
export const PrewarmMembersRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.prewarm-members'),
  setId: IdSchema,
  after: z.string().max(1024).nullable(),
});
export const PrewarmMemberSchema = z.strictObject({
  relativePath: z.string().min(1).max(1024),
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const PrewarmMembersResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.prewarm-members'),
  members: z.array(PrewarmMemberSchema).max(10_000),
  /** Pass back as `after` for the next page; null on the last page. */
  next: z.string().max(1024).nullable(),
});
export const BlobUrlsRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.blob-urls'),
  /** The published set the digests belong to: signing is authorized per set. */
  setId: IdSchema,
  sha256s: z.array(RenderSha256Schema).min(1).max(INPUT_URLS_MAX_BATCH),
});
export const BlobUrlsResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.blob-urls'),
  /** Keyed by sha256; a digest that is not a published map blob is absent. */
  downloads: z.record(RenderSha256Schema, InputDownloadSchema),
});
/** What a worker reports about its cache so operators and the UI can see readiness. */
export const WorkerCacheStatusSchema = z.strictObject({
  state: z.enum(['disabled', 'starting', 'prewarming', 'ready', 'over-budget', 'error']),
  maps: z.strictObject({ ready: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  blobs: z.strictObject({ cached: z.number().int().nonnegative(), wanted: z.number().int().nonnegative() }),
  bytes: z.strictObject({
    cached: z.number().int().nonnegative(),
    wanted: z.number().int().nonnegative(),
    budget: z.number().int().nonnegative(),
    diskFree: z.number().int().nonnegative().optional(),
  }),
  lastError: z.string().max(2048).optional(),
  /** The render GPU as the driver reports it (free includes co-tenant residency). */
  gpu: z.strictObject({ totalBytes: z.number().int().nonnegative(), freeBytes: z.number().int().nonnegative() }).optional(),
  /**
   * Scene memory each warm map needs per texture tier, measured from the
   * cached KTX2 headers (textures + geometry + reserve; frame attachments
   * are per job). Lets admission route or refuse before a lease.
   */
  demand: z.array(z.strictObject({
    mapVersionId: IdSchema,
    renderTextures: z.enum(['uastc-full', 'bc7-512']),
    sceneBytes: z.number().int().nonnegative(),
    textureBytes: z.number().int().nonnegative(),
  })).max(2000).optional(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const WorkerCacheReportRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.cache-status'),
  registrationId: IdSchema,
  cache: WorkerCacheStatusSchema,
});
export const WorkerCacheReportResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.cache-status'),
});

export type InputDownload = z.infer<typeof InputDownloadSchema>;
export type InputUrlsRequest = z.infer<typeof InputUrlsRequestSchema>;
export type InputUrlsResponse = z.infer<typeof InputUrlsResponseSchema>;
export type PrewarmSet = z.infer<typeof PrewarmSetSchema>;
export type PrewarmMember = z.infer<typeof PrewarmMemberSchema>;
export type PrewarmManifestRequest = z.infer<typeof PrewarmManifestRequestSchema>;
export type PrewarmManifestResponse = z.infer<typeof PrewarmManifestResponseSchema>;
export type PrewarmMembersRequest = z.infer<typeof PrewarmMembersRequestSchema>;
export type PrewarmMembersResponse = z.infer<typeof PrewarmMembersResponseSchema>;
export type BlobUrlsRequest = z.infer<typeof BlobUrlsRequestSchema>;
export type BlobUrlsResponse = z.infer<typeof BlobUrlsResponseSchema>;
export type WorkerCacheStatus = z.infer<typeof WorkerCacheStatusSchema>;
export type WorkerCacheReportRequest = z.infer<typeof WorkerCacheReportRequestSchema>;
export type WorkerCacheReportResponse = z.infer<typeof WorkerCacheReportResponseSchema>;
export type WorkerRegisterRequest = z.infer<typeof WorkerRegisterRequestSchema>;
export type WorkerRegisteredResponse = z.infer<typeof WorkerRegisteredResponseSchema>;
export type JobClaimRequest = z.infer<typeof JobClaimRequestSchema>;
export type JobClaimResponse = z.infer<typeof JobClaimResponseSchema>;
export type JobInputTransfer = z.infer<typeof JobInputTransferSchema>;
export type JobLeasedResponse = z.infer<typeof JobLeasedResponseSchema>;
export type LeaseHeartbeatRequest = z.infer<typeof LeaseHeartbeatRequestSchema>;
export type LeaseHeartbeatResponse = z.infer<typeof LeaseHeartbeatResponseSchema>;
export type LeaseProgressRequest = z.infer<typeof LeaseProgressRequestSchema>;
export type LeaseProgressResponse = z.infer<typeof LeaseProgressResponseSchema>;
export type ArtifactReserveRequest = z.infer<typeof ArtifactReserveRequestSchema>;
export type ArtifactReservedResponse = z.infer<typeof ArtifactReservedResponseSchema>;
export type CompletedArtifact = z.infer<typeof CompletedArtifactSchema>;
export type JobCompleteRequest = z.infer<typeof JobCompleteRequestSchema>;
export type JobFailRequest = z.infer<typeof JobFailRequestSchema>;
export type FencedMutationResponse = z.infer<typeof FencedMutationResponseSchema>;
export type WorkerDrainRequest = z.infer<typeof WorkerDrainRequestSchema>;
export type WorkerDrainResponse = z.infer<typeof WorkerDrainResponseSchema>;
