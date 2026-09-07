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

import type {
  ArtifactRole,
  EpisodeMode,
  EvalArtifact,
  InputKind,
  InputProvenance,
  ModelProvenance,
  OpenloopItem,
  OpenloopParams,
  OpenloopResult,
  RefusalCode,
  ResultKind,
  ResultManifest,
  ResultStatus,
  Truncation,
} from "@simforge-oss/evaluation/protocol";
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
  lowCents: number;
  highCents: number;
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
  /** The producer's role string, widened as the control plane types it. */
  role: string;
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

/**
 * The evaluation package's own document types, re-exported under the names this
 * UI uses.
 *
 * These are the canonical definitions, imported type-only from the
 * `./protocol` subpath, which does not re-export the episode runner or any
 * execution core. Type imports are erased, so this costs the portal bundle
 * nothing; duplicating them here would only create a second definition free to
 * drift. Runtime validation stays local (see {@link readEvalResultManifest}),
 * because a UI should degrade on an older document rather than throw.
 */
export type EvalArtifactRole = ArtifactRole;
export type EvalManifestArtifact = EvalArtifact;
export type EvalModelProvenance = ModelProvenance;
export type EvalInputProvenance = InputProvenance;
export type EvalResultManifest = ResultManifest;
export type EvalResultStatus = ResultStatus;
export type EvalResultKind = ResultKind;
export type EvalTruncation = Truncation;
export type OpenLoopItem = OpenloopItem;
export type OpenLoopResult = OpenloopResult;
export type OpenLoopRefusalCode = RefusalCode;
export type OpenLoopParams = OpenloopParams;
export type OpenLoopInputKind = InputKind;
export type EpisodeRunMode = EpisodeMode;

/**
 * A metric bucket keyed by horizon seconds.
 *
 * Widened on purpose: the producer keys these by its own horizon union, and a
 * result written by a newer worker may carry a horizon this build has never
 * heard of. The tables render whatever keys are present, so an unknown horizon
 * shows up instead of being dropped.
 */
export type HorizonMetrics = Record<string, number | undefined>;

/** Where a reference future came from, as the producer records it. */
export type OpenLoopReference = NonNullable<OpenloopItem["reference"]>;

/**
 * Camera calibration for drawing an image-space overlay.
 *
 * The producer carries this per item, and it is null whenever the input had no
 * real calibration — which is exactly when an image-space overlay would assert
 * a correspondence nobody measured. The UI then falls back to the metric
 * bird's-eye plot. See `components/FrameOverlay`.
 */
export type TrajectoryProjection = NonNullable<OpenloopItem["projection"]>;

/**
 * The optional `trajectories.json` artifact.
 *
 * Per-item geometry already travels in `openloop.json`, so this document is
 * only consulted for a run that shipped one; `item.projection` remains the
 * authority for whether an overlay may be drawn.
 */
export type TrajectoriesDocument = {
  items?: OpenLoopItem[];
  projection?: TrajectoryProjection | null;
};

export type FramesManifest = {
  frames: { cameraId: number; index: number; tUs: number; path: string }[];
};

/**
 * Read one metric bucket out of an item's free-form `metrics` record.
 *
 * The producer types `metrics` as `Record<string, unknown>` because which
 * buckets exist depends on the run, so the shape has to be checked here rather
 * than asserted. Non-numeric entries are dropped instead of rendered as NaN.
 */
export function horizonMetrics(
  metrics: Record<string, unknown> | null | undefined,
  bucket: string,
): HorizonMetrics | null {
  const value = metrics?.[bucket];
  if (!isRecord(value)) return null;
  const result: Record<string, number> = {};
  for (const [horizon, metric] of Object.entries(value)) {
    if (typeof metric === "number" && Number.isFinite(metric)) result[horizon] = metric;
  }
  return Object.keys(result).length > 0 ? result : null;
}

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
  if (!Array.isArray(value.artifacts)) {
    return { ok: false, reason: "the result manifest carries no `artifacts` array" };
  }
  if (!isRecord(value.provenance)) {
    return { ok: false, reason: "the result manifest carries no `provenance` block" };
  }
  // Validated at the boundary above, then asserted rather than rebuilt
  // field-by-field: rebuilding would silently drop any field a newer worker
  // added, and the discriminating fields are exactly what was just checked.
  return { ok: true, value: value as unknown as EvalResultManifest };
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
 * The projection an overlay may legitimately be drawn with, or null.
 *
 * Named because "we may draw in image space" is a claim about honesty, not a
 * null check: without real calibration the overlay would assert a
 * correspondence nobody measured. The item's own projection wins; a
 * run-level `trajectories.json` is only a fallback for a producer that put it
 * there instead.
 */
export function overlayProjection(
  item: Pick<OpenLoopItem, "projection">,
  document?: TrajectoriesDocument | null,
): TrajectoryProjection | null {
  const projection = item.projection ?? document?.projection ?? null;
  if (!projection) return null;
  return Array.isArray(projection.K) &&
    projection.K.length === 3 &&
    Array.isArray(projection.extrinsicsRigFromCamera) &&
    projection.extrinsicsRigFromCamera.length === 4 &&
    Array.isArray(projection.imageSize) &&
    projection.imageSize.length === 2
    ? projection
    : null;
}
