import { z } from "zod";
import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import {
  DISABLED_AMBIENT_PROVENANCE,
  EMPTY_AMBIENT_CONFIG_SHA256,
  SCENARIO_SCHEMA_VERSION,
} from "@simforge-oss/studio-ui/lib/scenario/contracts";
import {
  SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  ScenarioParityEvidenceV1Schema,
  ScenarioRenderWorkerIdentitySchema,
} from "@simforge-oss/studio-shared";
import { ScenarioRendererCapabilitySchema } from "./render-wire-contracts";
import {
  SCENARIO_AUTHORING_QUALITY_IDS,
  SCENARIO_DATASET_VISIBILITIES,
  SCENARIO_JOB_MODES,
  SCENARIO_RATING_REVIEWED_VIA,
  type ScenarioAuthoringQuality,
} from "@simforge-oss/studio-host";

/**
 * Wire DTOs and enumerations are owned by `@simforge-oss/studio-host`, the
 * boundary both hosts serve; this module adds the request validation schemas
 * the local routes parse and re-exports the shared shapes for server code.
 */
export {
  DEFAULT_SCENARIO_AUTHORING_QUALITY_ID,
  OPENSCENARIO_NATIVE_PROFILE,
  SCENARIO_AUTHORING_QUALITY_IDS,
  SCENARIO_DATASET_VISIBILITIES,
  SCENARIO_JOB_MODES,
  SCENARIO_RATING_REVIEWED_VIA,
} from "@simforge-oss/studio-host";
export type {
  CreateScenarioRevisionResultDto,
  ScenarioArtifactDto,
  ScenarioAuthoringQuality,
  ScenarioConflictDto,
  ScenarioDatasetDto,
  ScenarioDatasetReadinessDto,
  ScenarioDatasetVisibility,
  ScenarioDocumentDto,
  ScenarioDocumentRatingDto,
  ScenarioDocumentSummaryDto,
  ScenarioDocumentSummaryPageDto,
  ScenarioExportDto,
  ScenarioJobMode,
  ScenarioJobProvenanceDto,
  ScenarioMapDescriptorDto,
  ScenarioRatingAggregateDto,
  ScenarioRenderJobDto,
  ScenarioRevisionDto,
  ScenarioSimulationPreviewDto,
  ScenarioTagDto,
} from "@simforge-oss/studio-host";

export {
  DISABLED_AMBIENT_PROVENANCE,
  EMPTY_AMBIENT_CONFIG_SHA256,
  EMPTY_AMBIENT_RESULT_SHA256,
  SCENARIO_AUTHORING_QUALITY_CHOICES,
  SCENARIO_RENDER_CONTRACT_VERSION,
  SCENARIO_SCHEMA_VERSION,
} from "@simforge-oss/studio-ui/lib/scenario/contracts";
const AmbientDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const AmbientConfigSchema = z.record(z.unknown());

export const ScenarioAmbientProvenanceSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("disabled"),
    ambientConfig: z.object({}).strict(),
    configSha256: z.literal(EMPTY_AMBIENT_CONFIG_SHA256),
    /** SHA-256 of the canonical materialized-traffic artifact, including disabled. */
    resultSha256: AmbientDigestSchema,
  }),
  z.strictObject({
    mode: z.literal("native"),
    runtimeVersion: z.string().trim().min(1).max(128),
    seed: z.union([z.string().trim().min(1).max(256), z.number().int()]),
    ambientConfig: AmbientConfigSchema,
    configSha256: AmbientDigestSchema,
    resultSha256: AmbientDigestSchema,
  }),
  z.strictObject({
    mode: z.literal("sumo"),
    sumoVersion: z.string().trim().min(1).max(64),
    networkSha256: AmbientDigestSchema,
    seed: z.union([z.string().trim().min(1).max(256), z.number().int()]),
    ambientConfig: AmbientConfigSchema,
    configSha256: AmbientDigestSchema,
    resultSha256: AmbientDigestSchema,
  }),
]);
export type ScenarioAmbientProvenance = z.infer<typeof ScenarioAmbientProvenanceSchema>;
export const ScenarioMaterializedTrafficReferenceSchema = z.strictObject({
  artifactId: z.string().trim().min(1),
  sha256: AmbientDigestSchema,
  sizeBytes: z.number().int().positive().max(512 * 1024 * 1024),
  sourceInputDigest: AmbientDigestSchema,
  mapAssetId: z.string().trim().min(1),
  mapVersionId: z.string().trim().min(1),
});
export type ScenarioMaterializedTrafficReference = z.infer<typeof ScenarioMaterializedTrafficReferenceSchema>;
export const ReserveScenarioMaterializedTrafficSchema = ScenarioMaterializedTrafficReferenceSchema.omit({ artifactId: true }).extend({
  expectedVersion: z.number().int().positive(),
});
export const CompleteScenarioMaterializedTrafficSchema = ScenarioMaterializedTrafficReferenceSchema;

