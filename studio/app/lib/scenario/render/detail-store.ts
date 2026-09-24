import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne, queryRows } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import {
  RenderProgressRecordSchema,
  ScenarioRendererEngineSchema,
} from "@/app/lib/scenario/render-wire-contracts";
import { listRenderJobArtifacts } from "./artifact-store";
import type {
  ScenarioJobEventDto,
  ScenarioRenderAttemptDto,
  ScenarioRenderJobDetailDto,
  ScenarioRenderSubstitutionDto,
  ScenarioRenderWarningDto,
} from "@simforge-oss/studio-host";
import { RenderSubstitutionRecordSchema } from "@simforge-oss/studio-shared";

/**
 * The render details tab (#136) and session cards (#137): one job with its attempts, its event log,
 * and its artifacts.
 *
 * UNCACHED, for the same reason as the gallery and more so. Every interesting column here is
 * worker-advanced: `job_state`, `progress`, `attempt_count`, `failure_code`, `parity_result`,
 * `worker_attestation`, every `render_attempts` row, and the whole `job_events` log — which exists
 * precisely to be appended to while the user watches. A live progress view is the entire point of this
 * tab, so caching it would defeat the feature rather than merely risk staleness.
 */

type DetailRow = {
  id: string;
  revision_id: string;
  execution_package_id: string;
  execution_package_control_sha256: string | null;
  render_profile_id: string | null;
  job_mode: ScenarioRenderJobDetailDto["jobMode"];
  job_state: ScenarioRenderJobDetailDto["jobState"];
  progress: number | string | null;
  progress_detail: string | Record<string, unknown> | null;
  renderer_engine: string | null;
  intent_sha256: string | null;
  /** The native preset resolved at submission; null for other engines and older jobs. */
  render_preset: string | null;
  /** The intent's `render` (preset and overrides); null when it carries none (the default). */
  render_request: string | Record<string, unknown> | null;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  failure_code: string | null;
  failure_message: string | null;
  billing_mode: string;
  estimated_cost_cents: number | string;
  render_spec_sha256: string;
  hidden_at: string | null;
  hidden_by_user_id: string | null;
  parent_render_job_id: string | null;
  source_artifact_id: string | null;
  model_family: string | null;
  model_config_sha256: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancel_requested_at: string | null;
  motion_source: "original" | "resimulated" | "original-xosc" | null;
  timeline_contact_origin: "trace" | "derived-at-timeline-build" | "legacy-xodr-elevation" | null;
  sim_key: string | null;
  trace_sha256: string | null;
  sim_engine_sem_ver: string | null;
};

