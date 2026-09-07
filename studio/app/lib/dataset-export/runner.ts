import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  DatasetExportJob,
  DatasetExportPublicationKind,
  DatasetExportRequestedOutput,
  DatasetExportTaskStage,
} from "@simforge-oss/studio-shared";
import { queryRows, type Transaction } from "@/app/lib/db/data-api";
import {
  createDatasetExportTask,
  getDatasetExportJobV2,
  recordDatasetExportTaskAttempt,
} from "@/app/lib/db/dataset-export-v2-store";
import { LOCAL_ARTIFACTS_DIR } from "@/app/lib/db/config";
import { scenarioId } from "@/app/lib/scenario/core";
import { withScenarioJobTransaction } from "@/app/lib/scenario/jobs/lifecycle-lock";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/s3/s3-config";
import { localObjectPath, registerLocalFile, writeLocalObject } from "@/app/lib/s3/s3-object";
import {
  finishTar,
  finishZip,
  writeArtifactToTar,
  writeArtifactToZip,
  writeBufferToTar,
  writeBufferToZip,
  type ZipEntry,
} from "./archive";
import {
  buildOdvgJsonl,
  isBundleIndexArtifact,
  isSdgArtifact,
  isSdgManifestArtifact,
  isWorkerOdvgArtifact,
  readArtifactDocuments,
  readBundleIndexDocuments,
  validateSdgManifestArtifactCoverage,
} from "./odvg";
import {
  listArtifactsForJob,
  listScenarioDefinitionsForJob,
  type ExportArtifact,
  type ExportScenarioDefinition,
} from "./sources";

/**
 * In-process executor for the broad dataset-export domain.
 *
 * SimCloud runs these jobs on the unified CPU runner: a task queue per job
 * (`snapshot_resolve` → `prefix_materialize` → `package_archive` →
 * `publication_finalize`), fenced attempts, and publications that point at
 * canonical artifacts. Studio keeps exactly that data model so a job's tasks,
 * attempts, snapshot and publications read identically wherever it ran, but
 * the stages execute inside the local service: one job at a time, each stage
 * a short transaction plus streaming file work outside it.
 */

const WORKER_ID = "local:dataset_export";
const ATTEMPT_TTL_SECONDS = 6 * 60 * 60;
const MAX_STAGE_ATTEMPTS = 3;

/** Recipes the local executor can materialize with local renderer output. */
export const LOCAL_DATASET_EXPORT_RECIPES = ["review_bundle", "native_full", "sdg_odvg"] as const;
export type LocalDatasetExportRecipe = (typeof LOCAL_DATASET_EXPORT_RECIPES)[number];

export function isLocalDatasetExportRecipe(recipe: string): recipe is LocalDatasetExportRecipe {
  return (LOCAL_DATASET_EXPORT_RECIPES as readonly string[]).includes(recipe);
}

export const LOCAL_UNSUPPORTED_RECIPE_MESSAGE =
  "Alpamayo SFT packages require CARLA four-camera render groups with a run manifest, which the local Bevy renderer does not produce. Queue this recipe from SimCloud.";

type TaskRow = {
  id: string;
  workspace_id: string;
  dataset_export_job_id: string;
  stage: DatasetExportTaskStage;
  status: string;
  attempt_count: number;
  max_attempts: number;
  input_json: string;
  lease_token: string | null;
};

type ClaimedTask = TaskRow & {
  attempt_count: number;
  operational_attempt_id: string;
  input: Record<string, unknown>;
};

type StageOutcome = {
  output: Record<string, unknown>;
  beforeComplete?: (tx: Transaction) => Promise<void>;
  nextTask?: { stage: DatasetExportTaskStage; input: Record<string, unknown> } | null;
};

const runnerState = globalThis as typeof globalThis & {
  __simforgeDatasetExportRunner?: {
    inflight: Map<string, Promise<void>>;
    chain: Promise<void>;
  };
};
const state = (runnerState.__simforgeDatasetExportRunner ??= {
  inflight: new Map(),
  chain: Promise.resolve(),
});

function safeSegment(value: unknown, fallback = "item") {
  return String(value || fallback).replace(/[^a-zA-Z0-9._=-]+/g, "_");
}

function requestedPackage(job: DatasetExportJob): DatasetExportRequestedOutput | null {
  return job.requestedOutputsJson.find((output) => output.kind === "package") ?? null;
}

function exportIncludesScenarioJson(job: DatasetExportJob) {
  const format = String(job.format ?? "").toUpperCase();
  const recipe = String(job.recipe ?? "").toLowerCase();
  return (
    format === "REVIEW_BUNDLE" ||
    format === "NATIVE_FULL" ||
    recipe === "review_bundle" ||
    recipe === "native_full"
  );
}

function scenarioDefinitionDocument(scenario: ExportScenarioDefinition, job: DatasetExportJob) {
  let draft: unknown = {};
  try {
    draft = scenario.draft_json ? JSON.parse(scenario.draft_json) : {};
  } catch {
    draft = {};
  }
  return {
    schema_version: "simforge.scenario.export.v1",
    dataset_id: job.datasetId,
    workspace_id: job.workspaceId,
    scenario_id: scenario.id,
    display_name: scenario.display_name || scenario.id,
    status: scenario.status ?? null,
    source_kind: scenario.source_kind || "native",
    draft,
    exported_at: new Date().toISOString(),
  };
}