export const ScenarioAuthoringQualitySchema = z.enum(SCENARIO_AUTHORING_QUALITY_IDS);


const CanonicalScenarioContentSchema = z
  .custom<ScenarioTemplateV2>((value) => ScenarioTemplateV2Schema.safeParse(value).success, {
    message: "Invalid Scenario v2 document.",
  })
  .transform((value) => ScenarioTemplateV2Schema.parse(value));

/**
 * A document's description lives at `content.meta.description` and nowhere else.
 *
 * These `description` fields are a convenience on the wire only: the store folds them INTO
 * `canonical_content` before hashing, and reads them back out of the STORED GENERATED projection.
 * There is no `documents.description` column, because a second copy is a dual write that would
 * silently diverge from `content_sha256` and from every exported `.xosc` (§6.1).
 */
const DocumentDescriptionSchema = z.string().trim().max(4000);

export const CreateScenarioDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: DocumentDescriptionSchema.optional(),
  schemaVersion: z.string().trim().min(1).default(SCENARIO_SCHEMA_VERSION),
  content: CanonicalScenarioContentSchema,
  mapVersionId: z.string().trim().min(1).nullable().optional(),
  datasetId: z.string().trim().min(1),
  authoringQualityId: ScenarioAuthoringQualitySchema,
});

export const UpdateScenarioDocumentSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: DocumentDescriptionSchema.optional(),
  schemaVersion: z.string().trim().min(1).optional(),
  content: CanonicalScenarioContentSchema.optional(),
  mapVersionId: z.string().trim().min(1).nullable().optional(),
  authoringQualityId: ScenarioAuthoringQualitySchema.optional(),
});

export const ReserveScenarioSimulationPreviewSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  sha256: AmbientDigestSchema,
  sizeBytes: z.number().int().positive().max(512 * 1024 * 1024),
});
export const CompleteScenarioSimulationPreviewSchema = ReserveScenarioSimulationPreviewSchema.extend({
  artifactId: z.string().trim().min(1),
});

export const CreateScenarioDatasetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
});

export const UpdateScenarioDatasetSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "Provide a name or a description to update.",
  });

export const ScenarioDatasetVisibilitySchema = z.enum(SCENARIO_DATASET_VISIBILITIES);

export const UpsertScenarioDocumentRatingSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(4000).nullable().optional(),
  reviewedVia: z.enum(SCENARIO_RATING_REVIEWED_VIA).default("browser"),
  /** Which immutable revision the reviewer actually looked at, when known. */
  revisionId: z.string().trim().min(1).nullable().optional(),
  /** Which render the reviewer actually watched, when known. */
  renderJobId: z.string().trim().min(1).nullable().optional(),
});

export const ScenarioRatingBatchSchema = z.object({
  documentIds: z.array(z.string().trim().min(1)).min(1).max(200),
});

/**
 * Organizational tag colour.
 *
 * Lowercase six-digit hex, matching the table CHECK exactly. Uppercase is normalized rather than
 * rejected because v1's palette is written `#E8E044` everywhere and a case mismatch is not a thing
 * the operator can see or fix.
 */
