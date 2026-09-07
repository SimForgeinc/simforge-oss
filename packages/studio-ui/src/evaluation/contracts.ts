/**
 * The wire contracts the shared evaluation UI reads.
 *
 * OWNERSHIP — this module owns none of these documents. It is a structural
 * mirror, and the mirror exists for one reason: no single package can be
 * imported by both hosts.
 *
 * | Document | Producer / owner | Why it is mirrored here |
 * |---|---|---|
 * | `ComputeJob*`, `ComputeEstimate`, `Upload*` | SimCloud, `@simcloud/shared` (`packages/shared/src/compute-jobs.ts`), served under `/api/simforge/compute` | `@simcloud/shared` is a private Cloud workspace package; the OSS desktop app cannot depend on it. The DTOs are structurally identical, so a Cloud page may pass its own typed DTOs straight into these components. |
 * | `EvalResultManifest`, `OpenLoopResult`, `EvalArtifactRole` | `@simforge-oss/evaluation` (`src/protocol/**`) | The web portal must not import that package: its episode runner reaches `node:child_process`, which would drag a Node-only graph into a browser bundle. The desktop app, which already depends on it, may import the canonical types directly. |
 * | `ModelCatalogEntry` and friends | model-runtime workstream, in `./model-catalog` | Owned in this package precisely so there is exactly one table. |
 *
 * DRIFT POLICY — a mirror that silently tolerates disagreement is worse than
 * no mirror. Every reader below therefore returns {@link ContractReadResult}:
 * on a schema, kind or status this mirror does not recognise it reports the
 * mismatch, the gateway raises `result_unreadable`, and the result screen shows
 * that error. A document the UI cannot understand is never rendered as an
 * empty success, and never leaves a screen loading forever.
 */

import type { ModelFamilyId, ModelQuant } from "./model-catalog";

export const EVAL_RESULT_MANIFEST_SCHEMA = "simforge.eval-result-manifest/v1" as const;
export const OPENLOOP_RESULT_SCHEMA = "simforge.openloop-result/v1" as const;
export const OPENLOOP_PARAMS_SCHEMA = "simforge.openloop-params/v2" as const;

/* -------------------------------------------------------------------------- */
/* Compute jobs                                                               */
/* -------------------------------------------------------------------------- */

export type ComputeJobKind =
  | "alpamayo.openloop"
  | "alpamayo.text"
  | "alpamayo.closedloop-episode"
  | "reconstruct.nurec";

/**
 * Job lifecycle. `dispatch_unknown` is a real state, not an error: the
 * submission response was lost, so the server must reconcile with the provider
 * before anyone may resubmit. `partial` carries retained evidence and is never
 * a complete result.
 */