function scenarioJsonEntryName(scenario: ExportScenarioDefinition, seen: Map<string, number>) {
  const base = `scenarios/${safeSegment(scenario.display_name || "scenario")}-${safeSegment(scenario.id)}.json`;
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count ? base.replace(/\.json$/, `-${count + 1}.json`) : base;
}

function packageEntryBase(artifact: ExportArtifact) {
  const key = artifact.s3_key ?? artifact.id;
  return `${safeSegment(artifact.scenario_id, "scenario")}/${safeSegment(
    artifact.sequence_id || artifact.sensor_id || "shared",
  )}/${safeSegment(artifact.output_modality || artifact.artifact_type || artifact.artifact_family)}/${safeSegment(
    key.split("/").pop() || artifact.id,
  )}`;
}

function nextPackageEntryName(artifact: ExportArtifact, seen: Map<string, number>) {
  const base = packageEntryBase(artifact);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count ? base.replace(/([^/.]+)(\.[^/]*)?$/, `$1-${count + 1}$2`) : base;
}

// ── Job admission and task lifecycle ────────────────────────────────────────

async function loadJob(workspaceId: string, jobId: string) {
  const job = await getDatasetExportJobV2(workspaceId, jobId);
  if (!job) throw new Error(`dataset_export_job_missing:${jobId}`);
  return job;
}

/**
 * Open (or resume) the fenced attempt for this job. Returns null when the job
 * is terminal or cancelled, in which case nothing runs.
 */
async function admitJob(workspaceId: string, jobId: string) {
  return withScenarioJobTransaction(jobId, async (tx) => {
    const job = await tx.queryOne<{
      state: string;
      cancel_requested_at: string | null;
      attempt_count: number;
      max_attempts: number;
    }>(
      `SELECT state, cancel_requested_at::text AS cancel_requested_at, attempt_count, max_attempts
         FROM simforge.artifact_postprocess_jobs
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND postprocess_kind = 'dataset_export' FOR UPDATE`,
      { job_id: jobId, workspace_id: workspaceId },
    );
    if (!job || job.cancel_requested_at || !["queued", "running"].includes(job.state)) return null;
    const active = await tx.queryOne<{ id: string; expires_at: string }>(
      `SELECT id, expires_at::text AS expires_at FROM simforge.cpu_job_attempts
        WHERE job_family = 'artifact_postprocess' AND job_id = :job_id AND attempt_state = 'active'
        LIMIT 1`,
      { job_id: jobId },
    );
    if (active) {
      // Only one attempt per job runs in this process, so an active attempt
      // found at admission belongs to a process that died mid-run: expire it so
      // the job resumes from its remaining queued tasks with a fresh fence.
      await tx.execute(
        `UPDATE simforge.cpu_job_attempts
            SET attempt_state = 'expired', completed_at = NOW(),
                failure_code = 'runner_restarted'
          WHERE id = :attempt_id`,
        { attempt_id: active.id },
      );
      await tx.execute(
        `UPDATE dataset_export_tasks
            SET status = 'queued', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                updated_at = NOW()
          WHERE dataset_export_job_id = :job_id AND workspace_id = :workspace_id
            AND status = 'running'`,
        { job_id: jobId, workspace_id: workspaceId },
      );
    }
    const attemptNumber = Number(job.attempt_count) + 1;
    if (attemptNumber > Number(job.max_attempts)) {
      await tx.execute(
        `UPDATE simforge.artifact_postprocess_jobs
            SET state = 'failed', phase = 'failed', failure_code = 'attempts_exhausted',
                failure_detail = jsonb_build_object('message', 'Export exceeded its attempt budget.'),
                completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
          WHERE id = :job_id AND workspace_id = :workspace_id`,
        { job_id: jobId, workspace_id: workspaceId },
      );
      return null;
    }
    const attemptId = scenarioId("usppat");
    const fenceToken = randomBytes(32).toString("hex");
    await tx.execute(
      `INSERT INTO simforge.cpu_job_attempts (
         id, workspace_id, job_family, job_id, attempt_number, worker_id,
         fence_token_sha256, attempt_state, expires_at
       ) VALUES (
         :id, :workspace_id, 'artifact_postprocess', :job_id, :attempt_number, :worker_id,
         :fence, 'active', NOW() + (CAST(:ttl AS double precision) * INTERVAL '1 second')
       )`,
      {
        id: attemptId,
        workspace_id: workspaceId,
        job_id: jobId,
        attempt_number: attemptNumber,
        worker_id: WORKER_ID,
        fence: createHash("sha256").update(fenceToken).digest("hex"),
        ttl: ATTEMPT_TTL_SECONDS,
      },
    );
    await tx.execute(
      `UPDATE simforge.artifact_postprocess_jobs
          SET state = 'running', attempt_count = :attempt_number,
              started_at = COALESCE(started_at, NOW()), updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id`,
      { job_id: jobId, workspace_id: workspaceId, attempt_number: attemptNumber },
    );
    return { attemptId, attemptNumber };
  });
}