export const ScenarioTagColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, "Expected a six-digit hex colour.");

export const CreateScenarioTagSchema = z.object({
  label: z.string().trim().min(1).max(64),
  color: ScenarioTagColorSchema.nullable().optional(),
});

export const UpdateScenarioTagSchema = z
  .object({
    label: z.string().trim().min(1).max(64).optional(),
    color: ScenarioTagColorSchema.nullable().optional(),
  })
  .refine((value) => value.label !== undefined || value.color !== undefined, {
    message: "Provide a label or a color to update.",
  });

/** A set-replace, not add/remove — see `setScenarioDocumentTags`. */
export const SetScenarioDocumentTagsSchema = z.object({
  tagIds: z.array(z.string().trim().min(1)).max(64),
});

export const DuplicateScenarioDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  datasetId: z.string().trim().min(1).optional(),
});

export const ListScenarioDocumentSummariesSchema = z.object({
  datasetId: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Opaque `(updated_at, id)` keyset cursor produced by the previous page. */
  cursor: z.string().trim().min(1).max(200).nullable().optional(),
});

export const CreateScenarioDatasetItemSchema = z.object({
  revisionId: z.string().trim().min(1),
  renderJobId: z.string().trim().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CreateScenarioRevisionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  ambient: ScenarioAmbientProvenanceSchema.default(DISABLED_AMBIENT_PROVENANCE),
  materializedTraffic: ScenarioMaterializedTrafficReferenceSchema.optional(),
}).superRefine((value, context) => {
  if (!value.materializedTraffic) {
    context.addIssue({ code: "custom", path: ["materializedTraffic"], message: "Complete materialized traffic evidence is required." });
  } else if (value.materializedTraffic.sha256 !== value.ambient.resultSha256) {
    context.addIssue({ code: "custom", path: ["materializedTraffic", "sha256"], message: "Materialized traffic must match the ambient result digest." });
  }
});

export const CreateValidationRunSchema = z.object({
  revisionId: z.string().trim().min(1),
  validatorKind: z.string().trim().min(1).max(100),
  validatorVersion: z.string().trim().min(1).max(100),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const CreateExportSchema = z.object({
  revisionId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(200),
  ambient: ScenarioAmbientProvenanceSchema.default(DISABLED_AMBIENT_PROVENANCE),
});

export const ScenarioRenderSensorKindSchema = z.enum([
  "rgb",
  "depth",
  "semantic",
  "instance",
  "normals",
  "lidar",
  "semantic_lidar",
  "radar",
]);
export type ScenarioRenderSensorKind = z.infer<
  typeof ScenarioRenderSensorKindSchema
>;

const RenderSensorTransformSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  pitch: z.number().min(-Math.PI).max(Math.PI),
  yaw: z.number().min(-Math.PI).max(Math.PI),
  roll: z.number().min(-Math.PI).max(Math.PI),
});

const RenderSensorAttachmentSchema = z.enum([
  "rigid",
  "spring_arm",
  "spring_arm_ghost",
]);

const RenderCameraAttributesSchema = z.strictObject({
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  fov: z.number().positive().max(Math.PI),
  clipNear: z.number().positive(),
  clipFar: z.number().positive(),
  enablePostprocessEffects: z.boolean(),
}).refine((value) => value.clipFar > value.clipNear, {
  message: "clipFar must be greater than clipNear",
  path: ["clipFar"],
});

const RenderLidarAttributesSchema = z.strictObject({
  channels: z.number().int().min(1).max(256),
  range: z.number().positive().max(1_000),
  pointsPerSecond: z.number().int().positive(),
  rotationFrequency: z.number().positive().max(240),
  upperFov: z.number().min(-Math.PI).max(Math.PI),
  lowerFov: z.number().min(-Math.PI).max(Math.PI),
}).refine((value) => value.upperFov > value.lowerFov, {
  message: "upperFov must be greater than lowerFov",
  path: ["upperFov"],
});