export type ComputeJobStatus =
  | "queued"
  | "dispatching"
  | "dispatch_unknown"
  | "running"
  | "cancelling"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export const TERMINAL_COMPUTE_JOB_STATUSES: readonly ComputeJobStatus[] = [
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;

/** Which host submitted the job. Both appear in one workspace-scoped history. */
export type ComputeJobOrigin = "browser" | "desktop";

export type ComputeJobInputRole =
  | "clip"
  | "video"
  | "scenario"
  | "replay-context"
  | "clip-bundle";

export type ComputeJobModelRef = {
  family: ModelFamilyId;
  /** 40-hex pinned weights revision. */
  revision: string;
  quant: ModelQuant;
};

export type ComputeJobEstimate = {
  low: number;
  high: number;
  /** `unbenchmarked` means no measured cold/warm figures exist: render a bound, not a price. */
  basis: "measured" | "unbenchmarked";
};

export type ComputeJobErrorCode =
  | "input_error"
  | "model_revision_mismatch"
  | "capability_error"
  | "storage_error"
  | "internal"
  | "provider_unavailable"
  | "timeout"
  | "cancelled";

export type ComputeJobResultArtifact = {
  role: EvalArtifactRole;
  artifactId: string;
  mediaType: string;
  bytes: number;
  sha256: string;
};

export type ComputeJobResultSummary = {
  manifestSchema: string;
  status: string;
  scored: boolean;
  metrics: Record<string, unknown>;
  artifacts: ComputeJobResultArtifact[];
  /** When set, the retained bytes are failure/partial evidence with a TTL. */
  evidenceRetainedUntil: string | null;
};

export type ComputeJob = {
  id: string;
  kind: ComputeJobKind;
  status: ComputeJobStatus;
  origin: ComputeJobOrigin;
  workspaceId: string;
  submittedByUserId: string;
  submittedByEmail: string | null;
  model: ComputeJobModelRef;
  inputs: { role: ComputeJobInputRole; artifactId: string }[];
  params: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  queuedSeconds: number | null;
  /** Server truth for the cancel affordance. Role is explanatory copy only. */
  cancellable: boolean;
  cancelRequestedAt: string | null;
  estimateCents: ComputeJobEstimate;
  reservedCents: number;
  settledCents: number | null;
  scored: boolean | null;
  attempt: { number: number; state: "pending" | "dispatched" | "unknown" | "settled" } | null;
  result: ComputeJobResultSummary | null;
  error: { code: ComputeJobErrorCode; message: string; retryable: boolean } | null;
};

export type ComputeJobPage = { jobs: ComputeJob[]; nextCursor: string | null };

export type ComputeJobSubmission = {
  kind: ComputeJobKind;
  idempotencyKey: string;
  input: {
    model: ComputeJobModelRef;
    inputs: { role: ComputeJobInputRole; artifactId: string }[];
    /** Opaque to SimCloud: `simforge.openloop-params/v2`. */
    params: unknown;
  };
};

export type ComputeEstimateRefusalCode =
  | "insufficient_credits"
  | "concurrency_limit"
  | "model_not_available_for_workspace"
  | "quant_not_supported"
  | "invalid_job";

export type ComputeEstimate = {
  estimate: { lowCents: number; highCents: number; basis: "measured" | "unbenchmarked" };
  allowed: boolean;
  refusal: { code: ComputeEstimateRefusalCode; message: string } | null;
  availableCreditsCents: number;
  concurrency: { active: number; limit: number };
};

/* -------------------------------------------------------------------------- */
/* Uploads                                                                    */
/* -------------------------------------------------------------------------- */

export type UploadPurpose = "eval-clip" | "video" | "clip-bundle";

export type UploadGrant =
  | {
      mode: "put";
      url: string;
      method: "PUT";
      /** Sent verbatim. The checksum header value is already base64-encoded. */
      headers: Record<string, string>;
      expiresAt: string;
    }
  | {
      mode: "multipart";
      partSizeBytes: number;
      parts: { partNumber: number; url: string }[];
      expiresAt: string;
    };

export type UploadReservation = {
  uploadId: string;
  artifactId: string;
  /** False when the workspace already holds these exact bytes: skip straight to complete. */
  uploadRequired: boolean;
  grant: UploadGrant | null;
};

export type UploadCompletion = {
  artifactId: string;
  status: "available";
  bytes: number;
  sha256: string;
};

/* -------------------------------------------------------------------------- */
/* Durable results                                                            */
/* -------------------------------------------------------------------------- */

/** Frozen by the evaluation package: an unknown role fails its validation. */
export type EvalArtifactRole =
  | "result-manifest"
  | "openloop-result"
  | "video"
  | "frames"
  | "overlay-frames"
  | "trajectories"
  | "trace"
  | "events"
  | "score"
  | "provenance"
  | "evidence"
  | "log";

export type EvalManifestArtifact = {
  role: EvalArtifactRole;
  /** Relative to the manifest directory. */
  path: string;
  sha256: string;
  bytes: number;
  mediaType?: string;
};

export type EvalModelProvenance = {
  family: string;
  revision: string;
  checkpointDigest: string;
  quant: string;
  attn?: string;
  torch?: string;
  cuda?: string;
  diffusionSteps?: number;
  numTrajSamples?: number;
  cameraProfile?: string;
  rngProvenance?: string;
};

export type EvalInputProvenance = {
  kind: string;
  digest: string;
  ood?: string[];
  replayContext?: string;
};

export type EvalProvenance = {
  model?: EvalModelProvenance;
  input?: EvalInputProvenance;
  [key: string]: unknown;
};

export type EvalResultManifest = {
  schema: string;
  kind: "openloop" | "text" | "closedloop-episode";
  runId: string;
  attemptId: string;
  status: "succeeded" | "failed" | "cancelled" | "partial";
  /** False whenever no reference future existed: a prediction is not a score. */
  scored: boolean;
  artifacts: EvalManifestArtifact[];
  metrics: Record<string, unknown>;
  provenance: EvalProvenance;
  timing: Record<string, unknown>;
  /** Closed-loop only. An offline run must never be labelled real-time. */
  mode?: "offline-simtime" | "realtime";
  truncation?: "envelope_exceeded" | "deadline_budget" | null;
};

/** Metric buckets keyed by horizon seconds, as strings: "1.0" | "3.0" | "6.4". */
export type HorizonMetrics = Record<string, number>;

/** Per-item refusal codes emitted by the evaluation worker. */
export type OpenLoopRefusalCode =
  | "missing_fields"
  | "camera_set_invalid"
  | "calibration_invalid"
  | "reference_missing"
  | "unsupported_op"
  | "input_error";

/**
 * Where a reference future came from.
 *
 * Only `dataset` and `recorded-replay` are recorded human futures. An
 * `authored` scenario or a `reference-policy` trajectory is a reference, and
 * presenting either as human ground truth would misstate what was measured.
 */
export type OpenLoopReference = {
  kind: "dataset" | "recorded-replay" | "authored" | "reference-policy" | "none";
  points?: number[][];
  frame?: string;
  convention?: string;
  dtS?: number;
};

/**
 * One evaluated input. `refused` is a first-class outcome: the model was not
 * given the driving inputs it requires and nothing was fabricated to fill the
 * gap, so `refusal.missingFields` is what the user must see.
 */
export type OpenLoopItem = {
  index: number;
  itemId: string;
  status: "ok" | "refused" | "error";
  /** Ego-frame at t0 by default; read `frame`/`convention` rather than assuming. */
  frame?: string;
  convention?: string;
  dtS?: number;
  horizonS?: number;
  /** One entry per sampled trajectory, each a list of [x, y, z] metric points. */
  points?: number[][][];
  rotations?: number[][][] | null;
  reasoning?: string | null;
  metrics?: { minADE_k?: HorizonMetrics; minFDE_k?: HorizonMetrics } & Record<string, unknown>;
  reference?: OpenLoopReference;
  latencyMs?: number;
  refusal?: { code?: OpenLoopRefusalCode; missingFields: string[]; message?: string } | null;
  /** Text runs only: the model's answer and any structured fields it returned. */
  text?: string | null;
  fields?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
};

export type OpenLoopResult = {
  schema: string;
  model?: EvalModelProvenance;
  input?: EvalInputProvenance;
  items: OpenLoopItem[];
  aggregate?: {
    minADE?: HorizonMetrics;
    minFDE?: HorizonMetrics;
    scoredItems?: number;
    refusedItems?: number;
    failedItems?: number;
  };
  provenance?: EvalProvenance;
};

/**
 * Camera calibration for drawing an image-space overlay.
 *
 * Absent calibration means an image-space overlay would be an invented claim,
 * so the UI falls back to the metric bird's-eye plot. See
 * {@link TrajectoryProjection} consumers in `components/FrameOverlay`.
 */
export type TrajectoryProjection = {
  cameraId: number;
  K: number[][];
  distortion: { model: string; coeffs: number[] } | null;
  extrinsicsRigFromCamera: number[][];
  imageSize: [number, number];
  timestampsUs: number[];
};

export type TrajectoriesDocument = {
  frame?: string;
  convention?: string;
  dtS?: number;
  horizonS?: number;
  items?: OpenLoopItem[];
  projection: TrajectoryProjection | null;
};

export type FramesManifest = {
  frames: { cameraId: number; index: number; tUs: number; path: string }[];
};

/* -------------------------------------------------------------------------- */
/* Boundary readers                                                           */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The outcome of reading a producer's document.
 *
 * Rejection carries a reason on purpose: a result the UI cannot understand has
 * to be reported as unreadable, with the mismatch named, so a schema drift
 * between this mirror and the producer surfaces as a visible error instead of
 * an empty success or a screen that stays blank forever.
 */
export type ContractReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * Accept a durable manifest only when it identifies itself and carries the
 * fields every result screen depends on.
 */
export function readEvalResultManifest(value: unknown): ContractReadResult<EvalResultManifest> {
  if (!isRecord(value)) return { ok: false, reason: "the stored result is not a JSON object" };
  if (value.schema !== EVAL_RESULT_MANIFEST_SCHEMA) {
    return {
      ok: false,
      reason: `expected schema ${EVAL_RESULT_MANIFEST_SCHEMA}, found ${JSON.stringify(value.schema)}`,
    };
  }
  const { kind, status } = value;
  if (kind !== "openloop" && kind !== "text" && kind !== "closedloop-episode") {
    return { ok: false, reason: `unknown result kind ${JSON.stringify(kind)}` };
  }
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled" && status !== "partial") {
    return { ok: false, reason: `unknown result status ${JSON.stringify(status)}` };
  }
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.filter(isRecord).map((entry) => ({
        role: entry.role as EvalArtifactRole,
        path: typeof entry.path === "string" ? entry.path : "",
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
        bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
        mediaType: typeof entry.mediaType === "string" ? entry.mediaType : undefined,
      }))
    : [];
  return {
    ok: true,
    value: {
      schema: value.schema,
      kind,
      status,
      runId: typeof value.runId === "string" ? value.runId : "",
      attemptId: typeof value.attemptId === "string" ? value.attemptId : "",
      scored: value.scored === true,
      artifacts,
      metrics: isRecord(value.metrics) ? value.metrics : {},
      provenance: isRecord(value.provenance) ? (value.provenance as EvalProvenance) : {},
      timing: isRecord(value.timing) ? value.timing : {},
      mode: value.mode === "offline-simtime" || value.mode === "realtime" ? value.mode : undefined,
      truncation:
        value.truncation === "envelope_exceeded" || value.truncation === "deadline_budget"
          ? value.truncation
          : null,
    },
  };
}