async function claimNextTask(workspaceId: string, jobId: string, operationalAttemptId: string) {
  return withScenarioJobTransaction(jobId, async (tx) => {
    const cancelled = await tx.queryOne<{ id: string }>(
      `SELECT id FROM simforge.artifact_postprocess_jobs
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND (cancel_requested_at IS NOT NULL OR state NOT IN ('queued', 'running'))`,
      { job_id: jobId, workspace_id: workspaceId },
    );
    if (cancelled) return { kind: "stop" as const };
    const task = await tx.queryOne<TaskRow>(
      `SELECT id, workspace_id, dataset_export_job_id, stage, status, attempt_count, max_attempts,
              input_json::text AS input_json, lease_token
         FROM dataset_export_tasks
        WHERE dataset_export_job_id = :job_id AND workspace_id = :workspace_id AND status = 'queued'
        ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE`,
      { job_id: jobId, workspace_id: workspaceId },
    );
    if (!task) return { kind: "drained" as const };
    const leaseToken = randomBytes(16).toString("hex");
    const attemptCount = Number(task.attempt_count) + 1;
    await tx.execute(
      `UPDATE dataset_export_tasks
          SET status = 'running', lease_owner = :worker_id, lease_token = :lease_token,
              lease_expires_at = NOW() + (CAST(:ttl AS double precision) * INTERVAL '1 second'), last_heartbeat_at = NOW(),
              attempt_count = :attempt_count, started_at = COALESCE(started_at, NOW()),
              updated_at = NOW()
        WHERE id = :task_id`,
      {
        task_id: task.id,
        worker_id: WORKER_ID,
        lease_token: leaseToken,
        ttl: ATTEMPT_TTL_SECONDS,
        attempt_count: attemptCount,
      },
    );
    await tx.execute(
      `UPDATE simforge.artifact_postprocess_jobs
          SET phase = :phase, updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id`,
      { job_id: jobId, workspace_id: workspaceId, phase: task.stage },
    );
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(task.input_json) as Record<string, unknown>;
    } catch {
      input = {};
    }
    const claimed: ClaimedTask = {
      ...task,
      attempt_count: attemptCount,
      lease_token: leaseToken,
      operational_attempt_id: operationalAttemptId,
      input,
    };
    return { kind: "task" as const, task: claimed };
  });
}

async function completeTask(job: DatasetExportJob, task: ClaimedTask, outcome: StageOutcome) {
  await withScenarioJobTransaction(job.id, async (tx) => {
    const live = await tx.queryOne<{ id: string }>(
      `SELECT task.id FROM dataset_export_tasks task
         JOIN simforge.artifact_postprocess_jobs job
           ON job.id = task.dataset_export_job_id AND job.workspace_id = task.workspace_id
        WHERE task.id = :task_id AND task.status = 'running' AND task.lease_token = :lease_token
          AND job.cancel_requested_at IS NULL AND job.state = 'running'
        FOR UPDATE OF task`,
      { task_id: task.id, lease_token: task.lease_token },
    );
    if (!live) throw new Error("dataset_export_task_fence_lost");
    if (outcome.beforeComplete) await outcome.beforeComplete(tx);
    await tx.execute(
      `UPDATE dataset_export_tasks
          SET status = 'succeeded', output_json = CAST(:output AS JSONB), lease_expires_at = NULL,
              finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
        WHERE id = :task_id`,
      { task_id: task.id, output: outcome.output },
    );
  });
  await recordDatasetExportTaskAttempt({
    taskId: task.id,
    attemptNumber: task.attempt_count,
    leaseOwner: WORKER_ID,
    leaseToken: task.lease_token,
    status: "succeeded",
    metadataJson: { operationalAttemptId: task.operational_attempt_id },
  });
  if (outcome.nextTask) {
    await createDatasetExportTask({
      workspaceId: job.workspaceId,
      datasetExportJobId: job.id,
      stage: outcome.nextTask.stage,
      partitionKey: outcome.nextTask.stage === "snapshot_resolve" ? "snapshot" : null,
      inputJson: outcome.nextTask.input,
    });
  }
}

async function failTask(job: DatasetExportJob, task: ClaimedTask, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const retry = task.attempt_count < Math.min(Number(task.max_attempts), MAX_STAGE_ATTEMPTS);
  await withScenarioJobTransaction(job.id, async (tx) => {
    await tx.execute(
      `UPDATE dataset_export_tasks
          SET status = :status, error_code = :error_code, error_message = :message,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              finished_at = CASE WHEN :retry THEN finished_at ELSE COALESCE(finished_at, NOW()) END,
              updated_at = NOW()
        WHERE id = :task_id AND status = 'running' AND lease_token = :lease_token`,
      {
        task_id: task.id,
        lease_token: task.lease_token,
        status: retry ? "queued" : "failed",
        error_code: retry ? "retry" : "stage_failed",
        message,
        retry,
      },
    );
    if (!retry) {
      await tx.execute(
        `UPDATE simforge.artifact_postprocess_jobs
            SET state = 'failed', phase = 'failed', failure_code = :failure_code,
                failure_detail = jsonb_build_object('message', CAST(:message AS text), 'stage', CAST(:stage AS text)),
                completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
          WHERE id = :job_id AND workspace_id = :workspace_id AND state = 'running'`,
        {
          job_id: job.id,
          workspace_id: job.workspaceId,
          failure_code: `${task.stage}_failed`,
          message,
          stage: task.stage,
        },
      );
    }
  });
  await recordDatasetExportTaskAttempt({
    taskId: task.id,
    attemptNumber: task.attempt_count,
    leaseOwner: WORKER_ID,
    leaseToken: task.lease_token,
    status: "failed",
    errorCode: retry ? "retry" : "stage_failed",
    errorMessage: message,
    metadataJson: { operationalAttemptId: task.operational_attempt_id },
  });
  return retry;
}