const RenderRadarAttributesSchema = z.strictObject({
  horizontalFov: z.number().positive().max(Math.PI),
  verticalFov: z.number().positive().max(Math.PI),
  range: z.number().positive().max(1_000),
  pointsPerSecond: z.number().int().positive(),
});

const RenderSensorCommonShape = {
  id: z.string().trim().min(1).max(100),
  attachTo: z.string().trim().min(1).max(200),
  transform: RenderSensorTransformSchema,
} as const;

export const ScenarioRenderSensorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...RenderSensorCommonShape,
    kind: z.enum(["rgb", "depth", "semantic", "instance", "normals"]),
    attachment: RenderSensorAttachmentSchema,
    attributes: RenderCameraAttributesSchema,
  }),
  z.strictObject({
    ...RenderSensorCommonShape,
    kind: z.enum(["lidar", "semantic_lidar"]),
    attachment: z.literal("rigid"),
    attributes: RenderLidarAttributesSchema,
  }),
  z.strictObject({
    ...RenderSensorCommonShape,
    kind: z.literal("radar"),
    attachment: z.literal("rigid"),
    attributes: RenderRadarAttributesSchema,
  }),
]);
export type ScenarioRenderSensor = z.infer<
  typeof ScenarioRenderSensorSchema
>;

export const ScenarioRenderSpecSchema = z.strictObject({
  schema: z.literal("uniscenario.render-spec/v1").default("uniscenario.render-spec/v1"),
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  fps: z.number().positive().max(240),
  sensors: z.array(ScenarioRenderSensorSchema).min(1).max(64),
  quality: z.enum(["preview", "standard", "high", "cinematic"]).default("standard"),
  environment: z.object({
    cloudiness: z.number().min(0).max(100).optional(),
    precipitation: z.number().min(0).max(100).optional(),
    deposits: z.number().min(0).max(100).optional(),
    wind: z.number().min(0).max(100).optional(),
    sunAzimuth: z.number().min(0).max(360).optional(),
    sunAltitude: z.number().min(-90).max(90).optional(),
    fogDensity: z.number().min(0).max(100).optional(),
    fogDistance: z.number().nonnegative().optional(),
    wetness: z.number().min(0).max(100).optional(),
  }).default({}),
  outputs: z.array(z.enum(["video", "trace", "manifest", "annotations"])).min(1),
  formats: z.array(z.enum(["png", "ply", "csv", "mp4-h264", "json", "jsonl"])).min(1).default(["png", "mp4-h264", "json", "jsonl"]),
  executionMode: z.enum(["native-physics", "diagnostic-replay"]).default("native-physics"),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  value.sensors.forEach((sensor, index) => {
    if (ids.has(sensor.id)) {
      context.addIssue({
        code: "custom",
        path: ["sensors", index, "id"],
        message: `Sensor id "${sensor.id}" is duplicated.`,
      });
    }
    ids.add(sensor.id);
  });
  {
    // Lidar/radar measurement data always uploads alongside its video-only
    // camera peers; individual camera frames are never persisted.
    const formats = new Set(value.formats);
    for (const sensor of value.sensors) {
      const expected = sensor.kind === "lidar" || sensor.kind === "semantic_lidar"
        ? "ply"
        : sensor.kind === "radar"
          ? "csv"
          : null;
      if (expected && !formats.has(expected)) {
        context.addIssue({
          code: "custom",
          path: ["formats"],
          message: `Sensor "${sensor.id}" requires ${expected} data output.`,
        });
      }
    }
    if (value.outputs.includes("video") && !formats.has("mp4-h264")) {
      context.addIssue({
        code: "custom",
        path: ["formats"],
        message: "Video output requires the mp4-h264 format.",
      });
    }
  }
  if (value.outputs.includes("video") && !value.sensors.some((sensor) => sensor.kind === "rgb")) {
    context.addIssue({
      code: "custom",
      path: ["outputs"],
      message: "Video output requires at least one RGB sensor.",
    });
  }
});
export type ScenarioRenderSpec = z.infer<typeof ScenarioRenderSpecSchema>;