function progressPercentOf(progress: number | string | null): number | null {
  if (progress === null) return null;
  const value = Number(progress);
  // The canonical column is constrained to 0-1; the public DTO is explicitly 0-100.
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value * 100 : null;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const IMMUTABLE_RUNTIME_VERSION_RE = /^(?:[0-9a-f]{40}|v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/;
const ATTEMPT_STATES = new Set(["leased", "running", "succeeded", "failed", "expired", "cancelled"]);
const PUBLIC_EVENT_KINDS = new Set([
  "accepted", "assets_validated", "plan_compiled", "interaction_started",
  "render_started", "progress", "artifact_uploaded",
  "completed", "retry_queued", "failed", "cancelled",
]);

function invalidLineage(): never {
  throw new Error("uniscenario_render_lineage_invalid");
}

function publicTimestamp(value: string | null, required = false): string | null {
  if (value === null) {
    if (required) invalidLineage();
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalidLineage();
  return new Date(timestamp).toISOString();
}

function publicIdentifier(value: string | null): string {
  if (!value || !PUBLIC_ID_RE.test(value)) invalidLineage();
  return value;
}

/**
 * Failure codes whose message was written to name what is missing or
 * degraded (docs/engineering/no-silent-fallbacks.md): engine policy errors
 * the worker reports as `render.<code>` and control-plane evidence refusals.
 * Their message is part of the job result; other worker messages (log
 * tails, transport errors) stay redacted.
 */
const NAMED_FAILURE_CODE_RE = /^render\.(?:native|carla|render)_[a-z0-9_]+$/;
const FAILURE_MESSAGE_MAX = 2_000;

export function publicFailureDetail(code: string | null, message: string | null): string | null {
  if (!code || !NAMED_FAILURE_CODE_RE.test(code) || typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  return trimmed.length > FAILURE_MESSAGE_MAX ? `${trimmed.slice(0, FAILURE_MESSAGE_MAX - 3)}...` : trimmed;
}

const WARNING_LIMIT = 50;

/**
 * Engine warnings, oldest first: the render worker forwards them as `warning`
 * progress records, the local CPU lane as `warning` job events whose payload
 * is `{ code, message }`.
 */
export function publicRenderWarnings(records: readonly unknown[], localEvents: readonly unknown[] = []): ScenarioRenderWarningDto[] {
  const warnings: ScenarioRenderWarningDto[] = [];
  for (const value of records) {
    const record = RenderProgressRecordSchema.parse(parseJsonObject(value as string | Record<string, unknown>));
    if (record.event === "warning") warnings.push({ code: record.code, message: record.message });
  }
  for (const value of localEvents) {
    const payload = parseJsonObject(value as string | Record<string, unknown>);
    if (typeof payload.code !== "string" || typeof payload.message !== "string") invalidLineage();
    warnings.push({ code: payload.code, message: payload.message });
  }
  return warnings.slice(0, WARNING_LIMIT);
}

/** The substitutions the succeeded attempt recorded (`render_attempts.metrics.renderSubstitutions`). */
export function publicRenderSubstitutions(metrics: unknown): ScenarioRenderSubstitutionDto[] {
  if (metrics === null || metrics === undefined) return [];
  const object = parseJsonObject(metrics as string | Record<string, unknown>);
  const raw = object.renderSubstitutions;
  if (raw === undefined) return [];
  return RenderSubstitutionRecordSchema.array().parse(raw).map((item) => ({
    kind: item.kind, subject: item.subject, requested: item.requested, rendered: item.rendered, allowedBy: item.allowedBy,
  }));
}

export async function listRenderJobAttempts(
  context: AppContext,
  jobId: string,
  lineage: { executionPackageId: string; controlSha256: string; attemptCount: number },
) {
  const rows = await queryRows<{
    id: string; attempt_number: number; attempt_state: string; worker_node_id: string;
    execution_package_id: string | null; execution_package_control_sha256: string | null;
    worker_class: string | null; runtime_version: string | null; image_digest: string | null;
    renderer_engine: string | null; base_image_digest: string | null;
    base_image_platform_digest: string | null; engine_capabilities_sha256: string | null;
    leased_at: string | null;
    started_at: string | null; completed_at: string | null;
  }>(
    `SELECT o.id, o.attempt_number,
            CASE WHEN o.state = 'active' THEN 'running' ELSE o.state END AS attempt_state,
            o.worker_id AS worker_node_id,
            j.execution_package_id, j.execution_package_control_sha256,
            CASE WHEN a.id IS NULL THEN 'local' ELSE a.worker_class END AS worker_class,
            a.runtime_version, a.image_digest,
            COALESCE(a.renderer_engine, j.renderer_engine) AS renderer_engine,
            a.base_image_digest, a.base_image_platform_digest, a.engine_capabilities_sha256,
            o.leased_at::text AS leased_at,
            CASE WHEN o.state = 'active' THEN o.leased_at::text ELSE NULL END AS started_at,
            o.completed_at::text AS completed_at
       FROM simforge.operational_job_attempts o
       JOIN simforge.render_jobs j
         ON j.id = o.job_id AND j.workspace_id = o.workspace_id
       LEFT JOIN simforge.render_attempts a
         ON a.id = o.id AND a.workspace_id = o.workspace_id
      WHERE o.workspace_id = :workspace_id AND o.job_id = :job_id
        AND o.job_family = 'openscenario_render'
      ORDER BY o.attempt_number`,
    { workspace_id: context.workspaceId, job_id: jobId },
  );
  if (rows.length !== lineage.attemptCount) {
    invalidLineage();
  }
  const seenAttempts = new Set<number>();
  return rows.map((row): ScenarioRenderAttemptDto => {
    const attemptNumber = Number(row.attempt_number);
    const localAttempt = row.worker_class === "local";
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1
      || attemptNumber > lineage.attemptCount || seenAttempts.has(attemptNumber)
      || row.execution_package_id !== lineage.executionPackageId
      || row.execution_package_control_sha256 !== lineage.controlSha256
      || !SHA256_RE.test(row.execution_package_control_sha256 ?? "")
      || !ATTEMPT_STATES.has(row.attempt_state)
      || !PUBLIC_ID_RE.test(row.worker_class ?? "")
      || (localAttempt
        ? row.runtime_version !== null || row.image_digest !== null
        : !IMMUTABLE_RUNTIME_VERSION_RE.test(row.runtime_version ?? "")
          || !IMAGE_DIGEST_RE.test(row.image_digest ?? ""))
      || (row.base_image_digest !== null && !IMAGE_DIGEST_RE.test(row.base_image_digest))
      || (row.base_image_platform_digest !== null && !IMAGE_DIGEST_RE.test(row.base_image_platform_digest))
      || (row.engine_capabilities_sha256 !== null && !SHA256_RE.test(row.engine_capabilities_sha256))) {
      invalidLineage();
    }
    seenAttempts.add(attemptNumber);
    const leasedAt = publicTimestamp(row.leased_at, true)!;
    const startedAt = publicTimestamp(row.started_at);
    const completedAt = publicTimestamp(row.completed_at);
    if ((startedAt && Date.parse(startedAt) < Date.parse(leasedAt))
      || (completedAt && Date.parse(completedAt) < Date.parse(startedAt ?? leasedAt))) {
      invalidLineage();
    }
    return {
      id: publicIdentifier(row.id),
      attemptNumber,
      executionPackageControlSha256: row.execution_package_control_sha256!,
      status: row.attempt_state,
      attemptState: row.attempt_state,
      runtimeVersion: row.runtime_version,
      rendererEngine: row.renderer_engine ? ScenarioRendererEngineSchema.parse(row.renderer_engine) : null,
      workerNodeId: publicIdentifier(row.worker_node_id),
      workerClass: row.worker_class!,
      imageDigest: row.image_digest,
      baseImageDigest: row.base_image_digest,
      baseImagePlatformDigest: row.base_image_platform_digest,
      engineCapabilitiesSha256: row.engine_capabilities_sha256,
      leasedAt,
      startedAt,
      completedAt,
    };
  });
}

/**
 * The job event log, oldest first so the UI can render it as a timeline.
 *
 * Bounded by `limit` because this table is append-only and unbounded per job — a long-running or
 * repeatedly-retried render can accumulate a lot of events, and the details tab must not become the
 * one read that grows without limit. Ordering matches `job_events_render_job_id_event_ordinal_key`.
 */
export async function listRenderJobEvents(
  context: AppContext,
  jobId: string,
  options: { limit?: number } = {},
) {
  const rows = await queryRows<{
    event_ordinal: number; event_kind: string; render_attempt_id: string | null;
    attempt_lineage_valid: boolean; created_at: string;
  }>(
    `SELECT e.event_ordinal,
            CASE e.event_type
              WHEN 'leased' THEN 'accepted'
              WHEN 'job.started' THEN 'render_started'
              WHEN 'artifact.ready' THEN 'artifact_uploaded'
              WHEN 'job.completed' THEN 'completed'
              WHEN 'job.failed' THEN 'failed'
              WHEN 'job.canceled' THEN 'cancelled'
              ELSE 'progress'
            END AS event_kind,
            e.attempt_id AS render_attempt_id,
            (e.attempt_id IS NOT NULL AND a.id IS NOT NULL) AS attempt_lineage_valid,
            e.occurred_at::text AS created_at
       FROM simforge.operational_job_events e
       LEFT JOIN simforge.cpu_job_attempts a
         ON a.id = e.attempt_id AND a.workspace_id = e.workspace_id
        AND a.job_family = e.job_family AND a.job_id = e.job_id
      WHERE e.workspace_id = :workspace_id AND e.job_id = :job_id
        AND e.job_family = 'openscenario_render'
      ORDER BY e.event_ordinal
      LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      job_id: jobId,
      row_limit: Math.max(1, Math.min(Math.trunc(options.limit ?? 200) || 1, 500)),
    },
  );
  return rows.map((row): ScenarioJobEventDto => {
    const eventOrdinal = Number(row.event_ordinal);
    if (!Number.isSafeInteger(eventOrdinal) || eventOrdinal < 1
      || !PUBLIC_EVENT_KINDS.has(row.event_kind)
      || row.attempt_lineage_valid !== true) invalidLineage();
    return {
      eventOrdinal,
      eventKind: row.event_kind,
      attemptId: publicIdentifier(row.render_attempt_id),
      detail: null,
      createdAt: publicTimestamp(row.created_at, true)!,
    };
  });
}

/**
 * One render job with everything the details tab needs.
 *
 * Returns a HIDDEN job rather than null. Hiding is a gallery-listing concept, so a deep link into a
 * hidden render must still resolve — `hiddenAt` is on the DTO so the UI can show that state and offer
 * to unhide. Making this 404 instead would make hidden renders unrecoverable through the UI.
 *
 * Child reads run concurrently; progress is bounded to one latest record per stage in this attempt.
 */
export async function getRenderJobDetail(
  context: AppContext,
  jobId: string,
): Promise<ScenarioRenderJobDetailDto | null> {
  const job = await queryOne<DetailRow>(
    `SELECT j.id, j.revision_id, j.execution_package_id,
            j.execution_package_control_sha256, j.render_profile_id, j.job_mode, j.job_state, j.progress,
            j.progress_detail, j.renderer_engine, j.intent_sha256,
            j.priority, j.attempt_count, j.max_attempts, j.failure_code,
            j.failure_detail->>'message' AS failure_message, j.billing_mode,
            j.estimated_cost_cents, j.render_spec_sha256, j.hidden_at, j.hidden_by_user_id,
            j.parent_render_job_id, j.source_artifact_id, j.model_family, j.model_config_sha256,
            j.created_at, j.updated_at, j.started_at, j.completed_at, j.cancel_requested_at,
            j.motion_source, j.timeline_contact_origin, j.sim_key, j.trace_sha256, s.engine_sem_ver AS sim_engine_sem_ver,
            j.render_preset, j.render_intent->'render' AS render_request
       FROM simforge.render_jobs j
       LEFT JOIN simforge.sim_results s ON s.workspace_id = j.workspace_id AND s.sim_key = j.sim_key
       JOIN simforge.execution_packages ep
         ON ep.id = j.execution_package_id AND ep.workspace_id = j.workspace_id
      WHERE j.workspace_id = :workspace_id AND j.id = :job_id
      LIMIT 1`,
    { workspace_id: context.workspaceId, job_id: jobId },
  );
  if (!job) return null;
  if (!SHA256_RE.test(job.execution_package_control_sha256 ?? "")
    || !Number.isSafeInteger(Number(job.attempt_count))
    || Number(job.attempt_count) < 0) invalidLineage();

  const [attempts, events, artifacts, progressRows, warningRows, localWarningRows, substitutionRows] = await Promise.all([
    listRenderJobAttempts(context, jobId, {
      executionPackageId: job.execution_package_id,
      controlSha256: job.execution_package_control_sha256!,
      attemptCount: Number(job.attempt_count),
    }),
    listRenderJobEvents(context, jobId),
    listRenderJobArtifacts(context, jobId),
    queryRows<{ record: string | Record<string, unknown> }>(
      `SELECT DISTINCT ON (p.record->>'stage') p.record
         FROM simforge.render_progress_records p
         JOIN simforge.render_attempts a ON a.id = p.render_attempt_id
         JOIN simforge.render_jobs j ON j.id = p.render_job_id
        WHERE j.id = :job_id AND j.workspace_id = :workspace_id
          AND a.attempt_number = :attempt_number
          AND p.record->>'event' IN ('stage.started', 'stage.progress')
        ORDER BY p.record->>'stage', p.sequence DESC`,
      { job_id: jobId, workspace_id: context.workspaceId, attempt_number: Number(job.attempt_count) },
    ),
    queryRows<{ record: string | Record<string, unknown> }>(
      `SELECT p.record
         FROM simforge.render_progress_records p
         JOIN simforge.render_attempts a ON a.id = p.render_attempt_id
         JOIN simforge.render_jobs j ON j.id = p.render_job_id
        WHERE j.id = :job_id AND j.workspace_id = :workspace_id
          AND a.attempt_number = :attempt_number
          AND p.record->>'event' = 'warning'
        ORDER BY p.sequence
        LIMIT ${WARNING_LIMIT}`,
      { job_id: jobId, workspace_id: context.workspaceId, attempt_number: Number(job.attempt_count) },
    ),
    queryRows<{ payload: string | Record<string, unknown> }>(
      `SELECT e.event_payload AS payload
         FROM simforge.operational_job_events e
        WHERE e.workspace_id = :workspace_id AND e.job_id = :job_id
          AND e.job_family = 'openscenario_render' AND e.event_type = 'warning'
          AND e.attempt_id = (
            SELECT o.id FROM simforge.operational_job_attempts o
             WHERE o.workspace_id = :workspace_id AND o.job_id = :job_id AND o.job_family = 'openscenario_render'
             ORDER BY o.attempt_number DESC LIMIT 1
          )
        ORDER BY e.event_ordinal
        LIMIT ${WARNING_LIMIT}`,
      { job_id: jobId, workspace_id: context.workspaceId },
    ),
    queryRows<{ metrics: string | Record<string, unknown> | null }>(
      `SELECT a.metrics
         FROM simforge.render_attempts a
         JOIN simforge.render_jobs j ON j.id = a.render_job_id
        WHERE j.id = :job_id AND j.workspace_id = :workspace_id
          AND a.attempt_state = 'succeeded'
        ORDER BY a.attempt_number DESC
        LIMIT 1`,
      { job_id: jobId, workspace_id: context.workspaceId },
    ),
  ]);

  return {
    id: job.id,
    revisionId: job.revision_id,
    executionPackageId: job.execution_package_id,
    executionPackageControlSha256: job.execution_package_control_sha256!,
    renderProfileId: job.render_profile_id,
    jobMode: job.job_mode,
    jobState: job.job_state,
    progressPercent: progressPercentOf(job.progress),
    progressDetail: job.progress_detail
      ? RenderProgressRecordSchema.parse(parseJsonObject(job.progress_detail))
      : null,
    progressRecords: progressRows.map((row) => RenderProgressRecordSchema.parse(parseJsonObject(row.record))),
    rendererEngine: job.renderer_engine
      ? ScenarioRendererEngineSchema.parse(job.renderer_engine)
      : null,
    intentSha256: job.intent_sha256,
    render: job.renderer_engine === "native" ? renderRequestOf(job) : null,
    priority: Number(job.priority),
    attemptCount: Number(job.attempt_count),
    maxAttempts: Number(job.max_attempts),
    failureCode: job.failure_code && PUBLIC_ID_RE.test(job.failure_code) ? job.failure_code : null,
    // Worker failure details can contain arbitrary payloads, so only the message of a code that
    // names what is missing is public (`publicFailureDetail`); everything else stays redacted.
    failureDetail: job.job_state === "failed" ? publicFailureDetail(job.failure_code, job.failure_message) : null,
    warnings: publicRenderWarnings(warningRows.map((row) => row.record), localWarningRows.map((row) => row.payload)),
    substitutions: publicRenderSubstitutions(substitutionRows[0]?.metrics ?? null),
    billingMode: job.billing_mode,
    estimatedCostCents: Number(job.estimated_cost_cents),
    renderSpecSha256: job.render_spec_sha256,
    hiddenAt: job.hidden_at,
    hiddenByUserId: job.hidden_by_user_id,
    parentRenderJobId: job.parent_render_job_id,
    sourceArtifactId: job.source_artifact_id,
    modelFamily: job.model_family,
    modelConfigSha256: job.model_config_sha256,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    cancelRequestedAt: job.cancel_requested_at,
    motion: {
      source: job.motion_source ?? null,
      engineSemVer: job.sim_engine_sem_ver ?? null,
      simKey: job.sim_key ?? null,
      traceSha256: job.trace_sha256 ?? null,
      heightSource: job.timeline_contact_origin ?? null,
    },
    attempts,
    events,
    artifacts,
  };
}

/**
 * The native render configuration a job asked for: the preset recorded at
 * submission and the intent's `RenderConfig` overrides. `preset` is null on
 * a job submitted before it was recorded (the UI says so; it is never guessed).
 */
function renderRequestOf(job: DetailRow): NonNullable<ScenarioRenderJobDetailDto["render"]> {
  const request = job.render_request === null ? null : parseJsonObject(job.render_request);
  const preset = job.render_preset === "training" || job.render_preset === "showcase" ? job.render_preset : null;
  const set = request?.set && typeof request.set === "object" && !Array.isArray(request.set)
    ? request.set as Record<string, unknown>
    : {};
  return { preset, set };
}