async function settleAttempt(
  workspaceId: string,
  jobId: string,
  attemptId: string,
  outcome: "succeeded" | "failed" | "cancelled",
  detail?: string,
) {
  await withScenarioJobTransaction(jobId, async (tx) => {
    await tx.execute(
      `UPDATE simforge.cpu_job_attempts
          SET attempt_state = :state, completed_at = NOW(),
              failure_code = CASE WHEN :state = 'succeeded' THEN NULL ELSE :state END,
              failure_detail = CASE WHEN CAST(:detail AS text) IS NULL THEN NULL
                                    ELSE jsonb_build_object('message', CAST(:detail AS text)) END
        WHERE id = :attempt_id AND workspace_id = :workspace_id AND attempt_state = 'active'`,
      { attempt_id: attemptId, workspace_id: workspaceId, state: outcome, detail: detail ?? null },
    );
    if (outcome === "cancelled") {
      await tx.execute(
        `UPDATE simforge.artifact_postprocess_jobs
            SET state = 'cancelled', phase = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
                updated_at = NOW()
          WHERE id = :job_id AND workspace_id = :workspace_id AND state IN ('queued', 'running')`,
        { job_id: jobId, workspace_id: workspaceId },
      );
      await tx.execute(
        `UPDATE dataset_export_tasks
            SET status = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                error_code = 'cancelled', finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
          WHERE dataset_export_job_id = :job_id AND workspace_id = :workspace_id
            AND status IN ('queued', 'running')`,
        { job_id: jobId, workspace_id: workspaceId },
      );
    }
  });
}

// ── Artifact and publication registration ────────────────────────────────────

async function insertExportArtifact(
  tx: Transaction,
  job: DatasetExportJob,
  task: ClaimedTask,
  input: {
    kind: string;
    key: string;
    contentType: string;
    sha256: string;
    sizeBytes: number;
    metadata: Record<string, unknown>;
  },
) {
  const id = scenarioId("usart");
  const row = await tx.queryOne<{ id: string }>(
    `INSERT INTO simforge.artifacts (
       id, workspace_id, revision_id, artifact_kind, media_type, storage_bucket, storage_key,
       sha256, byte_length, artifact_state, metadata, verified_at, verification_method,
       verification_sha256, producer_job_family, producer_job_id, producer_attempt_id, provenance
     ) VALUES (
       :id, :workspace_id, NULL, :kind, :content_type, :bucket, :key,
       :sha256, :size_bytes, 'available', CAST(:metadata AS jsonb), NOW(), 'stream_sha256',
       :sha256, 'artifact_postprocess', :job_id, :attempt_id, CAST(:provenance AS jsonb)
     )
     ON CONFLICT (workspace_id, sha256, artifact_kind)
       WHERE artifact_state IN ('pending', 'available') AND deleted_at IS NULL
     DO UPDATE SET sha256 = EXCLUDED.sha256
     RETURNING id`,
    {
      id,
      workspace_id: job.workspaceId,
      kind: input.kind,
      content_type: input.contentType,
      bucket: LOCAL_ARTIFACT_BUCKET,
      key: input.key,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      metadata: input.metadata,
      job_id: job.id,
      attempt_id: task.operational_attempt_id,
      provenance: {
        contract: "uniscenario.artifact-provenance/v1",
        producerJobFamily: "artifact_postprocess",
        producerJobId: job.id,
        producerAttemptId: task.operational_attempt_id,
        operation: "dataset_export",
      },
    },
  );
  const artifactId = row?.id ?? id;
  await tx.execute(
    `INSERT INTO simforge.operational_job_artifact_links (
       id, workspace_id, artifact_id, job_family, job_id, attempt_id, relationship
     ) VALUES (
       :link_id, :workspace_id, :artifact_id, 'artifact_postprocess', :job_id, :attempt_id, 'output'
     ) ON CONFLICT (artifact_id, job_family, job_id, attempt_id, relationship) DO NOTHING`,
    {
      link_id: scenarioId("usjal"),
      workspace_id: job.workspaceId,
      artifact_id: artifactId,
      job_id: job.id,
      attempt_id: task.operational_attempt_id,
    },
  );
  return artifactId;
}

async function insertPublication(
  tx: Transaction,
  job: DatasetExportJob,
  input: {
    kind: DatasetExportPublicationKind;
    artifactId: string;
    isDefault: boolean;
    metadata: Record<string, unknown>;
  },
) {
  const id = `depub_${createHash("sha256").update(`${job.id}:${input.kind}`).digest("hex").slice(0, 24)}`;
  await tx.execute(
    `INSERT INTO dataset_export_publications (
       id, workspace_id, dataset_export_job_id, dataset_snapshot_id, kind, uniscenario_artifact_id,
       status, is_default, published_at, metadata_json, created_at
     ) VALUES (
       :id, :workspace_id, :job_id, :snapshot_id, :kind, :artifact_id,
       'ready', :is_default, NOW(), CAST(:metadata AS JSONB), NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
       uniscenario_artifact_id = EXCLUDED.uniscenario_artifact_id,
       status = 'ready', is_default = EXCLUDED.is_default,
       published_at = NOW(), metadata_json = EXCLUDED.metadata_json`,
    {
      id,
      workspace_id: job.workspaceId,
      job_id: job.id,
      snapshot_id: job.datasetSnapshotId ?? null,
      kind: input.kind,
      artifact_id: input.artifactId,
      is_default: input.isDefault,
      metadata: input.metadata,
    },
  );
  return id;
}