export const ScenarioJobModeSchema = z.enum(SCENARIO_JOB_MODES);

export const ParityThresholdsSchema = z.strictObject({
  positionM: z.number().nonnegative().max(SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS.positionM),
  headingDeg: z.number().nonnegative().max(SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS.headingDeg),
  speedMps: z.number().nonnegative().max(SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS.speedMps),
});

export const CreateRenderJobSchema = z.object({
  mode: ScenarioJobModeSchema.default("full_render"),
  revisionId: z.string().trim().min(1),
  executionPackageId: z.string().trim().min(1),
  originRecordingJobId: z.string().trim().min(1).nullable().optional(),
  renderProfileId: z.string().trim().min(1).nullable().optional(),
  renderSpec: ScenarioRenderSpecSchema.optional(),
  parityThresholds: ParityThresholdsSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  priority: z.number().int().min(-100).max(100).optional(),
}).superRefine((value, context) => {
  if (value.mode === "browser_render") {
    context.addIssue({ code: "custom", path: ["mode"], message: "Browser renders are created through the browser-render request contract." });
  }
  if (value.mode === "full_render" && !value.renderSpec) {
    context.addIssue({ code: "custom", path: ["renderSpec"], message: "Full renders require a render specification." });
  }
  if (value.mode === "interaction_2d" && value.renderSpec?.sensors.length) {
    context.addIssue({ code: "custom", path: ["renderSpec", "sensors"], message: "2D interactions are sensor-free." });
  }
});

export const CreateArtifactReservationSchema = z.object({
  revisionId: z.string().trim().min(1).nullable().optional(),
  artifactKind: z.string().trim().min(1).max(100),
  mediaType: z.string().trim().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CompleteArtifactSchema = z.object({
  artifactId: z.string().trim().min(1),
});

/**
 * Operator approval body: the renderer capability document and identity labels
 * exactly as the worker will present them at `POST /internal/workers/register`.
 */
export const ApproveRenderWorkerSchema = z.strictObject({
  engine: ScenarioRendererCapabilitySchema,
  labels: z.record(z.string(), z.string()),
  reason: z.string().trim().min(3).max(500),
});

export const RevokeRenderWorkerApprovalSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

export const ProvisionRenderWorkerCredentialSchema = z.strictObject({
  token: z.string().trim().min(32).max(4096),
  reason: z.string().trim().min(3).max(500),
});

export const RevokeRenderWorkerCredentialSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

export const RenderWorkerIdleHeartbeatSchema = z.strictObject({
  workerNodeId: z.string().trim().min(1).max(200),
  identity: ScenarioRenderWorkerIdentitySchema,
});

export const LeaseRenderJobSchema = z.object({
  workerNodeId: z.string().trim().min(1).max(200),
  leaseSeconds: z.number().int().min(30).max(180).default(90),
});

export const LeaseHeartbeatSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  progress: z.number().min(0).max(1).optional(),
});

export const BindArtifactUploadSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  kind: z.string().trim().min(1).max(100),
  mediaType: z.string().trim().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(5 * 1024 * 1024 * 1024),
});

export const AppendJobEventSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  sequence: z.number().int().positive(),
  type: z.enum(["accepted", "assets_validated", "plan_compiled", "interaction_started", "render_started", "progress", "artifact_uploaded"]),
  timestamp: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const CompleteRenderJobSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  result: z.object({
    planSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    attestation: z.record(z.string(), z.unknown()),
    parityEvidence: ScenarioParityEvidenceV1Schema,
    artifacts: z.array(z.object({
      kind: z.string().trim().min(1).max(100),
      artifactUrl: z.string().trim().min(1).max(1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().nonnegative(),
      mediaType: z.string().trim().min(1).max(200),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })).max(100),
  }),
});

export const FailRenderJobSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  error: z.object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(2000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