export function readOpenLoopResult(value: unknown): ContractReadResult<OpenLoopResult> {
  if (!isRecord(value)) return { ok: false, reason: "openloop.json is not a JSON object" };
  if (value.schema !== OPENLOOP_RESULT_SCHEMA) {
    return {
      ok: false,
      reason: `openloop.json declares schema ${JSON.stringify(value.schema)}, not ${OPENLOOP_RESULT_SCHEMA}`,
    };
  }
  if (!Array.isArray(value.items)) {
    return { ok: false, reason: "openloop.json carries no `items` array" };
  }
  // Structurally identical to the producer's type; the discriminating fields
  // above are exactly what distinguishes this document from another.
  return { ok: true, value: value as unknown as OpenLoopResult };
}

/**
 * The single question the overlay code asks before drawing on video frames.
 * Named because "we may draw in image space" is a claim about honesty, not a
 * null check: without calibration the overlay would assert a correspondence
 * that was never measured.
 */
export function canProjectToImage(
  document: TrajectoriesDocument | null,
): document is TrajectoriesDocument & { projection: TrajectoryProjection } {
  const projection = document?.projection;
  if (!projection) return false;
  return (
    Array.isArray(projection.K) &&
    projection.K.length === 3 &&
    Array.isArray(projection.extrinsicsRigFromCamera) &&
    projection.extrinsicsRigFromCamera.length === 4 &&
    Array.isArray(projection.imageSize) &&
    projection.imageSize.length === 2
  );
}