// ── Stages ───────────────────────────────────────────────────────────────────

async function snapshotResolve(job: DatasetExportJob, task: ClaimedTask): Promise<StageOutcome> {
  if (job.datasetSnapshotId) {
    return {
      output: { datasetSnapshotId: job.datasetSnapshotId, reused: true },
      beforeComplete: (tx) =>
        tx.execute(
          `UPDATE simforge.artifact_postprocess_jobs
              SET phase = 'prefix_materialize', updated_at = NOW()
            WHERE id = :job_id AND workspace_id = :workspace_id`,
          { job_id: job.id, workspace_id: job.workspaceId },
        ),
      nextTask: { stage: "prefix_materialize", input: { datasetSnapshotId: job.datasetSnapshotId } },
    };
  }
  const artifacts = await listArtifactsForJob(job);
  if (artifacts.length === 0) {
    throw new Error(
      "No artifacts matched this export scope. Render at least one scenario in this dataset to completion first.",
    );
  }
  const snapshotId = `dss_${createHash("sha256").update(`${job.id}:snapshot`).digest("hex").slice(0, 24)}`;
  return {
    output: { datasetSnapshotId: snapshotId, artifactCount: artifacts.length },
    beforeComplete: async (tx) => {
      await tx.execute(
        `INSERT INTO public.dataset_snapshots (
           id, dataset_id, workspace_id, source_query_json, summary_json, policy_snapshot_json,
           created_by_job_family, created_by_job_id, created_at
         ) VALUES (
           :id, :dataset_id, :workspace_id, CAST(:source_query AS JSONB), CAST(:summary AS JSONB),
           CAST(:policy AS JSONB), 'artifact_postprocess', :job_id, NOW()
         ) ON CONFLICT (id) DO NOTHING`,
        {
          id: snapshotId,
          dataset_id: job.datasetId,
          workspace_id: job.workspaceId,
          source_query: job.scopeJson ?? {},
          summary: {
            artifactCount: artifacts.length,
            canonicalArtifactCount: artifacts.filter((artifact) => artifact.artifact_family === "scenario").length,
          },
          policy: { format: job.format, recipe: job.recipe },
          job_id: job.id,
        },
      );
      for (const artifact of artifacts) {
        if (artifact.artifact_family === "scenario") {
          await tx.execute(
            `INSERT INTO simforge.dataset_snapshot_artifact_links (
               dataset_snapshot_id, workspace_id, artifact_id, render_job_id
             ) VALUES (:snapshot_id, :workspace_id, :artifact_id, :render_job_id)
             ON CONFLICT (dataset_snapshot_id, artifact_id) DO NOTHING`,
            {
              snapshot_id: snapshotId,
              workspace_id: job.workspaceId,
              artifact_id: artifact.id,
              render_job_id: artifact.simulation_id,
            },
          );
          continue;
        }
        await tx.execute(
          `INSERT INTO public.dataset_snapshot_items (
             dataset_snapshot_id, artifact_id, sample_key, sequence_id, split, role, metadata_json, created_at
           ) VALUES (:snapshot_id, :artifact_id, :sample_key, :sequence_id, 'unsplit', 'source', '{}'::JSONB, NOW())
           ON CONFLICT (dataset_snapshot_id, artifact_id, role) DO NOTHING`,
          {
            snapshot_id: snapshotId,
            artifact_id: artifact.id,
            sample_key:
              artifact.frame_index == null
                ? artifact.sequence_id
                : `${artifact.sequence_id || artifact.sensor_id || "sample"}:${artifact.frame_index}`,
            sequence_id: artifact.sequence_id,
          },
        );
      }
      await tx.execute(
        `UPDATE simforge.artifact_postprocess_jobs
            SET dataset_snapshot_id = :snapshot_id, phase = 'prefix_materialize', updated_at = NOW()
          WHERE id = :job_id AND workspace_id = :workspace_id`,
        { snapshot_id: snapshotId, job_id: job.id, workspace_id: job.workspaceId },
      );
    },
    nextTask: { stage: "prefix_materialize", input: { datasetSnapshotId: snapshotId } },
  };
}

async function prefixMaterialize(job: DatasetExportJob, task: ClaimedTask): Promise<StageOutcome> {
  const artifacts = await listArtifactsForJob(job);
  if (artifacts.length === 0) throw new Error("No artifacts to materialize.");
  const sdgManifestArtifacts = artifacts.filter(isSdgManifestArtifact);
  if (sdgManifestArtifacts.length > 0) {
    const manifestDocuments = [...new Set((await readArtifactDocuments(sdgManifestArtifacts)).values())];
    validateSdgManifestArtifactCoverage(
      artifacts,
      manifestDocuments,
      await readBundleIndexDocuments(artifacts.filter(isBundleIndexArtifact)),
    );
  }

  const attemptSuffix = `attempt-${task.attempt_count}`;
  const prefix = `datasets/${job.datasetId}/exports/${job.id}/prefix/${attemptSuffix}/`;
  const bucket = LOCAL_ARTIFACT_BUCKET;
  const manifestItems: Record<string, unknown>[] = [];
  for (const artifact of artifacts) {
    if (!artifact.s3_key) continue;
    const destKey = `${prefix}${packageEntryBase(artifact)}`;
    await registerLocalFile(
      bucket,
      destKey,
      localObjectPath(artifact.s3_bucket, artifact.s3_key),
      artifact.content_type ?? "application/octet-stream",
    );
    manifestItems.push({
      artifactId: artifact.id,
      source: `s3://${artifact.s3_bucket}/${artifact.s3_key}`,
      destination: `s3://${bucket}/${destKey}`,
      role: "source",
    });
  }

  let scenarioJsonCount = 0;
  if (exportIncludesScenarioJson(job)) {
    const seen = new Map<string, number>();
    for (const scenario of await listScenarioDefinitionsForJob(job)) {
      const key = `${prefix}${scenarioJsonEntryName(scenario, seen)}`;
      await writeLocalObject(
        bucket,
        key,
        Buffer.from(JSON.stringify(scenarioDefinitionDocument(scenario, job), null, 2)),
        "application/json",
      );
      scenarioJsonCount += 1;
      manifestItems.push({
        artifactId: `scenario_json:${scenario.id}`,
        source: "generated",
        destination: `s3://${bucket}/${key}`,
        role: "scenario_json",
        scenarioId: scenario.id,
      });
    }
  }

  let odvg: { key: string; body: string } | null = null;
  if (String(job.format).toUpperCase() === "ODVG") {
    const key = `${prefix}odvg/odvg-${attemptSuffix}.jsonl`;
    const workerLabelArtifacts = artifacts.filter(isWorkerOdvgArtifact);
    const sdgArtifactsPresent = artifacts.some(isSdgArtifact);
    if (sdgArtifactsPresent && workerLabelArtifacts.length === 0) {
      throw new Error("ODVG export for SDG datasets requires worker-produced odvg/*.json label artifacts.");
    }
    const body = buildOdvgJsonl(
      artifacts,
      workerLabelArtifacts.length > 0 ? await readArtifactDocuments(workerLabelArtifacts) : undefined,
    );
    if (sdgArtifactsPresent && !body.trim()) {
      throw new Error("ODVG export for SDG datasets produced no records from worker labels.");
    }
    if (!body.trim()) {
      throw new Error(
        "ODVG export produced no records: this dataset has no image artifacts with detection metadata.",
      );
    }
    await writeLocalObject(bucket, key, Buffer.from(body), "application/jsonl");
    manifestItems.push({
      artifactId: "odvg_jsonl",
      source: "generated",
      destination: `s3://${bucket}/${key}`,
      role: "label",
    });
    odvg = { key, body };
  }

  const manifestKey = `${prefix}manifest-${attemptSuffix}.json`;
  const manifest = {
    contractVersion: "simforge.dataset-export-prefix.v1",
    exportJobId: job.id,
    datasetId: job.datasetId,
    datasetSnapshotId: job.datasetSnapshotId,
    format: job.format,
    prefix: `s3://${bucket}/${prefix}`,
    odvg: odvg ? `s3://${bucket}/${odvg.key}` : null,
    items: manifestItems,
    scenarioJsonCount,
    generatedAt: job.createdAt,
  };
  const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
  await writeLocalObject(bucket, manifestKey, manifestBody, "application/json");
  const prefixDescriptorKey = `${prefix}_prefix-${attemptSuffix}.json`;
  const prefixDescriptor = Buffer.from(JSON.stringify({ bucket, prefix, itemCount: manifestItems.length }));
  await writeLocalObject(bucket, prefixDescriptorKey, prefixDescriptor, "application/json");
  const packageRequest = requestedPackage(job);

  return {
    output: { prefix, manifestKey, itemCount: manifestItems.length },
    beforeComplete: async (tx) => {
      const prefixArtifactId = await insertExportArtifact(tx, job, task, {
        kind: "prefix",
        key: prefixDescriptorKey,
        contentType: "application/json",
        sha256: createHash("sha256").update(prefixDescriptor).digest("hex"),
        sizeBytes: prefixDescriptor.byteLength,
        metadata: { s3Prefix: prefix, itemCount: manifestItems.length },
      });
      const manifestArtifactId = await insertExportArtifact(tx, job, task, {
        kind: "manifest",
        key: manifestKey,
        contentType: "application/json",
        sha256: createHash("sha256").update(manifestBody).digest("hex"),
        sizeBytes: manifestBody.byteLength,
        metadata: manifest,
      });
      const prefixIsDefault = !packageRequest;
      const prefixPublicationId = await insertPublication(tx, job, {
        kind: "prefix",
        artifactId: prefixArtifactId,
        isDefault: prefixIsDefault,
        metadata: { s3Bucket: bucket, s3Prefix: prefix, itemCount: manifestItems.length },
      });
      await insertPublication(tx, job, {
        kind: "manifest",
        artifactId: manifestArtifactId,
        isDefault: false,
        metadata: { s3Bucket: bucket, s3Key: manifestKey },
      });
      if (odvg) {
        const odvgArtifactId = await insertExportArtifact(tx, job, task, {
          kind: "odvg_jsonl",
          key: odvg.key,
          contentType: "application/jsonl",
          sha256: createHash("sha256").update(odvg.body).digest("hex"),
          sizeBytes: Buffer.byteLength(odvg.body),
          metadata: { s3Bucket: bucket, s3Key: odvg.key, sdgReference: "simforge.sdg.v1" },
        });
        await insertPublication(tx, job, {
          kind: "odvg",
          artifactId: odvgArtifactId,
          isDefault: false,
          metadata: { s3Bucket: bucket, s3Key: odvg.key, sdgReference: "simforge.sdg.v1" },
        });
      }
      await tx.execute(
        `UPDATE simforge.artifact_postprocess_jobs
            SET default_publication_id = CASE WHEN :prefix_default THEN :pub_id ELSE default_publication_id END,
                phase = CASE WHEN :has_package THEN 'package_archive' ELSE 'publication_finalize' END,
                progress = 0.6, updated_at = NOW()
          WHERE id = :job_id AND workspace_id = :workspace_id`,
        {
          prefix_default: prefixIsDefault,
          has_package: Boolean(packageRequest),
          pub_id: prefixPublicationId,
          job_id: job.id,
          workspace_id: job.workspaceId,
        },
      );
    },
    nextTask: packageRequest
      ? {
          stage: "package_archive",
          input: { prefix, manifestKey, delivery: packageRequest.delivery === "tar" ? "tar" : "zip" },
        }
      : { stage: "publication_finalize", input: { prefix, manifestKey } },
  };
}

async function packageArchive(job: DatasetExportJob, task: ClaimedTask): Promise<StageOutcome> {
  const artifacts = await listArtifactsForJob(job);
  if (artifacts.length === 0) throw new Error("No artifacts to package.");
  const delivery = task.input.delivery === "tar" ? "tar" : "zip";
  const isZip = delivery === "zip";
  const scenarioDefinitions = exportIncludesScenarioJson(job) ? await listScenarioDefinitionsForJob(job) : [];
  const bucket = LOCAL_ARTIFACT_BUCKET;
  const packageKey = `datasets/${job.datasetId}/exports/${job.id}/packages/export-attempt-${task.attempt_count}.${
    isZip ? "zip" : "tar"
  }`;
  const contentType = isZip ? "application/zip" : "application/x-tar";

  // Stream the archive to a scratch file on the artifact volume, then register
  // it in place: the object store hard-links same-volume files, so the package
  // is never buffered in memory or written twice.
  const scratchDirectory = join(LOCAL_ARTIFACTS_DIR, ".tmp", "dataset-export");
  await mkdir(scratchDirectory, { recursive: true });
  const scratchPath = join(scratchDirectory, `${job.id}-${task.attempt_count}.${isZip ? "zip" : "tar"}`);
  const sink = createWriteStream(scratchPath);
  const sinkDone = Promise.withResolvers<void>();
  sink.once("error", sinkDone.reject);
  sink.once("close", sinkDone.resolve);
  // Write failures surface through the per-chunk writes; this promise only
  // waits for the file to close, so its rejection must not go unobserved.
  sinkDone.promise.catch(() => undefined);
  try {
    const seen = new Map<string, number>();
    const scenarioSeen = new Map<string, number>();
    if (isZip) {
      const entries: ZipEntry[] = [];
      let offset = 0;
      for (const artifact of artifacts) {
        if (!artifact.s3_key || !artifact.size_bytes) continue;
        offset = await writeArtifactToZip(sink, artifact, nextPackageEntryName(artifact, seen), entries, offset);
      }
      for (const scenario of scenarioDefinitions) {
        offset = await writeBufferToZip(
          sink,
          scenarioJsonEntryName(scenario, scenarioSeen),
          Buffer.from(JSON.stringify(scenarioDefinitionDocument(scenario, job), null, 2)),
          entries,
          offset,
        );
      }
      await finishZip(sink, entries, offset);
    } else {
      for (const artifact of artifacts) {
        if (!artifact.s3_key || !artifact.size_bytes) continue;
        await writeArtifactToTar(sink, artifact, nextPackageEntryName(artifact, seen));
      }
      for (const scenario of scenarioDefinitions) {
        await writeBufferToTar(
          sink,
          scenarioJsonEntryName(scenario, scenarioSeen),
          Buffer.from(JSON.stringify(scenarioDefinitionDocument(scenario, job), null, 2)),
        );
      }
      await finishTar(sink);
    }
    sink.end();
    await sinkDone.promise;
    const stored = await registerLocalFile(bucket, packageKey, scratchPath, contentType);
    return {
      output: { packageKey, delivery },
      beforeComplete: async (tx) => {
        const packageArtifactId = await insertExportArtifact(tx, job, task, {
          kind: "package",
          key: packageKey,
          contentType,
          sha256: stored.checksumSha256Hex,
          sizeBytes: stored.sizeBytes,
          metadata: { delivery, scenarioJsonCount: scenarioDefinitions.length },
        });
        const publicationId = await insertPublication(tx, job, {
          kind: "package",
          artifactId: packageArtifactId,
          isDefault: isZip,
          metadata: {
            s3Bucket: bucket,
            s3Key: packageKey,
            delivery,
            scenarioJsonCount: scenarioDefinitions.length,
            sizeBytes: stored.sizeBytes,
            sha256: stored.checksumSha256Hex,
          },
        });
        await tx.execute(
          `UPDATE simforge.artifact_postprocess_jobs
              SET default_publication_id = COALESCE(:pub_id, default_publication_id),
                  phase = 'publication_finalize', progress = 0.9, updated_at = NOW()
            WHERE id = :job_id AND workspace_id = :workspace_id`,
          { pub_id: isZip ? publicationId : null, job_id: job.id, workspace_id: job.workspaceId },
        );
      },
      nextTask: { stage: "publication_finalize", input: { packageKey } },
    };
  } catch (error) {
    sink.destroy();
    throw error;
  } finally {
    // The scratch file is hard-linked (or copied) into the store by now; wait
    // for the descriptor to close before unlinking so Windows can remove it.
    await sinkDone.promise.catch(() => undefined);
    await rm(scratchPath, { force: true });
  }
}

async function publicationFinalize(job: DatasetExportJob): Promise<StageOutcome> {
  return {
    output: { finalized: true },
    beforeComplete: async (tx) => {
      await tx.execute(
        `UPDATE simforge.artifact_postprocess_jobs
            SET state = 'succeeded', phase = 'finalized', progress = 1,
                result_payload = COALESCE(result_payload, '{}'::JSONB) || CAST(:result AS JSONB),
                completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
          WHERE id = :job_id AND workspace_id = :workspace_id
            AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
        {
          job_id: job.id,
          workspace_id: job.workspaceId,
          result: {
            finalizedBy: WORKER_ID,
            finalizedAt: new Date().toISOString(),
            defaultPublicationId: job.defaultPublicationId,
          },
        },
      );
      await tx.execute(
        `UPDATE public.datasets
            SET stats_export_completed_count = stats_export_completed_count + 1, stats_updated_at = NOW()
          WHERE workspace_id = :workspace_id AND id = :dataset_id`,
        { workspace_id: job.workspaceId, dataset_id: job.datasetId },
      );
    },
    nextTask: null,
  };
}

async function runStage(job: DatasetExportJob, task: ClaimedTask): Promise<StageOutcome> {
  switch (task.stage) {
    case "snapshot_resolve":
      return snapshotResolve(job, task);
    case "prefix_materialize":
      return prefixMaterialize(job, task);
    case "package_archive":
      return packageArchive(job, task);
    case "publication_finalize":
      return publicationFinalize(job);
    default:
      throw new Error(`unsupported_dataset_export_stage:${String(task.stage)}`);
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────

async function runJob(workspaceId: string, jobId: string) {
  const admitted = await admitJob(workspaceId, jobId);
  if (!admitted) return;
  const { attemptId } = admitted;
  try {
    for (;;) {
      const claim = await claimNextTask(workspaceId, jobId, attemptId);
      if (claim.kind === "stop") {
        await settleAttempt(workspaceId, jobId, attemptId, "cancelled", "Export cancelled.");
        return;
      }
      if (claim.kind === "drained") break;
      const job = await loadJob(workspaceId, jobId);
      let outcome: StageOutcome;
      try {
        outcome = await runStage(job, claim.task);
        await completeTask(job, claim.task, outcome);
      } catch (error) {
        const retry = await failTask(job, claim.task, error);
        if (!retry) {
          await settleAttempt(
            workspaceId,
            jobId,
            attemptId,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
      }
    }
    const finished = await loadJob(workspaceId, jobId);
    if (finished.status === "succeeded" || finished.phase === "finalized") {
      await settleAttempt(workspaceId, jobId, attemptId, "succeeded");
      return;
    }
    // Every task drained without reaching finalization: the job cannot make
    // progress and must not sit in `running` forever.
    await withScenarioJobTransaction(jobId, (tx) =>
      tx.execute(
        `UPDATE simforge.artifact_postprocess_jobs
            SET state = 'failed', phase = 'failed', failure_code = 'no_runnable_task',
                failure_detail = jsonb_build_object('message', 'Export has no runnable task left.'),
                completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
          WHERE id = :job_id AND workspace_id = :workspace_id AND state = 'running'`,
        { job_id: jobId, workspace_id: workspaceId },
      ),
    );
    await settleAttempt(workspaceId, jobId, attemptId, "failed", "Export has no runnable task left.");
  } catch (error) {
    await settleAttempt(
      workspaceId,
      jobId,
      attemptId,
      "failed",
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    throw error;
  }
}

/**
 * Schedule a job on the local executor. Jobs run one at a time in admission
 * order; the returned promise resolves when this job has settled (or was
 * already running), and never rejects — failures are recorded on the job.
 */
export function scheduleDatasetExport(workspaceId: string, jobId: string): Promise<void> {
  const running = state.inflight.get(jobId);
  if (running) return running;
  const run = state.chain
    .then(() => runJob(workspaceId, jobId))
    .catch((error: unknown) => {
      console.error(`[dataset-export] job ${jobId} failed:`, error);
    })
    .finally(() => {
      state.inflight.delete(jobId);
    });
  state.inflight.set(jobId, run);
  state.chain = run;
  return run;
}

/**
 * Re-schedule every export this workspace left queued or running — for
 * example after the local service restarted mid-export. Safe to call on every
 * list request: already-scheduled jobs are skipped.
 */
export async function resumeDatasetExports(workspaceId: string, datasetId?: string) {
  const rows = await queryRows<{ id: string }>(
    `SELECT id FROM simforge.artifact_postprocess_jobs
      WHERE workspace_id = :workspace_id AND postprocess_kind = 'dataset_export'
        AND state IN ('queued', 'running') AND cancel_requested_at IS NULL
        ${datasetId ? "AND dataset_id = :dataset_id" : ""}
      ORDER BY created_at ASC, id ASC`,
    { workspace_id: workspaceId, ...(datasetId ? { dataset_id: datasetId } : {}) },
  );
  for (const row of rows) {
    if (!state.inflight.has(row.id)) void scheduleDatasetExport(workspaceId, row.id);
  }
}


